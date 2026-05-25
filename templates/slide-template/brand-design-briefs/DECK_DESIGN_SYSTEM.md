# Plaid Deck Design System

> **A reusable design brief for building any HTML slide deck in the Plaid visual language.**
> Use this with Claude Code in agent mode to scaffold a new deck, or as a reference when iterating on an existing one.

> ## Pipeline addendum (REQUIRED reading for demo-recorder builds)
>
> **Inside the demo-recorder pipeline, the canvas is 1280×800 (16:10 responsive), not 1920×1080.** Pixel sizes referenced below are authoring-canvas units; the pipeline scales them via `templates/slide-template/slide.css` + `pipeline-slide-contract.css` and `.slide-root` max-width. Token names (`--type-title` etc.) are honored verbatim.
>
> Authoritative pipeline references:
> - Canvas + cascade contract: [`templates/slide-template/pipeline-slide-contract.css`](../pipeline-slide-contract.css)
> - DOM shape rules: [`templates/slide-template/PIPELINE_SLIDE_SHELL_RULES.md`](../PIPELINE_SLIDE_SHELL_RULES.md)
> - Pipeline tests: `tests/unit/slide-canvas-size.test.js`, `tests/unit/slide-contract-cascade.test.js`
>
> Two separate canvases coexist intentionally:
> - **Authoring canvas (this brief)**: 1920×1080 for static deck.html previews / PDF exports
> - **Pipeline canvas (the demo video)**: 1280×800 for recorded host-app slide steps
>
> Both use the same T1–T11 templates, the same color tokens, the same Bowery Street display font. Only the canvas scale + max-width differ. If you author for the 1920×1080 canvas, the pipeline will responsively scale your slide; do NOT bake fixed 1920×1080 pixel positions into pipeline slide HTML.

This document has four parts:

1. **Foundations** — tokens, fonts, color, type scale, the slide shell
2. **Template library** — eleven reusable slide templates with copy-paste skeletons
3. **Composition rules** — how to choose templates, sequence sections, write headlines
4. **Implementation checklist** — what Claude Code should do step-by-step

---

## Part 1 — Foundations

### 1.1 What you are building

A **1920 × 1080 HTML slide deck** that uses a `<deck-stage>` web component to scale to any viewport, handle keyboard navigation, render speaker notes, and print to PDF.

**File layout:**

```
deck.html                ← main file
deck-stage.js            ← slide-stage web component (provided)
colors_and_type.css      ← design tokens (provided)
fonts/                   ← Plaid Sans + Bowery Street .otf files (provided)
assets/logos/
  plaid-horizontal-white.png
  plaid-horizontal-dark.png
assets/textures/         ← optional holo gradients (we use CSS instead)
```

**Hard rules:**

- Author every slide at **1920 × 1080**. Do not use vw/vh inside slides; px only.
- Static HTML — **no React, no build step**. Slides are direct-child `<section>` elements of `<deck-stage>`.
- Use **flex / grid with `gap`** for every multi-element row. Never inline-block or per-element margins.
- Body text **minimum 24px**. Hero numbers and titles much larger.

### 1.2 Fonts

```css
--font-display: "Bowery Street", "Times New Roman", Georgia, serif;
--font-sans:    "Plaid Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono:    "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
```

- **Bowery Street** (serif) — display & headline accents only. Hero numbers, italicized punch phrases, section starters. Weights 100–700, each with italic. Use 400 italic and 500 regular heavily.
- **Plaid Sans** — all body and most headlines. Weights 300–700.
- **SF Mono / JetBrains Mono** — code, raw data fragments, eyebrow labels, JSON.

**Substitution for export:** when exporting to PPTX, swap to Manrope (sans), Playfair Display (display serif), JetBrains Mono (mono) — these are free Google Fonts that render correctly in PowerPoint and Google Slides.

### 1.3 Color palette

```css
/* Neutrals */
--plaid-black:    #111112;
--plaid-white:    #FFFFFF;
--gray-50:        #F9F9F9;
--gray-100:      #F2F2F2;

/* Brand blues + mint */
--plaid-ink-900:  #022544;   /* deepest navy — primary dark background */
--plaid-ink-800:  #043C65;
--plaid-blue-700: #07578D;
--plaid-blue-600: #0B7BBC;   /* signature Plaid blue */
--plaid-blue-500: #3A80E2;
--plaid-blue-400: #5FA8E2;
--plaid-teal-600: #05565C;
--plaid-teal-500: #42F0CD;   /* fresh mint — the "Plaid / action / after" color */
--plaid-teal-400: #71FBE3;

/* Holograph pastels — soft, used for title + closing slides */
--holo-lilac:       #E6E6FF;
--holo-mint:        #D8FEF3;
--holo-buttercream: #FFF6D8;
--holo-pink:        #FFC0FF;
--holo-periwinkle:  #98A5FF;
```

**Color rules:**

- Navy (`--plaid-ink-900`) is the dominant background.
- Mint (`--plaid-teal-500`) is the semantic "Plaid / better / action" color. Reserve it for the **one** thing on the slide you want the eye to land on.
- Cool blues are the brand voice; mint is the call-to-action voice.
- Don't invent new colors. For soft tints, use `rgba()` on the existing brand colors. Common patterns: `rgba(255,255,255,0.04)` (subtle card bg on dark), `rgba(66,240,205,0.14)` (mint accent card), `rgba(255,255,255,0.08–0.18)` (dividers/borders on dark).

### 1.4 Type scale (1920 × 1080)

