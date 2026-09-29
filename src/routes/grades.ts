import express from "express";
import { and, asc, avg, desc, eq, getTableColumns, ilike, inArray, or, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { academicTerms, academicYears, assignments, classGrades, classes, enrollments, examResults, exams, studentProfiles, submissions, subjects, termSubjectResults } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { ADMIN_ROLES, requireAuth, requireRole, STAFF_ROLES } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { createAcademicTermSchema, createAcademicYearSchema, createExamSchema, examResultsSchema, gradebookSaveSchema, publishTermSubjectResultsSchema, saveTermSubjectResultsSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";
import * as policy from "../lib/policy.js";
import { activePortalClassIds, isInActivePortalClass } from "../lib/portal-context.js";
import { getLinkedChildIds } from "../lib/policy.js";
import { calculateSecondaryDivision, gradeSecondaryScore } from "../lib/grading/student-division.js";
import { calculateStudentPosition } from "../lib/grading/student-position.js";
import { notifyStudent } from "./notifications.js";
import { schoolToday } from "../lib/academic-year.js";

const router = express.Router();

// ─── Grade helper ─────────────────────────────────────────────────────────────
// The approved A–F thresholds are centralized with the secondary Division
// rules. GPA is deliberately not calculated or exposed by this gradebook.
const toLetterGrade = (score: number): string => {
    return gradeSecondaryScore(score).grade;
};

// ─── FORMAL TERMS / RESULTS ──────────────────────────────────────────────────
router.get("/academic-years", requireAuth, async (_req, res) => {
    try {
        const years = await db.select().from(academicYears).orderBy(desc(academicYears.startsOn));
        res.json({ data: years });
    } catch (e) {
        console.error("GET /grades/academic-years error:", e);
        res.status(500).json({ error: "Failed to load academic years" });
    }
});

router.post("/academic-years", requireAuth, requireRole(...ADMIN_ROLES), validateBody(createAcademicYearSchema), async (req, res) => {
    try {
        const { name, startsOn, endsOn, active } = req.body;
        if (active && (startsOn > schoolToday() || endsOn < schoolToday())) return res.status(400).json({ error: "Only a year covering today can be active. Create a future year as inactive and activate it when it begins." });
        const created = await db.transaction(async (transaction) => {
            if (active) await transaction.update(academicYears).set({ active: false });
            const [year] = await transaction.insert(academicYears).values({ name, startsOn, endsOn, active: active ?? false }).returning();
            return year;
        });
        await logAction({ req, action: "academic-year.create", resource: "academic_years", resourceId: created?.id, details: `Created academic year ${name}` });
        res.status(201).json({ data: created });
    } catch (e) {
        console.error("POST /grades/academic-years error:", e);
        res.status(500).json({ error: "Failed to create academic year" });
    }
});

router.patch("/academic-years/:id/activate", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Choose a valid academic year." });
        const [year] = await db.select().from(academicYears).where(eq(academicYears.id, id));
        if (!year) return res.status(404).json({ error: "Academic year not found." });
        const today = schoolToday();
        if (year.startsOn > today || year.endsOn < today) return res.status(400).json({ error: "This year cannot be activated outside its configured dates." });
        const activated = await db.transaction(async (transaction) => {
            await transaction.update(academicYears).set({ active: false });
            const [current] = await transaction.update(academicYears).set({ active: true }).where(eq(academicYears.id, id)).returning();
            return current;
        });
        await logAction({ req, action: "academic-year.activate", resource: "academic_years", resourceId: id, details: `Activated academic year ${year.name}` });
        return res.json({ data: activated });
    } catch (error) {
        console.error("PATCH /grades/academic-years/:id/activate error:", error);
        return res.status(500).json({ error: "Failed to activate academic year" });
    }
});

router.get("/academic-terms", requireAuth, async (req, res) => {
    try {
        const academicYearId = req.query.academicYearId ? Number(req.query.academicYearId) : undefined;
        const terms = await db.select({ ...getTableColumns(academicTerms), academicYear: { id: academicYears.id, name: academicYears.name } })
            .from(academicTerms).innerJoin(academicYears, eq(academicTerms.academicYearId, academicYears.id))
            .where(academicYearId ? eq(academicTerms.academicYearId, academicYearId) : undefined)
            .orderBy(desc(academicTerms.startsOn));
        res.json({ data: terms });
    } catch (e) {
        console.error("GET /grades/academic-terms error:", e);
        res.status(500).json({ error: "Failed to load academic terms" });
    }
});

