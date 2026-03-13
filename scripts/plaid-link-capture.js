'use strict';
/**
 * plaid-link-capture.js
 * Runs a real Plaid Link session (headless:false for OOPIF capture) and takes
 * a screenshot of each Plaid Link screen that corresponds to a link-* step in
 * demo-script.json.  Screenshots are written to {runDir}/plaid-link-screens/
 * and used by build-app.js to give the build agent pixel-accurate visual
 * references for the simulated Plaid Link step divs.
 *
 * Flow-type detection:
 *   remember-me — any link step label/narration contains "remember me",
 *                  "returning user", or "saved institution"
 *   standard    — otherwise (search → credentials → account select)
 *
 * Reads:  {PIPELINE_RUN_DIR}/demo-script.json
 * Writes: {PIPELINE_RUN_DIR}/plaid-link-screens/{stepId}.png  (one per link step)
 *         {PIPELINE_RUN_DIR}/plaid-link-screens/manifest.json
 *
 * Usage (standalone):
 *   node scripts/plaid-link-capture.js
 * Called by orchestrator as a stage:
 *   await require('./plaid-link-capture').main()
 */

require('dotenv').config({ override: true });

const { chromium }  = require('playwright');
const fs            = require('fs');
const path          = require('path');
const http          = require('http');
const { startServer } = require('./scratch/utils/app-server');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT  = path.resolve(__dirname, '..');
const OUT_DIR       = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const SCRIPT_FILE   = path.join(OUT_DIR, 'demo-script.json');
const SCREENS_DIR   = path.join(OUT_DIR, 'plaid-link-screens');
// Temp dir for the minimal capture page (served by app-server)
const CAPTURE_APP_DIR = path.join(OUT_DIR, '_plaid-link-capture-app');

// Sandbox credentials (mirrors record-local.js defaults)
const PLAID_SANDBOX_PHONE       = process.env.PLAID_SANDBOX_PHONE       || '+14155550011';
const PLAID_SANDBOX_OTP         = process.env.PLAID_SANDBOX_OTP         || '123456';
const PLAID_SANDBOX_USERNAME    = process.env.PLAID_SANDBOX_USERNAME    || 'user_good';
const PLAID_SANDBOX_PASSWORD    = process.env.PLAID_SANDBOX_PASSWORD    || 'pass_good';
const PLAID_SANDBOX_INSTITUTION = process.env.PLAID_SANDBOX_INSTITUTION || 'First Platypus Bank';

// Dwell time (ms) after each transition before capturing — lets the screen fully render
const SCREEN_DWELL_MS = 1800;

// ── Minimal capture page HTML ─────────────────────────────────────────────────

const CAPTURE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 1440px; height: 900px; overflow: hidden;
      background: #0d1117; display: flex; align-items: center;
      justify-content: center; font-family: system-ui, sans-serif; }
    #status { color: rgba(255,255,255,0.5); font-size: 14px; }
  </style>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
</head>
<body>
  <div id="status">Initialising Plaid Link…</div>
  <script>
    window._plaidLinkComplete   = false;
    window._plaidTransitionCount = 0;
    window._plaidOAuthDetected  = false;
    window._plaidMeta           = null;
    window._plaidTokenReady     = false;

    fetch('/api/create-link-token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ client_name: 'Plaid Demo' }),
    })
      .then(r => r.json())
      .then(data => {
        window._plaidHandler = Plaid.create({
          token:     data.link_token,
          onSuccess: (pt, meta) => {
            window._plaidLinkComplete = true;
            window._plaidMeta = meta;
          },
          onExit: () => {},
          onEvent: (name) => {
            if (name === 'TRANSITION_VIEW') window._plaidTransitionCount++;
            if (name === 'OPEN_OAUTH')      window._plaidOAuthDetected = true;
          },
        });
        window._plaidTokenReady = true;
        document.getElementById('status').textContent = 'Ready — opening Plaid Link…';
      })
      .catch(err => {
        document.getElementById('status').textContent = 'Token error: ' + err.message;
      });
  </script>
