#!/usr/bin/env node
import { POSTGRES_URL } from '../src/config.js';
import { db } from '../src/db/connection.js';
import { machineId } from '../src/db/machineId.js';
import { pgPool, closePostgres } from '../src/db/postgres.js';
import { safeJson } from '../src/utils.js';
import { logger } from '../src/log.js';

const log = logger('backfill');

const TABLES = {
  candidates: {
    selectAll: 'SELECT * FROM candidates',
    transform: (row, mid) => [
      mid, row.id, row.mint, row.status, row.created_at_ms, row.updated_at_ms,
      row.signature, row.signal_key,
      parseJson(row.candidate_json, {}), parseJson(row.filter_result_json, {}),
    ],
    upsert: `
      INSERT INTO candidates (machine_id, local_id, mint, status, created_at_ms, updated_at_ms,
        signature, signal_key, candidate, filter_result)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (machine_id, local_id) DO NOTHING
    `,
  },
  llm_decisions: {
    selectAll: 'SELECT * FROM llm_decisions',
    transform: (row, mid) => [
      mid, row.id, row.candidate_id, row.mint, row.created_at_ms, row.verdict,
      row.confidence, row.reason, parseJson(row.risks_json, []), parseJson(row.raw_json, {}),
    ],
    upsert: `
      INSERT INTO llm_decisions (machine_id, local_id, candidate_local_id, mint, created_at_ms,
        verdict, confidence, reason, risks, raw)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (machine_id, local_id) DO NOTHING
    `,
  },
  llm_batches: {
    selectAll: 'SELECT * FROM llm_batches',
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
      ON CONFLICT (machine_id, local_id) DO NOTHING
    `,
  },
  decision_logs: {
    selectAll: 'SELECT * FROM decision_logs',
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
      ON CONFLICT (machine_id, local_id) DO NOTHING
    `,
  },
  dry_run_positions: {
    selectAll: 'SELECT * FROM dry_run_positions',
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
      ON CONFLICT (machine_id, local_id) DO NOTHING
    `,
  },
  dry_run_trades: {
    selectAll: 'SELECT * FROM dry_run_trades',
    transform: (row, mid) => [
      mid, row.id, row.position_id, row.mint, row.side, row.at_ms,
      row.price, row.mcap, row.size_sol, row.token_amount_est, row.reason,
      parseJson(row.payload_json, {}),
    ],
    upsert: `
      INSERT INTO dry_run_trades (machine_id, local_id, position_local_id, mint, side, at_ms,
        price, mcap, size_sol, token_amount_est, reason, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (machine_id, local_id) DO NOTHING
    `,
  },
  learning_lessons: {
    selectAll: 'SELECT * FROM learning_lessons',
    transform: (row, mid) => [
      mid, row.id, row.run_id, row.created_at_ms, row.status, row.lesson,
      parseJson(row.evidence_json, {}),
    ],
    upsert: `
      INSERT INTO learning_lessons (machine_id, local_id, run_local_id, created_at_ms, status, lesson, evidence)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (machine_id, local_id) DO NOTHING
    `,
  },
};

function parseJson(text, fallback) {
  let value;
  if (text === null || text === undefined) value = fallback;
  else if (typeof text === 'object') value = text;
  else value = safeJson(text, fallback);
  return JSON.stringify(value === undefined ? null : value);
}

function parseArgs(argv) {
  const out = { tables: null, from: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--table' || a === '--tables') {
      out.tables = String(argv[++i] || '').split(',').filter(Boolean);
    } else if (a === '--from') {
      out.from = Number(argv[++i]);
    }
  }
  return out;
}

async function backfillTable(tableName, mid, fromMs) {
  const config = TABLES[tableName];
  if (!config) throw new Error(`unknown table: ${tableName}`);
  let select = config.selectAll;
  const params = [];
  if (fromMs && tableName !== 'historical_candles') {
    const col = tableName.includes('position') || tableName === 'candidates'
      ? (tableName === 'dry_run_positions' ? 'opened_at_ms' : 'created_at_ms')
      : 'at_ms';
    select += ` WHERE ${col} >= ?`;
    params.push(fromMs);
  }
  select += ' ORDER BY id ASC';
  const rows = db.prepare(select).all(...params);
  if (!rows.length) {
    log.info(`${tableName}: 0 rows`);
    return 0;
  }
  const pool = pgPool();
  const client = await pool.connect();
  let written = 0;
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      await client.query(config.upsert, config.transform(row, mid));
      written++;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  log.info(`${tableName}: ${written} rows`);
  return written;
}

async function main() {
  if (!POSTGRES_URL) {
    console.error('POSTGRES_URL is not set.');
    process.exit(1);
  }
  const { tables, from } = parseArgs(process.argv);
  const mid = machineId();
  log.info(`machine ${mid}`);
  const targets = tables && tables.length ? tables : Object.keys(TABLES);
  let total = 0;
  for (const t of targets) {
    total += await backfillTable(t, mid, from);
  }
  log.info(`done — ${total} rows total`);
  await closePostgres();
}

main().catch(error => {
  log.error(`failed: ${error.message}`);
  process.exitCode = 1;
  closePostgres().finally(() => process.exit());
});
