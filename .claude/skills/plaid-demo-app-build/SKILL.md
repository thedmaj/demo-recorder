---
name: plaid-demo-app-build
description: >-
  Build-agent contract for generating the demo host app (scratch-app/index.html) in the Plaid
  demo pipeline. Use when authoring or fixing the host app HTML: the step/DOM contract, goToStep
  navigation, data-testid rules, the post-panels API panel + link-events contracts, manual
  keyboard/click navigation, the Plaid Link real-SDK recording architecture, Link event names,
  the Plaid.create callback pattern, /link/token/create products[] resolution, and the
  onSuccess callback panel. Load for the `build`, `build-qa`, `app-touchup`, and `post-panels`
  stages and any hand-edit of generated host steps.
---

# Plaid Demo App Build Contract (Mode A)

Every generated host app (`scratch-app/index.html`) MUST follow the contracts below. Slides
follow `plaid-slide-design` instead; voice/narration follows `saas-demo-design-principles`;
product-specific API shapes live in `inputs/products/*.md`.

## DOM contract (every generated app)

```html
<!-- Each step is a full-viewport div -->
<div data-testid="step-{id}" class="step">...</div>

<!-- Global navigation (Playwright calls this) -->
<script>
  window.goToStep = function(id) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.querySelector(`[data-testid="step-${id}"]`).classList.add('active');
    // Fire link events for this step
    if (window._stepLinkEvents && window._stepLinkEvents[id]) {
      window._stepLinkEvents[id].forEach(e => window.addLinkEvent(e.eventName, e.metadata));
    }
    // Update API response panel
    if (window._stepApiResponses && window._stepApiResponses[id]) {
      window.updateApiResponse(window._stepApiResponses[id]);
    }
  };
  window.getCurrentStep = function() {
    return document.querySelector('.step.active')?.dataset.testid;
  };
</script>

<!-- Side panels — DO NOT hand-author. post-panels emits the canonical Claude Design v12 API
     panel + developer-only link-events-panel. Leave this placeholder before </body>: -->
<!-- API_PANEL_AND_LINK_EVENTS — injected by post-panels post-build -->
```

- All interactive elements need `data-testid` in **kebab-case** matching the
  `interaction.target` field in `demo-script.json`.
- **CRITICAL — never add `display` to step inline styles.** Steps use `.step { display:none }`
  / `.step.active { display:block }`. A `style="display:flex"` on a `.step` permanently shows
  that step on ALL other steps.
- **CRITICAL — `data-testid` uniqueness.** Every `data-testid` is unique document-wide. When the
  same control repeats per step, suffix it: `api-sidebar-expand-btn-auth`,
  `…-identity`, `…-signal`. The Playwright recorder is strict-mode and errors on duplicates.

### First-step bootstrap (build-app injects this — do not remove)

`build-app.js` injects an idempotent `<script id="pipeline-first-step-bootstrap-v1">` before
`</body>` that activates the first `.step[data-testid]` on `DOMContentLoaded` if none is
`.active` — fixes the regression where the LLM emitted `class="step"` (no `active`) on step 1
→ blank first paint. No-op once the storyboard editor's `STORYBOARD_SET_STEP` bridge has set
`.active`.

## API panel — post-panels owns it (v12)

Do **not** hand-author a panel/toggle; post-panels strips and replaces it (`build-app.js`
delegates to `post-panels.buildPanelPatchScript()`). The emitted shell uses these stable IDs:

