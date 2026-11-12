export type AdmissionStage = "nursery" | "kindergarten" | "primary" | "secondary" | "not_sure";
export type AdmissionRecipientRole = "primary_headmaster" | "secondary_headmaster" | "super_admin";

const primaryStages: AdmissionStage[] = ["nursery", "kindergarten", "primary"];

export function admissionRecipientRole(stage: AdmissionStage): AdmissionRecipientRole {
    if (stage === "secondary") return "secondary_headmaster";
    if (stage === "not_sure") return "super_admin";
    return "primary_headmaster";
}

export function admissionRecipientRoles(stage: AdmissionStage): AdmissionRecipientRole[] {
    const stageRole = admissionRecipientRole(stage);
    return stageRole === "super_admin" ? ["super_admin"] : [stageRole, "super_admin"];
}

// Super Admins retain oversight of every enquiry; headmasters are restricted
// to the stages belonging to their school level.
export function visibleAdmissionStages(role: string | undefined): AdmissionStage[] | null {
    if (role === "super_admin") return null;
    if (role === "secondary_headmaster") return ["secondary"];
    if (role === "primary_headmaster") return primaryStages;
    return [];
}
