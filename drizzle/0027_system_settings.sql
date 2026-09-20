CREATE TABLE IF NOT EXISTS "system_settings" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "updated_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
INSERT INTO "system_settings" ("id", "enabled") VALUES (1, true)
ON CONFLICT ("id") DO NOTHING;
