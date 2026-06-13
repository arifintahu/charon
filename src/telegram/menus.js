import { escapeHtml, fmtPct, fmtSol, fmtUsd } from '../format.js';
import { numSetting, boolSetting, setting, activeStrategy, allStrategies, hasEnabledStrategy } from '../db/settings.js';
import { openPositionCount, tradingMode, allPositions } from '../db/positions.js';
import { savedWallets } from '../enrichment/wallets.js';
import { gmgnStatusText } from '../enrichment/gmgn.js';
import { formatPosition } from './format.js';
import { ENABLE_LLM, LLM_API_KEY } from '../config.js';

export function menuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Strategy', callback_data: 'menu:strategy' },
          { text: 'Agent', callback_data: 'menu:agent' },
          { text: 'Filters', callback_data: 'menu:filters' },
        ],
        [
          { text: 'Wallets', callback_data: 'menu:wallets' },
          { text: 'Positions', callback_data: 'menu:positions' },
          { text: 'PnL', callback_data: 'menu:pnl' },
        ],
      ],
    },
  };
}

export function filtersText() {
  const strat = activeStrategy();
  return [
    `⚙️ <b>Charon Filters</b> (${escapeHtml(strat.name)})`,
    `Min claim fee: ${fmtSol(strat.min_fee_claim_sol)} SOL`,
    `Min mcap: ${fmtUsd(strat.min_mcap_usd)}`,
    `Max mcap: ${strat.max_mcap_usd > 0 ? fmtUsd(strat.max_mcap_usd) : 'off'}`,
    `Min trading fees: ${fmtSol(strat.min_gmgn_total_fee_sol)} SOL`,
    `Min grad volume: ${fmtUsd(strat.min_graduated_volume_usd)}`,
    `Min holders: ${strat.min_holders || 'off'}`,
    `Max holder: ${strat.max_top20_holder_percent < 100 ? fmtPct(strat.max_top20_holder_percent) : 'off'}`,
    `Min saved holders: ${strat.min_saved_wallet_holders || 'off'}`,
    strat.max_ath_distance_pct < 0 ? `Max ATH distance: ${strat.max_ath_distance_pct}%` : null,
    '',
    `Min sources: ${strat.min_source_count}`,
    `Fee required: ${strat.require_fee_claim ? 'yes' : 'no'}`,
    '',
    `Trending: <b>${boolSetting('trending_enabled', true) ? 'on' : 'off'}</b> · Source: <b>${escapeHtml(setting('trending_source', 'jupiter'))}</b>`,
    `GMGN status: token-info ${escapeHtml(gmgnStatusText('token'))} · trending ${escapeHtml(gmgnStatusText('trending'))}`,
    `Trending interval: ${escapeHtml(setting('trending_interval', '5m'))} · Limit: ${numSetting('trending_limit', 100)}`,
    `Min trend volume: ${fmtUsd(strat.trending_min_volume_usd)} · Min swaps: ${strat.trending_min_swaps}`,
    `Max trend rug: ${fmtPct(strat.trending_max_rug_ratio * 100)} · Max bundler: ${fmtPct(strat.trending_max_bundler_rate * 100)}`,
  ].filter(Boolean).join('\n');
}

export const numericFilterLabels = {
  min_mcap_usd: 'minimum mcap USD',
  max_mcap_usd: 'maximum mcap USD',
  min_gmgn_total_fee_sol: 'minimum total trading fees SOL (GMGN)',
  min_graduated_volume_usd: 'minimum graduated volume USD',
  max_top20_holder_percent: 'maximum holder percent',
  min_saved_wallet_holders: 'minimum saved-wallet holders',
  trending_limit: 'trending result limit',
};

