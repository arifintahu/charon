---
description: Run a Charon Telegram command headlessly (e.g. /charon positions, /charon stratset sniper tp_percent 75)
allowed-tools:
  - Bash
argument-hint: <bot-command> [args]
---

The user wants to drive the Charon bot without going through Telegram. Run the
headless shim and report what it captured.

```bash
node scripts/cmd.js $ARGUMENTS
```

Notes:
- Output is whatever the bot would have sent to Telegram, HTML-stripped.
- Inline keyboards are summarised under a `[buttons]` block — they are not
  clickable from here. To exercise a callback action, drive it via the matching
  text command (e.g. `/charon stratset sniper tp_percent 75` instead of clicking
  the strategy menu button).
- If the user asks a follow-up question about the output, answer from the
  captured text — don't re-run unless the state could have changed.
