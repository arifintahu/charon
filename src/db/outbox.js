import { db } from './connection.js';
import { POSTGRES_URL } from '../config.js';

const enqueueStmt = db.prepare(`
  INSERT INTO sync_outbox (table_name, local_id, enqueued_at_ms)
  VALUES (?, ?, ?)
`);

export function enqueueSync(tableName, localId) {
  if (!POSTGRES_URL) return;
  if (localId === null || localId === undefined) return;
  enqueueStmt.run(tableName, Number(localId), Date.now());
}

export function pendingOutboxCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM sync_outbox WHERE synced_at_ms IS NULL').get().n;
}

export function nextOutboxBatch(limit) {
  return db.prepare(`
    SELECT * FROM sync_outbox
    WHERE synced_at_ms IS NULL AND next_attempt_at_ms <= ?
    ORDER BY id ASC
    LIMIT ?
  `).all(Date.now(), limit);
}

export function markOutboxSynced(ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE sync_outbox SET synced_at_ms = ? WHERE id IN (${placeholders})`).run(Date.now(), ...ids);
}

export function markOutboxFailure(id, error) {
  const next = Date.now() + Math.min(60_000, 1000 * Math.pow(2, Math.min(8, 1)));
  db.prepare(`
    UPDATE sync_outbox
    SET retry_count = retry_count + 1,
        next_attempt_at_ms = ?,
        last_error = ?
    WHERE id = ?
  `).run(next, String(error).slice(0, 500), id);
}

export function backoffOutboxBatch(ids, error) {
  if (!ids.length) return;
  const stmt = db.prepare(`
    UPDATE sync_outbox
    SET retry_count = retry_count + 1,
        next_attempt_at_ms = ?,
        last_error = ?
    WHERE id = ?
  `);
  const message = String(error).slice(0, 500);
  for (const id of ids) {
    const row = db.prepare('SELECT retry_count FROM sync_outbox WHERE id = ?').get(id);
    const retries = (row?.retry_count ?? 0) + 1;
    const delay = Math.min(5 * 60_000, 1000 * Math.pow(2, Math.min(8, retries)));
    stmt.run(Date.now() + delay, message, id);
  }
}

export function pruneSyncedOutbox(maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  return db.prepare('DELETE FROM sync_outbox WHERE synced_at_ms IS NOT NULL AND synced_at_ms < ?').run(cutoff).changes;
}
