# Slide Template Rules (Plaid-only)

## Canonical HTML shell (required reference)
- Use **`pipeline-slide-shell.html`** as the structural source of truth for slide steps (`.slide-root` regions) **and** the global `#api-response-panel` chrome (Show JSON, Hide JSON, `api-panel-toggle`).
- Merge / adaptation rules live in **`PIPELINE_SLIDE_SHELL_RULES.md`**.
- `base.html` and `components.html` remain optional shortcuts; they do not replace the full shell for new builds.

## Purpose
Slides are a supplement to PowerPoint in presentations. They must be visually consistent across pipeline runs and should be directly readable in both remote calls and in-person rooms.

## Slides vs Plaid insight screens (do not conflate)
- **Slides** (`.slide-root`): optional steps that explain **behind-the-scenes** API calls and data in a **Plaid-only** deck style. Use for technical storytelling, not for the bank’s consumer UI.
- **Plaid insight steps** (e.g. `identity-match-insight`, `auth-insight`): full-viewport **product insight** layouts in the demo flow. They use the DOM contract (dark insight chrome + **global** `#api-response-panel` for JSON). They are **not** slides unless you intentionally wrap content in `.slide-root`.
- **Host bank app** (dashboard, transfers, Link host page): uses **Brandfetch-derived** tokens from `brand/<slug>.json` — never the slide template’s Plaid gradient as the full-page background.

## Scene metadata contract (required for alignment)
- Every `demo-script.json` step should include `sceneType`:
  - `host` for customer-branded host UI steps
  - `link` for the single Plaid Link launch step (`plaidPhase: "launch"`)
  - `insight` for full-viewport Plaid insight steps using global `#api-response-panel`
  - `slide` only for true template slides that render `.slide-root`
- QA and build checks should use `sceneType` as the source of truth. Do not infer slide-vs-insight only from prose like "slide" in `visualState`.
- If `sceneType` is `insight`, do **not** require `.slide-root`.
- If `sceneType` is `slide`, `.slide-root` is required.

## Key principles
1. **Plaid-only styling**: use Plaid design-system tokens from `CLAUDE.md` (dark navy background, Plaid teal accent `#00A67E`, white primary text).
2. **Stable type scale**: never “random” font sizes. Match:
   - slide title: large, bold (recommended 40–48px)
   - subtitle/body: 14–18px range with max line length ~55–65ch
   - endpoint text: mono font
3. **Safe area / crops**: maintain consistent padding so content is not clipped by projector overscan.
4. **Consistency over novelty**: match one of the existing panel patterns (hero + panels + optional callout).

## Required structure (HTML contract)
When generating a slide step, match **`pipeline-slide-shell.html`** (not only prose here). In summary:
- `.slide-root` as the full surface container
- `.slide-header` with:
  - optional `.slide-header-logo` (Plaid wordmark; same asset path pattern as the shell — omit the `<img>` if the asset is not copied)
  - `.slide-header-pill` containing `PLAID`
  - `.slide-header-endpoint` containing the endpoint being described (e.g. `POST /auth/get`)
- `.slide-body` containing:
  - `.slide-hero` with `.slide-title` and optional `.slide-subtitle`
  - optional `.slide-panels` with one or more `.slide-panel`
  - optional `.slide-callout`
- `.slide-footer` (recommended for deck-style closure): small Plaid mark + `.slide-footer-meta` (e.g. `plaid.com`), as in the shell

## API JSON panel contract (required for endpoint storytelling only)
- Raw Plaid API payloads must use the global JSON rail only:
  - `#api-response-panel`
  - `#api-response-content` inside `.side-panel-body`
- Do not create duplicate raw JSON containers inside slide layouts (no inline `*-json-panel`, no right-column raw payload blocks in `.slide-root`).
- JSON panel eligibility is endpoint-driven: only steps with explicit `apiResponse.endpoint` in `demo-script.json` may use/show JSON panel content.
- For endpoint steps with `apiResponse`, wire panel updates through the shared step contract (`goToStep` + `window._stepApiResponses`), not ad hoc per-step display logic.
- Default behavior: `#api-response-panel` is hidden/collapsed on initial page load (`display:none`).
- Persist **three** panel controls in the header: `data-testid="api-json-panel-show"`, `data-testid="api-json-panel-hide"`, and `data-testid="api-panel-toggle"` (toggle must call `window.toggleApiPanel()` for Playwright parity).
- On API-relevant insight/slide steps, hydrate payload data but keep panel collapsed until toggled open (unless the prompt says otherwise).
- When opened, render JSON **fully expanded** by default via renderjson (`set_show_to_level('all')` or equivalent deep level — no collapsed nested payload by default).
- Use a global runtime config constant for all builds (for example `window.__API_PANEL_CONFIG`) to centralize:
  - collapsed-by-default behavior
  - JSON expansion level
  - dynamic side-panel auto-resize
