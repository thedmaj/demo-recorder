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
| `templates/slide-template/pipeline-slide-contract.css` | Canvas 1280×800, typography ceilings |

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

Recorded slides target **1280×800 (16:10 responsive)** via `pipeline-slide-contract.css`.
Author with DECK templates; do **not** set fixed `width:1440px;height:900px` on `.slide-root`.

`scanSlideCanvasSize` (critical blocker, `app+slides` only) measures the rendered `.slide-root`
and fails if **width < 75% viewport**, **height < 67% viewport**, or **aspect outside [1.40, 1.85]**
(covers 16:9 = 1.78 and 16:10 = 1.60). Contract lives in `pipeline-slide-contract.css`
(`max-width: min(1280px, calc(100vw - 80px))`, `aspect-ratio: 16/10`) — **zero `!important`**,
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
| **Peer benchmark misuse** | Two hero stats side-by-side → `stat-highlight` (T4), **not** `data-table` (T7). Tables need ≥3 rows and right-aligned numerics — not a pair of callouts. |
| **Metric hero buried** | When narration cites a hero stat (+25%, ~90% fewer), put it in `.hero-stat-value` / mint moment — not a small card in a 4-up grid. |
| **API endpoint placement** | Put `POST /…` in a card column — never in a footer row. |
| **Duplicate JSON rail** | Do not embed JSON snippets inside `.slide-root` when `step.apiResponse` exists — use global `#api-response-panel` only. |
| **Mint overuse** | One `--plaid-teal-500` eye-draw per slide; stats on cream/white unless that stat *is* the mint moment. |
| **Overlap autofix regression** | Never inflate font-size above ceilings to “fix” overlap — increase `gap` / `padding-bottom` on `.slide-stack` instead. |
| **Bottom row clipped by `.frame { overflow: hidden }`** | The headline is too large for a text-heavy template. T4–T11 (card grids, stat highlights, CTA closes) cap `.h-title` at **64px** so the cards/body have room to breathe. T1–T3 keep the larger title clamp. Pipeline contract enforces this via `clamp(32px, 4.0vw, 64px)` on `.slide-root[data-slide-template="T4..T11"] .h-title`. |

## Template selection

Pick **one** of T1–T11 from DECK_TEMPLATES.md. Set `data-slide-template="T#"` on `.slide-root`.
Insight/API steps (`sceneType: "insight"`, `stepKind: "slide"`) use the same deck system — not host insight chrome.

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
