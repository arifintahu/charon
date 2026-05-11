# CLAUDE.md

Project-scoped guidance for Claude sessions on the Charon repo.

## What this is

Charon is a Telegram-driven Solana trading agent. It ingests Pump.fun token signals, enriches and filters candidates through strategy gates, optionally picks one via LLM, then executes in `dry_run` / `confirm` / `live` mode through Jupiter Ultra.

Trading hot path writes to local `charon.sqlite` (better-sqlite3, synchronous, never blocks on network). An async outbox worker mirrors analytic rows to Postgres (optional, set `POSTGRES_URL`) for cross-machine pooling and backtesting.

## Storage

- **Local SQLite** (`charon.sqlite`) — source of truth for trading. Open positions resume after restart. Strategy/settings hot-read with 5s cache.
- **Postgres** (optional) — analytic sink populated by `src/sync/postgresSink.js` from `sync_outbox` rows. Per-row `machine_id` partitions data across bot instances. `historical_candles` cache for the backtester lives here. Live state (positions, intents, guardrails) is per-machine; Postgres only pools analytics.
- Sync runs every `POSTGRES_SYNC_INTERVAL_MS` (default 5s), batched 100 rows, idempotent via `ON CONFLICT (machine_id, local_id) DO UPDATE`.
- If `POSTGRES_URL` is unset, the bot still runs — sync is a no-op.

## Verification

- `npm run check` — `node --check` on all boot files + the CLI shim.
- No test suite. Behaviour is observed via Telegram, or driven headlessly with `scripts/cmd.js` (see `using-charon-cli` skill).
- For the backtester: `node scripts/backtest.js --validate --from <window>` re-simulates closed positions against historical Jupiter candles. Tolerance ≥80% within ±5% PnL, ≥90% matching exit_reason is the trust threshold.
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

## Backtesting

- `npm run backtest:fetch -- --window <w>` warms `historical_candles` from Jupiter datapi.
- `npm run backtest -- --validate --from <w>` re-runs closed positions through the simulator.
- `npm run backtest -- --from <w> --override-tp 75 --override-sl -30 --override-llm-min-confidence 70` for single-config replay.
- `npm run backtest -- --from <w> --spec path/to/sweep.json --top 10` for cartesian sweeps.
- All reads go through Postgres; the backtester never touches SQLite directly. Run `pg:backfill` first if porting older data.

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
