-- Repair migration for databases adopted from the old push-based schema.
-- Those databases can have the Drizzle journal entry for 0008 while the
-- classes.school_level column was never physically created.
DO $$ BEGIN
	CREATE TYPE "public"."school_level" AS ENUM('nursery', 'primary', 'secondary');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN IF NOT EXISTS "school_level" "school_level";
