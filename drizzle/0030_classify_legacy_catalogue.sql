-- Classes created before school-level classification was introduced are the
-- school's existing Form I catalogue. Attach those rows to the secondary
-- catalogue so selecting the current year and secondary school returns the
-- existing classes and their subjects.
UPDATE "classes"
SET "school_level" = 'secondary'
WHERE "school_level" IS NULL
  AND "academic_year_id" IS NOT NULL;
