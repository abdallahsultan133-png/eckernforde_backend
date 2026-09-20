-- The school year starts in January. Keep this seed idempotent so a deployment
-- can safely apply it to databases that already contain the row. Some legacy
-- databases do not have the current model's unique(name) constraint, so use an
-- explicit existence check instead of ON CONFLICT.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "academic_years" WHERE "name" = '2026/2027') THEN
    UPDATE "academic_years"
    SET "starts_on" = '2026-01-01',
        "ends_on" = '2026-12-31',
        "active" = true,
        "updated_at" = now()
    WHERE "name" = '2026/2027';
  ELSE
    INSERT INTO "academic_years" ("name", "starts_on", "ends_on", "active")
    VALUES ('2026/2027', '2026-01-01', '2026-12-31', true);
  END IF;
END $$;

-- Match the admin activation workflow: exactly one in-range year is active.
UPDATE "academic_years"
SET "active" = false
WHERE "name" <> '2026/2027';
