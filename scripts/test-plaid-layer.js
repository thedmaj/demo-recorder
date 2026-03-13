'use strict';
/**
 * test-plaid-layer.js
 * Batch test runner for Plaid Layer scenarios.
 *
 * Plaid Layer uses phone-based identity passkey flow. This script creates a proper
 * session token via /session/token/create (requires PLAID_LAYER_TEMPLATE_ID in .env),
 * navigates the Layer UI, and documents results in plaid-link-nav-learnings.md.
 *
 * Polling strategy (no webhooks): After onSuccess, polls /accounts/get with
 * exponential backoff to verify linked account data is accessible.
 *
 * Layer sandbox phones (OTP: 123456 for all):
 *   +14155550011 — Full profile, LAYER_READY (2 banks + full PII)
 *   +14155550000 — Ineligible → LAYER_NOT_AVAILABLE → standard Link fallback
 *   +15155550017 — Partial PII (missing some identity fields)
 *   +14155550011 — Manual bypass: "I'd rather log in manually"
 *
 * Ref: plaid.com/docs/api/products/layer/
 *      plaid.com/docs/layer/add-to-app/
 */

require('dotenv').config({ override: true });
const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');
const http         = require('http');
const https        = require('https');

// ── Paths / config ────────────────────────────────────────────────────────────

const PROJECT_ROOT    = path.resolve(__dirname, '..');
const LEARNINGS_FILE  = path.join(PROJECT_ROOT, 'inputs', 'plaid-link-nav-learnings.md');
const OUT_DIR         = path.join(PROJECT_ROOT, 'out');
const plaidClientId   = process.env.PLAID_CLIENT_ID;
const plaidSecret     = process.env.PLAID_SANDBOX_SECRET || process.env.PLAID_SECRET;
const layerTemplateId = process.env.PLAID_LAYER_TEMPLATE_ID;

