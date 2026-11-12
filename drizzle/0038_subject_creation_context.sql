ALTER TABLE "subjects"
    ADD COLUMN IF NOT EXISTS "creation_academic_year_id" integer REFERENCES "academic_years"("id") ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE "subjects"
    ADD COLUMN IF NOT EXISTS "creation_stage" varchar(30);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "subjects_creation_context_idx"
    ON "subjects" ("creation_academic_year_id", "creation_stage");
--> statement-breakpoint

-- Recover orphan subjects created after the teacher chose a form. Do not
-- guess the context for older subjects or ones already linked to a class.
WITH matching_context AS (
    SELECT s.id AS subject_id, pc.academic_year_id, pc.stage,
           row_number() OVER (PARTITION BY s.id ORDER BY pc.updated_at DESC) AS position
    FROM "subjects" s
    JOIN "portal_contexts" pc ON pc.user_id = s.created_by
    JOIN "academic_years" ay ON ay.id = pc.academic_year_id
    WHERE s.creation_academic_year_id IS NULL
      AND s.created_at >= pc.updated_at
      AND s.created_at::date BETWEEN ay.starts_on::date AND ay.ends_on::date
      AND NOT EXISTS (SELECT 1 FROM "classes" c WHERE c.subject_id = s.id)
)
UPDATE "subjects" s
SET "creation_academic_year_id" = match.academic_year_id,
    "creation_stage" = match.stage
FROM matching_context match
WHERE s.id = match.subject_id AND match.position = 1;
