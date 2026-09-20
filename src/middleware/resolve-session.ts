import type { Request, Response, NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";

/**
 * Best-effort session lookup that never rejects the request. Runs globally,
 * ahead of securityMiddleware, so role-based rate limiting sees the real
 * caller instead of always falling back to the "guest" tier. Routes that
 * actually require auth still enforce it themselves via requireAuth.
 */
export const resolveSession = async (req: Request, _res: Response, next: NextFunction) => {
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
            req.user = {
                id: session.user.id,
                name: session.user.name,
                email: session.user.email,
                ...(role ? { role } : {}),
            };
        }
    } catch (e) {
        console.error("resolveSession error:", e);
    }
    next();
};
