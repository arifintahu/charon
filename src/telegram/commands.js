import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now, json } from '../utils.js';
import { escapeHtml, fmtPct } from '../format.js';
import { db } from '../db/connection.js';
import { enqueueSync } from '../db/outbox.js';
import { setSetting, allStrategies, invalidateStrategyCache } from '../db/settings.js';
import { loadStrategiesFromDisk, syncStrategiesToDb, diffStrategies } from '../db/strategySeeds.js';
import { candidateById, latestCandidateByMint } from '../db/candidates.js';
import {
  menuKeyboard,
  filtersText,
  navKeyboard,
  mainMenuText,
  candidateButtons,
  positionButtons,
  strategyMenuText,
  strategyKeyboard,
} from './menus.js';
import { candidateSummary, formatPosition } from './format.js';
import { refreshPosition } from '../execution/positions.js';
import { executeLiveSell } from '../execution/router.js';
import { handleCallback, editMenuMessage } from './callbacks.js';
import { consumeNumericFilterInput } from './input.js';
import { runLearning, sendLessons } from '../learning/commands.js';
import { fetchWalletPnl } from '../enrichment/wallets.js';
import { logger } from '../log.js';

const positionLog = logger('position');
const telegramLog = logger('telegram');
const callbackLog = logger('callback');
const messageLog = logger('message');

export async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (await consumeNumericFilterInput(chatId, text, msg.message_id)) return;
  if (!text.startsWith('/')) return;
  if (text.startsWith('/menu')) return sendMenu(chatId);
  if (text.startsWith('/positions')) return sendPositions(chatId);
  if (text.startsWith('/filters')) return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  if (text.startsWith('/strategy')) {
    return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
  }
  if (text.startsWith('/resetstrategies')) {
    return handleResetStrategies(chatId, text);
  }
  if (text.startsWith('/pnl')) return sendPnl(chatId);
  if (text.startsWith('/learn')) {
    const windowArg = text.split(/\s+/)[1] || '12h';
    return runLearning(chatId, windowArg);
  }
  if (text.startsWith('/lessons')) return sendLessons(chatId);
  if (text.startsWith('/candidate')) {
    const mint = text.split(/\s+/)[1];
    if (!mint) return bot.sendMessage(chatId, 'Usage: /candidate <mint>');
    const row = latestCandidateByMint(mint);
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    return sendCandidate(chatId, row.id);
  }
  if (text.startsWith('/walletadd')) {
    const [, label, address] = text.split(/\s+/);
    if (!label || !address) return bot.sendMessage(chatId, 'Usage: /walletadd <label> <address>');
    db.prepare(`
      INSERT INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET address = excluded.address
    `).run(label, address, now());
    return bot.sendMessage(chatId, `Saved wallet ${label}.`);
  }
  if (text.startsWith('/walletremove')) {
    const label = text.split(/\s+/)[1];
    if (!label) return bot.sendMessage(chatId, 'Usage: /walletremove <label>');
    db.prepare('DELETE FROM saved_wallets WHERE label = ?').run(label);
    return bot.sendMessage(chatId, `Removed ${label}.`);
  }
  if (text.startsWith('/wallets')) return handleCallback({ id: 'manual', data: 'menu:wallets', message: { chat: { id: chatId } } });
  if (text.startsWith('/setfilter')) {
    const { key, value } = parseSetFilter(text);
    const valid = new Set([
      'min_mcap_usd',
      'max_mcap_usd',
      'min_gmgn_total_fee_sol',
      'min_graduated_volume_usd',
      'max_top20_holder_percent',
      'min_saved_wallet_holders',
      'trending_enabled',
      'trending_source',
      'trending_allow_degen',
      'trending_interval',
      'trending_limit',
      'trending_order_by',
      'trading_mode',
      'llm_min_confidence',
      'llm_candidate_pick_count',
      'llm_candidate_max_age_ms',
    ]);
    if (!valid.has(key) || value == null) {
      return bot.sendMessage(chatId, `Usage: /setfilter &lt;name&gt; &lt;value&gt;\n\n${filtersText()}`, { parse_mode: 'HTML' });
    }
    setSetting(key, value === 'off' ? '0' : value);
    return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  }
}

