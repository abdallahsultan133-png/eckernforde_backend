import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema/index.js';

const { Pool } = pg;

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
    const message = error instanceof Error ? error.message : String(error);
    // DNS lookups can briefly fail when a Neon compute wakes or the local
    // network changes. Treat those transient resolver/socket failures like a
    // dropped idle client, but only retry safe read-only queries below.
    return /connection terminated|connection reset|socket hang up|ECONNRESET|EPIPE|EACCES|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(message);
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
pool.query = (async (...args: any[]) => {
    const readOnly = readOnlyQueryText(args[0]);
    for (let attempt = 0; ; attempt++) {
        try {
            return await poolQuery(...args);
        } catch (error) {
            if (!readOnly || !isRetryableConnectionError(error) || attempt >= 3) throw error;
            const backoffMs = 250 * (attempt + 1);
            console.warn(`[DB] read query connection/DNS failure; retrying in ${backoffMs}ms (attempt ${attempt + 1}/3).`);
            await wait(backoffMs);
        }
    }
}) as typeof pool.query;

// A dropped idle connection (Neon suspending a compute, a network blip) emits
// 'error' on the pool. Without a listener, node treats it as unhandled and
// crashes the process — the pool itself recovers on the next checkout.
pool.on('error', (err) => {
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
