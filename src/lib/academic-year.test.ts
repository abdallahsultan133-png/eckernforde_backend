import { describe, expect, it } from "vitest";
import { academicYearForDate } from "./academic-year.js";

describe("academic year rollover", () => {
    const legacy = { id: 1, startsOn: "2000-08-01", endsOn: "2099-07-31", active: false };
    const year2026 = { id: 2, startsOn: "2026-01-01", endsOn: "2026-12-31", active: true };
    const year2027 = { id: 3, startsOn: "2027-01-01", endsOn: "2027-12-31", active: true };

    it("uses the active school year instead of an overlapping legacy range", () => {
        expect(academicYearForDate([legacy, year2026], "2026-09-14")?.id).toBe(2);
    });

    it("requires the next year to be activated after the previous year closes", () => {
        expect(academicYearForDate([legacy, year2026], "2027-01-01")).toBeNull();
    });

    it("moves to the preconfigured next year on January 1", () => {
        expect(academicYearForDate([legacy, year2026, year2027], "2027-01-01")?.id).toBe(3);
    });

    it("never reopens a past year merely because its dates overlap", () => {
        expect(academicYearForDate([{ ...legacy, active: true }, year2026], "2026-09-14")?.id).toBe(2);
        expect(academicYearForDate([legacy, { ...year2026, active: false }], "2026-09-14")).toBeNull();
    });
});
