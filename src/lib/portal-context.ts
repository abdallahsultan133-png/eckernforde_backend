import { and, desc, eq } from "drizzle-orm";

import { db } from "../db/index.js";
import { academicYears, classes, enrollments, portalContexts } from "../db/schema/app.js";
import type { Caller } from "./policy.js";
import { isStudent, isTeacher } from "./policy.js";
import { academicYearForDate, schoolToday } from "./academic-year.js";

export const PRIMARY_STAGES = ["nursery", "kindergarten", "standard_i", "standard_ii", "standard_iii", "standard_iv", "standard_v", "standard_vi", "standard_vii"] as const;
export const SECONDARY_STAGES = ["form_i", "form_ii", "form_iii", "form_iv"] as const;
export const ALL_STAGES = [...PRIMARY_STAGES, ...SECONDARY_STAGES] as const;
export type PortalStage = typeof ALL_STAGES[number];

export function stageForClass(name: string): PortalStage | null {
  const value = name.trim().toLowerCase().replace(/[.\s-]+/g, "_");
  if (/^nursery(?:_|$)/.test(value)) return "nursery";
  if (/^kindergarten(?:_|$)|^kg(?:_|$)/.test(value)) return "kindergarten";
  const standard = value.match(/^standard_?(i|ii|iii|iv|v|vi|vii)(?:_|$)/);
  if (standard) return `standard_${standard[1]!.toLowerCase()}` as PortalStage;
  const form = value.match(/^form_?(i|ii|iii|iv)(?:_|$)/);
  if (form) return `form_${form[1]!.toLowerCase()}` as PortalStage;
  return null;
}

export function bandForStage(stage: PortalStage) {
  return SECONDARY_STAGES.includes(stage as typeof SECONDARY_STAGES[number]) ? "secondary" : "primary";
}

/** School progression order within a band. A lower number is an earlier class. */
export function stageRank(stage: PortalStage) {
  const stages = bandForStage(stage) === "secondary" ? SECONDARY_STAGES : PRIMARY_STAGES;
  return stages.indexOf(stage as never);
}

/** The full learner journey, including promotion from Standard VII to Form I. */
export function progressionRank(stage: PortalStage) {
  return ALL_STAGES.indexOf(stage);
}

export async function academicYearSnapshot() {
  const years = await db.select().from(academicYears).orderBy(desc(academicYears.startsOn));
  const today = schoolToday();
  // A broad legacy date range must not reopen an inactive year after rollover.
  // An academic year is current only while it is explicitly active and its
  // configured dates contain the school's local date.
  return { years, current: academicYearForDate(years, today), today };
}

export async function currentAcademicYear() {
  return (await academicYearSnapshot()).current;
}

/** Returns class ids in the authenticated user's chosen form/class context.
 * Students remain closed until they complete setup; teachers fall back to
 * their assigned current-year classes while an old or missing context is
 * repaired. Null is reserved for roles that do not use this context. */
export async function activePortalClassIds(caller: Caller & { id: string }) {
  if (!isStudent(caller) && !isTeacher(caller)) return null;
  const year = await currentAcademicYear();
  if (!year) return [];
  const [context] = await db.select({ stage: portalContexts.stage })
    .from(portalContexts)
    .where(and(eq(portalContexts.userId, caller.id), eq(portalContexts.academicYearId, year.id)));

  const classRows = await db.select({ id: classes.id, name: classes.name, teacherId: classes.teacherId, academicYearId: classes.academicYearId })
    .from(classes);
  const eligibleYear = classRows.filter((row) => row.academicYearId === year.id || (row.academicYearId === null && year.name === "Legacy"));
  const teacherRows = eligibleYear.filter((row) => row.teacherId === caller.id);
  if (isTeacher(caller)) {
    // Once a teacher has selected a form/class, it is a hard dashboard and
    // data boundary. An empty selected form must remain empty rather than
    // silently falling back to another class taught in the same year.
    if (!context) return teacherRows.map((row) => row.id);
    return teacherRows.filter((row) => stageForClass(row.name) === context.stage).map((row) => row.id);
  }
  if (!context) return [];
  const stageRows = eligibleYear.filter((row) => stageForClass(row.name) === context.stage);

  const enrolled = await db.select({ classId: enrollments.classId }).from(enrollments).where(eq(enrollments.studentId, caller.id));
  const enrolledIds = new Set(enrolled.map((row) => row.classId));
  return stageRows.filter((row) => enrolledIds.has(row.id)).map((row) => row.id);
}

/** A selected portal context is an additional boundary on top of role access.
 * Administrators and parents are intentionally unaffected. */
export async function isInActivePortalClass(caller: Caller & { id: string }, classId: number) {
  const classIds = await activePortalClassIds(caller);
  return classIds === null || classIds.includes(classId);
}
