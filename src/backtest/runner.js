import { pgQuery } from '../db/postgres.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { strategyById } from '../db/settings.js';
import { ensureCandles, intervalSeconds } from './candles.js';
import { simulatePosition } from './simulator.js';

const FILTER_KEYS = new Set([
  'min_source_count', 'require_fee_claim', 'token_age_max_ms',
  'min_mcap_usd', 'max_mcap_usd', 'min_fee_claim_sol', 'min_gmgn_total_fee_sol',
  'min_holders', 'max_top20_holder_percent', 'min_saved_wallet_holders',
  'max_ath_distance_pct', 'min_graduated_volume_usd',
  'trending_min_volume_usd', 'trending_min_swaps', 'trending_max_rug_ratio', 'trending_max_bundler_rate',
]);

const EXIT_KEYS = new Set([
  'tp_percent', 'sl_percent',
  'trailing_enabled', 'trailing_percent',
  'max_hold_ms',
  'partial_tp', 'partial_tp_at_percent', 'partial_tp_sell_percent',
]);

function mergeStrategy(base, override) {
  const out = { ...base };
  if (!override) return out;
  for (const k of Object.keys(override)) {
    if (override[k] !== undefined && override[k] !== null) out[k] = override[k];
  }
  return out;
}

function resolveStrategyForCandidate(candidate, fallbackId) {
  const stratId = candidate?.signals?.strategy || fallbackId || 'sniper';
  return strategyById(stratId) || strategyById('sniper') || { id: stratId };
}

async function loadCandidates({ fromMs, toMs, machineId, strategyId }) {
  const params = [fromMs, toMs];
  let sql = `
    SELECT machine_id, local_id, mint, status, created_at_ms, candidate
    FROM candidates
    WHERE created_at_ms BETWEEN $1 AND $2
  `;
  if (machineId) { params.push(machineId); sql += ` AND machine_id = $${params.length}`; }
  if (strategyId) {
    params.push(strategyId);
    sql += ` AND candidate->'signals'->>'strategy' = $${params.length}`;
  }
  sql += ' ORDER BY created_at_ms ASC';
  const res = await pgQuery(sql, params);
  return res.rows.map(row => ({
    machineId: row.machine_id,
    localId: Number(row.local_id),
    mint: row.mint,
    status: row.status,
    createdAtMs: Number(row.created_at_ms),
    candidate: typeof row.candidate === 'string' ? JSON.parse(row.candidate) : row.candidate,
  }));
}

async function cachedLlmVerdict({ machineId, candidateLocalId }) {
  const res = await pgQuery(
    `SELECT verdict, confidence FROM llm_decisions
     WHERE machine_id = $1 AND candidate_local_id = $2
     ORDER BY local_id DESC LIMIT 1`,
    [machineId, candidateLocalId],
  );
  return res.rows[0] || null;
}

