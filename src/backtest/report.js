function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function fmt(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function summariseSimulated(results) {
  const sims = results.positions.filter(p => p.outcome === 'simulated');
  const closed = sims.filter(p => p.exitReason !== 'OPEN' && p.exitReason !== 'NO_DATA');
  const pnls = closed.map(p => Number(p.pnlPercent));
  const wins = closed.filter(p => Number(p.pnlPercent) > 0).length;
  const byReason = new Map();
  for (const p of closed) {
    const key = p.exitReason || 'UNKNOWN';
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push(Number(p.pnlPercent));
  }
  const byCohort = new Map();
  for (const p of sims) {
    const key = p.cohort || 'simulated';
    if (!byCohort.has(key)) byCohort.set(key, []);
    if (p.exitReason !== 'OPEN' && p.exitReason !== 'NO_DATA') byCohort.get(key).push(Number(p.pnlPercent));
  }
  return {
    closed: closed.length,
    open: sims.length - closed.length,
    winRate: closed.length ? (wins / closed.length) * 100 : 0,
    avgPnl: avg(pnls),
    medianPnl: median(pnls),
    bestPnl: pnls.length ? Math.max(...pnls) : 0,
    worstPnl: pnls.length ? Math.min(...pnls) : 0,
    avgDrawdown: avg(closed.map(p => Number(p.maxDrawdownPercent || 0))),
    avgRunUp: avg(closed.map(p => Number(p.maxRunUpPercent || 0))),
    ambiguousCandles: closed.reduce((s, p) => s + Number(p.ambiguousCandleCount || 0), 0),
    byReason: [...byReason.entries()].map(([reason, list]) => ({
      reason, count: list.length, avgPnl: avg(list), medianPnl: median(list),
    })).sort((a, b) => b.count - a.count),
    byCohort: [...byCohort.entries()].map(([cohort, list]) => ({
      cohort, count: list.length, avgPnl: avg(list), medianPnl: median(list),
    })),
  };
}

export function formatSingleReport(results) {
  const s = summariseSimulated(results);
  const lines = [];
  const c = results.counts;
  lines.push('## Backtest (single config)');
  lines.push('');
  lines.push(`Closed: ${s.closed} · Open: ${s.open} · Win rate: ${fmt(s.winRate, 1)}% · Avg PnL: ${fmtPct(s.avgPnl)} · Median: ${fmtPct(s.medianPnl)}`);
  lines.push(`Drawdown avg: ${fmtPct(s.avgDrawdown)} · Run-up avg: ${fmtPct(s.avgRunUp)} · Best: ${fmtPct(s.bestPnl)} · Worst: ${fmtPct(s.worstPnl)}`);
  lines.push('');
  lines.push('Candidate funnel:');
  lines.push(`- Total: ${c.total}`);
  lines.push(`- Filtered (sim): ${c.filtered_sim}`);
  lines.push(`- LLM rejected (sim): ${c.llm_rejected_sim}`);
  lines.push(`- No entry price: ${c.no_entry_price}`);
  lines.push(`- No candles: ${c.no_candles}`);
  lines.push(`- Simulated: ${c.simulated} (unscreened cohort: ${c.unscreened_cohort})`);
  lines.push('');
  if (s.byReason.length) {
    lines.push('By exit reason:');
    for (const row of s.byReason) {
      lines.push(`- ${row.reason}: ${row.count} · avg ${fmtPct(row.avgPnl)} · median ${fmtPct(row.medianPnl)}`);
    }
    lines.push('');
  }
  if (s.byCohort.length > 1) {
    lines.push('By cohort:');
    for (const row of s.byCohort) {
      lines.push(`- ${row.cohort}: ${row.count} · avg ${fmtPct(row.avgPnl)} · median ${fmtPct(row.medianPnl)}`);
    }
    lines.push('');
  }
  lines.push(`Ambiguous candles (TP+SL same bar): ${s.ambiguousCandles}`);
  return lines.join('\n');
}

export function formatSweepReport(rows, { top = 10 } = {}) {
  const sorted = [...rows].sort((a, b) => b.summary.avgPnl - a.summary.avgPnl).slice(0, top);
  const lines = [];
  lines.push(`## Backtest sweep — top ${sorted.length}`);
  lines.push('');
  lines.push('cell | closed | win% | avg | median | drawdown | ambig');
  lines.push('---  | ---    | ---  | --- | ---    | ---      | ---');
  for (const row of sorted) {
    const s = row.summary;
    const label = Object.entries(row.cell).map(([k, v]) => `${k}=${v}`).join(' ');
    lines.push(`${label} | ${s.closed} | ${fmt(s.winRate, 1)} | ${fmtPct(s.avgPnl)} | ${fmtPct(s.medianPnl)} | ${fmtPct(s.avgDrawdown)} | ${s.ambiguousCandles}`);
  }
  return lines.join('\n');
}

export function formatValidationReport(results) {
  const rows = results.rows;
  const matched = rows.filter(r => r.sim_exit === r.actual_exit).length;
  const within5 = rows.filter(r => Math.abs(Number(r.delta_percent)) < 5).length;
  const within15 = rows.filter(r => Math.abs(Number(r.delta_percent)) < 15).length;
  const lines = [];
  lines.push('## Backtest validation');
  lines.push('');
  lines.push(`Positions: ${rows.length}`);
  lines.push(`Matching exit_reason: ${matched} (${rows.length ? fmt(matched / rows.length * 100, 1) : '—'}%)`);
  lines.push(`Within ±5% PnL: ${within5} (${rows.length ? fmt(within5 / rows.length * 100, 1) : '—'}%)`);
  lines.push(`Within ±15% PnL: ${within15} (${rows.length ? fmt(within15 / rows.length * 100, 1) : '—'}%)`);
  lines.push('');
  lines.push('pos | mint | actual | sim | actual% | sim% | Δ | ambig');
  for (const r of rows.slice(0, 50)) {
    lines.push(`${r.positionLocalId} | ${String(r.mint).slice(0, 10)}… | ${r.actual_exit || '—'} | ${r.sim_exit || '—'} | ${fmtPct(r.actual_pnl_percent)} | ${fmtPct(r.sim_pnl_percent)} | ${fmtPct(r.delta_percent)} | ${r.ambiguousCandleCount || 0}`);
  }
  if (rows.length > 50) lines.push(`… ${rows.length - 50} more`);
  return lines.join('\n');
}
