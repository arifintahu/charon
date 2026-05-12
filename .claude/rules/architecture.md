# Charon architecture

Canonical pipeline diagram: `docs/workflow.mmd`.

## Entry points

- `index.js` → `src/app.js#startCharon`
- Boot order: `validateConfig` → `initDb` → `startPostgresSync` (no-op if `POSTGRES_URL` unset) → `initLiveExecution` → `setupTelegram` → signal mode branch → `monitorPositions` interval

## File map per pipeline stage

| Stage | Files |
|---|---|
| Signal ingest | `src/signals/{serverClient,feeClaim,graduated,trending,priceMonitor,axiomSource}.js` |
| Candidate build + enrichment | `src/pipeline/candidateBuilder.js`, `src/enrichment/{gmgn,jupiter,twitter,wallets}.js` |
| Filters + strategy gates | `src/pipeline/orchestrator.js` |
| LLM screening | `src/pipeline/llm.js` |
| Execution | `src/execution/{router,positions,exitSimulator}.js`, `src/liveExecutor.js` |
| Telegram I/O | `src/telegram/{commands,callbacks,menus,send,format,input,bot}.js` |
| Persistence (SQLite) | `src/db/{connection,candidates,decisions,intents,positions,settings,outbox,machineId,strategySeeds}.js` |
| Strategies | `strategies/*.json` (source of truth), `src/strategy/schema.js` (whitelist + validator), `src/db/strategySeeds.js` (loader + sync) |
| Persistence (Postgres) | `src/db/postgres.js`, `src/db/postgresSchema.sql`, `src/sync/postgresSink.js` |
| Backtesting | `src/backtest/{candles,simulator,runner,report}.js`, `scripts/backtest{,-fetch}.js` |
| Learning / reports | `src/learning/{commands,lessons,report,summary}.js` |
| Config | `src/config.js`, `.env`, `docker-compose.yml` |
| Utilities | `src/utils.js`, `src/format.js` |

## Operating modes

Selected at boot in `src/app.js`:

- **Server mode** (`SIGNAL_SERVER_URL` set): polls signal server every `SIGNAL_POLL_MS`; price monitor handles dip alerts every 10s.
- **Standalone mode** (legacy): fee-claim websocket + graduated poll (`GRADUATED_POLL_MS`) + trending poll (`TRENDING_POLL_MS`).

Position monitor (`monitorPositions`) runs in both modes on `POSITION_CHECK_MS`.

## Execution modes

`TRADING_MODE` env var:

- `dry_run` — simulated buys/sells in SQLite. No wallet.
- `confirm` — Telegram approve/reject intent, then live.
- `live` — immediate Jupiter Ultra swap after approval.

`confirm` and `live` require `SOLANA_PRIVATE_KEY`, `JUPITER_API_KEY`, and a working RPC.

## Storage

- `charon.sqlite` (better-sqlite3) is the trading hot-path source of truth.
- Open positions resume monitoring after restart.
- Strategy configs are hot-read from SQLite (5s cache) — but **SQLite strategies are a working copy of `strategies/*.json`**. Every boot rebuilds the table from those files via `src/db/strategySeeds.js#syncStrategiesToDb` (REPLACE, not merge). To change a strategy: edit its JSON file, then restart or `/resetstrategies confirm`.
- A strategy may only carry `enabled: true` if its JSON has a `validation` block under 30 days old. Run `npm run backtest -- --strategy <id> --from 7d --validate-strategy` to populate it (atomic write).
- `.env` values (API keys, wallet key, RPC URLs, polling intervals) require restart.

### Postgres analytics sink (optional)

- Enabled by `POSTGRES_URL`. The bot still runs without it; sync becomes a no-op.
- `docker-compose.yml` runs Postgres 17 locally. `npm run pg:up | pg:migrate | pg:backfill | pg:psql | pg:down`.
- Per-row `machine_id` (auto-generated UUID, persisted to `settings.machine_id`) partitions data across bot instances.
- Outbox pattern: writes to SQLite append a row to `sync_outbox`; `src/sync/postgresSink.js` drains it every `POSTGRES_SYNC_INTERVAL_MS` (default 5s) in FIFO batches of `POSTGRES_SYNC_BATCH_SIZE` (default 100), idempotent via `ON CONFLICT (machine_id, local_id) DO UPDATE`.
- Tables synced: `signal_events`, `candidates`, `llm_decisions`, `llm_batches`, `decision_logs`, `dry_run_positions`, `dry_run_trades`, `learning_lessons`. **Not synced**: `settings`, `strategies`, `saved_wallets`, `price_alerts`, `trade_intents`, `tp_sl_rules` (per-machine live state).
- Failure handling: outbox rows back off exponentially on Postgres errors. Live trading is unaffected by remote outages.
- JSONB columns are stringified via `JSON.stringify` before parameter binding — `pg` coerces JS arrays into Postgres arrays otherwise.

