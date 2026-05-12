import { POSTGRES_URL, POSTGRES_SYNC_INTERVAL_MS, POSTGRES_SYNC_BATCH_SIZE, CHARON_MACHINE_LABEL } from '../config.js';
import { db } from '../db/connection.js';
import { pgPool, pgQuery, pgPing, postgresEnabled, closePostgres } from '../db/postgres.js';
import { machineId } from '../db/machineId.js';
import { nextOutboxBatch, markOutboxSynced, backoffOutboxBatch, pruneSyncedOutbox } from '../db/outbox.js';
import { safeJson } from '../utils.js';
import { logger } from '../log.js';

const log = logger('sync');

function parseJson(text, fallback = null) {
  let value;
  if (text === null || text === undefined) value = fallback;
  else if (typeof text === 'object') value = text;
  else value = safeJson(text, fallback);
  return JSON.stringify(value === undefined ? null : value);
}

const TABLES = {
  signal_events: {
    select: 'SELECT * FROM signal_events WHERE id = ?',
    transform: (row, mid) => [
      mid, row.id, row.mint, row.kind, row.at_ms, row.source, parseJson(row.payload_json, {}),
    ],
    upsert: `
      INSERT INTO signal_events (machine_id, local_id, mint, kind, at_ms, source, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (machine_id, local_id) DO UPDATE SET
        mint = EXCLUDED.mint, kind = EXCLUDED.kind, at_ms = EXCLUDED.at_ms,
        source = EXCLUDED.source, payload = EXCLUDED.payload, synced_at = now()
    `,
  },
  candidates: {
    select: 'SELECT * FROM candidates WHERE id = ?',
    transform: (row, mid) => [
      mid, row.id, row.mint, row.status, row.created_at_ms, row.updated_at_ms,
      row.signature, row.signal_key,
      parseJson(row.candidate_json, {}), parseJson(row.filter_result_json, {}),
    ],
    upsert: `
      INSERT INTO candidates (machine_id, local_id, mint, status, created_at_ms, updated_at_ms,
        signature, signal_key, candidate, filter_result)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (machine_id, local_id) DO UPDATE SET
        mint = EXCLUDED.mint, status = EXCLUDED.status,
        created_at_ms = EXCLUDED.created_at_ms, updated_at_ms = EXCLUDED.updated_at_ms,
        signature = EXCLUDED.signature, signal_key = EXCLUDED.signal_key,
        candidate = EXCLUDED.candidate, filter_result = EXCLUDED.filter_result,
        synced_at = now()
    `,
  },
  llm_decisions: {
    select: 'SELECT * FROM llm_decisions WHERE id = ?',
    transform: (row, mid) => [
      mid, row.id, row.candidate_id, row.mint, row.created_at_ms, row.verdict,
      row.confidence, row.reason, parseJson(row.risks_json, []), parseJson(row.raw_json, {}),
    ],
    upsert: `
      INSERT INTO llm_decisions (machine_id, local_id, candidate_local_id, mint, created_at_ms,
        verdict, confidence, reason, risks, raw)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (machine_id, local_id) DO UPDATE SET
        candidate_local_id = EXCLUDED.candidate_local_id, mint = EXCLUDED.mint,
        created_at_ms = EXCLUDED.created_at_ms, verdict = EXCLUDED.verdict,
        confidence = EXCLUDED.confidence, reason = EXCLUDED.reason,
        risks = EXCLUDED.risks, raw = EXCLUDED.raw, synced_at = now()
    `,
  },
  llm_batches: {
    select: 'SELECT * FROM llm_batches WHERE id = ?',
    transform: (row, mid) => [
      mid, row.id, row.created_at_ms, row.trigger_candidate_id, row.selected_candidate_id,
      row.selected_mint, row.verdict, row.confidence, row.reason,
      parseJson(row.risks_json, []), parseJson(row.raw_json, {}), parseJson(row.candidate_ids_json, []),
    ],
    upsert: `
      INSERT INTO llm_batches (machine_id, local_id, created_at_ms, trigger_candidate_local_id,
        selected_candidate_local_id, selected_mint, verdict, confidence, reason, risks, raw,
        candidate_local_ids)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (machine_id, local_id) DO UPDATE SET
        created_at_ms = EXCLUDED.created_at_ms,
        trigger_candidate_local_id = EXCLUDED.trigger_candidate_local_id,
        selected_candidate_local_id = EXCLUDED.selected_candidate_local_id,
        selected_mint = EXCLUDED.selected_mint, verdict = EXCLUDED.verdict,
        confidence = EXCLUDED.confidence, reason = EXCLUDED.reason,
        risks = EXCLUDED.risks, raw = EXCLUDED.raw,
        candidate_local_ids = EXCLUDED.candidate_local_ids, synced_at = now()
    `,
  },
  decision_logs: {
    select: 'SELECT * FROM decision_logs WHERE id = ?',
    transform: (row, mid) => [
      mid, row.id, row.at_ms, row.batch_id, row.trigger_candidate_id, row.selected_candidate_id,
      row.selected_mint, row.mode, row.action, row.verdict, row.confidence, row.reason,
      parseJson(row.guardrails_json, {}), parseJson(row.token_json, null),
      parseJson(row.candidate_json, null), parseJson(row.batch_json, []),
      parseJson(row.execution_json, {}), row.strategy_id,
    ],
    upsert: `
      INSERT INTO decision_logs (machine_id, local_id, at_ms, batch_local_id, trigger_candidate_local_id,
        selected_candidate_local_id, selected_mint, mode, action, verdict, confidence, reason,
        guardrails, token, candidate, batch, execution, strategy_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (machine_id, local_id) DO UPDATE SET
        at_ms = EXCLUDED.at_ms, batch_local_id = EXCLUDED.batch_local_id,
        trigger_candidate_local_id = EXCLUDED.trigger_candidate_local_id,
        selected_candidate_local_id = EXCLUDED.selected_candidate_local_id,
        selected_mint = EXCLUDED.selected_mint, mode = EXCLUDED.mode, action = EXCLUDED.action,
        verdict = EXCLUDED.verdict, confidence = EXCLUDED.confidence, reason = EXCLUDED.reason,
        guardrails = EXCLUDED.guardrails, token = EXCLUDED.token,
        candidate = EXCLUDED.candidate, batch = EXCLUDED.batch, execution = EXCLUDED.execution,
        strategy_id = EXCLUDED.strategy_id, synced_at = now()
    `,
  },
  dry_run_positions: {
    select: 'SELECT * FROM dry_run_positions WHERE id = ?',
    transform: (row, mid) => [
      mid, row.id, row.candidate_id, row.mint, row.symbol, row.status,
      row.opened_at_ms, row.closed_at_ms, row.size_sol,
      row.entry_price, row.entry_mcap, row.token_amount_est,
      row.high_water_price, row.high_water_mcap,
      row.tp_percent, row.sl_percent, row.trailing_enabled, row.trailing_percent, row.trailing_armed,
      row.exit_price, row.exit_mcap, row.exit_reason, row.pnl_percent, row.pnl_sol,
      row.llm_decision_id, row.execution_mode, row.entry_signature, row.exit_signature,
      row.token_amount_raw, row.strategy_id, row.partial_tp_done,
      parseJson(row.snapshot_json, {}),
    ],
    upsert: `
      INSERT INTO dry_run_positions (
        machine_id, local_id, candidate_local_id, mint, symbol, status,
        opened_at_ms, closed_at_ms, size_sol,
        entry_price, entry_mcap, token_amount_est,
        high_water_price, high_water_mcap,
        tp_percent, sl_percent, trailing_enabled, trailing_percent, trailing_armed,
        exit_price, exit_mcap, exit_reason, pnl_percent, pnl_sol,
        llm_decision_local_id, execution_mode, entry_signature, exit_signature,
        token_amount_raw, strategy_id, partial_tp_done, snapshot
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
        $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32
      )
      ON CONFLICT (machine_id, local_id) DO UPDATE SET
        candidate_local_id = EXCLUDED.candidate_local_id, mint = EXCLUDED.mint,
        symbol = EXCLUDED.symbol, status = EXCLUDED.status,
        opened_at_ms = EXCLUDED.opened_at_ms, closed_at_ms = EXCLUDED.closed_at_ms,
        size_sol = EXCLUDED.size_sol,
        entry_price = EXCLUDED.entry_price, entry_mcap = EXCLUDED.entry_mcap,
        token_amount_est = EXCLUDED.token_amount_est,
        high_water_price = EXCLUDED.high_water_price, high_water_mcap = EXCLUDED.high_water_mcap,
        tp_percent = EXCLUDED.tp_percent, sl_percent = EXCLUDED.sl_percent,
        trailing_enabled = EXCLUDED.trailing_enabled, trailing_percent = EXCLUDED.trailing_percent,
        trailing_armed = EXCLUDED.trailing_armed,
        exit_price = EXCLUDED.exit_price, exit_mcap = EXCLUDED.exit_mcap,
        exit_reason = EXCLUDED.exit_reason, pnl_percent = EXCLUDED.pnl_percent,
        pnl_sol = EXCLUDED.pnl_sol,
        llm_decision_local_id = EXCLUDED.llm_decision_local_id,
        execution_mode = EXCLUDED.execution_mode,
        entry_signature = EXCLUDED.entry_signature, exit_signature = EXCLUDED.exit_signature,
        token_amount_raw = EXCLUDED.token_amount_raw, strategy_id = EXCLUDED.strategy_id,
        partial_tp_done = EXCLUDED.partial_tp_done, snapshot = EXCLUDED.snapshot,
        synced_at = now()
    `,
  },
  dry_run_trades: {
    select: 'SELECT * FROM dry_run_trades WHERE id = ?',
    transform: (row, mid) => [
      mid, row.id, row.position_id, row.mint, row.side, row.at_ms,
      row.price, row.mcap, row.size_sol, row.token_amount_est, row.reason,
      parseJson(row.payload_json, {}),
    ],
    upsert: `
      INSERT INTO dry_run_trades (machine_id, local_id, position_local_id, mint, side, at_ms,
        price, mcap, size_sol, token_amount_est, reason, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (machine_id, local_id) DO UPDATE SET
        position_local_id = EXCLUDED.position_local_id, mint = EXCLUDED.mint,
        side = EXCLUDED.side, at_ms = EXCLUDED.at_ms,
        price = EXCLUDED.price, mcap = EXCLUDED.mcap, size_sol = EXCLUDED.size_sol,
        token_amount_est = EXCLUDED.token_amount_est, reason = EXCLUDED.reason,
        payload = EXCLUDED.payload, synced_at = now()
    `,
  },
  learning_lessons: {
    select: 'SELECT * FROM learning_lessons WHERE id = ?',
    transform: (row, mid) => [
      mid, row.id, row.run_id, row.created_at_ms, row.status, row.lesson,
      parseJson(row.evidence_json, {}),
    ],
    upsert: `
      INSERT INTO learning_lessons (machine_id, local_id, run_local_id, created_at_ms, status, lesson, evidence)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (machine_id, local_id) DO UPDATE SET
        run_local_id = EXCLUDED.run_local_id, created_at_ms = EXCLUDED.created_at_ms,
        status = EXCLUDED.status, lesson = EXCLUDED.lesson, evidence = EXCLUDED.evidence,
        synced_at = now()
    `,
  },
};

