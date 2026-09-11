ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_public_start_at_idx" ON "calendar_events" USING btree ("is_public", "start_at");
