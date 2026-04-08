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
const { resolveMode, getLinkModeAdapter } = require('../utils/link-mode');

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

function extractDataTestid(selector) {
  const m = String(selector || '').match(/^\[data-testid="([^"]+)"\]$/);
  return m ? m[1] : null;
}

async function locateClickFallback(page, selector) {
  const testid = extractDataTestid(selector);
  if (testid) {
    // 1) exact id (fast path)
    const exact = page.locator(`[data-testid="${testid}"]`).filter({ visible: true }).first();
    if (await exact.count()) return exact;

    // 2) strip auto-dedupe suffixes both ways
    const base = testid.replace(/-dup\d+$/, '');
    const byBase = page.locator(`[data-testid="${base}"]`).filter({ visible: true }).first();
    if (await byBase.count()) return byBase;
    const byPrefix = page.locator(`[data-testid^="${base}-dup"]`).filter({ visible: true }).first();
    if (await byPrefix.count()) return byPrefix;
  }

  // 3) semantic data-testid partial fallback from tokenized id
  if (testid) {
    const parts = testid
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .filter((p) => p.length >= 3)
      .slice(0, 3);
    if (parts.length >= 2) {
      const partial = `[data-testid*="${parts[0]}"][data-testid*="${parts[1]}"]`;
      const loc = page.locator(partial).filter({ visible: true }).first();
      if (await loc.count()) return loc;
    }
  }

  // 4) semantic/button-text fallback
  const semanticCandidates = [
    '[data-testid="link-external-account-btn"]',
    '[data-testid*="link"][data-testid*="account"]',
    '[data-testid*="link"][data-testid*="bank"]',
    'button:has-text("Continue with Plaid")',
    'button:has-text("Link your bank")',
    'button:has-text("Link an Account")',
    'button:has-text("Connect")',
    'button:has-text("Pay Bill")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
  ];
  for (const s of semanticCandidates) {
    const loc = page.locator(s).filter({ visible: true }).first();
    if (await loc.count()) return loc;
  }
  return null;
}

