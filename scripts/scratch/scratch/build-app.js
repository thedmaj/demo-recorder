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
 *   BUILD_REFINE_STEP_IDS — optional comma/whitespace-separated step ids; narrows QA
 *                           report + screenshot frames loaded for refinement so the
 *                           model focuses on those steps only (full HTML still emitted).
 */

require('dotenv').config({ override: true });
const Anthropic  = require('@anthropic-ai/sdk');
const fs         = require('fs');
const path       = require('path');

const {
  buildAppArchitectureBriefPrompt,
  buildAppFrameworkPlanPrompt,
  buildAppGenerationPrompt,
  shouldInjectLayerMobileMockTemplate,
} = require('../utils/prompt-templates');
const { buildLayerMockBrandTokensStyle } = require('../utils/layer-mock-brand-tokens');
const { inferProductFamily } = require('../utils/product-profiles');
const { inferPlaidLinkProductsFromPrompt } = require('../utils/link-token-create-config');
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
const { requireRunDir, getRunLayout, readRunManifest } = require('../utils/run-io');
const { isSlideStep: isSlideStepShared, annotateScriptWithStepKinds } = require('../utils/step-kind');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT    = path.resolve(__dirname, '../../..');
const OUT_DIR         = requireRunDir(PROJECT_ROOT, 'build-app');
const RUN_LAYOUT      = getRunLayout(OUT_DIR);
const INPUTS_DIR      = path.join(PROJECT_ROOT, 'inputs');
const SCRIPT_FILE     = path.join(OUT_DIR, 'demo-script.json');
const RESEARCH_FILE   = path.join(OUT_DIR, 'product-research.json');
const SCRATCH_APP_DIR = path.join(RUN_LAYOUT.buildDir, 'scratch-app');
const LEGACY_SCRATCH_APP_DIR = path.join(OUT_DIR, 'scratch-app');
const HTML_OUT        = path.join(SCRATCH_APP_DIR, 'index.html');
const PLAYWRIGHT_OUT  = path.join(SCRATCH_APP_DIR, 'playwright-script.json');
const FEEDBACK_FILE   = path.join(INPUTS_DIR, 'build-feedback.md');
const RUN_FEEDBACK_FILE = path.join(RUN_LAYOUT.feedbackDir, 'build-feedback.md');
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
const BUILD_QA_DIAG_FILE = path.join(RUN_LAYOUT.qaDir, 'build-qa-diagnostics.json');
const LEGACY_BUILD_QA_DIAG_FILE = path.join(OUT_DIR, 'build-qa-diagnostics.json');
const API_PANEL_QA_FILE = path.join(RUN_LAYOUT.buildDir, 'api-panel-qa.json');
const BUILD_LAYER_REPORT_FILE = path.join(RUN_LAYOUT.buildDir, 'build-layer-report.json');
const BUILD_METADATA_FILE = path.join(RUN_LAYOUT.buildDir, 'build-metadata.json');
const CONSISTENCY_MANIFEST_FILE = path.join(RUN_LAYOUT.buildDir, 'consistency-manifest.json');
const CONSISTENCY_LINT_FILE = path.join(RUN_LAYOUT.buildDir, 'consistency-lint.json');
const RENDERJSON_EXPAND_LEVEL_DEFAULT = 999;
// Heroicons outline "link" (24 viewBox); explicit px size + layout CSS so flex parents cannot blow it up.
const STOCK_LINK_BUTTON_ICON_SVG =
  '<svg class="icon-sm stock-link-icon" width="20" height="20" fill="none" viewBox="0 0 24 24" ' +
  'stroke-width="2" stroke="currentColor" aria-hidden="true" ' +
  'style="width:20px;height:20px;min-width:20px;min-height:20px;flex-shrink:0;display:block;box-sizing:content-box">' +
  '<path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.242a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>' +
  '</svg>';

const PIPELINE_PLAID_LAUNCH_CTA_STYLE_ATTR = 'data-pipeline-plaid-launch-cta-layout';

/**
 * Ensures host Plaid launch CTA keeps a modest inline icon (pipeline stock SVG) even when the
 * model wraps the button in aggressive flex layouts.
 */
function injectPlaidLaunchCtaLayoutStyles(html) {
  if (!html || !html.includes('data-testid="link-external-account-btn"')) {
    return html;
  }
  if (html.includes(PIPELINE_PLAID_LAUNCH_CTA_STYLE_ATTR)) {
    return html;
  }
  const snippet =
    `<style ${PIPELINE_PLAID_LAUNCH_CTA_STYLE_ATTR}="1">\n` +
    `[data-testid="link-external-account-btn"]{display:inline-flex;align-items:center;gap:0.5rem;justify-content:center;}\n` +
    `[data-testid="link-external-account-btn"] svg.stock-link-icon,\n` +
    `[data-testid="link-external-account-btn"] .stock-link-icon{\n` +
    `  width:20px !important;height:20px !important;min-width:20px !important;min-height:20px !important;\n` +
    `  max-width:20px !important;max-height:20px !important;flex-shrink:0 !important;\n` +
    `  display:block !important;box-sizing:content-box !important;\n` +
    `}\n` +
    `</style>\n`;
  if (html.includes('</head>')) {
    return html.replace('</head>', `${snippet}</head>`);
  }
  if (/<body\b/i.test(html)) {
    return html.replace(/<body\b/i, `${snippet}<body`);
  }
  return snippet + html;
}

/**
 * Normalize the Plaid Link launch button so the recording automation can reliably
 * click it and see the modal appear.
 *
 * Problems fixed:
 *   1) LLM sometimes generates the button with a `disabled` attribute and a
 *      "Preparing secure link…" / "Loading…" label, intending to enable it once
 *      `_plaidHandler` is ready. When the span that holds the label has no stable
 *      id, the label never gets updated, the button stays visually labelled
 *      "Preparing secure link…", and Playwright's click fires at an awkward moment
 *      where the Plaid SDK may auto-succeed against cached state without the
 *      modal ever becoming visible in the recording.
 *   2) onclick handler calls `_plaidHandler.open()` unguarded — if clicked before
 *      the handler is initialised, the click is a no-op (button-disabled check
 *      aside).
 *
 * This fixup is idempotent and conservative: it only touches the canonical launch
 * button (`data-testid="link-external-account-btn"`) and only when there is a
 * real problem. The LLM's own JS (setLaunchReady, etc.) is left alone.
 */
