-- Existing classes were created before academic-year scoping existed. They
-- are the school's current Form I catalogue, so attach only unassigned rows
-- to the seeded 2026/2027 year. Already classified historical/future classes
-- are left untouched.
UPDATE "classes"
SET "academic_year_id" = (
  SELECT "id" FROM "academic_years" WHERE "name" = '2026/2027'
)
WHERE "academic_year_id" IS NULL
  AND EXISTS (SELECT 1 FROM "academic_years" WHERE "name" = '2026/2027');
