import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting, setSetting, activeStrategy } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent } from '../db/decisions.js';
import { buildCandidate } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { createDryRunPosition, canOpenMorePositions, openPositionCount, hasOpenPositionForMint, tradingMode, recentClosedExits } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short, escapeHtml } from '../format.js';
import { logger } from '../log.js';

const agentLog = logger('agent');
const candidateLog = logger('candidate');

const DAY_MS = 86_400_000;
// Midnight UTC (GMT+0) of the day containing ms — epoch 0 is itself a UTC midnight.
const utcDayStart = ms => Math.floor(ms / DAY_MS) * DAY_MS;

// Returns a descriptor when entries should be skipped, else null. Two layers:
//   - streak cooldown: `threshold` consecutive losing exits (SL or red TP) within `cooldownMs`
//     arms a `cooldownMs` halt.
//   - daily halt: once the streak cooldown arms `dailyHaltCount` times in one UTC day, halt all
//     entries until the next 00:00 UTC.
// Streak lookups stay time-bounded and every halt has a concrete expiry that lapses on its own,
// so stale rows can't re-arm forever and the day counter self-resets — no latch, no manual reset.
function checkSlCooldown(strat) {
  const cooldownKey = `sl_cooldown_until_${strat.id}`;
  const haltKey = `sl_daily_halt_until_${strat.id}`;
  const dayKey = `sl_arm_day_${strat.id}`;
  const countKey = `sl_arm_count_${strat.id}`;
  const threshold = strat.sl_streak_cooldown_count ?? numSetting('sl_streak_cooldown_count', 3);
  const cooldownMs = strat.sl_streak_cooldown_ms ?? numSetting('sl_streak_cooldown_ms', 3600000);
  const dailyHaltCount = strat.sl_daily_halt_count ?? numSetting('sl_daily_halt_count', 3);
  const now = Date.now();

  const haltUntil = numSetting(haltKey, 0);
  if (now < haltUntil) return { active: true, armed: false, kind: 'daily_halt', until: haltUntil, threshold, cooldownMs, dailyHaltCount };
  const cooldownUntil = numSetting(cooldownKey, 0);
  if (now < cooldownUntil) return { active: true, armed: false, kind: 'cooldown', until: cooldownUntil, threshold, cooldownMs, dailyHaltCount };

  // A losing TRAILING_TP counts toward the streak just like an SL; only a flat/winning exit resets it.
  const recent = recentClosedExits(strat.id, threshold, now - cooldownMs);
  const isLoss = p => p.exit_reason === 'SL' || (p.pnl_percent != null && p.pnl_percent < 0);
  if (recent.length < threshold || !recent.every(isLoss)) return null;

  const newCooldownUntil = now + cooldownMs;
  setSetting(cooldownKey, String(newCooldownUntil));

  // Count arms within the current UTC day; the Nth arm escalates to a halt until 00:00 UTC.
  const today = utcDayStart(now);
  const armCount = (numSetting(dayKey, 0) === today ? numSetting(countKey, 0) : 0) + 1;
  setSetting(dayKey, String(today));
  setSetting(countKey, String(armCount));

  if (armCount >= dailyHaltCount) {
    const dayHaltUntil = today + DAY_MS;
    setSetting(haltKey, String(dayHaltUntil));
    return { active: true, armed: true, kind: 'daily_halt', until: dayHaltUntil, threshold, cooldownMs, dailyHaltCount, armCount };
  }
  return { active: true, armed: true, kind: 'cooldown', until: newCooldownUntil, threshold, cooldownMs, dailyHaltCount, armCount };
}

export const seenSignalCandidates = new Map();

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

export async function processCandidateFromSignals(signals) {
  // Skip if max positions reached — don't waste enrichment/LLM calls
  const strat = activeStrategy();
  if (!canOpenMorePositions()) {
    agentLog.info(`max positions reached (${openPositionCount()}/${strat.max_open_positions}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  const cooldown = checkSlCooldown(strat);
  if (cooldown) {
    const dailyHalt = cooldown.kind === 'daily_halt';
    const action = `entry_skipped_sl_${dailyHalt ? 'daily_halt' : 'cooldown'}${cooldown.armed ? '_armed' : ''}`;
    agentLog.info(`${dailyHalt ? 'sl daily halt' : 'sl streak cooldown'} active (${strat.id}${cooldown.armed ? ', just armed' : ''}), skipping ${signals.mint.slice(0, 8)}...`);
    logDecisionEvent({
      decision: { selected_mint: signals.mint },
      action,
      strategyId: strat.id,
      guardrails: {
        cooldownUntilMs: cooldown.until,
        slStreakThreshold: cooldown.threshold,
        cooldownMs: cooldown.cooldownMs,
        dailyHaltCount: cooldown.dailyHaltCount,
        armCountToday: cooldown.armCount,
      },
    });
    return;
  }

  const candidate = await buildCandidate(signals);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);
  if (!candidate.filters.passed) {
    candidateLog.info(`filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }
  let rows, batchDecision, batchId;

  if (!strat.use_llm) {
    const selfRow = candidateById(candidateId);
    rows = selfRow ? [selfRow] : [];
    batchId = null;
    batchDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      selected_row: selfRow,
      reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent,
      suggested_sl_percent: strat.sl_percent,
      raw: null,
    };
  } else {
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }
  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;
  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };
  const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  if (batchId) await sendBatchReveal(batchId, rows, batchDecision, candidateId);

  const minConfidence = strat.llm_min_confidence ?? numSetting('llm_min_confidence', 75);
  if (selectedRow && boolSetting('agent_enabled', true) && batchDecision.verdict === 'BUY' && batchDecision.confidence >= minConfidence) {
    if (!canOpenMorePositions()) {
      const max = strat.max_open_positions;
      agentLog.info(`max open positions reached (${openPositionCount()}/${max}), skipping buy ${selectedRow.candidate.token.mint}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        guardrails: { maxOpenPositions: max, openPositions: openPositionCount() },
      });
      return;
    }
    await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled: boolSetting('agent_enabled', true),
        confidenceThreshold: minConfidence,
        openPositions: openPositionCount(),
        maxOpenPositions: strat.max_open_positions,
      },
    });
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const freshSelectedRow = await refreshCandidateForExecution(selectedRow);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);

  const dupPositionId = hasOpenPositionForMint(freshSelectedRow.candidate.token?.mint);
  if (dupPositionId) {
    updateCandidateStatus(freshSelectedRow.id, 'duplicate_open_position');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_duplicate_position',
      guardrails: { existingPositionId: dupPositionId },
    });
    await sendTelegram([
      '🛑 <b>Skipped — position already open</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Already holding open position #${dupPositionId} for this mint.`,
    ].join('\n'));
    return;
  }

  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (mode === 'dry_run') {
    const positionId = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`);
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'dry_run_entry',
      guardrails: { maxOpenPositions: activeStrategy().max_open_positions, openPositions: openPositionCount() },
      execution: { positionId },
    });
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: activeStrategy().max_open_positions, openPositions: openPositionCount() },
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: activeStrategy().max_open_positions, openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
