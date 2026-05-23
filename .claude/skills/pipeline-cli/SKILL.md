---
name: pipeline-cli
description: Drive the Plaid Demo Pipeline from the Cursor CLI (`npm run pipe`). After status checks, run nextRecoveryCommand automatically when appropriate; on successful app-only builds through build-qa, bootstrap the dashboard (npm run dashboard if down) and pipe open. Use when the user asks to start, resume, inspect, or recover a pipeline build, or mentions a run ID or the dashboard.
metadata:
  tags: pipeline, cli, orchestrator, build, plaid, recovery, claude-code, dashboard
---

## Why this exists

The dashboard (`npm run dashboard`) is now **read-only by default** — all run / resume / kill / continue actions live in the CLI at [bin/pipe.js](../../../bin/pipe.js). Driving builds from Cursor gives Claude memory across stages, live recovery recommendations, and direct access to artifact files between attempts.

Everything below is already wired up. No setup needed.

## Commands

```bash
npm run pipe                                   # interactive menu (humans)
npm run pipe -- new      [--prompt=PATH] [--with-slides|--app-only]
                         [--research=gapfill|broad|deep]
                         [--to=STAGE] [--qa-threshold=N]
                         [--max-refinement-iterations=N]
                         [--build-fix-mode=smart|rebuild|patch]
                         [--no-touchup] [--non-interactive] [--json]
npm run pipe -- resume   [RUN_ID] [--from=STAGE] [--to=STAGE]
                         [--with-slides|--app-only]
npm run pipe -- stage    STAGE [RUN_ID]        # single-stage retry
npm run pipe -- status   [RUN_ID] [--json]     # canonical run state
npm run pipe -- monitor  [RUN_ID] [--poll-ms=N] # re-emit heartbeat lines for background runs
npm run pipe -- logs     [RUN_ID] [--follow]
npm run pipe -- stop     [RUN_ID] [--force]
npm run pipe -- list     [--limit=N] [--json]
npm run pipe -- continue [RUN_ID]              # resolve a pending prompt
npm run pipe -- open     [RUN_ID]              # open dashboard to view-only

# Tier-scoped QA recovery lanes (NEVER call build-app / generateApp)
npm run pipe -- app-touchup [RUN_ID]          # primary recovery for app-tier failures
                                              #   (npm run demo / app-only path included)
npm run pipe -- slide-fix   [RUN_ID]          # slide-tier recovery for app+slides runs
                                              #   (refuses to run when the app tier hasn't passed)
npm run pipe -- qa-touchup  [RUN_ID] [--tier=app|slide]
                                              # generate an agent-ready task .md for
                                              # surgical edits (no orchestrator loop)
```

Run IDs default to the latest run when omitted. Stage names are the canonical stages from [CLAUDE.md](../../../CLAUDE.md):
`research, ingest, script, brand-extract, script-critique, embed-script-validate, build, plaid-link-qa, build-qa, post-slides, post-panels, app-touchup, slide-fix, record, qa, figma-review, post-process, voiceover, coverage-check, auto-gap, resync-audio, embed-sync, audio-qa, ai-suggest-overlays, render, ppt, touchup`

## Structured events (`::PIPE::` markers)

The orchestrator emits stable machine-readable markers on stdout. Grep or stream-parse these when monitoring a run:

```
::PIPE:: event=pipeline_start  ts=… runId=… mode=scratch buildMode=app-only stages=research,ingest,…
::PIPE:: event=stage_start     ts=… runId=… stage=build index=7 total=23 pipelineElapsedSec=142.3
::PIPE:: event=stage_end       ts=… runId=… stage=build status=ok     durationSec=88.1
::PIPE:: event=stage_end       ts=… runId=… stage=record status=failed durationSec=310.0 message="…" recoveryHint="--from=record"
::PIPE:: event=prompt          ts=… runId=… kind=continue message="…" hint="npm run pipe -- continue"
::PIPE:: event=prompt_resolved ts=… runId=… kind=continue via=signal_file
::PIPE:: event=heartbeat   ts=… runId=… tick=7 stage=build-qa stageElapsedSec=412 pipelineElapsedSec=1245 awaitingContinue=false lastLogActivitySec=28 at=…
::PIPE:: event=pipeline_end    ts=… runId=… status=ok totalSec=1842.6 outputDir=/…/out/demos/…
```

