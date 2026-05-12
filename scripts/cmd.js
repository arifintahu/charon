#!/usr/bin/env node
// Headless driver for Charon Telegram commands.
//   node scripts/cmd.js positions
//   node scripts/cmd.js strategy
//   node scripts/cmd.js resetstrategies          (dry-run diff)
//   node scripts/cmd.js resetstrategies confirm  (apply)
//   node scripts/cmd.js candidate <mint>
// Setting CHARON_CLI=1 makes bot.js skip polling; bot.sendMessage / editMessageText
// are stubbed below so handler output prints to stdout instead of Telegram.

process.env.CHARON_CLI = '1';

const { validateConfig, TELEGRAM_CHAT_ID } = await import('../src/config.js');
validateConfig();

const { initDb } = await import('../src/db/connection.js');
initDb();

const { bot } = await import('../src/telegram/bot.js');

const captured = [];

function stripHtml(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
    .replace(/<\/?(b|i|u|s|strong|em|code|pre)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

function describeKeyboard(opts) {
  const kb = opts?.reply_markup?.inline_keyboard;
  if (!kb?.length) return '';
  const rows = kb.map(row => row.map(b => b.text).join(' | ')).join('\n');
  return `\n\n[buttons]\n${rows}`;
}

bot.sendMessage = async (chatId, text, opts = {}) => {
  captured.push(stripHtml(text) + describeKeyboard(opts));
  return { message_id: captured.length, chat: { id: chatId }, text: stripHtml(text) };
};
bot.editMessageText = async (text, opts = {}) => {
  captured.push(stripHtml(text) + describeKeyboard(opts));
  return true;
};
bot.answerCallbackQuery = async () => true;
bot.setMyCommands = async () => true;
bot.deleteMessage = async () => true;
bot.on = () => {};

const { handleMessage } = await import('../src/telegram/commands.js');

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error('Usage: node scripts/cmd.js <command> [args]');
  console.error('Examples:');
  console.error('  node scripts/cmd.js positions');
  console.error('  node scripts/cmd.js strategy');
  console.error('  node scripts/cmd.js resetstrategies');
  console.error('  node scripts/cmd.js resetstrategies confirm');
  console.error('  node scripts/cmd.js candidate <mint>');
  process.exit(2);
}

const text = (argv[0].startsWith('/') ? argv.join(' ') : '/' + argv.join(' ')).trim();

let exitCode = 0;
try {
  await handleMessage({
    text,
    chat: { id: Number(TELEGRAM_CHAT_ID) || 0 },
    message_id: 1,
  });
  if (!captured.length) {
    console.log('(no output — command may be unknown or returned silently)');
  } else {
    console.log(captured.join('\n\n———\n\n'));
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  exitCode = 1;
}

process.exit(exitCode);
