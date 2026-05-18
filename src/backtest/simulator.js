import { intervalSeconds } from './candles.js';

const ORDER_BY_RULE = {
  pessimistic: ['SL', 'TP', 'TRAILING_TP'],
  optimistic: ['TP', 'TRAILING_TP', 'SL'],
  midpoint: ['CLOSE_ONLY'],
};

function buildExitTriggers({ entryPrice, tpPercent, slPercent, highWaterPrice, trailingEnabled, trailingPercent }) {
  return {
    slPrice: entryPrice * (1 + Number(slPercent) / 100),
    tpPrice: entryPrice * (1 + Number(tpPercent) / 100),
    trailPrice: trailingEnabled && Number(trailingPercent) > 0
      ? highWaterPrice * (1 - Math.abs(Number(trailingPercent)) / 100)
      : null,
  };
}

export function simulatePosition({
  entryAtMs,
  entryPrice,
  entryMcap,
  sizeSol = 0.1,
  candles,
  strategyConfig,
  candleOrderRule = 'pessimistic',
}) {
  const tpPercent = Number(strategyConfig.tp_percent);
  const slPercent = Number(strategyConfig.sl_percent);
  const trailingEnabled = Boolean(strategyConfig.trailing_enabled);
  const trailingPercent = Number(strategyConfig.trailing_percent || 0);
  const trailingArmPercent = Number(strategyConfig.trailing_arm_percent || 0);
  const armPercent = trailingArmPercent > 0 ? trailingArmPercent : tpPercent;
  const maxHoldMs = Number(strategyConfig.max_hold_ms || 0);
  const partialTp = Boolean(strategyConfig.partial_tp);
  const partialTpAtPercent = Number(strategyConfig.partial_tp_at_percent || 0);

  if (!candles?.length || !Number.isFinite(Number(entryPrice)) || Number(entryPrice) <= 0
      || !Number.isFinite(Number(entryMcap)) || Number(entryMcap) <= 0) {
    return {
      exitReason: 'NO_DATA',
      exitPrice: null,
      exitMcap: null,
      exitAtMs: null,
      pnlPercent: 0,
      pnlSol: 0,
      holdMs: 0,
      ambiguousCandleCount: 0,
      maxDrawdownPercent: 0,
      maxRunUpPercent: 0,
      partialTpHits: 0,
      candlesEvaluated: 0,
    };
  }

  const stepMs = intervalSeconds(strategyConfig._interval || '5_MINUTE') * 1000;
  const order = ORDER_BY_RULE[candleOrderRule] || ORDER_BY_RULE.pessimistic;

  let highWaterPrice = Number(entryPrice);
  let trailingArmed = false;
  let partialTpDone = false;
  let partialTpHits = 0;
  let ambiguousCandleCount = 0;
  let maxDrawdownPercent = 0;
  let maxRunUpPercent = 0;
  let candlesEvaluated = 0;

  let lastClose = Number(entryPrice);
  let lastCandleEndMs = entryAtMs;

  for (const candle of candles) {
    const candleStartMs = Number(candle.time_sec || candle.time) * 1000;
    if (!Number.isFinite(candleStartMs)) continue;
    const candleEndMs = candleStartMs + stepMs;
    if (candleEndMs < entryAtMs) continue;
    candlesEvaluated++;

    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    lastClose = close;
    lastCandleEndMs = candleEndMs;

    // Update extreme excursions vs entry
    const runUp = (high / entryPrice - 1) * 100;
    const drawdown = (low / entryPrice - 1) * 100;
    if (runUp > maxRunUpPercent) maxRunUpPercent = runUp;
    if (drawdown < maxDrawdownPercent) maxDrawdownPercent = drawdown;

    // MAX_HOLD check: fire at candle close if it tips us over
    if (maxHoldMs > 0 && (candleEndMs - entryAtMs) >= maxHoldMs) {
      const exitPrice = close;
      const exitMcap = entryMcap * (exitPrice / entryPrice);
      const pnlPercent = (exitMcap / entryMcap - 1) * 100;
      return {
        exitReason: 'MAX_HOLD',
        exitPrice, exitMcap,
        exitAtMs: entryAtMs + maxHoldMs,
        pnlPercent,
        pnlSol: sizeSol * pnlPercent / 100,
        holdMs: maxHoldMs,
        highWaterPrice,
        ambiguousCandleCount,
        maxDrawdownPercent,
        maxRunUpPercent,
        partialTpHits,
        candlesEvaluated,
      };
    }

    // Partial TP: live behavior is "mark partial done, position stays open"
    if (partialTp && !partialTpDone) {
      const partialTrigger = entryPrice * (1 + partialTpAtPercent / 100);
      if (high >= partialTrigger) {
        partialTpDone = true;
        partialTpHits++;
      }
    }

    // Build exit triggers for this candle
    // For trailing: highWater may update mid-candle if high > current high water,
    // so trailing fire requires the high to have happened BEFORE the low.
    const triggers = buildExitTriggers({
      entryPrice, tpPercent, slPercent,
      highWaterPrice,
      trailingEnabled, trailingPercent,
    });
    const armPrice = entryPrice * (1 + armPercent / 100);

    const slTouched = low <= triggers.slPrice;
    const tpTouched = !trailingEnabled && high >= triggers.tpPrice;
    const trailingArmsThisCandle = trailingArmed || (trailingEnabled && high >= armPrice);
    const trailingTouched = trailingArmsThisCandle && triggers.trailPrice != null && low <= triggers.trailPrice;

    const touchedReasons = [];
    if (slTouched) touchedReasons.push('SL');
    if (tpTouched) touchedReasons.push('TP');
    if (trailingTouched) touchedReasons.push('TRAILING_TP');

    if (touchedReasons.length >= 2) ambiguousCandleCount++;

    let firedReason = null;
    if (candleOrderRule === 'midpoint') {
      // Only check whether close passes through a level
      if (slTouched && close <= triggers.slPrice) firedReason = 'SL';
      else if (tpTouched && close >= triggers.tpPrice) firedReason = 'TP';
      else if (trailingTouched && close <= (triggers.trailPrice || close)) firedReason = 'TRAILING_TP';
    } else {
      for (const candidate of order) {
        if (candidate === 'SL' && slTouched) { firedReason = 'SL'; break; }
        if (candidate === 'TP' && tpTouched) { firedReason = 'TP'; break; }
        if (candidate === 'TRAILING_TP' && trailingTouched) { firedReason = 'TRAILING_TP'; break; }
      }
    }

    if (firedReason) {
      let exitPrice;
      if (firedReason === 'SL') exitPrice = triggers.slPrice;
      else if (firedReason === 'TP') exitPrice = triggers.tpPrice;
      else exitPrice = triggers.trailPrice;
      const exitMcap = entryMcap * (exitPrice / entryPrice);
      const pnlPercent = (exitMcap / entryMcap - 1) * 100;
      // Estimate fire time within the candle: midpoint by default
      const exitAtMs = candleStartMs + Math.floor(stepMs / 2);
      return {
        exitReason: firedReason,
        exitPrice, exitMcap,
        exitAtMs,
        pnlPercent,
        pnlSol: sizeSol * pnlPercent / 100,
        holdMs: Math.max(0, exitAtMs - entryAtMs),
        highWaterPrice: Math.max(highWaterPrice, high),
        ambiguousCandleCount,
        maxDrawdownPercent,
        maxRunUpPercent,
        partialTpHits,
        candlesEvaluated,
      };
    }

    // Update high water and trailing armed AFTER exit checks for this candle
    if (high > highWaterPrice) highWaterPrice = high;
    if (!trailingArmed && trailingEnabled && high >= armPrice) trailingArmed = true;
  }

  // No exit fired → position remains OPEN at last candle close
  const pnlPercent = (lastClose / entryPrice - 1) * 100;
  return {
    exitReason: 'OPEN',
    exitPrice: lastClose,
    exitMcap: entryMcap * (lastClose / entryPrice),
    exitAtMs: lastCandleEndMs,
    pnlPercent,
    pnlSol: sizeSol * pnlPercent / 100,
    holdMs: Math.max(0, lastCandleEndMs - entryAtMs),
    highWaterPrice,
    ambiguousCandleCount,
    maxDrawdownPercent,
    maxRunUpPercent,
    partialTpHits,
    candlesEvaluated,
  };
}
