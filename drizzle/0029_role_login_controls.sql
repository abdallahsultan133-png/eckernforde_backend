ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "teachers_enabled" boolean NOT NULL DEFAULT true;
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "students_parents_enabled" boolean NOT NULL DEFAULT true;
