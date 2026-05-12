---
name: adding-bot-command
description: Use when adding a new Telegram text command to Charon (e.g. /foo). Walks through where to wire the handler, how to register it with Telegram's command list, and how to verify it via the headless CLI.
---

# Adding a Telegram command to Charon

A text command is a single branch in `handleMessage` in `src/telegram/commands.js` plus an entry in `setupTelegram`'s `bot.setMyCommands` call. The headless CLI picks it up automatically because it routes through the same `handleMessage`.

## Steps

### 1. Add the handler branch

Open `src/telegram/commands.js#handleMessage`. After the existing `text.startsWith('/...')` blocks, add yours:

```js
if (text.startsWith('/foo')) {
  const arg = text.split(/\s+/)[1];
  if (!arg) return bot.sendMessage(chatId, 'Usage: /foo <arg>');
  // ... do the thing, then:
  return bot.sendMessage(chatId, `Result: ${escapeHtml(result)}`, { parse_mode: 'HTML' });
}
```

Conventions:
- Always `return` the `bot.sendMessage` call so async flow is preserved.
- Use `escapeHtml` from `src/format.js` for any user/db-supplied string when `parse_mode: 'HTML'`.
- Read state through `src/db/*.js` helpers — don't query the DB inline if a helper exists.
- For writes, prefer existing helpers (`setSetting`, `updateStrategyConfig`, etc.). Inline `db.prepare(...)` only when the write is one-off and trivial.

### 2. Register with Telegram

In the same file, `setupTelegram()` calls `bot.setMyCommands([...])`. Append:

```js
{ command: 'foo', description: 'One-line description' },
```

Order matters only for the Telegram client's `/` autocomplete menu — group by purpose.

### 3. (Optional) Add a Claude slash command alias

If the command is one you'll want to drive headlessly, drop a file in `.claude/commands/foo.md`:

```markdown
---
description: Run /foo headlessly
allowed-tools:
  - Bash
argument-hint: <arg>
---

```bash
node scripts/cmd.js foo $ARGUMENTS
```
```

Skip this for one-offs — `/charon foo arg` already works without it.

### 4. Verify

```bash
npm run check                          # syntax
node scripts/cmd.js foo                # missing-arg path
node scripts/cmd.js foo bar            # happy path
```

If the command mutates state, follow up with `node scripts/cmd.js filters` or `/db "SELECT ..."` to confirm the write landed.

## Don't

- Don't add a callback-only path (inline keyboard with no text equivalent) unless absolutely necessary — it can't be exercised from the CLI.
- Don't duplicate menu/text bodies. The `src/telegram/menus.js` `*Text()` functions are the source of truth — call them.
- Don't validate `chatId` against `TELEGRAM_CHAT_ID` inside the handler — `bot` is configured to ignore other chats at the polling layer.
- Don't add comments restating what the handler does. The branch reads top-to-bottom.

## Reference

- Example single-arg with persistence: `/walletadd` in `src/telegram/commands.js`
- Example dispatched sub-handler with optional confirm flag: `/resetstrategies` → `handleResetStrategies` in `src/telegram/commands.js`
- Example calling a sub-handler: `/learn` → `runLearning` in `src/learning/commands.js`
- Example bouncing to a callback path: `/wallets` → `handleCallback({ data: 'menu:wallets', ... })`
