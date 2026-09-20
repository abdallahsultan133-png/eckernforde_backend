-- Some adopted databases replaced the writable submissions table with a
-- compatibility view. Students submit work through this relation, so restore
-- the table contract while preserving any rows exposed by the legacy view.
DO $$
DECLARE
    relation_kind "char";
BEGIN
    SELECT c.relkind
    INTO relation_kind
    FROM pg_class c
    INNER JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'submissions';

    IF relation_kind = 'v' THEN
        CREATE TABLE "submissions_repair" (
            "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            "assignment_id" integer NOT NULL REFERENCES "assignments"("id") ON DELETE CASCADE,
            "student_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
            "content" text,
            "file_url" text,
            "file_cld_pub_id" text,
            "file_name" text,
            "status" "submission_status" DEFAULT 'submitted' NOT NULL,
            "score" integer,
            "feedback" text,
            "graded_by" text REFERENCES "user"("id") ON DELETE SET NULL,
            "graded_at" timestamp,
            "submitted_at" timestamp DEFAULT now() NOT NULL,
            "ai_score" integer,
            "ai_summary" text,
            "created_at" timestamp DEFAULT now() NOT NULL,
            "updated_at" timestamp DEFAULT now() NOT NULL,
            CONSTRAINT "submissions_assignment_id_student_id_unique" UNIQUE("assignment_id", "student_id")
        );

        INSERT INTO "submissions_repair" (
            "id", "assignment_id", "student_id", "content", "file_url", "file_cld_pub_id", "file_name",
            "status", "score", "feedback", "graded_by", "graded_at", "submitted_at", "ai_score", "ai_summary",
            "created_at", "updated_at"
        ) OVERRIDING SYSTEM VALUE
        SELECT
            "id", "assignment_id", "student_id", "content", "file_url", "file_cld_pub_id", "file_name",
            "status"::"submission_status", "score", "feedback", "graded_by", "graded_at", "submitted_at", "ai_score", "ai_summary",
            "created_at", "updated_at"
        FROM "submissions";

        ALTER VIEW "submissions" RENAME TO "submissions_legacy_view";
        ALTER TABLE "submissions_repair" RENAME TO "submissions";
        CREATE INDEX "submissions_assignment_id_idx" ON "submissions" ("assignment_id");
        CREATE INDEX "submissions_student_id_idx" ON "submissions" ("student_id");

        EXECUTE format(
            'ALTER TABLE "submissions" ALTER COLUMN "id" RESTART WITH %s',
            COALESCE((SELECT max("id") + 1 FROM "submissions"), 1)
        );
    END IF;
END $$;
