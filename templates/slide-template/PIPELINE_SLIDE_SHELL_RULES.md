# Pipeline slide shell — Plaid Deck Design System (2026)

## What this is

Pipeline-generated **slide** steps (`sceneType: "slide"`, `.slide-root`) follow the **Plaid Deck Design System** in `brand-design-briefs/`. This file is the merge contract for build agents and `post-slides.js`.

**Historical rules:** `PIPELINE_SLIDE_SHELL_RULES.archive.md` (TD / layered-demo lineage). **Do not** use the old `.slide-header` / `.slide-panels` shell for new runs.

**Frozen runs:** Existing `out/demos/*` runs keep their prior slide HTML. Only **new** pipeline runs adopt this system.

## Files (load order)

| File | Role |
|------|------|
| `colors_and_type.css` | Design tokens + `@font-face` (Plaid Sans, Bowery Street) |
| `slide.css` | Pipeline-scoped shell (`.frame`, chrome, cards, backgrounds) |
| `pipeline-slide-shell.html` | Canonical **T3 Statement** reference |
| `brand-design-briefs/DECK_DESIGN_SYSTEM.md` | Foundations (tokens, shell, cards) |
| `brand-design-briefs/DECK_TEMPLATES.md` | T1–T11 skeletons — pick **exactly one** per slide |
| `brand-design-briefs/DECK_COMPOSITION.md` | Headlines, pacing, background rhythm |
| `fonts/*.otf` | Bundled into `scratch-app/fonts/` per build |
| `assets/logos/*.png` | Bundled into `scratch-app/assets/logos/` |

## DOM contract (required)

```html
<div data-testid="step-{id}" class="step">
  <div class="slide-root" data-slide-template="T3">
    <!-- optional background class on .slide-root: light | cream | holo -->
    <div class="frame">
      <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="" />
      <div class="eyebrow-tag">Section X — Name</div>
      <h2 class="h-title">Headline with <em>italic accent.</em></h2>
      <!-- template body (T1–T11) -->
      <div class="chrome-foot"><span>NN / TOTAL · Section</span></div>
    </div>
  </div>
</div>
```

- Set `data-slide-template="T1"` … `T11` on `.slide-root` for audit (`post-slides-report.json` → `templatesUsed`).
- Logo variant: `plaid-horizontal-white.png` on navy default; `plaid-horizontal-dark.png` on `.light` / `.cream` / `.holo`; `plaid-horizontal-holograph.png` optional on holo.
- **Plaid logo — hard contract (build-QA blocker):** Never invent a logo. Do **not** draw SVG marks, four-dot icon grids, rounded-square icons, or render the word "PLAID" as HTML/CSS text. Use **only** the bundled horizontal wordmarks under `assets/logos/` via `<img class="chrome-logo" src="assets/logos/plaid-horizontal-*.png" alt="">`, **or omit** `.chrome-logo` entirely (T1 title slides may omit chrome). Do **not** use `plaid-icon-white.png` or legacy `plaid-logo-*` paths in slide chrome.
- **Never** use `display: inline-block` inside `.slide-root` — flex/grid + `gap` only.
- Body text **≥ 24px** (mockup chrome excepted — see build-QA allowlist).
- **Typography ceilings:** `.h-title` max **72px** (T3 **96px**, T1 **140px**); `.hero-stat-value` max **180px**; body max **36px**. Prefer `slide.css` classes — post-slides runs `normalize-slide-typography.js` to cap LLM oversizing.
- Wrap slide body in `.slide-stack` so `.chrome-foot` (flex `margin-top: auto`) does not overlap content.

## Composition (required)

From `DECK_COMPOSITION.md`:

- Headlines: **sentence case**, end with a **period**, one **`<em>` Bowery Street italic** accent per `.h-title`.
- **One mint moment** per slide (`--plaid-teal-500` / `#42F0CD` as the primary eye-draw).
- Background rhythm: no more than **4 consecutive navy** slides without `.light` / `.cream` / `.holo`.
- Approved palette only; soft tints via `rgba()` on brand tokens.

## PPTX export font swap (documented, not automated)

When exporting to PowerPoint: **Manrope** (sans), **Playfair Display** (display), **JetBrains Mono** (mono).

## JSON panel (overlay invariant)

- `renderjson` CDN in `<head>`; `window.updateApiResponse`; single edge toggle `data-testid="api-panel-toggle"`.
- Raw JSON **only** in `#api-response-panel`, not inside `.slide-root`.
- **Always collapsed by default** on step navigation (48px edge chrome). Expand-on-click is a **transient fixed overlay** (z-index 2100) — slides and host UI **never reserve space** for the panel.
- `value-summary-slide`: no `apiResponse`, no JSON panel content.

## Build-QA

Nine slide-design scanners in `build-qa.js` (`scanSlideDesignSystem`):

- **`scanSlidePlaidLogoAuthenticity`** — **critical / deterministic blocker**. Flags invented logos and non-library `chrome-logo` src paths. Omitting `.chrome-logo` is allowed.
- **Eight warning scanners** — tokens, shell chrome, 24px floor, italic accent, mint overuse, inline-block, background rhythm, invented colors (`severity: 'warning'`, not blockers).

See `CLAUDE.md` § Plaid Slide Design System.

## Opt-in patches

`qa-patch-library.js`: `slide-design-tokens-inject`, `slide-shell-chrome-inject`, `slide-chrome-logo-canonical`, `slide-typography-floor` — manual invoke only.
