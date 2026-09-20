import express from "express";
import { and, desc, eq, gte, isNull, lt, lte, or } from "drizzle-orm";

import { db } from "../db/index.js";
import { academicTerms, academicYears, assignments, attendance, classes, enrollments, examResults, exams, portalContexts, submissions, subjects, termSubjectResults } from "../db/schema/app.js";
import { requireAuth } from "../middleware/require-auth.js";
import * as policy from "../lib/policy.js";
import { ALL_STAGES, academicYearSnapshot, bandForStage, currentAcademicYear, progressionRank, SECONDARY_STAGES, stageForClass, type PortalStage } from "../lib/portal-context.js";
import { schoolToday } from "../lib/academic-year.js";
import { clearShortCacheForUser } from "../middleware/cache.js";

const router = express.Router();

async function availableClassesFor(user: policy.Caller & { id: string }, academicYear: { id: number; name: string }) {
    const rows = await db.select({
        id: classes.id,
        name: classes.name,
        schoolLevel: classes.schoolLevel,
        academicYearId: classes.academicYearId,
        subject: { id: subjects.id, name: subjects.name },
        teacherId: classes.teacherId,
    }).from(classes).leftJoin(subjects, eq(classes.subjectId, subjects.id));

    const relevantYear = rows.filter((row) => row.academicYearId === academicYear.id || (row.academicYearId === null && academicYear.name === "Legacy"));
    if (policy.isTeacher(user)) return relevantYear.filter((row) => row.teacherId === user.id);
    if (policy.isStudent(user)) {
        const enrolled = await db.select({ classId: enrollments.classId }).from(enrollments).where(eq(enrollments.studentId, user.id));
        const enrolledIds = new Set(enrolled.map((row) => row.classId));
        return relevantYear.filter((row) => enrolledIds.has(row.id));
    }
    return relevantYear;
}

router.get("/", requireAuth, async (req, res) => {
    try {
        const caller = req.user!;
        const actorId = caller.id;
        if (!actorId) return policy.unauthorized(res);
        const scopedCaller = { ...caller, id: actorId };
        if (!policy.isStudent(caller) && !policy.isTeacher(caller)) {
            return res.json({ data: { setupRequired: false, academicYear: null, context: null, available: [] } });
        }
        const yearSnapshot = await academicYearSnapshot();
        const academicYear = yearSnapshot.current;
        if (!academicYear) return res.json({ data: { setupRequired: true, configurationRequired: true, academicYear: null, context: null, available: [] } });
        // Keep the setup selector chronological while hiding future years.
        // When January rollover arrives, the newly current year naturally
        // appears first and the closed year remains visible underneath it.
        const academicYearsList = yearSnapshot.years
            .filter((year) => year.name !== "Legacy" && year.startsOn <= yearSnapshot.today);
        const [context] = await db.select().from(portalContexts).where(and(eq(portalContexts.userId, actorId), eq(portalContexts.academicYearId, academicYear.id)));
        const available = await availableClassesFor(scopedCaller, academicYear);
        const stages = [...new Set(available.map((item) => stageForClass(item.name)).filter((stage): stage is PortalStage => !!stage))];
        return res.json({ data: { setupRequired: !context, academicYear, academicYears: academicYearsList, context: context ?? null, available, stages } });
    } catch (error) {
        console.error("GET /portal-context error:", error);
        return res.status(500).json({ error: "Failed to load portal context" });
    }
});