Values containing whitespace or `=` are double-quoted with `\"` escaping.

## Canonical status JSON

`npm run pipe -- status --json` returns (schema stable, consumed by the dashboard badge too):

```json
{
  "runId": "2026-04-23-…",
  "runDir": "/…/out/demos/…",
  "buildMode": "app-only",
  "mode": "scratch",
  "activePid": 12345,
  "running": true,
  "runningStage": "build",
  "awaitingContinue": false,
  "continueContext": null,
  "stages": [
    { "name": "research", "status": "completed", "durationSec": 197.1, "sentinel": "product-research.json" },
    { "name": "build",    "status": "failed",    "lastError": "…" },
    { "name": "record",   "status": "pending" }
  ],
  "counts": { "total": 23, "completed": 7, "failed": 1, "pending": 15, "running": 0 },
  "firstPending": "plaid-link-qa",
  "firstFailed": "build",
  "tierSummary": {
    "threshold": 80,
    "app":   { "passed": true,  "skipped": false, "failingStepIds": [], "minScore": 92 },
    "slide": { "passed": false, "skipped": false, "failingStepIds": ["network-insights-slide"], "minScore": 45 }
  },
  "recommendedRecovery": "slide-fix",
  "nextRecoveryCommand": "npm run pipe -- slide-fix 2026-04-23-… --non-interactive",
  "lastHeartbeatAt": "2026-05-22T12:34:56.789Z",
  "lastHeartbeatAgeSec": 18,
  "heartbeatStale": false,
  "heartbeatIntervalMs": 300000
}
```

Statuses: `completed | running | failed | pending`. `nextRecoveryCommand` is the single command Claude should run next; follow it unless the user asks for something different. **`tierSummary`** + **`recommendedRecovery`** come from the latest `qa-report-build.json` and route the lanes documented below.

## Next best action (run automatically — stay transparent)

**Default behavior:** Do not end the turn with only passive advice if a **concrete CLI step** is obvious. Fetch fresh state, **execute** the next command, **tell the user** what you ran (one short sentence).

