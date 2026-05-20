'use strict';
/**
 * post-panels.js
 *
 * Deterministic JSON-side-panel normalizer. Runs AFTER `build` and `build-qa`
 * and BEFORE `record`. Guarantees the following contracts are present on the
 * built `scratch-app/index.html` regardless of what the LLM produced:
 *
 *   1. Global shells: `#api-response-panel` + `#link-events-panel` exist and
 *      are hidden by default.
 *   2. Toggle button: `data-testid="api-panel-toggle"` present inside the API
 *      panel and wired to `window.toggleApiPanel()`.
 *   3. Content host: `#api-response-content` exists and is vertically +
 *      horizontally scrollable.
 *   4. Runtime wiring: `window._stepApiResponses` is hydrated from
 *      `demo-script.json` for every `stepKind === 'app'` step with an
 *      `apiResponse.response`; renderjson script tag present.
 *   5. Idempotent: re-running on an already-normalized file is a no-op.
 *
 * The LLM builder (`build-app.js`) has historically inlined all of this
 * logic. Moving it into a dedicated stage makes it (a) runnable standalone
 * via `pipe post-panels`, (b) idempotent across retries, and (c) independent
 * of LLM context budget — so panel quality stops being a casualty of a
 * token-pressured build.
 *
 * Reads:   $PIPELINE_RUN_DIR/scratch-app/index.html
 *          $PIPELINE_RUN_DIR/demo-script.json
 * Writes:  $PIPELINE_RUN_DIR/scratch-app/index.html  (normalized in-place)
 *          $PIPELINE_RUN_DIR/post-panels-report.json
 *          $PIPELINE_RUN_DIR/artifacts/build/post-panels-report.json
 *
 * Usage (CLI):
 *   PIPELINE_RUN_DIR=out/demos/2026-04-23-... node scripts/scratch/scratch/post-panels.js
 *   PIPELINE_RUN_DIR=... node scripts/scratch/scratch/post-panels.js --steps=step-a,step-b
 *   node scripts/scratch/scratch/post-panels.js --dry-run
 */

const fs = require('fs');
const path = require('path');

const { requireRunDir, getRunLayout, readRunManifest } = require('../utils/run-io');
const { annotateScriptWithStepKinds, isSlideStep } = require('../utils/step-kind');
const { buildPanelPayloadPrompt } = require('../utils/prompt-templates');

const PANEL_LLM_MODEL = process.env.POST_PANELS_MODEL || 'claude-opus-4-7';
const PANEL_LLM_MAX_TOKENS = Number(process.env.POST_PANELS_MAX_TOKENS || 2000);
const SPARSE_PAYLOAD_MIN_KEYS = Number(process.env.POST_PANELS_MIN_KEYS || 3);

const RENDERJSON_EXPAND_LEVEL_DEFAULT = 999;

const RENDERJSON_SCRIPT_TAG =
  '<script data-renderjson-lib src="https://cdn.jsdelivr.net/npm/renderjson@1.4.0/renderjson.min.js"></script>';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function hasApiEndpoint(step) {
  const endpoint = String(step?.apiResponse?.endpoint || '').trim();
  return /^[A-Z]+\s+\/|^\//.test(endpoint);
}

function isValueSummaryStep(step) {
  const id = String(step?.id || '').toLowerCase();
  const label = String(step?.label || '').toLowerCase();
  return id === 'value-summary-slide' || /\bvalue summary\b/.test(label);
}

function stepHasApiResponse(step) {
  return !!(
    step &&
    !isValueSummaryStep(step) &&
    hasApiEndpoint(step) &&
    step.apiResponse &&
    step.apiResponse.response &&
    typeof step.apiResponse.response === 'object'
  );
}

function collectStepApiResponses(demoScript, { onlyStepIds } = {}) {
  const responses = {};
  const endpoints = {};
  const filterSet = onlyStepIds && onlyStepIds.length ? new Set(onlyStepIds) : null;
  for (const step of (demoScript?.steps || [])) {
    if (!stepHasApiResponse(step)) continue;
    if (filterSet && !filterSet.has(step.id)) continue;
    responses[step.id] = step.apiResponse.response;
    if (step.apiResponse.endpoint) endpoints[step.id] = step.apiResponse.endpoint;
  }

  // Auto-inject an onSuccess metadata panel for the step immediately after a
  // plaidPhase:"launch" step when that step does not already declare its own
  // apiResponse. The post-link host page is where the demo announces "Plaid
  // Link succeeded — here's the public_token and account metadata we got
  // back" before any server-side product call (Bank Income, Identity Match,
  // Auth, etc.). When the LLM-generated demo-script does include a server
  // call there, we respect it and skip the synthesis (the existing panel
  // takes precedence).
  const synthesized = synthesizeLinkOnSuccessResponse(demoScript);
  if (synthesized) {
    const targetId = synthesized.stepId;
    if (!filterSet || filterSet.has(targetId)) {
      if (!responses[targetId]) {
        responses[targetId] = synthesized.response;
        endpoints[targetId] = synthesized.endpoint;
      }
    }
  }

  return { responses, endpoints };
}

/**
 * Synthesize an onSuccess callback apiResponse for the host step immediately
 * after a plaidPhase:"launch" step, parameterized from demoScript metadata
 * (plaidSandboxConfig, persona, products). Returns
 *
 *   { stepId, endpoint, response }
 *
 * or null when no synthesis applies (no launch step found, no following step,
 * or following step is itself a link / slide).
 *
 * The shape mirrors what Plaid SDK delivers to onSuccess(public_token, metadata):
 *   metadata = { institution, accounts[], link_session_id, transfer_status }
 */
