ALTER TABLE "exams"
  ADD COLUMN IF NOT EXISTS "exam_type" varchar(20) NOT NULL DEFAULT 'midterm';

ALTER TABLE "exams"
  ADD CONSTRAINT "exams_exam_type_check" CHECK ("exam_type" IN ('midterm', 'annual'));
