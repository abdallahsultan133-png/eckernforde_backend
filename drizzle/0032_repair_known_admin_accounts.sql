-- Repair the two existing staff accounts after the role split.
--
-- 0031 contained the original mail.com address, but the live account used by
-- the school is the gmail.com address.  Keep this migration idempotent and
-- update only rows that already exist; it must never create an account or a
-- password by itself.
UPDATE "user"
SET "role" = 'secondary_headmaster'
WHERE lower("email") IN (
    lower('abdallahsultan003@gmail.com'),
    lower('abdallahsultan003@mail.com')
);

UPDATE "user"
SET "role" = 'super_admin'
WHERE lower("email") = lower('abdallahsultan133@gmail.com');
