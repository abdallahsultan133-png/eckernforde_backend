import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { systemSettings } from "../db/schema/app.js";

/** Keep the emergency switch cheap to check without making it stale for long. */
let cachedSettings = { enabled: true, teachersEnabled: true, studentsParentsEnabled: true };
let cachedAt = 0;
const CACHE_MS = 5_000;

export const systemStatus = async () => {
  if (Date.now() - cachedAt < CACHE_MS) return cachedSettings;
  const [row] = await db.select({
    enabled: systemSettings.enabled,
    teachersEnabled: systemSettings.teachersEnabled,
    studentsParentsEnabled: systemSettings.studentsParentsEnabled,
  }).from(systemSettings).where(eq(systemSettings.id, 1));
  cachedSettings = {
    enabled: row?.enabled ?? true,
    teachersEnabled: row?.teachersEnabled ?? true,
    studentsParentsEnabled: row?.studentsParentsEnabled ?? true,
  };
  cachedAt = Date.now();
  return cachedSettings;
};

export const invalidateSystemStatus = () => { cachedAt = 0; };

/** Allow the switch endpoint and unauthenticated auth/health requests through. */
export const requireSystemEnabled = async (req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api/system") || req.path === "/healthz" || !req.user || req.user.role === "super_admin") return next();
  try {
    const settings = await systemStatus();
    const role = req.user.role;
    if (!settings.enabled) return res.status(503).json({ error: "System is temporarily offline.", code: "SYSTEM_OFFLINE" });
    if (role === "teacher" && !settings.teachersEnabled) return res.status(403).json({ error: "Teacher login is temporarily disabled.", code: "TEACHER_LOGIN_DISABLED" });
    if ((role === "student" || role === "parent") && !settings.studentsParentsEnabled) return res.status(403).json({ error: "Student and parent login is temporarily disabled.", code: "STUDENT_PARENT_LOGIN_DISABLED" });
    return next();
  } catch {
    return next();
  }
};