```html
<section class="panel" id="api-response-panel" data-testid="api-response-panel" aria-label="Plaid API reference" style="display:none">
  <button class="toggle" id="api-panel-toggle" data-testid="api-panel-toggle">…SVG chevron…</button>
  <header class="panel-head">
    <span class="eyebrow">Plaid API</span>
    <span class="method" id="api-panel-method">POST</span>
    <span class="path" id="api-panel-path">/auth/get</span>
    <div class="tabs"><button id="tab-req" data-tab="req">Request</button><button id="tab-res" data-tab="res">Response</button></div>
  </header>
  <div class="panel-toolbar">…</div>
  <div class="code-wrap">
    <pre class="code is-active" id="api-pane-request"  data-pane="req"></pre>
    <pre class="code"            id="api-pane-response" data-pane="res" hidden></pre>
  </div>
</section>
<div id="link-events-panel" data-testid="link-events-panel" style="display:none"></div>
```

- Default state `.panel.is-collapsed` (slides off-screen right; 48px chevron peek handle).
  build-qa's `prepareGlobalJsonRailForBuildQa` strips the collapsed class for screenshots.
- **Design spec (2026-06-02 default, owned by `post-panels.js` — do not override per-build):**
  panel **width `min(1080px, 92vw)`**; code/JSON `pre.code` **font-size 12px** (eyebrow & tabs
  12px, route 14px, method 9px); `__API_PANEL_CONFIG` defaults `collapsedByDefault:true`,
  `jsonExpandLevel:999`, `autoResize:true`, `minWidthPx:420`, `maxWidthViewportRatio:0.75`. The
  wide panel + 12px font exist so the expanded JSON reads **without horizontal scroll** —
  build-qa enforces this on slide-tier steps (`panel-horizontal-scroll` check; vertical scroll
  is fine). Bumping the patch version (`POST_PANELS_PATCH_VERSION`) forces these onto existing
  builds when post-panels re-runs.
- Legacy markup (`.side-panel*`, `.api-panel-edge-toggle`, `#api-response-content`,
  `#api-panel-endpoint`) is removed — do not emit it.
- **Do not style `.disclosure`** (renderjson toggles) beyond `color`/`cursor`; any
  `width`/`height`/`background` is a critical blocker (`scanRenderjsonDisclosureStyling`).
- **Panel is a fixed overlay (z-index 2100)** — never add `padding-right: 520px`,
  `max-width: calc(100% - 520px)`, or `body.api-panel-open` shrink rules on host steps or
  `.slide-root` (`scanPanelOverlayContract` blocker). Violations are auto-patched by
  `api-panel-toggle-latest` on the next run.

### onSuccess callback panel (v6+)

When the script has a `plaidPhase: "launch"` step, the **immediately following host step** is the
Link success page. post-panels auto-injects a "Plaid Link onSuccess (callback)" panel there **only
if** that step has no `apiResponse` of its own. Synthesized payload mirrors
`onSuccess(public_token, metadata)`:

```json
{
  "endpoint": "Plaid Link onSuccess (callback)",
  "response": {
    "public_token": "public-sandbox-<link_session_id>",
    "metadata": {
      "institution": { "name": "First Platypus Bank", "institution_id": "ins_109508" },
      "accounts": [
        { "id": "...", "name": "Plaid Checking", "mask": "0211", "type": "depository",
          "subtype": "checking", "verification_status": null, "class_type": null }
      ],
      "link_session_id": "...",
      "transfer_status": null
    }
  }
}
```

- Values parameterize from `demoScript.plaidSandboxConfig` (institutionId/Name, accountId/Name/
  Mask/Type/Subtype) when present.
- If the post-link step already declares an `apiResponse` (e.g. `POST /credit/bank_income/get`,
  `POST /identity/match`), the author's choice wins; synthesis is skipped. To show BOTH a Link
  callback beat AND a server call, insert a dedicated host step between them.
- Slide or another `link` step after launch → no panel injected.
- Implemented in `post-panels.synthesizeLinkOnSuccessResponse(demoScript)`.

## Manual navigation (REQUIRED in every app)

Add immediately after the `goToStep`/`getCurrentStep` definitions:

