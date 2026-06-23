#!/usr/bin/env node
// What's bloating charon.sqlite? Per-table row count + JSON-blob byte weight, read-only.
// Runs from any directory — .env is loaded from the repo root via src/config.js.

import Database from 'better-sqlite3';
import { DB_PATH } from '../src/config.js';

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const JSON_COLS = {
  candidates: ['candidate_json', 'filter_result_json'],
  decision_logs: ['guardrails_json', 'token_json', 'candidate_json', 'batch_json', 'execution_json'],
  llm_decisions: ['risks_json', 'raw_json'],
  llm_batches: ['risks_json', 'raw_json', 'candidate_ids_json'],
  dry_run_positions: ['snapshot_json'],
  dry_run_trades: ['payload_json'],
  price_alerts: ['candidate_json', 'signals_json'],
  alerts: ['payload_json'],
  learning_runs: ['summary_json', 'lessons_json', 'raw_json'],
};

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const rows = [];
for (const t of tables) {
  const n = db.prepare(`SELECT count(*) c FROM ${t}`).get().c;
  let bytes = 0;
  const cols = JSON_COLS[t] || [];
  if (cols.length && n) {
    const expr = cols.map(c => `COALESCE(SUM(LENGTH(${c})),0)`).join('+');
    try { bytes = db.prepare(`SELECT ${expr} b FROM ${t}`).get().b || 0; } catch { bytes = 0; }
  }
  rows.push({ table: t, rows: n, mb: bytes / 1e6 });
}
rows.sort((a, b) => b.mb - a.mb || b.rows - a.rows);

const pageSize = db.pragma('page_size', { simple: true });
const pageCount = db.pragma('page_count', { simple: true });
const freelist = db.pragma('freelist_count', { simple: true });
console.log(`db ${DB_PATH} — ~${Math.round(pageCount * pageSize / 1e6)}MB on disk, ~${Math.round(freelist * pageSize / 1e6)}MB free pages\n`);
console.log(`${'table'.padEnd(22)}${'rows'.padStart(10)}${'jsonMB'.padStart(10)}`);
for (const r of rows) console.log(`${r.table.padEnd(22)}${String(r.rows).padStart(10)}${r.mb.toFixed(1).padStart(10)}`);