```css
:root {
  --type-mega:     180px;   /* hero numbers (rare) */
  --type-display:  110px;   /* title cover, section starters */
  --type-title:    72px;    /* default slide titles */
  --type-subtitle: 48px;    /* large body / accent */
  --type-body:     30px;    /* slide body */
  --type-small:    24px;    /* secondary body / captions */
  --type-meta:     24px;    /* eyebrow / metadata (24px minimum) */
  --type-mono:     26px;    /* code blocks */
  --type-mono-sm:  22px;    /* dense code, only when needed */

  --pad-top:    100px;
  --pad-bottom: 88px;
  --pad-x:      120px;
}
```

**Type hard rules:**

- Body / eyebrow text minimum: **24px**. Below that, only decorative UI mockup chrome (avatar letters, confidence pills, status bars) inside mockup cards.
- Slide titles: 64–84px. Section starters 96–140px.
- Hero numbers: 140–200px in Bowery Street weight 500, letter-spacing −0.02 to −0.03em, line-height 0.9.

### 1.5 Background variants

Apply one class per `<section>`:

| Class | Background | Text | Use case |
|---|---|---|---|
| _none_ | navy `--plaid-ink-900` | white | Dominant — most content slides |
| `.light` | white | dark | Customer proof, light interludes |
| `.cream` | `#F4F0E6` | dark | Warm interludes (product mockups, "soft" stories) |
| `.holo` | soft holograph gradient | dark | Title, section dividers, closing slide |

```css
section.holo {
  color: var(--plaid-ink-900);
  background:
    radial-gradient(1200px 700px at 12% 18%, rgba(152,165,255,0.55), transparent 60%),
    radial-gradient(1100px 800px at 88% 82%, rgba(255,192,255,0.45), transparent 55%),
    radial-gradient(900px 600px at 78% 14%, rgba(255,246,216,0.55), transparent 60%),
    radial-gradient(900px 700px at 18% 82%, rgba(216,254,243,0.55), transparent 55%),
    linear-gradient(135deg, #E6E6FF 0%, #D8FEF3 50%, #FFF6D8 100%);
}
```

**Rhythm rule:** alternate background variants to create visual pacing. Don't run more than 4–5 navy slides in a row without a `.light` / `.cream` / `.holo` interlude.

### 1.6 The slide shell (every content slide)

```html
<section data-label="NN Short label">
  <div class="frame">
    <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="" />
    <div class="eyebrow-tag" style="margin-top:24px;">Section X — Section Name</div>

    <h2 class="h-title">
      Headline with <em>italicized accent.</em>
    </h2>

    <!-- slide body here -->

    <div class="chrome-foot">
      <span>NN / TOTAL &nbsp;·&nbsp; Section name</span>
    </div>
  </div>
</section>
```

**Shell CSS:**

```css
.frame {
  width: 100%; height: 100%;
  box-sizing: border-box;
  padding: var(--pad-top) var(--pad-x) var(--pad-bottom);
  display: flex; flex-direction: column;
  position: relative;
}
.chrome-logo {
  position: absolute;
  /* Top-right, 75px above the topmost text row (eyebrow / h-title). */
  top: calc(var(--pad-top) - 75px);
  right: var(--pad-x);
  height: 28px;
  width: auto;
  opacity: 0.85;
  z-index: 2;
}
.chrome-foot {
  position: relative;
  margin-top: auto;
  flex-shrink: 0;
  padding-top: 32px;
  display: flex; justify-content: space-between; align-items: baseline;
  font-family: var(--font-sans);
  font-size: 24px; font-weight: 500;
  color: rgba(255,255,255,0.45);
  letter-spacing: 0.04em;
}
.light .chrome-foot, .cream .chrome-foot, .holo .chrome-foot {
  color: rgba(2,37,68,0.55);
}
.eyebrow-tag {
  font-family: var(--font-sans);
  font-size: 24px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--plaid-teal-500);
  margin-bottom: 32px;
}
.light .eyebrow-tag, .cream .eyebrow-tag, .holo .eyebrow-tag {
  color: var(--plaid-blue-600);
}
.h-title {
  font-family: var(--font-sans);
  font-weight: 600;
  font-size: 72px;
  line-height: 1.08;
  letter-spacing: -0.018em;
  margin: 0 0 56px 0;
  max-width: 1500px;
}
```

Use `assets/logos/plaid-horizontal-dark.png` on `.light` / `.cream` / `.holo` slides.

### 1.7 The Bowery Street italic accent

Serif italic is a **rhetorical device**, not a style. Use it once per headline to punch the most quotable noun phrase:

```html
<h2 class="h-title">
  From bank data to
  <em style="font-family:var(--font-display); font-weight:400; font-style:italic;">financial intelligence.</em>
</h2>
```

Good candidates: *"for finance"*, *"actually act on"*, *"sharper insights"*, *"specific"*, *"really"*, *"converging"*, *"evolved with the model"*. Never twice in the same sentence.

### 1.8 Reusable card patterns

```css
/* Default card (on dark bg) */
.card-default {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 14px;
  padding: 30px 32px;
}

/* Accent card — "the best one in the set" */
.card-accent {
  background: linear-gradient(160deg, rgba(66,240,205,0.14), rgba(11,123,188,0.06));
  border: 1px solid rgba(66,240,205,0.3);
  border-radius: 14px;
  padding: 30px 32px;
}

/* Card on light bg */
.card-light {
  background: white;
  border-radius: 16px;
  padding: 36px 36px;
  box-shadow: 0 6px 20px rgba(2,37,68,0.06);
}

/* Frosted card for holo backgrounds */
.card-frosted {
  background: rgba(255,255,255,0.5);
  border: 1px solid rgba(2,37,68,0.08);
  backdrop-filter: blur(8px);
  border-radius: 16px;
  padding: 40px 36px;
}
```

---

**Continue to:** `DECK_TEMPLATES.md` (the template library) and `DECK_COMPOSITION.md` (writing & sequencing guide).