```javascript
// ── Manual navigation (arrow keys + click-to-advance) ───────────────────────
(function() {
  function _stepIds() {
    return Array.from(document.querySelectorAll('.step[data-testid]'))
      .map(s => s.dataset.testid.replace(/^step-/, ''));
  }
  function _navigate(delta) {
    var ids = _stepIds();
    var current = (window.getCurrentStep() || '').replace(/^step-/, '');
    var idx = ids.indexOf(current);
    var next = ids[Math.max(0, Math.min(ids.length - 1, idx + delta))];
    if (next && next !== current) window.goToStep(next);
  }
  document.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') _navigate(1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') _navigate(-1);
  });
  document.addEventListener('click', function(e) {
    if (e.target.closest('button, input, select, textarea, a, [role="button"], [role="link"]')) return;
    _navigate(1);
  });
})();
```

- Step background / card body / text areas advance on click; real controls (buttons, inputs,
  links) do their own thing and must NOT advance.
- Passive + event-driven — must not conflict with the Playwright automation flow.

## Plaid Link — real-SDK recording architecture

Recording uses `headless: false`, which captures cross-origin iframes (OOPIFs) via the GPU
compositor, so the **real** Plaid Link modal (`cdn.plaid.com`) **IS visible** in the video.
**Do NOT build simulated Plaid Link step divs** — the real SDK modal is the experience.

**Single real-SDK step:**
- The demo script has ONE Plaid Link step with `"plaidPhase": "launch"` — no sub-steps.
- Modal mode: a host button calls `window._plaidHandler.open()`. Embedded mode: launch starts
  from the in-page container mount/activation.
- The real SDK modal is an iframe over the host page for the whole flow; `record-local.js` uses
  CDP frameLocator to automate it (phone → OTP → institution → account).
- When `onSuccess` fires, the host app advances to the first post-link step.

**Build-agent rules (no-capture mode):**
- Do NOT build step divs for link-consent / link-otp / link-account-select / link-success / any
  Plaid screens.
- Modal mode only: include the Plaid Link button (`data-testid="link-external-account-btn"`)
  **inside the initiate-link step div**. Button onclick:
  `if (window._plaidHandler) window._plaidHandler.open();` — no `goToStep` call.
- Embedded mode: do NOT add "Connect Bank Account" / "Link Bank Account" launch CTAs; launch
  starts from embedded container activation. (Full UX: `skills/plaid-link-embedded-link-skill.md`.)
- `window._plaidLinkComplete = true` is set ONLY in `onSuccess` — NEVER in a goToStep handler.
- `onSuccess` stores `window._plaidInstitutionName` / `_plaidAccountName` / `_plaidAccountMask`;
  use these in post-link steps, never hardcode bank names. Pre-populate all post-link API
  responses with sandbox data.
- The initiate-link step in `demo-script.json` MUST have `"plaidPhase": "launch"`.
- Playwright entry (modal): ONE entry `action:"click"`,
  `target:"[data-testid=\"link-external-account-btn\"]"`, `waitMs: 120000`.
- Playwright entry (embedded): ONE entry `action:"goToStep"`, `target:"<launch-step-id>"`,
  `waitMs: 120000`. NEVER split into goToStep + click for the same launch step (duplicate
  `markStep`).

**demo-script structure:** single Plaid Link step (e.g. `"id":"wf-link-launch"`,
`"plaidPhase":"launch"`); narration covers the entire flow in ≤35 words
(consent → OTP → institution → account → success); duration 18–22s.

**Narration boundary (REQUIRED):** the step BEFORE the Link step ends with the trigger action
("…she taps Link Your Bank."); the Link step narration begins describing content VISIBLE INSIDE
the modal — never the act of opening it. Full rule + examples: `saas-demo-design-principles`.

**Recording behavior:** defaults to First Platypus Bank / Remember Me (non-OAuth); the "Save with
Plaid" phone screen is auto-dismissed. Saved-institution-list dwell + selection: see
`inputs/plaid-link-sandbox.md`.

## Recording nav script (`playwright-script.json`) — keep it in sync with `demo-script.json`

