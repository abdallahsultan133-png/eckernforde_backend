/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Route-level authorization — integration tests.
 *
 * These mount the REAL routers (real requireAuth / requireRole / validateBody
 * and the real policy calls inside each handler) on a throwaway Express server
 * and drive them over HTTP. They assert only the ACCESS DECISION each endpoint
 * makes:
 *   • 401 — no session
 *   • 403 — signed in, but wrong role, or the right role without ownership/scope
 *   • otherwise (200/201/400/404) — the guard passed and the handler was reached
 *
 * Two collaborators are faked:
 *   • ../lib/auth.js — better-auth is stubbed. The test middleware sets req.user
 *     straight from an `x-test-user` header, so requireAuth short-circuits on it;
 *     a request with no header falls through to the stub getSession() → null → 401.
 *   • ../db/index.js — every query is a chainable thenable resolving to the next
 *     value queued with `queueDb(...)` (defaults: `[]` for selects, `[{ id: 1 }]`
 *     for insert/update/delete). A test queues the row an ownership/enrollment
 *     lookup should return, then asserts the status. The SQL itself is not under
 *     test — lib/policy.test.ts covers the decision logic; this file covers that
 *     every route actually invokes it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── DB mock ──────────────────────────────────────────────────────────────────
const dbState = vi.hoisted(() => ({ queue: [] as unknown[], predicates: [] as SQL[] }));

vi.mock("../db/index.js", () => {
    const pull = (fallback: unknown) => (dbState.queue.length ? dbState.queue.shift() : fallback);

    // A Proxy that answers every chain method (`.from`, `.where`, `.innerJoin`,
    // `.values`, `.returning`, …) with itself and, when awaited, resolves to the
    // next queued value (or `fallback`).
    const chain = (fallback: unknown): any =>
        new Proxy(function () {}, {
            get(_target, prop) {
                if (prop === "where") return (predicate: SQL) => { if (predicate) dbState.predicates.push(predicate); return chain(fallback); };
                if (prop === "then") {
                    return (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
                        Promise.resolve(pull(fallback)).then(ok, err);
                }
                return () => chain(fallback);
            },
            apply: () => chain(fallback),
        });

    return {
        db: {
            select: () => chain([]),
            insert: () => chain([{ id: 1 }]),
            update: () => chain([{ id: 1, name: "Updated", email: "updated@school.test", role: "student" }]),
            delete: () => chain([{ id: 1 }]),
            execute: async () => ({ rows: [] }),
            transaction: async (callback: (transaction: any) => unknown) => callback({
                update: () => chain([{ id: 1 }]),
                insert: () => chain([{ id: 1 }]),
            }),
        },
        pool: { on: () => undefined },
    };
});

vi.mock("../lib/auth.js", () => ({
    auth: {
        api: {
            getSession: vi.fn(async () => null),
            requestPasswordReset: vi.fn(async () => ({ status: true })),
        },
        // Awaited by POST /api/users/:id/reset-password in "temporary" mode.
        $context: Promise.resolve({
            password: { hash: vi.fn(async () => "hashed-password") },
            internalAdapter: { deleteUserSessions: vi.fn(async () => undefined) },
        }),
    },
}));

// These route tests isolate the existing ownership and role guards. Portal
// class selection is exercised with the real helper in portal-context.test.ts;
// the legacy queued DB fixture here has no per-user context unless a test
// explicitly supplies one through the portal-context router.
vi.mock("../lib/portal-context.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/portal-context.js")>();
    return {
        ...actual,
        activePortalClassIds: async () => null,
        isInActivePortalClass: async () => true,
    };
});

/** Queue the value(s) the next DB query/queries should resolve to (FIFO). */
function queueDb(...values: unknown[]) {
    dbState.queue.push(...values);
}

// Routers under test — imported after the mocks above are registered.
const { default: auditLogsRouter } = await import("./audit-logs.js");
const { default: usersRouter } = await import("./users.js");
const { default: classesRouter } = await import("./classes.js");
const { default: gradesRouter } = await import("./grades.js");
const { default: attendanceRouter } = await import("./attendance.js");
const { default: calendarRouter } = await import("./calendar.js");
const { default: announcementsRouter } = await import("./announcements.js");
const { default: admissionsRouter } = await import("./admissions.js");
const { default: aiAssistantRouter } = await import("./ai-assistant.js");
const { default: uploadsRouter } = await import("./uploads.js");
const { default: portalContextRouter } = await import("./portal-context.js");
const { default: dashboardRouter } = await import("./dashboard.js");

// ── Test users ───────────────────────────────────────────────────────────────
type TestUser = { id: string; name: string; email: string; role: UserRoles };

