---
name: plaid-slide-design
description: >-
  Plaid Deck Design System for pipeline slide steps. Use when authoring,
  inserting, or fixing `.slide-root` HTML in post-slides, slide-fix, build-qa
  slide touchup, or storyboard slide edits. Enforces DECK_* briefs and blocks
  host/customer brand colors from bleeding into slides.
---

# Plaid Slide Design (pipeline)

Slides are **Plaid-branded narrative surfaces** — not extensions of the host bank app.
Every slide step uses the **Plaid Deck Design System** only.

## When to load this skill

- `post-slides` / `slide-fix` LLM insertion
- Manual or agent edits to `.slide-root` blocks in `scratch-app/index.html`
- Critiquing slide-tier build-QA failures (`slide-invented-color`, typography, chrome)

**Companion (layout patterns):** [`.claude/skills/plaid-workhorse-slides/SKILL.md`](../plaid-workhorse-slides/SKILL.md) — Workhorse html-ppt layouts with Plaid brand enforced. Injected together via `slide-design-skill.js`.

**Workhorse asset library:** [`.claude/skills/tosea-slide-workhorse/`](../tosea-slide-workhorse/) — single-page layout HTML to copy structure from (never copy themes/runtime).

## Source of truth (read in this order)

All paths relative to repo root:

| File | Role |
|------|------|
| `templates/slide-template/brand-design-briefs/DECK_DESIGN_SYSTEM.md` | Tokens, fonts, palette, shell, typography ceilings |
| `templates/slide-template/brand-design-briefs/DECK_TEMPLATES.md` | T1–T11 skeletons — pick **exactly one** per slide |
| `templates/slide-template/brand-design-briefs/DECK_COMPOSITION.md` | Headlines, pacing, background rhythm |
| `templates/slide-template/brand-design-briefs/WORKHORSE_TEMPLATE_CATALOG.md` | 20 showcase templates → T1–T11 + Workhorse layout routing |
| `templates/slide-template/PIPELINE_SLIDE_SHELL_RULES.md` | DOM merge contract for build + post-slides |
| `templates/slide-template/colors_and_type.css` | CSS custom properties (injected in `<head>`) |
| `templates/slide-template/slide.css` | Scoped rules under `.slide-root` only |
| `templates/slide-template/pipeline-slide-contract.css` | Canvas ~1400×875 (thin letterbox), typography ceilings |

**Do not** invent colors, fonts, or layout patterns outside these files.

## SLIDE vs HOST APP (hard boundary)

The host demo app is **customer-branded** (Huntington, Zip, Chime, etc.). Slides are **never** customer-branded.

| Surface | Brand | Colors / fonts |
|---------|-------|----------------|
| Host steps (`stepKind: "app"`) | Customer | From `brand/*.json` + build-app HOST APP DESIGN SYSTEM |
| Slide steps (`stepKind: "slide"`, `.slide-root`) | **Plaid only** | DECK_DESIGN_SYSTEM tokens only |

### Why host colors appear on slides (avoid these)

1. **Shared `index.html`** — `build-app` runs first and emits **unscoped** host CSS on `html, body, h1–h4, a` (customer hex + serif fonts). Slides live in the same document; anything not overridden inside `.slide-root` inherits host styles.
2. **Prompt confusion** — `post-slides` receives the customer **name** (`Brand: Huntington Bank`) for partnership copy only. That is **not** permission to use customer palette inside `.slide-root`.
3. **`visualState` hints** — Host steps may mention "Huntington green (#5BA63C)". Slide steps should say "Plaid-branded navy/cream". Never copy host hex from script context into slide markup.
4. **`hostHasExistingSlide` mirroring** — After slide 1, later slides may be told to "mirror existing `.slide-root`". Mirror **structure and template id**, not host colors or inline hex from a bad first slide.
5. **Inline LLM styles** — Prefer `var(--plaid-teal-500)`, `var(--plaid-ink-900)`, and approved rgba() on deck tokens. Raw customer hex in slide HTML bypasses CSS scoping.

### Forbidden inside `.slide-root`

- Customer primary/CTA hex (e.g. `#034F54`, `#5BA63C`, `#388E3C`)
- Customer heading fonts (`Huntington Serif`, host Google Fonts)
- Host nav, account cards, or `data-testid` blocks from the app tier
- `html` / `body` restyles using slide or host tokens
- Duplicate raw JSON rails (use global `#api-response-panel` only)
- Right padding / max-width reserves for the JSON panel (`padding-right: 520px`, `max-width: calc(100% - 520px)`, `body.api-panel-open` slide-shrink rules)