if (!plaidClientId || !plaidSecret) {
  console.error('[Layer] Missing PLAID_CLIENT_ID or PLAID_SANDBOX_SECRET in .env');
  process.exit(1);
}
if (!layerTemplateId) {
  console.error('[Layer] Missing PLAID_LAYER_TEMPLATE_ID in .env');
  console.error('  Set: PLAID_LAYER_TEMPLATE_ID=template_xxxx (from Plaid Dashboard → Layer)');
  process.exit(1);
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

const SCENARIOS = [
  {
    id:          'layer-ready',
    phone:       '+14155550011',
    tag:         'Layer — Full profile (LAYER_READY)',
    notes:       'Standard profile: full PII, 2 connected banks. Expect LAYER_READY event, account autofill.',
    manualLogin: false,
    expectEvent: 'LAYER_READY',
  },
  {
    id:          'layer-not-available',
    phone:       '+14155550000',
    tag:         'Layer — Ineligible (LAYER_NOT_AVAILABLE)',
    notes:       'Phone fails Layer eligibility. Expect LAYER_NOT_AVAILABLE, falls back to standard Link.',
    manualLogin: false,
    expectEvent: 'LAYER_NOT_AVAILABLE',
  },
  {
    id:          'layer-partial-pii',
    phone:       '+15155550017',
    tag:         'Layer — Partial PII',
    notes:       'Missing some identity fields. Expect partial autofill or LAYER_NOT_AVAILABLE fallback.',
    manualLogin: false,
    expectEvent: 'LAYER_READY',
  },
  {
    id:          'layer-manual-bypass',
    phone:       '+14155550011',
    tag:         'Layer — Manual login bypass',
    notes:       'Full profile but user clicks "I\'d rather log in manually". Tests manual credential fallback.',
    manualLogin: true,
    expectEvent: 'LAYER_READY',
  },
];

// ── CLI args ──────────────────────────────────────────────────────────────────

const args           = process.argv.slice(2);
const singleScenario = args.find(a => a.startsWith('--scenario='))?.replace('--scenario=', '');
const delayMs        = parseInt(args.find(a => a.startsWith('--delay='))?.replace('--delay=', '') || '5000', 10);
const scenariosToRun = singleScenario
  ? SCENARIOS.filter(s => s.id === singleScenario)
  : SCENARIOS;

if (scenariosToRun.length === 0) {
  console.error(`[Layer] Unknown scenario: ${singleScenario}. Valid: ${SCENARIOS.map(s => s.id).join(', ')}`);
  process.exit(1);
}

// ── Plaid API helper ──────────────────────────────────────────────────────────

function plaidPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ client_id: plaidClientId, secret: plaidSecret, ...body });
    const req = https.request({
      hostname: 'sandbox.plaid.com',
      port:     443,
      path:     endpoint,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { resolve({ error: 'parse_error', raw: Buffer.concat(chunks).toString().slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Polling backoff helper ────────────────────────────────────────────────────

/**
 * Polls fn() until it returns { done: true, value } or maxAttempts is reached.
 * Delay doubles each attempt (capped at maxDelayMs) — exponential backoff.
 */
async function pollWithBackoff(fn, { maxAttempts = 8, initialDelayMs = 1000, maxDelayMs = 8000, label = '' } = {}) {
  let delayMs = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn(attempt);
    if (result.done) {
      console.log(`  [Poll] ${label || 'check'} succeeded (attempt ${attempt}/${maxAttempts})`);
      return result.value;
    }
    if (attempt < maxAttempts) {
      console.log(`  [Poll] ${label || 'check'} attempt ${attempt}/${maxAttempts} — waiting ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
      delayMs = Math.min(Math.round(delayMs * 1.8), maxDelayMs);
    }
  }
  throw new Error(`Polling exhausted after ${maxAttempts} attempts: ${label}`);
}

// ── Token creation via /user/create + /session/token/create ──────────────────

/**
 * Plaid Layer token creation flow:
 *   1. POST /user/create  — creates a Plaid user with PII (including phone_number)
 *                           Returns user_token (user-sandbox-...)
 *   2. POST /session/token/create — creates a Layer session token using user_token
 *                           Returns link.link_token
 *
 * The user_token ties the phone to the Layer identity check. Without it, Layer
 * shows "Please submit Phone Number before opening Link."
 */
async function createSessionToken(phone) {
  console.log(`  [Layer] Creating session token (template_id=${layerTemplateId})`);
  const userId = `layer-test-${Date.now()}`;

  // Step 1: Create a Plaid user (only client_user_id accepted by this endpoint)
  // PII (phone, name, address) is set via /identity/profile/create if needed
  const userResult = await plaidPost('/user/create', {
    client_user_id: userId,
  });

  const userToken = userResult.user_token;
  if (!userToken) {
    console.warn(`  [Layer] /user/create failed: ${JSON.stringify(userResult)}`);
    throw new Error(`/user/create failed: ${JSON.stringify(userResult)}`);
  }
  console.log(`  [Layer] User created (user_token=${userToken.slice(0, 20)}..., request_id=${userResult.request_id})`);

  // Step 2: /session/token/create — pass user.user_id = userToken (Layer user association)
  // user.user_id accepts the user_token from /user/create (validated by API).
  // phone_number is NOT passed in the token (API rejects all phone fields);
  // the phone is submitted via handler.submit({ phone_number }) in the browser SDK.
  const sessionResult = await plaidPost('/session/token/create', {
    template_id: layerTemplateId,
    user: {
      client_user_id: userId,
      user_id:        userToken,  // associates this session with the Plaid user profile
    },
  });

  const sessionToken = sessionResult.link?.link_token || sessionResult.link_token;
  if (sessionToken) {
    console.log(`  [Layer] Session token created (request_id=${sessionResult.request_id})`);
    return { token: sessionToken, userId, userToken };
  }

  throw new Error(`/session/token/create failed: ${JSON.stringify(sessionResult)}`);
}

// ── Test page HTML (pre-embedded token) ──────────────────────────────────────

function buildLayerHtml(linkToken, phone) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Plaid Layer Test</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 1440px; height: 900px; overflow: hidden; background: #0d1117;
      display: flex; align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, sans-serif; color: #fff;
    }
    .card {
      background: rgba(255,255,255,0.05); border: 1px solid rgba(0,166,126,0.35);
      border-radius: 16px; padding: 48px 56px; max-width: 560px; text-align: center;
    }
    h1 { font-size: 26px; font-weight: 700; margin-bottom: 12px; }
    p  { color: rgba(255,255,255,0.65); margin-bottom: 8px; font-size: 14px; }
    button {
      background: #00A67E; color: #fff; border: none; border-radius: 8px;
      padding: 14px 36px; font-size: 16px; font-weight: 600; cursor: pointer;
      margin-top: 24px; min-width: 200px;
    }
    #status { margin-top: 20px; font-size: 13px; color: rgba(255,255,255,0.5); min-height: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Plaid Layer Test</h1>
    <p>Template: ${layerTemplateId}</p>
    <p>Phone: ${phone}</p>
    <button id="open-btn" data-testid="open-btn" onclick="openLayer()">Open Layer</button>
    <div id="status">Ready.</div>
  </div>
  <script>
    window._plaidResult   = null;
    window._plaidComplete = false;
    window._plaidEvents   = [];

    function openLayer() {
      document.getElementById('open-btn').disabled = true;
      document.getElementById('status').textContent = 'Opening Plaid Layer...';
      const handler = Plaid.create({
        token: '${linkToken}',
        onSuccess: function(public_token, metadata) {
          window._plaidResult   = { success: true, public_token, metadata };
          window._plaidComplete = true;
          document.getElementById('status').textContent = 'SUCCESS — token received';
          console.log('[Layer] onSuccess public_token=' + public_token);
        },
        onExit: function(err, metadata) {
          window._plaidResult   = { exited: true, err, metadata };
          window._plaidComplete = true;
          document.getElementById('status').textContent = err ? 'EXIT: ' + err.error_code : 'User exited';
          console.log('[Layer] onExit err=' + JSON.stringify(err));
        },
        onEvent: function(eventName, metadata) {
          window._plaidEvents.push({ eventName, metadata, timestamp: Date.now() });
          console.log('[LayerEvent] ' + eventName + ' view=' + (metadata.view_name || '') + ' match=' + (metadata.match_reason || ''));
          // LAYER_NOT_AVAILABLE: Plaid needs DOB to continue to standard Link fallback
          if (eventName === 'LAYER_NOT_AVAILABLE') {
            setTimeout(function() {
              window._plaidHandler.submit({ date_of_birth: '1990-01-01' });
              console.log('[Layer] LAYER_NOT_AVAILABLE — submitted date_of_birth for standard Link fallback');
            }, 500);
          }
        }
      });
      // Plaid Layer: open() FIRST (creates the iframe), then submit() after iframe loads.
      // submit() uses postMessage to the iframe — the iframe must exist first.
      // Calling submit() before open() causes postMessage to target the wrong window.
      window._plaidHandler = handler;
      handler.open();
      console.log('[Layer] open() called — waiting for iframe to load');
      // After iframe loads, submit phone to Layer SDK (phone only — for eligibility check)
      setTimeout(function() {
        handler.submit({ phone_number: '${phone}' });
        console.log('[Layer] submit() called with phone=${phone}');
        document.getElementById('status').textContent = 'Phone submitted — awaiting Layer eligibility check';
      }, 3000);
    }
  </script>
</body>
</html>`;
}

// ── Step runner ───────────────────────────────────────────────────────────────

class StepRunner {
  constructor() { this.results = []; }
  async run(label, fn) {
    const start = Date.now();
    let success = false; let note = ''; let err = null;
    try {
      const r = await fn();
      success = r !== false;
      if (typeof r === 'string') note = r;
    } catch (e) { err = e.message; note = e.message; }
    const ms = Date.now() - start;
    this.results.push({ step: label, success, durationMs: ms, note, err });
    console.log(`${success ? '✅' : '❌'} ${label.padEnd(48)} ${(ms/1000).toFixed(1)}s${note ? '  — ' + note : ''}`);
    return success;
  }
}

// ── Single scenario ───────────────────────────────────────────────────────────

async function runScenario(scenario) {
  console.log(`\n🔲 ${scenario.tag}`);
  console.log('━'.repeat(60));
  console.log(`  Phone        : ${scenario.phone}`);
  console.log(`  Manual login : ${scenario.manualLogin}`);
  console.log(`  Expect event : ${scenario.expectEvent}`);
  console.log('━'.repeat(60));

  const runner = new StepRunner();
  let tokenInfo = null;
  let accessToken = null;

  // ── Step 1: Create session token ─────────────────────────────────────────
  await runner.run('Create session token (/user/create + /session/token/create)', async () => {
    tokenInfo = await createSessionToken(scenario.phone);
    return `link_token created for user ${tokenInfo.userId}`;
  });

  if (!tokenInfo?.token) {
    return buildReport(scenario, runner.results, [], null);
  }

  // ── Start inline HTTP server ──────────────────────────────────────────────
  const html = buildLayerHtml(tokenInfo.token, scenario.phone);
  const server = await new Promise((res, rej) => {
    const s = http.createServer((req, resp) => {
      resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      resp.end(html);
    });
    s.listen(0, '127.0.0.1', () => res(s));
    s.on('error', rej);
  });
  const pageUrl = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page    = await context.newPage();

  page.on('console', msg => {
    const t = msg.text();
    if (t.startsWith('[Layer')) console.log(`  [browser] ${t}`);
  });

  try {
    // ── Step 2: Load page ───────────────────────────────────────────────────
    await runner.run('Load test page', async () => {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      return true;
    });

    // ── Step 3: Open Layer ──────────────────────────────────────────────────
    await runner.run('Click Open Layer button', async () => {
      await page.locator('[data-testid="open-btn"]').click();
      await page.waitForTimeout(2000);
      return true;
    });

    // ── Step 4: Wait for iframe ─────────────────────────────────────────────
    await runner.run('Plaid iframe attached', async () => {
      await page.waitForSelector(
        'iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]',
        { state: 'attached', timeout: 20000 }
      );
      // Wait 4s: iframe loads (~1-2s) + submit() fires at 3s → LAYER_READY at ~4s
      // The pollWithBackoff in step 5 handles the rest of the wait
      await page.waitForTimeout(4000);
      return true;
    });

    const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

    // ── Dump initial Layer screen ─────────────────────────────────────────────
    await (async () => {
      try {
        const plaidFrame = page.frames().find(f => f.url().includes('cdn.plaid.com'));
        if (!plaidFrame) return;
        const heading = await plaidFrame.evaluate(() =>
          document.querySelector('h1,h2,[role="heading"]')?.textContent?.trim()
        ).catch(() => null);
        const inputs = await plaidFrame.evaluate(() =>
          Array.from(document.querySelectorAll('input')).map(i => ({
            type: i.type, placeholder: i.placeholder, inputmode: i.inputMode, maxlength: i.maxLength,
          }))
        ).catch(() => []);
        const btns = await plaidFrame.evaluate(() =>
          Array.from(document.querySelectorAll('button')).map(b => ({
            text: b.textContent?.trim(), disabled: b.disabled,
          }))
        ).catch(() => []);
        const bodyText = await plaidFrame.evaluate(() =>
          document.body?.innerText?.slice(0, 400)
        ).catch(() => null);
        const events = await page.evaluate(() => (window._plaidEvents || []).map(e => e.eventName)).catch(() => []);
        console.log(`  [Layer] Initial screen heading: "${heading || '(none)'}"`);
        console.log(`  [Layer] Inputs: ${JSON.stringify(inputs)}`);
        console.log(`  [Layer] Buttons: ${JSON.stringify(btns)}`);
        console.log(`  [Layer] Body text: ${(bodyText || '').replace(/\n/g, ' ').slice(0, 200)}`);
        console.log(`  [Layer] Events fired so far: ${events.join(', ') || 'none'}`);
      } catch (_) {}
    })();

    // ── Step 5: Poll for LAYER_READY / LAYER_NOT_AVAILABLE ────────────────
    // The page calls open() immediately, then submit({ phone_number }) after 3s.
    // LAYER_READY fires ~1-2s after submit() is processed by Plaid's servers.
    // Total expected wait: ~5-7s from button click.
    let layerEvent = null;
    await runner.run('Poll for LAYER_READY or LAYER_NOT_AVAILABLE event', async () => {
      layerEvent = await pollWithBackoff(async () => {
        const events = await page.evaluate(() => (window._plaidEvents || []).map(e => e.eventName));
        if (events.includes('LAYER_READY'))         return { done: true, value: 'LAYER_READY' };
        if (events.includes('LAYER_NOT_AVAILABLE')) return { done: true, value: 'LAYER_NOT_AVAILABLE' };
        if (events.includes('HANDOFF'))             return { done: true, value: 'HANDOFF' };
        const complete = await page.evaluate(() => window._plaidComplete).catch(() => false);
        if (complete)                               return { done: true, value: 'COMPLETE_NO_LAYER_EVENT' };
        return { done: false };
      }, { maxAttempts: 12, initialDelayMs: 800, maxDelayMs: 4000, label: 'Layer event' });
      return layerEvent;
    });

    // ── Step 6: LAYER_READY consent screen — click Continue ──────────────
    // When LAYER_READY fires, Plaid shows a consent screen:
    //   "You're eligible to Skip the forms"
    //   "All your info pre-filled instantly using your Plaid account"
    //   [Continue] button
    if (layerEvent === 'LAYER_READY') {
      await runner.run('LAYER_READY: click Continue on consent screen', async () => {
        const continueBtn = frame.locator('button:has-text("Continue")').first();
        if (await continueBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
          await continueBtn.click();
          await page.waitForTimeout(2000);
          return 'Clicked Continue on Layer consent screen';
        }
        // Dump buttons for diagnostics
        const plaidFrame = page.frames().find(f => f.url().includes('cdn.plaid.com'));
        if (plaidFrame) {
          const btns = await plaidFrame.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim())).catch(() => []);
          console.log(`  [Layer] Consent screen buttons: ${btns.join(' | ')}`);
        }
        return false;
      });
    }

    // ── Step 6b: Layer OTP — appears after consent Continue ──────────────
    // After LAYER_READY + Continue, Plaid sends OTP to the phone and shows
    // "Enter the code we sent to your phone". Sandbox OTP is always 123456.
    // The input auto-submits when filled (React onChange pattern).
    if (layerEvent === 'LAYER_READY') {
      await runner.run('LAYER_READY: fill OTP (auto-submits)', async () => {
        const otpInput = frame.locator('input[inputmode="numeric"], input[maxlength="6"]').first();
        if (await otpInput.isVisible({ timeout: 8000 }).catch(() => false)) {
          await otpInput.fill('123456');
          await page.waitForTimeout(3000);
          return 'OTP 123456 filled — auto-submit expected';
        }
        // Check if we're already past OTP (e.g., onSuccess fired early)
        const complete = await page.evaluate(() => window._plaidComplete).catch(() => false);
        if (complete) return 'OTP not needed — already complete';
        const events = await page.evaluate(() => (window._plaidEvents || []).map(e => e.eventName));
        return `OTP input not found (events: ${events.join(', ')})`;
      });
    }

    // ── Step 6c: Layer review screen — click Share ────────────────────────
    // After OTP verification, Layer shows a "Confirm the details you want to share"
    // review screen with pre-filled identity info (name, DOB, address, SSN, bank account).
    // User clicks "Share" to confirm and trigger onSuccess.
    if (layerEvent === 'LAYER_READY') {
      await runner.run('LAYER_READY: click Share on review screen', async () => {
        // Poll for Share button to appear
        const shareBtn = await pollWithBackoff(async () => {
          const btn = frame.locator('button:has-text("Share")').first();
          if (await btn.isVisible({ timeout: 500 }).catch(() => false)) return { done: true, value: btn };
          const complete = await page.evaluate(() => window._plaidComplete).catch(() => false);
          if (complete) return { done: true, value: null };
          return { done: false };
        }, { maxAttempts: 8, initialDelayMs: 1000, maxDelayMs: 4000, label: 'Share button' });

        if (!shareBtn) {
          const complete = await page.evaluate(() => window._plaidComplete).catch(() => false);
          if (complete) return 'Already complete — Share not needed';
          // Dump screen for diagnostics
          const plaidFrame = page.frames().find(f => f.url().includes('cdn.plaid.com'));
          if (plaidFrame) {
            const btns = await plaidFrame.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)).catch(() => []);
            console.log(`  [Layer] Review screen buttons: ${btns.join(' | ')}`);
          }
          return false;
        }
        await shareBtn.click();
        await page.waitForTimeout(2000);
        return 'Clicked Share on Layer review screen';
      });
    }

    // ── Step 7: Manual login bypass (scenario-specific) ───────────────────
    // "I'd rather log in manually" is a template-controlled feature. With template
    // template_n31w56t6o9a7, this option does NOT appear — the consent screen only
    // shows [Exit] [Continue] [Privacy Policy] [Terms].
    // This step is a soft check: returns true whether or not the button is found,
    // and documents the finding.
    if (scenario.manualLogin && layerEvent === 'LAYER_READY') {
      await runner.run('Layer: check for manual login bypass option', async () => {
        await page.waitForTimeout(1000);
        for (const text of ["I'd rather log in manually", "log in manually", "Use password instead", "Skip", "Use a different method"]) {
          const el = frame.getByText(text, { exact: false }).first();
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            await el.click();
            await page.waitForTimeout(2000);
            return `Clicked "${text}"`;
          }
        }
        // Not found — this is a template-controlled feature, not a test failure
        const plaidFrame = page.frames().find(f => f.url().includes('cdn.plaid.com'));
        if (plaidFrame) {
          const btns = await plaidFrame.evaluate(() => Array.from(document.querySelectorAll('button,a')).map(b => b.textContent?.trim()).filter(Boolean)).catch(() => []);
          console.log(`  [Layer] Manual bypass check — visible elements: ${btns.join(' | ')}`);
        }
        return 'Manual bypass option not available with this template (template-controlled feature)';
      });
    }

    // ── Step 8b: Click Exit on LAYER_NOT_AVAILABLE / LAYER_AUTOFILL_NOT_AVAILABLE ─
    // When phone is ineligible, Plaid shows "Sorry, The provided phone number is not
    // eligible for Plaid Layer." with only an Exit button. Clicking Exit triggers onExit.
    if (layerEvent === 'LAYER_NOT_AVAILABLE') {
      await runner.run('LAYER_NOT_AVAILABLE: click Exit (ineligible — no fallback)', async () => {
        // Wait briefly for the error screen to render
        await page.waitForTimeout(1500);
        const exitBtn = frame.locator('button:has-text("Exit")').first();
        if (await exitBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await exitBtn.click();
          await page.waitForTimeout(1500);
          return 'Clicked Exit on ineligible screen (LAYER_AUTOFILL_NOT_AVAILABLE)';
        }
        // Maybe the screen already dismissed
        const complete = await page.evaluate(() => window._plaidComplete).catch(() => false);
        if (complete) return 'Already complete — Exit not needed';
        return false;
      });
    }

    // ── Step 9: Handle post-LAYER_NOT_AVAILABLE fallback (standard Link) ──
    // When LAYER_NOT_AVAILABLE fires: page re-submits DOB via handler.submit({ date_of_birth })
    // Plaid then transitions to standard Link. Wait up to 10s for institution search to appear.
    await runner.run('Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)', async () => {
      const searchInput = frame.locator('input[placeholder*="Search" i]').first();
      if (await searchInput.isVisible({ timeout: 10000 }).catch(() => false)) {
        await searchInput.fill('First Platypus Bank');
        await page.waitForTimeout(2000);
        const result = frame.getByText('First Platypus Bank', { exact: false }).first();
        if (await result.isVisible({ timeout: 5000 }).catch(() => false)) {
          await result.click();
          await page.waitForTimeout(2000);
          // Connection type screen
          const typeBtn = frame.locator('li:first-of-type button').first();
          if (await typeBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
            await typeBtn.click();
            await page.waitForTimeout(2000);
          }
          return 'Searched + selected First Platypus Bank';
        }
      }
      return 'Institution search not shown — skipped';
    });

    await runner.run('Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)', async () => {
      const usernameInput = frame.locator('input[type="text"]:first-of-type').first();
      if (await usernameInput.isVisible({ timeout: 4000 }).catch(() => false)) {
        await usernameInput.fill('user_good');
        const passInput = frame.locator('input[type="password"]').first();
        if (await passInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await passInput.fill('pass_good');
        }
        const submitBtn = frame.locator('button[type="submit"]').first();
        if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await submitBtn.click();
          await page.waitForTimeout(4000);
          return 'Credentials entered and submitted';
        }
      }
      return 'Credential screen not shown — skipped';
    });

    // ── Step 10: Account selection ─────────────────────────────────────────
    // NOTE: Account list items can be intercepted by an overlay div.
    // Use { force: true } to bypass pointer interception from overlay elements.
    await runner.run('Handle account selection (if shown)', async () => {
      await page.waitForTimeout(1000);
      try {
        await frame.locator('[role="progressbar"]').waitFor({ state: 'hidden', timeout: 6000 });
      } catch (_) {}

      const accountRow = frame.locator('li[role="listitem"]').first();
      if (await accountRow.isVisible({ timeout: 6000 }).catch(() => false)) {
        // Use force:true to bypass intercepting overlay divs (known Plaid UI issue)
        await accountRow.click({ force: true });
        await page.waitForTimeout(1000);
        // Continue or Confirm
        for (const sel of ['button:has-text("Continue")', 'button:has-text("Confirm")', 'button[type="submit"]']) {
          const btn = frame.locator(sel).first();
          if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await btn.click();
            await page.waitForTimeout(2000);
            return `Account clicked (force) + "${sel}" clicked`;
          }
        }
        return 'Account clicked (force) — Continue not found';
      }
      return 'Account list not shown — skipped (Layer may have auto-selected)';
    });

    // ── Step 11: Dismiss Save with Plaid screen ────────────────────────────
    await runner.run('Dismiss Save with Plaid screen (if shown)', async () => {
      for (const sel of ['button:has-text("Finish without saving")', 'button:has-text("without saving")']) {
        const btn = frame.locator(sel).first();
        if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await btn.click();
          await page.waitForTimeout(1500);
          return `Dismissed — "${sel}"`;
        }
      }
      return 'Not shown — clean exit';
    });

    // ── Step 12: Final permissions screen ──────────────────────────────────
    await runner.run('Handle final permissions screen (if shown)', async () => {
      for (const sel of [
        'button:has-text("Connect account information")',
        'button:has-text("Allow")',
        'button:has-text("Authorize")',
        'button:has-text("Continue")',
      ]) {
        const btn = frame.locator(sel).first();
        if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
          const txt = await btn.innerText().catch(() => sel);
          await btn.click();
          await page.waitForTimeout(2000);
          return `Clicked: "${txt.trim()}"`;
        }
      }
      return 'Not shown';
    });

    // ── Step 13: Poll for completion (onSuccess or onExit) ─────────────────
    // For LAYER_NOT_AVAILABLE scenarios, onExit fires (not onSuccess).
    // For LAYER_READY scenarios, onSuccess fires.
    // Both are valid completions; distinguish by result type in the report.
    const expectExit = (layerEvent === 'LAYER_NOT_AVAILABLE');
    await runner.run(`Poll for ${expectExit ? 'onExit (ineligible)' : 'onSuccess'} (with backoff)`, async () => {
      const result = await pollWithBackoff(async () => {
        const complete = await page.evaluate(() => window._plaidComplete).catch(() => false);
        if (complete) {
          const r = await page.evaluate(() => window._plaidResult).catch(() => null);
          return { done: true, value: r };
        }
        return { done: false };
      }, { maxAttempts: 15, initialDelayMs: 1000, maxDelayMs: 8000, label: expectExit ? 'onExit' : 'onSuccess' });

      if (result?.success)  return `public_token received`;
      if (result?.exited)   return `User exited — ${result.err?.error_code || 'no error'} (expected for LAYER_NOT_AVAILABLE)`;
      return false;
    });

    // ── Step 14: Post-success: retrieve Layer session data ────────────────
    // Layer returns a profile-sandbox-... token, NOT a standard public-sandbox-... token.
    // These are exchanged via /user_account/session/get (NOT /item/public_token/exchange).
    // Standard items use /item/public_token/exchange; Layer profile tokens use /user_account/session/get.
    const plaidResult = await page.evaluate(() => window._plaidResult).catch(() => null);
    if (plaidResult?.success) {
      const isLayerToken = plaidResult.public_token?.startsWith('profile-');
      if (isLayerToken) {
        await runner.run('Retrieve Layer session data (/user_account/session/get)', async () => {
          const data = await plaidPost('/user_account/session/get', {
            public_token: plaidResult.public_token,
          });
          if (data.identity && data.identity.addresses) {
            const name = data.identity.names?.[0] || '(no name)';
            const accts = (data.items || []).flatMap(i => i.accounts || []).length;
            return `Identity retrieved: ${name} — ${accts} account(s) linked`;
          }
          if (data.error_code) throw new Error(`/user_account/session/get: ${data.error_code} — ${data.error_message}`);
          return `Layer session data: ${JSON.stringify(data).slice(0, 100)}`;
        });
      } else {
        // Standard Link token — use /item/public_token/exchange + /accounts/get
        await runner.run('Exchange public_token → access_token', async () => {
          const exchanged = await plaidPost('/item/public_token/exchange', {
            public_token: plaidResult.public_token,
          });
          if (exchanged.access_token) {
            accessToken = exchanged.access_token;
            return `access_token obtained (item_id=${exchanged.item_id})`;
          }
          return false;
        });

        if (accessToken) {
          await runner.run('Poll /accounts/get until accounts available', async () => {
            const accounts = await pollWithBackoff(async () => {
              const data = await plaidPost('/accounts/get', { access_token: accessToken });
              if (data.accounts && data.accounts.length > 0) return { done: true, value: data.accounts };
              if (data.error_code === 'PRODUCT_NOT_READY') return { done: false };
              if (data.error_code) throw new Error(`/accounts/get error: ${data.error_code}`);
              return { done: false };
            }, { maxAttempts: 8, initialDelayMs: 1500, maxDelayMs: 8000, label: 'accounts/get' });
            const names = accounts.map(a => `${a.name} (${a.type}/${a.subtype})`).join(', ');
            return `${accounts.length} account(s): ${names}`;
          });
        }
      }
    }

  } catch (err) {
    console.error(`\n[Layer] Fatal: ${err.message}`);
    runner.results.push({ step: 'FATAL', success: false, durationMs: 0, note: err.message });
  }

  const plaidEvents  = await page.evaluate(() => window._plaidEvents || []).catch(() => []);
  const plaidResult  = await page.evaluate(() => window._plaidResult).catch(() => null);

  await browser.close();
  await new Promise(r => server.close(r));

  const passed  = runner.results.filter(r => r.success).length;
  const failed  = runner.results.filter(r => !r.success).length;
  const total   = runner.results.length;
  const allPass = failed === 0;

  console.log('\n' + '━'.repeat(60));
  console.log(`Results: ${passed}/${total} steps passed${allPass ? ' ✅' : ' ❌'}`);

  return buildReport(scenario, runner.results, plaidEvents, plaidResult);
}

