import express from "express";
import { randomBytes } from "node:crypto";
import {and, desc, eq, exists, getTableColumns, ilike, inArray, isNull, or, sql} from "drizzle-orm";

import {user, account} from "../db/schema/index.js";
import { classes, enrollments, portalContexts, studentProfiles, subjects } from "../db/schema/app.js";
import { db } from "../db/index.js";
import { auth } from "../lib/auth.js";
import { requireAuth, requireRole, ADMIN_ROLES, STAFF_ROLES } from "../middleware/require-auth.js";
import { validateBody } from "../middleware/validate.js";
import { updateRoleSchema, adminResetPasswordSchema } from "../lib/schemas.js";
import { logAction } from "./audit-logs.js";
import * as policy from "../lib/policy.js";
import { currentAcademicYear, type PortalStage } from "../lib/portal-context.js";

// A readable, unambiguous one-time password: 4 groups of 4 from an alphabet with
// no look-alike characters (no 0/O, 1/l/I). ~20 chars, always well over the
// 8-char minimum. Used only for the admin "temporary password" reset path.
function generateTemporaryPassword(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const bytes = randomBytes(16);
    let out = "";
    for (let i = 0; i < 16; i++) {
        out += alphabet[bytes[i]! % alphabet.length];
        if (i % 4 === 3 && i < 15) out += "-";
    }
    return out;
}

const router = express.Router();

// GET /api/users/teachers — any authenticated user can fetch the teacher list
// (used in class creation dropdowns). Returns only id + name, no PII.
router.get("/teachers", requireAuth, async (req, res) => {
    try {
        const requestedLevel = req.query.schoolLevel === undefined ? undefined : String(req.query.schoolLevel);
        if (requestedLevel !== undefined && !["primary", "secondary"].includes(requestedLevel)) {
            return res.status(400).json({ error: "Invalid school level" });
        }
        const headmasterLevel = policy.headmasterSchoolLevel(req.user!);
        if (headmasterLevel && requestedLevel && requestedLevel !== headmasterLevel) {
            return policy.forbidden(res, "You can only view teachers in your school level.");
        }
        const schoolLevel = headmasterLevel ?? requestedLevel;
        const conditions = [eq(user.role, "teacher")];
        if (req.query.search) {
            const search = String(req.query.search);
            conditions.push(or(ilike(user.name, `%${search}%`), ilike(user.email, `%${search}%`))!);
        }
        const teachers = await db
            .select({ id: user.id, name: user.name })
            .from(user)
            .where(and(
                ...conditions,
                schoolLevel
                    ? exists(db.select({ id: classes.id }).from(classes).where(and(eq(classes.teacherId, user.id), eq(classes.schoolLevel, schoolLevel as "primary" | "secondary"))))
                    : undefined,
            ))
            .orderBy(user.name);

        res.json({
            data: teachers,
            pagination: { page: 1, limit: teachers.length, total: teachers.length, totalPages: 1 }
        });
    } catch (e) {
        console.error("GET /users/teachers error:", e);
        res.status(500).json({ error: "Failed to get teachers" });
    }
});

