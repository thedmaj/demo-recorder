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

## Source of truth (read in this order)

All paths relative to repo root:

| File | Role |
|------|------|
| `templates/slide-template/brand-design-briefs/DECK_DESIGN_SYSTEM.md` | Tokens, fonts, palette, shell, typography ceilings |
| `templates/slide-template/brand-design-briefs/DECK_TEMPLATES.md` | T1–T11 skeletons — pick **exactly one** per slide |
| `templates/slide-template/brand-design-briefs/DECK_COMPOSITION.md` | Headlines, pacing, background rhythm |
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
- Partnership **text** naming the customer (e.g. "Plaid × Huntington") — still Plaid-styled, no customer color swatches

## Pipeline canvas (not 1920×1080)

Recorded slides target **1280×800 (16:10 responsive)** via `pipeline-slide-contract.css`.
Author with DECK templates; do **not** set fixed `width:1440px;height:900px` on `.slide-root`.

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
      <div class="chrome-foot"><span>Footer left</span><span>Footer right</span></div>
    </div>
  </div>
</div>
```

- One mint moment per slide (`--plaid-teal-500`)
- Body text ≥ 24px; flex/grid + `gap` only — **no `display:inline-block`**
- Headline: sentence case, ends with period, one Bowery `<em>` accent

## Template selection

Pick **one** of T1–T11 from DECK_TEMPLATES.md. Set `data-slide-template="T#"` on `.slide-root`.
Insight/API steps (`sceneType: "insight"`, `stepKind: "slide"`) use the same deck system — not host insight chrome.

## Build-QA expectations

Warnings/blockers to respect:

- `slide-invented-color` — hex outside approved Plaid palette
- `slide-plaid-logo-invented` — fabricated Plaid marks
- `slide-canvas-size` — slide too small or wrong aspect
- `slide-shell-chrome` — missing `.chrome-logo` / `.eyebrow-tag` / `.chrome-foot`
- `slide-narration-drift` — rendered text must match narration claims

## Quick palette reference

```
Navy bg:     --plaid-ink-900  (#022544)
Mint accent: --plaid-teal-500 (#42F0CD)
Cream text:  #E8E4D8 (on navy slides)
Light slides: .slide-root.light | .cream | .holo per DECK_COMPOSITION background rhythm
```

When in doubt, open DECK_DESIGN_SYSTEM.md — not the host app's `<style>` block.
