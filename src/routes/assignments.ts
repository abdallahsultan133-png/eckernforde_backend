import express from "express";
import { and, asc, desc, eq, getTableColumns, gte, inArray, lte, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { assignments, classes, enrollments, submissions, subjects } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireAuth, requireRole, STAFF_ROLES } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { createAssignmentSchema, updateAssignmentSchema, submitAssignmentSchema, gradeSubmissionSchema } from "../lib/schemas.js";
import { notifyEnrolledStudents, notifyStudent } from "./notifications.js";
import { sendAssignmentEmail, sendGradeEmail } from "../lib/email.js";
import { logAction } from "./audit-logs.js";
import * as policy from "../lib/policy.js";
import { getLinkedChildIds } from "../lib/policy.js";
import { runAiDetection } from "../lib/ai-detector.js";
import { activePortalClassIds, isInActivePortalClass } from "../lib/portal-context.js";

const router = express.Router();

// GET /api/homework?classId=&page=&limit=
// Lists assignments, optionally scoped to a class, newest first.
router.get("/", requireAuth, async (req, res) => {
    try {
        const { classId, subjectId, childId, academicYearId, page = 1, limit = 20, dueFrom, dueTo, sort } = req.query;

        const currentPage = Math.max(1, parseInt(String(page), 10) || 1);
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 20), 100);
        const offset = (currentPage - 1) * limitPerPage;

        const conditions = [];
        for (const [raw, lower] of [[dueFrom, true], [dueTo, false]] as const) {
            if (raw !== undefined) {
                if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) {
                    return res.status(400).json({ error: "Invalid deadline range" });
                }
                conditions.push(lower ? gte(assignments.dueAt, new Date(raw)) : lte(assignments.dueAt, new Date(raw)));
            }
        }
        if (classId) conditions.push(eq(assignments.classId, Number(classId)));
        if (subjectId) conditions.push(eq(classes.subjectId, Number(subjectId)));
        // Row-level list scoping (policy): a teacher only sees assignments for
        // classes they teach; admins/super_admins see everything.
        const teacherScope = policy.teacherClassScope(req.user!);
        if (teacherScope) conditions.push(teacherScope);

        const caller = req.user!;
        if ((policy.isTeacher(caller) || policy.isStudent(caller)) && caller.id) {
            const selectedClassIds = await activePortalClassIds({ ...caller, id: caller.id });
            if (selectedClassIds) conditions.push(selectedClassIds.length ? inArray(assignments.classId, selectedClassIds) : sql`false`);
        }

        // A parent only sees assignments for classes their own linked
        // children are enrolled in — not every class in the school.
        if (policy.isParent(req.user!)) {
            const childIds = await getLinkedChildIds({ id: req.user!.id!, email: req.user!.email });
            const requestedChildId = typeof childId === "string" && childId.trim() ? childId.trim() : null;
            if (requestedChildId && !childIds.includes(requestedChildId)) {
                return policy.forbidden(res, "You can only view homework for your linked children.");
            }
            const scopedChildIds = requestedChildId ? [requestedChildId] : childIds;
            const childClassIds = scopedChildIds.length > 0
                ? [...new Set((await db
                    .select({ classId: enrollments.classId })
                    .from(enrollments)
                    .where(inArray(enrollments.studentId, scopedChildIds))
                ).map((r) => r.classId))]
                : [];
            conditions.push(childClassIds.length > 0 ? inArray(assignments.classId, childClassIds) : sql`false`);
            if (academicYearId !== undefined) {
                const selectedYearId = Number(academicYearId);
                if (!Number.isInteger(selectedYearId) || selectedYearId <= 0) {
                    return res.status(400).json({ error: "Invalid academic year" });
                }
                conditions.push(eq(classes.academicYearId, selectedYearId));
            }
        }

        // A student only sees assignments for classes they're actually enrolled
        // in — not every class in the school. Without this, GET /api/homework
        // (or ?classId= for a class they're not in) leaks other classes' work.
        if (policy.isStudent(req.user!)) {
            const enrolledClassIds = (await db
                .select({ classId: enrollments.classId })
                .from(enrollments)
                .where(eq(enrollments.studentId, req.user!.id!))
            ).map((r) => r.classId);
            conditions.push(enrolledClassIds.length > 0 ? inArray(assignments.classId, enrolledClassIds) : sql`false`);
        }

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

        const list = await db
            .select({
                ...getTableColumns(assignments),
                class: { id: classes.id, name: classes.name },
                subject: { id: subjects.id, name: subjects.name },
                creator: { id: user.id, name: user.name },
            })
            .from(assignments)
            .innerJoin(classes, eq(assignments.classId, classes.id))
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .innerJoin(user, eq(assignments.createdBy, user.id))
            .where(whereClause)
            .orderBy(sort === "dueSoon" ? asc(assignments.dueAt) : desc(assignments.dueAt))
            .limit(limitPerPage)
            .offset(offset);

        // Enrich each row with submission progress so the list can show honest
        // workflow states (needs-grading / graded for staff; to-do / submitted /
        // graded for a student) without the client fetching each assignment.
        const assignmentIds = list.map((a) => a.id);
        const [aggRows, myRows] = await Promise.all([
            assignmentIds.length > 0
                ? db
                    .select({
                        assignmentId: submissions.assignmentId,
                        total: sql<number>`count(*)`.mapWith(Number),
                        graded: sql<number>`count(*) filter (where ${submissions.status} = 'graded')`.mapWith(Number),
                    })
                    .from(submissions)
                    .where(inArray(submissions.assignmentId, assignmentIds))
                    .groupBy(submissions.assignmentId)
                : Promise.resolve([]),
            assignmentIds.length > 0 && policy.isStudent(req.user!)
                ? db
                    .select({
                        assignmentId: submissions.assignmentId,
                        status: submissions.status,
                        score: submissions.score,
                    })
                    .from(submissions)
                    .where(and(eq(submissions.studentId, req.user!.id!), inArray(submissions.assignmentId, assignmentIds)))
                : Promise.resolve([]),
        ]);

        const aggById = new Map(aggRows.map((r) => [r.assignmentId, r]));
        const mineById = new Map(myRows.map((r) => [r.assignmentId, r]));

        const data = list.map((a) => ({
            ...a,
            submissionCount: aggById.get(a.id)?.total ?? 0,
            gradedCount: aggById.get(a.id)?.graded ?? 0,
            mySubmission: mineById.get(a.id)
                ? { status: mineById.get(a.id)!.status, score: mineById.get(a.id)!.score }
                : null,
        }));

        res.status(200).json({ data });
    } catch (e) {
        console.error("GET /homework error:", e);
        res.status(500).json({ error: "Failed to load homework" });
    }
});