// GET /api/users/students?search= — teacher/admin/super_admin only (exposes
// every student's email, so it can't be open to students/parents). Used by
// the class enrollment picker to browse/search the full student directory
// instead of requiring an exact email lookup per student.
router.get("/students", requireAuth, requireRole(...STAFF_ROLES), async (req, res) => {
    try {
        const { search, classId: rawClassId, stage: rawStage, academicYearId: rawAcademicYearId } = req.query;
        const requestedLevel = req.query.schoolLevel === undefined ? undefined : String(req.query.schoolLevel);
        if (requestedLevel !== undefined && !["primary", "secondary"].includes(requestedLevel)) return res.status(400).json({ error: "Invalid school level" });

        const conditions = [eq(user.role, "student")];
        const headmasterLevel = policy.headmasterSchoolLevel(req.user!);
        const schoolLevel = (headmasterLevel ?? (req.user!.role === "super_admin" ? requestedLevel : undefined)) as "primary" | "secondary" | undefined;
        const selectedStage = rawStage ? String(rawStage) as PortalStage : null;
        if (schoolLevel && rawStage) {
            const yearId = rawAcademicYearId === undefined
                ? (await currentAcademicYear())?.id
                : Number(rawAcademicYearId);
            if (!selectedStage || !Number.isFinite(yearId)) return res.status(400).json({ error: "Choose a valid form or class." });
            const stagePrefix = selectedStage.replaceAll("_", " ");
            const compactPrefix = selectedStage.replaceAll("_", "");
            const classPrefix = selectedStage.startsWith("standard_") ? selectedStage.replace("standard_", "class ") : null;
            const kgPrefix = selectedStage.startsWith("kindergarten_") ? selectedStage.replace("kindergarten_", "kg ") : null;
            const contextMatch = exists(db.select({ id: portalContexts.id }).from(portalContexts).where(and(
                    eq(portalContexts.userId, user.id),
                    eq(portalContexts.academicYearId, yearId!),
                    eq(portalContexts.schoolBand, schoolLevel),
                    eq(portalContexts.stage, selectedStage),
                )));
            const enrollmentMatch = exists(db.select({ id: enrollments.studentId }).from(enrollments)
                    .innerJoin(classes, eq(enrollments.classId, classes.id))
                    .where(and(
                        eq(enrollments.studentId, user.id),
                        schoolLevel === "primary" ? inArray(classes.schoolLevel, ["nursery", "primary"]) : eq(classes.schoolLevel, "secondary"),
                        eq(classes.academicYearId, yearId!),
                        or(
                            ilike(classes.name, `${stagePrefix}%`),
                            ilike(classes.name, `${compactPrefix}%`),
                            ilike(classes.name, `${stagePrefix.replaceAll(" ", "_")}%`),
                            ...(classPrefix ? [ilike(classes.name, `${classPrefix}%`)] : []),
                            ...(kgPrefix ? [ilike(classes.name, `${kgPrefix}%`), ilike(classes.name, `${kgPrefix.replace(" ", "_")}%`)] : []),
                        ),
                    )));
            conditions.push(or(contextMatch, enrollmentMatch)!);
        }
        if (schoolLevel && rawClassId === undefined && rawStage === undefined) {
            conditions.push(exists(
                db.select({ id: enrollments.studentId })
                    .from(enrollments)
                    .innerJoin(classes, eq(enrollments.classId, classes.id))
                    .where(and(eq(enrollments.studentId, user.id), schoolLevel === "primary" ? inArray(classes.schoolLevel, ["nursery", "primary"]) : eq(classes.schoolLevel, "secondary")))
            ));
        }
        if (policy.isTeacher(req.user!) && rawClassId !== undefined) {
            const classId = Number(rawClassId);
            if (!Number.isInteger(classId) || classId <= 0 || !(await policy.canManageClass(req.user!, classId))) {
                return policy.forbidden(res, "Teachers can only browse students in a class they teach.");
            }
            const [targetClass] = await db
                .select({ academicYearId: classes.academicYearId })
                .from(classes)
                .where(eq(classes.id, classId));
            if (!targetClass) return res.status(404).json({ error: "Class not found." });

            // The teacher already passed the ownership check for the target
            // class. Keep every student account available here so a newly
            // created student with no existing enrollment can be added.
        }
        if (search) {
            conditions.push(
                or(
                    ilike(user.name, `%${search}%`),
                    ilike(user.email, `%${search}%`)
                )!
            );
        }

        const page = Math.max(1, parseInt(String(req.query.page ?? 1), 10) || 1);
        const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? 500), 10) || 500, 1), 500);
        const offset = (page - 1) * limit;
        const [students, totalRows] = await Promise.all([db
            .select({ id: user.id, name: user.name, email: user.email, image: user.image, role: user.role })
            .from(user)
            .where(and(...conditions))
            .orderBy(user.name)
            .limit(limit)
            .offset(offset),
            db.select({ count: sql<number>`count(*)` }).from(user).where(and(...conditions)),
        ]);
        const total = Number(totalRows[0]?.count ?? 0);

        res.json({ data: students, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    } catch (e) {
        console.error("GET /users/students error:", e);
        res.status(500).json({ error: "Failed to get students" });
    }
});

