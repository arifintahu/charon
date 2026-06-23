#!/usr/bin/env node
// Diff realized live/confirm fills against the dry-run mcap-mark model.
//
// Dry-run PnL is a frictionless mark: (exit_mcap / entry_mcap - 1). Live exits store
// the realized round trip (receivedSol / size_sol - 1) in pnl_percent/pnl_sol while
// still recording the same entry_mcap/exit_mcap marks. So for every live position the
// model PnL can be reconstructed from its own row, and:
//
//   gap = realized - model = round-trip execution cost (slippage + price impact + Jupiter fee)
//
// A negative gap means live underperforms the simulation. The number that decides the
// go-live question is the gap on SL exits — the deep rug/dump tail the dry-run model
// is most optimistic about. (Caveat: SOL spent on network/priority fees outside the
// swap input is not captured in size_sol, so the true cost is slightly worse than gap.)
//
//   node scripts/live-vs-model.js [--pg] [--days N] [--json]
//     --pg      read pooled analytics from Postgres (default: local charon.sqlite)
//     --days N  only positions closed in the last N days (default: all)
//     --json    emit the machine-readable summary only

import Database from 'better-sqlite3';
import { DB_PATH } from '../src/config.js';

const args = process.argv.slice(2);
const usePg = args.includes('--pg');
const jsonOnly = args.includes('--json');
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : null;
const cutoffMs = days && Number.isFinite(days) ? Date.now() - days * 86_400_000 : 0;

// Postgres keys synced rows by (machine_id, local_id); local SQLite uses id.
const COLS = `${usePg ? 'local_id AS id' : 'id'}, symbol, exit_reason, size_sol, entry_mcap, exit_mcap, pnl_percent, pnl_sol, opened_at_ms, closed_at_ms`;
const WHERE = "status = 'closed' AND execution_mode = 'live' AND entry_mcap > 0 AND exit_mcap IS NOT NULL AND closed_at_ms >= ?";

async function fetchRows() {
  if (usePg) {
    const { default: pg } = await import('pg');
    if (!process.env.POSTGRES_URL) { console.error('POSTGRES_URL is not set'); process.exit(1); }
    const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
    try {
      const { rows } = await pool.query(
        `SELECT ${COLS} FROM dry_run_positions WHERE ${WHERE.replace('?', '$1')} ORDER BY closed_at_ms`,
        [cutoffMs],
      );
      return rows;
    } finally {
      await pool.end();
    }
  }
  const db = new Database(DB_PATH, { readonly: true });
  return db.prepare(`SELECT ${COLS} FROM dry_run_positions WHERE ${WHERE} ORDER BY closed_at_ms`).all(cutoffMs);
}

const pct = n => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const sol = n => `${n >= 0 ? '+' : ''}${n.toFixed(4)}`;

function enrich(rows) {
  return rows.map(r => {
    const modelPct = (Number(r.exit_mcap) / Number(r.entry_mcap) - 1) * 100;
    const realizedPct = Number(r.pnl_percent);
    const realizedSol = Number(r.pnl_sol);
    const modelSol = Number(r.size_sol) * modelPct / 100;
    return {
      id: r.id,
      symbol: r.symbol || '?',
      reason: r.exit_reason || '?',
      sizeSol: Number(r.size_sol),
      modelPct,
      realizedPct,
      gapPct: realizedPct - modelPct,
      modelSol,
      realizedSol,
      gapSol: realizedSol - modelSol,
    };
  });
}

function summarize(label, items) {
  const n = items.length;
  const avg = f => items.reduce((s, x) => s + f(x), 0) / n;
  const sum = f => items.reduce((s, x) => s + f(x), 0);
  return {
    label,
    n,
    avgModelPct: avg(x => x.modelPct),
    avgRealizedPct: avg(x => x.realizedPct),
    avgGapPct: avg(x => x.gapPct),
    sumModelSol: sum(x => x.modelSol),
    sumRealizedSol: sum(x => x.realizedSol),
    sumGapSol: sum(x => x.gapSol),
  };
}

function buildSummary(trades) {
  const byReason = {};
  for (const t of trades) (byReason[t.reason] ??= []).push(t);
  return {
    source: usePg ? 'postgres' : 'sqlite',
    window: days ? `${days}d` : 'all',
    overall: summarize('OVERALL', trades),
    byReason: Object.entries(byReason)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([reason, items]) => summarize(reason, items)),
  };
}

const trades = enrich(await fetchRows());

if (jsonOnly) {
  if (!trades.length) { console.log(JSON.stringify({ trades: 0 })); process.exit(0); }
  console.log(JSON.stringify(buildSummary(trades), null, 2));
  process.exit(0);
}

if (!trades.length) {
  console.log(`No closed live/confirm positions found${days ? ` in the last ${days}d` : ''} (source: ${usePg ? 'postgres' : 'sqlite'}).`);
  console.log('Run the confirm-mode pilot first, then re-run this to measure the live-vs-model gap.');
  process.exit(0);
}

console.log(`Live-vs-model — ${trades.length} closed live trades · source: ${usePg ? 'postgres' : 'sqlite'}${days ? ` · last ${days}d` : ''}\n`);

const head = `${'id'.padStart(5)}  ${'symbol'.padEnd(10)} ${'reason'.padEnd(12)} ${'model'.padStart(9)} ${'real'.padStart(9)} ${'gap'.padStart(9)} ${'gapSOL'.padStart(9)}`;
console.log(head);
console.log('-'.repeat(head.length));
for (const t of trades) {
  console.log(`${String(t.id).padStart(5)}  ${t.symbol.slice(0, 10).padEnd(10)} ${t.reason.padEnd(12)} ${pct(t.modelPct).padStart(9)} ${pct(t.realizedPct).padStart(9)} ${pct(t.gapPct).padStart(9)} ${sol(t.gapSol).padStart(9)}`);
}

const summary = buildSummary(trades);
const printGroup = g => {
  console.log(`\n${g.label} (n=${g.n})`);
  console.log(`  avg model PnL    ${pct(g.avgModelPct)}`);
  console.log(`  avg realized PnL ${pct(g.avgRealizedPct)}`);
  console.log(`  avg gap          ${pct(g.avgGapPct)}   <- execution cost per trade`);
  console.log(`  total SOL  model ${sol(g.sumModelSol)}  realized ${sol(g.sumRealizedSol)}  gap ${sol(g.sumGapSol)}`);
};

console.log('\n=== By exit reason ===');
for (const g of summary.byReason) printGroup(g);
console.log('\n=== Overall ===');
printGroup(summary.overall);

const slGroup = summary.byReason.find(g => g.label === 'SL');
console.log('\nVerdict:');
console.log(`  Realized edge ${summary.overall.avgRealizedPct >= 0 ? 'survives' : 'turns NEGATIVE'} live: avg ${pct(summary.overall.avgRealizedPct)} (model said ${pct(summary.overall.avgModelPct)}).`);
if (slGroup) console.log(`  SL-tail gap: ${pct(slGroup.avgGapPct)} — realized SL avg ${pct(slGroup.avgRealizedPct)} vs model ${pct(slGroup.avgModelPct)}.`);
