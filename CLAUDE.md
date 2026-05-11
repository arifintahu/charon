# CLAUDE.md

Project-scoped guidance for Claude sessions on the Charon repo.

## What this is

Charon is a Telegram-driven Solana trading agent. It ingests Pump.fun token signals, enriches and filters candidates through strategy gates, optionally picks one via LLM, then executes in `dry_run` / `confirm` / `live` mode through Jupiter Ultra. Source of truth is `charon.sqlite`.

## Verification

- `npm run check` — `node --check` on all boot files + the CLI shim.
- No test suite. Behaviour is observed via Telegram, or driven headlessly with `scripts/cmd.js` (see `using-charon-cli` skill).
- Say so explicitly when you can't verify a UI/behaviour change end-to-end.

## Layout

| What | Where |
|---|---|
| File map, modes, gotchas | @.claude/rules/architecture.md |
| Writing/code style rules | @.claude/rules/writing-style.md |
| Slash commands | `.claude/commands/` |
| Project subagents | `.claude/agents/` |
| Workflow skills | `.claude/skills/` |
| Permissions / hooks | `.claude/settings.json` |

The two `@` imports above are loaded into context automatically. Open the other folders on demand.

## Defaults

- Follow [@.claude/rules/writing-style.md](.claude/rules/writing-style.md) for all prose and code.
- Before editing source, check [@.claude/rules/architecture.md](.claude/rules/architecture.md) for the file map — it's faster than re-exploring.
- For multi-step recipes (adding a Telegram command, driving the bot headlessly), see `.claude/skills/`.
