'use strict';
/**
 * test-plaid-link-record.js
 *
 * Records the real Plaid Link SDK end-to-end using CDP frameLocator automation.
 *
 * Key behaviours:
 *   - Event-driven screen detection: waits for TRANSITION_VIEW events instead of
 *     fixed timeouts. Each screen change is detected in ~100ms; no time wasted.
 *   - Dynamic OAuth handling: if OPEN_OAUTH fires after selecting an institution,
 *     clicks the Plaid back button and selects the next institution in the list.
 *     No pre-determined list of OAuth banks required.
 *   - SCREEN_DWELL_MS: after each screen loads, pauses this many ms so the screen
 *     is fully visible in the recording. Default 4000ms (~4s per screen).
 *
 * Outputs to: out/plaid-link-test/
 *   recording.webm      — full browser recording (non-headless; captures iframe)
 *   screenshots/        — CDP screenshots at each step
 *   result.json         — public_token, access_token, auth/get response
 *
 * Usage:
 *   node scripts/test-plaid-link-record.js
 *   SCREEN_DWELL_MS=500 node scripts/test-plaid-link-record.js   # fast mode
 */

require('dotenv').config({ override: true });
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { startServer } = require('./scratch/utils/app-server');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT    = path.resolve(__dirname, '..');
const OUT_DIR         = path.join(PROJECT_ROOT, 'out', 'plaid-link-test');
const APP_DIR         = path.join(OUT_DIR, 'app');
const SCREENSHOTS_DIR = path.join(OUT_DIR, 'screenshots');
const REC_TMP_DIR     = path.join(OUT_DIR, '_rec-tmp');
const RESULT_FILE        = path.join(OUT_DIR, 'result.json');
const STEP_TIMING_FILE   = path.join(OUT_DIR, 'step-timing.json');

// ── Step timing (recording-relative) ─────────────────────────────────────────
// Records when each navigation step occurs relative to context/recording start.
// Written to step-timing.json for post-processing (ffmpeg section speed-up).

let _contextCreatedMs = 0;
const _stepTimings = [];

function recordStep(name) {
  const offsetS = _contextCreatedMs ? (Date.now() - _contextCreatedMs) / 1000 : null;
  _stepTimings.push({ step: name, recordingOffsetS: offsetS !== null ? parseFloat(offsetS.toFixed(2)) : null });
  console.log(`  [Timing] ${name}: ${offsetS !== null ? offsetS.toFixed(1) + 's' : 'N/A'}`);
}

// ── Config ────────────────────────────────────────────────────────────────────

// How long to remain on each Plaid Link screen in the recording (~4s = 1 cut).
// Override with env var for fast test mode: SCREEN_DWELL_MS=500
const SCREEN_DWELL_MS = parseInt(process.env.SCREEN_DWELL_MS || '4000', 10);

const PHONE    = '+14155550011';   // Remember Me returning-user
const OTP      = '123456';
const USERNAME = 'user_good';
const PASSWORD = 'pass_good';

// ── HTML app ──────────────────────────────────────────────────────────────────
// Tracks Plaid events and exposes them on window.* for Playwright to poll.

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Plaid Link Navigation Test</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0d1117; color: #fff;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      min-height: 100vh; gap: 32px;
    }
    h1 { font-size: 28px; font-weight: 700; }
    h1 span { color: #00A67E; }
    #status-panel {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(0,166,126,0.3);
      border-radius: 12px; padding: 24px 32px;
      min-width: 480px; max-width: 600px;
    }
    #status-label { font-size: 13px; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    #status-value { font-size: 20px; font-weight: 600; color: #00A67E; min-height: 28px; }
    #events-list { margin-top: 20px; display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto; }
    .event-row { font-size: 13px; color: rgba(255,255,255,0.65); padding: 4px 8px; background: rgba(255,255,255,0.04); border-radius: 4px; font-family: monospace; }
    #launch-btn {
      background: #00A67E; color: #fff; border: none;
      border-radius: 8px; padding: 16px 40px;
      font-size: 17px; font-weight: 600; cursor: pointer;
    }
    #launch-btn:disabled { background: rgba(0,166,126,0.3); cursor: not-allowed; }
    #success-panel {
      display: none;
      background: rgba(0,166,126,0.12);
      border: 1px solid rgba(0,166,126,0.5);
      border-radius: 12px; padding: 24px 32px;
      min-width: 480px; max-width: 600px;
    }
    #success-panel.visible { display: block; }
    #success-panel h2 { color: #00A67E; margin-bottom: 12px; }
    #success-panel p { font-size: 14px; color: rgba(255,255,255,0.75); margin-bottom: 6px; word-break: break-all; font-family: monospace; }
  </style>
