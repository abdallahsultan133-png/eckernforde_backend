import { Router } from "express";
import { and, count, countDistinct, eq, gt, gte, ilike, lt, isNull, inArray, or, sql, desc } from "drizzle-orm";

import { db } from "../db/index.js";
import { user } from "../db/schema/auth.js";
import { academicTerms, classes, subjects, departments, enrollments, attendance, assignments, announcements, submissions, classGrades, termSubjectResults } from "../db/schema/app.js";
import { requireAuth } from "../middleware/require-auth.js";
import { shortCache } from "../middleware/cache.js";
import { activePortalClassIds } from "../lib/portal-context.js";
import * as policy from "../lib/policy.js";
import { gradeSecondaryScore } from "../lib/grading/student-division.js";

const dashboardRouter = Router();

// Every route here is a read-only, per-user rollup that fans out into many
// aggregate queries. A 15s per-user response cache makes refreshes, extra tabs,
// and navigating back to the dashboard effectively free, while keeping the
// numbers fresh enough that a change shows up within seconds.
dashboardRouter.use(shortCache(15));

const daysAgoISO = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
};

const daysAgo = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d;
};

// Percent change vs a prior-period count, rounded to 1 decimal. Null when
// there's no meaningful baseline (avoids a misleading "+Infinity%" or "+100%"
// off a zero prior count).
const pctChange = (current: number, previous: number): number | null => {
    if (previous <= 0) return null;
    return Math.round(((current - previous) / previous) * 1000) / 10;
};