### Allowed inside `.slide-root`

- Approved Plaid palette (see DECK_DESIGN_SYSTEM §1.3): `--plaid-ink-900`, `--plaid-teal-500` / `#42F0CD`, navy/cream/holo backgrounds
- Plaid Sans + Bowery Street (one `<em>` italic accent per headline)
- Bundled logos only: `assets/logos/plaid-horizontal-white.png` (navy), `-dark.png` (light/cream), `-holograph.png` (holo)
- **Logo placement:** top-right, **28px** height, **75px above** the topmost text row — set by `slide.css` / `pipeline-slide-contract.css`. Do **not** inline `left:` or showcase-scale `height:` on `.chrome-logo`.
- Partnership **text** naming the customer (e.g. "Plaid × Huntington") — still Plaid-styled, no customer color swatches

## Pipeline canvas (not 1920×1080) — HARD CONTRACT

Recorded slides target a **near-full 16/10 canvas with a thin navy letterbox** via
`pipeline-slide-contract.css` (`max-width: min(1400px, calc(100vw - 24px))` → ~1400×875 on
1440×900). The old 1280×800 letterbox left only ~612px content height after frame padding, so
content-heavy slides clipped at the bottom (2026-05-29). Frame padding is `--pad-top:84px` /
`--pad-bottom:56px` (pad-top ≥75px keeps `.chrome-logo` on-canvas). Author with DECK templates; do
**not** set fixed `width:1440px;height:900px` on `.slide-root`.

**Content-clip detector (`slide-content-clipped`, critical blocker):** `build-qa` measures whether
slide content extends beyond the `.slide-root` edge (clipped by `overflow:hidden`). If content still
overflows, **trim the content** (drop/shorten the lowest row — e.g. a stat callout — tighten body
copy, reduce spacing); do NOT rely on the letterbox to hide overflow, and do NOT add font-clamps.
The detector measures BOTH (a) element-rect edges crossing the canvas AND (b) the canvas
**`.frame.scrollHeight − clientHeight`** (container scroll-overflow). (b) was added 2026-06-15 after a
two-column comparison slide (`bank-data-lift-slide`) clipped its card bullet lists by ~140px yet
passed QA: the overflowing lines were **raw text nodes + `<br>` inside a flex-constrained card whose
border stayed inside the frame**, so no element edge crossed the canvas — only the scrollHeight check
catches that. Any `> 6px` canvas overflow now fails the slide.

**Comparison / bullet-list card rule (prevents the above clip):** in `.sc-row` / `.sc-card` (or any
multi-line list card), content MUST fit the canvas — `align-items: stretch` sizes both cards to the
tallest, so the densest card is the binding constraint. Keep bullets **short enough to sit on one
line** at the template's default body size, cap list **`line-height` at ~1.4–1.5** (NOT 1.7 — loose
leading on a 5+ line mono block is exactly what overflowed here), and prefer ≤5 short bullets per
card. Prefer shortening wording or tightening line-height/padding over shrinking body text to fit —
if you do reduce a font-size, do it deliberately and stay readable (templates own sizing; there is
no enforced floor — see Typography below).
`slide-fix` must re-check `.frame` scroll-overflow after editing any list/comparison slide.

`scanSlideCanvasSize` (critical blocker, `app+slides` only) measures the rendered `.slide-root`
and fails if **width < 75% viewport**, **height < 67% viewport**, or **aspect outside [1.40, 1.85]**
(covers 16:9 = 1.78 and 16:10 = 1.60). Contract lives in `pipeline-slide-contract.css`
(`max-width: min(1400px, calc(100vw - 24px))`, `aspect-ratio: 16/10`) — **zero `!important`**,
cascade order authoritative (injected after `slide.css`). Never shadow it with a higher-priority
`!important` block or add `min-height`/`aspect-ratio`/width overrides on `.slide-root` that shrink
the slide. The API panel is a fixed overlay (z-index 2100) — reserve **no** width for it.

## Required DOM shape