let timer = null;
let stopped = false;

async function ensureBotRow(mid) {
  await pgQuery(
    `INSERT INTO bots (machine_id, label, last_seen_at)
     VALUES ($1, $2, now())
     ON CONFLICT (machine_id) DO UPDATE SET last_seen_at = now(),
       label = COALESCE(EXCLUDED.label, bots.label)`,
    [mid, CHARON_MACHINE_LABEL || null],
  );
}

async function syncBatch(rows) {
  const mid = machineId();
  const byTable = new Map();
  for (const row of rows) {
    if (!TABLES[row.table_name]) continue;
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
    byTable.get(row.table_name).push(row);
  }
  const successIds = [];
  const failedIds = [];
  let lastError = null;
  for (const [tableName, batch] of byTable) {
    const config = TABLES[tableName];
    const pool = pgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const outboxRow of batch) {
        const localRow = db.prepare(config.select).get(outboxRow.local_id);
        if (!localRow) {
          successIds.push(outboxRow.id);
          continue;
        }
        const params = config.transform(localRow, mid);
        await client.query(config.upsert, params);
        successIds.push(outboxRow.id);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      lastError = error;
      for (const outboxRow of batch) {
        if (!successIds.includes(outboxRow.id)) failedIds.push(outboxRow.id);
      }
    } finally {
      client.release();
    }
  }
  if (successIds.length) markOutboxSynced(successIds);
  if (failedIds.length && lastError) backoffOutboxBatch(failedIds, lastError);
  return { synced: successIds.length, failed: failedIds.length };
}

async function tick() {
  if (stopped) return;
  if (!(await pgPing())) return;
  await ensureBotRow(machineId()).catch(error => log.warn(`bot upsert failed: ${error.message}`));
  for (let i = 0; i < 5; i++) {
    const rows = nextOutboxBatch(POSTGRES_SYNC_BATCH_SIZE);
    if (!rows.length) break;
    await syncBatch(rows);
  }
  pruneSyncedOutbox();
}

export function startPostgresSync() {
  if (!postgresEnabled()) {
    log.info('POSTGRES_URL not set — sync disabled');
    return;
  }
  if (timer) return;
  log.info(`starting Postgres sync (interval ${POSTGRES_SYNC_INTERVAL_MS}ms, machine ${machineId()})`);
  tick().catch(error => log.warn(`initial tick failed: ${error.message}`));
  timer = setInterval(
    () => tick().catch(error => log.warn(`tick failed: ${error.message}`)),
    POSTGRES_SYNC_INTERVAL_MS,
  );
  if (typeof timer.unref === 'function') timer.unref();
}

export async function stopPostgresSync() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  await closePostgres();
}
