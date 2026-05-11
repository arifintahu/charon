---
description: Evaluate past Charon trades over one or more windows and surface patterns + recommendations
allowed-tools:
  - Bash
  - Read
  - Agent
argument-hint: [window]
---

Dispatch the `charon-evaluator` subagent to evaluate past trades.

- If the user passed `$ARGUMENTS`, treat it as the window list (e.g. `1d`, `1d 7d`, `7d`).
- If `$ARGUMENTS` is empty, run the default battery: `1d 3d 7d 30d`.

Pass the window list verbatim to the agent and report its summary back. Do not run SQL or `/learn` yourself — that's the agent's job.

For recurring evaluation, the user can wrap this with `/schedule` (cron) or `/loop` (interval): e.g. `/schedule daily /evaluate 1d`.
