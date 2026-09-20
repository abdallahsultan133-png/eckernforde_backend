import express from "express";
import { eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { reportCardTemplates } from "../db/schema/app.js";
import { ADMIN_ROLES, requireAuth, requireRole } from "../middleware/require-auth.js";

const router = express.Router();

const templateFields = {
    name: reportCardTemplates.name,
    schoolName: reportCardTemplates.schoolName,
    schoolAddress: reportCardTemplates.schoolAddress,
    headmasterName: reportCardTemplates.headmasterName,
    headmasterSignature: reportCardTemplates.headmasterSignature,
    logoUrl: reportCardTemplates.logoUrl,
    accentColor: reportCardTemplates.accentColor,
    showAttendance: reportCardTemplates.showAttendance,
    showRemarks: reportCardTemplates.showRemarks,
    showDivision: reportCardTemplates.showDivision,
    updatedAt: reportCardTemplates.updatedAt,
};

router.get("/", requireAuth, async (_req, res) => {
    try {
        const [template] = await db.select(templateFields).from(reportCardTemplates).orderBy(reportCardTemplates.id).limit(1);
        if (!template) return res.status(404).json({ error: "Report-card template has not been configured." });
        return res.json({ data: template });
    } catch (error) {
        console.error("GET /report-card-template error:", error);
        return res.status(500).json({ error: "Failed to load report-card template" });
    }
});

router.put("/", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    try {
        const body = req.body as Partial<{
            name: string; schoolName: string; schoolAddress: string; headmasterName: string;
            headmasterSignature: string; logoUrl: string; accentColor: string;
            showAttendance: boolean; showRemarks: boolean; showDivision: boolean;
        }>;
        const name = String(body.name ?? "").trim();
        const schoolName = String(body.schoolName ?? "").trim();
        const accentColor = String(body.accentColor ?? "").trim();
        if (!name || !schoolName) return res.status(400).json({ error: "Template name and school name are required." });
        if (!/^#[0-9a-f]{6}$/i.test(accentColor)) return res.status(400).json({ error: "Accent color must be a six-digit hex color." });

        const [existing] = await db.select({ id: reportCardTemplates.id }).from(reportCardTemplates).orderBy(reportCardTemplates.id).limit(1);
        const values = {
            name,
            schoolName,
            schoolAddress: String(body.schoolAddress ?? "").trim() || null,
            headmasterName: String(body.headmasterName ?? "").trim() || null,
            headmasterSignature: String(body.headmasterSignature ?? "").trim() || null,
            logoUrl: String(body.logoUrl ?? "").trim() || null,
            accentColor,
            showAttendance: body.showAttendance !== false,
            showRemarks: body.showRemarks !== false,
            showDivision: body.showDivision !== false,
            updatedBy: req.user!.id!,
            updatedAt: new Date(),
        };
        const [saved] = existing
            ? await db.update(reportCardTemplates).set(values).where(eq(reportCardTemplates.id, existing.id)).returning()
            : await db.insert(reportCardTemplates).values({ ...values, createdAt: new Date() }).returning();
        return res.json({ data: saved });
    } catch (error) {
        console.error("PUT /report-card-template error:", error);
        return res.status(500).json({ error: "Failed to save report-card template" });
    }
});

export default router;