```html
<div data-testid="step-{id}" class="step">
  <div class="slide-root" data-slide-template="T#">
    <div class="frame">
      <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="">
      <div class="eyebrow-tag">Section label</div>
      <div class="slide-stack">
        <h2 class="h-title">Sentence case headline with one <em>accent</em>.</h2>
      </div>
    </div>
  </div>
</div>
```

- **Mint cap (≤ 3 references per slide).** Combined count of `--plaid-teal-500` + `#42F0CD` across class names, inline styles, and inline CSS must stay ≤ 3 per `.slide-root`. Reserve mint for ONE primary eye-draw — usually a hero stat, a single CTA accent, or a value-summary mint card. Supporting text uses `var(--plaid-white)` / `rgba(255,255,255,0.78)` on navy, or `var(--plaid-ink-900)` on light/cream/holo. post-slides demotes excess mint to `var(--plaid-white)` automatically; relying on that as a crutch still loses visual hierarchy — write within the cap from the start.
- **Text contrast on light variants (HARD — build-QA `slide-text-contrast` blocker, 2026-06-11).** On `.slide-root.light` / `.cream` / `.holo`, NEVER style text white or near-white (`#fff`, `var(--plaid-white)`, `rgba(255,255,255,…)`) and never use mint for title `<em>` accents — both sit at ~1.1–1.3:1 contrast on light surfaces (invisible; KeyBank auth-slide regression). Text uses `var(--plaid-ink-900)` / `rgba(2,37,68,…)`; accents use `var(--plaid-blue-600)`. The pipeline contract CSS now ink-paints `p`/`li`/`span` defaults on light variants (mirroring its dark white-paint rule) and switches `.h-title em` to blue-600 — do not fight it with inline white. build-qa measures computed WCAG contrast per slide element and flags ratios < 2.0 as critical deterministic blockers.
- **Typography: templates own sizing (2026-05-27 update).** The slide-template CSS (`slide.css` + `pipeline-slide-contract.css`) sets the default size for every canonical class (`.h-title`, `.slide-body-text`, `.hero-stat-value`, `.eyebrow-tag`, `.mono-block`). Use these classes and let the stylesheet pick the size; do not add inline `font-size` unless content density or rendered overlap genuinely demands it. There is **no 24px floor and no per-template ceiling enforcement** — the LLM may reduce a specific element's font-size via inline style to fit content, and should reduce intelligently (small enough to clear the overlap or fit on one line, but stay readable). The pipeline no longer rewrites inline `font-size` to clamp it.
- Flex/grid + `gap` only — **no `display:inline-block`**.
- Headline: sentence case, ends with period, one Bowery `<em>` accent.

## Forbidden sales CTAs (pipeline demos — HARD)

Recorded product demos are **not** sales decks. Slides must **never** invite the viewer to contact Plaid, start a trial/POC, or kick off a retro/champion-challenger program.

**Do not render** (as buttons, pill CTAs, faux `<button>` spans, or prominent action lines):

- Contact Plaid / talk to Plaid / reach out to Plaid
- Contact Account Manager / contact your Plaid Account Manager / schedule with your Account Manager
- Start a free trial / free trial
- Start a POC / POC scoping / technical review and POC scoping
- Perform a retro analysis / run the production retro / start your retro / greenlight the retro

**Allowed on value-summary / T11 closes instead:**

- Three **product outcome** bullets (risk lift, compliance, operational wins)
- A **declarative** closing line tied to the demo story (no faux button chrome)
- Partnership / section labels in `.eyebrow-tag` only (`Plaid × {customer}`, product names). **Do not** add `.chrome-foot` — pipeline slides omit footers.

Build-QA enforces this via `scanSlideForbiddenSalesCta` (critical blocker).

## Layout & spacing (lessons from slide QA — May 2026)

These patterns caused the most **deterministic** failures in showcase-router reruns:

