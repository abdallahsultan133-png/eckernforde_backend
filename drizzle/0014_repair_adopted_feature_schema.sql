-- Repair feature structures on databases whose old push-based adoption marked
-- additive migrations as complete without applying them. Every statement is
-- idempotent so it is also safe on a fully current database.
DO $$ BEGIN
	CREATE TYPE "public"."school_level" AS ENUM('nursery', 'primary', 'secondary');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."academic_term_type" AS ENUM('midterm', 'terminal');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

ALTER TABLE "classes" ADD COLUMN IF NOT EXISTS "school_level" "school_level";--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "academic_years" (
	"id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
	"name" varchar(30) NOT NULL UNIQUE,
	"starts_on" text NOT NULL,
	"ends_on" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "academic_terms" (
	"id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
	"academic_year_id" integer NOT NULL REFERENCES "academic_years"("id") ON DELETE RESTRICT,
	"name" varchar(80) NOT NULL,
	"type" "academic_term_type" NOT NULL,
	"starts_on" text NOT NULL,
	"ends_on" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "academic_terms_year_name_unique" UNIQUE("academic_year_id", "name")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "term_subject_results" (
	"id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
	"academic_term_id" integer NOT NULL REFERENCES "academic_terms"("id") ON DELETE RESTRICT,
	"class_id" integer NOT NULL REFERENCES "classes"("id") ON DELETE RESTRICT,
	"subject_id" integer NOT NULL REFERENCES "subjects"("id") ON DELETE RESTRICT,
	"student_id" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
	"school_level" "school_level" NOT NULL,
	"score" integer NOT NULL CHECK ("score" >= 0 AND "score" <= 100),
	"applicable" boolean DEFAULT true NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"entered_by" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "term_subject_results_term_class_student_unique" UNIQUE("academic_term_id", "class_id", "student_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "academic_terms_year_id_idx" ON "academic_terms" ("academic_year_id");
CREATE INDEX IF NOT EXISTS "term_subject_results_term_student_idx" ON "term_subject_results" ("academic_term_id", "student_id");
CREATE INDEX IF NOT EXISTS "term_subject_results_class_id_idx" ON "term_subject_results" ("class_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "admissions_enquiries" (
	"id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(30),
	"child_stage" varchar(30) NOT NULL,
	"message" text,
	"consent" boolean DEFAULT false NOT NULL,
	"status" varchar(30) DEFAULT 'new' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "admissions_enquiries_status_created_idx" ON "admissions_enquiries" ("status", "created_at");--> statement-breakpoint

ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT false NOT NULL;
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT false NOT NULL;
ALTER TABLE "term_subject_results" ADD COLUMN IF NOT EXISTS "published" boolean DEFAULT false NOT NULL;
CREATE INDEX IF NOT EXISTS "announcements_public_created_at_idx" ON "announcements" ("is_public", "created_at");
CREATE INDEX IF NOT EXISTS "calendar_events_public_start_at_idx" ON "calendar_events" ("is_public", "start_at");
