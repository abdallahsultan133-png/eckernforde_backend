
import express from 'express';
import cors from "cors";
import helmet from "helmet";
import subjectsRouter from "./routes/subjects.js";
import usersRouter from "./routes/users.js";
import classesRouter from "./routes/classes.js"
import dashboardRouter from "./routes/dashboard.js";
import attendanceRouter from "./routes/attendance.js";
import assignmentsRouter from "./routes/assignments.js";
import announcementsRouter from "./routes/announcements.js";
import gradesRouter from "./routes/grades.js";
import calendarRouter from "./routes/calendar.js";
import notificationsRouter from "./routes/notifications.js";
import profileRouter from "./routes/profile.js";
import departmentsRouter from "./routes/departments.js";
import messagesRouter from "./routes/messages.js";
import auditLogsRouter from "./routes/audit-logs.js";
import uploadsRouter from "./routes/uploads.js";
import filesRouter from "./routes/files.js";
import aiAssistantRouter from "./routes/ai-assistant.js";
import admissionsRouter from "./routes/admissions.js";
import portalContextRouter from "./routes/portal-context.js";
import reportCardTemplateRouter from "./routes/report-card-template.js";
import systemRouter from "./routes/system.js";
import securityMiddleware from "./middleware/security.js";
import {resolveSession} from "./middleware/resolve-session.js";
import {toNodeHandler} from "better-auth/node";
import {auth} from "./lib/auth.js";
import {startScheduledJobs} from "./lib/scheduled-jobs.js";
import {sql} from "drizzle-orm";
import {db, pool} from "./db/index.js";
import {requireSystemEnabled} from "./middleware/system-status.js";

const app = express();
app.set("trust proxy", true);
const PORT = Number(process.env.PORT) || 8000;

if (!process.env.FRONTEND_URL) throw new Error('FRONTEND_URL is not set in .env file');

// This is a JSON-only API (no HTML/static assets served), so the default
// CSP is irrelevant to it; crossOriginResourcePolicy is relaxed so the
// frontend (a different origin) can read responses.
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
}));

app.use(cors({
    origin: process.env.FRONTEND_URL,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true
}))

// Auth routes are mounted before express.json() because better-auth reads
// the raw request body itself; express.json() would otherwise consume the
// stream first. resolveSession + securityMiddleware run ahead of them so
// login/signup/password-reset get the same bot-detection and rate limiting
// as every other route instead of being exempt from both.
app.use(resolveSession);
app.use(securityMiddleware);
app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());
app.use(requireSystemEnabled);

app.use('/api/subjects', subjectsRouter)
app.use('/api/users', usersRouter)
app.use('/api/classes', classesRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/attendance', attendanceRouter)
app.use('/api/homework', assignmentsRouter)
app.use('/api/announcements', announcementsRouter)
app.use('/api/grades', gradesRouter)
app.use('/api/calendar', calendarRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/profile', profileRouter)
app.use('/api/departments', departmentsRouter)
app.use('/api/messages', messagesRouter)
app.use('/api/audit-logs', auditLogsRouter)
app.use('/api/uploads', uploadsRouter)
app.use('/api/files', filesRouter)
app.use('/api/ai-assistant', aiAssistantRouter)
app.use('/api/admissions', admissionsRouter)
app.use('/api/portal-context', portalContextRouter)
app.use('/api/report-card-template', reportCardTemplateRouter)
app.use('/api/system', systemRouter)

app.get('/', (req, res) => {
    res.json({ service: 'School platform API', status: 'ok' });
});

app.get('/healthz', async (req, res) => {
    try {
        await db.execute(sql`SELECT 1`);
        res.status(200).json({ status: 'ok', db: 'up' });
    } catch (e) {
        console.error('[healthz] DB check failed:', e);
        res.status(503).json({ status: 'error', db: 'down' });
    }
});

// Keep API failures machine-readable. Express's default 404 page is HTML,
// which makes unknown endpoints unnecessarily difficult for the frontend and
// operational probes to diagnose.
app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found', message: 'API route not found.' });
});

console.log("BETTER_AUTH_URL:", process.env.BETTER_AUTH_URL);

const server = app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
    startScheduledJobs();
});

let shuttingDown = false;
async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received; closing HTTP server and database pool.`);
    server.close(async () => {
        try {
            await pool.end();
            process.exit(0);
        } catch (error) {
            console.error("[server] graceful shutdown failed:", error);
            process.exit(1);
        }
    });
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });
