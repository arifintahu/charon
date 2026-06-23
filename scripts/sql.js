#!/usr/bin/env node
// Read-only SQL against charon.sqlite. Refuses anything that isn't SELECT.
//   node scripts/sql.js "SELECT id, mint, status FROM dry_run_positions ORDER BY id DESC LIMIT 5"

import Database from 'better-sqlite3';
import { DB_PATH } from '../src/config.js';

const sql = process.argv.slice(2).join(' ').trim();
if (!sql) {
  console.error('Usage: node scripts/sql.js "<SELECT ...>"');
  process.exit(2);
}
if (!/^\s*SELECT\b/i.test(sql)) {
  console.error('Only SELECT queries are allowed. Use the bot CLI for writes.');
  process.exit(2);
}

const db = new Database(DB_PATH, { readonly: true });
try {
  const rows = db.prepare(sql).all();
  console.log(JSON.stringify(rows, null, 2));
} catch (err) {
  console.error(`SQL error: ${err.message}`);
  process.exit(1);
}
