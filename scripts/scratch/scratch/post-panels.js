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

const PIPELINE_SLIDE_CONTRACT_PATH = path.join(
  __dirname,
  '../../../templates/slide-template/pipeline-slide-contract.css'
);
const PIPELINE_SLIDE_COLORS_PATH = path.join(
  __dirname,
  '../../../templates/slide-template/colors_and_type.css'
);
const PIPELINE_SLIDE_BASE_PATH = path.join(
  __dirname,
  '../../../templates/slide-template/slide.css'
);

/**
 * Mark host-only chrome nodes so slide mode can hide them via
 * `body.pipeline-slide-active .host-app-chrome { display: none }`.
 *
 * Two matchers run in sequence:
 *
 *   1. **Class-based** — historical Plaid-curated demo class names
 *      (`fdic-bar`, `host-nav`, `sub-nav`, `host-footer`). Kept for
 *      backward compat with builds that use them.
 *
 *   2. **Element-tag** — every top-level `<nav>` / `<header>` / `<footer>`
 *      element in the document, since by the canonical slide DOM shape
 *      slides use `<div class="slide-root">` and never these semantic
 *      tags. Adds `host-app-chrome` to the class attribute (creating
 *      one if absent). This is what catches Pi-Bank-class builds where
 *      the LLM emitted `<nav class="nav">` / `<footer class="footer">`
 *      without honoring the documented `host-nav` / `host-footer`
 *      naming.
 *
 *   3. **Generic class aliases** — `.nav`, `.navbar`, `.topbar`,
 *      `.top-bar`, `.header-bar`, `.app-nav`, `.top-nav`, `.bottom-nav`,
 *      `.footer`, `.bottom-bar`. Belt-and-suspenders for elements that
 *      use a `<div>` wrapper with one of these classes instead of the
 *      semantic tag.
 */
