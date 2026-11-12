import express from "express";
import { and, asc, avg, desc, eq, getTableColumns, ilike, inArray, or, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { academicTerms, academicYears, assignments, classGrades, classes, enrollments, examResults, exams, notifications, portalContexts, studentProfiles, submissions, subjects, termSubjectResults } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { ADMIN_ROLES, requireAuth, requireRole, STAFF_ROLES } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { createAcademicTermSchema, createAcademicYearSchema, createExamSchema, examResultsSchema, gradebookSaveSchema, publishTermSubjectResultsSchema, saveTermSubjectResultsSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";
import * as policy from "../lib/policy.js";
import { activePortalClassIds, currentAcademicYear, isInActivePortalClass } from "../lib/portal-context.js";
import { getLinkedChildIds } from "../lib/policy.js";
import { calculateSecondaryDivision, gradeSecondaryScore } from "../lib/grading/student-division.js";
import { calculateStudentPosition } from "../lib/grading/student-position.js";
import { pairedExamAverage } from "../lib/grading/exam-average.js";
import { notifyAcademicAdministrators, notifyStudent } from "./notifications.js";
import { schoolToday } from "../lib/academic-year.js";

const router = express.Router();

// ─── Grade helper ─────────────────────────────────────────────────────────────
// The approved A–F thresholds are centralized with the secondary Division
// rules. GPA is deliberately not calculated or exposed by this gradebook.
const toLetterGrade = (score: number): string => {
    return gradeSecondaryScore(score).grade;
};

// ─── FORMAL TERMS / RESULTS ──────────────────────────────────────────────────
router.get("/academic-years", requireAuth, async (req, res) => {
    try {
        const today = schoolToday();
        const allYears = await db.select().from(academicYears).orderBy(desc(academicYears.startsOn));
        // Admins need future years for planning. Everyone else sees current
        // and historical years, but never a future year before its start date.
        const years = policy.isAdmin(req.user!)
            ? allYears
            : allYears.filter((year) => year.startsOn <= today);
        res.json({ data: years });
    } catch (e) {
        console.error("GET /grades/academic-years error:", e);
        res.status(500).json({ error: "Failed to load academic years" });
    }
});

router.post("/academic-years", requireAuth, requireRole(...ADMIN_ROLES), validateBody(createAcademicYearSchema), async (req, res) => {
    try {
        const { name, startsOn, endsOn, active } = req.body;
        if (startsOn > endsOn) return res.status(400).json({ error: "Academic year end date must be after its start date." });
        const created = await db.transaction(async (transaction) => {
            // `active` means ready for automatic rollover. Future years may be
            // scheduled alongside the current year; date selection decides
            // which one is live for the school today.
            if (active && startsOn <= schoolToday() && endsOn >= schoolToday()) {
                await transaction.update(academicYears).set({ active: false });
            }
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
        if (year.endsOn < today) return res.status(400).json({ error: "A completed academic year cannot be scheduled again." });
        const activated = await db.transaction(async (transaction) => {
            if (year.startsOn <= today && year.endsOn >= today) {
                await transaction.update(academicYears).set({ active: false });
            }
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

router.delete("/academic-years/:id", requireAuth, requireRole("super_admin"), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Choose a valid academic year." });
        const [year] = await db.select().from(academicYears).where(eq(academicYears.id, id));
        if (!year) return res.status(404).json({ error: "Academic year not found." });
        if (year.active) return res.status(409).json({ error: "The active academic year cannot be deleted. Activate another year first." });

        const [[linkedClass], [linkedTerm], [linkedContext]] = await Promise.all([
            db.select({ id: classes.id }).from(classes).where(eq(classes.academicYearId, id)).limit(1),
            db.select({ id: academicTerms.id }).from(academicTerms).where(eq(academicTerms.academicYearId, id)).limit(1),
            db.select({ id: portalContexts.id }).from(portalContexts).where(eq(portalContexts.academicYearId, id)).limit(1),
        ]);
        if (linkedClass || linkedTerm || linkedContext) {
            return res.status(409).json({ error: "This academic year contains school records and cannot be deleted." });
        }

        await db.delete(academicYears).where(eq(academicYears.id, id));
        await logAction({ req, action: "academic-year.delete", resource: "academic_years", resourceId: id, details: `Deleted academic year ${year.name}` });
        return res.status(204).send();
    } catch (error) {
        console.error("DELETE /grades/academic-years/:id error:", error);
        return res.status(500).json({ error: "Failed to delete academic year" });
    }
});

router.get("/academic-terms", requireAuth, async (req, res) => {
    try {
        const rawAcademicYearId = req.query.academicYearId;
        const academicYearId = rawAcademicYearId === undefined ? undefined : Number(rawAcademicYearId);
        if (academicYearId !== undefined && (!Number.isInteger(academicYearId) || academicYearId <= 0)) return res.status(400).json({ error: "Invalid academic year" });
        const currentYear = academicYearId === undefined ? await currentAcademicYear() : null;
        const termConditions = [eq(academicTerms.academicYearId, academicYearId ?? currentYear?.id ?? -1)];
        const terms = await db.select({ ...getTableColumns(academicTerms), academicYear: { id: academicYears.id, name: academicYears.name } })
            .from(academicTerms).innerJoin(academicYears, eq(academicTerms.academicYearId, academicYears.id))
            .where(and(...termConditions))
            .orderBy(desc(academicTerms.startsOn));
        res.json({ data: terms });
    } catch (e) {
        console.error("GET /grades/academic-terms error:", e);
        res.status(500).json({ error: "Failed to load academic terms" });
    }
});

// Publication needs the full authorized class catalogue, including subjects
// beyond the paginated 100-class directory. Keep the response small and scoped.
router.get("/publishable-classes", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    try {
        const level = policy.headmasterSchoolLevel(req.user!);
        const rows = await db.select({
            id: classes.id,
            name: classes.name,
            schoolLevel: classes.schoolLevel,
            academicYearId: classes.academicYearId,
            subject: { id: subjects.id, name: subjects.name },
        }).from(classes)
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .where(level ? eq(classes.schoolLevel, level) : undefined)
            .orderBy(asc(classes.name), asc(subjects.name));
        res.json({ data: rows });
    } catch (error) {
        console.error("GET /grades/publishable-classes error:", error);
        res.status(500).json({ error: "Failed to load classes for result publication" });
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
        if ((policy.isTeacher(req.user!) || policy.isHeadmaster(req.user!)) && !(await policy.canManageClass(req.user!, classId))) return policy.forbidden(res, "You can only record results for classes in your school.");
        if (policy.isTeacher(req.user!) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, classId))) return policy.forbidden(res, "This class is outside your selected portal context.");

        const [[term], [course], roster] = await Promise.all([
            db.select({ id: academicTerms.id, name: academicTerms.name, academicYearId: academicTerms.academicYearId }).from(academicTerms).where(eq(academicTerms.id, academicTermId)),
            db.select({ name: classes.name, subjectId: classes.subjectId, schoolLevel: classes.schoolLevel, academicYearId: classes.academicYearId }).from(classes).where(eq(classes.id, classId)),
            db.select({ studentId: enrollments.studentId }).from(enrollments).where(eq(enrollments.classId, classId)),
        ]);
        if (!term) return res.status(404).json({ error: "Academic term not found" });
        if (!course) return res.status(404).json({ error: "Class not found" });
        if (!course.schoolLevel) return res.status(400).json({ error: "This class must be assigned a school level by an administrator before results can be recorded." });
        if (!course.academicYearId || course.academicYearId !== term.academicYearId) return res.status(409).json({ error: "This assessment period does not belong to the class's academic year." });
        const enrolled = new Set(roster.map((row) => row.studentId));
        if (records.some((record: { studentId: string }) => !enrolled.has(record.studentId))) return res.status(400).json({ error: "Every result must belong to an enrolled student." });

        const saved = await db.insert(termSubjectResults).values(records.map((record: { studentId: string; score: number; applicable?: boolean }) => ({
            academicTermId, classId, subjectId: course.subjectId, studentId: record.studentId, schoolLevel: course.schoolLevel, score: record.score, applicable: record.applicable ?? true, published: false, enteredBy: req.user!.id!,
        }))).onConflictDoUpdate({
            target: [termSubjectResults.academicTermId, termSubjectResults.classId, termSubjectResults.subjectId, termSubjectResults.studentId],
            set: { score: sql`excluded.score`, applicable: sql`excluded.applicable`, schoolLevel: sql`excluded.school_level`, published: false, enteredBy: req.user!.id!, updatedAt: new Date() },
        }).returning();
        if (course.subjectId !== null) {
            await notifyAcademicAdministrators({
                type: "grade",
                title: "Results ready to publish",
                message: `${term.name} results for ${course.name} are saved and awaiting publication.`,
                link: `/admin/publish-results?termId=${academicTermId}&className=${encodeURIComponent(course.name)}&subjectId=${course.subjectId}`,
                schoolLevel: course.schoolLevel,
                excludeUserId: req.user!.id!,
                dedupe: true,
            });
        }
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
        if (policy.isHeadmaster(req.user!) && !(await policy.canManageClass(req.user!, classId))) return policy.forbidden(res, "You can only publish results for classes in your school.");
        const [[term], [course]] = await Promise.all([
            db.select({ type: academicTerms.type, academicYearId: academicTerms.academicYearId }).from(academicTerms).where(eq(academicTerms.id, academicTermId)),
            db.select({ name: classes.name, subjectId: classes.subjectId, schoolLevel: classes.schoolLevel, academicYearId: classes.academicYearId }).from(classes).where(eq(classes.id, classId)),
        ]);
        if (!term) return res.status(404).json({ error: "Academic term not found" });
        if (!course) return res.status(404).json({ error: "Class not found" });
        if (!course.schoolLevel) return res.status(400).json({ error: "This class must be assigned a school level before results can be published." });
        if (!course.academicYearId || course.academicYearId !== term.academicYearId) return res.status(409).json({ error: "This assessment period does not belong to the class's academic year." });

        const updated = await db.update(termSubjectResults).set({ published, updatedAt: new Date() })
            .where(and(eq(termSubjectResults.academicTermId, academicTermId), eq(termSubjectResults.classId, classId)))
            .returning({ id: termSubjectResults.id });
        let migrated = 0;
        if (published) {
            const legacy = await db.select({
                subjectId: classes.subjectId,
                schoolLevel: classes.schoolLevel,
                studentId: examResults.studentId,
                score: sql<number>`round((${examResults.score}::numeric / nullif(${exams.maxScore}, 0)) * 100, 0)`.mapWith(Number),
                enteredBy: examResults.gradedBy,
            }).from(examResults)
                .innerJoin(exams, eq(examResults.examId, exams.id))
                .innerJoin(classes, eq(exams.classId, classes.id))
                .where(and(
                    eq(exams.classId, classId),
                    term.type === "midterm"
                        ? or(eq(exams.examType, "midterm"), ilike(exams.title, "%midterm%"))
                        : or(eq(exams.examType, "annual"), ilike(exams.title, "%annual%"), ilike(exams.title, "%terminal%")),
                )).orderBy(desc(examResults.updatedAt), desc(examResults.id));
            const latest = new Map<string, typeof legacy[number]>();
            for (const row of legacy) {
                const key = `${row.subjectId}:${row.studentId}`;
                if (row.schoolLevel && row.subjectId !== null && !latest.has(key)) latest.set(key, row);
            }
            if (latest.size) {
                const inserted = await db.insert(termSubjectResults).values([...latest.values()].map((row) => ({
                    academicTermId, classId, subjectId: row.subjectId!, studentId: row.studentId, schoolLevel: row.schoolLevel!, score: row.score, applicable: true, published: true, enteredBy: row.enteredBy,
                }))).onConflictDoNothing().returning({ id: termSubjectResults.id });
                migrated = inserted.length;
            }
        }
        if (published && updated.length + migrated > 0) {
            const approvalLink = `/admin/publish-results?termId=${academicTermId}&className=${encodeURIComponent(course.name)}&subjectId=${course.subjectId}`;
            await db.update(notifications).set({ read: true, updatedAt: new Date() })
                .where(and(eq(notifications.link, approvalLink), eq(notifications.type, "grade")));
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
            await Promise.all([
                ...userIds.map((userId) => notifyStudent({ userId, type: "grade", title: "Term results published", message: "Your approved term results are now available in the secure portal.", link: "/reports" })),
                notifyAcademicAdministrators({
                    type: "grade",
                    title: "Results published",
                    message: `${course.name} results have been published. No further publication is needed unless results are changed.`,
                    link: "/admin/publish-results",
                    schoolLevel: course.schoolLevel,
                    excludeUserId: req.user!.id!,
                }),
            ]);
        }
        await logAction({ req, action: published ? "term-results.publish" : "term-results.unpublish", resource: "term_subject_results", resourceId: `${academicTermId}:${classId}`, details: `${published ? "Published" : "Unpublished"} ${updated.length} result(s)` });
        res.json({ data: { published, count: updated.length + migrated } });
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
        if ((policy.isTeacher(req.user!) || policy.isHeadmaster(req.user!)) && !(await policy.canManageClass(req.user!, classId))) return policy.forbidden(res, "You can only view results for classes in your school.");
        if (policy.isTeacher(req.user!) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id! }, classId))) return policy.forbidden(res, "This class is outside your selected portal context.");
        const rows = await db.select({ ...getTableColumns(termSubjectResults), student: { id: user.id, name: user.name, email: user.email } })
            .from(termSubjectResults).innerJoin(user, eq(termSubjectResults.studentId, user.id))
            .where(and(eq(termSubjectResults.academicTermId, academicTermId), eq(termSubjectResults.classId, classId), policy.isTeacher(req.user!) ? eq(user.role, "student") : undefined)).orderBy(user.name);
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
        const legacyRows = rows.length > 0 || policy.isStudent(req.user!) || policy.isParent(req.user!) ? [] : await db.select({
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
            .orderBy(subjects.name, desc(examResults.updatedAt), desc(examResults.id));
        // A student should have one mark per subject and term. Older exam
        // workflows could leave multiple exam rows for the same subject; the
        // ordered query above makes the newest mark authoritative for the
        // report and prevents repeated subjects.
        const latestLegacyBySubject = new Map<number, typeof legacyRows[number]>();
        for (const row of legacyRows) if (!latestLegacyBySubject.has(row.subjectId)) latestLegacyBySubject.set(row.subjectId, row);
        const reportRows = rows.length > 0 ? rows : [...latestLegacyBySubject.values()];
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
                    .orderBy(desc(examResults.updatedAt), desc(examResults.id))).filter((row, index, all) => all.findIndex((candidate) => candidate.studentId === row.studentId && candidate.classId === row.classId) === index)
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
        if (policy.isTeacher(caller) && caller.id) {
            const selectedClassIds = await activePortalClassIds({ ...caller, id: caller.id });
            if (selectedClassIds) conditions.push(selectedClassIds.length ? inArray(exams.classId, selectedClassIds) : sql`false`);
        }

        if (policy.isStudent(caller) && !classId) {
            const enrolledClassRows = await db
                .select({ classId: enrollments.classId })
                .from(enrollments)
                .where(eq(enrollments.studentId, caller.id!));
            const enrolledClassIds = enrolledClassRows.map((row) => row.classId);
            conditions.push(enrolledClassIds.length ? inArray(exams.classId, enrolledClassIds) : sql`false`);
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

        if ((policy.isTeacher(req.user!) || policy.isHeadmaster(req.user!)) && !(await policy.canManageClass(req.user!, classId))) {
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
        if ((policy.isTeacher(req.user!) || policy.isHeadmaster(req.user!)) && !(await policy.canManageClass(req.user!, existing.classId))) {
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

        if (policy.isTeacher(req.user!) || policy.isHeadmaster(req.user!)) {
            const [exam] = await db.select({ classId: exams.classId }).from(exams).where(eq(exams.id, examId));
            if (!exam) return res.status(404).json({ error: "Exam not found" });
            if (!(await policy.canManageClass(req.user!, exam.classId))) {
                return policy.forbidden(res, "You can only view results for classes in your school.");
            }
        }

        const resultConditions = [eq(examResults.examId, examId)];
        if (policy.isStudent(req.user!)) resultConditions.push(eq(examResults.studentId, req.user!.id!));
        else if (policy.isTeacher(req.user!)) resultConditions.push(eq(user.role, "student"));

        const rows = await db
            .select({
                ...getTableColumns(examResults),
                student: { id: user.id, name: user.name, email: user.email, image: user.image },
            })
            .from(examResults)
            .innerJoin(user, eq(examResults.studentId, user.id))
            .where(and(...resultConditions))
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
            .select({
                classId: exams.classId,
                maxScore: exams.maxScore,
                examType: exams.examType,
                className: classes.name,
                subjectName: subjects.name,
                subjectId: classes.subjectId,
                schoolLevel: classes.schoolLevel,
                academicYearId: classes.academicYearId,
            })
            .from(exams)
            .innerJoin(classes, eq(exams.classId, classes.id))
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .where(eq(exams.id, examId));
        if (!exam) return res.status(404).json({ error: "Exam not found" });

        if (policy.isTeacher(req.user!) || policy.isHeadmaster(req.user!)) {
            if (!(await policy.canManageClass(req.user!, exam.classId))) {
                return policy.forbidden(res, "You can only grade exams for classes in your school.");
            }
        }
        const schoolLevel = exam.schoolLevel;
        if (!schoolLevel) {
            return res.status(409).json({ error: "This class has no school level. Ask a school administrator to classify it before saving exam results." });
        }
        const resultAcademicYearId = exam.academicYearId;
        if (!resultAcademicYearId) {
            return res.status(409).json({ error: "This class has no academic year. Ask a school administrator to assign one before saving exam results." });
        }
        const termType = exam.examType === "annual" ? "terminal" : "midterm";
        const [resultTerm] = await db
            .select({ id: academicTerms.id })
            .from(academicTerms)
            .where(and(eq(academicTerms.academicYearId, resultAcademicYearId), eq(academicTerms.type, termType)))
            .orderBy(desc(academicTerms.startsOn), desc(academicTerms.id))
            .limit(1);
        if (!resultTerm) {
            return res.status(409).json({ error: `No ${termType} assessment period exists for this class's academic year. Ask a school administrator to create it before saving exam results.` });
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

        const existingResults = await db
            .select({ studentId: examResults.studentId, score: examResults.score, remarks: examResults.remarks })
            .from(examResults)
            .where(and(eq(examResults.examId, examId), inArray(examResults.studentId, studentIds)));
        const existingByStudent = new Map(existingResults.map((record) => [record.studentId, record]));
        const resultsChanged = records.some((record) => {
            const previous = existingByStudent.get(record.studentId);
            return !previous || previous.score !== record.score || (previous.remarks ?? null) !== (record.remarks ?? null);
        });

        const gradedBy = req.user!.id!;
        const resultTermId = resultTerm.id;
        // Save both copies of the marks atomically. A failed formal report
        // write must not leave an exam save that falsely appears complete.
        const { result, publishedFormalResults } = await db.transaction(async (transaction) => {
            const [publishedRecord] = await transaction
                .select({ id: termSubjectResults.id })
                .from(termSubjectResults)
                .where(and(
                    eq(termSubjectResults.academicTermId, resultTermId),
                    eq(termSubjectResults.classId, exam.classId),
                    eq(termSubjectResults.subjectId, exam.subjectId),
                    eq(termSubjectResults.published, true),
                ))
                .limit(1);
            const wasPublished = Boolean(publishedRecord);
            const result = await transaction
                .insert(examResults)
                .values(records.map((record) => ({ examId, studentId: record.studentId, score: record.score, remarks: record.remarks ?? null, gradedBy })))
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
            await transaction.insert(termSubjectResults).values(records.map((record) => ({
                academicTermId: resultTermId,
                classId: exam.classId,
                subjectId: exam.subjectId,
                studentId: record.studentId,
                schoolLevel,
                score: Math.round((record.score / exam.maxScore) * 100),
                applicable: true,
                published: wasPublished && !resultsChanged,
                enteredBy: gradedBy,
            }))).onConflictDoUpdate({
                target: [termSubjectResults.academicTermId, termSubjectResults.classId, termSubjectResults.subjectId, termSubjectResults.studentId],
                set: {
                    score: sql`excluded.score`,
                    applicable: true,
                    schoolLevel: sql`excluded.school_level`,
                    enteredBy: gradedBy,
                    ...(resultsChanged ? { published: false } : {}),
                    updatedAt: new Date(),
                },
            });
            return { result, publishedFormalResults: wasPublished };
        });

        if (resultsChanged || !publishedFormalResults) {
            const classLabel = `${exam.className}${exam.subjectName ? ` · ${exam.subjectName}` : ""}`;
            const isRepublish = publishedFormalResults && resultsChanged;
            const classQuery = encodeURIComponent(exam.className);
            await notifyAcademicAdministrators({
                type: "grade",
                title: isRepublish ? "Results changed — republish required" : "Results ready to publish",
                message: isRepublish
                    ? `Exam results for ${classLabel} were changed. Review and publish the updated results again.`
                    : `${exam.examType === "annual" ? "Terminal" : "Midterm"} exam results for ${classLabel} have been saved and are awaiting publication.`,
                link: `/admin/publish-results?termId=${resultTermId}&className=${classQuery}&subjectId=${exam.subjectId}`,
                schoolLevel,
                dedupe: !isRepublish,
            });
        }

        await logAction({ req, action: "exam.grade", resource: "exam_results", resourceId: examId, details: `Saved results for ${records.length} student(s)` });

        res.json({ data: result });
    } catch (e) {
        console.error("POST /grades/exams/:examId/results error:", e);
        res.status(500).json({ error: "Failed to save exam results" });
    }
});

// ─── GRADEBOOK ────────────────────────────────────────────────────────────────

// GET /api/grades/gradebook/:classId

// GET /api/grades/gradebook/all-subjects
// A student's complete homework record for the active academic context. This
// static route must remain above /gradebook/:classId so Express never treats
// "all-subjects" as a numeric class id.
router.get("/gradebook/all-subjects", requireAuth, requireRole("student", "parent"), async (req, res) => {
    try {
        const requestedStudentId = String(req.query.childId ?? "").trim();
        const studentId = req.user!.role === "parent" ? requestedStudentId : req.user!.id!;
        if (!studentId) return res.status(400).json({ error: "childId is required for parent requests" });
        if (!(await policy.canAccessStudent(req.user!, studentId))) return policy.forbidden(res);
        const requestedYearId = req.query.academicYearId ? Number(req.query.academicYearId) : null;
        if (requestedYearId !== null && (!Number.isInteger(requestedYearId) || requestedYearId <= 0)) {
            return res.status(400).json({ error: "Invalid academic year" });
        }
        const contextClassIds = req.user!.role === "parent"
            ? (await db
                .select({ id: classes.id })
                .from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .where(and(
                    eq(enrollments.studentId, studentId),
                    requestedYearId === null ? sql`true` : eq(classes.academicYearId, requestedYearId),
                ))).map((row) => row.id)
            : await activePortalClassIds({ ...req.user!, id: studentId });
        if (!contextClassIds?.length) return res.json({ data: [], student: { id: studentId, name: req.user!.name, email: req.user!.email }, overallAverage: null });

        const enrolledSubjects = await db
            .select({
                classId: classes.id,
                className: classes.name,
                subjectId: subjects.id,
                subjectName: subjects.name,
            })
            .from(enrollments)
            .innerJoin(classes, eq(enrollments.classId, classes.id))
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .where(and(eq(enrollments.studentId, studentId), inArray(classes.id, contextClassIds)))
            .orderBy(subjects.name);

        if (!enrolledSubjects.length) return res.json({ data: [], student: { id: studentId, name: req.user!.name, email: req.user!.email }, overallAverage: null });

        const classIds = enrolledSubjects.map((item) => item.classId);
        const assignmentRows = await db
            .select({
                id: assignments.id,
                classId: assignments.classId,
                title: assignments.title,
                description: assignments.description,
                dueAt: assignments.dueAt,
                maxScore: assignments.maxScore,
                createdAt: assignments.createdAt,
            })
            .from(assignments)
            .where(inArray(assignments.classId, classIds))
            .orderBy(asc(assignments.createdAt));

        const assignmentIds = assignmentRows.map((item) => item.id);
        const submissionRows = assignmentIds.length
            ? await db
                .select({
                    assignmentId: submissions.assignmentId,
                    studentId: submissions.studentId,
                    status: submissions.status,
                    score: submissions.score,
                    feedback: submissions.feedback,
                })
                .from(submissions)
                .where(and(eq(submissions.studentId, studentId), inArray(submissions.assignmentId, assignmentIds)))
            : [];
        const submissionByAssignment = new Map(submissionRows.map((item) => [item.assignmentId, item]));
        const publishedExamRows = await db
            .select({
                classId: termSubjectResults.classId,
                termType: academicTerms.type,
                score: termSubjectResults.score,
            })
            .from(termSubjectResults)
            .innerJoin(academicTerms, eq(termSubjectResults.academicTermId, academicTerms.id))
            .where(and(
                eq(termSubjectResults.studentId, studentId),
                inArray(termSubjectResults.classId, classIds),
                eq(termSubjectResults.published, true),
                eq(termSubjectResults.applicable, true),
            ));

        let totalEarned = 0;
        let totalAvailable = 0;
        const data = enrolledSubjects.map((subject) => {
            const subjectAssignments = assignmentRows.filter((item) => item.classId === subject.classId);
            const gradedAssignments = subjectAssignments.flatMap((assignment) => {
                const submission = submissionByAssignment.get(assignment.id);
                return submission?.status === "graded" && submission.score !== null
                    ? [{ score: Number(submission.score), maxScore: Number(assignment.maxScore) }]
                    : [];
            });
            const earned = gradedAssignments.reduce((sum, item) => sum + item.score, 0);
            const available = gradedAssignments.reduce((sum, item) => sum + item.maxScore, 0);
            totalEarned += earned;
            totalAvailable += available;
            const assignmentAvg = available > 0 ? Math.round((earned / available) * 100) : null;
            const examAvg = pairedExamAverage(publishedExamRows
                .filter((row) => row.classId === subject.classId)
                .map((row) => ({ termType: row.termType, score: Number(row.score) })));
            return {
                classId: subject.classId,
                className: subject.className,
                subjectName: subject.subjectName,
                assignmentCount: subjectAssignments.length,
                gradedAssignmentCount: gradedAssignments.length,
                assignmentAvg,
                examAvg,
                letterGrade: assignmentAvg === null ? null : toLetterGrade(assignmentAvg),
                assignments: subjectAssignments.map(({ classId: _classId, createdAt: _createdAt, ...assignment }) => assignment),
                submissions: subjectAssignments.flatMap((assignment) => {
                    const submission = submissionByAssignment.get(assignment.id);
                    return submission ? [submission] : [];
                }),
            };
        });

        const overallAverage = totalAvailable > 0 ? Math.round((totalEarned / totalAvailable) * 100) : null;
        return res.json({ data, student: { id: studentId, name: req.user!.name, email: req.user!.email }, overallAverage });
    } catch (error) {
        console.error("GET /grades/gradebook/all-subjects error:", error);
        return res.status(500).json({ error: "Failed to load homework for all subjects" });
    }
});

// GET /api/grades/grade-availability?classIds=1,2
// Lightweight grade presence check used before opening a Headmaster gradebook.
router.get("/grade-availability", requireAuth, async (req, res) => {
    try {
        const classIds = [...new Set(String(req.query.classIds ?? "")
            .split(",")
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isInteger(value) && value > 0))]
            .slice(0, 100);
        if (!classIds.length) return res.status(400).json({ error: "At least one class is required" });

        const caller = req.user!;
        if (!policy.isAdmin(caller) && !policy.isTeacher(caller) && !policy.isHeadmaster(caller)) {
            return policy.forbidden(res, "You cannot view grade availability for these classes.");
        }
        if (policy.isTeacher(caller) || policy.isHeadmaster(caller)) {
            const permitted = await Promise.all(classIds.map((classId) => policy.canManageClass(caller, classId)));
            if (permitted.some((allowed) => !allowed)) {
                return policy.forbidden(res, "You can only view grades for classes you manage.");
            }
        }

        const [finalGradeRows, homeworkGradeRows] = await Promise.all([
            db
                .select({ classId: classGrades.classId, count: sql<number>`count(*)`.mapWith(Number) })
                .from(classGrades)
                .where(and(inArray(classGrades.classId, classIds), sql`${classGrades.finalGrade} is not null`))
                .groupBy(classGrades.classId),
            db
                .select({ classId: assignments.classId, count: sql<number>`count(*)`.mapWith(Number) })
                .from(submissions)
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .where(and(inArray(assignments.classId, classIds), eq(submissions.status, "graded"), sql`${submissions.score} is not null`))
                .groupBy(assignments.classId),
        ]);
        const countByClass = new Map(finalGradeRows.map((row) => [row.classId, row.count]));
        for (const row of homeworkGradeRows) {
            countByClass.set(row.classId, (countByClass.get(row.classId) ?? 0) + row.count);
        }

        res.json({ data: classIds.map((classId) => ({ classId, hasGrades: (countByClass.get(classId) ?? 0) > 0 })) });
    } catch (error) {
        console.error("GET /grades/grade-availability error:", error);
        res.status(500).json({ error: "Failed to load grade availability" });
    }
});

// Returns per-student gradebook: assignment avg, exam avg, attendance rate and final grade.
router.get("/gradebook/:classId", requireAuth, async (req, res) => {
    try {
        const classId = Number(req.params.classId);
        if (!Number.isFinite(classId)) return res.status(400).json({ error: "Invalid classId" });

        if ((policy.isTeacher(req.user!) || policy.isHeadmaster(req.user!)) && !(await policy.canManageClass(req.user!, classId))) {
            return policy.forbidden(res, "You can only view the gradebook for classes you teach.");
        }
        if (req.user!.id && policy.isTeacher(req.user!) && !(await isInActivePortalClass({ ...req.user!, id: req.user!.id }, classId))) {
            return policy.forbidden(res, "This class is outside your selected portal context.");
        }
        if (policy.isStudent(req.user!) && !(await policy.isEnrolledInClass(req.user!.id!, classId))) {
            return policy.forbidden(res, "You can only view grades for classes you are enrolled in.");
        }


        let childIds: string[] = [];
        let selectedChildId: string | null = null;
        if (policy.isParent(req.user!)) {
            const requestedChildId = typeof req.query.childId === "string" ? req.query.childId.trim() : "";
            const requestedYearId = Number(req.query.academicYearId);
            if (!requestedChildId || !Number.isInteger(requestedYearId) || requestedYearId <= 0) {
                return res.status(400).json({ error: "Select a child and academic year to view the homework gradebook." });
            }
            childIds = await getLinkedChildIds({ id: req.user!.id!, email: req.user!.email });
            if (!childIds.includes(requestedChildId)) {
                return policy.forbidden(res, "You can only view grades for your linked children.");
            }
            const [selectedClass] = await db
                .select({ academicYearId: classes.academicYearId })
                .from(classes)
                .where(eq(classes.id, classId));
            if (!selectedClass || selectedClass.academicYearId !== requestedYearId) {
                return policy.forbidden(res, "This class is outside the selected academic year.");
            }
            if (!(await policy.isEnrolledInClass(requestedChildId, classId))) {
                return policy.forbidden(res, "The selected child is not enrolled in this class.");
            }
            selectedChildId = requestedChildId;
        }

        const [roster, assignmentAvgs, submissionCounts, assignmentCountRows, assignmentDetails, assignmentSubmissions, examAvgs, savedGrades, publishedExamRows] = await Promise.all([
            // All enrolled students
            db
                .select({ studentId: user.id, name: user.name, email: user.email, image: user.image })
                .from(enrollments)
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .where(and(eq(enrollments.classId, classId), policy.isTeacher(req.user!) ? eq(user.role, "student") : undefined))
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
                    feedback: submissions.feedback,
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
            // Students and parents only receive the completed Midterm +
            // Terminal/Annual average after both formal results are published.
            db
                .select({
                    studentId: termSubjectResults.studentId,
                    termType: academicTerms.type,
                    score: termSubjectResults.score,
                })
                .from(termSubjectResults)
                .innerJoin(academicTerms, eq(termSubjectResults.academicTermId, academicTerms.id))
                .where(and(
                    eq(termSubjectResults.classId, classId),
                    eq(termSubjectResults.published, true),
                    eq(termSubjectResults.applicable, true),
                )),
        ]);

        const aMap = Object.fromEntries(assignmentAvgs.map((r) => [r.studentId, Math.round(Number(r.avg) || 0)]));
        const submittedMap = Object.fromEntries(submissionCounts.map((r) => [r.studentId, Number(r.count) || 0]));
        const hasAssignments = Number(assignmentCountRows[0]?.count ?? 0) > 0;
        const eMap = Object.fromEntries(examAvgs.map((r) => [r.studentId, Math.round(Number(r.avg) || 0)]));
        const publishedExamGroups = new Map<string, Array<{ termType: "midterm" | "terminal"; score: number }>>();
        for (const row of publishedExamRows) {
            const results = publishedExamGroups.get(row.studentId) ?? [];
            results.push({ termType: row.termType, score: Number(row.score) });
            publishedExamGroups.set(row.studentId, results);
        }
        const publishedExamMap = Object.fromEntries([...publishedExamGroups].map(([studentId, results]) => [studentId, pairedExamAverage(results)]));
        const gMap = Object.fromEntries(savedGrades.map((r) => [r.studentId, r]));

        const gradebook = roster.map((s) => {
            const assignmentAvg = aMap[s.studentId] ?? null;
            const examAvg = policy.isStudent(req.user!) || policy.isParent(req.user!)
                ? publishedExamMap[s.studentId] ?? null
                : eMap[s.studentId] ?? null;
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
                ? gradebook.filter((row) => row.studentId === selectedChildId)
                : gradebook;

        const visibleSubmissions = policy.isStudent(req.user!)
            ? assignmentSubmissions.filter((row) => row.studentId === req.user!.id)
            : policy.isParent(req.user!)
                ? assignmentSubmissions.filter((row) => row.studentId === selectedChildId)
                : assignmentSubmissions;
        res.json({ data: visible, assignments: assignmentDetails, submissions: visibleSubmissions });
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

        if ((policy.isTeacher(req.user!) || policy.isHeadmaster(req.user!)) && !(await policy.canManageClass(req.user!, classId))) {
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