const USERS = {
    student:    { id: "student-1", name: "Sam Student",  email: "sam@school.test",  role: "student" },
    parent:     { id: "parent-1",  name: "Pat Parent",   email: "pat@school.test",  role: "parent" },
    teacher:    { id: "teacher-1", name: "Tess Teacher", email: "tess@school.test", role: "teacher" },
    teacher2:   { id: "teacher-2", name: "Ty Teacher",   email: "ty@school.test",   role: "teacher" },
    admin:      { id: "admin-1",   name: "Ada Admin",    email: "ada@school.test",  role: "admin" },
    superAdmin: { id: "super-1",   name: "Sue Super",    email: "sue@school.test",  role: "super_admin" },
} as const;

// ── Throwaway server ─────────────────────────────────────────────────────────
let server: Server;
let baseURL: string;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    // Stand-in for resolveSession: trust an `x-test-user` header so requireAuth
    // sees req.user and short-circuits on it. No header → requireAuth calls the
    // stubbed getSession() → null → 401.
    app.use((req, _res, next) => {
        const header = req.header("x-test-user");
        if (header) req.user = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
        next();
    });
    app.use("/api/audit-logs", auditLogsRouter);
    app.use("/api/users", usersRouter);
    app.use("/api/classes", classesRouter);
    app.use("/api/grades", gradesRouter);
    app.use("/api/attendance", attendanceRouter);
    app.use("/api/calendar", calendarRouter);
    app.use("/api/announcements", announcementsRouter);
    app.use("/api/admissions", admissionsRouter);
    app.use("/api/ai-assistant", aiAssistantRouter);
    app.use("/api/uploads", uploadsRouter);
    app.use("/api/portal-context", portalContextRouter);
    app.use("/api/dashboard", dashboardRouter);

    server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
    dbState.queue.length = 0;
    dbState.predicates.length = 0;
});

async function call(
    method: string,
    path: string,
    opts: { as?: TestUser; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {};
    if (opts.as) headers["x-test-user"] = Buffer.from(JSON.stringify(opts.as)).toString("base64");

    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(opts.body);
    }

    const res = await fetch(`${baseURL}${path}`, init);
    const text = await res.text();
    let body: any;
    try {
        body = text ? JSON.parse(text) : undefined;
    } catch {
        body = text;
    }
    return { status: res.status, body };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/audit-logs — admin only", () => {
    it("401 without a session", async () => {
        expect((await call("GET", "/api/audit-logs")).status).toBe(401);
    });

    it("403 for a student, parent, or teacher", async () => {
        for (const user of [USERS.student, USERS.parent, USERS.teacher]) {
            expect((await call("GET", "/api/audit-logs", { as: user })).status).toBe(403);
        }
    });

    it("200 for an admin or super_admin", async () => {
        for (const user of [USERS.admin, USERS.superAdmin]) {
            expect((await call("GET", "/api/audit-logs", { as: user })).status).toBe(200);
        }
    });
});

describe("GET /api/dashboard/stats — role-scoped aggregates", () => {
    it("returns student stats when the pending-assignment class scope is active", async () => {
        // The student path fans out across several aggregate queries. Keep this
        // smoke test close to the route so a new role-scoped query cannot make
        // the whole dashboard fail before it returns its response.
        const result = await call("GET", "/api/dashboard/stats", { as: USERS.student });
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ students: 0, teachers: 0, classes: 0, subjects: 0 });
    });
});

describe("PATCH /api/users/:id/role — privilege-escalation guard", () => {
    it("401 without a session", async () => {
        const r = await call("PATCH", "/api/users/u9/role", { body: { role: "teacher" } });
        expect(r.status).toBe(401);
    });

    it("403 for a teacher (not an admin)", async () => {
        const r = await call("PATCH", "/api/users/u9/role", { as: USERS.teacher, body: { role: "student" } });
        expect(r.status).toBe(403);
    });

    it("400 when the role is not a known role", async () => {
        const r = await call("PATCH", "/api/users/u9/role", { as: USERS.admin, body: { role: "root" } });
        expect(r.status).toBe(400);
    });

    it("an admin CANNOT promote anyone to admin or super_admin", async () => {
        for (const role of ["admin", "super_admin"] as const) {
            const r = await call("PATCH", "/api/users/u9/role", { as: USERS.admin, body: { role } });
            expect(r.status).toBe(403);
        }
    });

    it("an admin CAN set ordinary roles", async () => {
        for (const role of ["student", "teacher", "parent"] as const) {
            const r = await call("PATCH", "/api/users/u9/role", { as: USERS.admin, body: { role } });
            expect(r.status).toBe(200);
        }
    });

    it("a super_admin CAN grant admin-level roles", async () => {
        const r = await call("PATCH", "/api/users/u9/role", { as: USERS.superAdmin, body: { role: "admin" } });
        expect(r.status).toBe(200);
    });
});

