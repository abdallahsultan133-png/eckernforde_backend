import express from "express";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { academicTerms, classes, enrollments, examResults, exams, notifications, subjects, termSubjectResults } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireAuth } from "../middleware/require-auth.js";
import { currentAcademicYear } from "../lib/portal-context.js";
import { classNotificationRecipients, filterNotificationRecipients } from "../lib/user-notification-preferences.js";
import { sendPortalAlertEmail } from "../lib/email.js";

const router = express.Router();

async function surfacePendingResultPublications(userId: string, role: string | undefined) {
    if ((await filterNotificationRecipients([userId], "inApp")).length === 0) return;
    const schoolLevels = role === "secondary_headmaster" ? ["secondary"]
        : role === "primary_headmaster" ? ["nursery", "primary"]
            : role === "super_admin" ? null : [];
    if (schoolLevels?.length === 0) return;

    const pending = await db.select({
        termId: termSubjectResults.academicTermId,
        termName: academicTerms.name,
        classId: termSubjectResults.classId,
        className: classes.name,
        subjectId: termSubjectResults.subjectId,
        subjectName: subjects.name,
        schoolLevel: termSubjectResults.schoolLevel,
        hasPublished: sql<boolean>`bool_or(${termSubjectResults.published})`.mapWith(Boolean),
        sourceUpdatedAt: max(termSubjectResults.updatedAt),
    }).from(termSubjectResults)
        .innerJoin(academicTerms, eq(termSubjectResults.academicTermId, academicTerms.id))
        .innerJoin(classes, eq(termSubjectResults.classId, classes.id))
        .innerJoin(subjects, eq(termSubjectResults.subjectId, subjects.id))
        .where(schoolLevels ? inArray(termSubjectResults.schoolLevel, schoolLevels as Array<"nursery" | "primary" | "secondary">) : undefined)
        .groupBy(termSubjectResults.academicTermId, academicTerms.name, termSubjectResults.classId, classes.name, termSubjectResults.subjectId, subjects.name, termSubjectResults.schoolLevel)
        .having(sql`bool_or(not ${termSubjectResults.published})`);

    const candidates = pending.map((row) => {
        const title = row.hasPublished ? "Results changed — republish required" : "Results ready to publish";
        const classQuery = encodeURIComponent(row.className);
        const link = `/admin/publish-results?termId=${row.termId}&className=${classQuery}&subjectId=${row.subjectId}`;
        return {
            userId,
            type: "grade" as const,
            title,
            message: row.hasPublished
                ? `Results for ${row.className} · ${row.subjectName} · ${row.termName} have changed. Review and publish the updated results.`
                : `${row.termName} results for ${row.className} · ${row.subjectName} are saved and awaiting publication.`,
            link,
            read: false,
            sourceUpdatedAt: row.sourceUpdatedAt,
        };
    });

    // Older exam workflows can have saved marks in exam_results before a
    // formal term row was created. Surface those as approval work too; the
    // publish endpoint imports the saved exam marks into the formal report.
    const legacyGroups = await db.select({
        classId: exams.classId,
        className: classes.name,
        subjectId: classes.subjectId,
        subjectName: subjects.name,
        schoolLevel: classes.schoolLevel,
        academicYearId: classes.academicYearId,
        examType: exams.examType,
        sourceUpdatedAt: max(examResults.updatedAt),
    }).from(examResults)
        .innerJoin(exams, eq(examResults.examId, exams.id))
        .innerJoin(classes, eq(exams.classId, classes.id))
        .innerJoin(subjects, eq(classes.subjectId, subjects.id))
        .where(schoolLevels ? inArray(classes.schoolLevel, schoolLevels as Array<"nursery" | "primary" | "secondary">) : undefined)
        .groupBy(exams.classId, classes.name, classes.subjectId, subjects.name, classes.schoolLevel, classes.academicYearId, exams.examType);
    if (legacyGroups.length > 0) {
        const currentYear = await currentAcademicYear();
        const yearIds = [...new Set(legacyGroups.map((row) => row.academicYearId ?? currentYear?.id).filter((id): id is number => id !== null && id !== undefined))];
        const terms = yearIds.length
            ? await db.select({ id: academicTerms.id, name: academicTerms.name, academicYearId: academicTerms.academicYearId, type: academicTerms.type, startsOn: academicTerms.startsOn })
                .from(academicTerms).where(inArray(academicTerms.academicYearId, yearIds))
            : [];
        const termByYearType = new Map<string, typeof terms[number]>();
        for (const term of terms.sort((a, b) => b.startsOn.localeCompare(a.startsOn))) {
            const key = `${term.academicYearId}:${term.type}`;
            if (!termByYearType.has(key)) termByYearType.set(key, term);
        }
        const termByLegacyRow = legacyGroups.map((row) => {
            const yearId = row.academicYearId ?? currentYear?.id;
            const type = row.examType === "annual" ? "terminal" : "midterm";
            const term = yearId ? termByYearType.get(`${yearId}:${type}`) : undefined;
            return term ? { row, term } : null;
        }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
        if (termByLegacyRow.length > 0) {
            const classIds = [...new Set(termByLegacyRow.map(({ row }) => row.classId))];
            const termIds = [...new Set(termByLegacyRow.map(({ term }) => term.id))];
            const formalRows = await db.select({
                termId: termSubjectResults.academicTermId,
                classId: termSubjectResults.classId,
                subjectId: termSubjectResults.subjectId,
                published: termSubjectResults.published,
            }).from(termSubjectResults).where(and(
                inArray(termSubjectResults.classId, classIds),
                inArray(termSubjectResults.academicTermId, termIds),
            ));
            const formalByKey = new Map(formalRows.map((row) => [`${row.termId}:${row.classId}:${row.subjectId}`, row]));
            for (const { row, term } of termByLegacyRow) {
                if (formalByKey.has(`${term.id}:${row.classId}:${row.subjectId}`)) continue;
                const classQuery = encodeURIComponent(row.className);
                candidates.push({
                    userId,
                    type: "grade",
                    title: "Results ready to publish",
                    message: `${term.name} results for ${row.className} · ${row.subjectName} are saved and awaiting publication.`,
                    link: `/admin/publish-results?termId=${term.id}&className=${classQuery}&subjectId=${row.subjectId}`,
                    read: false,
                    sourceUpdatedAt: row.sourceUpdatedAt,
                });
            }
        }
    }
    if (candidates.length === 0) return;

    const existing = await db.select({ id: notifications.id, link: notifications.link, read: notifications.read, createdAt: notifications.createdAt })
        .from(notifications)
        .where(and(
            eq(notifications.userId, userId),
            inArray(notifications.link, candidates.map((candidate) => candidate.link)),
        ));
    const existingByLink = new Map(existing.map((row) => [row.link, row]));
    const missing = candidates.filter((candidate) => !existingByLink.has(candidate.link));
    if (missing.length) {
        await db.insert(notifications).values(missing.map(({ sourceUpdatedAt: _sourceUpdatedAt, ...notification }) => notification));
    }

    // A previous alert can have been marked read before the marks changed, or
    // the save-time notifier can have deduped against that older alert. Reopen
    // it only when the underlying saved results are newer than the alert, so
    // polling the feed does not make a deliberately-read alert unread again.
    const staleReadAlerts = candidates.flatMap((candidate) => {
        const previous = existingByLink.get(candidate.link);
        return previous?.read && candidate.sourceUpdatedAt && candidate.sourceUpdatedAt > previous.createdAt
            ? [previous.id]
            : [];
    });
    if (staleReadAlerts.length) {
        const reissuedAt = new Date();
        await db.update(notifications)
            .set({ read: false, createdAt: reissuedAt, updatedAt: reissuedAt })
            .where(and(eq(notifications.userId, userId), inArray(notifications.id, staleReadAlerts)));
    }
}

// GET /api/notifications?unreadOnly=true&limit=20
router.get("/", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id!;
        const unreadOnly = req.query.unreadOnly === "true";
        const limit = Math.min(parseInt(String(req.query.limit ?? "30"), 10) || 30, 100);

        // Reconcile pending results when a headmaster opens the notification
        // feed. This also surfaces approvals saved before the notification
        // flow was fixed, while the stable links prevent duplicate alerts.
        await surfacePendingResultPublications(userId, req.user!.role);

        const conditions = [eq(notifications.userId, userId)];
        if (unreadOnly) conditions.push(eq(notifications.read, false));

        const rows = await db
            .select()
            .from(notifications)
            .where(and(...conditions))
            .orderBy(desc(notifications.createdAt))
            .limit(limit);

        const unreadResult = await db
            .select({ unreadCount: sql<number>`count(*) filter (where ${notifications.read} = false)` })
            .from(notifications)
            .where(eq(notifications.userId, userId));

        const unreadCount = unreadResult[0]?.unreadCount ?? 0;

        res.json({ data: rows, unreadCount });
    } catch (e) {
        console.error("GET /notifications error:", e);
        res.status(500).json({ error: "Failed to load notifications" });
    }
});

