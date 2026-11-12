declare global {
    namespace Express {
        interface Request {
            user?: {
                id?: string;
                name?: string;
                email?: string;
                role?: UserRoles;
                portalArchive?: {
                    academicYearId: number;
                    schoolBand: "primary" | "secondary";
                    stage: string;
                };
            };
        }
    }
}

export {};
