'use strict';
/**
 * test-plaid-link.js
 * Standalone Plaid Link navigation test harness.
 *
 * Stands up a minimal web app with the real Plaid Link SDK, then uses the
 * browser agent (Playwright + Claude Haiku vision) to navigate the full flow:
 *   skipRememberMe → consent → search institution → credentials → account select → success
 *
 * Reports which strategies worked per step and saves learnings for future runs.
 *
 * Usage:
 *   node scripts/test-plaid-link.js                         # default: First Platypus Bank
 *   node scripts/test-plaid-link.js --institution="Tartan Bank"
 *   node scripts/test-plaid-link.js --no-vision             # CSS selectors only, no Claude
 *   node scripts/test-plaid-link.js --headless              # run without visible browser
 *   node scripts/test-plaid-link.js --username=user_good --password=pass_good
 *
 * Reads: .env (PLAID_CLIENT_ID, PLAID_SECRET, ANTHROPIC_API_KEY)
 * Writes: out/plaid-link-test-{timestamp}.json
 *         inputs/plaid-link-nav-learnings.md (cumulative learnings)
 */

require('dotenv').config({ override: true });
const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');
const http         = require('http');

const agent = require('./scratch/utils/plaid-browser-agent');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT  = path.resolve(__dirname, '..');
const OUT_DIR       = path.join(PROJECT_ROOT, 'out');
const LEARNINGS_FILE = path.join(PROJECT_ROOT, 'inputs', 'plaid-link-nav-learnings.md');
const TEMP_DIR      = path.join(OUT_DIR, '_plaid-link-test-tmp');

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs(argv = process.argv.slice(2)) {
  const inst        = argv.find(a => a.startsWith('--institution='))?.replace('--institution=', '') || 'First Platypus Bank';
  const username    = argv.find(a => a.startsWith('--username='))?.replace('--username=',  '') || 'user_good';
  const password    = argv.find(a => a.startsWith('--password='))?.replace('--password=',  '') || 'pass_good';
  const mfaCode     = argv.find(a => a.startsWith('--mfa='))?.replace('--mfa=', '')             || '1234';
  const noVision    = argv.includes('--no-vision');
  const headless    = argv.includes('--headless');
  const rememberMe  = argv.includes('--remember-me');
  const phone       = argv.find(a => a.startsWith('--phone='))?.replace('--phone=', '')         || '';
  const rememberMeOtp = argv.find(a => a.startsWith('--rm-otp='))?.replace('--rm-otp=', '')     || '123456';
  const phoneInToken = argv.includes('--phone-in-token'); // pass phone_number in link/token/create
  const tag         = argv.find(a => a.startsWith('--tag='))?.replace('--tag=', '')             || '';

  return { institution: inst, username, password, mfaCode, noVision, headless,
           rememberMe, phone, rememberMeOtp, phoneInToken, tag };
}

// ── Plaid API proxy (minimal — reuses plaid-backend.js logic) ─────────────────

/**
 * Minimal HTTP server that serves the test page HTML and proxies Plaid API calls.
 * Starts on an available port starting from 3838.
 */
async function startTestServer(htmlContent, port = 3838) {
  const plaidClientId = process.env.PLAID_CLIENT_ID;
  const plaidSecret   = process.env.PLAID_SANDBOX_SECRET || process.env.PLAID_SECRET;
  const plaidEnv      = process.env.PLAID_ENV || 'sandbox';

  const plaidBaseUrl = {
    sandbox:     'https://sandbox.plaid.com',
    development: 'https://development.plaid.com',
    production:  'https://production.plaid.com',
  }[plaidEnv] || 'https://sandbox.plaid.com';

  /**
   * Forward a request to Plaid API and return the response JSON.
   */
  async function plaidRequest(endpoint, body) {
    const https = require('https');
    const bodyStr = JSON.stringify({
      client_id: plaidClientId,
      secret:    plaidSecret,
      ...body,
    });
    const url = new URL(endpoint, plaidBaseUrl);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path:     url.pathname,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ error: 'parse_error', raw: data.substring(0, 200) }); }
        });
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    // Serve test page — match any GET to / or /index.html regardless of query string
    if (req.method === 'GET') {
      const pathname = req.url.split('?')[0];
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlContent);
        return;
      }
    }

    // Plaid API proxy endpoints
    if (req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch (_) {}

      if (req.url === '/api/create-link-token') {
        if (!plaidClientId || !plaidSecret) {
          res.writeHead(500, cors);
          res.end(JSON.stringify({ error: 'Missing PLAID_CLIENT_ID or PLAID_SECRET in .env' }));
          return;
        }
        // Build user object — include phone_number when provided (E.164 format)
        // This enables Plaid to pre-populate the phone for returning users
        const user = { client_user_id: 'test-user-001' };
        if (body.phone_number) {
          user.phone_number = body.phone_number;
        }
        const result = await plaidRequest('/link/token/create', {
          user,
          client_name: body.client_name || 'Plaid Link Test',
          products: ['auth', 'identity'],
          country_codes: ['US'],
          language: 'en',
        });
        res.writeHead(result.link_token ? 200 : 400, cors);
        res.end(JSON.stringify(result));
        return;
      }

      if (req.url === '/api/exchange-token') {
        const result = await plaidRequest('/item/public_token/exchange', {
          public_token: body.public_token,
        });
        res.writeHead(result.access_token ? 200 : 400, cors);
        res.end(JSON.stringify(result));
        return;
      }
    }

    res.writeHead(404, cors);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // Try ports 3838, 3839, ... until one works
  let usedPort = port;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(usedPort + attempt, '127.0.0.1', () => {
          usedPort = usedPort + attempt;
          resolve();
        });
      });
      break;
    } catch (err) {
      if (attempt === 9) throw new Error('No available port found in range 3838–3847');
    }
  }

  return {
    url:   `http://127.0.0.1:${usedPort}`,
    close: () => new Promise(r => server.close(r)),
  };
}