function synthesizeLinkOnSuccessResponse(demoScript) {
  if (!demoScript || !Array.isArray(demoScript.steps)) return null;
  const steps = demoScript.steps;
  const launchIdx = steps.findIndex(
    (s) => s && String(s.plaidPhase || '').toLowerCase() === 'launch'
  );
  if (launchIdx < 0 || launchIdx >= steps.length - 1) return null;
  const successStep = steps[launchIdx + 1];
  if (!successStep || !successStep.id) return null;
  // Skip if the following step is itself a link / slide tier — those are not
  // host pages where a callback panel belongs.
  const succSceneType = String(successStep.sceneType || '').toLowerCase();
  if (succSceneType === 'link' || succSceneType === 'slide') return null;
  const succStepKind = String(successStep.stepKind || '').toLowerCase();
  if (succStepKind === 'slide') return null;

  // Sandbox defaults — overridable by demo-script.plaidSandboxConfig.
  const sandboxCfg = demoScript.plaidSandboxConfig || {};
  const institutionId = sandboxCfg.institutionId || 'ins_109508';
  const institutionName = sandboxCfg.institutionName || 'First Platypus Bank';
  const accountId = sandboxCfg.accountId || 'BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp';
  const accountName = sandboxCfg.accountName || 'Plaid Checking';
  const accountMask = sandboxCfg.accountMask || '0211';
  const accountType = sandboxCfg.accountType || 'depository';
  const accountSubtype = sandboxCfg.accountSubtype || 'checking';

  const linkSessionId = '7e2d2a3a-c7bc-4a3c-9f87-' + (successStep.id || 'demo').slice(0, 12);
  const publicToken = 'public-sandbox-' + linkSessionId;

  return {
    stepId: successStep.id,
    endpoint: 'Plaid Link onSuccess (callback)',
    response: {
      public_token: publicToken,
      metadata: {
        institution: {
          name: institutionName,
          institution_id: institutionId,
        },
        accounts: [
          {
            id: accountId,
            name: accountName,
            mask: accountMask,
            type: accountType,
            subtype: accountSubtype,
            verification_status: null,
            class_type: null,
          },
        ],
        link_session_id: linkSessionId,
        transfer_status: null,
      },
    },
  };
}

