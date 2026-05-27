# Plaid Slide Design System — pipeline contract

Required for new runs with slides. Referenced from `CLAUDE.md` § Plaid Slide Design System.

**App-only invariant (HARD):** Runs with `run-manifest.json.buildMode === 'app-only'` MUST produce zero slide artifacts. Slide steps are not generated, the canonical placeholder is not emitted, `post-slides` skips with `{ skipped: true, reason: 'app-only' }`, slide-tier QA scanners are gated off, and `scanAppOnlyNoSlides` fires `app-only-slide-leak` (critical deterministic blocker) on any leak. The only path from app-only to app+slides is the storyboard editor's `insert-library-slide` which flips the manifest via `stampInsertedStepKindAndMaybeUpgradeBuildMode`. See `tests/unit/app-only-zero-slides.test.js`.

**Source of truth:** `templates/slide-template/brand-design-briefs/` (`DECK_DESIGN_SYSTEM.md`, `DECK_TEMPLATES.md`, `DECK_COMPOSITION.md`) + `colors_and_type.css` + `slide.css` + `pipeline-slide-contract.css` + `pipeline-slide-shell.html`. Agent skill: [`.claude/skills/plaid-slide-design/SKILL.md`](../.claude/skills/plaid-slide-design/SKILL.md) (slide vs host isolation, palette enforcement). Merge contract for build agents: [`templates/slide-template/PIPELINE_SLIDE_SHELL_RULES.md`](../templates/slide-template/PIPELINE_SLIDE_SHELL_RULES.md).

**Slide-fix as canonical residual recovery (REQUIRED):** When `build-qa.tierSummary.slide.passed === false`, the orchestrator dispatches the **slide-fix lane** ([`scripts/scratch/scratch/slide-fix.js`](../scripts/scratch/scratch/slide-fix.js)): deterministic patches → `strip-slide-roots --steps=<failing>` → `post-slides --steps=<failing>` → scoped re-QA → optional `qa-slide-fix-task.md` for Agent Mode StrReplace edits. **Slides NEVER trigger `build-app` regeneration.** This locks in the app-first / slides-after architecture — host steps that already passed QA are not re-rolled when a slide fails. See `scripts/scratch/utils/strip-slide-roots-for-post-slides.js` (canonical placeholder shape lives here as `buildCanonicalSlidePlaceholder`).