- Ensure expanded JSON does not bleed off page:
  - `.side-panel-body` supports both vertical and horizontal scrolling
  - panel width can resize dynamically within viewport bounds
- `.side-panel-body` must be vertically scrollable for long payloads (`overflow-y:auto`) so large responses remain readable.
- Use `renderjson` for API payload rendering:
  - `<script src="https://cdn.jsdelivr.net/npm/renderjson@1.4.0/renderjson.min.js"></script>`
  - apply Plaid-aligned colors via `slide.css` (`#api-response-content .renderjson …`) embedded with the slide styles (no ad-hoc one-off JSON panel styling patches).
- `#link-events-panel` is a developer artifact and must remain hidden during demo-facing flows.

## Value summary slide rule (required)
- `value-summary-slide` is narrative-only and must stay responsive like other template slides.
- Do **not** include `apiResponse` on `value-summary-slide`.
- Do **not** include JSON code/pre blocks or JSON side-panel content on `value-summary-slide`.
- Keep `value-summary-slide` focused on heading, value bullets, and CTA only.

## Story-first data highlighting (required)
- Slide body explains business meaning; JSON panel is canonical raw evidence.
- Every API storytelling slide should highlight 3-6 high-signal fields from the response that support the narrative outcome.
- Keep highlights product-contextual and decision-oriented. Examples:
  - Plaid Signal: return-risk score, top fraud/risk drivers, recommendation outcome.
  - CRA Income Insights: income streams, historical/forecast summary, predicted next payment.
  - Identity Match / verification: match score, pass threshold, status used to keep good users on the happy path.
- Avoid dumping full payload text in body copy. Summarize only the fields that change the decision or customer outcome.
- Keep API request/response semantics aligned with the slide claim:
  - endpoint shown in slide and API panel must match the step narrative (for example, income-insights slide must use income-insights endpoint/fields).
  - highlighted attributes must be present in the response JSON for that step.

## User-facing UI guardrail (required)
- Keep **presentation-style stats** (model scores, risk tiers, "ACCEPT"/"LOW RISK" badges, coverage percentages, internal confidence metrics) in Plaid insight slides or presenter context only.
- Do **not** place these internal metrics in customer-facing host app screens unless they provide clear user value and explicit user action.
- Host UI should prioritize user-understandable outcomes:
  - good: "Transfer posted", "Account verified", "Funding complete", "Next step"
  - avoid in host UI: "Identity score 99/100", "Signal score 12", "97%+ coverage", "LOW RISK"
- If a metric is shown in host UI, include plain-language justification tied to user benefit (for example, why the user should care or what action to take).

## Agent constraints
- Do **not** use host-app branding (no TD shell layout, no TD colors).
- Do **not** invent new layout patterns for every slide; reuse `.slide-panel` and `.slide-callout`.
- Slides should avoid heavy tables; if data must be shown, prefer a panel with 3–6 short bullets.

## Layout — responsive surface
- `.slide-root` uses **fluid width/height**: `width: 100%` with `max-width: min(1440px, 100vw)`, **`aspect-ratio: 16 / 10`**, and `max-height: min(900px, 100vh, 100dvh)` so slides scale down on smaller windows while matching the **1440×900** recording frame when space allows.
- Do **not** set fixed `width: 1440px; height: 900px` on `.slide-root` — the template CSS already handles caps.
- Inside a `.step`, let `.slide-root` fill the step (`width: 100%`); the step viewport still targets 1440×900 for Playwright.

## Presentation checklist
- Ensure all text remains legible at 125% zoom.
- Keep paragraphs short: prefer 1–2 sentences per block.
- Use accents only for emphasis (badges, callouts, endpoints).

