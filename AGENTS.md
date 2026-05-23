# Agent instructions (Cursor / Claude Code)

This repository expects **automated assistants** to follow [`CLAUDE.md`](CLAUDE.md) for product and pipeline behavior.

## Mandatory: pipeline heartbeat

If you **start or supervise** a long-running pipeline (`npm run demo`, `npm run demo:full`, `npm run pipe -- new`, `npm run pipe -- resume`, orchestrator, or watching logs while a run is active):

1. **Observe orchestrator heartbeats** — the orchestrator emits `::PIPE:: event=heartbeat` every 5 minutes mid-stage. Configure your Shell call with:
   ```
   notify_on_output: {
     pattern: "::PIPE:: event=heartbeat",
     reason: "5min pipeline heartbeat",
     debounce_ms: 280000
   }
   ```
   Post a one-line chat summary on each tick: `stage=<name>, elapsed=<s>s, lastLogActivity=<s>s ago, awaiting=<bool>`.
2. **Background orchestrator:** run `npm run pipe -- monitor [RUN_ID]` in parallel with the same `notify_on_output` pattern.
3. **Do not** only report progress when the user asks. Heartbeat-driven updates are required.
4. If `heartbeatStale: true` in `npm run pipe -- status --json`, investigate (`activePid`, tail `artifacts/logs/pipeline-build.log.md`).
5. Prefer **`--non-interactive`** on `pipe` commands when possible.

Optional for humans only: `npm run pipe:status-loop` — redundant for agents once orchestrator heartbeats are active.

**Full policy:** [`CLAUDE.md`](CLAUDE.md) — **REQUIRED — Pipeline heartbeat**. Cursor rule: [`.cursor/rules/pipeline-heartbeat.mdc`](.cursor/rules/pipeline-heartbeat.mdc). CLI skill: [`.claude/skills/pipeline-cli/SKILL.md`](.claude/skills/pipeline-cli/SKILL.md).