`record-local.js` records by iterating **`scratch-app/playwright-script.json`**, NOT
`demo-script.json`. That nav script is generated **once by `build-app`** (one row per step:
`{id, action, target, waitMs}` — `goToStep` for slide/host steps, `click` for the
`plaidPhase:"launch"` step). **Steps added or reordered AFTER build are invisible to the recorder
until the nav script is reconciled** — a slide inserted at index 0 of `demo-script.json` records
*last* or not at all (observed 2026-06-17: recorder logged "Loaded playwright-script.json: 9 steps"
and opened on the Plaid step, skipping the new index-0 slide).

**Application logic (already wired — don't bypass):**
- **`set-recording-dwells`** calls `reconcileRecordingScript(runDir)` before sizing dwells, so
  **every `record` run** first rebuilds the nav script in `demo-script.json` order (adds missing
  rows, prunes orphans, clears `dwellPlanAt`). This is the universal guarantee.
- The dashboard storyboard endpoints (`insert-step`, `insert-library-slide`, `remove-step`) sync
  the nav script immediately on edit.
- Helper: `scripts/scratch/utils/sync-recording-script.js` →
  `reconcileRecordingScript(runDir, { prune })`, `makeRecordingRowForStep(step)`.

**Agent-mode rule:** after editing `demo-script.json` steps + `post-slides` (or any hand edit that
adds/removes/reorders steps), **re-record from `--from=set-recording-dwells` or earlier — never
`--from=record`** (which skips the reconcile and records the stale step set). If you must run
`pipe stage record` directly, first run `pipe stage set-recording-dwells`, or call
`reconcileRecordingScript('<runDir>')` yourself. New slides also need their `.slide-root` built
(`post-slides`) and, when the run was already recorded, clear `post-record-freeze.sentinel` first.

## Plaid Link event names (use exactly — never invent)

```
OPEN, LAYER_READY, LAYER_NOT_AVAILABLE, SELECT_INSTITUTION, SELECT_BRAND,
SELECT_DEGRADED_INSTITUTION, ERROR, EXIT, HANDOFF, TRANSITION_VIEW,
SEARCH_INSTITUTION, SUBMIT_CREDENTIALS, SUBMIT_MFA,
BANK_INCOME_INSIGHTS_COMPLETED,
IDENTITY_VERIFICATION_START_STEP, IDENTITY_VERIFICATION_PASS_SESSION,
IDENTITY_VERIFICATION_FAIL_SESSION, IDENTITY_VERIFICATION_PENDING_REVIEW_SESSION,
IDENTITY_VERIFICATION_CREATE_SESSION
```

## Plaid.create callback pattern (always include)

```javascript
Plaid.create({
  token: '<link-token>',
  onSuccess: (public_token, metadata) => { /* token exchange */ },
  onExit: (err, metadata) => { /* handle close or error */ },
  onEvent: (eventName, metadata) => { /* all events incl. OPEN, HANDOFF */ }
});
```

## /link/token/create products[] — research-driven, never hardcoded

The `products[]` array is **resolved by the research stage**, never invented by the build LLM:

1. **Source of truth:** `link-token-create-config.json` (run dir), written by `research` via
   `scripts/scratch/utils/link-token-create-config.js` from the prompt, `requiredApiSignals`,
   AskBill, and `inputs/products/*.md`.
2. **Sanitization (in the resolver):** Layer 1 — `cra_base_report`/`cra_income_insights` cannot
   share a token with `income_verification` (CRA wins when `productFamily ∈ {cra_base_report,
   income_insights}`, else non-CRA Income wins). Layer 2 — `income_verification` only accepts
   `{income_verification, employment}`; anything else (`auth`, `identity`, `transactions`…) is
   dropped when `income_verification` is present.
3. **Backend authority:** `app-server.js`'s `/api/create-link-token` re-reads
   `link-token-create-config.json` from `PIPELINE_RUN_DIR` and uses its `products[]` over the HTML
   body; drift is logged.
4. **Build prompt contract:** generated HTML MUST use `linkTokenCreate.suggestedClientRequest`
   from research **verbatim** — never invent or "complete" a `products[]` list. (See the
   `## LINK TOKEN CREATE (dynamic — research-driven)` block in
   `scripts/scratch/utils/prompt-templates.js`.)
5. **Self-heal:** `qa-patch-library.js` ships `plaid-link-token-products-prune` for legacy apps;
   modern builds never need it.

Pure helpers (tests): `sanitizeProductsForLinkTokenMix` (link-token-create-config.js),
`resolveCreateLinkTokenProducts` / `loadResearchLinkTokenConfig` (app-server.js). Tests:
`tests/unit/link-token-create-config.test.js`, `tests/unit/app-server-link-token-resolution.test.js`.

## Update mode — "Reconnect bank" launches a REAL Plaid Link (never a host illustration)

When a beat depicts a lapsed connection (Item in `ITEM_LOGIN_REQUIRED`) and a **"Reconnect bank"**
action, the CTA MUST relaunch Plaid Link in **update mode** with the real SDK — do NOT fake it with
a host card/screenshot.

- **Token:** fetch from **`POST /api/create-update-link-token`** (app-server, backed by
  `plaid-backend.createUpdateModeLinkToken` + `resetLogin`). Body-less call is self-contained: it
  creates a Sandbox Item, forces `ITEM_LOGIN_REQUIRED` via `/sandbox/item/reset_login`, and returns
  an update-mode `link_token` (built from the existing `access_token`, **no `products[]`**).
- **Launch:** identical to a normal session — `Plaid.create({ token, onSuccess, onExit, onEvent })`
  then `handler.open()`. Reuse the `## Plaid.create callback pattern`.
- **onSuccess in update mode:** mark the connection repaired; **do NOT** call
  `/api/exchange-public-token` — the existing `access_token` stays valid. Recovery is confirmed by
  the `ITEM` / `LOGIN_REPAIRED` webhook (sandbox: re-auth `user_good` / `pass_good`).
- **Recording note:** this is a SECOND Link launch. Keep the PRIMARY connection as the single
  `plaidPhase:"launch"` recorded step; a reconnect/update-mode beat is a separate host-triggered
  launch (fine for non-recorded / build-qa runs). Full reference + sandbox testing:
  `inputs/plaid-link-sandbox.md` §8.

## Multi-item Link (OPT-IN) — onSuccess fires EMPTY

**Multi-item link is OPT-IN; standard single-item link is the default** — including for CRA. Enable
`enable_multi_item_link:true` ONLY when the prompt explicitly asks to connect **multiple institutions
in one session** (the link-token resolver detects that and sets the flag; or `CRA_MULTI_ITEM_LINK=true`).
Most demos connect one institution → standard link. **Never combine multi-item with `signal`** —
`signal` is not supported in the multi-item flow (Plaid 400s the token); the resolver + backend strip
it automatically when multi-item is on.

The rest of this section applies **only when multi-item is actually enabled**. Critical client
difference there: **`onSuccess` fires EMPTY** (no `public_token`). The app MUST NOT
require a public token to advance. Wire completion defensively:
- In `onSuccess` (may be empty): set `window._plaidLinkComplete = true` and `goToStep(firstPostLink)`.
- ALSO in `onEvent`: when `eventName === 'HANDOFF'`, set `window._plaidLinkComplete = true`
  (multi-item onSuccess can be empty/late; HANDOFF is the reliable session-end signal).
- Do NOT call `/api/exchange-public-token` with an empty token. Real token retrieval is server-side
  (`SESSION_FINISHED` / `ITEM_ADD_RESULT` webhooks, or `/link/token/get`) — out of scope for the
  recorded happy path, but never block the demo waiting for a client-side public token.

Not compatible with Embedded Institution Search, Same-Day/Instant Micro-deposits, or Database Auth.
Full reference: `inputs/plaid-link-sandbox.md` §9.

## Identity Verification (IDV) launch wiring — DISTINCT endpoint / flag / CTA

An IDV `plaidPhase:"launch"` step is **NOT a bank-link launch**. It uses the real Plaid Link SDK
the same way, but every glue identifier diverges from the bank-link contract above. Wiring an IDV
step like a bank link is the #1 cause of a broken IDV demo (404 on the token call, or a launch that
never completes). Use this contract verbatim; full facts in
[`inputs/products/plaid-identity-verification.md`](../../inputs/products/plaid-identity-verification.md).