// GET /api/users/lookup?email= — any authenticated user can resolve a single
// exact-email match to start a conversation with them. Unlike GET / (below),
// this doesn't allow browsing/searching the directory: it requires an exact
// email match and returns only the minimal fields needed to address a message.
router.get("/lookup", requireAuth, async (req, res) => {
    try {
        const email = String(req.query.email ?? "").trim().toLowerCase();
        if (!email) return res.status(400).json({ error: "email is required" });

        const [found] = await db
            .select({ id: user.id, name: user.name, email: user.email, image: user.image, role: user.role })
            .from(user)
            .where(eq(user.email, email));

        if (!found) return res.status(404).json({ error: "No user found with that email." });
        res.json({ data: found });
    } catch (e) {
        console.error("GET /users/lookup error:", e);
        res.status(500).json({ error: "Failed to look up user" });
    }
});

// Get all users with optional search, filtering and pagination
// Admin-only: this returns every user's email, so it must not be open to students/teachers.
router.get("/", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    try {
        const { search, role, schoolLevel: requestedLevelRaw, academicYearId: requestedAcademicYearIdRaw, stage: requestedStageRaw, page = 1, limit = 10 } = req.query;

        const currentPage = Math.max(1, parseInt(String(page), 10) || 1);
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100); // Max 100 records per page

        const offset = (currentPage - 1) * limitPerPage;

        const filterConditions = [];
        const headmasterLevel = policy.headmasterSchoolLevel(req.user!);
        if (req.user!.role === "super_admin" && requestedLevelRaw !== undefined) {
            const requestedLevel = String(requestedLevelRaw);
            if (!["primary", "secondary"].includes(requestedLevel)) return res.status(400).json({ error: "Invalid school level" });
            if (role === "teacher") {
                const requestedAcademicYearId = requestedAcademicYearIdRaw === undefined ? null : Number(requestedAcademicYearIdRaw);
                if (requestedAcademicYearId !== null && (!Number.isInteger(requestedAcademicYearId) || requestedAcademicYearId <= 0)) {
                    return res.status(400).json({ error: "Invalid academic year" });
                }
                const selectedStage = requestedStageRaw === undefined ? null : String(requestedStageRaw).trim().toLowerCase();
                const stageParts = selectedStage?.split("_") ?? [];
                const roman = stageParts.at(-1);
                const patterns = selectedStage === null
                    ? []
                    : selectedStage === "nursery"
                        ? ["nursery%"]
                        : selectedStage.startsWith("kindergarten_") && roman
                            ? [`kg ${roman}%`, `kg_${roman}%`, `kindergarten ${roman}%`, `kindergarten_${roman}%`]
                            : selectedStage.startsWith("standard_") && roman
                                ? [`standard ${roman}%`, `standard_${roman}%`, `class ${roman}%`, `class_${roman}%`]
                                : selectedStage.startsWith("form_") && roman
                                    ? [`form ${roman}%`, `form_${roman}%`]
                                    : [];
                if (selectedStage !== null && patterns.length === 0) return res.status(400).json({ error: "Invalid class stage" });
                filterConditions.push(exists(db.select({ id: classes.id }).from(classes).where(and(
                    eq(classes.teacherId, user.id),
                    requestedLevel === "primary" ? inArray(classes.schoolLevel, ["nursery", "primary"]) : eq(classes.schoolLevel, "secondary"),
                    requestedAcademicYearId === null ? undefined : eq(classes.academicYearId, requestedAcademicYearId),
                    selectedStage === null ? undefined : or(...patterns.map((pattern) => ilike(classes.name, pattern)))!,
                ))));
            } else if (role === "parent") {
                const requestedAcademicYearId = requestedAcademicYearIdRaw === undefined ? null : Number(requestedAcademicYearIdRaw);
                if (requestedAcademicYearId !== null && (!Number.isInteger(requestedAcademicYearId) || requestedAcademicYearId <= 0)) {
                    return res.status(400).json({ error: "Invalid academic year" });
                }
                const selectedStage = requestedStageRaw === undefined ? null : String(requestedStageRaw).trim().toLowerCase();
                const stageParts = selectedStage?.split("_") ?? [];
                const roman = stageParts.at(-1);
                const patterns = selectedStage === null
                    ? []
                    : selectedStage === "nursery"
                        ? ["nursery%"]
                        : selectedStage.startsWith("kindergarten_") && roman
                            ? [`kg ${roman}%`, `kg_${roman}%`, `kindergarten ${roman}%`, `kindergarten_${roman}%`]
                            : selectedStage.startsWith("standard_") && roman
                                ? [`standard ${roman}%`, `standard_${roman}%`, `class ${roman}%`, `class_${roman}%`]
                                : selectedStage.startsWith("form_") && roman
                                    ? [`form ${roman}%`, `form_${roman}%`]
                                    : [];
                if (selectedStage !== null && patterns.length === 0) return res.status(400).json({ error: "Invalid class stage" });
                const parentStudentLink = or(eq(studentProfiles.parentUserId, user.id), and(isNull(studentProfiles.parentUserId), sql`lower(${studentProfiles.parentEmail}) = lower(${user.email})`));
                const parentSchoolScope = requestedLevel === "primary"
                    ? inArray(classes.schoolLevel, ["nursery", "primary"])
                    : eq(classes.schoolLevel, "secondary");
                filterConditions.push(exists(db.select({ id: studentProfiles.userId }).from(studentProfiles).innerJoin(enrollments, eq(enrollments.studentId, studentProfiles.userId)).innerJoin(classes, eq(enrollments.classId, classes.id)).where(and(
                    parentStudentLink,
                    parentSchoolScope,
                    requestedAcademicYearId === null ? undefined : eq(classes.academicYearId, requestedAcademicYearId),
                    selectedStage === null ? undefined : or(...patterns.map((pattern) => ilike(classes.name, pattern)))!,
                ))));
            } else if (role === "student") {
                filterConditions.push(exists(db.select({ id: enrollments.studentId }).from(enrollments).innerJoin(classes, eq(enrollments.classId, classes.id)).where(and(eq(enrollments.studentId, user.id), eq(classes.schoolLevel, requestedLevel as "primary" | "secondary")))));
            }
        }
        if (headmasterLevel) {
            const parentStudentLink = or(
                eq(studentProfiles.parentUserId, user.id),
                and(isNull(studentProfiles.parentUserId), sql`lower(${studentProfiles.parentEmail}) = lower(${user.email})`),
            );
            const headmasterClassLevel = headmasterLevel === "secondary"
                ? or(eq(classes.schoolLevel, headmasterLevel), ilike(classes.name, "form%"))
                : or(
                    eq(classes.schoolLevel, headmasterLevel),
                    ilike(classes.name, "nursery%"),
                    ilike(classes.name, "kg%"),
                    ilike(classes.name, "kindergarten%"),
                    ilike(classes.name, "class%"),
                    ilike(classes.name, "standard%"),
                );
            filterConditions.push(or(
                eq(user.id, req.user!.id!),
                exists(db.select({ id: classes.id }).from(classes).where(and(eq(classes.teacherId, user.id), headmasterClassLevel))),
                exists(db.select({ id: enrollments.studentId }).from(enrollments).innerJoin(classes, eq(enrollments.classId, classes.id)).where(and(eq(enrollments.studentId, user.id), headmasterClassLevel))),
                exists(db.select({ id: studentProfiles.userId }).from(studentProfiles).innerJoin(enrollments, eq(enrollments.studentId, studentProfiles.userId)).innerJoin(classes, eq(enrollments.classId, classes.id)).where(and(parentStudentLink, headmasterClassLevel)))
            ));
            if (role === "teacher" && (requestedAcademicYearIdRaw !== undefined || requestedStageRaw !== undefined)) {
                const requestedAcademicYearId = requestedAcademicYearIdRaw === undefined ? null : Number(requestedAcademicYearIdRaw);
                if (requestedAcademicYearId !== null && (!Number.isInteger(requestedAcademicYearId) || requestedAcademicYearId <= 0)) {
                    return res.status(400).json({ error: "Invalid academic year" });
                }
                const selectedStage = requestedStageRaw === undefined ? null : String(requestedStageRaw).trim().toLowerCase();
                const stageParts = selectedStage?.split("_") ?? [];
                const roman = stageParts.at(-1);
                const patterns = selectedStage === null
                    ? []
                    : selectedStage === "nursery"
                        ? ["nursery%"]
                        : selectedStage.startsWith("kindergarten_") && roman
                            ? [`kg ${roman}%`, `kg_${roman}%`, `kindergarten ${roman}%`, `kindergarten_${roman}%`]
                            : selectedStage.startsWith("standard_") && roman
                                ? [`standard ${roman}%`, `standard_${roman}%`, `class ${roman}%`, `class_${roman}%`]
                                : selectedStage.startsWith("form_") && roman
                                    ? [`form ${roman}%`, `form_${roman}%`]
                                    : [];
                if (selectedStage !== null && patterns.length === 0) return res.status(400).json({ error: "Invalid class stage" });
                filterConditions.push(exists(db.select({ id: classes.id }).from(classes).where(and(
                    eq(classes.teacherId, user.id),
                    headmasterLevel === "primary" ? inArray(classes.schoolLevel, ["nursery", "primary"]) : eq(classes.schoolLevel, "secondary"),
                    requestedAcademicYearId === null ? undefined : eq(classes.academicYearId, requestedAcademicYearId),
                    selectedStage === null ? undefined : or(...patterns.map((pattern) => ilike(classes.name, pattern)))!,
                ))));
            }
            if (role && ["primary_headmaster", "secondary_headmaster", "super_admin"].includes(String(role))) {
                return res.json({ data: [], pagination: { page: currentPage, limit: limitPerPage, total: 0, totalPages: 0 } });
            }
        }

        // If search query exists, filter by user name OR user email
        if (search) {
            filterConditions.push(
                or(
                    ilike(user.name, `%${search}%`),
                    ilike(user.email, `%${search}%`)
                )
            );
        }

        // If role filter exists, match exact role
        if (role) {
            filterConditions.push(eq(user.role, role as any));
        }

        // Combine all filters using AND if any exist
        const whereClause = filterConditions.length > 0 ? and(...filterConditions) : undefined;

        const [countResult, usersList] = await Promise.all([
            db
                .select({ count: sql<number>`count(*)`})
                .from(user)
                .where(whereClause),
            db
                .select({
                    ...getTableColumns(user),
                }).from(user)
                .where(whereClause)
                .orderBy(desc(user.createdAt))
                .limit(limitPerPage)
                .offset(offset),
        ]);

        const totalCount = countResult[0]?.count ?? 0;

        const childrenByParent = new Map<string, Array<{ id: string; name: string; classes: string[] }>>();
        const teachingAssignmentsByTeacher = new Map<string, Array<{ classId: number; className: string; subjectId: number; subjectName: string }>>();
        if (role === "teacher" && usersList.length > 0) {
            const teacherIds = usersList.filter((row) => row.role === "teacher").map((row) => row.id);
            if (teacherIds.length > 0) {
                const hasRequestedTeacherScope = requestedAcademicYearIdRaw !== undefined && (req.user!.role === "super_admin" || Boolean(headmasterLevel));
                const activeYear = hasRequestedTeacherScope
                    ? { id: Number(requestedAcademicYearIdRaw) }
                    : await currentAcademicYear();
                const assignmentLevel = headmasterLevel ?? (req.user!.role === "super_admin" && requestedLevelRaw !== undefined
                    ? String(requestedLevelRaw)
                    : null);
                const selectedStage = (req.user!.role === "super_admin" || Boolean(headmasterLevel)) && requestedStageRaw !== undefined
                    ? String(requestedStageRaw).trim().toLowerCase()
                    : null;
                const stageParts = selectedStage?.split("_") ?? [];
                const roman = stageParts.at(-1);
                const stagePatterns = selectedStage === null
                    ? []
                    : selectedStage === "nursery"
                        ? ["nursery%"]
                        : selectedStage.startsWith("kindergarten_") && roman
                            ? [`kg ${roman}%`, `kg_${roman}%`, `kindergarten ${roman}%`, `kindergarten_${roman}%`]
                            : selectedStage.startsWith("standard_") && roman
                                ? [`standard ${roman}%`, `standard_${roman}%`, `class ${roman}%`, `class_${roman}%`]
                                : selectedStage.startsWith("form_") && roman
                                    ? [`form ${roman}%`]
                                    : [];
                const assignments = activeYear?.id
                    ? await db.select({
                        teacherId: classes.teacherId,
                        classId: classes.id,
                        className: classes.name,
                        subjectId: subjects.id,
                        subjectName: subjects.name,
                    }).from(classes)
                        .innerJoin(subjects, eq(classes.subjectId, subjects.id))
                        .where(and(
                            inArray(classes.teacherId, teacherIds),
                            eq(classes.academicYearId, activeYear.id),
                            assignmentLevel === "primary"
                                ? inArray(classes.schoolLevel, ["nursery", "primary"])
                                : assignmentLevel === "secondary" ? eq(classes.schoolLevel, "secondary") : undefined,
                            selectedStage && stagePatterns.length > 0 ? or(...stagePatterns.map((pattern) => ilike(classes.name, pattern))) : undefined,
                        ))
                        .orderBy(classes.name, subjects.name)
                    : [];
                for (const assignment of assignments) {
                    teachingAssignmentsByTeacher.set(assignment.teacherId, [
                        ...(teachingAssignmentsByTeacher.get(assignment.teacherId) ?? []),
                        { classId: assignment.classId, className: assignment.className, subjectId: assignment.subjectId, subjectName: assignment.subjectName },
                    ]);
                }
            }
        }
        if (role === "parent") {
            const parents = usersList.filter((row) => row.role === "parent");
            if (parents.length > 0) {
                const parentIds = parents.map((row) => row.id);
                const parentIdByEmail = new Map(parents.map((row) => [row.email.toLowerCase(), row.id]));
                const profiles = await db.select({
                    childId: studentProfiles.userId,
                    parentUserId: studentProfiles.parentUserId,
                    parentEmail: studentProfiles.parentEmail,
                    childName: user.name,
                }).from(studentProfiles)
                    .innerJoin(user, eq(studentProfiles.userId, user.id))
                    .where(or(
                        inArray(studentProfiles.parentUserId, parentIds),
                        and(
                            isNull(studentProfiles.parentUserId),
                            inArray(sql<string>`lower(${studentProfiles.parentEmail})`, [...parentIdByEmail.keys()]),
                        ),
                    ));

                if (profiles.length > 0) {
                    const childIds = [...new Set(profiles.map((profile) => profile.childId))];
                    const scopedLevel = headmasterLevel ?? (req.user!.role === "super_admin" && requestedLevelRaw !== undefined ? String(requestedLevelRaw) : null);
                    const scopedAcademicYearId = req.user!.role === "super_admin" && requestedAcademicYearIdRaw !== undefined ? Number(requestedAcademicYearIdRaw) : null;
                    const scopedStage = req.user!.role === "super_admin" && requestedStageRaw !== undefined ? String(requestedStageRaw).trim().toLowerCase() : null;
                    const scopedStageParts = scopedStage?.split("_") ?? [];
                    const scopedRoman = scopedStageParts.at(-1);
                    const scopedStagePatterns = scopedStage === null
                        ? []
                        : scopedStage === "nursery"
                            ? ["nursery%"]
                            : scopedStage.startsWith("kindergarten_") && scopedRoman
                                ? [`kg ${scopedRoman}%`, `kg_${scopedRoman}%`, `kindergarten ${scopedRoman}%`, `kindergarten_${scopedRoman}%`]
                                : scopedStage.startsWith("standard_") && scopedRoman
                                    ? [`standard ${scopedRoman}%`, `standard_${scopedRoman}%`, `class ${scopedRoman}%`, `class_${scopedRoman}%`]
                                    : scopedStage.startsWith("form_") && scopedRoman
                                        ? [`form ${scopedRoman}%`, `form_${scopedRoman}%`]
                                        : [];
                    const schoolScope = scopedLevel === "secondary"
                        ? or(eq(classes.schoolLevel, "secondary"), and(isNull(classes.schoolLevel), ilike(classes.name, "form%")))
                        : scopedLevel === "primary"
                            ? or(
                                inArray(classes.schoolLevel, ["nursery", "primary"]),
                                and(isNull(classes.schoolLevel), or(
                                    ilike(classes.name, "nursery%"), ilike(classes.name, "kg%"),
                                    ilike(classes.name, "kindergarten%"), ilike(classes.name, "class%"),
                                    ilike(classes.name, "standard%"),
                                )),
                            )
                            : undefined;
                    const [year, classRows] = await Promise.all([
                        scopedAcademicYearId === null ? currentAcademicYear() : Promise.resolve(null),
                        db.select({ childId: enrollments.studentId, name: classes.name, academicYearId: classes.academicYearId })
                            .from(enrollments)
                            .innerJoin(classes, eq(enrollments.classId, classes.id))
                            .where(and(
                                inArray(enrollments.studentId, childIds),
                                schoolScope,
                                scopedAcademicYearId === null ? undefined : eq(classes.academicYearId, scopedAcademicYearId),
                                scopedStage === null ? undefined : or(...scopedStagePatterns.map((pattern) => ilike(classes.name, pattern)))!,
                            )),
                    ]);
                    const classesByChild = new Map<string, typeof classRows>();
                    for (const row of classRows) {
                        const entries = classesByChild.get(row.childId) ?? [];
                        entries.push(row);
                        classesByChild.set(row.childId, entries);
                    }
                    for (const profile of profiles) {
                        const parentId = profile.parentUserId ?? parentIdByEmail.get(profile.parentEmail?.toLowerCase() ?? "");
                        if (!parentId) continue;
                        const enrolled = classesByChild.get(profile.childId) ?? [];
                        if (scopedLevel && enrolled.length === 0) continue;
                        const currentClasses = scopedAcademicYearId !== null
                            ? enrolled
                            : year
                                ? enrolled.filter((row) => row.academicYearId === year.id || (year.name === "Legacy" && row.academicYearId === null))
                                : [];
                        const child = { id: profile.childId, name: profile.childName, classes: [...new Set(currentClasses.map((row) => row.name))].sort() };
                        childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), child]);
                    }
                }
            }
        }

        res.status(200).json({
            data: role === "parent"
                ? usersList.map((row) => row.role === "parent" ? { ...row, children: (childrenByParent.get(row.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)) } : row)
                : role === "teacher"
                    ? usersList.map((row) => row.role === "teacher" ? { ...row, teachingAssignments: teachingAssignmentsByTeacher.get(row.id) ?? [] } : row)
                    : usersList,
            pagination: {
                page: currentPage,
                limit: limitPerPage,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limitPerPage),
            }
        })

    } catch (e) {
        console.error(`GET /users error: ${e}`);
        res.status(500).json({ error: 'Failed to get users' });
    }
})