// GET /api/homework/:id/report — teacher/admin only. Returns the marks
// matrix for every assignment in the selected class subject.
router.get("/:id/report", requireAuth, requireRole(...STAFF_ROLES), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid homework id" });

        const [selectedAssignment] = await db
            .select({
                id: assignments.id,
                classId: assignments.classId,
                title: assignments.title,
                class: { id: classes.id, name: classes.name },
                subject: { id: subjects.id, name: subjects.name, code: subjects.code },
            })
            .from(assignments)
            .innerJoin(classes, eq(assignments.classId, classes.id))
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .where(eq(assignments.id, id));

        if (!selectedAssignment) return res.status(404).json({ error: "Homework not found" });

        if (policy.isTeacher(req.user!) && !(await policy.canManageClass(req.user!, selectedAssignment.classId))) {
            return policy.forbidden(res, "You can only view reports for classes you teach.");
        }
        if (policy.isTeacher(req.user!) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, selectedAssignment.classId))) {
            return policy.forbidden(res, "This homework is outside your selected portal context.");
        }

        const reportAssignments = await db
            .select({ id: assignments.id, title: assignments.title, dueAt: assignments.dueAt, maxScore: assignments.maxScore })
            .from(assignments)
            .where(eq(assignments.classId, selectedAssignment.classId))
            .orderBy(asc(assignments.dueAt), asc(assignments.id));

        const classStudents = await db
            .select({ id: user.id, name: user.name, email: user.email })
            .from(enrollments)
            .innerJoin(user, eq(enrollments.studentId, user.id))
            .where(eq(enrollments.classId, selectedAssignment.classId))
            .orderBy(asc(user.name));

        const assignmentIds = reportAssignments.map((assignment) => assignment.id);
        const reportSubmissions = assignmentIds.length > 0
            ? await db
                .select({ assignmentId: submissions.assignmentId, studentId: submissions.studentId, status: submissions.status, score: submissions.score })
                .from(submissions)
                .where(inArray(submissions.assignmentId, assignmentIds))
            : [];
        const submissionByKey = new Map(reportSubmissions.map((submission) => [`${submission.studentId}:${submission.assignmentId}`, submission]));

        const students = classStudents.map((student) => {
            const marks = reportAssignments.map((assignment) => {
                const submission = submissionByKey.get(`${student.id}:${assignment.id}`);
                return {
                    assignmentId: assignment.id,
                    score: submission?.score ?? null,
                    status: submission?.status ?? "not_submitted",
                };
            });
            const scoredMarks = reportAssignments
                .map((assignment, index) => ({ score: marks[index]?.score ?? null, maxScore: assignment.maxScore }))
                .filter((mark): mark is { score: number; maxScore: number } => mark.score !== null);
            const totalScore = scoredMarks.reduce((sum, mark) => sum + mark.score, 0);
            const totalMaxScore = scoredMarks.reduce((sum, mark) => sum + mark.maxScore, 0);
            return {
                ...student,
                marks,
                totalScore,
                totalMaxScore,
                averagePercent: totalMaxScore > 0 ? Math.round((totalScore / totalMaxScore) * 1000) / 10 : null,
            };
        });

        const averages = students.map((student) => student.averagePercent).filter((average): average is number => average !== null);
        const gradedMarks = reportSubmissions.filter((submission) => submission.status === "graded" && submission.score !== null).length;
        res.json({
            data: {
                selectedAssignment: { id: selectedAssignment.id, title: selectedAssignment.title },
                class: selectedAssignment.class,
                subject: selectedAssignment.subject,
                assignments: reportAssignments,
                students,
                summary: {
                    studentCount: students.length,
                    assignmentCount: reportAssignments.length,
                    gradedMarks,
                    classAveragePercent: averages.length ? Math.round((averages.reduce((sum, average) => sum + average, 0) / averages.length) * 10) / 10 : null,
                },
            },
        });
    } catch (e) {
        console.error("GET /homework/:id/report error:", e);
        res.status(500).json({ error: "Failed to load homework report" });
    }
});

