import 'dotenv/config';
import dns from 'node:dns';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { neonConfig, Pool } from '@neondatabase/serverless';
import ws from 'ws';
import * as schema from './schema/index.js';

// Neon exposes both IPv4 and IPv6 records. On hosts whose IPv6 route is
// present but not usable, Node can spend the connection timeout on IPv6 before
// trying IPv4 and report an otherwise misleading DNS/timeout failure.
dns.setDefaultResultOrder(process.env.DB_IP_FAMILY === '6' ? 'ipv6first' : 'ipv4first');

// Neon’s WebSocket pool avoids requiring a direct outbound TCP connection to
// PostgreSQL port 5432, which was timing out during authentication. Node 24
// provides WebSocket globally and is the runtime used by this project.
neonConfig.webSocketConstructor = globalThis.WebSocket ?? ws;

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not defined');
}

/**
 * A pooled TCP connection to Postgres (node-postgres), replacing the previous
 * neon-http driver. On a long-running server this is the right model:
 *  - persistent connections — no per-query HTTPS handshake (neon-http did one
 *    round-trip *per query*, ~90ms each)
 *  - real transactions — `db.transaction(...)` actually works, so multi-step
 *    writes (enrol + audit-log, create + return) are atomic
 *  - resilient to Neon compute suspend/resume
 *
 * DATABASE_URL points at Neon's PgBouncer pooler ("-pooler" host) — which is
 * exactly what this wants. `max` stays modest: the pooler multiplexes many
 * client connections onto few Postgres ones, and the app runs multiple
 * instances. TLS is taken from `sslmode=require` in the connection string.
 */
export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Keep the client pool deliberately small. Neon/PgBouncer performs the
    // actual multiplexing, while a large local pool makes transient network
    // failures much more likely during compute suspend/resume.
    max: Number(process.env.DB_POOL_MAX ?? 3),
    // Do not retain an idle TCP session long enough for a cloud pooler or a
    // local network device to close it behind our back.
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 10_000),
    // A cold Neon compute can need several seconds to wake up. Ten seconds
    // was too aggressive and surfaced as a Better Auth 500 during sign-in.
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 30_000),
    // Ask the TCP socket to keep idle connections alive and recycle old
    // sessions so a connection surviving a network interruption is not
    // handed back to a request.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    maxLifetimeSeconds: Number(process.env.DB_MAX_LIFETIME_SECONDS ?? 120),
    // Recycle clients periodically even when they stay busy. This prevents a
    // long-lived desktop process from repeatedly receiving a stale socket.
    maxUses: Number(process.env.DB_MAX_USES ?? 500),
});

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isRetryableConnectionError(error: unknown) {
    // Drizzle wraps driver failures in DrizzleQueryError, so inspect the full
    // cause chain instead of only the outer "Failed query" message. Neon can
    // also reject a WebSocket connection with a bare ErrorEvent that has no
    // message or error code; that event is still a transient connection error.
    const pending: unknown[] = [error];
    const seen = new Set<object>();
    while (pending.length > 0) {
        const current = pending.pop();
        if (!current || (typeof current !== 'object' && typeof current !== 'function')) {
            if (typeof current === 'string' && /connection terminated|connection reset|socket hang up|ECONNRESET|EPIPE|EACCES|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(current)) return true;
            continue;
        }
        if (seen.has(current as object)) continue;
        seen.add(current as object);
        const details = current as { name?: unknown; message?: unknown; code?: unknown; type?: unknown; cause?: unknown; errors?: unknown; originalError?: unknown };
        const message = [details.name, details.message, details.code, details.type]
            .filter((value): value is string => typeof value === 'string')
            .join(' ');
        if (/connection terminated|connection reset|socket hang up|ECONNRESET|EPIPE|EACCES|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(message)
            || (details.name === 'ErrorEvent' && details.type === 'error')) return true;
        if (details.cause) pending.push(details.cause);
        if (details.originalError) pending.push(details.originalError);
        if (Array.isArray(details.errors)) pending.push(...details.errors);
    }
    return false;
}

function readOnlyQueryText(query: unknown) {
    const text = typeof query === "string"
        ? query
        : query && typeof query === "object" && "text" in query && typeof query.text === "string"
            ? query.text
            : "";
    return /^\s*select\b/i.test(text);
}

// pg-pool drops broken clients automatically, but the request that discovers a
// dropped connection otherwise fails immediately. Retrying one read-only query
// lets the pool acquire a fresh client without risking duplicate writes.
const poolQuery = pool.query.bind(pool) as (...args: any[]) => Promise<any>;
const readRetryAttempts = Math.max(1, Number(process.env.DB_READ_RETRY_ATTEMPTS ?? 5));
pool.query = (async (...args: any[]) => {
    const readOnly = readOnlyQueryText(args[0]);
    for (let attempt = 0; ; attempt++) {
        try {
            return await poolQuery(...args);
        } catch (error) {
            if (!readOnly || !isRetryableConnectionError(error) || attempt >= readRetryAttempts - 1) throw error;
            const backoffMs = Math.min(4_000, 250 * (2 ** attempt));
            console.warn(`[DB] read query connection/DNS failure; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${readRetryAttempts}).`);
            await wait(backoffMs);
        }
    }
}) as typeof pool.query;

// A dropped idle connection (Neon suspending a compute, a network blip) emits
// 'error' on the pool. Without a listener, node treats it as unhandled and
// crashes the process — the pool itself recovers on the next checkout.
pool.on('error', (err: Error) => {
    console.error('[DB] idle pool client error (pool will recover):', err.message);
});

export const db = drizzle(pool, { schema });

// Startup connection check with retry. Neon suspends idle computes, so the
// first connection after a deploy/restart can take a few seconds to resume —
// retry a few times before declaring the connection dead.
async function verifyConnection(attempts = 4): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            await db.execute(sql`select 1`);
            console.log(`[DB] ✅ Postgres pool connected${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`);
            return;
        } catch (e) {
            if (attempt === attempts) {
                console.error(`[DB] ❌ Postgres connection FAILED after ${attempts} attempts:`, e);
                return;
            }
            const backoffMs = 500 * attempt;
            console.warn(`[DB] not ready (attempt ${attempt}/${attempts}), retrying in ${backoffMs}ms…`);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
    }
}

void verifyConnection();
