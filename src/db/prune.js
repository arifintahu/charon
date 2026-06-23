import { db } from './connection.js';
import { logger } from '../log.js';

const log = logger('prune');
const DAY = 86_400_000;

// Days kept per table. The firehose tables (candidates, decision_logs, llm_*) carry big JSON
// blobs and are mirrored to Postgres for analytics — locally only the last few hours matter
// (signal dedup ~10m, SL cooldown 60m, re-entry guard 6h), so they're trimmed hard. Live trading
// state — dry_run_positions, settings, strategies, trade_intents, tp_sl_rules, learning_* — is
// never pruned. Tune the default with DB_PRUNE_RETAIN_DAYS (e.g. =1 if blobs are large + recent).
const RETAIN_DAYS = Math.max(1, Number(process.env.DB_PRUNE_RETAIN_DAYS) || 3);
const VACUUM_ENABLED = process.env.DB_PRUNE_VACUUM !== 'false';

const PLAN = [
  { table: 'candidates', column: 'created_at_ms', days: RETAIN_DAYS },
  { table: 'decision_logs', column: 'at_ms', days: RETAIN_DAYS },
  { table: 'llm_decisions', column: 'created_at_ms', days: RETAIN_DAYS },
  { table: 'llm_batches', column: 'created_at_ms', days: RETAIN_DAYS },
  { table: 'alerts', column: 'sent_at_ms', days: RETAIN_DAYS },
  { table: 'dry_run_trades', column: 'at_ms', days: 7 },
];

function deleteOlderThan(table, column, cutoff) {
  try {
    return db.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff).changes;
  } catch (err) {
    log.warn(`prune ${table} failed: ${err.message}`);
    return 0;
  }
}

// DELETE-only: fast, short locks, safe to run while trading. Frees pages for reuse so the file
// stops growing; the on-disk size is reclaimed separately by vacuumIfBloated() at boot.
export function pruneDatabase() {
  const now = Date.now();
  let total = 0;
  for (const { table, column, days } of PLAN) {
    const n = deleteOlderThan(table, column, now - days * DAY);
    if (n) { total += n; log.info(`pruned ${n} rows from ${table} (>${days}d)`); }
  }
  // price alerts: drop triggered/cancelled past retention and anything expired; keep active pending.
  try {
    const n = db.prepare("DELETE FROM price_alerts WHERE (status != 'pending' AND created_at_ms < ?) OR expires_at_ms < ?")
      .run(now - RETAIN_DAYS * DAY, now).changes;
    if (n) { total += n; log.info(`pruned ${n} price_alerts`); }
  } catch (err) { log.warn(`prune price_alerts failed: ${err.message}`); }
  // drained outbox rows only — never touch pending (synced_at_ms IS NULL) or the unsynced backlog is lost.
  try {
    const n = db.prepare('DELETE FROM sync_outbox WHERE synced_at_ms IS NOT NULL AND synced_at_ms < ?')
      .run(now - DAY).changes;
    if (n) { total += n; log.info(`pruned ${n} drained outbox rows`); }
  } catch (err) { log.warn(`prune sync_outbox failed: ${err.message}`); }
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
  log.info(`prune complete — ${total} rows removed (retain ${RETAIN_DAYS}d)`);
  return total;
}

// Reclaim file space when many pages are free (e.g. right after the first big prune). VACUUM
// rewrites and exclusively locks the whole DB, so this runs ONLY at boot before trading starts —
// never on the daily timer. Disable with DB_PRUNE_VACUUM=false.
export function vacuumIfBloated() {
  if (!VACUUM_ENABLED) return;
  try {
    const pageSize = db.pragma('page_size', { simple: true });
    const pageCount = db.pragma('page_count', { simple: true });
    const freelist = db.pragma('freelist_count', { simple: true });
    const freeRatio = pageCount ? freelist / pageCount : 0;
    if (freelist < 20_000 && freeRatio < 0.2) return; // not enough free space to justify the lock
    const beforeMb = Math.round(pageCount * pageSize / 1e6);
    log.info(`vacuuming — ${freelist}/${pageCount} pages free (~${beforeMb}MB on disk), this blocks briefly...`);
    db.exec('VACUUM');
    const afterMb = Math.round(db.pragma('page_count', { simple: true }) * pageSize / 1e6);
    log.info(`vacuum done — ${beforeMb}MB -> ${afterMb}MB`);
  } catch (err) {
    log.warn(`vacuum failed: ${err.message}`);
  }
}
