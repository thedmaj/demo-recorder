#!/usr/bin/env node
'use strict';

/**
 * plaid-link-qa.js
 *
 * Core build-stage smoke test for live Plaid Link launch.
 * - Replays steps up to the Plaid launch click
 * - Verifies /api/create-link-token succeeds
 * - Verifies Plaid Link actually opens (iframe/handler signal)
 * - Writes run artifact: plaid-link-qa.json
 *
 * If launch fails, captures rich diagnostics (network + console + page errors)
 * and exits non-zero so the pipeline halts before build-qa/record.
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { startServer } = require('../utils/app-server');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const SCRATCH_DIR = path.join(OUT_DIR, 'scratch-app');
const PW_SCRIPT = path.join(SCRATCH_DIR, 'playwright-script.json');
const DEMO_SCRIPT = path.join(OUT_DIR, 'demo-script.json');
const REPORT_FILE = path.join(OUT_DIR, 'plaid-link-qa.json');

const QA_WAIT_MS = parseInt(process.env.PLAID_LINK_QA_WAIT_MS || '20000', 10);
const QA_PORT = parseInt(process.env.PLAID_LINK_QA_PORT || '3739', 10);
const HEADLESS = !(
  process.env.PLAID_LINK_QA_HEADLESS === 'false' ||
  process.env.PLAID_LINK_QA_HEADLESS === '0'
);

function writeReport(payload) {
  fs.writeFileSync(
    REPORT_FILE,
    JSON.stringify({ ...payload, checkedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

function normalizeGoToStepExpression(target) {
  return target.startsWith('window.')
    ? target
    : target.startsWith('goToStep(')
      ? `window.${target}`
      : `window.goToStep('${target}')`;
}

async function locateVisible(page, selector) {
  const loc = page.locator(selector).filter({ visible: true }).first();
  await loc.waitFor({ state: 'visible', timeout: 10000 });
  return loc;
}

async function runPlaywrightRow(page, row) {
  if (row.action === 'goToStep') {
    await page.evaluate(normalizeGoToStepExpression(row.target || ''));
    return;
  }
  if (row.action === 'click') {
    const loc = await locateVisible(page, row.target);
    await loc.click({ timeout: 10000, force: true });
    return;
  }
  if (row.action === 'fill') {
    const loc = await locateVisible(page, row.target);
    await loc.fill(row.value || '');
    return;
  }
  if (row.action === 'wait') {
    await page.waitForTimeout(row.waitMs || 500);
  }
}

async function waitForLaunchSignal(page, tokenResponses) {
  const deadline = Date.now() + QA_WAIT_MS;
  while (Date.now() < deadline) {
    const domState = await page.evaluate(() => {
      const iframe =
        document.querySelector('iframe[src*="plaid.com"]') ||
        document.querySelector('iframe[src*="cdn.plaid.com"]') ||
        document.querySelector('iframe[name*="plaid"]');
      return {
        hasPlaidIframe: !!iframe,
        hasHandler: !!window._plaidHandler,
        currentStep: typeof window.getCurrentStep === 'function' ? window.getCurrentStep() : null,
      };
    });

    const tokenOk = tokenResponses.some((r) => r.status === 200);
    if (tokenOk && (domState.hasPlaidIframe || domState.hasHandler)) {
      return { ok: true, domState };
    }
    await page.waitForTimeout(400);
  }
  const domState = await page.evaluate(() => ({
    hasPlaidIframe:
      !!document.querySelector('iframe[src*="plaid.com"]') ||
      !!document.querySelector('iframe[src*="cdn.plaid.com"]') ||
      !!document.querySelector('iframe[name*="plaid"]'),
    hasHandler: !!window._plaidHandler,
    currentStep: typeof window.getCurrentStep === 'function' ? window.getCurrentStep() : null,
  }));
  return { ok: false, domState };
}

function parseJsonSafely(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function main() {
  if (process.env.PLAID_LINK_LIVE !== 'true') {
    console.log('[plaid-link-qa] PLAID_LINK_LIVE != true — skipping.');
    writeReport({ passed: true, skipped: true, reason: 'PLAID_LINK_LIVE=false' });
    return;
  }
  if (!fs.existsSync(path.join(SCRATCH_DIR, 'index.html'))) {
    throw new Error('CRITICAL: plaid-link-qa requires scratch-app/index.html (run build first)');
  }
  if (!fs.existsSync(PW_SCRIPT) || !fs.existsSync(DEMO_SCRIPT)) {
    throw new Error('CRITICAL: plaid-link-qa missing playwright-script.json or demo-script.json');
  }

  const playwrightScript = JSON.parse(fs.readFileSync(PW_SCRIPT, 'utf8'));
  const demoScript = JSON.parse(fs.readFileSync(DEMO_SCRIPT, 'utf8'));
  const launchStep = (demoScript.steps || []).find((s) => s && s.plaidPhase === 'launch');
  if (!launchStep) {
    console.log('[plaid-link-qa] No plaidPhase=launch step found — skipping.');
    writeReport({ passed: true, skipped: true, reason: 'No plaidPhase launch step' });
    return;
  }

  const rows = playwrightScript.steps || [];
  const launchIdx = rows.findIndex((r) => (r.stepId || r.id) === launchStep.id && r.action === 'click');
  if (launchIdx < 0) {
    throw new Error(`CRITICAL: plaid-link-qa could not find launch click row for step "${launchStep.id}"`);
  }

  const tokenResponses = [];
  const tokenRequests = [];
  const consoleErrors = [];
  const pageErrors = [];

  const server = await startServer(QA_PORT, SCRATCH_DIR);
  const expectedServerUrl = `http://localhost:${QA_PORT}`;
  if (server.url !== expectedServerUrl) {
    throw new Error(
      `CRITICAL: plaid-link-qa bound to ${server.url} instead of ${expectedServerUrl}. ` +
      `Another local server is likely using the QA port. Stop conflicting servers and rerun.`
    );
  }
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      consoleErrors.push({ type, text: msg.text() });
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(String(err && err.message ? err.message : err));
  });
  page.on('request', (req) => {
    if (req.url().includes('/api/create-link-token')) {
      let body = null;
      try {
        body = req.postDataJSON();
      } catch (_) {
        body = req.postData() || null;
      }
      tokenRequests.push({ url: req.url(), body });
    }
  });
  page.on('response', async (res) => {
    if (!res.url().includes('/api/create-link-token')) return;
    let body = '';
    try {
      body = await res.text();
    } catch (_) {}
    tokenResponses.push({
      url: res.url(),
      status: res.status(),
      body: (body || '').slice(0, 2000),
    });
  });

  try {
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(600);

    for (let i = 0; i <= launchIdx; i++) {
      const row = rows[i];
      await runPlaywrightRow(page, row);
      const dwell = Math.min(Math.max(row.waitMs || 700, 300), 3500);
      await page.waitForTimeout(dwell);
    }

    const launchResult = await waitForLaunchSignal(page, tokenResponses);
    const offOriginRequests = tokenRequests.filter((r) => !String(r.url || '').startsWith(expectedServerUrl));
    const offOriginResponses = tokenResponses.filter((r) => !String(r.url || '').startsWith(expectedServerUrl));
    const tokenFailures = tokenResponses.filter((r) => r.status >= 400);
    const tokenSuccesses = tokenResponses.filter((r) => r.status === 200);
    const latestTokenSuccess = tokenSuccesses[tokenSuccesses.length - 1] || null;
    const latestSuccessJson = latestTokenSuccess ? parseJsonSafely(latestTokenSuccess.body) : null;
    const hasLinkToken = !!(latestSuccessJson && typeof latestSuccessJson.link_token === 'string' && latestSuccessJson.link_token.length > 0);

    if (offOriginRequests.length || offOriginResponses.length) {
      const detail = {
        passed: false,
        launchStepId: launchStep.id,
        launchRowIndex: launchIdx,
        expectedServerUrl,
        tokenRequests,
        tokenResponses,
        offOriginRequests,
        offOriginResponses,
        domState: launchResult.domState,
        consoleErrors: consoleErrors.slice(-20),
        pageErrors: pageErrors.slice(-20),
      };
      writeReport(detail);
      throw new Error(
        `CRITICAL: Plaid Link QA observed /api/create-link-token traffic outside ${expectedServerUrl}. ` +
        `Possible mixed server context. See ${REPORT_FILE}.`
      );
    }

    if (!tokenSuccesses.length || tokenFailures.length || !hasLinkToken) {
      const detail = {
        passed: false,
        launchStepId: launchStep.id,
        launchRowIndex: launchIdx,
        expectedServerUrl,
        tokenRequests,
        tokenResponses,
        tokenFailures,
        latestTokenSuccess,
        hasLinkToken,
        domState: launchResult.domState,
        consoleErrors: consoleErrors.slice(-20),
        pageErrors: pageErrors.slice(-20),
      };
      writeReport(detail);
      throw new Error(
        `CRITICAL: Plaid Link QA requires /api/create-link-token to return HTTP 200 with link_token ` +
        `and zero token-create failures. See ${REPORT_FILE}.`
      );
    }

    if (!launchResult.ok) {
      const tokenFailure = tokenResponses.find((r) => r.status >= 400) || null;
      const detail = {
        passed: false,
        launchStepId: launchStep.id,
        launchRowIndex: launchIdx,
        expectedServerUrl,
        tokenRequests,
        tokenResponses,
        tokenFailure,
        domState: launchResult.domState,
        consoleErrors: consoleErrors.slice(-20),
        pageErrors: pageErrors.slice(-20),
      };
      writeReport(detail);
      const tokenMsg = tokenFailure ? `; /api/create-link-token status=${tokenFailure.status}` : '';
      throw new Error(
        `CRITICAL: Plaid Link QA failed — launch signal not observed within ${QA_WAIT_MS}ms${tokenMsg}. ` +
        `See ${REPORT_FILE} for diagnostics.`
      );
    }

    writeReport({
      passed: true,
      launchStepId: launchStep.id,
      launchRowIndex: launchIdx,
      expectedServerUrl,
      tokenRequests,
      tokenResponses,
      domState: launchResult.domState,
      consoleErrors: consoleErrors.slice(-10),
      pageErrors: pageErrors.slice(-10),
    });
    console.log('[plaid-link-qa] Plaid Link launch smoke test passed.');
  } finally {
    try { await context.close(); } catch (_) {}
    try { await browser.close(); } catch (_) {}
    try { await server.close(); } catch (_) {}
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('[plaid-link-qa] Fatal:', err.message);
    process.exit(1);
  });
}
