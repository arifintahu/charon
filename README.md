# Charon

Charon is a Telegram trench agent for screening noisy Pump-token flow with overlap signals, strategy gates, LLM selection, and dry-run/confirm/live execution.

# ALERT
This Codebase is on testing-period, developer doesn't guarantee of any result.


## Flow

1. Charon polls the Charon signal server every `SIGNAL_POLL_MS`.
2. The active strategy gates source count, fee requirement, token age, market cap, holders, fees, trend quality, ATH distance, and position caps.
3. Passing candidates are enriched with token info, Jupiter asset/holders/chart data, saved-wallet exposure, and fxtwitter narrative when available.
4. The LLM screens up to `LLM_CANDIDATE_PICK_COUNT` recent candidates and may pick one `BUY`.
5. Charon routes approved buys through `dry_run`, `confirm`, or `live`.
6. Open positions are monitored every `POSITION_CHECK_MS` for TP, SL, trailing TP, max hold, and partial TP rules.

## Access

Charon requires a signal server URL and API key. The signal server aggregates fee-claim, graduated, and trending data from Pump.fun in real time — without it Charon has nothing to screen.

To get access, contact the maintainer. Once you have credentials, set them in `.env`:

```env
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=your_key_here
```

## Install

```bash
git clone git@github.com:yunus-0x/charon.git
cd charon
npm install
cp .env.example .env
```

Edit `.env` with your credentials. Optionally start the Postgres analytics sink (pools analytics across machines for `/evaluate`):

```bash
npm run pg:up
npm run pg:migrate
npm run pg:backfill   # only if charon.sqlite already has data
```

Then run:

```bash
npm start
```

For PM2:

```bash
pm2 start index.js --name charon
pm2 save
```

## Required Config

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

`TELEGRAM_CHAT_ID` is the chat or group ID where Charon sends alerts and accepts commands. Only messages from this chat are processed.

