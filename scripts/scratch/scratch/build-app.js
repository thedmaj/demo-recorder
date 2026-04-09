'use strict';
/**
 * build-app.js
 * Two Claude calls: architecture brief, then full HTML app generation
 * with streaming.
 *
 * Reads:  out/demo-script.json
 *         out/qa-report-{N}.json   (optional, passed via --qa=path)
 * Writes: scratch-app/index.html
 *         scratch-app/playwright-script.json
 *
 * Usage:
 *   node scripts/scratch/scratch/build-app.js
 *   node scripts/scratch/scratch/build-app.js --qa=out/qa-report-1.json
 *
 * Environment:
 *   ANTHROPIC_API_KEY   — required
 */

require('dotenv').config({ override: true });
const Anthropic  = require('@anthropic-ai/sdk');
const fs         = require('fs');
const path       = require('path');

const {
  buildAppArchitectureBriefPrompt,
  buildAppFrameworkPlanPrompt,
  buildAppGenerationPrompt,
} = require('../utils/prompt-templates');
const { inferProductFamily } = require('../utils/product-profiles');
const { buildCuratedProductKnowledge, buildCuratedDigest } = require('../utils/product-knowledge');
const { readPipelineRunContext } = require('../utils/run-context');
const {
  getPlaidSkillBundleForFamily,
  getPlaidLinkUxSkillBundle,
  getEmbeddedLinkSkillBundle,
  writePlaidLinkUxSkillManifest,
} = require('../utils/plaid-skill-loader');
const { resolveMode, getLinkModeAdapter } = require('../utils/link-mode');
const { askPlaidDocs } = require('../utils/mcp-clients');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT    = path.resolve(__dirname, '../../..');
const OUT_DIR         = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const INPUTS_DIR      = path.join(PROJECT_ROOT, 'inputs');
const SCRIPT_FILE     = path.join(OUT_DIR, 'demo-script.json');
const RESEARCH_FILE   = path.join(OUT_DIR, 'product-research.json');
const SCRATCH_APP_DIR = path.join(OUT_DIR, 'scratch-app');
const HTML_OUT        = path.join(SCRATCH_APP_DIR, 'index.html');
const PLAYWRIGHT_OUT  = path.join(SCRATCH_APP_DIR, 'playwright-script.json');
const FEEDBACK_FILE   = path.join(INPUTS_DIR, 'build-feedback.md');
const RUN_FEEDBACK_FILE = path.join(OUT_DIR, 'build-feedback.md');
const PROMPT_FILE     = path.join(INPUTS_DIR, 'prompt.txt');
const ASSETS_DIR      = path.join(PROJECT_ROOT, 'assets');

const PLAID_LOGO_ASSET_MAP = [
  {
    source: 'Plaid-Logo horizontal black with white background.png',
    target: 'plaid-logo-horizontal-black-white-background.png',
  },
  {
    source: 'plaid logo horizontal white text transparent background.png',
    target: 'plaid-logo-horizontal-white-text-transparent-background.png',
  },
  {
    source: 'Plaid vertical logo white text transparent background.png',
    target: 'plaid-logo-vertical-white-text-transparent-background.png',
  },
  {
    source: 'plaid logo text white background.png',
    target: 'plaid-logo-text-white-background.png',
  },
  {
    source: 'plaid logo no text white background.png',
    target: 'plaid-logo-no-text-white-background.png',
  },
  {
    source: 'plaid logo no text black background.png',
    target: 'plaid-logo-no-text-black-background.png',
  },
];

// Delimiter that separates HTML from Playwright JSON in Claude's response
const PLAYWRIGHT_MARKER = '<!-- PLAYWRIGHT_SCRIPT_JSON -->';
const BUILD_QA_DIAG_FILE = path.join(OUT_DIR, 'build-qa-diagnostics.json');
const API_PANEL_QA_FILE = path.join(OUT_DIR, 'api-panel-qa.json');
const BUILD_LAYER_REPORT_FILE = path.join(OUT_DIR, 'build-layer-report.json');

/**
 * @param {Array<{ category?: string, severity?: string, stepId?: string }>} diagnostics
 */
function summarizeBuildQaDiagnostics(diagnostics) {
  const categoryCounts = {};
  const criticalStepIds = new Set();
  for (const d of diagnostics || []) {
    const c = d.category || 'uncategorized';
    categoryCounts[c] = (categoryCounts[c] || 0) + 1;
    if (d.severity === 'critical' && d.stepId) criticalStepIds.add(d.stepId);
  }
  return { categoryCounts, criticalStepIds: [...criticalStepIds] };
}

function isSlideLikeStep(step) {
  const sceneType = String(step?.sceneType || '').toLowerCase();
  if (sceneType) return sceneType === 'slide';
  const haystack = [step?.id, step?.label, step?.visualState].filter(Boolean).join(' ').toLowerCase();
  return /\bslide\b/.test(haystack) && !/\binsight\b/.test(haystack);
}

function isApiRelevantSlide(step) {
  if (!isSlideLikeStep(step)) return false;
  if (step?.apiResponse?.endpoint || step?.apiResponse?.response) return true;
  const haystack = [
    step?.id,
    step?.label,
    step?.visualState,
    step?.narration,
    step?.description,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(api|endpoint|json|report|insight|income|cra|base report)\b/.test(haystack);
}

function parseJsonFromText(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    try { return JSON.parse(fenced.trim()); } catch (_) {}
  }
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) {
    try { return JSON.parse(obj[0]); } catch (_) {}
  }
  return null;
}