async function runPlaywrightRow(page, row) {
  if (row.action === 'goToStep') {
    await page.evaluate(normalizeGoToStepExpression(row.target || ''));
    return;
  }
  if (row.action === 'click') {
    const stepId = row.stepId || row.id || null;
    if (stepId) {
      await page.evaluate((id) => {
        if (typeof window.goToStep === 'function') window.goToStep(id);
      }, stepId);
      await page.waitForTimeout(120);
    }
    let loc = null;
    try {
      loc = await locateVisible(page, row.target);
    } catch (_) {
      loc = await locateClickFallback(page, row.target);
      if (!loc) throw _;
    }
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

async function waitForLaunchSignal(page, tokenResponses, plaidLinkMode = 'modal', linkModeAdapter = null) {
  const deadline = Date.now() + QA_WAIT_MS;
  const adapter = linkModeAdapter || getLinkModeAdapter(plaidLinkMode);
  while (Date.now() < deadline) {
    const domState = await page.evaluate(() => {
      const iframe =
        document.querySelector('iframe[src*="plaid.com"]') ||
        document.querySelector('iframe[src*="cdn.plaid.com"]') ||
        document.querySelector('iframe[name*="plaid"]');
      return {
        hasPlaidIframe: !!iframe,
        hasHandler: !!window._plaidHandler,
        hostedOpened: !!window.__embeddedLinkOpened,
        hostedError: window.__embeddedLinkError || null,
        openedUrls: Array.isArray(window.__qaOpenedUrls) ? window.__qaOpenedUrls.slice(-5) : [],
        currentStep: typeof window.getCurrentStep === 'function' ? window.getCurrentStep() : null,
      };
    });

    const tokenOk = tokenResponses.some((r) => r.status === 200);
    const launchSeen = adapter.isLaunchObserved(domState);
    if (tokenOk && launchSeen) {
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
    hostedOpened: !!window.__embeddedLinkOpened,
    hostedError: window.__embeddedLinkError || null,
    openedUrls: Array.isArray(window.__qaOpenedUrls) ? window.__qaOpenedUrls.slice(-5) : [],
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
  const plaidLinkMode = resolveMode({ demoScript });
  const linkModeAdapter = getLinkModeAdapter(plaidLinkMode);
  const embeddedMode = linkModeAdapter.id === 'embedded';
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
  await context.addInitScript(() => {
    const originalOpen = window.open ? window.open.bind(window) : null;
    window.__qaOpenedUrls = [];
    window.open = function(url, target, features) {
      try {
        window.__qaOpenedUrls.push(String(url || ''));
      } catch (_) {}
      if (originalOpen) {
        try { return originalOpen(url, target, features); } catch (_) {}
      }
      return { closed: false, close: function() {} };
    };
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
      try {
        await runPlaywrightRow(page, row);
      } catch (err) {
        // Non-launch click selectors can drift across generated builds.
        // For launch smoke QA, tolerate pre-launch click misses as long as
        // we can still reach and execute the canonical launch click row.
        const isPreLaunchClick = row && row.action === 'click' && i < launchIdx;
        if (!isPreLaunchClick) throw err;
        console.warn(`[plaid-link-qa] Pre-launch click skipped (${row.target || 'unknown target'}): ${err.message}`);
      }
      const dwell = Math.min(Math.max(row.waitMs || 700, 300), 3500);
      await page.waitForTimeout(dwell);
    }

    const launchResult = await waitForLaunchSignal(page, tokenResponses, linkModeAdapter.id, linkModeAdapter);
    const offOriginRequests = tokenRequests.filter((r) => !String(r.url || '').startsWith(expectedServerUrl));
    const offOriginResponses = tokenResponses.filter((r) => !String(r.url || '').startsWith(expectedServerUrl));
    const tokenFailures = tokenResponses.filter((r) => r.status >= 400);
    const tokenSuccesses = tokenResponses.filter((r) => r.status === 200);
    const latestTokenSuccess = tokenSuccesses[tokenSuccesses.length - 1] || null;
    const latestSuccessJson = latestTokenSuccess ? parseJsonSafely(latestTokenSuccess.body) : null;
    const tokenValidation = linkModeAdapter.validateTokenResponse(latestSuccessJson);
    const hasLinkToken = !!(latestSuccessJson && typeof latestSuccessJson.link_token === 'string' && latestSuccessJson.link_token.length > 0);
    const hasHostedLinkUrl = !!(latestSuccessJson && typeof latestSuccessJson.hosted_link_url === 'string' && latestSuccessJson.hosted_link_url.length > 0);

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

    if (!tokenSuccesses.length || tokenFailures.length || !tokenValidation.ok) {
      const detail = {
        passed: false,
        launchStepId: launchStep.id,
        launchRowIndex: launchIdx,
        expectedServerUrl,
        tokenRequests,
        tokenResponses,
        tokenFailures,
        latestTokenSuccess,
        tokenValidation,
        hasLinkToken,
        hasHostedLinkUrl,
        plaidLinkMode,
        domState: launchResult.domState,
        consoleErrors: consoleErrors.slice(-20),
        pageErrors: pageErrors.slice(-20),
      };
      writeReport(detail);
      throw new Error(
        `CRITICAL: Plaid Link QA requires /api/create-link-token to return HTTP 200 with link_token ` +
        `${embeddedMode ? 'and hosted_link_url ' : ''}and zero token-create failures. ` +
        `Mode=${linkModeAdapter.id}; required fields: ${tokenValidation.requiredFields.join(', ')}. See ${REPORT_FILE}.`
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
      plaidLinkMode,
      expectedServerUrl,
      tokenRequests,
      tokenResponses,
      domState: launchResult.domState,
      launchSignal: linkModeAdapter.launchSignalDescription(),
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
