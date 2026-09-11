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
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admissions_enquiries_status_created_idx" ON "admissions_enquiries" USING btree ("status", "created_at");
