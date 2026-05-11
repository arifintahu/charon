# Charon architecture

Canonical pipeline diagram: `docs/workflow.mmd`.

## Entry points

- `index.js` → `src/app.js#startCharon`
- Boot order: `validateConfig` → `initDb` → `initLiveExecution` → `setupTelegram` → signal mode branch → `monitorPositions` interval

## File map per pipeline stage

| Stage | Files |
|---|---|
| Signal ingest | `src/signals/{serverClient,feeClaim,graduated,trending,priceMonitor,axiomSource}.js` |
| Candidate build + enrichment | `src/pipeline/candidateBuilder.js`, `src/enrichment/{gmgn,jupiter,twitter,wallets}.js` |
| Filters + strategy gates | `src/pipeline/orchestrator.js` |
| LLM screening | `src/pipeline/llm.js` |
| Execution | `src/execution/{router,positions}.js`, `src/liveExecutor.js` |
| Telegram I/O | `src/telegram/{commands,callbacks,menus,send,format,input,bot}.js` |
| Persistence | `src/db/{connection,candidates,decisions,intents,positions,settings}.js` |
| Learning / reports | `src/learning/{commands,lessons,report,summary}.js` |
| Config | `src/config.js`, `.env` |
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

- `charon.sqlite` (better-sqlite3) is the only persistence layer.
- Open positions resume monitoring after restart.
- Strategy configs and per-strategy thresholds are hot-read from SQLite — menu changes apply without restart.
- `.env` values (API keys, wallet key, RPC URLs, polling intervals) require restart.

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

## Evaluation

- `/evaluate [windows]` (slash command) → dispatches `charon-evaluator` subagent.
- Default windows: `1d 3d 7d 30d`. Pass explicit windows to override (e.g. `/evaluate 7d`).
- Agent uses `scripts/sql.js` for the metric battery (headline / per-strategy / per-exit-reason / LLM-confidence buckets / config drift) and optionally calls `/learn <window>` for LLM-synthesised lessons.
- Recommendations are gated to ≥10 closed trades per window — below that, the agent reports "insufficient data".
- For cadence, wrap with `/schedule` or `/loop` at the Claude Code layer. No scheduler inside Charon.

## Headless command shim

`scripts/cmd.js` (alias `npm run cmd --`) stubs `bot.sendMessage`/`editMessageText` and prints captured output. Inline keyboards are summarised under a `[buttons]` block — they aren't clickable; drive callback actions via their equivalent text command. State mutations write to `charon.sqlite` immediately and the running bot hot-reads them.
