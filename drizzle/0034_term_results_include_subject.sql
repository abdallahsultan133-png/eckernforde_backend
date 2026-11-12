ALTER TABLE "term_subject_results"
    DROP CONSTRAINT IF EXISTS "term_subject_results_term_class_student_unique";
--> statement-breakpoint
ALTER TABLE "term_subject_results"
    DROP CONSTRAINT IF EXISTS "term_subject_results_term_class_subject_student_unique";
--> statement-breakpoint
ALTER TABLE "term_subject_results"
    ADD CONSTRAINT "term_subject_results_term_class_subject_student_unique"
    UNIQUE ("academic_term_id", "class_id", "subject_id", "student_id");