async function handleResetStrategies(chatId, text) {
  const parts = text.split(/\s+/);
  const confirm = parts[1] === 'confirm';
  let fromDisk;
  try {
    fromDisk = loadStrategiesFromDisk();
  } catch (err) {
    return bot.sendMessage(chatId, `❌ Failed to load strategies from disk:\n${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
  const fromDb = allStrategies();
  const diff = diffStrategies(fromDb, fromDisk);
  const lines = ['🔄 <b>Reset strategies</b>'];
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    lines.push('', 'SQLite already matches strategies/ — no changes.');
    return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }
  for (const id of diff.added) lines.push(`+ ${id} (insert)`);
  for (const id of diff.removed) lines.push(`- ${id} (delete)`);
  for (const c of diff.changed) lines.push(`~ ${c.id}: ${c.fields.length} field(s)\n   ${c.fields.map(escapeHtml).join('\n   ')}`);
  if (!confirm) {
    lines.push('', 'Run <code>/resetstrategies confirm</code> to apply.');
    return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  }
  syncStrategiesToDb(db, fromDisk, { invalidateCache: invalidateStrategyCache });
  lines.push('', '✅ Applied.');
  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

export async function sendCandidate(chatId, id) {
  const row = candidateById(id);
  if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
  const decision = db.prepare('SELECT * FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(id);
  await bot.sendMessage(chatId, candidateSummary(row.candidate, decision), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...candidateButtons(id, decision),
  });
}

export async function sendPositions(chatId) {
  const rows = allPositions(12);
  const text = rows.length ? rows.map(formatPosition).join('\n\n') : 'No dry-run positions yet.';
  await bot.sendMessage(chatId, `📍 <b>Positions</b>\n\n${text}`, { parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function sendPosition(chatId, id, query = null) {
  let row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  if (row.status === 'open') {
    const refreshed = await refreshPosition(row, { autoExit: row.execution_mode !== 'live' }).catch((err) => {
      positionLog.warn(`refresh ${id} ${err.message}`);
      return null;
    });
    if (refreshed) row = { ...row, ...refreshed };
  }
  const buttons = row.status === 'open' ? positionButtons(id) : {};
  if (query) return editMenuMessage(query, formatPosition(row), buttons);
  await bot.sendMessage(chatId, formatPosition(row), { parse_mode: 'HTML', disable_web_page_preview: true, ...buttons });
}

export async function closePosition(chatId, id, reason) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row || row.status !== 'open') return bot.sendMessage(chatId, 'Open position not found.');
  const result = await refreshPosition(row, { autoExit: false });
  const price = result?.price ?? row.high_water_price ?? row.entry_price;
  const mcap = result?.mcap ?? row.high_water_mcap ?? row.entry_mcap;
  const pnlPercent = row.entry_mcap ? (Number(mcap) / Number(row.entry_mcap) - 1) * 100 : 0;
  const pnlSol = Number(row.size_sol) * pnlPercent / 100;
  let sell = null;
  if (row.execution_mode === 'live') sell = await executeLiveSell(row, reason);
  db.prepare(`
    UPDATE dry_run_positions
    SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
        pnl_percent = ?, pnl_sol = ?, exit_signature = ?
    WHERE id = ?
  `).run(now(), price, mcap, reason, pnlPercent, pnlSol, sell?.signature || null, id);
  enqueueSync('dry_run_positions', id);
  const tradeRes = db.prepare(`
    INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
    VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, row.mint, now(), price, mcap, row.size_sol, row.token_amount_est, reason, json({ pnlPercent, pnlSol, sell }));
  enqueueSync('dry_run_trades', Number(tradeRes.lastInsertRowid));
  const label = row.execution_mode === 'live' ? 'Closed live position' : 'Closed dry-run position';
  await bot.sendMessage(chatId, `${label} #${id}: ${escapeHtml(reason)} ${fmtPct(pnlPercent)}`, { parse_mode: 'HTML' });
}

export async function updatePositionRule(chatId, id, field, nextValue, query = null) {
  if (!Number.isFinite(nextValue)) return bot.sendMessage(chatId, 'Invalid value.');
  db.prepare(`UPDATE dry_run_positions SET ${field} = ? WHERE id = ?`).run(nextValue, id);
  enqueueSync('dry_run_positions', id);
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (row) {
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(position_id) DO UPDATE SET
        tp_percent = excluded.tp_percent,
        sl_percent = excluded.sl_percent,
        trailing_enabled = excluded.trailing_enabled,
        trailing_percent = excluded.trailing_percent,
        updated_at_ms = excluded.updated_at_ms
    `).run(id, row.tp_percent, row.sl_percent, row.trailing_enabled, row.trailing_percent, now());
  }
  await sendPosition(chatId, id, query);
}

export async function toggleTrailing(chatId, id, query = null) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  const next = row.trailing_enabled ? 0 : 1;
  db.prepare('UPDATE dry_run_positions SET trailing_enabled = ? WHERE id = ?').run(next, id);
  enqueueSync('dry_run_positions', id);
  db.prepare(`
    INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(position_id) DO UPDATE SET
      tp_percent = excluded.tp_percent,
      sl_percent = excluded.sl_percent,
      trailing_enabled = excluded.trailing_enabled,
      trailing_percent = excluded.trailing_percent,
      updated_at_ms = excluded.updated_at_ms
  `).run(id, row.tp_percent, row.sl_percent, next, row.trailing_percent, now());
  await sendPosition(chatId, id, query);
}

export function setupTelegram() {
  bot.setMyCommands([
    { command: 'menu', description: 'Open Charon menu' },
    { command: 'strategy', description: 'Show strategy menu' },
    { command: 'resetstrategies', description: 'Re-sync strategies table from strategies/*.json' },
    { command: 'positions', description: 'Show dry-run positions' },
    { command: 'candidate', description: 'Show candidate by mint' },
    { command: 'filters', description: 'Show filters' },
    { command: 'pnl', description: 'Show saved-wallet PnL' },
    { command: 'learn', description: 'Run manual learning report' },
    { command: 'lessons', description: 'Show active screening lessons' },
    { command: 'setfilter', description: 'Set a filter value' },
    { command: 'walletadd', description: 'Save wallet for exposure/PnL' },
    { command: 'walletremove', description: 'Remove saved wallet' },
    { command: 'wallets', description: 'List saved wallets' },
  ]).catch(err => telegramLog.warn(`commands ${err.message}`));

  bot.on('callback_query', query => handleCallback(query).catch(err => callbackLog.warn(err.message)));
  bot.on('message', msg => handleMessage(msg).catch(err => messageLog.warn(err.message)));
  bot.on('polling_error', err => telegramLog.warn(`polling ${err.message}`));
}

async function sendMenu(chatId = TELEGRAM_CHAT_ID) {
  const { TELEGRAM_TOPIC_ID } = await import('../config.js');
  await bot.sendMessage(chatId, mainMenuText(), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...menuKeyboard(),
  });
}

async function sendPnl(chatId, query = null) {
  const wallets = savedWallets();
  if (!wallets.length) {
    const text = '📊 <b>PnL</b>\n\nNo saved wallets. Use /walletadd &lt;label&gt; &lt;address&gt;.';
    return query ? editMenuMessage(query, text, navKeyboard()) : bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  }
  const chunks = [];
  for (const wallet of wallets) {
    const pnl = await fetchWalletPnl(wallet.address).catch(() => null);
    if (!pnl) {
      chunks.push(`• <b>${escapeHtml(wallet.label)}</b>: no data`);
      continue;
    }
    chunks.push([
      `• <b>${escapeHtml(wallet.label)}</b>`,
      `Win: ${fmtPct(pnl.winRate)} · PnL: ${fmtPct(pnl.totalPnlPercent)}`,
      `Trades: ${pnl.totalTrades} · Wins: ${pnl.wins}`,
    ].join('\n'));
  }
  const text = `📊 <b>PnL</b>\n\n${chunks.join('\n\n')}`;
  return query ? editMenuMessage(query, text, navKeyboard()) : bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

function parseSetFilter(text) {
  const parts = text.trim().split(/\s+/);
  return { key: parts[1], value: parts[2] };
}

function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

function savedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
}