// Previous contexts are deliberately read-only. A student can revisit a
// submitted year's records without being able to alter the class/form chosen
// for that year.
router.get("/history", requireAuth, async (req, res) => {
    try {
        const caller = req.user!;
        if (!caller.id) return policy.unauthorized(res);
        const userId = caller.id;
        if (!policy.isStudent(caller) && !policy.isTeacher(caller)) return res.json({ data: [] });
        const current = await currentAcademicYear();
        const archiveCutoff = current?.startsOn ?? schoolToday();
        const rows = await db.select({
            id: portalContexts.id,
            schoolBand: portalContexts.schoolBand,
            stage: portalContexts.stage,
            academicYear: { id: academicYears.id, name: academicYears.name, startsOn: academicYears.startsOn, endsOn: academicYears.endsOn },
        }).from(portalContexts)
            .innerJoin(academicYears, eq(portalContexts.academicYearId, academicYears.id))
            .where(eq(portalContexts.userId, caller.id))
            .orderBy(desc(academicYears.startsOn));
        const data = await Promise.all(rows.filter((row) => row.academicYear.endsOn < archiveCutoff).map(async (row) => {
            const candidates = await db.select({
                id: classes.id,
                name: classes.name,
                teacherId: classes.teacherId,
                academicYearId: classes.academicYearId,
                subject: { id: subjects.id, name: subjects.name },
            }).from(classes).leftJoin(subjects, eq(classes.subjectId, subjects.id));
            const yearClasses = candidates.filter((item) =>
                (item.academicYearId === row.academicYear.id || (item.academicYearId === null && row.academicYear.name === "Legacy"))
                && stageForClass(item.name) === row.stage,
            );
            if (policy.isTeacher(caller)) {
                return { ...row, isCurrent: row.academicYear.id === current?.id, classes: yearClasses.filter((item) => item.teacherId === caller.id).map(({ teacherId: _teacherId, academicYearId: _academicYearId, ...item }) => item) };
            }
            const enrolled = await db.select({ classId: enrollments.classId }).from(enrollments).where(eq(enrollments.studentId, userId));
            const enrolledIds = new Set(enrolled.map((item) => item.classId));
            return { ...row, isCurrent: row.academicYear.id === current?.id, classes: yearClasses.filter((item) => enrolledIds.has(item.id)).map(({ teacherId: _teacherId, academicYearId: _academicYearId, ...item }) => item) };
        }));
        return res.json({ data });
    } catch (error) {
        console.error("GET /portal-context/history error:", error);
        return res.status(500).json({ error: "Failed to load academic history" });
    }
});

