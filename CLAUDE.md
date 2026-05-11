# CLAUDE.md

Project-scoped guidance for Claude sessions.

## What this is

Charon is a Telegram-driven Solana trading agent. It ingests Pump.fun token signals, enriches and filters candidates through strategy gates, optionally picks one via LLM, then executes in `dry_run` / `confirm` / `live` mode through Jupiter Ultra. Source of truth is `charon.sqlite`.

## Entry points

- `index.js` → `src/app.js#startCharon`
- Boot order: `validateConfig` → `initDb` → `initLiveExecution` → `setupTelegram` → signal mode branch → `monitorPositions` interval

## Pipeline

Canonical diagram: `docs/workflow.mmd`. File map per node:

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

## Verification

- `npm run check` — `node --check` on `index.js`, `src/app.js`, `src/config.js`, `src/liveExecutor.js`.
- No test suite. Behaviour is observed through Telegram side effects.
- For UI/behaviour changes, say so explicitly when you can't verify end-to-end.

## Conventions and gotchas

- ESM project (`"type": "module"`). Use `import`, never `require`.
- `@solana/web3.js` v1 (legacy SDK). A future migration to `@solana/kit` is noted in README — until then, stay on v1.
- GMGN has aggressive rate limits. Keep `GMGN_REQUEST_DELAY_MS >= 2500`. Lowering it can get the key banned.
- Position monitor sends a Telegram alert after 3 consecutive polling failures. Failure wrapping uses `makeFailureTracker` from `src/utils.js`.
- `setDefaultResultOrder('ipv4first')` is set in `src/app.js` — DNS quirk for some hosts. Don't remove.
- Jupiter Ultra mode handles slippage and routing — no manual slippage config.
- Single-chat Telegram: only `TELEGRAM_CHAT_ID` messages are processed.

## Writing rules for this repo

- Rules: no empty modifiers, no "not X but Y" contrasts, practical only.
- Default to no comments. Add one only when WHY is non-obvious (hidden invariant, workaround, surprising behaviour).
- Don't add features, refactors, or backwards-compat shims beyond what a task requires.
- Don't create planning/decision documents unless asked.