function normalizePlaidLaunchCta(html) {
  if (!html || !html.includes('data-testid="link-external-account-btn"')) {
    return html;
  }
  let changed = false;
  const changes = [];

  // 1) Strip `disabled` (and aria-disabled) from the launch button itself so the
  //    button is clickable from the moment it renders. The onclick handler will
  //    wait for `_plaidHandler` before calling .open(), so this is safe.
  const btnRe = /<button\b([^>]*\bdata-testid="link-external-account-btn"[^>]*)>/i;
  const btnMatch = html.match(btnRe);
  if (btnMatch) {
    let attrs = btnMatch[1];
    let attrsChanged = false;
    if (/\bdisabled\b/i.test(attrs)) {
      attrs = attrs.replace(/\s+disabled(?==|\b)(="[^"]*")?/gi, '');
      attrsChanged = true;
    }
    if (/\baria-disabled\s*=\s*"(true|1)"/i.test(attrs)) {
      attrs = attrs.replace(/\s+aria-disabled\s*=\s*"(true|1)"/gi, '');
      attrsChanged = true;
    }
    if (attrsChanged) {
      html = html.replace(btnRe, `<button${attrs}>`);
      changed = true;
      changes.push('removed disabled/aria-disabled from launch CTA');
    }
  }

  // 2) Replace any loading-style label ("Preparing secure link…", "Loading…",
  //    "Connecting…", "Initializing…") on the launch button with the stable
  //    "Link external account" label that the narration references.
  //    We target the first textual span (or direct text node) inside the canonical
  //    button only to avoid touching unrelated UI.
  const btnBlockRe = /(<button\b[^>]*\bdata-testid="link-external-account-btn"[^>]*>)([\s\S]*?)(<\/button>)/i;
  const btnBlock = html.match(btnBlockRe);
  if (btnBlock) {
    const [full, open, inner, close] = btnBlock;
    const loadingLabelRe = /(Preparing\s+secure\s+link[\u2026.]*|Loading[\u2026.]*|Connecting[\u2026.]*|Initiali[sz]ing[\u2026.]*|Please\s+wait[\u2026.]*)/i;
    if (loadingLabelRe.test(inner)) {
      const newInner = inner.replace(loadingLabelRe, 'Link external account');
      html = html.replace(full, `${open}${newInner}${close}`);
      changed = true;
      changes.push('replaced loading label with "Link external account"');
    }
  }

  // 3) Harden the onclick handler: wait (with a ~10s cap) for `_plaidHandler` to
  //    be initialised before calling `.open()`. If the click lands before the
  //    link-token fetch resolves, the original pattern
  //    `if (window._plaidHandler) window._plaidHandler.open();` was a no-op,
  //    which in turn led to Plaid SDK auto-completing against cached state.
  const unguardedOnclickRe = /launchBtn\.addEventListener\(\s*['"]click['"]\s*,\s*function\s*\(\s*e\s*\)\s*\{\s*e\.preventDefault\(\)\s*;\s*if\s*\(\s*window\._plaidHandler\s*\)\s*window\._plaidHandler\.open\(\)\s*;\s*\}\s*\)\s*;?/;
  const hardenedOnclick =
    `launchBtn.addEventListener('click', async function(e){\n` +
    `      e.preventDefault();\n` +
    `      // Wait up to 10s for the Plaid handler to initialise (link-token fetch + Plaid.create)\n` +
    `      // so that clicks landing before the handler is ready still open the modal.\n` +
    `      for (var i = 0; i < 50 && !(window._plaidHandler && typeof window._plaidHandler.open === 'function'); i++) {\n` +
    `        await new Promise(function(r){ setTimeout(r, 200); });\n` +
    `      }\n` +
    `      if (window._plaidHandler && typeof window._plaidHandler.open === 'function') {\n` +
    `        window._plaidHandler.open();\n` +
    `      }\n` +
    `    });`;
  if (unguardedOnclickRe.test(html)) {
    html = html.replace(unguardedOnclickRe, hardenedOnclick);
    changed = true;
    changes.push('hardened launch onclick to await _plaidHandler');
  }

  if (changed) {
    console.log(`[Build] Normalized Plaid Link launch CTA: ${changes.join('; ')}`);
  }
  return html;
}

/**
 * Normalize the Plaid Link EMBEDDED UX so the recording and the rendered MP4
 * match the contract in CLAUDE.md and `skills/plaid-link-embedded-link-skill.md`.
 *
 * Problems this fixes (seen in real runs):
 *   1) LLM adds an additional "Link bank account" / launch button next to the
 *      embedded widget. In embedded mode the widget IS the CTA — the modal is
 *      surfaced by clicking an institution tile inside the widget. An extra
 *      host-side button is redundant at best and actively confusing at worst.
 *   2) The embedded container is sized arbitrarily (e.g. 380x420), which leaves
 *      empty whitespace below the institution tiles. The build normalizer applies
 *      one default footprint for every embedded demo: **430×390** (min + height).
 *
 * We only touch the canonical container
 * (`data-testid="plaid-embedded-link-container"`) and only when we detect the
 * two specific anti-patterns. The fixup is idempotent.
 *
 * @param {string} html          Full generated index.html
 * @param {object} [demoScript]  Parsed demo-script.json (to read plaidLinkMode
 *                               and any embedded size hints the LLM emitted)
 */
function normalizePlaidEmbeddedLinkUx(html, demoScript) {
  if (!html) return html;
  if (!html.includes('plaid-embedded-link-container')) return html;

  // Authoritative mode check: demo-script.json wins; fall back to presence of
  // the embedded container if no script was supplied.
  const scriptMode = String(demoScript?.plaidLinkMode || '').toLowerCase();
  if (scriptMode && scriptMode !== 'embedded') return html;

  const changes = [];

  // ── 1) Strip any launch-button (`link-external-account-btn`) and the simple
  //       flex row that wraps it. Keep the surrounding trust copy intact.
  const stripped = stripEmbeddedLaunchCta(html);
  if (stripped !== html) {
    html = stripped;
    changes.push('removed extra launch CTA button (embedded mode uses institution-tile click instead)');
  }

  // ── 2) Harmonize container sizing — single default for all embedded use cases.
  const profile = resolveEmbeddedLinkSizeProfile(html, demoScript);
  const sizing = EMBEDDED_LINK_SIZE_PROFILES[profile] || EMBEDDED_LINK_SIZE_PROFILES.default;
  const sized = applyEmbeddedContainerSizing(html, sizing);
  if (sized !== html) {
    html = sized;
    changes.push(`sized container to ${sizing.width}x${sizing.height} (embedded default)`);
  }

  if (changes.length) {
    console.log(`[Build] Normalized Plaid Embedded Link UX: ${changes.join('; ')}`);
  }
  return html;
}

/**
 * Single embedded Link container size for all demos (above Plaid 350×300 / 300×350 minimums).
 * CSS uses `min-width`/`min-height` plus explicit `height` so the iframe does not fall back to 150px.
 */
const EMBEDDED_LINK_SIZE_PROFILES = {
  default: { width: 430, height: 390, label: 'default (all embedded use cases)' },
};

function resolveEmbeddedLinkSizeProfile(_html, _demoScript) {
  // Legacy HTML may still set window.__embeddedLinkSizeProfile to small|medium|large; sizing is unified.
  return 'default';
}

function stripEmbeddedLaunchCta(html) {
  // Remove ANY `<button ... data-testid="link-external-account-btn" ...>...</button>`.
  const btnRe = /<button\b[^>]*\bdata-testid="link-external-account-btn"[^>]*>[\s\S]*?<\/button>\s*/gi;
  let out = html.replace(btnRe, '');
  if (out === html) return html;

  // If the wrapper row (e.g. `.linkcta-row`) is now empty or only has the
  // "256-bit encryption" sibling, leave the sibling but drop the row wrapper's
  // purpose-defined flex layout so the trust text reads naturally. We don't
  // need to be aggressive about this — the styling will still render fine.
  // Collapse `<div class="linkcta-row"></div>` (empty) if any remain.
  out = out.replace(/<div\s+class="linkcta-row"\s*>\s*<\/div>\s*/gi, '');
  return out;
}

function applyEmbeddedContainerSizing(html, sizing) {
  const { width, height } = sizing;

  // Common patterns the LLM emits for the container rule. We match the rule
  // opening `#plaid-embedded-link-container{...}` and rewrite sizing inside it,
  // preserving most other props (padding, radius) while stripping flex-centering
  // and overflow:hidden variants that clip the iframe.
  const ruleRe = /(#plaid-embedded-link-container\s*\{)([^}]*)(\})/g;
  let changed = false;
  const out = html.replace(ruleRe, (full, open, body, close) => {
    changed = true;
    // Remove any existing sizing props (min/max/width/height variants) so we
    // don't end up with conflicting declarations.
    const cleaned = body
      .replace(/\bmin-width\s*:[^;]+;?/gi, '')
      .replace(/\bmin-height\s*:[^;]+;?/gi, '')
      .replace(/\bmax-width\s*:[^;]+;?/gi, '')
      .replace(/\bmax-height\s*:[^;]+;?/gi, '')
      .replace(/\bwidth\s*:[^;]+;?/gi, '')
      .replace(/\bheight\s*:[^;]+;?/gi, '')
      // `overflow: hidden` on this box clips the Plaid iframe when content is
      // taller than the host min-height; drop hidden overflows on this rule only.
      .replace(/\boverflow(?:-x|-y)?\s*:\s*hidden\s*;?/gi, '')
      // Drop flex-centering that forces the placeholder/widget to sit in the
      // middle with dead whitespace. The Plaid-rendered iframe sizes itself
      // naturally inside a block container.
      .replace(/\bdisplay\s*:\s*flex\s*;?/gi, '')
      .replace(/\balign-items\s*:[^;]+;?/gi, '')
      .replace(/\bjustify-content\s*:[^;]+;?/gi, '')
      .replace(/;\s*;+/g, ';')
      .trim();
    // Explicit height (not only min-height): nested iframes default to 150px tall
    // when the parent used height:auto; min-height alone does not establish a
    // percentage basis for iframe height:100% / SDK layout.
    const sized = `min-width:${width}px;min-height:${height}px;height:${height}px;width:100%;max-width:${width}px;`;
    const bodyNext = (cleaned ? cleaned.replace(/;?$/, ';') : '') + sized;
    return `${open}${bodyNext}${close}`;
  });
  return changed ? out : html;
}

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
  return isSlideStepShared(step);
}

function isValueSummaryStep(step) {
  const id = String(step?.id || '').toLowerCase();
  const label = String(step?.label || '').toLowerCase();
  return id === 'value-summary-slide' || /\bvalue summary\b/.test(label);
}

function hasApiEndpoint(step) {
  const endpoint = String(step?.apiResponse?.endpoint || '').trim();
  return /^[A-Z]+\s+\/|^\//.test(endpoint);
}

function isApiRelevantSlide(step) {
  if (!isSlideLikeStep(step)) return false;
  if (isValueSummaryStep(step)) return false;
  return hasApiEndpoint(step);
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

function formatCurrencyMaybe(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: Number.isInteger(abs) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(abs);
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

function buildConsistencyManifest(demoScript) {
  const personaName = String(demoScript?.persona?.name || '').trim();
  const requiredLiterals = new Set();
  const amountChecks = [];

  if (personaName) requiredLiterals.add(personaName);

  for (const step of demoScript?.steps || []) {
    const visualState = String(step?.visualState || '');
    const visualAmounts = visualState.match(/\$[0-9][0-9,]*(?:\.[0-9]{2})?/g) || [];
    visualAmounts.forEach((s) => requiredLiterals.add(s));

    const response = step?.apiResponse?.response;
    if (!response || typeof response !== 'object') continue;

    const stack = [{ value: response, path: 'response' }];
    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) continue;
      const value = item.value;
      if (Array.isArray(value)) {
        value.forEach((entry, idx) => stack.push({ value: entry, path: `${item.path}[${idx}]` }));
        continue;
      }
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          stack.push({ value: v, path: `${item.path}.${k}` });
        }
        continue;
      }
      if (typeof value === 'number') {
        const pathLower = item.path.toLowerCase();
        if (!/(amount|balance|income|credit|apr|fee|total|monthly|annual|outflow|inflow|net|line)/.test(pathLower)) {
          continue;
        }
        const currency = formatCurrencyMaybe(value);
        amountChecks.push({
          stepId: step?.id || null,
          path: item.path,
          value,
          expectedLiterals: [currency, String(value)].filter(Boolean),
        });
      }
    }
  }

  const trimmedAmounts = amountChecks.slice(0, 80);
  return {
    generatedAt: new Date().toISOString(),
    personaName: personaName || null,
    requiredLiterals: Array.from(requiredLiterals).slice(0, 120),
    amountChecks: trimmedAmounts,
  };
}

function runConsistencyLint(html, manifest) {
  const text = String(html || '');
  const misses = [];
  const warnings = [];

  if (manifest.personaName && !text.includes(manifest.personaName)) {
    misses.push({
      severity: 'critical',
      category: 'persona-name-missing',
      message: `Persona name "${manifest.personaName}" was not found in generated HTML.`,
    });
  }

  for (const literal of manifest.requiredLiterals || []) {
    if (!literal || literal.length < 2) continue;
    if (!text.includes(literal)) {
      warnings.push({
        severity: 'warning',
        category: 'literal-missing',
        literal,
        message: `Expected literal "${literal}" not found in HTML.`,
      });
    }
  }

  for (const check of manifest.amountChecks || []) {
    const expected = (check.expectedLiterals || []).filter(Boolean);
    if (expected.length === 0) continue;
    if (!expected.some((lit) => text.includes(lit))) {
      warnings.push({
        severity: 'warning',
        category: 'api-amount-missing',
        stepId: check.stepId || null,
        path: check.path,
        expectedLiterals: expected,
        message: `No rendered literal matched API scalar at ${check.path} (${expected.join(' or ')}).`,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    passed: misses.length === 0,
    misses,
    warnings,
    summary: {
      criticalCount: misses.length,
      warningCount: warnings.length,
    },
  };
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

const ARCH_MODEL         = 'claude-opus-4-7';
const ARCH_MAX_TOKENS    = 1024;
const FRAMEWORK_MODEL    = 'claude-opus-4-7';
const FRAMEWORK_MAX_TOKENS = 1800;
const BUILD_MODEL        = 'claude-opus-4-7';
const BUILD_BUDGET_TOKENS = 12000;
// Adaptive thinking consumes tokens before output; for large demos (10+ steps
// with multiple `.slide-root` insight screens) 32K can truncate the final
// HTML + playwright script. Override with BUILD_MAX_TOKENS_OVERRIDE to raise.
const BUILD_MAX_TOKENS   = Math.max(
  8000,
  parseInt(process.env.BUILD_MAX_TOKENS_OVERRIDE || '32000', 10) || 32000
);

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
const BRAND_DIR = RUN_LAYOUT.brandDir;

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
    console.warn(`[Build] Brand profile not found: ${path.relative(PROJECT_ROOT, profilePath)} — using Plaid defaults`);
    return null;
  }

  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    console.log(`[Build] Brand profile loaded: ${path.relative(PROJECT_ROOT, profilePath)} (${profile.name}, mode: ${profile.mode})`);
    return profile;
  } catch (err) {
    console.warn(`[Build] Could not parse ${path.relative(PROJECT_ROOT, profilePath)}: ${err.message} — using Plaid defaults`);
    return null;
  }
}

// ── CLI arg parsing ───────────────────────────────────────────────────────────

/** @returns {Set<string>|null} */
function parseBuildRefineStepIdScope() {
  const raw = String(process.env.BUILD_REFINE_STEP_IDS || '').trim();
  if (!raw) return null;
  const ids = raw.split(/[, \n\t]+/).map((s) => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

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

function promptIndicatesMobileVisual(promptText, demoScript) {
  const prompt = String(promptText || '').toLowerCase();
  const product = String(demoScript?.product || '').toLowerCase();
  const stepText = Array.isArray(demoScript?.steps)
    ? demoScript.steps
      .map((s) => [s?.id, s?.label, s?.narration, s?.visualState].filter(Boolean).join(' '))
      .join(' ')
      .toLowerCase()
    : '';
  const haystack = `${prompt}\n${product}\n${stepText}`;
  if (/\bdesktop[-\s]?only\b|\bno mobile\b|\bdo not use mobile\b|\bwithout mobile\b/.test(haystack)) {
    return false;
  }
  return (
    /\bmobile build\b|\bmobile demo build\b|\bmobile visual build\b/.test(haystack) ||
    /\bmobile[-\s]?simulated build\b|\buse (?:the )?mobile app framework\b/.test(haystack) ||
    /\bviewmode\s*:\s*mobile(?:-auto|-simulated)?\b/.test(haystack)
  );
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
  const embeddedMode = String(demoScript?.plaidLinkMode || '').toLowerCase() === 'embedded' ||
    /plaid-embedded-link-container/i.test(String(launch?.interaction?.target || ''));
  if (embeddedMode) {
    // Embedded should auto-mount from container activation; no launch CTA required.
    row.action = 'goToStep';
    row.target = launch.id;
  } else {
    row.action = 'click';
    row.target = '[data-testid="link-external-account-btn"]';
  }
  if (!row.waitMs || row.waitMs < 120000) row.waitMs = 120000;
}

/**
 * Deduplicate playwright rows that reference the same demo-script stepId.
 *
 * CLAUDE.md rule (Plaid Link section):
 *   "NEVER split into a goToStep entry + click entry for the same launch step —
 *    this causes duplicate markStep calls"
 *
 * The LLM occasionally emits two rows for the Plaid Link launch step (one
 * `goToStep` + one `click`, or two `click`s), which causes the recorder to
 * fire the Plaid Link flow twice, produces two step-timing windows for the
 * same stepId, and ultimately duplicates the narration clip in the
 * voiceover-manifest. The downstream fallout was observed on the Banner run:
 *   - step-timing had plaid-link-launch at [2] AND [3]
 *   - voiceover-manifest listed plaid-link-launch x2
 *   - the rendered MP4 repeated the Plaid Link narration at the ~42s mark
 *
 * Preference when collapsing duplicates:
 *   - For Plaid Link launch (row matches plaidPhase:"launch"): keep the
 *     single `click` on [data-testid="link-external-account-btn"] (modal mode),
 *     or the single `goToStep` (embedded mode). The `normalizeLaunchPlaywrightRow`
 *     above has already fixed up the first row's action/target/waitMs, so we
 *     simply keep the first and drop the rest.
 *   - For any other duplicate stepId (shouldn't happen, but defensive):
 *     prefer rows with action:"click" (carries user intent) over "goToStep".
 */
function dedupePlaywrightRowsByStepId(playwrightScript, demoScript) {
  const rows = playwrightScript?.steps;
  if (!Array.isArray(rows) || rows.length < 2) return;

  const launchStep = (demoScript.steps || []).find((s) => s && s.plaidPhase === 'launch');
  const launchId = launchStep ? launchStep.id : null;

  const seenIndex = new Map();
  const droppedIds = [];
  const kept = [];
  for (const row of rows) {
    const sid = row.stepId || row.id;
    if (!sid) {
      // Rows without stepId are rare; keep them as-is rather than dropping.
      kept.push(row);
      continue;
    }
    if (!seenIndex.has(sid)) {
      seenIndex.set(sid, kept.length);
      kept.push(row);
      continue;
    }
    // Duplicate encountered. For the Plaid Link launch step, always keep the
    // first row (already normalized to click+link-external-account-btn or
    // goToStep+container by normalizeLaunchPlaywrightRow). For other steps,
    // prefer click actions over goToStep in the kept row.
    droppedIds.push(sid);
    const existingIdx = seenIndex.get(sid);
    if (sid !== launchId) {
      const existing = kept[existingIdx];
      const existingIsClick = String(existing.action || '').toLowerCase() === 'click';
      const newIsClick = String(row.action || '').toLowerCase() === 'click';
      if (newIsClick && !existingIsClick) {
        // Promote the click row by replacing the previously kept goToStep row.
        kept[existingIdx] = row;
      }
    }
  }
  if (droppedIds.length === 0) return;
  playwrightScript.steps = kept;
  console.warn(
    `[Build] Deduplicated ${droppedIds.length} playwright row(s) with repeated stepId(s): ` +
    `${Array.from(new Set(droppedIds)).join(', ')}. ` +
    `(CLAUDE.md: single playwright entry per launch step.)`
  );
}

/**
 * Strip LLM-hallucinated duplicate `data-testid` attributes from buttons.
 *
 * The build LLM occasionally emits buttons with TWO data-testid attributes,
 * usually because it tried to also stuff a CSS selector into the markup:
 *
 *   <button data-testid="continue-btn" onclick="..." data-testid="[data-testid=&quot;continue-btn&quot;]">…</button>
 *
 * That's invalid HTML — browsers honor only the first attribute, but the
 * literal selector string in the second attribute confuses Playwright's
 * `waitForSelector` and Vision QA reads the malformed markup as evidence of
 * a broken button. Real BofA / Chase fix flow surfaced four of these in a
 * single Chase run.
 *
 * Strategy: find every `<button …>` start-tag with ≥2 `data-testid=` occurrences,
 * keep the first, drop everything after that matches `data-testid="…"`.
 * Returns `{ html, fixedCount }`.
 */
function cleanMalformedTestidDuplicates(html) {
  if (!html || typeof html !== 'string') return { html, fixedCount: 0 };
  let fixedCount = 0;
  // Match the start-tag of any element that has a data-testid attribute.
  // We restrict to <button …>/<a …>/<div …> since those are the LLM's usual
  // offenders; broadening to .* would risk eating legitimate cross-tag content.
  const tagRe = /<(button|a|div)\b[^>]*\sdata-testid=[^>]*>/gi;
  const result = String(html).replace(tagRe, (tag) => {
    // Count how many data-testid attributes appear in this single tag.
    const occurrences = tag.match(/\sdata-testid\s*=\s*("[^"]*"|'[^']*')/gi) || [];
    if (occurrences.length < 2) return tag;
    // Keep the FIRST data-testid attribute, drop subsequent ones.
    let kept = false;
    const cleaned = tag.replace(
      /\sdata-testid\s*=\s*("[^"]*"|'[^']*')/g,
      (attr) => {
        if (!kept) { kept = true; return attr; }
        return ''; // drop
      }
    );
    if (cleaned !== tag) fixedCount++;
    return cleaned;
  });
  if (fixedCount > 0) {
    console.warn(
      `[Build] cleanMalformedTestidDuplicates: stripped ${fixedCount} duplicate data-testid attribute(s). ` +
      `(LLM hallucination; first attribute is canonical.)`
    );
  }
  return { html: result, fixedCount };
}

/**
 * Catch the Playwright "target testid is one step behind" bug.
 *
 * What goes wrong: the LLM is asked to produce one Playwright row per demo
 * step. For each click row, the `target` should be the testid of the button
 * INSIDE that step's `<div data-testid="step-X">…</div>` — i.e. the CTA that
 * navigates from this step to the next. The LLM frequently picks the button
 * from the PREVIOUS step (the one that brought us TO this step), because
 * narratively "what advances to step X" = "the click that landed us here".
 *
 * Real Chase Bank run failure: 4/7 steps targeted the prior step's testid.
 * Each row failed at `waitForSelector` because the targeted button was no
 * longer in the DOM (it lived in the now-hidden previous-step div).
 *
 * This validator:
 *   1. For each click row whose target is `[data-testid="X"]`, check that X
 *      exists INSIDE the step's own div.
 *   2. If not, attempt auto-fix by finding the primary CTA button INSIDE the
 *      step's div whose `onclick` calls `goToStep('<next-step-id>')`. That's
 *      the canonical "next" button.
 *   3. Only auto-fix when we can find exactly one matching button — bail out
 *      otherwise so we don't paper over a real authoring error.
 *
 * Returns `{ fixedCount, warningCount }`.
 */
function validatePlaywrightTargetsAgainstSteps(playwrightScript, demoScript, html) {
  const rows = playwrightScript?.steps;
  if (!Array.isArray(rows) || rows.length === 0) return { fixedCount: 0, warningCount: 0 };
  if (typeof html !== 'string' || !html) return { fixedCount: 0, warningCount: 0 };

  const orderedStepIds = (demoScript.steps || []).map(s => s && s.id).filter(Boolean);
  const launchId = (demoScript.steps || []).find(s => s && s.plaidPhase === 'launch')?.id || null;

  // Helper: extract the markup for a given step's container div.
  function extractStepBlock(stepId) {
    if (!stepId) return null;
    const safe = String(stepId).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp(
      `<div[^>]*\\bdata-testid="step-${safe}"[^>]*>[\\s\\S]*?(?=<div[^>]*\\bdata-testid="step-|<!--[\\s\\S]*?SIDE PANELS|<\\/body>|$)`,
      'i'
    );
    const m = String(html).match(re);
    return m ? m[0] : null;
  }

  // Helper: find the primary CTA button inside a step's block.
  //
  //   - When `nextId` is provided, prefer buttons whose onclick calls
  //     `goToStep('<nextId>')`. This is the strongest signal — "the button
  //     that advances to the next step in the script."
  //
  //   - When `nextId` is null (last step in the script) OR no button matches
  //     it, fall back to "the only btn-primary with ANY goToStep onclick."
  //     Ambiguous (>1 candidate) → return null so we don't auto-fix
  //     incorrectly. Last steps often navigate back to a "home" or "done"
  //     screen, which still represents the canonical CTA for that step.
  //
  // Always prefers `.btn-primary` over secondary buttons.
  function findPrimaryCtaToNext(stepBlock, nextId) {
    if (!stepBlock) return null;
    const buttonRe = /<button\b[^>]*>/gi;
    const allCandidates = [];
    let m;
    while ((m = buttonRe.exec(stepBlock))) {
      const tag = m[0];
      const onclickMatch = tag.match(/onclick\s*=\s*"([^"]*)"|onclick\s*=\s*'([^']*)'/i);
      const onclick = (onclickMatch && (onclickMatch[1] || onclickMatch[2])) || '';
      const goToMatch = onclick.match(/goToStep\s*\(\s*['"]([^'"]+)['"]/);
      const goToTarget = goToMatch ? goToMatch[1] : null;
      const tidMatch = tag.match(/\bdata-testid\s*=\s*"([^"]+)"|data-testid\s*=\s*'([^']+)'/);
      const testId = (tidMatch && (tidMatch[1] || tidMatch[2])) || null;
      if (!testId) continue;
      const isPrimary = /\bbtn[-\s]*primary\b|\bprimary\b/i.test(tag);
      allCandidates.push({ testId, isPrimary, goToTarget });
    }
    if (allCandidates.length === 0) return null;

    // Prefer exact next-step match.
    if (nextId) {
      const exact = allCandidates.filter(c => c.goToTarget === nextId);
      if (exact.length > 0) {
        const primary = exact.find(c => c.isPrimary);
        return primary ? primary.testId : exact[0].testId;
      }
    }

    // Fallback: the only btn-primary that has SOME goToStep onclick.
    const primaryWithGoTo = allCandidates.filter(c => c.isPrimary && c.goToTarget);
    if (primaryWithGoTo.length === 1) return primaryWithGoTo[0].testId;
    if (primaryWithGoTo.length > 1) return null; // ambiguous, don't guess

    // Final fallback: any single primary button (even without goToStep).
    const primaryAny = allCandidates.filter(c => c.isPrimary);
    if (primaryAny.length === 1) return primaryAny[0].testId;
    return null;
  }

  let fixedCount = 0;
  let warningCount = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || String(row.action || '').toLowerCase() !== 'click') continue;
    const target = String(row.target || '');
    const tidMatch = target.match(/\[data-testid=["']([^"']+)["']\]/);
    if (!tidMatch) continue;
    const targetTid = tidMatch[1];
    const stepId = row.stepId || row.id;
    if (!stepId) continue;
    const block = extractStepBlock(stepId);
    if (!block) continue; // step missing — different problem; skip
    // Already correct? Move on.
    if (new RegExp(`\\bdata-testid\\s*=\\s*["']${targetTid.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}["']`).test(block)) {
      continue;
    }

    // Drift detected. Try auto-fix.
    // Skip the launch step — its CTA is normalized separately by
    // normalizeLaunchPlaywrightRow which knows about live vs token-only mode.
    if (stepId === launchId) {
      console.warn(
        `[Build] validatePlaywrightTargets: target "${targetTid}" not in launch step "${stepId}" block — ` +
        `leaving alone (launch normalizer owns this row).`
      );
      warningCount++;
      continue;
    }

    const stepIdx = orderedStepIds.indexOf(stepId);
    const nextStepId = stepIdx >= 0 && stepIdx + 1 < orderedStepIds.length
      ? orderedStepIds[stepIdx + 1]
      : null;
    const candidate = findPrimaryCtaToNext(block, nextStepId);
    if (candidate && candidate !== targetTid) {
      console.warn(
        `[Build] validatePlaywrightTargets: step "${stepId}" target "${targetTid}" is not in this step's div ` +
        `(LLM picked the previous step's button). Auto-fixing to "${candidate}" (CTA → ${nextStepId}).`
      );
      row.target = `[data-testid="${candidate}"]`;
      fixedCount++;
    } else {
      console.warn(
        `[Build] validatePlaywrightTargets: step "${stepId}" target "${targetTid}" is not in this step's div, ` +
        `but no unambiguous CTA → "${nextStepId || '(no next step)'}" was found. Leaving as-is — author should review.`
      );
      warningCount++;
    }
  }
  if (fixedCount > 0 || warningCount > 0) {
    console.warn(`[Build] validatePlaywrightTargets: fixed ${fixedCount}, warned ${warningCount}.`);
  }
  return { fixedCount, warningCount };
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
  const launchStepRe = new RegExp(
    `<div[^>]+data-testid="step-${launch.id}"[^>]*>[\\s\\S]*?data-testid=["']link-external-account-btn["']`,
    'i'
  );
  if (launchStepRe.test(html)) {
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

function ensureEmbeddedContainerInLaunchStep(html, demoScript, linkModeAdapter) {
  if (!PLAID_LINK_LIVE || !linkModeAdapter || linkModeAdapter.id !== 'embedded') {
    return { html, injected: false };
  }
  const launch = (demoScript.steps || []).find((s) => s && s.plaidPhase === 'launch');
  if (!launch) return { html, injected: false };
  const hasContainerInLaunch = new RegExp(
    `<div[^>]+data-testid="step-${launch.id}"[^>]*>[\\s\\S]*?data-testid=["']plaid-embedded-link-container["']`,
    'i'
  ).test(html);
  if (hasContainerInLaunch) return { html, injected: false };

  const launchStepCloseRe = new RegExp(`(<div[^>]+data-testid="step-${launch.id}"[^>]*>[\\s\\S]*?)(</div>)`, 'i');
  const fallbackContainer =
    `\n      <div data-testid="plaid-embedded-link-container" aria-label="Plaid Embedded Link Container"` +
    ` style="width:100%;max-width:430px;min-height:390px;height:390px;margin:16px auto 0;border:1px solid rgba(0,0,0,0.08);border-radius:12px;overflow:visible;background:#ffffff;"></div>\n`;

  const patched = html.replace(launchStepCloseRe, (_m, pre, close) => {
    if (pre.includes('data-testid="plaid-embedded-link-container"')) return `${pre}${close}`;
    return `${pre}${fallbackContainer}${close}`;
  });
  return { html: patched, injected: patched !== html };
}

/**
 * Embedded-only sanitizer:
 * - keep canonical launch selector on plaidPhase:"launch" step only
 * - rewrite non-launch duplicates to non-canonical selector to prevent QA drift
 */
function sanitizeEmbeddedLaunchSelectorsInHtml(html, demoScript, linkModeAdapter) {
  if (!PLAID_LINK_LIVE || !linkModeAdapter || linkModeAdapter.id !== 'embedded') {
    return { html, changed: false, demotedCount: 0 };
  }
  const launch = (demoScript.steps || []).find((s) => s && s.plaidPhase === 'launch');
  if (!launch?.id) return { html, changed: false, demotedCount: 0 };

  const stepChunkRe = /(<div[^>]+data-testid="step-([^"]+)"[^>]*>)([\s\S]*?)(?=<div[^>]+data-testid="step-[^"]+"|<\/body>)/gi;
  let changed = false;
  let demotedCount = 0;
  let launchHasCanonical = false;

  const next = html.replace(stepChunkRe, (_m, openTag, stepId, body) => {
    if (stepId === launch.id) {
      if (/data-testid=["']link-external-account-btn["']/i.test(body)) launchHasCanonical = true;
      return `${openTag}${body}`;
    }
    const patchedBody = body.replace(/data-testid=["']link-external-account-btn["']/gi, () => {
      demotedCount += 1;
      changed = true;
      return 'data-testid="link-external-account-btn-nonlaunch"';
    });
    return `${openTag}${patchedBody}`;
  });

  // Ensure launch step still has canonical selector after demotion pass.
  if (!launchHasCanonical) {
    const launchChunkRe = new RegExp(`(<div[^>]+data-testid="step-${launch.id}"[^>]*>[\\s\\S]*?)data-testid=["']link-external-account-btn-nonlaunch["']`, 'i');
    const repaired = next.replace(launchChunkRe, '$1data-testid="link-external-account-btn"');
    if (repaired !== next) {
      changed = true;
      return { html: repaired, changed, demotedCount };
    }
  }

  return { html: next, changed, demotedCount };
}

function escapeHtmlText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function deriveLaunchButtonLabel(innerHtml) {
  const text = String(innerHtml || '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#\d+;|&#x[\da-f]+;|&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^A-Za-z0-9]+/, '')
    .trim();
  if (!text) return 'Link Bank Account';
  if (text.length > 64) return 'Link Bank Account';
  return text;
}

function inferEmbeddedUseCaseText(promptText = '', demoScript = null) {
  const scriptText = demoScript ? JSON.stringify(demoScript) : '';
  return `${promptText || ''}\n${scriptText}`.toLowerCase();
}

/**
 * Runtime shim + injected container bounds: same footprint as
 * `resolveEmbeddedLinkSizeProfile` + `EMBEDDED_LINK_SIZE_PROFILES` so live QA
 * matches normalized HTML.
 */
function resolveEmbeddedRuntimeSizingProfile(html, demoScript, promptText = '') {
  const profile = resolveEmbeddedLinkSizeProfile(html, demoScript);
  const sizing = EMBEDDED_LINK_SIZE_PROFILES[profile] || EMBEDDED_LINK_SIZE_PROFILES.default;
  const text = inferEmbeddedUseCaseText(promptText, demoScript);
  const isInboundFunding =
    /\binbound\b|\baccount funding\b|\bfunding\b|\bincoming payment\b|\badd funds\b|\bwallet\b|\bdeposit\b/.test(text);
  return {
    useCase: isInboundFunding ? 'account-funding' : 'general-embedded',
    minWidthPx: sizing.width,
    minHeightPx: sizing.height,
    sizeProfile: profile,
  };
}

function enforceCanonicalLaunchButtonIcon(html) {
  if (!html.includes('data-testid="link-external-account-btn"')) {
    return { html, patched: false };
  }
  let patched = false;
  const buttonRe = /(<button\b[^>]*data-testid=["']link-external-account-btn["'][^>]*>)([\s\S]*?)(<\/button>)/gi;
  const next = html.replace(buttonRe, (_m, openTag, inner, closeTag) => {
    const label = escapeHtmlText(deriveLaunchButtonLabel(inner));
    const canonicalInner = `\n        ${STOCK_LINK_BUTTON_ICON_SVG}\n        <span>${label}</span>\n      `;
    const normalizedExisting = String(inner || '').replace(/\s+/g, ' ').trim();
    const normalizedCanonical = canonicalInner.replace(/\s+/g, ' ').trim();
    if (normalizedExisting === normalizedCanonical) return `${openTag}${inner}${closeTag}`;
    patched = true;
    return `${openTag}${canonicalInner}${closeTag}`;
  });
  return { html: next, patched };
}

/**
 * When `investments` is requested, include `auth` + `identity` so Link matches typical
 * Investments Move / held-away flows (brokerage account + identifiers + ownership signals).
 */
function enrichProductsForInvestmentsMode(products) {
  if (!Array.isArray(products) || !products.length) return products;
  const lower = products.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean);
  if (!lower.includes('investments')) return lower;
  const out = [...lower];
  for (const x of ['auth', 'identity']) {
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * POST /api/create-link-token JSON for the build-injected embedded-Link shim.
 * Prefers `product-research.json` → `linkTokenCreate.suggestedClientRequest`, else infers
 * `products` from prompt + demo-script (same heuristics as research).
 */
function buildEmbeddedCreateLinkTokenFetchBody(linkTokenCreate, demoScript, promptText) {
  const personaCo = String(demoScript?.persona?.company || '').trim();
  const scr =
    linkTokenCreate && typeof linkTokenCreate.suggestedClientRequest === 'object'
      ? linkTokenCreate.suggestedClientRequest
      : null;

  if (scr) {
    const out = {};
    const rawName = scr.client_name || scr.clientName;
    const cn = rawName != null ? String(rawName).trim() : '';
    if (cn && cn !== '<BrandName>') out.client_name = cn;
    else if (personaCo) out.client_name = personaCo;
    else if (cn) out.client_name = 'Plaid Demo';

    if (Array.isArray(scr.products) && scr.products.length) {
      const rawList = scr.products.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean);
      out.products = linkTokenCreate && linkTokenCreate.askBillOnlyInvestmentsMoveAuthGet
        ? rawList
        : enrichProductsForInvestmentsMode(rawList);
    }
    const uid = scr.user_id || scr.userId;
    if (uid) out.user_id = String(uid);
    if (scr.phone_number != null && scr.phone_number !== '') out.phone_number = scr.phone_number;
    if (scr.phoneNumber != null && scr.phoneNumber !== '') out.phone_number = scr.phoneNumber;
    if (scr.link_customization_name) out.link_customization_name = scr.link_customization_name;
    if (scr.linkCustomizationName) out.link_customization_name = scr.linkCustomizationName;
    if (scr.user && typeof scr.user === 'object' && !Array.isArray(scr.user)) out.user = scr.user;

    if (Array.isArray(out.products) && out.products.length) {
      if (!out.user_id) out.user_id = 'demo-user-001';
      return out;
    }
  }

  if (linkTokenCreate && linkTokenCreate.askBillOnlyInvestmentsMoveAuthGet) {
    const out = { user_id: 'demo-user-001' };
    if (personaCo) out.client_name = personaCo;
    if (Array.isArray(linkTokenCreate.products) && linkTokenCreate.products.length) {
      out.products = [...linkTokenCreate.products];
    }
    return out;
  }

  const blob = `${String(promptText || '')}\n${JSON.stringify(demoScript || {})}`;
  let products = inferPlaidLinkProductsFromPrompt(blob);
  if (!products.length) products = ['auth', 'identity'];
  else products = enrichProductsForInvestmentsMode(products);

  const body = {
    user_id: 'demo-user-001',
    products,
  };
  if (personaCo) body.client_name = personaCo;
  return body;
}

function injectEmbeddedLinkRuntimeHandler(html, demoScript, linkModeAdapter, promptText = '', linkTokenCreate = null) {
  if (!PLAID_LINK_LIVE || !linkModeAdapter || linkModeAdapter.id !== 'embedded') return { html, injected: false };
  if (!html.includes('</body>')) {
    return { html, injected: false };
  }
  const sizingProfile = resolveEmbeddedRuntimeSizingProfile(html, demoScript, promptText);
  const embeddedLinkTokenPayload = buildEmbeddedCreateLinkTokenFetchBody(linkTokenCreate, demoScript, promptText);
  if (/Plaid\.createEmbedded\s*\(/.test(html)) {
    if (html.includes('window.__embeddedLinkLayoutShimApplied')) return { html, injected: false };
    const layoutShim = `<script>
(function() {
  if (window.__embeddedLinkLayoutShimApplied) return;
  window.__embeddedLinkLayoutShimApplied = true;
  window.__plaidLinkMode = 'embedded';
  var sizingProfile = ${JSON.stringify(sizingProfile)};
  function enforceEmbeddedContainerBounds(container) {
    if (!container) return;
    container.style.display = 'block';
    container.style.overflow = 'visible';
    container.style.width = '100%';
    var _embH = String(sizingProfile.minHeightPx || 300) + 'px';
    container.style.minHeight = _embH;
    container.style.height = _embH;
    container.style.minWidth = String(sizingProfile.minWidthPx || 350) + 'px';
    container.style.marginInline = '0';
    container.style.marginLeft = '0';
    container.style.marginRight = 'auto';
    container.style.alignSelf = 'flex-start';
  }
  function syncEmbeddedLayout() {
    var container = document.querySelector('[data-testid="plaid-embedded-link-container"]') || document.getElementById('plaid-embedded-link-container');
    if (!container) return;
    enforceEmbeddedContainerBounds(container);
  }
  var _origGoToStep = typeof window.goToStep === 'function' ? window.goToStep : null;
  if (_origGoToStep) {
    window.goToStep = function(id) {
      var out = _origGoToStep.apply(this, arguments);
      setTimeout(syncEmbeddedLayout, 0);
      return out;
    };
  }
  window.addEventListener('resize', function() { syncEmbeddedLayout(); });
  setTimeout(syncEmbeddedLayout, 0);
})();
</script>`;
    return { html: html.replace('</body>', `${layoutShim}\n</body>`), injected: true };
  }
  if (html.includes('window.__embeddedLinkRuntimePatched')) return { html, injected: false };
  const launch = (demoScript.steps || []).find((s) => s && s.plaidPhase === 'launch');
  const launchStepId = launch?.id || null;
  const steps = Array.isArray(demoScript?.steps) ? demoScript.steps : [];
  const launchIdx = launchStepId ? steps.findIndex((s) => s && s.id === launchStepId) : -1;
  const firstPostLinkStepId = launchIdx >= 0 && launchIdx < steps.length - 1 ? steps[launchIdx + 1]?.id || null : null;
  const patch = `<script>
(function() {
  if (window.__embeddedLinkRuntimePatched) return;
  window.__embeddedLinkRuntimePatched = true;
  var sizingProfile = ${JSON.stringify(sizingProfile)};
  window.__plaidLinkMode = 'embedded';
  window.__embeddedLinkWidgetLoaded = false;
  window.__embeddedLinkError = null;
  window.__embeddedLinkMountMode = null;

  function getLaunchStepEl() {
    if (!${JSON.stringify(launchStepId)}) return null;
    return document.querySelector('[data-testid="step-' + ${JSON.stringify(launchStepId)} + '"]');
  }

  function enforceLaunchSelectorColocation() {
    var launchStep = getLaunchStepEl();
    if (!launchStep) {
      var embeddedContainer = document.querySelector('[data-testid="plaid-embedded-link-container"], #plaid-embedded-link-container');
      launchStep = embeddedContainer && embeddedContainer.closest ? embeddedContainer.closest('.step[data-testid]') : null;
    }
    if (!launchStep) return;
    var canonicalBtns = Array.from(document.querySelectorAll('[data-testid="link-external-account-btn"]'));
    for (var i = 0; i < canonicalBtns.length; i++) {
      var btn = canonicalBtns[i];
      if (!btn) continue;
      if (!launchStep.contains(btn)) {
        btn.setAttribute('data-testid', 'link-external-account-btn-nonlaunch');
      }
    }
    var launchCanonical = launchStep.querySelector('[data-testid="link-external-account-btn"]');
    if (launchCanonical && !launchCanonical.querySelector('svg')) {
      launchCanonical.insertAdjacentHTML(
        'afterbegin',
        '<svg class="stock-link-icon" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true" style="width:20px;height:20px;min-width:20px;min-height:20px;flex-shrink:0;display:block;box-sizing:content-box"><path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.242a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>'
      );
    }
  }

  function ensureEmbeddedContainer() {
    enforceLaunchSelectorColocation();
    var launchStep = getLaunchStepEl();
    if (!launchStep) return null;
    var container = launchStep.querySelector('[data-testid="plaid-embedded-link-container"]');
    if (!container) {
      container = document.createElement('div');
      container.setAttribute('data-testid', 'plaid-embedded-link-container');
      container.setAttribute('aria-label', 'Plaid Embedded Link Container');
      container.style.width = '100%';
      container.style.overflow = 'visible';
      var _embH2 = String(sizingProfile.minHeightPx || 300) + 'px';
      container.style.minHeight = _embH2;
      container.style.height = _embH2;
      container.style.minWidth = String(sizingProfile.minWidthPx || 350) + 'px';
      container.style.marginTop = '16px';
      container.style.border = '1px solid rgba(0,0,0,0.08)';
      container.style.borderRadius = '12px';
      container.style.background = '#ffffff';
      var launchBtn = launchStep.querySelector('[data-testid="link-external-account-btn"]');
      if (launchBtn && launchBtn.parentNode) launchBtn.parentNode.insertBefore(container, launchBtn.nextSibling);
      else launchStep.appendChild(container);
    }
    container.style.display = 'block';
    container.style.overflow = 'visible';
    var _embH3 = String(sizingProfile.minHeightPx || 300) + 'px';
    container.style.minHeight = _embH3;
    container.style.height = _embH3;
    container.style.minWidth = String(sizingProfile.minWidthPx || 350) + 'px';
    container.style.marginInline = '0';
    container.style.marginLeft = '0';
    container.style.marginRight = 'auto';
    container.style.alignSelf = 'flex-start';
    return container;
  }

  async function mountEmbeddedLink() {
    var container = ensureEmbeddedContainer();
    if (!container) return;
    if (window.__plaidEmbeddedInstance) return;
    var payload = ${JSON.stringify(embeddedLinkTokenPayload)};
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
      if (!window.Plaid) throw new Error('Plaid SDK is unavailable');
      var onSuccess = function(public_token, metadata) {
        try {
          window._plaidPublicToken = public_token || '';
          window._plaidInstitutionName = metadata && metadata.institution ? metadata.institution.name : (window._plaidInstitutionName || '');
          window._plaidAccountName = metadata && metadata.accounts && metadata.accounts[0] ? metadata.accounts[0].name : (window._plaidAccountName || '');
          window._plaidAccountMask = metadata && metadata.accounts && metadata.accounts[0] ? metadata.accounts[0].mask : (window._plaidAccountMask || '');
          window._plaidLinkComplete = true;
          ${firstPostLinkStepId ? `if (typeof window.goToStep === 'function') window.goToStep(${JSON.stringify(firstPostLinkStepId)});` : ''}
        } catch (_) {}
      };
      var onExit = function(err) {
        if (err) window.__embeddedLinkError = String(err.message || err);
      };
      var onEvent = function(name, meta) {
        if (typeof window.addLinkEvent === 'function') {
          try { window.addLinkEvent(name, meta); } catch (_) {}
        }
      };
      if (typeof window.Plaid.createEmbedded === 'function') {
        window.__plaidEmbeddedInstance = window.Plaid.createEmbedded({
          token: data.link_token,
          onSuccess: onSuccess,
          onExit: onExit,
          onEvent: onEvent,
          onLoad: function() { window.__embeddedLinkWidgetLoaded = true; }
        }, container);
        window.__embeddedLinkWidgetLoaded = true;
        window.__embeddedLinkMountMode = 'createEmbedded';
      } else if (typeof window.Plaid.create === 'function') {
        // Fallback for older SDK snapshots while preserving in-page auto-launch behavior.
        window._plaidHandler = window.Plaid.create({
          token: data.link_token,
          onSuccess: onSuccess,
          onExit: onExit,
          onEvent: onEvent,
        });
        if (window._plaidHandler && typeof window._plaidHandler.open === 'function') window._plaidHandler.open();
        window.__embeddedLinkWidgetLoaded = true;
        window.__embeddedLinkMountMode = 'modal-fallback';
      } else {
        throw new Error('Plaid SDK does not support createEmbedded or create');
      }
    } catch (err) {
      window.__embeddedLinkError = String((err && err.message) || err || 'embedded-link-launch-failed');
      console.error('Embedded Link launch failed:', window.__embeddedLinkError);
    }
  }

  function maybeMountForActiveStep() {
    if (!${JSON.stringify(launchStepId)} || typeof window.getCurrentStep !== 'function') return;
    enforceLaunchSelectorColocation();
    var active = window.getCurrentStep();
    if (active === ('step-' + ${JSON.stringify(launchStepId)})) mountEmbeddedLink();
  }

  var _origGoToStep = typeof window.goToStep === 'function' ? window.goToStep : null;
  if (_origGoToStep) {
    window.goToStep = function(id) {
      var out = _origGoToStep.apply(this, arguments);
      setTimeout(maybeMountForActiveStep, 0);
      return out;
    };
  }

  document.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-testid="link-external-account-btn"]') : null;
    if (!btn) return;
    // Embedded mode auto-loads in-page; button remains as fallback trigger.
    enforceLaunchSelectorColocation();
    setTimeout(mountEmbeddedLink, 0);
  }, true);
  enforceLaunchSelectorColocation();
  setTimeout(maybeMountForActiveStep, 0);
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

function computeScriptSignature(demoScript) {
  const stable = {
    title: demoScript?.title || '',
    product: demoScript?.product || '',
    steps: (demoScript?.steps || []).map((s) => ({
      id: s?.id || '',
      label: s?.label || '',
      interaction: s?.interaction?.target || '',
      endpoint: s?.apiResponse?.endpoint || '',
      sceneType: s?.sceneType || '',
    })),
  };
  return require('crypto')
    .createHash('sha256')
    .update(JSON.stringify(stable))
    .digest('hex');
}

function readBuildMetadata() {
  if (!fs.existsSync(BUILD_METADATA_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(BUILD_METADATA_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeBuildMetadata(meta) {
  fs.mkdirSync(path.dirname(BUILD_METADATA_FILE), { recursive: true });
  fs.writeFileSync(BUILD_METADATA_FILE, JSON.stringify(meta, null, 2), 'utf8');
}

function extractRunIdsFromText(text) {
  const ids = new Set();
  const re = /(\d{4}-\d{2}-\d{2}-[a-z0-9-]+-v\d+)/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) ids.add(m[1]);
  return [...ids];
}

function scanArtifactForForeignRunIds(filePath, currentRunId) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return extractRunIdsFromText(raw).filter((id) => id !== currentRunId);
  } catch (_) {
    return [];
  }
}

function assertNoForeignRunReferences({ currentRunId, artifactPaths }) {
  const offenders = [];
  for (const p of artifactPaths || []) {
    const foreign = scanArtifactForForeignRunIds(p, currentRunId);
    if (foreign.length > 0) offenders.push({ path: p, foreignRunIds: foreign });
  }
  if (offenders.length > 0) {
    const detail = offenders
      .map((o) => `${path.basename(o.path)} -> ${[...new Set(o.foreignRunIds)].join(', ')}`)
      .join('; ');
    throw new Error(`Cross-run contamination check failed (${currentRunId}): ${detail}`);
  }
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
  console.log('[Build] Call 1: Generating architecture brief (claude-opus-4-7)...');

  const { system, userMessages } = buildAppArchitectureBriefPrompt(demoScript, {
    plaidLinkLive: PLAID_LINK_LIVE,
    plaidSkillBrief: briefOpts.plaidSkillBrief || '',
    plaidLinkMode: briefOpts.plaidLinkMode || 'modal',
    embeddedLinkSkillBrief: briefOpts.embeddedLinkSkillBrief || '',
    pipelineAppOnlyHostUi: !!briefOpts.pipelineAppOnlyHostUi,
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
    pipelineAppOnlyHostUi: !!frameworkOpts.pipelineAppOnlyHostUi,
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

  const stepsNeedingJsonRail = (demoScript.steps || []).filter((s) => {
    if (isValueSummaryStep(s)) return false;
    const r = s?.apiResponse?.response;
    return r != null && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length > 0;
  });
  if (stepsNeedingJsonRail.length > 0) {
    const needToggle = () =>
      html.includes('data-testid="api-panel-toggle"') ||
      html.includes("data-testid='api-panel-toggle'") ||
      html.includes('class="api-panel-edge-toggle"') ||
      html.includes("class='api-panel-edge-toggle'");
    if (!needToggle()) {
      layer1Issues.push('API JSON rail contract: missing data-testid="api-panel-toggle"');
    }
    if (!html.includes('id="api-response-content"') && !html.includes("id='api-response-content'")) {
      layer1Issues.push('API JSON rail contract: missing #api-response-content inside api-response-panel');
    }
  }

  for (const row of pwRows) {
    if (!row || !row.id || !stepIds.includes(row.id)) {
      layer2Issues.push(`Playwright row has unknown id: ${row && row.id ? row.id : '<missing>'}`);
    }
  }
  if (!pwRows.length) layer2Issues.push('Playwright script contains zero steps');
  const isEmbeddedMode = String(demoScript?.plaidLinkMode || '').toLowerCase() === 'embedded';
  if (PLAID_LINK_LIVE && !isEmbeddedMode && !html.includes('data-testid="link-external-account-btn"')) {
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
 * Call 2: Full app generation (claude-opus-4-7, streaming, extended thinking).
 * Streams progress dots to stdout.
 */
async function generateApp(client, demoScript, architectureBrief, qaReport, brand, refinementOpts = {}) {
  console.log('[Build] Call 2: Generating full HTML app (claude-opus-4-7 streaming)...');
  console.log('[Build] Progress: ');

  const designPlugin = loadDesignPlugin();
  const slideCssPath = path.join(PROJECT_ROOT, 'templates/slide-template/slide.css');
  const slideShellPath = path.join(PROJECT_ROOT, 'templates/slide-template/pipeline-slide-shell.html');
  const slideShellRulesPath = path.join(PROJECT_ROOT, 'templates/slide-template/PIPELINE_SLIDE_SHELL_RULES.md');
  const layerMockTemplatePath = path.join(PROJECT_ROOT, 'templates/mobile-layer-mock/LAYER_MOCK_TEMPLATE.md');
  const layerMobileSkeletonPath = path.join(
    PROJECT_ROOT,
    'templates/mobile-layer-mock/layer-mobile-skeleton-from-2026-03-23-layer-v2.html'
  );
  let slideTemplateRules = '';
  let slideTemplateCss = '';
  let slideTemplateShellHtml = '';
  let layerMockTemplate = '';
  let layerMobileSkeletonHtml = '';
  try {
    if (fs.existsSync(slideShellRulesPath)) {
      slideTemplateRules = fs.readFileSync(slideShellRulesPath, 'utf8');
    }
    if (fs.existsSync(slideCssPath)) slideTemplateCss = fs.readFileSync(slideCssPath, 'utf8');
    if (fs.existsSync(slideShellPath)) {
      slideTemplateShellHtml = fs.readFileSync(slideShellPath, 'utf8');
      slideTemplateShellHtml = slideTemplateShellHtml.replace(
        /\r?\n  \/\* ── Standalone file preview only[\s\S]*?\}\)\(\);\r?\n/,
        '\n'
      );
    }
    if (fs.existsSync(layerMockTemplatePath)) layerMockTemplate = fs.readFileSync(layerMockTemplatePath, 'utf8');
    if (fs.existsSync(layerMobileSkeletonPath)) {
      layerMobileSkeletonHtml = fs.readFileSync(layerMobileSkeletonPath, 'utf8');
      console.log('[Build] Loaded Layer mobile skeleton hard contract for build prompt');
    } else {
      console.warn('[Build] Layer mobile skeleton not found — hard contract block omitted:', layerMobileSkeletonPath);
    }
  } catch (e) {
    console.warn('[Build] Warning: could not load slide template assets:', e.message);
  }
  if (
    shouldInjectLayerMobileMockTemplate(demoScript, !!refinementOpts.mobileVisualEnabled) &&
    !String(layerMobileSkeletonHtml || '').trim()
  ) {
    console.error(
      '[Build] Layer mobile mock builds require the canonical skeleton at templates/mobile-layer-mock/layer-mobile-skeleton-from-2026-03-23-layer-v2.html (missing or empty).'
    );
    process.exit(1);
  }

  const siteRefPath = path.join(RUN_LAYOUT.brandDir, 'site-reference.png');
  let brandSiteReferenceBase64 = '';
  if (fs.existsSync(siteRefPath)) {
    try {
      brandSiteReferenceBase64 = fs.readFileSync(siteRefPath).toString('base64');
      console.log(`[Build] Brand site reference screenshot loaded (${path.relative(PROJECT_ROOT, siteRefPath)})`);
    } catch (e) {
      console.warn(`[Build] Could not read brand site reference: ${e.message}`);
    }
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
      slideTemplateShellHtml,
      layerMockTemplate,
      layerMobileSkeletonHtml,
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
      buildMode: refinementOpts.buildMode || 'app',
      slidePromptTier: refinementOpts.slidePromptTier || 'full',
      willRunSlidesPhase: !!refinementOpts.willRunSlidesPhase,
      promptText: refinementOpts.promptText || '',
      brandSiteReferenceBase64: brandSiteReferenceBase64 || undefined,
      linkTokenCreate: refinementOpts.linkTokenCreate || null,
      pipelineAppOnlyHostUi: !!refinementOpts.pipelineAppOnlyHostUi,
    }
  );

  const stream = await client.messages.stream({
    model:      BUILD_MODEL,
    max_tokens: BUILD_MAX_TOKENS,
    thinking: {
      type: 'adaptive',
    },
    output_config: {
      effort: 'high',
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

/**
 * Nudge generated slide steps toward `pipeline-slide-shell.html` + `slide.css`:
 * header endpoint row, callout flex alignment, panel min-width, scoped endpoint CSS.
 * Endpoint text is inferred from existing `POST /…` labels already present in the HTML
 * (same strings the insight steps use), so marketing copy on the slide is unchanged.
 */
function ensurePipelineSlideShellConformance(html) {
  if (!html.includes('slide-root')) return html;
  let out = html;

  if (!out.includes('.slide-header-endpoint{')) {
    const pillRuleRe = /(\.slide-header-pill\{[^}]+\})/;
    if (pillRuleRe.test(out)) {
      out = out.replace(
        pillRuleRe,
        '$1.slide-header-endpoint{font-size:13px;font-family:"SF Mono","Fira Code",Consolas,monospace;color:var(--slide-text-tertiary)}'
      );
      console.log('[Build] Slide shell: added .slide-header-endpoint to scoped slide CSS');
    }
  }

  const calloutShortRe =
    /\.slide-callout\{background:rgba\(255,255,255,0\.05\);border:1px solid rgba\(0,166,126,0\.28\);border-radius:14px;padding:18px 20px\}/;
  if (calloutShortRe.test(out) && !/\.slide-callout\{[^}]*align-self/.test(out)) {
    out = out.replace(
      calloutShortRe,
      '.slide-callout{align-self:flex-end;background:rgba(255,255,255,0.05);border:1px solid rgba(0,166,126,0.28);border-radius:14px;padding:18px 20px;min-width:360px}'
    );
    console.log('[Build] Slide shell: normalized .slide-callout rule to template');
  }

  out = out.replace(/\.slide-panel\{([^}]*min-width:)240px([^}]*)\}/, (_, a, b) => `${a}360px${b}`);

  const escapeHtmlText = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  function inferPostEndpointLineFromHtml(src) {
    const re = /POST\s\/[a-z0-9_/]+/gi;
    const seen = new Set();
    const ordered = [];
    let m;
    while ((m = re.exec(src)) !== null) {
      const norm = m[0].replace(/\s+/g, ' ');
      const key = norm.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(norm);
    }
    return ordered.join('  ·  ').slice(0, 240);
  }

  out = out.replace(
    /(<div class="slide-header-pill"[^>]*>[\s\S]*?<\/div>)(\s*)(<\/div>\s*<\/header>)/g,
    (full, pillClose, gap, headerTail) => {
      if (full.includes('slide-header-endpoint')) return full;
      const line = inferPostEndpointLineFromHtml(out);
      const inner = line
        ? `<div class="slide-header-endpoint" data-testid="slide-endpoint">${escapeHtmlText(line)}</div>`
        : '<div class="slide-header-endpoint" data-testid="slide-endpoint"></div>';
      return `${pillClose}${gap}${inner}${gap}${headerTail}`;
    }
  );

  out = out.replace(
    /(<aside class="slide-callout"[^>]*?)\s+style="[^"]*\balign-self\s*:\s*[^;"]+[^"]*"/gi,
    '$1'
  );

  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(opts = {}) {
  // Accept qaReportFile from orchestrator, fall back to CLI args
  const parsedArgs = parseArgs();
  const { qaReportPath: cliQaPath } = parsedArgs;
  const qaReportPath = opts.qaReportFile || cliQaPath;
  const requestedFixMode = String(opts.fixMode || 'fullbuild').toLowerCase().trim();
  const fixMode = requestedFixMode === 'touchup' ? 'touchup' : 'fullbuild';
  const requestedBuildMode = String(opts.buildMode || process.env.BUILD_MODE || 'app').toLowerCase().trim();
  const buildMode = requestedBuildMode === 'slides' ? 'slides' : 'app';
  const requestedSlidePromptTier = String(
    opts.slidePromptTier || process.env.SLIDE_PROMPT_TIER || ''
  ).toLowerCase().trim();
  const slidePromptTier = buildMode === 'slides'
    ? 'full'
    : (requestedSlidePromptTier === 'minimal' ? 'minimal' : 'full');
  const willRunSlidesPhase = opts.willRunSlidesPhase === true;
  const touchupStepId = typeof opts.touchupStepId === 'string' && opts.touchupStepId.trim()
    ? opts.touchupStepId.trim()
    : null;
  const fixModeReasons = Array.isArray(opts.fixModeReasonCodes) ? opts.fixModeReasonCodes : [];
  const skipArchitectureBrief = fixMode === 'touchup' && (process.env.BUILD_TOUCHUP_SKIP_BRIEF || 'true') !== 'false';
  console.log(
    `[Build] Fix mode: ${fixMode}` +
    (fixMode === 'touchup' && touchupStepId ? ` (step=${touchupStepId})` : '') +
    (fixModeReasons.length ? ` [reasons=${fixModeReasons.join(',')}]` : '')
  );
  console.log(`[Build] Build mode: ${buildMode}`);
  console.log(
    `[Build] Slide prompt tier: ${slidePromptTier}` +
    (buildMode === 'app' ? ` (slides-followup=${willRunSlidesPhase})` : '')
  );
  const layeredBuildEnabled = opts.layeredBuildEnabled != null
    ? !!opts.layeredBuildEnabled
    : (parsedArgs.layeredBuildEnabled || LAYERED_BUILD_ENABLED);
  const explicitMobileVisualRequested = !!(
    opts.mobileVisualEnabled === true ||
    parsedArgs.mobileVisualEnabled ||
    MOBILE_VISUAL_ENABLED
  );
  const configuredBuildViewMode = (opts.buildViewMode || parsedArgs.buildViewMode || BUILD_VIEW_MODE || 'desktop').toLowerCase();

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
  const { mutated: stepKindMutated } = annotateScriptWithStepKinds(demoScript);
  let scriptSanitized = stepKindMutated > 0;
  if (stepKindMutated > 0) {
    console.log(`[Build] stepKind back-filled on ${stepKindMutated} step(s)`);
  }
  for (const step of (demoScript.steps || [])) {
    if (isValueSummaryStep(step) && step.apiResponse) {
      delete step.apiResponse;
      scriptSanitized = true;
      console.log(`[Build] Removed apiResponse from "${step.id}" (value-summary slides must not carry JSON rails)`);
    }
  }
  if (scriptSanitized) {
    fs.writeFileSync(SCRIPT_FILE, JSON.stringify(demoScript, null, 2));
    console.log('[Build] Persisted sanitized demo-script.json (value-summary apiResponse removed)');
  }
  const runManifest = readRunManifest(OUT_DIR);
  const pipelineAppOnlyHostUi = !!(runManifest && String(runManifest.buildMode || '').toLowerCase() === 'app-only');
  if (pipelineAppOnlyHostUi) {
    console.log('[Build] App-only run: marketing value props + differentiators omitted from host-app build prompts');
  }
  const activeRunId = runManifest?.runId || RUN_LAYOUT.runId;
  const promptText = fs.existsSync(PROMPT_FILE) ? fs.readFileSync(PROMPT_FILE, 'utf8') : '';
  const inferredMobileVisualEnabled = promptIndicatesMobileVisual(promptText, demoScript);
  const mobileVisualForce = process.env.MOBILE_VISUAL_FORCE === 'true' || process.env.MOBILE_VISUAL_FORCE === '1';
  const mobileVisualEnabled =
    inferredMobileVisualEnabled || (explicitMobileVisualRequested && mobileVisualForce);
  const buildViewMode = mobileVisualEnabled ? configuredBuildViewMode : 'desktop';
  if (explicitMobileVisualRequested && !inferredMobileVisualEnabled && !mobileVisualForce) {
    console.warn(
      '[Build] Ignoring mobile visual request without explicit mobile-build prompt intent. ' +
      'Set MOBILE_VISUAL_FORCE=true to override.'
    );
  }
  console.log(`[Build] Loaded demo-script.json: ${demoScript.steps.length} steps for "${demoScript.product}"`);
  console.log(`[Build] Layered build: ${layeredBuildEnabled ? 'ENABLED' : 'disabled'}`);
  console.log(
    `[Build] Mobile visual mode: ${mobileVisualEnabled ? 'ENABLED' : 'disabled'} (viewMode=${buildViewMode})` +
    (inferredMobileVisualEnabled && !explicitMobileVisualEnabled ? ' [auto-detected from prompt]' : '')
  );
  const plaidLinkMode = resolveMode({ demoScript, promptText });
  const linkModeAdapter = getLinkModeAdapter(plaidLinkMode);
  demoScript.plaidLinkMode = plaidLinkMode;
  console.log(`[Build] Plaid Link mode: ${plaidLinkMode}`);
  const productFamily = inferProductFamily({ promptText, demoScript });
  const apiPanelQa = await hydrateApiSamplesForRelevantSlides(demoScript, productFamily);
  try {
    fs.mkdirSync(path.dirname(API_PANEL_QA_FILE), { recursive: true });
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
  let linkTokenCreate = null;
  if (fs.existsSync(RESEARCH_FILE)) {
    try {
      const research = JSON.parse(fs.readFileSync(RESEARCH_FILE, 'utf8'));
      if (research && research.solutionsMasterContext && typeof research.solutionsMasterContext === 'object') {
        solutionsMasterContext = research.solutionsMasterContext;
      }
      if (research && research.linkTokenCreate && typeof research.linkTokenCreate === 'object') {
        linkTokenCreate = research.linkTokenCreate;
        console.log(
          `[Build] link-token-create: products=[${(linkTokenCreate.products || []).join(', ')}]`
        );
      }
    } catch (e) {
      console.warn(`[Build] Could not parse product-research.json for Solutions Master context: ${e.message}`);
    }
  }
  let buildQaDiagnosticSummary = null;
  const buildQaDiagPath = fs.existsSync(BUILD_QA_DIAG_FILE)
    ? BUILD_QA_DIAG_FILE
    : (fs.existsSync(LEGACY_BUILD_QA_DIAG_FILE) ? LEGACY_BUILD_QA_DIAG_FILE : null);
  if (buildQaDiagPath) {
    try {
      const dq = JSON.parse(fs.readFileSync(buildQaDiagPath, 'utf8'));
      buildQaDiagnosticSummary = dq.summary && dq.summary.categoryCounts
        ? {
          categoryCounts: dq.summary.categoryCounts,
          criticalStepIds: dq.summary.criticalStepIds || [],
        }
        : summarizeBuildQaDiagnostics(dq.diagnostics);
      if (Object.keys(buildQaDiagnosticSummary.categoryCounts || {}).length) {
        console.log(`[Build] Loaded ${path.relative(PROJECT_ROOT, buildQaDiagPath)} summary for prompt context`);
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
  const resolvedQaPath = qaReportPath
    ? (path.isAbsolute(qaReportPath) ? qaReportPath : path.join(PROJECT_ROOT, qaReportPath))
    : null;

  assertNoForeignRunReferences({
    currentRunId: activeRunId,
    artifactPaths: [
      resolvedQaPath,
      fs.existsSync(PLAYWRIGHT_OUT) ? PLAYWRIGHT_OUT : null,
      fs.existsSync(HTML_OUT) ? HTML_OUT : null,
      buildQaDiagPath,
    ].filter(Boolean),
  });

  if (qaReportPath) {
    if (fs.existsSync(resolvedQaPath)) {
      try {
        qaReport = JSON.parse(fs.readFileSync(resolvedQaPath, 'utf8'));
        console.log(`[Build] Loaded QA report: ${resolvedQaPath} (score: ${qaReport.overallScore}/100)`);

        const refineStepScope = parseBuildRefineStepIdScope();
        if (refineStepScope && qaReport) {
          const origIssues = Array.isArray(qaReport.stepsWithIssues) ? qaReport.stepsWithIssues : [];
          const origSteps = Array.isArray(qaReport.steps) ? qaReport.steps : [];
          if (origIssues.length > 0) {
            const nextIssues = origIssues.filter((s) => s && refineStepScope.has(String(s.stepId)));
            if (nextIssues.length === 0) {
              console.warn(
                '[Build] BUILD_REFINE_STEP_IDS matched no stepsWithIssues — check ids; using full QA context.'
              );
            } else {
              qaReport = {
                ...qaReport,
                stepsWithIssues: nextIssues,
                steps: origSteps.filter((s) => s && refineStepScope.has(String(s.stepId))),
              };
              console.log(
                `[Build] BUILD_REFINE_STEP_IDS: narrowed refinement context to ${nextIssues.length} failing step(s)`
              );
            }
          } else if (origSteps.length > 0) {
            const nextSteps = origSteps.filter((s) => s && refineStepScope.has(String(s.stepId)));
            if (nextSteps.length > 0) {
              qaReport = { ...qaReport, steps: nextSteps };
              console.log(
                `[Build] BUILD_REFINE_STEP_IDS: narrowed qa.steps to ${nextSteps.length} row(s) (report had empty stepsWithIssues)`
              );
            } else {
              console.warn(
                '[Build] BUILD_REFINE_STEP_IDS matched no qa.steps — check ids; using full QA context.'
              );
            }
          }
        }

        // Load QA frame images for steps that failed — visual context for the build agent.
        // Without frames, the agent is fixing visual problems from a text description alone.
        //
        // Frame-naming reality: there are TWO conventions in this codebase:
        //   (A) Post-record QA writes        `qa-frames/<stepId>-{start,mid,end}.png`
        //   (B) Build-QA writes              `artifacts/qa/frames/<stepId>-buildqa-<rowIndex>-{start,mid,end}.png`
        //                                     (also mirrored to `qa-frames/<stepId>-buildqa-...`)
        // Until the fix below, only (A) was searched for, which meant the LLM touchup
        // loop got ZERO visual context after a build-QA failure (since build-QA only
        // writes (B) names). Now we try both conventions per (suffix, stepId), preferring
        // the latest rowIndex of (B) when present.
        const framesDirPrimary = path.join(RUN_LAYOUT.qaDir, 'frames');
        const framesDirLegacy = path.join(OUT_DIR, 'qa-frames');
        const framesDirsToScan = [framesDirPrimary, framesDirLegacy].filter((d) => {
          try { return fs.existsSync(d); } catch (_) { return false; }
        });
        const failedSteps = (qaReport.stepsWithIssues || []).map(s => s.stepId).filter(Boolean);
        if (failedSteps.length > 0 && framesDirsToScan.length > 0) {
          if (failedSteps.length > 8) {
            console.warn(`[Build] WARNING: ${failedSteps.length} failed steps but only 8 included in refinement context — subsequent passes needed`);
          }

          /**
           * Resolve a single frame path for `(stepId, suffix)`. Strategy:
           *   1. Direct hit on `<stepId>-<suffix>.png` (post-record convention).
           *   2. Highest-rowIndex match for `<stepId>-buildqa-<row>-<suffix>.png`
           *      across all known frames dirs (build-QA convention).
           */
          const resolveFramePath = (stepId, suffix) => {
            for (const dir of framesDirsToScan) {
              const direct = path.join(dir, `${stepId}-${suffix}.png`);
              if (fs.existsSync(direct)) return direct;
            }
            const buildQaPattern = new RegExp(
              `^${stepId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}-buildqa-(\\d+)-${suffix}\\.png$`,
            );
            let best = null;
            for (const dir of framesDirsToScan) {
              let files;
              try { files = fs.readdirSync(dir); } catch (_) { continue; }
              for (const f of files) {
                const m = f.match(buildQaPattern);
                if (!m) continue;
                const rowIndex = parseInt(m[1], 10);
                if (!best || rowIndex > best.rowIndex) {
                  best = { rowIndex, file: path.join(dir, f) };
                }
              }
            }
            return best ? best.file : null;
          };

          for (const stepId of failedSteps.slice(0, 8)) { // cap to limit token budget
            for (const suffix of ['start', 'mid']) {
              const framePath = resolveFramePath(stepId, suffix);
              if (framePath) {
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

  if (fixMode === 'touchup' && qaReport && touchupStepId) {
    const originalIssueCount = Array.isArray(qaReport.stepsWithIssues) ? qaReport.stepsWithIssues.length : 0;
    const originalStepCount = Array.isArray(qaReport.steps) ? qaReport.steps.length : 0;
    qaReport = {
      ...qaReport,
      stepsWithIssues: Array.isArray(qaReport.stepsWithIssues)
        ? qaReport.stepsWithIssues.filter((s) => s?.stepId === touchupStepId)
        : [],
      steps: Array.isArray(qaReport.steps)
        ? qaReport.steps.filter((s) => s?.stepId === touchupStepId)
        : [],
    };
    qaFrames = qaFrames.filter((f) => f.stepId === touchupStepId);
    console.log(
      `[Build] Touchup scope: narrowed QA context to step "${touchupStepId}" ` +
      `(issues ${originalIssueCount}->${qaReport.stepsWithIssues.length}, steps ${originalStepCount}->${qaReport.steps.length}, frames=${qaFrames.length})`
    );
  }

  // ── Load human reviewer feedback (optional) ──────────────────────────────
  let humanFeedback = null;
  const feedbackSources = [RUN_FEEDBACK_FILE, path.join(OUT_DIR, 'build-feedback.md'), FEEDBACK_FILE];
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
  let architectureBrief = '';
  if (skipArchitectureBrief) {
    architectureBrief =
      'TOUCHUP MODE: Preserve existing app structure, DOM contract, and test IDs. ' +
      'Apply minimal, localized fixes for the scoped QA issues only.';
    console.log('[Build] Touchup mode: skipping architecture brief call.');
  } else {
    architectureBrief = await getArchitectureBrief(client, demoScript, {
        // Token budget: raise via smaller skill zip or future BUILD_SKILL_BRIEF_MAX_CHARS if prompts hit limits.
        plaidSkillBrief: skillBundle.skillLoaded ? skillBundle.text.slice(0, 12000) : '',
      plaidLinkMode,
      embeddedLinkSkillBrief: embeddedLinkSkillBundle.skillLoaded ? embeddedLinkSkillBundle.text.slice(0, 6000) : '',
      pipelineAppOnlyHostUi,
    });
  }

  // ── Call 1b: Optional layered framework contract ──────────────────────────
  let layeredBuildPlan = null;
  if (layeredBuildEnabled) {
    layeredBuildPlan = await getFrameworkPlan(client, demoScript, architectureBrief, {
      mobileVisualEnabled,
      buildViewMode,
      promptText,
      pipelineAppOnlyHostUi,
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
      linkTokenCreate,
      buildQaDiagnosticSummary,
      plaidSkillMarkdown: skillBundle.skillLoaded ? skillBundle.text : '',
      plaidLinkUxSkillMarkdown: linkUxSkillBundle.skillLoaded ? linkUxSkillBundle.text : '',
      embeddedLinkSkillMarkdown: embeddedLinkSkillBundle.skillLoaded ? embeddedLinkSkillBundle.text : '',
      plaidLinkMode,
      layeredBuildEnabled,
      layeredBuildPlan,
      mobileVisualEnabled,
      buildViewMode,
      fixMode,
      touchupStepId,
      buildMode,
      slidePromptTier,
      willRunSlidesPhase,
      promptText,
      pipelineAppOnlyHostUi,
    });

  // ── Parse response ────────────────────────────────────────────────────────
  let html, playwrightScript;
  const scriptSignature = computeScriptSignature(demoScript);
  const priorBuildMeta = readBuildMetadata();
  const allowPlaywrightFallback = !!(
    priorBuildMeta &&
    priorBuildMeta.runId === (runManifest?.runId || RUN_LAYOUT.runId) &&
    priorBuildMeta.scriptSignature === scriptSignature
  );
  try {
    ({ html, playwrightScript } = parseAppResponse(rawResponse, {
      fallbackPlaywrightPath:
        allowPlaywrightFallback && fs.existsSync(PLAYWRIGHT_OUT) ? PLAYWRIGHT_OUT : null,
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
    if (have < need && allowPlaywrightFallback && fs.existsSync(PLAYWRIGHT_OUT)) {
      try {
        const prev = JSON.parse(fs.readFileSync(PLAYWRIGHT_OUT, 'utf8'));
        const ps = prev && prev.steps;
        if (Array.isArray(ps) && ps.length >= need) {
          const merged = playwrightScript.steps.slice();
          for (let i = merged.length; i < need; i++) merged.push(ps[i]);
          playwrightScript = { steps: merged };
          console.warn(
            `[Build] Playwright steps: merged ${have} new row(s) + ${need - have} from previous build ` +
            `(same-run/same-script recovery).`
          );
        }
      } catch (_) {}
    }
  }

  // Strip LLM-hallucinated duplicate data-testid attributes BEFORE we run
  // any Playwright-target validation — otherwise the validator could match
  // the bogus inner attribute and miss the real bug.
  const cleanResult = cleanMalformedTestidDuplicates(html);
  if (cleanResult.fixedCount > 0) {
    html = cleanResult.html;
  }

  repairPlaywrightInsightNavigation(playwrightScript, demoScript);
  normalizeLaunchPlaywrightRow(playwrightScript, demoScript);
  normalizeFinalSlidePlaywrightRow(playwrightScript, demoScript);
  dedupePlaywrightRowsByStepId(playwrightScript, demoScript);
  // Catch the "target testid is in the previous step's div" drift that broke
  // ~60% of Chase Bank QA runs. Auto-fixes when an unambiguous CTA-to-next
  // exists; warns otherwise. Runs LAST so it sees the cleaned HTML +
  // normalized rows.
  validatePlaywrightTargetsAgainstSteps(playwrightScript, demoScript, html);

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
  const stepsWithApiData = (demoScript.steps || []).filter((s) =>
    !isValueSummaryStep(s) && hasApiEndpoint(s) && s.apiResponse?.response
  );
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
    // Deterministic panel chrome merge: enforce a single edge toggle icon control.
    if (hasPanel) {
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
        if (merged) {
          console.log('[Build] Enforced canonical API panel edge toggle via template merge');
        } else {
          domErrors.push('Failed to inject canonical API panel edge toggle into #api-response-panel.');
        }
      }
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
  //    Auto-sanitize this first, then fail only if any display style remains.
  let strippedStepDisplayStyles = 0;
  html = html.replace(/<div\b[^>]*style="[^"]*"[^>]*>/gi, (tag) => {
    const isStepDiv = /\bdata-testid="step-[^"]*"|\bclass="[^"]*\bstep\b[^"]*"/i.test(tag);
    if (!isStepDiv) return tag;
    const styleMatch = tag.match(/\bstyle="([^"]*)"/i);
    if (!styleMatch) return tag;
    const originalStyle = String(styleMatch[1] || '');
    const cleanedStyle = originalStyle
      .replace(/\bdisplay\s*:[^;"]*;?/gi, '')
      .replace(/;;+/g, ';')
      .replace(/^\s*;\s*|\s*;\s*$/g, '')
      .trim();
    if (cleanedStyle === originalStyle.trim()) return tag;
    strippedStepDisplayStyles += 1;
    if (!cleanedStyle) {
      return tag.replace(/\s*\bstyle="[^"]*"/i, '');
    }
    return tag.replace(/\bstyle="[^"]*"/i, `style="${cleanedStyle}"`);
  });
  if (strippedStepDisplayStyles > 0) {
    console.log(`[Build] Removed inline display style from ${strippedStepDisplayStyles} step div(s)`);
  }
  const stepDisplayStyle = html.match(
    /<div[^>]*(?:data-testid="step-[^"]*"|class="[^"]*\bstep\b[^"]*")[^>]*style="[^"]*\bdisplay\s*:/i
  );
  if (stepDisplayStyle) {
    domErrors.push(
      'A step div has inline style with "display:" — this overrides .step.active visibility. ' +
      'Remove all inline display styles from step divs.'
    );
  }

  // 4b. Slide surfaces must remain responsive. Auto-strip fixed pixel sizing from
  // inline .slide-root style attributes and enforce a responsive override.
  const slideRootTagRe = /(<[^>]*class="[^"]*\bslide-root\b[^"]*"[^>]*style=")([^"]*)(")/gi;
  let slideRootInlineFixes = 0;
  html = html.replace(slideRootTagRe, (full, pre, styleText, post) => {
    const cleaned = String(styleText)
      .replace(/\b(?:width|height|min-width|min-height|max-width|max-height)\s*:\s*\d+px\s*;?/gi, '')
      .replace(/;;+/g, ';')
      .replace(/^\s*;\s*|\s*;\s*$/g, '')
      .trim();
    if (cleaned !== String(styleText).trim()) slideRootInlineFixes += 1;
    return `${pre}${cleaned}${post}`;
  });
  if (slideRootInlineFixes > 0) {
    console.log(`[Build] Removed fixed pixel sizing from ${slideRootInlineFixes} .slide-root inline style block(s)`);
  }
  if (html.includes('</head>') && !html.includes('id="slide-root-responsive-override"')) {
    const responsiveOverride = `<style id="slide-root-responsive-override">
.slide-root{
  width:100% !important;
  max-width:min(1440px, 100vw) !important;
  height:auto !important;
  max-height:min(900px, 100vh, 100dvh) !important;
  aspect-ratio:16 / 10 !important;
  margin-inline:auto;
  box-sizing:border-box;
}
</style>`;
    html = html.replace('</head>', `${responsiveOverride}\n</head>`);
  }
  html = ensurePipelineSlideShellConformance(html);
  const valueSummaryBlock = html.match(
    /<div[^>]*data-testid=["']step-value-summary-slide["'][^>]*>[\s\S]*?(?=<!--[\s\S]*SIDE PANELS[\s\S]*-->|<div[^>]*id=["']link-events-panel["'][^>]*>|<div[^>]*data-testid=["']step-[^"']+["'][^>]*>|<\/body>)/i
  );
  if (valueSummaryBlock && valueSummaryBlock[0]) {
    const vs = valueSummaryBlock[0];
    if (/<pre\b|<code\b|summary metrics json|api[-\s]?json|raw json/i.test(vs)) {
      domErrors.push(
        'value-summary-slide contains JSON/code content. Value summary must be narrative-only (no JSON panel/code blocks).'
      );
    }
    if (/id=["']api-response-panel["']/i.test(vs) || /data-testid=["']api-panel-toggle["']/i.test(vs)) {
      domErrors.push(
        'value-summary-slide contains API side-panel controls. Value summary must not show API panel/toggle.'
      );
    }
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
    const isEmbeddedMode = !!(linkModeAdapter && linkModeAdapter.id === 'embedded');
    if (!isEmbeddedMode) {
      const ctaPatch = ensureCanonicalLaunchCtaInHtml(html, demoScript);
      html = ctaPatch.html;
      if (ctaPatch.injected) {
        console.log('[Build] Injected canonical launch CTA data-testid="link-external-account-btn"');
      }
      const launchIconPatch = enforceCanonicalLaunchButtonIcon(html);
      html = launchIconPatch.html;
      if (launchIconPatch.patched) {
        console.log('[Build] Normalized launch CTA to stock link icon + clean label');
      }
    } else {
      const embeddedLaunchSanitizer = sanitizeEmbeddedLaunchSelectorsInHtml(html, demoScript, linkModeAdapter);
      html = embeddedLaunchSanitizer.html;
      if (embeddedLaunchSanitizer.changed) {
        console.log(
          `[Build] Embedded-only launch selector sanitizer demoted ${embeddedLaunchSanitizer.demotedCount} non-launch canonical selector(s)`
        );
      }
    }
    const embeddedContainerPatch = ensureEmbeddedContainerInLaunchStep(html, demoScript, linkModeAdapter);
    html = embeddedContainerPatch.html;
    if (embeddedContainerPatch.injected) {
      console.log('[Build] Injected embedded container into launch step for embedded mode');
    }
    if (!isEmbeddedMode && !html.includes('data-testid="link-external-account-btn"')) {
      domErrors.push('Missing canonical launch CTA target: data-testid="link-external-account-btn".');
    }
    const embeddedPatch = injectEmbeddedLinkRuntimeHandler(html, demoScript, linkModeAdapter, promptText, linkTokenCreate);
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

  // ── Normalize showApiPanel → _showApiPanelStub (do NOT strip calls) ─────────
  // Previously we stripped `showApiPanel(...)` with a paren walker. Removing a
  // zero-arg `showApiPanel()` also ate the trailing `;` and left `else }` / `else };`
  // in `toggleApiPanel`, plus bare `showApiPanel` handler refs — first script parse error,
  // Plaid Link QA sees "Unexpected token '}'" and no link token fetch runs.
  // Renaming all references preserves arguments (including nested parens in literals).
  if (/\bshowApiPanel\b/.test(html)) {
    const before = html;
    html = html.replace(/\bfunction\s+showApiPanel\b/g, 'function _showApiPanelStub');
    html = html.replace(/\bshowApiPanel\b/g, '_showApiPanelStub');
    if (html !== before) {
      console.log('[Build] Normalized showApiPanel → _showApiPanelStub (definition + all references)');
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
    if (!isValueSummaryStep(step) && hasApiEndpoint(step) && step.apiResponse?.response) {
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
    // Keep JSON panel styling owned by slide template/rules and generated CSS.
    // Do not infer or inject ad-hoc visual styles here.
  }
  if (Object.keys(stepApiResponses).length > 0 && html.includes('</body>')) {
    const apiPatch = `<script>
(function() {
  if (window.__buildApiPanelPatchApplied) return;
  window.__buildApiPanelPatchApplied = true;
  var _resp = ${JSON.stringify(stepApiResponses).replace(/</g, '\\u003c')};
  var _eps  = ${JSON.stringify(stepApiEndpoints).replace(/</g, '\\u003c')};
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
    var candidates = Array.from(panel.querySelectorAll('button, [role="button"]')).filter(function(el) {
      if (!el) return false;
      if (el.id === 'api-panel-toggle' || el.getAttribute('data-testid') === 'api-panel-toggle') return true;
      var txt = String(el.textContent || '').trim().toLowerCase();
      return txt === 'show json' || txt === 'hide json';
    });
    var btn = candidates[0] || null;
    if (candidates.length > 1) {
      for (var i = 1; i < candidates.length; i += 1) {
        try { candidates[i].remove(); } catch (_) {}
      }
    }
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
    if (btn.id !== 'api-panel-toggle') btn.id = 'api-panel-toggle';
    if (btn.getAttribute('data-testid') !== 'api-panel-toggle') btn.setAttribute('data-testid', 'api-panel-toggle');
    if (!String(btn.className || '').includes('api-panel-edge-toggle')) btn.classList.add('api-panel-edge-toggle');
    if (!btn.querySelector('.api-panel-toggle-icon')) {
      btn.innerHTML = '<span class="api-panel-toggle-icon" aria-hidden="true"></span>';
    }
    btn.setAttribute('aria-expanded', window.__apiPanelUserOpen ? 'true' : 'false');
    btn.setAttribute(
      'aria-label',
      window.__apiPanelUserOpen ? 'Collapse API JSON panel' : 'Expand API JSON panel'
    );
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
    if (open) {
      panel.style.removeProperty('display');
      panel.style.display = 'flex';
      panel.classList.remove('api-panel-collapsed');
      panel.classList.add('api-panel-open');
    } else {
      panel.style.removeProperty('display');
      panel.style.display = 'flex';
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
      // Insight steps must show an expanded JSON rail for build-qa / vision QA (not the 22px collapsed strip).
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
    html = html.replace('</body>', `${apiPatch}\n</body>`);
    console.log(`[Build] Injected _stepApiResponses patch for ${Object.keys(stepApiResponses).length} step(s)`);
  } else if (html.includes('api-response-panel') && html.includes('</body>') && !html.includes('window.__apiPanelGlobalConfigApplied')) {
    const collapsePatch = `<script>
(function() {
  if (window.__apiPanelGlobalConfigApplied) return;
  window.__apiPanelGlobalConfigApplied = true;
  window.__API_PANEL_CONFIG = Object.assign({
    collapsedByDefault: true,
    jsonExpandLevel: ${RENDERJSON_EXPAND_LEVEL_DEFAULT},
    autoResize: true,
    minWidthPx: 420,
    maxWidthViewportRatio: 0.62
  }, window.__API_PANEL_CONFIG || {});
})();
</script>`;
    html = html.replace('</body>', `${collapsePatch}\n</body>`);
    console.log('[Build] Applied global API panel config defaults');
  }
  if (html.includes('</body>') && !html.includes('window.__renderJsonDefaultsApplied')) {
    const renderJsonDefaultsPatch = `<script>
(function() {
  if (window.__renderJsonDefaultsApplied) return;
  window.__renderJsonDefaultsApplied = true;
  function applyRenderJsonDefaults() {
    if (!(window.renderjson && typeof window.renderjson === 'function')) return false;
    var cfg = window.__API_PANEL_CONFIG || {};
    var showLevel = Number(cfg.jsonExpandLevel || ${RENDERJSON_EXPAND_LEVEL_DEFAULT});
    if (!Number.isFinite(showLevel) || showLevel < 1) showLevel = ${RENDERJSON_EXPAND_LEVEL_DEFAULT};
    try {
      if (typeof window.renderjson.set_show_to_level === 'function') window.renderjson.set_show_to_level(showLevel);
      if (typeof window.renderjson.set_icons === 'function') window.renderjson.set_icons('+', '-');
      if (typeof window.renderjson.set_sort_objects === 'function') window.renderjson.set_sort_objects(false);
      return true;
    } catch (_) {
      return false;
    }
  }
  if (applyRenderJsonDefaults()) return;
  var renderJsonScript = document.querySelector('script[data-renderjson-lib], script[src*="renderjson"]');
  if (renderJsonScript && typeof renderJsonScript.addEventListener === 'function') {
    renderJsonScript.addEventListener('load', applyRenderJsonDefaults, { once: true });
  } else {
    window.addEventListener('load', applyRenderJsonDefaults, { once: true });
  }
})();
</script>`;
    html = html.replace('</body>', `${renderJsonDefaultsPatch}\n</body>`);
  }

  // ── Runtime mobile shell (mobile-optimized default) ───────────────────────
  // Applies simulated device shell ONLY to non-slide steps.
  // Slide-style steps are desktop-forced automatically with no manual toggle.
  if (mobileVisualEnabled && html.includes('</body>') && !html.includes('window.__mobileViewRuntimeApplied')) {
    if (html.includes('</head>') && !html.includes('id="mobile-view-runtime-styles"')) {
      const mobileViewStyles = `<style id="mobile-view-runtime-styles">
body.mobile-shell-enabled .app-main{
  background:radial-gradient(circle at 50% 10%, rgba(255,255,255,0.06), rgba(0,0,0,0));
}
/* Fit phone chrome in real browser chrome at 100% zoom: dvh + reserve ~140px for Layer helper / UI bars */
body.mobile-shell-enabled .step.mobile-shell-target{
  position:absolute !important;
  left:50% !important; top:50% !important;
  width:min(390px, calc(100vw - 32px), calc(100dvw - 32px)) !important;
  height:min(844px, calc(100dvh - 140px), calc(100vh - 140px)) !important;
  transform:translate(-50%, -50%) !important;
  border-radius:34px !important;
  border:1px solid rgba(255,255,255,0.18) !important;
  box-shadow:0 24px 60px rgba(0,0,0,0.42), 0 0 0 10px rgba(255,255,255,0.04) !important;
  overflow:hidden !important;
}
body.mobile-shell-enabled .step.mobile-shell-target .layer-mobile-stage,
body.mobile-shell-enabled .step.mobile-shell-target .mobile-stage{
  width:100% !important;
  height:100% !important;
  min-height:0 !important;
  box-sizing:border-box !important;
}
body.mobile-shell-enabled .step.mobile-shell-target .layer-mobile-shell{
  width:100% !important;
  height:100% !important;
  min-height:0 !important;
  max-height:100% !important;
  box-sizing:border-box !important;
}
body.mobile-shell-enabled .step.mobile-shell-target .mobile-device,
body.mobile-shell-enabled .step.mobile-shell-target .mobile-frame,
body.mobile-shell-enabled .step.mobile-shell-target [data-testid="mobile-simulator-shell"]{
  width:100% !important;
  height:100% !important;
  max-width:100% !important;
  max-height:100% !important;
  min-height:0 !important;
  box-sizing:border-box !important;
}
</style>`;
      html = html.replace('</head>', `${mobileViewStyles}\n</head>`);
      console.log('[Build] Injected runtime mobile-shell styles');
    }
    const desktopPreferredStepIds = Array.isArray(demoScript?.steps)
      ? demoScript.steps
          .filter((step) => {
            const sceneType = String(step?.sceneType || '').toLowerCase();
            const id = String(step?.id || '').toLowerCase();
            const label = String(step?.label || '').toLowerCase();
            const visual = String(step?.visualState || '').toLowerCase();
            return (
              sceneType === 'slide' ||
              id.includes('slide') ||
              label.includes('slide') ||
              visual.includes('slide')
            );
          })
          .map((step) => String(step.id))
      : [];
    const desktopPreferredStepIdsJson = JSON.stringify(desktopPreferredStepIds);
    const mobileViewPatch = `<script>
(function() {
  if (window.__mobileViewRuntimeApplied) return;
  window.__mobileViewRuntimeApplied = true;
  var mode = 'mobile-simulated';
  var mq = window.matchMedia ? window.matchMedia('(max-width: 480px)') : null;
  var desktopPreferredStepIds = new Set(${desktopPreferredStepIdsJson});

  function activeStep() { return document.querySelector('.step.active'); }
  function activeStepId() {
    var a = activeStep();
    return a && a.dataset && a.dataset.testid ? String(a.dataset.testid).replace(/^step-/, '') : '';
  }
  function isSlideStep(id) {
    if (!id) return false;
    var node = document.querySelector('[data-testid="step-' + id + '"]');
    if (desktopPreferredStepIds.has(id)) return true;
    if (/slide/i.test(id)) return true;
    return !!(node && node.querySelector('.slide-root'));
  }
  function computeEffectiveMode() {
    var id = activeStepId();
    if (id && isSlideStep(id)) return 'desktop';
    if (mode === 'mobile-auto') return (mq && mq.matches) ? 'mobile-simulated' : 'desktop';
    return mode;
  }
  function shouldShellForCurrentStep() {
    var id = activeStepId();
    if (!id || isSlideStep(id)) return false;
    return computeEffectiveMode() === 'mobile-simulated';
  }
  function applyMode() {
    var a = activeStep();
    var effectiveMode = computeEffectiveMode();
    document.querySelectorAll('.step.mobile-shell-target').forEach(function(s){ s.classList.remove('mobile-shell-target'); });
    if (!a) {
      document.body.classList.remove('mobile-shell-enabled');
      return;
    }
    document.body.setAttribute('data-view-mode-effective', effectiveMode);
    if (shouldShellForCurrentStep()) {
      a.classList.add('mobile-shell-target');
      document.body.classList.add('mobile-shell-enabled');
    } else {
      document.body.classList.remove('mobile-shell-enabled');
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

  var prevGoToStep = window.goToStep;
  if (typeof prevGoToStep === 'function') {
    window.goToStep = function(id) {
      prevGoToStep(id);
      applyMode();
    };
  }
  window.setDemoViewMode = setMode;
  window.getDemoViewMode = function(){ return mode; };
  if (mq && typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', function(){ if (mode === 'mobile-auto') applyMode(); });
  } else if (mq && typeof mq.addListener === 'function') {
    mq.addListener(function(){ if (mode === 'mobile-auto') applyMode(); });
  }
  // Mobile-first default for mobile visual builds.
  setMode('mobile-simulated');
})();
</script>`;
    html = html.replace('</body>', `${mobileViewPatch}\n</body>`);
    console.log('[Build] Injected runtime mobile-shell (mobile-simulated default)');
  }

  // Layer mock: :root colors from brand only (runs even if mobile-runtime script was already in HTML from a prior refinement).
  if (
    mobileVisualEnabled &&
    shouldInjectLayerMobileMockTemplate(demoScript, mobileVisualEnabled) &&
    html.includes('</head>') &&
    !html.includes('id="layer-mock-brand-tokens"')
  ) {
    let layerBrandStyle;
    try {
      layerBrandStyle = buildLayerMockBrandTokensStyle(brand);
    } catch (e) {
      console.error(e.message || String(e));
      process.exit(1);
    }
    html = html.replace('</head>', `${layerBrandStyle}\n</head>`);
    console.log(
      `[Build] Injected Layer mock :root brand tokens (${brand.slug || brand.name || 'brand'})`
    );
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
  // Duplicate-stepId guard: dedupePlaywrightRowsByStepId already collapses
  // these, but assert here so a future regression fails loudly at build time
  // instead of silently producing duplicated narration downstream.
  const seenPwIds = new Set();
  const duplicatedPwIds = [];
  for (const s of pwSteps) {
    const id = s.stepId || s.id;
    if (!id) continue;
    if (seenPwIds.has(id)) duplicatedPwIds.push(id);
    else seenPwIds.add(id);
  }
  if (duplicatedPwIds.length > 0) {
    console.error('[Build] playwright-script.json still has duplicated stepId(s) after dedupe:');
    console.error(`  ✗ Duplicated: ${[...new Set(duplicatedPwIds)].join(', ')}`);
    console.error('  This would duplicate the narration clip in the final video. Check dedupePlaywrightRowsByStepId.');
    process.exit(1);
  }
  console.log(`[Build] playwright-script step IDs: OK (${pwSteps.length} unique steps match demo-script)`);

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

  // ── Post-process: ensure onSuccess advances the host app to the first post-link step ──
  // CLAUDE.md contract: "When onSuccess fires, the host app advances to the first
  // post-link step". If the LLM-generated onSuccess forgets to call goToStep, the
  // screen stays on the Plaid Link launch step while the recorder moves to the next
  // playwright row — narration for the next step plays over the wrong visual.
  // Detect missing advance and inject a goToStep(firstPostLinkStepId) call.
  {
    const launchStepForAdvance = (demoScript.steps || []).find((s) => s && s.plaidPhase === 'launch');
    const launchIdxForAdvance = launchStepForAdvance
      ? (demoScript.steps || []).findIndex((s) => s && s.id === launchStepForAdvance.id)
      : -1;
    const firstPostLinkIdForAdvance =
      launchIdxForAdvance >= 0 && launchIdxForAdvance < (demoScript.steps || []).length - 1
        ? (demoScript.steps[launchIdxForAdvance + 1] || {}).id || null
        : null;
    const hasGoToStepInOnSuccess = /_plaidLinkComplete\s*=\s*true[\s\S]{0,400}?window\.goToStep\s*\(/m.test(html);
    if (firstPostLinkIdForAdvance && !hasGoToStepInOnSuccess) {
      const injected = `window._plaidLinkComplete = true;\n        if (typeof window.goToStep === 'function') { try { window.goToStep(${JSON.stringify(firstPostLinkIdForAdvance)}); } catch(e) {} }`;
      const before = html;
      html = html.replace(/window\._plaidLinkComplete\s*=\s*true;/g, injected);
      if (html !== before) {
        console.log(`[Build] Injected goToStep("${firstPostLinkIdForAdvance}") into onSuccess — screen must advance off the Plaid Link step the moment onSuccess fires, otherwise the next step's narration plays over a stale visual (CLAUDE.md DOM contract).`);
      }
    }
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
      `if (((typeof token !== 'undefined') ? !token : true) && (typeof data === 'undefined' || !data || !data.link_token)) {
      console.error('Failed to create link token: missing link_token in response', data);
      return;
    }
    window._plaidHandler = Plaid.create({`
    );
    if (html !== before) {
      console.log('[Build] Hardened Plaid token bootstrap (HTTP/error-aware + link_token guard)');
    }
  }

  // Host Plaid launch CTA: enforce modest inline icon sizing whenever the canonical button exists.
  html = injectPlaidLaunchCtaLayoutStyles(html);

  // Host Plaid launch CTA: normalize button state so the recording automation can
  // reliably click it and see the modal open (strip disabled, replace loading
  // labels, and harden the onclick to await _plaidHandler initialisation).
  html = normalizePlaidLaunchCta(html);

  // Plaid Embedded Link UX: strip any extra launch button (embedded mode
  // surfaces the modal via institution-tile click inside the widget itself) and
  // size the container per the use-case profile from CLAUDE.md.
  html = normalizePlaidEmbeddedLinkUx(html, demoScript);

  // ── Consistency manifest + lint (Phase 2) ─────────────────────────────────
  // Single source of truth stays in demo-script.json. This lint is intentionally
  // conservative: persona name absence is critical; literal/API misses are warnings
  // unless strict mode is enabled.
  const consistencyManifest = buildConsistencyManifest(demoScript);
  fs.writeFileSync(CONSISTENCY_MANIFEST_FILE, JSON.stringify(consistencyManifest, null, 2), 'utf8');
  const consistencyLint = runConsistencyLint(html, consistencyManifest);
  fs.writeFileSync(CONSISTENCY_LINT_FILE, JSON.stringify(consistencyLint, null, 2), 'utf8');
  if (consistencyLint.summary.warningCount > 0) {
    console.warn(
      `[Build] Consistency lint: ${consistencyLint.summary.warningCount} warning(s), ` +
      `${consistencyLint.summary.criticalCount} critical`
    );
  } else {
    console.log('[Build] Consistency lint: no warnings.');
  }
  if (consistencyLint.summary.criticalCount > 0) {
    console.error('[Build] Consistency lint found critical issues.');
    const strict = process.env.BUILD_CONSISTENCY_LINT_STRICT === '1' || process.env.BUILD_CONSISTENCY_LINT_STRICT === 'true';
    if (strict) {
      process.exit(1);
    }
  }

  // ── Write outputs ──────────────────────────────────────────────────────────
  fs.writeFileSync(HTML_OUT, html, 'utf8');
  fs.writeFileSync(PLAYWRIGHT_OUT, JSON.stringify(playwrightScript, null, 2), 'utf8');
  fs.mkdirSync(LEGACY_SCRATCH_APP_DIR, { recursive: true });
  fs.writeFileSync(path.join(LEGACY_SCRATCH_APP_DIR, 'index.html'), html, 'utf8');
  fs.writeFileSync(
    path.join(LEGACY_SCRATCH_APP_DIR, 'playwright-script.json'),
    JSON.stringify(playwrightScript, null, 2),
    'utf8'
  );
  writeBuildMetadata({
    runId: (runManifest?.runId || RUN_LAYOUT.runId),
    scriptSignature,
    writtenAt: new Date().toISOString(),
    htmlPath: path.relative(OUT_DIR, HTML_OUT),
    playwrightPath: path.relative(OUT_DIR, PLAYWRIGHT_OUT),
  });

  console.log(`[Build] Written: scratch-app/index.html (${Math.round(html.length / 1024)}KB)`);
  console.log(`[Build] Written: scratch-app/playwright-script.json (${playwrightScript.steps.length} steps)`);
  console.log('[Build] Done — next: node scripts/scratch/scratch/record-local.js');
}

module.exports = {
  main,
  // Exported for unit tests (pure functions, safe to call standalone):
  cleanMalformedTestidDuplicates,
  validatePlaywrightTargetsAgainstSteps,
};

if (require.main === module) {
  main().catch(err => {
    console.error('[Build] Fatal error:', err.message);
    process.exit(1);
  });
}
