---
description: Show active Charon strategy and its config (headless)
allowed-tools:
  - Bash
argument-hint: [strategy_id]
---

```bash
node scripts/cmd.js strategy $ARGUMENTS
```

With no argument: shows the menu. With an id (`sniper` / `dip_buy` / `smart_money` / `degen`): switches to that strategy.