</head>
<body>
  <h1>Plaid Link <span>Navigation Test</span></h1>
  <div id="status-panel">
    <div id="status-label">Status</div>
    <div id="status-value">Initializing...</div>
    <div id="events-list"></div>
  </div>
  <button id="launch-btn" data-testid="launch-plaid-link-btn" disabled>Launch Plaid Link</button>
  <div id="success-panel" data-testid="success-panel">
    <h2>Link Successful</h2>
    <div id="token-display"></div>
  </div>

  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <script>
    // ── Event tracking (polled by Playwright) ─────────────────────────────────
    window._plaidTransitionCount = 0;  // incremented on every TRANSITION_VIEW
    window._plaidOAuthDetected   = false; // set when OPEN_OAUTH fires
    window._plaidLinkComplete    = false;
    window._publicToken = null;
    window._accessToken = null;
    window._itemId      = null;

    const statusValue  = document.getElementById('status-value');
    const eventsList   = document.getElementById('events-list');
    const launchBtn    = document.getElementById('launch-btn');
    const successPanel = document.getElementById('success-panel');

    function setStatus(msg) {
      statusValue.textContent = msg;
      console.log('[App]', msg);
    }

    async function initPlaidLink() {
      try {
        setStatus('Fetching link token...');
        const res = await fetch('/api/create-link-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            products: ['auth', 'identity'],
            client_name: 'Plaid Link Test',
            user_id: 'test-user-001',
            // Pass phone so Plaid can identify this as a returning Remember Me user
            // on the backend. Does NOT skip the phone entry UI screen.
            phone_number: '+14155550011',
            link_customization_name: '',
          }),
        });
        const data = await res.json();
        console.log('[App] link_token:', data.link_token.substring(0, 30) + '...');

        window._plaidHandler = Plaid.create({
          token: data.link_token,

          onSuccess(public_token, metadata) {
            console.log('[App] onSuccess:', public_token);
            setStatus('Link successful!');
            window._publicToken = public_token;
            window._linkMetadata = metadata;
            fetch('/api/exchange-public-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ public_token }),
            })
            .then(r => r.json())
            .then(d => {
              window._accessToken = d.access_token;
              window._itemId      = d.item_id;
              console.log('[App] access_token:', d.access_token);
              const td = document.getElementById('token-display');
              td.innerHTML =
                '<p>public_token: '  + public_token.substring(0, 35)         + '...</p>' +
                '<p>access_token: '  + (d.access_token||'').substring(0, 35) + '...</p>' +
                '<p>item_id: '       + (d.item_id||'')                       + '</p>';
              successPanel.classList.add('visible');
              window._plaidLinkComplete = true;
            })
            .catch(err => {
              console.error('[App] exchange error:', err);
              window._plaidLinkComplete = true;
            });
          },

          onExit(err, metadata) {
            console.warn('[App] onExit', err, metadata);
            setStatus(err ? 'Exited: ' + err.error_message : 'Exited');
            window._plaidLinkComplete = true;
          },

          onEvent(eventName, metadata) {
            // Append to UI
            const row = document.createElement('div');
            row.className = 'event-row';
            row.textContent = eventName + (metadata.view_name ? ' → ' + metadata.view_name : '');
            eventsList.appendChild(row);
            eventsList.scrollTop = eventsList.scrollHeight;
            setStatus(eventName + (metadata.view_name ? ' → ' + metadata.view_name : ''));
            console.log('[PlaidEvent]', eventName, metadata);

            // Update counters for Playwright polling
            if (eventName === 'TRANSITION_VIEW') {
              window._plaidTransitionCount++;
              if (metadata.view_name) window._plaidLastView = metadata.view_name;
              // Persistent flag — once set, never reset (survives subsequent transitions)
              if (metadata.view_name === 'SELECT_SAVED_INSTITUTION') {
                window._plaidSavedInstShown = true;
              }
            }
            if (eventName === 'OPEN_OAUTH') window._plaidOAuthDetected = true;
          },
        });

        setStatus('Ready — click Launch to begin');
        launchBtn.disabled = false;
      } catch (err) {
        console.error('[App] init error:', err);
        setStatus('Error: ' + err.message);
      }
    }

    launchBtn.addEventListener('click', () => {
      if (window._plaidHandler) {
        setStatus('Opening Plaid Link...');
        window._plaidHandler.open();
      }
    });

    initPlaidLink();
  </script>
