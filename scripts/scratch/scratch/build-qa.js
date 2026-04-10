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
 *   ANTHROPIC_API_KEY        — required for vision QA
 */

require('dotenv').config({ override: true });
const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');
const { startServer } = require('../utils/app-server');
const { gleanChat } = require('../utils/mcp-clients');
const { loadTimingContract } = require('../../timing-contract');
const { validateNarrationSync, writeReport: writeNarrationSyncReport } = require('../../validate-narration-sync');
const { requireRunDir, getRunLayout } = require('../utils/run-io');
const {
  appendPipelineLogSection,
  appendPipelineLogJson,
} = require('../utils/pipeline-logger');

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

function isPlaidLaunchRow(row, launchStepId) {
  if (!launchStepId) return false;
  const id = row.stepId || row.id;
  // Step ID from plaidPhase:'launch' is authoritative; regex is redundant and causes false
  // negatives when the generated button testid doesn't match (e.g. "link-your-bank-btn").
  return id === launchStepId && row.action === 'click';
}

/** build-qa cannot drive the Plaid iframe; fake onSuccess so post-link steps are testable. */
async function simulateSandboxPlaidLinkComplete(page, demoScript) {
  const steps = demoScript.steps || [];
  const launchIdx = steps.findIndex(s => s && s.plaidPhase === 'launch');
  const nextId = launchIdx >= 0 && launchIdx < steps.length - 1 ? steps[launchIdx + 1].id : null;
  await page.evaluate((nid) => {
    window._plaidLinkComplete = true;
    if (!window._plaidAccountName) window._plaidAccountName = 'Plaid Checking';
    if (!window._plaidAccountMask) window._plaidAccountMask = '0000';
    if (!window._plaidInstitutionName) window._plaidInstitutionName = 'First Platypus Bank';
    if (window._plaidHandler) {
      try { window._plaidHandler.destroy(); } catch (e) {}
    }
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
  const sceneType = String(step?.sceneType || '').toLowerCase();
  if (sceneType) return sceneType === 'slide';
  const haystack = [step?.id, step?.label, step?.visualState].filter(Boolean).join(' ').toLowerCase();
  return /\bslide\b/.test(haystack) && !/\binsight\b/.test(haystack);
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

async function evaluateStepState(page, stepId) {
  return page.evaluate((id) => {
    const stepEl = document.querySelector(`[data-testid="step-${id}"]`);
    const active = document.querySelector('.step.active');
    const apiPanel = document.getElementById('api-response-panel');
    const linkPanel = document.getElementById('link-events-panel');
    const stepStyle = stepEl ? window.getComputedStyle(stepEl) : null;
    const apiStyle = apiPanel ? window.getComputedStyle(apiPanel) : null;
    const linkStyle = linkPanel ? window.getComputedStyle(linkPanel) : null;
    const apiBody = document.getElementById('api-response-content');
    const apiBodyContainer = apiPanel ? apiPanel.querySelector('.side-panel-body') : null;
    const endpoint = document.getElementById('api-panel-endpoint');
    const apiToggle = document.querySelector('[data-testid="api-panel-toggle"], #api-panel-toggle');
    const apiJsonShow = document.querySelector('[data-testid="api-json-panel-show"], #api-json-panel-show');
    const apiJsonHide = document.querySelector('[data-testid="api-json-panel-hide"], #api-json-panel-hide');
    const slideRoot = active ? active.querySelector('.slide-root') : null;
    const slideRootStyle = slideRoot ? window.getComputedStyle(slideRoot) : null;
    const slideInlineStyle = slideRoot ? String(slideRoot.getAttribute('style') || '') : '';
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
      apiPanelVisible: isVisible(apiPanel, apiStyle),
      apiBodyVisible: apiBodyContainer ? window.getComputedStyle(apiBodyContainer).display !== 'none' : false,
      apiBodyOverflowY: apiBodyContainer ? window.getComputedStyle(apiBodyContainer).overflowY : '',
      apiJsonToggleExists: Boolean(apiToggle),
      apiJsonShowExists: Boolean(apiJsonShow),
      apiJsonHideExists: Boolean(apiJsonHide),
      apiPanelChromeTriplet:
        Boolean(apiJsonShow) && Boolean(apiJsonHide) && Boolean(apiToggle),
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
      activeStepText: (active?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
      activeStepPreCodeCount: active ? active.querySelectorAll('pre, code').length : 0,
      activeStepJsonHintNodeCount: active ? active.querySelectorAll('[class*="json"], [id*="json"], [data-testid*="json"]').length : 0,
      slideRootInlineStyleHasFixedSize: /\b(?:width|height|min-width|min-height|max-width|max-height)\s*:\s*\d+px\b/i.test(slideInlineStyle),
      slideRootComputedWidth: slideRootStyle ? parseFloat(slideRootStyle.width || '0') : 0,
      viewportWidth: window.innerWidth || document.documentElement.clientWidth || 0,
      activeStepHasMobileShellTarget: Boolean(active?.classList?.contains('mobile-shell-target')),
      activeStepHasMobileSimulatorShell: Boolean(active?.querySelector('[data-testid="mobile-simulator-shell"]')),
      hasOnboardingCompleteStep: Boolean(document.querySelector('[data-testid="step-onboarding-complete"]')),
      layerShareConfirmOnclick: layerShareConfirmBtn ? String(layerShareConfirmBtn.getAttribute('onclick') || '') : '',
      piiContinueOnclick: piiContinueBtn ? String(piiContinueBtn.getAttribute('onclick') || '') : '',
      activePiiInputCount: activePiiInputs.length,
      activeStepHasPlaidLinkLaunchBtn: Boolean(active?.querySelector('[data-testid="link-external-account-btn"]')),
      plaidLaunchCtaMetrics,
      layerHelperText: (layerHelper?.textContent || '').replace(/\s+/g, ' ').trim(),
      layerHelperVisible: isVisible(layerHelper, layerHelperStyle),
      activePhoneInputValue: activePhoneInput ? String(activePhoneInput.value || '').trim() : '',
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
      nonPanelInlineSvgHints: nonPanelInlineSvgs.slice(0, 8).map((svg) =>
        String(svg.getAttribute('data-testid') || svg.getAttribute('aria-label') || svg.className || 'inline-svg').slice(0, 64)
      ),
      dataUriImageCount: dataUriImgs.length,
      syntheticIconCount: syntheticIconNodes.length,
      syntheticIconHints: syntheticIconNodes.slice(0, 8).map((el) =>
        String(el.getAttribute('data-testid') || el.className || el.tagName || 'icon-node').slice(0, 64)
      ),
    };
  });
}

function evaluateApiStoryAlignment(step) {
  const issues = [];
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
      key: 'income',
      storyPattern: /\bincome|income[_\s-]?insights|stream|payroll|next payment\b/i,
      endpointPattern: /income[_\s-]?insights/,
      responseHints: ['income', 'income_stream', 'predicted_next_payment', 'historical_average_monthly_income', 'forecasted_average_monthly_income'],
      label: 'income-insights context',
    },
    {
      key: 'baseReport',
      storyPattern: /\bbase report|ownership|balances|inflows|outflows|days available\b/i,
      endpointPattern: /base[_\s-]?report/,
      responseHints: ['accounts', 'balances', 'ownership', 'inflows', 'outflows', 'days_available'],
      label: 'base-report context',
    },
    {
      key: 'signal',
      storyPattern: /\bsignal|ach|return risk|fraud|risk score\b/i,
      endpointPattern: /signal/,
      responseHints: ['score', 'risk', 'decision', 'recommendation', 'reason'],
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
      key: 'auth',
      storyPattern: /\bauth|routing|account number|ach rails|wire routing|depository\b/i,
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
    if (!state.logoPresent || !state.logoVisible || !state.logoLoaded) {
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
      const isThemeLightAsset = /\/theme\/light\//i.test(logoSrc);
      const navIsLight = typeof state.navBgLuminance === 'number' && state.navBgLuminance > 0.82;
      if (isThemeLightAsset && navIsLight) {
        diagnostics.push({
          stepId: firstStepId || 'build',
          category: 'missing-logo',
          severity: 'critical',
          issue: `Logo contrast risk at ${vp.label}: using Brandfetch /theme/light/ asset on light navigation background.`,
          suggestion: 'Use a contrast-safe wordmark variant (prefer /theme/dark/) or enforce a dark logo shell background.',
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

  const launchBtn = '[data-testid="link-external-account-btn"]';
  try {
    const loc = await locateVisible(page, launchBtn);
    const beforeErrors = pageErrors.length;
    await loc.click({ timeout: 8000, force: true });
    await page.waitForTimeout(400);
    const hasHandler = await page.evaluate(() => Boolean(window._plaidHandler));
    if (!hasHandler) {
      diagnostics.push({
        stepId: launchId,
        category: 'plaid-link-mobile-launch',
        severity: 'critical',
        issue: 'Plaid handler is not initialized when launching from mobile-simulated view.',
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
      issue: `Could not click mobile Plaid launch button "${launchBtn}": ${err.message}`,
      suggestion: 'Ensure the launch CTA exists and remains visible in mobile-simulated mode.',
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

async function ensureApiPanelContractForStep(page, stepId) {
  return page.evaluate((id) => {
    const panel = document.getElementById('api-response-panel');
    const body = panel ? panel.querySelector('.side-panel-body') : null;
    const content = document.getElementById('api-response-content');
    if (!panel || !body) return;
    const responses = window._stepApiResponses || {};
    const data = responses[id];
    if (data && content && !(content.textContent || '').trim()) {
      try {
        const pretty = JSON.stringify(data, null, 2);
        if (typeof window.syntaxHighlight === 'function') content.innerHTML = window.syntaxHighlight(pretty);
        else content.textContent = pretty;
      } catch (_) {}
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
    if (data && typeof window.updateApiResponse === 'function') {
      try {
        window.updateApiResponse(data);
      } catch (_) { /* ignore */ }
    }
    const content = document.getElementById('api-response-content');
    if (data && content && !(content.textContent || '').trim()) {
      try {
        const pretty = JSON.stringify(data, null, 2);
        if (typeof window.syntaxHighlight === 'function') content.innerHTML = window.syntaxHighlight(pretty);
        else content.textContent = pretty;
      } catch (_) { /* ignore */ }
    }
    panel.style.removeProperty('display');
    panel.classList.add('visible');
    panel.classList.remove('api-json-collapsed');
    const body = panel.querySelector('.side-panel-body');
    if (body) {
      body.style.removeProperty('display');
      body.style.display = 'block';
    }
  }, stepId);
}

function buildStepAssertions(step, state) {
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
          issue:
            'API JSON rail is missing required header controls (data-testid="api-json-panel-show", ' +
            '"api-json-panel-hide", and "api-panel-toggle").',
          suggestion: 'Merge templates/slide-template/pipeline-slide-shell.html panel header — all three controls + toggleApiPanel().',
        });
      }
      if (!state.apiPanelVisible) {
        diagnostics.push({
          stepId: step.id,
          category: 'panel-visibility',
          severity: 'critical',
          issue: 'api-response-panel is not visible after build-QA JSON rail prep — panel must display for apiResponse steps.',
          suggestion: 'Ensure goToStep or updateApiResponse shows #api-response-panel (display:flex + .visible) for insight steps.',
        });
      }
      if (state.apiPanelChromeTriplet && !state.hasToggleApiFunction) {
        diagnostics.push({
          stepId: step.id,
          category: 'panel-collapse-contract',
          severity: 'warning',
          issue: 'window.toggleApiPanel() is missing — header buttons should call a shared toggle implementation.',
          suggestion: 'Define toggleApiPanel() per templates/slide-template/PIPELINE_SLIDE_SHELL_RULES.md.',
        });
      }
      if (state.apiContentLength < MIN_JSON_PANEL_CHARS) {
        diagnostics.push({
          stepId: step.id,
          category: 'missing-panel',
          severity: 'critical',
          issue: `API panel #api-response-content is empty or too short (${state.apiContentLength} chars; need sample JSON).`,
          suggestion: 'Hydrate from demo-script apiResponse via window._stepApiResponses and updateApiResponse() / renderjson.',
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
      suggestion: 'Use responsive .slide-root sizing from SLIDE_RULES; avoid fixed px width/height.',
    });
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
  if (needsLayerHelperAudit) {
    const helperText = String(state.layerHelperText || '');
    const hasEligibleNumber = helperText.includes('415-555-1111');
    const hasIneligibleNumber = helperText.includes('415-555-0011');
    if (!state.layerHelperVisible || !hasEligibleNumber || !hasIneligibleNumber) {
      diagnostics.push({
        stepId: step.id,
        category: 'layer-helper-text-contract',
        severity: 'critical',
        issue: 'Layer helper text below mobile frame is missing, hidden, or missing required eligible/ineligible phone numbers.',
        suggestion: 'Render visible helper text below the mobile frame with 415-555-1111 (eligible) and 415-555-0011 (ineligible fallback).',
      });
    }
  }
  if (isLayerEligibilityCapture) {
    const phoneVal = String(state.activePhoneInputValue || '');
    if (phoneVal && !/415\D*555\D*1111/.test(phoneVal)) {
      diagnostics.push({
        stepId: step.id,
        category: 'layer-helper-text-contract',
        severity: 'critical',
        issue: `Layer eligibility capture phone input is not prefilled with eligible number (found "${phoneVal}").`,
        suggestion: 'Prefill phone input with 415-555-1111 as default for Layer flows.',
      });
    }
    if (!phoneVal) {
      diagnostics.push({
        stepId: step.id,
        category: 'layer-helper-text-contract',
        severity: 'warning',
        issue: 'Layer eligibility capture step has no detectable phone prefill value.',
        suggestion: 'Prefill the phone input with 415-555-1111 to make eligible path the default first experience.',
      });
    }
  }
  if (isSlideLikeStep(step) && !state.activeStepHasSlideRoot) {
    diagnostics.push({
      stepId: step.id,
      category: 'slide-template-misuse',
      severity: 'warning',
      issue: 'A slide-like step does not include the expected .slide-root structure.',
      suggestion: 'Render slide scenes using the shared slide template contract.',
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
async function captureStepFrames(page, stepId, rowIndex, dwellMs) {
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
      captureError('selector-missing', `Could not click selector "${stepEntry.target}": ${err.message}`, 'Ensure the expected clickable element exists, is visible, and uses the requested selector.');
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
  const mobileVisualEnabled = opts.mobileVisualEnabled != null
    ? !!opts.mobileVisualEnabled
    : MOBILE_VISUAL_ENABLED;

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
  try {
    const html = fs.readFileSync(path.join(SCRATCH_DIR, 'index.html'), 'utf8');
    diagnostics.push(...scanDuplicateBankMarks(html, demoScript));
    diagnostics.push(...scanMissingBrandLogo(html, demoScript));
  } catch (_) {}

  // Sanity guard: ensure the loaded page actually contains the expected step containers.
  // Without this, downstream selector checks produce misleading false negatives.
  const expectedStepTestids = new Set(demoStepIds.map((id) => `step-${id}`));
  let domStepIds = [];
  try {
    await page.waitForSelector('.step[data-testid]', { timeout: 12000 });
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

  const rows = playwrightScript.steps || [];
  console.log(`[build-qa] Walking ${rows.length} playwright row(s)...`);
  const launchStepId = getPlaidLaunchStepId(demoScript);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const stepId = row.stepId || row.id;
    const step = stepMap.get(stepId);
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
    const result = await runPlaywrightRow(page, row);
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
    if (isPlaidLaunchRow(row, launchStepId)) {
      try {
        await forceStepActive(page, stepId);
        await page.waitForTimeout(400);
      } catch (_) {}
    }

    if (step && stepRequiresGlobalJsonRail(step)) {
      try {
        await prepareGlobalJsonRailForBuildQa(page, stepId);
        await page.waitForTimeout(160);
      } catch (_) {}
    }

    try {
      const frames = await captureStepFrames(page, stepId, i, result.dwellMs);
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
        diagnostics.push(...buildStepAssertions(step, state));
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

    if (isPlaidLaunchRow(row, launchStepId)) {
      console.log('[build-qa] Simulating Plaid Link success (sandbox) — iframe not automated in build-qa');
      await simulateSandboxPlaidLinkComplete(page, demoScript);
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

  await context.close();
  await browser.close();
  await server.close();

  const prebuiltStepFrames = [];
  for (const stepId of demoStepIds) {
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

  console.log(`[build-qa] Running vision QA on ${prebuiltStepFrames.length} step(s)...`);
  const normalizedDiagnostics = diagnostics.map((d) => ({ ...d, phase: d.phase || inferQaPhase(d) }));
  const categoryCounts = {};
  const phaseCounts = {};
  const criticalStepIds = new Set();
  for (const d of normalizedDiagnostics) {
    const c = d.category || 'uncategorized';
    categoryCounts[c] = (categoryCounts[c] || 0) + 1;
    const p = d.phase || 'unknown';
    phaseCounts[p] = (phaseCounts[p] || 0) + 1;
    if (d.severity === 'critical' && d.stepId) criticalStepIds.add(d.stepId);
  }
  fs.writeFileSync(DIAG_OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    recordParity: RECORD_PARITY,
    headless: HEADLESS,
    diagnostics: normalizedDiagnostics,
    summary: {
      categoryCounts,
      phaseCounts,
      criticalStepIds: [...criticalStepIds],
      totalDiagnostics: normalizedDiagnostics.length,
    },
  }, null, 2));
  fs.writeFileSync(LEGACY_DIAG_OUT, fs.readFileSync(DIAG_OUT, 'utf8'), 'utf8');
  appendPipelineLogJson('[BUILD-QA] Diagnostics summary', {
    diagnosticsFile: DIAG_OUT,
    totalDiagnostics: normalizedDiagnostics.length,
    categoryCounts,
    phaseCounts,
    criticalStepIds: [...criticalStepIds],
  }, { runDir: OUT_DIR });
  delete require.cache[require.resolve('./qa-review')];
  const qaReview = require('./qa-review');

  const report = await qaReview.main({
    buildOnly: true,
    prebuiltStepFrames,
    buildQaDiagnostics: normalizedDiagnostics,
    iteration: 'build',
  });

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
};

if (require.main === module) {
  main().catch(err => {
    console.error('[build-qa] Fatal:', err.message);
    process.exit(1);
  });
}
