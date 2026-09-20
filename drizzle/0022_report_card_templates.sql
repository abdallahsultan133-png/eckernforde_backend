-- Older databases already have report_card_templates with the original
-- headteacher/comment fields. Extend that table in place so existing settings
-- remain usable by the new live template editor.
ALTER TABLE "report_card_templates" ADD COLUMN IF NOT EXISTS "name" varchar(120);
ALTER TABLE "report_card_templates" ADD COLUMN IF NOT EXISTS "school_name" varchar(255);
ALTER TABLE "report_card_templates" ADD COLUMN IF NOT EXISTS "school_address" text;
ALTER TABLE "report_card_templates" ADD COLUMN IF NOT EXISTS "headmaster_name" varchar(255);
ALTER TABLE "report_card_templates" ADD COLUMN IF NOT EXISTS "headmaster_signature" text;
ALTER TABLE "report_card_templates" ADD COLUMN IF NOT EXISTS "logo_url" text;
ALTER TABLE "report_card_templates" ADD COLUMN IF NOT EXISTS "accent_color" varchar(7) DEFAULT '#0f4c5c';
ALTER TABLE "report_card_templates" ADD COLUMN IF NOT EXISTS "show_remarks" boolean DEFAULT true;
ALTER TABLE "report_card_templates" ADD COLUMN IF NOT EXISTS "show_division" boolean DEFAULT true;
ALTER TABLE "report_card_templates" ADD COLUMN IF NOT EXISTS "updated_by" text REFERENCES "user"("id") ON DELETE SET NULL;

UPDATE "report_card_templates"
SET "name" = COALESCE("name", 'Official school report card'),
    "school_name" = COALESCE("school_name", 'Academix School'),
    "headmaster_name" = COALESCE("headmaster_name", "headteacher_name"),
    "accent_color" = COALESCE("accent_color", '#0f4c5c'),
    "show_remarks" = COALESCE("show_remarks", "show_headteacher_comment", true),
    "show_division" = COALESCE("show_division", true);

ALTER TABLE "report_card_templates" ALTER COLUMN "name" SET NOT NULL;
ALTER TABLE "report_card_templates" ALTER COLUMN "school_name" SET NOT NULL;
ALTER TABLE "report_card_templates" ALTER COLUMN "accent_color" SET NOT NULL;
ALTER TABLE "report_card_templates" ALTER COLUMN "accent_color" SET DEFAULT '#0f4c5c';
ALTER TABLE "report_card_templates" ALTER COLUMN "show_remarks" SET NOT NULL;
ALTER TABLE "report_card_templates" ALTER COLUMN "show_remarks" SET DEFAULT true;
ALTER TABLE "report_card_templates" ALTER COLUMN "show_division" SET NOT NULL;
ALTER TABLE "report_card_templates" ALTER COLUMN "show_division" SET DEFAULT true;
--> statement-breakpoint
INSERT INTO "report_card_templates" ("school_id", "name", "school_name", "school_address", "headmaster_name", "headmaster_signature")
SELECT (SELECT min("id") FROM "schools"), 'Official school report card', 'Academix School', '', '', ''
WHERE NOT EXISTS (SELECT 1 FROM "report_card_templates")
  AND EXISTS (SELECT 1 FROM "schools");
