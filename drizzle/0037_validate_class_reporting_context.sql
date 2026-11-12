-- Fully validate the guard where historical classes have already been
-- classified. Databases with unresolved legacy rows keep the new-write guard
-- from 0036 and can validate after those rows are repaired.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "classes"
        WHERE "school_level" IS NULL OR "academic_year_id" IS NULL
    ) AND EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'classes_reporting_context_required'
          AND conrelid = 'public.classes'::regclass
          AND NOT convalidated
    ) THEN
        ALTER TABLE "classes" VALIDATE CONSTRAINT "classes_reporting_context_required";
    END IF;
END $$;
