---
description: Run a Charon Telegram command headlessly (e.g. /charon positions, /charon resetstrategies)
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
  text command (e.g. `/charon resetstrategies confirm` after editing a JSON
  strategy file).
- If the user asks a follow-up question about the output, answer from the
  captured text — don't re-run unless the state could have changed.