function markHostAppChrome(html) {
  if (!html || typeof html !== 'string') return html;

  // 1) Curated class names
  for (const cls of ['fdic-bar', 'host-nav', 'sub-nav', 'host-footer']) {
    const re = new RegExp(`class="([^"]*\\b${cls}\\b[^"]*)"`, 'g');
    html = html.replace(re, (m, classes) => {
      if (classes.includes('host-app-chrome')) return m;
      return `class="${classes} host-app-chrome"`;
    });
  }

  // 2) Semantic element tags (top-level chrome by definition)
  //    Tag the opening tag. If it has no class attribute, add one.
  //    If it has one without host-app-chrome, append.
  for (const tag of ['nav', 'header', 'footer']) {
    // First pass: add to existing class attribute
    const reWithClass = new RegExp(`<${tag}(\\s[^>]*?)?\\sclass="([^"]*)"`, 'gi');
    html = html.replace(reWithClass, (m, beforeAttrs, classes) => {
      if (classes.includes('host-app-chrome')) return m;
      return `<${tag}${beforeAttrs || ''} class="${classes} host-app-chrome"`;
    });
    // Second pass: add class attribute to bare element (no class= present)
    const reNoClass = new RegExp(`<${tag}((?:\\s[^>]*?)?)>`, 'gi');
    html = html.replace(reNoClass, (m, attrs) => {
      // Skip if we already added a class attribute above
      if (/\sclass="/.test(attrs)) return m;
      return `<${tag}${attrs} class="host-app-chrome">`;
    });
  }

  // 3) Generic chrome class aliases the LLM frequently emits
  for (const cls of ['nav', 'navbar', 'topbar', 'top-bar', 'header-bar',
                     'app-nav', 'top-nav', 'bottom-nav', 'footer', 'bottom-bar']) {
    const re = new RegExp(`class="([^"]*\\b${cls}\\b[^"]*)"`, 'g');
    html = html.replace(re, (m, classes) => {
      if (classes.includes('host-app-chrome')) return m;
      return `class="${classes} host-app-chrome"`;
    });
  }

  return html;
}

/**
 * Refresh the injected `<style data-pipeline-slide-contract>` block with the
 * **full** Plaid Deck Design System CSS — colors/type tokens, base slide.css
 * (scoped under `.slide-root`), and the canvas-size + chrome-hide contract.
 *
 * Why all three: the host scratch-app does NOT link slide.css /
 * colors_and_type.css as `<link>` tags (they live in templates/slide-template/
 * only). Without inlining them, slides would render on a white page with no
 * design tokens — pipeline-slide-contract.css is structural-only and assumes
 * the other two are loaded. Catching the build-app variant where the LLM
 * forgot to copy these CSS files into scratch-app/assets/.
 */
function refreshPipelineSlideContractInHtml(html) {
  if (!html || !html.includes('data-pipeline-slide-contract=')) return html;
  const parts = [];
  for (const p of [PIPELINE_SLIDE_COLORS_PATH, PIPELINE_SLIDE_BASE_PATH, PIPELINE_SLIDE_CONTRACT_PATH]) {
    try {
      const css = fs.readFileSync(p, 'utf8').trim();
      if (css) parts.push(`/* === ${path.basename(p)} === */\n${css}`);
    } catch (_) { /* skip missing files */ }
  }
  if (parts.length === 0) return html;
  const combined = parts.join('\n\n');
  return html.replace(
    /<style data-pipeline-slide-contract="v1">[\s\S]*?<\/style>/,
    `<style data-pipeline-slide-contract="v1">\n${combined}\n</style>`
  );
}

function buildSlideHostIsolationScript() {
  return `<script id="pipeline-slide-host-isolation-v1">
(function() {
  if (window.__pipelineSlideHostIsolationApplied) return;
  window.__pipelineSlideHostIsolationApplied = true;
  function syncSlideHostMode(stepId) {
    var el = document.querySelector('[data-testid="step-' + stepId + '"]');
    var isSlide = !!(el && el.querySelector('.slide-root'));
    document.body.classList.toggle('pipeline-slide-active', isSlide);
  }
  var orig = window.goToStep;
  if (typeof orig === 'function') {
    window.goToStep = function(id) {
      var r = orig.apply(this, arguments);
      syncSlideHostMode(id);
      return r;
    };
  }
  function bootstrap() {
    var active = document.querySelector('.step.active');
    if (!active) return;
    var tid = active.getAttribute('data-testid') || '';
    var id = tid.replace(/^step-/, '');
    if (id) syncSlideHostMode(id);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
  else bootstrap();
})();
</script>`;
}

function ensureSlideHostIsolation(html) {
  if (!html || typeof html !== 'string') return { html, changes: {} };
  const changes = { markedHostChrome: false, refreshedSlideContract: false, addedSlideIsolationScript: false };
  if (!html.includes('slide-root') || !html.includes('</body>')) return { html, changes };

  const beforeMark = html;
  html = markHostAppChrome(html);
  if (html !== beforeMark) changes.markedHostChrome = true;

  const beforeContract = html;
  html = refreshPipelineSlideContractInHtml(html);
  if (html !== beforeContract) changes.refreshedSlideContract = true;

  if (!html.includes('pipeline-slide-host-isolation-v1')) {
    html = html.replace('</body>', `${buildSlideHostIsolationScript()}\n</body>`);
    changes.addedSlideIsolationScript = true;
  }
  return { html, changes };
}

const { requireRunDir, getRunLayout, readRunManifest } = require('../utils/run-io');
const { annotateScriptWithStepKinds, isSlideStep } = require('../utils/step-kind');
const { buildPanelPayloadPrompt } = require('../utils/prompt-templates');

const { OPUS_PRIMARY } = require('../utils/anthropic-models');
const PANEL_LLM_MODEL = process.env.POST_PANELS_MODEL || OPUS_PRIMARY;
const PANEL_LLM_MAX_TOKENS = Number(process.env.POST_PANELS_MAX_TOKENS || 2000);
const SPARSE_PAYLOAD_MIN_KEYS = Number(process.env.POST_PANELS_MIN_KEYS || 3);

const RENDERJSON_EXPAND_LEVEL_DEFAULT = 999;

const RENDERJSON_SCRIPT_TAG =
  '<script data-renderjson-lib src="https://cdn.jsdelivr.net/npm/renderjson@1.4.0/renderjson.min.js"></script>';

// ─── renderjson shim — emitted alongside the CDN library tag ──────────────
// renderjson@1.4.0 (minified) silently ignored `set_show_to_level('all')`
// in late-May 2026 builds — every nested object/array stayed `display:none`
// and "+" disclosure clicks did nothing. This shim replaces window.renderjson
// AFTER the CDN library loads with a custom pretty-printer that emits fully
// expanded, token-colored JSON via .tok-key / .tok-string / .tok-number /
// .tok-bool / .tok-null / .tok-punct hooks. Existing v12 panel CSS
// (#api-response-panel pre.code .tok-*) supplies the colors.
// The shim returns a `<pre class="renderjson tok-rendered">` so existing
// CSS hooks scoped to .renderjson keep working too.
// Idempotent — re-running the script just rebinds the same shim.
const RENDERJSON_SHIM_BLOCK = [
  '<script id="renderjson-pretty-shim" data-version="v1">',
  '(function() {',
  '  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }',
  '  function pretty(value, indent) {',
  '    indent = indent || 0;',
  '    var PAD = new Array(indent + 1).join("  ");',
  '    var PAD_INNER = new Array(indent + 2).join("  ");',
  '    if (value === null) return \'<span class="tok-null">null</span>\';',
  '    if (value === undefined) return \'<span class="tok-null">undefined</span>\';',
  '    if (typeof value === "boolean") return \'<span class="tok-bool">\' + value + \'</span>\';',
  '    if (typeof value === "number") return \'<span class="tok-number">\' + value + \'</span>\';',
  '    if (typeof value === "string") return \'<span class="tok-string">"\' + esc(value) + \'"</span>\';',
  '    if (Array.isArray(value)) {',
  '      if (value.length === 0) return \'<span class="tok-punct">[]</span>\';',
  '      var arr = [];',
  '      for (var i = 0; i < value.length; i++) arr.push(PAD_INNER + pretty(value[i], indent + 1));',
  '      return \'<span class="tok-punct">[</span>\\n\' + arr.join(\'<span class="tok-punct">,</span>\\n\') + \'\\n\' + PAD + \'<span class="tok-punct">]</span>\';',
  '    }',
  '    if (typeof value === "object") {',
  '      var keys = Object.keys(value);',
  '      if (keys.length === 0) return \'<span class="tok-punct">{}</span>\';',
  '      var obj = keys.map(function(k) {',
  '        return PAD_INNER + \'<span class="tok-key">"\' + esc(k) + \'"</span><span class="tok-punct">:</span> \' + pretty(value[k], indent + 1);',
  '      });',
  '      return \'<span class="tok-punct">{</span>\\n\' + obj.join(\'<span class="tok-punct">,</span>\\n\') + \'\\n\' + PAD + \'<span class="tok-punct">}</span>\';',
  '    }',
  '    return esc(String(value));',
  '  }',
  '  function shim(data) {',
  '    var pre = document.createElement("pre");',
  '    pre.className = "renderjson tok-rendered";',
  '    pre.style.whiteSpace = "pre";',
  '    if (data === null || data === undefined) {',
  '      pre.innerHTML = \'<span style="color:rgba(255,255,255,0.42);font-style:italic;">(no body)</span>\';',
  '      return pre;',
  '    }',
  '    try { pre.innerHTML = pretty(data, 0); }',
  '    catch (e) { pre.textContent = JSON.stringify(data, null, 2); }',
  '    return pre;',
  '  }',
  '  shim.set_show_to_level = function() { return shim; };',
  '  shim.set_icons = function() { return shim; };',
  '  shim.set_max_string_length = function() { return shim; };',
  '  shim.set_sort_objects = function() { return shim; };',
  '  shim.set_replacer = function() { return shim; };',
  '  shim.set_collapse_msg = function() { return shim; };',
  '  shim.set_property_list = function() { return shim; };',
  '  shim.set_show_by_default = function() { return shim; };',
  '  shim.options = { show_to_level: Number.MAX_VALUE };',
  '  window.renderjson = shim;',
  '  // Re-trigger goToStep so the active step refreshes through the shim.',
  '  var active = document.querySelector(".step.active");',
  '  var id = active && active.dataset && active.dataset.testid ? active.dataset.testid.replace(/^step-/, "") : null;',
  '  if (id && typeof window.goToStep === "function") { try { window.goToStep(id); } catch (_) {} }',
  '})();',
  '</script>',
  '<style id="renderjson-pretty-shim-css">',
  '#api-response-panel pre.code, #api-response-panel pre.renderjson { white-space: pre; }',
  '#api-response-panel pre.code .tok-key, #api-response-panel pre.renderjson .tok-key { color: var(--tok-key, #9CDCFE); }',
  '#api-response-panel pre.code .tok-string, #api-response-panel pre.renderjson .tok-string { color: var(--tok-string, #42F0CD); }',
  '#api-response-panel pre.code .tok-number, #api-response-panel pre.renderjson .tok-number { color: var(--tok-number, #F5C76A); }',
  '#api-response-panel pre.code .tok-bool, #api-response-panel pre.renderjson .tok-bool { color: var(--tok-bool, #C586C0); font-style: italic; }',
  '#api-response-panel pre.code .tok-null, #api-response-panel pre.renderjson .tok-null { color: var(--tok-null, #C586C0); font-style: italic; }',
  '#api-response-panel pre.code .tok-punct, #api-response-panel pre.renderjson .tok-punct { color: var(--tok-punct, rgba(255,255,255,0.46)); }',
  '</style>'
].join('\n');

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
  // LLM-stub defense: the build-app prompt encourages a minimal _showApiPanelStub
  // helper but historically LLMs have emitted ones that hard-reference legacy
  // IDs (#api-panel-edge-toggle, #api-panel-body, #api-panel-endpoint) and
  // throw "Cannot read properties of null" the moment goToStep runs. Replace
  // it with a safe no-op — the wrapped goToStep further down drives the panel
  // via populateApiPanel against the canonical v12 markup.
  if (typeof window._showApiPanelStub !== 'function' ||
      !window._showApiPanelStub.__pipelineSafe) {
    window._showApiPanelStub = function() { /* neutered — populateApiPanel owns the panel */ };
    window._showApiPanelStub.__pipelineSafe = true;
  }
  var _resp = ${respJson};
  var _eps  = ${epsJson};
  // The host JS reads \`apiData.endpoint\` for the panel label and reads
  // request/response panes from EITHER \`apiData.request\` + \`apiData.response\`
  // (v10 — two-tab panel) OR \`apiData.data\` (legacy — single-pane fallback).
  // We emit the v10 wrapped shape; the renderer detects which keys are
  // present and falls back automatically. _resp is shaped as either:
  //   • { request, response } — preferred (LLM emits both)
  //   • <flat response body>  — legacy (response-only)
  // We normalize to the v10 wrapped form below.
  var _wrappedResp = {};
  Object.keys(_resp).forEach(function(k) {
    var v = _resp[k];
    if (v && typeof v === 'object' && ('request' in v || 'response' in v)) {
      _wrappedResp[k] = { endpoint: _eps[k] || '', request: v.request || null, response: v.response || null };
    } else {
      // Legacy flat shape — treat as response-only.
      _wrappedResp[k] = { endpoint: _eps[k] || '', request: null, response: v };
    }
  });
  window._stepApiResponses = Object.assign({}, window._stepApiResponses || {}, _wrappedResp);
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
    // Claude Design v12 "API Panel (standalone)" CSS — re-injected on every
    // goToStep so even if a build-qa run rewrites the head <style> block,
    // the v12 chrome remains active. ID-scoped + !important to beat any
    // LLM-emitted .panel rule that might exist in the host stylesheet.
    var existing = document.getElementById('api-panel-edge-toggle-style');
    if (existing && existing.getAttribute('data-version') === '${vTag}') return;
    if (existing) { try { existing.remove(); } catch (_) {} }
    var st = document.createElement('style');
    st.id = 'api-panel-edge-toggle-style';
    st.setAttribute('data-version', '${vTag}');
    st.textContent = [
      // Tokens — Claude Design palette (#9CDCFE keys, Plaid mint strings, etc.)
      '#api-response-panel.panel,#api-response-panel{',
      '  --panel-bg:#022544;--panel-bg-2:#021B33;',
      '  --panel-border:rgba(255,255,255,0.08);',
      '  --tok-key:#9CDCFE;--tok-string:#42F0CD;',
      '  --tok-number:#F5C76A;--tok-bool:#C586C0;--tok-null:#C586C0;',
      '  --tok-punct:rgba(255,255,255,0.46);',
      '}',
      // Panel chrome
      '#api-response-panel.panel,section#api-response-panel{',
      '  position:fixed !important;top:0 !important;right:0 !important;bottom:0 !important;left:auto !important;',
      '  width:min(720px,92vw) !important;min-width:0 !important;max-width:none !important;height:auto !important;',
      '  background:var(--panel-bg) !important;',
      '  border-left:1px solid var(--panel-border) !important;',
      '  box-shadow:0 32px 80px rgba(2,37,68,0.14),0 8px 24px rgba(2,37,68,0.08);',
      '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      '  display:flex !important;flex-direction:column !important;',
      '  transform:translateX(0);',
      '  transition:transform 400ms cubic-bezier(0.22,1,0.36,1);',
      '  z-index:2100;overflow:visible !important;',
      '}',
      // Collapsed: slide out + carry chevron with us to the viewport right edge
      '#api-response-panel.panel.is-collapsed,#api-response-panel.is-collapsed{',
      '  transform:translateX(100%) !important;',
      '  width:min(720px,92vw) !important;pointer-events:none;',
      '}',
      '#api-response-panel.is-collapsed .toggle{pointer-events:auto;}',
      // Chevron toggle
      '#api-response-panel .toggle{',
      '  position:absolute;top:50%;left:-36px;transform:translateY(-50%);',
      '  width:36px;height:56px;appearance:none;border:0;padding:0;cursor:pointer;',
      '  background:rgba(2,37,68,0.55) !important;',
      '  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);',
      '  border:1px solid var(--panel-border) !important;border-right:0 !important;',
      '  border-radius:8px 0 0 8px !important;',
      '  color:rgba(255,255,255,0.7);display:grid;place-items:center;',
      '  z-index:2200;',
      '  transition:background 150ms cubic-bezier(0.4,0,0.2,1),color 150ms cubic-bezier(0.4,0,0.2,1);',
      '}',
      '#api-response-panel .toggle:hover{background:rgba(2,37,68,0.8) !important;color:#fff;}',
      '#api-response-panel .toggle svg{width:16px;height:16px;transition:transform 400ms cubic-bezier(0.22,1,0.36,1);}',
      '#api-response-panel.is-collapsed .toggle svg{transform:rotate(180deg);}',
      // Header + route + tabs
      '#api-response-panel .panel-head{padding:20px 24px 16px;border-bottom:1px solid var(--panel-border);display:flex !important;align-items:flex-end;justify-content:space-between;gap:24px;}',
      '#api-response-panel .panel-head .eyebrow{color:var(--plaid-teal-500,#42F0CD);font-size:12px;line-height:1;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:8px;display:block;}',
      '#api-response-panel .panel-head .route{font-family:"SF Mono","JetBrains Mono",ui-monospace,monospace;font-size:18px;line-height:1.2;color:#fff;display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
      '#api-response-panel .panel-head .method{display:inline-block;font-size:11px;font-weight:700;letter-spacing:0.08em;padding:3px 8px;border-radius:4px;background:rgba(66,240,205,0.14);color:var(--plaid-teal-500,#42F0CD);border:1px solid rgba(66,240,205,0.28);font-family:-apple-system,BlinkMacSystemFont,sans-serif;}',
      '#api-response-panel .panel-head .path{color:rgba(255,255,255,0.92);}',
      '#api-response-panel .tabs{display:inline-flex !important;gap:2px;padding:3px;background:rgba(0,0,0,0.28);border:1px solid var(--panel-border);border-radius:8px;}',
      '#api-response-panel .tab{appearance:none;border:0;background:transparent;font:inherit;color:rgba(255,255,255,0.62);padding:7px 14px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;transition:color 150ms cubic-bezier(0.4,0,0.2,1),background 150ms cubic-bezier(0.4,0,0.2,1);}',
      '#api-response-panel .tab:hover{color:#fff;}',
      '#api-response-panel .tab[aria-selected="true"]{background:var(--plaid-blue-600,#0B7BBC);color:#fff;box-shadow:0 1px 0 rgba(255,255,255,0.08) inset;}',
      // Toolbar
      '#api-response-panel .panel-toolbar{display:flex !important;align-items:center;justify-content:space-between;padding:12px 24px;background:var(--panel-bg-2);border-bottom:1px solid var(--panel-border);font-family:"SF Mono","JetBrains Mono",ui-monospace,monospace;font-size:12px;color:rgba(255,255,255,0.54);}',
      '#api-response-panel .copy-btn{appearance:none;background:transparent;border:1px solid var(--panel-border);color:rgba(255,255,255,0.7);font:inherit;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;padding:4px 10px;border-radius:4px;cursor:pointer;transition:all 150ms cubic-bezier(0.4,0,0.2,1);}',
      '#api-response-panel .copy-btn:hover{color:#fff;border-color:rgba(255,255,255,0.24);background:rgba(255,255,255,0.04);}',
      // Code panes
      '#api-response-panel .code-wrap{position:relative;flex:1;min-height:0;overflow:hidden;}',
      '#api-response-panel pre.code{margin:0;padding:20px 24px 24px;font-family:"SF Mono","JetBrains Mono",ui-monospace,monospace;font-size:13px;line-height:1.65;color:#DCE7F2;overflow:auto;height:100%;tab-size:2;background:transparent;}',
      '#api-response-panel [data-pane]{display:none !important;}',
      '#api-response-panel [data-pane].is-active{display:block !important;}',
      // renderjson tokens — Claude Design palette
      '#api-response-panel .renderjson{font-family:"SF Mono","JetBrains Mono",ui-monospace,monospace;}',
      '#api-response-panel .renderjson a{text-decoration:none;}',
      '#api-response-panel .renderjson .disclosure{',
      '  display:inline-block !important;width:14px !important;text-align:center !important;margin-right:4px !important;',
      '  color:rgba(255,255,255,0.42) !important;font-weight:600 !important;cursor:pointer !important;user-select:none !important;',
      '  background:none !important;background-color:transparent !important;border:none !important;',
      '  height:auto !important;min-width:0 !important;min-height:0 !important;max-width:none !important;max-height:none !important;',
      '  font-size:1em !important;line-height:1 !important;padding:0 !important;outline:none !important;box-shadow:none !important;',
      '  vertical-align:baseline !important;text-decoration:none !important;appearance:none !important;',
      '}',
      '#api-response-panel .renderjson .disclosure:hover{color:var(--plaid-teal-500,#42F0CD) !important;}',
      '#api-response-panel .renderjson .syntax{color:var(--tok-punct);}',
      '#api-response-panel .renderjson .string{color:var(--tok-string);}',
      '#api-response-panel .renderjson .number{color:var(--tok-number);}',
      '#api-response-panel .renderjson .boolean{color:var(--tok-bool);font-style:italic;}',
      '#api-response-panel .renderjson .key{color:var(--tok-key);}',
      '#api-response-panel .renderjson .keyword{color:var(--tok-null);font-style:italic;}',
      '#api-response-panel .renderjson .object.syntax,#api-response-panel .renderjson .array.syntax{color:rgba(255,255,255,0.6);}',
      // Legacy class neutralization — older builds may still ship .side-panel,
      // .side-panel-header, .api-panel-edge-toggle markup. We don't want two
      // chevrons or two panel chromes layering on top of each other. Hide
      // the legacy bits when they appear as siblings/descendants of the v12
      // panel.
      '#api-response-panel.panel .side-panel-header,#api-response-panel.panel .side-panel-body{display:none !important;}',
      '#api-response-panel.panel > .api-panel-edge-toggle{display:none !important;}',
      ''
    ].join('\\n');
    document.head.appendChild(st);
  }
  ensureEdgeToggleStyles();

  function renderToggleContent(/* open */) {
    // Claude Design v12 chevron SVG. Rotation is handled in CSS
    // (#api-response-panel.is-collapsed .toggle svg → rotate(180deg))
    // so authors don't need to swap content between open / collapsed states.
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 3 11 8 6 13"></polyline></svg>';
  }
  function ensurePanelToggle(panel) {
    if (!panel) return null;
    // Dedupe: build-app sometimes emits a standalone <button class="api-panel-edge-toggle">
    // as a SIBLING of the panel. Combined with the toggle we own inside the
    // panel, two chevrons render at the right edge of the viewport (both pinned
    // by position:fixed;right:0). Remove every duplicate that lives outside
    // the panel before we touch the inside-the-panel toggle.
    var allToggles = document.querySelectorAll('.api-panel-edge-toggle, [data-testid="api-panel-toggle"]');
    for (var i = 0; i < allToggles.length; i++) {
      var t = allToggles[i];
      if (!panel.contains(t)) { try { t.remove(); } catch (_) {} }
    }
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
    // Always rewrite className + innerHTML so older v1/v2 buttons get the
    // Claude Design v12 chrome (SVG chevron). Idempotent — re-renders to the
    // same DOM. The v12 button class is .toggle (matches Claude Design
    // selector); we strip the legacy .api-panel-edge-toggle class if any
    // earlier post-panels patch put it there.
    if (!String(btn.className || '').split(/\\s+/).includes('toggle')) {
      btn.classList.add('toggle');
    }
    btn.classList.remove('api-panel-edge-toggle');
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
      panel.classList.remove('is-collapsed');
      panel.classList.add('api-panel-open');
    } else {
      panel.classList.add('api-panel-collapsed'); // legacy (build-qa scanners)
      panel.classList.add('is-collapsed');        // Claude Design v12
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

  // Two-tab Request/Response panel — switchApiTab toggles which pane is visible.
  // Default tab is Request when request data is present; otherwise Response.
  // The panes never display simultaneously; exactly one is .is-active.
  //
  // Accepts BOTH short tab keys ("req"/"res", which is what the Claude
  // Design v12 markup emits via data-tab="req|res") AND long keys
  // ("request"/"response" — the legacy api-panel-tab markup). Queries both
  // selector families so a click on either v12 .tab buttons or legacy
  // .api-panel-tab buttons flips the right pane.
  window.switchApiTab = function(which) {
    var w = String(which || '').toLowerCase();
    var v12Key = (w === 'request' || w === 'req') ? 'req' :
                 (w === 'response' || w === 'res') ? 'res' : w;
    var legacyKey = (w === 'request' || w === 'req') ? 'request' :
                    (w === 'response' || w === 'res') ? 'response' : w;
    var tabSel = '.tab[data-tab], .api-panel-tab[data-tab], button[role="tab"][data-tab]';
    var paneSel = '[data-pane]';
    var tabs = document.querySelectorAll(tabSel);
    var panes = document.querySelectorAll(paneSel);
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var v = t.getAttribute('data-tab');
      var on = v === v12Key || v === legacyKey;
      if (on) t.classList.add('is-active'); else t.classList.remove('is-active');
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (var j = 0; j < panes.length; j++) {
      var p = panes[j];
      var pv = p.getAttribute('data-pane');
      var onP = pv === v12Key || pv === legacyKey;
      if (onP) {
        p.classList.add('is-active');
        if (p.hasAttribute('hidden')) p.removeAttribute('hidden');
      } else {
        p.classList.remove('is-active');
        // v12 CSS hides via [data-pane]:not(.is-active); also set hidden
        // attribute for belt-and-suspenders accessibility.
        if (!p.hasAttribute('hidden')) p.setAttribute('hidden', '');
      }
    }
  };

  function ensureTabStructure(panel) {
    if (!panel) return null;
    var header = panel.querySelector('.side-panel-header');
    var body = panel.querySelector('.side-panel-body');
    // Inject tabs row inside header if missing
    if (header && !header.querySelector('.api-panel-tabs')) {
      var tabs = document.createElement('div');
      tabs.className = 'api-panel-tabs';
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('data-testid', 'api-panel-tabs');
      tabs.innerHTML =
        '<button class="api-panel-tab is-active" data-tab="request" data-testid="api-panel-tab-request" role="tab" aria-selected="true">Request</button>' +
        '<button class="api-panel-tab" data-tab="response" data-testid="api-panel-tab-response" role="tab" aria-selected="false">Response</button>';
      header.appendChild(tabs);
      // Bind click handlers (delegation would also work — explicit is clearer)
      var btns = tabs.querySelectorAll('.api-panel-tab');
      for (var k = 0; k < btns.length; k++) {
        btns[k].addEventListener('click', function(e) {
          e.preventDefault(); e.stopPropagation();
          window.switchApiTab(this.getAttribute('data-tab'));
        });
      }
    }
    // Inject request + response panes inside body if missing
    if (body && !body.querySelector('.api-panel-pane[data-pane="request"]')) {
      // Wipe any legacy single-content children to avoid double-rendering
      body.innerHTML = '';
      var paneReq = document.createElement('div');
      paneReq.className = 'api-panel-pane is-active';
      paneReq.id = 'api-pane-request';
      paneReq.setAttribute('data-pane', 'request');
      paneReq.setAttribute('data-testid', 'api-pane-request');
      var paneRes = document.createElement('div');
      paneRes.className = 'api-panel-pane';
      paneRes.id = 'api-pane-response';
      paneRes.setAttribute('data-pane', 'response');
      paneRes.setAttribute('data-testid', 'api-pane-response');
      body.appendChild(paneReq);
      body.appendChild(paneRes);
    }
    return { paneReq: panel.querySelector('#api-pane-request'),
             paneRes: panel.querySelector('#api-pane-response'),
             tabReq: panel.querySelector('[data-testid="api-panel-tab-request"]'),
             tabRes: panel.querySelector('[data-testid="api-panel-tab-response"]') };
  }

  var _origGoToStep = window.goToStep;
  if (typeof _origGoToStep !== 'function') return;
  window.goToStep = function(id) {
    _origGoToStep(id);
    var panel = document.getElementById('api-response-panel');
    if (!panel) return;
    var endpoint = document.getElementById('api-panel-endpoint') || document.getElementById('api-endpoint-label');
    var stepData = window._stepApiResponses && window._stepApiResponses[id];
    if (stepData) {
      var endpointLabel = _eps[id] || stepData.endpoint || '';
      // v7 live onSuccess override: if this step is the synthesized onSuccess
      // panel AND the real SDK callback has fired, prefer the captured live
      // payload as the RESPONSE.
      var requestData = stepData.request || null;
      var responseData;
      var liveEndpointSuffix = '';
      if (isOnSuccessEndpoint(endpointLabel) && window._plaidLinkOnSuccess) {
        responseData = window._plaidLinkOnSuccess;
        liveEndpointSuffix = ' — live';
      } else if (stepData && typeof stepData === 'object' && 'response' in stepData) {
        responseData = stepData.response;
      } else {
        // Legacy flat / wrapped-as-data shape: treat the whole thing as response
        responseData = (stepData && stepData.data != null) ? stepData.data : stepData;
      }
      if (endpoint && endpointLabel) {
        endpoint.textContent = endpointLabel.replace(/\\s—\\s+live$/, '') + liveEndpointSuffix;
      }
      // Build the tabbed structure (idempotent), then render each pane independently.
      var refs = ensureTabStructure(panel);
      if (refs) {
        if (refs.tabReq) refs.tabReq.style.display = requestData ? '' : 'none';
        if (refs.tabRes) refs.tabRes.style.display = responseData ? '' : 'none';
        renderApiJson(refs.paneReq, requestData);
        renderApiJson(refs.paneRes, responseData);
        // Default tab: Request when present, else Response.
        window.switchApiTab(requestData ? 'request' : 'response');
      }
      window.__lastApiJsonData = responseData;  // back-compat for rerenderCurrentApiJson
      var openByDefault =
        window.__API_PANEL_CONFIG && window.__API_PANEL_CONFIG.collapsedByDefault === false;
      window.__apiPanelUserOpen = !!openByDefault;
      setPanelVisibility(panel, !!openByDefault);
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
    // Canonical API panel — Claude Design "API Panel (standalone)" template
    // (2026-05-26 handoff bundle). Two-tab Request / Response panel with:
    //   .toggle (chevron, left edge)
    //   .panel-head (eyebrow + .method/.path + .tabs)
    //   .panel-toolbar (content-type label + Copy button)
    //   .code-wrap > pre.code[data-pane="req|res"] (renderjson panes)
    // Legacy id/data-testid attributes preserved so existing populateApiPanel
    // + build-qa selectors keep working.
    const shell = [
      '<section class="panel" id="api-response-panel" data-testid="api-response-panel" aria-label="Plaid API reference" style="display:none">',
        '<button class="toggle" id="api-panel-toggle" data-testid="api-panel-toggle" type="button" aria-controls="api-response-panel" aria-expanded="false" aria-label="Expand panel">',
          '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
            '<polyline points="6 3 11 8 6 13"></polyline>',
          '</svg>',
        '</button>',
        '<header class="panel-head">',
          '<div>',
            '<span class="eyebrow">Plaid API</span>',
            '<div class="route">',
              '<span class="method" id="api-panel-method" data-testid="api-panel-method">POST</span>',
              '<span class="path" id="api-panel-path" data-testid="api-panel-path"></span>',
            '</div>',
          '</div>',
          '<div class="tabs" role="tablist" aria-label="Request or response">',
            '<button class="tab" id="tab-req" data-testid="api-panel-tab-request" role="tab" data-tab="req" aria-controls="api-pane-request" aria-selected="true">Request</button>',
            '<button class="tab" id="tab-res" data-testid="api-panel-tab-response" role="tab" data-tab="res" aria-controls="api-pane-response" aria-selected="false">Response</button>',
          '</div>',
        '</header>',
        '<div class="panel-toolbar">',
          '<span id="api-panel-content-type">application/json · request body</span>',
          '<button class="copy-btn" id="api-panel-copy" data-testid="api-panel-copy" type="button">Copy</button>',
        '</div>',
        '<div class="code-wrap">',
          '<pre class="code is-active" id="api-pane-request" data-testid="api-pane-request" data-pane="req" role="tabpanel" aria-labelledby="tab-req"></pre>',
          '<pre class="code" id="api-pane-response" data-testid="api-pane-response" data-pane="res" role="tabpanel" aria-labelledby="tab-res" hidden></pre>',
          // Legacy id container for any populateApiPanel callers that still
          // write to #api-response-content. Hidden by default; modern
          // populateApiPanel writes into #api-pane-request / #api-pane-response
          // directly.
          '<div id="api-response-content" data-testid="api-response-content" hidden></div>',
        '</div>',
      '</section>'
    ].join('');
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

  // Inject the renderjson pretty-printer shim immediately before </body>.
  // Must run AFTER the CDN library tag so its `window.renderjson` override
  // wins. Idempotent — re-running just re-binds the same shim.
  if (hasAnyApiData && !html.includes('renderjson-pretty-shim')) {
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${RENDERJSON_SHIM_BLOCK}\n</body>`);
      changes.addedRenderjsonShim = true;
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
  const POST_PANELS_PATCH_VERSION = 'v11';
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

  const slideIso = ensureSlideHostIsolation(html);
  html = slideIso.html;
  Object.assign(changes, slideIso.changes);

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
  markHostAppChrome,
  ensureSlideHostIsolation,
  refreshPipelineSlideContractInHtml,
  findSparsePayloadSteps,
  extractJsonFromLlmText,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
