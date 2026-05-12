---
name: using-charon-cli
description: Use when you need to drive the Charon bot without Telegram — checking state, switching strategy, setting filters, running learning, or verifying a behavioural change. Covers the headless `scripts/cmd.js` shim and its constraints.
---

# Using the Charon CLI

The Telegram bot's handlers are wired to a single `bot` instance. `scripts/cmd.js` sets `CHARON_CLI=1` (which makes `src/telegram/bot.js` skip polling) and stubs `bot.sendMessage`/`editMessageText` so handler output prints to stdout instead of Telegram. The handler code path is otherwise identical.

## Quick reference

```bash
# Read-only
node scripts/cmd.js positions
node scripts/cmd.js filters
node scripts/cmd.js strategy                       # show strategy menu (read-only)
node scripts/cmd.js lessons
node scripts/cmd.js pnl                            # network
node scripts/cmd.js candidate <mint>               # network

# State changes (write to charon.sqlite; running bot hot-reads)
node scripts/cmd.js resetstrategies                # diff sqlite vs strategies/*.json
node scripts/cmd.js resetstrategies confirm        # apply (after editing a JSON file)
node scripts/cmd.js setfilter min_mcap_usd 5000
node scripts/cmd.js walletadd alpha 9xQ...
node scripts/cmd.js learn 12h
```

Slash-command equivalents inside Claude Code: `/positions`, `/strategy`, `/filters`, `/charon <anything>`, `/db "SELECT ..."`.

## Output shape

- HTML tags stripped, links rendered as `text (url)`.
- Inline keyboards appear under a `[buttons]` block — they describe what would have been clickable in Telegram, but they are **not** clickable from the CLI.
- Multiple bot messages from one handler are separated by `———`.

## Constraints

- **No keyboard callbacks.** If a Telegram interaction is callback-only, find the text command that does the same write — `setfilter`, `resetstrategies`, etc. The `[buttons]` block in the output tells you what's available. To change strategy params, edit `strategies/<id>.json` and run `resetstrategies confirm`.
- **Live mutations.** Writes go straight to `charon.sqlite`. The running bot will pick them up on its next hot-read. If you need a sandbox, copy the DB first and set `DB_PATH` in `.env`.
- **Network costs.** `pnl`, `candidate <mint>`, `learn` make real API calls. Don't bulk-run them just to explore.
- **Config required.** `validateConfig()` still runs — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, RPC, etc. must be in `.env` even though the CLI doesn't open Telegram.

## When to use it

- "Does this change actually affect the bot's output?" → run the relevant command before and after the edit.
- "What's the bot currently filtering on?" → `filters` + `strategy`.
- "Did my migration leave the DB consistent?" → combine with `/db "SELECT ..."` for direct reads.
- "Walk me through a candidate end-to-end" → see the `add-bot-command` skill for the data flow; use this skill to inspect each artefact.

## When not to use it

- Anything that needs to observe the live signal stream — the CLI doesn't fire signal handlers, only Telegram command handlers.
- Anything that needs an inline keyboard interaction with no text equivalent (rare; check the `[buttons]` block first).
- Verifying live trade execution — `confirm`/`live` modes will try to actually swap. Stay on `dry_run` for CLI work.
