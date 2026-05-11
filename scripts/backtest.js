#!/usr/bin/env node
import fs from 'node:fs';
import { POSTGRES_URL } from '../src/config.js';
import { closePostgres } from '../src/db/postgres.js';
import { initDb } from '../src/db/connection.js';
import { runBacktest, runValidation } from '../src/backtest/runner.js';
import {
  summariseSimulated,
  formatSingleReport,
  formatSweepReport,
  formatValidationReport,
} from '../src/backtest/report.js';

function parseArgs(argv) {
  const out = {
    mode: 'single',
    window: '7d',
    from: null,
    to: null,
    interval: '5_MINUTE',
    candleRule: 'pessimistic',
    unscreenedPolicy: 'cohort',
    machineId: null,
    strategyId: null,
    overrides: { strategy: {}, llm_min_confidence: null },
    spec: null,
    top: 10,
    output: 'text',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--validate':   out.mode = 'validate'; break;
      case '--from':       out.window = String(argv[++i]); break;
      case '--window':     out.window = String(argv[++i]); break;
      case '--to':         out.to = Number(argv[++i]); break;
      case '--interval':   out.interval = String(argv[++i]); break;
      case '--candle-rule':out.candleRule = String(argv[++i]); break;
      case '--unscreened-policy': out.unscreenedPolicy = String(argv[++i]); break;
      case '--machine':    out.machineId = String(argv[++i]); break;
      case '--strategy':   out.strategyId = String(argv[++i]); break;
      case '--override-tp':  out.overrides.strategy.tp_percent = Number(argv[++i]); break;
      case '--override-sl':  out.overrides.strategy.sl_percent = Number(argv[++i]); break;
      case '--override-trailing-enabled': out.overrides.strategy.trailing_enabled = String(argv[++i]) === 'true'; break;
      case '--override-trailing':         out.overrides.strategy.trailing_percent = Number(argv[++i]); break;
      case '--override-max-hold-ms':      out.overrides.strategy.max_hold_ms = Number(argv[++i]); break;
      case '--override-min-mcap':         out.overrides.strategy.min_mcap_usd = Number(argv[++i]); break;
      case '--override-max-mcap':         out.overrides.strategy.max_mcap_usd = Number(argv[++i]); break;
      case '--override-min-holders':      out.overrides.strategy.min_holders = Number(argv[++i]); break;
      case '--override-max-top20':        out.overrides.strategy.max_top20_holder_percent = Number(argv[++i]); break;
      case '--override-llm-min-confidence': out.overrides.llm_min_confidence = Number(argv[++i]); break;
      case '--spec':       out.spec = String(argv[++i]); out.mode = 'sweep'; break;
      case '--top':        out.top = Number(argv[++i]); break;
      case '--output':     out.output = String(argv[++i]); break;
      default:
        if (a.startsWith('--')) console.warn(`[backtest] unknown flag ${a}`);
    }
  }
  return out;
}

function windowMs(spec) {
  const m = String(spec).match(/^(\d+)\s*([smhd])?$/);
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

function cartesian(spec) {
  const keys = Object.keys(spec);
  if (!keys.length) return [{}];
  const arrays = keys.map(k => Array.isArray(spec[k]) ? spec[k] : [spec[k]]);
  const out = [];
  function recurse(idx, current) {
    if (idx === keys.length) { out.push({ ...current }); return; }
    for (const v of arrays[idx]) {
      current[keys[idx]] = v;
      recurse(idx + 1, current);
    }
  }
  recurse(0, {});
  return out;
}

async function runSingle(args, fromMs, toMs) {
  const results = await runBacktest({
    fromMs, toMs,
    overrides: args.overrides,
    machineId: args.machineId,
    strategyId: args.strategyId,
    interval: args.interval,
    candleOrderRule: args.candleRule,
    unscreenedPolicy: args.unscreenedPolicy,
  });
  if (args.output === 'json') console.log(JSON.stringify(results, null, 2));
  else console.log(formatSingleReport(results));
  return results;
}

async function runSweep(args, fromMs, toMs) {
  const spec = JSON.parse(fs.readFileSync(args.spec, 'utf8'));
  const base = spec.base || {};
  const sweep = spec.sweep || {};
  const cells = cartesian(sweep);
  const interval = base.interval || args.interval;
  const candleRule = base.candle_rule || args.candleRule;
  const rows = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const overrides = { strategy: {}, llm_min_confidence: null };
    for (const [k, v] of Object.entries(cell)) {
      if (k === 'llm_min_confidence') overrides.llm_min_confidence = Number(v);
      else overrides.strategy[k] = v;
    }
    const results = await runBacktest({
      fromMs, toMs, overrides,
      machineId: args.machineId,
      strategyId: args.strategyId || base.strategy,
      interval, candleOrderRule: candleRule,
      unscreenedPolicy: base.unscreened_policy || args.unscreenedPolicy,
    });
    const summary = summariseSimulated(results);
    rows.push({ cell, summary });
    console.error(`[sweep] ${i + 1}/${cells.length} ${JSON.stringify(cell)} → closed=${summary.closed} avg=${summary.avgPnl.toFixed(2)}%`);
  }
  if (args.output === 'json') console.log(JSON.stringify(rows, null, 2));
  else console.log(formatSweepReport(rows, { top: args.top }));
}

async function runValidate(args, fromMs, toMs) {
  const results = await runValidation({
    fromMs, toMs,
    machineId: args.machineId,
    interval: args.interval,
    candleOrderRule: args.candleRule,
  });
  if (args.output === 'json') console.log(JSON.stringify(results, null, 2));
  else console.log(formatValidationReport(results));
  return results;
}

async function main() {
  if (!POSTGRES_URL) {
    console.error('POSTGRES_URL is not set.');
    process.exit(1);
  }
  initDb();
  const args = parseArgs(process.argv);
  const toMs = args.to || Date.now();
  const fromMs = toMs - windowMs(args.window);
  if (args.mode === 'sweep') await runSweep(args, fromMs, toMs);
  else if (args.mode === 'validate') await runValidate(args, fromMs, toMs);
  else await runSingle(args, fromMs, toMs);
  await closePostgres();
}

main().catch(error => {
  console.error(`[backtest] failed: ${error.message}`);
  process.exitCode = 1;
  closePostgres().finally(() => process.exit());
});