describe("POST /api/users/:id/reset-password — admin password reset", () => {
    const target = { id: "u9", name: "Nia Ninth", email: "nia@school.test", role: "student" };

    it("401 without a session", async () => {
        const r = await call("POST", "/api/users/u9/reset-password", { body: { mode: "email" } });
        expect(r.status).toBe(401);
    });

    it("403 for non-admins (student, parent, teacher)", async () => {
        for (const as of [USERS.student, USERS.parent, USERS.teacher]) {
            const r = await call("POST", "/api/users/u9/reset-password", { as, body: { mode: "email" } });
            expect(r.status).toBe(403);
        }
    });

    it("400 for an unknown mode", async () => {
        const r = await call("POST", "/api/users/u9/reset-password", { as: USERS.admin, body: { mode: "carrier-pigeon" } });
        expect(r.status).toBe(400);
    });

    it("404 when the target user does not exist", async () => {
        queueDb([]); // target lookup → no rows
        const r = await call("POST", "/api/users/u9/reset-password", { as: USERS.admin, body: { mode: "email" } });
        expect(r.status).toBe(404);
    });

    it("an admin CAN send a reset email to an ordinary user", async () => {
        queueDb([target]);
        const r = await call("POST", "/api/users/u9/reset-password", { as: USERS.admin, body: { mode: "email" } });
        expect(r.status).toBe(200);
        expect(r.body.data).toMatchObject({ mode: "email" });
    });

    it("an admin CAN set a temporary password, returned once", async () => {
        queueDb([target], [{ id: "cred-1" }]); // target lookup, then existing credential account
        const r = await call("POST", "/api/users/u9/reset-password", { as: USERS.admin, body: { mode: "temporary" } });
        expect(r.status).toBe(200);
        expect(r.body.data.mode).toBe("temporary");
        expect(typeof r.body.data.temporaryPassword).toBe("string");
        expect(r.body.data.temporaryPassword.length).toBeGreaterThanOrEqual(8);
    });

    it("a plain admin CANNOT reset an admin-level account", async () => {
        queueDb([{ ...target, role: "super_admin" }]);
        const r = await call("POST", "/api/users/u9/reset-password", { as: USERS.admin, body: { mode: "email" } });
        expect(r.status).toBe(403);
    });

    it("a super_admin CAN reset an admin's password", async () => {
        queueDb([{ ...target, role: "admin" }]);
        const r = await call("POST", "/api/users/u9/reset-password", { as: USERS.superAdmin, body: { mode: "email" } });
        expect(r.status).toBe(200);
    });
});

describe("DELETE /api/users/:id — admin user deletion", () => {
    const target = { id: "u9", name: "Nia Ninth", email: "nia@school.test", role: "student" };

    it("401 without a session", async () => {
        expect((await call("DELETE", "/api/users/u9")).status).toBe(401);
    });

    it("403 for non-admins (student, parent, teacher)", async () => {
        for (const as of [USERS.student, USERS.parent, USERS.teacher]) {
            expect((await call("DELETE", "/api/users/u9", { as })).status).toBe(403);
        }
    });

    it("400 when an admin targets their own account", async () => {
        const r = await call("DELETE", `/api/users/${USERS.admin.id}`, { as: USERS.admin });
        expect(r.status).toBe(400);
    });

    it("404 when the target user does not exist", async () => {
        queueDb([]); // target lookup → no rows
        expect((await call("DELETE", "/api/users/u9", { as: USERS.admin })).status).toBe(404);
    });

    it("an admin CAN delete an ordinary user", async () => {
        queueDb([target]);
        const r = await call("DELETE", "/api/users/u9", { as: USERS.admin });
        expect(r.status).toBe(200);
        expect(r.body.data).toMatchObject({ id: "u9" });
    });

    it("a plain admin CANNOT delete an admin-level account", async () => {
        queueDb([{ ...target, role: "super_admin" }]);
        expect((await call("DELETE", "/api/users/u9", { as: USERS.admin })).status).toBe(403);
    });

    it("a super_admin CAN delete an admin", async () => {
        queueDb([{ ...target, role: "admin" }]);
        expect((await call("DELETE", "/api/users/u9", { as: USERS.superAdmin })).status).toBe(200);
    });
});

describe("users directory endpoints", () => {
    it("GET /api/users is admin only", async () => {
        expect((await call("GET", "/api/users", { as: USERS.teacher })).status).toBe(403);
        expect((await call("GET", "/api/users", { as: USERS.student })).status).toBe(403);
        expect((await call("GET", "/api/users", { as: USERS.admin })).status).toBe(200);
    });

    it("GET /api/users/students is staff only", async () => {
        expect((await call("GET", "/api/users/students", { as: USERS.student })).status).toBe(403);
        expect((await call("GET", "/api/users/students", { as: USERS.parent })).status).toBe(403);
        expect((await call("GET", "/api/users/students", { as: USERS.teacher })).status).toBe(200);
    });

    it("GET /api/users/teachers is any signed-in user, but not the public", async () => {
        expect((await call("GET", "/api/users/teachers")).status).toBe(401);
        expect((await call("GET", "/api/users/teachers", { as: USERS.student })).status).toBe(200);
    });
});

