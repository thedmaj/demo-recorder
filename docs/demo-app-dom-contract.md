# Demo App DOM Contract (Mode A)

Every generated host app MUST follow this contract. Referenced from `CLAUDE.md` § Demo App DOM Contract.

## Step container + global navigation

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
```

## Side panels — HIDDEN by default

- `link-events-panel` MUST be hidden by default (`display:none`) — never visible in recordings; developer artifact only.
- `api-response-panel` MUST be hidden by default (`display:none`). On insight steps, show panel chrome with JSON body collapsed (`class api-json-collapsed` on `#api-response-panel` hides `.side-panel-body` until toggle).

```html
<div id="link-events-panel" data-testid="link-events-panel" class="side-panel" style="display:none">...</div>
<div id="api-response-panel" data-testid="api-response-panel" class="side-panel" style="display:none">...</div>
```

All interactive elements must have `data-testid` attributes in kebab-case matching the `interaction.target` field in `demo-script.json`.

## JSON Panel Toggle & Overlay Contract (REQUIRED)

`post-panels` owns the API panel toggle — **do not hand-author a different toggle in generated HTML**; it will be stripped and replaced. `build-app.js` delegates to `post-panels.buildPanelPatchScript()` which injects the versioned IIFE on every build. Violations are auto-patched by the `api-panel-toggle-latest` patch on next run.

Rules for generated HTML:
- **Do not style `.disclosure`** (renderjson sub-tree toggles) beyond `color` and `cursor` — any `width`/`height`/`background` on `.disclosure` is a critical deterministic blocker (`scanRenderjsonDisclosureStyling`). post-panels v8 overrides it at runtime, but build-QA will still flag it.
- **Panel is a fixed overlay** (z-index 2100) — never add `padding-right: 520px`, `max-width: calc(100% - 520px)`, or `body.api-panel-open` shrink rules on host steps or `.slide-root` (`scanPanelOverlayContract` blocker).
- Panel arrives **collapsed by default** on every step nav; 48px edge toggle is the only visible chrome until user clicks.

## Plaid Link onSuccess Callback Panel Contract (v6+)

When the demo-script contains a step with `plaidPhase: "launch"`, the host step immediately after it is the **Link success page** — the screen the user lands on once the Plaid SDK modal closes successfully. The `post-panels` stage auto-injects an "Plaid Link onSuccess (callback)" API response panel on this step when, and only when, the script does not already declare its own `apiResponse` there. The synthesized payload mirrors what the Plaid Web SDK delivers to the `onSuccess(public_token, metadata)` callback:

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

Values are parameterized from `demoScript.plaidSandboxConfig` when present (institutionId, institutionName, accountId, accountName, accountMask, accountType, accountSubtype).

**Rules:**

- If the post-link step **already** has an `apiResponse` (e.g. a server-side product call like `POST /credit/bank_income/get` or `POST /identity/match` immediately after the SDK callback), the script-author's choice wins and the synthesis is skipped. For demos that want BOTH an explicit Link callback beat and a server call, insert a dedicated host step between `plaidPhase: "launch"` and the server-call step.
- If the post-link step is a slide (`stepKind: "slide"`) or another `link` step, no panel is injected — those are not host pages.
- Synthesis is implemented in `post-panels.synthesizeLinkOnSuccessResponse(demoScript)`; re-running the stage on an old scratch-app injects the panel without a full rebuild.

## Manual Navigation (REQUIRED in every generated app)

Every demo app must include keyboard and click-to-advance navigation so a human can drive the demo manually (e.g. for manual Playwright recording or presenter review). Add this script block immediately after the `goToStep` / `getCurrentStep` definitions:

```javascript
// Manual navigation (arrow keys + click-to-advance)
// Required for human-driven recording sessions and presenter review.
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
  // ArrowRight / ArrowDown = next step; ArrowLeft / ArrowUp = previous step
  document.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') _navigate(1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') _navigate(-1);
  });
  // Click on any non-interactive area of the active step to advance.
  document.addEventListener('click', function(e) {
    if (e.target.closest('button, input, select, textarea, a, [role="button"], [role="link"]')) return;
    _navigate(1);
  });
})();
```

**Rules for click-to-advance:**
- The entire step background / card body / text areas should be clickable to advance
- Actual interactive controls (buttons, inputs, links) must NOT trigger advance — they do their own thing
- This must not conflict with the Playwright automation flow — the script is passive and event-driven

## CRITICAL invariants

**Never add `display` to step inline styles** — Steps use `.step { display: none }` / `.step.active { display: block }` for visibility. Never add `style="display:flex"` or `style="display:block"` to a `.step` div — this permanently overrides the hidden state and makes that step visible on ALL other steps.

**data-testid uniqueness** — every `data-testid` attribute must be unique within the entire document. When the same interactive element (e.g., expand button) appears in multiple steps, make the testid unique per step: `api-sidebar-expand-btn-auth`, `api-sidebar-expand-btn-identity`, `api-sidebar-expand-btn-signal`. The Playwright recorder uses strict mode and will error if multiple elements match a single `data-testid` selector.

**First-step bootstrap** — `build-app.js` always injects an idempotent `<script id="pipeline-first-step-bootstrap-v1">` block before `</body>` that activates the first `.step[data-testid]` on `DOMContentLoaded` if no step is already `.active`. Idempotent with the storyboard editor's `STORYBOARD_SET_STEP` postMessage bridge.