export async function runBacktest({
  fromMs,
  toMs,
  overrides = {},
  machineId = null,
  strategyId = null,
  interval = '5_MINUTE',
  candleOrderRule = 'pessimistic',
  unscreenedPolicy = 'cohort',
  candleFetcher = ensureCandles,
} = {}) {
  const overrideStrategy = overrides.strategy || {};
  const overrideLlmMinConfidence = Number.isFinite(Number(overrides.llm_min_confidence))
    ? Number(overrides.llm_min_confidence)
    : null;

  const candidates = await loadCandidates({ fromMs, toMs, machineId, strategyId });
  const results = {
    config: { fromMs, toMs, overrides, machineId, strategyId, interval, candleOrderRule, unscreenedPolicy },
    counts: {
      total: candidates.length,
      filtered_sim: 0,
      llm_rejected_sim: 0,
      no_entry_price: 0,
      no_candles: 0,
      simulated: 0,
      unscreened_cohort: 0,
      llm_unscreened_skipped: 0,
    },
    positions: [],
  };

  const stepSec = intervalSeconds(interval);
  const maxHoldMsCap = Number(overrideStrategy.max_hold_ms || 7 * 24 * 60 * 60_000);

  for (const c of candidates) {
    const baseStrat = resolveStrategyForCandidate(c.candidate, strategyId);
    const overrideStrat = mergeStrategy(baseStrat, overrideStrategy);

    const filterResult = filterCandidate(c.candidate, overrideStrat);
    if (!filterResult.passed) {
      results.counts.filtered_sim++;
      results.positions.push({
        machineId: c.machineId, candidateLocalId: c.localId, mint: c.mint,
        outcome: 'filtered_sim', failures: filterResult.failures,
        strategyId: overrideStrat.id, createdAtMs: c.createdAtMs,
      });
      continue;
    }

    const verdict = await cachedLlmVerdict({ machineId: c.machineId, candidateLocalId: c.localId });
    const minConfidence = overrideLlmMinConfidence != null ? overrideLlmMinConfidence : Number(overrideStrat.llm_min_confidence || 0);
    let cohort = 'simulated';
    if (!verdict) {
      if (unscreenedPolicy === 'skip') {
        results.counts.llm_unscreened_skipped++;
        results.positions.push({
          machineId: c.machineId, candidateLocalId: c.localId, mint: c.mint,
          outcome: 'llm_unscreened_skipped', strategyId: overrideStrat.id, createdAtMs: c.createdAtMs,
        });
        continue;
      }
      cohort = unscreenedPolicy === 'cohort' ? 'unscreened_cohort' : 'simulated';
    } else if (String(verdict.verdict).toUpperCase() !== 'BUY' || Number(verdict.confidence) < minConfidence) {
      results.counts.llm_rejected_sim++;
      results.positions.push({
        machineId: c.machineId, candidateLocalId: c.localId, mint: c.mint,
        outcome: 'llm_rejected_sim',
        verdict: verdict.verdict, confidence: verdict.confidence, threshold: minConfidence,
        strategyId: overrideStrat.id, createdAtMs: c.createdAtMs,
      });
      continue;
    }

    const entryPrice = Number(c.candidate?.metrics?.priceUsd);
    const entryMcap = Number(c.candidate?.metrics?.marketCapUsd || c.candidate?.metrics?.graduatedMarketCapUsd);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(entryMcap) || entryMcap <= 0) {
      results.counts.no_entry_price++;
      results.positions.push({
        machineId: c.machineId, candidateLocalId: c.localId, mint: c.mint,
        outcome: 'no_entry_price', strategyId: overrideStrat.id, createdAtMs: c.createdAtMs,
      });
      continue;
    }

    const entryAtMs = c.createdAtMs;
    const padMs = stepSec * 2_000;
    const fetchTo = entryAtMs + maxHoldMsCap + padMs;
    let candles;
    try {
      const { rows } = await candleFetcher({
        mint: c.mint, interval, fromMs: entryAtMs - padMs, toMs: fetchTo,
      });
      candles = rows;
    } catch (error) {
      results.counts.no_candles++;
      results.positions.push({
        machineId: c.machineId, candidateLocalId: c.localId, mint: c.mint,
        outcome: 'no_candles', error: error.message, strategyId: overrideStrat.id, createdAtMs: c.createdAtMs,
      });
      continue;
    }
    if (!candles || !candles.length) {
      results.counts.no_candles++;
      results.positions.push({
        machineId: c.machineId, candidateLocalId: c.localId, mint: c.mint,
        outcome: 'no_candles', strategyId: overrideStrat.id, createdAtMs: c.createdAtMs,
      });
      continue;
    }

    const sim = simulatePosition({
      entryAtMs, entryPrice, entryMcap,
      sizeSol: Number(overrideStrat.position_size_sol || 0.1),
      candles,
      strategyConfig: { ...overrideStrat, _interval: interval },
      candleOrderRule,
    });

    results.counts.simulated++;
    if (cohort === 'unscreened_cohort') results.counts.unscreened_cohort++;

    results.positions.push({
      machineId: c.machineId,
      candidateLocalId: c.localId,
      mint: c.mint,
      outcome: 'simulated',
      cohort,
      strategyId: overrideStrat.id,
      createdAtMs: c.createdAtMs,
      entryPrice,
      entryMcap,
      verdict: verdict?.verdict || null,
      confidence: verdict?.confidence ?? null,
      ...sim,
    });
  }
  return results;
}