// A previous year's portal is a read-only record of this student's own work.
// Historical access is authorized by their saved year context, while each
// query is scoped to their user ID and the selected year's real dates/terms.
router.get("/history/:academicYearId", requireAuth, async (req, res) => {
    try {
        const caller = req.user!;
        if (!caller.id) return policy.unauthorized(res);
        if (!policy.isStudent(caller)) return policy.forbidden(res, "Only students can open their academic archive.");
        const academicYearId = Number(req.params.academicYearId);
        if (!Number.isInteger(academicYearId) || academicYearId <= 0) return res.status(400).json({ error: "Choose a valid academic year." });
        const [year] = await db.select().from(academicYears).where(eq(academicYears.id, academicYearId));
        if (!year) return res.status(404).json({ error: "Academic year not found." });
        const [context] = await db.select().from(portalContexts).where(and(eq(portalContexts.userId, caller.id), eq(portalContexts.academicYearId, academicYearId)));
        if (!context) return policy.forbidden(res, "You have no saved context for this academic year.");
        const current = await currentAcademicYear();
        if (year.id === current?.id || year.endsOn >= (current?.startsOn ?? schoolToday())) {
            return res.status(409).json({ error: "This academic year has not closed. Use your current portal for active records." });
        }

        const yearStart = new Date(`${year.startsOn}T00:00:00Z`);
        const yearEndExclusive = new Date(`${year.endsOn}T00:00:00Z`);
        yearEndExclusive.setUTCDate(yearEndExclusive.getUTCDate() + 1);
        const belongsToYearAndStage = (row: { className: string; classAcademicYearId: number | null }) =>
            (row.classAcademicYearId === null || row.classAcademicYearId === year.id)
            && stageForClass(row.className) === context.stage;

        const [classOptions, termResults, attendanceRecords, assignmentRecords, examRecords] = await Promise.all([
            availableClassesFor(caller as policy.Caller & { id: string }, year),
            db.select({
                id: termSubjectResults.id, score: termSubjectResults.score, applicable: termSubjectResults.applicable,
                termId: academicTerms.id, termName: academicTerms.name, termType: academicTerms.type,
                subjectName: subjects.name, className: classes.name, classAcademicYearId: classes.academicYearId,
            }).from(termSubjectResults)
                .innerJoin(academicTerms, eq(termSubjectResults.academicTermId, academicTerms.id))
                .innerJoin(subjects, eq(termSubjectResults.subjectId, subjects.id))
                .innerJoin(classes, eq(termSubjectResults.classId, classes.id))
                .where(and(eq(termSubjectResults.studentId, caller.id), eq(termSubjectResults.published, true), eq(academicTerms.academicYearId, year.id)))
                .orderBy(desc(academicTerms.startsOn), subjects.name),
            db.select({
                id: attendance.id, date: attendance.date, status: attendance.status,
                className: classes.name, classAcademicYearId: classes.academicYearId,
            }).from(attendance).innerJoin(classes, eq(attendance.classId, classes.id))
                .where(and(eq(attendance.studentId, caller.id), gte(attendance.date, year.startsOn), lte(attendance.date, year.endsOn)))
                .orderBy(desc(attendance.date)),
            db.select({
                id: submissions.id, submittedAt: submissions.submittedAt, status: submissions.status, score: submissions.score,
                title: assignments.title, maxScore: assignments.maxScore,
                className: classes.name, classAcademicYearId: classes.academicYearId,
            }).from(submissions).innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .innerJoin(classes, eq(assignments.classId, classes.id))
                .where(and(eq(submissions.studentId, caller.id), gte(submissions.submittedAt, yearStart), lt(submissions.submittedAt, yearEndExclusive)))
                .orderBy(desc(submissions.submittedAt)),
            db.select({
                id: examResults.id, score: examResults.score, recordedAt: examResults.createdAt,
                title: exams.title, scheduledAt: exams.scheduledAt, maxScore: exams.maxScore,
                className: classes.name, classAcademicYearId: classes.academicYearId,
            }).from(examResults).innerJoin(exams, eq(examResults.examId, exams.id))
                .innerJoin(classes, eq(exams.classId, classes.id))
                .where(and(eq(examResults.studentId, caller.id), or(
                    and(gte(exams.scheduledAt, yearStart), lt(exams.scheduledAt, yearEndExclusive)),
                    and(isNull(exams.scheduledAt), gte(examResults.createdAt, yearStart), lt(examResults.createdAt, yearEndExclusive)),
                )))
                .orderBy(desc(exams.scheduledAt)),
        ]);

        return res.json({ data: {
            academicYear: year,
            context,
            classes: classOptions.filter((row) => stageForClass(row.name) === context.stage).map(({ teacherId: _teacherId, ...row }) => row),
            termResults: termResults.filter(belongsToYearAndStage).map(({ classAcademicYearId: _yearId, ...row }) => row),
            attendance: attendanceRecords.filter(belongsToYearAndStage).map(({ classAcademicYearId: _yearId, ...row }) => row),
            assignments: assignmentRecords.filter(belongsToYearAndStage).map(({ classAcademicYearId: _yearId, ...row }) => row),
            exams: examRecords.filter(belongsToYearAndStage).map(({ classAcademicYearId: _yearId, ...row }) => row),
        } });
    } catch (error) {
        console.error("GET /portal-context/history/:academicYearId error:", error);
        return res.status(500).json({ error: "Failed to load academic archive" });
    }
});