1. **After** any orchestrator exit, stage retry, `pipe stop`, or when deciding what to do next: run **`npm run pipe -- status --json`** (unless you already have fresh JSON from the last few seconds).
2. If **`nextRecoveryCommand`** is non-null and the user has **not** asked you to stop or pursue a different strategy: **run that command verbatim** (append **`--non-interactive`** when it is a `pipe new` / `pipe resume` / `pipe stage` invocation and the user did not request an interactive gate). State in chat: *Running: `<command>` — recovering per pipe status.*
3. If **`nextRecoveryCommand`** is null and **`running`** is false:
   - If **`firstFailed`** is set → follow the [Recovery decision tree](#recovery-decision-tree); pick the first matching branch and **run** the recommended command, not only describe it.
   - If **`firstFailed`** is null → summarize success (which stages completed) and apply [Dashboard after app-only build-qa success](#dashboard-after-app-only-build-qa-success) below when it matches.

**Anti-pattern:** Listing what the user *could* run without running it when `nextRecoveryCommand` or an equivalent one-liner is already known.

## Dashboard after app-only build-qa success

When **all** of these hold (use `pipe status --json` or read `run-manifest.json` + `pipeline-progress.json`):

- **`buildMode`** is **`app-only`**
- Stage **`build-qa`** is **`completed`**
- **`firstFailed`** is **null** (no stage failed on this run)
- Pipeline is **not** currently **`running`** (orchestrator finished after build-qa — the usual **`npm run demo`** / `--to=build-qa` path)

…then the **next best user experience** is reviewing frames, QA details, and the scratch app **in the dashboard** — not staring at the terminal.

**Agent checklist (do in order):**

1. **Announce** in one sentence: build-qa passed for an app-only run; next step is review in the local dashboard (default **http://localhost:4040/**).
2. **Port alignment:** `npm run dashboard` binds **`PORT`** (default **4040**, see `scripts/dashboard/server.js`). **`npm run pipe -- open`** builds URLs with **`DASHBOARD_PORT`** (default **4040**). If `.env` changes one, set **both** so the probe, server, and opener agree.
3. **Probe** whether the dashboard is already up (e.g. `curl -sf "http://localhost:<port>/" >/dev/null`, or HTTP GET to that origin). If the connection fails, the server is not running.
4. **Start the dashboard** if needed: from the **repository root**, run **`npm run dashboard`** as a **background** long-running process (same as a dev server — do not block the session forever). Briefly wait until the port responds or retry the probe once or twice.
5. **Open the browser** for this run: **`npm run pipe -- open <RUN_ID>`** (or **`npm run pipe -- open`** for the latest run). Uses the OS opener (`open` / `xdg-open` / `start`).
6. If your environment **cannot** bind ports or spawn background servers (sandbox): **tell the user** to run **`npm run dashboard`** in a separate terminal, then **`npm run pipe -- open`**, and explain they should inspect the demo app + build-qa artifacts in the UI.

**Note:** `pipe open` **does not** start the Node server — it only opens a URL. If nothing listens on the port, start **`npm run dashboard`** first.

## Exit codes

| Code | Meaning |
|------|---------|
| 0    | Success |
| 2    | Pipeline error (stage failure not caught by retry) |
| 3    | User cancelled |
| 4    | Another pipeline is already running in this project |
| 5    | Orchestrator stopped awaiting human continue (in `--non-interactive` mode) |
| 64   | Usage error (bad subcommand / flags) |

## Recovery decision tree

When a run hits trouble, choose one of these in order:

1. **Prompt gate** (`awaitingContinue=true`, `::PIPE:: event=prompt`):
   - Read the `message` field for context.
   - If the user wants to unblock: `npm run pipe -- continue <RUN_ID>`.
   - Do **not** re-run the stage — the orchestrator is still alive mid-stage.

2. **Build-QA tier failure** (`recommendedRecovery` is `app-touchup` / `slide-fix` / `app-touchup+slide-fix`):
   - **Always run this first** instead of `pipe stage build-qa` / `--build-fix-mode=touchup` — those re-trigger the full LLM regen path which can drift the passing tier.
   - **`app-touchup`** (app-only OR `slide.passed`): `npm run pipe -- app-touchup <RUN_ID> --non-interactive`. Applies app patches (`api-panel-toggle-latest`, `plaid-launch-cta-icon-ratio`, `plaid-link-token-products-prune`, `zip-cra-host-contract`) → `post-panels` → build-qa `stepScope=app`. Writes `qa-touchup-task.md` / `qa-app-touchup-task.md` for residual failures.
   - **`slide-fix`** (app+slides only, `app.passed && !slide.passed`): `npm run pipe -- slide-fix <RUN_ID> --non-interactive`. Patches → `strip-slide-roots --steps=…` → `post-slides --steps=…` → `post-panels` → build-qa `stepScope=slides`. Writes `qa-slide-fix-task.md`.
   - **`app-touchup+slide-fix`** (both tiers failed, localized): run app-touchup first; slide-fix refuses while app tier is failing.

3. **Single stage failed** (`firstFailed` set):
   - Inspect the failure's artifact (see the reading order below).
   - Retry that stage alone first: `npm run pipe -- stage <firstFailed> <RUN_ID>`.
   - Only escalate to `resume --from=…` if the single-stage retry succeeds but downstream stages also need to re-run.

4. **QA threshold miss** (qa-report-* shows score below threshold):
   - Adjust the threshold: `--qa-threshold=N` on the retry.
   - Or raise refinement iterations: `--max-refinement-iterations=N`.

5. **Build mismatches the script systemically** (`recommendedRecovery: 'fullbuild'` OR runtime/selector errors on ≥2 steps OR deterministic blocker gate):
   - Stage `build` with `--build-fix-mode=fullbuild` (LLM regen). Tier lanes will NOT fix this.

6. **No run identity known** (status shows "No latest run"):
   - Ask the user for the intended `RUN_ID`, or start a new build with `npm run pipe -- new`.

When `nextRecoveryCommand` is already populated by `pipe status --json`, prefer it verbatim — it already reflects the tier matrix.

## Artifact reading order when stuck

Always load these in this order before proposing fixes. Paths are relative to the run dir (`status.runDir`):

1. `run-manifest.json` — mode, buildMode, prompt fingerprint, createdAt
2. `pipeline-progress.json` — authoritative completed-stage list
3. `artifacts/logs/pipeline-build.log.md` — full stage timeline with MILESTONE entries
4. `demo-script.json` — persona, product, steps (if past `script`)
5. `script-critique.json` — quality issues flagged before build
6. `build-qa-diagnostics.json` / `qa-report-build.json` — pre-record DOM + vision diagnostics
7. `qa-report-<N>.json` — post-record vision QA (latest N is the refined pass)
8. `audio-qa-report.json` — per-clip stutter/freeze + clipping + duration-desync findings
9. `coverage-report.json` — narration word coverage vs script
10. `overlay-suggestions.json` — optional overlay patches for touchup

For fast progress without over-reading, ask `pipe status --json` first and only open the artifact(s) tied to `firstFailed` / `lastError`.

## Non-interactive (Claude-driven) invocations

Pass `--non-interactive` to skip all human prompts; the orchestrator will auto-advance on QA gates (equivalent to `SCRATCH_AUTO_APPROVE=true`). In this mode, `promptContinue` gates still emit `::PIPE:: event=prompt` but auto-continue — watch for `event=prompt_resolved via=signal_file` to confirm.

Combine with `--json` to parse events programmatically instead of scraping human logs.

## Long-running builds — orchestrator heartbeat (agent behavior)

The orchestrator emits **`::PIPE:: event=heartbeat`** every **5 minutes** (`PIPELINE_HEARTBEAT_MS`, default 300000) **mid-stage**, independent of stage completion. Each tick also writes `pipeline-heartbeat.json` and a `[HEARTBEAT]` log section.

### How to observe the heartbeat

When supervising a pipeline in Cursor / Claude Code, configure your long-running Shell call:

```
notify_on_output: {
  pattern: "::PIPE:: event=heartbeat",
  reason: "5min pipeline heartbeat",
  debounce_ms: 280000
}
```

On each notification, post a one-line chat summary:
`stage=<name>, elapsed=<s>s, lastLogActivity=<s>s ago, awaiting=<bool>`

**Background orchestrator:** if the orchestrator Shell is backgrounded (`block_until_ms: 0`), run in parallel:

```bash
npm run pipe -- monitor [RUN_ID]
```

…with the same `notify_on_output` pattern. `pipe monitor` polls `pipeline-heartbeat.json` and re-emits heartbeat lines.

**Stall detection:** `npm run pipe -- status --json` exposes `heartbeatStale: true` when `running` and no heartbeat for **>2× interval**. Investigate before suggesting `pipe stop`.

Optional for humans only: `npm run pipe:status-loop` (prints status every 300s) — **redundant** for agents once orchestrator heartbeats are active.

## Worked example

```text
user: my build is broken, can you fix it

Claude:
  $ npm run pipe -- status --json
  # sees firstFailed=build, lastError="terminated"
  $ cat out/demos/<RUN_ID>/build-qa-diagnostics.json | jq '.issues[:3]'
  # identifies the specific DOM contract violation
  $ npm run pipe -- stage build <RUN_ID> --non-interactive
  # watches ::PIPE:: event=stage_end stage=build status=ok
  $ npm run pipe -- resume <RUN_ID> --from=build-qa
```

## Dashboard integration (read-only mirror)

- `npm run dashboard` still serves timelines, frames, sync-map editor, overlays, slide library, demo-apps. All those are untouched.
- Run Pipeline / Resume / Kill / Continue buttons now **copy** a CLI command to the clipboard (plus show a toast). The server returns HTTP 410 with `{ cliCommand }` when the dashboard tries to POST.
- Setting `DASHBOARD_WRITE=true` re-enables the legacy dashboard runner (fallback only — Cursor CLI is preferred).
- `GET /api/runs/:runId/stage-state` returns the exact JSON from `pipe status --json`; it is also what the header badge polls.

After a **successful app-only build through build-qa**, prefer driving the user through the dashboard using **[Dashboard after app-only build-qa success](#dashboard-after-app-only-build-qa-success)** — probe port, **`npm run dashboard`** if down, then **`npm run pipe -- open`**.

## Files to know

- [bin/pipe.js](../../../bin/pipe.js) — the CLI itself
- [scripts/scratch/utils/stage-state.js](../../../scripts/scratch/utils/stage-state.js) — shared stage sentinels + status derivation
- [scripts/scratch/orchestrator.js](../../../scripts/scratch/orchestrator.js) — emits `::PIPE::` events and writes `{runDir}/.pipeline.pid`
- [scripts/dashboard/server.js](../../../scripts/dashboard/server.js) — write-gating, stage-state endpoint
