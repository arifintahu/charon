import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now, parseNumericInput } from '../utils.js';
import { setSetting } from '../db/settings.js';
import {
  filtersText,
  filtersKeyboard,
  numericFilterLabels,
  navKeyboard,
} from './menus.js';

export const pendingNumericInputs = new Map();

export async function requestNumericFilterInput(query, key) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  if (!numericFilterLabels[key]) return bot.sendMessage(chatId, 'Unknown numeric filter.');
  pendingNumericInputs.set(String(chatId), {
    type: 'setting',
    key,
    at: now(),
    messageId: query.message?.message_id || null,
  });
  return editMenuMessage(
    query,
    `Send a number for ${numericFilterLabels[key]}.\nExamples: 5, 50000, 100k, 1.5m, off`,
    navKeyboard([[{ text: 'Cancel', callback_data: 'menu:filters' }]]),
  );
}

export async function consumeNumericFilterInput(chatId, text, userMessageId = null) {
  const pending = pendingNumericInputs.get(String(chatId));
  if (!pending) return false;
  if (now() - pending.at > 5 * 60 * 1000) {
    pendingNumericInputs.delete(String(chatId));
    await bot.sendMessage(chatId, 'That input expired. Tap the filter input button again.');
    return true;
  }
  const value = parseNumericInput(text);
  if (value == null) {
    await bot.sendMessage(chatId, 'Invalid number. Try 5, 50000, 100k, 1.5m, or off.');
    return true;
  }
  pendingNumericInputs.delete(String(chatId));
  if (userMessageId) bot.deleteMessage(chatId, userMessageId).catch(() => {});
  setSetting(pending.key, String(value));
  if (pending.messageId) {
    await bot.editMessageText(filtersText(), {
      chat_id: chatId,
      message_id: pending.messageId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...filtersKeyboard(),
    }).catch(() => bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML', ...filtersKeyboard() }));
  } else {
    await bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML', ...filtersKeyboard() });
  }
  return true;
}

async function editMenuMessage(query, text, extra = {}) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
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