// PATCH /api/users/:id/role — admin/super_admin only. Promotes/demotes a user's role.
// This exists specifically because sign-up can no longer set role directly (see lib/auth.ts).
router.patch("/:id/role", requireAuth, requireRole(...ADMIN_ROLES), validateBody(updateRoleSchema), async (req, res) => {
    try {
        const id = String(req.params.id ?? "");
        if (!id) return res.status(400).json({ error: "user id is required" });

        const { role } = req.body as { role: UserRoles };

        // Only a super_admin can create/demote other super_admins or admins.
        if (!policy.canGrantRole(req.user!, role)) {
            return policy.forbidden(res, "Only a super_admin can grant headmaster-level roles.");
        }

        if (req.user!.role !== "super_admin") {
            const [target] = await db.select({ id: user.id, role: user.role }).from(user).where(eq(user.id, id));
            if (!target) return res.status(404).json({ error: "User not found" });
            if (!(await policy.canManageUser(req.user!, target))) {
                return policy.forbidden(res, "You can only manage accounts belonging to your school.");
            }
        }

        const [updated] = await db
            .update(user)
            .set({ role })
            .where(eq(user.id, id))
            .returning({ id: user.id, name: user.name, email: user.email, role: user.role });

        if (!updated) return res.status(404).json({ error: "User not found" });

        await logAction({ req, action: "user.role_change", resource: "users", resourceId: id, details: `Role changed to "${role}"` });

        res.status(200).json({ data: updated });
    } catch (e) {
        console.error("PATCH /users/:id/role error:", e);
        res.status(500).json({ error: "Failed to update role" });
    }
});

