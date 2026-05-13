#!/usr/bin/env node
import { POSTGRES_URL } from '../src/config.js';
import { pgPool, closePostgres } from '../src/db/postgres.js';
import { logger } from '../src/log.js';

const log = logger('pg-vacuum');

const TABLES = [
  'dry_run_positions',
  'dry_run_trades',
  'candidates',
  'llm_decisions',
  'llm_batches',
  'decision_logs',
];

async function tableSize(client, table) {
  const res = await client.query(
    `SELECT pg_size_pretty(pg_total_relation_size($1::regclass)) AS size`,
    [table],
  );
  return res.rows[0]?.size || '?';
}

async function main() {
  if (!POSTGRES_URL) {
    console.error('POSTGRES_URL is not set. Set it in .env or pass it inline.');
    process.exit(1);
  }
  const client = await pgPool().connect();
  try {
    for (const table of TABLES) {
      const before = await tableSize(client, table);
      await client.query(`VACUUM (FULL, ANALYZE) ${table}`);
      const after = await tableSize(client, table);
      log.info(`${table}: ${before} -> ${after}`);
    }
  } finally {
    client.release();
  }
  await closePostgres();
}

main().catch(error => {
  log.error(`failed: ${error.message}`);
  process.exitCode = 1;
  closePostgres().finally(() => process.exit());
});