router.post("/academic-terms", requireAuth, requireRole(...ADMIN_ROLES), validateBody(createAcademicTermSchema), async (req, res) => {
    try {
        const { academicYearId, name, type, startsOn, endsOn } = req.body;
        const [year] = await db.select({ id: academicYears.id }).from(academicYears).where(eq(academicYears.id, academicYearId));
        if (!year) return res.status(404).json({ error: "Academic year not found" });
        const [created] = await db.insert(academicTerms).values({ academicYearId, name, type, startsOn, endsOn }).returning();
        await logAction({ req, action: "academic-term.create", resource: "academic_terms", resourceId: created?.id, details: `Created ${type} term ${name}` });
        res.status(201).json({ data: created });
    } catch (e) {
        console.error("POST /grades/academic-terms error:", e);
        res.status(500).json({ error: "Failed to create academic term" });
    }
});

router.post("/term-results", requireAuth, requireRole(...STAFF_ROLES), validateBody(saveTermSubjectResultsSchema), async (req, res) => {
    try {
        const { academicTermId, classId, records } = req.body;
        if (policy.isTeacher(req.user!) && !(await policy.canManageClass(req.user!, classId))) return policy.forbidden(res, "You can only record results for classes you teach.");
        if (policy.isTeacher(req.user!) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, classId))) return policy.forbidden(res, "This class is outside your selected portal context.");

        const [[term], [course], roster] = await Promise.all([
            db.select({ id: academicTerms.id }).from(academicTerms).where(eq(academicTerms.id, academicTermId)),
            db.select({ subjectId: classes.subjectId, schoolLevel: classes.schoolLevel }).from(classes).where(eq(classes.id, classId)),
            db.select({ studentId: enrollments.studentId }).from(enrollments).where(eq(enrollments.classId, classId)),
        ]);
        if (!term) return res.status(404).json({ error: "Academic term not found" });
        if (!course) return res.status(404).json({ error: "Class not found" });
        if (!course.schoolLevel) return res.status(400).json({ error: "This class must be assigned a school level by an administrator before results can be recorded." });
        const enrolled = new Set(roster.map((row) => row.studentId));
        if (records.some((record: { studentId: string }) => !enrolled.has(record.studentId))) return res.status(400).json({ error: "Every result must belong to an enrolled student." });

        const saved = await db.insert(termSubjectResults).values(records.map((record: { studentId: string; score: number; applicable?: boolean }) => ({
            academicTermId, classId, subjectId: course.subjectId, studentId: record.studentId, schoolLevel: course.schoolLevel, score: record.score, applicable: record.applicable ?? true, published: true, enteredBy: req.user!.id!,
        }))).onConflictDoUpdate({
            target: [termSubjectResults.academicTermId, termSubjectResults.classId, termSubjectResults.studentId],
            set: { score: sql`excluded.score`, applicable: sql`excluded.applicable`, schoolLevel: sql`excluded.school_level`, published: true, enteredBy: req.user!.id!, updatedAt: new Date() },
        }).returning();
        await logAction({ req, action: "term-results.save", resource: "term_subject_results", resourceId: classId, details: `Saved ${records.length} ${course.schoolLevel} term result(s)` });
        res.json({ data: saved });
    } catch (e) {
        console.error("POST /grades/term-results error:", e);
        res.status(500).json({ error: "Failed to save term results" });
    }
});