// GET /api/homework/:id
// Assignment detail. If the caller is a student, also returns their own submission (if any).
router.get("/:id", requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid homework id" });

        const [assignment] = await db
            .select({
                ...getTableColumns(assignments),
                class: { id: classes.id, name: classes.name },
                creator: { id: user.id, name: user.name },
            })
            .from(assignments)
            .innerJoin(classes, eq(assignments.classId, classes.id))
            .innerJoin(user, eq(assignments.createdBy, user.id))
            .where(eq(assignments.id, id));

        if (!assignment) return res.status(404).json({ error: "Homework not found" });

        if (req.user!.id && (policy.isTeacher(req.user!) || policy.isStudent(req.user!)) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id }, assignment.classId))) {
            return policy.forbidden(res, "This homework is outside your selected portal context.");
        }

        if (policy.isParent(req.user!)) {
            const childIds = await getLinkedChildIds({ id: req.user!.id!, email: req.user!.email });
            if (!(await policy.anyChildEnrolledInClass(childIds, assignment.classId))) {
                return policy.forbidden(res, "None of your children are enrolled in this class.");
            }
        }

        let mySubmission = null;
        if (req.user?.role === "student" && req.user.id) {
            const [row] = await db
                .select()
                .from(submissions)
                .where(and(eq(submissions.assignmentId, id), eq(submissions.studentId, req.user.id)));
            mySubmission = row ?? null;
        }

        res.status(200).json({ data: { ...assignment, mySubmission } });
    } catch (e) {
        console.error("GET /homework/:id error:", e);
        res.status(500).json({ error: "Failed to load homework" });
    }
});