</body>
</html>
`;

// ── Screenshot helper ─────────────────────────────────────────────────────────

let _screenshotIndex = 0;
async function screenshot(page, label) {
  const name = String(++_screenshotIndex).padStart(2, '0') + '-' + label.replace(/[\s/]+/g, '-') + '.png';
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, name), fullPage: false })
    .then(() => console.log(`  [Screenshot] ${name}`))
    .catch(err => console.warn(`  [Screenshot] failed (${label}): ${err.message}`));
}

// ── Event-driven wait helpers ─────────────────────────────────────────────────

/**
 * Wait for the next TRANSITION_VIEW event from Plaid Link.
 * Returns quickly (~100ms) once Plaid fires the event; times out gracefully.
 * After detecting the transition, pauses SCREEN_DWELL_MS so the screen is
 * visible in the recording.
 *
 * @param {Page}   page
 * @param {number} [timeoutMs=8000]  Max wait for the transition event
 * @param {number} [dwell]           Override dwell; defaults to SCREEN_DWELL_MS
 */
async function waitForTransition(page, timeoutMs = 8000, dwell = SCREEN_DWELL_MS) {
  const before = await page.evaluate(() => window._plaidTransitionCount || 0);
  await page.waitForFunction(
    (n) => (window._plaidTransitionCount || 0) > n,
    before,
    { timeout: timeoutMs, polling: 100 }
  ).catch(() => null);  // timeout is non-fatal — Plaid may not always fire TRANSITION_VIEW
  // Short settle wait: Chromium's GPU compositor shows a brief blank frame between
  // cross-origin iframe repaints. 200ms lets the new screen fully render before dwell.
  await page.waitForTimeout(200);
  if (dwell > 0) await page.waitForTimeout(dwell);
}

/**
 * Wait for any of a set of Plaid events.
 * Resolves as soon as one fires or timeout elapses.
 * Returns the name of the event that fired, or null on timeout.
 */
async function waitForEvent(page, eventNames, timeoutMs = 5000) {
  const nameSet = JSON.stringify(eventNames);
  return page.waitForFunction(
    ([names, before]) => {
      const log = window._plaidEventLog || [];
      return log.slice(before).find(e => names.includes(e.name))?.name || null;
    },
    [eventNames, await page.evaluate(() => (window._plaidEventLog||[]).length)],
    { timeout: timeoutMs, polling: 100 }
  ).then(handle => handle.jsonValue()).catch(() => null);
}

// Expose _plaidEventLog in the page (HTML only sets _plaidTransitionCount)
// We add a lightweight shim after page load.
async function injectEventLog(page) {
  await page.evaluate(() => {
    window._plaidEventLog = window._plaidEventLog || [];
    const orig = window._plaidHandler;
    // Patch onEvent to also push to _plaidEventLog
    // (The HTML onEvent already does this via addEvent; we just add the log array)
    const origCreate = Plaid.create.bind(Plaid);
    Plaid.create = function(cfg) {
      const origOnEvent = cfg.onEvent;
      cfg.onEvent = function(name, meta) {
        window._plaidEventLog = window._plaidEventLog || [];
        window._plaidEventLog.push({ name, meta, ts: Date.now() });
        if (origOnEvent) origOnEvent(name, meta);
      };
      return origCreate(cfg);
    };
  }).catch(() => {});
}

// ── Plaid iframe helpers ──────────────────────────────────────────────────────

function getFrame(page) {
  return page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');
}

async function waitForIframe(page, timeoutMs = 30000) {
  console.log('  [Plaid] Waiting for iframe...');
  await page.locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]')
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .catch(() => {});
  await page.waitForTimeout(1500); // let it render first screen
  console.log('  [Plaid] iframe ready');
}

/**
 * Try to click the Plaid back button to return to the previous screen.
 */
async function clickBack(frame, page) {
  for (const sel of [
    '[aria-label="Back"]',
    'button[aria-label*="back" i]',
    '[data-testid="back-button"]',
    'button:has-text("Back")',
    'svg[class*="back"]',
  ]) {
    const btn = frame.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click({ force: true });
      await page.waitForTimeout(1000);
      console.log(`  [Plaid] Clicked back via "${sel}"`);
      return true;
    }
  }
  // Last resort: look for the back arrow icon near the top of the iframe
  const allFrames = page.frames();
  const plaidFrame = allFrames.find(f => f.url().includes('cdn.plaid.com') || f.url().includes('plaid.com'));
  if (plaidFrame) {
    const clicked = await plaidFrame.evaluate(() => {
      const el = document.querySelector('[class*="backButton"], [class*="BackButton"], [class*="back-button"]');
      if (el) { el.click(); return true; }
      return false;
    }).catch(() => false);
    if (clicked) { await page.waitForTimeout(1000); return true; }
  }
  return false;
}

// ── Main navigation: event-driven, dynamic OAuth retry ───────────────────────

async function navigatePlaidLink(page) {
  const frame = getFrame(page);

  // ── 1. Phone entry ────────────────────────────────────────────────────────
  // Handles two cases:
  //   A) Phone field is pre-filled (Plaid recognised returning user via link token) → just click Continue
  //   B) Phone field is empty → type number at human speed, pause 1.5s, then click Continue
  // NOTE: phone screen does NOT auto-advance — an explicit Continue click is always required.
  console.log('\n  [Step 1] Phone entry...');
  const phoneSelectors = ['input[type="tel"]', 'input[inputmode="numeric"]', 'input[name="phone"]', 'input[placeholder*="phone" i]'];
  let phoneHandled = false;
  for (const sel of phoneSelectors) {
    const el = frame.locator(sel).first();
    if (await el.isVisible({ timeout: sel === phoneSelectors[0] ? 8000 : 1500 }).catch(() => false)) {
      await screenshot(page, '1-phone-screen');
      const beforeTransition = await page.evaluate(() => window._plaidTransitionCount || 0);

      // Detect pre-fill: Plaid masks returning-user phones as "(···) ···-0011".
      // Check the visible text in the field — if it contains any digits or dots/bullets
      // (masking chars), the number is already filled. We inspect the inner text of the
      // input's container rather than inputValue() which may return an empty string for
      // masked fields. Fallback: also check if the last-4 hint matches PHONE's last 4.
      recordStep('phone-screen');
      const last4 = PHONE.slice(-4); // '0011'
      const containerText = await frame.locator('input[type="tel"]').first()
        .evaluate(el => {
          // Try the input value first
          if (el.value && el.value.replace(/\D/g,'').length > 0) return el.value;
          // Then check placeholder-style masking via closest label or parent text
          return el.closest('form, [class*="phone"], [class*="Phone"]')?.textContent?.trim() || '';
        }).catch(() => '');
      const isPrefilled = containerText.includes(last4) ||
                          /[·•\*\d]{4,}/.test(containerText);

      if (isPrefilled) {
        console.log(`  [Step 1] Phone appears pre-filled ("${containerText.substring(0,30)}") — skipping entry`);
        await page.waitForTimeout(1500);
      } else {
        // Type digits one-by-one to simulate human typing (~110ms per keystroke)
        await el.click();
        await el.pressSequentially('4155550011', { delay: 110 });
        // 1.5s pause so the completed number is clearly visible before Continue
        await page.waitForTimeout(1500);
        console.log(`  [Step 1] Phone typed manually`);
      }

      // Always click Continue to submit (phone screen never auto-advances).
      // The Continue button starts disabled and becomes enabled once React validates
      // the typed number — use click({ timeout: 5000 }) which retries until enabled.
      const continueBtn = frame.getByRole('button', { name: /continue/i }).first();
      const clicked = await continueBtn.click({ timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (clicked) {
        console.log(`  [Step 1] Clicked Continue`);
      } else {
        // Fallback: submit button or Enter
        await frame.locator('button[type="submit"]').first()
          .click({ timeout: 3000 }).catch(() => el.press('Enter').catch(() => {}));
        console.log(`  [Step 1] Submitted phone via fallback`);
      }

      recordStep('phone-submitted');
      // Wait for TRANSITION_VIEW → OTP screen
      await page.waitForFunction(
        (n) => (window._plaidTransitionCount || 0) > n,
        beforeTransition,
        { timeout: 8000, polling: 100 }
      ).catch(() => null);
      await page.waitForTimeout(200); // settle: let iframe repaint before dwell
      if (SCREEN_DWELL_MS > 0) await page.waitForTimeout(SCREEN_DWELL_MS);
      console.log(`  [Step 1] Phone submitted + transitioned (via "${sel}")`);
      phoneHandled = true;
      break;
    }
  }
  if (!phoneHandled) {
    for (const text of ['Continue without phone number', 'without phone number', 'Skip']) {
      const el = frame.getByText(text, { exact: false }).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click();
        await waitForTransition(page, 5000);
        console.log(`  [Step 1] Skipped phone via "${text}"`);
        break;
      }
    }
  }

  // ── 2. OTP ────────────────────────────────────────────────────────────────
  console.log('\n  [Step 2] OTP...');
  // Plaid OTP input uses inputmode="numeric" (confirmed). NOT just maxlength="6".
  const otpSelectors = [
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[maxlength="6"]',
    'input[maxlength="4"]',
    'input[placeholder*="code" i]',
    'input[autocomplete*="one-time-code"]',
  ];
  let otpHandled = false;
  for (const sel of otpSelectors) {
    const el = frame.locator(sel).first();
    if (await el.isVisible({ timeout: sel === otpSelectors[0] ? 8000 : 1500 }).catch(() => false)) {
      await screenshot(page, '2-otp-screen');
      recordStep('otp-screen');
      const transitionBeforeOTP = await page.evaluate(() => window._plaidTransitionCount || 0);
      // fill() waits for the element to be editable. Cap at 8s; fall back to
      // pressSequentially (fires key events, bypasses editability checks).
      const filled = await el.fill(OTP, { timeout: 8000 })
        .then(() => true)
        .catch(async () => {
          console.log('  [Step 2] fill() slow/failed — trying pressSequentially');
          await el.click({ force: true, timeout: 3000 }).catch(() => {});
          await el.pressSequentially(OTP, { delay: 80 }).catch(() => {});
          return true;
        });
      // 1s pause so the entered code is clearly visible before auto-advance
      await page.waitForTimeout(1000);
      recordStep('otp-filled');  // digits now visible — post-processor anchors success range here
      // Check if OTP auto-advanced already (common in Plaid sandbox).
      // If not, try a quick submit click; don't waste time on disabled buttons.
      const autoAdvanced = await page.evaluate(
        (n) => (window._plaidTransitionCount || 0) > n, transitionBeforeOTP
      ).catch(() => false);
      if (!autoAdvanced) {
        // OTP hasn't auto-advanced — try a quick submit click (1.5s timeout per attempt)
        let submitted = false;
        for (const btnSel of ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Verify")']) {
          const btn = frame.locator(btnSel).first();
          if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
            await btn.click({ timeout: 1500 }).catch(() => el.press('Enter').catch(() => {}));
            submitted = true;
            break;
          }
        }
        if (!submitted) await el.press('Enter').catch(() => {});
      } else {
        console.log('  [Step 2] OTP auto-advanced — skipping submit click');
      }
      recordStep('otp-submitted');
      await waitForTransition(page, 8000);
      console.log(`  [Step 2] OTP filled via "${sel}"`);
      otpHandled = true;
      break;
    }
  }
  if (!otpHandled) console.log('  [Step 2] No OTP screen');

  // ── 3. Saved institution selection (Remember Me list) ─────────────────────
  // After OTP, Plaid transitions to SELECT_SAVED_INSTITUTION and shows the saved
  // banks list. We wait for that specific view event, then pause 2s so the screen
  // is clearly visible before selecting, then pick the first non-OAuth bank.
  console.log('\n  [Step 3] Saved institution list...');
  {
    // Wait for the saved institution list to appear — accept either signal:
    //   A) _plaidSavedInstShown flag set by onEvent (TRANSITION_VIEW → SELECT_SAVED_INSTITUTION)
    //   B) ul li items become directly visible in the iframe (DOM-based detection)
    // Both are checked concurrently; whichever resolves first wins.
    // Timeout is 10s to accommodate Plaid's loading → list sequence.
    const onSavedInstScreen = await Promise.race([
      page.waitForFunction(
        () => window._plaidSavedInstShown === true,
        null,
        { timeout: 10000, polling: 100 }
      ).then(() => { console.log('  [Step 3] Detected via event flag'); return true; }).catch(() => false),
      frame.locator('ul li').first()
        .waitFor({ state: 'visible', timeout: 10000 })
        .then(() => { console.log('  [Step 3] Detected via DOM (ul li visible)'); return true; })
        .catch(() => false),
    ]);

    if (!onSavedInstScreen) {
      console.log('  [Step 3] No institution list detected — standard flow, skipping');
    } else {
      recordStep('institution-list-shown');
      // 500ms settle — enough to show the list before selection (post-processing preserves this)
      await page.waitForTimeout(500);

    // Collect all visible institution items using the frameLocator (more reliable than page.frames())
    const liLocators = frame.locator('ul li');
    const liCount = await liLocators.count().catch(() => 0);
    const institutions = [];
    for (let i = 0; i < liCount; i++) {
      const el = liLocators.nth(i);
      const visible = await el.isVisible().catch(() => false);
      const text = visible ? (await el.innerText().catch(() => '')).trim().substring(0, 80) : '';
      if (visible && text) institutions.push({ idx: i, text });
    }

    console.log('  [Step 3] Available institutions:', JSON.stringify(institutions.map(i => i.text)));
    await screenshot(page, '3-institution-list');

    // Try each institution; skip any that trigger OPEN_OAUTH
    let instSelected = false;
    // Prefer known non-OAuth sandbox banks
    const preferred = ['Tartan Bank', 'First Platypus Bank', 'First Gingham'];
    const ordered = [
      ...institutions.filter(i => preferred.some(p => i.text.includes(p))),
      ...institutions.filter(i => !preferred.some(p => i.text.includes(p))),
    ];

    for (const inst of ordered) {
      // Reset OAuth flag before each attempt
      await page.evaluate(() => { window._plaidOAuthDetected = false; });

      console.log(`  [Step 3] Trying: "${inst.text}"`);
      await liLocators.nth(inst.idx).click({ force: true }).catch(async () => {
        // Fallback: evaluate click if locator click fails
        const plaidFrame = page.frames().find(f => f.url().includes('plaid.com') || f.url().includes('cdn.plaid.com'));
        if (plaidFrame) await plaidFrame.evaluate((idx) => document.querySelectorAll('ul li')[idx]?.click(), inst.idx).catch(() => {});
      });

      // Wait up to 3s for either TRANSITION_VIEW (success) or OPEN_OAUTH (fail)
      const fired = await Promise.race([
        page.waitForFunction(() => window._plaidOAuthDetected === true, null, { timeout: 3000, polling: 100 })
          .then(() => 'oauth').catch(() => null),
        page.waitForFunction(
          (n) => (window._plaidTransitionCount || 0) > n,
          await page.evaluate(() => window._plaidTransitionCount || 0),
          { timeout: 3000, polling: 100 }
        ).then(() => 'transition').catch(() => null),
      ]);

      if (fired === 'oauth') {
        console.log(`  [Step 3] "${inst.text}" triggered OAuth — clicking back`);
        await clickBack(frame, page);
        await page.waitForTimeout(1500);
        continue;
      }

      // Non-OAuth: selected successfully
      recordStep('institution-selected');
      if (SCREEN_DWELL_MS > 0) await page.waitForTimeout(SCREEN_DWELL_MS);
      console.log(`  [Step 3] Selected non-OAuth institution: "${inst.text}"`);
      instSelected = true;
      break;
    }

      if (!instSelected) console.log('  [Step 3] No institution list or all were OAuth');
    } // end if (onSavedInstScreen)
  }

  // ── 4. Consent / "Get started" (standard flow only) ──────────────────────
  console.log('\n  [Step 4] Consent screen...');
  // Check for checkbox before clicking button
  for (const sel of ['input[type="checkbox"]:not(:checked)', '[role="checkbox"][aria-checked="false"]']) {
    const cb = frame.locator(sel).first();
    if (await cb.isVisible({ timeout: 1500 }).catch(() => false)) {
      await cb.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
      break;
    }
  }
  for (const label of ['Get started', 'I agree', 'Agree', 'Continue', 'Next']) {
    const btn = frame.getByRole('button', { name: label, exact: false }).first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await screenshot(page, '4-consent');
      try { await btn.click({ timeout: 5000 }); }
      catch (_) { await btn.click({ force: true, timeout: 3000 }).catch(() => {}); }
      await waitForTransition(page, 5000);
      console.log(`  [Step 4] Consent clicked "${label}"`);
      break;
    }
  }

  // ── 5. Institution search (standard flow; skipped in Remember Me) ─────────
  console.log('\n  [Step 5] Institution search...');
  for (const sel of ['input[placeholder*="Search" i]', 'input[type="search"]', 'input[name="search"]', 'input[aria-label*="Search" i]']) {
    const el = frame.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await screenshot(page, '5-institution-search');
      await el.fill('First Platypus Bank');
      await page.waitForTimeout(1500); // wait for results
      // Select from results
      const result = frame.getByText('First Platypus Bank', { exact: false }).first();
      if (await result.isVisible({ timeout: 4000 }).catch(() => false)) {
        await result.click();
        await waitForTransition(page, 6000);
        console.log('  [Step 5] Institution selected from search');
      }
      break;
    }
  }

  // ── 6. Connection type (non-OAuth: first option) ──────────────────────────
  const connType = frame.locator('li:first-of-type button').first();
  if (await connType.isVisible({ timeout: 2000 }).catch(() => false)) {
    await connType.click();
    await waitForTransition(page, 4000);
    console.log('  [Step 6] Connection type selected');
  }

  // ── 7. Credentials ────────────────────────────────────────────────────────
  // Only run if a username field is visible. In Remember Me flow, credentials
  // are skipped — guard the submit click to avoid accidentally clicking the
  // disabled account-selection submit button.
  console.log('\n  [Step 7] Credentials...');
  let credsFilled = false;
  for (const sel of ['input[name="username"]', 'input[id*="username" i]', 'input[type="text"]:first-of-type']) {
    const el = frame.locator(sel).first();
    if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
      await screenshot(page, '7-credentials');
      recordStep('credentials-screen');
      await el.fill(USERNAME);
      credsFilled = true;
      break;
    }
  }
  if (credsFilled) {
    for (const sel of ['input[name="password"]', 'input[type="password"]']) {
      const el = frame.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.fill(PASSWORD);
        break;
      }
    }
    for (const sel of ['button[type="submit"]', 'button:has-text("Submit")', 'button:has-text("Log in")', 'button:has-text("Sign in")']) {
      const btn = frame.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        recordStep('credentials-submitted');
        await waitForTransition(page, 10000); // account load can take a few seconds
        console.log('  [Step 7] Credentials submitted');
        break;
      }
    }
  } else {
    console.log('  [Step 7] No credentials screen — skipping (Remember Me flow)');
  }

  // ── 8. Account selection ──────────────────────────────────────────────────
  console.log('\n  [Step 8] Account selection...');
  for (const sel of ['li[role="listitem"]', '[role="radio"]', 'input[type="radio"]']) {
    const el = frame.locator(sel).first();
    if (await el.isVisible({ timeout: 7000 }).catch(() => false)) {
      await screenshot(page, '8-account-selection');
      recordStep('account-selection');
      await el.click({ force: true });
      await page.waitForTimeout(500);
      console.log(`  [Step 8] Account row clicked`);
      break;
    }
  }
  await screenshot(page, '8b-before-confirm');
  // "Confirm" in Remember Me flow; "Continue" in standard flow
  let confirmClicked = false;
  for (const sel of ['button:has-text("Continue")', 'button:has-text("Confirm")', 'button:has-text("Link account")', 'button:has-text("Share")', 'button[type="submit"]']) {
    const btn = frame.locator(sel).first();
    if (await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
      try { await btn.click({ timeout: 5000 }); }
      catch (_) { await btn.click({ force: true, timeout: 3000 }).catch(() => {}); }
      recordStep('confirm-clicked');
      await waitForTransition(page, 5000, 0); // no extra dwell here — onSuccess handles it
      console.log(`  [Step 8] Confirm clicked via "${sel}"`);
      confirmClicked = true;
      break;
    }
  }
  if (!confirmClicked) {
    // Debug dump
    const plaidFrame = page.frames().find(f => f.url().includes('cdn.plaid.com') || f.url().includes('plaid.com'));
    if (plaidFrame) {
      const btns = await plaidFrame.evaluate(() =>
        Array.from(document.querySelectorAll('button'))
          .filter(b => b.offsetParent !== null)
          .map(b => b.textContent?.trim())
      ).catch(() => []);
      console.warn('  [Step 8] Visible buttons:', JSON.stringify(btns));
    }
  }

  // ── 9. Dismiss "Save with Plaid" ──────────────────────────────────────────
  console.log('\n  [Step 9] Dismiss save screen...');
  for (const sel of ['button:has-text("Finish without saving")', 'a:has-text("Finish without saving")', 'button:has-text("without saving")']) {
    const el = frame.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await screenshot(page, '9-save-screen');
      await el.click();
      await page.waitForTimeout(1000);
      console.log(`  [Step 9] Save screen dismissed`);
      break;
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SANDBOX_SECRET) {
    console.error('ERROR: PLAID_CLIENT_ID and PLAID_SANDBOX_SECRET required in .env');
    process.exit(1);
  }
  process.env.PLAID_LINK_LIVE = 'true';

  fs.mkdirSync(APP_DIR,         { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  fs.mkdirSync(REC_TMP_DIR,     { recursive: true });

  fs.writeFileSync(path.join(APP_DIR, 'index.html'), HTML);
  console.log(`[Test] SCREEN_DWELL_MS = ${SCREEN_DWELL_MS}ms per screen`);

  const appServer = await startServer(3838, APP_DIR);
  console.log('[Test] App server:', appServer.url);

  const browser = await chromium.launch({
    headless: false,  // non-headless: GPU compositor captures cross-origin iframe
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: REC_TMP_DIR, size: { width: 1440, height: 900 } },
  });
  _contextCreatedMs = Date.now(); // recording clock starts here

  const page = await context.newPage();
  page.on('console', msg => {
    const t = msg.text();
    if (msg.type() === 'error') console.warn('  [Browser ERR]', t.substring(0, 120));
    else if (t.startsWith('[App]') || t.startsWith('[Plaid')) console.log('  [Browser]', t);
  });

  const startMs = Date.now();
  const result  = { steps: [], error: null };

  try {
    // ── Load app + inject event log shim ────────────────────────────────────
    console.log('\n[Test] Loading app...');
    await page.goto(appServer.url, { waitUntil: 'networkidle' });
    await injectEventLog(page);
    await screenshot(page, '0-app-loaded');

    // ── Wait for link token ──────────────────────────────────────────────────
    await page.waitForFunction(
      () => !document.getElementById('launch-btn').disabled,
      null, { timeout: 20000 }
    );
    await screenshot(page, '0b-ready');
    console.log('[Test] Link token ready');

    // ── Launch Plaid Link ────────────────────────────────────────────────────
    await page.locator('[data-testid="launch-plaid-link-btn"]').click();
    result.steps.push({ step: 'launched', ms: Date.now() - startMs });

    await waitForIframe(page, 30000);
    await screenshot(page, '0c-iframe-open');
    result.steps.push({ step: 'iframe-attached', ms: Date.now() - startMs });

    // ── Navigate through all Plaid Link screens ──────────────────────────────
    console.log('\n[Test] Navigating Plaid Link...');
    await navigatePlaidLink(page);
    result.steps.push({ step: 'navigation-complete', ms: Date.now() - startMs });

    // ── Wait for onSuccess ───────────────────────────────────────────────────
    console.log('\n[Test] Waiting for onSuccess...');
    await page.waitForFunction(
      () => window._plaidLinkComplete === true,
      null, { timeout: 120000, polling: 200 }
    ).catch(() => console.warn('[Test] onSuccess timeout'));

    recordStep('link-complete');  // moment the host page success panel appears
    await page.waitForTimeout(1500);
    await screenshot(page, 'final-success');

    const tokens = await page.evaluate(() => ({
      publicToken:  window._publicToken  || null,
      accessToken:  window._accessToken  || null,
      itemId:       window._itemId       || null,
      complete:     window._plaidLinkComplete || false,
    }));

    console.log('\n[Test] Tokens:');
    console.log('  public_token:', tokens.publicToken  ? tokens.publicToken.substring(0, 40)  + '...' : 'MISSING');
    console.log('  access_token:', tokens.accessToken  ? tokens.accessToken.substring(0, 40)  + '...' : 'MISSING');
    console.log('  item_id:     ', tokens.itemId || 'MISSING');

    result.tokens  = tokens;
    result.success = tokens.complete && !!tokens.publicToken;

    // ── Verify with /auth/get ────────────────────────────────────────────────
    if (tokens.accessToken) {
      console.log('\n[Test] Calling /api/auth-get...');
      const authResp = await page.evaluate(async (at) => {
        const r = await fetch('/api/auth-get', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: at }),
        });
        return r.json();
      }, tokens.accessToken);
      const accounts = authResp.accounts?.length ?? 0;
      const ach      = authResp.numbers?.ach?.length ?? 0;
      console.log(`  /auth/get → ${accounts} accounts, ${ach} ACH routing numbers`);
      result.authGet = { accounts, achNumbers: ach, sample: authResp.accounts?.[0] || null };
    }

  } catch (err) {
    console.error('\n[Test] FATAL:', err.message);
    result.error = err.message;
    await screenshot(page, 'error').catch(() => {});
  }

  // ── Save recording ───────────────────────────────────────────────────────
  console.log('\n[Test] Closing browser...');
  await page.waitForTimeout(1500);
  const videoPath = await page.video()?.path();
  await context.close();
  await browser.close();
  await appServer.close();

  const recordingOut = path.join(OUT_DIR, 'recording.webm');
  if (videoPath && fs.existsSync(videoPath)) {
    fs.renameSync(videoPath, recordingOut);
    console.log('[Test] Recording:', recordingOut);
    result.recording = recordingOut;
  }

  result.durationMs   = Date.now() - startMs;
  result.screenshots  = fs.readdirSync(SCREENSHOTS_DIR).filter(f => f.endsWith('.png')).sort();
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  // Write step timing for post-processing
  recordStep('recording-end');
  fs.writeFileSync(STEP_TIMING_FILE, JSON.stringify(_stepTimings, null, 2));
  console.log('[Test] Step timing:', STEP_TIMING_FILE);

  const dur = (result.durationMs / 1000).toFixed(1);
  const ss  = result.screenshots?.length ?? 0;
  console.log('\n' + '═'.repeat(60));
  console.log(result.success ? '  RESULT: PASSED' : '  RESULT: FAILED');
  if (result.error) console.log('  Error:', result.error);
  console.log(`  Duration:    ${dur}s`);
  console.log(`  Screenshots: ${ss}`);
  if (result.authGet) console.log(`  /auth/get:   ${result.authGet.accounts} accounts, ${result.authGet.achNumbers} ACH numbers`);
  console.log(`  Dwell/screen: ${SCREEN_DWELL_MS}ms`);
  console.log('  Recording:   out/plaid-link-test/recording.webm');
  console.log('═'.repeat(60) + '\n');

  process.exit(result.success ? 0 : 1);
}

main().catch(err => {
  console.error('[Test] Uncaught:', err.message);
  process.exit(1);
});
