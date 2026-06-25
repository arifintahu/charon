#!/usr/bin/env node
// One-off: relabel pre-execution guardrail-skip rows that were stamped mode='dry_run'
// by the orchestrator bug (the breaker / reentry / max-positions / not-approved
// logDecisionEvent calls ran before `mode` was resolved, so they fell back to the
// default 'dry_run' regardless of the bot's real trading_mode). The code fix stamps
// the real mode going forward; this backfills the historical rows and re-enqueues
// them so the corrected label syncs to Postgres.
//
//   node scripts/relabel-guardrail-mode.js            # preview only
//   node scripts/relabel-guardrail-mode.js confirm    # apply

import Database from 'better-sqlite3';
import { DB_PATH, POSTGRES_URL } from '../src/config.js';

const AFFECTED_ACTIONS = [
  'entry_skipped_sl_cooldown',
  'entry_skipped_sl_cooldown_armed',
  'entry_skipped_sl_daily_halt',
  'entry_skipped_sl_daily_halt_armed',
  'entry_skipped_reentry_block',
  'entry_skipped_max_positions',
  'entry_not_approved',
  'no_candidate_selected',
];

const apply = process.argv.slice(2).includes('confirm');
const ph = AFFECTED_ACTIONS.map(() => '?').join(',');
const day = ms => new Date(Number(ms)).toISOString().slice(0, 10);

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');

const targetMode = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value || 'dry_run';
if (targetMode === 'dry_run') {
  console.log("trading_mode is 'dry_run' — guardrail skips are already correctly labeled. Nothing to relabel.");
  process.exit(0);
}

const preview = db.prepare(`
  SELECT action, COUNT(*) AS n, MIN(at_ms) AS first_ms, MAX(at_ms) AS last_ms
  FROM decision_logs
  WHERE mode = 'dry_run' AND action IN (${ph})
  GROUP BY action ORDER BY n DESC
`).all(...AFFECTED_ACTIONS);

const total = preview.reduce((s, r) => s + r.n, 0);
if (!total) {
  console.log("No mislabeled guardrail rows found (mode='dry_run' for the affected actions). Nothing to do.");
  process.exit(0);
}

console.log(`Mislabeled guardrail rows (mode='dry_run' → '${targetMode}'):`);
for (const r of preview) console.log(`  ${r.action.padEnd(34)} ${String(r.n).padStart(5)}   ${day(r.first_ms)} … ${day(r.last_ms)}`);
console.log(`  ${'TOTAL'.padEnd(34)} ${String(total).padStart(5)}`);

if (!apply) {
  console.log('\n(dry preview — re-run with `confirm` to apply)');
  process.exit(0);
}

const relabel = db.transaction(() => {
  const ids = db.prepare(`SELECT id FROM decision_logs WHERE mode = 'dry_run' AND action IN (${ph})`).all(...AFFECTED_ACTIONS).map(r => r.id);
  const res = db.prepare(`UPDATE decision_logs SET mode = ? WHERE mode = 'dry_run' AND action IN (${ph})`).run(targetMode, ...AFFECTED_ACTIONS);
  let enqueued = 0;
  if (POSTGRES_URL) {
    const enq = db.prepare("INSERT INTO sync_outbox (table_name, local_id, enqueued_at_ms) VALUES ('decision_logs', ?, ?)");
    const now = Date.now();
    for (const id of ids) { enq.run(id, now); enqueued++; }
  }
  return { updated: res.changes, enqueued };
})();

console.log(`\nUpdated ${relabel.updated} rows to mode='${targetMode}'.`);
console.log(POSTGRES_URL
  ? `Re-enqueued ${relabel.enqueued} rows to sync_outbox — Postgres updates on the next sync.`
  : 'POSTGRES_URL unset — SQLite updated; no Postgres re-sync needed.');