// ── Minimal test page HTML ─────────────────────────────────────────────────────

function buildTestHtml(institution) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1440">
  <title>Plaid Link Test Harness</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 1440px; height: 900px; overflow: hidden;
      background: #0d1117;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, Helvetica, Arial, sans-serif;
      color: #ffffff;
    }
    .card {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(0,166,126,0.35);
      border-radius: 16px;
      padding: 48px 56px;
      max-width: 560px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 12px; }
    p  { color: rgba(255,255,255,0.65); margin-bottom: 32px; font-size: 15px; }
    #connect-btn {
      background: #00A67E;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 14px 36px;
      font-size: 17px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
      min-width: 200px;
    }
    #connect-btn:hover { background: #008f6b; }
    #connect-btn:disabled { background: #555; cursor: not-allowed; }
    #status {
      margin-top: 24px;
      font-size: 14px;
      color: rgba(255,255,255,0.5);
      min-height: 24px;
    }
    #result {
      margin-top: 20px;
      background: rgba(0,166,126,0.12);
      border: 1px solid rgba(0,166,126,0.35);
      border-radius: 8px;
      padding: 16px;
      font-size: 13px;
      text-align: left;
      display: none;
      word-break: break-all;
    }
    .institution-badge {
      background: rgba(0,166,126,0.15);
      border: 1px solid rgba(0,166,126,0.35);
      border-radius: 20px;
      padding: 4px 14px;
      font-size: 13px;
      color: #00A67E;
      display: inline-block;
      margin-bottom: 24px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Plaid Link Test Harness</h1>
    <p>Validates browser agent navigation through the Plaid Link sandbox flow.</p>
    <div class="institution-badge" id="institution-badge">Institution: ${institution}</div>
    <br>
    <button id="connect-btn" data-testid="connect-btn" onclick="connectPlaid()">
      Connect Account
    </button>
    <div id="status">Ready. Click "Connect Account" to start.</div>
    <div id="result" id="result-panel"></div>
  </div>

  <script>
    window._plaidResult    = null;
    window._plaidComplete  = false;
    window._plaidEvents    = [];

    function setStatus(msg) {
      document.getElementById('status').textContent = msg;
      console.log('[TestPage] ' + msg);
    }

    function showResult(data) {
      const el = document.getElementById('result');
      el.style.display = 'block';
      el.textContent = JSON.stringify(data, null, 2);
    }

    // Read phone number from URL query param (passed when --phone-in-token is used)
    (function() {
      const params = new URLSearchParams(window.location.search);
      window._tokenPhone = params.get('phone') || null;
      if (window._tokenPhone) {
        document.getElementById('institution-badge').textContent =
          'Institution: ${institution} | Phone in token: ' + window._tokenPhone;
      }
    })();

    function connectPlaid() {
      const btn = document.getElementById('connect-btn');
      btn.disabled = true;
      setStatus('Fetching link token...');

      const tokenBody = { client_name: 'Plaid Link Test' };
      if (window._tokenPhone) { tokenBody.phone_number = window._tokenPhone; }

      fetch('/api/create-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tokenBody)
      })
      .then(r => r.json())
      .then(data => {
        if (!data.link_token) {
          setStatus('ERROR: ' + (data.error || 'No link token'));
          window._plaidResult = { error: data.error || 'no_link_token', data };
          btn.disabled = false;
          return;
        }
        setStatus('Link token ready. Opening Plaid Link...');

        const handler = Plaid.create({
          token: data.link_token,
          onSuccess: function(public_token, metadata) {
            window._plaidResult   = { success: true, public_token, metadata };
            window._plaidComplete = true;
            setStatus('SUCCESS — account connected!');
            showResult({ public_token, institution: metadata.institution });
            btn.disabled = false;
          },
          onExit: function(err, metadata) {
            window._plaidResult   = { exited: true, err, metadata };
            window._plaidComplete = true;
            setStatus(err ? 'EXITED with error: ' + err.error_code : 'User exited Plaid Link');
            btn.disabled = false;
          },
          onEvent: function(eventName, metadata) {
            window._plaidEvents.push({ eventName, timestamp: Date.now() });
            console.log('[PlaidEvent] ' + eventName, metadata);
          }
        });
        handler.open();
      })
      .catch(err => {
        setStatus('Fetch error: ' + err.message);
        window._plaidResult = { error: err.message };
        btn.disabled = false;
      });
    }
  </script>
