-- Some adopted databases replaced the writable exam_results table with a
-- compatibility view over assessment_results. The application writes exam
-- marks through exam_results, so restore the table contract while retaining
-- the old view as a named legacy snapshot source.
DO $$
DECLARE
    relation_kind "char";
BEGIN
    SELECT c.relkind
    INTO relation_kind
    FROM pg_class c
    INNER JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'exam_results';

    IF relation_kind = 'v' THEN
        CREATE TABLE "exam_results_repair" (
            "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            "exam_id" integer NOT NULL REFERENCES "exams"("id") ON DELETE CASCADE,
            "student_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
            "score" integer NOT NULL,
            "remarks" text,
            "graded_by" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
            "created_at" timestamp DEFAULT now() NOT NULL,
            "updated_at" timestamp DEFAULT now() NOT NULL,
            CONSTRAINT "exam_results_exam_student_unique" UNIQUE("exam_id", "student_id")
        );

        INSERT INTO "exam_results_repair" ("id", "exam_id", "student_id", "score", "remarks", "graded_by", "created_at", "updated_at")
        OVERRIDING SYSTEM VALUE
        SELECT "id", "exam_id", "student_id", "score", "remarks", "graded_by", "created_at", "updated_at"
        FROM "exam_results";

        ALTER VIEW "exam_results" RENAME TO "exam_results_assessment_view";
        ALTER TABLE "exam_results_repair" RENAME TO "exam_results";
        CREATE INDEX "exam_results_exam_id_idx" ON "exam_results" ("exam_id");
        CREATE INDEX "exam_results_student_id_idx" ON "exam_results" ("student_id");

        EXECUTE format(
            'ALTER TABLE "exam_results" ALTER COLUMN "id" RESTART WITH %s',
            COALESCE((SELECT max("id") + 1 FROM "exam_results"), 1)
        );
    END IF;
END $$;
