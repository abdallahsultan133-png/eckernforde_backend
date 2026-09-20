require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const assignments = await pool.query("select id, title, description, due_at, max_score, created_at from assignments where class_id = $1 order by created_at", [6]);
  const submissions = await pool.query("select s.assignment_id, s.student_id, s.status, s.score from submissions s join assignments a on a.id = s.assignment_id where a.class_id = $1", [6]);
  const grades = await pool.query("select class_id, student_id, final_grade, letter_grade from class_grades where class_id = $1", [6]);
  console.log(JSON.stringify({ assignments: assignments.rows, submissions: submissions.rows, grades: grades.rows }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
