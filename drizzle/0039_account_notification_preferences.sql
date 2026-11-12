ALTER TABLE "user"
    ADD COLUMN IF NOT EXISTS "notification_preferences" jsonb NOT NULL DEFAULT '{"inApp":true,"email":true}'::jsonb;
