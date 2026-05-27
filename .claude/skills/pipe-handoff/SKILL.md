---
name: pipe-handoff
description: >-
  Resolve a paused Plaid demo pipeline at an agent handoff checkpoint
  (post-script summary review, post-build-qa tier failure, etc.). Reads
  the pending handoff file from the most recent run, displays the
  high-level summary, asks the operator to confirm / modify / abort via
  AskUserQuestion, and writes recovery-plan.json so the running
  orchestrator can resume. Invoke when the pipeline log shows
  `event=handoff_pending` or the operator types `/pipe-handoff`.
---

# pipe-handoff (Plaid demo pipeline)

The demo pipeline pauses at named checkpoints when `PIPE_AGENT_HANDOFF=true`.
At each checkpoint it writes a handoff bundle into the run's `handoffs/`
directory and waits for the operator (via an agent) to write a
`recovery-plan.json` describing what to do next.

This skill is the operator-facing front door for that flow.

## Trigger phrases

Invoke this skill when:
- The operator types `/pipe-handoff`
- The pipeline log shows `::PIPE:: event=handoff_pending`
- The operator says "check pipeline handoffs", "the pipeline paused", "what does the agent want", or similar

## Inputs (all on disk in the current repo)

| File | What it carries |
|------|-----------------|
| `out/latest/handoffs/handoff-pending` | Sentinel — exists only when a checkpoint is awaiting resolution. Contains `{checkpoint, writtenAt}`. |
| `out/latest/handoffs/<checkpoint>.md` | Human-readable summary the agent shows to the operator. Render this verbatim. |
| `out/latest/handoffs/<checkpoint>.options.json` | Structured options list. Each option has `{id, label, description, action, recommended?}`. |

## Resolution contract (what the skill writes)

Write `out/latest/handoffs/recovery-plan.json`:

```jsonc
{
  "action": "continue" | "modify" | "abort" | <option.action from options.json>,
  "args": { /* optional, action-specific */ },
  "instructions": "<free-text, required when action=modify>",
  "resolvedAt": "<ISO8601>",
  "resolvedBy": "agent"
}
```

The orchestrator polls for this file every 3s. As soon as the file appears
the pipeline consumes it, archives it as `<checkpoint>.resolved.json`, deletes
the sentinel, and resumes.

## Steps to execute

1. **Find the pending handoff.** Resolve the current run via the
   `out/latest` symlink. Read the sentinel at
   `out/latest/handoffs/handoff-pending` — it tells you the checkpoint.
   If the sentinel is missing, reply "No handoff is currently pending in
   `out/latest`" and stop.

2. **Load the bundle.** Read the matching `.md` (summary) and
   `.options.json` (option list) from the same directory.

3. **Display the summary.** Echo the markdown to the user. Do NOT
   summarize or compress it — the summary is intentionally short.

4. **Ask for the decision** via `AskUserQuestion`. The question text:
   `"How should the pipeline proceed from <checkpoint>?"`. The options come
   straight from `options.json` — preserve the order, mark the
   `recommended: true` option with `(Recommended)` in the label per the
   AskUserQuestion convention. The "header" field of each option should
   be a short tag like `Confirm` / `Modify` / `Abort` matching the
   option's id capitalized.

5. **Branch on the user's answer:**
   - If the answer maps to an option with `action: "modify"`: call
     AskUserQuestion **again** with a single open-ended question
     `"Describe the changes the script should reflect."` — the user's
     response (including via "Other") becomes the `instructions` field.
     Build the plan as `{action: "modify", instructions: "<text>"}`.
   - If the answer maps to any other option: build the plan as
     `{action: option.action, args: option.args || {}}`.

6. **Write the plan** to `out/latest/handoffs/recovery-plan.json` with
   `resolvedAt` (current ISO timestamp) and `resolvedBy: "agent"`. Use
   the `Write` tool.

7. **Reply concisely** to the operator: one sentence confirming what
   was written, e.g. `"Wrote recovery-plan.json — pipeline will resume
   in ~3s with action=continue."` Do not re-render the summary.

## Special cases

- **No `out/latest` symlink** (rare): list `out/demos/` and use the
  most recently modified subdirectory.
- **Multiple pending handoffs across runs**: only the current run
  (`out/latest`) is in scope. Stale handoffs in other runs are not the
  skill's responsibility — leave them.
- **Operator types `/pipe-handoff` but no sentinel exists**: report it.
  Don't speculate about what stage the pipeline is in.
- **Invalid options.json**: surface the error to the operator with the
  file path; do not guess a plan.
- **User aborts the AskUserQuestion**: don't write a plan. The pipeline
  will eventually time out (default 60 min) and resume with the
  recommended option.

## Examples

### Confirm path

```
User:  /pipe-handoff
Agent: [renders post-script summary]
Agent: AskUserQuestion → user picks "Confirm — proceed to build"
Agent: writes recovery-plan.json {action: "continue"}
Agent: "Wrote recovery-plan.json — pipeline will resume in ~3s."
```

### Modify path

```
User:  /pipe-handoff
Agent: [renders post-script summary]
Agent: AskUserQuestion → user picks "Modify — describe changes"
Agent: AskUserQuestion → user: "Drop the closing combined slide and merge it into the value-summary slide instead."
Agent: writes recovery-plan.json {action: "modify", instructions: "Drop the closing..."}
Agent: "Wrote recovery-plan.json — operator instructions appended to inputs/prompt.txt, script stage will re-run."
```

### Abort path

```
User:  /pipe-handoff
Agent: [renders summary]
Agent: AskUserQuestion → user picks "Abort"
Agent: writes recovery-plan.json {action: "abort"}
Agent: "Wrote recovery-plan.json — pipeline will halt."
```

## What this skill does NOT do

- It does not modify `demo-script.json`, `prompt.txt`, or any other
  pipeline artifact directly. Those edits are the orchestrator's job;
  the skill only writes the plan that authorizes them.
- It does not pause to ask the user multiple times unless the chosen
  option is `modify` (where free-text instructions are required).
- It does not invoke build / record / render — those run inside the
  orchestrator subprocess that was already paused.