Signal server (required — see [Access](#access) above):

```env
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=
SIGNAL_POLL_MS=30000
```

RPC endpoint (required for live execution):

```env
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

If `SOLANA_RPC_URL`/`SOLANA_WS_URL` are not set, Charon falls back to Helius mainnet URLs and requires:

```env
HELIUS_API_KEY=
```

## GMGN Enrichment

```env
GMGN_ENABLED=true
GMGN_API_KEY=
```

GMGN enriches candidates with holder count, liquidity, fee data, and social links. Set `GMGN_ENABLED=false` to skip it — Charon falls back to Jupiter/server data and the status line shows `off`. GMGN has aggressive rate limits; keep `GMGN_REQUEST_DELAY_MS` at 2500+ ms.

## LLM Config

```env
ENABLE_LLM=true
LLM_BASE_URL=https://api.minimax.io/v1
LLM_API_KEY=
LLM_MODEL=MiniMax-M2.7
LLM_TIMEOUT_MS=60000
LLM_CANDIDATE_PICK_COUNT=10
LLM_CANDIDATE_MAX_AGE_MS=600000
```

`LLM_BASE_URL` accepts any OpenAI-compatible endpoint. The default is MiniMax M2.7, which is fast and cheap for this use case. OpenAI (`https://api.openai.com/v1`), Groq, and local Ollama endpoints all work — just set the matching `LLM_MODEL`.

Set `ENABLE_LLM=false` to disable LLM globally. Individual strategies also have a `use_llm` flag — strategies with `use_llm: false` (e.g. `degen`) auto-approve any candidate that passes filters without calling the LLM.

Each strategy has its own `llm_min_confidence` threshold. Edit it in `strategies/<id>.json`, then run `/resetstrategies confirm` (or restart) to apply.

## Execution Modes

```env
TRADING_MODE=dry_run
```

- `dry_run`: stores simulated buys/sells in SQLite. No wallet needed.
- `confirm`: sends a Telegram trade intent with approve/reject buttons. Executes live only after you confirm.
- `live`: signs and executes Jupiter Ultra swaps immediately after strategy and LLM approval.

Live and confirm modes require:

```env
SOLANA_PRIVATE_KEY=
JUPITER_API_KEY=
JUPITER_SWAP_BASE_URL=https://api.jup.ag/swap/v2
LIVE_MIN_SOL_RESERVE=0.02
```

`LIVE_MIN_SOL_RESERVE` is the minimum SOL kept in the wallet after any buy. Charon refuses to execute if the balance would fall below this.

Swaps use Jupiter Ultra mode — slippage and routing are handled automatically by Jupiter. No manual slippage config needed.

## Strategies

Strategies live in `strategies/*.json` — one file per strategy is the **only** source of truth. Each boot rebuilds the SQLite `strategies` table from those files.

```bash
/menu → Strategy        # show menu, switch active via inline buttons
/strategy               # text shortcut — same menu
/resetstrategies        # dry-run diff vs disk
/resetstrategies confirm  # re-sync mid-run after editing a JSON file
```

Default strategies (under `strategies/`):

- `sniper.json`: fee-claim overlap, immediate entry, LLM on.
- `dip_buy.json`: waits for ATH-distance dip alerts.
- `smart_money.json`: stricter holder/trending quality, partial TP support.
- `degen.json`: lower source threshold, rule-based (no LLM).

To change a strategy: edit the JSON file, then either restart or `/resetstrategies confirm`. The 5s strategy cache picks the new values up automatically. Exactly one strategy may be `enabled: true` at a time.

## Telegram Commands

```bash
/menu
/strategy
/resetstrategies [confirm]
/positions
/candidate <mint>
/filters
/pnl
/learn <window>
/lessons
/walletadd <label> <address>
/walletremove <label>
/wallets
```

## Storage

Charon writes the trading hot path to `charon.sqlite` (local, synchronous, never blocks on network). It stores:

- candidates and filter results
- LLM decisions and batches
- decision logs
- dry-run/live positions and trades
- trade intents
- saved wallets
- strategy configs
- price alerts
- learning runs and lessons

Open positions resume monitoring after restart.

### Postgres analytics sink (optional)

If `POSTGRES_URL` is set, an async outbox worker mirrors analytic rows to Postgres for cross-machine pooling and evaluation. Live trading is unaffected by remote outages — if Postgres is down, the outbox queues and drains when it returns.

Per-row `machine_id` (auto-generated UUID, set `CHARON_MACHINE_ID`/`CHARON_MACHINE_LABEL` to override) partitions data across bot instances. Live state (open positions, intents, guardrails) stays per-machine — Postgres only pools analytics.

Local Postgres via docker-compose:

```bash
npm run pg:up         # start Postgres 17 container
npm run pg:migrate    # apply src/db/postgresSchema.sql
npm run pg:backfill   # one-time SQLite → Postgres copy
npm run pg:psql       # interactive shell
npm run pg:down       # stop container (data persists in named volume)
```

```env
POSTGRES_URL=postgres://charon:charon@localhost:5432/charon
CHARON_MACHINE_ID=          # leave blank to auto-generate
CHARON_MACHINE_LABEL=
POSTGRES_SYNC_INTERVAL_MS=5000
POSTGRES_SYNC_BATCH_SIZE=100
```

Tables synced: `candidates`, `llm_decisions`, `llm_batches`, `decision_logs`, `dry_run_positions`, `dry_run_trades`, `learning_lessons`.

## Evaluation

Once trades have closed, `/evaluate [windows]` (default `1d 3d 7d 30d`) dispatches the `charon-evaluator` subagent. It pulls a metric battery from the Postgres analytics sink — headline PnL, per-strategy and per-exit-reason breakdowns, LLM-confidence buckets, and config drift — and writes one report per window to `evals/`. Recommendations are gated to ≥10 closed trades per window; below that it reports "insufficient data".

## Verification

```bash
npm run check
```

## Config Reloading

SQLite/menu settings are hot-read by the bot. API keys, wallet key, RPC URLs, Jupiter base URL, and polling intervals are `.env` values and require restart.

## API Usage Notes

- **GMGN**: Rate-limited. Keep `GMGN_REQUEST_DELAY_MS=2500` or higher. Running many instances or lowering the delay will get your key banned.
- **Jupiter**: `fetchJupiterAsset` and `fetchJupiterHolders` are called per candidate and per position refresh cycle. At high throughput, you may hit 429s — Charon backs off automatically and retries from cache.
- **Helius RPC**: Position monitoring polls every `POSITION_CHECK_MS` (default 10s). Use a paid Helius plan for live trading; free tier will throttle under load.
- **LLM**: One API call per batch cycle (up to `LLM_CANDIDATE_PICK_COUNT` candidates per call). MiniMax M2.7 is the most cost-efficient default for this prompt shape.

## Notes

- Live execution uses `@solana/web3.js` v1 (legacy SDK). It works, but a future version may migrate to `@solana/kit`.
- The position monitor sends a Telegram alert after 3 consecutive failures on any polling loop.
