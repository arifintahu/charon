#!/usr/bin/env node
import { POSTGRES_URL } from '../src/config.js';
import { pgQuery, closePostgres } from '../src/db/postgres.js';
import { ensureCandles, intervalSeconds } from '../src/backtest/candles.js';

function parseArgs(argv) {
  const out = { window: '7d', interval: '5_MINUTE', mint: null, sleepMs: 150, padMs: 30 * 60_000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--window' || a === '--from') out.window = String(argv[++i]);
    else if (a === '--interval') out.interval = String(argv[++i]);
    else if (a === '--mint') out.mint = String(argv[++i]);
    else if (a === '--sleep') out.sleepMs = Number(argv[++i]);
    else if (a === '--pad-ms') out.padMs = Number(argv[++i]);
  }
  return out;
}

function windowMs(window) {
  const m = String(window).match(/^(\d+)\s*([smhd])?$/);
  if (!m) return 7 * 24 * 60 * 60_000;
  const n = Number(m[1]);
  const unit = m[2] || 'd';
  switch (unit) {
    case 's': return n * 1000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    default:  return n * 86_400_000;
  }
}

async function listMints({ fromMs, toMs, only }) {
  if (only) return [only];
  const res = await pgQuery(
    `SELECT DISTINCT mint FROM candidates
     WHERE created_at_ms BETWEEN $1 AND $2 ORDER BY mint`,
    [fromMs, toMs],
  );
  return res.rows.map(r => r.mint);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!POSTGRES_URL) {
    console.error('POSTGRES_URL is not set.');
    process.exit(1);
  }
  const args = parseArgs(process.argv);
  const toMs = Date.now();
  const fromMs = toMs - windowMs(args.window);
  const mints = await listMints({ fromMs, toMs, only: args.mint });
  console.log(`[fetch] ${mints.length} mints, window ${args.window}, interval ${args.interval}`);
  let totalInserted = 0;
  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i];
    const padded = fromMs - args.padMs;
    const end = toMs + args.padMs;
    try {
      const { rows, fetched, pages } = await ensureCandles({
        mint,
        interval: args.interval,
        fromMs: padded,
        toMs: end,
      });
      totalInserted += fetched;
      console.log(`[fetch] ${i + 1}/${mints.length} ${mint.slice(0, 8)}… cached=${rows.length} new=${fetched} pages=${pages}`);
    } catch (error) {
      console.log(`[fetch] ${mint.slice(0, 8)}… failed: ${error.message}`);
    }
    if (i + 1 < mints.length) await sleep(args.sleepMs);
  }
  console.log(`[fetch] done — ${totalInserted} new candles inserted (interval ${args.interval}, step ${intervalSeconds(args.interval)}s)`);
  await closePostgres();
}

main().catch(error => {
  console.error(`[fetch] failed: ${error.message}`);
  process.exitCode = 1;
  closePostgres().finally(() => process.exit());
});
