import { db } from './connection.js';
import { now, json } from '../utils.js';
import { setting, activeStrategy } from './settings.js';
import { enqueueSync } from './outbox.js';

const ENV_SNAPSHOT_KEYS = [
  'TRENDING_ENABLED', 'TRENDING_SOURCE', 'TRENDING_INTERVAL', 'TRENDING_LIMIT',
  'TRENDING_ALLOW_DEGEN',
  'SIGNAL_POLL_MS', 'GRADUATED_POLL_MS', 'GRADUATED_LOOKBACK_MS',
  'TRENDING_POLL_MS', 'TRENDING_LOOKBACK_MS', 'POSITION_CHECK_MS',
  'GMGN_ENABLED', 'GMGN_REQUEST_DELAY_MS', 'GMGN_MAX_RETRIES', 'GMGN_CACHE_TTL_MS',
  'ENABLE_LLM', 'LLM_MODEL', 'LLM_CANDIDATE_PICK_COUNT', 'LLM_CANDIDATE_MAX_AGE_MS',
  'TRADING_MODE', 'LIVE_MIN_SOL_RESERVE', 'JUPITER_SLIPPAGE_BPS',
];

function captureEnvSnapshot() {
  const out = {};
  for (const k of ENV_SNAPSHOT_KEYS) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

function summariseSwap(swap) {
  if (!swap) return null;
  return {
    signature: swap.signature ?? null,
    inputAmount: swap.inputAmount ?? null,
    outputAmount: swap.outputAmount ?? null,
    slippageBps: swap.slippageBps ?? null,
  };
}

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function hasOpenPositionForMint(mint) {
  if (!mint) return false;
  const row = db.prepare(`SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1`).get(mint);
  return row ? row.id : null;
}

export function canOpenMorePositions() {
  const max = activeStrategy().max_open_positions ?? 0;
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function recentClosedExits(strategyId, limit = 10, sinceMs = 0) {
  return db.prepare(
    `SELECT exit_reason, pnl_percent FROM dry_run_positions
     WHERE status != 'open' AND strategy_id = ? AND closed_at_ms > ?
     ORDER BY closed_at_ms DESC LIMIT ?`
  ).all(strategyId, sinceMs, limit);
}

export function recentLossForMint(mint, lossPct, sinceMs) {
  return db.prepare(
    `SELECT symbol, pnl_percent, closed_at_ms FROM dry_run_positions
     WHERE status != 'open' AND mint = ? AND pnl_percent <= ? AND closed_at_ms > ?
     ORDER BY closed_at_ms DESC LIMIT 1`
  ).get(mint, lossPct, sinceMs);
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol;
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent ?? strat.tp_percent);
  const sl = Number(decision.suggested_sl_percent ?? strat.sl_percent);
  const trailingEnabled = strat.trailing_enabled ? 1 : 0;
  const trailingPercent = strat.trailing_percent;

  const out = db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { positionId: existing.id, tradeId: null };

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      json({ candidate, decision, reason, strategy: strat, env: captureEnvSnapshot() }),
    );
    const positionId = Number(result.lastInsertRowid);
    const tradeRes = db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { positionId, tradeId: Number(tradeRes.lastInsertRowid) };
  })();
  enqueueSync('dry_run_positions', out.positionId);
  if (out.tradeId) enqueueSync('dry_run_trades', out.tradeId);
  return out.positionId;
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol;
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent ?? strat.tp_percent);
  const sl = Number(decision.suggested_sl_percent ?? strat.sl_percent);
  const trailingEnabled = strat.trailing_enabled ? 1 : 0;
  const trailingPercent = strat.trailing_percent;

  const out = db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { positionId: existing.id, tradeId: null };

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      json({ candidate, decision, reason, swap: summariseSwap(swap), strategy: strat, env: captureEnvSnapshot() }),
    );
    const positionId = Number(result.lastInsertRowid);
    const tradeRes = db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { positionId, tradeId: Number(tradeRes.lastInsertRowid) };
  })();
  enqueueSync('dry_run_positions', out.positionId);
  if (out.tradeId) enqueueSync('dry_run_trades', out.tradeId);
  return out.positionId;
}