export function filtersKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Configure in Strategy', callback_data: 'menu:strategy' }],
        [
          { text: 'Trend On/Off', callback_data: 'toggle:trending_enabled' },
          { text: 'Use Jupiter', callback_data: 'set:trending_source:jupiter' },
          { text: 'Use GMGN', callback_data: 'set:trending_source:gmgn' },
        ],
        [
          { text: 'Trend 5m', callback_data: 'set:trending_interval:5m' },
          { text: 'Trend 1h', callback_data: 'set:trending_interval:1h' },
          { text: 'Trend 6h', callback_data: 'set:trending_interval:6h' },
        ],
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function agentText() {
  const strat = activeStrategy();
  const fallback = !hasEnabledStrategy();
  return [
    '🛶 <b>Charon Agent</b>',
    fallback ? `⚠️ <b>No enabled strategy — falling back to ${escapeHtml(strat.name)}.</b> Edit <code>strategies/*.json</code> and run <code>/resetstrategies confirm</code>.` : null,
    `Strategy: <b>${escapeHtml(strat.name)}</b>${fallback ? ' (fallback)' : ''}`,
    `Agent: <b>${boolSetting('agent_enabled', true) ? 'on' : 'off'}</b>`,
    `Mode: <b>${escapeHtml(tradingMode())}</b>`,
    `LLM: <b>${strat.use_llm && ENABLE_LLM && LLM_API_KEY ? 'configured' : 'disabled'}</b>`,
    `Confidence: ${fmtPct(strat.llm_min_confidence || numSetting('llm_min_confidence', 75))}`,
    `Open positions: ${openPositionCount()}/${strat.max_open_positions || 'unlimited'}`,
    `Batch candidates: ${numSetting('llm_candidate_pick_count', 10)}`,
    `Candidate freshness: ${Math.round(numSetting('llm_candidate_max_age_ms', 600000) / 1000)}s`,
    `Size: ${fmtSol(strat.position_size_sol)} SOL`,
    `TP/SL: ${fmtPct(strat.tp_percent)} / ${fmtPct(strat.sl_percent)}`,
    `Trailing: ${strat.trailing_enabled ? fmtPct(strat.trailing_percent) : 'off'}`,
  ].filter(Boolean).join('\n');
}

export function agentKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Toggle Agent', callback_data: 'toggle:agent' }],
        [
          { text: 'Dry Run', callback_data: 'set:trading_mode:dry_run' },
          { text: 'Confirm', callback_data: 'set:trading_mode:confirm' },
          { text: 'Live', callback_data: 'set:trading_mode:live' },
        ],
        [
          { text: 'Batch 5', callback_data: 'set:llm_candidate_pick_count:5' },
          { text: 'Batch 10', callback_data: 'set:llm_candidate_pick_count:10' },
        ],
        [
          { text: 'Fresh 5m', callback_data: 'set:llm_candidate_max_age_ms:300000' },
          { text: 'Fresh 10m', callback_data: 'set:llm_candidate_max_age_ms:600000' },
          { text: 'Fresh 20m', callback_data: 'set:llm_candidate_max_age_ms:1200000' },
        ],
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function navKeyboard(rows = []) {
  return {
    reply_markup: {
      inline_keyboard: [
        ...rows,
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function mainMenuText() {
  return `🛶 <b>Charon</b>\nDry-run trench agent online.`;
}

export function walletsText() {
  const rows = savedWallets();
  const body = rows.length
    ? rows.map(row => `• <b>${escapeHtml(row.label)}</b>: <code>${escapeHtml(row.address)}</code>`).join('\n')
    : 'No saved wallets. Use /walletadd &lt;label&gt; &lt;address&gt;';
  return `👛 <b>Saved Wallets</b>\n\n${body}`;
}

export function positionsText() {
  const rows = allPositions(12);
  const text = rows.length ? rows.map(formatPosition).join('\n\n') : 'No dry-run positions yet.';
  return `📍 <b>Positions</b>\n\n${text}`;
}

export function strategyMenuText() {
  const strat = activeStrategy();
  const all = allStrategies();
  const fallback = !hasEnabledStrategy();
  const entryIcons = { immediate: '⚡', wait_for_dip: '📉', after_confirmation: '🧠' };
  return [
    '🎯 <b>Strategy</b>',
    '',
    fallback ? `⚠️ <b>No strategy enabled in strategies/*.json — falling back to ${escapeHtml(strat.name)}</b>` : null,
    fallback ? 'Set <code>"enabled": true</code> in <code>strategies/&lt;id&gt;.json</code>, then <code>/resetstrategies confirm</code>.' : null,
    fallback ? '' : null,
    `Active: <b>${escapeHtml(strat.name)}</b>${fallback ? ' (fallback)' : ''}`,
    `Entry: ${entryIcons[strat.entry_mode] || '?'} ${strat.entry_mode}`,
    `Min sources: ${strat.min_source_count}`,
    `Fee required: ${strat.require_fee_claim ? 'yes' : 'no'}`,
    `Size: ${fmtSol(strat.position_size_sol)} SOL`,
    `TP/SL: ${fmtPct(strat.tp_percent)} / ${fmtPct(strat.sl_percent)}`,
    `Trailing: ${strat.trailing_enabled ? fmtPct(strat.trailing_percent) : 'off'}`,
    `Max positions: ${strat.max_open_positions}`,
    strat.min_holders > 0 ? `Min holders: ${strat.min_holders}` : null,
    strat.max_ath_distance_pct < 0 ? `Max ATH distance: ${strat.max_ath_distance_pct}%` : null,
    strat.partial_tp ? `Partial TP: ${strat.partial_tp_sell_percent}% at ${fmtPct(strat.partial_tp_at_percent)}` : null,
    strat.max_hold_ms > 0 ? `Max hold: ${Math.round(strat.max_hold_ms / 60000)}m` : null,
    strat.use_llm ? `LLM: yes (min ${strat.llm_min_confidence}%)` : 'LLM: no (rule-based)',
    '',
    ...all.map(s => `${s.enabled ? '▶' : '○'} ${s.name}`),
  ].filter(Boolean).join('\n');
}

export function strategyKeyboard() {
  const all = allStrategies();
  const selector = all.map(s => [{
    text: `${s.enabled ? '▶ ' : ''}${s.name}`,
    callback_data: `strategy:select:${s.id}`,
  }]);
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '── Select Strategy ──', callback_data: 'noop' }],
        ...selector,
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function candidateButtons(candidateId, decision = null) {
  const verdict = String(decision?.verdict || '').toUpperCase();
  if (verdict && verdict !== 'BUY') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: `Skipped: ${verdict}`, callback_data: 'noop' }],
          [
            { text: 'View Candidate', callback_data: `cand:${candidateId}` },
            { text: 'Ignore', callback_data: `ign:${candidateId}` },
          ],
          [{ text: 'Positions', callback_data: 'menu:positions' }],
        ],
      },
    };
  }
  if (verdict === 'BUY') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'LLM BUY selected', callback_data: 'noop' }],
          [
            { text: 'View Candidate', callback_data: `cand:${candidateId}` },
            { text: 'Positions', callback_data: 'menu:positions' },
          ],
          [
            { text: 'Set TP/SL', callback_data: `tpsl:c:${candidateId}` },
            { text: 'Ignore', callback_data: `ign:${candidateId}` },
          ],
        ],
      },
    };
  }
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'View Candidate', callback_data: `cand:${candidateId}` },
          { text: 'Dry Buy', callback_data: `buy:${candidateId}` },
        ],
        [
          { text: 'Set TP/SL', callback_data: `tpsl:c:${candidateId}` },
          { text: 'Ignore', callback_data: `ign:${candidateId}` },
        ],
        [{ text: 'Positions', callback_data: 'menu:positions' }],
      ],
    },
  };
}