// PATCH /api/notifications/:id/read — mark one as read
router.patch("/:id/read", requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [updated] = await db
            .update(notifications)
            .set({ read: true })
            .where(and(eq(notifications.id, id), eq(notifications.userId, req.user!.id!)))
            .returning();
        if (!updated) return res.status(404).json({ error: "Notification not found" });
        res.json({ data: updated });
    } catch (e) {
        res.status(500).json({ error: "Failed to mark as read" });
    }
});

// PATCH /api/notifications/read-all — mark all as read
router.patch("/read-all", requireAuth, async (req, res) => {
    try {
        await db
            .update(notifications)
            .set({ read: true })
            .where(and(eq(notifications.userId, req.user!.id!), eq(notifications.read, false)));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to mark all as read" });
    }
});

// DELETE /api/notifications/:id
router.delete("/:id", requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        await db.delete(notifications).where(and(eq(notifications.id, id), eq(notifications.userId, req.user!.id!)));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Failed to delete notification" });
    }
});

export default router;

// ─── HELPER: create notifications for enrolled students ──────────────────────
// Called from assignments and announcements routes after creating a new item.
export async function notifyEnrolledStudents(params: {
    classId: number;
    type: "announcement" | "assignment" | "grade" | "attendance" | "exam" | "general";
    title: string;
    message: string;
    link?: string;
}) {
    try {
        const recipients = await classNotificationRecipients(params.classId);
        const recipientIds = await filterNotificationRecipients(recipients.map((entry) => entry.id), "inApp");
        if (recipientIds.length === 0) return;

        await db.insert(notifications).values(
            recipientIds.map((userId) => ({
                userId,
                type: params.type,
                title: params.title,
                message: params.message,
                link: params.link ?? null,
                read: false,
            }))
        );
    } catch (e) {
        console.error("notifyEnrolledStudents error:", e);
    }
}