describe("class list scopes", () => {
    it("returns the student's enrolled classes for the dashboard scope", async () => {
        queueDb(
            [{ count: 1 }],
            [{ id: 7, name: "Form II Mathematics", status: "active" }],
        );

        const result = await call("GET", "/api/classes?mine=1&limit=6", { as: USERS.student });

        expect(result.status).toBe(200);
        expect(result.body.data).toHaveLength(1);
        expect(result.body.data[0]).toMatchObject({ id: 7, name: "Form II Mathematics" });
    });

    it("keeps the full class catalogue available without the dashboard scope", async () => {
        queueDb(
            [{ count: 2 }],
            [
                { id: 7, name: "Form II Mathematics", status: "active" },
                { id: 8, name: "Form II English", status: "active" },
            ],
        );

        const result = await call("GET", "/api/classes?limit=12", { as: USERS.student });

        expect(result.status).toBe(200);
        expect(result.body.data).toHaveLength(2);
        expect(dbState.predicates).toHaveLength(0);
    });
});

describe("class management — role + ownership", () => {
    it("creating a class requires staff", async () => {
        expect((await call("POST", "/api/classes")).status).toBe(401);
        expect((await call("POST", "/api/classes", { as: USERS.student, body: {} })).status).toBe(403);
    });

    it("a teacher can create a class", async () => {
        const r = await call("POST", "/api/classes", {
            as: USERS.teacher,
            body: { name: "Chemistry 1", subjectId: 1, teacherId: "ignored" },
        });
        expect(r.status).toBe(201);
    });

    it("a teacher can edit only a class they teach", async () => {
        queueDb([{ id: 1, teacherId: USERS.teacher2.id }]); // owned by someone else
        const denied = await call("PUT", "/api/classes/1", { as: USERS.teacher, body: { name: "Renamed" } });
        expect(denied.status).toBe(403);

        queueDb([{ id: 1, teacherId: USERS.teacher.id }]); // owned by the caller
        const ok = await call("PUT", "/api/classes/1", { as: USERS.teacher, body: { name: "Renamed" } });
        expect(ok.status).toBe(200);
    });

    it("an admin can edit any class", async () => {
        queueDb([{ id: 1, teacherId: USERS.teacher2.id }]);
        const r = await call("PUT", "/api/classes/1", { as: USERS.admin, body: { name: "Renamed" } });
        expect(r.status).toBe(200);
    });

    it("a missing class is 404, not 403 (existence checked before ownership)", async () => {
        queueDb([]); // no such row
        const r = await call("PUT", "/api/classes/999", { as: USERS.admin, body: { name: "x" } });
        expect(r.status).toBe(404);
    });

    it("only an admin can delete a class", async () => {
        expect((await call("DELETE", "/api/classes/1", { as: USERS.teacher })).status).toBe(403);
        queueDb([{ id: 1 }]);
        expect((await call("DELETE", "/api/classes/1", { as: USERS.admin })).status).toBe(200);
    });
});

describe("class roster visibility — GET /api/classes/:id/students", () => {
    it("a teacher sees the roster only for classes they teach", async () => {
        queueDb([]); // canManageClass ownership lookup → nothing
        expect((await call("GET", "/api/classes/1/students", { as: USERS.teacher })).status).toBe(403);

        queueDb([{ id: 1 }]); // owns it
        expect((await call("GET", "/api/classes/1/students", { as: USERS.teacher })).status).toBe(200);
    });

    it("a student sees the roster only for a class they're enrolled in", async () => {
        queueDb([]); // isEnrolledInClass → no row
        expect((await call("GET", "/api/classes/1/students", { as: USERS.student })).status).toBe(403);

        queueDb([{ studentId: USERS.student.id }]); // enrolled
        expect((await call("GET", "/api/classes/1/students", { as: USERS.student })).status).toBe(200);
    });

    it("a parent sees the roster only for a class one of their children is in", async () => {
        queueDb([]); // getLinkedChildIds → none
        expect((await call("GET", "/api/classes/1/students", { as: USERS.parent })).status).toBe(403);

        queueDb([{ userId: "child-1" }], [{ studentId: "child-1" }]); // linked child + enrolled
        expect((await call("GET", "/api/classes/1/students", { as: USERS.parent })).status).toBe(200);
    });

    it("an admin sees any roster", async () => {
        expect((await call("GET", "/api/classes/1/students", { as: USERS.admin })).status).toBe(200);
    });
});

