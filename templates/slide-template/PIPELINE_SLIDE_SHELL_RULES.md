# Pipeline slide shell — merge rules (HTML + JSON panel)

## What this is

`pipeline-slide-shell.html` is the **canonical HTML reference** for Plaid-only **slide** steps (`sceneType: slide`, `.slide-root`) and the **global API JSON rail** (`#api-response-panel`). It complements prose rules in `SLIDE_RULES.md` with **copy-pasteable structure** so builds are layout-consistent.

**Design lineage:** Layout and density from production **2026-03-23-layer-v2**-family demos (including the “TD final” layered build) and subsequent **Auth / Identity / Signal** slide flows — dense multi-panel grids, optional Plaid wordmark in the header, footer strip (`plaid.com`), glass side JSON. This is **Plaid-only** deck polish; do **not** reuse bank/host branding or colors (see **Agent constraints** in `SLIDE_RULES.md`). Mobile shell provenance: `templates/mobile-layer-mock/layer-mobile-skeleton-from-2026-03-23-layer-v2.html`.

## Files

| File | Role |
|------|------|
| `pipeline-slide-shell.html` | Full HTML reference (open beside `slide.css` for local preview). |
| `slide.css` | Scoped slide + side-panel styles — embed **verbatim** in generated `<style>` (do not leak `html`/`body` slide theme to host steps). |
| `SLIDE_RULES.md` | Product, scene metadata, API storytelling, value-summary constraints. |
| `components.html` | Optional fragment snippets (header / hero / panel / callout / footer). |

## Merge into `scratch-app/index.html`

1. **Slide surface:** For each slide step, wrap content in `[data-testid="step-{id}"]` + `.slide-root` following the shell’s header / body / footer regions.
2. **Header:** Prefer the **logo + pill + endpoint** row from the shell (local `./plaid-logo-horizontal-white-text-transparent-background.png` when copied to scratch-app). Omit the `<img>` if the build omits that asset; keep pill + endpoint.
3. **Footer:** Keep `.slide-footer` with small Plaid mark + `plaid.com` (or equivalent) for deck-style closure on marketing slides.
4. **Do not** embed raw JSON inside `.slide-root` for endpoint steps — use `#api-response-panel` only.
5. **Remove** the standalone preview IIFE at the bottom of the shell script when merging (comment begins with `/* ── Standalone file preview only` … `*/`). That block exists so opening `pipeline-slide-shell.html` in a browser demonstrates **fully expanded** JSON with the panel visible. Production demos keep `collapsedByDefault: true` in `window.__API_PANEL_CONFIG` unless the prompt explicitly asks otherwise.

## JSON viewer (required)

- **Library:** `https://cdn.jsdelivr.net/npm/renderjson@1.4.0/renderjson.min.js` in `<head>` (CDN exception per DOM contract).
- **Expansion:** After `configureRenderjson()`, every render must show **all levels expanded**:
  - `renderjson.set_show_to_level('all')` **or** numeric `999` if `'all'` is unsupported in an older bundle.
- **Hydration:** Implement `window.updateApiResponse(data)` (or the pipeline’s `_showApiPanelStub` pattern) so it clears `#api-response-content`, appends `renderjson(data)`, and respects `__API_PANEL_CONFIG.collapsedByDefault` for panel visibility.

## API panel chrome — Show, Hide, and toggle (all required)

Persist **three** controls in `#api-response-panel .side-panel-header`:

| Control | `data-testid` | Behavior |
|---------|---------------|----------|
| Show JSON | `api-json-panel-show` | `display:flex` on `#api-response-panel` |
| Hide JSON | `api-json-panel-hide` | `display:none` on `#api-response-panel` |
| Toggle | `api-panel-toggle` | Same as Show/Hide combined (`toggleApiPanel`); label syncs to **Show JSON** / **Hide JSON** |

- Implement `window.toggleApiPanel()` for Playwright / dashboard parity.
- Keep button labels in sync (e.g. toggle reads **Show JSON** / **Hide JSON** based on visibility).
- `#link-events-panel` remains `display:none` for all demo-facing steps.

## `window.__API_PANEL_CONFIG`

Centralize behavior:

```javascript
window.__API_PANEL_CONFIG = Object.assign({
  collapsedByDefault: true,
  jsonExpandLevel: 'all',
  autoResize: true,
  minWidthPx: 360,
  maxWidthViewportRatio: 0.52
}, window.__API_PANEL_CONFIG || {});
```

- **`jsonExpandLevel`:** `'all'` preferred for fully expanded trees when the panel is opened.
- **`collapsedByDefault`:** `true` for recordings so the rail opens only when the story needs it.

## renderjson theming

Apply Plaid-aligned colors via CSS on `#api-response-content .renderjson …` in the same `<style>` block as `slide.css` (canonical rules live in `slide.css` in this folder).

## QA checklist

- [ ] Slide steps include responsive `.slide-root` (no fixed 1440×900 on root).
- [ ] `value-summary-slide` has **no** `apiResponse` and **no** JSON panel content.
- [ ] Endpoint slides: body summarizes 3–6 fields; raw JSON only in `#api-response-content`.
- [ ] All three panel controls present and wired; `toggleApiPanel` works.
- [ ] renderjson tree is **fully expanded** when the user opens the panel.