export async function loadActualClosedPositions({ fromMs, toMs, machineId = null }) {
  const params = [fromMs, toMs];
  let sql = `
    SELECT machine_id, local_id, candidate_local_id, mint, opened_at_ms, closed_at_ms,
           entry_price, entry_mcap, exit_price, exit_mcap, exit_reason, pnl_percent, pnl_sol,
           size_sol, tp_percent, sl_percent, trailing_enabled, trailing_percent,
           strategy_id, snapshot
    FROM dry_run_positions
    WHERE status = 'closed' AND closed_at_ms BETWEEN $1 AND $2
  `;
  if (machineId) {
    params.push(machineId);
    sql += ` AND machine_id = $${params.length}`;
  }
  sql += ' ORDER BY closed_at_ms ASC';
  const res = await pgQuery(sql, params);
  return res.rows.map(row => ({
    ...row,
    snapshot: typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot,
  }));
}

export async function runValidation({
  fromMs,
  toMs,
  machineId = null,
  interval = '5_MINUTE',
  candleOrderRule = 'pessimistic',
  candleFetcher = ensureCandles,
} = {}) {
  const positions = await loadActualClosedPositions({ fromMs, toMs, machineId });
  const stepSec = intervalSeconds(interval);
  const results = { config: { fromMs, toMs, machineId, interval, candleOrderRule }, rows: [] };

  for (const p of positions) {
    const snapshotStrategy = p.snapshot && typeof p.snapshot.strategy === 'object'
      ? p.snapshot.strategy
      : strategyById(p.strategy_id) || {};
    const cfg = {
      tp_percent: Number(p.tp_percent),
      sl_percent: Number(p.sl_percent),
      trailing_enabled: Boolean(p.trailing_enabled),
      trailing_percent: Number(p.trailing_percent || 0),
      trailing_arm_percent: Number(snapshotStrategy.trailing_arm_percent || 0),
      sl_arm_delay_ms: Number(snapshotStrategy.sl_arm_delay_ms || 0),
      max_hold_ms: Number(snapshotStrategy.max_hold_ms || 0),
      partial_tp: Boolean(snapshotStrategy.partial_tp),
      partial_tp_at_percent: Number(snapshotStrategy.partial_tp_at_percent || 0),
      partial_tp_sell_percent: Number(snapshotStrategy.partial_tp_sell_percent || 0),
      _interval: interval,
    };

    const padMs = stepSec * 2_000;
    let candles;
    try {
      const { rows } = await candleFetcher({
        mint: p.mint, interval,
        fromMs: Number(p.opened_at_ms) - padMs,
        toMs: Number(p.closed_at_ms || Date.now()) + padMs,
      });
      candles = rows;
    } catch (error) {
      results.rows.push({ ...p, sim_error: error.message });
      continue;
    }

    const sim = simulatePosition({
      entryAtMs: Number(p.opened_at_ms),
      entryPrice: Number(p.entry_price),
      entryMcap: Number(p.entry_mcap),
      sizeSol: Number(p.size_sol),
      candles,
      strategyConfig: cfg,
      candleOrderRule,
    });

    const actualPnl = Number(p.pnl_percent);
    const simPnl = Number(sim.pnlPercent);
    results.rows.push({
      machineId: p.machine_id,
      positionLocalId: Number(p.local_id),
      mint: p.mint,
      actual_exit: p.exit_reason,
      sim_exit: sim.exitReason,
      actual_pnl_percent: actualPnl,
      sim_pnl_percent: simPnl,
      delta_percent: simPnl - actualPnl,
      ambiguousCandleCount: sim.ambiguousCandleCount,
      candlesEvaluated: sim.candlesEvaluated,
    });
  }
  return results;
}
