-- Teachers could create a Form class without a school level because the class
-- creation API ignored the level for that role. Those classes were then absent
-- from headmaster approvals and formal student reports despite saved exam marks.
-- Only classify names that unambiguously identify a secondary form.
UPDATE "classes"
SET "school_level" = 'secondary', "updated_at" = now()
WHERE "school_level" IS NULL
  AND lower(trim("name")) ~ '^form[[:space:]_.-]*(iv|iii|ii|i|[1-4])($|[^[:alnum:]])';