| Concern | Bank link | **IDV** |
|---|---|---|
| Token endpoint | `POST /api/create-link-token` | **`POST /api/create-idv-link-token`** |
| Launch CTA | `data-testid="link-external-account-btn"` | **`data-testid="idv-launch-btn"`** (or `onclick="launchIdv()"`) |
| Completion flag (set in `onSuccess` ONLY) | `window._plaidLinkComplete` | **`window._idvComplete`** |
| `products[]` | research-driven | **`["identity_verification"]` only** (mutually exclusive — never mixed) |
| `onSuccess` payload | `public_token` present | **`public_token` is `null`** — onSuccess = *submitted*, not *passed* |

- **Token fetch:** `fetch('/api/create-idv-link-token', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ client_user_id, client_name }) })`.
  Do **NOT** send `template_id` from the client — the backend resolves it from
  `IDV_TEMPLATE_IDENTITY_BANK_OPTIONAL` / `PLAID_IDV_TEMPLATE_ID` and adds `gave_consent:true`. Do
  NOT call `/api/create-link-token` for IDV (it builds a bank token, not an IDV token).
- **Launch handler** (`launchIdv()`): fetch the token → `Plaid.create({ token, onSuccess, onExit, onEvent })`
  → `handler.open()`. Same SDK, same callback shape as the bank launch.
