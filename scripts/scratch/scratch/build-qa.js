'use strict';
/**
 * build-qa.js
 * Walks the built scratch-app with Playwright (no video), captures multiple
 * screenshots per demo-script step, then runs the same Claude vision QA as qa-review.js against
 * demo-script visualState — validates the HTML build against the prompt/script
 * without recording.
 *
 * Reads:  PIPELINE_RUN_DIR/scratch-app/playwright-script.json
 *         PIPELINE_RUN_DIR/demo-script.json
 * Writes: PIPELINE_RUN_DIR/qa-frames/*-buildqa-*.png
 *         PIPELINE_RUN_DIR/qa-report-build.json (unless iteration overridden)
 *         PIPELINE_RUN_DIR/build-qa-diagnostics.json
 *
 * Usage:
 *   PIPELINE_RUN_DIR=out/demos/2026-03-23-layer-v2 node scripts/scratch/scratch/build-qa.js
 *
 * Env:
 *   BUILD_QA_MAX_WAIT_MS     — cap per playwright row waitMs (default 15000)
 *   BUILD_QA_PLAID_CLICK_MS  — cap wait after Plaid Link button click (default 10000)
 *   BUILD_QA_RECORD_PARITY   — headed browser + deviceScaleFactor 2 for closer parity with record-local
 *   BUILD_QA_PLAID_LAUNCH_ICON_MAX_RATIO — icon max dim / button height; flag if exceeded (default 0.4)
 *   BUILD_QA_PLAID_LAUNCH_ICON_STRICT — if true, oversized launch CTA icon is critical (not just warning)
 *   BUILD_QA_PLAID_MODE      — auto|full|token-only|skip (auto defaults to token-only)
 *   BUILD_QA_TOKEN_ONLY_WAIT_MS — max wait for /api/create-link-token token-only probe (default 7000)
 *   BUILD_QA_SKIP_MOBILE_PLAID_WHEN_TOKEN_ONLY — skip mobile launch smoke in token-only mode (default true)
 *   BUILD_QA_STEP_SCOPE      — all|slides (default all). "slides" restricts walkthrough to slide-like steps.
 *   ANTHROPIC_API_KEY        — required for vision QA
 */

require('../utils/load-env').loadEnv();
const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');
const { startServer } = require('../utils/app-server');
const { gleanChat } = require('../utils/mcp-clients');
const { loadTimingContract } = require('../../timing-contract');
const { validateNarrationSync, writeReport: writeNarrationSyncReport } = require('../../validate-narration-sync');
const { requireRunDir, getRunLayout, readRunManifest } = require('../utils/run-io');
const { isSlideStep: isSlideStepShared } = require('../utils/step-kind');
const { isKnownWorkhorseLayout } = require('../utils/slide-template-registry');
const { getSlideTypographyCeilings } = require('../utils/normalize-slide-typography');
const {
  appendPipelineLogSection,
  appendPipelineLogJson,
} = require('../utils/pipeline-logger');
const {
  isLogoNavLuminanceCollision,
  collisionIssueText,
} = require('../utils/host-nav-logo-contrast');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR      = requireRunDir(PROJECT_ROOT, 'build-qa');
const RUN_LAYOUT   = getRunLayout(OUT_DIR);
// Prefer run-root scratch-app (live build). artifacts/build/scratch-app can lag and breaks QA (e.g. goToStep missing).
const _scratchRoot = path.join(OUT_DIR, 'scratch-app');
const _scratchArtifact = path.join(RUN_LAYOUT.buildDir, 'scratch-app');
const SCRATCH_DIR  = fs.existsSync(path.join(_scratchRoot, 'index.html'))
  ? _scratchRoot
  : fs.existsSync(path.join(_scratchArtifact, 'index.html'))
    ? _scratchArtifact
    : _scratchRoot;
const PW_SCRIPT    = path.join(SCRATCH_DIR, 'playwright-script.json');
const DEMO_SCRIPT  = path.join(OUT_DIR, 'demo-script.json');
const FRAMES_DIR   = path.join(RUN_LAYOUT.qaDir, 'frames');
const LEGACY_FRAMES_DIR = path.join(OUT_DIR, 'qa-frames');
const DIAG_OUT     = path.join(RUN_LAYOUT.qaDir, 'build-qa-diagnostics.json');
const LEGACY_DIAG_OUT = path.join(OUT_DIR, 'build-qa-diagnostics.json');
const SLIDE_MESSAGING_OUT = path.join(RUN_LAYOUT.qaDir, 'slide-messaging-suggestions.json');
const VOICEOVER_MANIFEST_FILE = path.join(OUT_DIR, 'voiceover-manifest.json');
const SYNC_HEALTH_OUT = path.join(RUN_LAYOUT.qaDir, 'sync-health-report.json');
const LEGACY_SYNC_HEALTH_OUT = path.join(OUT_DIR, 'sync-health-report.json');
const SYNC_TIMELINE_DEBUG_OUT = path.join(RUN_LAYOUT.qaDir, 'narration-sync-debug.json');
const LEGACY_SYNC_TIMELINE_DEBUG_OUT = path.join(OUT_DIR, 'narration-sync-debug.json');

const MAX_WAIT     = parseInt(process.env.BUILD_QA_MAX_WAIT_MS || '15000', 10);
const PLAID_CLICK_WAIT = parseInt(process.env.BUILD_QA_PLAID_CLICK_MS || '10000', 10);
const BUILD_QA_PLAID_MODE_RAW = String(process.env.BUILD_QA_PLAID_MODE || 'auto').trim().toLowerCase();
const BUILD_QA_TOKEN_ONLY_WAIT_MS = parseInt(process.env.BUILD_QA_TOKEN_ONLY_WAIT_MS || '7000', 10);
const BUILD_QA_SKIP_MOBILE_PLAID_WHEN_TOKEN_ONLY = !(
  process.env.BUILD_QA_SKIP_MOBILE_PLAID_WHEN_TOKEN_ONLY === 'false' ||
  process.env.BUILD_QA_SKIP_MOBILE_PLAID_WHEN_TOKEN_ONLY === '0'
);
const RECORD_PARITY = process.env.BUILD_QA_RECORD_PARITY === 'true' || process.env.BUILD_QA_RECORD_PARITY === '1';
const MOBILE_VISUAL_ENABLED = process.env.MOBILE_VISUAL_ENABLED === 'true' || process.env.MOBILE_VISUAL_ENABLED === '1';
const HEADLESS      = process.env.BUILD_QA_HEADLESS != null
  ? !(process.env.BUILD_QA_HEADLESS === 'false' || process.env.BUILD_QA_HEADLESS === '0')
  : !RECORD_PARITY;

const PLAID_LAUNCH_ICON_MAX_RATIO = (() => {
  const v = parseFloat(process.env.BUILD_QA_PLAID_LAUNCH_ICON_MAX_RATIO || '0.4');
  if (!Number.isFinite(v) || v <= 0 || v > 1) return 0.4;
  return v;
})();
const PLAID_LAUNCH_ICON_STRICT =
  process.env.BUILD_QA_PLAID_LAUNCH_ICON_STRICT === '1' ||
  process.env.BUILD_QA_PLAID_LAUNCH_ICON_STRICT === 'true';
const BUILD_QA_DETERMINISTIC_GATE = process.env.BUILD_QA_DETERMINISTIC_GATE == null
  ? true
  : !(
    process.env.BUILD_QA_DETERMINISTIC_GATE === '0' ||
    process.env.BUILD_QA_DETERMINISTIC_GATE === 'false'
  );
let CURRENT_BUILD_QA_STEP_SCOPE = 'all';
const DETERMINISTIC_BLOCKER_CATEGORIES = new Set([
  'missing-panel',
  'panel-chrome-contract',
  'panel-visibility',
  'api-story-alignment',
  'slide-template-misuse',
  'slide-canvas-size',
  'mobile-slide-mode-contract',
  'qa-target-mismatch',
  'runtime-js-error',
  'navigation-mismatch',
  'selector-missing',
  'timing-duplicate-step-window',
  'narration-overrun',
  'sync-governor-cross-screen-owner',
  'plaid-embedded-prelink-integrated',
  'plaid-embedded-size-profile',
  'plaid-link-mobile-layout',
  'plaid-embedded-launch-selector-drift',
  // Brand-fidelity blockers (Phase 3 hyper-realism upgrade). Missing
  // regulatory disclosures are critical (legal risk for the customer);
  // missing nav labels are critical when ≥60% of expected labels are
  // absent (it means the LLM invented a different nav).
  'brand-disclosure-missing',
  'brand-nav-label-missing',
  'brand-fidelity-vision', // reserved for future LLM-graded sub-check
  'slide-plaid-logo-invented',
  'slide-plaid-logo-noncanonical',
  'slide-host-chrome-leak',
  'slide-workhorse-theme-leak',
  'slide-workhorse-runtime-leak',
  'slide-text-overlap',
  'slide-content-clipped',
  'slide-forbidden-sales-cta',
  'cra-lendscore-host-layout',
  'host-logo-contrast',
]);

const PLAID_BTN_RE = /link[-_]external[-_]account|connect[-_]bank|open[-_]link|link[-_]account[-_]btn|btn[-_]link|link[-_](?:\w+[-_])?bank|start[-_]link|initiate[-_]link|plaid[-_]link[-_]btn/i;
const RESPONSIVE_DESKTOP_VIEWPORTS = [
  { width: 1280, height: 800, label: '1280x800' },
  { width: 1440, height: 900, label: '1440x900' },
  { width: 1728, height: 1117, label: '1728x1117' },
];
const MOBILE_VISUAL_VIEWPORTS = [
  { width: 390, height: 844, label: '390x844' },
  { width: 430, height: 932, label: '430x932' },
];

function getPlaidLaunchStepId(demoScript) {
  for (const s of demoScript.steps || []) {
    if (s && s.plaidPhase === 'launch') return s.id;
  }
  return null;
}

// ALL plaidPhase:"launch" step ids. A demo may have more than one live launch
// (e.g. Plaid Layer prefill + a separate live IDV session) — token-only mode
// must skip the live modal for EVERY launch, not just the first, or the second
// modal opens during the walk and bleeds into the following step's frames.
function getPlaidLaunchStepIds(demoScript) {
  return (demoScript.steps || [])
    .filter((s) => s && s.plaidPhase === 'launch')
    .map((s) => s.id);
}

function isPlaidLaunchRow(row, launchStepIdOrIds) {
  if (!launchStepIdOrIds) return false;
  const ids = Array.isArray(launchStepIdOrIds) ? launchStepIdOrIds : [launchStepIdOrIds];
  if (ids.length === 0) return false;
  const id = row.stepId || row.id;
  // Step ID from plaidPhase:'launch' is authoritative; regex is redundant and causes false
  // negatives when the generated button testid doesn't match (e.g. "link-your-bank-btn").
  return ids.includes(id) && row.action === 'click';
}

function resolveBuildQaPlaidMode(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (normalized === 'full' || normalized === 'token-only' || normalized === 'skip') return normalized;
  if (normalized && normalized !== 'auto') {
    console.warn(`[build-qa] Unknown BUILD_QA_PLAID_MODE="${normalized}" — defaulting to auto(token-only).`);
  }
  return 'token-only';
}

function inferTokenProbePayload(demoScript) {
  const launchStep = (demoScript.steps || []).find((s) => s && s.plaidPhase === 'launch') || {};
  const payload = {};
  const stepProducts = Array.isArray(launchStep.products) ? launchStep.products.filter(Boolean) : [];
  const productText = `${demoScript.product || ''} ${launchStep.label || ''} ${launchStep.id || ''}`.toLowerCase();
  const isCra = /cra|consumer[_\s-]?report|income[_\s-]?insights|check[_\s-]?report/.test(productText);

  if (stepProducts.length) payload.products = stepProducts;
  if (launchStep.productFamily) payload.productFamily = launchStep.productFamily;
  if (launchStep.credentialScope) payload.credentialScope = launchStep.credentialScope;
  if (isCra && !payload.credentialScope) payload.credentialScope = 'cra';
  if (isCra && !payload.productFamily) payload.productFamily = 'cra_base_report';
  if (isCra && !payload.products) payload.products = ['cra_base_report', 'cra_income_insights'];
  if (String(demoScript?.plaidLinkMode || '').toLowerCase() === 'embedded') {
    payload.linkMode = 'embedded';
    payload.link_mode = 'embedded';
  }
  payload.userId = `build-qa-token-${Date.now()}`;
  return payload;
}

