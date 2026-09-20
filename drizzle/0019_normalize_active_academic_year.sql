-- The seeded 2026/2027 year is the active school year. Keep legacy rows for
-- historical access, but do not leave them active alongside the current year.
UPDATE "academic_years"
SET "active" = false
WHERE "name" <> '2026/2027';
