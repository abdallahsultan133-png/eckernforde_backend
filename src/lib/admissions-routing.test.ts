import { describe, expect, it } from "vitest";

import { admissionRecipientRole, admissionRecipientRoles, visibleAdmissionStages, type AdmissionStage } from "./admissions-routing.js";

describe("admissions routing", () => {
    it.each([
        ["nursery", "primary_headmaster"],
        ["kindergarten", "primary_headmaster"],
        ["primary", "primary_headmaster"],
        ["secondary", "secondary_headmaster"],
        ["not_sure", "super_admin"],
    ] as const)("sends %s enquiries to %s", (stage, role) => {
        expect(admissionRecipientRole(stage as AdmissionStage)).toBe(role);
        expect(admissionRecipientRoles(stage as AdmissionStage)).toEqual(
            role === "super_admin" ? ["super_admin"] : [role, "super_admin"],
        );
    });

    it("only exposes relevant stages to each headmaster", () => {
        expect(visibleAdmissionStages("primary_headmaster")).toEqual(["nursery", "kindergarten", "primary"]);
        expect(visibleAdmissionStages("secondary_headmaster")).toEqual(["secondary"]);
        expect(visibleAdmissionStages("super_admin")).toBeNull();
        expect(visibleAdmissionStages("teacher")).toEqual([]);
        expect(visibleAdmissionStages(undefined)).toEqual([]);
    });
});
