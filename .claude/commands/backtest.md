---
description: Replay historical Charon candidates through the pipeline with overridable params, against historical Jupiter candles
allowed-tools:
  - Bash
  - Read
  - Agent
argument-hint: [window] [overrides|spec=file.json]
---

Dispatch the `charon-backtester` subagent to run a backtest.

- If the user passed `$ARGUMENTS`, treat the first token as the window (e.g. `1d`, `7d`, `30d`) and pass the rest verbatim as overrides or `spec=path`.
- If `$ARGUMENTS` is empty, run a default `7d` single-config baseline (current strategy params).

Workflow the subagent should follow:
1. Warm the candle cache: `npm run backtest:fetch -- --window <w> --interval 5_MINUTE`.
2. Validate the simulator against actual closed positions: `npm run backtest -- --validate --from <w>`. Abort with a warning if <80% of positions are within ±5% PnL tolerance or <90% match exit_reason.
3. Run the requested config (`single` or `--spec <path>` for sweeps).
4. Summarise top results in the evaluator's terse house style.

Requires `POSTGRES_URL` to be set and `npm run pg:migrate` to have been applied.

For recurring backtests, wrap with `/schedule` or `/loop`.