</body>
</html>`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Detect flow type from demo-script link steps.
 * Returns 'remember-me' or 'standard'.
 */
function detectFlowType(linkSteps) {
  const text = linkSteps
    .map(s => `${s.id} ${s.label || ''} ${s.narration || ''}`)
    .join(' ')
    .toLowerCase();
  if (/remember[\s-]me|returning user|saved institution|recognizes/.test(text)) {
    return 'remember-me';
  }
  return 'standard';
}

/**
 * Wait for _plaidTransitionCount to increase (new screen appeared).
 * Returns the new count, or the current count on timeout.
 */
async function waitForTransition(page, currentCount, timeoutMs = 10000) {
  try {
    await page.waitForFunction(
      (n) => (window._plaidTransitionCount || 0) > n,
      currentCount,
      { timeout: timeoutMs, polling: 100 },
    );
  } catch (_) {
    console.warn('  [capture] Transition wait timed out — proceeding anyway');
  }
  await sleep(SCREEN_DWELL_MS);
  return await page.evaluate(() => window._plaidTransitionCount || 0).catch(() => currentCount + 1);
}

/**
 * Take a CDP screenshot of the full page (captures Plaid Link OOPIF via GPU compositor).
 */
async function captureScreen(page, stepId, screensDir) {
  const outPath = path.join(screensDir, `${stepId}.png`);
  await page.screenshot({ path: outPath, fullPage: false });
  const size = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`  [capture] ✓ Captured ${stepId}.png (${size} KB)`);
  return outPath;
}

/**
 * Click a button matching any of the provided text labels inside the Plaid frame.
 */
async function clickButton(frame, labels, timeoutMs = 5000) {
  for (const label of labels) {
    const btn = frame.getByRole('button', { name: label, exact: false }).first();
    if (await btn.isVisible({ timeout: timeoutMs }).catch(() => false)) {
      await btn.click({ force: true }).catch(() => {});
      console.log(`  [capture] Clicked button: "${label}"`);
      return true;
    }
    // Also try getByText as fallback
    const txt = frame.getByText(label, { exact: false }).first();
    if (await txt.isVisible({ timeout: 500 }).catch(() => false)) {
      await txt.click({ force: true }).catch(() => {});
      console.log(`  [capture] Clicked text: "${label}"`);
      return true;
    }
  }
  return false;
}

/**
 * Run the capture session.
 * Navigates through the real Plaid Link sandbox, taking a screenshot for
 * each link step ID before interacting with that screen.
 *
 * @param {import('playwright').Page} page
 * @param {object[]} linkSteps  — link-* steps from demo-script.json
 * @param {'remember-me'|'standard'} flowType
 * @param {string} screensDir  — output directory for screenshots
 * @returns {Promise<Array<{stepId, path}>>}
 */
async function runCaptureSession(page, linkSteps, flowType, screensDir) {
  const captures = [];
  const isRememberMe = flowType === 'remember-me';

  // ── Wait for link token and open Plaid Link ──────────────────────────────
  console.log('  [capture] Waiting for link token…');
  await page.waitForFunction(() => window._plaidTokenReady === true, null, { timeout: 30000 });
  await page.evaluate(() => window._plaidHandler && window._plaidHandler.open());
  console.log('  [capture] Plaid Link opened');

  // Wait for the iframe to become visible
  const iframeSelector = 'iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]';
  await page.waitForSelector(iframeSelector, { state: 'visible', timeout: 30000 });
  await sleep(3000); // let first screen fully render
  const frame = page.frameLocator(iframeSelector);

  let transitionCount = await page.evaluate(() => window._plaidTransitionCount || 0).catch(() => 0);
  let stepIndex = 0;

  // ── REMEMBER-ME FLOW ─────────────────────────────────────────────────────
  if (isRememberMe) {
    // Screen 1: Phone entry → maps to first link step (link-consent)
    if (stepIndex < linkSteps.length) {
      await captureScreen(page, linkSteps[stepIndex].id, screensDir);
      captures.push({ stepId: linkSteps[stepIndex].id });
      stepIndex++;
    }

    // Fill phone number to advance to OTP screen
    const phoneInput = frame.locator(
      'input[type="tel"], input[name="phone"], input[placeholder*="phone" i]'
    ).first();
    if (await phoneInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await phoneInput.fill(PLAID_SANDBOX_PHONE);
      transitionCount = await waitForTransition(page, transitionCount);
      console.log('  [capture] Phone filled — transitioned to OTP');
    } else {
      // Skip phone link
      await clickButton(frame, ['Continue without phone number', 'without phone number', 'Skip']);
      transitionCount = await waitForTransition(page, transitionCount);
    }

    // Screen 2: OTP → maps to second link step (link-otp)
    if (stepIndex < linkSteps.length) {
      await captureScreen(page, linkSteps[stepIndex].id, screensDir);
      captures.push({ stepId: linkSteps[stepIndex].id });
      stepIndex++;
    }

    // Fill OTP to advance to institution list
    const otpInput = frame.locator(
      'input[inputmode="numeric"], input[type="tel"], input[maxlength="6"]'
    ).first();
    if (await otpInput.isVisible({ timeout: 8000 }).catch(() => false)) {
      await otpInput.fill(PLAID_SANDBOX_OTP);
      await sleep(500);
      await clickButton(frame, ['Continue', 'Verify', 'Confirm', 'Submit']);
      transitionCount = await waitForTransition(page, transitionCount, 12000);
      console.log('  [capture] OTP filled — transitioned to institution list');
    }

    // Screen 3: Institution list / account-select → maps to third link step
    if (stepIndex < linkSteps.length) {
      await captureScreen(page, linkSteps[stepIndex].id, screensDir);
      captures.push({ stepId: linkSteps[stepIndex].id });
      stepIndex++;
    }

    // Select institution (first non-OAuth one)
    const instList = frame.locator('ul li').first();
    if (await instList.isVisible({ timeout: 8000 }).catch(() => false)) {
      await sleep(1000); // brief dwell so viewer can read the list
      // Try up to 3 institutions to find a non-OAuth one
      const liLocators = frame.locator('ul li');
      const count = await liLocators.count().catch(() => 1);
      for (let i = 0; i < Math.min(count, 3); i++) {
        const li = liLocators.nth(i);
        await li.click({ force: true }).catch(() => {});
        const oauthDetected = await page.waitForFunction(
          () => window._plaidOAuthDetected,
          null, { timeout: 2000 }
        ).then(() => true).catch(() => false);
        if (oauthDetected) {
          // Reset flag and go back
          await page.evaluate(() => { window._plaidOAuthDetected = false; });
          await clickButton(frame, ['Back']);
          await sleep(500);
          console.log(`  [capture] Institution ${i} was OAuth — trying next`);
          continue;
        }
        console.log(`  [capture] Selected institution ${i}`);
        break;
      }
      transitionCount = await waitForTransition(page, transitionCount, 12000);
    }

    // There may be a consent/get-started screen after institution selection
    await clickButton(frame, ['Get started', 'I agree', 'Continue', 'Agree']);
    transitionCount = await waitForTransition(page, transitionCount);

    // Account selection (if shown)
    const accountRow = frame.locator('li[role="listitem"], [role="radio"]').first();
    if (await accountRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      await accountRow.click({ force: true }).catch(() => {});
      await clickButton(frame, ['Continue', 'Confirm', 'Link account', 'Share']);
      transitionCount = await waitForTransition(page, transitionCount, 12000);
      console.log('  [capture] Account selected');
    }

    // Dismiss "Save with Plaid" screen if shown
    await clickButton(frame, ['Finish without saving', 'without saving', 'Finish']);
    await sleep(500);

  // ── STANDARD FLOW ────────────────────────────────────────────────────────
  } else {
    // Screen 1: Consent / "Get started"
    if (stepIndex < linkSteps.length) {
      await captureScreen(page, linkSteps[stepIndex].id, screensDir);
      captures.push({ stepId: linkSteps[stepIndex].id });
      stepIndex++;
    }
    await clickButton(frame, ['Get started', 'I agree', 'Continue', 'Next']);
    transitionCount = await waitForTransition(page, transitionCount);

    // Skip phone screen if present
    const phoneInput = frame.locator('input[type="tel"]').first();
    if (await phoneInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await clickButton(frame, ['Continue without phone number', 'without phone number', 'Skip']);
      transitionCount = await waitForTransition(page, transitionCount);
    }

    // Screen 2: Institution search
    if (stepIndex < linkSteps.length) {
      await captureScreen(page, linkSteps[stepIndex].id, screensDir);
      captures.push({ stepId: linkSteps[stepIndex].id });
      stepIndex++;
    }
    // Fill search and select first result
    const searchInput = frame.locator('input[placeholder*="Search" i], input[type="search"]').first();
    if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await searchInput.fill(PLAID_SANDBOX_INSTITUTION);
      transitionCount = await waitForTransition(page, transitionCount, 8000);
    }
    const result = frame.getByText(PLAID_SANDBOX_INSTITUTION, { exact: false }).first();
    if (await result.isVisible({ timeout: 5000 }).catch(() => false)) {
      await result.click({ force: true }).catch(() => {});
      transitionCount = await waitForTransition(page, transitionCount, 8000);
    }

    // Connection type (pick first)
    const connType = frame.locator('li:first-of-type button').first();
    if (await connType.isVisible({ timeout: 3000 }).catch(() => false)) {
      await connType.click().catch(() => {});
      transitionCount = await waitForTransition(page, transitionCount);
    }

    // Screen 3: Credentials
    if (stepIndex < linkSteps.length) {
      await captureScreen(page, linkSteps[stepIndex].id, screensDir);
      captures.push({ stepId: linkSteps[stepIndex].id });
      stepIndex++;
    }
    // Fill credentials
    const usernameInput = frame.locator(
      'input[name="username"], input[id*="username" i], input[type="text"]:first-of-type'
    ).first();
    if (await usernameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await usernameInput.fill(PLAID_SANDBOX_USERNAME);
    }
    await sleep(300);
    const passwordInput = frame.locator('input[type="password"]').first();
    if (await passwordInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await passwordInput.fill(PLAID_SANDBOX_PASSWORD);
    }
    await clickButton(frame, ['Submit', 'Log in', 'Sign in', 'Continue']);
    transitionCount = await waitForTransition(page, transitionCount, 15000);

    // MFA if shown
    const mfaInput = frame.locator('input[maxlength="4"], input[maxlength="6"]').first();
    if (await mfaInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await mfaInput.fill('1234');
      await clickButton(frame, ['Submit', 'Continue', 'Verify']);
      transitionCount = await waitForTransition(page, transitionCount, 10000);
    }

    // Screen 4: Account selection
    if (stepIndex < linkSteps.length) {
      await captureScreen(page, linkSteps[stepIndex].id, screensDir);
      captures.push({ stepId: linkSteps[stepIndex].id });
      stepIndex++;
    }
    const accountRow = frame.locator('li[role="listitem"], [role="radio"]').first();
    if (await accountRow.isVisible({ timeout: 6000 }).catch(() => false)) {
      await accountRow.click({ force: true }).catch(() => {});
      await clickButton(frame, ['Continue', 'Confirm', 'Link account', 'Share']);
      transitionCount = await waitForTransition(page, transitionCount, 12000);
    }

    // Dismiss "Save with Plaid" if shown
    await clickButton(frame, ['Finish without saving', 'without saving', 'Finish']);
    await sleep(500);
  }

  // ── Final screen: success / connected ────────────────────────────────────
  // Wait for _plaidLinkComplete or success UI
  await page.waitForFunction(
    () => window._plaidLinkComplete === true,
    null, { timeout: 20000 }
  ).catch(() => { console.warn('  [capture] _plaidLinkComplete not set — capturing anyway'); });

  await sleep(SCREEN_DWELL_MS);

  if (stepIndex < linkSteps.length) {
    await captureScreen(page, linkSteps[stepIndex].id, screensDir);
    captures.push({ stepId: linkSteps[stepIndex].id });
  }

  return captures;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[plaid-link-capture] Starting Plaid Link screen capture…');

  if (!fs.existsSync(SCRIPT_FILE)) {
    throw new Error(`CRITICAL: demo-script.json not found at ${SCRIPT_FILE}`);
  }

  const demoScript = JSON.parse(fs.readFileSync(SCRIPT_FILE, 'utf8'));
  const linkSteps  = demoScript.steps.filter(s => /^link[-_]/.test(s.id));

  if (linkSteps.length === 0) {
    console.log('[plaid-link-capture] No link-* steps in demo-script.json — skipping.');
    return;
  }

  const flowType = detectFlowType(linkSteps);
  console.log(`[plaid-link-capture] Flow type: ${flowType}`);
  console.log(`[plaid-link-capture] Link steps to capture: ${linkSteps.map(s => s.id).join(', ')}`);

  // Write the minimal capture app page
  fs.mkdirSync(CAPTURE_APP_DIR, { recursive: true });
  fs.writeFileSync(path.join(CAPTURE_APP_DIR, 'index.html'), CAPTURE_PAGE_HTML, 'utf8');

  // Start app-server (provides /api/create-link-token and static file serving)
  const server = await startServer(3741, CAPTURE_APP_DIR);
  console.log(`[plaid-link-capture] Server: ${server.url}`);

  fs.mkdirSync(SCREENS_DIR, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({
      headless: false,      // headless:false required to capture OOPIF via GPU compositor
      args: ['--disable-web-security'],
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('[plaid-link-capture] Page loaded — running capture session…');

    const captures = await runCaptureSession(page, linkSteps, flowType, SCREENS_DIR);

    // Write manifest
    const manifest = {
      flowType,
      capturedAt:  new Date().toISOString(),
      runId:       path.basename(OUT_DIR),
      steps:       captures.map(c => c.stepId),
      institution: await page.evaluate(() => window._plaidMeta?.institution?.name || null).catch(() => null),
    };
    fs.writeFileSync(
      path.join(SCREENS_DIR, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    console.log(`[plaid-link-capture] ✓ Captured ${captures.length}/${linkSteps.length} screens`);
    console.log(`[plaid-link-capture] Output: ${SCREENS_DIR}`);

    if (captures.length < linkSteps.length) {
      const missing = linkSteps.filter(s => !captures.find(c => c.stepId === s.id)).map(s => s.id);
      console.warn(`[plaid-link-capture] Warning: missing captures for: ${missing.join(', ')}`);
    }

  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
    // Clean up temp capture app dir
    try { fs.rmSync(CAPTURE_APP_DIR, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[plaid-link-capture] Fatal:', err.message);
    process.exit(1);
  });
}