function readAcademicYearId(value: unknown): number | null | undefined {
    if (value === undefined) return undefined;
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function dashboardStageScope(value: unknown) {
    if (value === undefined) return undefined;
    const stage = String(value).trim().toLowerCase();
    const patterns: Record<string, string[]> = {
        nursery: ["nursery%"],
        kindergarten_i: ["kg i%", "kg_i%", "kindergarten i%", "kindergarten_i%"],
        kindergarten_ii: ["kg ii%", "kg_ii%", "kindergarten ii%", "kindergarten_ii%"],
        kindergarten_iii: ["kg iii%", "kg_iii%", "kindergarten iii%", "kindergarten_iii%"],
        standard_i: ["standard i%", "standard_i%", "class i%", "class_i%"],
        standard_ii: ["standard ii%", "standard_ii%", "class ii%", "class_ii%"],
        standard_iii: ["standard iii%", "standard_iii%", "class iii%", "class_iii%"],
        standard_iv: ["standard iv%", "standard_iv%", "class iv%", "class_iv%"],
        standard_v: ["standard v%", "standard_v%", "class v%", "class_v%"],
        standard_vi: ["standard vi%", "standard_vi%", "class vi%", "class_vi%"],
        form_i: ["form i%", "form_i%"], form_ii: ["form ii%", "form_ii%"],
        form_iii: ["form iii%", "form_iii%"], form_iv: ["form iv%", "form_iv%"],
    };
    return patterns[stage] ? or(...patterns[stage].map((pattern) => ilike(classes.name, pattern))) : null;
}

function dashboardSchoolScope(value: unknown, role?: string) {
    if (role !== "super_admin" || value === undefined) return undefined;
    const level = String(value);
    if (!["primary", "secondary"].includes(level)) return null;
    return eq(classes.schoolLevel, level as "primary" | "secondary");
}

// A teacher's dashboard is scoped to only the classes they teach — their own
// students, attendance, and grading load, not the whole school's. Every other
// role still sees the org-wide numbers.
dashboardRouter.get("/stats", requireAuth, async (req, res) => {
    try {
        const academicYearId = readAcademicYearId(req.query.academicYearId);
        if (academicYearId === null) return res.status(400).json({ message: "Invalid academic year" });
        const dashboardClassScope = and(policy.headmasterClassScope(req.user!), academicYearId === undefined ? undefined : eq(classes.academicYearId, academicYearId));
        const isTeacher = req.user?.role === "teacher";
        const contextClassIds = req.user?.id && (req.user.role === "teacher" || req.user.role === "student")
            ? await activePortalClassIds({ ...req.user, id: req.user.id })
            : null;
        const contextClassScope = contextClassIds ? (contextClassIds.length ? inArray(classes.id, contextClassIds) : sql`false`) : undefined;
        const contextAttendanceScope = contextClassIds ? (contextClassIds.length ? inArray(attendance.classId, contextClassIds) : sql`false`) : undefined;

        if (isTeacher) {
            const teacherId = req.user!.id!;
            const cutoff30 = daysAgoISO(30);
            const cutoff60 = daysAgoISO(60);

            const [
                [studentsResult], [classesResult], [subjectsResult], [attendanceStats], [pendingGrading],
                [prevClasses], [prevSubjects], [prevAttendanceStats],
                [expectedSubmissions], [actualSubmissions],
            ] = await Promise.all([
                db
                    .select({ total: countDistinct(enrollments.studentId) })
                    .from(enrollments)
                    .innerJoin(classes, eq(enrollments.classId, classes.id))
                    .where(and(eq(classes.teacherId, teacherId), contextClassScope, dashboardClassScope)),
                db.select({ total: count() }).from(classes).where(and(eq(classes.teacherId, teacherId), contextClassScope, dashboardClassScope)),
                db
                    .select({ total: countDistinct(classes.subjectId) })
                    .from(classes)
                    .where(and(eq(classes.teacherId, teacherId), contextClassScope, dashboardClassScope)),
                db
                    .select({
                        total: sql<number>`count(*)`.mapWith(Number),
                        present: sql<number>`count(*) filter (where ${attendance.status} = 'present')`.mapWith(Number),
                    })
                    .from(attendance)
                    .innerJoin(classes, eq(attendance.classId, classes.id))
                    .where(and(eq(classes.teacherId, teacherId), contextClassScope, dashboardClassScope, gte(attendance.date, cutoff30))),
                db
                    .select({ total: count() })
                    .from(submissions)
                    .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                    .innerJoin(classes, eq(assignments.classId, classes.id))
                    .where(and(eq(classes.teacherId, teacherId), contextClassScope, dashboardClassScope, eq(submissions.status, "submitted"))),
                // Prior-period baselines for trend deltas — same shape, cut off 30 days earlier.
                db.select({ total: count() }).from(classes).where(and(eq(classes.teacherId, teacherId), contextClassScope, dashboardClassScope, lt(classes.createdAt, daysAgo(30)))),
                db
                    .select({ total: countDistinct(classes.subjectId) })
                    .from(classes)
                    .where(and(eq(classes.teacherId, teacherId), contextClassScope, dashboardClassScope, lt(classes.createdAt, daysAgo(30)))),
                db
                    .select({
                        total: sql<number>`count(*)`.mapWith(Number),
                        present: sql<number>`count(*) filter (where ${attendance.status} = 'present')`.mapWith(Number),
                    })
                    .from(attendance)
                    .innerJoin(classes, eq(attendance.classId, classes.id))
                    .where(and(eq(classes.teacherId, teacherId), contextClassScope, dashboardClassScope, gte(attendance.date, cutoff60), lt(attendance.date, cutoff30))),
                // Assignment completion = actual submissions / (assignments × enrolled students) across the teacher's classes.
                db
                    .select({ total: sql<number>`count(*)`.mapWith(Number) })
                    .from(assignments)
                    .innerJoin(classes, eq(assignments.classId, classes.id))
                    .innerJoin(enrollments, eq(enrollments.classId, classes.id))
                    .where(and(eq(classes.teacherId, teacherId), contextClassScope, dashboardClassScope)),
                db
                    .select({ total: count() })
                    .from(submissions)
                    .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                    .innerJoin(classes, eq(assignments.classId, classes.id))
                    .where(and(eq(classes.teacherId, teacherId), contextClassScope, dashboardClassScope)),
            ]);

            const attendanceRate = attendanceStats && attendanceStats.total > 0
                ? Math.round((attendanceStats.present / attendanceStats.total) * 1000) / 10
                : null;
            const prevAttendanceRate = prevAttendanceStats && prevAttendanceStats.total > 0
                ? (prevAttendanceStats.present / prevAttendanceStats.total) * 100
                : null;

            const assignmentCompletionRate = expectedSubmissions?.total
                ? Math.round(((actualSubmissions?.total ?? 0) / expectedSubmissions.total) * 1000) / 10
                : null;

            return res.json({
                students: studentsResult?.total ?? 0,
                classes: classesResult?.total ?? 0,
                subjects: subjectsResult?.total ?? 0,
                attendanceRate,
                pendingGrading: pendingGrading?.total ?? 0,
                assignmentCompletionRate,
                // No createdAt on enrollments, so a "students" trend can't be
                // computed honestly for a teacher's roster — omitted rather than faked.
                trends: {
                    classes: pctChange(classesResult?.total ?? 0, prevClasses?.total ?? 0),
                    subjects: pctChange(subjectsResult?.total ?? 0, prevSubjects?.total ?? 0),
                    attendanceRate: attendanceRate !== null && prevAttendanceRate !== null
                        ? Math.round((attendanceRate - prevAttendanceRate) * 10) / 10
                        : null,
                },
            });
        }

        // A student's attendance rate (and now classes/subjects/pending-work
        // counts) are their own, not the school-wide figures. Parents fall
        // through this branch too, but the root dashboard doesn't use these
        // org-wide numbers for them — see /profile/my-children instead.
        const isStudent = req.user?.role === "student";
        const isAdminLike = policy.isAdmin(req.user!);
        const isHeadmaster = policy.isHeadmaster(req.user!);
        const studentId = req.user?.id;
        const cutoff30 = daysAgoISO(30);
        const cutoff60 = daysAgoISO(60);
        const cutoff30Date = daysAgo(30);

        const [
            students, teachers, totalClasses, totalSubjects, [attendanceStats], [pendingGrading],
            [prevStudents], [prevTeachers], [prevClasses], [prevSubjects], [prevAttendanceStats],
            [departmentsResult], [prevDepartments],
            [pendingAssignments],
        ] = await Promise.all([
            isStudent && studentId
                ? db.select({ total: countDistinct(enrollments.classId) }).from(enrollments).where(and(eq(enrollments.studentId, studentId), contextClassIds ? inArray(enrollments.classId, contextClassIds) : undefined))
                : isHeadmaster || academicYearId !== undefined
                    ? db.select({ total: countDistinct(enrollments.studentId) }).from(enrollments).innerJoin(classes, eq(enrollments.classId, classes.id)).where(dashboardClassScope)
                    : db.select({ total: count() }).from(user).where(eq(user.role, "student")),
            isHeadmaster || academicYearId !== undefined
                ? db.select({ total: countDistinct(classes.teacherId) }).from(classes).where(dashboardClassScope)
                : db.select({ total: count() }).from(user).where(eq(user.role, "teacher")),
            isStudent && studentId
                ? db.select({ total: countDistinct(enrollments.classId) }).from(enrollments).where(and(eq(enrollments.studentId, studentId), contextClassIds ? inArray(enrollments.classId, contextClassIds) : undefined))
                : db.select({ total: count() }).from(classes).where(dashboardClassScope),
            isStudent && studentId
                ? db
                    .select({ total: countDistinct(classes.subjectId) })
                    .from(enrollments)
                    .innerJoin(classes, eq(enrollments.classId, classes.id))
                    .where(and(eq(enrollments.studentId, studentId), contextClassScope))
                : isHeadmaster || academicYearId !== undefined
                    ? db.select({ total: countDistinct(classes.subjectId) }).from(classes).where(dashboardClassScope)
                    : db.select({ total: count() }).from(subjects),
            isStudent && studentId
                ? db
                    .select({
                        total: sql<number>`count(*)`.mapWith(Number),
                        present: sql<number>`count(*) filter (where ${attendance.status} = 'present')`.mapWith(Number),
                    })
                    .from(attendance)
                    .where(and(eq(attendance.studentId, studentId), contextAttendanceScope, gte(attendance.date, cutoff30)))
                : db
                    .select({
                        total: sql<number>`count(*)`.mapWith(Number),
                        present: sql<number>`count(*) filter (where ${attendance.status} = 'present')`.mapWith(Number),
                    })
                    .from(attendance)
                    .innerJoin(classes, eq(attendance.classId, classes.id))
                    .where(and(gte(attendance.date, cutoff30), dashboardClassScope)),
            isHeadmaster || academicYearId !== undefined
                ? db
                    .select({ total: count() })
                    .from(submissions)
                    .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                    .innerJoin(classes, eq(assignments.classId, classes.id))
                    .where(and(eq(submissions.status, "submitted"), dashboardClassScope))
                : db
                    .select({ total: count() })
                    .from(submissions)
                    .where(eq(submissions.status, "submitted")),
            // Prior-period baselines for trend deltas. Students' own
            // enrollment counts have no createdAt to compare against, so
            // those trends are simply omitted below rather than computed here.
            db.select({ total: count() }).from(user).where(and(eq(user.role, "student"), lt(user.createdAt, cutoff30Date))),
            db.select({ total: count() }).from(user).where(and(eq(user.role, "teacher"), lt(user.createdAt, cutoff30Date))),
            db.select({ total: count() }).from(classes).where(and(dashboardClassScope, lt(classes.createdAt, cutoff30Date))),
            academicYearId !== undefined
                ? db.select({ total: countDistinct(classes.subjectId) }).from(classes).where(and(dashboardClassScope, lt(classes.createdAt, cutoff30Date)))
                : db.select({ total: count() }).from(subjects).where(lt(subjects.createdAt, cutoff30Date)),
            isStudent && studentId
                ? db
                    .select({
                        total: sql<number>`count(*)`.mapWith(Number),
                        present: sql<number>`count(*) filter (where ${attendance.status} = 'present')`.mapWith(Number),
                    })
                    .from(attendance)
                    .where(and(eq(attendance.studentId, studentId), contextAttendanceScope, gte(attendance.date, cutoff60), lt(attendance.date, cutoff30)))
                : db
                    .select({
                        total: sql<number>`count(*)`.mapWith(Number),
                        present: sql<number>`count(*) filter (where ${attendance.status} = 'present')`.mapWith(Number),
                    })
                    .from(attendance)
                    .innerJoin(classes, eq(attendance.classId, classes.id))
                    .where(and(dashboardClassScope, gte(attendance.date, cutoff60), lt(attendance.date, cutoff30))),
            isAdminLike && (isHeadmaster || academicYearId !== undefined)
                ? db.select({ total: countDistinct(departments.id) }).from(departments).innerJoin(subjects, eq(subjects.departmentId, departments.id)).innerJoin(classes, eq(classes.subjectId, subjects.id)).where(dashboardClassScope)
                : isAdminLike ? db.select({ total: count() }).from(departments) : Promise.resolve([{ total: 0 }]),
            isAdminLike && (isHeadmaster || academicYearId !== undefined)
                ? db.select({ total: countDistinct(departments.id) }).from(departments).innerJoin(subjects, eq(subjects.departmentId, departments.id)).innerJoin(classes, eq(classes.subjectId, subjects.id)).where(and(dashboardClassScope, lt(departments.createdAt, cutoff30Date)))
                : isAdminLike ? db.select({ total: count() }).from(departments).where(lt(departments.createdAt, cutoff30Date)) : Promise.resolve([{ total: 0 }]),
            isStudent && studentId
                ? db
                    .select({ total: sql<number>`count(*)`.mapWith(Number) })
                    .from(assignments)
                    .innerJoin(enrollments, eq(enrollments.classId, assignments.classId))
                    .innerJoin(classes, eq(assignments.classId, classes.id))
                    .leftJoin(submissions, and(eq(submissions.assignmentId, assignments.id), eq(submissions.studentId, studentId)))
                    // "Pending" = still actionable: enrolled, not yet submitted, and
                    // the deadline hasn't passed (the submit route rejects anything
                    // past dueAt, so a closed assignment isn't something the student
                    // can act on — counting it here just makes the dashboard lie).
                    .where(and(
                        eq(enrollments.studentId, studentId),
                        contextClassScope,
                        isNull(submissions.id),
                        or(isNull(assignments.dueAt), gt(assignments.dueAt, new Date())),
                    ))
                : Promise.resolve([{ total: 0 }]),
        ]);

        const attendanceRate = attendanceStats && attendanceStats.total > 0
            ? Math.round((attendanceStats.present / attendanceStats.total) * 1000) / 10
            : null;
        const prevAttendanceRate = prevAttendanceStats && prevAttendanceStats.total > 0
            ? (prevAttendanceStats.present / prevAttendanceStats.total) * 100
            : null;
        const attendanceRateTrend = attendanceRate !== null && prevAttendanceRate !== null
            ? Math.round((attendanceRate - prevAttendanceRate) * 10) / 10
            : null;

        res.json({
            students: students[0]?.total ?? 0,
            teachers: teachers[0]?.total ?? 0,
            classes: totalClasses[0]?.total ?? 0,
            subjects: totalSubjects[0]?.total ?? 0,
            attendanceRate,
            pendingGrading: pendingGrading?.total ?? 0,
            ...(isAdminLike ? { departments: departmentsResult?.total ?? 0 } : {}),
            ...(isStudent ? { pendingAssignments: pendingAssignments?.total ?? 0 } : {}),
            trends: {
                ...(isStudent ? {} : {
                    students: pctChange(students[0]?.total ?? 0, prevStudents?.total ?? 0),
                    classes: pctChange(totalClasses[0]?.total ?? 0, prevClasses?.total ?? 0),
                    subjects: pctChange(totalSubjects[0]?.total ?? 0, prevSubjects?.total ?? 0),
                }),
                teachers: pctChange(teachers[0]?.total ?? 0, prevTeachers?.total ?? 0),
                attendanceRate: attendanceRateTrend,
                ...(isAdminLike ? { departments: pctChange(departmentsResult?.total ?? 0, prevDepartments?.total ?? 0) } : {}),
            },
        });
    } catch (error) {
        console.error("Dashboard stats error:", error);
        res.status(500).json({ message: "Failed to load dashboard statistics" });
    }
});

// GET /api/dashboard/recent-activity?limit=5
// Merges the most recent announcements, assignments, and submissions into one
// feed. Org-wide for every role, including teachers — everyone sees what
// everyone else has been doing, not just their own classes. The dashboard asks
// for the latest 5; the "all activity" page asks for a larger slice.
dashboardRouter.get("/recent-activity", requireAuth, async (req, res) => {
    try {
        const academicYearId = readAcademicYearId(req.query.academicYearId);
        if (academicYearId === null) return res.status(400).json({ message: "Invalid academic year" });
        const dashboardClassScope = and(policy.headmasterClassScope(req.user!), academicYearId === undefined ? undefined : eq(classes.academicYearId, academicYearId));
        const requestedLimit = Number(req.query.limit);
        const limit = Number.isFinite(requestedLimit)
            ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
            : 5;
        const contextClassIds = req.user?.id && (req.user.role === "teacher" || req.user.role === "student")
            ? await activePortalClassIds({ ...req.user, id: req.user.id })
            : null;
        const activityScope = contextClassIds ? (contextClassIds.length ? inArray(classes.id, contextClassIds) : sql`false`) : undefined;
        const announcementScope = contextClassIds
            ? and(activityScope, dashboardClassScope)
            : dashboardClassScope
                ? or(isNull(announcements.classId), dashboardClassScope)!
                : undefined;

        const [recentAnnouncements, recentAssignments, recentSubmissions] = await Promise.all([
            db
                .select({
                    id: announcements.id,
                    title: announcements.title,
                    createdAt: announcements.createdAt,
                    authorName: user.name,
                })
                .from(announcements)
                .innerJoin(user, eq(announcements.authorId, user.id))
                .leftJoin(classes, eq(announcements.classId, classes.id))
                .where(announcementScope)
                .orderBy(desc(announcements.createdAt))
                .limit(limit),
            db
                .select({
                    id: assignments.id,
                    title: assignments.title,
                    createdAt: assignments.createdAt,
                    className: classes.name,
                })
                .from(assignments)
                .innerJoin(classes, eq(assignments.classId, classes.id))
                .where(and(activityScope, dashboardClassScope))
                .orderBy(desc(assignments.createdAt))
                .limit(limit),
            db
                .select({
                    id: submissions.id,
                    createdAt: submissions.submittedAt,
                    studentName: user.name,
                    assignmentTitle: assignments.title,
                })
                .from(submissions)
                .innerJoin(user, eq(submissions.studentId, user.id))
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .innerJoin(classes, eq(assignments.classId, classes.id))
                .where(and(
                    activityScope,
                    dashboardClassScope,
                    policy.isTeacher(req.user!) ? eq(user.role, "student") : undefined,
                ))
                .orderBy(desc(submissions.submittedAt))
                .limit(limit),
        ]);

        const feed = [
            ...recentAnnouncements.map((a) => ({
                type: "announcement" as const,
                id: a.id,
                title: "New announcement",
                description: `${a.title} — by ${a.authorName}`,
                time: a.createdAt,
            })),
            ...recentAssignments.map((a) => ({
                type: "assignment" as const,
                id: a.id,
                title: "Homework published",
                description: `${a.title} (${a.className})`,
                time: a.createdAt,
            })),
            ...recentSubmissions.map((s) => ({
                type: "submission" as const,
                id: s.id,
                title: "Homework submitted",
                description: `${s.studentName} submitted "${s.assignmentTitle}"`,
                time: s.createdAt,
            })),
        ]
            .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
            .slice(0, limit);

        res.json({ data: feed });
    } catch (error) {
        console.error("Dashboard recent-activity error:", error);
        res.status(500).json({ message: "Failed to load recent activity" });
    }
});

// GET /api/dashboard/attendance-today — a current, operational snapshot rather
// than a misleading zero when the school has not yet recorded any marks. The
// same role scoping as the trend endpoint applies: teachers see their classes,
// students see their own records, and administrators see the school total.
dashboardRouter.get("/attendance-today", requireAuth, async (req, res) => {
    try {
        const academicYearId = readAcademicYearId(req.query.academicYearId);
        if (academicYearId === null) return res.status(400).json({ message: "Invalid academic year" });
        const dashboardClassScope = and(policy.headmasterClassScope(req.user!), academicYearId === undefined ? undefined : eq(classes.academicYearId, academicYearId));
        const today = new Date().toISOString().slice(0, 10);
        const isTeacher = req.user?.role === "teacher";
        const isStudent = req.user?.role === "student";
        const userId = req.user?.id;
        const contextClassIds = userId && (isTeacher || isStudent)
            ? await activePortalClassIds({ ...req.user!, id: userId })
            : null;
        const contextClassScope = contextClassIds
            ? (contextClassIds.length ? inArray(classes.id, contextClassIds) : sql`false`)
            : undefined;
        const scope = isTeacher && userId
            ? and(eq(classes.teacherId, userId), contextClassScope, dashboardClassScope)
            : isStudent && userId
                ? and(eq(attendance.studentId, userId), contextClassScope, dashboardClassScope)
                : dashboardClassScope;

        const [summary] = await db
            .select({
                total: sql<number>`count(*)`.mapWith(Number),
                present: sql<number>`count(*) filter (where ${attendance.status} = 'present')`.mapWith(Number),
                absent: sql<number>`count(*) filter (where ${attendance.status} = 'absent')`.mapWith(Number),
                late: sql<number>`count(*) filter (where ${attendance.status} = 'late')`.mapWith(Number),
                excused: sql<number>`count(*) filter (where ${attendance.status} = 'excused')`.mapWith(Number),
            })
            .from(attendance)
            .innerJoin(classes, eq(attendance.classId, classes.id))
            .where(scope ? and(eq(attendance.date, today), scope) : eq(attendance.date, today));

        // For a teacher, an empty attendance register is actionable. Keep the
        // class list separate from the school-wide snapshot so an admin never
        // receives a potentially overwhelming and unactionable list.
        let unrecordedClasses: { id: number; name: string }[] = [];
        if (isTeacher && userId) {
            const [myClasses, recorded] = await Promise.all([
                db.select({ id: classes.id, name: classes.name }).from(classes).where(and(eq(classes.teacherId, userId), contextClassScope, dashboardClassScope)),
                db.select({ classId: attendance.classId })
                    .from(attendance)
                    .innerJoin(classes, eq(attendance.classId, classes.id))
                    .where(and(eq(attendance.date, today), eq(classes.teacherId, userId), contextClassScope, dashboardClassScope))
                    .groupBy(attendance.classId),
            ]);
            const recordedIds = new Set(recorded.map((row) => row.classId));
            unrecordedClasses = myClasses.filter((item) => !recordedIds.has(item.id));
        }

        res.json({
            date: today,
            total: summary?.total ?? 0,
            present: summary?.present ?? 0,
            absent: summary?.absent ?? 0,
            late: summary?.late ?? 0,
            excused: summary?.excused ?? 0,
            unrecordedClasses,
        });
    } catch (error) {
        console.error("Dashboard attendance-today error:", error);
        res.status(500).json({ message: "Failed to load today's attendance" });
    }
});

// GET /api/dashboard/attendance-trend?range=7|30|90|365 — attendance
// present/absent/late breakdown bucketed by day (<=30d), week (90d), or month
// (365d). Scoped to the teacher's own classes for teachers, to the student's
// own attendance for students; org-wide for everyone else.
const ATTENDANCE_RANGE_DAYS: Record<string, number> = { "7": 7, "30": 30, "90": 90, "365": 365 };

dashboardRouter.get("/attendance-trend", requireAuth, async (req, res) => {
    try {
        const academicYearId = readAcademicYearId(req.query.academicYearId);
        if (academicYearId === null) return res.status(400).json({ message: "Invalid academic year" });
        const stageScope = dashboardStageScope(req.query.stage);
        if (stageScope === null) return res.status(400).json({ message: "Invalid class or form" });
        const schoolScope = dashboardSchoolScope(req.query.schoolLevel, req.user?.role);
        if (schoolScope === null) return res.status(400).json({ message: "Invalid school level" });
        const dashboardClassScope = and(policy.headmasterClassScope(req.user!), academicYearId === undefined ? undefined : eq(classes.academicYearId, academicYearId), schoolScope, stageScope);
        const isTeacher = req.user?.role === "teacher";
        const isStudent = req.user?.role === "student";
        const userId = req.user?.id;
        const contextClassIds = userId && (isTeacher || isStudent)
            ? await activePortalClassIds({ ...req.user!, id: userId })
            : null;
        const contextClassScope = contextClassIds
            ? (contextClassIds.length ? inArray(classes.id, contextClassIds) : sql`false`)
            : undefined;

        const days = ATTENDANCE_RANGE_DAYS[String(req.query.range ?? "30")] ?? 30;
        const bucket = days > 90
            ? sql<string>`to_char(${attendance.date}::date, 'YYYY-MM')`
            : days > 30
                ? sql<string>`to_char(date_trunc('week', ${attendance.date}::date), 'YYYY-MM-DD')`
                : attendance.date;

        const conditions = [gte(attendance.date, daysAgoISO(days))];
        if (isTeacher && userId) conditions.push(eq(classes.teacherId, userId));
        if (isStudent && userId) conditions.push(eq(attendance.studentId, userId));
        if (contextClassScope) conditions.push(contextClassScope);
        if (dashboardClassScope) conditions.push(dashboardClassScope);

        const rows = await db
            .select({
                bucket,
                total: sql<number>`count(*)`.mapWith(Number),
                present: sql<number>`count(*) filter (where ${attendance.status} = 'present')`.mapWith(Number),
                absent: sql<number>`count(*) filter (where ${attendance.status} = 'absent')`.mapWith(Number),
                late: sql<number>`count(*) filter (where ${attendance.status} = 'late')`.mapWith(Number),
            })
            .from(attendance)
            .innerJoin(classes, eq(attendance.classId, classes.id))
            .where(and(...conditions))
            .groupBy(bucket)
            .orderBy(bucket);

        const data = rows.map((r) => ({
            date: r.bucket,
            attendanceRate: r.total > 0 ? Math.round((r.present / r.total) * 1000) / 10 : 0,
            present: r.present,
            absent: r.absent,
            late: r.late,
        }));

        res.json({ data, range: days });
    } catch (error) {
        console.error("Dashboard attendance-trend error:", error);
        res.status(500).json({ message: "Failed to load attendance trend" });
    }
});

// GET /api/dashboard/grade-distribution — count of students or personal subjects
// per letter grade. Personal bars count each subject; staff bars count each
// student after averaging published Midterm and Terminal subject averages.
dashboardRouter.get("/grade-distribution", requireAuth, async (req, res) => {
    try {
        const academicYearId = readAcademicYearId(req.query.academicYearId);
        if (academicYearId === null) return res.status(400).json({ message: "Invalid academic year" });
        const stageScope = dashboardStageScope(req.query.stage);
        if (stageScope === null) return res.status(400).json({ message: "Invalid class or form" });
        const schoolScope = dashboardSchoolScope(req.query.schoolLevel, req.user?.role);
        if (schoolScope === null) return res.status(400).json({ message: "Invalid school level" });
        const dashboardClassScope = and(policy.headmasterClassScope(req.user!), academicYearId === undefined ? undefined : eq(classes.academicYearId, academicYearId), schoolScope, stageScope);
        const isTeacher = req.user?.role === "teacher";
        const isStudent = req.user?.role === "student";
        const userId = req.user?.id;
        const contextClassIds = userId && (isTeacher || isStudent)
            ? await activePortalClassIds({ ...req.user!, id: userId })
            : null;
        const contextClassScope = contextClassIds
            ? (contextClassIds.length ? inArray(classes.id, contextClassIds) : sql`false`)
            : undefined;
        if (isStudent && userId) {
            const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
            // A subject is counted once, after averaging its published Midterm
            // and Terminal marks for this portal year. Incomplete pairs are
            // deliberately omitted so the chart never presents a partial-year
            // score as a final subject grade.
            if (!contextClassIds?.length) {
                return res.json({ data: Object.entries(counts).map(([grade, count]) => ({ grade, count })) });
            }
            const resultRows = await db
                .select({ subjectId: termSubjectResults.subjectId, termType: academicTerms.type, score: termSubjectResults.score })
                .from(termSubjectResults)
                .innerJoin(classes, eq(termSubjectResults.classId, classes.id))
                .innerJoin(academicTerms, eq(termSubjectResults.academicTermId, academicTerms.id))
                .where(and(
                    eq(termSubjectResults.studentId, userId),
                    inArray(classes.id, contextClassIds),
                    eq(termSubjectResults.published, true),
                    eq(termSubjectResults.applicable, true),
                    academicYearId === undefined ? undefined : eq(academicTerms.academicYearId, academicYearId),
                ));

            const bySubject = new Map<number, { midterm: number[]; terminal: number[] }>();
            for (const row of resultRows) {
                const results = bySubject.get(row.subjectId) ?? { midterm: [], terminal: [] };
                results[row.termType].push(Number(row.score));
                bySubject.set(row.subjectId, results);
            }
            for (const results of bySubject.values()) {
                if (results.midterm.length === 0 || results.terminal.length === 0) continue;
                const midtermAverage = results.midterm.reduce((sum, score) => sum + score, 0) / results.midterm.length;
                const terminalAverage = results.terminal.reduce((sum, score) => sum + score, 0) / results.terminal.length;
                const subjectAverage = (midtermAverage + terminalAverage) / 2;
                const grade = gradeSecondaryScore(subjectAverage).grade;
                counts[grade] = (counts[grade] ?? 0) + 1;
            }
            return res.json({ data: Object.entries(counts).map(([grade, count]) => ({ grade, count })) });
        }

        const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
        const resultRows = await db
            .select({ studentId: termSubjectResults.studentId, subjectId: termSubjectResults.subjectId, termType: academicTerms.type, score: termSubjectResults.score })
            .from(termSubjectResults)
            .innerJoin(classes, eq(termSubjectResults.classId, classes.id))
            .innerJoin(academicTerms, eq(termSubjectResults.academicTermId, academicTerms.id))
            .where(and(
                eq(termSubjectResults.published, true),
                eq(termSubjectResults.applicable, true),
                eq(academicTerms.academicYearId, classes.academicYearId),
                dashboardClassScope,
                isTeacher && userId ? eq(classes.teacherId, userId) : undefined,
                contextClassScope,
            ));

        // Count each student once: average their applicable subject scores
        // within Midterm and Terminal, then average those two term averages.
        const byStudent = new Map<string, { midterm: Map<number, number[]>; terminal: Map<number, number[]> }>();
        for (const row of resultRows) {
            const results = byStudent.get(row.studentId) ?? { midterm: new Map<number, number[]>(), terminal: new Map<number, number[]>() };
            const bySubject = results[row.termType];
            bySubject.set(row.subjectId, [...(bySubject.get(row.subjectId) ?? []), Number(row.score)]);
            byStudent.set(row.studentId, results);
        }
        for (const results of byStudent.values()) {
            if (results.midterm.size === 0 || results.terminal.size === 0) continue;
            const termAverage = (scoresBySubject: Map<number, number[]>) => {
                const subjectAverages = [...scoresBySubject.values()].map((scores) => scores.reduce((sum, score) => sum + score, 0) / scores.length);
                return subjectAverages.reduce((sum, score) => sum + score, 0) / subjectAverages.length;
            };
            const finalAverage = (termAverage(results.midterm) + termAverage(results.terminal)) / 2;
            const grade = gradeSecondaryScore(finalAverage).grade;
            counts[grade] = (counts[grade] ?? 0) + 1;
        }

        res.json({ data: Object.entries(counts).map(([grade, count]) => ({ grade, count })) });
    } catch (error) {
        console.error("Dashboard grade-distribution error:", error);
        res.status(500).json({ message: "Failed to load grade distribution" });
    }
});

// GET /api/dashboard/subject-performance ? average final grade by subject.
// Teachers only receive subjects from their own classes; administrators receive
// the school-wide view. This powers the subject lists on their dashboards.
dashboardRouter.get("/subject-performance", requireAuth, async (req, res) => {
    try {
        const academicYearId = readAcademicYearId(req.query.academicYearId);
        if (academicYearId === null) return res.status(400).json({ message: "Invalid academic year" });
        const stageScope = dashboardStageScope(req.query.stage);
        if (stageScope === null) return res.status(400).json({ message: "Invalid class or form" });
        const schoolScope = dashboardSchoolScope(req.query.schoolLevel, req.user?.role);
        if (schoolScope === null) return res.status(400).json({ message: "Invalid school level" });
        const dashboardClassScope = and(policy.headmasterClassScope(req.user!), academicYearId === undefined ? undefined : eq(classes.academicYearId, academicYearId), schoolScope, stageScope);
        const isTeacher = req.user?.role === "teacher";
        const userId = req.user?.id;
        const contextClassIds = userId && isTeacher
            ? await activePortalClassIds({ ...req.user!, id: userId })
            : null;
        const contextClassScope = contextClassIds
            ? (contextClassIds.length ? inArray(classes.id, contextClassIds) : sql`false`)
            : undefined;
        const scopeClause = isTeacher && userId
            ? and(eq(classes.teacherId, userId), contextClassScope, dashboardClassScope)
            : dashboardClassScope;

        const rows = await db
            .select({
                subjectId: subjects.id,
                subjectName: subjects.name,
                avgGrade: sql<number | null>`avg(${termSubjectResults.score})`,
                passedCount: sql<number>`count(*) filter (where ${termSubjectResults.score} >= 45)`.mapWith(Number),
                needsAttentionCount: sql<number>`count(*) filter (where ${termSubjectResults.score} < 30)`.mapWith(Number),
                topGradeCount: sql<number>`count(*) filter (where ${termSubjectResults.score} >= 75)`.mapWith(Number),
                failingCount: sql<number>`count(*) filter (where ${termSubjectResults.score} < 30)`.mapWith(Number),
            })
            .from(termSubjectResults)
            .innerJoin(classes, eq(termSubjectResults.classId, classes.id))
            .innerJoin(subjects, eq(classes.subjectId, subjects.id))
            .innerJoin(academicTerms, eq(termSubjectResults.academicTermId, academicTerms.id))
            .where(and(scopeClause, eq(termSubjectResults.published, true), academicYearId === undefined ? undefined : eq(academicTerms.academicYearId, academicYearId)))
            .groupBy(subjects.id, subjects.name);

        res.json({
            data: rows.map((row) => ({
                subjectId: row.subjectId,
                subjectName: row.subjectName,
                avgGrade: row.avgGrade === null ? null : Math.round(Number(row.avgGrade) * 10) / 10,
                passedCount: row.passedCount,
                needsAttentionCount: row.needsAttentionCount,
                topGradeCount: row.topGradeCount,
                failingCount: row.failingCount,
            })),
        });
    } catch (error) {
        console.error("Dashboard subject-performance error:", error);
        res.status(500).json({ message: "Failed to load subject performance" });
    }
});

// GET /api/dashboard/class-activity — per-class assignment/submission/attendance
// volume over the last 30 days, plus average final grade, for the 8
// most-active classes. Scoped to the teacher's own classes for teachers, to
// the student's enrolled classes for students; org-wide for everyone else.
// Powers both the "Class Activity" chart and admin/teacher's top/bottom
// performing classes list — one query set, no duplicated aggregation.
dashboardRouter.get("/class-activity", requireAuth, async (req, res) => {
    try {
        const academicYearId = readAcademicYearId(req.query.academicYearId);
        if (academicYearId === null) return res.status(400).json({ message: "Invalid academic year" });
        const stageScope = dashboardStageScope(req.query.stage);
        if (stageScope === null) return res.status(400).json({ message: "Invalid class or form" });
        const schoolScope = dashboardSchoolScope(req.query.schoolLevel, req.user?.role);
        if (schoolScope === null) return res.status(400).json({ message: "Invalid school level" });
        const dashboardClassScope = and(policy.headmasterClassScope(req.user!), academicYearId === undefined ? undefined : eq(classes.academicYearId, academicYearId), schoolScope, stageScope);
        const isTeacher = req.user?.role === "teacher";
        const isStudent = req.user?.role === "student";
        const userId = req.user?.id;
        const contextClassIds = userId && (isTeacher || isStudent)
            ? await activePortalClassIds({ ...req.user!, id: userId })
            : null;
        const contextClassScope = contextClassIds
            ? (contextClassIds.length ? inArray(classes.id, contextClassIds) : sql`false`)
            : undefined;
        const since = daysAgoISO(30);
        const sinceDate = daysAgo(30);

        let scopeClause;
        if (isTeacher && userId) {
            scopeClause = and(eq(classes.teacherId, userId), contextClassScope, dashboardClassScope);
        } else if (isStudent && userId) {
            const enrolled = await db.select({ classId: enrollments.classId }).from(enrollments).where(eq(enrollments.studentId, userId));
            const classIds = enrolled.map((r) => r.classId);
            if (classIds.length === 0) return res.json({ data: [] });
            scopeClause = and(inArray(classes.id, classIds), contextClassScope, dashboardClassScope);
        } else if (dashboardClassScope) {
            scopeClause = dashboardClassScope;
        }

        const [assignmentCounts, submissionCounts, attendanceCounts, gradeAverages, classRows] = await Promise.all([
            db
                .select({ classId: assignments.classId, total: sql<number>`count(*)`.mapWith(Number) })
                .from(assignments)
                .innerJoin(classes, eq(assignments.classId, classes.id))
                .where(scopeClause ? and(scopeClause, gte(assignments.createdAt, sinceDate)) : gte(assignments.createdAt, sinceDate))
                .groupBy(assignments.classId),
            db
                .select({ classId: assignments.classId, total: sql<number>`count(*)`.mapWith(Number) })
                .from(submissions)
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .innerJoin(classes, eq(assignments.classId, classes.id))
                .where(scopeClause ? and(scopeClause, gte(submissions.submittedAt, sinceDate)) : gte(submissions.submittedAt, sinceDate))
                .groupBy(assignments.classId),
            db
                .select({ classId: attendance.classId, total: sql<number>`count(*)`.mapWith(Number) })
                .from(attendance)
                .innerJoin(classes, eq(attendance.classId, classes.id))
                .where(scopeClause ? and(scopeClause, gte(attendance.date, since)) : gte(attendance.date, since))
                .groupBy(attendance.classId),
            db
                .select({ classId: classGrades.classId, avg: sql<number | null>`avg(${classGrades.finalGrade})` })
                .from(classGrades)
                .innerJoin(classes, eq(classGrades.classId, classes.id))
                .where(scopeClause)
                .groupBy(classGrades.classId),
            db
                .select({ id: classes.id, name: classes.name, subjectName: subjects.name })
                .from(classes)
                .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                .where(scopeClause),
        ]);

        const byId = new Map<number, { classId: number; className: string; subjectName: string | null; assignments: number; submissions: number; attendanceMarks: number; avgGrade: number | null }>();
        for (const c of classRows) byId.set(c.id, { classId: c.id, className: c.name, subjectName: c.subjectName, assignments: 0, submissions: 0, attendanceMarks: 0, avgGrade: null });
        for (const r of assignmentCounts) { const e = byId.get(r.classId); if (e) e.assignments = r.total; }
        for (const r of submissionCounts) { const e = byId.get(r.classId); if (e) e.submissions = r.total; }
        for (const r of attendanceCounts) { const e = byId.get(r.classId); if (e) e.attendanceMarks = r.total; }
        for (const r of gradeAverages) { const e = byId.get(r.classId); if (e) e.avgGrade = r.avg !== null ? Math.round(Number(r.avg) * 10) / 10 : null; }

        const data = Array.from(byId.values())
            .sort((a, b) => (b.assignments + b.submissions + b.attendanceMarks) - (a.assignments + a.submissions + a.attendanceMarks))
            .slice(0, 8);

        res.json({ data });
    } catch (error) {
        console.error("Dashboard class-activity error:", error);
        res.status(500).json({ message: "Failed to load class activity" });
    }
});

export default dashboardRouter;