// POST /api/users/:id/reset-password — admin/super_admin only. Lets staff help a
// user who is locked out. Two modes (see adminResetPasswordSchema):
//   • "email"     — send the user the same reset link /forgot-password sends.
//   • "temporary" — set a generated one-time password, returned ONCE in the
//                   response for the admin to relay; all of that user's existing
//                   sessions are revoked so the old password stops working.
// A plain admin cannot reset an admin-level account, and nobody can target
// themselves (policy.canResetPasswordFor). The password is never logged.
router.post("/:id/reset-password", requireAuth, requireRole(...ADMIN_ROLES), validateBody(adminResetPasswordSchema), async (req, res) => {
    try {
        const id = String(req.params.id ?? "");
        if (!id) return res.status(400).json({ error: "user id is required" });

        const [target] = await db
            .select({ id: user.id, name: user.name, email: user.email, role: user.role })
            .from(user)
            .where(eq(user.id, id));

        if (!target) return res.status(404).json({ error: "User not found" });

        if (!policy.canResetPasswordFor(req.user!, target)) {
            return policy.forbidden(res, "You don't have permission to reset this account's password.");
        }
        if (!(await policy.canManageUser(req.user!, target))) {
            return policy.forbidden(res, "You can only manage accounts belonging to your school.");
        }

        const { mode } = req.body as { mode: "email" | "temporary" };

        if (mode === "email") {
            await auth.api.requestPasswordReset({
                body: {
                    email: target.email,
                    redirectTo: `${process.env.FRONTEND_URL}/reset-password`,
                },
            });
            await logAction({ req, action: "user.password_reset", resource: "users", resourceId: id, details: "Sent a reset link by email" });
            return res.status(200).json({ data: { mode: "email", email: target.email } });
        }

        // mode === "temporary"
        const ctx = await auth.$context;
        const temporaryPassword = generateTemporaryPassword();
        const hash = await ctx.password.hash(temporaryPassword);

        // Better Auth keeps the email/password credential in `account` with
        // providerId "credential". A Google-only user has no such row yet.
        const [cred] = await db
            .select({ id: account.id })
            .from(account)
            .where(and(eq(account.userId, id), eq(account.providerId, "credential")));

        if (cred) {
            await db
                .update(account)
                .set({ password: hash, updatedAt: new Date() })
                .where(eq(account.id, cred.id));
        } else {
            await db.insert(account).values({
                id: randomBytes(16).toString("hex"),
                accountId: id,
                providerId: "credential",
                userId: id,
                password: hash,
            });
        }

        // Invalidate every active session so the old password is truly dead.
        await ctx.internalAdapter.deleteUserSessions(id);

        await logAction({ req, action: "user.password_reset", resource: "users", resourceId: id, details: "Set a temporary password" });
        return res.status(200).json({ data: { mode: "temporary", email: target.email, temporaryPassword } });
    } catch (e) {
        console.error("POST /users/:id/reset-password error:", e);
        res.status(500).json({ error: "Failed to reset password" });
    }
});