router.post("/term-results/publish", requireAuth, requireRole(...ADMIN_ROLES), validateBody(publishTermSubjectResultsSchema), async (req, res) => {
    try {
        const { academicTermId, classId, published } = req.body;
        const updated = await db.update(termSubjectResults).set({ published, updatedAt: new Date() })
            .where(and(eq(termSubjectResults.academicTermId, academicTermId), eq(termSubjectResults.classId, classId)))
            .returning({ id: termSubjectResults.id });
        if (published && updated.length > 0) {
            const recipients = await db.select({ studentId: termSubjectResults.studentId, parentId: studentProfiles.parentUserId })
                .from(termSubjectResults)
                .leftJoin(studentProfiles, eq(studentProfiles.userId, termSubjectResults.studentId))
                .where(and(eq(termSubjectResults.academicTermId, academicTermId), eq(termSubjectResults.classId, classId)));
            const userIds = [
                ...new Set(
                    recipients.flatMap((recipient) =>
                        [recipient.studentId, recipient.parentId].filter((id): id is string => Boolean(id)),
                    ),
                ),
            ];
            await Promise.all(userIds.map((userId) => notifyStudent({ userId, type: "grade", title: "Term results available", message: "Your approved term results are now available in the secure portal.", link: "/grades/term-results" })));
        }
        await logAction({ req, action: published ? "term-results.publish" : "term-results.unpublish", resource: "term_subject_results", resourceId: `${academicTermId}:${classId}`, details: `${published ? "Published" : "Unpublished"} ${updated.length} result(s)` });
        res.json({ data: { published, count: updated.length } });
    } catch (e) {
        console.error("POST /grades/term-results/publish error:", e);
        res.status(500).json({ error: "Failed to update result publication" });
    }
});

// Must be registered before /term-results/:studentId so "class" is not
// interpreted as a student id.
router.get("/term-results/class/:classId", requireAuth, requireRole(...STAFF_ROLES), async (req, res) => {
    try {
        const classId = Number(req.params.classId);
        const academicTermId = Number(req.query.academicTermId);
        if (!Number.isInteger(classId) || !Number.isInteger(academicTermId)) return res.status(400).json({ error: "Valid classId and academicTermId are required" });
        if (policy.isTeacher(req.user!) && !(await policy.canManageClass(req.user!, classId))) return policy.forbidden(res, "You can only view results for classes you teach.");
        if (policy.isTeacher(req.user!) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, classId))) return policy.forbidden(res, "This class is outside your selected portal context.");
        const rows = await db.select({ ...getTableColumns(termSubjectResults), student: { id: user.id, name: user.name, email: user.email } })
            .from(termSubjectResults).innerJoin(user, eq(termSubjectResults.studentId, user.id))
            .where(and(eq(termSubjectResults.academicTermId, academicTermId), eq(termSubjectResults.classId, classId))).orderBy(user.name);
        res.json({ data: rows });
    } catch (e) {
        console.error("GET /grades/term-results/class/:classId error:", e);
        res.status(500).json({ error: "Failed to load class term results" });
    }
});