describe("grades — staff role + class ownership", () => {
    it("POST /api/grades/exams requires staff", async () => {
        expect((await call("POST", "/api/grades/exams", { as: USERS.student, body: {} })).status).toBe(403);
        expect((await call("POST", "/api/grades/exams", { as: USERS.parent, body: {} })).status).toBe(403);
    });

    it("a teacher can create an exam only for a class they teach", async () => {
        queueDb([]); // canManageClass → not the owner
        const denied = await call("POST", "/api/grades/exams", {
            as: USERS.teacher,
            body: { classId: 5, title: "Midterm" },
        });
        expect(denied.status).toBe(403);

        queueDb([{ id: 1 }]); // owner
        const ok = await call("POST", "/api/grades/exams", {
            as: USERS.teacher,
            body: { classId: 5, title: "Midterm" },
        });
        expect(ok.status).toBe(201);
    });

    it("an admin can create an exam for any class", async () => {
        const r = await call("POST", "/api/grades/exams", {
            as: USERS.admin,
            body: { classId: 5, title: "Midterm" },
        });
        expect(r.status).toBe(201);
    });

    it("saving gradebook grades is staff only and teacher-scoped", async () => {
        const noRole = await call("POST", "/api/grades/gradebook/5/save", { as: USERS.student, body: {} });
        expect(noRole.status).toBe(403);

        queueDb([]); // canManageClass → not the owner
        const notOwner = await call("POST", "/api/grades/gradebook/5/save", {
            as: USERS.teacher,
            body: { records: [{ studentId: "s1", finalGrade: 90 }] },
        });
        expect(notOwner.status).toBe(403);
    });

    it("GET /api/grades/gradebook/:classId — a student sees only a class they're in", async () => {
        queueDb([]); // isEnrolledInClass → no
        expect((await call("GET", "/api/grades/gradebook/5", { as: USERS.student })).status).toBe(403);

        queueDb([{ studentId: USERS.student.id }]); // enrolled
        expect((await call("GET", "/api/grades/gradebook/5", { as: USERS.student })).status).toBe(200);
    });

    it("GET /api/grades/gradebook/:classId — a parent needs a child in the class", async () => {
        queueDb([]); // getLinkedChildIds → none
        expect((await call("GET", "/api/grades/gradebook/5", { as: USERS.parent })).status).toBe(403);
    });

    it("GET /api/grades/exams is open to any authenticated user", async () => {
        expect((await call("GET", "/api/grades/exams")).status).toBe(401);
        expect((await call("GET", "/api/grades/exams", { as: USERS.student })).status).toBe(200);
    });
});

describe("attendance — marking is staff + class-scoped", () => {
    const body = { classId: 3, date: "2026-01-15", records: [{ studentId: "s1", status: "present" }] };

    it("a student cannot mark attendance", async () => {
        expect((await call("POST", "/api/attendance", { as: USERS.student, body: {} })).status).toBe(403);
    });

    it("a teacher can mark attendance only for a class they teach", async () => {
        queueDb([]); // canManageClass → not the owner
        expect((await call("POST", "/api/attendance", { as: USERS.teacher, body })).status).toBe(403);

        queueDb([{ id: 1 }]); // owner
        expect((await call("POST", "/api/attendance", { as: USERS.teacher, body })).status).toBe(200);
    });

    it("an admin can mark attendance for any class", async () => {
        expect((await call("POST", "/api/attendance", { as: USERS.admin, body })).status).toBe(200);
    });
});

describe("calendar read scope", () => {
    it("requires login", async () => {
        expect((await call("GET", "/api/calendar")).status).toBe(401);
    });
    it.each([USERS.student, USERS.teacher])("limits $role academic events to permitted classes", async (as) => {
        queueDb([{ id: 42 }], [], [], []);
        expect((await call("GET", "/api/calendar", { as })).status).toBe(200);
        const clauses = dbState.predicates.map(p => new PgDialect().sqlToQuery(p));
        const scoped = clauses.filter(p => p.params.includes(42));
        expect(scoped).toHaveLength(3);
        expect(scoped.some(p => p.sql.includes('is null'))).toBe(true);
    });
    it("excludes all class-bound records for a parent without linked children", async () => {
        expect((await call("GET", "/api/calendar", { as: USERS.parent })).status).toBe(200);
        const clauses = dbState.predicates.map(p => new PgDialect().sqlToQuery(p).sql);
        expect(clauses.filter(sql => sql.includes("false"))).toHaveLength(3);
    });
    it("lets a parent scope the calendar to one linked child", async () => {
        queueDb([{ userId: "child-1" }], [{ id: 77 }], [], [], []);
        expect((await call("GET", "/api/calendar?childId=child-1", { as: USERS.parent })).status).toBe(200);
        const clauses = dbState.predicates.map(p => new PgDialect().sqlToQuery(p));
        expect(clauses.filter(p => p.params.includes(77))).toHaveLength(3);
    });
    it("rejects a calendar request for somebody else's child", async () => {
        queueDb([{ userId: "child-1" }]);
        expect((await call("GET", "/api/calendar?childId=child-2", { as: USERS.parent })).status).toBe(403);
    });
});