// POST /api/homework — teacher/admin only
router.post("/", requireAuth, requireRole(...STAFF_ROLES), validateBody(createAssignmentSchema), async (req, res) => {
    try {
        const { classId, title, description, dueAt, maxScore, attachmentUrl, attachmentCldPubId, attachmentName } = req.body as {
            classId: number;
            title: string;
            description?: string | null;
            dueAt?: string | null;
            maxScore?: number;
            attachmentUrl?: string | null;
            attachmentCldPubId?: string | null;
            attachmentName?: string | null;
        };

        if (policy.isTeacher(req.user!) && !(await policy.canManageClass(req.user!, classId))) {
            return policy.forbidden(res, "You can only create homework for classes you teach.");
        }
        if (policy.isTeacher(req.user!) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, classId))) {
            return policy.forbidden(res, "This class is outside your selected portal context.");
        }

        const [created] = await db
            .insert(assignments)
            .values({
                classId,
                title: title.trim(),
                description: description ?? null,
                dueAt: dueAt ? new Date(dueAt) : null,
                maxScore: maxScore && maxScore > 0 ? maxScore : 100,
                attachmentUrl: attachmentUrl ?? null,
                attachmentCldPubId: attachmentCldPubId ?? null,
                attachmentName: attachmentName ?? null,
                createdBy: req.user!.id!,
            })
            .returning();

        await logAction({ req, action: "assignment.create", resource: "assignments", resourceId: created?.id, details: `Created homework "${title.trim()}"` });

        // Notify enrolled students about the new assignment
        if (created) {
            await notifyEnrolledStudents({
                classId,
                type: "assignment",
                title: "New Homework",
                message: `"${title.trim()}" has been posted.${dueAt ? ` Due: ${new Date(dueAt).toLocaleDateString()}` : ""}`,
                link: `/homework/${created.id}`,
            });

            // Send email to enrolled students
            const enrolled = await db.select({ email: user.email }).from(enrollments)
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .where(eq(enrollments.classId, classId));
            const emails = enrolled.map((e) => e.email).filter(Boolean) as string[];
            if (emails.length > 0) {
                const [cls] = await db.select({ name: classes.name }).from(classes).where(eq(classes.id, classId));
                sendAssignmentEmail({
                    to: emails,
                    assignmentTitle: title.trim(),
                    className: cls?.name ?? "Your class",
                    dueAt: dueAt ? new Date(dueAt) : null,
                    assignmentUrl: `${process.env.FRONTEND_URL}/homework/${created.id}`,
                }); // fire-and-forget
            }
        }

        res.status(201).json({ data: created });
    } catch (e) {
        console.error("POST /homework error:", e);
        res.status(500).json({ error: "Failed to create homework" });
    }
});

// PUT /api/homework/:id — teacher/admin only
router.put("/:id", requireAuth, requireRole(...STAFF_ROLES), validateBody(updateAssignmentSchema), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid homework id" });

        const [existing] = await db.select({ classId: assignments.classId }).from(assignments).where(eq(assignments.id, id));
        if (!existing) return res.status(404).json({ error: "Homework not found" });
        if (policy.isTeacher(req.user!) && !(await policy.canManageClass(req.user!, existing.classId))) {
            return policy.forbidden(res, "You can only edit homework for classes you teach.");
        }
        if (policy.isTeacher(req.user!) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, existing.classId))) {
            return policy.forbidden(res, "This homework is outside your selected portal context.");
        }

        const { title, description, dueAt, maxScore, attachmentUrl, attachmentCldPubId, attachmentName } = req.body as {
            title?: string;
            description?: string;
            dueAt?: string | null;
            maxScore?: number;
            attachmentUrl?: string | null;
            attachmentCldPubId?: string | null;
            attachmentName?: string | null;
        };

        const [updated] = await db
            .update(assignments)
            .set({
                ...(title !== undefined ? { title } : {}),
                ...(description !== undefined ? { description } : {}),
                ...(dueAt !== undefined ? { dueAt: dueAt ? new Date(dueAt) : null } : {}),
                ...(maxScore !== undefined ? { maxScore } : {}),
                ...(attachmentUrl !== undefined ? { attachmentUrl } : {}),
                ...(attachmentCldPubId !== undefined ? { attachmentCldPubId } : {}),
                ...(attachmentName !== undefined ? { attachmentName } : {}),
            })
            .where(eq(assignments.id, id))
            .returning();

        if (!updated) return res.status(404).json({ error: "Homework not found" });

        await logAction({ req, action: "assignment.update", resource: "assignments", resourceId: id });

        res.status(200).json({ data: updated });
    } catch (e) {
        console.error("PUT /homework/:id error:", e);
        res.status(500).json({ error: "Failed to update homework" });
    }
});