router.get("/term-results/:studentId", requireAuth, async (req, res) => {
    try {
        const studentId = String(req.params.studentId ?? "");
        const academicTermId = Number(req.query.academicTermId);
        if (!Number.isInteger(academicTermId) || academicTermId <= 0) return res.status(400).json({ error: "academicTermId is required" });
        if (!(await policy.canAccessStudent(req.user!, studentId))) return policy.forbidden(res);
        const [term] = await db.select().from(academicTerms).where(eq(academicTerms.id, academicTermId));
        if (!term) return res.status(404).json({ error: "Academic term not found" });

        const rows = await db.select({ ...getTableColumns(termSubjectResults), subject: { id: subjects.id, name: subjects.name, code: subjects.code }, class: { id: classes.id, name: classes.name } })
            .from(termSubjectResults).innerJoin(subjects, eq(termSubjectResults.subjectId, subjects.id)).innerJoin(classes, eq(termSubjectResults.classId, classes.id))
            .where(and(eq(termSubjectResults.academicTermId, academicTermId), eq(termSubjectResults.studentId, studentId), eq(termSubjectResults.published, true))).orderBy(subjects.name);

        // Older teacher workflows stored marks as exam_results instead of the
        // newer formal term_subject_results records. Keep those real marks
        // visible in the report while schools migrate to formal entry: exam
        // examType identifies Midterm vs Annual/Terminal and scores are
        // normalized to percentages using each exam's max score. Keep the
        // title checks for older rows created before examType was introduced.
        const legacyRows = rows.length > 0 ? [] : await db.select({
            id: examResults.id,
            academicTermId: sql<number>`${academicTermId}`,
            classId: exams.classId,
            subjectId: classes.subjectId,
            studentId: examResults.studentId,
            schoolLevel: classes.schoolLevel,
            score: sql<number>`round((${examResults.score}::numeric / nullif(${exams.maxScore}, 0)) * 100, 2)`.mapWith(Number),
            applicable: sql<boolean>`true`.mapWith(Boolean),
            published: sql<boolean>`true`.mapWith(Boolean),
            enteredBy: exams.createdBy,
            createdAt: examResults.createdAt,
            updatedAt: examResults.updatedAt,
            subject: { id: subjects.id, name: subjects.name, code: subjects.code },
            class: { id: classes.id, name: classes.name },
        })
            .from(examResults)
            .innerJoin(exams, eq(examResults.examId, exams.id))
            .innerJoin(classes, eq(exams.classId, classes.id))
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .where(and(
                eq(examResults.studentId, studentId),
                term.type === "midterm"
                    ? or(eq(exams.examType, "midterm"), ilike(exams.title, "%midterm%"))
                    : or(eq(exams.examType, "annual"), ilike(exams.title, "%annual%"), ilike(exams.title, "%terminal%")),
            ))
            .orderBy(subjects.name, desc(exams.scheduledAt), desc(exams.createdAt), desc(examResults.createdAt));
        // A student should have one mark per subject and term. Older exam
        // workflows could leave multiple exam rows for the same subject; the
        // ordered query above makes the newest mark authoritative for the
        // report and prevents repeated subjects.
        const reportRows = rows.length > 0
            ? rows
            : Array.from(new Map(legacyRows.map((row) => [row.subjectId, row])).values());
        const secondary = reportRows.some((row) => row.schoolLevel === "secondary");
        // Position is based only on published formal marks in the same report
        // subjects. Legacy marks remain visible, but cannot be fairly ranked
        // until the cohort has been moved to formal term results.
        const positionClassIds = rows.length > 0
            ? rows.filter((row) => row.applicable).map((row) => row.classId)
            : legacyRows.filter((row) => row.applicable).map((row) => row.classId);
        const cohortRows = rows.length > 0
            ? await db.select({ studentId: termSubjectResults.studentId, classId: termSubjectResults.classId, score: termSubjectResults.score, applicable: termSubjectResults.applicable, schoolLevel: termSubjectResults.schoolLevel })
                .from(termSubjectResults)
                .where(and(eq(termSubjectResults.academicTermId, academicTermId), eq(termSubjectResults.published, true), inArray(termSubjectResults.classId, positionClassIds)))
            : positionClassIds.length > 0
                ? (await db.select({ studentId: examResults.studentId, classId: exams.classId, score: sql<number>`round((${examResults.score}::numeric / nullif(${exams.maxScore}, 0)) * 100, 2)`.mapWith(Number), applicable: sql<boolean>`true`.mapWith(Boolean), schoolLevel: classes.schoolLevel, examId: exams.id, markedAt: examResults.createdAt })
                    .from(examResults)
                    .innerJoin(exams, eq(examResults.examId, exams.id))
                    .innerJoin(classes, eq(exams.classId, classes.id))
                    .where(and(
                        inArray(exams.classId, positionClassIds),
                        term.type === "midterm"
                            ? or(eq(exams.examType, "midterm"), ilike(exams.title, "%midterm%"))
                            : or(eq(exams.examType, "annual"), ilike(exams.title, "%annual%"), ilike(exams.title, "%terminal%")),
                    ))
                    .orderBy(desc(examResults.createdAt))).filter((row, index, all) => all.findIndex((candidate) => candidate.studentId === row.studentId && candidate.classId === row.classId) === index)
                : [];
        const position = calculateStudentPosition(studentId, positionClassIds, cohortRows, secondary);
        // Each published paper is reported independently.  Secondary division is
        // calculated from that paper's marks so the midterm and terminal papers
        // can legitimately have different divisions.
        const secondaryRows = reportRows.filter((row) => row.schoolLevel === "secondary");
        const division = secondaryRows.length > 0 ? calculateSecondaryDivision(secondaryRows.map((row) => ({ subjectId: row.subjectId, score: row.score, applicable: row.applicable }))) : null;
        res.json({ data: reportRows, term: { id: term.id, name: term.name, type: term.type }, division, position });
    } catch (e) {
        console.error("GET /grades/term-results/:studentId error:", e);
        res.status(500).json({ error: "Failed to load term results" });
    }
});

