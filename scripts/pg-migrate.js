#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSTGRES_URL } from '../src/config.js';
import { pgQuery, closePostgres } from '../src/db/postgres.js';
import { logger } from '../src/log.js';

const log = logger('pg-migrate');

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, '..', 'src', 'db', 'postgresSchema.sql');

async function main() {
  if (!POSTGRES_URL) {
    console.error('POSTGRES_URL is not set. Set it in .env or pass it inline.');
    process.exit(1);
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pgQuery(sql);
  log.info(`applied ${path.basename(schemaPath)}`);
  await closePostgres();
}

main().catch(error => {
  log.error(`failed: ${error.message}`);
  process.exitCode = 1;
  closePostgres().finally(() => process.exit());
});
