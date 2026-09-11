ALTER TABLE "term_subject_results" ADD COLUMN IF NOT EXISTS "published" boolean DEFAULT false NOT NULL;
