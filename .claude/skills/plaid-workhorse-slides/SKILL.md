---
name: plaid-workhorse-slides
description: >-
  Hybrid slide authoring for the demo pipeline and standalone exports: Workhorse
  (html-ppt) layout patterns inside Plaid Deck Design System branding. Use when
  post-slides, slide-fix, or agents generate `.slide-root` HTML — pick the best
  Workhorse layout for the narrative, always apply Plaid colors, fonts, and chrome.
  Loads with plaid-slide-design; never use Workhorse themes or host brand colors.
---

# Plaid × Workhorse slides (pipeline integration)

**Layout intelligence:** [`.claude/skills/tosea-slide-workhorse/`](../../tosea-slide-workhorse/) (Tier A html-ppt — layout catalog + single-page templates).

**Brand authority (always wins):** [`.claude/skills/plaid-slide-design/SKILL.md`](../plaid-slide-design/SKILL.md) + `templates/slide-template/brand-design-briefs/`.

## Priority stack (conflicts)

1. **Plaid brand** — colors, fonts, logos, chrome, build-QA blockers
2. **Pipeline DOM** — `.step` → `.slide-root` → `.frame` + chrome (not Workhorse `.deck`/`.slide`)
3. **Workhorse layout** — grid structure, information architecture, which pattern fits the beat
4. **Standalone extras** — only outside pipeline (see below)

## When to load

- `post-slides` / `slide-fix` LLM calls (injected via `slide-design-skill.js`)
- Claude Code or Cursor agents editing `.slide-root` in `scratch-app/index.html`
- Authoring standalone Plaid-branded HTML decks (export path)

## Layout selection (agent decides at runtime)

