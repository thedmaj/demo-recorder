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
  return { responses, endpoints };
}

function buildPanelPatchScript(responses, endpoints) {
  const respJson = JSON.stringify(responses).replace(/</g, '\\u003c');
  const epsJson = JSON.stringify(endpoints).replace(/</g, '\\u003c');
  return `<script data-post-panels-patch>
(function() {
  if (window.__buildApiPanelPatchApplied) return;
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
    if (document.getElementById('api-panel-edge-toggle-style')) return;
    var st = document.createElement('style');
    st.id = 'api-panel-edge-toggle-style';
    st.textContent =
      '.api-panel-edge-toggle{position:absolute;left:-20px;top:50%;transform:translateY(-50%);width:20px;height:64px;border-radius:10px 0 0 10px;border:1px solid rgba(0,166,126,0.55);border-right:none;background:rgba(0,166,126,0.22);color:#9cf8df;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,0.28);z-index:6;}' +
      '.api-panel-edge-toggle:hover{background:rgba(0,166,126,0.30);color:#c6ffef;}' +
      '.api-panel-toggle-icon{width:8px;height:8px;border-top:2px solid currentColor;border-right:2px solid currentColor;transform:rotate(-135deg);display:block;}' +
      '.api-panel-edge-toggle.is-open .api-panel-toggle-icon{transform:rotate(45deg);}' +
      '#api-response-panel.api-panel-collapsed{width:22px !important;min-width:22px !important;max-width:22px !important;}' +
      '#api-response-panel.api-panel-collapsed .side-panel-header,#api-response-panel.api-panel-collapsed .side-panel-body{display:none !important;}' +
      '#api-response-panel{overflow:visible;}';
    document.head.appendChild(st);
  }
  ensureEdgeToggleStyles();

  function ensurePanelToggle(panel) {
    if (!panel) return null;
    var btn = panel.querySelector('#api-panel-toggle, [data-testid="api-panel-toggle"]');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'api-panel-toggle';
      btn.setAttribute('data-testid', 'api-panel-toggle');
      btn.className = 'api-panel-edge-toggle';
      btn.type = 'button';
      btn.innerHTML = '<span class="api-panel-toggle-icon" aria-hidden="true"></span>';
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        window.toggleApiPanel();
      });
      panel.appendChild(btn);
    }
    if (!btn.querySelector('.api-panel-toggle-icon')) {
      btn.innerHTML = '<span class="api-panel-toggle-icon" aria-hidden="true"></span>';
    }
    btn.setAttribute('aria-expanded', window.__apiPanelUserOpen ? 'true' : 'false');
    btn.setAttribute('aria-label', window.__apiPanelUserOpen ? 'Collapse API JSON panel' : 'Expand API JSON panel');
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

  var _origGoToStep = window.goToStep;
  if (typeof _origGoToStep !== 'function') return;
  window.goToStep = function(id) {
    _origGoToStep(id);
    var panel = document.getElementById('api-response-panel');
    if (!panel) return;
    var content = document.getElementById('api-response-content');
    var endpoint = document.getElementById('api-panel-endpoint');
    var data = window._stepApiResponses && window._stepApiResponses[id];
    if (data) {
      if (endpoint && _eps[id]) endpoint.textContent = _eps[id];
      window.__lastApiJsonData = data;
      if (content) renderApiJson(content, data);
      window.__apiPanelUserOpen = true;
      setPanelVisibility(panel, true);
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

  const alreadyHasPatch =
    /data-post-panels-patch/.test(html) || /window\.__buildApiPanelPatchApplied/.test(html);
  if (hasAnyApiData && html.includes('</body>') && !alreadyHasPatch) {
    const patch = buildPanelPatchScript(responses, endpoints);
    html = html.replace('</body>', `${patch}\n</body>`);
    changes.addedPatchScript = true;
    changes.stepsHydrated = Object.keys(responses).length;
  } else if (hasAnyApiData && alreadyHasPatch) {
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