// DELETE /api/homework/:id — teacher/admin only
router.delete("/:id", requireAuth, requireRole(...STAFF_ROLES), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid homework id" });

        const [existing] = await db.select({ classId: assignments.classId }).from(assignments).where(eq(assignments.id, id));
        if (!existing) return res.status(404).json({ error: "Homework not found" });
        if (policy.isTeacher(req.user!) && !(await policy.canManageClass(req.user!, existing.classId))) {
            return policy.forbidden(res, "You can only delete homework for classes you teach.");
        }
        if (policy.isTeacher(req.user!) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, existing.classId))) {
            return policy.forbidden(res, "This homework is outside your selected portal context.");
        }

        const [deleted] = await db.delete(assignments).where(eq(assignments.id, id)).returning({ id: assignments.id });
        if (!deleted) return res.status(404).json({ error: "Homework not found" });

        await logAction({ req, action: "assignment.delete", resource: "assignments", resourceId: id });

        res.status(200).json({ data: deleted });
    } catch (e) {
        console.error("DELETE /homework/:id error:", e);
        res.status(500).json({ error: "Failed to delete homework" });
    }
});

// POST /api/homework/:id/submit — student only. Upserts the caller's own submission.
router.post("/:id/submit", requireAuth, requireRole("student"), validateBody(submitAssignmentSchema), async (req, res) => {
    try {
        const assignmentId = Number(req.params.id);
        if (!Number.isFinite(assignmentId)) return res.status(400).json({ error: "Invalid homework id" });

        const { content, fileUrl, fileCldPubId, fileName } = req.body as {
            content?: string | null;
            fileUrl?: string | null;
            fileCldPubId?: string | null;
            fileName?: string | null;
        };

        const [assignment] = await db.select().from(assignments).where(eq(assignments.id, assignmentId));
        if (!assignment) return res.status(404).json({ error: "Homework not found" });

        if (!(await policy.isEnrolledInClass(req.user!.id!, assignment.classId))) {
            return policy.forbidden(res, "You are not enrolled in this class.");
        }
        if (!(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, assignment.classId))) {
            return policy.forbidden(res, "This homework is outside your selected portal context.");
        }

        // Once the deadline passes, submission is closed entirely — no more
        // late submissions accepted.
        if (assignment.dueAt && new Date() > assignment.dueAt) {
            return res.status(403).json({ error: "The deadline for this homework has passed. You can no longer submit." });
        }

        const studentId = req.user!.id!;

        // A submission is final — once it exists, it can't be resubmitted or
        // overwritten (by the student; a teacher regrading is unaffected).
        const [existingSubmission] = await db
            .select({ id: submissions.id })
            .from(submissions)
            .where(and(eq(submissions.assignmentId, assignmentId), eq(submissions.studentId, studentId)));
        if (existingSubmission) {
            return res.status(409).json({ error: "You've already submitted this homework. Resubmitting isn't allowed." });
        }

        const [result] = await db
            .insert(submissions)
            .values({
                assignmentId,
                studentId,
                content: content ?? null,
                fileUrl: fileUrl ?? null,
                fileCldPubId: fileCldPubId ?? null,
                fileName: fileName ?? null,
                status: "submitted",
                submittedAt: new Date(),
            })
            .returning();

        if (result && content) {
            void runAiDetection(result.id, content);
        }

        res.status(200).json({ data: result });
    } catch (e) {
        console.error("POST /homework/:id/submit error:", e);
        res.status(500).json({ error: "Failed to submit homework" });
    }
});

