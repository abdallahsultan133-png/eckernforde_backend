-- Existing legacy rows may still need administrative classification. NOT VALID
-- leaves those rows intact while rejecting every new or edited class without
-- the school level and academic year required for publishable results.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'classes_reporting_context_required'
          AND conrelid = 'public.classes'::regclass
    ) THEN
        ALTER TABLE "classes"
            ADD CONSTRAINT "classes_reporting_context_required"
            CHECK ("school_level" IS NOT NULL AND "academic_year_id" IS NOT NULL) NOT VALID;
    END IF;
END $$;
