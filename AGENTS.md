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

## Skills sync convention (Cursor ↔ Claude Code)

Every skill in this repo must be discoverable in **both** agent modes:

- Claude Code: `.claude/skills/<name>/SKILL.md`
- Cursor: `.cursor/skills/<name>/SKILL.md`

Three sync patterns are in use — pick by skill type:

| Pattern | When to use | Examples |
|---------|-------------|----------|
| **Symlink to canonical `.agents/skills/<name>/`** | Large asset-heavy skills (themes, fonts, layout templates). Both `.claude/skills/<name>` and `.cursor/skills/<name>` are symlinks to `../../.agents/skills/<name>`. | [`tosea-slide-workhorse`](.agents/skills/tosea-slide-workhorse), [`remotion-best-practices`](.agents/skills/remotion-best-practices) |
| **Canonical `.claude/` + thin Cursor mirror** | Skills with framing/discovery text that differs per agent. The Cursor file is a short pointer linking back to the Claude SKILL.md. | [`plaid-slide-design`](.claude/skills/plaid-slide-design), [`plaid-workhorse-slides`](.claude/skills/plaid-workhorse-slides) |
| **`.cursor/rules/<name>.mdc` auto-attach companion** | Cursor-only editor hint that triggers the skill on glob match. Always pairs with one of the patterns above; never replaces SKILL.md. | [`.cursor/rules/plaid-slide-design.mdc`](.cursor/rules/plaid-slide-design.mdc), [`.cursor/rules/plaid-workhorse-slides.mdc`](.cursor/rules/plaid-workhorse-slides.mdc) |

**Rules:**

1. When adding or editing a skill, update **both** agent locations in the same commit.
2. For the symlink pattern, `.agents/skills/<name>/` is the source of truth. The `npx skills` CLI tracks installations in [`skills-lock.json`](skills-lock.json) at repo root.
3. For the canonical-plus-mirror pattern, the `.claude/` file is the source of truth. The Cursor mirror's frontmatter may differ but the body must link back.
4. Parity is enforced by [`tests/unit/skills-parity.test.js`](tests/unit/skills-parity.test.js) — every Claude skill must have a Cursor counterpart, and symlink targets must resolve to the canonical `.agents/` path.
5. Documented exceptions (Cursor-only or Claude-only skills) are allowlisted in that test file. Add new ones with a comment.
