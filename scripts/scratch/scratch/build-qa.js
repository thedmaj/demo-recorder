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
 *   ANTHROPIC_API_KEY        — required for vision QA
 */

require('dotenv').config({ override: true });
const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');
const { startServer } = require('../utils/app-server');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR      = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const SCRATCH_DIR  = path.join(OUT_DIR, 'scratch-app');
const PW_SCRIPT    = path.join(SCRATCH_DIR, 'playwright-script.json');
const DEMO_SCRIPT  = path.join(OUT_DIR, 'demo-script.json');
const FRAMES_DIR   = path.join(OUT_DIR, 'qa-frames');
const DIAG_OUT     = path.join(OUT_DIR, 'build-qa-diagnostics.json');

const MAX_WAIT     = parseInt(process.env.BUILD_QA_MAX_WAIT_MS || '15000', 10);
const PLAID_CLICK_WAIT = parseInt(process.env.BUILD_QA_PLAID_CLICK_MS || '10000', 10);
const RECORD_PARITY = process.env.BUILD_QA_RECORD_PARITY === 'true' || process.env.BUILD_QA_RECORD_PARITY === '1';
const HEADLESS      = process.env.BUILD_QA_HEADLESS != null
  ? !(process.env.BUILD_QA_HEADLESS === 'false' || process.env.BUILD_QA_HEADLESS === '0')
  : !RECORD_PARITY;

const PLAID_BTN_RE = /link[-_]external[-_]account|connect[-_]bank|open[-_]link|link[-_]account[-_]btn|btn[-_]link|link[-_]bank|start[-_]link|initiate[-_]link|plaid[-_]link[-_]btn/i;

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
  const haystack = [step?.id, step?.label, step?.visualState].filter(Boolean).join(' ').toLowerCase();
  return /\bslide\b/.test(haystack);
}

async function locateVisible(page, selector) {
  const loc = page.locator(selector).filter({ visible: true }).first();
  await loc.waitFor({ state: 'visible', timeout: 8000 });
  return loc;
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
    const endpoint = document.getElementById('api-panel-endpoint');
    const isVisible = (el, style) => {
      if (!el || !style) return false;
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0 && rect.width > 0 && rect.height > 0;
    };
    return {
      currentStep: typeof window.getCurrentStep === 'function' ? window.getCurrentStep() : null,
      activeStepTestid: active?.dataset?.testid || null,
      stepExists: Boolean(stepEl),
      stepVisible: isVisible(stepEl, stepStyle),
      apiPanelExists: Boolean(apiPanel),
      apiPanelVisible: isVisible(apiPanel, apiStyle),
      linkPanelVisible: isVisible(linkPanel, linkStyle),
      apiContentLength: (apiBody?.textContent || '').trim().length,
      apiEndpointText: (endpoint?.textContent || '').trim(),
      activeStepHasSlideRoot: Boolean(active?.querySelector('.slide-root')),
    };
  }, stepId);
}

