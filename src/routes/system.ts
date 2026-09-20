import express from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { systemSettings } from "../db/schema/app.js";
import { requireAuth, requireRole } from "../middleware/require-auth.js";
import { invalidateSystemStatus } from "../middleware/system-status.js";

const router = express.Router();

router.get("/status", requireAuth, async (_req, res) => {
  const [row] = await db.select({
    enabled: systemSettings.enabled,
    teachersEnabled: systemSettings.teachersEnabled,
    studentsParentsEnabled: systemSettings.studentsParentsEnabled,
  }).from(systemSettings).where(eq(systemSettings.id, 1));
  res.json({ data: {
    enabled: row?.enabled ?? true,
    teachersEnabled: row?.teachersEnabled ?? true,
    studentsParentsEnabled: row?.studentsParentsEnabled ?? true,
  } });
});

router.patch("/status", requireAuth, requireRole("super_admin"), async (req, res) => {
  const body = req.body ?? {};
  const changes = {
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    ...(typeof body.teachersEnabled === "boolean" ? { teachersEnabled: body.teachersEnabled } : {}),
    ...(typeof body.studentsParentsEnabled === "boolean" ? { studentsParentsEnabled: body.studentsParentsEnabled } : {}),
  };
  if (Object.keys(changes).length === 0) return res.status(400).json({ error: "Provide a valid system access setting." });
  const [row] = await db.insert(systemSettings).values({ id: 1, updatedBy: req.user!.id, ...changes })
    .onConflictDoUpdate({ target: systemSettings.id, set: { ...changes, updatedBy: req.user!.id } })
    .returning({ enabled: systemSettings.enabled, teachersEnabled: systemSettings.teachersEnabled, studentsParentsEnabled: systemSettings.studentsParentsEnabled });
  invalidateSystemStatus();
  res.json({ data: row });
});

export default router;