| Failure mode | Prevention |
|--------------|------------|
| **`slide-text-overlap`** | Wrap body in `.slide-stack`; do not add `.chrome-foot`. Keep API endpoint labels inside cards, not in a bottom footer row. |
| **`slide-text-wrap`** | Headline (`.h-title`) must fit **one line** — aim ≤ ~6 words / ~40 chars. A wrapping H2 reads as overflow. Shorten to a declarative phrase; push detail to body. e.g. "Mortgage verification shouldn't take weeks." → "Skip the document chase." |
| **`slide-value-messaging`** | Every slide carries **2–3 concrete, outcome-oriented value claims** tied to the step's data — never generic mantras. "Verify earning power from live payroll, not a static pay stub." not "Powerful insights." (See DECK_COMPOSITION → Pipeline product demos → Value claims.) |
| **Peer benchmark misuse** | Two hero stats side-by-side → `stat-highlight` (T4), **not** `data-table` (T7). Tables need ≥3 rows and right-aligned numerics — not a pair of callouts. |
| **Metric hero buried** | When narration cites a hero stat (+25%, ~90% fewer), put it in `.hero-stat-value` / mint moment — not a small card in a 4-up grid. |
| **API endpoint placement** | Put `POST /…` in a card column — never in a footer row. |
| **Duplicate JSON rail** | Do not embed JSON snippets inside `.slide-root` when `step.apiResponse` exists — use global `#api-response-panel` only. |
| **Mint overuse** | One `--plaid-teal-500` eye-draw per slide; stats on cream/white unless that stat *is* the mint moment. |
| **Overlap autofix regression** | Never inflate font-size above ceilings to “fix” overlap — increase `gap` / `padding-bottom` on `.slide-stack` instead. |
| **Bottom row clipped by `.frame { overflow: hidden }`** | The headline is too large for a text-heavy template. T4–T11 (card grids, stat highlights, CTA closes) cap `.h-title` at **64px** so the cards/body have room to breathe. T1–T3 keep the larger title clamp. Pipeline contract enforces this via `clamp(32px, 4.0vw, 64px)` on `.slide-root[data-slide-template="T4..T11"] .h-title`. |

## Template selection

**The script tags intent; the router maps it to a DEFAULT template.** At script time, prefer setting
`slideRole` over `slideTemplate`/`workhorseLayout`/`showcaseTemplateId` — the latter are hard
overrides that bypass routing. The script-gen LLM sets a `slideRole` on each slide step (its
narrative job), and `slide-template-router.js` deterministically maps the role to a Plaid
template/layout. **At slide-authoring time the routed template is a strong default, not a mandate**
(LAYOUT AUTONOMY, 2026-07-01): the authoring model may deliberately choose a different T1–T11 /
workhorse layout when it fits the slide's content better — set `data-slide-template` /
`data-workhorse-layout` to what it actually used. Insight/API steps (`sceneType: "insight"`,
`stepKind: "slide"`) use the same deck system — not host insight chrome.

### Slide intent → template (authoritative)

| slideRole | Template | T# / layout | Reach for it when… |
|---|---|---|---|
| `opening` | Title Hero | T1 / cover | deck opener, one emotional payoff |
| `section-break` | Section Beat | T2 / section-divider | chapter divider in a long deck |
| `problem-statement` | Statement Slide | T3 / bullets | one headline + one idea, lots of air |
| `concept-explainer` | Bullet List | T3 / bullets | 3–6 peer points (not a process) |
| `three-pillars` | Three Pillars | T5 / three-column | exactly three peers of equal weight |
| `pull-quote` | Big Pull Quote | T3 / big-quote | a single quote that earns full-bleed |
| `hero-metrics` | Triple Stat | T4 / stat-highlight | ≤3 hero numbers at max size |
| `kpi-dashboard` | KPI Grid | T4 / kpi-grid | 4 metrics with QoQ deltas |
| `api-field-reveal` | **API Field Table** | T7 / field-table | **the key fields an API returns + sample values** (CRA Income/Cash Flow/Base Report read-outs, identity/account fields) — label/value rows, never bare spans or KPI cards |
| `data-comparison-table` | Data Table | T7 / table | pricing tiers, thresholds, API limits — rows + right-aligned numerics |
| `bar-chart` | Bar Chart Insight | T4 / chart-bar | bounded categorical comparison (top-N, cohorts); SVG only |
| `before-after` | Before / After | T6 / comparison | two-panel old-way vs new-way |
| `transformation-rows` | Comparison Table | T7 / comparison | 3–5 matched before→after rows |
| `sequential-steps` | Step Flow | T8 / process-steps | a numbered, causal process |
| `flow-diagram` | Flow Diagram | T8 / flow-diagram | 4–6 node pipeline, one highlighted node |
| `architecture` | Architecture Map | T9 / arch-diagram | one platform + many dependencies |
| `timeline` | Timeline | T8 / timeline | events on a true time axis |
| `roadmap` | Roadmap | T11 / roadmap | NOW / NEXT / LATER / VISION |
| `code-proof` | Code Window | T3 / code | one API call / snippet (10–15 lines) |
| `customer-proof` | Proof Quote | T10 / customer-proof | testimonial + a hero stat |
| `value-summary` | Action Cards | T11 / cta | the closing outcomes slide |