- **Completion:** in `onSuccess(public_token, metadata)` set `window._idvComplete = true` and
  `goToStep(firstPostIdvStep)` — NEVER set the flag in a `goToStep` handler. `public_token` is
  `null`; do NOT call `/api/exchange-public-token`. The session id arrives in `metadata` (and the
  `IDENTITY_VERIFICATION_*` `onEvent` names above).
- **Verdict (behind-the-scenes only):** retrieve via `POST /api/identity-verification-get`
  (`{ identity_verification_id }`). Pass/fail is decided by `/identity_verification/get` after the
  `STATUS_UPDATED` webhook — never inferred from `onSuccess`. Surface the verdict in slides / the
  JSON panel / a clearly-labeled Underwriter Internal view; the host happy path shows `success` /
  `pending_review`, never `failed` or raw API errors.
- **Recording:** `record-local.js` (`executeLayerOrIdvLaunch`) clicks `[data-testid="idv-launch-btn"]`
  / `button[onclick*="launchIdv"]`, verifies the live modal loads, then waits on `_idvComplete`.
- **Multi-launch:** IDV is a distinct launch product — a demo may have an IDV launch step AND a
  separate bank/Layer/CRA launch step (each its own `plaidPhase:"launch"`). Wire each with ITS OWN
  endpoint + completion flag; never share `_plaidLinkComplete`/`_idvComplete` across products.

## Related skills / references

- Embedded Link UX: `skills/plaid-link-embedded-link-skill.md`
- Pre-link host UI: `skills/plaid-link-prelink-ui-skill.md`
- Sandbox credentials / institutions / recording dwell: `inputs/plaid-link-sandbox.md`
- Product API shapes & gotchas: `inputs/products/*.md`
- Slides: `plaid-slide-design`; Pipeline CLI / recovery: `pipeline-cli`
