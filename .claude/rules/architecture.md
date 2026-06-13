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
| Learning / reports | `src/learning/{commands,lessons,report,summary}.js` |
| Config | `src/config.js`, `.env`, `docker-compose.yml` |
| Utilities | `src/utils.js`, `src/format.js`, `src/log.js` (timestamped `logger('<tag>')` — never use bare `console.log` for runtime status) |

## Operating modes

Selected at boot in `src/app.js`:

- **Server mode** (`SIGNAL_SERVER_URL` set): polls signal server every `SIGNAL_POLL_MS`; price monitor handles dip alerts every 10s.
- **Standalone mode** (legacy): fee-claim websocket + graduated poll (`GRADUATED_POLL_MS`) + trending poll (`TRENDING_POLL_MS`). The fee-claim WS gates `sniper` / `smart_money` / `dip_buy` candidate triggers; `degen` is driven by the trending poller alone.
  - `FEE_CLAIM_WS_ENABLED=false` (default `true`) skips the WS entirely — useful on free Solana RPC tiers where `logsSubscribe` on the Pump programs burns credits fast. With it off, only the `degen` strategy produces candidates. Graduated/trending HTTP pollers continue regardless and still enrich degen candidates with graduation context.

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
- Strategy configs are hot-read from SQLite (5s cache) — but **SQLite strategies are a working copy of `strategies/*.json`**. Every boot rebuilds the table from those files via `src/db/strategySeeds.js#syncStrategiesToDb` (REPLACE, not merge). To change a strategy: edit its JSON file, then restart or `/resetstrategies confirm`. Exactly one strategy may carry `enabled: true`.
- `.env` values (API keys, wallet key, RPC URLs, polling intervals) require restart.

### Postgres analytics sink (optional)

- Enabled by `POSTGRES_URL`. The bot still runs without it; sync becomes a no-op.
- `docker-compose.yml` runs Postgres 17 locally. `npm run pg:up | pg:migrate | pg:backfill | pg:psql | pg:down`.
- Per-row `machine_id` (auto-generated UUID, persisted to `settings.machine_id`) partitions data across bot instances.
- Outbox pattern: writes to SQLite append a row to `sync_outbox`; `src/sync/postgresSink.js` drains it every `POSTGRES_SYNC_INTERVAL_MS` (default 5s) in FIFO batches of `POSTGRES_SYNC_BATCH_SIZE` (default 100), idempotent via `ON CONFLICT (machine_id, local_id) DO UPDATE`.
- Tables synced: `candidates`, `llm_decisions`, `llm_batches`, `decision_logs`, `dry_run_positions`, `dry_run_trades`, `learning_lessons`. **Not synced**: `settings`, `strategies`, `saved_wallets`, `price_alerts`, `trade_intents`, `tp_sl_rules` (per-machine live state).
- Failure handling: outbox rows back off exponentially on Postgres errors. Live trading is unaffected by remote outages.
- JSONB columns are stringified via `JSON.stringify` before parameter binding — `pg` coerces JS arrays into Postgres arrays otherwise.

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
- Exit logic for `refreshPosition` lives in pure-function `src/execution/exitSimulator.js#evaluateExitTick`.
- When adding a new analytic table or column, mirror it in `src/db/postgresSchema.sql`, the `TABLES` registry in `src/sync/postgresSink.js`, AND `scripts/pg-backfill.js`. JSON columns must be `JSON.stringify`'d before pg parameter binding.

## Evaluation

- `/evaluate [windows]` (slash command) → dispatches `charon-evaluator` subagent.
- Default windows: `1d 3d 7d 30d`. Pass explicit windows to override (e.g. `/evaluate 7d`).
- Agent uses `scripts/sql.js` for the metric battery (headline / per-strategy / per-exit-reason / LLM-confidence buckets / config drift) and optionally calls `/learn <window>` for LLM-synthesised lessons.
- Recommendations are gated to ≥10 closed trades per window — below that, the agent reports "insufficient data".
- For cadence, wrap with `/schedule` or `/loop` at the Claude Code layer. No scheduler inside Charon.

## Headless command shim

`scripts/cmd.js` (alias `npm run cmd --`) stubs `bot.sendMessage`/`editMessageText` and prints captured output. Inline keyboards are summarised under a `[buttons]` block — they aren't clickable; drive callback actions via their equivalent text command. State mutations write to `charon.sqlite` immediately and the running bot hot-reads them.
