import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ queue: [] as unknown[] }));
vi.mock("../db/index.js", () => {
    const chain = (): any => new Proxy(function () {}, {
        get(_target, property) {
            if (property === "then") return (resolve: (value: unknown) => unknown) => Promise.resolve(state.queue.shift() ?? []).then(resolve);
            return () => chain();
        },
    });
    return { db: { select: () => chain() } };
});

const { activePortalClassIds, isInActivePortalClass } = await import("./portal-context.js");
const year = { id: 2, name: "2026/2027", startsOn: "2000-01-01", endsOn: "2099-12-31", active: true };
const classes = [
    { id: 1, name: "Form I", teacherId: "teacher-1", academicYearId: 2 },
    { id: 2, name: "Form II", teacherId: "teacher-1", academicYearId: 2 },
    { id: 3, name: "Form I", teacherId: "teacher-2", academicYearId: 2 },
    { id: 4, name: "Form I", teacherId: "teacher-1", academicYearId: 1 },
    { id: 5, name: "Form I", teacherId: "teacher-1", academicYearId: null },
];

afterEach(() => { state.queue.length = 0; });

describe("selected portal class scope", () => {
    it("limits a teacher to the selected form and their own current-year classes", async () => {
        state.queue.push([year], [{ stage: "form_i" }], classes);
        expect(await activePortalClassIds({ id: "teacher-1", role: "teacher" })).toEqual([1]);
    });

    it("does not fall back to another form when a teacher's selected form has no classes", async () => {
        state.queue.push([year], [{ stage: "form_iv" }], classes);
        expect(await activePortalClassIds({ id: "teacher-1", role: "teacher" })).toEqual([]);
    });

    it("limits a student to enrolled classes in their saved form", async () => {
        state.queue.push([year], [{ stage: "form_i" }], classes, [{ classId: 1 }, { classId: 2 }, { classId: 3 }, { classId: 5 }]);
        expect(await activePortalClassIds({ id: "student-1", role: "student" })).toEqual([1, 3]);
    });

    it("keeps unassigned classes available only in the adopted Legacy year", async () => {
        state.queue.push([{ ...year, id: 6, name: "Legacy" }], [{ stage: "form_i" }], classes);
        expect(await activePortalClassIds({ id: "teacher-1", role: "teacher" })).toEqual([5]);
    });

    it("closes class-scoped access when no year context has been saved", async () => {
        state.queue.push([year], []);
        expect(await activePortalClassIds({ id: "student-1", role: "student" })).toEqual([]);
        state.queue.push([year], []);
        expect(await isInActivePortalClass({ id: "student-1", role: "student" }, 1)).toBe(false);
    });

    it("keeps a teacher's assigned current-year classes available before context setup", async () => {
        state.queue.push([year], [], classes);
        expect(await activePortalClassIds({ id: "teacher-1", role: "teacher" })).toEqual([1, 2]);
    });

    it("closes class-scoped access while the next academic year is not active", async () => {
        state.queue.push([]);
        expect(await activePortalClassIds({ id: "student-1", role: "student" })).toEqual([]);
    });
});
