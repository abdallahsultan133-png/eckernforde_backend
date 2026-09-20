-- Academic context is explicit so a portal session can be scoped to the
-- selected academic year and stage rather than relying on client state.
ALTER TABLE "classes" ADD COLUMN IF NOT EXISTS "academic_year_id" integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "classes" ADD CONSTRAINT "classes_academic_year_id_academic_years_id_fk"
    FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "classes_academic_year_id_idx" ON "classes" USING btree ("academic_year_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_contexts" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "academic_year_id" integer NOT NULL REFERENCES "academic_years"("id") ON DELETE RESTRICT,
  "school_band" varchar(20) NOT NULL,
  "stage" varchar(30) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "portal_contexts_user_year_unique" UNIQUE("user_id", "academic_year_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_contexts_user_id_idx" ON "portal_contexts" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_contexts_academic_year_id_idx" ON "portal_contexts" USING btree ("academic_year_id");
