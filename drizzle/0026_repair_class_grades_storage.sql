-- Some adopted databases replaced class_grades with a compatibility view.
-- The gradebook save endpoint writes final marks through this relation, so
-- restore the writable table contract while preserving existing rows.
DO $$
DECLARE
    relation_kind "char";
BEGIN
    SELECT c.relkind INTO relation_kind
    FROM pg_class c
    INNER JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'class_grades';

    IF relation_kind = 'v' THEN
        CREATE TABLE "class_grades_repair" (
            "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            "class_id" integer NOT NULL REFERENCES "classes"("id") ON DELETE CASCADE,
            "student_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
            "assignment_avg" integer,
            "exam_avg" integer,
            "attendance_rate" integer,
            "final_grade" integer,
            "letter_grade" varchar(4),
            "gpa" text,
            "remarks" text,
            "graded_by" text REFERENCES "user"("id") ON DELETE SET NULL,
            "created_at" timestamp DEFAULT now() NOT NULL,
            "updated_at" timestamp DEFAULT now() NOT NULL,
            CONSTRAINT "class_grades_class_student_unique" UNIQUE("class_id", "student_id")
        );

        INSERT INTO "class_grades_repair" (
            "id", "class_id", "student_id", "assignment_avg", "exam_avg", "attendance_rate",
            "final_grade", "letter_grade", "gpa", "remarks", "graded_by", "created_at", "updated_at"
        ) OVERRIDING SYSTEM VALUE
        SELECT
            "id", "class_id", "student_id", "assignment_avg", "exam_avg", "attendance_rate",
            "final_grade", "letter_grade", "gpa", "remarks", "graded_by", "created_at", "updated_at"
        FROM "class_grades";

        ALTER VIEW "class_grades" RENAME TO "class_grades_legacy_view";
        ALTER TABLE "class_grades_repair" RENAME TO "class_grades";
        CREATE INDEX "class_grades_class_id_idx" ON "class_grades" ("class_id");
        CREATE INDEX "class_grades_student_id_idx" ON "class_grades" ("student_id");

        EXECUTE format(
            'ALTER TABLE "class_grades" ALTER COLUMN "id" RESTART WITH %s',
            COALESCE((SELECT max("id") + 1 FROM "class_grades"), 1)
        );
    END IF;
END $$;
