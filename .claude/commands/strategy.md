---
description: Show active Charon strategy and its config (headless)
allowed-tools:
  - Bash
argument-hint: ""
---

```bash
node scripts/cmd.js strategy
```

Shows the strategy menu (read-only) — active strategy + the list of `strategies/*.json` files. Switch the active one via the inline `▶ <name>` buttons in Telegram.

To change strategy params: edit `strategies/<id>.json` and run `node scripts/cmd.js resetstrategies confirm`.
