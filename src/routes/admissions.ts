import express from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { admissionsEnquiries } from "../db/schema/app.js";
import { createAdmissionEnquirySchema } from "../lib/schemas.js";
import { requireAuth, requireRole, ADMIN_ROLES } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";

const router = express.Router();

// Public, minimal and rate-limited by the application-wide security middleware.
// Do not log request bodies here: enquiries contain family contact details.
router.post("/enquiries", validateBody(createAdmissionEnquirySchema), async (req, res) => {
    try {
        const { fullName, email, phone, childStage, message, consent, website } = req.body;
        if (website) return res.status(204).end(); // Honeypot: silently discard bots.
        await db.insert(admissionsEnquiries).values({
            fullName,
            email: email.toLowerCase(),
            phone: phone || null,
            childStage,
            message: message || null,
            consent,
        });
        res.status(201).json({ data: { received: true } });
    } catch (error) {
        console.error("POST /admissions/enquiries error:", error instanceof Error ? error.message : "unknown error");
        res.status(500).json({ error: "We could not submit your enquiry. Please try again." });
    }
});

// Administrative review endpoint. Enquiry data is never exposed through the
// public site or normal staff roles.
router.get("/enquiries", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res) => {
    try {
        const data = await db.select().from(admissionsEnquiries).orderBy(desc(admissionsEnquiries.createdAt));
        res.json({ data });
    } catch (error) {
        console.error("GET /admissions/enquiries error:", error instanceof Error ? error.message : "unknown error");
        res.status(500).json({ error: "Could not load enquiries." });
    }
});

router.patch("/enquiries/:id/status", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body?.status ?? "");
    if (!Number.isInteger(id) || !["new", "in_progress", "closed"].includes(status)) return res.status(400).json({ error: "Valid enquiry status is required." });
    try {
        const [updated] = await db.update(admissionsEnquiries).set({ status }).where(eq(admissionsEnquiries.id, id)).returning();
        if (!updated) return res.status(404).json({ error: "Enquiry not found." });
        res.json({ data: updated });
    } catch (error) {
        console.error("PATCH /admissions/enquiries/:id/status error:", error instanceof Error ? error.message : "unknown error");
        res.status(500).json({ error: "Could not update enquiry." });
    }
});

export default router;
