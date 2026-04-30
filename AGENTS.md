# Agent instructions (Cursor / Claude Code)

This repository expects **automated assistants** to follow [`CLAUDE.md`](CLAUDE.md) for product and pipeline behavior.

## Mandatory: pipeline heartbeat

If you **start or supervise** a long-running pipeline (`npm run demo`, `npm run demo:full`, `npm run pipe -- new`, `npm run pipe -- resume`, orchestrator, or watching logs while a run is active):

1. Post a **short status update in chat at least every 5 minutes** until the run finishes or fails. Use `npm run pipe -- status` or `npm run pipe -- status --json`.
2. **Do not** only report progress when the user asks. Proactive updates are required.
3. If logs go quiet for **~5 minutes** while status still shows an in-flight stage, investigate (`activePid`, `artifacts/logs/pipeline-build.log.md`) and tell the user.
4. Prefer **`--non-interactive`** on `pipe` commands when possible.

Optional: run `npm run pipe:status-loop` in another terminal — it **does not replace** chat updates.

**Full policy:** [`CLAUDE.md`](CLAUDE.md) — sections **REQUIRED — Pipeline heartbeat** and **Claude Code / Cursor agents — long-running builds (heartbeat policy)**. Cursor rule: [`.cursor/rules/pipeline-heartbeat.mdc`](.cursor/rules/pipeline-heartbeat.mdc).
