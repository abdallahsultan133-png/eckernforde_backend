import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";

/**
 * Best-effort session lookup that never rejects the request. Runs globally,
 * ahead of securityMiddleware, so role-based rate limiting sees the real
 * caller instead of always falling back to the "guest" tier. Routes that
 * actually require auth still enforce it themselves via requireAuth.
 */
export const resolveSession = async (req: Request, res: Response, next: NextFunction) => {
    // Better Auth resolves its own session for /api/auth routes. Looking it up
    // here first made an email sign-in perform two database operations before
    // a session even exists. When a hosted database is waking up or a pooled
    // connection was briefly interrupted, that extra lookup could make the
    // first login fail while an immediate retry succeeded.
    if (req.path.startsWith("/api/auth/")) {
        return next();
    }

    try {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
        if (session?.user) {
            const role = (session.user as { role?: UserRoles }).role;
            let portalArchive: { academicYearId: number; schoolBand: "primary" | "secondary"; stage: string } | undefined;
            const archiveCookie = req.headers.cookie
                ?.split(";")
                .map((part) => part.trim())
                .find((part) => part.startsWith("academix_teacher_archive="))
                ?.slice("academix_teacher_archive=".length);
            if (archiveCookie && role === "teacher") {
                try {
                    const parsed = JSON.parse(decodeURIComponent(archiveCookie)) as {
                        userId?: string; academicYearId?: number; schoolBand?: string; stage?: string;
                    };
                    if (parsed.userId === session.user.id
                        && Number.isInteger(parsed.academicYearId)
                        && (parsed.schoolBand === "primary" || parsed.schoolBand === "secondary")
                        && typeof parsed.stage === "string") {
                        portalArchive = {
                            academicYearId: parsed.academicYearId!,
                            schoolBand: parsed.schoolBand,
                            stage: parsed.stage,
                        };
                    }
                } catch {
                    // Ignore a malformed archive cookie. The normal current
                    // portal remains available and the next archive selection
                    // replaces the invalid value.
                }
            }
            req.user = {
                id: session.user.id,
                name: session.user.name,
                email: session.user.email,
                ...(role ? { role } : {}),
                ...(portalArchive ? { portalArchive } : {}),
            };
            if (portalArchive && ["GET", "HEAD"].includes(req.method)) {
                if (req.query.academicYearId === undefined) req.query.academicYearId = String(portalArchive.academicYearId);
                if (req.query.stage === undefined) req.query.stage = portalArchive.stage;
            }

            const archiveContextAction = req.path.endsWith("/portal-context/teacher-history/open")
                || req.path.endsWith("/portal-context/teacher-history/close");
            if (portalArchive && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !archiveContextAction) {
                return res.status(409).json({
                    error: "Previous academic years are read-only. Return to the current year before making changes.",
                    message: "Previous academic years are read-only. Return to the current year before making changes.",
                });
            }
        }
    } catch (e) {
        console.error("resolveSession error:", e);
    }
    next();
};