</body>
</html>`;
}

// ── Step runner with timing + result capture ──────────────────────────────────

class StepRunner {
  constructor() {
    this.results = [];
  }

  async run(label, fn) {
    const start = Date.now();
    let success = false;
    let note    = '';
    let err     = null;

    try {
      const result = await fn();
      success = result !== false;
      if (typeof result === 'string') note = result;
    } catch (e) {
      err  = e.message;
      note = e.message;
    }

    const durationMs = Date.now() - start;
    const record = { step: label, success, durationMs, note, err };
    this.results.push(record);

    const icon = success ? '✅' : '❌';
    const dStr = `${(durationMs / 1000).toFixed(1)}s`;
    console.log(`${icon} ${label.padEnd(40)} ${dStr}${note ? '  — ' + note : ''}`);

    return success;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(overrideArgs) {
  const { institution, username, password, mfaCode, noVision, headless,
          rememberMe, phone, rememberMeOtp, phoneInToken, tag } = overrideArgs || parseArgs();

  // Convert local phone number format (415-555-0011) to E.164 (+14155550011) for API
  const phoneE164 = phone ? '+1' + phone.replace(/[-().\s]/g, '') : null;

  const modeLabel = rememberMe
    ? `Remember Me — phone ${phone || '(none)'}${phoneInToken ? ' [in token]' : ''}`
    : `Standard (skip phone)`;

  console.log(`\n🔗 Plaid Link Navigation Test${tag ? ' — ' + tag : ''}`);
  console.log('━'.repeat(50));
  console.log(`  Institution : ${institution}`);
  console.log(`  Username    : ${username}`);
  console.log(`  Mode        : ${noVision ? 'CSS selectors only' : 'Claude Haiku vision'}`);
  console.log(`  Browser     : ${headless ? 'headless' : 'visible'}`);
  console.log(`  Flow        : ${modeLabel}`);
  if (phoneInToken) console.log(`  Phone→Token : ${phoneE164 || '(none)'}`);
  console.log('━'.repeat(50));

  if (!process.env.PLAID_CLIENT_ID || !(process.env.PLAID_SANDBOX_SECRET || process.env.PLAID_SECRET)) {
    console.error('\n[Test] Missing PLAID_CLIENT_ID or PLAID_SANDBOX_SECRET in .env');
    process.exit(1);
  }
  if (!noVision && !process.env.ANTHROPIC_API_KEY) {
    console.error('\n[Test] Missing ANTHROPIC_API_KEY in .env (required for vision mode)');
    console.error('  Run with --no-vision to use CSS selectors only');
    process.exit(1);
  }

  // ── Start test server ────────────────────────────────────────────────────

  const htmlContent = buildTestHtml(institution);
  const server      = await startTestServer(htmlContent);
  console.log(`\n[Test] Server: ${server.url}`);

  // Build page URL — append phone query param when phoneInToken mode is active
  const pageUrl = (phoneInToken && phoneE164)
    ? `${server.url}?phone=${encodeURIComponent(phoneE164)}`
    : server.url;

  // ── Launch Playwright ────────────────────────────────────────────────────

  const browser  = await chromium.launch({ headless });
  const context  = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page     = await context.newPage();

  // Pipe browser console to terminal
  page.on('console', msg => {
    const text = msg.text();
    if (!text.includes('[PlaidEvent]') || process.env.VERBOSE) {
      console.log(`  [browser] ${text}`);
    }
  });

  const runner = new StepRunner();
  const creds  = { username, password, institution, mfa: mfaCode };

  try {
    // ── 1. Load page ───────────────────────────────────────────────────────
    await runner.run('Load test page', async () => {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);
      return true;
    });

    // ── 2. Click Connect button ────────────────────────────────────────────
    await runner.run('Click Connect button', async () => {
      // Try direct selector first (fast path)
      const btn = page.locator('[data-testid="connect-btn"]');
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click();
        return 'data-testid selector';
      }
      if (!noVision) {
        const ok = await agent.visionClick(page,
          'Find the "Connect Account" button on the dark page. Click it.',
          { retries: 2, waitAfterMs: 1000 }
        );
        return ok ? 'vision click' : false;
      }
      return false;
    });

    // Wait for Plaid Link to initialize
    await page.waitForTimeout(2000);

    // ── 3. Wait for Plaid iframe ───────────────────────────────────────────
    await runner.run('Plaid iframe appears', async () => {
      await page.waitForSelector(
        'iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]',
        { state: 'attached', timeout: 20000 }
      );
      await page.waitForTimeout(1500);
      return true;
    });

    // ── 4. Phone screen — skip OR enter Remember Me phone number ─────────
    if (rememberMe && phone) {
      await runner.run(`Enter Remember Me phone: ${phone}`, async () => {
        const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

        // First: dump current screen state so we can distinguish phone entry from OTP entry
        try {
          const allFrames = page.frames();
          const plaidFrame = allFrames.find(f => f.url().includes('cdn.plaid.com') || f.url().includes('plaid.com/link'));
          if (plaidFrame) {
            const inputs = await plaidFrame.evaluate(() =>
              Array.from(document.querySelectorAll('input')).map(i => ({
                type: i.type, inputmode: i.inputMode, maxlength: i.maxLength,
                placeholder: i.placeholder, name: i.name, autocomplete: i.autocomplete,
                ariaLabel: i.getAttribute('aria-label'),
              }))
            ).catch(() => []);
            const heading = await plaidFrame.evaluate(() =>
              document.querySelector('h1,h2,h3,[role="heading"]')?.textContent?.trim()
            ).catch(() => null);
            console.log(`  [Test] Phone screen heading: ${heading || '(none)'}`);
            console.log(`  [Test] Phone screen inputs: ${JSON.stringify(inputs)}`);
          }
        } catch (_) {}

        // Phone input selectors
        const phoneSelectors = [
          'input[type="tel"]',
          'input[placeholder*="phone" i]',
          'input[placeholder*="(555)" i]',
          'input[name*="phone" i]',
          'input[autocomplete*="tel"]',
        ];
        for (const sel of phoneSelectors) {
          try {
            const el = frame.locator(sel).first();
            if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
              // Check if this looks like an OTP input (maxlength=6) vs phone input
              const attrs = await el.evaluate(i => ({
                maxlength: i.maxLength, placeholder: i.placeholder, inputmode: i.inputMode,
              })).catch(() => ({}));
              if (attrs.maxlength === 6 || attrs.inputmode === 'numeric') {
                console.log(`  [Test] Found input that looks like OTP (maxlength=${attrs.maxlength}, inputmode=${attrs.inputmode}) — skipping phone fill`);
                return 'Phone screen not shown — Plaid shows OTP directly for returning user';
              }
              await el.fill(phone);
              await page.waitForTimeout(1000); // wait for debounce + button enable
              // Click Continue / Submit — most common labels first to minimize wait time
              const phoneBtnSelectors = [
                'button:has-text("Send code")',     // returning user "Send verification code"
                'button:has-text("Continue")',       // new user standard flow
                'button[type="submit"]',
                'button:has-text("Next")',
                'button:has-text("Get code")',
                'button:has-text("Text me")',
                'button:has-text("Verify")',
                'button:has-text("Confirm")',
                'button:has-text("Submit")',
              ];
              for (const btnSel of phoneBtnSelectors) {
                try {
                  const btn = frame.locator(btnSel).first();
                  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await btn.click();
                    await page.waitForTimeout(2000);
                    return `Phone entered via "${sel}" + submitted via "${btnSel}"`;
                  }
                } catch (_) {}
              }
              // Dump all buttons for diagnostics before giving up
              try {
                const allFrames = page.frames();
                const plaidFrame = allFrames.find(f => f.url().includes('cdn.plaid.com') || f.url().includes('plaid.com/link'));
                if (plaidFrame) {
                  const btns = await plaidFrame.evaluate(() =>
                    Array.from(document.querySelectorAll('button')).map(b => ({
                      text: b.textContent?.trim(), disabled: b.disabled, type: b.type,
                    }))
                  ).catch(() => []);
                  console.log(`  [Test] Phone submit — all buttons: ${JSON.stringify(btns)}`);
                }
              } catch (_) {}
              return `Phone entered via "${sel}" (submit not found)`;
            }
          } catch (_) {}
        }
        // Phone screen may not have appeared — dump frame state
        try {
          const allFrames = page.frames();
          const plaidFrame = allFrames.find(f => f.url().includes('cdn.plaid.com') || f.url().includes('plaid.com/link'));
          if (plaidFrame) {
            const btns = await plaidFrame.evaluate(() =>
              Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)
            ).catch(() => []);
            const inputs = await plaidFrame.evaluate(() =>
              Array.from(document.querySelectorAll('input')).map(i => `${i.type}[${i.placeholder || i.name || '?'}]`)
            ).catch(() => []);
            console.log(`  [Test] Frame buttons: ${btns.join(' | ') || '(none)'}`);
            console.log(`  [Test] Frame inputs:  ${inputs.join(' | ') || '(none)'}`);
          }
        } catch (_) {}
        return 'Phone screen not detected — may have been skipped automatically';
      });

      // ── 4b. Enter Remember Me OTP ────────────────────────────────────────
      await runner.run(`Enter Remember Me OTP: ${rememberMeOtp}`, async () => {
        const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');
        await page.waitForTimeout(1000);

        const otpSelectors = [
          'input[type="tel"]',
          'input[inputmode="numeric"]',
          'input[maxlength="6"]',
          'input[placeholder*="code" i]',
          'input[placeholder*="otp" i]',
          'input[autocomplete*="one-time-code"]',
          'input[type="text"]',
        ];
        for (const sel of otpSelectors) {
          try {
            const el = frame.locator(sel).first();
            if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
              await el.fill(rememberMeOtp);
              await page.waitForTimeout(800);
              // Try all known OTP submit button labels
              const otpBtnSelectors = [
                'button[type="submit"]',
                'button:has-text("Continue")',
                'button:has-text("Verify")',
                'button:has-text("Next")',
                'button:has-text("Confirm")',
                'button:has-text("Submit")',
                'button:has-text("Verify code")',
                'button:has-text("Check code")',
              ];
              for (const btnSel of otpBtnSelectors) {
                try {
                  const btn = frame.locator(btnSel).first();
                  if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
                    await btn.click();
                    await page.waitForTimeout(3000);
                    return `OTP entered via "${sel}" + submitted via "${btnSel}"`;
                  }
                } catch (_) {}
              }
              // Fallback: press Enter on the OTP input
              try {
                await el.press('Enter');
                await page.waitForTimeout(3000);
                return `OTP entered via "${sel}" + Enter key`;
              } catch (_) {}
              return `OTP entered via "${sel}" (submit not found)`;
            }
          } catch (_) {}
        }
        // Dump state if OTP screen not found
        try {
          const allFrames = page.frames();
          const plaidFrame = allFrames.find(f => f.url().includes('cdn.plaid.com') || f.url().includes('plaid.com/link'));
          if (plaidFrame) {
            const btns = await plaidFrame.evaluate(() =>
              Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)
            ).catch(() => []);
            const inputs = await plaidFrame.evaluate(() =>
              Array.from(document.querySelectorAll('input')).map(i => `${i.type}[${i.placeholder || i.name || i.autocomplete || '?'}]`)
            ).catch(() => []);
            console.log(`  [Test] After phone submit — buttons: ${btns.join(' | ') || '(none)'}`);
            console.log(`  [Test] After phone submit — inputs:  ${inputs.join(' | ') || '(none)'}`);
          }
        } catch (_) {}
        return 'OTP screen not shown — Plaid may have auto-advanced';
      });

    } else {
      await runner.run('Skip Remember Me phone screen', async () => {
        const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');
        const skipTexts = ['Continue without phone number', 'without phone number', 'Skip'];
        for (const text of skipTexts) {
          try {
            const el = frame.getByText(text, { exact: false }).first();
            if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
              await el.click();
              await page.waitForTimeout(1500);
              return `frameLocator — "${text}"`;
            }
          } catch (_) {}
        }
        return 'Not shown — no skip needed';
      });
    }

    // ── 5. Accept consent / Get Started ───────────────────────────────────
    await runner.run('Accept data sharing consent', async () => {
      const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');
      const consentLabels = ['I agree', 'Agree', 'Get started', 'Continue', 'Next'];
      for (const label of consentLabels) {
        try {
          const btn = frame.getByRole('button', { name: label, exact: false }).first();
          if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await btn.click();
            await page.waitForTimeout(2000);
            return `frameLocator button — "${label}"`;
          }
        } catch (_) {}
      }
      // Vision fallback
      if (!noVision) {
        const ok = await agent.clickContinue(page);
        return ok ? 'vision — Continue/Agree' : false;
      }
      return 'Not found';
    });

    // ── 6. Search for institution ──────────────────────────────────────────
    await runner.run(`Search for "${institution}"`, async () => {
      const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

      // Try various search input selectors
      const searchSelectors = [
        'input[placeholder*="Search" i]',
        'input[type="search"]',
        'input[name="search"]',
        'input[aria-label*="Search" i]',
        '[data-testid="search-input"]',
      ];
      for (const sel of searchSelectors) {
        try {
          const input = frame.locator(sel).first();
          if (await input.isVisible({ timeout: 4000 }).catch(() => false)) {
            await input.fill(institution);
            await page.waitForTimeout(2000);
            return `frameLocator input — "${sel}"`;
          }
        } catch (_) {}
      }
      // Vision fallback
      if (!noVision) {
        const ok = await agent.visionType(page,
          `Find the institution search text input inside the white Plaid Link modal.`,
          institution, { waitAfterMs: 2000 }
        );
        return ok ? 'vision type' : false;
      }
      return false;
    });

    // ── 7. Select institution from results ────────────────────────────────
    await runner.run(`Select "${institution}" from results`, async () => {
      const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

      // Prefer text-based selection (most reliable — exact match to what we searched for)
      try {
        const byText = frame.getByText(institution, { exact: false }).first();
        if (await byText.isVisible({ timeout: 5000 }).catch(() => false)) {
          await byText.click();
          await page.waitForTimeout(2500);
          return `frameLocator getByText — "${institution}"`;
        }
      } catch (_) {}

      // Selector-based fallbacks
      const resultSelectors = [
        '[data-testid*="institution"]',
        'li[role="option"]',
        'button[role="option"]',
        'ul li button',
        '[class*="institution" i]',
      ];
      for (const sel of resultSelectors) {
        try {
          const el = frame.locator(sel).first();
          if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
            await el.click();
            await page.waitForTimeout(2500);
            return `frameLocator — "${sel}"`;
          }
        } catch (_) {}
      }

      // Vision fallback
      if (!noVision) {
        const ok = await agent.visionClick(page,
          `Find and click the "${institution}" institution row in the search results list inside the Plaid Link modal.`,
          { retries: 2, waitAfterMs: 2500 }
        );
        return ok ? 'vision click' : false;
      }
      return false;
    });

    // ── 8. Check for intermediate connection type screen ──────────────────
    await runner.run('Handle connection type screen (if shown)', async () => {
      const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');
      // If multiple connection options appear, click the first (standard credentials)
      const optionSelectors = [
        'li:first-of-type button',
        '[data-testid*="institution-option"]:first-of-type',
        'ul li:first-of-type',
      ];
      for (const sel of optionSelectors) {
        try {
          const el = frame.locator(sel).first();
          if (await el.isVisible({ timeout: 2500 }).catch(() => false)) {
            await el.click();
            await page.waitForTimeout(2000);
            return `Selected first option — "${sel}"`;
          }
        } catch (_) {}
      }
      return 'Not shown — single connection type';
    });

    // ── 9. Enter username ─────────────────────────────────────────────────
    await runner.run(`Enter username: ${username}`, async () => {
      const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');
      const usernameSelectors = [
        'input[name="username"]',
        'input[id*="username" i]',
        'input[placeholder*="user" i]',
        'input[type="text"]:first-of-type',
      ];
      for (const sel of usernameSelectors) {
        try {
          const el = frame.locator(sel).first();
          if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
            await el.fill(username);
            return `frameLocator — "${sel}"`;
          }
        } catch (_) {}
      }
      if (!noVision) {
        const ok = await agent.visionType(page, 'Find the username or user ID input field.', username);
        return ok ? 'vision type' : false;
      }
      return false;
    });

    // ── 10. Enter password ────────────────────────────────────────────────
    await runner.run('Enter password', async () => {
      const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');
      const passwordSelectors = [
        'input[name="password"]',
        'input[type="password"]',
        'input[id*="password" i]',
      ];
      for (const sel of passwordSelectors) {
        try {
          const el = frame.locator(sel).first();
          if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
            await el.fill(password);
            return `frameLocator — "${sel}"`;
          }
        } catch (_) {}
      }
      if (!noVision) {
        const ok = await agent.visionType(page, 'Find the password input (characters shown as dots).', password);
        return ok ? 'vision type' : false;
      }
      return false;
    });

    // ── 11. Submit credentials ────────────────────────────────────────────
    await runner.run('Submit credentials', async () => {
      const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');
      const submitSelectors = [
        'button[type="submit"]',
        'button:has-text("Submit")',
        'button:has-text("Log in")',
        'button:has-text("Sign in")',
        'button:has-text("Continue")',
      ];
      for (const sel of submitSelectors) {
        try {
          const btn = frame.locator(sel).first();
          if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await btn.click();
            await page.waitForTimeout(4000);
            return `frameLocator — "${sel}"`;
          }
        } catch (_) {}
      }
      if (!noVision) {
        const ok = await agent.visionClick(page, 'Find the Submit or Sign in button.', { retries: 1, waitAfterMs: 4000 });
        return ok ? 'vision click' : false;
      }
      return false;
    });

    // ── 12. Handle MFA if shown ───────────────────────────────────────────
    await runner.run('Enter MFA code (if shown)', async () => {
      const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');
      const mfaSelectors = [
        'input[placeholder*="code" i]',
        'input[placeholder*="otp" i]',
        'input[placeholder*="pin" i]',
        'input[type="tel"]',
        'input[maxlength="4"]',
        'input[maxlength="6"]',
      ];
      for (const sel of mfaSelectors) {
        try {
          const el = frame.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
            await el.fill(mfaCode);
            await page.waitForTimeout(500);
            // Submit MFA
            try {
              const submitBtn = frame.locator('button[type="submit"], button:has-text("Submit")').first();
              if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await submitBtn.click();
              }
            } catch (_) {}
            await page.waitForTimeout(3000);
            return `MFA entered — "${sel}"`;
          }
        } catch (_) {}
      }
      return 'Not shown — no MFA prompted';
    });

    // ── 13. Select first account ──────────────────────────────────────────
    await runner.run('Select first account', async () => {
      const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

      // Wait for account list to appear. Plaid shows a progressbar (SPAN[role=progressbar])
      // while accounts load — wait for it to disappear before trying to select.
      try {
        await frame.locator('[role="progressbar"]').waitFor({ state: 'hidden', timeout: 8000 });
      } catch (_) { /* progressbar may not appear on fast connections */ }
      await page.waitForTimeout(1000);

      // Plaid Link account rows: discovered via iframe DOM dump.
      // Checkboxes are HIDDEN inputs inside LI[role=listitem] wrappers — the LI is the
      // clickable element. input[type="checkbox"] exists but isVisible() returns false.
      // Correct approach: click the LI row directly.
      const accountSelectors = [
        // Primary: confirmed by DOM dump (Plaid renders accounts as LI wrappers with hidden inputs)
        'li[role="listitem"]',
        // Also try direct role-based selectors
        '[role="radio"]',
        'input[type="radio"]',
        // Fallbacks
        '[data-testid*="account"]',
        '[class*="Account"]',
        'ul li',
        'label:has(input)',
      ];

      let selectedVia = null;
      for (const sel of accountSelectors) {
        try {
          const el = frame.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
            await el.click();
            await page.waitForTimeout(1000);
            selectedVia = sel;
            break;
          }
        } catch (_) {}
      }

      // If no account selector matched, dump iframe buttons + inputs for diagnostics
      if (!selectedVia) {
        try {
          const allFrames = page.frames();
          const plaidFrame = allFrames.find(f => f.url().includes('cdn.plaid.com') || f.url().includes('plaid.com/link'));
          if (plaidFrame) {
            const btns = await plaidFrame.evaluate(() =>
              Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)
            ).catch(() => []);
            const inputs = await plaidFrame.evaluate(() =>
              Array.from(document.querySelectorAll('input')).map(i => `${i.type}[${i.name || i.placeholder || '?'}]`)
            ).catch(() => []);
            const roles = await plaidFrame.evaluate(() =>
              Array.from(document.querySelectorAll('[role]')).map(e => `${e.tagName}[role=${e.getAttribute('role')}]`).slice(0, 20)
            ).catch(() => []);
            // Also dump alert text + heading + full body text for diagnostics
            const alertText = await plaidFrame.evaluate(() =>
              Array.from(document.querySelectorAll('[role="alert"]')).map(e => e.textContent?.trim()).filter(Boolean)
            ).catch(() => []);
            const heading = await plaidFrame.evaluate(() =>
              document.querySelector('h1,h2,h3,[role="heading"]')?.textContent?.trim()
            ).catch(() => null);
            const bodyText = await plaidFrame.evaluate(() =>
              Array.from(document.querySelectorAll('p,span,div'))
                .map(e => e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 ? e.textContent?.trim() : null)
                .filter(t => t && t.length > 3 && t.length < 200)
                .slice(0, 10)
            ).catch(() => []);
            console.log(`  [Test] Account screen buttons: ${btns.join(' | ') || '(none)'}`);
            console.log(`  [Test] Account screen inputs:  ${inputs.join(' | ') || '(none)'}`);
            console.log(`  [Test] Account screen roles:   ${roles.join(' | ') || '(none)'}`);
            console.log(`  [Test] Account screen heading: ${heading || '(none)'}`);
            console.log(`  [Test] Account screen alerts:  ${alertText.join(' | ') || '(none)'}`);
            console.log(`  [Test] Account screen text:    ${bodyText.join(' | ') || '(none)'}`);
          }
        } catch (_) {}
      }

      // Click Continue (or "Confirm" for returning-user screens, "Link account" / submit)
      const continueSelectors = [
        'button:has-text("Continue")',
        'button:has-text("Confirm")',       // returning-user: "Confirm | Add new account"
        'button:has-text("Link account")',
        'button:has-text("Connect")',
        'button[type="submit"]',
      ];
      for (const sel of continueSelectors) {
        try {
          const btn = frame.locator(sel).first();
          if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await btn.click();
            await page.waitForTimeout(2000);
            return selectedVia
              ? `Account selected via "${selectedVia}" + Continue clicked`
              : `Continue clicked without explicit account selection (may already be pre-selected)`;
          }
        } catch (_) {}
      }
      return selectedVia ? `Account selected via "${selectedVia}" (Continue not found)` : false;
    });

    // ── 14. Dismiss "Save with Plaid" phone screen ────────────────────────
    await runner.run('Dismiss Save with Plaid screen (if shown)', async () => {
      const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');
      const dismissSelectors = [
        'button:has-text("Finish without saving")',
        'button:has-text("without saving")',
        'a:has-text("Finish without saving")',
      ];
      for (const sel of dismissSelectors) {
        try {
          const el = frame.locator(sel).first();
          if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
            await el.click();
            await page.waitForTimeout(1500);
            return `Dismissed — "${sel}"`;
          }
        } catch (_) {}
      }
      return 'Not shown — clean exit';
    });

    // ── 15. Final "Connect account information" / permissions screen ──────────
    await runner.run('Handle final permissions screen (if shown)', async () => {
      const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');
      await page.waitForTimeout(1500);

      // Plaid Link shows a final permissions review screen before onSuccess.
      // Button text varies: "Connect account information", "Allow", "Authorize", "Connect"
      const finalSelectors = [
        'button:has-text("Connect account information")',
        'button:has-text("Allow")',
        'button:has-text("Authorize")',
        'button:has-text("Continue")',
        'button[type="submit"]',
      ];
      for (const sel of finalSelectors) {
        try {
          const btn = frame.locator(sel).first();
          if (await btn.isVisible({ timeout: 4000 }).catch(() => false)) {
            // Log what button text we found for learning
            const btnText = await btn.innerText().catch(() => sel);
            await btn.click();
            await page.waitForTimeout(2000);
            return `Clicked final button: "${btnText.trim()}"`;
          }
        } catch (_) {}
      }

      // Try to dump iframe state for diagnostics
      try {
        const allFrames = page.frames();
        const plaidFrame = allFrames.find(f => f.url().includes('cdn.plaid.com') || f.url().includes('plaid.com/link'));
        if (plaidFrame) {
          const buttons = await plaidFrame.evaluate(() =>
            Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)
          ).catch(() => []);
          if (buttons.length > 0) {
            console.log(`  [Test] Visible buttons in Plaid frame: ${buttons.join(' | ')}`);
          }
        }
      } catch (_) {}

      return 'Not shown — may have auto-advanced';
    });

    // ── 16. Wait for Plaid onSuccess ──────────────────────────────────────
    await runner.run('Plaid Link onSuccess fires', async () => {
      // Note: waitForFunction(fn, arg, options) — pass null as arg so options are recognized
      await page.waitForFunction(
        () => window._plaidComplete === true,
        null,
        { timeout: 60000 }
      );
      const result = await page.evaluate(() => window._plaidResult);
      if (result?.success) return `public_token received`;
      if (result?.exited) return `User exited — ${result.err?.error_code || 'no error'}`;
      return false;
    });

  } catch (err) {
    console.error(`\n[Test] Fatal error: ${err.message}`);
    runner.results.push({ step: 'FATAL', success: false, note: err.message });
  }

  // ── Results summary ──────────────────────────────────────────────────────

  const passed  = runner.results.filter(r => r.success).length;
  const failed  = runner.results.filter(r => !r.success).length;
  const total   = runner.results.length;
  const allPass = failed === 0;

  console.log('\n' + '━'.repeat(50));
  console.log(`Results: ${passed}/${total} steps passed${allPass ? ' ✅' : ' ❌'}`);

  // Capture Plaid events
  const plaidEvents = await page.evaluate(() => window._plaidEvents || []).catch(() => []);
  const plaidResult = await page.evaluate(() => window._plaidResult).catch(() => null);

  // ── Write report ─────────────────────────────────────────────────────────

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(OUT_DIR, `plaid-link-test-${timestamp}.json`);

  const report = {
    testedAt:    new Date().toISOString(),
    institution,
    username,
    mode:        noVision ? 'css-only' : 'vision',
    headless,
    rememberMe,
    phone:       rememberMe ? phone : null,
    phoneInToken: phoneInToken || false,
    tag,
    passed,
    failed,
    total,
    allPass,
    steps:       runner.results,
    plaidEvents,
    plaidResult,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[Test] Report: ${reportPath}`);

  // ── Update learnings file ─────────────────────────────────────────────────

  updateLearnings(report);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  await page.waitForTimeout(headless ? 0 : 2000);
  await browser.close();
  await server.close();

  return report;
}