function buildStepAssertions(step, state) {
  const diagnostics = [];
  const expectedStepTestid = `step-${step.id}`;
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
  if (step.apiResponse?.response) {
    if (!state.apiPanelExists) {
      diagnostics.push({
        stepId: step.id,
        category: 'missing-panel',
        severity: 'critical',
        issue: 'An API insight step is missing the global api-response-panel element.',
        suggestion: 'Include the global api-response-panel and show it from goToStep for insight steps.',
      });
    } else if (!state.apiPanelVisible) {
      diagnostics.push({
        stepId: step.id,
        category: 'panel-visibility',
        severity: 'critical',
        issue: 'The API response panel is hidden on an insight step that should show response JSON.',
        suggestion: 'Show the global api-response-panel for steps with apiResponse data.',
      });
    } else if (!state.apiContentLength) {
      diagnostics.push({
        stepId: step.id,
        category: 'missing-panel',
        severity: 'critical',
        issue: 'The API response panel is visible but empty.',
        suggestion: 'Populate the panel from apiResponse.response or window._stepApiResponses for this step.',
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
  if (isSlideLikeStep(step) && !state.activeStepHasSlideRoot) {
    diagnostics.push({
      stepId: step.id,
      category: 'slide-template-misuse',
      severity: 'warning',
      issue: 'A slide-like step does not include the expected .slide-root structure.',
      suggestion: 'Render slide scenes using the shared slide template contract.',
    });
  }
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
          const loc = await locateVisible(page, a.selector);
          await loc.click({ timeout: 8000, force: true });
        } catch (err) {
          captureError('selector-missing', `Could not click selector "${a.selector}": ${err.message}`, 'Ensure the expected interactive element exists, is visible, and has the required data-testid.');
        }
      } else if (a.type === 'fill') {
        try {
          const loc = await locateVisible(page, a.selector);
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
      const loc = await locateVisible(page, stepEntry.target);
      await loc.click({ timeout: 8000, force: true });
    } catch (err) {
      captureError('selector-missing', `Could not click selector "${stepEntry.target}": ${err.message}`, 'Ensure the expected clickable element exists, is visible, and uses the requested selector.');
    }
  } else if (stepEntry.action === 'fill') {
    try {
      const loc = await locateVisible(page, stepEntry.target);
      await loc.fill(stepEntry.value || '');
    } catch (err) {
      captureError('selector-missing', `Could not fill selector "${stepEntry.target}": ${err.message}`, 'Ensure the expected input exists, is visible, and can be filled by Playwright.');
    }
  }

  return { dwellMs, errors };
}

async function main() {
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

  const server = await startServer(3739, SCRATCH_DIR);
  const url    = server.url;
  console.log(`[build-qa] Serving app at ${url}`);

  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: RECORD_PARITY ? 2 : 1,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(800);

  const stepMap = new Map((demoScript.steps || []).map(step => [step.id, step]));
  /** @type {Record<string, Array<{label:string,path:string}>>} */
  const stepFramesById = {};
  const diagnostics = [];

  const rows = playwrightScript.steps || [];
  console.log(`[build-qa] Walking ${rows.length} playwright row(s)...`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const stepId = row.stepId || row.id;
    const step = stepMap.get(stepId);
    const result = await runPlaywrightRow(page, row);
    diagnostics.push(...result.errors);

    try {
      const frames = await captureStepFrames(page, stepId, i, result.dwellMs);
      if (frames.length > 0) {
        stepFramesById[stepId] = frames;
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
        const state = await evaluateStepState(page, stepId);
        diagnostics.push(...buildStepAssertions(step, state));
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
  const categoryCounts = {};
  const criticalStepIds = new Set();
  for (const d of diagnostics) {
    const c = d.category || 'uncategorized';
    categoryCounts[c] = (categoryCounts[c] || 0) + 1;
    if (d.severity === 'critical' && d.stepId) criticalStepIds.add(d.stepId);
  }
  fs.writeFileSync(DIAG_OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    recordParity: RECORD_PARITY,
    headless: HEADLESS,
    diagnostics,
    summary: {
      categoryCounts,
      criticalStepIds: [...criticalStepIds],
      totalDiagnostics: diagnostics.length,
    },
  }, null, 2));
  delete require.cache[require.resolve('./qa-review')];
  const qaReview = require('./qa-review');

  const report = await qaReview.main({
    buildOnly: true,
    prebuiltStepFrames,
    buildQaDiagnostics: diagnostics,
    iteration: 'build',
  });

  const strict = process.env.BUILD_QA_STRICT === 'true' || process.env.BUILD_QA_STRICT === '1';
  if (strict && report && !report.passed) {
    console.error('[build-qa] BUILD_QA_STRICT: QA did not pass threshold');
    process.exit(2);
  }

  return report;
}

module.exports = {
  main,
  computeCaptureDelays,
  normalizeGoToStepExpression,
  isSlideLikeStep,
};

if (require.main === module) {
  main().catch(err => {
    console.error('[build-qa] Fatal:', err.message);
    process.exit(1);
  });
}
