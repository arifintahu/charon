# CLAUDE.md

Project-scoped guidance for Claude sessions on the Charon repo.

## What this is

Charon is a Telegram-driven Solana trading agent. It ingests Pump.fun token signals, enriches and filters candidates through strategy gates, optionally picks one via LLM, then executes in `dry_run` / `confirm` / `live` mode through Jupiter Ultra.

Trading hot path writes to local `charon.sqlite` (better-sqlite3, synchronous, never blocks on network). An async outbox worker mirrors analytic rows to Postgres (optional, set `POSTGRES_URL`) for cross-machine pooling and evaluation.

## Storage

- **`strategies/*.json`** — source of truth for strategy definitions. Every boot rebuilds the SQLite `strategies` table from these files via `src/db/strategySeeds.js#syncStrategiesToDb` (REPLACE, not merge). To change a strategy: edit the JSON file, then either restart or `node scripts/cmd.js resetstrategies confirm`. The 5s cache picks the new values up automatically. Exactly one strategy may carry `enabled: true`.
- **Local SQLite** (`charon.sqlite`) — hot path for trading state (positions, intents, decisions, candidates). Strategy rows live here too but as a working copy of the JSON. Open positions resume after restart. Strategy/settings hot-read with 5s cache.
- **Postgres** (optional) — analytic sink populated by `src/sync/postgresSink.js` from `sync_outbox` rows. Per-row `machine_id` partitions data across bot instances. Live state (positions, intents, guardrails) is per-machine; Postgres only pools analytics.
- Sync runs every `POSTGRES_SYNC_INTERVAL_MS` (default 5s), batched 100 rows, idempotent via `ON CONFLICT (machine_id, local_id) DO UPDATE`.
- If `POSTGRES_URL` is unset, the bot still runs — sync is a no-op.

## Verification

- `npm run check` — `node --check` on all boot files + the CLI shim.
- No test suite. Behaviour is observed via Telegram, or driven headlessly with `scripts/cmd.js` (see `using-charon-cli` skill).
- Say so explicitly when you can't verify a UI/behaviour change end-to-end.

## Local Postgres (docker-compose)

```
npm run pg:up         # start Postgres 17 container
npm run pg:migrate    # apply src/db/postgresSchema.sql
npm run pg:backfill   # one-time SQLite → Postgres copy
npm run pg:psql       # interactive shell
npm run pg:down       # stop container (data persists in named volume)
```

`POSTGRES_URL=postgres://charon:charon@localhost:5432/charon` for local dev. Production points the same env var at the real host.

## Evaluation

- `/evaluate [windows]` (slash command) → dispatches the `charon-evaluator` subagent. Default windows `1d 3d 7d 30d`.
- Pulls the metric battery from Postgres analytics (headline / per-strategy / per-exit-reason / LLM-confidence buckets / config drift), writes one report per window to `evals/`.
- Recommendations are gated to ≥10 closed trades per window — below that it reports "insufficient data".

## Layout

| What | Where |
|---|---|
| File map, modes, gotchas | @.claude/rules/architecture.md |
| Writing/code style rules | @.claude/rules/writing-style.md |
| Strategy definitions | `strategies/*.json` (one file per strategy, source of truth) |
| Slash commands | `.claude/commands/` |
| Project subagents | `.claude/agents/` |
| Workflow skills | `.claude/skills/` |
| Permissions / hooks | `.claude/settings.json` |

The two `@` imports above are loaded into context automatically. Open the other folders on demand.

## Defaults

- Follow [@.claude/rules/writing-style.md](.claude/rules/writing-style.md) for all prose and code.
- Before editing source, check [@.claude/rules/architecture.md](.claude/rules/architecture.md) for the file map — it's faster than re-exploring.
- For multi-step recipes (adding a Telegram command, driving the bot headlessly), see `.claude/skills/`.
