# Context engineering rollout — metrics

Use these to validate the pipeline and dashboard HITL changes after rollout.

## Quality (downstream)

- **Build-QA pass rate**: % of runs where `qa-report-build.json` meets `QA_PASS_THRESHOLD` without a refine loop.
- **Post-record QA drift**: count of QA issues tagged `prompt-contract-drift` or `missing-panel` per run (from `qa-report-*.json`).
- **Claim-check flags**: number of `claim-check-flags.json` entries per run; target downward trend when `pipeline-run-context.json` is present.

## Throughput (HITL)

- **Median time to clear drafts**: from `needs_review: true` to `needs_review: false` with `unresolvedDraftCount === 0`.
- **Facts reviewed per session**: approve/reject/edit actions in dashboard Fact Inbox (optional server log if you add analytics).

## Context health

- **`pipeline-run-context.json` presence**: should exist after `research` and refresh after `script`.
- **Curated digest size**: approximate character count of injected `CURATED PRODUCT KNOWLEDGE` block (should stay bounded via `CONTEXT_MAX_*` env vars).

## Environment knobs

- `CONTEXT_MAX_SECTION_CHARS` (default `2800`)
- `CONTEXT_MAX_BULLETS_PER_SECTION` (default `14`)
- `CONTEXT_MAX_QA_FIXLOG_CHARS` (default `2400`)
- `KNOWLEDGE_STALE_DAYS` (default `90`) — dashboard stale badge threshold