// Called when a grade is saved for a student
export async function notifyStudent(params: {
    userId: string;
    type: "announcement" | "assignment" | "grade" | "attendance" | "exam" | "general";
    title: string;
    message: string;
    link?: string;
}) {
    try {
        if ((await filterNotificationRecipients([params.userId], "inApp")).length === 0) return;
        await db.insert(notifications).values({
            userId: params.userId,
            type: params.type,
            title: params.title,
            message: params.message,
            link: params.link ?? null,
            read: false,
        });
    } catch (e) {
        console.error("notifyStudent error:", e);
    }
}

/** Notify administrators when already-published results need review again. */
export async function notifyAcademicAdministrators(params: {
    type: "grade" | "exam" | "general";
    title: string;
    message: string;
    link?: string;
    schoolLevel: "nursery" | "primary" | "secondary";
    excludeUserId?: string;
    dedupe?: boolean;
}) {
    try {
        const headmasterRole = params.schoolLevel === "secondary"
            ? "secondary_headmaster"
            : "primary_headmaster";
        const administrators = await db
            .select({ userId: user.id, email: user.email })
            .from(user)
            .where(inArray(user.role, ["super_admin", headmasterRole]));
        const eligible = administrators.filter((administrator) => administrator.userId !== params.excludeUserId);
        const inAppIds = new Set(await filterNotificationRecipients(eligible.map((administrator) => administrator.userId), "inApp"));
        const emailIds = new Set(await filterNotificationRecipients(eligible.map((administrator) => administrator.userId), "email"));
        let recipients = eligible.filter((administrator) => inAppIds.has(administrator.userId));
        let emailRecipients = eligible.filter((administrator) => emailIds.has(administrator.userId));
        if (params.dedupe && params.link && eligible.length > 0) {
            const existing = await db.select({ userId: notifications.userId })
                .from(notifications)
                .where(and(
                    inArray(notifications.userId, eligible.map((administrator) => administrator.userId)),
                    eq(notifications.type, params.type),
                    eq(notifications.title, params.title),
                    eq(notifications.link, params.link),
                ));
            const alreadyNotified = new Set(existing.map((row) => row.userId));
            recipients = recipients.filter((administrator) => !alreadyNotified.has(administrator.userId));
            emailRecipients = emailRecipients.filter((administrator) => !alreadyNotified.has(administrator.userId));
        }
        if (recipients.length > 0) {
            await db.insert(notifications).values(
                recipients.map((administrator) => ({
                    userId: administrator.userId,
                    type: params.type,
                    title: params.title,
                    message: params.message,
                    link: params.link ?? null,
                    read: false,
                })),
            );
        }
        if (emailRecipients.length > 0) {
            await sendPortalAlertEmail({
                to: emailRecipients.map((administrator) => administrator.email),
                title: params.title,
                message: params.message,
                link: params.link ?? null,
            });
        }
    } catch (e) {
        console.error("notifyAcademicAdministrators error:", e);
    }
}