// DELETE /api/users/:id — admin/super_admin only. Permanently removes the row
// from the `user` table; Postgres cascades take out the dependent auth rows
// (session, account) and the student-owned records (enrollments, submissions,
// grades, attendance, exam results, messages, notifications, files, profile),
// while author/grader references are nulled (see the FK onDelete rules in
// db/schema/app.ts).
//
// If the target still owns *restricted* records — classes they teach,
// assignments / announcements / exams / calendar events they created,
// attendance they marked, files they uploaded — Postgres refuses the delete
// (FK violation, SQLSTATE 23503) and we return 409 so the admin knows to
// reassign or remove those first rather than getting a generic 500.
router.delete("/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
    try {
        const id = String(req.params.id ?? "");
        if (!id) return res.status(400).json({ error: "user id is required" });

        if (id === req.user!.id) {
            return res.status(400).json({ error: "You can't delete your own account." });
        }

        const [target] = await db
            .select({ id: user.id, name: user.name, email: user.email, role: user.role })
            .from(user)
            .where(eq(user.id, id));

        if (!target) return res.status(404).json({ error: "User not found" });

        if (!policy.canDeleteUser(req.user!, target)) {
            return policy.forbidden(res, "You don't have permission to delete this account.");
        }
        if (!(await policy.canManageUser(req.user!, target))) {
            return policy.forbidden(res, "You can only manage accounts belonging to your school.");
        }

        try {
            const [deleted] = await db
                .delete(user)
                .where(eq(user.id, id))
                .returning({ id: user.id });

            if (!deleted) return res.status(404).json({ error: "User not found" });
        } catch (err: any) {
            if (err?.code === "23503") {
                return res.status(409).json({
                    error:
                        "This account still owns records that can't be auto-removed — classes they teach, " +
                        "homework, announcements, exams or calendar events they created, attendance they " +
                        "marked, or files they uploaded. Reassign or delete those first, then try again.",
                });
            }
            throw err;
        }

        await logAction({
            req,
            action: "user.delete",
            resource: "users",
            resourceId: id,
            details: `Deleted ${target.name} <${target.email}> (was ${target.role})`,
        });

        res.status(200).json({ data: { id } });
    } catch (e) {
        console.error("DELETE /users/:id error:", e);
        res.status(500).json({ error: "Failed to delete user" });
    }
});

export default router;
