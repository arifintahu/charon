#!/usr/bin/env node
// Read-only SQL against Postgres (POSTGRES_URL). Refuses anything that isn't SELECT.
//   node scripts/pg-sql.js "SELECT id, mint, status FROM dry_run_positions ORDER BY id DESC LIMIT 5"

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error('POSTGRES_URL is not set');
  process.exit(1);
}

const sql = process.argv.slice(2).join(' ').trim();
if (!sql) {
  console.error('Usage: node scripts/pg-sql.js "<SELECT ...>"');
  process.exit(2);
}
if (!/^\s*SELECT\b/i.test(sql)) {
  console.error('Only SELECT queries are allowed.');
  process.exit(2);
}

const pool = new Pool({ connectionString: url });
try {
  const { rows } = await pool.query(sql);
  console.log(JSON.stringify(rows, null, 2));
} catch (err) {
  console.error(`SQL error: ${err.message}`);
  process.exit(1);
} finally {
  await pool.end();
}
