-- The active school year must have both formal report sections available.
-- Older data may contain only Annual/Terminal terms while teachers already
-- entered Midterm exams; seed the missing Midterm term without duplicating an
-- existing setup.
INSERT INTO "academic_terms" ("academic_year_id", "name", "type", "starts_on", "ends_on")
SELECT
    ay."id",
    'Midterm',
    'midterm',
    ay."starts_on",
    LEAST(ay."ends_on"::date, ay."starts_on"::date + INTERVAL '6 months')::date::text
FROM "academic_years" ay
WHERE ay."active" = true
  AND NOT EXISTS (
      SELECT 1
      FROM "academic_terms" existing
      WHERE existing."academic_year_id" = ay."id"
        AND existing."type" = 'midterm'
  );