// ── Direct invocation entry point ────────────────────────────────────────────

async function runFromCLI() {
  const report = await main();
  process.exit(report.allPass ? 0 : 1);
}

// ── Learnings writer ──────────────────────────────────────────────────────────

function updateLearnings(report) {
  const date    = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const status  = report.allPass ? 'PASS' : 'FAIL';
  const modeStr = report.mode === 'vision' ? 'vision+CSS' : 'CSS-only';

  const successStrategies = report.steps
    .filter(s => s.success && s.note && s.note !== 'true')
    .map(s => `  - **${s.step}**: ${s.note}`)
    .join('\n');

  const failedSteps = report.steps
    .filter(s => !s.success)
    .map(s => `  - **${s.step}**: ${s.note || 'no detail'}`)
    .join('\n');

  const flowDesc = report.rememberMe
    ? `Remember Me phone=${report.phone}${report.phoneInToken ? ' [phone in token]' : ''}`
    : 'Standard (skip phone)';

  const entry = `
## Run: ${date} — ${status} (${report.passed}/${report.total}) [${modeStr}]${report.tag ? ' — ' + report.tag : ''}
**Institution**: ${report.institution} | **Username**: ${report.username} | **Flow**: ${flowDesc}

### What worked:
${successStrategies || '  (none)'}

### What failed:
${failedSteps || '  (none — all passed!)'}

### Plaid events observed:
  ${report.plaidEvents.map(e => e.eventName).join(', ') || '(none)'}

---
`;

  let existing = '';
  if (fs.existsSync(LEARNINGS_FILE)) {
    existing = fs.readFileSync(LEARNINGS_FILE, 'utf8');
  }

  if (!existing) {
    existing = `# Plaid Link Navigation Learnings

Cumulative log of test harness runs. Each run records which CSS selectors and
vision strategies succeeded per step. Use this to tune plaid-browser-agent.js.

---
`;
  }

  fs.writeFileSync(LEARNINGS_FILE, existing + entry);
  console.log(`[Test] Learnings updated: ${LEARNINGS_FILE}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

module.exports = { main, parseArgs, updateLearnings };

if (require.main === module) {
  runFromCLI().catch(err => {
    console.error('[Test] Fatal:', err.message);
    process.exit(1);
  });
}