The router also honors per-template `whenToUse`/`avoidWhen` (in `slide-template-registry.json`) and a
CRA-endpoint safety fallback. To change role↔template mappings or a template's discriminating
keywords, edit `TEMPLATE_STEP_ROLES` / `TEMPLATE_KEYWORDS` in
`scripts/scratch/utils/slide-template-registry.js` (or `data-step-roles` / `data-keywords` on the
showcase `<section>`), then regenerate the registry.

## Build-QA expectations

Warnings/blockers to respect:

- `slide-invented-color` — hex outside approved Plaid palette
- `slide-plaid-logo-invented` — fabricated Plaid marks
- `slide-chrome-logo-placement` — inline top-left or oversized logo (showcase leak)
- `slide-canvas-size` — slide too small or wrong aspect
- `slide-shell-chrome` — missing `.chrome-logo` / `.eyebrow-tag`
- `slide-narration-drift` — rendered text must match narration claims
- `slide-forbidden-sales-cta` — contact/trial/POC/retro action prompts on slides

## Quick palette reference

```
Navy bg:     --plaid-ink-900  (#022544)
Mint accent: --plaid-teal-500 (#42F0CD)
Cream text:  #E8E4D8 (on navy slides)
Light slides: .slide-root.light | .cream | .holo per DECK_COMPOSITION background rhythm
```

When in doubt, open DECK_DESIGN_SYSTEM.md — not the host app's `<style>` block.

## Pipeline mechanics (when slides exist / don't)

- **App-only invariant (HARD):** runs with `run-manifest.json.buildMode === 'app-only'` produce
  **zero** slide artifacts — no slide steps, no placeholder, `post-slides` skips
  (`{ skipped: true, reason: 'app-only' }`), slide-tier scanners gated off. `scanAppOnlyNoSlides`
  fires `app-only-slide-leak` (critical) on any leak. Only the storyboard editor's
  `insert-library-slide` flips a run to `app+slides`. See `tests/unit/app-only-zero-slides.test.js`.
- **Slide-fix is the only slide recovery** — slides NEVER trigger `build-app` regeneration. When
  `build-qa.tierSummary.slide.passed === false`, the orchestrator runs the slide-fix lane
  (deterministic patches → `strip-slide-roots --steps=…` → `post-slides --steps=…` → scoped re-QA).
  Host steps that already passed are not re-rolled. (Drive via `pipeline-cli`.)
- **Drift checkpoint:** after build-qa passes, `slide-content-hash.json` SHA-256s every step block
  (`source: 'build-qa'`). After `record`, `post-record-freeze.sentinel` exists → automated
  `post-slides`/`slide-fix` re-runs SKIP (`reason: 'post_record_freeze'`); storyboard editor edits
  are allowed but recompute the hash and flag `voiceoverStale`/`recordingStale`.
- **Workhorse hybrid leak scanners** (`app+slides`, critical): `scanSlideWorkhorseThemeLeak`
  (no `assets/themes/*.css` or CDN webfont imports inside `.slide-root`),
  `scanSlideWorkhorseRuntimeLeak` (no `runtime.js`/`fx-runtime.js`/`chart.js`/`highlight.js`).
  Motion attrs (`data-anim`, `data-fx`, `anim-*`) are warnings only. Pipeline slides are static + SVG.
  See `.claude/skills/plaid-workhorse-slides/SKILL.md`.
- **PPTX export font swap:** Manrope (sans), Playfair Display (display), JetBrains Mono (mono) —
  export tooling (`scripts/export-plaid-deck.sh`) is separate from on-screen pipeline slides.
- **Opt-in patches** (manual invoke only, do not auto-fire from QA): `slide-design-tokens-inject`,
  `slide-shell-chrome-inject`, `slide-chrome-logo-canonical`, `slide-typography-floor` in
  `scripts/scratch/utils/qa-patch-library.js` via `buildManualPatchMatch(name)` + `applyPatches()`.