describe("calendar events — add / remove is admin only", () => {
    const newEvent = { title: "Staff meeting", startAt: "2026-09-01T10:00" };

    it("only an admin or super_admin can add an event", async () => {
        expect((await call("POST", "/api/calendar")).status).toBe(401);
        expect((await call("POST", "/api/calendar", { as: USERS.student, body: newEvent })).status).toBe(403);
        expect((await call("POST", "/api/calendar", { as: USERS.parent, body: newEvent })).status).toBe(403);
        expect((await call("POST", "/api/calendar", { as: USERS.teacher, body: newEvent })).status).toBe(403);

        expect((await call("POST", "/api/calendar", { as: USERS.admin, body: newEvent })).status).toBe(201);
        expect((await call("POST", "/api/calendar", { as: USERS.superAdmin, body: newEvent })).status).toBe(201);
    });

    it("only an admin or super_admin can remove an event", async () => {
        expect((await call("DELETE", "/api/calendar/1", { as: USERS.teacher })).status).toBe(403);
        expect((await call("DELETE", "/api/calendar/1", { as: USERS.student })).status).toBe(403);
        // delete().returning() yields a row from the mock → handler reaches 200.
        expect((await call("DELETE", "/api/calendar/1", { as: USERS.admin })).status).toBe(200);
    });

    it("only an admin or super_admin can edit an event", async () => {
        expect((await call("PUT", "/api/calendar/1", { as: USERS.teacher, body: { title: "Renamed" } })).status).toBe(403);
        expect((await call("PUT", "/api/calendar/1", { as: USERS.admin, body: { title: "Renamed" } })).status).toBe(200);
    });
});

describe("admissions enquiries — public write, admin-only review", () => {
    const enquiry = { fullName: "Mina Parent", email: "mina@example.test", childStage: "primary", consent: true };

    it("accepts a minimal valid public enquiry without requiring a portal account", async () => {
        expect((await call("POST", "/api/admissions/enquiries", { body: enquiry })).status).toBe(201);
    });

    it("rejects invalid or non-consented public submissions", async () => {
        expect((await call("POST", "/api/admissions/enquiries", { body: { ...enquiry, email: "not-an-email" } })).status).toBe(400);
        expect((await call("POST", "/api/admissions/enquiries", { body: { ...enquiry, consent: false } })).status).toBe(400);
    });

    it("keeps enquiry review and status changes admin-only", async () => {
        expect((await call("GET", "/api/admissions/enquiries")).status).toBe(401);
        expect((await call("GET", "/api/admissions/enquiries", { as: USERS.teacher })).status).toBe(403);
        expect((await call("GET", "/api/admissions/enquiries", { as: USERS.student })).status).toBe(403);
        expect((await call("GET", "/api/admissions/enquiries", { as: USERS.admin })).status).toBe(200);
        expect((await call("PATCH", "/api/admissions/enquiries/1/status", { as: USERS.teacher, body: { status: "closed" } })).status).toBe(403);
        expect((await call("PATCH", "/api/admissions/enquiries/1/status", { as: USERS.admin, body: { status: "closed" } })).status).toBe(200);
    });
});

describe("public content publication boundaries", () => {
    it("allows anonymous read-only access to the narrow public feeds", async () => {
        expect((await call("GET", "/api/announcements/public")).status).toBe(200);
        expect((await call("GET", "/api/calendar/public")).status).toBe(200);
    });

    it("requires an administrator to change public announcement visibility", async () => {
        expect((await call("PATCH", "/api/announcements/1/publication", { body: { isPublic: true } })).status).toBe(401);
        expect((await call("PATCH", "/api/announcements/1/publication", { as: USERS.teacher, body: { isPublic: true } })).status).toBe(403);
        queueDb([{ id: 1, classId: null }]);
        expect((await call("PATCH", "/api/announcements/1/publication", { as: USERS.admin, body: { isPublic: true } })).status).toBe(200);
    });

    it("requires an administrator to change public event visibility", async () => {
        expect((await call("PATCH", "/api/calendar/1/publication", { body: { isPublic: true } })).status).toBe(401);
        expect((await call("PATCH", "/api/calendar/1/publication", { as: USERS.teacher, body: { isPublic: true } })).status).toBe(403);
        queueDb([{ id: 1, classId: null }]);
        expect((await call("PATCH", "/api/calendar/1/publication", { as: USERS.admin, body: { isPublic: true } })).status).toBe(200);
    });
});

describe("formal term-result publication — admin only", () => {
    const body = { academicTermId: 1, classId: 1, published: true };

    it("rejects unauthenticated and teacher publication attempts", async () => {
        expect((await call("POST", "/api/grades/term-results/publish", { body })).status).toBe(401);
        expect((await call("POST", "/api/grades/term-results/publish", { as: USERS.teacher, body })).status).toBe(403);
        expect((await call("POST", "/api/grades/term-results/publish", { as: USERS.student, body })).status).toBe(403);
    });

    it("allows an administrator to publish a class-term result set", async () => {
        const result = await call("POST", "/api/grades/term-results/publish", { as: USERS.admin, body });
        expect(result.status).toBe(200);
        expect(result.body.data.published).toBe(true);
    });
});