async function runTokenOnlyLinkProbe(page, demoScript) {
  const payload = inferTokenProbePayload(demoScript);
  const result = await Promise.race([
    page.evaluate(async (body) => {
      const res = await fetch('/api/create-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      let text = '';
      try { text = await res.text(); } catch (_) {}
      return {
        ok: res.ok,
        status: res.status,
        body: String(text || '').slice(0, 2000),
      };
    }, payload),
    new Promise((resolve) => setTimeout(() => resolve({
      ok: false,
      status: 0,
      body: `token-only-timeout-${BUILD_QA_TOKEN_ONLY_WAIT_MS}ms`,
    }), Math.max(500, BUILD_QA_TOKEN_ONLY_WAIT_MS))),
  ]);
  return { payload, result };
}

/** build-qa cannot drive the Plaid iframe; fake onSuccess so post-link steps are testable. */
async function simulateSandboxPlaidLinkComplete(page, demoScript, currentLaunchId) {
  const steps = demoScript.steps || [];
  // Advance to the step AFTER the launch step currently being walked. For
  // multi-launch demos (Layer + live IDV) each launch must advance to its own
  // post-link step — keying off the first launch only would send the IDV
  // launch back to the Layer post-step. Falls back to the first launch.
  const launchIdx = currentLaunchId
    ? steps.findIndex(s => s && s.id === currentLaunchId)
    : steps.findIndex(s => s && s.plaidPhase === 'launch');
  const nextId = launchIdx >= 0 && launchIdx < steps.length - 1 ? steps[launchIdx + 1].id : null;
  await page.evaluate((nid) => {
    window._plaidLinkComplete = true;
    if (!window._plaidAccountName) window._plaidAccountName = 'Plaid Checking';
    if (!window._plaidAccountMask) window._plaidAccountMask = '0000';
    if (!window._plaidInstitutionName) window._plaidInstitutionName = 'First Platypus Bank';
    // Destroy BOTH possible handlers (Layer = _plaidHandler, IDV = _idvHandler)
    // so neither live modal lingers over the following step's frames.
    if (window._plaidHandler) { try { window._plaidHandler.destroy(); } catch (e) {} }
    if (window._idvHandler) { try { window._idvHandler.destroy(); } catch (e) {} }
    if (nid && typeof window.goToStep === 'function') window.goToStep(nid);
  }, nextId);
  await page.waitForTimeout(500);
}

function normalizeGoToStepExpression(target) {
  return target.startsWith('window.')
    ? target
    : target.startsWith('goToStep(')
      ? `window.${target}`
      : `window.goToStep('${target}')`;
}

function computeCaptureDelays(totalMs) {
  const total = Math.max(0, totalMs || 0);
  const startWait = Math.min(250, Math.floor(total * 0.12));
  const remaining = Math.max(0, total - startWait);
  const midWait = remaining <= 500
    ? Math.floor(remaining / 2)
    : Math.min(2000, Math.max(250, Math.floor(remaining / 2)));
  const endWait = Math.max(0, remaining - midWait);
  return { startWait, midWait, endWait };
}

function isSlideLikeStep(step) {
  return isSlideStepShared(step);
}

/** Static HTML: Brandfetch wordmark + icon in the same nav reads as duplicate logos (pipeline used to prompt both). */
function scanDuplicateBankMarks(html, demoScript) {
  const company = (demoScript.persona && demoScript.persona.company) || '';
  if (!company || /^plaid$/i.test(String(company).trim())) return [];
  const hasIcon = /data-testid="host-bank-icon-img/.test(html);
  const hasLogo = /data-testid="host-bank-logo-img/.test(html);
  if (!hasIcon || !hasLogo) return [];
  const firstStepId = (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build';
  return [{
    stepId: firstStepId,
    category: 'duplicate-bank-mark',
    severity: 'warning',
    issue: 'Both host-bank-icon-img and host-bank-logo-img are present — nav often shows two identical bank tiles.',
    suggestion: 'Use a single Brandfetch <img> (wordmark only). Rebuild after prompt-templates logo rules update.',
  }];
}

function scanMissingBrandLogo(html, demoScript) {
  const company = (demoScript.persona && demoScript.persona.company) || '';
  if (!company || /^plaid$/i.test(String(company).trim())) return [];
  const hasLogo = /data-testid="host-bank-logo-img/.test(html);
  const hasIcon = /data-testid="host-bank-icon-img/.test(html);
  if (hasLogo || hasIcon) return [];
  const firstStepId = (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build';
  return [{
    stepId: firstStepId,
    category: 'missing-logo',
    severity: 'critical',
    issue: 'No host bank logo/image element found in built HTML.',
    suggestion: 'Render exactly one host brand <img> in nav (data-testid host-bank-logo-img or host-bank-icon-img).',
  }];
}

// ─── Plaid Slide Design System scanners (warning-only) ─────────────────────

// Source of truth: templates/slide-template/colors_and_type.css.
// Keep in sync with the documented Plaid palette there (sans the gradient
// definitions). Missing entries here surface as false-positive
// `slide-invented-color` warnings on slides that use legitimate holo accents.
const SLIDE_DESIGN_APPROVED_HEX = new Set([
  // Core surfaces / type
  '#111112', '#ffffff', '#f9f9f9', '#f2f2f2', '#f4f0e6',
  // Plaid blues (ink + scale)
  '#022544', '#031c34', '#043c65', '#07578d', '#0b7bbc', '#3a80e2', '#5fa8e2', '#e6f1fb',
  // Mint (Plaid teal scale)
  '#05565c', '#42f0cd', '#71fbe3',
  // Holograph pastels (full set from colors_and_type.css)
  '#e6e6ff', '#d8fef3', '#fff6d8', '#f9dbff', '#8bffff', '#ffc0ff', '#ffffc7', '#98a5ff', '#e373ff', '#affeef',
  // Neutral scale
  '#1d1d1b', '#2a2a28', '#474747', '#747677', '#a8aaab', '#d4d4d4', '#e6e6e6',
  // Status accents
  '#d83232', '#8b1f1f', '#ffe5e5', '#8f6a00',
]);

const SLIDE_TYPOGRAPHY_ALLOWLIST = /\.(?:mockup-chrome|phone-mockup|avatar|confidence-pill)\b/i;

function escapeRegexId(id) {
  return String(id).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function extractStepHtmlBlocks(html, stepIds, { requireSlideRoot = false } = {}) {
  const blocks = new Map();
  if (!html || !Array.isArray(stepIds)) return blocks;
  for (const id of stepIds) {
    const safe = escapeRegexId(id);
    const openRe = new RegExp(`<div[^>]*\\bdata-testid=["']step-${safe}["'][^>]*>`, 'i');
    const open = openRe.exec(html);
    if (!open) continue;
    const start = open.index;
    const tail = html.slice(start + open[0].length);
    // Find the next step OR a documented host-level boundary so the LAST step
    // (no following step div) does not absorb the global side-panel chrome,
    // the post-panels <script>, or any trailing assets. These regions contain
    // mint tokens, holo colors, and other slide-only constructs by design;
    // counting them against an actual slide's content produces phantom
    // warnings (e.g., slide-mint-overuse caused by panel toggle CSS).
    const nextRe = /<div[^>]*\bdata-testid=["']step-[^"']+["'][^>]*>|<!--\s*={3,}[\s\S]*?SIDE PANELS|<div[^>]*\bid=["'](?:link-events-panel|api-response-panel)["']|<\/body>/gi;
    const next = nextRe.exec(tail);
    const end = start + open[0].length + (next ? next.index : tail.length);
    const block = html.slice(start, end);
    if (requireSlideRoot && !/\bslide-root\b/.test(block)) continue;
    blocks.set(id, block);
  }
  return blocks;
}

function extractSlideStepHtmlBlocks(html, slideStepIds) {
  return extractStepHtmlBlocks(html, slideStepIds, { requireSlideRoot: true });
}

/**
 * Forbid CSS that reserves horizontal space for the JSON panel — it is a fixed
 * overlay (z-index 2100) and must never shrink slides or host columns.
 */
function scanPanelOverlayContract(html, demoScript) {
  const out = [];
  const source = String(html || '');

  if (/body\.api-panel-open[\s\S]{0,400}\.slide-root/.test(source)) {
    out.push({
      stepId: 'global',
      category: 'panel-overlay-contract',
      severity: 'critical',
      deterministicBlocker: true,
      issue:
        'CSS shrinks or reserves slide canvas when the API panel is open (body.api-panel-open + .slide-root).',
      suggestion:
        'Remove reserve rules — #api-response-panel is a fixed overlay; slides stay full-bleed at all times.',
    });
  }

  const reservePatterns = [
    {
      // 3xx–9xx px reserve (was 5xx-only — missed the 480px gutter the pipeline
      // itself once emitted; the panel is an overlay and reserves 0 slide space).
      re: /padding-right:\s*[3-9]\d{2}px/i,
      label: 'padding-right: ≥300px (panel reserve)',
    },
    {
      re: /max-width:\s*calc\s*\(\s*100%\s*-\s*[3-9]\d{2}px/i,
      label: 'max-width: calc(100% - ≥300px) (panel reserve)',
    },
    {
      re: /\.host-api-panel-reserve\b/i,
      label: 'host-api-panel-reserve class',
    },
    {
      // Any explicit slide-stack/slide content reservation tied to the gutter.
      re: /pipeline-slide-api-gutter[\s\S]{0,200}max-width:\s*calc/i,
      label: 'pipeline-slide-api-gutter slide-stack reserve',
    },
  ];

  const steps = Array.isArray(demoScript?.steps) ? demoScript.steps : [];
  for (const step of steps) {
    const block = extractStepHtmlBlocks(source, [step.id]).get(step.id) || '';
    if (!block) continue;
    for (const { re, label } of reservePatterns) {
      if (re.test(block)) {
        out.push({
          stepId: step.id,
          category: 'panel-overlay-contract',
          severity: 'critical',
          deterministicBlocker: true,
          issue: `Step reserves horizontal space for the JSON panel (${label}).`,
          suggestion:
            'Remove reserve CSS — JSON panel is a fixed overlay (z-index 2100). Slides and host steps must NOT reserve right padding for it.',
        });
      }
    }
  }

  return out;
}

/**
 * CRA LendScore / Network Insights host steps: NMLS footer, CTA visibility.
 */
function scanCraHostUnderwritingContracts(html, demoScript) {
  const steps = Array.isArray(demoScript?.steps) ? demoScript.steps : [];
  const lendSteps = steps.filter((s) => /lend[_\s-]?score/i.test(String(s?.apiResponse?.endpoint || '')));
  if (!lendSteps.length) return [];

  const out = [];
  const hostSteps = steps.filter((s) => {
    const kind = String(s?.stepKind || s?.sceneType || '').toLowerCase();
    return kind !== 'slide' && !/slide-root/i.test(String(s?.visualState || ''));
  });
  if (hostSteps.length && !/nmls\s*id\s*1963958/i.test(html || '')) {
    out.push({
      stepId: 'host-app',
      category: 'brand-disclosure-missing',
      severity: 'critical',
      deterministicBlocker: true,
      issue: 'Zip CRA host app is missing verbatim footer disclosure: "NMLS ID 1963958".',
      suggestion:
        'Add a host footer on checkout/underwriting screens with exactly: NMLS ID 1963958 (see inputs/brand-references/zip.md).',
    });
  }

  for (const step of lendSteps) {
    const block = extractStepHtmlBlocks(html, [step.id]).get(step.id) || '';
    if (!block) {
      out.push({
        stepId: step.id,
        category: 'cra-lendscore-host-layout',
        severity: 'critical',
        deterministicBlocker: true,
        issue: `Missing host step container for LendScore reveal (${step.id}).`,
        suggestion: 'Render data-testid="step-lendscore-reveal" with underwriting UI and API panel wiring.',
      });
      continue;
    }
    if (!/approve-plan-cta|data-testid=['"]approve-plan-cta['"]/i.test(block)) {
      out.push({
        stepId: step.id,
        category: 'cra-lendscore-host-layout',
        severity: 'critical',
        deterministicBlocker: true,
        issue: 'LendScore host step is missing primary CTA data-testid="approve-plan-cta".',
        suggestion: 'Add visible pink Approve plan button per demo-script interaction target.',
      });
    }
    if (!/\blendscore\b|lend[\s_-]?score/i.test(block) || !/\b78\b|\bscore\b/i.test(block)) {
      out.push({
        stepId: step.id,
        category: 'cra-lendscore-host-layout',
        severity: 'warning',
        deterministicBlocker: false,
        issue: 'LendScore score/decision not clearly visible on the host step.',
        suggestion: 'Show LendScore 78 (or script value), APPROVE badge, and LendScore — beta microcopy.',
      });
    }
    if (/base[_\s-]?report\/get/i.test(block) && !/lend[_\s-]?score\/get/i.test(block)) {
      out.push({
        stepId: step.id,
        category: 'api-story-alignment',
        severity: 'critical',
        deterministicBlocker: true,
        issue: 'On-screen API label references base_report/get but demo-script declares lend_score/get.',
        suggestion: 'Panel endpoint label and _stepApiResponses key must be POST /cra/check_report/lend_score/get.',
      });
    }
  }

  return out;
}

function slideDesignWarning(stepId, category, issue, suggestion) {
  return {
    stepId,
    category,
    severity: 'warning',
    deterministicBlocker: false,
    issue,
    suggestion,
  };
}

function slideDesignCritical(stepId, category, issue, suggestion) {
  return {
    stepId,
    category,
    severity: 'critical',
    deterministicBlocker: true,
    issue,
    suggestion,
  };
}

/** Canonical Plaid deck chrome logos — templates/slide-template/assets/logos/ */
const CANONICAL_SLIDE_PLAID_LOGO_SRC = new Set([
  'assets/logos/plaid-horizontal-white.png',
  'assets/logos/plaid-horizontal-dark.png',
  'assets/logos/plaid-horizontal-holograph.png',
]);

const LEGACY_NONCANONICAL_LOGO_SRC = /(?:plaid-logo-|\.\/plaid-logo|scratch-app\/plaid-logo)/i;

function normalizeSlideLogoSrc(src) {
  return String(src || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function isCanonicalSlidePlaidLogoSrc(src) {
  return CANONICAL_SLIDE_PLAID_LOGO_SRC.has(normalizeSlideLogoSrc(src));
}

function pickCanonicalLogoForSlideBlock(block) {
  const isLight =
    /\bslide-root[^>]*\b(?:light|cream|holo)\b/i.test(block) ||
    /\bclass="[^"]*\bslide-root\s+(?:light|cream|holo)\b/i.test(block);
  return isLight
    ? 'assets/logos/plaid-horizontal-dark.png'
    : 'assets/logos/plaid-horizontal-white.png';
}

/**
 * Hard contract: never invent a Plaid logo on slides. Use bundled horizontal
 * wordmarks from assets/logos/ via <img class="chrome-logo">, or omit logo entirely.
 *
 * @param {string} html
 * @param {string[]} slideStepIds
 */
function scanSlidePlaidLogoAuthenticity(html, slideStepIds) {
  const blocks = extractSlideStepHtmlBlocks(html, slideStepIds);
  const iterable = blocks.size
    ? [...blocks.entries()]
    : /\bslide-root\b/.test(html || '')
      ? [['slide-design', html]]
      : [];
  const out = [];

  for (const [stepId, block] of iterable) {
    const frameHead = (block.match(/<div[^>]*\bclass="[^"]*\bframe\b[^"]*"[^>]*>[\s\S]{0,2500}/i) || [])[0] || block.slice(0, 2500);

    // Non-<img> chrome-logo (div/span with text, icon grid, etc.) — the common LLM failure mode.
    const nonImgChrome = block.match(/<(?!(?:img|img\/))[^>]*\bclass="[^"]*chrome-logo[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi) || [];
    for (const tag of nonImgChrome) {
      if (/>?\s*PLAID\s*</i.test(tag) || /<svg\b/i.test(tag)) {
        out.push(slideDesignCritical(
          stepId,
          'slide-plaid-logo-invented',
          'Invented Plaid logo on slide (text/SVG chrome-logo). Do not draw icons or set "PLAID" in a div/span.',
          'Use <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png"> (or -dark/-holograph on light slides), or remove .chrome-logo entirely.'
        ));
        break;
      }
    }

    // SVG or icon-grid posing as logo inside .frame header region.
    if (/<div[^>]*\bclass="[^"]*\bframe\b[^"]*"[^>]*>[\s\S]{0,1200}?<svg\b/i.test(block)) {
      out.push(slideDesignCritical(
        stepId,
        'slide-plaid-logo-invented',
        'Inline SVG used as Plaid logo inside .slide-root .frame (forbidden).',
        'Replace with canonical <img class="chrome-logo" src="assets/logos/plaid-horizontal-*.png"> from templates/slide-template/assets/logos/, or omit the logo.'
      ));
    }
    if (/\b(?:plaid-icon|logo-icon|brand-icon|die-icon|four-dot)\b/i.test(frameHead) && /<svg\b/i.test(frameHead)) {
      out.push(slideDesignCritical(
        stepId,
        'slide-plaid-logo-invented',
        'Custom icon-grid / faux Plaid mark detected in slide header (not from logo library).',
        'Use bundled horizontal wordmark PNG only — never recreate the four-dot icon or "PLAID" logotype in HTML/CSS.'
      ));
    }

    // Standalone PLAID wordmark text in frame without canonical img (e.g. rounded icon + PLAID label).
    if (
      />?\s*PLAID\s*</i.test(frameHead) &&
      !/<img[^>]*\bclass="[^"]*chrome-logo[^"]*"[^>]*>/i.test(frameHead)
    ) {
      out.push(slideDesignCritical(
        stepId,
        'slide-plaid-logo-invented',
        'Rendered "PLAID" as text/CSS instead of the canonical horizontal wordmark image.',
        'Delete faux logo markup. Use <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt=""> or omit chrome-logo.'
      ));
    }

    const imgTags = block.match(/<img[^>]*\bclass="[^"]*chrome-logo[^"]*"[^>]*>/gi) || [];
    for (const imgTag of imgTags) {
      const srcMatch = imgTag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      const src = srcMatch ? srcMatch[1] : '';
      if (!src || /^data:/i.test(src)) {
        out.push(slideDesignCritical(
          stepId,
          'slide-plaid-logo-noncanonical',
          'chrome-logo <img> is missing src or uses a data URI — not the bundled logo library.',
          `Set src="${pickCanonicalLogoForSlideBlock(block)}" (canonical assets/logos/ path).`
        ));
        continue;
      }
      if (LEGACY_NONCANONICAL_LOGO_SRC.test(src) || /plaid-icon-white/i.test(src)) {
        out.push(slideDesignCritical(
          stepId,
          'slide-plaid-logo-noncanonical',
          `Slide chrome-logo uses non-library path "${src}" (legacy or icon asset).`,
          `Use assets/logos/plaid-horizontal-white.png, plaid-horizontal-dark.png, or plaid-horizontal-holograph.png only.`
        ));
        continue;
      }
      if (!isCanonicalSlidePlaidLogoSrc(src)) {
        out.push(slideDesignCritical(
          stepId,
          'slide-plaid-logo-noncanonical',
          `Slide chrome-logo src "${src}" is not an approved bundled wordmark.`,
          'Copy from templates/slide-template/assets/logos/ — horizontal wordmarks only — or remove .chrome-logo.'
        ));
      }
    }

    // img with alt=Plaid in slide frame but not chrome-logo — often a homemade mark.
    const roguePlaidImg = block.match(/<img(?![^>]*chrome-logo)[^>]*\balt\s*=\s*["']Plaid["'][^>]*>/gi) || [];
    for (const tag of roguePlaidImg) {
      if (!isCanonicalSlidePlaidLogoSrc((tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1])) {
        out.push(slideDesignCritical(
          stepId,
          'slide-plaid-logo-invented',
          'Non-canonical <img alt="Plaid"> in slide frame (invented logo asset).',
          'Remove and use <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png"> or omit logo entirely.'
        ));
        break;
      }
    }
  }

  return out;
}

/**
 * Chrome logo placement — top-right, 28px height via CSS (not inline showcase scale).
 * @param {string} html
 * @param {string[]} slideStepIds
 */
function scanSlideChromeLogoPlacement(html, slideStepIds) {
  const blocks = extractSlideStepHtmlBlocks(html, slideStepIds);
  const out = [];

  for (const [stepId, block] of blocks) {
    const imgTags = block.match(/<img[^>]*\bclass="[^"]*chrome-logo[^"]*"[^>]*>/gi) || [];
    for (const tag of imgTags) {
      const style = (tag.match(/\bstyle\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
      if (!style) continue;

      if (/\bleft\s*:/i.test(style)) {
        out.push(slideDesignCritical(
          stepId,
          'slide-chrome-logo-placement',
          'chrome-logo has inline left: positioning (legacy top-left placement).',
          'Remove inline style on .chrome-logo. Placement is top-right via slide.css: top: calc(var(--pad-top) - 75px); right: var(--pad-x); height: 28px.'
        ));
        continue;
      }

      const heightMatch = style.match(/\bheight\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
      if (heightMatch && parseFloat(heightMatch[1], 10) > 36) {
        out.push(slideDesignCritical(
          stepId,
          'slide-chrome-logo-placement',
          `chrome-logo inline height ${heightMatch[1]}px exceeds production 28px (showcase preview leak).`,
          'Remove inline height on .chrome-logo — pipeline logo is 28px via slide.css / pipeline-slide-contract.css.'
        ));
      }

      if (/\btop\s*:\s*60px\b/i.test(style) && /\bleft\s*:\s*120px\b/i.test(style)) {
        out.push(slideDesignCritical(
          stepId,
          'slide-chrome-logo-placement',
          'chrome-logo uses stale DECK_DESIGN_SYSTEM top-left coordinates (60px / 120px).',
          'Remove inline style; use canonical top-right placement from slide.css.'
        ));
      }
    }
  }

  return out;
}

/** @param {string} html */
function scanSlideDesignTokens(html) {
  if (!html || !/\bslide-root\b/.test(html)) return [];
  const hasInk = /--plaid-ink-900|#022544/i.test(html);
  const hasMint = /--plaid-teal-500|#42F0CD/i.test(html);
  const hasTokenSheet = /colors_and_type\.css|POST-SLIDES DESIGN SYSTEM CSS/i.test(html);
  if (hasInk && hasMint && (hasTokenSheet || /--plaid-ink-900/.test(html))) return [];
  const firstId = 'slide-design';
  return [slideDesignWarning(
    firstId,
    'slide-design-tokens',
    'Slide markup is missing Plaid Deck Design System tokens (--plaid-ink-900 / --plaid-teal-500 or colors_and_type.css).',
    'Ensure post-slides injects design-system CSS or reference token variables in slide styles.'
  )];
}

/** @param {string} html @param {string[]} slideStepIds */
function scanSlideShellChrome(html, slideStepIds) {
  const blocks = extractSlideStepHtmlBlocks(html, slideStepIds);
  const out = [];
  for (const [stepId, block] of blocks) {
    if (/data-slide-template\s*=\s*["']T1["']/i.test(block)) continue;
    const missing = [];
    if (!/\bchrome-logo\b/.test(block)) missing.push('.chrome-logo');
    if (!/\beyebrow-tag\b/.test(block)) missing.push('.eyebrow-tag');
    if (missing.length) {
      out.push(slideDesignWarning(
        stepId,
        'slide-shell-chrome',
        `Slide missing canonical shell chrome: ${missing.join(', ')}.`,
        'Use .frame + .chrome-logo + .eyebrow-tag per DECK_DESIGN_SYSTEM.md (T1 may omit eyebrow). Pipeline slides omit .chrome-foot.'
      ));
    }
  }
  return out;
}

/**
 * scanSlideTypographyFloor — NEUTERED 2026-05-27.
 * The 24px body floor enforcement was scrapped; slide templates own sizing,
 * LLM may reduce inline font-size to fit content. Function preserved as a
 * no-op so the call site (scanSlideQuality) doesn't need to change.
 * @param {string} _html
 */
function scanSlideTypographyFloor(_html) {
  return [];
}

/**
 * Slide canvas hard contract (May 2026 — see CLAUDE.md "Plaid Slide Design
 * System"). Evaluates a per-step `state` produced by `evaluateStepState`
 * (live Playwright snapshot of `.slide-root.getBoundingClientRect()`) and
 * returns deterministic diagnostics when the slide does not meet the
 * Google-Slides-class size + 16:10 aspect contract.
 *
 * Contract:
 *   width  ≥ viewportWidth  * widthFraction  (default 0.75 → 1080px on 1440)
 *   height ≥ viewportHeight * heightFraction (default 0.67 → 600px on 900)
 *   aspect ratio in [minAspect, maxAspect] (default [1.40, 1.85] — covers 16:9 and 16:10)
 *
 * Returns `[]` (no diagnostics) for non-slide steps or when the slide has
 * not been measured yet (state.slideRootRenderedWidth === 0). All emitted
 * diagnostics use `category: 'slide-canvas-size'` and `severity: 'critical'`
 * — auto-blocked by the deterministic blocker gate.
 *
 * Pure function. Exported for unit testing.
 *
 * @param {object} state  Output of evaluateStepState (or equivalent shape)
 * @param {object} step   demo-script step object (used to check isSlideLikeStep)
 * @param {object} [opts]
 * @param {number} [opts.widthFraction=0.75]
 * @param {number} [opts.heightFraction=0.67]
 * @param {number} [opts.minAspect=1.40]
 * @param {number} [opts.maxAspect=1.85]
 * @returns {Array<object>} Array of diagnostic objects { stepId, category, severity, issue, suggestion }
 */
function scanSlideCanvasSize(state, step, opts = {}) {
  const out = [];
  if (!state || !step) return out;
  if (!isSlideLikeStep(step)) return out;
  const renderedWidth = Number(state.slideRootRenderedWidth) || 0;
  if (renderedWidth <= 0) return out;
  const renderedHeight = Number(state.slideRootRenderedHeight) || 0;
  const viewportWidth = Number(state.viewportWidth) || 1440;
  const viewportHeight = Number(state.viewportHeight) || 900;
  const widthFraction = Number.isFinite(opts.widthFraction) ? opts.widthFraction : 0.75;
  const heightFraction = Number.isFinite(opts.heightFraction) ? opts.heightFraction : 0.67;
  const minAspect = Number.isFinite(opts.minAspect) ? opts.minAspect : 1.40;
  const maxAspect = Number.isFinite(opts.maxAspect) ? opts.maxAspect : 1.85;
  const minWidth = Math.round(viewportWidth * widthFraction);
  const minHeight = Math.round(viewportHeight * heightFraction);
  const aspectRatio = renderedHeight > 0 ? renderedWidth / renderedHeight : 0;
  if (renderedWidth < minWidth) {
    out.push({
      stepId: step.id,
      category: 'slide-canvas-size',
      severity: 'critical',
      issue:
        `Slide canvas width ${Math.round(renderedWidth)}px is below the ${minWidth}px contract ` +
        `(viewport ${viewportWidth}×${viewportHeight}). Slides must occupy at least ${Math.round(widthFraction * 100)}% of viewport width.`,
      suggestion:
        'Apply the pipeline-slide-contract.css rules so `.step.active .slide-root` ' +
        'uses `max-width: min(1280px, calc(100vw - 80px))`. The JSON panel is a fixed overlay and must not shrink slides.',
    });
  }
  if (renderedHeight > 0 && renderedHeight < minHeight) {
    out.push({
      stepId: step.id,
      category: 'slide-canvas-size',
      severity: 'critical',
      issue:
        `Slide canvas height ${Math.round(renderedHeight)}px is below the ${minHeight}px contract ` +
        `(viewport ${viewportWidth}×${viewportHeight}).`,
      suggestion:
        'Verify the slide CSS keeps `aspect-ratio: 16/10` (or 16/9) so the slide auto-sizes vertically ' +
        'when the width contract is met. Avoid inline `min-height` / `height` on `.slide-root` — use the CSS contract.',
    });
  }
  if (aspectRatio > 0 && (aspectRatio < minAspect || aspectRatio > maxAspect)) {
    out.push({
      stepId: step.id,
      category: 'slide-canvas-size',
      severity: 'critical',
      issue:
        `Slide aspect ratio ${aspectRatio.toFixed(2)} is outside the [${minAspect}–${maxAspect}] contract ` +
        `(canonical 16:10 = 1.60, 16:9 = 1.78).`,
      suggestion:
        'Restore `aspect-ratio: 16/10` on `.slide-root` and remove any inline `aspect-ratio` / `min-height` ' +
        'overrides that change the slide shape.',
    });
  }
  return out;
}

/**
 * Slide steps must be full-screen Plaid deck surfaces — no host bank nav/banner/footer.
 */
function scanSlideHostChromeLeak(state, step) {
  const out = [];
  if (!state || !step || !isSlideLikeStep(step)) return out;
  // Broad detector wins when present: any host banner/nav/header/footer visible
  // and overlapping the slide canvas (covers branded chrome that doesn't use
  // the 3 legacy nav classes — e.g. a TD bank banner). Falls back to the legacy
  // hostNavVisible + slide-active signal.
  const leaked = Array.isArray(state.hostChromeOnSlide) && state.hostChromeOnSlide.length > 0;
  const legacyLeak = state.hostChromeOnSlide == null && state.hostNavVisible && !state.bodyHasSlideActiveClass;
  if (!leaked && !legacyLeak) return out;
  out.push({
    stepId: step.id,
    category: 'slide-host-chrome-leak',
    severity: 'critical',
    deterministicBlocker: true,
    issue:
      'Host application chrome (banner/nav/header/footer) is visible on a slide step — slides must be ' +
      'isolated full-screen Plaid deck surfaces with NO host app content' +
      (leaked ? ` (offending: ${state.hostChromeOnSlide.join(', ')})` : '') + '.',
    suggestion:
      'In app-touchup: tag every host-only node (the bank banner/nav/header/footer) with class ' +
      '`host-app-chrome`, ensure `body.pipeline-slide-active` hides `.host-app-chrome` on slide steps ' +
      '(post-panels slide-host-isolation), and verify the slide-root is the only visible surface. ' +
      'Do NOT place host nav/banner markup inside or above a `.slide-root`.',
  });
  return out;
}

/**
 * Warn when inline font-size exceeds DECK_DESIGN_SYSTEM ceilings for the slide template.
 * @param {string} html
 */
/**
 * scanSlideTypographyCeiling — NEUTERED 2026-05-27.
 * Per-template H-title / hero-stat / body / mono ceilings scrapped;
 * slide templates own sizing, LLM may use any inline font-size. Preserved
 * as a no-op so the call site doesn't need to change.
 * @param {string} _html
 */
function scanSlideTypographyCeiling(_html) {
  return [];
}

/** @param {string} html @param {string[]} slideStepIds */
function scanSlideHeadlineItalicAccent(html, slideStepIds) {
  const blocks = extractSlideStepHtmlBlocks(html, slideStepIds);
  const out = [];
  for (const [stepId, block] of blocks) {
    if (/data-slide-template\s*=\s*["']T1["']/i.test(block)) continue;
    const titleMatch = block.match(/<h[12][^>]*\bh-title\b[^>]*>[\s\S]*?<\/h[12]>/i);
    if (!titleMatch) {
      out.push(slideDesignWarning(stepId, 'slide-headline-accent', 'Slide has no .h-title headline.', 'Add .h-title with one <em> Bowery Street italic accent.'));
      continue;
    }
    if (!/<em\b/i.test(titleMatch[0])) {
      out.push(slideDesignWarning(
        stepId,
        'slide-headline-accent',
        '.h-title is missing the required Bowery Street <em> italic accent.',
        'Italicize the operative noun phrase once per headline (DECK_COMPOSITION.md).'
      ));
    }
  }
  return out;
}

/** @param {string} html @param {string[]} slideStepIds */
function scanSlideMintOveruse(html, slideStepIds) {
  const blocks = extractSlideStepHtmlBlocks(html, slideStepIds);
  const out = [];
  const mintRe = /(--plaid-teal-500|#42F0CD)/gi;
  for (const [stepId, block] of blocks) {
    const hits = block.match(mintRe) || [];
    if (hits.length > 3) {
      out.push(slideDesignWarning(
        stepId,
        'slide-mint-overuse',
        `Slide uses mint (${hits.length} references); limit to one primary mint moment.`,
        'Reserve --plaid-teal-500 / #42F0CD for a single eye-draw per slide.'
      ));
    }
  }
  return out;
}

/** Forbidden sales / outbound CTAs on pipeline slides (not sales decks). */
const SLIDE_FORBIDDEN_SALES_CTA_PATTERNS = [
  { re: /\bcontact\s+plaid\b/i, label: 'contact Plaid' },
  { re: /\bcontact\s+(?:your\s+)?(?:plaid\s+)?account\s+manager\b/i, label: 'contact Account Manager' },
  { re: /\bstart\s+a\s+free\s+trial\b/i, label: 'start a free trial' },
  { re: /\bfree\s+trial\b/i, label: 'free trial' },
  { re: /\bstart\s+a\s+poc\b/i, label: 'Start a POC' },
  { re: /\bpoc\s+scoping\b/i, label: 'POC scoping' },
  { re: /\bperform\s+a\s+retro\s+analysis\b/i, label: 'perform a retro analysis' },
  { re: /\brun\s+the\s+production\s+retro\b/i, label: 'run the production retro' },
  { re: /\bstart\s+your\s+retro\b/i, label: 'start your retro' },
  { re: /\bgreenlight\s+(?:the\s+)?(?:protect\s+)?retro\b/i, label: 'greenlight the retro' },
];

function stripHtmlToText(fragment) {
  return String(fragment || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string} html @param {string[]} slideStepIds */
function scanSlideForbiddenSalesCta(html, slideStepIds) {
  const blocks = extractSlideStepHtmlBlocks(html, slideStepIds);
  const out = [];
  for (const [stepId, block] of blocks) {
    const text = stripHtmlToText(block);
    const buttonLike = /<button\b[^>]*>[\s\S]*?<\/button>/gi;
    const pillLike = /<(?:button|span|a)\b[^>]*(?:border-radius:\s*999|class="[^"]*(?:btn|cta|pill)[^"]*")[^>]*>[\s\S]*?<\/(?:button|span|a)>/gi;
    const hits = new Set();
    for (const { re, label } of SLIDE_FORBIDDEN_SALES_CTA_PATTERNS) {
      if (re.test(text)) hits.add(label);
    }
    let m;
    while ((m = buttonLike.exec(block)) !== null) {
      const btnText = stripHtmlToText(m[0]);
      for (const { re, label } of SLIDE_FORBIDDEN_SALES_CTA_PATTERNS) {
        if (re.test(btnText)) hits.add(label);
      }
    }
    while ((m = pillLike.exec(block)) !== null) {
      const pillText = stripHtmlToText(m[0]);
      for (const { re, label } of SLIDE_FORBIDDEN_SALES_CTA_PATTERNS) {
        if (re.test(pillText)) hits.add(label);
      }
    }
    if (hits.size === 0) continue;
    out.push({
      stepId,
      category: 'slide-forbidden-sales-cta',
      severity: 'critical',
      deterministicBlocker: true,
      issue: `Forbidden sales CTA on slide: ${[...hits].join(', ')}.`,
      suggestion:
        'Remove contact/trial/POC/retro action buttons and lines. Value-summary slides should recap product outcomes with declarative copy — see plaid-slide-design SKILL § Forbidden sales CTAs.',
    });
  }
  return out;
}

/** @param {string} html */
function scanSlideInlineBlockLayout(html) {
  if (!html || !/\bslide-root\b/.test(html)) return [];
  const styleBlocks = [];
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = styleRe.exec(html)) !== null) styleBlocks.push(m[1]);
  const offenders = [];
  for (const css of styleBlocks) {
    const ruleRe = /([^{}]*\.slide-root[^{}]*)\{([^{}]*)\}/gi;
    let rule;
    while ((rule = ruleRe.exec(css)) !== null) {
      if (/display\s*:\s*inline-block/i.test(rule[2])) offenders.push(rule[1].trim());
    }
    if (/\.slide-root[\s\S]*?display\s*:\s*inline-block/i.test(css)) offenders.push('.slide-root');
  }
  if (/\bslide-root\b[^>]*style="[^"]*display\s*:\s*inline-block/i.test(html)) offenders.push('inline style');
  if (!offenders.length) return [];
  return [slideDesignWarning(
    'slide-design',
    'slide-inline-block',
    'display:inline-block detected in slide-scoped CSS (forbidden — use flex/grid + gap).',
    'Remove inline-block rules under .slide-root per DECK_DESIGN_SYSTEM.md.'
  )];
}

/** @param {object} demoScript @param {string} html */
function scanSlideBackgroundRhythm(demoScript, html) {
  const steps = Array.isArray(demoScript?.steps) ? demoScript.steps : [];
  const slideSteps = steps.filter((s) => isSlideLikeStep(s));
  if (slideSteps.length < 5) return [];
  let consecutiveNavy = 0;
  let maxRun = 0;
  let runStartId = null;
  let worstStart = null;
  for (const step of slideSteps) {
    const safe = escapeRegexId(step.id);
    const re = new RegExp(
      `<div[^>]*\\bdata-testid="step-${safe}"[^>]*>[\\s\\S]*?\\bslide-root\\b[^>]*`,
      'i'
    );
    const m = html.match(re);
    const variant = m && m[0] || '';
    const isInterlude = /\bslide-root[^>]*\b(?:light|cream|holo)\b/i.test(variant) ||
      /\bclass="[^"]*\bslide-root\s+(?:light|cream|holo)\b/i.test(variant);
    if (isInterlude) {
      consecutiveNavy = 0;
      runStartId = null;
      continue;
    }
    if (consecutiveNavy === 0) runStartId = step.id;
    consecutiveNavy += 1;
    if (consecutiveNavy > maxRun) {
      maxRun = consecutiveNavy;
      worstStart = runStartId;
    }
  }
  if (maxRun <= 4) return [];
  return [slideDesignWarning(
    worstStart || slideSteps[0].id,
    'slide-background-rhythm',
    `${maxRun} consecutive navy slides without a .light / .cream / .holo interlude.`,
    'Alternate background variants — no more than 4 navy slides in a row (DECK_COMPOSITION.md).'
  )];
}

/** @param {string} html */
function scanSlideInventedColors(html) {
  if (!html || !/\bslide-root\b/.test(html)) return [];
  const out = [];
  const hexRe = /#([0-9a-fA-F]{3,8})\b/g;
  const slideSection = html.split(/\bslide-root\b/).slice(1).join('slide-root') || html;
  const seen = new Set();
  let m;
  while ((m = hexRe.exec(slideSection)) !== null) {
    const raw = m[0].toLowerCase();
    const norm = raw.length === 4
      ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
      : raw.slice(0, 7);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (!SLIDE_DESIGN_APPROVED_HEX.has(norm)) {
      out.push(slideDesignWarning(
        'slide-design',
        'slide-invented-color',
        `Non-palette hex color ${raw} in slide CSS/HTML.`,
        'Use documented Plaid tokens or rgba() on brand colors only.'
      ));
      if (out.length >= 5) break;
    }
  }
  return out;
}

// ── Plaid × Workhorse leak scanners ─────────────────────────────────────────
// Pipeline rule: Workhorse layout *patterns* may be borrowed inside .slide-root,
// but Workhorse themes, runtime, animation engine, and Chart.js never ship in
// pipeline slides. See .claude/skills/plaid-workhorse-slides/SKILL.md.

/** html-ppt theme filename allowlist used to identify a Workhorse theme link. */
const WORKHORSE_THEME_FILE_RE = /assets\/themes\/(minimal-white|editorial-serif|soft-pastel|sharp-mono|arctic-cool|sunset-warm|catppuccin-latte|catppuccin-mocha|dracula|tokyo-night|nord|solarized-light|gruvbox-dark|rose-pine|neo-brutalism|glassmorphism|bauhaus|swiss-grid|terminal-green|xiaohongshu-white|rainbow-gradient|aurora|blueprint|memphis-pop|cyberpunk-neon|y2k-chrome|retro-tv|japanese-minimal|vaporwave|midcentury|corporate-clean|academic-paper|news-broadcast|pitch-deck-vc|magazine-bold|engineering-whiteprint)\.css/i;

/** Non-Plaid display/sans/serif fonts pulled in via Google Fonts or jsdelivr. */
const WORKHORSE_FONT_HREF_RE = /fonts\.googleapis\.com\/css2?\?[^"'>]*family=(Inter|Playfair\+Display|Noto\+Sans\+SC|Noto\+Serif\+SC|JetBrains\+Mono|IBM\+Plex\+Mono)/i;

/**
 * @param {string} html
 * @param {string[]} slideStepIds
 */
function scanSlideWorkhorseThemeLeak(html, slideStepIds) {
  if (!html || !/\bslide-root\b/.test(html)) return [];
  const blocks = extractSlideStepHtmlBlocks(html, slideStepIds);
  const iterable = blocks.size ? [...blocks.entries()] : [['slide-design', html]];
  const out = [];

  // Theme CSS link anywhere inside a slide step block.
  for (const [stepId, block] of iterable) {
    if (WORKHORSE_THEME_FILE_RE.test(block)) {
      out.push(slideDesignCritical(
        stepId,
        'slide-workhorse-theme-leak',
        'Workhorse html-ppt theme CSS link found inside a slide step (forbidden in pipeline).',
        'Remove the <link href="assets/themes/...css">. Pipeline slides use templates/slide-template/colors_and_type.css + slide.css only — Plaid palette is the only allowed theme.'
      ));
    }
    if (WORKHORSE_FONT_HREF_RE.test(block)) {
      out.push(slideDesignCritical(
        stepId,
        'slide-workhorse-theme-leak',
        'Non-Plaid webfont import (Inter / Playfair / Noto / JetBrains Mono / IBM Plex Mono) inside a slide step.',
        'Use Plaid Sans + Bowery Street from templates/slide-template/colors_and_type.css. No CDN font imports in pipeline slides.'
      ));
    }
  }

  // Document-level <link> to a Workhorse theme also fails (slides inherit it).
  // Only fire once even if many.
  if (slideStepIds.length > 0 && WORKHORSE_THEME_FILE_RE.test(html)) {
    const alreadyFired = out.some((d) => d.category === 'slide-workhorse-theme-leak');
    if (!alreadyFired) {
      out.push(slideDesignCritical(
        slideStepIds[0],
        'slide-workhorse-theme-leak',
        'Document <head> imports a Workhorse html-ppt theme CSS — it will style .slide-root.',
        'Remove the Workhorse theme link from the document; pipeline slides use Plaid tokens only.'
      ));
    }
  }

  return out;
}

const WORKHORSE_RUNTIME_SRC_RE = /\b(?:runtime\.js|fx-runtime\.js|animations\/fx\/[a-z0-9-]+\.js)\b/i;
const CHARTJS_SRC_RE = /\b(?:chart(?:\.min)?\.js|chartjs|chart\.js@\d)\b|cdn\.jsdelivr\.net\/npm\/chart\.js|cdnjs[^"'>]*chart\.js/i;
const HIGHLIGHTJS_SRC_RE = /\bhighlight\.js@\d|cdnjs[^"'>]*highlight\.js/i;

/**
 * @param {string} html
 * @param {string[]} slideStepIds
 */
function scanSlideWorkhorseRuntimeLeak(html, slideStepIds) {
  if (!html || !/\bslide-root\b/.test(html)) return [];
  const blocks = extractSlideStepHtmlBlocks(html, slideStepIds);
  const iterable = blocks.size ? [...blocks.entries()] : [['slide-design', html]];
  const out = [];

  for (const [stepId, block] of iterable) {
    if (WORKHORSE_RUNTIME_SRC_RE.test(block)) {
      out.push(slideDesignCritical(
        stepId,
        'slide-workhorse-runtime-leak',
        'Workhorse runtime.js / fx-runtime.js / canvas FX script referenced inside a slide step (pipeline slides are static).',
        'Remove <script src="...runtime.js">. Pipeline slides do not use html-ppt keyboard runtime or canvas FX.'
      ));
    }
    if (CHARTJS_SRC_RE.test(block)) {
      out.push(slideDesignCritical(
        stepId,
        'slide-workhorse-runtime-leak',
        'Chart.js script referenced inside a slide step (SVG-only contract).',
        'Rebuild data visuals as inline SVG/CSS. Chart.js is not permitted in pipeline slides.'
      ));
    }
    if (HIGHLIGHTJS_SRC_RE.test(block)) {
      out.push(slideDesignCritical(
        stepId,
        'slide-workhorse-runtime-leak',
        'highlight.js script referenced inside a slide step.',
        'Use static <pre><code> with Plaid mono font. No syntax-highlighting runtime in pipeline slides.'
      ));
    }
  }

  // Document-level catch (same idea as theme leak).
  if (slideStepIds.length > 0) {
    if (WORKHORSE_RUNTIME_SRC_RE.test(html) && !out.some((d) => /runtime/.test(d.issue))) {
      out.push(slideDesignCritical(
        slideStepIds[0],
        'slide-workhorse-runtime-leak',
        'Document loads Workhorse runtime.js or fx-runtime.js — affects every .slide-root.',
        'Remove the Workhorse runtime <script>. Pipeline slides are static.'
      ));
    }
    if (CHARTJS_SRC_RE.test(html) && !out.some((d) => /Chart\.js/.test(d.issue))) {
      out.push(slideDesignCritical(
        slideStepIds[0],
        'slide-workhorse-runtime-leak',
        'Document loads Chart.js — pipeline slides are SVG-only.',
        'Remove Chart.js <script>. Rebuild charts as inline SVG.'
      ));
    }
  }

  return out;
}

/**
 * @param {string} html
 * @param {string[]} slideStepIds
 */
/**
 * Detect rendered text overlap inside .slide-root.
 *
 * State input shape: `state.slideTextOverlaps` (collected from the Playwright
 * walk in evaluateStepState) — list of pairs of text-bearing elements whose
 * rendered bounding boxes intersect by more than 8x8 px.
 *
 * Severity: critical (deterministic blocker) when any overlap is found on a
 * slide-like step. The suggestion guides slide-fix to either reduce font-size
 * on the larger element or widen `gap`/`padding` on the parent flex/grid
 * container that holds both.
 *
 * @param {object} state
 * @param {object} step
 */
function scanSlideTextOverlap(state, step) {
  if (!state || !step || !isSlideLikeStep(step)) return [];
  const overlaps = Array.isArray(state.slideTextOverlaps) ? state.slideTextOverlaps : [];
  if (overlaps.length === 0) return [];

  const out = [];
  for (const pair of overlaps.slice(0, 6)) {
    const aLabel = `${pair.a.tag} \"${pair.a.text.slice(0, 40)}\"`;
    const bLabel = `${pair.b.tag} \"${pair.b.text.slice(0, 40)}\"`;
    const aFs = Math.round(pair.a.fontSize || 0);
    const bFs = Math.round(pair.b.fontSize || 0);
    // Recommendation: trim the larger font-size by 25% (rounded to multiples of 2).
    // The 24px floor was removed 2026-05-27 — templates own sizing and the LLM
    // may reduce inline font-size to fit content.
    const bigger = aFs >= bFs ? { label: aLabel, fs: aFs } : { label: bLabel, fs: bFs };
    const target = Math.max(1, Math.round((bigger.fs * 0.75) / 2) * 2);
    const suggestion =
      `Reduce font-size on ${bigger.label} from ${bigger.fs}px to ~${target}px, or increase gap/padding on the shared flex/grid container. Overlap area ${pair.overlapArea}px² (${pair.overlapW}x${pair.overlapH}px).`;
    out.push({
      stepId: step.id,
      category: 'slide-text-overlap',
      severity: 'critical',
      deterministicBlocker: true,
      issue: `Text elements overlap on slide: ${aLabel} intersects with ${bLabel}.`,
      suggestion,
      // Machine-readable payload — slide-fix can use these coordinates to
      // generate targeted patches without re-measuring.
      meta: {
        a: pair.a,
        b: pair.b,
        overlapArea: pair.overlapArea,
        overlapW: pair.overlapW,
        overlapH: pair.overlapH,
        recommendedFontSizePx: target,
      },
    });
  }

  if (overlaps.length > 6) {
    out.push({
      stepId: step.id,
      category: 'slide-text-overlap',
      severity: 'warning',
      deterministicBlocker: false,
      issue: `${overlaps.length - 6} additional text-overlap pair(s) suppressed (showing 6 of ${overlaps.length}).`,
      suggestion: 'Resolve the critical overlaps first; the rest typically cascade once spacing is fixed.',
    });
  }

  return out;
}

/**
 * Slide text-wrap autofix candidate emitter. Reads
 * `state.slideTextWraps` (precomputed in the Playwright walker) and emits one
 * `slide-text-wrap` diagnostic per element that wraps to ≥2 lines AND could
 * fit on a single line at a smaller (≥24px) font-size. Severity is `warning`
 * (not a blocker) — the autofix patch downshifts the font deterministically
 * on the next slide-fix iteration. This is the "dynamic font reduction"
 * signal requested when text leans into a second line that would look better
 * on the same line at a smaller size.
 *
 * @param {object} state
 * @param {object} step
 */
function scanSlideTextWrap(state, step) {
  if (!state || !step || !isSlideLikeStep(step)) return [];
  const wraps = Array.isArray(state.slideTextWraps) ? state.slideTextWraps : [];
  if (wraps.length === 0) return [];
  const out = [];
  for (const w of wraps) {
    const label = `${w.tag} "${(w.text || '').slice(0, 50)}"`;
    out.push({
      stepId: step.id,
      category: 'slide-text-wrap',
      severity: 'warning',
      deterministicBlocker: false,
      issue:
        `Slide text wraps to ${w.lines} line${w.lines === 1 ? '' : 's'}: ${label} at ${Math.round(w.fontSize)}px. ` +
        `It would fit on one line at ~${w.recommendedFontSizePx}px (24px floor). ` +
        `Autofix candidate.`,
      suggestion:
        `Reduce font-size on ${label} from ${Math.round(w.fontSize)}px to ${w.recommendedFontSizePx}px ` +
        `(floor 24px) so the line collapses without losing readability.`,
      // Machine-readable payload — slide-text-wrap-fit patch consumes these.
      meta: {
        tag: w.tag,
        classes: w.classes,
        text: w.text,
        currentFontSizePx: Math.round(w.fontSize),
        recommendedFontSizePx: w.recommendedFontSizePx,
        lines: w.lines,
        rect: w.rect,
        isHeadlineLike: w.isHeadlineLike,
      },
    });
  }
  return out;
}

function scanSlideMotionAttributes(html, slideStepIds) {
  if (!html || !/\bslide-root\b/.test(html)) return [];
  const blocks = extractSlideStepHtmlBlocks(html, slideStepIds);
  const iterable = blocks.size ? [...blocks.entries()] : [['slide-design', html]];
  const out = [];

  for (const [stepId, block] of iterable) {
    const dataAnim = /\bdata-anim\s*=/i.test(block);
    const dataFx = /\bdata-fx\s*=/i.test(block);
    const animClass = /\bclass\s*=\s*["'][^"']*\banim-[a-z0-9-]+/i.test(block);
    if (dataAnim || dataFx || animClass) {
      const triggers = [
        dataAnim ? 'data-anim' : null,
        dataFx ? 'data-fx' : null,
        animClass ? 'anim-* class' : null,
      ].filter(Boolean).join(', ');
      out.push(slideDesignWarning(
        stepId,
        'slide-motion-attributes',
        `Workhorse animation hook (${triggers}) inside .slide-root — pipeline slides are static.`,
        'Remove data-anim / data-fx / anim-* class. Motion is allowed only on standalone exports, not pipeline recordings.'
      ));
    }
  }

  return out;
}

/** Ensure each slide uses a registered showcase workhorse layout. */
function scanSlideShowcaseTemplate(html, demoScript, buildMode) {
  const mode = String(buildMode || '').toLowerCase().trim();
  if (mode !== 'app+slides') return [];
  const steps = Array.isArray(demoScript?.steps) ? demoScript.steps : [];
  const slideStepIds = steps.filter((s) => isSlideLikeStep(s)).map((s) => s.id);
  if (!slideStepIds.length) return [];
  const out = [];
  for (const stepId of slideStepIds) {
    const re = new RegExp(
      `<div[^>]*\\bdata-testid="step-${String(stepId).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}"[^>]*>[\\s\\S]*?(?=<div[^>]*\\bdata-testid="step-|<!--[\\s\\S]*?SIDE PANELS|<div[^>]*\\bid="(?:link-events-panel|api-response-panel)"|<\\/body>)`,
      'i'
    );
    const m = String(html || '').match(re);
    if (!m) continue;
    const block = m[0];
    if (/\bdata-slide-pending\s*=\s*"true"/i.test(block)) continue;
    const layoutM = block.match(/\bdata-workhorse-layout\s*=\s*["']([^"']+)["']/i);
    const layout = layoutM ? layoutM[1] : '';
    if (!layout) {
      out.push({
        category: 'slide-showcase-template',
        severity: 'warning',
        deterministicBlocker: false,
        stepId,
        issue: `Slide "${stepId}" missing data-workhorse-layout (must match templates/slide-template/showcase registry).`,
      });
      continue;
    }
    if (!isKnownWorkhorseLayout(layout)) {
      out.push({
        category: 'slide-showcase-template',
        severity: 'warning',
        deterministicBlocker: false,
        stepId,
        issue: `Slide "${stepId}" uses unknown workhorse layout "${layout}" — not in showcase registry.`,
      });
    }
  }
  return out;
}

/** Run all slide-design scanners when the build includes slides. */
function scanSlideDesignSystem(html, demoScript, buildMode) {
  const steps = Array.isArray(demoScript?.steps) ? demoScript.steps : [];
  const slideStepIds = steps.filter((s) => isSlideLikeStep(s)).map((s) => s.id);
  if (!slideStepIds.length || !/\bslide-root\b/.test(html || '')) return [];
  return [
    ...scanSlideShowcaseTemplate(html, demoScript, buildMode),
    ...scanSlidePlaidLogoAuthenticity(html, slideStepIds),
    ...scanSlideChromeLogoPlacement(html, slideStepIds),
    ...scanSlideDesignTokens(html),
    ...scanSlideShellChrome(html, slideStepIds),
    ...scanSlideTypographyFloor(html),
    ...scanSlideTypographyCeiling(html),
    ...scanSlideHeadlineItalicAccent(html, slideStepIds),
    ...scanSlideMintOveruse(html, slideStepIds),
    ...scanSlideForbiddenSalesCta(html, slideStepIds),
    ...scanSlideInlineBlockLayout(html),
    ...scanSlideBackgroundRhythm(demoScript, html),
    ...scanSlideInventedColors(html),
    ...scanSlideWorkhorseThemeLeak(html, slideStepIds),
    ...scanSlideWorkhorseRuntimeLeak(html, slideStepIds),
    ...scanSlideMotionAttributes(html, slideStepIds),
  ];
}

/**
 * Slide narration drift scanner — fires ONLY when buildMode === 'app+slides'.
 *
 * For every slide-kind step, extracts concrete numeric tokens + named
 * decisions + product names from `step.narration` and asserts each appears
 * in the rendered slide block's text content. If the LLM inserted a slide
 * whose visible text doesn't match the narration's concrete claims, we'd
 * ship voiceover that says "Trust Index 87 — ACCEPT" while the screen shows
 * "Score 92 — REVIEW". This scanner catches that BEFORE recording.
 *
 * Returns an array of diagnostics (empty when clean).
 *
 * @param {string} html
 * @param {object} demoScript
 * @param {string} buildMode
 * @returns {Array<object>}
 */
function scanSlideNarrationConcreteValues(html, demoScript, buildMode) {
  const mode = String(buildMode || '').toLowerCase().trim();
  if (mode !== 'app+slides') return [];
  if (!html || !demoScript || !Array.isArray(demoScript.steps)) return [];

  // Re-use extractStepBlocks from the hash utility to get per-step HTML;
  // import lazily so we don't introduce a load-order cycle.
  let extract;
  try {
    delete require.cache[require.resolve('../utils/slide-content-hash')];
    extract = require('../utils/slide-content-hash').extractStepBlocks;
  } catch (_) {
    return [];
  }
  const blocks = new Map(extract(html).map((b) => [b.stepId, b.html]));

  const slideSteps = demoScript.steps.filter((s) => s && (isSlideLikeStep ? isSlideLikeStep(s) : (s.stepKind === 'slide' || s.sceneType === 'slide')));
  if (slideSteps.length === 0) return [];

  const out = [];
  for (const step of slideSteps) {
    const blockHtml = blocks.get(step.id);
    if (!blockHtml) continue; // missing slide block is handled by other scanners
    const narration = String(step.narration || '').trim();
    if (!narration) continue;
    // Strip HTML tags for content-only comparison.
    const slideText = String(blockHtml)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const slideTextLower = slideText.toLowerCase();

    const missingTokens = [];

    // 1. Numeric tokens — `\b\d+(\.\d+)?\s*(%|seconds|s|ms)?\b`. We extract
    //    numbers that look like meaningful claims (scores, percentages,
    //    durations, dollar amounts). Filter out tiny 1-2 digit numbers
    //    that might just be IDs or step counts.
    const numericRe = /(\$?\d{1,3}(?:,\d{3})+|\$?\d+(?:\.\d+)?\s*(?:%|seconds?|s|ms|days?)?)/gi;
    const seenNums = new Set();
    let m;
    while ((m = numericRe.exec(narration)) !== null) {
      const raw = m[1].trim();
      // Skip standalone single-digit / two-digit numbers without unit (likely word counts).
      if (/^\d{1,2}$/.test(raw)) continue;
      const normalized = raw.replace(/\s+/g, '').toLowerCase();
      if (seenNums.has(normalized)) continue;
      seenNums.add(normalized);
      const variants = [normalized, raw.toLowerCase()];
      const found = variants.some((v) => slideTextLower.includes(v));
      if (!found) missingTokens.push(`numeric: "${raw}"`);
    }

    // 2. Named decisions — ACCEPT / REVIEW / REROUTE / DECLINE / APPROVED / etc.
    const decisionWords = [
      'ACCEPT', 'ACCEPTED', 'REVIEW', 'REROUTE', 'REROUTED', 'DECLINE', 'DECLINED',
      'APPROVE', 'APPROVED', 'REJECT', 'REJECTED', 'PENDING', 'PASS', 'FAIL',
    ];
    for (const w of decisionWords) {
      // Word-boundary match in narration (case-insensitive for the source,
      // but only flag when present as a capitalized decision token in
      // narration — those are the ones authors put in to make claims).
      const re = new RegExp(`\\b${w}\\b`, 'g');
      if (re.test(narration) && !new RegExp(`\\b${w}\\b`, 'i').test(slideText)) {
        missingTokens.push(`decision: "${w}"`);
      }
    }

    // 3. Named Plaid products mentioned in narration but not on screen.
    //    These are the product names the demo cares about — Plaid Layer,
    //    Plaid Signal, Trust Index, Ti2, etc.
    const productPhrases = [
      'Trust Index', 'Ti2',
      'Plaid Layer', 'Plaid Signal', 'Plaid Identity Verification', 'Plaid IDV',
      'Plaid Monitor', 'Plaid Assets', 'Plaid Protect', 'Plaid Instant Auth',
      'Plaid Liabilities', 'Plaid Investments', 'Plaid Investments Move',
      'Bank Income', 'Cash Advance Score', 'Earned Wage Access',
    ];
    for (const phrase of productPhrases) {
      if (new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(narration)
          && !new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(slideText)) {
        missingTokens.push(`product: "${phrase}"`);
      }
    }

    if (missingTokens.length > 0) {
      out.push({
        stepId: step.id,
        category: 'slide-narration-drift',
        severity: 'critical',
        issue:
          `Slide HTML for "${step.id}" is missing concrete claims from its narration: ` +
          `${missingTokens.slice(0, 6).join(', ')}` +
          (missingTokens.length > 6 ? ` (+ ${missingTokens.length - 6} more)` : ''),
        suggestion:
          'Either (a) update the slide HTML so the rendered content visibly evidences these claims ' +
          '(numbers, decisions, product names appear on screen), or (b) edit step.narration to remove ' +
          'claims the slide does not actually show. Recording + voiceover sync depend on the rendered ' +
          'content matching what the narrator says.',
        deterministicBlocker: true,
        missingTokens,
      });
    }
  }
  return out;
}

/**
 * App-only invariant scanner — fires ONLY when run-manifest.buildMode is
 * 'app-only'. Asserts the generated HTML contains zero slide artifacts.
 * Any leak is a critical deterministic blocker because it points at a
 * regression in build-app or the script stage (NOT something slide-fix
 * should "fix" — slide-fix doesn't run on app-only). The recovery hint
 * tells the operator that fact explicitly so they don't reach for the
 * wrong patch.
 *
 * Returns an array of diagnostics (empty when clean).
 */
function scanAppOnlyNoSlides(html, demoScript, buildMode) {
  const mode = String(buildMode || '').toLowerCase().trim();
  if (mode !== 'app-only') return [];
  const src = String(html || '');
  if (!src) return [];

  const checks = [
    {
      pattern: /<div[^>]*\bclass="[^"]*\bslide-root\b/i,
      label: '`.slide-root` div',
      hint: 'Build-app should emit zero `.slide-root` markup on app-only runs.',
    },
    {
      pattern: /\bdata-slide-pending\s*=\s*"true"/i,
      label: '`data-slide-pending="true"` placeholder',
      hint: 'Canonical slide placeholders are gated on buildMode==="app+slides" only.',
    },
    {
      pattern: /<style[^>]*\bdata-pipeline-slide-contract\b/i,
      label: '`<style data-pipeline-slide-contract>` CSS block',
      hint: 'The pipeline-slide-contract CSS is injected by post-slides; post-slides must not run on app-only.',
    },
    {
      pattern: /\bdata-slide-template\s*=\s*"T\d+/i,
      label: '`data-slide-template="T#"` marker',
      hint: 'Slide template markers belong on app+slides runs only.',
    },
  ];

  const out = [];
  for (const check of checks) {
    if (check.pattern.test(src)) {
      out.push({
        stepId: 'build',
        category: 'app-only-slide-leak',
        severity: 'critical',
        issue: `App-only run contains ${check.label} — slide artifact leaked into an app-only build.`,
        suggestion:
          `${check.hint} This is a build-app or script-stage regression, NOT something slide-fix should patch ` +
          '(slide-fix does not run on app-only). Inspect generate-script.js (slide step leak), build-app.js ' +
          '(slide-root post-processing), or the LLM build prompt for the failing run.',
        deterministicBlocker: true,
      });
    }
  }

  // Also flag demo-script step leak: if any step has stepKind==='slide' or
  // sceneType==='slide' on app-only, log it (even if HTML happens to be clean
  // this run — the next stage that consumes the script will misbehave).
  const slideStepsInScript = Array.isArray(demoScript?.steps)
    ? demoScript.steps.filter((s) => s && (s.stepKind === 'slide' || s.sceneType === 'slide'))
    : [];
  if (slideStepsInScript.length > 0) {
    out.push({
      stepId: slideStepsInScript[0].id || 'build',
      category: 'app-only-slide-leak',
      severity: 'critical',
      issue:
        `App-only demo-script.json contains ${slideStepsInScript.length} slide step(s): ` +
        `${slideStepsInScript.map((s) => s.id || '<no-id>').join(', ')}`,
      suggestion:
        'Check generate-script.js app-only safety net (it should strip insight/slide steps when ' +
        'SCRIPT_ZERO_SLIDE=true). If the operator wants slides, the storyboard editor flips ' +
        'buildMode -> "app+slides" via stampInsertedStepKindAndMaybeUpgradeBuildMode.',
      deterministicBlocker: true,
    });
  }

  return out;
}

// Properties that, when applied to renderjson's `.disclosure` toggle class,
// turn the small inline-character toggles into large solid blocks. Verified
// regression: 2026-05-21-Uses-Current-For-Daily-CRA-Auth-Identity-Signal-Protect-v1
// where LLM-generated CSS gave .disclosure width + background → huge white
// squares obscuring every JSON sub-tree marker.
const DISCLOSURE_PROBLEM_PROPS = /\b(width|height|min-width|min-height|background|background-color|background-image)\s*:/i;
const DISCLOSURE_PROP_HARMLESS_VALUES = /:\s*(0(\.0+)?(px|em|rem)?|auto|none|transparent|inherit|initial|unset)\s*(!important)?\s*;/i;

/**
 * Deterministic static-CSS scan: flag rules that style renderjson's
 * `.disclosure` class with width, height, or background — those produce the
 * "huge white block" failure mode observed in build
 * 2026-05-21-Uses-Current-For-Daily-CRA-Auth-Identity-Signal-Protect-v1.
 *
 * post-panels.js v8 injects canonical override CSS at request time, so the
 * panel ultimately renders correctly. This check still surfaces the LLM's
 * bad output so future builds can be fixed at the source.
 *
 * @param {string} html
 * @returns {Array<object>}
 */
function scanRenderjsonDisclosureStyling(html) {
  const out = [];
  if (typeof html !== 'string' || html.length === 0) return out;
  // Extract every <style>...</style> block, including ones with attributes.
  const styleBlocks = [];
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = styleRe.exec(html)) !== null) {
    styleBlocks.push(m[1]);
  }
  if (styleBlocks.length === 0) return out;
  // Skip rules that look like the post-panels v8 canonical override block —
  // those legitimately set width:auto, height:auto, background:transparent,
  // and those are the FIX not the bug.
  // Any `.disclosure` rule scoped under #api-response-panel is panel-owned —
  // either the post-panels v8+ canonical override (which legitimately sets a
  // small fixed width on the inline toggle) or panel chrome. The LLM-source bug
  // this check targets is a GLOBAL/host `.disclosure` rule, not a panel-scoped
  // one. The older regex only matched `#api-response-panel a.disclosure` /
  // `button.disclosure` and missed the current shim selector
  // `#api-response-panel .renderjson .disclosure`, producing a false-positive
  // critical blocker (2026-05-29). Match any panel-scoped `.disclosure` rule.
  const POST_PANELS_OVERRIDE = /#api-response-panel\b[^{]*\.disclosure|#api-response-panel\s+(a\.)?disclosure|#api-response-panel\s+button\.disclosure/i;
  const offenders = [];
  for (const css of styleBlocks) {
    // Find all rules where the selector list contains a token matching
    // .disclosure (with optional ancestor selector). We capture each rule
    // body separately so we can inspect its declarations.
    const ruleRe = /([^{}]*\.disclosure[^{}]*)\{([^{}]*)\}/gi;
    let rule;
    while ((rule = ruleRe.exec(css)) !== null) {
      const selector = (rule[1] || '').trim();
      const body     = rule[2] || '';
      // Skip the post-panels override block — that is our fix, not the bug.
      if (POST_PANELS_OVERRIDE.test(selector)) continue;
      // Look for problematic property declarations. Each declaration is
      // `prop: value;`. We split on `;` and check each one against the
      // problem-prop regex while excluding harmless values like `0`,
      // `auto`, `none`, `transparent`.
      const decls = body
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      const badDecls = [];
      for (const decl of decls) {
        const declWithSemi = decl + ';';
        if (!DISCLOSURE_PROBLEM_PROPS.test(declWithSemi)) continue;
        if (DISCLOSURE_PROP_HARMLESS_VALUES.test(declWithSemi)) continue;
        badDecls.push(decl);
      }
      if (badDecls.length) {
        offenders.push({ selector, badDecls });
      }
    }
  }
  if (offenders.length === 0) return out;
  const summarized = offenders
    .slice(0, 3)
    .map((o) => `\`${o.selector} { ${o.badDecls.join('; ')}; }\``)
    .join(' • ');
  out.push({
    stepId: 'build',
    category: 'json-panel-styling',
    // WARNING, not a blocker: post-panels.js v8 injects a canonical
    // `#api-response-panel .renderjson .disclosure` override at request time, so
    // the panel RENDERS CORRECTLY regardless of this host rule (a global
    // `.disclosure` is also commonly a legit host disclaimer-box style, not a
    // renderjson toggle). Failing the deterministic gate here blocked an
    // otherwise-correct build (Current rerun: 93 vision, panel fine). Keep
    // surfacing it as a source-cleanup nudge without halting the pipeline.
    severity: 'warning',
    issue:
      `renderjson \`.disclosure\` toggles have host-CSS rule(s) that set width/height/background — ` +
      `post-panels overrides these in the panel at render time (panel is unaffected), but the host rule ` +
      `should be scoped/renamed for cleanliness. Offending rule(s): ${summarized}.`,
    suggestion:
      'Scope or rename the host `.disclosure` rule (e.g. `.host-disclosure`) so it cannot collide with ' +
      'renderjson toggles. Renderjson disclosure toggles must remain inline text (only `color` and ' +
      '`cursor: pointer` are safe). post-panels.js v8 already masks the symptom in the panel.',
    deterministicBlocker: false,
  });
  return out;
}

async function locateVisible(page, selector) {
  const loc = page.locator(selector).filter({ visible: true }).first();
  await loc.waitFor({ state: 'visible', timeout: 8000 });
  return loc;
}

function extractDataTestid(selector) {
  const m = String(selector || '').match(/^\[data-testid="([^"]+)"\]$/);
  return m ? m[1] : null;
}

async function locateVisibleWithFallback(page, selector) {
  try {
    return await locateVisible(page, selector);
  } catch (primaryErr) {
    const testid = extractDataTestid(selector);
    if (testid) {
      const base = testid.replace(/-dup\d+$/, '');
      const candidates = [
        `[data-testid="${testid}"]`,
        `[data-testid="${base}"]`,
        `[data-testid^="${base}-dup"]`,
      ];
      for (const candidate of candidates) {
        const loc = page.locator(candidate).filter({ visible: true }).first();
        if (await loc.count()) return loc;
      }
    }
    throw primaryErr;
  }
}

async function forceStepActive(page, stepId) {
  if (!stepId || typeof stepId !== 'string') return { ok: false, reason: 'invalid-step-id' };
  return page.evaluate((id) => {
    const expected = `step-${id}`;
    const target = document.querySelector(`[data-testid="${expected}"]`);
    if (!target) return { ok: false, reason: 'step-not-found', expected };
    const activeBefore = document.querySelector('.step.active')?.getAttribute('data-testid') || null;
    if (typeof window.goToStep === 'function') {
      try { window.goToStep(id); } catch (_) {}
    }
    let activeAfter = document.querySelector('.step.active')?.getAttribute('data-testid') || null;
    // Recovery fallback: if goToStep didn't activate the expected step, force class alignment.
    if (activeAfter !== expected) {
      document.querySelectorAll('.step.active').forEach((el) => el.classList.remove('active'));
      target.classList.add('active');
      activeAfter = document.querySelector('.step.active')?.getAttribute('data-testid') || null;
    }
    return {
      ok: activeAfter === expected,
      expected,
      activeBefore,
      activeAfter,
      recovered: activeBefore !== activeAfter && activeAfter === expected,
    };
  }, stepId);
}

async function getDomStepInventory(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.step[data-testid]'))
      .map((el) => String(el.getAttribute('data-testid') || ''))
      .filter(Boolean)
  );
}

/** First demo-script step id — used when the host app loads with no visible .step.active. */
function resolveInitialStepId(demoScript) {
  const steps = demoScript?.steps;
  if (!Array.isArray(steps) || !steps.length) return null;
  return steps[0]?.id || null;
}

async function hasVisibleActiveStep(page) {
  return page.evaluate(() => {
    const active = document.querySelector('.step.active');
    if (!active) return false;
    const st = window.getComputedStyle(active);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const rect = active.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

/**
 * Demos often list a marketing slide first; generated HTML may omit .active on load so every
 * .step stays display:none and Playwright's visible wait fails before the walkthrough starts.
 */
async function ensureInitialStepVisible(page, demoScript) {
  if (await hasVisibleActiveStep(page)) {
    const stepId = await page.evaluate(() => {
      const tid = document.querySelector('.step.active')?.getAttribute('data-testid') || '';
      return tid.replace(/^step-/, '');
    });
    return { activated: false, stepId, reason: null };
  }

  const stepId = resolveInitialStepId(demoScript);
  if (!stepId) {
    return { activated: false, stepId: null, reason: 'no-script-steps' };
  }

  const firstStep = (demoScript.steps || [])[0];
  const reason = isSlideLikeStep(firstStep)
    ? 'slide-first-no-visible-active-on-load'
    : 'no-visible-active-on-load';

  const forceResult = await forceStepActive(page, stepId);
  if (!forceResult.ok) {
    throw new Error(
      `Could not activate initial step "${stepId}" (${reason}): ${forceResult.reason || 'forceStepActive failed'}`
    );
  }

  await page.waitForSelector('.step.active', { state: 'visible', timeout: 8000 });
  return { activated: true, stepId, reason, forceResult };
}

async function evaluateStepState(page, stepId) {
  return page.evaluate((id) => {
    const stepEl = document.querySelector(`[data-testid="step-${id}"]`);
    const active = document.querySelector('.step.active');
    const apiPanel = document.getElementById('api-response-panel');
    const linkPanel = document.getElementById('link-events-panel');
    const stepStyle = stepEl ? window.getComputedStyle(stepEl) : null;
    const apiStyle = apiPanel ? window.getComputedStyle(apiPanel) : null;
    const linkStyle = linkPanel ? window.getComputedStyle(linkPanel) : null;
    // v12 panel (Claude Design "API Panel (standalone)") uses .code-wrap with
    // two <pre.code data-pane="req"|data-pane="res"> panes. Legacy v9–v11 uses
    // .side-panel-body + #api-response-content. Support BOTH so this scanner
    // works against any pipeline build.
    const v12PaneReq = document.getElementById('api-pane-request');
    const v12PaneRes = document.getElementById('api-pane-response');
    const v12CodeWrap = apiPanel ? apiPanel.querySelector('.code-wrap') : null;
    const legacyApiBody = document.getElementById('api-response-content');
    const legacyBodyContainer = apiPanel ? apiPanel.querySelector('.side-panel-body') : null;
    let apiBody, apiBodyContainer;
    if (v12PaneReq || v12PaneRes) {
      // Pick whichever pane is currently active; fall back to whichever has content.
      const activePane =
        (v12PaneReq && v12PaneReq.classList.contains('is-active')) ? v12PaneReq :
        (v12PaneRes && v12PaneRes.classList.contains('is-active')) ? v12PaneRes :
        (v12PaneReq && (v12PaneReq.textContent || '').trim() ? v12PaneReq : v12PaneRes);
      apiBody = activePane || v12PaneReq || v12PaneRes;
      apiBodyContainer = v12CodeWrap;
    } else {
      apiBody = legacyApiBody;
      apiBodyContainer = legacyBodyContainer;
    }
    const endpoint = document.getElementById('api-panel-path') ||
                     document.getElementById('api-panel-endpoint');
    const apiToggle = document.querySelector('[data-testid="api-panel-toggle"], #api-panel-toggle, .api-panel-edge-toggle');
    const slideRoot = active ? active.querySelector('.slide-root') : null;
    const slideRootStyle = slideRoot ? window.getComputedStyle(slideRoot) : null;
    const slideInlineStyle = slideRoot ? String(slideRoot.getAttribute('style') || '') : '';
    const slideRootRect = slideRoot ? slideRoot.getBoundingClientRect() : null;
    // Content-clipping detector: how far the lowest/right-most visible content
    // inside the slide-root extends BEYOND the canvas edge. The canvas uses
    // overflow:hidden, so any positive value = content clipped by the letterbox
    // ("blue border clips the content" bug). Detects BOTH:
    //   • TEXT clips — leaf text nodes (e.g. a stat caption cut at the bottom).
    //   • OBJECT clips — visual elements (img/svg, or a box with a
    //     background/border/box-shadow — e.g. a step CARD or media tile) whose
    //     border-box extends past the canvas. Object clips are easy to miss
    //     visually (a card just looks a little short), so they're measured too.
    // Ignores the chrome-logo (decorative, lives in the top margin) and any
    // element whose box ≈ the slide-root itself (full-bleed background layers).
    let slideContentOverflowPx = 0;
    let slideClippedText = '';
    let slideClippedKind = '';
    if (slideRoot && slideRootRect) {
      const clipBottom = slideRootRect.bottom;
      const clipRight = slideRootRect.right;
      const clipTop = slideRootRect.top;
      const clipLeft = slideRootRect.left;
      const rootW = slideRootRect.width;
      const isVisualBox = (el, cs) => {
        const tag = el.tagName;
        if (tag === 'IMG' || tag === 'SVG' || tag === 'CANVAS' || tag === 'VIDEO' || /svg/i.test(tag)) return true;
        const bg = cs.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return true;
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
        if (parseFloat(cs.borderTopWidth) || parseFloat(cs.borderBottomWidth) ||
            parseFloat(cs.borderLeftWidth) || parseFloat(cs.borderRightWidth)) return true;
        if (cs.boxShadow && cs.boxShadow !== 'none') return true;
        return false;
      };
      const nodes = slideRoot.querySelectorAll('*');
      for (const n of nodes) {
        if (n.classList && (n.classList.contains('chrome-logo') || n.classList.contains('frame'))) continue;
        const cs = window.getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity || '1') === 0) continue;
        const rr = n.getBoundingClientRect();
        if (rr.width === 0 || rr.height === 0) continue;
        const txt = (n.textContent || '').trim();
        const isLeafText = !!txt && n.children.length === 0;
        const visual = isVisualBox(n, cs);
        if (!isLeafText && !visual) continue;
        // Skip full-bleed background layers (box ≈ the slide-root on both axes) —
        // their edges legitimately coincide with the canvas, not a clip.
        if (!isLeafText && rr.width >= rootW - 2 && Math.abs(rr.bottom - clipBottom) <= 2 && Math.abs(rr.top - clipTop) <= 2) continue;
        const over = Math.max(rr.bottom - clipBottom, rr.right - clipRight, clipTop - rr.top, clipLeft - rr.left);
        if (over > slideContentOverflowPx) {
          slideContentOverflowPx = over;
          slideClippedKind = isLeafText ? 'text' : 'object';
          slideClippedText = (txt || (n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(' ')[0] : ''))).slice(0, 60);
        }
      }
      slideContentOverflowPx = Math.round(slideContentOverflowPx);
    }
    const slideBody = active ? active.querySelector('.slide-body') : null;
    const slideBodyStyle = slideBody ? window.getComputedStyle(slideBody) : null;
    const slideTable = active ? active.querySelector('.slide-root table') : null;
    const slideTableRect = slideTable ? slideTable.getBoundingClientRect() : null;
    const bankLogo = document.querySelector('[data-testid="host-bank-logo-img"], [data-testid="host-bank-icon-img"]');
    const bankLogoShell = document.querySelector('[data-testid="host-bank-logo-shell"]');
    const layerHelper =
      active?.querySelector('[data-testid="layer-eligibility-helper-text"]') ||
      document.querySelector('[data-testid="layer-eligibility-helper-text"]');
    const layerHelperStyle = layerHelper ? window.getComputedStyle(layerHelper) : null;
    const activePhoneInput = active
      ? active.querySelector('input[type="tel"], input[data-testid*="phone"], input[name*="phone"]')
      : null;
    const layerShareConfirmBtn = active ? active.querySelector('[data-testid="layer-share-confirm-btn"]') : null;
    const piiContinueBtn = active ? active.querySelector('[data-testid="pii-continue-btn"]') : null;
    const activePiiInputs = active
      ? active.querySelectorAll(
        '[data-testid*="ssn"], [data-testid*="dob"], [name*="ssn"], [name*="dob"], input[autocomplete*="ssn"], input[autocomplete*="bday"]'
      )
      : [];
    const isVisible = (el, style) => {
      if (!el || !style) return false;
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0 && rect.width > 0 && rect.height > 0;
    };

    let plaidLaunchCtaMetrics = null;
    const launchBtn = active ? active.querySelector('[data-testid="link-external-account-btn"]') : null;
    const embeddedContainer = active
      ? active.querySelector('[data-testid="plaid-embedded-link-container"], #plaid-embedded-link-container')
      : null;
    const embeddedRect = embeddedContainer ? embeddedContainer.getBoundingClientRect() : null;
    const embeddedHostRecommendedDuplicate = (() => {
      if (!active || !embeddedContainer) return false;
      const isInsideEmbed = (el) => el === embeddedContainer || embeddedContainer.contains(el);
      const nodes = active.querySelectorAll('*');
      let hostRecommendedCount = 0;
      nodes.forEach((el) => {
        if (isInsideEmbed(el)) return;
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (t.length > 220) return;
        if (/\b(recommended|instant verification)\b/.test(t) && /\bplaid\b/.test(t)) {
          hostRecommendedCount += 1;
        }
      });
      return hostRecommendedCount > 0;
    })();
    const embeddedFakeInstitutionSearch = (() => {
      if (!active || !embeddedContainer) return false;
      const inputs = active.querySelectorAll('input, [role="searchbox"], [contenteditable="true"]');
      for (const input of inputs) {
        if (embeddedContainer.contains(input)) continue;
        const ph = String(input.getAttribute('placeholder') || '').toLowerCase();
        const aria = String(input.getAttribute('aria-label') || '').toLowerCase();
        if (/\b(search|find).*\b(institution|bank)/.test(ph) || /\b(search|find).*\b(institution|bank)/.test(aria)) {
          return true;
        }
      }
      return false;
    })();
    if (launchBtn) {
      const br = launchBtn.getBoundingClientRect();
      const svgs = launchBtn.querySelectorAll('svg');
      let iconMaxDim = 0;
      svgs.forEach((svg) => {
        const r = svg.getBoundingClientRect();
        iconMaxDim = Math.max(iconMaxDim, r.width, r.height);
      });
      plaidLaunchCtaMetrics = {
        buttonHeight: br.height,
        buttonWidth: br.width,
        iconMaxDim,
        svgCount: svgs.length,
      };
    }

    return {
      currentStep: typeof window.getCurrentStep === 'function' ? window.getCurrentStep() : null,
      activeStepTestid: active?.dataset?.testid || null,
      stepExists: Boolean(stepEl),
      stepVisible: isVisible(stepEl, stepStyle),
      apiPanelExists: Boolean(apiPanel),
      apiPanelVisible: isVisible(apiPanel, apiStyle) && !(apiPanel && (apiPanel.classList.contains('api-panel-collapsed') || apiPanel.classList.contains('is-collapsed'))),
      apiBodyVisible: apiBodyContainer ? window.getComputedStyle(apiBodyContainer).display !== 'none' : false,
      // v12 panels make .code-wrap overflow:hidden and let the inner
      // <pre.code> pane (apiBody) do the actual scrolling (overflow:auto). The
      // container's overflowY therefore reads "hidden" even though the panel
      // scrolls fine — report the scrollable child's value when the container
      // itself isn't scrollable, so we don't false-flag every v12 build.
      apiBodyOverflowY: (function () {
        if (!apiBodyContainer) return '';
        const c = window.getComputedStyle(apiBodyContainer).overflowY;
        if (/(auto|scroll)/i.test(c)) return c;
        if (apiBody) {
          const ic = window.getComputedStyle(apiBody).overflowY;
          if (/(auto|scroll)/i.test(ic)) return ic;
        }
        return c;
      })(),
      apiJsonToggleExists: Boolean(apiToggle),
      apiPanelChromeTriplet: Boolean(apiToggle),
      // Horizontal-scroll guard: the expanded JSON rail must read without a
      // horizontal scrollbar (vertical scroll is fine). Measure the active
      // <pre.code> pane — scrollWidth > clientWidth means long lines overflow
      // (white-space:pre never wraps), so the viewer would have to scroll
      // sideways to see the code. Skip when the pane isn't laid out (clientWidth
      // tiny → not expanded) to avoid false positives.
      apiPanelCodeOverflowsX: (function () {
        if (!apiBody) return false;
        const cw = apiBody.clientWidth || 0;
        if (cw < 50) return false;
        return (apiBody.scrollWidth - cw) > 8;
      })(),
      apiPanelCodeScrollWidth: apiBody ? apiBody.scrollWidth : 0,
      apiPanelCodeClientWidth: apiBody ? apiBody.clientWidth : 0,
      apiPanelHasEdgeToggleClass: Boolean(apiToggle && String(apiToggle.className || '').includes('api-panel-edge-toggle')),
      hasToggleApiFunction: typeof window.toggleApiPanel === 'function',
      bankLogoPresent: Boolean(bankLogo),
      bankLogoVisible: bankLogo ? isVisible(bankLogo, window.getComputedStyle(bankLogo)) : false,
      bankLogoLoaded: bankLogo ? (bankLogo.tagName !== 'IMG' || (bankLogo.complete && bankLogo.naturalWidth > 0)) : false,
      bankLogoShellPresent: Boolean(bankLogoShell),
      bankLogoShellVisible: bankLogoShell ? isVisible(bankLogoShell, window.getComputedStyle(bankLogoShell)) : false,
      linkPanelVisible: isVisible(linkPanel, linkStyle),
      apiContentLength: (apiBody?.textContent || '').trim().length,
      apiEndpointText: (endpoint?.textContent || '').trim(),
      activeStepHasSlideRoot: Boolean(active?.querySelector('.slide-root')),
      slideContentOverflowPx,
      slideClippedText,
      slideClippedKind,
      activeStepText: (active?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
      activeStepPreCodeCount: active ? active.querySelectorAll('pre, code').length : 0,
      activeStepJsonHintNodeCount: active ? active.querySelectorAll('[class*="json"], [id*="json"], [data-testid*="json"]').length : 0,
      slideRootInlineStyleHasFixedSize: /\b(?:width|height|min-width|min-height|max-width|max-height)\s*:\s*\d+px\b/i.test(slideInlineStyle),
      slideRootComputedWidth: slideRootStyle ? parseFloat(slideRootStyle.width || '0') : 0,
      slideRootComputedHeight: slideRootStyle ? parseFloat(slideRootStyle.height || '0') : 0,
      slideRootRenderedWidth: slideRootRect ? slideRootRect.width : 0,
      slideRootRenderedHeight: slideRootRect ? slideRootRect.height : 0,
      slideRootOffsetLeft: slideRootRect ? slideRootRect.left : 0,
      viewportWidth: window.innerWidth || document.documentElement.clientWidth || 0,
      viewportHeight: window.innerHeight || document.documentElement.clientHeight || 0,
      bodyHasSlideActiveClass: document.body.classList.contains('pipeline-slide-active'),
      hostNavVisible: (() => {
        const nav = document.querySelector('.host-nav, .fdic-bar, .sub-nav');
        if (!nav) return false;
        const st = window.getComputedStyle(nav);
        return st.display !== 'none' && st.visibility !== 'hidden' && nav.getBoundingClientRect().height > 0;
      })(),
      // Broad host-chrome-on-slide detector: ANY app banner/nav/header/footer
      // (not just the 3 legacy classes, not just .host-app-chrome) that is
      // visible and overlaps the slide canvas. Slides are isolated full-screen
      // Plaid surfaces — no host application content may bleed in. Excludes the
      // #api-response-panel overlay and anything inside a .slide-root.
      hostChromeOnSlide: (() => {
        const root = active ? active.querySelector('.slide-root') : null;
        if (!root) return null; // not a slide step
        const sel = 'header, nav, footer, .host-nav, .fdic-bar, .sub-nav, .host-app-chrome,' +
          '[class*="banner"], [class*="navbar"], [class*="topbar"], [class*="app-header"], [class*="site-header"]';
        const hits = [];
        document.querySelectorAll(sel).forEach((el) => {
          if (el.id === 'api-response-panel' || el.closest('#api-response-panel')) return; // panel overlay is allowed
          if (el.closest('.slide-root')) return; // legit slide-internal header/nav
          const st = window.getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return;
          const r = el.getBoundingClientRect();
          if (r.height < 8 || r.width < 8) return;
          // overlaps the visible viewport (top band where banners live, or anywhere on-canvas)
          if (r.bottom > 0 && r.top < (window.innerHeight || 900) && r.right > 0 && r.left < (window.innerWidth || 1440)) {
            hits.push(((el.tagName || '') + '.' + (typeof el.className === 'string' ? el.className : '')).slice(0, 60));
          }
        });
        return hits.length ? hits.slice(0, 5) : false;
      })(),
      activeSlideHasTable: Boolean(slideTable),
      slideTableWidth: slideTableRect ? slideTableRect.width : 0,
      slideBodyBorderWidth: slideBodyStyle ? parseFloat(slideBodyStyle.borderTopWidth || '0') : 0,
      activeStepHasMobileShellTarget: Boolean(active?.classList?.contains('mobile-shell-target')),
      activeStepHasMobileSimulatorShell: Boolean(active?.querySelector('[data-testid="mobile-simulator-shell"]')),
      hasOnboardingCompleteStep: Boolean(document.querySelector('[data-testid="step-onboarding-complete"]')),
      layerShareConfirmOnclick: layerShareConfirmBtn ? String(layerShareConfirmBtn.getAttribute('onclick') || '') : '',
      piiContinueOnclick: piiContinueBtn ? String(piiContinueBtn.getAttribute('onclick') || '') : '',
      activePiiInputCount: activePiiInputs.length,
      activeStepHasPlaidLinkLaunchBtn: Boolean(active?.querySelector('[data-testid="link-external-account-btn"]')),
      embeddedContainerExists: Boolean(embeddedContainer),
      embeddedContainerWidth: embeddedRect ? embeddedRect.width : 0,
      embeddedContainerHeight: embeddedRect ? embeddedRect.height : 0,
      embeddedHostRecommendedDuplicate,
      embeddedFakeInstitutionSearch,
      plaidLaunchCtaMetrics,
      layerHelperText: (layerHelper?.textContent || '').replace(/\s+/g, ' ').trim(),
      layerHelperVisible: isVisible(layerHelper, layerHelperStyle),
      activePhoneInputValue: activePhoneInput ? String(activePhoneInput.value || '').trim() : '',
      // ── Slide text-overlap detection ──────────────────────────────────────
      // For slide-like active steps, walk visible text-bearing elements inside
      // .slide-root and report pairs whose rendered bounding boxes overlap by
      // more than 8 px of intersection area. Excludes parent-child pairs.
      // Returns up to 12 worst pairs (sorted by overlap area descending).
      slideTextOverlaps: (() => {
        const slideRoot = active ? active.querySelector('.slide-root') : null;
        if (!slideRoot) return [];
        const TEXT_TAGS = new Set(['H1','H2','H3','H4','H5','H6','P','LI','BLOCKQUOTE','STRONG','EM','SPAN','DIV','BUTTON','A','LABEL','CODE','PRE','TD','TH']);
        const all = Array.from(slideRoot.querySelectorAll('*'));
        const candidates = [];
        for (const el of all) {
          if (!TEXT_TAGS.has(el.tagName)) continue;
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length < 2) continue;
          // Only consider elements that have direct text node children, not
          // pure containers. Otherwise a wrapping <div> will dominate every pair.
          const hasDirectText = Array.from(el.childNodes).some(
            (n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0
          );
          if (!hasDirectText) continue;
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (Number(cs.opacity || '1') === 0) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 1 || r.height <= 1) continue;
          candidates.push({ el, rect: r, text: text.slice(0, 80), fontSize: parseFloat(cs.fontSize || '0') || 0, tag: el.tagName });
        }
        const overlaps = [];
        const OVERLAP_AREA_THRESHOLD = 8 * 8; // 8px x 8px = 64px²
        for (let i = 0; i < candidates.length; i++) {
          for (let j = i + 1; j < candidates.length; j++) {
            const a = candidates[i];
            const b = candidates[j];
            if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
            const x1 = Math.max(a.rect.left, b.rect.left);
            const y1 = Math.max(a.rect.top, b.rect.top);
            const x2 = Math.min(a.rect.right, b.rect.right);
            const y2 = Math.min(a.rect.bottom, b.rect.bottom);
            const w = x2 - x1;
            const h = y2 - y1;
            if (w <= 0 || h <= 0) continue;
            const area = w * h;
            if (area < OVERLAP_AREA_THRESHOLD) continue;
            overlaps.push({
              a: { tag: a.tag, text: a.text, fontSize: a.fontSize, rect: { x: Math.round(a.rect.left), y: Math.round(a.rect.top), w: Math.round(a.rect.width), h: Math.round(a.rect.height) } },
              b: { tag: b.tag, text: b.text, fontSize: b.fontSize, rect: { x: Math.round(b.rect.left), y: Math.round(b.rect.top), w: Math.round(b.rect.width), h: Math.round(b.rect.height) } },
              overlapArea: Math.round(area),
              overlapW: Math.round(w),
              overlapH: Math.round(h),
            });
          }
        }
        overlaps.sort((p, q) => q.overlapArea - p.overlapArea);
        return overlaps.slice(0, 12);
      })(),
      // ── Slide text-wrap measurement ──────────────────────────────────────
      // For headline / label-class text elements inside .slide-root, measure
      // how many lines they currently render across and whether shrinking
      // the font-size (down to the 24px floor) would let them collapse to a
      // single line. This is the "dynamic font reduction" signal — fed into
      // slide-text-wrap-fit patch which scopes a CSS rule per stepId+tag.
      //
      // Skips long-form body copy (P / LI with > 80 chars) — those legitimately
      // wrap. Only flags elements where wrapping looks like an alignment
      // problem (headlines, eyebrows, stat values, short labels).
      slideTextWraps: (() => {
        const slideRoot = active ? active.querySelector('.slide-root') : null;
        if (!slideRoot) return [];
        // Lead-title / display-stat-VALUE classes only. The auto-shrink-to-one-
        // line routine must NEVER touch sub-bullets, stat captions, or body copy
        // — shrinking a long caption to fit one line makes it microscopic
        // (e.g. a stat label collapsing to ~10px). NON_TITLE is an explicit
        // exclude: note that \bsc-stat\b also matches "sc-stat-label", so the
        // label guard below is what keeps captions out.
        const HEADLINE_LIKE = /\b(h-title|hero-title|headline|h-hero|display-title|hero-stat-value|sc-stat|stat-value|h-section)\b/i;
        const NON_TITLE = /(?:label|caption|sub-?title|sub-?head|subhead|eyebrow|body|bullet|footnote|disclaimer|note|meta|detail|copy|desc)/i;
        const SHORT_TAG = new Set(['H1', 'H2', 'H3']);
        const candidates = [];
        for (const el of Array.from(slideRoot.querySelectorAll('*'))) {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length < 4) continue;
          const hasDirectText = Array.from(el.childNodes).some(
            (n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0
          );
          if (!hasDirectText) continue;
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (Number(cs.opacity || '1') === 0) continue;
          const className = String(el.className || '');
          // Sub-bullets / stat captions / body labels are never lead titles —
          // exclude them outright so the one-line-fit shrink can't apply.
          if (NON_TITLE.test(className)) continue;
          const isHeadlineLike = HEADLINE_LIKE.test(className);
          const isShortTag = SHORT_TAG.has(el.tagName);
          // Skip multi-sentence body copy — natural wrapping is expected.
          if (!isHeadlineLike && !isShortTag) continue;
          if (text.length > 120 && !isHeadlineLike) continue;
          const fontSize = parseFloat(cs.fontSize || '0') || 0;
          const lineHeightRaw = cs.lineHeight;
          let lineHeight = parseFloat(lineHeightRaw);
          if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
            // Browsers report 'normal' as e.g. 'normal' literal — treat as ~1.2x.
            lineHeight = fontSize * 1.2;
          }
          const rect = el.getBoundingClientRect();
          if (rect.width <= 1 || rect.height <= 1) continue;
          if (fontSize < 18) continue; // Below the floor — can't shrink further.
          const lines = Math.max(1, Math.round(rect.height / lineHeight));
          if (lines <= 1) continue;
          // Estimate text width via a single-line measurement so we can predict
          // whether a smaller font would fit in the available width.
          // Use a hidden span clone to measure rendered single-line width.
          const probe = document.createElement('span');
          probe.style.cssText = `
            position: absolute;
            visibility: hidden;
            white-space: nowrap;
            font: ${cs.font};
            letter-spacing: ${cs.letterSpacing};
            text-transform: ${cs.textTransform};
          `;
          probe.textContent = text;
          document.body.appendChild(probe);
          const measuredWidth = probe.getBoundingClientRect().width;
          probe.remove();
          const containerWidth = rect.width;
          if (containerWidth <= 0 || measuredWidth <= 0) continue;
          // Required shrink factor to fit on one line, with a 4% safety margin.
          // The 24px floor was removed 2026-05-27 — recommend whatever size fits
          // the container; the LLM/patch can decide if the smaller size is
          // readable enough for the content.
          const requiredFactor = containerWidth / (measuredWidth * 1.04);
          if (!Number.isFinite(requiredFactor) || requiredFactor >= 1) continue;
          const recommendedFs = Math.max(1, Math.floor(fontSize * requiredFactor));
          if (recommendedFs >= fontSize) continue;
          candidates.push({
            tag: el.tagName,
            classes: className,
            text: text.slice(0, 80),
            fontSize,
            lines,
            recommendedFontSizePx: recommendedFs,
            rect: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
            isHeadlineLike,
          });
        }
        // Worst wrappers first (most lines × largest font).
        candidates.sort((a, b) => (b.lines * b.fontSize) - (a.lines * a.fontSize));
        return candidates.slice(0, 8);
      })(),
    };
  }, stepId);
}

function detectHostUiStatLeak(step, state) {
  const sceneType = String(step?.sceneType || '').toLowerCase();
  if (sceneType && sceneType !== 'host') return null;
  if (!sceneType && isSlideLikeStep(step)) return null;
  const text = String(state?.activeStepText || '').toLowerCase();
  if (!text) return null;
  const metricSignals = [
    /\bidentity score\b/,
    /\bsignal score\b/,
    /\blow risk\b/,
    /\baccept\b/,
    /\bconfidence\b/,
    /\b\d{1,3}\s*\/\s*100\b/,
    /\b\d{1,3}%\+?\b/,
  ];
  const hasMetric = metricSignals.some((rx) => rx.test(text));
  if (!hasMetric) return null;
  return 'Host UI contains presentation-style internal stats without clear user-facing benefit.';
}

async function evaluateAssetAuthenticity(page) {
  return page.evaluate(() => {
    const hostLogo = document.querySelector('[data-testid="host-bank-logo-img"], [data-testid="host-bank-icon-img"]');
    const hostLogoShell = document.querySelector('[data-testid="host-bank-logo-shell"]');
    const logoTag = hostLogo ? String(hostLogo.tagName || '').toUpperCase() : '';
    const logoSrc = hostLogo?.getAttribute('src') || '';
    const shellInlineSvg = !!(hostLogoShell && hostLogoShell.querySelector('svg'));
    const shellText = hostLogoShell ? (hostLogoShell.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const shellLooksLikeTextLogo = !!shellText && shellText.length <= 6 && /^[a-z0-9&.\- ]+$/i.test(shellText);

    const allSvgs = Array.from(document.querySelectorAll('svg'));
    const nonPanelInlineSvgs = allSvgs.filter((svg) => {
      return !svg.closest('#api-response-panel') && !svg.closest('#link-events-panel');
    });

    const dataUriImgs = Array.from(document.querySelectorAll('img')).filter((img) => {
      const src = String(img.getAttribute('src') || '').trim().toLowerCase();
      return src.startsWith('data:');
    });

    const syntheticIconNodes = Array.from(document.querySelectorAll('.merchant-icon, .sum-icon, [data-testid*="icon"]')).filter((el) => {
      const txt = (el.textContent || '').replace(/\s+/g, '').trim();
      const hasSingleGlyph = txt.length > 0 && txt.length <= 2;
      const hasInlineSvg = !!el.querySelector('svg');
      const isImg = el.tagName === 'IMG' || !!el.querySelector('img');
      return (hasSingleGlyph || hasInlineSvg) && !isImg;
    });

    return {
      logoTag,
      logoSrc,
      shellInlineSvg,
      shellLooksLikeTextLogo,
      nonPanelInlineSvgCount: nonPanelInlineSvgs.length,
      // NOTE: svg.className is an SVGAnimatedString, not a string — String(...) it yields
      // "[object SVGAnimatedString]". Use getAttribute('class') instead so the hint is a
      // real class list (or any usable identifier).
      nonPanelInlineSvgHints: nonPanelInlineSvgs.slice(0, 8).map((svg) =>
        String(
          svg.getAttribute('data-testid')
          || svg.getAttribute('aria-label')
          || svg.getAttribute('class')
          || svg.id
          || 'inline-svg'
        ).slice(0, 64)
      ),
      dataUriImageCount: dataUriImgs.length,
      syntheticIconCount: syntheticIconNodes.length,
      syntheticIconHints: syntheticIconNodes.slice(0, 8).map((el) => {
        // Same SVGAnimatedString pitfall applies if el is an SVG.
        const classAttr = typeof el.className === 'string'
          ? el.className
          : (el.getAttribute && el.getAttribute('class')) || '';
        return String(
          (el.getAttribute && el.getAttribute('data-testid'))
          || classAttr
          || el.tagName
          || 'icon-node'
        ).slice(0, 64);
      }),
    };
  });
}

function evaluateApiStoryAlignment(step) {
  const issues = [];
  // Live-launch steps (plaidPhase:"launch") surface a SESSION-CREATION call
  // (e.g. POST /link/token/create or /session/token/create) — not a product
  // result. The narration legitimately describes the product (identity, auth,
  // etc.), but the launch step's panel shows token creation, so product-result
  // field alignment does not apply. The product RESULT panel lives on the
  // post-launch step. Skip alignment enforcement on launch steps (2026-05-29).
  if (String(step?.plaidPhase || '').toLowerCase() === 'launch') return issues;
  const endpoint = String(step?.apiResponse?.endpoint || '').toLowerCase();
  const responseBlob = JSON.stringify(step?.apiResponse?.response || {}).toLowerCase();
  const story = [
    step?.id,
    step?.label,
    step?.narration,
    step?.visualState,
    step?.description,
  ].filter(Boolean).join(' ').toLowerCase();
  if (!step?.apiResponse?.response) return issues;

  const checks = [
    {
      key: 'cashflowInsights',
      storyPattern: /\bcash[\s_-]?flow[\s_-]?insights|cashflow_insights|cash.?flow attributes\b/i,
      endpointPattern: /cashflow[_\s-]?insights/,
      responseHints: ['attributes', 'report_id', 'generated_time', 'income_volatility', 'nsf', 'discretionary', 'essential', 'loan_payment'],
      label: 'cash-flow-insights context',
    },
    {
      key: 'checkReportCreate',
      storyPattern: /\breport ready|user_check_report_ready|check_report\/create|report_id\b/i,
      endpointPattern: /check_report\/create/,
      responseHints: ['report_id', 'status', 'ready', 'webhook'],
      label: 'check-report-create context',
    },
    {
      key: 'income',
      // Avoid bare `\bincome` — it false-positives on cash-flow attribute names like income_volatility_low.
      storyPattern: /\b(cra income insights|income insights|income_insights|payroll income|bank income)\b|\/credit\/bank_income\b/i,
      endpointPattern: /income[_\s-]?insights/,
      responseHints: ['income', 'income_stream', 'predicted_next_payment', 'historical_average_monthly_income', 'forecasted_average_monthly_income'],
      label: 'income-insights context',
    },
    {
      key: 'lendScore',
      storyPattern: /\blendscore|lend[\s_-]?score|scores\.lend_score|12-month default|reason_codes|pcs\d{4}\b/i,
      endpointPattern: /lend[_\s-]?score/,
      responseHints: ['lend_score', 'reason_codes', 'score_range', 'model_status', 'decision_hint'],
      label: 'lend-score context',
    },
    {
      key: 'networkInsights',
      storyPattern: /\bnetwork insights|network_insights|network_attributes|plaid_conn_user_/i,
      endpointPattern: /network[_\s-]?insights/,
      responseHints: ['network_attributes', 'network_insight', 'items', 'report_id'],
      label: 'network-insights context',
    },
    {
      key: 'baseReport',
      // Removed "ownership" — it is also a core Identity Match term and was
      // producing false positives on non-CRA demos (see audit 2026-04-18).
      // Require an explicit CRA/base-report phrase for the story match.
      // Exclude LendScore-only beats: "days available" beside lend_score/get is common.
      storyPattern: /\bbase report|cra base report|consumer report|inflows|outflows|net income\b/i,
      endpointPattern: /base[_\s-]?report/,
      responseHints: ['accounts', 'balances', 'ownership', 'inflows', 'outflows', 'days_available'],
      label: 'base-report context',
    },
    {
      key: 'signal',
      storyPattern: /\bsignal|ach|return risk|fraud|risk score\b/i,
      // `/transfer/authorization/create` runs Signal INTERNALLY — the verdict
      // surfaces as `authorization.decision` + `decision_rationale.code`, not
      // as raw Signal scores. So the endpoint counts as a valid Signal carrier
      // when the narration anchors to Signal. (Verified via Plaid AskBill,
      // 2026-05-26 — see inputs/products/plaid-transfer.md "Pattern A vs B".)
      endpointPattern: /signal|\/transfer\/authorization\/create/,
      // Either Signal scores OR an authorization decision satisfies the
      // "Signal risk context" story. `decision` + `decision_rationale`
      // collectively communicate the Signal verdict on the Transfer path.
      responseHints: ['score', 'risk', 'decision', 'decision_rationale', 'recommendation', 'reason', 'authorization'],
      label: 'signal risk context',
    },
    {
      key: 'identity',
      storyPattern: /\bidentity|match|verification|pass threshold|happy path\b/i,
      endpointPattern: /identity|match|verification/,
      responseHints: ['score', 'status', 'match', 'confidence', 'classification'],
      label: 'identity context',
    },
    {
      // Connection-repair / Link update mode (item_login_required recovery).
      // Listed BEFORE 'auth' so a re-authentication / reconnect story matches
      // here instead of false-matching the auth-rails context (the word
      // "re-authenticate" otherwise tripped the auth pattern).
      key: 'updateMode',
      storyPattern: /update[\s_-]?mode|item_login_required|login_repaired|re-?auth\w*|reconnect|repair (?:the )?connection|relink/i,
      endpointPattern: /reset_login|login_repaired|item_login_required|update[\s_-]?mode/i,
      responseHints: ['link_token', 'expiration', 'reset_login', 'login_repaired', 'item_login_required', 'item_id', 'request_id', 'access_token'],
      label: 'update-mode / connection-repair context',
    },
    {
      key: 'auth',
      // Word-boundary the tokens so "authenticate"/"authentication"/"authorize"
      // don't false-match the auth-rails context (e.g. on a re-auth beat).
      storyPattern: /\bauth\b|\brouting\b|\baccount number\b|\bach rails\b|\bwire routing\b|\bdepository\b/i,
      endpointPattern: /\/auth\/get\b/,
      responseHints: ['numbers', 'ach', 'routing', 'account', 'mask', 'subtype'],
      label: 'auth rails context',
    },
    {
      key: 'liabilities',
      storyPattern: /\bliabilit|mortgage|apr|loan|debt|payoff|principal|interest|due date\b/i,
      endpointPattern: /\/liabilities\/get\b/,
      responseHints: ['liabilities', 'mortgage', 'student', 'credit', 'apr', 'current_balance', 'last_payment_amount', 'origination_principal_amount'],
      label: 'liabilities context',
    },
    {
      key: 'transactions',
      storyPattern: /\btransaction|merchant|category|spend|purchase|sync|cash ?flow\b/i,
      endpointPattern: /\/transactions\/(sync|get)\b/,
      responseHints: ['added', 'modified', 'removed', 'transactions', 'merchant_name', 'personal_finance_category', 'category', 'amount', 'date', 'name'],
      label: 'transactions context',
    },
    {
      key: 'investments',
      storyPattern: /\binvestment|holding|ticker|portfolio|securit|allocation|brokerage\b/i,
      endpointPattern: /\/investments\/(holdings|transactions)\/get\b/,
      responseHints: ['holdings', 'securities', 'security_id', 'ticker_symbol', 'quantity', 'institution_value', 'institution_price', 'cost_basis', 'iso_currency_code'],
      label: 'investments holdings context',
    },
  ];

  const endpointCheck = checks.find((c) => c.endpointPattern.test(endpoint));
  if (endpointCheck) {
    // Endpoint is authoritative to avoid cross-context false positives from broad narration keywords.
    const hasAnyHint = endpointCheck.responseHints.some((hint) => responseBlob.includes(hint));
    if (!hasAnyHint) {
      issues.push(`Response JSON missing expected fields for ${endpointCheck.label}.`);
    }
    return issues;
  }

  // If no known Plaid endpoint matched, do NOT run the story-based fallback on
  // host-custom aggregator endpoints (e.g., /banner/ach-plan/decision,
  // /partner/*, /shell/*). The story regex can otherwise false-positive on
  // overlapping vocabulary (e.g., "ownership" appearing in Identity Match
  // narration while the endpoint is a host decision summary).
  const PLAID_ENDPOINT = /\/(auth|identity|signal|liabilities|transactions|income|assets|transfer|link|item|processor|cra|investments|user|categories|payment|sandbox|webhook|institutions|accounts|holdings|statements|consumer_report)\b/;
  if (endpoint && !PLAID_ENDPOINT.test(endpoint)) {
    return issues;
  }

  const storyCheck = checks.find((c) => c.storyPattern.test(story));
  if (storyCheck) {
    if (!storyCheck.endpointPattern.test(endpoint)) {
      issues.push(`Endpoint does not match ${storyCheck.label}.`);
    }
    const hasAnyHint = storyCheck.responseHints.some((hint) => responseBlob.includes(hint));
    if (!hasAnyHint) {
      issues.push(`Response JSON missing expected fields for ${storyCheck.label}.`);
    }
  }
  return issues;
}

async function evaluateResponsiveState(page, stepId) {
  return page.evaluate((id) => {
    if (id && typeof window.goToStep === 'function') window.goToStep(id);
    const active = document.querySelector('.step.active');
    const activeRect = active ? active.getBoundingClientRect() : null;
    const bankLogo = document.querySelector('[data-testid="host-bank-logo-img"], [data-testid="host-bank-icon-img"]');
    const bankLogoShell = document.querySelector('[data-testid="host-bank-logo-shell"]');
    const logoStyle = bankLogo ? window.getComputedStyle(bankLogo) : null;
    const logoRect = bankLogo ? bankLogo.getBoundingClientRect() : null;
    const shellStyle = bankLogoShell ? window.getComputedStyle(bankLogoShell) : null;
    const shellRect = bankLogoShell ? bankLogoShell.getBoundingClientRect() : null;
    const logoVisible = !!(bankLogo && logoStyle && logoRect &&
      logoStyle.display !== 'none' && logoStyle.visibility !== 'hidden' &&
      Number(logoStyle.opacity || '1') > 0 && logoRect.width > 0 && logoRect.height > 0);
    const logoShellVisible = !!(bankLogoShell && shellStyle && shellRect &&
      shellStyle.display !== 'none' && shellStyle.visibility !== 'hidden' &&
      Number(shellStyle.opacity || '1') > 0 && shellRect.width > 0 && shellRect.height > 0);
    const logoLoaded = !!(bankLogo && (bankLogo.tagName !== 'IMG' || (bankLogo.complete && bankLogo.naturalWidth > 0)));
    const navEl = document.querySelector('header, nav, [data-testid="top-nav"], [data-testid="host-nav"]');
    const navStyle = navEl ? window.getComputedStyle(navEl) : null;
    const parseRgb = (v) => {
      const m = String(v || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : null;
    };
    const rgb = parseRgb(navStyle?.backgroundColor || '');
    const luminance = rgb ? ((0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255) : null;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      activeStepExists: Boolean(active),
      activeRect: activeRect ? {
        left: activeRect.left,
        right: activeRect.right,
        top: activeRect.top,
        bottom: activeRect.bottom,
        width: activeRect.width,
        height: activeRect.height,
      } : null,
      logoPresent: Boolean(bankLogo),
      logoVisible,
      logoLoaded,
      // A full-bleed slide step intentionally hides the host nav (and its
      // logo) — don't treat a hidden host logo on a slide as "missing".
      activeIsSlide: !!(active && active.querySelector('.slide-root')),
      logoSrc: bankLogo?.getAttribute('src') || '',
      logoWidth: logoRect ? logoRect.width : 0,
      logoHeight: logoRect ? logoRect.height : 0,
      navBgLuminance: luminance,
      logoShellPresent: Boolean(bankLogoShell),
      logoShellVisible,
    };
  }, stepId);
}

async function runResponsiveChecks(page, demoScript) {
  const diagnostics = [];
  const firstStepId = (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || null;
  const assetAuth = await evaluateAssetAuthenticity(page);
  if (assetAuth.logoTag && assetAuth.logoTag !== 'IMG') {
    diagnostics.push({
      stepId: firstStepId || 'build',
      category: 'asset-authenticity',
      severity: 'critical',
      issue: `Host logo element is ${assetAuth.logoTag}, not IMG.`,
      suggestion: 'Use a real logo image from a trusted brand/logo library source (no generated vector/text logos).',
    });
  }
  if (assetAuth.logoSrc && /^(data:|blob:)/i.test(assetAuth.logoSrc)) {
    diagnostics.push({
      stepId: firstStepId || 'build',
      category: 'asset-authenticity',
      severity: 'critical',
      issue: 'Host logo uses data/blob URL instead of a real hosted brand asset.',
      suggestion: 'Use a real hosted logo asset (e.g., brand library/CDN), not generated inline/base64 logo content.',
    });
  }
  if (assetAuth.shellInlineSvg || assetAuth.shellLooksLikeTextLogo) {
    diagnostics.push({
      stepId: firstStepId || 'build',
      category: 'asset-authenticity',
      severity: 'critical',
      issue: 'Host logo shell appears to contain generated/fake logo graphics (inline SVG or short text mark).',
      suggestion: 'Do not generate logos. Use only real brand logo assets from the logo library.',
    });
  }
  if (assetAuth.nonPanelInlineSvgCount > 0) {
    diagnostics.push({
      stepId: firstStepId || 'build',
      category: 'asset-authenticity',
      severity: 'warning',
      issue: `Inline SVG icons detected in app UI (${assetAuth.nonPanelInlineSvgHints.join(', ')}).`,
      suggestion: 'Use approved icon-library assets only; inline SVG is acceptable when copied verbatim from that library.',
    });
  }
  if (assetAuth.syntheticIconCount > 0) {
    diagnostics.push({
      stepId: firstStepId || 'build',
      category: 'asset-authenticity',
      severity: 'critical',
      issue: `Synthetic icon placeholders detected (${assetAuth.syntheticIconHints.join(', ')}).`,
      suggestion: 'Replace synthetic/handmade icon placeholders with real icon library assets.',
    });
  }
  if (assetAuth.dataUriImageCount > 0) {
    diagnostics.push({
      stepId: firstStepId || 'build',
      category: 'asset-authenticity',
      severity: 'warning',
      issue: `Data-URI images detected (${assetAuth.dataUriImageCount}).`,
      suggestion: 'Prefer real hosted logo/icon assets from approved libraries over generated embedded images.',
    });
  }

  for (const vp of RESPONSIVE_DESKTOP_VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(120);
    const state = await evaluateResponsiveState(page, firstStepId);
    const overflowsX = state.scrollWidth > state.viewport.width + 2;
    if (overflowsX) {
      diagnostics.push({
        stepId: firstStepId || 'build',
        category: 'responsive-layout',
        severity: 'critical',
        issue: `Horizontal overflow at ${vp.label} (scrollWidth=${state.scrollWidth}, viewportWidth=${state.viewport.width}).`,
        suggestion: 'Use fluid desktop layout and avoid fixed-width wrappers that exceed viewport width.',
      });
    }
    if (state.activeRect && (state.activeRect.left < -2 || state.activeRect.right > state.viewport.width + 2)) {
      diagnostics.push({
        stepId: firstStepId || 'build',
        category: 'responsive-layout',
        severity: 'critical',
        issue: `Active step is clipped at ${vp.label} (left=${Math.round(state.activeRect.left)}, right=${Math.round(state.activeRect.right)}).`,
        suggestion: 'Ensure step containers and primary cards fit inside desktop viewports 1280–1728px without clipping.',
      });
    }
    if (state.activeIsSlide) {
      // Host nav (and its logo) is intentionally hidden on full-bleed slide
      // steps — skip the host-logo presence/visibility checks here.
    } else if (!state.logoPresent || !state.logoVisible || !state.logoLoaded) {
      diagnostics.push({
        stepId: firstStepId || 'build',
        category: 'missing-logo',
        severity: 'critical',
        issue: `Host logo is missing or not visible at ${vp.label} (present=${state.logoPresent}, visible=${state.logoVisible}, loaded=${state.logoLoaded}).`,
        suggestion: 'Render a visible host brand image in nav and ensure the image URL loads successfully.',
      });
    } else if (!state.logoShellPresent || !state.logoShellVisible) {
      diagnostics.push({
        stepId: firstStepId || 'build',
        category: 'missing-logo',
        severity: 'warning',
        issue: `Host logo shell/container is missing at ${vp.label}; transparent/light logos may be illegible on some backgrounds.`,
        suggestion: 'Wrap host logo image in a visible pill/container (e.g., data-testid="host-bank-logo-shell") with subtle background and border.',
      });
    } else {
      const logoSrc = String(state.logoSrc || '');
      if (
        state.logoPresent &&
        state.logoVisible &&
        isLogoNavLuminanceCollision({
          logoSrc,
          navBgLuminance: state.navBgLuminance,
        })
      ) {
        diagnostics.push({
          stepId: firstStepId || 'build',
          category: 'host-logo-contrast',
          severity: 'critical',
          deterministicBlocker: true,
          issue: collisionIssueText({
            logoSrc,
            navBgLuminance: state.navBgLuminance,
            viewportLabel: vp.label,
          }),
          suggestion:
            'Apply host-nav-logo-contrast patch via `npm run pipe -- app-touchup` — white banner, accent border, dark wordmark URL.',
        });
      }
      if (state.logoWidth > 0 && state.logoHeight > 0 && state.logoWidth < 48) {
        diagnostics.push({
          stepId: firstStepId || 'build',
          category: 'missing-logo',
          severity: 'warning',
          issue: `Logo appears too small at ${vp.label} (width=${Math.round(state.logoWidth)}px).`,
          suggestion: 'Increase rendered logo width or use a full wordmark variant instead of icon-only mark.',
        });
      }
    }
  }
  return diagnostics;
}

async function runMobileVisualChecks(page, demoScript) {
  const diagnostics = [];
  const firstStepId = (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build';
  const shellPresent = await page.evaluate(() => {
    const shellNode = document.querySelector('[data-testid="mobile-simulator-shell"]');
    const runtimeToggle = document.querySelector('[data-testid="mobile-view-toggle"], #mobile-view-toggle');
    const runtimeApi = typeof window.setDemoViewMode === 'function';
    return Boolean(shellNode || runtimeToggle || runtimeApi);
  });
  if (!shellPresent) {
    diagnostics.push({
      stepId: firstStepId,
      category: 'mobile-visual-contract',
      severity: 'warning',
      issue: 'Mobile visual mode enabled but no simulator shell or runtime view toggle was found.',
      suggestion: 'Provide either [data-testid="mobile-simulator-shell"] or a runtime toggle API/button (setDemoViewMode/mobile-view-toggle).',
    });
  }
  for (const vp of MOBILE_VISUAL_VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(150);
    const snapshot = await page.evaluate(() => {
      const active = document.querySelector('.step.active');
      if (!active) return { activeExists: false };
      const rect = active.getBoundingClientRect();
      return {
        activeExists: true,
        scrollW: document.documentElement.scrollWidth,
        vw: window.innerWidth,
        rectLeft: rect.left,
        rectRight: rect.right,
      };
    });
    if (!snapshot.activeExists) continue;
    if ((snapshot.scrollW || 0) > (snapshot.vw || 0) + 4) {
      diagnostics.push({
        stepId: firstStepId,
        category: 'mobile-visual-overflow',
        severity: 'warning',
        issue: `Mobile visual overflow at ${vp.label} (scrollWidth=${snapshot.scrollW}, viewportWidth=${snapshot.vw}).`,
        suggestion: 'Constrain mobile-simulated layout width and avoid fixed desktop containers in mobile visual mode.',
      });
    }
    if ((snapshot.rectLeft || 0) < -2 || (snapshot.rectRight || 0) > (snapshot.vw || 0) + 2) {
      diagnostics.push({
        stepId: firstStepId,
        category: 'mobile-visual-overflow',
        severity: 'warning',
        issue: `Active step is partially clipped at ${vp.label}.`,
        suggestion: 'Ensure mobile-simulated container is centered and fully visible in narrow viewport checks.',
      });
    }
  }
  return diagnostics;
}

async function runMobilePlaidLaunchCheck(page, demoScript, pageErrors) {
  const diagnostics = [];
  const launchStep = (demoScript.steps || []).find((s) => s && s.plaidPhase === 'launch');
  if (!launchStep) return diagnostics;
  const launchId = launchStep.id;
  const plaidLinkMode = String(demoScript?.plaidLinkMode || '').toLowerCase() === 'embedded' ? 'embedded' : 'modal';
  try {
    await page.evaluate((id) => {
      if (typeof window.setDemoViewMode === 'function') window.setDemoViewMode('mobile-simulated');
      if (typeof window.goToStep === 'function') window.goToStep(id);
    }, launchId);
    await page.waitForTimeout(250);
  } catch (err) {
    diagnostics.push({
      stepId: launchId,
      category: 'plaid-link-mobile-launch',
      severity: 'critical',
      issue: `Could not prepare mobile-simulated Plaid launch step: ${err.message}`,
      suggestion: 'Ensure runtime view toggle and goToStep are initialized before mobile Plaid launch QA.',
    });
    return diagnostics;
  }

  try {
    const beforeErrors = pageErrors.length;
    if (plaidLinkMode === 'embedded') {
      await page.waitForTimeout(900);
    } else {
      const launchBtn = '[data-testid="link-external-account-btn"]';
      const loc = await locateVisible(page, launchBtn);
      await loc.click({ timeout: 8000, force: true });
      await page.waitForTimeout(900);
    }
    const launchState = await page.evaluate(() => ({
      hasHandler: Boolean(window._plaidHandler),
      embeddedWidgetLoaded: Boolean(window.__embeddedLinkWidgetLoaded),
      embeddedInstanceReady: Boolean(window.__plaidEmbeddedInstance),
    }));
    if (plaidLinkMode === 'embedded') {
      if (!launchState.embeddedWidgetLoaded && !launchState.embeddedInstanceReady) {
        diagnostics.push({
          stepId: launchId,
          category: 'plaid-link-mobile-launch',
          severity: 'critical',
          issue: 'Embedded Link widget did not load in mobile-simulated view.',
          suggestion: 'Ensure embedded mode mounts Plaid.createEmbedded into the in-page container when the launch step is active.',
        });
      }
    } else if (!launchState.hasHandler) {
      diagnostics.push({
        stepId: launchId,
        category: 'plaid-link-mobile-launch',
        severity: 'critical',
        issue: 'Plaid handler is not initialized when launching modal Link from mobile-simulated view.',
        suggestion: 'Ensure click bindings and Plaid token bootstrap complete before launch on mobile-simulated steps.',
      });
    }
    const newErrors = pageErrors.slice(beforeErrors);
    const bindError = newErrors.find((e) => /Cannot read properties of null \(reading 'addEventListener'\)/i.test(String(e || '')));
    if (bindError) {
      diagnostics.push({
        stepId: launchId,
        category: 'plaid-link-mobile-launch',
        severity: 'critical',
        issue: `Runtime JS binding error during mobile launch: ${bindError}`,
        suggestion: 'Guard addEventListener bindings against missing nodes and normalize testid selector drift.',
      });
    }
  } catch (err) {
    diagnostics.push({
      stepId: launchId,
      category: 'plaid-link-mobile-launch',
      severity: 'critical',
      issue:
        plaidLinkMode === 'embedded'
          ? `Could not validate embedded launch state in mobile-simulated mode: ${err.message}`
          : `Could not click mobile Plaid launch button "[data-testid=\\"link-external-account-btn\\"]": ${err.message}`,
      suggestion:
        plaidLinkMode === 'embedded'
          ? 'Ensure the embedded container is rendered and widget bootstrap runs when the launch step becomes active.'
          : 'Ensure the launch CTA exists and remains visible in mobile-simulated mode.',
    });
  }
  return diagnostics;
}

async function runEmbeddedLaunchSelectorDriftCheck(page, demoScript) {
  const diagnostics = [];
  const isEmbedded = String(demoScript?.plaidLinkMode || '').toLowerCase() === 'embedded';
  if (!isEmbedded) return diagnostics;
  const launchStep = (demoScript.steps || []).find((s) => s && s.plaidPhase === 'launch');
  if (!launchStep?.id) return diagnostics;

  const state = await page.evaluate((launchId) => {
    const result = { launchContainsContainer: false, canonicalSteps: [] };
    const steps = Array.from(document.querySelectorAll('.step[data-testid]'));
    for (const step of steps) {
      const testid = String(step.getAttribute('data-testid') || '');
      const sid = testid.replace(/^step-/, '');
      const hasCanonical = !!step.querySelector('[data-testid="link-external-account-btn"]');
      if (hasCanonical) result.canonicalSteps.push(sid);
      if (sid === launchId) {
        result.launchContainsContainer = !!step.querySelector('[data-testid="plaid-embedded-link-container"], #plaid-embedded-link-container');
      }
    }
    return result;
  }, launchStep.id);

  if (!state.launchContainsContainer) {
    diagnostics.push({
      stepId: launchStep.id,
      category: 'plaid-embedded-launch-selector-drift',
      severity: 'critical',
      issue: 'Embedded launch container is missing from the plaidPhase:"launch" step.',
      suggestion: 'Ensure data-testid="plaid-embedded-link-container" is present in the launch step for embedded mode.',
    });
  }
  if (Array.isArray(state.canonicalSteps) && state.canonicalSteps.length > 0) {
    diagnostics.push({
      stepId: launchStep.id,
      category: 'plaid-embedded-launch-selector-drift',
      severity: 'critical',
      issue: `Embedded mode found disallowed launch CTA selector data-testid="link-external-account-btn" on step(s): ${state.canonicalSteps.join(', ')}.`,
      suggestion: 'Remove Link/Connect launch CTA buttons in embedded mode and start launch from the embedded container activation.',
    });
  }
  return diagnostics;
}

function toFinite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildSyncHealthReport({
  demoScript,
  qaReport,
  diagnostics,
  timingContract,
  narrationSyncReport,
  voiceoverManifest,
  syncTimelineRows,
}) {
  const qaByStep = new Map((qaReport?.steps || []).map((s) => [String(s.stepId || ''), s]));
  const diagByStep = new Map();
  for (const d of diagnostics || []) {
    const sid = String(d?.stepId || '').trim();
    if (!sid) continue;
    const arr = diagByStep.get(sid) || [];
    arr.push(d);
    diagByStep.set(sid, arr);
  }
  const timingByStep = new Map();
  for (const row of timingContract?.steps || []) {
    const sid = String(row?.stepId || '').trim();
    if (!sid) continue;
    const arr = timingByStep.get(sid) || [];
    arr.push(row);
    timingByStep.set(sid, arr);
  }
  const timelineByStep = new Map();
  for (const row of syncTimelineRows || []) {
    const sid = String(row?.stepId || '').trim();
    if (!sid) continue;
    const arr = timelineByStep.get(sid) || [];
    arr.push(row);
    timelineByStep.set(sid, arr);
  }
  const syncViolationsByStep = new Map();
  for (const v of narrationSyncReport?.violations || []) {
    const sid = String(v?.stepId || '').trim();
    if (!sid) continue;
    const arr = syncViolationsByStep.get(sid) || [];
    arr.push(v);
    syncViolationsByStep.set(sid, arr);
  }

  const stepHealth = (demoScript?.steps || []).map((step, idx) => {
    const sid = String(step?.id || '').trim();
    const qa = qaByStep.get(sid) || null;
    const stepDiags = diagByStep.get(sid) || [];
    const timingRows = timingByStep.get(sid) || [];
    const timelineRows = timelineByStep.get(sid) || [];
    const syncViolations = syncViolationsByStep.get(sid) || [];
    const hasCriticalDiag = stepDiags.some((d) => d.severity === 'critical');
    const hasOverrun = timingRows.some((r) => String(r.status || '') === 'overrun');
    const inWindow = timelineRows.length === 0 ? null : timelineRows.some((r) => r.inOwnWindow === true);
    const clipLeadMs = timelineRows.length > 0 && Number.isFinite(Number(timelineRows[0].leadMs))
      ? Number(timelineRows[0].leadMs)
      : null;
    return {
      stepId: sid,
      index: idx,
      label: step?.label || '',
      qaScore: qa ? Number(qa.score || 0) : null,
      qaCritical: qa ? !!qa.critical : false,
      qaIssues: qa?.issues || [],
      timingStatus: hasOverrun ? 'overrun' : (timingRows.length > 0 ? 'ok' : 'unknown'),
      clipInWindow: inWindow,
      clipLeadMs,
      clipRows: timelineRows,
      syncViolationCodes: syncViolations.map((v) => v.code),
      diagnosticsCategories: [...new Set(stepDiags.map((d) => d.category).filter(Boolean))],
      pass: Boolean(qa && qa.score >= (qaReport?.passThreshold || 80) && !qa.critical && !hasCriticalDiag && !hasOverrun && syncViolations.length === 0),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    sources: {
      qaReport: 'qa-report-build.json',
      diagnostics: 'build-qa-diagnostics.json',
      timingContract: timingContract ? 'timing-contract.json' : null,
      narrationSyncValidation: narrationSyncReport ? 'narration-sync-validation.json' : null,
      voiceoverManifest: voiceoverManifest ? 'voiceover-manifest.json' : null,
    },
    summary: {
      totalSteps: stepHealth.length,
      passedSteps: stepHealth.filter((s) => s.pass).length,
      failedSteps: stepHealth.filter((s) => !s.pass).length,
      qaOverallScore: Number(qaReport?.overallScore || 0),
      qaPassed: !!qaReport?.passed,
      narrationSyncOk: !!narrationSyncReport?.ok,
      narrationViolationCount: (narrationSyncReport?.violations || []).length,
      narrationWarningCount: (narrationSyncReport?.warnings || []).length,
      timingContractGeneratedAt: timingContract?.generatedAt || null,
      voiceoverManifestResyncedAt: voiceoverManifest?.resyncedAt || null,
    },
    narrationSyncSummary: narrationSyncReport?.summary || null,
    stepHealth,
  };
}

function inferQaPhase(diag) {
  const c = String(diag?.category || '').toLowerCase();
  if (/selector-missing|navigation-mismatch|responsive-layout|mobile-visual|duplicate-bank-mark|missing-logo|timing-duplicate-step-window|timing-coverage-gap/.test(c)) {
    return 'framework';
  }
  if (/api-story-alignment|panel-|missing-panel|plaid-link|action-failure|runtime-js-error|narration-screen-mismatch|narration-overrun|sync-governor|cross-screen-owner/.test(c)) {
    return 'data-interaction';
  }
  return 'visual-polish';
}

function isDeterministicBlocker(diag) {
  if (!diag || typeof diag !== 'object') return false;
  if (diag.deterministicBlocker === true) return true;
  if (diag.severity !== 'critical') return false;
  const category = String(diag.category || '').trim();
  if (!category) return false;
  if (CURRENT_BUILD_QA_STEP_SCOPE === 'slides' && category === 'navigation-mismatch') return false;
  if (DETERMINISTIC_BLOCKER_CATEGORIES.has(category)) return true;
  if (category.startsWith('sync-governor-') && category !== 'sync-governor-warning') return true;
  return false;
}

function parseJsonFromText(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
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

function normalizeResponseLinkMode(json) {
  const mode = String(
    (json && (json.plaid_link_mode || json.link_mode || json.linkMode)) || ''
  ).trim().toLowerCase();
  return mode === 'embedded' || mode === 'modal' ? mode : null;
}

async function collectSlideMessagingContext(page, demoScript) {
  const slides = (demoScript.steps || []).filter((step) => isSlideLikeStep(step));
  const rows = [];
  for (const step of slides) {
    try {
      await page.evaluate((id) => {
        if (typeof window.goToStep === 'function') window.goToStep(id);
      }, step.id);
      await page.waitForTimeout(120);
      const snap = await page.evaluate((id) => {
        const active = document.querySelector('.step.active');
        const target = document.querySelector(`[data-testid="step-${id}"]`);
        const text = (target?.innerText || active?.innerText || '').replace(/\s+/g, ' ').trim();
        return {
          hasSlideRoot: Boolean(target?.querySelector('.slide-root') || active?.querySelector('.slide-root')),
          renderedText: text.slice(0, 1800),
        };
      }, step.id);
      rows.push({
        stepId: step.id,
        label: step.label || '',
        narration: step.narration || '',
        visualState: step.visualState || '',
        renderedText: snap.renderedText || '',
        hasSlideRoot: !!snap.hasSlideRoot,
      });
    } catch (_) {
      rows.push({
        stepId: step.id,
        label: step.label || '',
        narration: step.narration || '',
        visualState: step.visualState || '',
        renderedText: '',
        hasSlideRoot: false,
      });
    }
  }
  return rows;
}

function buildSlideMessagingPrompt(demoScript, slideRows) {
  const persona = demoScript.persona || {};
  const lines = [];
  lines.push('You are enhancing business/value messaging for Plaid demo slides.');
  lines.push('Use concise, buyer-facing value language tied to the demo use case.');
  lines.push('Return JSON only.');
  lines.push('');
  lines.push('Required output schema:');
  lines.push('{');
  lines.push('  "slides": [');
  lines.push('    {');
  lines.push('      "stepId": "<slide step id>",');
  lines.push('      "additionalValueClaims": [');
  lines.push('        { "claim": "<string>", "whyItMatters": "<string>", "reference": "<source hint or rationale>" }');
  lines.push('      ]');
  lines.push('    }');
  lines.push('  ],');
  lines.push('  "globalSuggestions": ["<string>", "..."]');
  lines.push('}');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Return exactly one valid JSON object and nothing else.');
  lines.push('- Do not wrap JSON in markdown fences.');
  lines.push('- Add 2 to 4 additional value claims per slide.');
  lines.push('- Do not restate existing claims verbatim.');
  lines.push('- Keep claims specific, outcome-oriented, and plausible.');
  lines.push('- Avoid unsourced hard metrics unless clearly justified.');
  lines.push('');
  lines.push(`Demo product: ${demoScript.product || ''}`);
  lines.push(`Persona: ${persona.name || ''} | Company: ${persona.company || ''} | Use case: ${persona.useCase || ''}`);
  lines.push('');
  lines.push('Slide messaging context:');
  lines.push(JSON.stringify(slideRows, null, 2));
  return lines.join('\n');
}

async function evaluateSlideValueMessaging(page, demoScript) {
  const slides = (demoScript.steps || []).filter((step) => isSlideLikeStep(step));
  if (!slides.length) {
    return {
      artifact: { generatedAt: new Date().toISOString(), skipped: true, reason: 'No slide steps found.' },
      diagnostics: [],
    };
  }
  const slideRows = await collectSlideMessagingContext(page, demoScript);
  const prompt = buildSlideMessagingPrompt(demoScript, slideRows);
  const artifact = {
    generatedAt: new Date().toISOString(),
    slideCount: slides.length,
    input: slideRows,
    rawResponse: '',
    parsed: null,
    parseError: null,
  };
  const diagnostics = [];
  try {
    artifact.rawResponse = await gleanChat(prompt, { responseMode: 'json' });
    artifact.parsed = parseJsonFromText(artifact.rawResponse);
    if (!artifact.parsed) {
      const retryPrompt =
        `${prompt}\n\n` +
        'Retry now. Output must be valid JSON only with no extra text.';
      const retryRaw = await gleanChat(retryPrompt, { responseMode: 'json' });
      artifact.retryRawResponse = retryRaw;
      artifact.parsed = parseJsonFromText(retryRaw);
    }
    if (!artifact.parsed) {
      artifact.parseError = 'Could not parse JSON from gleanChat response (after strict retry)';
      diagnostics.push({
        stepId: slides[0].id,
        category: 'slide-value-messaging',
        severity: 'warning',
        issue: 'Glean slide messaging response was not valid JSON.',
        suggestion: 'Glean was asked for strict JSON and retried once. Inspect MCP response format or tighten schema fields.',
      });
      return { artifact, diagnostics };
    }
    const suggestionsByStep = Array.isArray(artifact.parsed.slides) ? artifact.parsed.slides : [];
    for (const row of suggestionsByStep) {
      const sid = row && row.stepId ? row.stepId : (slides[0] && slides[0].id) || 'slide';
      const claims = Array.isArray(row?.additionalValueClaims) ? row.additionalValueClaims.slice(0, 4) : [];
      for (const claim of claims) {
        const text = claim && claim.claim ? String(claim.claim).trim() : '';
        if (!text) continue;
        diagnostics.push({
          stepId: sid,
          category: 'slide-value-messaging',
          severity: 'warning',
          issue: `Suggested value-add claim: ${text}`,
          suggestion: claim?.whyItMatters
            ? `Why it matters: ${String(claim.whyItMatters).trim()}`
            : 'Apply this suggestion if it improves buyer-facing value clarity.',
        });
      }
    }
    const globals = Array.isArray(artifact.parsed.globalSuggestions) ? artifact.parsed.globalSuggestions.slice(0, 4) : [];
    for (const g of globals) {
      const text = String(g || '').trim();
      if (!text) continue;
      diagnostics.push({
        stepId: slides[0].id,
        category: 'slide-value-messaging',
        severity: 'warning',
        issue: `Global slide messaging suggestion: ${text}`,
        suggestion: 'Incorporate this guidance in slide copy refinement if aligned with the use case.',
      });
    }
  } catch (err) {
    artifact.parseError = `Glean pass failed: ${err.message}`;
    diagnostics.push({
      stepId: slides[0].id,
      category: 'slide-value-messaging',
      severity: 'warning',
      issue: `Non-blocking slide messaging pass failed: ${err.message}`,
      suggestion: 'Verify Glean MCP availability/credentials. Build QA remains valid without this pass.',
    });
  }
  return { artifact, diagnostics };
}

/**
 * Host Plaid Link launch CTA: flag oversized SVG (flex/layout bugs) or missing icon.
 * @param {object} step
 * @param {object} state  evaluateStepState result
 * @returns {Array<{stepId:string,category:string,severity:string,issue:string,suggestion:string}>}
 */
function buildPlaidLaunchCtaIconDiagnostics(step, state) {
  const diagnostics = [];
  if (!step || step.plaidPhase !== 'launch') return diagnostics;
  if (!state || !state.activeStepHasPlaidLinkLaunchBtn) return diagnostics;

  const m = state.plaidLaunchCtaMetrics;
  if (!m || m.buttonHeight <= 0) return diagnostics;

  if (m.svgCount === 0) {
    diagnostics.push({
      stepId: step.id,
      category: 'plaid-launch-cta-icon',
      severity: 'warning',
      issue: 'Plaid Link launch CTA has no SVG icon inside the button.',
      suggestion:
        'Ensure build-app injects the stock link icon for data-testid="link-external-account-btn", or add the canonical Heroicons outline link SVG at ~20px.',
    });
    return diagnostics;
  }

  if (m.iconMaxDim > 0) {
    const ratio = m.iconMaxDim / m.buttonHeight;
    if (ratio > PLAID_LAUNCH_ICON_MAX_RATIO) {
      diagnostics.push({
        stepId: step.id,
        category: 'plaid-launch-cta-icon',
        severity: PLAID_LAUNCH_ICON_STRICT ? 'critical' : 'warning',
        issue:
          `Plaid Link launch CTA icon is disproportionately large (icon max ${Math.round(m.iconMaxDim)}px vs button height ${Math.round(m.buttonHeight)}px, ratio ${ratio.toFixed(2)}; max allowed ${PLAID_LAUNCH_ICON_MAX_RATIO}).`,
        suggestion:
          'Keep the leading icon near text line-height (~18–24px). Avoid flex-grow on icon wrappers; rely on pipeline injectPlaidLaunchCtaLayoutStyles + stock-link-icon sizing in build-app.',
      });
    }
  }

  return diagnostics;
}

function buildEmbeddedLinkUxDiagnostics(step, state, demoScript) {
  const diagnostics = [];
  if (!step || step.plaidPhase !== 'launch') return diagnostics;
  const isEmbedded = String(demoScript?.plaidLinkMode || '').toLowerCase() === 'embedded';
  if (!isEmbedded) return diagnostics;

  if (!state?.embeddedContainerExists) {
    diagnostics.push({
      stepId: step.id,
      category: 'plaid-embedded-prelink-integrated',
      severity: 'critical',
      issue: 'Embedded Link launch step is missing the in-page embedded container.',
      suggestion: 'Include data-testid="plaid-embedded-link-container" in the launch step.',
    });
    return diagnostics;
  }

  const width = Number(state?.embeddedContainerWidth || 0);
  const height = Number(state?.embeddedContainerHeight || 0);

  // Updated embedded guidance: enforce only minimum recommended container sizing.
  const meetsMin = (width >= 350 && height >= 300) || (width >= 300 && height >= 350);
  if (!meetsMin) {
    diagnostics.push({
      stepId: step.id,
      category: 'plaid-embedded-size-profile',
      severity: 'critical',
      issue: `Embedded container is too small (${Math.round(width)}x${Math.round(height)}).`,
      suggestion: 'Use a minimum embedded container size of 350x300px or 300x350px.',
    });
  }

  if (state?.embeddedHostRecommendedDuplicate) {
    diagnostics.push({
      stepId: step.id,
      category: 'plaid-embedded-prelink-integrated',
      severity: 'critical',
      issue:
        'Host trust column duplicates the Plaid SDK "Recommended · Instant verification" tile. ' +
        'The live embed owns that recommendation — remove the host-side Recommended card.',
      suggestion:
        'Keep headline, encryption bullets, and consent in the trust column only. ' +
        'Let Plaid Embedded Institution Search render the Recommended path.',
    });
  }

  if (state?.embeddedFakeInstitutionSearch) {
    diagnostics.push({
      stepId: step.id,
      category: 'plaid-embedded-prelink-integrated',
      severity: 'critical',
      issue:
        'Launch step renders a fake institution-search input outside the live embedded container.',
      suggestion:
        'Remove mock search bars/preview tiles. Mount Plaid.createEmbedded into ' +
        'data-testid="plaid-embedded-link-container" on this same step.',
    });
  }

  return diagnostics;
}

async function ensureApiPanelContractForStep(page, stepId) {
  return page.evaluate((id) => {
    const panel = document.getElementById('api-response-panel');
    if (!panel) return;
    // v12: .code-wrap + .code panes. Legacy: .side-panel-body + #api-response-content.
    const body = panel.querySelector('.code-wrap') || panel.querySelector('.side-panel-body');
    if (!body) return;
    const responses = window._stepApiResponses || {};
    const data = responses[id];
    if (!data) return;
    // Prefer the wrapped { endpoint, request, response } shape; fall back to
    // legacy { endpoint, data } and to flat response data.
    const isWrapped = data && typeof data === 'object' && ('request' in data || 'response' in data);
    const reqData = isWrapped ? data.request : null;
    const resData = isWrapped
      ? data.response
      : (data && data.data != null ? data.data : data);
    const paneReq = document.getElementById('api-pane-request');
    const paneRes = document.getElementById('api-pane-response');
    function hydrate(target, payload) {
      if (!target || payload == null) return;
      if ((target.textContent || '').trim().length >= 12) return;
      try {
        if (window.renderjson) target.appendChild(window.renderjson(payload));
        else target.textContent = JSON.stringify(payload, null, 2);
      } catch (_) {
        target.textContent = JSON.stringify(payload, null, 2);
      }
    }
    if (paneReq || paneRes) {
      hydrate(paneReq, reqData);
      hydrate(paneRes, resData);
    } else {
      const content = document.getElementById('api-response-content');
      if (content && !(content.textContent || '').trim()) {
        try {
          const pretty = JSON.stringify(resData, null, 2);
          if (typeof window.syntaxHighlight === 'function') content.innerHTML = window.syntaxHighlight(pretty);
          else content.textContent = pretty;
        } catch (_) {}
      }
    }
    // Intentionally do NOT mutate panel visibility/collapse state here.
    // Use prepareGlobalJsonRailForBuildQa() before screenshots when apiResponse is present.
  }, stepId);
}

/** demo-script steps that ship apiResponse (excluding value-summary) must show the global JSON rail in build-QA frames. */
function isDemoValueSummaryStep(step) {
  const id = String(step?.id || '').toLowerCase();
  const label = String(step?.label || '').toLowerCase();
  return id === 'value-summary-slide' || /\bvalue summary\b/.test(label);
}

function stepRequiresGlobalJsonRail(step) {
  if (!step || isDemoValueSummaryStep(step)) return false;
  const r = step.apiResponse?.response;
  if (r == null || typeof r !== 'object' || Array.isArray(r)) return false;
  return Object.keys(r).length > 0;
}

const MIN_JSON_PANEL_CHARS = 12;

/**
 * Ensure the canonical #api-response-panel is visible with JSON body expanded so
 * build-QA screenshots and vision QA match the pipeline slide-shell contract.
 */
async function prepareGlobalJsonRailForBuildQa(page, stepId) {
  await ensureApiPanelContractForStep(page, stepId);
  await page.evaluate((id) => {
    const data = (window._stepApiResponses && window._stepApiResponses[id]) || null;
    const panel = document.getElementById('api-response-panel');
    if (!panel) return;
    // Drive the v12 renderer first (populateApiPanel handles both wrapped
    // and legacy data shapes), then fall back to the legacy updateApiResponse.
    if (data) {
      try {
        const endpoint = data.endpoint || '';
        const payload = (data && typeof data === 'object' && ('request' in data || 'response' in data))
          ? { request: data.request, response: data.response }
          : (data.data != null ? data.data : data);
        if (typeof window.populateApiPanel === 'function') window.populateApiPanel(endpoint, payload);
        else if (typeof window.updateApiResponse === 'function') window.updateApiResponse(data);
      } catch (_) { /* ignore */ }
    }
    panel.style.removeProperty('display');
    panel.style.display = 'flex';
    panel.classList.add('visible');
    panel.classList.remove('api-json-collapsed');
    panel.classList.remove('api-panel-collapsed');
    panel.classList.remove('is-collapsed');  // v12 collapsed state
    // v12 .code-wrap / legacy .side-panel-body — make sure body is visible.
    const codeWrap = panel.querySelector('.code-wrap');
    const legacyBody = panel.querySelector('.side-panel-body');
    if (codeWrap) {
      codeWrap.style.removeProperty('display');
      codeWrap.style.display = 'block';
    }
    if (legacyBody) {
      legacyBody.style.removeProperty('display');
      legacyBody.style.display = 'block';
    }
  }, stepId);
}

function buildStepAssertions(step, state, demoScript, opts = {}) {
  const isAppOnlyRun = !!opts.isAppOnlyRun;
  const diagnostics = [];
  const expectedStepTestid = `step-${step.id}`;
  const isValueSummarySlide = String(step?.id || '').toLowerCase() === 'value-summary-slide';
  const expectsJsonPanel = stepRequiresGlobalJsonRail(step);
  const stepHay = [step?.id, step?.label, step?.visualState, step?.narration].filter(Boolean).join(' ').toLowerCase();
  const stepIdLower = String(step?.id || '').toLowerCase();
  // Only true host phone screen — do not match "layer-eligible-flow" (contains "eligib" inside "eligible").
  const isLayerEligibilityCapture = stepIdLower === 'eligibility-capture';
  // Helper line is for mobile Layer host moments only — not slides whose narration mentions "Layer".
  const needsLayerHelperAudit =
    stepIdLower === 'eligibility-capture' ||
    stepIdLower === 'layer-eligible-flow' ||
    stepIdLower === 'onboarding-complete';
  const hasEndpoint = Boolean(String(step?.apiResponse?.endpoint || '').trim());
  const hasApiResponse = !!(step?.apiResponse?.response && typeof step.apiResponse.response === 'object');
  diagnostics.push(...buildEmbeddedLinkUxDiagnostics(step, state, demoScript));
  if (!state.stepExists || !state.stepVisible || state.activeStepTestid !== expectedStepTestid) {
    diagnostics.push({
      stepId: step.id,
      category: 'navigation-mismatch',
      severity: 'critical',
      issue: `Expected active step "${expectedStepTestid}" but got "${state.activeStepTestid || state.currentStep || 'none'}".`,
      suggestion: 'Fix goToStep wiring and the playwright step order so the expected step is active before capture.',
    });
  }
  if (state.linkPanelVisible) {
    diagnostics.push({
      stepId: step.id,
      category: 'prompt-contract-drift',
      severity: 'warning',
      issue: 'The developer-only link-events panel is visible during build QA.',
      suggestion: 'Keep link-events-panel hidden for all demo steps.',
    });
  }
  if (expectsJsonPanel) {
    if (!hasEndpoint) {
      diagnostics.push({
        stepId: step.id,
        category: 'api-rail-contract',
        severity: 'warning',
        issue: 'Step has apiResponse.response but apiResponse.endpoint is empty — endpoint label should match the JSON rail.',
        suggestion: 'Set apiResponse.endpoint (e.g. POST /identity/match) per demo-script contract.',
      });
    }
    if (!state.apiPanelExists) {
      diagnostics.push({
        stepId: step.id,
        category: 'missing-panel',
        severity: 'critical',
        issue: 'An API insight step is missing the global api-response-panel element.',
        suggestion: 'Include the global api-response-panel and show it from goToStep for insight steps.',
      });
    } else {
      if (!state.apiPanelChromeTriplet) {
        diagnostics.push({
          stepId: step.id,
          category: 'panel-chrome-contract',
          severity: 'critical',
          issue: 'API JSON rail is missing the required edge toggle control (data-testid="api-panel-toggle").',
          suggestion: 'Merge templates/slide-template/pipeline-slide-shell.html edge toggle contract (single icon control + toggleApiPanel()).',
        });
      }
      // OVERLAY CONTRACT (2026-06-04): #api-response-panel is a fixed overlay
      // that stays COLLAPSED by default on EVERY step (host and slide alike) and
      // never reflows the slide. So a present + populated + collapsed panel is
      // valid everywhere — we no longer require the panel to be visible/expanded
      // on slide steps. Panel content is still validated below (apiContentLength)
      // and the panel data is driven by _stepApiResponses / live-api-capture.
      if (state.apiPanelChromeTriplet && !state.hasToggleApiFunction) {
        diagnostics.push({
          stepId: step.id,
          category: 'panel-collapse-contract',
          severity: 'warning',
          issue: 'window.toggleApiPanel() is missing — the edge toggle icon must call a shared collapse/expand implementation.',
          suggestion: 'Define toggleApiPanel() per templates/slide-template/PIPELINE_SLIDE_SHELL_RULES.md.',
        });
      }
      // Expanded JSON rail must read without horizontal scroll (vertical is
      // fine). Slide-tier steps force-open the panel before capture, so the
      // measurement reflects the real expanded width.
      if (isSlideLikeStep(step) && state.apiPanelVisible && state.apiPanelCodeOverflowsX) {
        diagnostics.push({
          stepId: step.id,
          category: 'panel-horizontal-scroll',
          severity: 'warning',
          issue: `Expanded API JSON panel needs horizontal scroll to read the code (pre.code scrollWidth ${state.apiPanelCodeScrollWidth}px > clientWidth ${state.apiPanelCodeClientWidth}px). Vertical scroll is OK; horizontal is not.`,
          suggestion: 'The code must fit the panel width (post-panels sets min(1080px,92vw) + 12px font). Shorten very long string values in this step\'s apiResponse fixture (tokens, URLs, base64) or trim deep nesting so no line overflows.',
        });
      }
      if (state.apiContentLength < MIN_JSON_PANEL_CHARS) {
        diagnostics.push({
          stepId: step.id,
          category: 'missing-panel',
          severity: 'critical',
          issue: `API panel content pane is empty or too short (${state.apiContentLength} chars; need sample JSON in #api-pane-request/#api-pane-response or #api-response-content).`,
          suggestion: 'Hydrate the active pane from demo-script apiResponse via window._stepApiResponses and populateApiPanel().',
        });
      }
      // If panel body is visible, it must contain JSON and support scrolling.
      if (state.apiBodyVisible && !state.apiContentLength) {
        diagnostics.push({
          stepId: step.id,
          category: 'missing-panel',
          severity: 'critical',
          issue: 'API panel body is visible but empty.',
          suggestion: 'Populate the panel from apiResponse.response or window._stepApiResponses for this step.',
        });
      }
      if (state.apiBodyVisible && !/(auto|scroll)/i.test(String(state.apiBodyOverflowY || ''))) {
        diagnostics.push({
          stepId: step.id,
          category: 'panel-visibility',
          severity: 'warning',
          issue: 'API panel body is not configured for vertical scrolling.',
          suggestion: 'Set .side-panel-body overflow-y to auto/scroll so long JSON payloads remain readable.',
        });
      }
    }
    for (const mismatch of evaluateApiStoryAlignment(step)) {
      diagnostics.push({
        stepId: step.id,
        category: 'api-story-alignment',
        severity: 'critical',
        issue: mismatch,
        suggestion: 'Align endpoint + response fields with the slide narrative and highlighted attributes.',
      });
    }
  } else if (state.apiPanelVisible) {
    diagnostics.push({
      stepId: step.id,
      category: 'panel-visibility',
      severity: 'warning',
      issue: 'The API response panel is visible on a non-insight / consumer step.',
      suggestion: 'Hide the api-response-panel on all non-insight steps.',
    });
  }
  if (isSlideLikeStep(step) && state.slideRootInlineStyleHasFixedSize) {
    diagnostics.push({
      stepId: step.id,
      category: 'slide-template-misuse',
      severity: 'critical',
      issue: 'Slide root uses fixed pixel sizing (inline width/height).',
      suggestion: 'Use responsive .slide-root sizing per PIPELINE_SLIDE_SHELL_RULES.md; avoid fixed px width/height.',
    });
  }

  // Canonical slide canvas contract — see `scanSlideCanvasSize()` definition
  // above for the rule details. Emits up to 3 deterministic-blocker diagnostics
  // (`slide-canvas-size` category) when a slide doesn't meet the
  // Google-Slides-class width/height/aspect-ratio contract.
  // Gated on !isAppOnlyRun — app-only runs use scanAppOnlyNoSlides instead
  // (which flags any slide DOM as a critical leak).
  if (!isAppOnlyRun) {
    for (const d of scanSlideCanvasSize(state, step)) diagnostics.push(d);
    for (const d of scanSlideHostChromeLeak(state, step)) diagnostics.push(d);
    for (const d of scanSlideTextOverlap(state, step)) diagnostics.push(d);
    for (const d of scanSlideTextWrap(state, step)) diagnostics.push(d);
  }
  if (isSlideLikeStep(step) && (state.activeStepHasMobileShellTarget || state.activeStepHasMobileSimulatorShell)) {
    diagnostics.push({
      stepId: step.id,
      category: 'mobile-slide-mode-contract',
      severity: 'critical',
      issue: 'Slide-like step is rendering inside mobile shell instead of desktop mode.',
      suggestion: 'Auto-switch to desktop presentation for slide-like steps and keep mobile shell off for those steps.',
    });
  }
  if (isSlideLikeStep(step)) {
    if (
      state.slideRootComputedWidth > 0 &&
      state.viewportWidth > state.slideRootComputedWidth + 120
    ) {
      const expectedLeft = Math.max(0, (state.viewportWidth - state.slideRootComputedWidth) / 2);
      if (Math.abs((state.slideRootOffsetLeft || 0) - expectedLeft) > 36) {
        diagnostics.push({
          stepId: step.id,
          category: 'slide-template-misuse',
          severity: 'warning',
          issue: 'Slide surface is not centered on wider viewports.',
          suggestion: 'Center .slide-root with horizontal auto margins so widescreen captures keep content visually focused.',
        });
      }
    }
    if (state.activeSlideHasTable) {
      if (!state.slideBodyBorderWidth || state.slideBodyBorderWidth < 1) {
        diagnostics.push({
          stepId: step.id,
          category: 'slide-template-misuse',
          severity: 'warning',
          issue: 'Slide table scene is missing a visible content frame/border around the central content area.',
          suggestion: 'Wrap slide body content in a bordered frame (or add border to .slide-body) to keep tables visually centered on widescreen.',
        });
      }
      if (
        state.slideRootComputedWidth > 0 &&
        state.slideTableWidth > 0 &&
        state.slideTableWidth / state.slideRootComputedWidth > 0.9
      ) {
        diagnostics.push({
          stepId: step.id,
          category: 'slide-template-misuse',
          severity: 'warning',
          issue: 'Slide table columns are overly spread across the full slide width.',
          suggestion: 'Constrain slide table width and reduce horizontal cell padding so columns stay readable at 1440+ widths.',
        });
      }
    }
  }
  if (isValueSummarySlide) {
    if (hasEndpoint || hasApiResponse) {
      diagnostics.push({
        stepId: step.id,
        category: 'slide-template-misuse',
        severity: 'critical',
        issue: 'value-summary-slide contains apiResponse metadata.',
        suggestion: 'Remove apiResponse from value-summary-slide. Final value summary must be narrative-only.',
      });
    }
    if (state.apiPanelVisible) {
      diagnostics.push({
        stepId: step.id,
        category: 'panel-visibility',
        severity: 'critical',
        issue: 'API panel is visible during value-summary-slide.',
        suggestion: 'Keep api-response-panel hidden for value-summary-slide.',
      });
    }
    if (state.activeStepPreCodeCount > 0 || state.activeStepJsonHintNodeCount > 0) {
      diagnostics.push({
        stepId: step.id,
        category: 'slide-template-misuse',
        severity: 'critical',
        issue: 'value-summary-slide includes JSON/code-like content.',
        suggestion: 'Remove JSON/code blocks from value-summary-slide. Keep only headline, value bullets, and CTA.',
      });
    }
  }
  if (String(step?.id || '').toLowerCase() === 'layer-eligible-flow') {
    if (!state.hasOnboardingCompleteStep) {
      diagnostics.push({
        stepId: step.id,
        category: 'layer-branching-contract',
        severity: 'critical',
        issue: 'Layer-eligible flow is missing an onboarding-complete destination step.',
        suggestion: 'Add a dedicated onboarding-complete step and route eligible users to it directly.',
      });
    }
    if (/pii|plaid-link|link-fallback/i.test(String(state.layerShareConfirmOnclick || ''))) {
      diagnostics.push({
        stepId: step.id,
        category: 'layer-branching-contract',
        severity: 'critical',
        issue: 'Layer-eligible CTA routes to fallback PII/Link path.',
        suggestion: 'Route layer-share-confirm-btn to onboarding-complete; fallback PII + Link is ineligible-only.',
      });
    }
    if (state.activePiiInputCount > 0 || state.activeStepHasPlaidLinkLaunchBtn) {
      diagnostics.push({
        stepId: step.id,
        category: 'layer-branching-contract',
        severity: 'critical',
        issue: 'Layer-eligible step contains fallback PII inputs or Plaid Link launch controls.',
        suggestion: 'Keep fallback PII fields and Link launch controls out of the eligible Layer step.',
      });
    }
  }
  if (String(step?.id || '').toLowerCase() === 'pii-fallback-form') {
    if (!/plaid-link|link-fallback|link/i.test(String(state.piiContinueOnclick || ''))) {
      diagnostics.push({
        stepId: step.id,
        category: 'layer-branching-contract',
        severity: 'warning',
        issue: 'PII fallback continue action does not clearly route to Plaid Link fallback.',
        suggestion: 'Route pii-continue-btn to the standard Plaid Link fallback step for ineligible users.',
      });
    }
  }
  // Mock-Layer "helper text below the mobile frame" + 415-555-1111 prefill
  // contract REMOVED (2026-05-29). Layer is a live Plaid Layer Web SDK modal
  // (like Plaid Link); the eligible sandbox number is +14155550011 and there is
  // no mobile-frame helper text. Eligibility is exercised by the live modal, not
  // asserted via mock helper copy.
  if (isSlideLikeStep(step) && !state.activeStepHasSlideRoot) {
    diagnostics.push({
      stepId: step.id,
      category: 'slide-template-misuse',
      severity: 'warning',
      issue: 'A slide-like step does not include the expected .slide-root structure.',
      suggestion: 'Render slide scenes using the shared slide template contract.',
    });
  }
  // Content-clipping detector (2026-05-29): slide content overflowing the 16/10
  // canvas is clipped by the letterbox edge (overflow:hidden) — the "blue border
  // clips the bottom text" bug. This is a rendering defect, so flag it as a
  // deterministic blocker; slide-fix trims content (fewer/shorter lines, drop a
  // stat) rather than a font-clamp enforcer. Threshold > 6px ignores sub-pixel rounding.
  if (isSlideLikeStep(step) && Number(state.slideContentOverflowPx || 0) > 6) {
    const kind = state.slideClippedKind === 'object' ? 'an OBJECT (card/image/shape)' : 'TEXT';
    diagnostics.push({
      stepId: step.id,
      category: 'slide-content-clipped',
      severity: 'critical',
      issue: `Slide content is clipped by the canvas edge — ${kind} extends ${state.slideContentOverflowPx}px beyond the slide-root (overflow:hidden). Clipped element: "${state.slideClippedText || ''}".`,
      suggestion: state.slideClippedKind === 'object'
        ? 'A visual element (e.g. a step card, media tile, or image row) is cut off by the letterbox. Reduce its size or the number/height of items, tighten vertical spacing, or shorten copy inside it so the whole object fits the 16/10 canvas. Do NOT rely on the letterbox to hide overflow.'
        : 'Reduce content so it fits the 16/10 canvas: drop or shorten the lowest row (e.g. a stat callout), tighten body copy, or reduce inter-block spacing. Do NOT rely on the letterbox to hide overflow.',
      deterministicBlocker: true,
    });
  }
  if (isSlideLikeStep(step)) {
    const textLen = String(state.activeStepText || '').trim().length;
    if (!state.stepVisible || textLen < 80) {
      diagnostics.push({
        stepId: step.id,
        category: 'blank-slide',
        severity: 'critical',
        issue: 'Slide step appears blank or near-empty during capture.',
        suggestion: 'Ensure the slide renders visible heading/body/CTA content before frame capture.',
      });
    }
  }
  const hostStatLeak = detectHostUiStatLeak(step, state);
  if (hostStatLeak) {
    diagnostics.push({
      stepId: step.id,
      category: 'host-ui-metrics-leak',
      severity: 'warning',
      issue: hostStatLeak,
      suggestion: 'Move internal metrics to Plaid insight/slide context or replace with user-meaningful outcome language.',
    });
  }
  diagnostics.push(...buildPlaidLaunchCtaIconDiagnostics(step, state));
  return diagnostics;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} stepId
 * @param {number} rowIndex
 * @param {number} dwellMs
 */
/**
 * Poll the page for transient loading / "linking account" / "continuing in
 * Plaid Link" indicators and wait up to `maxWaitMs` for them to clear. These
 * spinners are part of Plaid Link's account-linking handshake — they are NOT
 * demo step content and should not end up in QA screenshots.
 *
 * Returns `{ cleared, elapsedMs, lastSignal }`. On timeout, returns cleared=false
 * so callers can surface a diagnostic (but still capture whatever is on screen).
 */
async function waitForLoadingToClear(page, opts = {}) {
  const maxWaitMs = Math.max(0, Number(opts.maxWaitMs) || 0);
  if (maxWaitMs === 0) return { cleared: true, elapsedMs: 0, lastSignal: null };
  const pollMs = 250;
  const start = Date.now();

  const check = async () => {
    return page.evaluate(() => {
      // Consider the ACTIVE step only; avoid false positives from hidden steps.
      const active = document.querySelector('.step.active') || document.body;
      if (!active) return { spinner: false, text: null };

      // Loading-spinner element patterns (legitimate transient states Plaid
      // Link triggers, or the host's own post-link handshake UI).
      const loadingSelectors = [
        '.spinner',
        '.loading-spinner',
        '.loader',
        '[class*="spinner"]:not([class*="spinner-hidden"])',
        '[class*="loading"]:not([class*="loaded"]):not([class*="loading-complete"])',
        '[class*="linking"]:not([class*="linked"])',
        '[aria-busy="true"]',
      ];
      let spinnerEl = null;
      for (const sel of loadingSelectors) {
        try {
          const el = active.querySelector(sel);
          if (!el) continue;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || el.offsetParent === null) continue;
          spinnerEl = el;
          break;
        } catch (_) {}
      }

      // Text patterns that indicate a transient Plaid / linking handshake.
      const visibleText = (active.innerText || '').slice(0, 2000).toLowerCase();
      const transientPatterns = [
        /linking\s+(your\s+)?(account|bank)/i,
        /continuing\s+in\s+plaid\s+link/i,
        /verifying\s+(connection|account|ownership)/i,
        /retrieving\s+(account|transaction|your)/i,
        /loading\s+(your\s+)?account/i,
        /connecting\s+(to\s+)?(your\s+)?bank/i,
        /please\s+wait/i,
      ];
      let textMatch = null;
      for (const re of transientPatterns) {
        const m = visibleText.match(re);
        if (m) { textMatch = m[0]; break; }
      }

      return {
        spinner: !!spinnerEl,
        text: textMatch,
        signal: spinnerEl ? `spinner:${spinnerEl.className || spinnerEl.tagName || 'unknown'}` : (textMatch ? `text:${textMatch}` : null),
      };
    });
  };

  let lastSignal = null;
  while (Date.now() - start < maxWaitMs) {
    let result;
    try { result = await check(); } catch (_) { result = { spinner: false, text: null, signal: null }; }
    if (!result.spinner && !result.text) {
      return { cleared: true, elapsedMs: Date.now() - start, lastSignal };
    }
    lastSignal = result.signal;
    await page.waitForTimeout(pollMs);
  }
  return { cleared: false, elapsedMs: Date.now() - start, lastSignal };
}

async function captureStepFrames(page, stepId, rowIndex, dwellMs, stabilityOpts = {}) {
  // Wait for transient loading states BEFORE the first screenshot so vision
  // QA never sees "Linking account…" / "Continuing in Plaid Link…" spinners
  // as if they were real demo scenes. Opt-in per-call so existing callers
  // keep their old behavior unless they pass maxWaitMs.
  const spinnerMax = Math.max(0, Number(stabilityOpts.spinnerMaxWaitMs) || 0);
  if (spinnerMax > 0) {
    const stability = await waitForLoadingToClear(page, { maxWaitMs: spinnerMax });
    if (!stability.cleared) {
      console.warn(
        `[build-qa] Step "${stepId}" still showed a loading indicator after ${stability.elapsedMs}ms ` +
          `(signal=${stability.lastSignal || 'unknown'}); capturing anyway.`
      );
    } else if (stability.elapsedMs > 500) {
      console.log(
        `[build-qa] Step "${stepId}" — waited ${stability.elapsedMs}ms for linking/loading indicator to clear.`
      );
    }
  }

  const { startWait, midWait, endWait } = computeCaptureDelays(dwellMs);
  const frames = [];
  const capture = async (label, waitMs) => {
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    const out = path.join(FRAMES_DIR, `${stepId}-buildqa-${rowIndex}-${label}.png`);
    await page.screenshot({ path: out, fullPage: false });
    if (LEGACY_FRAMES_DIR !== FRAMES_DIR) {
      const legacyOut = path.join(LEGACY_FRAMES_DIR, `${stepId}-buildqa-${rowIndex}-${label}.png`);
      fs.copyFileSync(out, legacyOut);
    }
    frames.push({ label, path: out });
  };

  await capture('start', startWait);
  await capture('mid', midWait);
  await capture('end', endWait);
  return frames;
}

/**
 * @param {import('playwright').Page} page
 * @param {object} stepEntry
 */
async function runPlaywrightRow(page, stepEntry) {
  const waitMs = Math.min(stepEntry.waitMs || 2000, MAX_WAIT);
  const isPlaidClick = stepEntry.action === 'click' && PLAID_BTN_RE.test(stepEntry.target || '');
  const dwellMs = isPlaidClick && !RECORD_PARITY ? Math.min(waitMs, PLAID_CLICK_WAIT) : waitMs;
  const errors = [];
  const captureError = (category, issue, suggestion) => {
    errors.push({
      stepId: stepEntry.stepId || stepEntry.id,
      category,
      severity: category === 'action-failure' || category === 'selector-missing' ? 'critical' : 'warning',
      issue,
      suggestion,
    });
  };

  if (stepEntry.actions && Array.isArray(stepEntry.actions)) {
    for (const a of stepEntry.actions) {
      if (a.type === 'wait') await page.waitForTimeout(a.ms || 1000);
      else if (a.type === 'click') {
        try {
          const loc = await locateVisibleWithFallback(page, a.selector);
          await loc.click({ timeout: 8000, force: true });
        } catch (err) {
          captureError('selector-missing', `Could not click selector "${a.selector}": ${err.message}`, 'Ensure the expected interactive element exists, is visible, and has the required data-testid.');
        }
      } else if (a.type === 'fill') {
        try {
          const loc = await locateVisibleWithFallback(page, a.selector);
          await loc.fill(a.value || '');
        } catch (err) {
          captureError('selector-missing', `Could not fill selector "${a.selector}": ${err.message}`, 'Ensure the expected input exists, is visible, and uses the correct selector.');
        }
      } else if (a.type === 'evalStep') {
        try {
          await page.evaluate(a.expression);
        } catch (err) {
          captureError('action-failure', `Could not evaluate "${a.expression}": ${err.message}`, 'Fix goToStep/navigation JavaScript so build QA can advance to the expected step.');
        }
      }
    }
    return { dwellMs, errors };
  }

  if (!stepEntry.action) {
    return { dwellMs, errors };
  }

  if (stepEntry.action === 'goToStep') {
    const target = stepEntry.target || '';
    const expression = normalizeGoToStepExpression(target);
    try {
      await page.evaluate(expression);
    } catch (err) {
      captureError('action-failure', `Could not navigate with "${expression}": ${err.message}`, 'Ensure window.goToStep exists and step IDs match the generated HTML.');
    }
  } else if (stepEntry.action === 'click') {
    try {
      const targetStepId = stepEntry.stepId || stepEntry.id || null;
      if (targetStepId) {
        const aligned = await forceStepActive(page, targetStepId);
        if (!aligned?.ok) {
          captureError(
            'navigation-mismatch',
            `Could not align active step before click for "${targetStepId}" (activeAfter=${aligned?.activeAfter || 'none'}).`,
            'Ensure goToStep can activate the expected step container before interaction.'
          );
        }
        await page.waitForTimeout(120);
      }
      const loc = await locateVisibleWithFallback(page, stepEntry.target);
      await loc.click({ timeout: 8000, force: true });
    } catch (err) {
      // Slide-rendered steps (insight/title slides via .slide-root) advance by
      // NAVIGATION, not a button click — the script sometimes assigns them a
      // "continue-*-btn" click target that the slide doesn't render. A missing
      // continue button on a slide is not a real defect (the next row's
      // forceStepActive navigates onward), so downgrade to a warning instead of
      // the critical selector-missing that fails the deterministic gate.
      let onSlide = false;
      try {
        onSlide = await page.evaluate(() => {
          const a = document.querySelector('.step.active');
          return !!(a && a.querySelector('.slide-root'));
        });
      } catch (_) {}
      if (onSlide) {
        captureError('slide-advance-no-button', `Click target "${stepEntry.target}" not found on a slide step — advancing by navigation (slides need no continue button).`, 'Slide steps advance via goToStep; no continue button required. If you want a clickable advance, render a host step instead of a slide.');
      } else {
        captureError('selector-missing', `Could not click selector "${stepEntry.target}": ${err.message}`, 'Ensure the expected clickable element exists, is visible, and uses the requested selector.');
      }
    }
  } else if (stepEntry.action === 'fill') {
    try {
      const targetStepId = stepEntry.stepId || stepEntry.id || null;
      if (targetStepId) {
        const aligned = await forceStepActive(page, targetStepId);
        if (!aligned?.ok) {
          captureError(
            'navigation-mismatch',
            `Could not align active step before fill for "${targetStepId}" (activeAfter=${aligned?.activeAfter || 'none'}).`,
            'Ensure goToStep can activate the expected step container before interaction.'
          );
        }
        await page.waitForTimeout(120);
      }
      const loc = await locateVisibleWithFallback(page, stepEntry.target);
      await loc.fill(stepEntry.value || '');
    } catch (err) {
      captureError('selector-missing', `Could not fill selector "${stepEntry.target}": ${err.message}`, 'Ensure the expected input exists, is visible, and can be filled by Playwright.');
    }
  }

  return { dwellMs, errors };
}

async function main(opts = {}) {
  if (!fs.existsSync(path.join(SCRATCH_DIR, 'index.html'))) {
    console.error('[build-qa] Missing scratch-app/index.html — run build stage first');
    process.exit(1);
  }
  if (!fs.existsSync(PW_SCRIPT)) {
    console.error('[build-qa] Missing scratch-app/playwright-script.json');
    process.exit(1);
  }
  if (!fs.existsSync(DEMO_SCRIPT)) {
    console.error('[build-qa] Missing demo-script.json');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[build-qa] Missing ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const playwrightScript = JSON.parse(fs.readFileSync(PW_SCRIPT, 'utf8'));
  const demoScript       = JSON.parse(fs.readFileSync(DEMO_SCRIPT, 'utf8'));
  const demoStepIds      = (demoScript.steps || []).map(s => s.id);
  const plaidQaMode = resolveBuildQaPlaidMode(opts.plaidMode || BUILD_QA_PLAID_MODE_RAW);
  const mobileVisualEnabled = opts.mobileVisualEnabled != null
    ? !!opts.mobileVisualEnabled
    : MOBILE_VISUAL_ENABLED;

  // Resolve buildMode from run-manifest (authoritative). Used to gate slide-tier
  // scanners + activate the app-only invariant scanner. Falls back to demo-script
  // step inspection if manifest is missing (legacy runs).
  const runManifestForMode = readRunManifest(OUT_DIR);
  let resolvedBuildMode = runManifestForMode && typeof runManifestForMode.buildMode === 'string'
    ? String(runManifestForMode.buildMode).toLowerCase().trim()
    : '';
  if (resolvedBuildMode !== 'app-only' && resolvedBuildMode !== 'app+slides') {
    const hasSlideSteps = Array.isArray(demoScript.steps)
      && demoScript.steps.some((s) => s && (s.stepKind === 'slide' || s.sceneType === 'slide'));
    resolvedBuildMode = hasSlideSteps ? 'app+slides' : 'app-only';
  }
  const isAppOnlyRun = resolvedBuildMode === 'app-only';

  const server = await startServer(3739, SCRATCH_DIR);
  const url    = server.url;
  console.log(`[build-qa] Serving app at ${url}`);

  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  fs.mkdirSync(LEGACY_FRAMES_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: RECORD_PARITY ? 2 : 1,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => {
    pageErrors.push(String((err && err.message) || err || 'unknown pageerror'));
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(800);

  const stepMap = new Map((demoScript.steps || []).map(step => [step.id, step]));
  /** @type {Record<string, Array<{label:string,path:string}>>} */
  const stepFramesById = {};
  const diagnostics = [];
  let htmlPanelTogglePresent = false;
  try {
    const html = fs.readFileSync(path.join(SCRATCH_DIR, 'index.html'), 'utf8');
    htmlPanelTogglePresent =
      (/data-testid=["']api-panel-toggle["']|id=["']api-panel-toggle["']/i.test(html)) ||
      (/class=["'][^"']*api-panel-edge-toggle[^"']*["']/i.test(html));
    if (/function\s+_initHandler\s*\(\s*token\s*\)[\s\S]{0,500}?if\s*\(\s*!data\s*\|\|\s*!data\.link_token\s*\)/i.test(html)) {
      diagnostics.push({
        stepId: 'plaid-link-launch',
        category: 'runtime-js-error',
        severity: 'critical',
        issue: 'Plaid bootstrap guard references `data` inside `_initHandler(token)`, which can throw ReferenceError and break /api/create-link-token flow.',
        suggestion: 'Use `if (!token && (typeof data === "undefined" || !data || !data.link_token))` or token-only guard in `_initHandler`.',
        deterministicBlocker: true,
      });
    }
    if (
      /\.then\(function\(data\)[\s\S]{0,400}?if\s*\(\s*!token\s*&&\s*\(typeof data === 'undefined'/i.test(html) ||
      /\.then\(function\(data\)[\s\S]{0,400}?if\s*\(\s*!token\s*&&\s*\(typeof data === "undefined"/i.test(html)
    ) {
      diagnostics.push({
        stepId: 'plaid-link-launch',
        category: 'runtime-js-error',
        severity: 'critical',
        issue: 'Plaid token bootstrap references `token` inside a data-scope callback, which can throw `ReferenceError: token is not defined` before Plaid handler init.',
        suggestion: 'In data callbacks, guard with `((typeof token !== "undefined") ? !token : true)` or use data-only checks before Plaid.create.',
        deterministicBlocker: true,
      });
    }
    diagnostics.push(...scanDuplicateBankMarks(html, demoScript));
    diagnostics.push(...scanMissingBrandLogo(html, demoScript));
    diagnostics.push(...scanRenderjsonDisclosureStyling(html));
    // Slide-design scanners are gated on buildMode === 'app+slides'.
    // On app-only runs we instead run scanAppOnlyNoSlides, which asserts
    // zero slide artifacts (any leak is a critical blocker).
    if (!isAppOnlyRun) {
      diagnostics.push(...scanSlideDesignSystem(html, demoScript, resolvedBuildMode));
      // Narration-vs-rendered concrete-values drift scanner. Fires only on
      // app+slides; catches LLM hallucinated claims before recording.
      diagnostics.push(...scanSlideNarrationConcreteValues(html, demoScript, resolvedBuildMode));
    } else {
      diagnostics.push(...scanAppOnlyNoSlides(html, demoScript, resolvedBuildMode));
    }
    diagnostics.push(...scanCraHostUnderwritingContracts(html, demoScript));
    diagnostics.push(...scanPanelOverlayContract(html, demoScript));
  } catch (_) {}

  // Sanity guard: ensure the loaded page actually contains the expected step containers.
  // Without this, downstream selector checks produce misleading false negatives.
  const expectedStepTestids = new Set(demoStepIds.map((id) => `step-${id}`));
  let domStepIds = [];
  try {
    await page.waitForSelector('.step[data-testid]', { state: 'attached', timeout: 12000 });
    const initialBoot = await ensureInitialStepVisible(page, demoScript);
    if (initialBoot.activated) {
      console.warn(
        `[build-qa] No visible active step on load — activated "${initialBoot.stepId}" ` +
        `(${initialBoot.reason}). Host apps should set .active or call goToStep(firstStepId) on init.`
      );
    }
    domStepIds = await getDomStepInventory(page);
    const overlap = domStepIds.filter((id) => expectedStepTestids.has(id));
    if (!domStepIds.length || overlap.length === 0) {
      throw new Error(
        `Loaded page step inventory does not match demo-script. expected=${demoStepIds.length}, ` +
        `dom=${domStepIds.length}, overlap=${overlap.length}`
      );
    }
  } catch (err) {
    diagnostics.push({
      stepId: (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build',
      category: 'qa-target-mismatch',
      severity: 'critical',
      issue: `Build-QA loaded an unexpected page shape: ${err.message}`,
      suggestion: 'Verify SCRATCH_DIR points to the current run scratch-app and that .step[data-testid] containers are rendered before walkthrough.',
    });
    fs.writeFileSync(DIAG_OUT, JSON.stringify({
      generatedAt: new Date().toISOString(),
      recordParity: RECORD_PARITY,
      headless: HEADLESS,
      diagnostics,
      summary: {
        categoryCounts: { 'qa-target-mismatch': 1 },
        phaseCounts: { buildQa: 1 },
        criticalStepIds: [(demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build'],
        totalDiagnostics: diagnostics.length,
        domStepIds,
      },
    }, null, 2));
    fs.writeFileSync(LEGACY_DIAG_OUT, fs.readFileSync(DIAG_OUT, 'utf8'), 'utf8');
    throw err;
  }

  const rowsAll = playwrightScript.steps || [];
  const stepScopeRaw = String(opts.stepScope || process.env.BUILD_QA_STEP_SCOPE || 'all').trim().toLowerCase();
  const stepScope = (stepScopeRaw === 'slides' || stepScopeRaw === 'app') ? stepScopeRaw : 'all';
  CURRENT_BUILD_QA_STEP_SCOPE = stepScope;
  if (stepScopeRaw !== 'all' && stepScopeRaw !== 'slides' && stepScopeRaw !== 'app') {
    console.warn(`[build-qa] Unknown BUILD_QA_STEP_SCOPE="${stepScopeRaw}" — defaulting to "all"`);
  }
  const slideStepIds = new Set(
    (demoScript.steps || [])
      .filter((step) => isSlideLikeStep(step))
      .map((step) => step.id)
      .filter(Boolean)
  );
  // Tier-scoped row filter — 'slides' keeps slide steps only, 'app' keeps
  // non-slide steps only, 'all' keeps everything. Slide-scoped QA is used by
  // the slide-fix lane; app-scoped QA is used by the app-touchup lane.
  let rows;
  if (stepScope === 'slides') {
    rows = rowsAll.filter((row) => slideStepIds.has(row.stepId || row.id));
  } else if (stepScope === 'app') {
    rows = rowsAll.filter((row) => !slideStepIds.has(row.stepId || row.id));
  } else {
    rows = rowsAll;
  }
  if ((stepScope === 'slides' || stepScope === 'app') && rows.length === 0) {
    console.warn(`[build-qa] BUILD_QA_STEP_SCOPE=${stepScope} yielded zero rows — falling back to full walkthrough`);
    rows = rowsAll;
  }
  const qaTargetStepIds =
    stepScope === 'slides'
      ? demoStepIds.filter((id) => slideStepIds.has(id))
      : stepScope === 'app'
        ? demoStepIds.filter((id) => !slideStepIds.has(id))
        : demoStepIds.slice();
  const effectiveQaTargetStepIds = qaTargetStepIds.length > 0 ? qaTargetStepIds : demoStepIds;
  console.log(
    `[build-qa] Walking ${rows.length} playwright row(s)...` +
    (stepScope !== 'all' ? ` (scope=${stepScope}, totalRows=${rowsAll.length})` : '') +
    ` [plaidMode=${plaidQaMode}]`
  );
  const launchStepId = getPlaidLaunchStepId(demoScript);
  // Every live-launch step (supports multi-launch demos: Layer + live IDV).
  const launchStepIds = getPlaidLaunchStepIds(demoScript);
  let tokenOnlyProbe = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const stepId = row.stepId || row.id;
    const step = stepMap.get(stepId);
    const nextRow = rows[i + 1] || null;
    const nextStepId = nextRow ? (nextRow.stepId || nextRow.id) : null;
    const boundaryClickRow =
      !!step &&
      row &&
      row.action === 'click' &&
      !PLAID_BTN_RE.test(String(row.target || '')) &&
      nextRow &&
      nextRow.action === 'goToStep' &&
      typeof stepId === 'string' &&
      typeof nextStepId === 'string' &&
      stepId.trim() &&
      nextStepId.trim() &&
      stepId !== nextStepId;
    if (step && typeof stepId === 'string' && stepId.trim()) {
      try {
        const preAlign = await forceStepActive(page, stepId);
        if (!preAlign?.ok) {
          diagnostics.push({
            stepId,
            category: 'navigation-mismatch',
            severity: 'warning',
            issue: `Pre-row step alignment failed for "${stepId}" (reason=${preAlign?.reason || 'unknown'}, activeAfter=${preAlign?.activeAfter || 'none'}).`,
            suggestion: 'Verify generated goToStep wiring and step container IDs in built HTML.',
          });
        }
      } catch (_) {}
    }
    const isLaunchRow = isPlaidLaunchRow(row, launchStepIds);
    // Is this the first step AFTER the Plaid Link launch? If so, Plaid's
    // onSuccess handshake legitimately shows a "Linking account…" spinner
    // on the host page for a few seconds before the real post-link state
    // renders — give capture an extended stability window.
    const prevRowIdx = i - 1;
    const prevRow = prevRowIdx >= 0 ? rows[prevRowIdx] : null;
    const isFirstPostLaunchRow = !isLaunchRow && prevRow && isPlaidLaunchRow(prevRow, launchStepIds);
    // Standard stability window for every captured frame — short, harmless.
    // Launch step (embedded mode) needs longer for the widget to finish
    // mounting past its own "Continuing in Plaid Link…" loading state.
    const spinnerMaxWaitMs = isLaunchRow
      ? 6000
      : isFirstPostLaunchRow
        ? 8000
        : 2000;
    let result;
    let capturedFramesOverride = null;
    if (boundaryClickRow) {
      try {
        await forceStepActive(page, stepId);
        await page.waitForTimeout(120);
      } catch (_) {}
      try {
        const preClickDwell = Math.min(Math.max(600, row.waitMs || 1200), 1500);
        capturedFramesOverride = await captureStepFrames(page, stepId, i, preClickDwell, { spinnerMaxWaitMs });
        console.log(
          `[build-qa] Boundary pre-capture for step "${stepId}" before click transition to "${nextStepId}"`
        );
      } catch (err) {
        diagnostics.push({
          stepId,
          category: 'action-failure',
          severity: 'critical',
          issue: `Pre-click boundary capture failed for step "${stepId}": ${err.message}`,
          suggestion: 'Ensure the step renders stably before click so build QA can capture non-transition frames.',
        });
      }
    }
    if (isLaunchRow && plaidQaMode !== 'full') {
      if (plaidQaMode === 'token-only' && !tokenOnlyProbe) {
        try {
          tokenOnlyProbe = await runTokenOnlyLinkProbe(page, demoScript);
          if (!tokenOnlyProbe.result.ok || tokenOnlyProbe.result.status !== 200) {
            diagnostics.push({
              stepId,
              category: 'plaid-link-token-health',
              severity: 'critical',
              issue: `Token-only probe failed: status=${tokenOnlyProbe.result.status}`,
              suggestion: 'Ensure /api/create-link-token returns HTTP 200 for build-qa token-only mode.',
            });
          } else {
            const bodyJson = parseJsonFromText(tokenOnlyProbe.result.body);
            // The whole POINT of build-qa in token-only mode is that a VALID
            // link_token is minted. A 200 with no token (e.g. the app-server
            // returning `{ "link_mode": "embedded" }` but no token string) is
            // just as broken as a 500 — fail it explicitly.
            const rawToken =
              bodyJson && typeof bodyJson.link_token === 'string' && bodyJson.link_token.trim();
            if (!rawToken) {
              diagnostics.push({
                stepId,
                category: 'plaid-link-token-health',
                severity: 'critical',
                issue: 'Token-only probe returned HTTP 200 but the response body has no non-empty `link_token` string.',
                suggestion: 'Check app-server /api/create-link-token — it must return { link_token: "link-sandbox-..." } on success.',
              });
            } else {
              // Soft-check token shape (sandbox tokens look like
              // `link-sandbox-<uuid-ish>`) — warn only; some fixtures and
              // mock modes ship shorter opaque tokens.
              if (!/^link-[a-z]+-[a-z0-9-]{8,}/i.test(rawToken)) {
                diagnostics.push({
                  stepId,
                  category: 'plaid-link-token-health',
                  severity: 'warning',
                  issue: `Token-only probe returned an unrecognized token shape (first 12 chars: "${rawToken.slice(0, 12)}").`,
                  suggestion: 'Expected shape is `link-<env>-<id>` (e.g. link-sandbox-abc...). Verify /api/create-link-token is returning the raw Plaid response.',
                });
              } else {
                console.log(`[build-qa] Token-only probe: link_token valid (len=${rawToken.length}).`);
              }
            }
            const responseMode = normalizeResponseLinkMode(bodyJson);
            const expectedEmbedded = String(demoScript?.plaidLinkMode || '').toLowerCase() === 'embedded';
            if (expectedEmbedded && responseMode && responseMode !== 'embedded') {
              diagnostics.push({
                stepId,
                category: 'plaid-link-token-health',
                severity: 'critical',
                issue: `Token-only probe returned mode=${responseMode}; expected embedded.`,
                suggestion: 'Ensure app-server propagates embedded mode into /api/create-link-token for this run.',
              });
            }
          }
        } catch (err) {
          diagnostics.push({
            stepId,
            category: 'plaid-link-token-health',
            severity: 'critical',
            issue: `Token-only probe crashed: ${err.message}`,
            suggestion: 'Check app-server /api/create-link-token route and payload handling.',
          });
        }
      }
      result = { dwellMs: Math.min(row.waitMs || 2000, MAX_WAIT), errors: [] };
    } else {
      result = await runPlaywrightRow(page, row);
    }
    diagnostics.push(...result.errors);

    // Force the intended script step active before screenshot capture.
    // This prevents drift where click actions advance into the next step
    // before build-qa captures the current step's expected state.
    if (step && typeof stepId === 'string' && stepId.trim()) {
      try {
        await forceStepActive(page, stepId);
        await page.waitForTimeout(120);
      } catch (_) {}
    }

    // Align active host step with demo-script for Plaid launch: button may live on prior step DOM.
    if (isPlaidLaunchRow(row, launchStepIds)) {
      try {
        await forceStepActive(page, stepId);
        await page.waitForTimeout(400);
      } catch (_) {}
    }

    // OVERLAY CONTRACT (2026-06-04): the panel is a fixed overlay that stays
    // COLLAPSED by default on EVERY step and never reflows the slide. We no
    // longer force-open it on slide steps — force-opening buried the slide
    // behind the panel (and made the panel look "expanded by default"). Slides
    // are screenshot clean with the panel collapsed; the panel's data is still
    // validated deterministically (apiContentLength + _stepApiResponses /
    // live-api-capture). The presenter expands the overlay live when desired.

    try {
      const frames = (capturedFramesOverride && capturedFramesOverride.length > 0)
        ? capturedFramesOverride
        : await captureStepFrames(page, stepId, i, result.dwellMs, { spinnerMaxWaitMs });
      if (frames.length > 0) {
        const prevFrames = stepFramesById[stepId];
        // Same demo step can appear on multiple playwright rows (e.g. goToStep then click).
        // Vision QA only consumes the first 3 frames (start/mid/end) — merge into one triplet:
        // before interaction, shortly after, settled after.
        if (prevFrames && prevFrames.length > 0) {
          const postFrames = frames;
          stepFramesById[stepId] = [
            { label: 'start', path: prevFrames[0].path },
            {
              label: 'mid',
              path: (postFrames[1] && postFrames[1].path) || postFrames[0].path,
            },
            { label: 'end', path: postFrames[postFrames.length - 1].path },
          ];
        } else {
          stepFramesById[stepId] = frames;
        }
      }
    } catch (err) {
      diagnostics.push({
        stepId,
        category: 'action-failure',
        severity: 'critical',
        issue: `Screenshot capture failed for step "${stepId}": ${err.message}`,
        suggestion: 'Fix the step rendering or screenshot path so build QA can capture visual evidence.',
      });
    }

    if (step) {
      try {
        if (step.apiResponse?.response) {
          await ensureApiPanelContractForStep(page, stepId);
        }
        const state = await evaluateStepState(page, stepId);
        if (htmlPanelTogglePresent && !state.apiPanelChromeTriplet) {
          state.apiPanelChromeTriplet = true;
        }
        diagnostics.push(...buildStepAssertions(step, state, demoScript, { isAppOnlyRun }));
        if (step.apiResponse?.response && state.apiPanelExists) {
          // JSON should be visible whenever panel is visible; no toggle-behavior checks.
        }
      } catch (err) {
        diagnostics.push({
          stepId,
          category: 'action-failure',
          severity: 'warning',
          issue: `Could not evaluate DOM assertions for step "${stepId}": ${err.message}`,
          suggestion: 'Check browser console errors and ensure the built app initializes correctly.',
        });
      }
    }

    if (isLaunchRow) {
      if (plaidQaMode === 'token-only') {
        console.log('[build-qa] Token-only mode: skipping live Plaid Link launch and simulating post-link success.');
      } else if (plaidQaMode === 'skip') {
        console.log('[build-qa] Plaid mode=skip: skipping Plaid launch interactions and simulating post-link success.');
      } else {
        console.log('[build-qa] Simulating Plaid Link success (sandbox) — iframe not automated in build-qa');
      }
      await simulateSandboxPlaidLinkComplete(page, demoScript, stepId);
    }
  }

  try {
    diagnostics.push(...(await runResponsiveChecks(page, demoScript)));
  } catch (err) {
    diagnostics.push({
      stepId: (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build',
      category: 'responsive-layout',
      severity: 'warning',
      issue: `Responsive QA checks failed to execute: ${err.message}`,
      suggestion: 'Verify viewport resizing and client-side step navigation are operational during build-qa.',
    });
  }
  if (mobileVisualEnabled) {
    try {
      diagnostics.push(...(await runMobileVisualChecks(page, demoScript)));
    } catch (err) {
      diagnostics.push({
        stepId: (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build',
        category: 'mobile-visual-contract',
        severity: 'warning',
        issue: `Mobile visual checks failed to execute: ${err.message}`,
        suggestion: 'Verify mobile visual viewport checks can resize and inspect the active step in build-qa.',
      });
    }
  }
  const shouldRunMobilePlaidLaunchCheck =
    plaidQaMode === 'full' ||
    (plaidQaMode === 'token-only' && !BUILD_QA_SKIP_MOBILE_PLAID_WHEN_TOKEN_ONLY);
  if (shouldRunMobilePlaidLaunchCheck) {
    try {
      diagnostics.push(...(await runMobilePlaidLaunchCheck(page, demoScript, pageErrors)));
    } catch (err) {
      diagnostics.push({
        stepId: (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build',
        category: 'plaid-link-mobile-launch',
        severity: 'warning',
        issue: `Mobile Plaid launch smoke check failed to execute: ${err.message}`,
        suggestion: 'Verify mobile-simulated launch check can run after walkthrough.',
      });
    }
  } else {
    console.log('[build-qa] Skipping mobile Plaid launch smoke check in token-only mode.');
  }
  try {
    diagnostics.push(...(await runEmbeddedLaunchSelectorDriftCheck(page, demoScript)));
  } catch (err) {
    diagnostics.push({
      stepId: (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build',
      category: 'plaid-embedded-launch-selector-drift',
      severity: 'warning',
      issue: `Embedded launch selector drift check failed to execute: ${err.message}`,
      suggestion: 'Verify selector drift guard can inspect all .step[data-testid] containers after walkthrough.',
    });
  }

  const runtimeBindingError = pageErrors.find((e) => /Cannot read properties of null \(reading 'addEventListener'\)/i.test(String(e || '')));
  if (runtimeBindingError) {
    diagnostics.push({
      stepId: (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build',
      category: 'runtime-js-error',
      severity: 'critical',
      issue: `Runtime JS error detected: ${runtimeBindingError}`,
      suggestion: 'Guard event listener bindings against missing selectors; this can break Plaid initialization and step navigation.',
    });
  }

  // Non-blocking slide value-messaging enhancement pass (Glean-backed).
  // This adds advisory diagnostics and writes a standalone artifact for refinement input.
  try {
    const slideMsg = await evaluateSlideValueMessaging(page, demoScript);
    if (slideMsg && slideMsg.artifact) {
      fs.writeFileSync(SLIDE_MESSAGING_OUT, JSON.stringify(slideMsg.artifact, null, 2));
      fs.writeFileSync(path.join(OUT_DIR, 'slide-messaging-suggestions.json'), JSON.stringify(slideMsg.artifact, null, 2));
    }
    if (slideMsg && Array.isArray(slideMsg.diagnostics) && slideMsg.diagnostics.length > 0) {
      diagnostics.push(...slideMsg.diagnostics);
    }
  } catch (err) {
    diagnostics.push({
      stepId: (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build',
      category: 'slide-value-messaging',
      severity: 'warning',
      issue: `Slide value messaging pass crashed: ${err.message}`,
      suggestion: 'Treat as non-blocking and inspect Glean/tool logs if suggestions are missing.',
    });
  }

  // Hard timing guardrail (non-visual): narration must fit within adjusted composition windows.
  const timingContract = loadTimingContract(OUT_DIR);
  const timingViolations = [];
  const timingDupes = [];
  const timingCoverageGaps = [];
  const narrationWindowMismatches = [];
  const syncTimelineRows = [];
  let voiceoverManifest = null;
  const timingBoundaryToleranceMs = Number(process.env.NARRATION_WINDOW_TOLERANCE_MS || 120);
  if (timingContract && Array.isArray(timingContract.steps)) {
    const byId = new Map();
    const sortedTiming = [...timingContract.steps]
      .filter((r) => r && Number.isFinite(Number(r.compStartMs)) && Number.isFinite(Number(r.compEndMs)))
      .sort((a, b) => Number(a.compStartMs) - Number(b.compStartMs));

    for (const row of timingContract.steps) {
      const sid = String(row?.stepId || '').trim();
      if (!sid) continue;
      if (!byId.has(sid)) byId.set(sid, 0);
      byId.set(sid, byId.get(sid) + 1);
    }
    for (const [stepId, count] of byId.entries()) {
      if (count > 1) {
        timingDupes.push({ stepId, count });
        diagnostics.push({
          stepId,
          category: 'timing-duplicate-step-window',
          severity: 'critical',
          issue: `Step "${stepId}" has ${count} timing windows in timing-contract.json.`,
          suggestion: 'Collapse duplicate contiguous windows so one screen maps to one narration timeline window.',
        });
      }
    }

    for (let i = 1; i < sortedTiming.length; i++) {
      const prevEnd = Number(sortedTiming[i - 1].compEndMs || 0);
      const curStart = Number(sortedTiming[i].compStartMs || 0);
      const gapMs = Math.round(curStart - prevEnd);
      if (gapMs > 250) {
        timingCoverageGaps.push({ gapMs, fromStep: sortedTiming[i - 1].stepId, toStep: sortedTiming[i].stepId });
        diagnostics.push({
          stepId: sortedTiming[i].stepId || ((demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build'),
          category: 'timing-coverage-gap',
          severity: 'warning',
          issue: `Uncovered composition gap of ${gapMs}ms between "${sortedTiming[i - 1].stepId}" and "${sortedTiming[i].stepId}".`,
          suggestion: 'Ensure sync-map explicitly governs contiguous comp regions with no large unowned gaps.',
        });
      }
    }

    // Hard governor: narration clip start must land inside one of its own step windows.
    // This catches cross-screen narration bleed caused by stale/duplicate timing windows.
    try {
      if (fs.existsSync(VOICEOVER_MANIFEST_FILE)) {
        voiceoverManifest = JSON.parse(fs.readFileSync(VOICEOVER_MANIFEST_FILE, 'utf8'));
        const clips = Array.isArray(voiceoverManifest?.clips) ? voiceoverManifest.clips : [];
        for (const clip of clips) {
          const cid = String(clip?.id || '').trim();
          if (!cid) continue;
          const clipStart = toFinite(clip.compStartMs) ?? toFinite(clip.startMs);
          const clipStartSource = toFinite(clip.compStartMs) != null ? 'compStartMs' : 'startMs';
          if (!Number.isFinite(clipStart)) continue;
          const windows = sortedTiming.filter((r) => String(r.stepId || '') === cid);
          if (windows.length === 0) continue;
          const canonicalWindow = windows[0] || null;
          const canonicalStart = canonicalWindow ? toFinite(canonicalWindow.compStartMs) : null;
          const canonicalEnd = canonicalWindow ? toFinite(canonicalWindow.compEndMs) : null;
          const inOwnWindow = windows.some((w) => (
            clipStart >= Number(w.compStartMs || 0) - timingBoundaryToleranceMs &&
            clipStart <= Number(w.compEndMs || 0) + timingBoundaryToleranceMs
          ));
          syncTimelineRows.push({
            stepId: cid,
            clipStartMs: clipStart,
            clipStartSource,
            windowStartMs: canonicalStart,
            windowEndMs: canonicalEnd,
            leadMs: canonicalStart != null ? Math.round(clipStart - canonicalStart) : null,
            inOwnWindow,
            overrunStatus: canonicalWindow?.status || 'unknown',
            boundaryToleranceMs: timingBoundaryToleranceMs,
          });
          if (!inOwnWindow) {
            narrationWindowMismatches.push({ stepId: cid, clipStartMs: clipStart });
            diagnostics.push({
              stepId: cid,
              category: 'narration-screen-mismatch',
              severity: 'critical',
              issue: `Narration starts at ${clipStart}ms (${clipStartSource}) outside its own screen timing window(s).`,
              suggestion: 'Rebuild timing windows and sync-map so each narration clip starts within its step window only (prefer compStartMs coordinates).',
            });
          }
        }
      }
    } catch (err) {
      diagnostics.push({
        stepId: (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build',
        category: 'narration-screen-mismatch',
        severity: 'warning',
        issue: `Could not evaluate narration-to-screen mapping: ${err.message}`,
        suggestion: 'Inspect voiceover-manifest.json and timing-contract.json for stale timing artifacts.',
      });
    }

    for (const row of timingContract.steps) {
      if (row && row.status === 'overrun') {
        const policyHint = row.isPlaidLink
          ? ` Policy=${row.plaidLinkPolicy || 'default'}.`
          : '';
        diagnostics.push({
          stepId: row.stepId || ((demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build'),
          category: 'narration-overrun',
          severity: 'critical',
          issue: `Narration exceeds visible composition window by ${Math.abs(Number(row.deltaMs || 0))}ms.${policyHint}`,
          suggestion: 'Increase visual duration (sync-map freeze) or shorten narration/gap so actual >= target.',
        });
        timingViolations.push(row);
      }
    }
  }

  let narrationSyncReport = null;
  // Sync-governor depends on timing-contract.json + voiceover-manifest.json, both of
  // which are produced by the voiceover / resync-audio stages. When build-qa runs
  // before voiceover (the common case for a pure app-only build-walkthrough), these
  // files don't exist yet and the governor would flood the report with missing-file
  // warnings that are false positives. Only run the governor if the upstream files
  // are already present (i.e. we're re-running build-qa after voiceover).
  const timingContractPath = path.join(OUT_DIR, 'timing-contract.json');
  const voiceoverManifestPath = path.join(OUT_DIR, 'voiceover-manifest.json');
  const syncGovernorInputsReady =
    fs.existsSync(timingContractPath) && fs.existsSync(voiceoverManifestPath);
  if (!syncGovernorInputsReady) {
    console.log(
      '[build-qa] Skipping sync-governor — timing-contract.json / voiceover-manifest.json not yet generated (this is expected for pre-voiceover build-qa).'
    );
  } else {
    try {
      narrationSyncReport = validateNarrationSync(OUT_DIR);
      writeNarrationSyncReport(OUT_DIR, narrationSyncReport);
      const mappedCriticalCodes = new Set(['cross-screen-owner', 'clip-missing-step-window']);
      for (const v of narrationSyncReport.violations || []) {
        if (v.code === 'narration-screen-mismatch' || v.code === 'narration-overrun' || v.code === 'duplicate-step-window') continue;
        const severity = String(v.code || '').startsWith('missing-')
          ? 'warning'
          : (mappedCriticalCodes.has(v.code) ? 'critical' : 'warning');
        diagnostics.push({
          stepId: v.stepId || ((demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build'),
          category: `sync-governor-${v.code || 'unknown'}`,
          severity,
          issue: `[sync-governor] ${v.message}`,
          suggestion: 'Regenerate timing-contract/voiceover-manifest and ensure sync-map remap is applied before QA.',
        });
      }
      for (const w of narrationSyncReport.warnings || []) {
        diagnostics.push({
          stepId: w.stepId || ((demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build'),
          category: `sync-governor-${w.code || 'warning'}`,
          severity: 'warning',
          issue: `[sync-governor] ${w.message}`,
          suggestion: 'Review narration timing warnings and tighten lead/lag if this recurs.',
        });
      }
    } catch (err) {
      diagnostics.push({
        stepId: (demoScript.steps && demoScript.steps[0] && demoScript.steps[0].id) || 'build',
        category: 'sync-governor-report',
        severity: 'warning',
        issue: `Could not generate narration sync report: ${err.message}`,
        suggestion: 'Inspect validate-narration-sync inputs (timing-contract.json, voiceover-manifest.json).',
      });
    }
  }

  await context.close();
  await browser.close();
  await server.close();

  const prebuiltStepFrames = [];
  for (const stepId of effectiveQaTargetStepIds) {
    const frames = stepFramesById[stepId];
    if (!frames || frames.length === 0) {
      console.warn(`[build-qa] No screenshot captured for step "${stepId}" — skipped`);
      diagnostics.push({
        stepId,
        category: 'navigation-mismatch',
        severity: 'critical',
        issue: 'No build-QA screenshots were captured for this step.',
        suggestion: 'Ensure playwright-script.json visits this step and the UI renders successfully during the walkthrough.',
      });
      continue;
    }
    prebuiltStepFrames.push({
      stepId,
      frames,
    });
  }

  if (prebuiltStepFrames.length === 0) {
    console.error('[build-qa] No frames to QA');
    process.exit(1);
  }

  // Brand-fidelity scan (Phase 3 hyper-realism upgrade).
  // Reads the brand profile produced by `brand-extract` and checks that the
  // rendered host HTML contains the expected nav labels + verbatim regulatory
  // disclosures. Missing items are pushed into `diagnostics` BEFORE
  // normalization so the existing deterministic-gate logic picks them up.
  // No-op when no brand profile or no nav/footer expectations are declared.
  try {
    const { runBrandFidelityChecks } = require('../utils/brand-fidelity');
    let brandProfile = null;
    const brandDir = path.join(OUT_DIR, 'artifacts', 'brand');
    if (fs.existsSync(brandDir)) {
      for (const f of fs.readdirSync(brandDir)) {
        if (f.endsWith('.json') && !/brand-extract\.json$/.test(f)) {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(brandDir, f), 'utf8'));
            if (j && (j.nav || j.footer)) { brandProfile = j; break; }
          } catch (_) {}
        }
      }
    }
    if (!brandProfile) {
      const legacy = path.join(OUT_DIR, 'brand-extract.json');
      if (fs.existsSync(legacy)) {
        try {
          const j = JSON.parse(fs.readFileSync(legacy, 'utf8'));
          if (j && (j.nav || j.footer)) brandProfile = j;
        } catch (_) {}
      }
    }
    if (brandProfile) {
      const indexHtmlPath = path.join(SCRATCH_DIR, 'index.html');
      if (fs.existsSync(indexHtmlPath)) {
        const html = fs.readFileSync(indexHtmlPath, 'utf8');
        const fidelityDiagnostics = runBrandFidelityChecks(html, brandProfile);
        if (fidelityDiagnostics.length > 0) {
          console.warn(
            `[build-qa] Brand-fidelity scan: ${fidelityDiagnostics.length} diagnostic(s) ` +
            `for "${brandProfile.name || brandProfile.slug || 'brand'}"`
          );
          for (const d of fidelityDiagnostics) {
            console.warn(`  [${d.severity.toUpperCase()}] ${d.category} — ${d.issue}`);
          }
          diagnostics.push(...fidelityDiagnostics);
        } else {
          console.log(
            `[build-qa] Brand-fidelity scan: clean ` +
            `(${(brandProfile.nav && brandProfile.nav.items || []).length} nav labels, ` +
            `${(brandProfile.footer && brandProfile.footer.disclosures || []).length} disclosures)`
          );
        }
      }
    }
  } catch (e) {
    console.warn(`[build-qa] Brand-fidelity scan skipped: ${e.message}`);
  }

  console.log(`[build-qa] Running vision QA on ${prebuiltStepFrames.length} step(s)...`);
  const normalizedDiagnostics = diagnostics.map((d) => ({
    ...d,
    phase: d.phase || inferQaPhase(d),
    deterministicBlocker: isDeterministicBlocker(d),
  }));
  const categoryCounts = {};
  const phaseCounts = {};
  const criticalStepIds = new Set();
  const deterministicBlockedStepIds = new Set();
  const deterministicReasonsSet = new Set();
  for (const d of normalizedDiagnostics) {
    const c = d.category || 'uncategorized';
    categoryCounts[c] = (categoryCounts[c] || 0) + 1;
    const p = d.phase || 'unknown';
    phaseCounts[p] = (phaseCounts[p] || 0) + 1;
    if (d.severity === 'critical' && d.stepId) criticalStepIds.add(d.stepId);
    if (d.deterministicBlocker) {
      if (d.stepId) deterministicBlockedStepIds.add(d.stepId);
      deterministicReasonsSet.add(c);
    }
  }
  const deterministicReasons = Array.from(deterministicReasonsSet);
  const deterministicBlockerCount = deterministicReasons.length;
  const deterministicPassed = deterministicBlockerCount === 0;
  fs.writeFileSync(DIAG_OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    recordParity: RECORD_PARITY,
    headless: HEADLESS,
    deterministicGate: {
      enabled: BUILD_QA_DETERMINISTIC_GATE,
      deterministicPassed,
      blockerCount: deterministicBlockerCount,
      blockedStepIds: [...deterministicBlockedStepIds],
      reasons: deterministicReasons,
    },
    diagnostics: normalizedDiagnostics,
    summary: {
      categoryCounts,
      phaseCounts,
      criticalStepIds: [...criticalStepIds],
      totalDiagnostics: normalizedDiagnostics.length,
      deterministicPassed,
      deterministicBlockerCount,
      deterministicBlockedStepIds: [...deterministicBlockedStepIds],
      deterministicReasons,
    },
  }, null, 2));
  fs.writeFileSync(LEGACY_DIAG_OUT, fs.readFileSync(DIAG_OUT, 'utf8'), 'utf8');
  appendPipelineLogJson('[BUILD-QA] Diagnostics summary', {
    diagnosticsFile: DIAG_OUT,
    totalDiagnostics: normalizedDiagnostics.length,
    categoryCounts,
    phaseCounts,
    criticalStepIds: [...criticalStepIds],
    deterministicPassed,
    deterministicBlockerCount,
    deterministicBlockedStepIds: [...deterministicBlockedStepIds],
    deterministicReasons,
  }, { runDir: OUT_DIR });

  // ── Dynamic font reduction (slide-text-wrap autofix) ─────────────────────
  // Vision QA on slides flagged elements that wrap to ≥2 lines and would fit
  // on a single line at a smaller (≥24px) font-size. Apply the deterministic
  // CSS-override patch in-place RIGHT after diagnostics are written, so
  // subsequent recordings / build-qa walks see the smaller, tighter layout.
  // The current build-qa pass's vision frames were captured before this
  // mutation — that's fine; the next iteration consumes the fix. Failure
  // here is non-fatal: log and continue.
  try {
    if ((categoryCounts['slide-text-wrap'] || 0) > 0) {
      delete require.cache[require.resolve('../utils/qa-patch-library')];
      const patchLib = require('../utils/qa-patch-library');
      const wrapPatch = (patchLib.PATCHES || []).find((p) => p.name === 'slide-text-wrap-fit');
      if (wrapPatch && typeof wrapPatch.apply === 'function') {
        const result = await wrapPatch.apply({ runDir: OUT_DIR });
        console.log(`[build-qa] slide-text-wrap-fit: ${result.applied ? 'applied' : 'skipped'} — ${result.summary}`);
      }
    }
  } catch (e) {
    console.warn(`[build-qa] slide-text-wrap-fit failed (non-fatal): ${e.message}`);
  }

  delete require.cache[require.resolve('./qa-review')];
  const qaReview = require('./qa-review');

  const report = await qaReview.main({
    buildOnly: true,
    prebuiltStepFrames,
    buildQaDiagnostics: normalizedDiagnostics,
    iteration: 'build',
  });
  if (report) {
    report.deterministicGateEnabled = BUILD_QA_DETERMINISTIC_GATE;
    report.deterministicPassed = deterministicPassed;
    report.deterministicBlockerCount = deterministicBlockerCount;
    report.deterministicBlockedStepIds = [...deterministicBlockedStepIds];
    report.deterministicReasons = deterministicReasons;
  }

  try {
    if (report && BUILD_QA_DETERMINISTIC_GATE && !deterministicPassed) {
      report.passed = false;
      const deterministicReason = `Deterministic blocker gate failed: ${deterministicBlockerCount} blocker category(s) (${deterministicReasons.join(', ') || 'unspecified'}).`;
      report.overrideReason = report.overrideReason
        ? `${report.overrideReason} | ${deterministicReason}`
        : deterministicReason;
      const outPath = path.join(OUT_DIR, 'qa-report-build.json');
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.warn('[build-qa] Forced fail: deterministic blocker gate triggered');
      appendPipelineLogSection('[BUILD-QA] Guardrail override', [
        'guardrail=deterministic-blocker-gate',
        `overrideReason=${report.overrideReason}`,
      ], { runDir: OUT_DIR });
    }
  } catch (_) {}

  // Hard guardrail: do not allow a blank/empty final value-summary slide to pass overall build QA.
  try {
    const valueSummary = (report?.steps || []).find((s) => s.stepId === 'value-summary-slide');
    const hasBlankSlideDiag = normalizedDiagnostics.some((d) => d.stepId === 'value-summary-slide' && d.category === 'blank-slide');
    if (report && report.passed && (hasBlankSlideDiag || (valueSummary && Number(valueSummary.score || 0) <= 20))) {
      report.passed = false;
      report.overrideReason = 'Blank or near-empty value-summary-slide detected; forcing build QA fail.';
      const outPath = path.join(OUT_DIR, 'qa-report-build.json');
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.warn('[build-qa] Forced fail: blank value-summary-slide guardrail triggered');
      appendPipelineLogSection('[BUILD-QA] Guardrail override', [
        'guardrail=blank-slide',
        `overrideReason=${report.overrideReason}`,
      ], { runDir: OUT_DIR });
    }
  } catch (_) {}

  // Hard guardrail: timing-contract overrun means narration outlasts visuals.
  const narrationGovernorCriticalCount = (narrationSyncReport?.violations || [])
    .filter((v) => !String(v?.code || '').startsWith('missing-')).length;
  try {
    if (report && report.passed && (timingViolations.length > 0 || timingDupes.length > 0 || narrationWindowMismatches.length > 0 || narrationGovernorCriticalCount > 0)) {
      report.passed = false;
      report.overrideReason = `Timing governor violation: overruns=${timingViolations.length}, duplicateWindows=${timingDupes.length}, narrationWindowMismatches=${narrationWindowMismatches.length}, narrationGovernorViolations=${narrationGovernorCriticalCount}.`;
      const outPath = path.join(OUT_DIR, 'qa-report-build.json');
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.warn('[build-qa] Forced fail: timing governor guardrail triggered');
      appendPipelineLogSection('[BUILD-QA] Guardrail override', [
        'guardrail=timing-governor',
        `overrideReason=${report.overrideReason}`,
      ], { runDir: OUT_DIR });
    }
  } catch (_) {}

  try {
    const debugPayload = {
      generatedAt: new Date().toISOString(),
      boundaryToleranceMs: timingBoundaryToleranceMs,
      source: narrationSyncReport?.timelineRows ? 'validate-narration-sync' : 'build-qa',
      rows: Array.isArray(narrationSyncReport?.timelineRows) && narrationSyncReport.timelineRows.length > 0
        ? narrationSyncReport.timelineRows
        : syncTimelineRows,
    };
    fs.writeFileSync(SYNC_TIMELINE_DEBUG_OUT, JSON.stringify(debugPayload, null, 2));
    fs.writeFileSync(LEGACY_SYNC_TIMELINE_DEBUG_OUT, JSON.stringify(debugPayload, null, 2));
  } catch (_) {}

  try {
    const syncHealth = buildSyncHealthReport({
      demoScript,
      qaReport: report,
      diagnostics: normalizedDiagnostics,
      timingContract,
      narrationSyncReport,
      voiceoverManifest,
      syncTimelineRows: Array.isArray(narrationSyncReport?.timelineRows) && narrationSyncReport.timelineRows.length > 0
        ? narrationSyncReport.timelineRows
        : syncTimelineRows,
    });
    fs.writeFileSync(SYNC_HEALTH_OUT, JSON.stringify(syncHealth, null, 2));
    fs.writeFileSync(LEGACY_SYNC_HEALTH_OUT, JSON.stringify(syncHealth, null, 2));
    appendPipelineLogJson('[BUILD-QA] Sync health summary', {
      syncHealthFile: SYNC_HEALTH_OUT,
      summary: syncHealth.summary,
      narrationSyncSummary: syncHealth.narrationSyncSummary || null,
    }, { runDir: OUT_DIR });
  } catch (err) {
    console.warn(`[build-qa] Could not write sync-health-report: ${err.message}`);
  }

  // ── Tier-aware summary ────────────────────────────────────────────────────
  // After all guardrails have settled report.passed / overrideReason / scores,
  // stamp an `app` vs `slide` tier breakdown + a `recommendedRecovery` hint on
  // the report. This is the single signal the orchestrator + stage-state read
  // to decide whether to route to `slide-fix`, `app-touchup`, or `fullbuild`
  // instead of full `build-app` regeneration.
  try {
    if (report) {
      delete require.cache[require.resolve('../utils/qa-tier-summary')];
      const { computeTierSummary } = require('../utils/qa-tier-summary');
      const tier = computeTierSummary(report, demoScript, { runDir: OUT_DIR });
      report.buildMode = tier.buildMode;
      report.tierSummary = tier.tierSummary;
      report.recommendedRecovery = tier.recommendedRecovery;
      report.systemicReasons = tier.systemicReasons;
      const outPath = path.join(OUT_DIR, 'qa-report-build.json');
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

      // Drift checkpoint: after a passing QA, hash each step block in the
      // scratch-app HTML so downstream stages (record, voiceover, sync) can
      // detect any drift since QA blessed the HTML. On app-only runs the
      // slide-tier entries are omitted entirely by the hash utility.
      if (report.passed === true) {
        try {
          delete require.cache[require.resolve('../utils/slide-content-hash')];
          const { computeHashesForRun } = require('../utils/slide-content-hash');
          const summary = computeHashesForRun(OUT_DIR, { source: 'build-qa', userModifiedSinceQa: false });
          appendPipelineLogJson('[BUILD-QA] slide-content-hash baseline', summary, { runDir: OUT_DIR });
        } catch (hashErr) {
          console.warn(`[build-qa] slide-content-hash baseline skipped: ${hashErr.message}`);
        }
      }

      appendPipelineLogJson('[BUILD-QA] Tier summary', {
        buildMode: tier.buildMode,
        app: {
          passed: tier.tierSummary.app.passed,
          minScore: tier.tierSummary.app.minScore,
          failingStepIds: tier.tierSummary.app.failingStepIds,
        },
        slide: {
          passed: tier.tierSummary.slide.passed,
          skipped: tier.tierSummary.slide.skipped,
          minScore: tier.tierSummary.slide.minScore,
          failingStepIds: tier.tierSummary.slide.failingStepIds,
        },
        recommendedRecovery: tier.recommendedRecovery,
        systemicReasons: tier.systemicReasons,
      }, { runDir: OUT_DIR });
    }
  } catch (err) {
    console.warn(`[build-qa] Could not write tier summary: ${err.message}`);
  }

  const strict = process.env.BUILD_QA_STRICT === 'true' || process.env.BUILD_QA_STRICT === '1';
  if (strict && report && !report.passed) {
    console.error('[build-qa] BUILD_QA_STRICT: QA did not pass threshold');
    appendPipelineLogSection('[BUILD-QA] Strict mode failure', [
      'strict=true',
      'passed=false',
      'exitCode=2',
    ], { runDir: OUT_DIR });
    process.exit(2);
  }

  appendPipelineLogJson('[BUILD-QA] Final result', {
    passed: !!(report && report.passed),
    overallScore: report ? report.overallScore : null,
    passThreshold: report ? report.passThreshold : null,
    deterministicGateEnabled: report ? !!report.deterministicGateEnabled : null,
    deterministicPassed: report ? !!report.deterministicPassed : null,
    deterministicBlockerCount: report ? Number(report.deterministicBlockerCount || 0) : null,
    deterministicBlockedStepIds: report && Array.isArray(report.deterministicBlockedStepIds)
      ? report.deterministicBlockedStepIds
      : [],
    deterministicReasons: report && Array.isArray(report.deterministicReasons)
      ? report.deterministicReasons
      : [],
    overrideReason: report ? report.overrideReason || null : null,
    stepsWithIssues: report && Array.isArray(report.stepsWithIssues)
      ? report.stepsWithIssues.map((s) => ({
          stepId: s.stepId,
          score: s.score,
          critical: !!s.critical,
          issues: s.issues || [],
        }))
      : [],
  }, { runDir: OUT_DIR });

  return report;
}

module.exports = {
  main,
  computeCaptureDelays,
  normalizeGoToStepExpression,
  isSlideLikeStep,
  buildPlaidLaunchCtaIconDiagnostics,
  waitForLoadingToClear,
  evaluateApiStoryAlignment,
  resolveInitialStepId,
  ensureInitialStepVisible,
  hasVisibleActiveStep,
  scanRenderjsonDisclosureStyling,
  scanSlideDesignTokens,
  scanSlideShellChrome,
  scanSlideTypographyFloor,
  scanSlideTypographyCeiling,
  scanSlideCanvasSize,
  scanSlideHostChromeLeak,
  scanSlideHeadlineItalicAccent,
  scanSlideMintOveruse,
  scanSlideForbiddenSalesCta,
  scanSlideInlineBlockLayout,
  scanSlideBackgroundRhythm,
  scanSlideInventedColors,
  scanSlideWorkhorseThemeLeak,
  scanSlideWorkhorseRuntimeLeak,
  scanSlideMotionAttributes,
  scanSlideTextOverlap,
  scanSlideTextWrap,
  scanSlideShowcaseTemplate,
  scanSlideDesignSystem,
  scanAppOnlyNoSlides,
  scanSlideNarrationConcreteValues,
  scanCraHostUnderwritingContracts,
  scanPanelOverlayContract,
  scanSlidePlaidLogoAuthenticity,
  scanSlideChromeLogoPlacement,
  extractStepHtmlBlocks,
  extractSlideStepHtmlBlocks,
  isCanonicalSlidePlaidLogoSrc,
  CANONICAL_SLIDE_PLAID_LOGO_SRC,
};

if (require.main === module) {
  main().catch(err => {
    console.error('[build-qa] Fatal:', err.message);
    process.exit(1);
  });
}