**Public API contract:** `scripts/scratch/scratch/post-slides.js` exports `spliceSlideFragmentIntoHtml` as a public function. Consumed by `scripts/dashboard/utils/insert-slide-html.js` (the storyboard editor's `/insert-library-slide` endpoint), `scripts/scratch/utils/qa-touchup.js`, and the canonical splice path. Do not break this export when refactoring post-slides.

**Frozen runs:** Existing `out/demos/*` runs are **not** retrofitted. Only new pipeline runs (and `post-slides` insertions) adopt T1–T11 templates.

## Shell + templates

- Every slide step: `data-testid="step-{id}"` → `.slide-root` with `data-slide-template="T1"|…|"T11"`.
- Canonical chrome: `.frame`, `.chrome-logo`, `.eyebrow-tag`, `.h-title` (one `<em>` Bowery italic accent), `.chrome-foot` (T1 may omit eyebrow/footer).
- Background classes on `.slide-root`: default navy (`--plaid-ink-900`), or `.light` / `.cream` / `.holo`.
- Assets copied per build: `scratch-app/fonts/`, `scratch-app/assets/logos/` (paths like `assets/logos/plaid-horizontal-white.png`).
- `post-slides-report.json` records `templatesUsed[]` per inserted slide.

## Canonical slide canvas (HARD CONTRACT, May 2026 — rebuilt 2026-05-22)

Every active slide MUST render at a **Google-Slides-class size** that dominates the viewport. There is **no per-slide variability** — one contract, all slides, enforced by a deterministic blocker.

| Property | Contract | Why |
|----------|----------|-----|
| **Width** | `max-width: min(1280px, calc(100vw - 80px))` → **≥ 75% viewport** | Slides are the deliverable on slide-tier steps; small slides are unreadable on screen capture. |
| **Aspect ratio** | `16/10` (allowed: `[1.40, 1.85]` — covers 16:9 = 1.78 and 16:10 = 1.60) | Matches Google Slides default + Plaid Deck Design System. |
| **Height** | Auto from aspect-ratio → **≥ 67% viewport** | On a 1440×900 viewport the slide is 1280×800. |
| **API panel reservation** | **None** — panel is a fixed overlay (z-index 2100) | Collapsed default is 48px edge toggle; expand-on-click overlays content without shrinking slides |

**Source of truth (rebuilt 2026-05-22):** [`templates/slide-template/pipeline-slide-contract.css`](../templates/slide-template/pipeline-slide-contract.css), injected ONCE by `post-slides.ensureSlideDesignStylesInHead` inside the `<style data-pipeline-slide-contract="v1">` block. **Zero `!important` declarations** in the contract — cascade order is authoritative (the contract block is emitted AFTER `slide.css` in `<head>`). This replaces four prior competing patches:

| Replaced layer | Status |
|----------------|--------|
| `build-app.js` `slide-root-responsive-override` | DELETED |
| `normalize-slide-typography.js` `slide-typography-ceilings-v1` (`max-width` clause) | DELETED (font ceilings kept) |
| `qa-patch-library.js` `slide-canvas-fullbleed` | RETIRED (stub kept for historical references) |
| Per-step inline-style escapes (added during surgical slide-fix iterations) | DELETED |

**Enforced by:**

- **`scanSlideCanvasSize`** in `build-qa.js` (deterministic blocker, category `slide-canvas-size`, severity `critical`). Measures rendered `.slide-root.getBoundingClientRect()` per slide step during the Playwright walk and fires if width < 75%, height < 67%, or aspect outside `[1.40, 1.85]`. Gated on `buildMode === 'app+slides'`.
- **`scanPanelOverlayContract`** in `build-qa.js` (deterministic blocker, category `panel-overlay-contract`, severity `critical`). Forbids `body.api-panel-open` slide-shrink rules and 520px reserve CSS on host/slide steps.
- **`scanSlideNarrationConcreteValues`** in `build-qa.js` (deterministic blocker, category `slide-narration-drift`, severity `critical`). Catches LLM hallucinations where the slide's rendered text doesn't match concrete claims in the step's narration (numeric tokens, ACCEPT/REVIEW/REROUTE decisions, product names like "Trust Index"). Voiceover sync depends on the rendered content matching the narrator's claims.

**Hand-edits MUST NOT** add `min-height`, `aspect-ratio`, or width overrides on `.slide-root` (inline or in stylesheet) that would shrink the slide below the contract. The `scanSlideCanvasSize` blocker will fail the build. If you need to override the contract, edit `pipeline-slide-contract.css` directly — do not shadow it with a higher-priority `!important` block.

## Drift checkpoint (slide-content-hash.json + post-record-freeze.sentinel)

After `build-qa` passes, [`scripts/scratch/utils/slide-content-hash.js`](../scripts/scratch/utils/slide-content-hash.js) writes a SHA-256 of every `<div data-testid="step-{id}">` block to `slide-content-hash.json` with `source: 'build-qa'`. This locks the HTML at the QA-blessed state. On app-only runs the slide-tier section is **omitted** (no slides exist to hash).

When `record` completes, it writes `post-record-freeze.sentinel`. While the sentinel exists:
- Automated `post-slides` / `slide-fix` re-runs SKIP with `reason: 'post_record_freeze'` (and a recovery hint to re-run `pipe stage record`).
- Storyboard editor mutations (`/script`, `/insert-library-slide`, `/remove-step`, `/reorder-steps`) are allowed but call `recordEditorMutation` to:
  1. Recompute slide-content-hash with `source: 'storyboard-edit'`, `userModifiedSinceQa: true` for affected step ids
  2. Append to `editor-mutation-log.json` with `voiceoverStale` / `recordingStale` flags

`GET /api/runs/:runId/staleness` returns the dashboard-banner-ready summary with `recommendedRecovery` priority: `recordingStale > voiceoverStale > qaStale`. The dashboard surfaces this as yellow ("QA not re-run since edit") and red ("Recording stale") banners.

## Record stage guard

`record-local.js` refuses to start if `scratch-app/index.html` contains any `data-slide-pending="true"` placeholder (post-slides failed to fill it). Halts with a clear recovery hint pointing at `pipe stage post-slides` or `pipe slide-fix`.

## Composition rules

- Sentence-case headlines ending with a period; **one mint moment** per slide (`--plaid-teal-500` / `#42F0CD`).
- Body text **≥ 24px**; flex/grid + `gap` only — **no `display: inline-block`** inside `.slide-root`.
- Background rhythm: **≤ 4 consecutive navy** slides before a `.light` / `.cream` / `.holo` interlude.
- Approved palette only; soft tints via `rgba()` on brand tokens.

## PPTX export font swap (documented)

Manrope (sans), Playfair Display (display), JetBrains Mono (mono) — export tooling is separate.

## Build-QA — deterministic blockers + design warnings

**Slide canvas size (hard contract — see § Canonical slide canvas above):** `scanSlideCanvasSize` in `build-qa.js`. Category `slide-canvas-size`, severity `critical`. Auto-fixed by the `slide-canvas-fullbleed` patch.

**Logo (hard contract):** `scanSlidePlaidLogoAuthenticity` in `build-qa.js` is a **deterministic blocker** (`severity: 'critical'`). Slides must use bundled horizontal wordmarks only — `<img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png">` (navy), `plaid-horizontal-dark.png` (light/cream/holo), or `plaid-horizontal-holograph.png` — **or omit** `.chrome-logo` entirely. Never invent SVG/icon-grid logos or render "PLAID" as text/CSS.

**CRA LendScore host (blockers when family is `cra_lend_score`):** `scanCraHostUnderwritingContracts` enforces Zip-style **NMLS ID 1963958** footer (via `inputs/brand-references/zip.md`), visible `approve-plan-cta`, and `evaluateApiStoryAlignment` recognizes `POST /cra/check_report/lend_score/get` (not Base Report mis-label). Product KB: `inputs/products/plaid-cra-lend-score.md`.

**Plaid × Workhorse hybrid blockers (when slides borrow Workhorse layouts):** Three scanners in `build-qa.js` (May 2026 — gated on `buildMode === 'app+slides'`):
- **`scanSlideWorkhorseThemeLeak`** — category `slide-workhorse-theme-leak`, severity `critical`. Blocks `<link>` to `assets/themes/*.css` from html-ppt or CDN webfont imports (Inter / Playfair / Noto / JetBrains Mono / IBM Plex Mono) inside `.slide-root`.
- **`scanSlideWorkhorseRuntimeLeak`** — category `slide-workhorse-runtime-leak`, severity `critical`. Blocks `<script>` references to `runtime.js`, `fx-runtime.js`, `chart.js`, or `highlight.js` inside `.slide-root`. Pipeline slides are static and SVG-only.
- **`scanSlideMotionAttributes`** — category `slide-motion-attributes`, severity `warning`. Flags `data-anim`, `data-fx`, and `anim-*` classes inside `.slide-root`. Motion is allowed only on standalone exports.

**Text overlap (May 2026):** `scanSlideTextOverlap` is a deterministic blocker (category `slide-text-overlap`, severity `critical`). During the Playwright walk, every visible text-bearing element inside `.slide-root` is measured; pairs whose rendered bounding boxes intersect by more than 8×8 px are reported with element tags, fonts, rects, and a recommended target font-size (75% of the larger, floored at the 24 px Plaid body minimum). Parent-child relationships are excluded. The `slide-text-overlap-autofix` patch in [`scripts/scratch/utils/qa-patch-library.js`](../scripts/scratch/utils/qa-patch-library.js) reads `build-qa-diagnostics.json` and emits scoped per-step `font-size` and `.slide-stack { gap }` overrides; when both overlapping elements are already at the 24 px floor the patch defers to `slide-fix` LLM remediation (widen container padding/gap).

Hybrid rules: [`.claude/skills/plaid-workhorse-slides/SKILL.md`](../.claude/skills/plaid-workhorse-slides/SKILL.md). Standalone export: [`scripts/export-plaid-deck.sh`](../scripts/export-plaid-deck.sh).

**Eight warning scanners** (not blockers): tokens, shell chrome, 24px floor, italic accent, mint overuse, inline-block, background rhythm, invented colors — all `severity: 'warning'`, `deterministicBlocker: false`.

## Opt-in patches (manual invoke)

[`scripts/scratch/utils/qa-patch-library.js`](../scripts/scratch/utils/qa-patch-library.js): `slide-design-tokens-inject`, `slide-shell-chrome-inject`, `slide-chrome-logo-canonical`, `slide-typography-floor` — use `buildManualPatchMatch(name)` + `applyPatches()`; they do **not** auto-fire from QA.
