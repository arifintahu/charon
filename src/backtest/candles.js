import axios from 'axios';
import { JSON_HEADERS } from '../config.js';
import { pgQuery } from '../db/postgres.js';

const INTERVAL_SECONDS = {
  '1_MINUTE': 60,
  '5_MINUTE': 300,
  '15_MINUTE': 900,
  '1_HOUR': 3600,
  '4_HOUR': 14400,
};

const CANDLES_PER_PAGE = 500;

export function intervalSeconds(interval) {
  return INTERVAL_SECONDS[interval] || 300;
}

async function fetchPage({ mint, interval, toMs, candles = CANDLES_PER_PAGE, quote = 'usd' }) {
  const url = new URL(`https://datapi.jup.ag/v2/charts/${mint}`);
  url.searchParams.set('interval', interval);
  url.searchParams.set('to', String(toMs));
  url.searchParams.set('candles', String(candles));
  url.searchParams.set('type', 'price');
  url.searchParams.set('quote', quote);
  const res = await axios.get(url.toString(), { timeout: 15_000, headers: JSON_HEADERS });
  return Array.isArray(res.data?.candles) ? res.data.candles : [];
}

async function persistCandles(mint, interval, quote, candles) {
  if (!candles.length) return 0;
  const valuesSql = [];
  const params = [];
  const fetchedAt = Date.now();
  for (const c of candles) {
    if (!Number.isFinite(Number(c.time))) continue;
    if (!Number.isFinite(Number(c.close))) continue;
    const i = params.length;
    valuesSql.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7}, $${i + 8}, $${i + 9}, $${i + 10})`);
    params.push(
      mint,
      interval,
      Number(c.time),
      Number(c.open),
      Number(c.high),
      Number(c.low),
      Number(c.close),
      c.volume != null ? Number(c.volume) : null,
      quote,
      fetchedAt,
    );
  }
  if (!valuesSql.length) return 0;
  const sql = `
    INSERT INTO historical_candles (mint, interval, time_sec, open, high, low, close, volume, quote, fetched_at_ms)
    VALUES ${valuesSql.join(',')}
    ON CONFLICT (mint, interval, time_sec, quote) DO NOTHING
  `;
  const res = await pgQuery(sql, params);
  return res.rowCount || 0;
}

function rangeCoverage(rows, fromSec, toSec) {
  if (!rows.length) return { hasFrom: false, hasTo: false, earliest: null, latest: null };
  let earliest = Infinity;
  let latest = -Infinity;
  for (const r of rows) {
    const t = Number(r.time_sec);
    if (t < earliest) earliest = t;
    if (t > latest) latest = t;
  }
  return {
    hasFrom: earliest <= fromSec,
    hasTo: latest >= toSec,
    earliest: earliest === Infinity ? null : earliest,
    latest: latest === -Infinity ? null : latest,
  };
}

export async function getCachedCandles({ mint, interval, fromMs, toMs, quote = 'usd' }) {
  const fromSec = Math.floor(Number(fromMs) / 1000);
  const toSec = Math.ceil(Number(toMs) / 1000);
  const res = await pgQuery(
    `SELECT mint, interval, time_sec, open, high, low, close, volume
     FROM historical_candles
     WHERE mint = $1 AND interval = $2 AND quote = $3 AND time_sec >= $4 AND time_sec <= $5
     ORDER BY time_sec ASC`,
    [mint, interval, quote, fromSec, toSec],
  );
  return res.rows;
}

export async function ensureCandles({ mint, interval, fromMs, toMs, quote = 'usd', maxPages = 12 }) {
  const fromSec = Math.floor(Number(fromMs) / 1000);
  const toSec = Math.ceil(Number(toMs) / 1000);
  const existing = await getCachedCandles({ mint, interval, fromMs, toMs, quote });
  const coverage = rangeCoverage(existing, fromSec, toSec);

  let inserted = 0;
  let pages = 0;
  let cursorMs = Number(toMs);
  while (pages < maxPages) {
    pages++;
    const candles = await fetchPage({ mint, interval, toMs: cursorMs, quote });
    if (!candles.length) break;
    inserted += await persistCandles(mint, interval, quote, candles);
    const firstTime = Number(candles[0].time);
    if (!Number.isFinite(firstTime)) break;
    if (firstTime <= fromSec) break;
    if (coverage.hasFrom && firstTime <= (coverage.latest || 0)) break;
    cursorMs = firstTime * 1000 - 1;
  }
  const final = await getCachedCandles({ mint, interval, fromMs, toMs, quote });
  return { rows: final, fetched: inserted, pages };
}

let probedFineInterval = null;

export async function pickFineInterval(mint) {
  if (probedFineInterval) return probedFineInterval;
  try {
    const candles = await fetchPage({ mint, interval: '1_MINUTE', toMs: Date.now(), candles: 5 });
    probedFineInterval = candles.length ? '1_MINUTE' : '5_MINUTE';
  } catch {
    probedFineInterval = '5_MINUTE';
  }
  return probedFineInterval;
}
