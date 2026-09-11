import express from "express";
import { and, avg, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { academicTerms, academicYears, assignments, classGrades, classes, enrollments, examResults, exams, studentProfiles, submissions, subjects, termSubjectResults } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { ADMIN_ROLES, requireAuth, requireRole, STAFF_ROLES } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { createAcademicTermSchema, createAcademicYearSchema, createExamSchema, examResultsSchema, gradebookSaveSchema, publishTermSubjectResultsSchema, saveTermSubjectResultsSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";
import * as policy from "../lib/policy.js";
import { getLinkedChildIds } from "../lib/policy.js";
import { calculateSecondaryDivision, gradeSecondaryScore } from "../lib/grading/student-division.js";
import { notifyStudent } from "./notifications.js";

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
        if (active) await db.update(academicYears).set({ active: false });
        const [created] = await db.insert(academicYears).values({ name, startsOn, endsOn, active: active ?? false }).returning();
        await logAction({ req, action: "academic-year.create", resource: "academic_years", resourceId: created?.id, details: `Created academic year ${name}` });
        res.status(201).json({ data: created });
    } catch (e) {
        console.error("POST /grades/academic-years error:", e);
        res.status(500).json({ error: "Failed to create academic year" });
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
            academicTermId, classId, subjectId: course.subjectId, studentId: record.studentId, schoolLevel: course.schoolLevel, score: record.score, applicable: record.applicable ?? true, published: false, enteredBy: req.user!.id!,
        }))).onConflictDoUpdate({
            target: [termSubjectResults.academicTermId, termSubjectResults.classId, termSubjectResults.studentId],
            set: { score: sql`excluded.score`, applicable: sql`excluded.applicable`, schoolLevel: sql`excluded.school_level`, published: false, enteredBy: req.user!.id!, updatedAt: new Date() },
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
        const [term, rows] = await Promise.all([
            db.select().from(academicTerms).where(eq(academicTerms.id, academicTermId)).then((result) => result[0]),
            db.select({ ...getTableColumns(termSubjectResults), subject: { id: subjects.id, name: subjects.name, code: subjects.code }, class: { id: classes.id, name: classes.name } })
                .from(termSubjectResults).innerJoin(subjects, eq(termSubjectResults.subjectId, subjects.id)).innerJoin(classes, eq(termSubjectResults.classId, classes.id))
                .where(and(eq(termSubjectResults.academicTermId, academicTermId), eq(termSubjectResults.studentId, studentId), eq(termSubjectResults.published, true))).orderBy(subjects.name),
        ]);
        if (!term) return res.status(404).json({ error: "Academic term not found" });
        const secondary = rows.filter((row) => row.schoolLevel === "secondary");
        const division = term.type === "terminal" && secondary.length > 0 ? calculateSecondaryDivision(secondary.map((row) => ({ subjectId: row.subjectId, score: row.score, applicable: row.applicable }))) : null;
        res.json({ data: rows, term: { id: term.id, name: term.name, type: term.type }, division });
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
        const { classId, title, description, scheduledAt, durationMinutes, maxScore, venue } = req.body as {
            classId: number; title: string; description?: string | null;
            scheduledAt?: string | null; durationMinutes?: number | null; maxScore?: number; venue?: string | null;
        };

        if (policy.isTeacher(req.user!) && !(await policy.canManageClass(req.user!, classId))) {
            return policy.forbidden(res, "You can only create exams for classes you teach.");
        }

        const [created] = await db.insert(exams).values({
            classId,
            title: title.trim(),
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

        if (policy.isTeacher(req.user!)) {
            const [exam] = await db.select({ classId: exams.classId }).from(exams).where(eq(exams.id, examId));
            if (!exam) return res.status(404).json({ error: "Exam not found" });
            if (!(await policy.canManageClass(req.user!, exam.classId))) {
                return policy.forbidden(res, "You can only grade exams for classes you teach.");
            }
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

        const [roster, assignmentAvgs, examAvgs, savedGrades] = await Promise.all([
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
                    avg: avg(sql<number>`(${submissions.score}::float / NULLIF(${assignments.maxScore}, 0)) * 100`),
                })
                .from(submissions)
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .where(and(eq(assignments.classId, classId), eq(submissions.status, "graded")))
                .groupBy(submissions.studentId),
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
        const eMap = Object.fromEntries(examAvgs.map((r) => [r.studentId, Math.round(Number(r.avg) || 0)]));
        const gMap = Object.fromEntries(savedGrades.map((r) => [r.studentId, r]));

        const gradebook = roster.map((s) => {
            const assignmentAvg = aMap[s.studentId] ?? null;
            const examAvg = eMap[s.studentId] ?? null;
            const saved = gMap[s.studentId];

            // Weighted: 40% assignments, 60% exams (if both exist); otherwise whichever is available
            let computed: number | null = null;
            if (assignmentAvg !== null && examAvg !== null) {
                computed = Math.round(assignmentAvg * 0.4 + examAvg * 0.6);
            } else if (assignmentAvg !== null) {
                computed = assignmentAvg;
            } else if (examAvg !== null) {
                computed = examAvg;
            }

            const finalGrade = saved?.finalGrade ?? computed;
            const letter = finalGrade !== null ? toLetterGrade(finalGrade) : null;
            return {
                studentId: s.studentId,
                name: s.name,
                email: s.email,
                image: s.image,
                assignmentAvg,
                examAvg,
                finalGrade,
                letterGrade: saved?.letterGrade ?? letter,
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

        res.json({ data: visible });
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