// ─── EXAMS ────────────────────────────────────────────────────────────────────

// GET /api/grades/exams?classId=
router.get("/exams", requireAuth, async (req, res) => {
    try {
        const classId = req.query.classId ? Number(req.query.classId) : undefined;
        const conditions = classId ? [eq(exams.classId, classId)] : [];
        // A teacher only sees exams for classes they teach — not every
        // teacher's. Admins, parents, and super_admins see everything.
        const teacherScope = policy.teacherClassScope(req.user!);
        if (teacherScope) conditions.push(teacherScope);
        const caller = req.user!;
        if ((policy.isTeacher(caller) || policy.isStudent(caller)) && caller.id) {
            const selectedClassIds = await activePortalClassIds({ ...caller, id: caller.id });
            if (selectedClassIds) conditions.push(selectedClassIds.length ? inArray(exams.classId, selectedClassIds) : sql`false`);
        }

        const list = await db
            .select({
                ...getTableColumns(exams),
                class: { id: classes.id, name: classes.name },
                creator: { id: user.id, name: user.name },
            })
            .from(exams)
            .innerJoin(classes, eq(exams.classId, classes.id))
            .innerJoin(user, eq(exams.createdBy, user.id))
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(desc(exams.scheduledAt));

        res.json({ data: list });
    } catch (e) {
        console.error("GET /grades/exams error:", e);
        res.status(500).json({ error: "Failed to load exams" });
    }
});

// POST /api/grades/exams — teacher/admin
router.post("/exams", requireAuth, requireRole(...STAFF_ROLES), validateBody(createExamSchema), async (req, res) => {
    try {
        const { classId, title, examType, description, scheduledAt, durationMinutes, maxScore, venue } = req.body as {
            classId: number; title: string; examType: "midterm" | "annual"; description?: string | null;
            scheduledAt?: string | null; durationMinutes?: number | null; maxScore?: number; venue?: string | null;
        };

        if (policy.isTeacher(req.user!) && !(await policy.canManageClass(req.user!, classId))) {
            return policy.forbidden(res, "You can only create exams for classes you teach.");
        }
        if (policy.isTeacher(req.user!) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, classId))) {
            return policy.forbidden(res, "This class is outside your selected portal context.");
        }

        const [created] = await db.insert(exams).values({
            classId,
            title: title.trim(),
            examType,
            description: description ?? null,
            scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
            durationMinutes: durationMinutes ?? null,
            maxScore: maxScore && maxScore > 0 ? maxScore : 100,
            venue: venue ?? null,
            createdBy: req.user!.id!,
        }).returning();

        await logAction({ req, action: "exam.create", resource: "exams", resourceId: created?.id, details: `Created exam "${title.trim()}"` });

        res.status(201).json({ data: created });
    } catch (e) {
        console.error("POST /grades/exams error:", e);
        res.status(500).json({ error: "Failed to create exam" });
    }
});

// DELETE /api/grades/exams/:id — teacher/admin
router.delete("/exams/:id", requireAuth, requireRole(...STAFF_ROLES), async (req, res) => {
    try {
        const id = Number(req.params.id);

        const [existing] = await db.select({ classId: exams.classId }).from(exams).where(eq(exams.id, id));
        if (!existing) return res.status(404).json({ error: "Exam not found" });
        if (policy.isTeacher(req.user!) && !(await policy.canManageClass(req.user!, existing.classId))) {
            return policy.forbidden(res, "You can only delete exams for classes you teach.");
        }

        const [deleted] = await db.delete(exams).where(eq(exams.id, id)).returning({ id: exams.id });
        if (!deleted) return res.status(404).json({ error: "Exam not found" });
        await logAction({ req, action: "exam.delete", resource: "exams", resourceId: id });
        res.json({ data: deleted });
    } catch (e) {
        console.error("DELETE /grades/exams/:id error:", e);
        res.status(500).json({ error: "Failed to delete exam" });
    }
});

// ─── EXAM RESULTS ─────────────────────────────────────────────────────────────