> **Authoritative intent → template map lives in [`plaid-slide-design/SKILL.md` § Template selection](../plaid-slide-design/SKILL.md#template-selection).** In the pipeline, the script tags each slide with a `slideRole` and `slide-template-router.js` picks the template — prefer that over hand-picking. The table below is the layout-mechanics view (narrative job → Workhorse layout → nearest T#); keep it consistent with the slide-design map.

Read [`.claude/skills/tosea-slide-workhorse/references/layouts.md`](../../tosea-slide-workhorse/references/layouts.md), the matching `templates/single-page/<name>.html` for structure **only** (never copy Workhorse themes/runtime), and the **20-template showcase catalog** in `templates/slide-template/brand-design-briefs/WORKHORSE_TEMPLATE_CATALOG.md` (sourced from `tmp-showcase/index.html`).

| Narrative job | Workhorse layout | Set `data-workhorse-layout` | Nearest `data-slide-template` | Showcase # |
|---------------|------------------|----------------------------|------------------------------|------------|
| Opening / title | `cover` | `cover` | T1 | 01 Title Hero |
| Section break | `section-divider` | `section-divider` | T2 | 02 Section Beat |
| One idea + body | `bullets`, `two-column` | same | T3 | 03 Statement / 04 Bullets |
| Three pillars | `three-column` | `three-column` | T5 | 05 Three Pillars |
| Hero metrics | `stat-highlight`, `kpi-grid` | same | T4 | 07 Triple Stat / 08 KPI Grid |
| API field read-out | `field-table` | `field-table` | T7 | API Field Table |
| Tabular data | `table` | `table` | T7 | 09 Data Table |
| Chart insight | `chart-bar` | `chart-bar` | T4 | 10 Bar Chart (SVG only) |
| Before / after | `comparison` | `comparison` | T6 / T7 | 11 Before/After / 12 Old vs New |
| Process / flow | `process-steps`, `flow-diagram` | same | T8 | 13 Step Flow / 14 Flow Diagram |
| Architecture | `arch-diagram` | `arch-diagram` | T9 | 15 Architecture Map |
| Timeline / plan | `timeline`, `roadmap` | same | T8 / T11 | 16 Timeline / 17 Roadmap |
| Proof / quote | `big-quote`, `customer-proof` | same | T3 / T10 | 06 Pull Quote / 18 Proof Quote |
| Close / CTA | `cta` | `cta` | T11 | 20 Action Cards |
| API / code insight | `code`, `diff`, `terminal` | same | T3 (+ mono) | 19 Code Window |

Pick the layout that best conveys the step's **value prop and product understanding**, then wrap in Plaid shell.

## Chrome logo (production — not showcase preview)

`tmp-showcase/index.html` scales `.chrome-logo` to ~140px for gallery readability. **Pipeline slides use 28px** at **top-right**, **75px above the topmost text row**:

```css
.slide-root .chrome-logo {
  position: absolute;
  top: calc(var(--pad-top) - 75px);
  right: var(--pad-x);
  height: 28px;
  width: auto;
  opacity: 0.85;
}
```

- Never inline `left:` or oversized `height:` on `.chrome-logo` — build-QA `scanSlideChromeLogoPlacement` is a **critical blocker**.
- Logo variant: `plaid-horizontal-white.png` (navy), `-dark.png` (light/cream/holo), `-holograph.png` (holo).
- T1 may omit `.chrome-logo`.

## Required pipeline DOM

```html
<div data-testid="step-{id}" class="step">
  <div class="slide-root" data-slide-template="T4" data-workhorse-layout="kpi-grid">
    <div class="frame">
      <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="">
      <div class="eyebrow-tag">Section label</div>
      <div class="slide-stack">
        <!-- Workhorse grid/cards/diagram markup here — Plaid tokens only -->
      </div>
    </div>
  </div>
</div>
```

- **T1** may omit eyebrow per DECK_TEMPLATES. Pipeline slides omit `.chrome-foot`.
- Set **both** `data-slide-template` (nearest T#) and `data-workhorse-layout` (actual pattern).

## Token bridge (mandatory — no Workhorse themes)

Never link `assets/themes/*.css`, `fonts.css` (Inter/Playfair), or `runtime.js` inside pipeline slides.

| Workhorse token | Use Plaid instead |
|-----------------|-------------------|
| `--bg`, `--surface` | `--plaid-ink-900` or `.slide-root.light` / `.cream` / `.holo` |
| `--text-1` | `#E8E4D8` on navy; `--plaid-ink-900` on light |
| `--text-2`, `--text-3` | `rgba(255,255,255,0.74)` / `0.54` on navy |
| `--accent`, `--grad` | `--plaid-teal-500` — **one mint moment per slide** |
| `--good` / `--warn` / `--bad` | `--success-solid`, `--warning-bg`, `--error-solid` |
| `--font-sans` | `"Plaid Sans", …` |
| Bowery accent | exactly one `<em>` in `.h-title` |
| `--font-mono` | `var(--font-mono)` |

Use `var(--plaid-teal-500)` not `#42F0CD` literals when possible. No customer/host hex inside `.slide-root`.

## Pipeline constraints (user decisions)

| Topic | Rule |
|-------|------|
| **Scope** | Pipeline slides + optional standalone export |
| **Motion** | **None** in pipeline — no `data-anim`, no `data-fx`, no canvas FX |
| **Charts** | **SVG/CSS only** — do not use Chart.js; rebuild `chart-*` layouts as inline SVG |
| **Canvas** | Fluid ≈1400×875 via `pipeline-slide-contract.css` (`max-width: min(1400px, calc(100vw − 24px))`, 16/10) at the 1440×900 recording viewport — not 100vw Workhorse deck, and NOT the old 1280×800 letterbox (retired 2026-05-29). 1280×800 survives only as the **standalone-export** default profile. |
| **Typography** | Templates own sizing (`slide.css` + `pipeline-slide-contract.css` canonical classes). No 24px floor / per-template ceiling enforcement — reduce a specific element deliberately if content demands it, and stay readable. (Canonical rule: `plaid-slide-design` § Typography.) |
| **Host bleed** | Slides Plaid-only; customer name is partnership copy only |
| **Sales CTAs** | **Forbidden** on pipeline slides — no contact Plaid / Account Manager / free trial / Start a POC / retro-analysis buttons or faux CTAs (see plaid-slide-design SKILL) |

### Layout pitfalls (from slide QA)

- **Code Window (`data-workhorse-layout="code"`)** → `.slide-stack.sc-code-split`: `.sc-code-copy` (headline + body) **left**, `.slide-code-block.sc-code-pane` + `pre.sc-code-pre` **right**. Do not stack `pre` under the title — the right column uses full slide height for 10–15 lines.
- **Two-stat peer benchmarks** → `stat-highlight` (T4), not `data-table` (T7).
- **Hero metrics** → one `.hero-stat-value` mint moment; do not bury the narration’s lead stat in a small grid cell.
- **No footers** — pipeline slides omit `.chrome-foot`; put partnership labels in `.eyebrow-tag`.

## Forbidden in pipeline `.slide-root`

- Workhorse theme CSS, CDN webfonts from html-ppt
- `runtime.js`, theme cycling, presenter mode hooks
- `display: inline-block` (flex/grid + gap only)
- Chart.js / highlight.js CDNs
- Customer brand colors or fonts
- JSON panel inside slide (use global `#api-response-panel`)
- **Sales CTAs** — contact Plaid, contact Account Manager, start a free trial, Start a POC, perform a retro analysis (buttons or prominent action lines)

## Standalone export (outside scratch-app)

When the user wants a **standalone** HTML deck (not a pipeline step), use the project script:

```bash
./scripts/export-plaid-deck.sh \
  --manifest decks/my-deck.json \
  --out dist/my-deck.html
  # optional: --canvas authoring  (1920x1080 instead of 1280x800)
  # optional: --nav keyboard      (arrow-key navigation)
```

The script (`scripts/scratch/utils/export-plaid-deck.js`) reads a manifest of the form:

```json
{
  "title": "Plaid Q2 Roadmap",
  "slides": [
    {
      "id": "cover",
      "template": "T1",
      "workhorseLayout": "cover",
      "background": "holo",
      "sourceHtml": "<div class=\"frame\">...</div>"
    }
  ]
}
```

and assembles a single self-contained HTML file with `colors_and_type.css`, `slide.css`, and `pipeline-slide-contract.css` inlined; Plaid fonts and logos are copied next to the output. The exporter detects Workhorse leak patterns (themes / runtime / Chart.js / motion attrs) in `sourceHtml` and logs warnings but does not block — standalone exports are slightly looser than pipeline recordings.

Rules:

1. Reuse the same `.slide-stack` inner markup and Plaid tokens
2. **Static by default** (`--nav static`); pass `--nav keyboard` only if explicitly requested
3. **`--canvas pipeline`** (1280x800) is the default **for standalone exports only** — despite the flag name, this is NOT the recorded pipeline canvas (that is fluid ≈1400×875 via the contract CSS); use `--canvas authoring` (1920x1080) for browser/PDF presentations
4. Do **not** import Workhorse themes; Plaid palette only

## Authoring workflow

1. Read step narration + `visualState` + API endpoint (if insight slide).
2. Choose Workhorse layout from table above.
3. Open `.claude/skills/tosea-slide-workhorse/templates/single-page/<layout>.html` — copy **grid structure only**.
4. Map all colors/fonts through token bridge; wrap in Plaid shell.
5. Verify: one mint moment, one Bowery `<em>`, bundled logo or omit on T1, no host hex.

## Companion skills

| Skill | Path |
|-------|------|
| Workhorse layouts (canonical assets) | `.claude/skills/tosea-slide-workhorse/` |
| Plaid brand + QA | `.claude/skills/plaid-slide-design/SKILL.md` |
| Cursor mirror | `.cursor/skills/plaid-workhorse-slides/SKILL.md` |

Pipeline loader: `scripts/scratch/utils/slide-design-skill.js`