function parseFeedbackMarkdown(raw) {
  const text = String(raw || '');
  const runMatch = text.match(/\bRun:\s*([^\n]+)/i);
  const runId = runMatch ? String(runMatch[1] || '').trim() : '';
  const globalMatch = text.match(/##\s+Global HTML Notes\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/i);
  const globalNotes = globalMatch ? String(globalMatch[1] || '').trim() : '';

  const perStep = {};
  const perStepSection = text.match(/##\s+Per-Step Visual Notes\s*\n([\s\S]*?)$/i);
  if (perStepSection && perStepSection[1]) {
    const body = perStepSection[1];
    const stepBlocks = body.split(/\n###\s+/).map((b) => b.trim()).filter(Boolean);
    for (const block of stepBlocks) {
      const nl = block.indexOf('\n');
      if (nl < 0) continue;
      const stepId = block.slice(0, nl).trim();
      const note = block.slice(nl + 1).trim();
      if (stepId && note) perStep[stepId] = note;
    }
  }
  return { runId, globalNotes, perStep };
}

function buildScopedHumanFeedback(raw, currentRunId, demoStepIds) {
  const parsed = parseFeedbackMarkdown(raw);
  const targetRun = String(currentRunId || '').trim();
  if (!parsed.runId) {
    return { text: null, reason: 'Feedback file is unbound (missing Run: header), ignored for safety.' };
  }
  if (parsed.runId !== targetRun) {
    return { text: null, reason: `Feedback run mismatch (feedback run=${parsed.runId}, current run=${targetRun}), ignored.` };
  }
  const validIds = new Set(Array.isArray(demoStepIds) ? demoStepIds : []);
  const filteredStepEntries = Object.entries(parsed.perStep || {})
    .filter(([stepId]) => validIds.has(stepId));
  const dropped = Object.keys(parsed.perStep || {}).length - filteredStepEntries.length;

  const lines = [];
  if (parsed.globalNotes) {
    lines.push('## Global HTML Notes');
    lines.push('');
    lines.push(parsed.globalNotes);
    lines.push('');
  }
  if (filteredStepEntries.length > 0) {
    lines.push('## Per-Step Visual Notes');
    lines.push('');
    for (const [stepId, note] of filteredStepEntries) {
      lines.push(`### ${stepId}`);
      lines.push('');
      lines.push(note);
      lines.push('');
    }
  }
  const out = lines.join('\n').trim();
  if (!out) {
    return { text: null, reason: 'No scoped feedback matched current run/step IDs.' };
  }
  const meta = dropped > 0 ? ` (dropped ${dropped} non-matching step note(s))` : '';
  return {
    text: out,
    reason: `Scoped feedback applied for run ${targetRun}${meta}.`,
  };
}

function isNonEmptyObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function buildAskBillApiSampleQuestion(step, productName, productFamily) {
  const endpoint = step?.apiResponse?.endpoint || '';
  const stepLabel = [step?.label, step?.id].filter(Boolean).join(' / ');
  return (
    `Provide a realistic Plaid sandbox JSON sample response for this demo step.\n` +
    `Product: ${productName || productFamily || 'Plaid'}\n` +
    `Step: ${stepLabel}\n` +
    (endpoint ? `Endpoint: ${endpoint}\n` : '') +
    `Requirements:\n` +
    `- Return JSON only (no markdown, no prose).\n` +
    `- Use fields that are valid for the endpoint and plausible values.\n` +
    `- Keep the payload concise (about 10-40 lines when pretty-printed).\n`
  );
}

async function hydrateApiSamplesForRelevantSlides(demoScript, productFamily) {
  const checks = [];
  const steps = demoScript.steps || [];
  let autoFilled = 0;

  for (const step of steps) {
    const relevant = isApiRelevantSlide(step);
    const endpoint = step?.apiResponse?.endpoint || null;
    const hasResponse = isNonEmptyObject(step?.apiResponse?.response);
    const row = {
      stepId: step?.id || '',
      relevant,
      endpoint,
      hadResponse: hasResponse,
      askBillUsed: false,
      filled: false,
      note: '',
    };
    if (!relevant || hasResponse) {
      checks.push(row);
      continue;
    }

    row.askBillUsed = true;
    try {
      const q = buildAskBillApiSampleQuestion(step, demoScript.product, productFamily);
      const answer = await askPlaidDocs(q);
      const parsed = parseJsonFromText(answer);
      if (isNonEmptyObject(parsed)) {
        step.apiResponse = step.apiResponse || {};
        step.apiResponse.response = parsed;
        row.filled = true;
        row.note = 'Filled from AskBill sample JSON.';
        autoFilled += 1;
      } else {
        row.note = 'AskBill returned non-JSON or empty content.';
      }
    } catch (err) {
      row.note = `AskBill request failed: ${err.message}`;
    }
    checks.push(row);
  }

  return {
    generatedAt: new Date().toISOString(),
    stage: 'build',
    autoFilledCount: autoFilled,
    checks,
  };
}

// ── Model config ──────────────────────────────────────────────────────────────

const ARCH_MODEL         = 'claude-opus-4-6';
const ARCH_MAX_TOKENS    = 1024;
const FRAMEWORK_MODEL    = 'claude-opus-4-6';
const FRAMEWORK_MAX_TOKENS = 1800;
const BUILD_MODEL        = 'claude-opus-4-6';
const BUILD_BUDGET_TOKENS = 12000;
const BUILD_MAX_TOKENS   = 32000;

// ── Live Plaid Link flag ──────────────────────────────────────────────────────
const PLAID_LINK_LIVE = process.env.PLAID_LINK_LIVE === 'true';
const LAYERED_BUILD_ENABLED = process.env.LAYERED_BUILD_ENABLED === 'true' || process.env.LAYERED_BUILD_ENABLED === '1';
const MOBILE_VISUAL_ENABLED = process.env.MOBILE_VISUAL_ENABLED === 'true' || process.env.MOBILE_VISUAL_ENABLED === '1';
const BUILD_VIEW_MODE = String(process.env.BUILD_VIEW_MODE || 'desktop').toLowerCase();

// ── Plaid Link capture screenshots ───────────────────────────────────────────
const PLAID_LINK_SCREENS_DIR = path.join(OUT_DIR, 'plaid-link-screens');

// ── Design plugin (assetlib) ──────────────────────────────────────────────────
const ASSETLIB_DIR     = path.join(PROJECT_ROOT, 'assetlib');
const ASSETLIB_HTML    = path.join(ASSETLIB_DIR, 'index.html');
const ASSETLIB_CSS     = path.join(ASSETLIB_DIR, 'plaid-link.css');

function loadDesignPlugin() {
  if (!fs.existsSync(ASSETLIB_HTML)) {
    console.log('[Build] Design plugin: assetlib/index.html not found — skipping');
    return { html: null, css: null };
  }
  const html = fs.readFileSync(ASSETLIB_HTML, 'utf8');
  const css  = fs.existsSync(ASSETLIB_CSS) ? fs.readFileSync(ASSETLIB_CSS, 'utf8') : '';
  console.log(`[Build] Design plugin loaded: assetlib/index.html (${Math.round(html.length / 1024)}KB), plaid-link.css (${Math.round(css.length / 1024)}KB)`);
  return { html, css };
}

function copyPlaidLogoAssetsToScratchRoot() {
  let copied = 0;
  const missing = [];
  for (const asset of PLAID_LOGO_ASSET_MAP) {
    const src = path.join(ASSETS_DIR, asset.source);
    const dest = path.join(SCRATCH_APP_DIR, asset.target);
    if (!fs.existsSync(src)) {
      missing.push(asset.source);
      continue;
    }
    try {
      fs.copyFileSync(src, dest);
      copied++;
    } catch (err) {
      console.warn(`[Build] Could not copy Plaid logo asset "${asset.source}": ${err.message}`);
    }
  }
  if (copied > 0) {
    console.log(`[Build] Copied ${copied} Plaid logo asset(s) to scratch-app root`);
  }
  if (missing.length > 0) {
    console.warn(`[Build] Missing Plaid logo assets in assets/: ${missing.join(', ')}`);
  }
}

// ── Brand profile loading ─────────────────────────────────────────────────────
const BRAND_DIR = path.join(PROJECT_ROOT, 'brand');

/**
 * Resolves and loads a brand profile JSON.
 *
 * Resolution order:
 *   1. --brand=<slug> CLI argument
 *   2. BRAND_PROFILE environment variable
 *   3. Auto-detect from demoScript.persona.company
 *   4. Returns null → prompt-templates uses PLAID_DEFAULT_BRAND inline
 *
 * @param {object|null} demoScript  Parsed demo-script.json, or null
 * @returns {object|null}
 */
function loadBrand(demoScript) {
  const brandArg = process.argv.find(a => a.startsWith('--brand='));
  const cliSlug  = brandArg ? brandArg.replace('--brand=', '').toLowerCase() : null;
  const envSlug  = process.env.BRAND_PROFILE ? process.env.BRAND_PROFILE.toLowerCase() : null;

  let autoSlug = null;
  if (demoScript && demoScript.persona && demoScript.persona.company) {
    autoSlug = demoScript.persona.company.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  const slug = cliSlug || envSlug || autoSlug;

  if (!slug || slug === 'plaid') {
    console.log('[Build] Brand: Plaid defaults');
    return null;
  }

  const profilePath = path.join(BRAND_DIR, `${slug}.json`);
  if (!fs.existsSync(profilePath)) {
    console.warn(`[Build] Brand profile not found: brand/${slug}.json — using Plaid defaults`);
    return null;
  }

  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    console.log(`[Build] Brand profile loaded: brand/${slug}.json (${profile.name}, mode: ${profile.mode})`);
    return profile;
  } catch (err) {
    console.warn(`[Build] Could not parse brand/${slug}.json: ${err.message} — using Plaid defaults`);
    return null;
  }
}

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const qaArg    = process.argv.find(a => a.startsWith('--qa='));
  const brandArg = process.argv.find(a => a.startsWith('--brand='));
  const viewModeArg = process.argv.find(a => a.startsWith('--view-mode='));
  const layeredArg = process.argv.includes('--layered-build');
  const mobileVisualArg = process.argv.includes('--mobile-visual');
  return {
    qaReportPath: qaArg    ? qaArg.replace('--qa=', '')    : null,
    brandSlug:    brandArg ? brandArg.replace('--brand=', '') : null,
    buildViewMode: viewModeArg ? viewModeArg.replace('--view-mode=', '').trim().toLowerCase() : null,
    layeredBuildEnabled: layeredArg,
    mobileVisualEnabled: mobileVisualArg,
  };
}

/**
 * Models sometimes emit click/fill rows for steps that have apiResponse insight data.
 * build-qa and recordings expect goToStep so the active step matches demo-script.json.
 */
function repairPlaywrightInsightNavigation(playwrightScript, demoScript) {
  const rows = playwrightScript?.steps;
  if (!Array.isArray(rows)) return;
  const insightIds = new Set(
    (demoScript.steps || [])
      .filter(s => s && s.apiResponse && /insight/i.test(s.id))
      .map(s => s.id)
  );
  let fixed = 0;
  for (const row of rows) {
    const id = row.stepId || row.id;
    if (!id || !insightIds.has(id)) continue;
    if (row.action === 'goToStep' && String(row.target || '').replace(/['"]/g, '') === id) continue;
    row.action = 'goToStep';
    row.target = id;
    fixed++;
  }
  if (fixed > 0) {
    console.log(`[Build] Repaired ${fixed} playwright row(s) to goToStep for insight steps`);
  }
}

function normalizeLaunchPlaywrightRow(playwrightScript, demoScript) {
  const rows = playwrightScript?.steps;
  if (!Array.isArray(rows)) return;
  const launch = (demoScript.steps || []).find((s) => s && s.plaidPhase === 'launch');
  if (!launch) return;
  const row = rows.find((r) => (r.stepId || r.id) === launch.id);
  if (!row) return;
  row.action = 'click';
  row.target = '[data-testid="link-external-account-btn"]';
  if (!row.waitMs || row.waitMs < 120000) row.waitMs = 120000;
}

function normalizeFinalSlidePlaywrightRow(playwrightScript, demoScript) {
  const rows = playwrightScript?.steps;
  if (!Array.isArray(rows) || !rows.length) return;
  const steps = demoScript.steps || [];
  const finalStep = steps[steps.length - 1];
  if (!finalStep) return;
  const isSlide = String(finalStep.sceneType || '').toLowerCase() === 'slide' || /slide/i.test(`${finalStep.id || ''} ${finalStep.label || ''}`);
  if (!isSlide) return;
  const row = rows.find((r) => (r.stepId || r.id) === finalStep.id);
  if (!row) return;
  row.action = 'goToStep';
  row.target = finalStep.id;
  if (!row.waitMs || row.waitMs < 3000) row.waitMs = 4000;
}

function ensureCanonicalLaunchCtaInHtml(html, demoScript) {
  if (!PLAID_LINK_LIVE) return { html, injected: false };
  const launch = (demoScript.steps || []).find((s) => s && s.plaidPhase === 'launch');
  if (!launch) return { html, injected: false };
  if (html.includes('data-testid="link-external-account-btn"')) {
    return { html, injected: false };
  }
  const stepDivRe = new RegExp(
    `(<div[^>]+data-testid="step-${launch.id}"[^>]*>[\\s\\S]*?)(<(?:button|a)(?:\\s[^>]*?)?)>`,
    'i'
  );
  const patched = html.replace(stepDivRe, (_m, pre, tagOpen) => {
    if (/data-testid=/i.test(tagOpen)) {
      return `${pre}${tagOpen.replace(/data-testid="[^"]*"/i, 'data-testid="link-external-account-btn"')}>`;
    }
    return `${pre}${tagOpen} data-testid="link-external-account-btn">`;
  });
  return { html: patched, injected: patched !== html };
}

function injectEmbeddedLinkRuntimeHandler(html, demoScript, linkModeAdapter) {
  if (!PLAID_LINK_LIVE || !linkModeAdapter || linkModeAdapter.id !== 'embedded') return { html, injected: false };
  if (!html.includes('data-testid="link-external-account-btn"') || !html.includes('</body>')) {
    return { html, injected: false };
  }
  if (html.includes('window.__embeddedLinkRuntimePatched')) return { html, injected: false };
  const launch = (demoScript.steps || []).find((s) => s && s.plaidPhase === 'launch');
  const launchStepId = launch?.id || null;
  const patch = `<script>
(function() {
  if (window.__embeddedLinkRuntimePatched) return;
  window.__embeddedLinkRuntimePatched = true;
  window.__plaidLinkMode = 'embedded';
  window.__embeddedLinkOpenAttempts = [];
  window.__embeddedLinkError = null;
  async function launchEmbeddedLink() {
    var payload = { linkMode: 'embedded', link_mode: 'embedded' };
    try {
      var res = await fetch('/api/create-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var txt = await res.text();
      var data = {};
      try { data = txt ? JSON.parse(txt) : {}; } catch (_) { data = { raw: txt }; }
      window.__embeddedLinkLastTokenResponse = { status: res.status, body: data };
      if (!res.ok) throw new Error((data && (data.error || data.error_message || data.display_message)) || ('HTTP ' + res.status));
      if (!data.link_token) throw new Error('Embedded Link token response missing link_token');
      if (!data.hosted_link_url) throw new Error('Embedded Link token response missing hosted_link_url');
      var opened = window.open(data.hosted_link_url, '_blank', 'noopener,noreferrer');
      window.__embeddedLinkOpenAttempts.push({ url: data.hosted_link_url, at: Date.now(), opened: !!opened });
      if (!opened) throw new Error('Popup blocked while opening hosted_link_url');
      window.__embeddedLinkOpened = true;
      ${launchStepId ? `if (typeof window.goToStep === 'function') window.goToStep('${launchStepId}');` : ''}
    } catch (err) {
      window.__embeddedLinkError = String((err && err.message) || err || 'embedded-link-launch-failed');
      console.error('Embedded Link launch failed:', window.__embeddedLinkError);
    }
  }
  document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-testid="link-external-account-btn"]') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    launchEmbeddedLink();
  }, true);
})();
</script>`;
  return { html: html.replace('</body>', `${patch}\n</body>`), injected: true };
}

// ── Response parsing ──────────────────────────────────────────────────────────

/**
 * Strips leading/trailing markdown fences from a string.
 * Handles ```html, ```json, ``` etc.
 */
function stripFences(text) {
  return text
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

function extractHtmlPartFromRaw(raw) {
  const markerIdx = raw.indexOf(PLAYWRIGHT_MARKER);
  if (markerIdx === -1) {
    throw new Error(
      `[Build] Response missing separator "${PLAYWRIGHT_MARKER}".\n` +
      `First 300 chars: ${raw.substring(0, 300)}`
    );
  }
  let htmlPart = raw.substring(0, markerIdx).trim();
  htmlPart = stripFences(htmlPart);
  if (!htmlPart.startsWith('<!DOCTYPE') && !htmlPart.startsWith('<html')) {
    const doctypeIdx = htmlPart.indexOf('<!DOCTYPE');
    const htmlIdx    = htmlPart.indexOf('<html');
    const startIdx   = doctypeIdx !== -1 ? doctypeIdx : (htmlIdx !== -1 ? htmlIdx : 0);
    htmlPart = htmlPart.substring(startIdx);
  }
  return htmlPart;
}

function extractPlaywrightJsonText(raw) {
  const markerIdx = raw.indexOf(PLAYWRIGHT_MARKER);
  if (markerIdx === -1) return '';
  const jsonPart = raw.substring(markerIdx + PLAYWRIGHT_MARKER.length).trim();
  return stripFences(jsonPart).replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
}

/**
 * Fixes common LLM mistakes before JSON.parse (invalid targets, trailing commas, smart quotes).
 */
function sanitizePlaywrightJsonText(s) {
  let t = String(s);
  t = t.replace(/[\u201c\u201d]/g, '"');
  // "target": "window.goToStep('step-id')" / goToStep("id") → bare step id (strict JSON)
  const unesc = (id) => String(id).replace(/\\(.)/g, '$1');
  t = t.replace(
    /"target"\s*:\s*"window\.goToStep\('([^'\\]*(?:\\.[^'\\]*)*)'\)"/g,
    (_m, id) => `"target": ${JSON.stringify(unesc(id))}`
  );
  t = t.replace(
    /"target"\s*:\s*"window\.goToStep\("([^"\\]*(?:\\.[^"\\]*)*)"\)"/g,
    (_m, id) => `"target": ${JSON.stringify(unesc(id))}`
  );
  t = t.replace(
    /"target"\s*:\s*"goToStep\('([^'\\]*(?:\\.[^'\\]*)*)'\)"/g,
    (_m, id) => `"target": ${JSON.stringify(unesc(id))}`
  );
  t = t.replace(
    /"target"\s*:\s*"goToStep\("([^"\\]*(?:\\.[^"\\]*)*)"\)"/g,
    (_m, id) => `"target": ${JSON.stringify(unesc(id))}`
  );
  t = t.replace(/,(\s*[\]}])/g, '$1');
  return t;
}

/**
 * When the model truncates mid-step, extract complete `{ ... }` step objects from the steps array.
 */
function recoverStepsFromPartialJson(text) {
  const key = '"steps"';
  const si = text.indexOf(key);
  if (si < 0) return null;
  const lb = text.indexOf('[', si + key.length);
  if (lb < 0) return null;
  const inner = text.slice(lb + 1);
  const steps = [];
  let i = 0;
  while (i < inner.length) {
    const objStart = inner.indexOf('{', i);
    if (objStart < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = objStart;
    let closed = false;
    for (; j < inner.length; j++) {
      const c = inner[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const chunk = inner.slice(objStart, j + 1);
          try {
            steps.push(JSON.parse(chunk));
          } catch (_) {
            /* skip malformed chunk */
          }
          closed = true;
          i = j + 1;
          while (i < inner.length && /[\s,\n\r]/.test(inner[i])) i++;
          break;
        }
      }
    }
    if (!closed) break;
  }
  if (steps.length === 0) return null;
  return { steps };
}

/**
 * Try to parse only the "steps" array (handles truncated outer JSON if array is complete).
 */
function tryParseStepsArrayOnly(text) {
  const key = '"steps"';
  const si = text.indexOf(key);
  if (si < 0) return null;
  const lb = text.indexOf('[', si + key.length);
  if (lb < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let q = '';
  for (let p = lb; p < text.length; p++) {
    const c = text[p];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      q = '"';
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        const inner = text.slice(lb, p + 1);
        try {
          const steps = JSON.parse(inner);
          if (Array.isArray(steps)) return { steps };
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

/** Normalize goToStep rows to bare step id (record-local accepts both; JSON is cleaner). */
function normalizePlaywrightGoToTargets(script) {
  const steps = script && script.steps;
  if (!Array.isArray(steps)) return;
  for (const row of steps) {
    if (!row || row.action !== 'goToStep' || row.target == null) continue;
    const t = String(row.target).trim();
    const m1 = t.match(/^window\.goToStep\((['"])((?:\\.|(?!\2).)*?)\2\)\s*$/);
    if (m1) {
      row.target = m1[2].replace(/\\(.)/g, '$1');
      continue;
    }
    const m2 = t.match(/^goToStep\((['"])((?:\\.|(?!\2).)*?)\2\)\s*$/);
    if (m2) row.target = m2[2].replace(/\\(.)/g, '$1');
  }
}

/**
 * @returns {{ playwrightScript: object } | null}
 */
function tryParsePlaywrightScript(playwrightRaw) {
  const variants = [playwrightRaw, sanitizePlaywrightJsonText(playwrightRaw)];
  for (const v of variants) {
    try {
      const o = JSON.parse(v);
      if (o && Array.isArray(o.steps)) return o;
    } catch (_) {}
    const greedy = v.match(/(\{[\s\S]*\})/);
    if (greedy) {
      try {
        const o = JSON.parse(greedy[1]);
        if (o && Array.isArray(o.steps)) return o;
      } catch (_) {}
    }
    const stepsOnly = tryParseStepsArrayOnly(v);
    if (stepsOnly) return stepsOnly;
    const recovered = recoverStepsFromPartialJson(v);
    if (recovered && recovered.steps.length > 0) {
      console.warn(
        `[Build] Recovered ${recovered.steps.length} complete playwright step object(s) from partial/truncated JSON.`
      );
      return recovered;
    }
  }
  return null;
}

/**
 * Splits the raw Claude response into HTML and Playwright JSON parts.
 * The response must contain PLAYWRIGHT_MARKER.
 *
 * @param {string} raw - Full response text from Claude
 * @returns {{ html: string, playwrightScript: object }}
 */
function parseAppResponse(raw, opts = {}) {
  const htmlPart = extractHtmlPartFromRaw(raw);
  const playwrightRaw = extractPlaywrightJsonText(raw);
  let playwrightScript = tryParsePlaywrightScript(playwrightRaw);

  if (!playwrightScript && opts.fallbackPlaywrightPath && fs.existsSync(opts.fallbackPlaywrightPath)) {
    try {
      playwrightScript = JSON.parse(fs.readFileSync(opts.fallbackPlaywrightPath, 'utf8'));
      if (playwrightScript && Array.isArray(playwrightScript.steps)) {
        console.warn(
          `[Build] Playwright JSON parse failed — reusing previous ${path.basename(opts.fallbackPlaywrightPath)} ` +
            '(new HTML still applied; verify step IDs match demo-script).'
        );
      } else {
        playwrightScript = null;
      }
    } catch (_) {
      playwrightScript = null;
    }
  }

  if (!playwrightScript) {
    const err = new Error(
      `[Build] Could not parse playwright-script.json after sanitization.\nRaw (first 800 chars):\n${playwrightRaw.substring(0, 800)}`
    );
    err.playwrightRaw = playwrightRaw;
    throw err;
  }

  normalizePlaywrightGoToTargets(playwrightScript);
  return { html: htmlPart, playwrightScript };
}

/**
 * Extracts the text content from a Claude response (handles both streaming
 * accumulated text and non-streaming content arrays).
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
  }
  return String(content);
}

// ── Claude calls ──────────────────────────────────────────────────────────────

/**
 * Call 1: Architecture brief (claude-sonnet-4-6, non-streaming, 1024 tokens).
 */
async function getArchitectureBrief(client, demoScript, briefOpts = {}) {
  console.log('[Build] Call 1: Generating architecture brief (claude-opus-4-6)...');

  const { system, userMessages } = buildAppArchitectureBriefPrompt(demoScript, {
    plaidLinkLive: PLAID_LINK_LIVE,
    plaidSkillBrief: briefOpts.plaidSkillBrief || '',
    plaidLinkMode: briefOpts.plaidLinkMode || 'modal',
    embeddedLinkSkillBrief: briefOpts.embeddedLinkSkillBrief || '',
  });

  const response = await client.messages.create({
    model:      ARCH_MODEL,
    max_tokens: ARCH_MAX_TOKENS,
    system,
    messages:   userMessages,
  });

  const brief = extractText(response.content);
  console.log('[Build] Architecture brief received');
  return brief;
}

/**
 * Optional layered-build call: produce a deterministic framework/data/polish contract.
 */
async function getFrameworkPlan(client, demoScript, architectureBrief, frameworkOpts = {}) {
  console.log('[Build] Call 1b: Generating layered framework plan...');
  const { system, userMessages } = buildAppFrameworkPlanPrompt(demoScript, architectureBrief, {
    mobileVisualEnabled: !!frameworkOpts.mobileVisualEnabled,
    buildViewMode: frameworkOpts.buildViewMode || 'desktop',
  });
  const response = await client.messages.create({
    model: FRAMEWORK_MODEL,
    max_tokens: FRAMEWORK_MAX_TOKENS,
    system,
    messages: userMessages,
  });
  const raw = extractText(response.content);
  try {
    const parsed = JSON.parse(raw);
    console.log('[Build] Layered framework plan received');
    return parsed;
  } catch (_) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      try {
        const parsed = JSON.parse(fenced.trim());
        console.log('[Build] Layered framework plan received (fenced JSON)');
        return parsed;
      } catch (_) {}
    }
  }
  console.warn('[Build] Layered framework plan was not valid JSON; continuing without structured layer plan');
  return null;
}

function validateLayerContracts({ html, playwrightScript, demoScript, mobileVisualEnabled }) {
  const layer1Issues = [];
  const layer2Issues = [];
  const layer3Issues = [];
  const stepIds = (demoScript.steps || []).map((s) => s.id);
  const pwRows = (playwrightScript && Array.isArray(playwrightScript.steps)) ? playwrightScript.steps : [];

  for (const stepId of stepIds) {
    const stepDivRx = new RegExp(`<div[^>]+data-testid="step-${stepId}"[^>]+class="[^"]*\\bstep\\b`, 'i');
    if (!stepDivRx.test(html)) {
      layer1Issues.push(`Missing step container: step-${stepId}`);
    }
  }
  if (!html.includes('window.goToStep')) layer1Issues.push('Missing window.goToStep');
  if (!html.includes('window.getCurrentStep')) layer1Issues.push('Missing window.getCurrentStep');
  if (!html.includes('id="api-response-panel"')) layer1Issues.push('Missing api-response-panel shell');
  if (!html.includes('id="link-events-panel"')) layer1Issues.push('Missing link-events-panel shell');

  for (const row of pwRows) {
    if (!row || !row.id || !stepIds.includes(row.id)) {
      layer2Issues.push(`Playwright row has unknown id: ${row && row.id ? row.id : '<missing>'}`);
    }
  }
  if (!pwRows.length) layer2Issues.push('Playwright script contains zero steps');
  if (PLAID_LINK_LIVE && !html.includes('data-testid="link-external-account-btn"')) {
    layer2Issues.push('Missing canonical Plaid launch CTA data-testid="link-external-account-btn"');
  }

  if (!html.includes('renderjson.min.js')) {
    layer3Issues.push('Missing renderjson viewer script');
  }
  if (mobileVisualEnabled && !html.includes('mobile-simulator-shell')) {
    layer3Issues.push('Mobile visual mode enabled but no mobile-simulator-shell marker found');
  }

  return {
    layer1Framework: { passed: layer1Issues.length === 0, issues: layer1Issues },
    layer2DataInteraction: { passed: layer2Issues.length === 0, issues: layer2Issues },
    layer3VisualPolish: { passed: layer3Issues.length === 0, issues: layer3Issues },
    overallPassed: layer1Issues.length === 0 && layer2Issues.length === 0 && layer3Issues.length === 0,
  };
}

/**
 * Call 2: Full app generation (claude-opus-4-6, streaming, extended thinking).
 * Streams progress dots to stdout.
 */
async function generateApp(client, demoScript, architectureBrief, qaReport, brand, refinementOpts = {}) {
  console.log('[Build] Call 2: Generating full HTML app (claude-opus-4-6 streaming)...');
  console.log('[Build] Progress: ');

  const designPlugin = loadDesignPlugin();
  const slideRulesPath = path.join(PROJECT_ROOT, 'templates/slide-template/SLIDE_RULES.md');
  const slideCssPath = path.join(PROJECT_ROOT, 'templates/slide-template/slide.css');
  const layerMockTemplatePath = path.join(PROJECT_ROOT, 'templates/mobile-layer-mock/LAYER_MOCK_TEMPLATE.md');
  let slideTemplateRules = '';
  let slideTemplateCss = '';
  let layerMockTemplate = '';
  try {
    if (fs.existsSync(slideRulesPath)) slideTemplateRules = fs.readFileSync(slideRulesPath, 'utf8');
    if (fs.existsSync(slideCssPath)) slideTemplateCss = fs.readFileSync(slideCssPath, 'utf8');
    if (fs.existsSync(layerMockTemplatePath)) layerMockTemplate = fs.readFileSync(layerMockTemplatePath, 'utf8');
  } catch (e) {
    console.warn('[Build] Warning: could not load slide template assets:', e.message);
  }
  const { system: buildSystem, userMessages: buildMessages } = buildAppGenerationPrompt(
    demoScript, architectureBrief, qaReport,
    {
      plaidLinkLive:      PLAID_LINK_LIVE,
      plaidLinkScreens:   refinementOpts.plaidLinkScreens || [],
      designPluginHtml:   designPlugin.html,
      designPluginCss:    designPlugin.css,
      brand,
      slideTemplateRules,
      slideTemplateCss,
      layerMockTemplate,
      qaFrames:           refinementOpts.qaFrames   || [],
      prevTestids:        refinementOpts.prevTestids || [],
      humanFeedback:      refinementOpts.humanFeedback || '',
      productFamily:      refinementOpts.productFamily || 'generic',
      curatedProductKnowledge: refinementOpts.curatedProductKnowledge || null,
      curatedDigest:      refinementOpts.curatedDigest || null,
      pipelineRunContext: refinementOpts.pipelineRunContext || null,
      solutionsMasterContext: refinementOpts.solutionsMasterContext || null,
      buildQaDiagnosticSummary: refinementOpts.buildQaDiagnosticSummary || null,
      plaidSkillMarkdown: refinementOpts.plaidSkillMarkdown || '',
      plaidLinkUxSkillMarkdown: refinementOpts.plaidLinkUxSkillMarkdown || '',
      layeredBuildEnabled: !!refinementOpts.layeredBuildEnabled,
      layeredBuildPlan: refinementOpts.layeredBuildPlan || null,
      mobileVisualEnabled: !!refinementOpts.mobileVisualEnabled,
      buildViewMode: refinementOpts.buildViewMode || 'desktop',
    }
  );

  const stream = await client.messages.stream({
    model:      BUILD_MODEL,
    max_tokens: BUILD_MAX_TOKENS,
    thinking: {
      type:          'enabled',
      budget_tokens: BUILD_BUDGET_TOKENS,
    },
    system:   buildSystem,
    messages: buildMessages,
  });

  let fullText = '';
  let chunkCount = 0;

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      fullText += event.delta.text;
      chunkCount++;
      // Print a dot every 10 chunks to show progress without flooding stdout
      if (chunkCount % 10 === 0) {
        process.stdout.write('.');
      }
    }
  }

  process.stdout.write('\n');
  console.log(`[Build] Generation complete (${fullText.length} chars)`);

  return fullText;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(opts = {}) {
  // Accept qaReportFile from orchestrator, fall back to CLI args
  const parsedArgs = parseArgs();
  const { qaReportPath: cliQaPath } = parsedArgs;
  const qaReportPath = opts.qaReportFile || cliQaPath;
  const layeredBuildEnabled = opts.layeredBuildEnabled != null
    ? !!opts.layeredBuildEnabled
    : (parsedArgs.layeredBuildEnabled || LAYERED_BUILD_ENABLED);
  const mobileVisualEnabled = opts.mobileVisualEnabled != null
    ? !!opts.mobileVisualEnabled
    : (parsedArgs.mobileVisualEnabled || MOBILE_VISUAL_ENABLED);
  const buildViewMode = (opts.buildViewMode || parsedArgs.buildViewMode || BUILD_VIEW_MODE || 'desktop').toLowerCase();

  // Validate inputs
  if (!fs.existsSync(SCRIPT_FILE)) {
    console.error('[Build] Missing: out/demo-script.json — run generate-script.js first');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[Build] Missing ANTHROPIC_API_KEY in environment');
    process.exit(1);
  }

  const demoScript = JSON.parse(fs.readFileSync(SCRIPT_FILE, 'utf8'));
  console.log(`[Build] Loaded demo-script.json: ${demoScript.steps.length} steps for "${demoScript.product}"`);
  console.log(`[Build] Layered build: ${layeredBuildEnabled ? 'ENABLED' : 'disabled'}`);
  console.log(`[Build] Mobile visual mode: ${mobileVisualEnabled ? 'ENABLED' : 'disabled'} (viewMode=${buildViewMode})`);
  const promptText = fs.existsSync(PROMPT_FILE) ? fs.readFileSync(PROMPT_FILE, 'utf8') : '';
  const plaidLinkMode = resolveMode({ demoScript, promptText });
  const linkModeAdapter = getLinkModeAdapter(plaidLinkMode);
  demoScript.plaidLinkMode = plaidLinkMode;
  console.log(`[Build] Plaid Link mode: ${plaidLinkMode}`);
  const productFamily = inferProductFamily({ promptText, demoScript });
  const apiPanelQa = await hydrateApiSamplesForRelevantSlides(demoScript, productFamily);
  try {
    fs.writeFileSync(API_PANEL_QA_FILE, JSON.stringify(apiPanelQa, null, 2));
    if (apiPanelQa.autoFilledCount > 0) {
      console.log(`[Build] API panel QA: auto-filled ${apiPanelQa.autoFilledCount} relevant slide API sample(s) from AskBill`);
    } else {
      console.log('[Build] API panel QA: no missing relevant slide API samples detected');
    }
  } catch (e) {
    console.warn(`[Build] Could not write api-panel-qa.json: ${e.message}`);
  }
  const curatedProductKnowledge = buildCuratedProductKnowledge(productFamily);
  const curatedDigest = buildCuratedDigest(curatedProductKnowledge);
  const pipelineRunContext = readPipelineRunContext(OUT_DIR);
  let solutionsMasterContext = null;
  if (fs.existsSync(RESEARCH_FILE)) {
    try {
      const research = JSON.parse(fs.readFileSync(RESEARCH_FILE, 'utf8'));
      if (research && research.solutionsMasterContext && typeof research.solutionsMasterContext === 'object') {
        solutionsMasterContext = research.solutionsMasterContext;
      }
    } catch (e) {
      console.warn(`[Build] Could not parse product-research.json for Solutions Master context: ${e.message}`);
    }
  }
  let buildQaDiagnosticSummary = null;
  if (fs.existsSync(BUILD_QA_DIAG_FILE)) {
    try {
      const dq = JSON.parse(fs.readFileSync(BUILD_QA_DIAG_FILE, 'utf8'));
      buildQaDiagnosticSummary = dq.summary && dq.summary.categoryCounts
        ? {
          categoryCounts: dq.summary.categoryCounts,
          criticalStepIds: dq.summary.criticalStepIds || [],
        }
        : summarizeBuildQaDiagnostics(dq.diagnostics);
      if (Object.keys(buildQaDiagnosticSummary.categoryCounts || {}).length) {
        console.log('[Build] Loaded build-qa-diagnostics.json summary for prompt context');
      }
    } catch (e) {
      console.warn(`[Build] Could not parse build-qa-diagnostics.json: ${e.message}`);
    }
  }
  console.log(`[Build] Product family: ${productFamily}`);

  const skillBundle = getPlaidSkillBundleForFamily(productFamily, { promptText, demoScript });
  if (skillBundle.skillLoaded) {
    console.log(
      `[Build] Plaid integration skill: ${skillBundle.members.length} excerpt(s) for prompts`
    );
  }
  const linkUxSkillBundle = getPlaidLinkUxSkillBundle({ promptText, demoScript });
  const embeddedLinkSkillBundle = getEmbeddedLinkSkillBundle({ promptText, demoScript });
  if (linkUxSkillBundle.skillLoaded) {
    console.log(`[Build] Plaid Link UX skill: loaded (${linkUxSkillBundle.flowType} flow)`);
  }
  if (embeddedLinkSkillBundle.skillLoaded) {
    console.log('[Build] Embedded Link skill: loaded');
  }
  writePlaidLinkUxSkillManifest(OUT_DIR, {
    stage: 'build',
    flowType: linkUxSkillBundle.flowType,
    markdownPath: linkUxSkillBundle.markdownPath,
    skillLoaded: linkUxSkillBundle.skillLoaded,
    chars: linkUxSkillBundle.chars,
  });

  // Validate Plaid credentials when live mode is enabled (requires productFamily above)
  if (PLAID_LINK_LIVE) {
    const isCraFamily = productFamily === 'cra_base_report' || productFamily === 'income_insights';
    const hasDefaultCreds = !!process.env.PLAID_CLIENT_ID && !!process.env.PLAID_SANDBOX_SECRET;
    const hasCraCreds = !!process.env.CRA_CLIENT_ID && !!process.env.CRA_SECRET;
    if ((!isCraFamily && !hasDefaultCreds) || (isCraFamily && !(hasCraCreds || hasDefaultCreds))) {
      console.error(
        isCraFamily
          ? '[Build] CRA-family live mode requires CRA_CLIENT_ID and CRA_SECRET (or fallback default Plaid creds) in .env'
          : '[Build] PLAID_LINK_LIVE=true but missing PLAID_CLIENT_ID or PLAID_SANDBOX_SECRET in .env'
      );
      process.exit(1);
    }
    console.log('[Build] Plaid Link mode: LIVE (sandbox) — will generate app with real Plaid Link SDK');
  } else {
    console.log('[Build] Plaid Link mode: MOCK (self-contained HTML)');
  }

  // Load brand profile (auto-detects from persona.company, --brand=, or BRAND_PROFILE env)
  const brand = loadBrand(demoScript);

  // Load optional QA report + associated frame images for refinement context
  let qaReport    = null;
  let qaFrames    = [];   // base64 PNG frames for failed steps (visual context for build agent)
  let prevTestids = [];   // data-testid inventory from previous build (structural context)

  if (qaReportPath) {
    const resolvedQaPath = path.isAbsolute(qaReportPath)
      ? qaReportPath
      : path.join(PROJECT_ROOT, qaReportPath);
    if (fs.existsSync(resolvedQaPath)) {
      try {
        qaReport = JSON.parse(fs.readFileSync(resolvedQaPath, 'utf8'));
        console.log(`[Build] Loaded QA report: ${resolvedQaPath} (score: ${qaReport.overallScore}/100)`);

        // Load QA frame images for steps that failed — visual context for the build agent.
        // Without frames, the agent is fixing visual problems from a text description alone.
        const framesDir   = path.join(OUT_DIR, 'qa-frames');
        const failedSteps = (qaReport.stepsWithIssues || []).map(s => s.stepId);
        if (failedSteps.length > 0 && fs.existsSync(framesDir)) {
          if (failedSteps.length > 8) {
            console.warn(`[Build] WARNING: ${failedSteps.length} failed steps but only 8 included in refinement context — subsequent passes needed`);
          }
          for (const stepId of failedSteps.slice(0, 8)) { // cap to limit token budget
            for (const suffix of ['start', 'mid']) {
              const framePath = path.join(framesDir, `${stepId}-${suffix}.png`);
              if (fs.existsSync(framePath)) {
                try {
                  const base64 = fs.readFileSync(framePath).toString('base64');
                  qaFrames.push({ stepId, suffix, base64 });
                } catch (_) {}
              }
            }
          }
          console.log(`[Build] Loaded ${qaFrames.length} QA frame(s) for refinement visual context (${failedSteps.length} failed steps)`);
        }

        // Extract data-testid inventory from previous HTML for structural context.
        // Gives the agent a quick reference to what it previously built without
        // including the full ~8KB HTML in the prompt.
        if (fs.existsSync(HTML_OUT)) {
          try {
            const prevHtml = fs.readFileSync(HTML_OUT, 'utf8');
            const matches  = [...prevHtml.matchAll(/data-testid="([^"]+)"/g)];
            prevTestids    = [...new Set(matches.map(m => m[1]))];
            console.log(`[Build] Previous build: ${prevTestids.length} unique data-testid attributes`);
          } catch (_) {}
        }
      } catch (err) {
        console.warn(`[Build] Warning: could not parse QA report: ${err.message}`);
      }
    } else {
      console.warn(`[Build] Warning: QA report not found at ${resolvedQaPath}`);
    }
  }

  // ── Load human reviewer feedback (optional) ──────────────────────────────
  let humanFeedback = null;
  const feedbackSources = [RUN_FEEDBACK_FILE, FEEDBACK_FILE];
  const currentRunId = path.basename(OUT_DIR);
  for (const sourcePath of feedbackSources) {
    if (!fs.existsSync(sourcePath)) continue;
    try {
      const rawFeedback = fs.readFileSync(sourcePath, 'utf8').trim();
      if (!rawFeedback) continue;
      const scoped = buildScopedHumanFeedback(
        rawFeedback,
        currentRunId,
        (demoScript.steps || []).map((s) => s.id)
      );
      if (!scoped.text) {
        console.log(`[Build] Human feedback skipped (${path.relative(PROJECT_ROOT, sourcePath)}): ${scoped.reason}`);
        continue;
      }
      humanFeedback = scoped.text;
      const lineCount = humanFeedback.split('\n').length;
      console.log(`[Build] Human feedback loaded: ${path.relative(PROJECT_ROOT, sourcePath)} (${lineCount} lines)`);
      console.log(`[Build] ${scoped.reason}`);
      console.log('[Build] ⭐ Human feedback will be injected as highest-priority guidance');
      break;
    } catch (err) {
      console.warn(`[Build] Could not read ${path.relative(PROJECT_ROOT, sourcePath)}: ${err.message}`);
    }
  }

  // ── Plaid Link capture screenshots — DISABLED ─────────────────────────────
  // plaid-link-capture stage is disabled; Plaid Link recorded via Playwright directly.
  // To restore: uncomment this block and re-enable the stage in orchestrator.js STAGES.
  /*
  let plaidLinkScreens = [];
  if (PLAID_LINK_LIVE && fs.existsSync(path.join(PLAID_LINK_SCREENS_DIR, 'manifest.json'))) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(PLAID_LINK_SCREENS_DIR, 'manifest.json'), 'utf8')
      );
      for (const stepId of (manifest.steps || [])) {
        const imgPath = path.join(PLAID_LINK_SCREENS_DIR, `${stepId}.png`);
        if (fs.existsSync(imgPath)) {
          const base64 = fs.readFileSync(imgPath).toString('base64');
          plaidLinkScreens.push({ stepId, base64 });
        }
      }
      console.log(
        `[Build] Loaded ${plaidLinkScreens.length} Plaid Link capture screenshot(s) ` +
        `(flow: ${manifest.flowType}) — will generate simulated step divs`
      );
    } catch (err) {
      console.warn(`[Build] Could not load Plaid Link capture screenshots: ${err.message}`);
    }
  }
  */
  const plaidLinkScreens = [];

  fs.mkdirSync(SCRATCH_APP_DIR, { recursive: true });
  copyPlaidLogoAssetsToScratchRoot();

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // ── Call 1: Architecture brief ────────────────────────────────────────────
  const architectureBrief = await getArchitectureBrief(client, demoScript, {
    plaidSkillBrief: skillBundle.skillLoaded ? skillBundle.text.slice(0, 12000) : '',
    plaidLinkMode,
    embeddedLinkSkillBrief: embeddedLinkSkillBundle.skillLoaded ? embeddedLinkSkillBundle.text.slice(0, 6000) : '',
  });

  // ── Call 1b: Optional layered framework contract ──────────────────────────
  let layeredBuildPlan = null;
  if (layeredBuildEnabled) {
    layeredBuildPlan = await getFrameworkPlan(client, demoScript, architectureBrief, {
      mobileVisualEnabled,
      buildViewMode,
    });
  }

  // ── Call 2: Full app generation (streaming) ───────────────────────────────
  const rawResponse = await generateApp(client, demoScript, architectureBrief, qaReport, brand,
    {
      qaFrames,
      prevTestids,
      humanFeedback,
      plaidLinkScreens,
      productFamily,
      curatedProductKnowledge,
      curatedDigest,
      pipelineRunContext,
      solutionsMasterContext,
      buildQaDiagnosticSummary,
      plaidSkillMarkdown: skillBundle.skillLoaded ? skillBundle.text : '',
      plaidLinkUxSkillMarkdown: linkUxSkillBundle.skillLoaded ? linkUxSkillBundle.text : '',
      embeddedLinkSkillMarkdown: embeddedLinkSkillBundle.skillLoaded ? embeddedLinkSkillBundle.text : '',
      plaidLinkMode,
      layeredBuildEnabled,
      layeredBuildPlan,
      mobileVisualEnabled,
      buildViewMode,
    });

  // ── Parse response ────────────────────────────────────────────────────────
  let html, playwrightScript;
  try {
    ({ html, playwrightScript } = parseAppResponse(rawResponse, {
      fallbackPlaywrightPath: fs.existsSync(PLAYWRIGHT_OUT) ? PLAYWRIGHT_OUT : null,
    }));
  } catch (err) {
    console.error(err.message);
    // Save raw response for debugging
    const debugPath = path.join(OUT_DIR, 'build-app-raw-response.txt');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(debugPath, rawResponse);
    console.error(`[Build] Raw response saved to ${debugPath} for debugging`);
    process.exit(1);
  }

  // Truncated model output may yield fewer playwright rows than demo-script steps — splice tail from previous file.
  {
    const need = demoScript.steps.length;
    const have = (playwrightScript.steps || []).length;
    if (have < need && fs.existsSync(PLAYWRIGHT_OUT)) {
      try {
        const prev = JSON.parse(fs.readFileSync(PLAYWRIGHT_OUT, 'utf8'));
        const ps = prev && prev.steps;
        if (Array.isArray(ps) && ps.length >= need) {
          const merged = playwrightScript.steps.slice();
          for (let i = merged.length; i < need; i++) merged.push(ps[i]);
          playwrightScript = { steps: merged };
          console.warn(
            `[Build] Playwright steps: merged ${have} new row(s) + ${need - have} from previous build (truncated JSON recovery).`
          );
        }
      } catch (_) {}
    }
  }

  repairPlaywrightInsightNavigation(playwrightScript, demoScript);
  normalizeLaunchPlaywrightRow(playwrightScript, demoScript);
  normalizeFinalSlidePlaywrightRow(playwrightScript, demoScript);

  const layerReport = validateLayerContracts({
    html,
    playwrightScript,
    demoScript,
    mobileVisualEnabled,
  });
  try {
    fs.writeFileSync(BUILD_LAYER_REPORT_FILE, JSON.stringify({
      generatedAt: new Date().toISOString(),
      layeredBuildEnabled,
      mobileVisualEnabled,
      buildViewMode,
      layeredBuildPlan,
      validation: layerReport,
    }, null, 2));
    if (layeredBuildEnabled) {
      const l1 = layerReport.layer1Framework.issues.length;
      const l2 = layerReport.layer2DataInteraction.issues.length;
      const l3 = layerReport.layer3VisualPolish.issues.length;
      console.log(`[Build] Layered contract report written: L1 issues=${l1}, L2 issues=${l2}, L3 issues=${l3}`);
    }
  } catch (e) {
    console.warn(`[Build] Could not write build-layer-report.json: ${e.message}`);
  }

  // ── Validate DOM contract ──────────────────────────────────────────────────
  // These are hard errors — a contract violation means the recording will fail.
  const domErrors = [];

  // 1. Every step in demo-script.json must have a corresponding step div.
  //    When PLAID_LINK_LIVE=true WITHOUT capture screenshots: skip Plaid Link sim steps
  //    (the real SDK iframe handles them; no host-page divs are needed).
  //    When PLAID_LINK_LIVE=true WITH capture screenshots: the build agent IS expected to
  //    generate simulated step divs (using the captured screenshots as reference), so we
  //    validate all steps including Plaid Link ones.
  const PLAID_SIM_STEP_PATTERN = /^link[-_](?:consent|otp|account[-_]select|success)$/i;
  const stepIds = demoScript.steps.map(s => s.id);
  // When PLAID_LINK_LIVE=true, skip Plaid Link sim step validation — record-local.js handles
  // these steps via real iframe CDP automation; no host-page divs are required.
  const stepsToCheck = PLAID_LINK_LIVE
    ? stepIds.filter(id => !PLAID_SIM_STEP_PATTERN.test(id))
    : stepIds;
  const missingSteps = stepsToCheck.filter((id) => {
    const stepDivRx = new RegExp(`<div[^>]+data-testid="step-${id}"[^>]+class="[^"]*\\bstep\\b`, 'i');
    return !stepDivRx.test(html);
  });
  if (missingSteps.length > 0) {
    domErrors.push(`Missing data-testid for steps: ${missingSteps.join(', ')}`);
  }
  if (PLAID_LINK_LIVE) {
    const skippedSimSteps = stepIds.filter(id => PLAID_SIM_STEP_PATTERN.test(id));
    if (skippedSimSteps.length > 0) {
      console.log(`[Build] Skipping Plaid simulation steps (PLAID_LINK_LIVE=true): ${skippedSimSteps.join(', ')}`);
    }
  }

  // 2. Navigation functions must exist (record-local.js calls them on every step).
  // If missing, inject a safe fallback implementation from the step DOM contract.
  const hasGoToStep = html.includes('window.goToStep');
  const hasGetCurrentStep = html.includes('window.getCurrentStep');
  if ((!hasGoToStep || !hasGetCurrentStep) && html.includes('</body>')) {
    const navPatch = `<script>
(function() {
  if (typeof window.goToStep !== 'function') {
    window.goToStep = function(id) {
      var sid = String(id || '').replace(/^step-/, '');
      var steps = document.querySelectorAll('.step[data-testid]');
      for (var i = 0; i < steps.length; i++) steps[i].classList.remove('active');
      var target = document.querySelector('[data-testid="step-' + sid + '"]');
      if (!target) return;
      target.classList.add('active');
      if (window._stepLinkEvents && window._stepLinkEvents[sid]) {
        window._stepLinkEvents[sid].forEach(function(e){
          if (window.addLinkEvent) window.addLinkEvent(e.eventName, e.metadata);
        });
      }
      if (window._stepApiResponses && window._stepApiResponses[sid] && typeof window.updateApiResponse === 'function') {
        window.updateApiResponse(window._stepApiResponses[sid]);
      }
    };
  }
  if (typeof window.getCurrentStep !== 'function') {
    window.getCurrentStep = function() {
      return document.querySelector('.step.active')?.dataset?.testid || '';
    };
  }
})();
</script>`;
    html = html.replace('</body>', `${navPatch}\n</body>`);
    console.log('[Build] Injected fallback goToStep/getCurrentStep contract');
  }
  if (!html.includes('window.goToStep')) {
    domErrors.push('window.goToStep not found in generated HTML');
  }
  if (!html.includes('window.getCurrentStep')) {
    domErrors.push('window.getCurrentStep not found in generated HTML');
  }

  // 2b. API panel contract: if any step has apiResponse data, the global panel chrome
  // must exist so build-qa, manual preview, and recording can all surface the same JSON rail.
  const stepsWithApiData = (demoScript.steps || []).filter(s => s.apiResponse?.response);
  if (stepsWithApiData.length > 0) {
    const hasPanel =
      html.includes('id="api-response-panel"') || html.includes("id='api-response-panel'");
    const hasContent =
      html.includes('id="api-response-content"') ||
      html.includes("id='api-response-content'") ||
      html.includes('data-testid="api-response-content"');
    if (hasPanel && !hasContent) {
      html = html.replace(
        /(<div[^>]*\bid\s*=\s*["']api-response-panel["'][^>]*>)/i,
        '$1<div id="api-response-content" data-testid="api-response-content"></div>'
      );
      console.log('[Build] Injected missing #api-response-content inside api-response-panel');
    }
    if (!html.includes('id="api-response-panel"') && !html.includes("id='api-response-panel'")) {
      domErrors.push('Global api-response-panel not found in generated HTML.');
    }
    if (
      !html.includes('id="api-response-content"') &&
      !html.includes("id='api-response-content'") &&
      !html.includes('data-testid="api-response-content"')
    ) {
      domErrors.push('Global api-response-content not found in generated HTML.');
    }
    if (
      html.includes('data-testid="api-panel-toggle"') ||
      html.includes("data-testid='api-panel-toggle'") ||
      html.includes('id="api-panel-toggle"') ||
      html.includes("id='api-panel-toggle'")
    ) {
      console.log('[Build] Found legacy API JSON toggle control — will disable to keep JSON always visible when panel is shown');
    }

    // Enforce one canonical raw JSON rail. Any extra inline JSON panel containers in step
    // layouts are contract violations that create repetitive QA churn.
    const forbiddenInlineJsonPanelMatches = [
      ...html.matchAll(/<(?:div|aside|section)[^>]*\b(?:id|class)\s*=\s*["'][^"']*(?:json-panel|insight-right|auth-json-panel|api-json-panel|raw-json)[^"']*["'][^>]*>/gi),
    ]
      .map(m => m[0])
      .filter(tag => !/api-response-panel|api-response-content/i.test(tag));
    if (forbiddenInlineJsonPanelMatches.length > 0) {
      const example = forbiddenInlineJsonPanelMatches[0].slice(0, 140);
      domErrors.push(`Found duplicate inline raw JSON panel markup. Use only #api-response-panel. Example: ${example}`);
    }
  }
  // Detect malformed "function {" (no name, no params) — a JS syntax error that prevents
  // the entire inline <script> from executing. This makes window.goToStep undefined at
  // runtime even though it appears to exist in the source HTML.
  if (/\bfunction\s*\{/.test(html)) {
    domErrors.push('Malformed anonymous function "function {" found in script — JS syntax error will prevent window.goToStep from loading at runtime');
  }

  // 3. Duplicate data-testid attributes cause Playwright strict-mode errors.
  // Auto-fix: if the duplicated testid is NOT an interaction target (recording never clicks it),
  // strip the testid from the 2nd+ occurrences. Navigation links, sidebar headers, and shared
  // structural elements fall into this category — the recording calls goToStep() directly.
  const interactionTargetSet = new Set(
    (demoScript.steps || []).map(s => s.interaction?.target).filter(Boolean)
  );
  // IMPORTANT: only count real DOM attributes, not JS selector strings in <script>.
  const htmlForTestidScan = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const testidMatches = [...htmlForTestidScan.matchAll(/data-testid="([^"]+)"/g)];
  const testidCounts = {};
  for (const m of testidMatches) {
    testidCounts[m[1]] = (testidCounts[m[1]] || 0) + 1;
  }
  const dupeTestids = Object.entries(testidCounts)
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (dupeTestids.length > 0) {
    const stepContainerIds = new Set((stepsToCheck || []).map((id) => `step-${id}`));
    const protectedStepDupes = dupeTestids.filter((id) => stepContainerIds.has(id));
    if (protectedStepDupes.length > 0) {
      domErrors.push(
        `Duplicate step container data-testid detected: ${protectedStepDupes.join(', ')}. ` +
        `Step IDs must be unique and cannot be auto-renamed.`
      );
    }
    // Separate into auto-fixable (not a recording target) vs hard errors
    const mutableDupes = dupeTestids.filter((id) => !stepContainerIds.has(id));
    const fixableDupes = mutableDupes.filter(id => !interactionTargetSet.has(id));
    const hardDupes    = mutableDupes.filter(id =>  interactionTargetSet.has(id));

    // Auto-fix ALL duplicates: keep first occurrence, rename the rest.
    // For interaction targets this is still safe — the recording clicks the first (usually
    // the global nav element), which is the one that stays. Any duplicate in a step div
    // gets renamed to prevent Playwright strict-mode errors.
    const allDupes = [...fixableDupes, ...hardDupes];
    if (allDupes.length > 0) {
      for (const dupeId of allDupes) {
        let seen = 0;
        html = html.replace(new RegExp(`\\bdata-testid="${dupeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g'), () => {
          seen++;
          return seen === 1 ? `data-testid="${dupeId}"` : `data-testid="${dupeId}-dup${seen}"`;
        });
      }
      if (hardDupes.length > 0) {
        console.warn(`[Build] Auto-deduped interaction target testid(s) — recording uses first occurrence: ${hardDupes.join(', ')}`);
      }
      if (fixableDupes.length > 0) {
        console.log(`[Build] Auto-deduped ${fixableDupes.length} non-target testid(s): ${fixableDupes.join(', ')}`);
      }
    }
  }

  // 4. Step divs must NOT have inline style="display:..." — this permanently overrides
  //    .step visibility and makes the step visible on all other steps' video frames.
  //    (Pattern matches class="step" or data-testid="step-..." with a display style)
  const stepDisplayStyle = html.match(/data-testid="step-[^"]*"[^>]*style="[^"]*display\s*:/);
  if (stepDisplayStyle) {
    domErrors.push(
      'A step div has inline style with "display:" — this overrides .step.active visibility. ' +
      'Remove all inline display styles from step divs.'
    );
  }

  // 5. Every interaction.target in demo-script.json must have a matching data-testid in HTML.
  //    When PLAID_LINK_LIVE=true, skip interaction targets from Plaid simulation steps.
  const stepsForTargets = PLAID_LINK_LIVE
    ? demoScript.steps.filter(s => !PLAID_SIM_STEP_PATTERN.test(s.id))
    : demoScript.steps;
  const interactionTargets = stepsForTargets
    .map(s => s.interaction?.target)
    .filter(t => t && t !== 'none' && t !== 'n/a' && t !== '' && t !== null);
  const missingTargets = [...new Set(
    interactionTargets.filter(t => !html.includes(`data-testid="${t}"`))
  )];
  if (missingTargets.length > 0) {
    // Auto-fix: inject missing testids onto the first interactive element in each step's div.
    // Avoids hard-exit when LLM uses a different name for an otherwise-correct button/link.
    let autoFixed = 0;
    for (const target of missingTargets) {
      const step = demoScript.steps.find(s => s.interaction?.target === target);
      if (!step) continue;
      const stepId = step.id;
      // Match the step div and attempt to inject the testid on its first button/a/[role=button]
      const stepDivRe = new RegExp(
        `(<div[^>]+data-testid="step-${stepId}"[^>]*>[\\s\\S]*?)(<(?:button|a)(?:\\s[^>]*?)?)>`
      );
      const patched = html.replace(stepDivRe, (m, pre, tagOpen) => {
        if (tagOpen.includes(`data-testid="${target}"`)) return m; // already there
        console.log(`[Build] Auto-injected data-testid="${target}" into step "${stepId}"`);
        autoFixed++;
        return `${pre}${tagOpen} data-testid="${target}">`;
      });
      if (patched !== html) html = patched;
    }
    const stillMissing = missingTargets.filter(t => !html.includes(`data-testid="${t}"`));
    if (stillMissing.length > 0) {
      domErrors.push(`Missing data-testid for interaction targets: ${stillMissing.join(', ')}`);
    } else if (autoFixed > 0) {
      console.log(`[Build] Auto-fixed ${autoFixed} missing testid(s) — re-validating`);
    }
  }

  // 5b. Live Plaid launch CTA must always exist for plaid-link-qa selector contract.
  if (PLAID_LINK_LIVE) {
    const ctaPatch = ensureCanonicalLaunchCtaInHtml(html, demoScript);
    html = ctaPatch.html;
    if (ctaPatch.injected) {
      console.log('[Build] Injected canonical launch CTA data-testid="link-external-account-btn"');
    }
    if (!html.includes('data-testid="link-external-account-btn"')) {
      domErrors.push('Missing canonical launch CTA target: data-testid="link-external-account-btn".');
    }
    const embeddedPatch = injectEmbeddedLinkRuntimeHandler(html, demoScript, linkModeAdapter);
    html = embeddedPatch.html;
    if (embeddedPatch.injected) {
      console.log('[Build] Injected embedded-Link runtime launch handler');
    }
  }

  if (layeredBuildEnabled) {
    for (const issue of (layerReport.layer1Framework.issues || [])) {
      domErrors.push(`[Layer1] ${issue}`);
    }
    for (const issue of (layerReport.layer2DataInteraction.issues || [])) {
      domErrors.push(`[Layer2] ${issue}`);
    }
    const layer3Issues = layerReport.layer3VisualPolish.issues || [];
    if (layer3Issues.length) {
      console.warn('[Build] Layer3 polish warnings:');
      layer3Issues.forEach((msg) => console.warn(`  - ${msg}`));
    }
  }

  if (domErrors.length > 0) {
    console.error('[Build] DOM contract violations (recording will fail):');
    domErrors.forEach(e => console.error(`  ✗ ${e}`));
    process.exit(1);
  }
  console.log('[Build] DOM contract: OK');

  // ── Harden syntaxHighlight (LLM sometimes calls it with undefined data) ─────
  if (/function\s+_?syntaxHighlight\s*\(\s*json\s*\)\s*\{/.test(html)) {
    html = html.replace(
      /function\s+(_?syntaxHighlight)\s*\(\s*json\s*\)\s*\{/,
      'function $1(json) { if (json == null) return ""; '
    );
    console.log('[Build] Patched syntaxHighlight for null-safe JSON stringify');
  }

  // ── Strip brittle showApiPanel calls and normalize to one global panel ─────
  // The LLM frequently emits partial / duplicated panel logic. We strip direct
  // showApiPanel() calls and later inject a stable global `_stepApiResponses` +
  // goToStep wrapper so build-qa, manual preview, and recording all see the same panel behavior.
  if (html.includes('showApiPanel(')) {
    const before = html;
    // Step 1: Rename the function DEFINITION so stripping doesn't corrupt it.
    html = html.replace(/\bfunction\s+showApiPanel\b/g, 'function _showApiPanelStub');
    // Step 2: Strip showApiPanel() CALLS using a paren-depth counter, not a regex.
    // The naive [^)]* regex breaks on phone numbers like "+1(111)222-3333" inside
    // the JSON argument — the first ) terminates the match early, leaving raw JSON
    // as invalid JavaScript (causes "window.goToStep is not a function" errors).
    let stripped = '';
    let i = 0;
    while (i < html.length) {
      const idx = html.indexOf('showApiPanel(', i);
      if (idx === -1) { stripped += html.slice(i); break; }
      stripped += html.slice(i, idx);
      // Walk forward counting parens to find the matching close paren
      let depth = 0;
      let j = idx + 'showApiPanel'.length;
      while (j < html.length) {
        if (html[j] === '(') depth++;
        else if (html[j] === ')') { depth--; if (depth === 0) { j++; break; } }
        j++;
      }
      // Skip optional trailing semicolon + whitespace
      while (j < html.length && (html[j] === ';' || html[j] === ' ' || html[j] === '\n' || html[j] === '\r')) j++;
      i = j;
    }
    html = stripped;
    if (html !== before) {
      console.log('[Build] Stripped showApiPanel() calls — api-response-panel overlay stays hidden');
    }
  }
  // ── Restore insight-step API panel calls stripped above ────────────────────
  // After stripping, any if (API_DATA[id]) { } block is left empty. Re-insert the
  // correct _showApiPanelStub call so insight steps show their JSON response panel.
  html = html.replace(
    /if\s*\(\s*API_DATA\s*\[\s*id\s*\]\s*\)\s*\{\s*\}/g,
    'if (API_DATA[id]) { _showApiPanelStub(API_DATA[id].endpoint || "", API_DATA[id].response || API_DATA[id].data); }'
  );

  // ── Patch _showApiPanelStub to clear display:none!important before showing ──
  // record-local.js sets apiPanel.style.setProperty('display','none','important')
  // on non-insight steps. _showApiPanelStub only adds the 'visible' class (which
  // changes transform), but display:none!important overrides the transform — panel
  // stays invisible. Fix: remove the inline display property at the top of the stub.
  if (html.includes('function _showApiPanelStub')) {
    html = html.replace(
      /function _showApiPanelStub\s*\(([^)]*)\)\s*\{/g,
      (match, args) => {
        return `function _showApiPanelStub(${args}) { var _ap = document.getElementById('api-response-panel'); if (_ap) _ap.style.removeProperty('display');`;
      }
    );
    console.log('[Build] Patched _showApiPanelStub to clear display:none before show');
  }

  // ── Inject global API response data + goToStep wrapper ─────────────────────
  // build-qa and manual preview do not get the record-local.js runtime patch, so ensure the
  // built app can surface api-response-panel content on its own even if the model forgot to
  // wire every insight branch correctly.
  const stepApiResponses = {};
  const stepApiEndpoints = {};
  for (const step of (demoScript.steps || [])) {
    if (step.apiResponse?.response) {
      stepApiResponses[step.id] = step.apiResponse.response;
      if (step.apiResponse.endpoint) stepApiEndpoints[step.id] = step.apiResponse.endpoint;
    }
  }
  if (Object.keys(stepApiResponses).length > 0) {
    const renderJsonScriptTag = '<script data-renderjson-lib src="https://cdn.jsdelivr.net/npm/renderjson@1.4.0/renderjson.min.js"></script>';
    if (!html.includes('renderjson.min.js')) {
      if (html.includes('</head>')) html = html.replace('</head>', `${renderJsonScriptTag}\n</head>`);
      else if (html.includes('</body>')) html = html.replace('</body>', `${renderJsonScriptTag}\n</body>`);
      console.log('[Build] Injected renderjson viewer script tag');
    }
    if (!html.includes('id="api-json-viewer-styles"') && html.includes('</head>')) {
      const viewerStyles = `<style id="api-json-viewer-styles">
#api-response-panel .side-panel-body { overflow-y: auto !important; overflow-x: hidden; max-height: calc(100vh - 140px); overscroll-behavior: contain; scrollbar-width: thin; }
#api-response-content { font-family: "SF Mono", "Fira Code", Consolas, monospace; font-size: 12px; line-height: 1.5; color: rgba(255,255,255,0.9); }
#api-response-content .disclosure { color: #00A67E !important; }
#api-response-content .syntax { color: rgba(255,255,255,0.55) !important; }
#api-response-content .key { color: #7dd3fc !important; }
#api-response-content .string { color: #86efac !important; }
#api-response-content .number { color: #fbbf24 !important; }
#api-response-content .boolean { color: #fca5a5 !important; }
#api-response-content .keyword { color: #c4b5fd !important; }
</style>`;
      html = html.replace('</head>', `${viewerStyles}\n</head>`);
      console.log('[Build] Injected API JSON viewer styles (scroll + theme colors)');
    }
  }
  if (Object.keys(stepApiResponses).length > 0 && html.includes('</body>')) {
    const apiPatch = `<script>
(function() {
  if (window.__buildApiPanelPatchApplied) return;
  window.__buildApiPanelPatchApplied = true;
  var _resp = ${JSON.stringify(stepApiResponses).replace(/</g, '\\u003c')};
  var _eps  = ${JSON.stringify(stepApiEndpoints).replace(/</g, '\\u003c')};
  window._stepApiResponses = Object.assign({}, window._stepApiResponses || {}, _resp);
  function renderApiJson(target, data) {
    if (!target) return;
    target.innerHTML = '';
    try {
      if (window.renderjson && typeof window.renderjson === 'function') {
        if (typeof window.renderjson.set_show_to_level === 'function') window.renderjson.set_show_to_level(3);
        if (typeof window.renderjson.set_icons === 'function') window.renderjson.set_icons('+', '-');
        if (typeof window.renderjson.set_sort_objects === 'function') window.renderjson.set_sort_objects(false);
        target.appendChild(window.renderjson(data));
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
  }
  function rerenderCurrentApiJson() {
    var panel = document.getElementById('api-response-panel');
    var content = document.getElementById('api-response-content');
    var data = window.__lastApiJsonData;
    if (!panel || !content || !data) return;
    renderApiJson(content, data);
  }
  if (!window.renderjson) {
    var existing = document.querySelector('script[data-renderjson-lib]');
    if (existing) {
      existing.addEventListener('load', rerenderCurrentApiJson, { once: true });
    }
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
    var body = panel.querySelector('.side-panel-body');
    if (data) {
      if (endpoint && _eps[id]) endpoint.textContent = _eps[id];
      panel.style.removeProperty('display');
      panel.style.display = 'flex';
      panel.classList.add('visible');
      panel.classList.remove('api-json-collapsed');
      if (body) {
        body.style.display = '';
        body.style.overflowY = 'auto';
        body.style.maxHeight = 'calc(100vh - 140px)';
      }
      window.__lastApiJsonData = data;
      if (content) {
        renderApiJson(content, data);
      }
    } else {
      panel.style.setProperty('display', 'none', 'important');
      panel.classList.remove('visible', 'expanded', 'open', 'active', 'api-json-collapsed');
      if (body) {
        body.style.display = '';
        body.style.overflowY = 'auto';
      }
    }
  };
  var jsonToggles = document.querySelectorAll('[data-testid="api-panel-toggle"], #api-panel-toggle');
  jsonToggles.forEach(function(el) {
    el.style.display = 'none';
    el.setAttribute('aria-hidden', 'true');
  });
  try { delete window.toggleApiPanel; } catch (_) { window.toggleApiPanel = undefined; }
})();
</script>`;
    html = html.replace('</body>', `${apiPatch}\n</body>`);
    console.log(`[Build] Injected _stepApiResponses patch for ${Object.keys(stepApiResponses).length} step(s)`);
  } else if (html.includes('api-response-panel') && html.includes('</body>') && !html.includes('window.__apiPanelNoJsonToggleApplied')) {
    const collapsePatch = `<script>
(function() {
  if (window.__apiPanelNoJsonToggleApplied) return;
  window.__apiPanelNoJsonToggleApplied = true;
  var jsonToggles = document.querySelectorAll('[data-testid="api-panel-toggle"], #api-panel-toggle');
  jsonToggles.forEach(function(el) {
    el.style.display = 'none';
    el.setAttribute('aria-hidden', 'true');
  });
  try { delete window.toggleApiPanel; } catch (_) { window.toggleApiPanel = undefined; }
})();
</script>`;
    html = html.replace('</body>', `${collapsePatch}\n</body>`);
    console.log('[Build] Disabled legacy API JSON toggle controls');
  }

  // ── Runtime mobile view toggle (desktop/mobile-auto/mobile-simulated) ─────
  // Applies simulated device shell ONLY to non-slide steps. Slide template steps
  // with .slide-root remain full-frame.
  if (mobileVisualEnabled && html.includes('</body>') && !html.includes('window.__mobileViewRuntimeApplied')) {
    if (html.includes('</head>') && !html.includes('id="mobile-view-runtime-styles"')) {
      const mobileViewStyles = `<style id="mobile-view-runtime-styles">
#mobile-view-toggle{
  position:fixed; top:68px; left:16px; z-index:12000;
  background:rgba(17,17,17,0.86); color:#fff; border:1px solid rgba(255,255,255,0.2);
  border-radius:10px; padding:8px 12px; font-size:12px; font-weight:700;
  letter-spacing:.02em; cursor:pointer; backdrop-filter:blur(8px);
}
#mobile-view-toggle:hover{background:rgba(30,30,30,0.92);}
body.mobile-shell-enabled .app-main{
  background:radial-gradient(circle at 50% 10%, rgba(255,255,255,0.06), rgba(0,0,0,0));
}
body.mobile-shell-enabled .step.mobile-shell-target{
  position:absolute !important;
  left:50% !important; top:50% !important;
  width:min(390px, calc(100vw - 32px)) !important;
  height:min(844px, calc(100vh - 32px)) !important;
  transform:translate(-50%, -50%) !important;
  border-radius:34px !important;
  border:1px solid rgba(255,255,255,0.18) !important;
  box-shadow:0 24px 60px rgba(0,0,0,0.42), 0 0 0 10px rgba(255,255,255,0.04) !important;
  overflow:hidden !important;
}
</style>`;
      html = html.replace('</head>', `${mobileViewStyles}\n</head>`);
      console.log('[Build] Injected runtime mobile-view toggle styles');
    }
    const mobileViewPatch = `<script>
(function() {
  if (window.__mobileViewRuntimeApplied) return;
  window.__mobileViewRuntimeApplied = true;
  var mode = '${buildViewMode}';
  var mq = window.matchMedia ? window.matchMedia('(max-width: 480px)') : null;

  function activeStep() { return document.querySelector('.step.active'); }
  function activeStepId() {
    var a = activeStep();
    return a && a.dataset && a.dataset.testid ? String(a.dataset.testid).replace(/^step-/, '') : '';
  }
  function isSlideStep(id) {
    if (!id) return false;
    var node = document.querySelector('[data-testid="step-' + id + '"]');
    return !!(node && node.querySelector('.slide-root'));
  }
  function shouldShellForCurrentStep() {
    var id = activeStepId();
    if (!id || isSlideStep(id)) return false;
    if (mode === 'mobile-simulated') return true;
    if (mode === 'mobile-auto') return !!(mq && mq.matches);
    return false;
  }
  function applyMode() {
    var a = activeStep();
    document.querySelectorAll('.step.mobile-shell-target').forEach(function(s){ s.classList.remove('mobile-shell-target'); });
    if (!a) {
      document.body.classList.remove('mobile-shell-enabled');
      return;
    }
    if (shouldShellForCurrentStep()) {
      a.classList.add('mobile-shell-target');
      document.body.classList.add('mobile-shell-enabled');
    } else {
      document.body.classList.remove('mobile-shell-enabled');
    }
    if (window.__mobileViewToggleBtn) {
      window.__mobileViewToggleBtn.textContent = 'View: ' + mode;
      window.__mobileViewToggleBtn.setAttribute('data-view-mode', mode);
    }
  }
  function setMode(next) {
    var normalized = String(next || '').toLowerCase();
    if (['desktop','mobile-auto','mobile-simulated'].indexOf(normalized) === -1) normalized = 'desktop';
    mode = normalized;
    document.body.setAttribute('data-view-mode', mode);
    applyMode();
    return mode;
  }
  function toggleMode() {
    if (mode === 'desktop') return setMode('mobile-auto');
    if (mode === 'mobile-auto') return setMode('mobile-simulated');
    return setMode('desktop');
  }

  var prevGoToStep = window.goToStep;
  if (typeof prevGoToStep === 'function') {
    window.goToStep = function(id) {
      prevGoToStep(id);
      applyMode();
    };
  }
  window.setDemoViewMode = setMode;
  window.getDemoViewMode = function(){ return mode; };
  window.toggleDemoViewMode = toggleMode;

  var btn = document.getElementById('mobile-view-toggle');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'mobile-view-toggle';
    btn.setAttribute('data-testid', 'mobile-view-toggle');
    btn.type = 'button';
    btn.textContent = 'View: ' + mode;
    btn.addEventListener('click', function(){ toggleMode(); });
    document.body.appendChild(btn);
  }
  window.__mobileViewToggleBtn = btn;
  if (mq && typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', function(){ if (mode === 'mobile-auto') applyMode(); });
  } else if (mq && typeof mq.addListener === 'function') {
    mq.addListener(function(){ if (mode === 'mobile-auto') applyMode(); });
  }
  setMode(mode);
})();
</script>`;
    html = html.replace('</body>', `${mobileViewPatch}\n</body>`);
    console.log('[Build] Injected runtime mobile-view toggle (desktop/mobile-auto/mobile-simulated)');
  }

  // ── Harden generated click bindings (avoid null.addEventListener crash) ────
  // Some model outputs bind listeners to deduped selectors (e.g. -dup2) that do
  // not exist at runtime. That throws and aborts the script before Plaid init.
  // Convert direct querySelector(...).addEventListener(...) chains into a safe
  // binder with fallback selector resolution.
  if (html.includes('document.querySelector(') && html.includes('.addEventListener(')) {
    const hadSafeBindBefore = html.includes('window.__safeBind');
    const bindPattern = /document\.querySelector\(([^)]+)\)\.addEventListener\(\s*(['"][^'"]+['"])\s*,\s*/g;
    const converted = html.replace(bindPattern, 'window.__safeBind($1, $2, ');
    if (converted !== html) {
      html = converted;
      if (!hadSafeBindBefore && html.includes('</body>')) {
        const safeBindShim = `<script>
(function() {
  if (window.__safeBind) return;
  function fallbackByTestid(selector) {
    if (typeof selector !== 'string') return null;
    var m = selector.match(/^\\[data-testid="([^"]+)"\\]$/);
    if (!m) return null;
    var raw = m[1];
    var base = raw.replace(/-dup\\d+$/, '');
    var byBase = document.querySelector('[data-testid="' + base + '"]');
    if (byBase) return byBase;
    var byRawDup = document.querySelector('[data-testid^="' + raw + '-dup"]');
    if (byRawDup) return byRawDup;
    var byBaseDup = document.querySelector('[data-testid^="' + base + '-dup"]');
    if (byBaseDup) return byBaseDup;
    return null;
  }
  window.__safeBind = function(selector, eventName, handler, options) {
    var el = document.querySelector(selector) || fallbackByTestid(selector);
    if (!el || typeof el.addEventListener !== 'function') {
      console.warn('[Build] __safeBind skipped missing selector:', selector);
      return false;
    }
    el.addEventListener(eventName, handler, options);
    return true;
  };
})();
</script>`;
        html = html.replace('</body>', `${safeBindShim}\n</body>`);
      }
      console.log('[Build] Hardened generated addEventListener bindings with __safeBind');
    }
  }

  // ── Enforce 98% U.S. depository account coverage stat (Auth) ───────────────
  // The LLM sometimes writes "95%" for the Plaid Auth coverage statistic.
  // The approved CLAUDE.md value is "over 98% of U.S. depository accounts."
  // Apply a targeted replacement: only "95%+" or "95%" near depository context.
  {
    const before = html;
    html = html.replace(/\b95(%\+?)\b(?=[^<]{0,60}[Dd]epository)/g, '98$1');
    html = html.replace(/(?<=[Dd]epository[^<]{0,60})\b95(%\+?)\b/g, '98$1');
    if (html !== before) {
      console.log('[Build] Corrected 95% → 98% for U.S. depository account coverage stat');
    }
  }

  // ── Validate playwright-script.json step IDs match demo-script.json ────────
  // The LLM generates playwright-script.json and can invent arbitrary step IDs.
  // If playwright-script IDs don't match demo-script IDs, record-local.js will:
  //   - fail to resolve Plaid Link phases (regex can't match unknown IDs)
  //   - write step-timing.json with wrong IDs (QA then can't find steps → skips them)
  //   - cause "step not in demo-script.json" QA warnings for every step
  const demoStepIds = new Set(demoScript.steps.map(s => s.id));
  const pwSteps     = playwrightScript.steps || [];
  const inventedIds = pwSteps
    .map(s => s.stepId || s.id)
    .filter(id => id && !demoStepIds.has(id));
  if (inventedIds.length > 0) {
    console.error('[Build] playwright-script.json step ID mismatch (recording will fail):');
    console.error(`  ✗ These IDs are not in demo-script.json: ${inventedIds.join(', ')}`);
    console.error(`  ✓ Valid IDs from demo-script.json: ${[...demoStepIds].join(', ')}`);
    process.exit(1);
  }
  console.log(`[Build] playwright-script step IDs: OK (${pwSteps.length} steps match demo-script)`);

  // ── Post-process: ensure handler.destroy() is called in onSuccess ─────────
  // The Plaid iframe persists in the DOM after onSuccess unless destroy() is called,
  // causing it to overlay all post-link steps in the recording.
  if (html.includes('window._plaidLinkComplete = true') && !html.includes('handler.destroy()')) {
    html = html.replace(
      /window\._plaidLinkComplete\s*=\s*true;/g,
      'window._plaidLinkComplete = true;\n        if (window._plaidHandler) { try { window._plaidHandler.destroy(); } catch(e) {} }'
    );
    console.log('[Build] Injected handler.destroy() into onSuccess (Plaid modal cleanup)');
  }

  // ── Harden Plaid Link token bootstrap error handling ───────────────────────
  // Generated apps commonly do:
  //   fetch('/api/create-link-token').then(r => r.json()).then(data => Plaid.create({ token: data.link_token }))
  // If the endpoint returns HTTP 500 with { error: ... }, Plaid.create() is still called
  // with token=undefined, causing a misleading "Missing Link parameter" client error.
  // Fix:
  // 1) parse response body with status-aware check
  // 2) guard on data.link_token before Plaid.create()
  if (html.includes("fetch('/api/create-link-token'")) {
    const before = html;
    html = html.replace(
      /\.then\(function\(r\)\s*\{\s*return r\.json\(\);\s*\}\)/,
      `.then(function(r) {
    return r.text().then(function(t) {
      var j = {};
      try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { raw: t }; }
      if (!r.ok) {
        var msg = (j && (j.error || j.error_message || j.display_message)) || ('HTTP ' + r.status);
        throw new Error(msg);
      }
      return j;
    });
  })`
    );
    html = html.replace(
      /window\._plaidHandler\s*=\s*Plaid\.create\(\{/,
      `if (!data || !data.link_token) {
      console.error('Failed to create link token: missing link_token in response', data);
      return;
    }
    window._plaidHandler = Plaid.create({`
    );
    if (html !== before) {
      console.log('[Build] Hardened Plaid token bootstrap (HTTP/error-aware + link_token guard)');
    }
  }

  // ── Write outputs ──────────────────────────────────────────────────────────
  fs.writeFileSync(HTML_OUT, html, 'utf8');
  fs.writeFileSync(PLAYWRIGHT_OUT, JSON.stringify(playwrightScript, null, 2), 'utf8');

  console.log(`[Build] Written: scratch-app/index.html (${Math.round(html.length / 1024)}KB)`);
  console.log(`[Build] Written: scratch-app/playwright-script.json (${playwrightScript.steps.length} steps)`);
  console.log('[Build] Done — next: node scripts/scratch/scratch/record-local.js');
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[Build] Fatal error:', err.message);
    process.exit(1);
  });
}
