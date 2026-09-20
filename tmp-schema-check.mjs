import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const queries = [
  `select n.nspname as schema, c.relname, c.relkind, pg_get_viewdef(c.oid, true) as definition
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relname in ('exam_results', 'exams') order by c.relname`,
  `select table_schema, table_name, table_type from information_schema.tables where table_name = 'exam_results'`,
  `select table_schema, table_name, column_name, data_type from information_schema.columns where table_name = 'exam_results' order by ordinal_position`,
];
for (const query of queries) {
  const result = await pool.query(query);
  console.log(JSON.stringify(result.rows, null, 2));
}
await pool.end();
