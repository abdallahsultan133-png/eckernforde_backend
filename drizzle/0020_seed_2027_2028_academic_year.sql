-- Preconfigure the next January-to-December school year so rollover does not
-- depend on a user remembering to create it on the first day of January.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "academic_years" WHERE "name" = '2027/2028') THEN
    UPDATE "academic_years"
    SET "starts_on" = '2027-01-01',
        "ends_on" = '2027-12-31',
        "active" = true,
        "updated_at" = now()
    WHERE "name" = '2027/2028';
  ELSE
    INSERT INTO "academic_years" ("name", "starts_on", "ends_on", "active")
    VALUES ('2027/2028', '2027-01-01', '2027-12-31', true);
  END IF;
END $$;
