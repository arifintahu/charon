---
description: Run a read-only SELECT against charon.sqlite
allowed-tools:
  - Bash
argument-hint: <SELECT ...>
---

```bash
node scripts/sql.js "$ARGUMENTS"
```

Read-only. Writes are refused — go through the bot CLI so the running bot hot-reads the change.

Common tables: `candidates`, `llm_decisions`, `dry_run_positions`, `dry_run_trades`, `tp_sl_rules`, `settings`, `saved_wallets`, `alerts`, `learning_runs`, `lessons`, `price_alerts`, `strategies`, `intents`.
