import { z } from "zod";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

// ─── CLASSES ────────────────────────────────────────────────────────────────
export const createClassSchema = z.object({
    name: z.string().trim().min(1, "name is required").max(255),
    subjectId: z.number().int().positive(),
    teacherId: z.string().min(1, "teacherId is required"),
    description: z.string().max(5000).optional().nullable(),
    capacity: z.number().int().positive().max(1000).optional(),
    bannerUrl: z.string().optional().nullable(),
    bannerCldPubId: z.string().optional().nullable(),
    status: z.enum(["active", "inactive", "archived"]).optional(),
    schoolLevel: z.enum(["nursery", "primary", "secondary"]).optional().nullable(),
});
export const updateClassSchema = createClassSchema.partial();

export const joinClassSchema = z.object({
    inviteCode: z.string().trim().min(1, "inviteCode is required").max(64),
});

export const enrollSchema = z
    .object({
        studentId: z.string().min(1).optional(),
        email: z.string().email().optional(),
    })
    .refine((d) => !!d.studentId || !!d.email, { message: "Provide studentId or email." });

// ─── SUBJECTS / DEPARTMENTS ──────────────────────────────────────────────────
export const createSubjectSchema = z.object({
    name: z.string().trim().min(1, "name is required").max(255),
    code: z.string().trim().min(1, "code is required").max(50),
    description: z.string().max(255).optional().nullable(),
    departmentId: z.number().int().positive(),
});
export const updateSubjectSchema = createSubjectSchema.partial();

export const createDepartmentSchema = z.object({
    name: z.string().trim().min(1, "name is required").max(255),
    code: z.string().trim().min(1, "code is required").max(50),
    description: z.string().max(255).optional().nullable(),
});
export const updateDepartmentSchema = createDepartmentSchema.partial();

// ─── ATTENDANCE ───────────────────────────────────────────────────────────────
export const markAttendanceSchema = z.object({
    classId: z.number().int().positive(),
    date: dateStr,
    records: z
        .array(
            z.object({
                studentId: z.string().min(1),
                status: z.enum(["present", "absent", "late", "excused"]),
                notes: z.string().max(500).optional().nullable(),
            })
        )
        .min(1, "records must be a non-empty array"),
});

export const qrGenerateSchema = z.object({
    classId: z.number().int().positive(),
    date: dateStr,
    expiryMinutes: z.number().int().positive().max(180).optional(),
});

// ─── ASSIGNMENTS ──────────────────────────────────────────────────────────────
export const createAssignmentSchema = z.object({
    classId: z.number().int().positive(),
    title: z.string().trim().min(1, "title is required").max(255),
    description: z.string().max(5000).optional().nullable(),
    dueAt: z.string().optional().nullable(),
    maxScore: z.number().int().positive().optional(),
    attachmentUrl: z.string().optional().nullable(),
    attachmentCldPubId: z.string().optional().nullable(),
    attachmentName: z.string().optional().nullable(),
});
export const updateAssignmentSchema = createAssignmentSchema.omit({ classId: true }).partial();

export const submitAssignmentSchema = z
    .object({
        content: z.string().max(10000).optional().nullable(),
        fileUrl: z.string().optional().nullable(),
        fileCldPubId: z.string().optional().nullable(),
        fileName: z.string().optional().nullable(),
    })
    .refine((d) => !!(d.content && d.content.trim()) || !!d.fileUrl, {
        message: "Provide either text content or a file attachment.",
    });

export const gradeSubmissionSchema = z.object({
    score: z.number().min(0),
    feedback: z.string().max(2000).optional().nullable(),
});

// ─── EXAMS / GRADES ───────────────────────────────────────────────────────────
export const createExamSchema = z.object({
    classId: z.number().int().positive(),
    title: z.string().trim().min(1, "title is required").max(255),
    description: z.string().max(5000).optional().nullable(),
    scheduledAt: z.string().optional().nullable(),
    durationMinutes: z.number().int().positive().optional().nullable(),
    maxScore: z.number().int().positive().optional(),
    venue: z.string().max(255).optional().nullable(),
});

export const examResultsSchema = z.object({
    records: z
        .array(
            z.object({
                studentId: z.string().min(1),
                score: z.number().min(0),
                remarks: z.string().max(1000).optional().nullable(),
            })
        )
        .min(1, "records must be a non-empty array"),
});

export const gradebookSaveSchema = z.object({
    records: z
        .array(
            z.object({
                studentId: z.string().min(1),
                finalGrade: z.number().min(0).max(100),
                remarks: z.string().max(1000).optional().nullable(),
            })
        )
        .min(1, "records required"),
});

// ─── FORMAL TERM RESULTS ─────────────────────────────────────────────────────
export const createAcademicYearSchema = z.object({
    name: z.string().trim().regex(/^\d{4}(?:\/\d{2,4})?$/, "use a school-year label such as 2026 or 2026/27"),
    startsOn: dateStr,
    endsOn: dateStr,
    active: z.boolean().optional(),
}).refine((value) => value.endsOn >= value.startsOn, { message: "endsOn must be after startsOn", path: ["endsOn"] });

export const createAcademicTermSchema = z.object({
    academicYearId: z.number().int().positive(),
    name: z.string().trim().min(1).max(80),
    type: z.enum(["midterm", "terminal"]),
    startsOn: dateStr,
    endsOn: dateStr,
}).refine((value) => value.endsOn >= value.startsOn, { message: "endsOn must be after startsOn", path: ["endsOn"] });