// GET /api/grades/exams/:examId/results — teacher/admin sees all; student sees own
router.get("/exams/:examId/results", requireAuth, async (req, res) => {
    try {
        const examId = Number(req.params.examId);

        if (policy.isTeacher(req.user!)) {
            const [exam] = await db.select({ classId: exams.classId }).from(exams).where(eq(exams.id, examId));
            if (!exam) return res.status(404).json({ error: "Exam not found" });
            if (!(await policy.canManageClass(req.user!, exam.classId))) {
                return policy.forbidden(res, "You can only view results for classes you teach.");
            }
        }

        const rows = await db
            .select({
                ...getTableColumns(examResults),
                student: { id: user.id, name: user.name, email: user.email, image: user.image },
            })
            .from(examResults)
            .innerJoin(user, eq(examResults.studentId, user.id))
            .where(
                policy.isStudent(req.user!)
                    ? and(eq(examResults.examId, examId), eq(examResults.studentId, req.user!.id!))
                    : eq(examResults.examId, examId)
            )
            .orderBy(user.name);

        res.json({ data: rows });
    } catch (e) {
        console.error("GET /grades/exams/:examId/results error:", e);
        res.status(500).json({ error: "Failed to load exam results" });
    }
});

// POST /api/grades/exams/:examId/results — bulk upsert results (teacher/admin)
router.post("/exams/:examId/results", requireAuth, requireRole(...STAFF_ROLES), validateBody(examResultsSchema), async (req, res) => {
    try {
        const examId = Number(req.params.examId);
        const { records } = req.body as { records: Array<{ studentId: string; score: number; remarks?: string | null }> };

        const [exam] = await db
            .select({ classId: exams.classId, maxScore: exams.maxScore })
            .from(exams)
            .where(eq(exams.id, examId));
        if (!exam) return res.status(404).json({ error: "Exam not found" });

        if (policy.isTeacher(req.user!)) {
            if (!(await policy.canManageClass(req.user!, exam.classId))) {
                return policy.forbidden(res, "You can only grade exams for classes you teach.");
            }
        }

        const studentIds = records.map((record) => record.studentId);
        if (new Set(studentIds).size !== studentIds.length) {
            return res.status(400).json({ error: "Each student can only appear once in a save." });
        }
        const invalidScore = records.find((record) => record.score > exam.maxScore);
        if (invalidScore) {
            return res.status(400).json({ error: `Scores cannot exceed this exam's maximum of ${exam.maxScore}.` });
        }
        const enrolledRows = await db
            .select({ studentId: enrollments.studentId })
            .from(enrollments)
            .where(and(eq(enrollments.classId, exam.classId), inArray(enrollments.studentId, studentIds)));
        if (enrolledRows.length !== studentIds.length) {
            return res.status(400).json({ error: "Every result must belong to a student enrolled in this exam's class." });
        }

        const gradedBy = req.user!.id!;
        const result = await db
            .insert(examResults)
            .values(records.map((r) => ({ examId, studentId: r.studentId, score: r.score, remarks: r.remarks ?? null, gradedBy })))
            .onConflictDoUpdate({
                target: [examResults.examId, examResults.studentId],
                set: {
                    score: sql`excluded.score`,
                    remarks: sql`excluded.remarks`,
                    gradedBy: sql`excluded.graded_by`,
                    updatedAt: new Date(),
                },
            })
            .returning();

        await logAction({ req, action: "exam.grade", resource: "exam_results", resourceId: examId, details: `Saved results for ${records.length} student(s)` });

        res.json({ data: result });
    } catch (e) {
        console.error("POST /grades/exams/:examId/results error:", e);
        res.status(500).json({ error: "Failed to save exam results" });
    }
});

// ─── GRADEBOOK ────────────────────────────────────────────────────────────────

