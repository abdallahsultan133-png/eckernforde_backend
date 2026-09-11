-- Formal academic results are separate from legacy class_grades.  This keeps
-- Midterm/Terminal subject results and secondary Division calculations free of
-- assignment weighting and GPA concepts.  Written idempotently because this
-- project has historical drizzle-kit push migrations.

DO $$ BEGIN
	CREATE TYPE "public"."school_level" AS ENUM('nursery', 'primary', 'secondary');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."academic_term_type" AS ENUM('midterm', 'terminal');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

ALTER TABLE "classes" ADD COLUMN IF NOT EXISTS "school_level" "school_level";--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "academic_years" (
	"id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
	"name" varchar(30) NOT NULL,
	"starts_on" text NOT NULL,
	"ends_on" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "academic_years_name_unique" UNIQUE("name")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "academic_terms" (
	"id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
	"academic_year_id" integer NOT NULL,
	"name" varchar(80) NOT NULL,
	"type" "academic_term_type" NOT NULL,
	"starts_on" text NOT NULL,
	"ends_on" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "academic_terms_year_name_unique" UNIQUE("academic_year_id", "name"),
	CONSTRAINT "academic_terms_academic_year_id_academic_years_id_fk" FOREIGN KEY ("academic_year_id") REFERENCES "public"."academic_years"("id") ON DELETE restrict ON UPDATE no action
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "term_subject_results" (
	"id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
	"academic_term_id" integer NOT NULL,
	"class_id" integer NOT NULL,
	"subject_id" integer NOT NULL,
	"student_id" text NOT NULL,
	"school_level" "school_level" NOT NULL,
	"score" integer NOT NULL,
	"applicable" boolean DEFAULT true NOT NULL,
	"entered_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "term_subject_results_term_class_student_unique" UNIQUE("academic_term_id", "class_id", "student_id"),
	CONSTRAINT "term_subject_results_academic_term_id_academic_terms_id_fk" FOREIGN KEY ("academic_term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "term_subject_results_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "term_subject_results_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "term_subject_results_student_id_user_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "term_subject_results_entered_by_user_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "term_subject_results_score_range" CHECK ("score" >= 0 AND "score" <= 100)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "academic_terms_year_id_idx" ON "academic_terms" USING btree ("academic_year_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "term_subject_results_term_student_idx" ON "term_subject_results" USING btree ("academic_term_id", "student_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "term_subject_results_class_id_idx" ON "term_subject_results" USING btree ("class_id");
