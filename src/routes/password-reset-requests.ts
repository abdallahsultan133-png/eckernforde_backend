import express from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { db } from "../db/index.js";
import { account, user } from "../db/schema/auth.js";
import { notifications, passwordResetRequests } from "../db/schema/app.js";
import { auth } from "../lib/auth.js";
import { sendPasswordResetRequestNotificationEmail } from "../lib/email.js";
import { passwordResetRequestSchema } from "../lib/schemas.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireRole } from "../middleware/require-auth.js";
import { logAction } from "./audit-logs.js";
import { filterNotificationRecipients } from "../lib/user-notification-preferences.js";

const router = express.Router();

function generateTemporaryPassword(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const bytes = randomBytes(16);
    let password = "";
    for (let i = 0; i < 16; i += 1) {
        password += alphabet[bytes[i]! % alphabet.length];
        if (i % 4 === 3 && i < 15) password += "-";
    }
    return password;
}

// Public by design: Better Auth's reset endpoint also returns the same generic
// response for unknown addresses. Only known users are placed in the admin
// queue, so this route never reveals whether an address exists.
router.post("/", validateBody(passwordResetRequestSchema), async (req, res) => {
    const { email } = req.body as { email: string };
    const normalizedEmail = email.toLowerCase();

    try {
        const [target] = await db
            .select({ id: user.id, name: user.name, email: user.email })
            .from(user)
            .where(sql`lower(${user.email}) = ${normalizedEmail}`);

        if (target) {
            const requestedAt = new Date();
            await db.insert(passwordResetRequests).values({
                userId: target.id,
                email: normalizedEmail,
                status: "pending",
                requestedAt,
            });

            const superAdmins = await db
                .select({ id: user.id, email: user.email })
                .from(user)
                .where(eq(user.role, "super_admin"));
            const emailEnabledIds = new Set(await filterNotificationRecipients(superAdmins.map((admin) => admin.id), "email"));
            const notificationEnabledIds = await filterNotificationRecipients(superAdmins.map((admin) => admin.id), "inApp");
            await sendPasswordResetRequestNotificationEmail({
                to: superAdmins.filter((admin) => emailEnabledIds.has(admin.id)).map((admin) => admin.email),
                requesterName: target.name,
                requesterEmail: target.email,
                requestedAt,
                adminUrl: `${process.env.FRONTEND_URL}/users`,
            });
            if (notificationEnabledIds.length > 0) {
                await db.insert(notifications).values(notificationEnabledIds.map((userId) => ({
                    userId,
                    type: "general" as const,
                    title: "Password reset requested",
                    message: `${target.name} (${target.email}) forgot their password and needs a temporary password.`,
                    link: "/users",
                    read: false,
                })));
            }
        }

        await auth.api.requestPasswordReset({
            body: {
                email: normalizedEmail,
                // Never allow a caller to turn a recovery email into an
                // open redirect/phishing link.
                redirectTo: `${process.env.FRONTEND_URL}/reset-password`,
            },
        });

        res.json({
            status: true,
            message: "If this email exists in our system, check your email for the reset link",
        });
    } catch (error) {
        console.error("POST /password-reset-requests error:", error);
        res.status(500).json({ error: "Unable to start password recovery" });
    }
});

// Super admins can see the operational recovery queue. Reset tokens and
// passwords are intentionally never returned here.
router.get("/", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
        const allRequests = String(req.query.limit ?? "100").toLowerCase() === "all";
        const page = allRequests ? 1 : Math.max(1, parseInt(String(req.query.page ?? 1), 10) || 1);
        const limit = allRequests ? 1 : Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
        const offset = (page - 1) * limit;
        const requestsQuery = db
            .select({
                id: passwordResetRequests.id,
                email: passwordResetRequests.email,
                status: passwordResetRequests.status,
                requestedAt: passwordResetRequests.requestedAt,
                handledAt: passwordResetRequests.handledAt,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                },
            })
            .from(passwordResetRequests)
            .leftJoin(user, eq(passwordResetRequests.userId, user.id))
            .orderBy(desc(passwordResetRequests.requestedAt));
        const [requests, totalRows] = await Promise.all([
            allRequests ? requestsQuery : requestsQuery.limit(limit).offset(offset),
            db.select({ count: sql<number>`count(*)` }).from(passwordResetRequests),
        ]);
        const total = Number(totalRows[0]?.count ?? 0);
        const responseLimit = allRequests ? Math.max(total, 1) : limit;

        res.json({ data: requests, pagination: { page, limit: responseLimit, total, totalPages: allRequests ? Number(total > 0) : Math.ceil(total / limit) } });
    } catch (error) {
        console.error("GET /password-reset-requests error:", error);
        res.status(500).json({ error: "Failed to load password recovery requests" });
    }
});

// Generate a temporary credential directly from a queued request. The clear
// text password is returned exactly once and is never stored or logged.
router.post("/:id/temporary-password", requireAuth, requireRole("super_admin"), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid recovery request" });

    try {
        const [request] = await db
            .select({
                id: passwordResetRequests.id,
                userId: passwordResetRequests.userId,
                email: passwordResetRequests.email,
                name: user.name,
                userEmail: user.email,
            })
            .from(passwordResetRequests)
            .leftJoin(user, eq(passwordResetRequests.userId, user.id))
            .where(eq(passwordResetRequests.id, id));

        if (!request) return res.status(404).json({ error: "Recovery request not found" });
        if (!request.userId || !request.name || !request.userEmail) {
            return res.status(410).json({ error: "The account for this recovery request no longer exists" });
        }

        const context = await auth.$context;
        const temporaryPassword = generateTemporaryPassword();
        const passwordHash = await context.password.hash(temporaryPassword);

        await db.transaction(async (tx) => {
            const [credential] = await tx
                .select({ id: account.id })
                .from(account)
                .where(and(eq(account.userId, request.userId!), eq(account.providerId, "credential")));

            if (credential) {
                await tx.update(account)
                    .set({ password: passwordHash, updatedAt: new Date() })
                    .where(eq(account.id, credential.id));
            } else {
                await tx.insert(account).values({
                    id: randomBytes(16).toString("hex"),
                    accountId: request.userId!,
                    providerId: "credential",
                    userId: request.userId!,
                    password: passwordHash,
                });
            }

            await tx.update(passwordResetRequests)
                .set({ status: "temporary_password", handledAt: new Date(), handledBy: req.user!.id })
                .where(eq(passwordResetRequests.id, id));
        });

        await context.internalAdapter.deleteUserSessions(request.userId);
        await logAction({
            req,
            action: "user.password_reset",
            resource: "password_reset_requests",
            resourceId: id,
            details: "Generated a temporary password from a recovery request",
        });

        res.json({
            data: {
                id,
                name: request.name,
                email: request.userEmail,
                temporaryPassword,
            },
        });
    } catch (error) {
        console.error("POST /password-reset-requests/:id/temporary-password error:", error);
        res.status(500).json({ error: "Failed to generate a temporary password" });
    }
});

export default router;