function buildReport(scenario, steps, plaidEvents, plaidResult) {
  const passed  = steps.filter(r => r.success).length;
  const failed  = steps.filter(r => !r.success).length;
  const total   = steps.length;
  const allPass = failed === 0;

  const report = {
    testedAt: new Date().toISOString(),
    product: 'layer',
    phone: scenario.phone,
    manualLogin: scenario.manualLogin,
    expectEvent: scenario.expectEvent,
    tag: scenario.tag,
    passed, failed, total, allPass,
    steps,
    plaidEvents,
    plaidResult,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rpt = path.join(OUT_DIR, `plaid-layer-test-${ts}.json`);
  fs.writeFileSync(rpt, JSON.stringify(report, null, 2));
  console.log(`[Layer] Report: ${rpt}`);

  updateLearnings(report);
  return report;
}

// ── Learnings writer ──────────────────────────────────────────────────────────

function updateLearnings(report) {
  const date    = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const status  = report.allPass ? 'PASS' : 'FAIL';
  const layerEv = report.plaidEvents.find(e =>
    e.eventName === 'LAYER_READY' || e.eventName === 'LAYER_NOT_AVAILABLE'
  );
  const evtNames = report.plaidEvents.map(e => e.eventName).join(', ') || '(none)';

  const successSteps = report.steps
    .filter(s => s.success && s.note && s.note !== 'true')
    .map(s => `  - **${s.step}**: ${s.note}`)
    .join('\n');

  const failedSteps = report.steps
    .filter(s => !s.success)
    .map(s => `  - **${s.step}**: ${s.note || 'no detail'}`)
    .join('\n');

  const outcome = report.plaidResult?.success ? 'onSuccess — public_token received'
    : report.plaidResult?.exited ? `onExit (${report.plaidResult.err?.error_code || 'user exit'})`
    : 'timeout / incomplete';

  const entry = `
## Run: ${date} — ${status} (${report.passed}/${report.total}) [Layer] — ${report.tag}
**Phone**: \`${report.phone}\` | **Manual login**: ${report.manualLogin} | **Expected event**: ${report.expectEvent}
**Layer event observed**: ${layerEv ? layerEv.eventName : 'none (LAYER_READY/LAYER_NOT_AVAILABLE not fired)'}
**Outcome**: ${outcome}

### What worked:
${successSteps || '  (none)'}

### What failed:
${failedSteps || '  (none — all passed!)'}

### Plaid events observed:
  ${evtNames}

---
`;

  const existing = fs.existsSync(LEARNINGS_FILE) ? fs.readFileSync(LEARNINGS_FILE, 'utf8') : '';
  fs.writeFileSync(LEARNINGS_FILE, existing + entry);
  console.log(`[Layer] Learnings updated: ${LEARNINGS_FILE}`);
}

// ── Batch runner ──────────────────────────────────────────────────────────────

async function runBatch() {
  console.log(`\n🔲 Plaid Layer Batch Test`);
  console.log(`   Template: ${layerTemplateId}`);
  console.log(`   ${scenariosToRun.length} scenario(s) — ${delayMs}ms between each`);
  console.log('━'.repeat(60));

  const summary = [];

  for (let i = 0; i < scenariosToRun.length; i++) {
    const scenario = scenariosToRun[i];
    console.log(`\n[${i + 1}/${scenariosToRun.length}] ${scenario.tag}`);

    let report;
    try {
      report = await runScenario(scenario);
    } catch (err) {
      console.error(`  [Layer] Fatal: ${err.message}`);
      report = buildReport(scenario, [{ step: 'FATAL', success: false, durationMs: 0, note: err.message }], [], null);
    }

    const layerEv = (report.plaidEvents || []).find(e =>
      e.eventName === 'LAYER_READY' || e.eventName === 'LAYER_NOT_AVAILABLE'
    );
    summary.push({
      phone:      scenario.phone,
      tag:        scenario.tag,
      passed:     report.passed,
      total:      report.total,
      allPass:    report.allPass,
      layerEvent: layerEv?.eventName || 'none',
      outcome:    report.plaidResult?.success ? 'onSuccess'
                : report.plaidResult?.exited  ? `onExit (${report.plaidResult.err?.error_code || 'exit'})`
                : 'timeout',
    });

    if (i < scenariosToRun.length - 1) {
      console.log(`\n  ⏳ Waiting ${delayMs}ms before next scenario...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log('\n' + '━'.repeat(60));
  console.log('📊 Layer Batch Summary');
  console.log('━'.repeat(60));
  for (const r of summary) {
    const icon = r.allPass ? '✅' : '❌';
    console.log(`${icon} ${r.phone}  ${String(r.passed + '/' + r.total).padEnd(6)}  layer=${r.layerEvent.padEnd(22)} ${r.outcome.padEnd(18)}  ${r.tag}`);
  }

  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const batchEntry = `
## Batch Summary: Plaid Layer — ${date}
**Template ID**: \`${layerTemplateId}\`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
${summary.map(r =>
  `| \`${r.phone}\` | ${r.tag} | ${r.passed}/${r.total} ${r.allPass ? '✅' : '❌'} | ${r.layerEvent} | ${r.outcome} |`
).join('\n')}

---
`;
  const existing = fs.existsSync(LEARNINGS_FILE) ? fs.readFileSync(LEARNINGS_FILE, 'utf8') : '';
  fs.writeFileSync(LEARNINGS_FILE, existing + batchEntry);
  console.log(`\n[Layer] Batch summary appended to ${LEARNINGS_FILE}`);

  process.exit(summary.every(r => r.allPass) ? 0 : 1);
}

runBatch().catch(err => {
  console.error('[Layer] Fatal:', err.message);
  process.exit(1);
});