router.post("/", requireAuth, async (req, res) => {
    try {
        const caller = req.user!;
        const actorId = caller.id;
        if (!actorId) return policy.unauthorized(res);
        if (!policy.isStudent(caller) && !policy.isTeacher(caller)) return policy.forbidden(res, "Only students and teachers select a portal context.");
        const { academicYearId, schoolBand, stage } = req.body as { academicYearId?: number; schoolBand?: string; stage?: string };
        if (!academicYearId || !ALL_STAGES.includes(stage as PortalStage) || !["primary", "secondary"].includes(schoolBand ?? "")) return res.status(400).json({ error: "Choose a valid school level and form or class." });
        const selectedYearId = Number(academicYearId);
        const selectedStage = stage as PortalStage;
        const selectedBand = schoolBand as "primary" | "secondary";
        if (bandForStage(selectedStage) !== selectedBand) return res.status(400).json({ error: "The selected level does not match the form or class." });
        const academicYear = await currentAcademicYear();
        if (!academicYear || academicYear.id !== selectedYearId) return res.status(400).json({ error: "Select the current academic year." });
        // Choosing a portal context does not enrol the caller or grant class
        // access. A new student/teacher can complete onboarding before staff
        // assign classes; class-scoped routes still check real enrolment/ownership.
        const [existing] = await db.select().from(portalContexts).where(and(eq(portalContexts.userId, actorId), eq(portalContexts.academicYearId, academicYear.id)));
        if (policy.isStudent(caller)) {
            if (existing) {
                // A student's selection is fixed for an active calendar year.
                // This stops a Form I student from opening Form II data in the
                // same January–December year (and also prevents moving down).
                if (selectedStage !== existing.stage) {
                    return res.status(409).json({ error: "Select your correct class or form for this academic year. Your saved selection cannot be changed until the next academic year." });
                }
            } else {
                // Existing students must choose a stage they are actually
                // enrolled in for this year. A brand-new student with no
                // enrolments can still complete setup while staff prepare the
                // timetable.
                const enrolledStages = new Set(
                    (await availableClassesFor({ ...caller, id: actorId }, academicYear))
                        .map((item) => stageForClass(item.name))
                        .filter((item): item is PortalStage => !!item),
                );
                if (enrolledStages.size > 0 && !enrolledStages.has(selectedStage)) {
                    return res.status(409).json({ error: "Select your correct class or form. Your current enrolments are in a different stage." });
                }

                // On 1 January, use the most recent saved form as the
                // progression reference. The student may remain in it while
                // records/enrolment are being prepared, or advance exactly one
                // stage. They cannot skip Form II and open Form III directly.
                const [previous] = await db.select({ stage: portalContexts.stage })
                    .from(portalContexts)
                    .innerJoin(academicYears, eq(portalContexts.academicYearId, academicYears.id))
                    .where(and(eq(portalContexts.userId, actorId), lt(academicYears.startsOn, academicYear.startsOn)))
                    .orderBy(desc(academicYears.startsOn))
                    .limit(1);
                if (previous) {
                    const previousStage = previous.stage as PortalStage;
                    const isPreviousOrNext = progressionRank(selectedStage) === progressionRank(previousStage)
                        || progressionRank(selectedStage) === progressionRank(previousStage) + 1;
                    if (!isPreviousOrNext) {
                        return res.status(409).json({ error: "Select your correct class or form. At the start of a new academic year you may keep your previous stage or move ahead by one stage only." });
                    }
                }
            }
        }
        const [context] = await db.insert(portalContexts).values({ userId: actorId, academicYearId: selectedYearId, schoolBand: selectedBand, stage: selectedStage }).onConflictDoUpdate({ target: [portalContexts.userId, portalContexts.academicYearId], set: { schoolBand: selectedBand, stage: selectedStage, updatedAt: new Date() } }).returning();
        clearShortCacheForUser(actorId);
        return res.status(existing ? 200 : 201).json({ data: context });
    } catch (error) {
        console.error("POST /portal-context error:", error);
        return res.status(500).json({ error: "Failed to save portal context" });
    }
});

export default router;