describe("AI student assistant — administrator only", () => {
    const body = { message: "Find Sam Student" };

    it("rejects unauthenticated and teacher access before any student lookup", async () => {
        expect((await call("POST", "/api/ai-assistant/chat", { body })).status).toBe(401);
        expect((await call("POST", "/api/ai-assistant/chat", { as: USERS.teacher, body })).status).toBe(403);
        expect((await call("POST", "/api/ai-assistant/chat", { as: USERS.student, body })).status).toBe(403);
    });

    it("allows an administrator through the authorization guard", async () => {
        // The test environment intentionally has no Anthropic key, so a 500
        // proves the administrator reached the configured-handler boundary.
        expect((await call("POST", "/api/ai-assistant/chat", { as: USERS.admin, body })).status).toBe(500);
    });
});

describe("Cloudinary upload signing - authenticated and constrained", () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const validParams = { folder: "uploads/avatars", timestamp };

    it("requires authentication", async () => {
        expect((await call("POST", "/api/uploads/sign", { body: validParams })).status).toBe(401);
    });

    it("rejects unapproved folders and unsupported parameters", async () => {
        expect((await call("POST", "/api/uploads/sign", {
            as: USERS.student,
            body: { ...validParams, folder: "private/exports" },
        })).status).toBe(400);
        expect((await call("POST", "/api/uploads/sign", {
            as: USERS.student,
            body: { ...validParams, callback: "https://attacker.test" },
        })).status).toBe(400);
    });

    it("rejects expired signing timestamps", async () => {
        expect((await call("POST", "/api/uploads/sign", {
            as: USERS.student,
            body: { ...validParams, timestamp: timestamp - 60 * 60 },
        })).status).toBe(400);
    });
});

describe("student academic archive", () => {
    const path = "/api/portal-context/history/7";

    it("requires a student session and a saved context for the requested year", async () => {
        expect((await call("GET", path)).status).toBe(401);
        expect((await call("GET", path, { as: USERS.teacher })).status).toBe(403);
        queueDb([{ id: 7, name: "2025", startsOn: "2025-01-01", endsOn: "2025-12-31" }], []);
        expect((await call("GET", path, { as: USERS.student })).status).toBe(403);
    });

    it("keeps the current year in the live portal instead of the read-only archive", async () => {
        const year = { id: 7, name: "Current", startsOn: "2000-01-01", endsOn: "2099-12-31", active: true };
        queueDb([year], [{ id: 11, userId: USERS.student.id, academicYearId: 7, stage: "form_i" }], [year]);
        expect((await call("GET", path, { as: USERS.student })).status).toBe(409);
    });

    it("does not expose an overlapping legacy year as historical", async () => {
        const legacy = { id: 7, name: "Legacy", startsOn: "2000-08-01", endsOn: "2099-07-31", active: false };
        const current = { id: 8, name: "2026/2027", startsOn: "2026-01-01", endsOn: "2026-12-31", active: true };
        queueDb([legacy], [{ id: 11, userId: USERS.student.id, academicYearId: 7, stage: "form_i" }], [current]);
        expect((await call("GET", path, { as: USERS.student })).status).toBe(409);
        queueDb([current], [{ id: 11, academicYear: legacy, stage: "form_i" }]);
        const list = await call("GET", "/api/portal-context/history", { as: USERS.student });
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual([]);
    });

    it("returns only records for the student's saved year and stage", async () => {
        queueDb(
            [{ id: 7, name: "2025", startsOn: "2025-01-01", endsOn: "2025-12-31" }],
            [{ id: 11, userId: USERS.student.id, academicYearId: 7, schoolBand: "secondary", stage: "form_i" }],
            [], // No current academic year in this isolated fixture.
            [{ id: 5, name: "Form I", academicYearId: 7, teacherId: USERS.teacher.id, subject: { id: 2, name: "Mathematics" } }],
            [
                { id: 21, termName: "Terminal", className: "Form I", classAcademicYearId: 7, score: 80 },
                { id: 22, termName: "Terminal", className: "Form II", classAcademicYearId: 7, score: 80 },
            ],
            [{ id: 31, date: "2025-02-10", status: "present", className: "Form I", classAcademicYearId: 7 }],
            [{ id: 41, title: "Algebra", className: "Form I", classAcademicYearId: 7 }],
            [{ id: 51, title: "Midterm", className: "Form I", classAcademicYearId: 7 }],
            [{ classId: 5 }],
        );

        const response = await call("GET", path, { as: USERS.student });
        expect(response.status).toBe(200);
        expect(response.body.data.classes).toHaveLength(1);
        expect(response.body.data.termResults).toHaveLength(1);
        expect(response.body.data.termResults[0].className).toBe("Form I");
        expect(response.body.data.attendance).toHaveLength(1);
        expect(response.body.data.assignments).toHaveLength(1);
        expect(response.body.data.exams).toHaveLength(1);
        const clauses = dbState.predicates.map((predicate) => new PgDialect().sqlToQuery(predicate));
        expect(clauses.filter((clause) => clause.params.includes(USERS.student.id)).length).toBeGreaterThanOrEqual(6);
        expect(clauses.some((clause) => clause.params.includes(7))).toBe(true);
    });
});