// GET /api/homework/:id/submissions — teacher/admin only. All submissions for grading.
router.get("/:id/submissions", requireAuth, requireRole(...STAFF_ROLES), async (req, res) => {
    try {
        const assignmentId = Number(req.params.id);
        if (!Number.isFinite(assignmentId)) return res.status(400).json({ error: "Invalid homework id" });

        const [assignment] = await db.select({ classId: assignments.classId }).from(assignments).where(eq(assignments.id, assignmentId));
        if (!assignment) return res.status(404).json({ error: "Homework not found" });
        if (policy.isTeacher(req.user!) && !(await policy.canManageClass(req.user!, assignment.classId))) {
            return policy.forbidden(res, "You can only view submissions for classes you teach.");
        }
        if (policy.isTeacher(req.user!) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, assignment.classId))) {
            return policy.forbidden(res, "This homework is outside your selected portal context.");
        }

        const rows = await db
            .select({
                ...getTableColumns(submissions),
                student: { id: user.id, name: user.name, email: user.email, image: user.image },
            })
            .from(submissions)
            .innerJoin(user, eq(submissions.studentId, user.id))
            .where(eq(submissions.assignmentId, assignmentId))
            .orderBy(desc(submissions.submittedAt));

        res.status(200).json({ data: rows });
    } catch (e) {
        console.error("GET /homework/:id/submissions error:", e);
        res.status(500).json({ error: "Failed to load submissions" });
    }
});

// PUT /api/homework/submissions/:submissionId/grade — teacher/admin only
router.put("/submissions/:submissionId/grade", requireAuth, requireRole(...STAFF_ROLES), validateBody(gradeSubmissionSchema), async (req, res) => {
    try {
        const submissionId = Number(req.params.submissionId);
        if (!Number.isFinite(submissionId)) return res.status(400).json({ error: "Invalid submission id" });

        if (policy.isTeacher(req.user!)) {
            const [existingSubmission] = await db
                .select({ classId: assignments.classId })
                .from(submissions)
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .where(eq(submissions.id, submissionId));
            if (!existingSubmission) return res.status(404).json({ error: "Submission not found" });
            if (!(await policy.canManageClass(req.user!, existingSubmission.classId))) {
                return policy.forbidden(res, "You can only grade submissions for classes you teach.");
            }
            if (!(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, existingSubmission.classId))) {
                return policy.forbidden(res, "This homework is outside your selected portal context.");
            }
        }

        const { score, feedback } = req.body as { score: number; feedback?: string | null };

        const [updated] = await db
            .update(submissions)
            .set({
                score: Number(score),
                feedback: feedback ?? null,
                status: "graded",
                gradedBy: req.user!.id!,
                gradedAt: new Date(),
            })
            .where(eq(submissions.id, submissionId))
            .returning();

        if (!updated) return res.status(404).json({ error: "Submission not found" });

        await logAction({ req, action: "submission.grade", resource: "submissions", resourceId: submissionId, details: `Score: ${score}` });

        // Notify the student that their work has been graded
        await notifyStudent({
            userId: updated.studentId,
            type: "grade",
            title: "Homework Graded",
            message: `Your submission has been graded. Score: ${score}.${feedback ? ` Feedback: ${feedback}` : ""}`,
            link: `/homework/${updated.assignmentId}`,
        });

        // Send grade email to student
        const [studentUser] = await db.select({ email: user.email, name: user.name })
            .from(user).where(eq(user.id, updated.studentId));
        const [assignment] = await db.select({ title: assignments.title, maxScore: assignments.maxScore })
            .from(assignments).where(eq(assignments.id, updated.assignmentId));
        if (studentUser?.email && assignment) {
            const feedbackStr = typeof feedback === "string" && feedback ? feedback : undefined;
            sendGradeEmail({
                to: studentUser.email,
                studentName: studentUser.name,
                assignmentTitle: assignment.title,
                score: Number(score),
                maxScore: assignment.maxScore,
                ...(feedbackStr ? { feedback: feedbackStr } : {}),
                assignmentUrl: `${process.env.FRONTEND_URL}/homework/${updated.assignmentId}`,
            }); // fire-and-forget
        }

        res.status(200).json({ data: updated });
    } catch (e) {
        console.error("PUT /homework/submissions/:submissionId/grade error:", e);
        res.status(500).json({ error: "Failed to grade submission" });
    }
});

export default router;
