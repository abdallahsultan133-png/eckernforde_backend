import express from "express";
import { and, desc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";

import { db } from "../db/index.js";
import { academicTerms, academicYears, assignments, attendance, classes, enrollments, examResults, exams, portalContexts, submissions, subjects, termSubjectResults } from "../db/schema/app.js";
import { announcements, calendarEvents } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
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
        // Portal setup is for the current year only. Historical contexts are
        // exposed through /history, while future scheduled years stay hidden
        // until their configured start date.
        const academicYearsList = [academicYear];
        const [context] = await db.select().from(portalContexts).where(and(eq(portalContexts.userId, actorId), eq(portalContexts.academicYearId, academicYear.id)));
        const available = await availableClassesFor(scopedCaller, academicYear);
        const stages = [...new Set(available.map((item) => stageForClass(item.name)).filter((stage): stage is PortalStage => !!stage))];
        let archiveContext = null;
        if (policy.isTeacher(caller) && caller.portalArchive) {
            const [archiveYear] = await db.select().from(academicYears).where(eq(academicYears.id, caller.portalArchive.academicYearId));
            if (archiveYear && archiveYear.id !== academicYear.id && archiveYear.endsOn < academicYear.startsOn) {
                const archiveClasses = (await availableClassesFor(scopedCaller, archiveYear))
                    .filter((item) => stageForClass(item.name) === caller.portalArchive!.stage);
                if (archiveClasses.length > 0) archiveContext = {
                    ...caller.portalArchive,
                    academicYear: { id: archiveYear.id, name: archiveYear.name, startsOn: archiveYear.startsOn, endsOn: archiveYear.endsOn },
                    classes: archiveClasses.map(({ teacherId: _teacherId, academicYearId: _yearId, ...item }) => item),
                };
            }
        }
        return res.json({ data: { setupRequired: !context, academicYear, academicYears: academicYearsList, context: context ?? null, archiveContext, available, stages } });
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

// A teacher's previous-year workspace is selected explicitly by academic
// year, school band and stage. It never changes the teacher's active portal
// context and every result is limited to classes assigned to that teacher.
router.get("/teacher-history/options", requireAuth, async (req, res) => {
    try {
        const caller = req.user!;
        if (!caller.id) return policy.unauthorized(res);
        if (!policy.isTeacher(caller)) return policy.forbidden(res, "Only teachers can open the teaching archive.");

        const current = await currentAcademicYear();
        const archiveCutoff = current?.startsOn ?? schoolToday();
        const [years, teacherClasses] = await Promise.all([
            db.select().from(academicYears).orderBy(desc(academicYears.startsOn)),
            db.select({
                id: classes.id,
                name: classes.name,
                schoolLevel: classes.schoolLevel,
                academicYearId: classes.academicYearId,
                subject: { id: subjects.id, name: subjects.name, code: subjects.code },
            }).from(classes)
                .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                .where(eq(classes.teacherId, caller.id)),
        ]);

        const data = years
            .filter((year) => year.endsOn < archiveCutoff)
            .map((year) => {
                const stageMap = new Map<string, {
                    stage: PortalStage;
                    schoolBand: "primary" | "secondary";
                    classes: typeof teacherClasses;
                }>();
                for (const classRow of teacherClasses) {
                    const belongsToYear = classRow.academicYearId === year.id
                        || (classRow.academicYearId === null && year.name === "Legacy");
                    if (!belongsToYear) continue;
                    const stage = stageForClass(classRow.name);
                    if (!stage) continue;
                    const schoolBand = bandForStage(stage);
                    const key = `${schoolBand}:${stage}`;
                    const existing = stageMap.get(key);
                    if (existing) existing.classes.push(classRow);
                    else stageMap.set(key, { stage, schoolBand, classes: [classRow] });
                }
                return {
                    academicYear: { id: year.id, name: year.name, startsOn: year.startsOn, endsOn: year.endsOn },
                    selections: [...stageMap.values()],
                };
            })
            .filter((year) => year.selections.length > 0);

        return res.json({ data });
    } catch (error) {
        console.error("GET /portal-context/teacher-history/options error:", error);
        return res.status(500).json({ error: "Failed to load previous teaching years" });
    }
});

router.post("/teacher-history/open", requireAuth, async (req, res) => {
    try {
        const caller = req.user!;
        if (!caller.id) return policy.unauthorized(res);
        if (!policy.isTeacher(caller)) return policy.forbidden(res, "Only teachers can open the teaching archive.");
        const academicYearId = Number(req.body?.academicYearId);
        const schoolBand = String(req.body?.schoolBand ?? "");
        const stage = String(req.body?.stage ?? "") as PortalStage;
        if (!Number.isInteger(academicYearId) || academicYearId <= 0
            || !(["primary", "secondary"] as string[]).includes(schoolBand)
            || !ALL_STAGES.includes(stage) || bandForStage(stage) !== schoolBand) {
            return res.status(400).json({ error: "Choose a valid academic year, school and form or class." });
        }
        const [year] = await db.select().from(academicYears).where(eq(academicYears.id, academicYearId));
        if (!year) return res.status(404).json({ error: "Academic year not found." });
        const current = await currentAcademicYear();
        if (year.id === current?.id || year.endsOn >= (current?.startsOn ?? schoolToday())) {
            return res.status(409).json({ error: "Choose a completed academic year." });
        }
        const archiveClasses = (await availableClassesFor({ ...caller, id: caller.id }, year))
            .filter((item) => stageForClass(item.name) === stage);
        if (archiveClasses.length === 0) return policy.forbidden(res, "You have no classes in the selected previous-year context.");

        const value = encodeURIComponent(JSON.stringify({ userId: caller.id, academicYearId, schoolBand, stage }));
        const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
        res.setHeader("Set-Cookie", `academix_teacher_archive=${value}; Path=/api; HttpOnly; SameSite=Lax${secure}`);
        clearShortCacheForUser(caller.id);
        return res.json({ data: {
            academicYear: { id: year.id, name: year.name, startsOn: year.startsOn, endsOn: year.endsOn },
            schoolBand,
            stage,
            classes: archiveClasses.map(({ teacherId: _teacherId, academicYearId: _yearId, ...item }) => item),
        } });
    } catch (error) {
        console.error("POST /portal-context/teacher-history/open error:", error);
        return res.status(500).json({ error: "Failed to open the previous teaching year" });
    }
});

router.post("/teacher-history/close", requireAuth, async (req, res) => {
    if (!req.user?.id) return policy.unauthorized(res);
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `academix_teacher_archive=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    clearShortCacheForUser(req.user.id);
    return res.json({ success: true });
});

router.get("/teacher-history/:academicYearId", requireAuth, async (req, res) => {
    try {
        const caller = req.user!;
        if (!caller.id) return policy.unauthorized(res);
        if (!policy.isTeacher(caller)) return policy.forbidden(res, "Only teachers can open the teaching archive.");

        const academicYearId = Number(req.params.academicYearId);
        const schoolBand = String(req.query.schoolBand ?? "");
        const stage = String(req.query.stage ?? "") as PortalStage;
        if (!Number.isInteger(academicYearId) || academicYearId <= 0) return res.status(400).json({ error: "Choose a valid academic year." });
        if (!(["primary", "secondary"] as string[]).includes(schoolBand) || !ALL_STAGES.includes(stage) || bandForStage(stage) !== schoolBand) {
            return res.status(400).json({ error: "Choose a valid school and form or class." });
        }

        const [year] = await db.select().from(academicYears).where(eq(academicYears.id, academicYearId));
        if (!year) return res.status(404).json({ error: "Academic year not found." });
        const current = await currentAcademicYear();
        if (year.id === current?.id || year.endsOn >= (current?.startsOn ?? schoolToday())) {
            return res.status(409).json({ error: "This academic year has not closed. Use your current teaching workspace." });
        }

        const assignedClasses = (await availableClassesFor({ ...caller, id: caller.id }, year))
            .filter((item) => stageForClass(item.name) === stage);
        if (assignedClasses.length === 0) {
            return policy.forbidden(res, "You have no classes in the selected previous-year context.");
        }
        const classIds = assignedClasses.map((item) => item.id);

        const [classRows, enrollmentRows, homeworkRows, attendanceRows, examRows, formalResultRows, announcementRows, eventRows] = await Promise.all([
            db.select({
                id: classes.id, name: classes.name, description: classes.description, status: classes.status,
                capacity: classes.capacity, schedules: classes.schedules, schoolLevel: classes.schoolLevel,
                subject: { id: subjects.id, name: subjects.name, code: subjects.code },
            }).from(classes)
                .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                .where(and(eq(classes.teacherId, caller.id), inArray(classes.id, classIds))),
            db.select({
                classId: classes.id, className: classes.name,
                studentId: user.id, studentName: user.name, studentEmail: user.email,
            }).from(enrollments)
                .innerJoin(classes, eq(enrollments.classId, classes.id))
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .where(inArray(enrollments.classId, classIds))
                .orderBy(classes.name, user.name),
            db.select({
                id: assignments.id, classId: assignments.classId, className: classes.name,
                title: assignments.title, description: assignments.description, dueAt: assignments.dueAt,
                maxScore: assignments.maxScore, createdAt: assignments.createdAt,
            }).from(assignments)
                .innerJoin(classes, eq(assignments.classId, classes.id))
                .where(inArray(assignments.classId, classIds))
                .orderBy(desc(assignments.createdAt)),
            db.select({
                id: attendance.id, classId: attendance.classId, className: classes.name,
                studentId: user.id, studentName: user.name, date: attendance.date,
                status: attendance.status, notes: attendance.notes,
            }).from(attendance)
                .innerJoin(classes, eq(attendance.classId, classes.id))
                .innerJoin(user, eq(attendance.studentId, user.id))
                .where(inArray(attendance.classId, classIds))
                .orderBy(desc(attendance.date), classes.name, user.name),
            db.select({
                id: exams.id, classId: exams.classId, className: classes.name,
                title: exams.title, examType: exams.examType, scheduledAt: exams.scheduledAt,
                durationMinutes: exams.durationMinutes, maxScore: exams.maxScore, venue: exams.venue,
            }).from(exams)
                .innerJoin(classes, eq(exams.classId, classes.id))
                .where(inArray(exams.classId, classIds))
                .orderBy(desc(exams.scheduledAt)),
            db.select({
                id: termSubjectResults.id, classId: termSubjectResults.classId, className: classes.name,
                subjectId: subjects.id, subjectName: subjects.name, termId: academicTerms.id,
                termName: academicTerms.name, termType: academicTerms.type, score: termSubjectResults.score,
                published: termSubjectResults.published, studentId: user.id, studentName: user.name,
            }).from(termSubjectResults)
                .innerJoin(academicTerms, eq(termSubjectResults.academicTermId, academicTerms.id))
                .innerJoin(classes, eq(termSubjectResults.classId, classes.id))
                .innerJoin(subjects, eq(termSubjectResults.subjectId, subjects.id))
                .innerJoin(user, eq(termSubjectResults.studentId, user.id))
                .where(and(inArray(termSubjectResults.classId, classIds), eq(academicTerms.academicYearId, year.id)))
                .orderBy(desc(academicTerms.startsOn), classes.name, subjects.name, user.name),
            db.select({
                id: announcements.id, classId: announcements.classId, className: classes.name,
                title: announcements.title, content: announcements.content, pinned: announcements.pinned,
                createdAt: announcements.createdAt,
            }).from(announcements)
                .innerJoin(classes, eq(announcements.classId, classes.id))
                .where(inArray(announcements.classId, classIds))
                .orderBy(desc(announcements.createdAt)),
            db.select({
                id: calendarEvents.id, classId: calendarEvents.classId, className: classes.name,
                title: calendarEvents.title, description: calendarEvents.description, type: calendarEvents.type,
                startAt: calendarEvents.startAt, endAt: calendarEvents.endAt, allDay: calendarEvents.allDay,
            }).from(calendarEvents)
                .innerJoin(classes, eq(calendarEvents.classId, classes.id))
                .where(inArray(calendarEvents.classId, classIds))
                .orderBy(desc(calendarEvents.startAt)),
        ]);

        const homeworkIds = homeworkRows.map((item) => item.id);
        const examIds = examRows.map((item) => item.id);
        const [submissionRows, examResultRows] = await Promise.all([
            homeworkIds.length
                ? db.select({ assignmentId: submissions.assignmentId, status: submissions.status, score: submissions.score })
                    .from(submissions).where(inArray(submissions.assignmentId, homeworkIds))
                : Promise.resolve([]),
            examIds.length
                ? db.select({ examId: examResults.examId, score: examResults.score })
                    .from(examResults).where(inArray(examResults.examId, examIds))
                : Promise.resolve([]),
        ]);

        const classStudentCounts = new Map<number, number>();
        for (const row of enrollmentRows) classStudentCounts.set(row.classId, (classStudentCounts.get(row.classId) ?? 0) + 1);
        const homework = homeworkRows.map((row) => {
            const records = submissionRows.filter((item) => item.assignmentId === row.id);
            const scores = records.flatMap((item) => item.score === null ? [] : [item.score]);
            return {
                ...row,
                submissionCount: records.length,
                gradedCount: scores.length,
                averageScore: scores.length ? Math.round((scores.reduce((total, score) => total + score, 0) / scores.length) * 10) / 10 : null,
            };
        });
        const archiveExams = examRows.map((row) => {
            const records = examResultRows.filter((item) => item.examId === row.id);
            return {
                ...row,
                resultCount: records.length,
                averageScore: records.length ? Math.round((records.reduce((total, item) => total + item.score, 0) / records.length) * 10) / 10 : null,
            };
        });
        const formalResultGroups = new Map<string, {
            termId: number; termName: string; termType: string; classId: number; className: string;
            subjectId: number; subjectName: string; resultCount: number; publishedCount: number; totalScore: number;
        }>();
        for (const row of formalResultRows) {
            const key = `${row.termId}:${row.classId}:${row.subjectId}`;
            const group = formalResultGroups.get(key) ?? {
                termId: row.termId, termName: row.termName, termType: row.termType,
                classId: row.classId, className: row.className, subjectId: row.subjectId,
                subjectName: row.subjectName, resultCount: 0, publishedCount: 0, totalScore: 0,
            };
            group.resultCount += 1;
            group.publishedCount += row.published ? 1 : 0;
            group.totalScore += row.score;
            formalResultGroups.set(key, group);
        }

        const subjectsById = new Map<number, { id: number; name: string; code: string }>();
        for (const row of classRows) if (row.subject) subjectsById.set(row.subject.id, row.subject);
        return res.json({ data: {
            academicYear: { id: year.id, name: year.name, startsOn: year.startsOn, endsOn: year.endsOn },
            context: { schoolBand, stage },
            classes: classRows.map((row) => ({ ...row, studentCount: classStudentCounts.get(row.id) ?? 0 })),
            subjects: [...subjectsById.values()],
            students: enrollmentRows,
            homework,
            attendance: attendanceRows,
            exams: archiveExams,
            formalResults: [...formalResultGroups.values()].map(({ totalScore, ...group }) => ({
                ...group,
                averageScore: group.resultCount ? Math.round((totalScore / group.resultCount) * 10) / 10 : null,
            })),
            announcements: announcementRows,
            events: eventRows,
        } });
    } catch (error) {
        console.error("GET /portal-context/teacher-history/:academicYearId error:", error);
        return res.status(500).json({ error: "Failed to load the previous teaching year" });
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