### Backtester

- Reads from Postgres only (`POSTGRES_URL` required). Run `npm run pg:backfill` once to seed it.
- `scripts/backtest-fetch.js` warms `historical_candles` from Jupiter datapi `/v2/charts/{mint}` (1m/5m/1h/4h intervals).
- `scripts/backtest.js` modes:
  - default — single config replay against archived candidates.
  - `--validate` — re-simulate closed positions; pass criterion ≥80% within ±5% PnL, ≥90% matching `exit_reason`.
  - `--spec <path>` — cartesian sweep of `tp_percent`, `sl_percent`, `trailing_percent`, `llm_min_confidence`.
- Exit fills are modeled at trigger price (entry × (1 + sl/100)) — not the candle wick low — to match live polling behavior. Real stops fill near the trigger; candle lows are not honest exit prices.
- `candle-rule`: `pessimistic` (SL fires first when both touched in one candle), `optimistic`, `midpoint`. Ambiguous candles (both touched) are counted and surfaced.
- `unscreened-policy`: `cohort` (default — simulate but tag separately) | `skip` | `approve`. Applies to candidates that were filtered before reaching the LLM.

### Per-trade snapshot

`dry_run_positions.snapshot_json` captures the agent state at entry. Shape:

```
{ candidate, decision, reason, swap?, strategy: {id, name, ...all strategy config fields}, env: {curated .env vars} }
```

The `env` whitelist lives in `src/db/positions.js#ENV_SNAPSHOT_KEYS` — signal toggles, polling cadences, GMGN, LLM, trading mode. No secrets. Positions opened before this enrichment have `strategy` as a string id and `env: null` — evaluator treats these as a pre-snapshot cohort.

## Conventions and gotchas

- ESM project (`"type": "module"`). Use `import`, never `require`.
- `@solana/web3.js` v1 (legacy SDK). Migration to `@solana/kit` is noted in README — stay on v1 until then.
- GMGN has aggressive rate limits. Keep `GMGN_REQUEST_DELAY_MS >= 2500`.
- Position monitor sends a Telegram alert after 3 consecutive polling failures. Failure wrapping uses `makeFailureTracker` from `src/utils.js`.
- `setDefaultResultOrder('ipv4first')` is set in `src/app.js` — DNS quirk. Don't remove.
- Jupiter Ultra mode handles slippage and routing — no manual slippage config.
- Single-chat Telegram: only `TELEGRAM_CHAT_ID` messages are processed.
- `CHARON_CLI=1` disables bot polling so `scripts/cmd.js` can run handlers without fighting the live bot.
- Exit logic for `refreshPosition` lives in pure-function `src/execution/exitSimulator.js#evaluateExitTick`. The backtest simulator reuses the same logic but models stop fills at trigger price, not candle wick lows.
- When adding a new analytic table or column, mirror it in `src/db/postgresSchema.sql`, the `TABLES` registry in `src/sync/postgresSink.js`, AND `scripts/pg-backfill.js`. JSON columns must be `JSON.stringify`'d before pg parameter binding.

## Backtest

- `/backtest [window] [overrides|--spec path]` (slash command) → dispatches `charon-backtester` subagent.
- Default window: `7d`. Reads exclusively from Postgres; warm `historical_candles` via `npm run backtest:fetch` first.
- Validation always runs before sweeps. If <80% within ±5% PnL tolerance or <90% match exit_reason, recommendations are not trustworthy.
- Sweep specs are JSON (`base` + `sweep` cartesian product). Top-K by avg_pnl.
- Never re-runs the LLM; uses cached verdicts from `llm_decisions` and applies the override `llm_min_confidence` threshold.

## Evaluation

- `/evaluate [windows]` (slash command) → dispatches `charon-evaluator` subagent.
- Default windows: `1d 3d 7d 30d`. Pass explicit windows to override (e.g. `/evaluate 7d`).
- Agent uses `scripts/sql.js` for the metric battery (headline / per-strategy / per-exit-reason / LLM-confidence buckets / config drift) and optionally calls `/learn <window>` for LLM-synthesised lessons.
- Recommendations are gated to ≥10 closed trades per window — below that, the agent reports "insufficient data".
- For cadence, wrap with `/schedule` or `/loop` at the Claude Code layer. No scheduler inside Charon.

## Headless command shim

`scripts/cmd.js` (alias `npm run cmd --`) stubs `bot.sendMessage`/`editMessageText` and prints captured output. Inline keyboards are summarised under a `[buttons]` block — they aren't clickable; drive callback actions via their equivalent text command. State mutations write to `charon.sqlite` immediately and the running bot hot-reads them.
