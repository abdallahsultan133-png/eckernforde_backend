-- Older deployed databases can be missing subjects.code even when their
-- migration journal reports the original subjects table as applied.
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "code" varchar(50);--> statement-breakpoint
UPDATE "subjects"
SET "code" = 'SUBJECT-' || "id"::text
WHERE "code" IS NULL;--> statement-breakpoint
ALTER TABLE "subjects" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subjects_code_unique" ON "subjects" ("code");
