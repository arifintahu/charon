---
description: Evaluate past Charon trades over one or more windows and surface patterns + recommendations
allowed-tools:
  - Bash
  - Read
  - Agent
argument-hint: [window] [--mode live|dry_run|all]
---

Dispatch the `charon-evaluator` subagent to evaluate past trades.

- Treat the bare tokens in `$ARGUMENTS` as the window list (e.g. `1d`, `1d 7d`, `7d`).
- If no window is given, run the default battery: `1d 3d 7d 30d`.
- An optional `--mode live|dry_run|all` flag selects which positions to evaluate. **Default is `live`.**

Pass the window list and the mode verbatim to the agent and report its summary back. Do not run SQL or `/learn` yourself — that's the agent's job.

The agent names each report `evals/evaluate-<window>-<range>-<mode>.md` — the mode is appended automatically, so a default run writes `…-live.md` and a `--mode dry_run` run writes `…-dry_run.md`. Live and dry-run reports for the same window never overwrite each other.

For recurring evaluation, the user can wrap this with `/schedule` (cron) or `/loop` (interval): e.g. `/schedule daily /evaluate 1d`.
