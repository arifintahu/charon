#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSTGRES_URL } from '../src/config.js';
import { closePostgres } from '../src/db/postgres.js';
import { initDb } from '../src/db/connection.js';
import { logger } from '../src/log.js';

const log = logger('backtest');
const sweepLog = logger('sweep');
const validateLog = logger('validate-strategy');
import { runBacktest, runValidation } from '../src/backtest/runner.js';
import {
  summariseSimulated,
  formatSingleReport,
  formatSweepReport,
  formatValidationReport,
} from '../src/backtest/report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STRATEGIES_DIR = path.resolve(__dirname, '../strategies');

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
    validateStrategy: false,
    minTrades: 10,
    maxDrawdown: -50,
    overrides: { strategy: {}, llm_min_confidence: null },
    spec: null,
    top: 10,
    output: 'text',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--validate':   out.mode = 'validate'; break;
      case '--validate-strategy': out.validateStrategy = true; break;
      case '--min-trades':   out.minTrades = Number(argv[++i]); break;
      case '--max-drawdown': out.maxDrawdown = Number(argv[++i]); break;
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
        if (a.startsWith('--')) log.warn(`unknown flag ${a}`);
    }
  }
  return out;
}

function loadStrategyJson(id) {
  const p = path.join(STRATEGIES_DIR, `${id}.json`);
  if (!fs.existsSync(p)) throw new Error(`strategy file not found: ${p}`);
  return { path: p, json: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

function currentGitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}

function writeValidationMarker(filePath, json, summary, args) {
  const next = {
    ...json,
    validation: {
      validated_at_ms: Date.now(),
      window: args.window,
      trades: summary.closed,
      win_rate_pct: Number(summary.winRate.toFixed(2)),
      avg_pnl_pct: Number(summary.avgPnl.toFixed(2)),
      median_pnl_pct: Number(summary.medianPnl.toFixed(2)),
      max_drawdown_pct: Number(summary.worstPnl.toFixed(2)),
      git_sha: currentGitSha(),
    },
  };
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
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
  let strategyJson = null;
  let strategyPath = null;
  let overrides = args.overrides;
  let strategyId = args.strategyId;
  if (args.strategyId) {
    const loaded = loadStrategyJson(args.strategyId);
    strategyJson = loaded.json;
    strategyPath = loaded.path;
    overrides = {
      ...args.overrides,
      strategy: { ...strategyJson.config, ...args.overrides.strategy },
    };
    if (args.validateStrategy) strategyId = null;
  }
  const results = await runBacktest({
    fromMs, toMs,
    overrides,
    machineId: args.machineId,
    strategyId,
    interval: args.interval,
    candleOrderRule: args.candleRule,
    unscreenedPolicy: args.unscreenedPolicy,
  });
  if (args.output === 'json') console.log(JSON.stringify(results, null, 2));
  else console.log(formatSingleReport(results));

  if (args.validateStrategy) {
    if (!strategyJson) {
      validateLog.error('requires --strategy <id>');
      process.exitCode = 1;
      return results;
    }
    const summary = summariseSimulated(results);
    const failures = [];
    if (summary.closed < args.minTrades) failures.push(`closed trades ${summary.closed} < min ${args.minTrades}`);
    if (summary.avgPnl <= 0) failures.push(`avg pnl ${summary.avgPnl.toFixed(2)}% must be > 0`);
    if (summary.worstPnl < args.maxDrawdown) failures.push(`worst pnl ${summary.worstPnl.toFixed(2)}% below floor ${args.maxDrawdown}%`);
    if (failures.length) {
      console.error(`\n❌ Validation failed for ${args.strategyId}:`);
      for (const f of failures) console.error(`  - ${f}`);
      console.error(`\nstrategies/${args.strategyId}.json NOT modified.`);
      process.exitCode = 1;
    } else {
      writeValidationMarker(strategyPath, strategyJson, summary, args);
      console.log(`\n✅ Validation passed. ${strategyPath} updated.`);
    }
  }
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
    sweepLog.info(`${i + 1}/${cells.length} ${JSON.stringify(cell)} → closed=${summary.closed} avg=${summary.avgPnl.toFixed(2)}%`);
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
  log.error(`failed: ${error.message}`);
  process.exitCode = 1;
  closePostgres().finally(() => process.exit());
});
