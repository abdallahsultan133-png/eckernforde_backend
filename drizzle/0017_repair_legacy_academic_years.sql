-- Some databases had academic_years before formal results were added. The
-- CREATE TABLE IF NOT EXISTS in 0008/0014 left its legacy column names intact.
-- Preserve those rows and IDs while adding the columns the current API uses.
ALTER TABLE "academic_years" ADD COLUMN IF NOT EXISTS "starts_on" text;
ALTER TABLE "academic_years" ADD COLUMN IF NOT EXISTS "ends_on" text;
ALTER TABLE "academic_years" ADD COLUMN IF NOT EXISTS "active" boolean;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'academic_years' AND column_name = 'start_date'
  ) THEN
    UPDATE "academic_years" SET "starts_on" = "start_date"
    WHERE "starts_on" IS NULL AND "start_date" IS NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'academic_years' AND column_name = 'end_date'
  ) THEN
    UPDATE "academic_years" SET "ends_on" = "end_date"
    WHERE "ends_on" IS NULL AND "end_date" IS NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'academic_years' AND column_name = 'is_current'
  ) THEN
    UPDATE "academic_years" SET "active" = "is_current" WHERE "active" IS NULL;
  END IF;
END $$;
--> statement-breakpoint
-- A missing legacy date requires an administrator to supply the real value;
-- manufacturing a date would make the wrong year appear current.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "academic_years" WHERE "starts_on" IS NULL OR "ends_on" IS NULL) THEN
    RAISE EXCEPTION 'academic_years contains rows without dates; set their real starts_on and ends_on before migrating';
  END IF;
END $$;
--> statement-breakpoint
UPDATE "academic_years" SET "active" = false WHERE "active" IS NULL;
ALTER TABLE "academic_years" ALTER COLUMN "starts_on" SET NOT NULL;
ALTER TABLE "academic_years" ALTER COLUMN "ends_on" SET NOT NULL;
ALTER TABLE "academic_years" ALTER COLUMN "active" SET DEFAULT false;
ALTER TABLE "academic_years" ALTER COLUMN "active" SET NOT NULL;