describe("portal form selection across academic years", () => {
    const currentYear = { id: 8, name: "New year", startsOn: "2000-01-01", endsOn: "2099-12-31", active: true };
    const classes = [
        { id: 1, name: "Form I", academicYearId: 8, teacherId: USERS.teacher.id },
        { id: 2, name: "Form II", academicYearId: 8, teacherId: USERS.teacher.id },
    ];
    const body = { academicYearId: 8, schoolBand: "secondary", stage: "form_ii" };

    it("does not let a student replace their selected form in the same year", async () => {
        queueDb([currentYear], [{ id: 5, stage: "form_i" }]);
        const response = await call("POST", "/api/portal-context", { as: USERS.student, body });
        expect(response.status).toBe(409);
        expect(response.body.error).toContain("correct class or form");
    });

    it("does not let a student change to a lower form during the same year", async () => {
        queueDb([currentYear], [{ id: 5, stage: "form_ii" }]);
        const response = await call("POST", "/api/portal-context", {
            as: USERS.student,
            body: { ...body, stage: "form_i" },
        });
        expect(response.status).toBe(409);
        expect(response.body.error).toContain("correct class or form");
    });

    it("lets a student select their assigned form in a new year", async () => {
        // Context selection is onboarding only; enrollment is checked later
        // when class-scoped data is requested.
        queueDb([currentYear], []);
        const response = await call("POST", "/api/portal-context", { as: USERS.student, body });
        expect(response.status).toBe(201);
    });

    it("allows only the saved stage or one promotion when a new year starts", async () => {
        queueDb([currentYear], [], [], [], [{ stage: "form_i" }]);
        expect((await call("POST", "/api/portal-context", { as: USERS.student, body })).status).toBe(201);

        queueDb([currentYear], [], [], [], [{ stage: "form_i" }]);
        const skipped = await call("POST", "/api/portal-context", {
            as: USERS.student,
            body: { ...body, stage: "form_iii" },
        });
        expect(skipped.status).toBe(409);
        expect(skipped.body.error).toContain("move ahead by one stage");
    });

    it("lets a teacher move between assigned forms during one year", async () => {
        queueDb([currentYear], classes, [{ id: 5, stage: "form_i" }]);
        const response = await call("POST", "/api/portal-context", { as: USERS.teacher, body });
        expect(response.status).toBe(200);
    });

    it("does not offer unassigned Legacy classes in a new academic year", async () => {
        queueDb(
            [currentYear],
            [],
            [
                { id: 1, name: "Form I", academicYearId: null, teacherId: USERS.teacher.id },
                { id: 2, name: "Form II", academicYearId: 8, teacherId: USERS.teacher.id },
            ],
            [{ classId: 1 }, { classId: 2 }],
        );
        const response = await call("GET", "/api/portal-context", { as: USERS.student });
        expect(response.status).toBe(200);
        expect(response.body.data.available.map((item: { id: number }) => item.id)).toEqual([2]);
        expect(response.body.data.stages).toEqual(["form_ii"]);
    });
});

describe("academic-year activation", () => {
    const path = "/api/grades/academic-years/7/activate";

    it("is restricted to administrators", async () => {
        expect((await call("PATCH", path)).status).toBe(401);
        expect((await call("PATCH", path, { as: USERS.teacher })).status).toBe(403);
    });

    it("activates a configured year only within its dates", async () => {
        queueDb([{ id: 7, name: "Future", startsOn: "2099-01-01", endsOn: "2099-12-31" }]);
        expect((await call("PATCH", path, { as: USERS.admin })).status).toBe(400);
        queueDb([{ id: 7, name: "Current", startsOn: "2000-01-01", endsOn: "2099-12-31" }]);
        expect((await call("PATCH", path, { as: USERS.admin })).status).toBe(200);
    });

    it("creates a future year without making it current", async () => {
        const future = { name: "2099/2100", startsOn: "2099-01-01", endsOn: "2099-12-31" };
        expect((await call("POST", "/api/grades/academic-years", { as: USERS.admin, body: { ...future, active: true } })).status).toBe(400);
        expect((await call("POST", "/api/grades/academic-years", { as: USERS.admin, body: { ...future, active: false } })).status).toBe(201);
    });

    it("requires calendar-year academic dates", async () => {
        const invalid = { name: "2099/2100", startsOn: "2099-01-02", endsOn: "2099-12-31", active: false };
        expect((await call("POST", "/api/grades/academic-years", { as: USERS.admin, body: invalid })).status).toBe(400);
    });
});
