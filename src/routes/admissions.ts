import express from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { admissionsEnquiries, notifications } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { createAdmissionEnquirySchema } from "../lib/schemas.js";
import { requireAuth, requireRole, ADMIN_ROLES } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { sendAdmissionEnquiryEmail } from "../lib/email.js";
import { admissionRecipientRoles, visibleAdmissionStages, type AdmissionStage } from "../lib/admissions-routing.js";

const router = express.Router();

// Public, minimal and rate-limited by the application-wide security middleware.
// Do not log request bodies here: enquiries contain family contact details.
router.post("/enquiries", validateBody(createAdmissionEnquirySchema), async (req, res) => {
    try {
        const { fullName, email, phone, childStage, message, consent, website } = req.body;
        if (website) return res.status(204).end(); // Honeypot: silently discard bots.
        const [enquiry] = await db.insert(admissionsEnquiries).values({
            fullName,
            email: email.toLowerCase(),
            phone: phone || null,
            childStage,
            message: message || null,
            consent,
        }).returning({ id: admissionsEnquiries.id });
        if (!enquiry) throw new Error("Enquiry insert returned no record");

        // The enquiry is safely stored even when email or notification services
        // are unavailable. Never tell visitors to resubmit an already-saved form.
        const audienceRoles = admissionRecipientRoles(childStage as AdmissionStage);
        let administrators: { id: string; email: string }[] = [];
        try {
            administrators = await db.select({ id: user.id, email: user.email })
                .from(user).where(inArray(user.role, audienceRoles));
        } catch (error) {
            console.error(`[Admissions] Enquiry ${enquiry.id}: could not look up administrator accounts:`, error instanceof Error ? error.message : "unknown error");
        }
        try {
            if (administrators.length > 0) {
                await db.insert(notifications).values(administrators.map((admin) => ({
                    userId: admin.id,
                    type: "general" as const,
                    title: "New admissions enquiry",
                    message: `${fullName} submitted an admissions enquiry for ${childStage}.`,
                    link: "/admin/admissions",
                    read: false,
                })));
            }
        } catch (error) {
            console.error(`[Admissions] Enquiry ${enquiry.id}: in-app notification failed:`, error instanceof Error ? error.message : "unknown error");
        }

        const recipients = [...new Set([
                // Shared/unassigned inboxes are a fallback for uncertain-stage
                // enquiries, not a bypass of headmaster-specific routing.
                ...(childStage === "not_sure" ? [process.env.ADMISSIONS_NOTIFICATION_EMAIL, process.env.SCHOOL_ADMIN_EMAIL] : []),
                ...administrators.map((admin) => admin.email),
            ].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim().toLowerCase()))];
        if (recipients.length === 0) {
            console.warn(`[Admissions] Enquiry ${enquiry.id}: no notification email recipients configured.`);
        } else {
            const outcomes = await Promise.allSettled(recipients.map((to) => sendAdmissionEnquiryEmail({
                to, fullName, email, phone, childStage, message,
            })));
            const failures = outcomes.filter((outcome) => outcome.status === "rejected" || !outcome.value).length;
            if (failures > 0) {
                console.warn(`[Admissions] Enquiry ${enquiry.id}: email provider did not accept ${failures} of ${recipients.length} notifications.`);
            }
        }
        res.status(201).json({ data: { received: true } });
    } catch (error) {
        console.error("POST /admissions/enquiries error:", error instanceof Error ? error.message : "unknown error");
        res.status(500).json({ error: "We could not submit your enquiry. Please try again." });
    }
});

// Administrative review endpoint. Enquiry data is never exposed through the
// public site or normal staff roles.
router.get("/enquiries", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    try {
        const allowedStages = visibleAdmissionStages(req.user!.role);
        const data = await db.select().from(admissionsEnquiries)
            .where(allowedStages === null ? undefined : inArray(admissionsEnquiries.childStage, allowedStages))
            .orderBy(desc(admissionsEnquiries.createdAt));
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
        const allowedStages = visibleAdmissionStages(req.user!.role);
        const [updated] = await db.update(admissionsEnquiries).set({ status })
            .where(and(eq(admissionsEnquiries.id, id), allowedStages === null ? undefined : inArray(admissionsEnquiries.childStage, allowedStages)))
            .returning();
        if (!updated) return res.status(404).json({ error: "Enquiry not found." });
        res.json({ data: updated });
    } catch (error) {
        console.error("PATCH /admissions/enquiries/:id/status error:", error instanceof Error ? error.message : "unknown error");
        res.status(500).json({ error: "Could not update enquiry." });
    }
});

export default router;
