import express from "express";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { academicYears, auditLogs } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireAuth, requireRole, ADMIN_ROLES } from "../middleware/require-auth.js";
import type { Request } from "express";

const router = express.Router();

// GET /api/audit-logs?limit=50 — admin/super_admin only
router.get("/", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    try {
        const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
        const rawAcademicYearId = req.query.academicYearId;
        const academicYearId = rawAcademicYearId === undefined ? undefined : Number(rawAcademicYearId);
        if (academicYearId !== undefined && (!Number.isInteger(academicYearId) || academicYearId <= 0)) return res.status(400).json({ error: "Invalid academic year" });
        const conditions = [];
        if (academicYearId !== undefined) {
            const [year] = await db.select({ startsOn: academicYears.startsOn, endsOn: academicYears.endsOn }).from(academicYears).where(eq(academicYears.id, academicYearId));
            if (!year) return res.status(404).json({ error: "Academic year not found" });
            conditions.push(gte(auditLogs.createdAt, new Date(`${year.startsOn}T00:00:00Z`)));
            conditions.push(lte(auditLogs.createdAt, new Date(`${year.endsOn}T23:59:59Z`)));
        }

        const logs = await db
            .select({
                id: auditLogs.id,
                action: auditLogs.action,
                resource: auditLogs.resource,
                resourceId: auditLogs.resourceId,
                details: auditLogs.details,
                createdAt: auditLogs.createdAt,
                user: { id: user.id, name: user.name, email: user.email },
            })
            .from(auditLogs)
            .leftJoin(user, eq(auditLogs.userId, user.id))
            .where(conditions.length ? and(...conditions) : undefined)
            .orderBy(desc(auditLogs.createdAt))
            .limit(limit);

        res.json({ data: logs });
    } catch (e) {
        console.error("GET /audit-logs error:", e);
        res.status(500).json({ error: "Failed to load audit logs" });
    }
});

export default router;

// ─── HELPER ───────────────────────────────────────────────────────────────────
// Call this from any route to record an action. Fire-and-forget (never throws).
export async function logAction(params: {
    req: Request;
    action: string;       // e.g. 'class.create', 'grade.update', 'student.enroll'
    resource: string;     // e.g. 'classes', 'grades'
    resourceId?: string | number | undefined;
    details?: string | undefined;
}) {
    try {
        await db.insert(auditLogs).values({
            userId: params.req.user?.id ?? null,
            action: params.action,
            resource: params.resource,
            resourceId: params.resourceId != null ? String(params.resourceId) : null,
            details: params.details ?? null,
            ipAddress: String(params.req.ip ?? params.req.socket?.remoteAddress ?? ""),
        });
    } catch (e) {
        console.warn("logAction failed (non-fatal):", e);
    }
}
