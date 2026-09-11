ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcements_public_created_at_idx" ON "announcements" USING btree ("is_public", "created_at");