// GET /api/grades/gradebook/:classId
// Returns per-student gradebook: assignment avg, exam avg, attendance rate and final grade.
router.get("/gradebook/:classId", requireAuth, async (req, res) => {
    try {
        const classId = Number(req.params.classId);
        if (!Number.isFinite(classId)) return res.status(400).json({ error: "Invalid classId" });

        if (policy.isTeacher(req.user!) && !(await policy.canManageClass(req.user!, classId))) {
            return policy.forbidden(res, "You can only view the gradebook for classes you teach.");
        }
        if (req.user!.id && (policy.isTeacher(req.user!) || policy.isStudent(req.user!)) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id }, classId))) {
            return policy.forbidden(res, "This class is outside your selected portal context.");
        }

        if (policy.isStudent(req.user!) && !(await policy.isEnrolledInClass(req.user!.id!, classId))) {
            return policy.forbidden(res, "You're not enrolled in this class.");
        }

        let childIds: string[] = [];
        if (policy.isParent(req.user!)) {
            childIds = await getLinkedChildIds({ id: req.user!.id!, email: req.user!.email });
            if (!(await policy.anyChildEnrolledInClass(childIds, classId))) {
                return policy.forbidden(res, "None of your children are enrolled in this class.");
            }
        }

        const [roster, assignmentAvgs, submissionCounts, assignmentCountRows, assignmentDetails, assignmentSubmissions, examAvgs, savedGrades] = await Promise.all([
            // All enrolled students
            db
                .select({ studentId: user.id, name: user.name, email: user.email, image: user.image })
                .from(enrollments)
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .where(eq(enrollments.classId, classId))
                .orderBy(user.name),
            // Assignment averages
            db
                .select({
                    studentId: submissions.studentId,
                    // Weight the average by marks available across all graded
                    // homework: total marks earned / total marks available.
                    avg: sql<number>`(SUM(${submissions.score})::float / NULLIF(SUM(${assignments.maxScore}), 0)) * 100`,
                })
                .from(submissions)
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .where(and(eq(assignments.classId, classId), eq(submissions.status, "graded")))
                .groupBy(submissions.studentId),
            // Submitted work (graded or awaiting grading). This is deliberately
            // separate from the average above: a submitted-but-ungraded task is
            // not an F, while no submission for an assigned task is.
            db
                .select({ studentId: submissions.studentId, count: sql<number>`count(*)`.mapWith(Number) })
                .from(submissions)
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .where(and(eq(assignments.classId, classId), inArray(submissions.status, ["submitted", "graded"])))
                .groupBy(submissions.studentId),
            db
                .select({ count: sql<number>`count(*)`.mapWith(Number) })
                .from(assignments)
                .where(eq(assignments.classId, classId)),
            // The gradebook is the complete subject record, not a recent-work
            // feed. Return every assignment for this class in chronological
            // order so teachers can review every question in one place.
            db
                .select({
                    id: assignments.id,
                    title: assignments.title,
                    description: assignments.description,
                    dueAt: assignments.dueAt,
                    maxScore: assignments.maxScore,
                    createdAt: assignments.createdAt,
                })
                .from(assignments)
                .where(eq(assignments.classId, classId))
                .orderBy(asc(assignments.createdAt)),
            db
                .select({
                    assignmentId: submissions.assignmentId,
                    studentId: submissions.studentId,
                    status: submissions.status,
                    score: submissions.score,
                })
                .from(submissions)
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .where(eq(assignments.classId, classId)),
            // Exam averages
            db
                .select({
                    studentId: examResults.studentId,
                    avg: avg(sql<number>`(${examResults.score}::float / NULLIF(${exams.maxScore}, 0)) * 100`),
                })
                .from(examResults)
                .innerJoin(exams, eq(examResults.examId, exams.id))
                .where(eq(exams.classId, classId))
                .groupBy(examResults.studentId),
            // Existing saved grades
            db
                .select()
                .from(classGrades)
                .where(eq(classGrades.classId, classId)),
        ]);

        const aMap = Object.fromEntries(assignmentAvgs.map((r) => [r.studentId, Math.round(Number(r.avg) || 0)]));
        const submittedMap = Object.fromEntries(submissionCounts.map((r) => [r.studentId, Number(r.count) || 0]));
        const hasAssignments = Number(assignmentCountRows[0]?.count ?? 0) > 0;
        const eMap = Object.fromEntries(examAvgs.map((r) => [r.studentId, Math.round(Number(r.avg) || 0)]));
        const gMap = Object.fromEntries(savedGrades.map((r) => [r.studentId, r]));

        const gradebook = roster.map((s) => {
            const assignmentAvg = aMap[s.studentId] ?? null;
            const examAvg = eMap[s.studentId] ?? null;
            const saved = gMap[s.studentId];
            const missingAssignmentSubmission = hasAssignments && !submittedMap[s.studentId];

            // Exams are reported separately and never change the homework result.
            const computed = assignmentAvg;

            // A saved C/D grade must never make missing assignment work appear
            // passed. Keep the stored grade intact for audit purposes, but show
            // this live gradebook row as -- / F until work is submitted.
            const finalGrade = missingAssignmentSubmission ? null : (saved?.finalGrade ?? computed);
            const letter = missingAssignmentSubmission ? "F" : finalGrade !== null ? toLetterGrade(finalGrade) : null;
            return {
                studentId: s.studentId,
                name: s.name,
                email: s.email,
                image: s.image,
                assignmentAvg,
                missingAssignmentSubmission,
                examAvg,
                finalGrade,
                letterGrade: missingAssignmentSubmission ? "F" : (saved?.letterGrade ?? letter),
                remarks: saved?.remarks ?? null,
                isOverridden: !!saved?.gradedBy,
            };
        });

        // A student only sees their own row; a parent only their linked
        // children's rows — never the rest of the class's grades.
        const visible = policy.isStudent(req.user!)
            ? gradebook.filter((row) => row.studentId === req.user!.id)
            : policy.isParent(req.user!)
                ? gradebook.filter((row) => childIds.includes(row.studentId))
                : gradebook;

        res.json({ data: visible, assignments: assignmentDetails, submissions: assignmentSubmissions });
    } catch (e) {
        console.error("GET /grades/gradebook/:classId error:", e);
        res.status(500).json({ error: "Failed to load gradebook" });
    }
});

