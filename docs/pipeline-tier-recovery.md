# Tier-aware QA recovery

Referenced from `CLAUDE.md` § Pipeline Restartability. Do not rebuild the whole app for one bad step.

Every `qa-report-build.json` carries `buildMode`, `tierSummary`, and `recommendedRecovery`. The orchestrator and `pipe status` route a **surgical** recovery lane instead of regenerating the entire `scratch-app/index.html`.

```
buildMode  | app.passed | slide.passed | recommendedRecovery   | Lane (no build-app)
-----------|------------|--------------|-----------------------|-----------------------------
app-only   | true       | (skipped)    | null                  | stop
app-only   | false      | (skipped)    | app-touchup           | npm run pipe -- app-touchup
app+slides | true       | true         | null                  | stop
app+slides | true       | false        | slide-fix             | npm run pipe -- slide-fix
app+slides | false      | true         | app-touchup           | npm run pipe -- app-touchup
app+slides | false      | false        | app-touchup+slide-fix | app-touchup first, then slide-fix
either     | systemic*  |              | fullbuild             | (legacy LLM regen path)
```

\* Systemic = deterministic blocker, build-QA guardrail override, or runtime/selector errors on ≥2 steps. See `scripts/scratch/utils/qa-tier-summary.js`.

## Lane contracts (load-bearing)

- **`pipe app-touchup`** ([`scripts/scratch/scratch/app-touchup.js`](../scripts/scratch/scratch/app-touchup.js)) — app patches (`api-panel-toggle-latest`, `host-nav-logo-contrast`, `plaid-launch-cta-icon-ratio`, `plaid-link-token-products-prune`, `zip-cra-host-contract`) → `post-panels` → build-qa `stepScope=app` (or `all` on app-only). On residual failures under an AI agent, writes `qa-touchup-task.md` (app-only) or `qa-app-touchup-task.md` (app+slides). **Never** edits `.slide-root` blocks. Never calls `build-app`.
- **`pipe slide-fix`** ([`scripts/scratch/scratch/slide-fix.js`](../scripts/scratch/scratch/slide-fix.js)) — slide patches (typography ceiling/floor, layout, chrome-logo) → `strip-slide-roots --steps=…` → `post-slides --steps=…` → `post-panels` → build-qa `stepScope=slides`. Refuses to run on app-only and when the app tier hasn't passed. On residual failures, writes `qa-slide-fix-task.md`. **Never** edits non-slide step blocks. Never calls `build-app`.
- **`pipe status`** surfaces `tierSummary` + `recommendedRecovery`; the `nextRecoveryCommand` field is tier-aware.

**Do NOT** use `--build-fix-mode=touchup` (LLM full HTML regen) for tier-localized failures — that path rewrites the entire `index.html` and can regress passing tiers (see e.g. the Zip CRA LendScore slide regression `2026-05-21`). Use the tier lanes instead.

## Pipeline stages

`research`, `ingest`, `script`, `brand-extract`, `script-critique`, `embed-script-validate`, `build`, `build-qa`, `post-slides`, `post-panels`, `app-touchup`, `slide-fix`, `record`, `qa`, `figma-review`, `post-process`, `voiceover`, `coverage-check`, `auto-gap`, `resync-audio`, `embed-sync`, `audio-qa`, `ai-suggest-overlays`, `render`, `ppt`, `touchup`.