function buildPanelPatchScript(responses, endpoints, versionTag) {
  const respJson = JSON.stringify(responses).replace(/</g, '\\u003c');
  const epsJson = JSON.stringify(endpoints).replace(/</g, '\\u003c');
  const vTag = (typeof versionTag === 'string' && versionTag) ? versionTag : 'v1';
  return `<script data-post-panels-patch="${vTag}">
(function() {
  // Versioned-idempotency: re-run when the embedded patch is older than this
  // version. The legacy build-app patch sets __buildApiPanelPatchApplied=true
  // (boolean) which is NOT equal to 'v3'/etc., so we run anyway and overwrite
  // its state. This is the fix for the "v2 never ran because v1 set the flag"
  // bug observed in 2026-05-20-Buying-A-Lucid-Air-Auth-Identity-Income-v1.
  if (window.__buildApiPanelPatchVersion === '${vTag}') return;
  window.__buildApiPanelPatchVersion = '${vTag}';
  // Preserve compatibility with code paths that check the old boolean flag.
  window.__buildApiPanelPatchApplied = true;
  var _resp = ${respJson};
  var _eps  = ${epsJson};
  window._stepApiResponses = Object.assign({}, window._stepApiResponses || {}, _resp);
  window.__API_PANEL_CONFIG = Object.assign({
    collapsedByDefault: true,
    jsonExpandLevel: ${RENDERJSON_EXPAND_LEVEL_DEFAULT},
    autoResize: true,
    minWidthPx: 420,
    maxWidthViewportRatio: 0.62
  }, window.__API_PANEL_CONFIG || {});
  if (typeof window.__apiPanelUserOpen !== 'boolean') {
    window.__apiPanelUserOpen = !window.__API_PANEL_CONFIG.collapsedByDefault;
  }
  function ensureEdgeToggleStyles() {
    // Re-inject styles when the version changes so the v3 styles override the
    // older small-chevron design from v1/v2. Remove the old style block first.
    var existing = document.getElementById('api-panel-edge-toggle-style');
    if (existing && existing.getAttribute('data-version') === '${vTag}') return;
    if (existing) { try { existing.remove(); } catch (_) {} }
    var st = document.createElement('style');
    st.id = 'api-panel-edge-toggle-style';
    st.setAttribute('data-version', '${vTag}');
    // v3 styling: pill-shaped, labeled toggle attached to the panel's outer
    // edge. Visible at a glance, clearly clickable, with a readable label so
    // build-qa / vision QA recognizes it as an affordance. Uses very high
    // specificity (#api-response-panel scope) and !important on layout
    // properties so LLM-generated host CSS cannot accidentally hide it.
    st.textContent = [
      // Base panel rules — re-asserted at high specificity so they win over
      // any LLM-generated CSS that may have set overflow:hidden or width
      // constraints on .side-panel.
      '#api-response-panel{overflow:visible !important;}',
      '#api-response-panel.api-panel-collapsed{width:48px !important;min-width:48px !important;max-width:48px !important;}',
      '#api-response-panel.api-panel-collapsed .side-panel-header,#api-response-panel.api-panel-collapsed .side-panel-body{display:none !important;}',
      // Edge toggle — vertically centered on the panel, icon-only. The arrow
      // points in the direction the panel will MOVE on click (right when open
      // because the panel will collapse rightward; left when closed because
      // the panel will expand leftward). Anchored to the panel\\'s left edge so
      // it sits visually attached to the panel regardless of viewport width.
      '#api-response-panel .api-panel-edge-toggle{',
      '  position:absolute !important;',
      '  left:-36px !important;',
      '  top:50% !important;',
      '  transform:translateY(-50%) !important;',
      '  display:inline-flex !important;',
      '  align-items:center;justify-content:center;',
      '  width:36px;height:60px;',
      '  padding:0;',
      '  border-radius:10px 0 0 10px;',
      '  border:1px solid rgba(0,166,126,0.6);border-right:none;',
      '  background:rgba(0,166,126,0.22);',
      '  color:#9cf8df;',
      '  cursor:pointer;',
      '  box-shadow:0 8px 24px rgba(0,0,0,0.28);',
      '  z-index:2001;',
      '  user-select:none;',
      '  transition:background 0.16s ease,color 0.16s ease;',
      '}',
      '#api-response-panel .api-panel-edge-toggle:hover{background:rgba(0,166,126,0.34);color:#c6ffef;}',
      '#api-response-panel .api-panel-edge-toggle:focus-visible{outline:2px solid #00a67e;outline-offset:2px;}',
      // Directional chevron. CSS-only — drawn from two borders rotated to form
      // an arrowhead. is-open class signals the panel is currently expanded;
      // in that state, a click will collapse (panel moves right) so the chevron
      // points right. Otherwise it points left (panel will expand leftward).
      '#api-response-panel .api-panel-toggle-icon{',
      '  width:10px;height:10px;',
      '  border-top:2px solid currentColor;border-right:2px solid currentColor;',
      '  transform:rotate(-135deg);', // default: points LEFT (collapsed state)
      '  display:inline-block;',
      '  transition:transform 0.18s ease;',
      '}',
      '#api-response-panel .api-panel-edge-toggle.is-open .api-panel-toggle-icon{transform:rotate(45deg);}', // points RIGHT
      // Collapsed panel: keep the toggle pinned outside the thin strip and
      // centered vertically so it remains discoverable while the panel is hidden.
      '#api-response-panel.api-panel-collapsed .api-panel-edge-toggle{left:-36px !important;top:50% !important;transform:translateY(-50%) !important;}',
      '',
    ].join('\\n');
    document.head.appendChild(st);
  }
  ensureEdgeToggleStyles();

  function renderToggleContent(/* open */) {
    // v5: icon-only. The chevron's rotation (driven by the .is-open class on the
    // parent button) communicates direction: arrow points RIGHT when open
    // (panel will collapse right) and LEFT when collapsed (panel will expand
    // left). Screen readers still get a directional aria-label via the
    // ensurePanelToggle attributes below.
    return '<span class="api-panel-toggle-icon" aria-hidden="true"></span>';
  }
  function ensurePanelToggle(panel) {
    if (!panel) return null;
    var existing = panel.querySelector('#api-panel-toggle, [data-testid="api-panel-toggle"]');
    var btn;
    if (existing) {
      // CRITICAL: clone-and-replace to STRIP any stale listeners attached by
      // the original LLM-generated HTML's DOMContentLoaded handler (or by an
      // older v1/v2 post-panels patch). Without this, the original listener
      // and our v3 listener both fire on click and the state toggles twice
      // (net effect: no visible change). Clone preserves all attributes and
      // innerHTML but drops all event listeners — exactly what we want.
      if (existing.dataset.postPanelsToggleVersion !== '${vTag}') {
        btn = existing.cloneNode(true);
        if (existing.parentNode) existing.parentNode.replaceChild(btn, existing);
        else { existing.remove(); panel.appendChild(btn); }
      } else {
        btn = existing;
      }
    } else {
      btn = document.createElement('button');
      btn.id = 'api-panel-toggle';
      btn.setAttribute('data-testid', 'api-panel-toggle');
      btn.className = 'api-panel-edge-toggle';
      btn.type = 'button';
      panel.appendChild(btn);
    }
    // Always rewrite className + innerHTML so older v1/v2 buttons get the v3
    // pill chrome (label + icon). Idempotent — re-renders to the same DOM.
    if (!String(btn.className || '').split(/\\s+/).includes('api-panel-edge-toggle')) {
      btn.classList.add('api-panel-edge-toggle');
    }
    var desiredHtml = renderToggleContent(!!window.__apiPanelUserOpen);
    if (btn.innerHTML !== desiredHtml) btn.innerHTML = desiredHtml;
    // Bind the v3 click listener exactly once. The version marker on the
    // dataset prevents the clone+rebind cycle from running on every goToStep.
    if (btn.dataset.postPanelsToggleVersion !== '${vTag}') {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        window.toggleApiPanel();
      });
      btn.dataset.postPanelsToggleVersion = '${vTag}';
    }
    btn.setAttribute('aria-expanded', window.__apiPanelUserOpen ? 'true' : 'false');
    btn.setAttribute('aria-label', window.__apiPanelUserOpen ? 'Collapse API JSON panel' : 'Expand API JSON panel');
    btn.setAttribute('title', window.__apiPanelUserOpen ? 'Collapse API JSON panel' : 'Expand API JSON panel');
    if (window.__apiPanelUserOpen) btn.classList.add('is-open');
    else btn.classList.remove('is-open');
    return btn;
  }

  function applyPanelSize(panel, content) {
    if (!panel || !content || !window.__API_PANEL_CONFIG.autoResize || !window.__apiPanelUserOpen) return;
    var cfg = window.__API_PANEL_CONFIG;
    var maxPx = Math.floor(window.innerWidth * Number(cfg.maxWidthViewportRatio || 0.62));
    var minPx = Number(cfg.minWidthPx || 420);
    var target = Math.min(maxPx, Math.max(minPx, Math.ceil((content.scrollWidth || minPx) + 80)));
    panel.style.width = target + 'px';
    panel.style.maxWidth = 'calc(100vw - 32px)';
    panel.style.overflow = 'hidden';
    content.style.maxWidth = '100%';
    content.style.overflowX = 'auto';
    content.style.overflowY = 'auto';
    content.style.wordBreak = 'break-word';
  }

  function renderApiJson(target, data) {
    if (!target) return;
    target.innerHTML = '';
    target.style.maxWidth = '100%';
    target.style.overflowX = 'auto';
    target.style.overflowY = 'auto';
    try {
      if (window.renderjson && typeof window.renderjson === 'function') {
        if (typeof window.renderjson.set_show_to_level === 'function') window.renderjson.set_show_to_level(window.__API_PANEL_CONFIG.jsonExpandLevel);
        if (typeof window.renderjson.set_icons === 'function') window.renderjson.set_icons('+', '-');
        if (typeof window.renderjson.set_sort_objects === 'function') window.renderjson.set_sort_objects(false);
        target.appendChild(window.renderjson(data));
        applyPanelSize(document.getElementById('api-response-panel'), target);
        return;
      }
    } catch (_) {}
    var pretty = JSON.stringify(data, null, 2);
    try {
      if (typeof window.syntaxHighlight === 'function') target.innerHTML = window.syntaxHighlight(pretty);
      else target.textContent = pretty;
    } catch (_) {
      target.textContent = pretty;
    }
    applyPanelSize(document.getElementById('api-response-panel'), target);
  }

  function setPanelVisibility(panel, open) {
    if (!panel) return;
    panel.style.removeProperty('display');
    panel.style.display = 'flex';
    if (open) {
      panel.classList.remove('api-panel-collapsed');
      panel.classList.add('api-panel-open');
    } else {
      panel.classList.add('api-panel-collapsed');
      panel.classList.remove('api-panel-open');
    }
    ensurePanelToggle(panel);
  }

  function rerenderCurrentApiJson() {
    var panel = document.getElementById('api-response-panel');
    var content = document.getElementById('api-response-content');
    var data = window.__lastApiJsonData;
    if (!panel || !content || !data) return;
    renderApiJson(content, data);
    setPanelVisibility(panel, window.__apiPanelUserOpen);
  }

  window.toggleApiPanel = function(forceOpen) {
    var panel = document.getElementById('api-response-panel');
    if (!panel) return false;
    if (typeof forceOpen === 'boolean') window.__apiPanelUserOpen = forceOpen;
    else window.__apiPanelUserOpen = !window.__apiPanelUserOpen;
    setPanelVisibility(panel, window.__apiPanelUserOpen);
    if (window.__apiPanelUserOpen) rerenderCurrentApiJson();
    return window.__apiPanelUserOpen;
  };

  if (!window.renderjson) {
    var existing = document.querySelector('script[data-renderjson-lib]');
    if (existing) existing.addEventListener('load', rerenderCurrentApiJson, { once: true });
  }

  // v7: capture the REAL Plaid Link onSuccess(public_token, metadata) callback
  // args at runtime so the JSON panel shows the actual SDK session payload —
  // not the synthesized sandbox defaults that ship in _stepApiResponses.
  //
  // We monkey-patch window.Plaid.create so that ANY host app using the SDK
  // gets its onSuccess wrapped. The original handler is still invoked
  // identically; we just capture the args first.
  //
  // The synthesized panel data remains as a build-time fallback (used by
  // build-qa / vision QA which never actually completes a real Link session,
  // and visible if a viewer navigates to the post-link step before the SDK
  // has fired its callback).
  function isOnSuccessEndpoint(label) {
    return /onSuccess|on[\\\s_-]?success/i.test(String(label || ''));
  }
  function refreshPanelForCurrentStep() {
    try {
      if (typeof window.getCurrentStep !== 'function') return;
      var cur = (window.getCurrentStep() || '').replace(/^step-/, '');
      if (!cur) return;
      var ep = _eps[cur] || '';
      if (!isOnSuccessEndpoint(ep)) return;
      if (!window._plaidLinkOnSuccess) return;
      var panel = document.getElementById('api-response-panel');
      var content = document.getElementById('api-response-content');
      var endpoint = document.getElementById('api-panel-endpoint');
      if (!panel || !content) return;
      // Live onSuccess: append a " — live" suffix to the endpoint label so the
      // operator can see at a glance that the panel is showing the real SDK
      // capture (vs the build-time sandbox fallback).
      if (endpoint) endpoint.textContent = ep.replace(/\\s—\\s+live$/, '') + ' — live';
      window.__lastApiJsonData = window._plaidLinkOnSuccess;
      renderApiJson(content, window._plaidLinkOnSuccess);
    } catch (_) {}
  }
  function installPlaidOnSuccessHook() {
    if (typeof window.Plaid !== 'object' || !window.Plaid || typeof window.Plaid.create !== 'function') return false;
    if (window.__plaidOnSuccessHookInstalled) return true;
    window.__plaidOnSuccessHookInstalled = true;
    var origCreate = window.Plaid.create;
    window.Plaid.create = function(opts) {
      try {
        if (opts && typeof opts === 'object' && typeof opts.onSuccess === 'function') {
          var userOnSuccess = opts.onSuccess;
          opts.onSuccess = function(public_token, metadata) {
            try {
              window._plaidLinkOnSuccess = {
                public_token: public_token,
                metadata: metadata,
                captured_at: new Date().toISOString(),
              };
              // If we are already on the post-link step (the SDK auto-advanced
              // host UI but the panel still shows synthesized data), live-refresh.
              refreshPanelForCurrentStep();
            } catch (_) {}
            return userOnSuccess.apply(this, arguments);
          };
        }
      } catch (_) {}
      return origCreate.apply(this, arguments);
    };
    return true;
  }
  // Plaid SDK script may load asynchronously; retry every 100ms for up to 15s.
  if (!installPlaidOnSuccessHook()) {
    var hookAttempts = 0;
    var hookInterval = setInterval(function() {
      if (installPlaidOnSuccessHook() || ++hookAttempts > 150) clearInterval(hookInterval);
    }, 100);
  }

  var _origGoToStep = window.goToStep;
  if (typeof _origGoToStep !== 'function') return;
  window.goToStep = function(id) {
    _origGoToStep(id);
    var panel = document.getElementById('api-response-panel');
    if (!panel) return;
    var content = document.getElementById('api-response-content');
    var endpoint = document.getElementById('api-panel-endpoint');
    var stepData = window._stepApiResponses && window._stepApiResponses[id];
    if (stepData) {
      var endpointLabel = _eps[id] || '';
      // v7: if this step is the synthesized onSuccess panel AND the real SDK
      // callback has already fired, prefer the captured live payload over the
      // build-time sandbox fallback. Operators see the real public_token,
      // institution, account_id, mask, link_session_id that came back from
      // the actual Plaid session.
      var renderData;
      var liveEndpointSuffix = '';
      if (isOnSuccessEndpoint(endpointLabel) && window._plaidLinkOnSuccess) {
        renderData = window._plaidLinkOnSuccess;
        liveEndpointSuffix = ' — live';
      } else {
        // Unwrap so we render the response payload, not the wrapper
        // { endpoint, response } object. Previously the wrapped goToStep
        // rendered the full wrapper, double-printing the endpoint field.
        renderData = (stepData && typeof stepData === 'object' && stepData.response)
          ? stepData.response
          : stepData;
      }
      if (endpoint && endpointLabel) {
        endpoint.textContent = endpointLabel.replace(/\\s—\\s+live$/, '') + liveEndpointSuffix;
      }
      window.__lastApiJsonData = renderData;
      // v6: respect __API_PANEL_CONFIG.collapsedByDefault (default true) so new
      // step navigation lands with the panel CHROME visible but the JSON body
      // hidden. The user can click the toggle arrow to expand and inspect the
      // payload. This matches operator expectations: "JSON should be available
      // on insight steps, but not autoplay-in-your-face on every navigation."
      // Build-QA / vision-QA that needs to validate JSON content can override
      // by setting window.__API_PANEL_CONFIG.collapsedByDefault = false before
      // walking the steps.
      var openByDefault =
        window.__API_PANEL_CONFIG && window.__API_PANEL_CONFIG.collapsedByDefault === false;
      window.__apiPanelUserOpen = !!openByDefault;
      setPanelVisibility(panel, !!openByDefault);
      // Always render the JSON into the (possibly collapsed) body so that
      // expanding the panel later is instant — the data is already in the DOM.
      if (content) renderApiJson(content, renderData);
    } else {
      panel.style.setProperty('display', 'none', 'important');
      panel.classList.remove('api-panel-collapsed');
      panel.classList.remove('api-panel-open');
    }
  };

  window.addEventListener('resize', function() {
    if (!window.__apiPanelUserOpen) return;
    var panel = document.getElementById('api-response-panel');
    var content = document.getElementById('api-response-content');
    applyPanelSize(panel, content);
  });
})();
</script>`;
}