export const saveTermSubjectResultsSchema = z.object({
    academicTermId: z.number().int().positive(),
    classId: z.number().int().positive(),
    records: z.array(z.object({
        studentId: z.string().min(1),
        score: z.number().int().min(0).max(100),
        applicable: z.boolean().optional(),
    })).min(1, "records required"),
});
export const publishTermSubjectResultsSchema = z.object({
    academicTermId: z.number().int().positive(),
    classId: z.number().int().positive(),
    published: z.boolean(),
});

// A public enquiry is intentionally a small, low-risk first step. It does not
// collect a child name, date of birth, documents, or any portal credentials.
export const createAdmissionEnquirySchema = z.object({
    fullName: z.string().trim().min(2).max(255),
    email: z.string().trim().email().max(255),
    phone: z.string().trim().max(30).optional().or(z.literal("")),
    childStage: z.enum(["nursery", "kindergarten", "primary", "secondary", "not_sure"]),
    message: z.string().trim().max(2000).optional().or(z.literal("")),
    consent: z.boolean().refine((value) => value, { message: "Consent is required." }),
    // A visually hidden honeypot. Real browsers leave it empty; bots often do not.
    website: z.string().max(0).optional(),
});

// ─── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
export const createAnnouncementSchema = z.object({
    classId: z.number().int().positive().optional().nullable(),
    title: z.string().trim().min(1, "title is required").max(255),
    content: z.string().trim().min(1, "content is required").max(10000),
    pinned: z.boolean().optional(),
});
export const updateAnnouncementSchema = createAnnouncementSchema.partial();

// ─── CALENDAR ─────────────────────────────────────────────────────────────────
export const createCalendarEventSchema = z.object({
    title: z.string().trim().min(1, "title is required").max(255),
    description: z.string().max(5000).optional().nullable(),
    type: z.enum(["class", "exam", "holiday", "event", "deadline"]).optional(),
    startAt: z.string().min(1, "startAt is required"),
    endAt: z.string().optional().nullable(),
    allDay: z.boolean().optional(),
    classId: z.number().int().positive().optional().nullable(),
    recurrenceFreq: z.enum(["none", "daily", "weekly", "monthly"]).optional(),
    recurrenceInterval: z.number().int().positive().max(30).optional(),
    recurrenceEndAt: z.string().optional().nullable(),
});
export const updateCalendarEventSchema = createCalendarEventSchema.partial();

// ─── MESSAGES ─────────────────────────────────────────────────────────────────
export const sendMessageSchema = z.object({
    receiverId: z.string().min(1, "receiverId is required"),
    content: z.string().trim().min(1, "content is required").max(5000),
});

// ─── USERS / PROFILE ──────────────────────────────────────────────────────────
export const updateRoleSchema = z.object({
    role: z.enum(["student", "teacher", "admin", "parent", "super_admin"]),
});

// Admin-initiated password reset. "email" mails the user a reset link (the same
// one /forgot-password sends); "temporary" sets a generated one-time password
// the admin reads back once and hands to the user in person.
export const adminResetPasswordSchema = z.object({
    mode: z.enum(["email", "temporary"]),
});

export const linkParentSchema = z.object({
    // Pass an email to link that user (must already have role "parent") as this
    // student's parent; pass null to unlink.
    email: z.union([z.string().email(), z.null()]),
});

export const createFileSchema = z.object({
    studentId: z.string().min(1, "studentId is required"),
    name: z.string().trim().min(1, "name is required").max(255),
    category: z.enum(["document", "certificate", "medical", "other"]).optional(),
    url: z.string().min(1, "url is required"),
    cldPubId: z.string().min(1, "cldPubId is required"),
    fileSize: z.number().int().positive().optional().nullable(),
});

// ─── AI ASSISTANT ─────────────────────────────────────────────────────────────
export const aiChatSchema = z.object({
    message: z.string().trim().min(1, "message is required").max(2000),
    history: z
        .array(
            z.object({
                role: z.enum(["user", "assistant"]),
                content: z.string().max(4000),
            })
        )
        .max(40)
        .optional(),
});

// Display photo (avatar). `url` must be a Cloudinary-hosted image; `null` clears
// the photo and falls back to initials. `publicId` is Cloudinary's handle for
// the asset, kept so the image can be transformed/removed later.
export const updateAvatarSchema = z.object({
    url: z.union([
        z.string().regex(/^https:\/\/[a-z0-9.-]+\.cloudinary\.com\/.+/i, "must be a Cloudinary URL"),
        z.null(),
    ]),
    publicId: z.union([z.string().max(300), z.null()]).optional(),
});

export const updateProfileSchema = z.object({
    registrationNumber: z.string().max(50).optional().nullable(),
    dateOfBirth: z.string().optional().nullable(),
    phone: z.string().max(30).optional().nullable(),
    address: z.string().max(500).optional().nullable(),
    parentName: z.string().max(255).optional().nullable(),
    parentPhone: z.string().max(30).optional().nullable(),
    parentEmail: z.union([z.string().email(), z.literal("")]).optional().nullable(),
    bio: z.string().max(2000).optional().nullable(),
});