export function batchRevealButtons(batchId, rows, decision, triggerCandidateId = null) {
  const selectedId = Number(decision.selected_candidate_id || 0);
  const triggerId = Number(triggerCandidateId || 0);
  const keyboard = [];
  if (selectedId) keyboard.push([{ text: 'Reveal Pick', callback_data: `cand:${selectedId}` }]);
  keyboard.push([{ text: 'Reveal Batch', callback_data: `batch:${batchId}` }]);
  if (triggerId && triggerId !== selectedId) keyboard.push([{ text: 'Reveal Trigger', callback_data: `cand:${triggerId}` }]);
  keyboard.push([{ text: 'Positions', callback_data: 'menu:positions' }]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

export function positionButtons(positionId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Dry Sell', callback_data: `sell:${positionId}` },
          { text: 'Refresh', callback_data: `pos:${positionId}` },
        ],
        [
          { text: 'TP +25%', callback_data: `tp:${positionId}:25` },
          { text: 'TP +50%', callback_data: `tp:${positionId}:50` },
        ],
        [
          { text: 'SL -15%', callback_data: `sl:${positionId}:-15` },
          { text: 'SL -25%', callback_data: `sl:${positionId}:-25` },
        ],
        [{ text: 'Trail On/Off', callback_data: `trail:${positionId}` }],
      ],
    },
  };
}

export function intentButtons(intentId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Confirm Buy', callback_data: `intent:${intentId}:confirm` },
          { text: 'Reject', callback_data: `intent:${intentId}:reject` },
        ],
        [{ text: 'Positions', callback_data: 'menu:positions' }],
      ],
    },
  };
}

export async function sendTpSlDefaults(chatId, query = null) {
  const text = 'TP/SL defaults are now set per strategy in <code>strategies/&lt;id&gt;.json</code>. Edit the file and run <code>/resetstrategies confirm</code>.';
  if (query) return editMenuMessage(query, text, navKeyboard());
  const { bot } = await import('./bot.js');
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

async function editMenuMessage(query, text, extra = {}) {
  const { TELEGRAM_CHAT_ID } = await import('../config.js');
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  const { bot } = await import('./bot.js');
  if (!messageId) {
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }
}