/**
 * Normalize panel-related HTML. Returns the updated HTML and a `changes` object
 * describing what was done. Idempotent: calling twice produces no deltas on the
 * second call (all inserts are guarded by id / marker checks).
 *
 * @param {string} html
 * @param {object} demoScript
 * @param {{ onlyStepIds?: string[] }} [opts]
 * @returns {{ html: string, changes: object }}
 */
function normalizePanelsInHtml(html, demoScript, opts = {}) {
  const changes = {
    addedApiPanelShell: false,
    addedLinkEventsShell: false,
    addedApiContent: false,
    addedToggleButton: false,
    addedRenderjson: false,
    addedPatchScript: false,
    removedInlineJsonPanels: 0,
    stepsHydrated: 0,
    alreadyNormalized: false,
    appOnlySkipped: false,
  };

  if (!html || typeof html !== 'string') {
    return { html: html || '', changes };
  }

  // App-only runs have no insight/slide steps and no JSON rail. The whole
  // panel normalization is a no-op — do not inject empty shells.
  if (opts.pipelineAppOnlyHostUi === true) {
    changes.appOnlySkipped = true;
    return { html, changes };
  }

  const { responses, endpoints } = collectStepApiResponses(demoScript, opts);
  const hasAnyApiData = Object.keys(responses).length > 0;

  const hasApiPanel = /id\s*=\s*["']api-response-panel["']/.test(html);
  const hasLinkPanel = /id\s*=\s*["']link-events-panel["']/.test(html);

  if (!hasApiPanel && hasAnyApiData && html.includes('</body>')) {
    const shell =
      '<div id="api-response-panel" data-testid="api-response-panel" class="side-panel" style="display:none"><div class="side-panel-header"><span id="api-panel-endpoint"></span></div><div class="side-panel-body"><div id="api-response-content" data-testid="api-response-content"></div></div></div>';
    html = html.replace('</body>', `${shell}\n</body>`);
    changes.addedApiPanelShell = true;
    changes.addedApiContent = true;
  }

  if (!hasLinkPanel && html.includes('</body>')) {
    const shell =
      '<div id="link-events-panel" data-testid="link-events-panel" class="side-panel" style="display:none"></div>';
    html = html.replace('</body>', `${shell}\n</body>`);
    changes.addedLinkEventsShell = true;
  }

  if (changes.addedApiPanelShell === false && hasApiPanel) {
    const hasContent =
      /id\s*=\s*["']api-response-content["']/.test(html) ||
      /data-testid\s*=\s*["']api-response-content["']/.test(html);
    if (!hasContent) {
      html = html.replace(
        /(<div[^>]*\bid\s*=\s*["']api-response-panel["'][^>]*>)/i,
        '$1<div id="api-response-content" data-testid="api-response-content"></div>'
      );
      changes.addedApiContent = true;
    }
  }

  if (/id\s*=\s*["']api-response-panel["']/.test(html)) {
    html = html.replace(
      /<button[^>]*(?:id|data-testid)\s*=\s*["']api-json-panel-(?:show|hide)["'][^>]*>[\s\S]*?<\/button>/gi,
      ''
    );
    const hasToggle = /data-testid=["']api-panel-toggle["']|id=["']api-panel-toggle["']/i.test(html);
    if (!hasToggle) {
      const toggleMarkup =
        '<button type="button" id="api-panel-toggle" data-testid="api-panel-toggle" class="api-panel-edge-toggle" aria-label="Expand API JSON panel" aria-expanded="false"><span class="api-panel-toggle-icon" aria-hidden="true"></span></button>';
      let merged = false;
      html = html.replace(
        /(<div[^>]*\bid\s*=\s*["']api-response-panel["'][^>]*>)/i,
        (m) => {
          merged = true;
          return `${m}${toggleMarkup}`;
        }
      );
      if (merged) changes.addedToggleButton = true;
    }
  }

  const forbiddenInlineJsonPanelMatches = [
    ...html.matchAll(/<(?:div|aside|section)[^>]*\b(?:id|class)\s*=\s*["'][^"']*(?:json-panel|insight-right|auth-json-panel|api-json-panel|raw-json)[^"']*["'][^>]*>/gi),
  ]
    .map((m) => m[0])
    .filter((tag) => !/api-response-panel|api-response-content/i.test(tag));
  if (forbiddenInlineJsonPanelMatches.length > 0) {
    changes.removedInlineJsonPanels = forbiddenInlineJsonPanelMatches.length;
  }

  if (hasAnyApiData && !html.includes('renderjson.min.js')) {
    if (html.includes('</head>')) {
      html = html.replace('</head>', `${RENDERJSON_SCRIPT_TAG}\n</head>`);
      changes.addedRenderjson = true;
    } else if (html.includes('</body>')) {
      html = html.replace('</body>', `${RENDERJSON_SCRIPT_TAG}\n</body>`);
      changes.addedRenderjson = true;
    }
  }

  // Version stamp so we can rewrite older buggy patches in already-built scratch-apps.
  // Bump when the embedded patch script is updated.
  //   v3 changes vs v2:
  //   - Versioned `__buildApiPanelPatchVersion` flag (not the old plain boolean
  //     `__buildApiPanelPatchApplied`) so a stale v1 IIFE from build-app no
  //     longer short-circuits the post-panels patch.
  //   - Labeled "Show JSON / Hide JSON" pill toggle instead of a tiny chevron.
  //   - Stripper also removes the build-app legacy IIFE.
  //   v4 changes vs v3:
  //   - ensurePanelToggle now clones-and-replaces the existing toggle button to
  //     STRIP stale click listeners attached by the original LLM-generated
  //     DOMContentLoaded handler. Without the clone, that listener and the v3
  //     listener both fired on every click, flipping state twice (net effect:
  //     no visible toggle).
  //   - The button stores `data-post-panels-toggle-version` so re-renders on
  //     goToStep do not re-clone unnecessarily.
  //   v5 changes vs v4:
  //   - Toggle is now centered vertically on the panel (top:50%; translateY(-50%))
  //     so it visually anchors to the panel's geometry instead of floating at the
  //     top corner where it can be confused with header content.
  //   - Replaced the "Show JSON / Hide JSON" pill label with a single directional
  //     arrow icon. The arrow points in the direction the panel will MOVE on click:
  //       - Panel open  → click collapses it (panel moves right) → arrow points RIGHT (›)
  //       - Panel closed → click expands it (panel moves left)  → arrow points LEFT  (‹)
  //   - Same accessible aria-label / title text is preserved for screen readers; only
  //     the visible affordance is now icon-only and direction-correct.
  //   v6 changes vs v5:
  //   - Panels are now DEFAULT-COLLAPSED on every step navigation (respects
  //     __API_PANEL_CONFIG.collapsedByDefault, which is already true). Previous
  //     versions force-opened the panel on every step, which made screen
  //     recordings feel auto-expanded and noisy. JSON content is still
  //     rendered immediately into the (collapsed) body so expanding is instant.
  //     Build-QA can opt into expanded panels by setting
  //     window.__API_PANEL_CONFIG.collapsedByDefault = false before walking.
  //   - synthesizeLinkOnSuccessResponse(demoScript) auto-injects an
  //     "Plaid Link onSuccess (callback)" apiResponse panel for the host step
  //     immediately AFTER the plaidPhase:"launch" step when that step does
  //     not already declare its own apiResponse. The payload mirrors what
  //     Plaid SDK delivers to onSuccess(public_token, metadata) and is
  //     parameterized from demo-script.plaidSandboxConfig.
  //   v7 changes vs v6:
  //   - Live capture of the real Plaid SDK onSuccess(public_token, metadata)
  //     callback. The patch IIFE monkey-patches window.Plaid.create so any
  //     host app using the SDK gets its onSuccess wrapped: args are saved to
  //     window._plaidLinkOnSuccess BEFORE the original handler runs, and the
  //     current panel re-renders if the user is already on the post-link
  //     step. Synthesized sandbox payload remains the fallback (build-qa
  //     token-only mode, pre-link manual nav). When live data is present,
  //     the panel header label gets a " — live" suffix so operators can
  //     visually distinguish real vs synthesized in screen recordings.
  const POST_PANELS_PATCH_VERSION = 'v7';
  const patchMarker = `data-post-panels-patch="${POST_PANELS_PATCH_VERSION}"`;
  const hasCurrentPatch = html.includes(patchMarker);
  const hasAnyPostPanelsPatch = /data-post-panels-patch/.test(html);
  // build-app.js emits a near-identical patch IIFE without a data attribute.
  // Recognize it via its stable opener so post-panels can strip the duplicate.
  const buildAppPatchRegex =
    /<script>\s*\(function\(\)\s*\{\s*if\s*\(window\.__buildApiPanelPatchApplied\)\s*return;\s*window\.__buildApiPanelPatchApplied\s*=\s*true;[\s\S]*?<\/script>/g;
  const hasBuildAppLegacyPatch = buildAppPatchRegex.test(html);
  buildAppPatchRegex.lastIndex = 0; // reset for the replace pass below
  const hasAnyPatch = hasAnyPostPanelsPatch || hasBuildAppLegacyPatch;

  if (hasAnyApiData && html.includes('</body>') && !hasCurrentPatch) {
    // Strip stale post-panels patches AND the build-app legacy duplicate so
    // the new patch can run cleanly. Both are idempotent and inject the same
    // step-API data, so dropping them is safe.
    if (hasAnyPostPanelsPatch) {
      html = html.replace(
        /<script data-post-panels-patch[\s\S]*?<\/script>\s*/g,
        ''
      );
      changes.replacedStalePatch = true;
    }
    if (hasBuildAppLegacyPatch) {
      html = html.replace(buildAppPatchRegex, '');
      changes.replacedBuildAppLegacyPatch = true;
    }
    const patch = buildPanelPatchScript(responses, endpoints, POST_PANELS_PATCH_VERSION);
    html = html.replace('</body>', `${patch}\n</body>`);
    changes.addedPatchScript = true;
    changes.stepsHydrated = Object.keys(responses).length;
  } else if (hasAnyApiData && hasCurrentPatch) {
    changes.alreadyNormalized = true;
    changes.stepsHydrated = Object.keys(responses).length;
  }

  return { html, changes };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { steps: null, dryRun: false, llmFallback: false };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--llm-fallback') out.llmFallback = true;
    else if (a.startsWith('--steps=')) {
      out.steps = a
        .slice('--steps='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return out;
}

/**
 * Detect steps whose apiResponse.response is "sparse" (likely LLM-under-served):
 * - missing entirely
 * - fewer than SPARSE_PAYLOAD_MIN_KEYS keys at the top level
 * - contains obvious placeholder values (TODO, REPLACE_ME)
 */
function findSparsePayloadSteps(demoScript, { onlyStepIds } = {}) {
  const filterSet = onlyStepIds && onlyStepIds.length ? new Set(onlyStepIds) : null;
  const sparse = [];
  for (const step of (demoScript?.steps || [])) {
    if (!stepHasApiResponse(step)) continue;
    if (filterSet && !filterSet.has(step.id)) continue;
    const resp = step.apiResponse.response;
    const keyCount = resp && typeof resp === 'object' ? Object.keys(resp).length : 0;
    const raw = JSON.stringify(resp || {});
    const hasPlaceholder = /\bTODO\b|REPLACE_ME|placeholder|PLACEHOLDER/.test(raw);
    if (keyCount < SPARSE_PAYLOAD_MIN_KEYS || hasPlaceholder) {
      sparse.push({
        stepId: step.id,
        keyCount,
        hasPlaceholder,
        endpoint: step.apiResponse.endpoint || '',
      });
    }
  }
  return sparse;
}

function extractJsonFromLlmText(text) {
  if (!text || typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const firstBrace = body.indexOf('{');
  const lastBrace = body.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < firstBrace) return null;
  const candidate = body.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch (_) {
    return null;
  }
}

async function enrichSparsePayloadsWithLlm(demoScript, sparse, { dryRun }) {
  const results = { hydrated: [], skipped: [] };
  if (sparse.length === 0) return results;
  if (dryRun) {
    for (const s of sparse) results.skipped.push({ ...s, reason: 'dry-run' });
    return results;
  }
  let client;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!process.env.ANTHROPIC_API_KEY) {
      for (const s of sparse) results.skipped.push({ ...s, reason: 'missing-ANTHROPIC_API_KEY' });
      return results;
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  } catch (e) {
    for (const s of sparse) results.skipped.push({ ...s, reason: `sdk-load-error: ${e.message}` });
    return results;
  }
  for (const target of sparse) {
    const step = (demoScript.steps || []).find((x) => x && x.id === target.stepId);
    if (!step) {
      results.skipped.push({ ...target, reason: 'step-missing' });
      continue;
    }
    const existing = step.apiResponse && step.apiResponse.response ? JSON.stringify(step.apiResponse.response, null, 2) : '';
    const { system, userMessages } = buildPanelPayloadPrompt({
      step,
      existingPayload: existing,
      narrationHint: step.visualState || step.narration || '',
    });
    try {
      const response = await client.messages.create({
        model: PANEL_LLM_MODEL,
        max_tokens: PANEL_LLM_MAX_TOKENS,
        system,
        messages: userMessages,
      });
      const text = (response.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const json = extractJsonFromLlmText(text);
      if (!json || typeof json !== 'object') {
        results.skipped.push({ ...target, reason: 'no-json-in-response' });
        continue;
      }
      step.apiResponse.response = json;
      results.hydrated.push({
        stepId: target.stepId,
        previousKeyCount: target.keyCount,
        newKeyCount: Object.keys(json).length,
      });
    } catch (e) {
      results.skipped.push({ ...target, reason: `llm-error: ${e.message}` });
    }
  }
  return results;
}

function resolveHtmlPath(outDir, layout) {
  const root = path.join(outDir, 'scratch-app', 'index.html');
  if (fs.existsSync(root)) return root;
  const artifactRoot = path.join(layout.buildDir, 'scratch-app', 'index.html');
  if (fs.existsSync(artifactRoot)) return artifactRoot;
  return root;
}

async function main() {
  const PROJECT_ROOT = path.resolve(__dirname, '../../..');
  const outDir = requireRunDir(PROJECT_ROOT, 'post-panels');
  const layout = getRunLayout(outDir);
  const cli = parseArgs(process.argv.slice(2));
  const htmlPath = resolveHtmlPath(outDir, layout);
  const scriptPath = path.join(outDir, 'demo-script.json');

  if (!fs.existsSync(htmlPath)) {
    console.error(`[post-panels] scratch-app/index.html not found at ${htmlPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(scriptPath)) {
    console.error(`[post-panels] demo-script.json not found at ${scriptPath}`);
    process.exit(1);
  }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const demoScript = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  annotateScriptWithStepKinds(demoScript);

  const runManifest = readRunManifest(outDir);
  const pipelineAppOnlyHostUi = !!(
    runManifest && String(runManifest.buildMode || '').toLowerCase() === 'app-only'
  );
  if (pipelineAppOnlyHostUi) {
    console.log('[post-panels] App-only run — skipping panel normalization (no API JSON rail expected).');
  }

  let llmResults = null;
  if (cli.llmFallback && !pipelineAppOnlyHostUi) {
    const sparse = findSparsePayloadSteps(demoScript, { onlyStepIds: cli.steps || null });
    if (sparse.length > 0) {
      console.log(
        `[post-panels] Found ${sparse.length} sparse payload(s); invoking LLM fallback.`
      );
      llmResults = await enrichSparsePayloadsWithLlm(demoScript, sparse, { dryRun: cli.dryRun });
      if (llmResults && llmResults.hydrated.length > 0 && !cli.dryRun) {
        fs.writeFileSync(scriptPath, JSON.stringify(demoScript, null, 2));
        console.log(
          `[post-panels] Wrote demo-script.json with ${llmResults.hydrated.length} hydrated payload(s).`
        );
      }
    } else {
      console.log('[post-panels] No sparse payloads detected; skipping LLM fallback.');
    }
  }

  const { html: updated, changes } = normalizePanelsInHtml(html, demoScript, {
    onlyStepIds: cli.steps || null,
    pipelineAppOnlyHostUi,
  });

  const slideStepCount = (demoScript.steps || []).filter((s) => isSlideStep(s)).length;
  const report = {
    at: new Date().toISOString(),
    htmlPath: path.relative(outDir, htmlPath),
    dryRun: cli.dryRun,
    onlyStepIds: cli.steps || null,
    slideStepCount,
    totalSteps: (demoScript.steps || []).length,
    changes,
    llm: cli.llmFallback ? (llmResults || { hydrated: [], skipped: [] }) : null,
  };

  const reportPath = path.join(outDir, 'post-panels-report.json');
  const artifactReportPath = path.join(layout.buildDir, 'post-panels-report.json');

  if (!cli.dryRun && updated !== html) {
    fs.writeFileSync(htmlPath, updated, 'utf8');
    console.log(
      `[post-panels] Wrote normalized HTML (${JSON.stringify({
        addedApiPanelShell: changes.addedApiPanelShell,
        addedToggleButton: changes.addedToggleButton,
        addedPatchScript: changes.addedPatchScript,
        stepsHydrated: changes.stepsHydrated,
      })})`
    );
  } else {
    console.log(
      `[post-panels] No HTML changes needed${cli.dryRun ? ' (dry-run)' : ''}.` +
        ` stepsHydrated=${changes.stepsHydrated}`
    );
  }

  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    fs.mkdirSync(path.dirname(artifactReportPath), { recursive: true });
    fs.writeFileSync(artifactReportPath, JSON.stringify(report, null, 2));
  } catch (e) {
    console.warn(`[post-panels] Could not write report: ${e.message}`);
  }
}

module.exports = {
  main,
  normalizePanelsInHtml,
  collectStepApiResponses,
  stepHasApiResponse,
  buildPanelPatchScript,
  findSparsePayloadSteps,
  extractJsonFromLlmText,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