// POST /api/grades/gradebook/:classId/save — teacher/admin saves/overrides final grades
router.post("/gradebook/:classId/save", requireAuth, requireRole(...STAFF_ROLES), validateBody(gradebookSaveSchema), async (req, res) => {
    try {
        const classId = Number(req.params.classId);
        const { records } = req.body as {
            records: Array<{ studentId: string; finalGrade: number; remarks?: string | null }>
        };

        if (policy.isTeacher(req.user!) && !(await policy.canManageClass(req.user!, classId))) {
            return policy.forbidden(res, "You can only save grades for classes you teach.");
        }
        if (policy.isTeacher(req.user!) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, classId))) {
            return policy.forbidden(res, "This class is outside your selected portal context.");
        }

        const gradedBy = req.user!.id!;
        const result = await db
            .insert(classGrades)
            .values(records.map((r) => {
                const letter = toLetterGrade(r.finalGrade);
                return {
                    classId,
                    studentId: r.studentId,
                    finalGrade: r.finalGrade,
                    letterGrade: letter,
                    gpa: null,
                    remarks: r.remarks ?? null,
                    gradedBy,
                };
            }))
            .onConflictDoUpdate({
                target: [classGrades.classId, classGrades.studentId],
                set: {
                    finalGrade: sql`excluded.final_grade`,
                    letterGrade: sql`excluded.letter_grade`,
                    gpa: null,
                    remarks: sql`excluded.remarks`,
                    gradedBy: sql`excluded.graded_by`,
                    updatedAt: new Date(),
                },
            })
            .returning();

        await logAction({ req, action: "gradebook.save", resource: "class_grades", resourceId: classId, details: `Saved final grades for ${records.length} student(s)` });

        res.json({ data: result });
    } catch (e) {
        console.error("POST /grades/gradebook/:classId/save error:", e);
        res.status(500).json({ error: "Failed to save grades" });
    }
});

// GET /api/grades/student/:studentId — student's full grade history across all classes
router.get("/student/:studentId", requireAuth, async (req, res) => {
    try {
        const studentId = String(req.params.studentId ?? "");
        if (!(await policy.canAccessStudent(req.user!, studentId))) {
            return policy.forbidden(res);
        }

        const grades = await db
            .select({
                ...getTableColumns(classGrades),
                class: { id: classes.id, name: classes.name },
            })
            .from(classGrades)
            .innerJoin(classes, eq(classGrades.classId, classes.id))
            .where(eq(classGrades.studentId, studentId))
            .orderBy(desc(classGrades.updatedAt));

        res.json({ data: grades });
    } catch (e) {
        console.error("GET /grades/student/:studentId error:", e);
        res.status(500).json({ error: "Failed to load student grades" });
    }
});

export default router;
