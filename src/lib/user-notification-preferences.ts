import { and, eq, inArray, or, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { enrollments, studentProfiles } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";

export type NotificationChannel = "inApp" | "email";

/** Missing preference values default to enabled for existing and newly created accounts. */
export function notificationChannelEnabled(preferences: { inApp?: boolean; email?: boolean } | null | undefined, channel: NotificationChannel) {
    return preferences?.[channel] !== false;
}

/** Return only recipients who have enabled the requested notification channel. */
export async function filterNotificationRecipients(userIds: string[], channel: NotificationChannel) {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return [];
    const recipients = await db.select({ id: user.id, preferences: user.notificationPreferences })
        .from(user)
        .where(inArray(user.id, ids));
    return recipients.filter((recipient) => notificationChannelEnabled(recipient.preferences, channel)).map((recipient) => recipient.id);
}

/** Student and linked parent accounts that should receive class updates. */
export async function classNotificationRecipients(classId: number) {
    const students = await db.select({ id: user.id, email: user.email })
        .from(enrollments)
        .innerJoin(user, eq(enrollments.studentId, user.id))
        .where(eq(enrollments.classId, classId));
    if (students.length === 0) return students;

    const profiles = await db.select({ parentUserId: studentProfiles.parentUserId, parentEmail: studentProfiles.parentEmail })
        .from(studentProfiles)
        .where(inArray(studentProfiles.userId, students.map((student) => student.id)));
    const parentIds = [...new Set(profiles.flatMap((profile) => profile.parentUserId ? [profile.parentUserId] : []))];
    const parentEmails = [...new Set(profiles.flatMap((profile) => profile.parentEmail ? [profile.parentEmail.trim().toLowerCase()] : []))];
    const parentConditions = [
        parentIds.length ? inArray(user.id, parentIds) : undefined,
        parentEmails.length ? inArray(sql<string>`lower(${user.email})`, parentEmails) : undefined,
    ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
    const parents = parentConditions.length
        ? await db.select({ id: user.id, email: user.email }).from(user).where(and(eq(user.role, "parent"), or(...parentConditions)))
        : [];
    const byId = new Map([...students, ...parents].map((recipient) => [recipient.id, recipient]));
    return [...byId.values()];
}
