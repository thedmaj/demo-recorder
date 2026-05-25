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

Read [`.claude/skills/tosea-slide-workhorse/references/layouts.md`](../../tosea-slide-workhorse/references/layouts.md) and the matching `templates/single-page/<name>.html` for structure **only** — never copy Workhorse `<link>` tags, themes, or `runtime.js`.

| Narrative job | Workhorse layout | Set `data-workhorse-layout` | Nearest `data-slide-template` (QA metadata) |
|---------------|------------------|----------------------------|---------------------------------------------|
| Opening / title | `cover` | `cover` | T1 |
| Section break | `section-divider` | `section-divider` | T2 |
| One idea + body | `bullets`, `two-column` | same | T3 |
| Three pillars | `three-column` | `three-column` | T5 |
| Hero metrics | `stat-highlight`, `kpi-grid` | same | T4 |
| Before / after | `comparison`, `pros-cons` | same | T6 / T7 |
| Process / flow | `process-steps`, `flow-diagram` | same | T8 |
| Architecture | `arch-diagram`, `mindmap` | same | T9 |
| Proof / quote | `big-quote`, `table` | same | T10 |
| Close / CTA | `cta`, `thanks`, `roadmap` | same | T11 |
| API / code insight | `code`, `diff`, `terminal` | same | T3 (+ mono) |
| Timeline / plan | `timeline`, `gantt` | same | T8 |

Pick the layout that best conveys the step's **value prop and product understanding**, then wrap in Plaid shell.

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
      <div class="chrome-foot"><span>03 / 12 · Section</span></div>
    </div>
  </div>
</div>
```

- **T1** may omit eyebrow/footer per DECK_TEMPLATES.
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
| **Canvas** | 1280×800 via `pipeline-slide-contract.css` — not 100vw Workhorse deck |
| **Typography** | Plaid ceilings in `pipeline-slide-contract.css`; body **≥ 24px** |
| **Host bleed** | Slides Plaid-only; customer name is partnership copy only |

## Forbidden in pipeline `.slide-root`

- Workhorse theme CSS, CDN webfonts from html-ppt
- `runtime.js`, theme cycling, presenter mode hooks
- `display: inline-block` (flex/grid + gap only)
- Chart.js / highlight.js CDNs
- Customer brand colors or fonts
- JSON panel inside slide (use global `#api-response-panel`)

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
3. **`--canvas pipeline`** (1280x800) is the default; use `--canvas authoring` (1920x1080) for browser/PDF presentations
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
