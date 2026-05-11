import pg from 'pg';
import { POSTGRES_URL } from '../config.js';

let pool = null;
let connectAttempted = false;

export function postgresEnabled() {
  return Boolean(POSTGRES_URL);
}

export function pgPool() {
  if (!POSTGRES_URL) return null;
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 4, idleTimeoutMillis: 30_000 });
  pool.on('error', err => console.log(`[pg] pool error: ${err.message}`));
  return pool;
}

export async function pgQuery(text, params = []) {
  const p = pgPool();
  if (!p) throw new Error('POSTGRES_URL is not set');
  return p.query(text, params);
}

export async function pgPing() {
  if (!POSTGRES_URL) return false;
  try {
    await pgQuery('SELECT 1');
    if (!connectAttempted) {
      connectAttempted = true;
      console.log('[pg] connected');
    }
    return true;
  } catch (error) {
    if (!connectAttempted) {
      connectAttempted = true;
      console.log(`[pg] unreachable: ${error.message}`);
    }
    return false;
  }
}

export async function closePostgres() {
  if (!pool) return;
  try { await pool.end(); } catch {}
  pool = null;
}
