export function evaluateExitTick({
  entryMcap,
  entryPrice,
  sizeSol,
  highWaterMcap = 0,
  highWaterPrice = 0,
  trailingArmed = false,
  partialTpDone = false,
  currentPrice,
  currentMcap,
  tpPercent,
  slPercent,
  trailingEnabled = false,
  trailingPercent = 0,
  maxHoldMs = 0,
  openedAtMs,
  nowMs,
  partialTp = false,
  partialTpAtPercent = 0,
  partialTpSellPercent = 0,
  pnlOverride = null,
}) {
  const entryM = Number(entryMcap);
  const curM = Number(currentMcap);
  if (!Number.isFinite(curM) || !Number.isFinite(entryM) || entryM <= 0) {
    return {
      pnlPercent: 0,
      pnlSol: 0,
      highWaterMcap,
      highWaterPrice,
      trailingArmed,
      partialTpDone,
      exitReason: null,
      partialTpTriggeredThisTick: false,
    };
  }

  let pnlPercent = (curM / entryM - 1) * 100;
  let pnlSol = Number(sizeSol) * pnlPercent / 100;
  if (pnlOverride && Number.isFinite(Number(pnlOverride.pnlPercent))) {
    pnlPercent = Number(pnlOverride.pnlPercent);
    if (Number.isFinite(Number(pnlOverride.pnlSol))) pnlSol = Number(pnlOverride.pnlSol);
  }

  const nextHighMcap = Math.max(Number(highWaterMcap || 0), curM);
  const nextHighPrice = Math.max(Number(highWaterPrice || 0), Number(currentPrice || 0));

  const tpHit = pnlPercent >= Number(tpPercent);
  const slHit = pnlPercent <= Number(slPercent);
  const nextTrailingArmed = trailingArmed || (trailingEnabled && tpHit);
  const trailDrop = nextHighMcap > 0 ? (curM / nextHighMcap - 1) * 100 : 0;
  const trailingHit = nextTrailingArmed && trailingEnabled && trailDrop <= -Math.abs(Number(trailingPercent));

  let exitReason = null;

  if (Number(maxHoldMs) > 0 && Number(nowMs) - Number(openedAtMs) >= Number(maxHoldMs)) {
    exitReason = 'MAX_HOLD';
  }

  let partialTpTriggeredThisTick = false;
  let nextPartialTpDone = partialTpDone;
  if (!exitReason && partialTp && !partialTpDone && pnlPercent >= Number(partialTpAtPercent)) {
    partialTpTriggeredThisTick = true;
    nextPartialTpDone = true;
  }

  if (!exitReason) {
    if (slHit) exitReason = 'SL';
    else if (tpHit && !trailingEnabled) exitReason = 'TP';
    else if (trailingHit) exitReason = 'TRAILING_TP';
  }

  return {
    pnlPercent,
    pnlSol,
    highWaterMcap: nextHighMcap,
    highWaterPrice: nextHighPrice,
    trailingArmed: nextTrailingArmed,
    partialTpDone: nextPartialTpDone,
    exitReason,
    partialTpTriggeredThisTick,
    partialTpSellPercent: Number(partialTpSellPercent) || 0,
  };
}
