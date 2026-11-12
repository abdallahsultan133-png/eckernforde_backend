-- Replace the broad admin role with school-specific headmaster roles.
-- Existing catalogue data is classified as secondary by migration 0030, so
-- legacy admins are retained as secondary headmasters until a super admin
-- explicitly assigns an account to primary headmaster. Converting the column
-- to text first keeps this migration safe inside Drizzle's transaction even on
-- PostgreSQL versions that cannot use a newly-added enum value immediately.
ALTER TABLE "user" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "user" ALTER COLUMN "role" TYPE text USING "role"::text;

UPDATE "user"
SET "role" = 'secondary_headmaster'
WHERE "role" = 'admin';

UPDATE "user"
SET "role" = 'secondary_headmaster'
WHERE lower("email") = lower('abdallahsultan003@mail.com');

DROP TYPE "role";
CREATE TYPE "role" AS ENUM ('student', 'teacher', 'primary_headmaster', 'secondary_headmaster', 'parent', 'super_admin');
ALTER TABLE "user"
    ALTER COLUMN "role" TYPE "role"
    USING "role"::text::"role";
ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'student';
