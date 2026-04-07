'use strict';
/**
 * record-local.js
 * Playwright records the locally-served scratch-app.
 *
 * Reads:  scratch-app/playwright-script.json
 *         out/demo-script.json
 * Writes: public/recording.webm
 *         out/step-timing.json
 *
 * Usage: node scripts/scratch/scratch/record-local.js
 *
 * No Steel.dev — uses Playwright's local Chromium directly.
 */

require('dotenv').config({ override: true });
const { chromium }  = require('playwright');
const fs             = require('fs');
const path           = require('path');
const { execSync }   = require('child_process');
const { startServer } = require('../utils/app-server');
const agent          = require('../utils/plaid-browser-agent');
const { executeSmartPlaidPhase } = require('../utils/smart-plaid-agent');
const { inferProductFamily } = require('../utils/product-profiles');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT      = path.resolve(__dirname, '../../..');
const OUT_DIR           = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const SCRATCH_APP_DIR   = path.join(OUT_DIR, 'scratch-app');
const PLAYWRIGHT_SCRIPT = path.join(SCRATCH_APP_DIR, 'playwright-script.json');
const DEMO_SCRIPT_FILE  = path.join(OUT_DIR, 'demo-script.json');
const TIMING_FILE        = path.join(OUT_DIR, 'step-timing.json');
const CLICK_COORDS_FILE  = path.join(OUT_DIR, 'click-coords.json');
const RECORDING_TMP_DIR  = path.join(OUT_DIR, '_recording-tmp');

// ── Recording quality config ──────────────────────────────────────────────────

const TARGET_FPS = parseInt(process.env.RECORDING_FPS || '30', 10);

// ── Live Plaid Link config ──────────────────────────────────────────────────

const PLAID_LINK_LIVE  = process.env.PLAID_LINK_LIVE  === 'true';
const MANUAL_RECORD   = process.env.MANUAL_RECORD    === 'true';
const PLAID_LINK_RECORDING_PROFILE = (process.env.PLAID_LINK_RECORDING_PROFILE || '').toLowerCase();
const PLAID_SANDBOX_INSTITUTION = process.env.PLAID_SANDBOX_INSTITUTION || 'First Platypus Bank';
const PLAID_SANDBOX_USERNAME    = process.env.PLAID_SANDBOX_USERNAME    ||
  (PLAID_LINK_RECORDING_PROFILE === 'cra' ? 'user_credit_profile_good' : 'user_good');
const PLAID_SANDBOX_PASSWORD    = process.env.PLAID_SANDBOX_PASSWORD    || 'pass_good';

/** True when demo-script.json is a Plaid Check / CRA family (Base Report or Income Insights). */
function isCraFamilyDemoScript(demoScript) {
  const family = inferProductFamily({ promptText: '', demoScript: demoScript || null });
  return family === 'cra_base_report' || family === 'income_insights';
}

// Use vision-based browser agent for Plaid Link iframe phases.
// Falls back to CSS-selector approach only if ANTHROPIC_API_KEY is missing.
const USE_BROWSER_AGENT = PLAID_LINK_LIVE && !!process.env.ANTHROPIC_API_KEY;

// Smart Plaid Agent: Claude Sonnet loop that replaces the explicit-selector waterfall.
// Set SMART_PLAID_AGENT=true to enable. Requires USE_BROWSER_AGENT to also be true.
// Falls back to the explicit-selector path when false (default).
const SMART_PLAID_AGENT = process.env.SMART_PLAID_AGENT === 'true' && USE_BROWSER_AGENT;

// How long to dwell on each Plaid Link screen in the recording (~4s = 1 cut).
// Set PLAID_SCREEN_DWELL_MS=0 to disable and run at full automation speed.
const PLAID_SCREEN_DWELL_MS = parseInt(process.env.PLAID_SCREEN_DWELL_MS || '4000', 10);
/** Min wall time between otp-submitted and institution-list-shown (matches test harness). */
const OTP_TO_INST_LIST_MIN_GAP_MS = parseInt(process.env.OTP_TO_INST_LIST_MIN_GAP_MS || '2000', 10);

// Resolved sandbox credentials (populated in main() after async Glean lookup)
let _sandboxCredentials = null;

// Sandbox config loaded from demo-script.json (overrides env vars and defaults)
let _sandboxConfig = null;

/**
 * Loads Plaid sandbox configuration from demo-script.json's plaidSandboxConfig block,
 * falling back to env vars and hardcoded defaults.
 *
 * demo-script.json can include:
 * {
 *   "plaidSandboxConfig": {
 *     "phone": "415-555-0011",
 *     "otp": "123456",
 *     "institutionId": "ins_109508",
 *     "username": "user_good",
 *     "password": "pass_good",
 *     "mfa": null,
 *     "plaidLinkFlow": "remember-me"   // "standard" | "remember-me" | "oauth"
 *   }
 * }
 */
function loadSandboxConfig(demoScript) {
  const sc = demoScript?.plaidSandboxConfig || {};
  const isCraFlow =
    PLAID_LINK_RECORDING_PROFILE === 'cra' ||
    isCraFamilyDemoScript(demoScript);
  const fallbackUser = process.env.PLAID_SANDBOX_USERNAME ||
    (isCraFlow ? 'user_credit_profile_good' : 'user_good');
  const fallbackPass = process.env.PLAID_SANDBOX_PASSWORD || 'pass_good';
  const config = {
    phone:         sc.phone         || process.env.PLAID_SANDBOX_PHONE    || '+14155550011',
    otp:           sc.otp           || process.env.PLAID_SANDBOX_OTP      || '123456',
    institutionId: sc.institutionId || process.env.PLAID_SANDBOX_INSTITUTION_ID || 'ins_109508',
    username:      sc.username      || fallbackUser,
    password:      sc.password      || fallbackPass,
    mfa:           sc.mfa           || null,
    plaidLinkFlow: sc.plaidLinkFlow || process.env.PLAID_LINK_FLOW || 'standard',
  };
  console.log(
    `[Record] Sandbox config: phone=${config.phone}, otp=${config.otp}, flow=${config.plaidLinkFlow}, ` +
    `username=${config.username} (CRA-like=${isCraFlow})`
  );
  return config;
}

// ── Step timing (mirrors record-idv.js pattern exactly) ───────────────────────

let recordingStartMs = null;
const stepTimings    = [];

// ── Click coordinate capture ──────────────────────────────────────────────────
// Populated during recording; written to click-coords.json alongside step-timing.json.
// Keys are step IDs; values are normalized viewport fractions (0–1) for Remotion overlays.
const clickCoords = {};
let _currentStepId = null; // set in main loop before each step's actions run

function markStep(stepId, label) {
  const elapsedMs = Date.now() - recordingStartMs;
  stepTimings.push({ id: stepId, label, startMs: elapsedMs });
  console.log(`  [${String(Math.round(elapsedMs / 1000)).padStart(3)}s] Step: ${label}`);
}

// ── Granular Plaid Link phase timing (for post-process-recording.js) ──────────
// Written to plaid-link-timing.json alongside step-timing.json.
// Keys match the STEP_TIMING_SCHEMA in post-process-recording.js.

const plaidLinkTimings = {};

// Plaid phase key → demo-script step ID (for storyboard/QA frame mapping)
const PLAID_PHASE_TO_STEP_ID = {
  'phone-submitted':       'link-consent',
  'otp-screen':            'link-otp',
  'institution-list-shown':'link-account-select',
  'link-complete':         'link-success',
};

function markPlaidStep(key, page) {
  if (!recordingStartMs) return;
  const secs = (Date.now() - recordingStartMs) / 1000;
  plaidLinkTimings[key] = secs;
  console.log(`  [PlaidTiming] ${key} = ${secs.toFixed(2)}s`);
  // Take a CDP screenshot for storyboard/QA — captures the real Plaid iframe
  if (page && PLAID_PHASE_TO_STEP_ID[key]) {
    const stepId   = PLAID_PHASE_TO_STEP_ID[key];
    const frameDir = path.join(OUT_DIR, 'plaid-frames');
    if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });
    page.screenshot({ path: path.join(frameDir, `${stepId}-mid.png`) })
      .then(() => console.log(`  [PlaidFrames] Saved ${stepId}-mid.png`))
      .catch(e  => console.warn(`  [PlaidFrames] Screenshot failed for ${stepId}: ${e.message}`));
  }
}

// ── Action executor ───────────────────────────────────────────────────────────

/**
 * Executes a single playwright action object against the page.
 * Supported action types: wait, click, fill, hover, scroll, evalStep, screenshot.
 *
 * @param {import('playwright').Page} page
 * @param {object} action
 */
async function executeAction(page, action) {
  switch (action.type) {

    case 'wait':
      await page.waitForTimeout(action.ms || 1000);
      break;

    case 'click': {
      // Use .filter({visible:true}).first() to avoid strict-mode violations when
      // the same data-testid appears in multiple steps (only the active step is visible).
      const loc = page.locator(action.selector).filter({ visible: true }).first();
      await loc.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      // Capture bounding box for click-coords.json (used by Remotion ClickRipple overlay)
      if (_currentStepId && !clickCoords[_currentStepId]) {
        const box = await loc.boundingBox().catch(() => null);
        if (box) {
          clickCoords[_currentStepId] = {
            xFrac:  (box.x + box.width  / 2) / 1440,
            yFrac:  (box.y + box.height / 2) / 900,
            width:  box.width,
            height: box.height,
            target: action.selector,
          };
        }
      }
      await loc.click({ force: true, timeout: 5000 }).catch(err => {
        console.warn(`  [Record] click failed (${action.selector}): ${err.message}`);
      });
      break;
    }

    case 'fill': {
      const loc = page.locator(action.selector);
      await loc.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      await loc.fill(action.value || '').catch(err => {
        console.warn(`  [Record] fill failed (${action.selector}): ${err.message}`);
      });
      break;
    }

    case 'hover': {
      const loc = page.locator(action.selector);
      await loc.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      await loc.hover().catch(err => {
        console.warn(`  [Record] hover failed (${action.selector}): ${err.message}`);
      });
      if (action.durationMs) {
        await page.waitForTimeout(action.durationMs);
      }
      break;
    }

    case 'scroll':
      await page.mouse.wheel(0, action.deltaY || 0);
      break;

    case 'evalStep': {
      // Support both { stepId } and { expression } formats
      const expr = action.expression || `window.goToStep('${action.stepId}')`;
      await page.evaluate(expr).catch(err => {
        console.warn(`  [Record] eval failed (${expr}): ${err.message}`);
      });
      break;
    }

    case 'screenshot': {
      const name = action.name || `screenshot-${Date.now()}`;
      const screenshotPath = path.join(OUT_DIR, `${name}.png`);
      await page.screenshot({ path: screenshotPath }).catch(err => {
        console.warn(`  [Record] screenshot failed (${name}): ${err.message}`);
      });
      break;
    }

    default:
      console.warn(`  [Record] Unknown action type: ${action.type}`);
  }
}

/**
 * Executes all actions for a single step's action list.
 *
 * @param {import('playwright').Page} page
 * @param {Array} actions
 */
async function executeActions(page, actions) {
  for (const action of actions) {
    await executeAction(page, action);
  }
}

// ── Live Plaid Link iframe actions ──────────────────────────────────────────

/**
 * Get the Plaid Link iframe locator. Plaid Link renders in an iframe
 * with id containing "plaid-link" or a src from cdn.plaid.com.
 *
 * @param {import('playwright').Page} page
 * @returns {import('playwright').FrameLocator}
 */
function getPlaidLinkFrame(page) {
  return page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');
}

/**
 * Wait for the Plaid Link iframe to appear and be ready.
 */
async function plaidLinkWaitReady(page) {
  console.log('  [Plaid Link] Waiting for Link iframe to appear...');
  const iframeSelector = 'iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]';
  // Use state:'attached' — the Plaid iframe may be CSS-hidden (display:none) even after
  // handler.open() is called until Plaid's animation plays. CDP frameLocator can still
  // interact with attached-but-hidden iframes directly. Wait for attached, then attempt
  // to make it visible by removing any hiding CSS before proceeding.
  await page.waitForSelector(iframeSelector, { state: 'attached', timeout: 30000 });
  // Force-show the Plaid iframe if it's CSS-hidden — Plaid's CSS sometimes keeps it
  // display:none until the first screen renders, but we need CDP access immediately.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.style.setProperty('display', 'block', 'important');
      el.style.setProperty('visibility', 'visible', 'important');
      el.style.setProperty('opacity', '1', 'important');
      // Also ensure the Plaid overlay container is visible
      const overlay = el.closest('[id*="plaid-link-overlay"], [class*="plaid-link"]') || el.parentElement;
      if (overlay && overlay !== el) {
        overlay.style.setProperty('display', 'block', 'important');
        overlay.style.setProperty('visibility', 'visible', 'important');
      }
    }
  }, iframeSelector).catch(() => {});
  // Inject event tracking before first screen interaction
  await injectPlaidEventTracking(page);
  // Wait for iframe content to initialize and first screen to render
  await page.waitForTimeout(4000);
  console.log('  [Plaid Link] Link iframe detected');

}

/**
 * Inject event-tracking globals into the host page so Playwright can poll them.
 * _plaidTransitionCount  — incremented on every TRANSITION_VIEW event
 * _plaidOAuthDetected    — set true when OPEN_OAUTH fires
 *
 * Safe to call multiple times (idempotent).
 */
async function injectPlaidEventTracking(page) {
  await page.evaluate(() => {
    if (window.__plaidTrackingInjected) return;
    window.__plaidTrackingInjected  = true;
    window._plaidTransitionCount    = window._plaidTransitionCount || 0;
    window._plaidOAuthDetected      = window._plaidOAuthDetected   || false;
    // Patch Plaid.create to intercept onEvent without replacing the app's handler
    if (typeof Plaid !== 'undefined' && Plaid.create) {
      const _orig = Plaid.create.bind(Plaid);
      Plaid.create = function(cfg) {
        const _origOnEvent = cfg.onEvent;
        cfg.onEvent = function(name, meta) {
          if (name === 'TRANSITION_VIEW') window._plaidTransitionCount++;
          if (name === 'OPEN_OAUTH')       window._plaidOAuthDetected = true;
          if (_origOnEvent) _origOnEvent(name, meta);
        };
        return _orig(cfg);
      };
    }
  }).catch(() => {});
}

/**
 * Wait for Plaid Link to transition to a new screen (TRANSITION_VIEW event).
 * Resolves as soon as the event fires (~100ms); times out gracefully.
 * After detecting the transition, dwells for PLAID_SCREEN_DWELL_MS so
 * the screen is visible in the recording at the desired pace.
 *
 * @param {Page}   page
 * @param {number} [timeoutMs=8000]
 * @param {number} [dwell]  Override dwell; defaults to PLAID_SCREEN_DWELL_MS
 * @param {number|null} [beforeCount]  Wait until count > this (set from immediately before the click that triggers the transition)
 */
async function plaidWaitForTransition(page, timeoutMs = 8000, dwell = PLAID_SCREEN_DWELL_MS, beforeCount = null) {
  const before = beforeCount !== null && beforeCount !== undefined
    ? beforeCount
    : await page.evaluate(() => window._plaidTransitionCount || 0);
  await page.waitForFunction(
    (n) => (window._plaidTransitionCount || 0) > n,
    before,
    { timeout: timeoutMs, polling: 100 }
  ).catch(() => null);
  if (dwell > 0) await page.waitForTimeout(dwell);
}

/**
 * Screen-state validation: after a navigation action, confirm that a known
 * element on the NEXT expected screen is visible before proceeding.
 * This supplements the TRANSITION_VIEW count-based wait and guards against
 * count drift (e.g. extra events causing a premature return).
 *
 * @param {FrameLocator} frame         Plaid Link frameLocator
 * @param {string[]}     selectors     CSS selectors — any visible one means "arrived"
 * @param {string}       screenLabel   Human-readable label for log messages
 * @param {number}       [timeoutMs]   Per-selector probe timeout (default 3000ms)
 * @returns {Promise<boolean>}         true if screen was confirmed, false if timed out
 */
async function plaidVerifyScreen(frame, selectors, screenLabel, timeoutMs = 3000) {
  for (const sel of selectors) {
    try {
      const el = frame.locator(sel).first();
      if (await el.isVisible({ timeout: timeoutMs }).catch(() => false)) {
        console.log(`  [Plaid Link] ✓ Screen confirmed: ${screenLabel} (matched: ${sel})`);
        return true;
      }
    } catch (_) {}
  }
  console.warn(`  [Plaid Link] ⚠ Screen not confirmed: ${screenLabel} — automation may be on wrong screen`);
  return false;
}

/**
 * Click the Plaid Link back button to return to the previous screen.
 * Used when OAuth is detected after an institution selection.
 */
async function plaidClickBack(frame, page) {
  for (const sel of [
    '[aria-label="Back"]',
    'button[aria-label*="back" i]',
    '[data-testid="back-button"]',
    'button:has-text("Back")',
  ]) {
    const btn = frame.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click({ force: true });
      await page.waitForTimeout(1000);
      return true;
    }
  }
  // Evaluate fallback: class-based back button
  const plaidFrame = page.frames().find(f => f.url().includes('cdn.plaid.com') || f.url().includes('plaid.com'));
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

/**
 * Select a saved institution from the Remember Me list with dynamic OAuth detection.
 * Tries preferred non-OAuth institutions first (Tartan Bank, First Platypus Bank).
 * If any institution triggers OPEN_OAUTH, clicks back and tries the next one.
 * Falls back to text-based click if frame.evaluate() list is empty.
 *
 * @returns {string|null} Name of the selected institution, or null if list not present
 */
async function plaidSelectSavedInstitution(page, otpSubmittedWallMs = null) {
  const frame = getPlaidLinkFrame(page);

  // Wait for the saved institution list to load
  await frame.locator('ul li').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  if (otpSubmittedWallMs != null) {
    const need = OTP_TO_INST_LIST_MIN_GAP_MS - (Date.now() - otpSubmittedWallMs);
    if (need > 0) await page.waitForTimeout(need);
  }
  markPlaidStep('institution-list-shown', page);

  // Dwell 2 seconds so the viewer sees the institution list before selection.
  // Do NOT scroll — Tartan Bank is always visible at the top of the list.
  await page.waitForTimeout(2000);

  const plaidFrame = page.frames().find(f => f.url().includes('cdn.plaid.com') || f.url().includes('plaid.com'));
  if (!plaidFrame) return null;

  // Collect all visible list items from the Plaid iframe
  const listItems = await plaidFrame.evaluate(() =>
    Array.from(document.querySelectorAll('ul li')).map((li, idx) => ({
      idx,
      text: li.textContent?.trim()?.substring(0, 80) || '',
      visible: li.offsetParent !== null,
    })).filter(el => el.visible && el.text)
  ).catch(() => []);

  if (listItems.length === 0) return null;

  console.log(`  [Plaid Link] Saved institutions: ${JSON.stringify(listItems.map(i => i.text))}`);

  // Order: preferred non-OAuth names first, then others.
  // Tartan Bank is always first in sandbox Remember Me list and is non-OAuth.
  const preferred = ['Tartan Bank', 'First Platypus Bank', 'First Gingham'];
  const ordered = [
    ...listItems.filter(i => preferred.some(p => i.text.includes(p))),
    ...listItems.filter(i => !preferred.some(p => i.text.includes(p))),
  ];

  for (const inst of ordered) {
    // Reset OAuth flag before each attempt
    await page.evaluate(() => { window._plaidOAuthDetected = false; });
    const beforeCount = await page.evaluate(() => window._plaidTransitionCount || 0);

    await plaidFrame.evaluate((idx) => {
      document.querySelectorAll('ul li')[idx]?.click();
    }, inst.idx);

    // Race: TRANSITION_VIEW (selected OK) vs OPEN_OAUTH (OAuth bank)
    const result = await Promise.race([
      page.waitForFunction(() => window._plaidOAuthDetected === true, null, { timeout: 3000, polling: 100 })
        .then(() => 'oauth').catch(() => null),
      page.waitForFunction(
        (n) => (window._plaidTransitionCount || 0) > n, beforeCount,
        { timeout: 3000, polling: 100 }
      ).then(() => 'transition').catch(() => null),
    ]);

    if (result === 'oauth') {
      console.log(`  [Plaid Link] "${inst.text}" is OAuth — clicking back`);
      await plaidClickBack(frame, page);
      await page.waitForTimeout(1500);
      continue;
    }

    if (PLAID_SCREEN_DWELL_MS > 0) await page.waitForTimeout(PLAID_SCREEN_DWELL_MS);
    console.log(`  [Plaid Link] Selected institution: "${inst.text}"`);
    return inst.text;
  }

  console.log('  [Plaid Link] All saved institutions were OAuth or list empty');
  return null;
}

/**
 * Skip the Plaid Link "Remember Me" phone-number screen.
 * Plaid Link sometimes shows "Use your phone number to log in or sign up with Plaid"
 * before the institution search. We always skip this by clicking the
 * "Continue without phone number" link.
 *
 * @returns {boolean} true if the screen was found and skipped
 */
async function plaidLinkSkipRememberMe(page) {
  const frame = getPlaidLinkFrame(page);

  const skipSelectors = [
    'button:has-text("Continue without phone number")',
    'a:has-text("Continue without phone number")',
    '[data-testid="submit-button-secondary"]',
    'button:has-text("Skip")',
    // Generic link/button that contains "without" (catches translated variants)
    'button:has-text("without")',
    'a:has-text("without")',
  ];

  for (const selector of skipSelectors) {
    try {
      const el = frame.locator(selector).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await el.click({ timeout: 5000 });
        console.log(`  [Plaid Link] Skipped Remember Me screen via: ${selector}`);
        await page.waitForTimeout(1500);
        return true;
      }
    } catch (_) {}
  }

  return false; // Screen not present — nothing to skip
}

/**
 * Click Continue/Agree buttons on Plaid Link consent screens.
 * Always tries to skip the Remember Me phone screen first.
 */
async function plaidLinkContinue(page) {
  const frame = getPlaidLinkFrame(page);
  console.log('  [Plaid Link] Clicking Continue/Agree on consent screen...');

  // First: skip Remember Me / phone-number screen if present
  const skipped = await plaidLinkSkipRememberMe(page);
  if (skipped) return;

  // Standard consent/agree buttons (ordered safest-first)
  const continueSelectors = [
    'button:has-text("Agree")',
    'button:has-text("I agree")',
    'button:has-text("Get started")',
    '[data-testid="continue-button"]',
    'button[type="submit"]',
    // "Continue" last — avoid accidentally submitting the phone-number form
    'button:has-text("Continue")',
  ];

  for (const selector of continueSelectors) {
    try {
      const btn = frame.locator(selector).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click({ timeout: 5000 });
        console.log(`  [Plaid Link] Clicked: ${selector}`);
        await page.waitForTimeout(1500);
        return;
      }
    } catch (_) {
      // Try next selector
    }
  }

  console.warn('  [Plaid Link] No Continue/Agree button found — may have auto-advanced');
}

/**
 * Search for an institution in Plaid Link's search input.
 */
async function plaidLinkSearch(page, institution) {
  const frame = getPlaidLinkFrame(page);
  console.log(`  [Plaid Link] Searching for institution: ${institution}...`);

  const searchSelectors = [
    'input[placeholder*="Search"]',
    'input[placeholder*="search"]',
    'input[type="search"]',
    'input[data-testid="search-input"]',
    'input[aria-label*="Search"]',
    'input[name="search"]',
  ];

  for (const selector of searchSelectors) {
    try {
      const input = frame.locator(selector).first();
      if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
        await input.fill(institution, { timeout: 5000 });
        console.log(`  [Plaid Link] Typed into: ${selector}`);
        await page.waitForTimeout(2000); // Wait for search results
        return;
      }
    } catch (_) {
      // Try next selector
    }
  }

  console.warn('  [Plaid Link] No search input found');
}

/**
 * Select the first institution from search results.
 */
async function plaidLinkSelectInstitution(page) {
  const frame = getPlaidLinkFrame(page);
  console.log('  [Plaid Link] Selecting first institution from results...');

  const resultSelectors = [
    '[data-testid="institution-select"]',
    'button[role="option"]',
    'li[role="option"]',
    '[class*="InstitutionSearchResult"]',
    '[class*="institution"]',
    'button:has-text("First Platypus")',
    'button:has-text("Platypus")',
  ];

  for (const selector of resultSelectors) {
    try {
      const result = frame.locator(selector).first();
      if (await result.isVisible({ timeout: 5000 }).catch(() => false)) {
        await result.click({ timeout: 5000 });
        console.log(`  [Plaid Link] Selected institution via: ${selector}`);
        await page.waitForTimeout(2000);
        return;
      }
    } catch (_) {
      // Try next selector
    }
  }

  // Fallback: try clicking the first visible list item / button in the results area
  try {
    const firstItem = frame.locator('ul li, [role="listbox"] [role="option"]').first();
    if (await firstItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstItem.click({ timeout: 5000 });
      console.log('  [Plaid Link] Selected institution via fallback list item');
      await page.waitForTimeout(2000);
      return;
    }
  } catch (_) {}

  console.warn('  [Plaid Link] No institution result found to select');
}

/**
 * Enter sandbox test credentials (username/password) and submit.
 */
async function plaidLinkEnterCredentials(page, username, password) {
  const frame = getPlaidLinkFrame(page);
  console.log(`  [Plaid Link] Entering sandbox credentials (${username})...`);

  // Fill username
  const usernameSelectors = [
    'input[name="username"]',
    'input[placeholder*="username" i]',
    'input[placeholder*="user" i]',
    'input[id*="username"]',
    'input[type="text"]:first-of-type',
  ];

  for (const selector of usernameSelectors) {
    try {
      const input = frame.locator(selector).first();
      if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
        await input.fill(username, { timeout: 5000 });
        console.log(`  [Plaid Link] Username filled via: ${selector}`);
        break;
      }
    } catch (_) {}
  }

  await page.waitForTimeout(500);

  // Fill password
  const passwordSelectors = [
    'input[name="password"]',
    'input[type="password"]',
    'input[placeholder*="password" i]',
    'input[id*="password"]',
  ];

  for (const selector of passwordSelectors) {
    try {
      const input = frame.locator(selector).first();
      if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
        await input.fill(password, { timeout: 5000 });
        console.log(`  [Plaid Link] Password filled via: ${selector}`);
        break;
      }
    } catch (_) {}
  }

  await page.waitForTimeout(500);

  // Click submit
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Continue")',
  ];

  for (const selector of submitSelectors) {
    try {
      const btn = frame.locator(selector).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click({ timeout: 5000 });
        console.log(`  [Plaid Link] Submitted via: ${selector}`);
        await page.waitForTimeout(3000);
        return;
      }
    } catch (_) {}
  }

  console.warn('  [Plaid Link] No submit button found');
}

/**
 * Select the first account and click Continue.
 */
async function plaidLinkSelectAccount(page) {
  const frame = getPlaidLinkFrame(page);
  console.log('  [Plaid Link] Selecting first account...');

  // Plaid Link shows account checkboxes or clickable rows
  const accountSelectors = [
    'input[type="checkbox"]:first-of-type',
    '[data-testid="account-select"]',
    '[role="checkbox"]',
    '[class*="AccountItem"]',
    'label:has(input[type="checkbox"])',
  ];

  for (const selector of accountSelectors) {
    try {
      const el = frame.locator(selector).first();
      if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
        await el.click({ timeout: 5000 });
        console.log(`  [Plaid Link] Account selected via: ${selector}`);
        break;
      }
    } catch (_) {}
  }

  await page.waitForTimeout(1000);

  // Click Continue after selecting account
  const continueSelectors = [
    'button:has-text("Continue")',
    'button:has-text("Link account")',
    'button:has-text("Connect")',
    'button[type="submit"]',
  ];

  for (const selector of continueSelectors) {
    try {
      const btn = frame.locator(selector).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click({ timeout: 5000 });
        console.log(`  [Plaid Link] Continued via: ${selector}`);
        await page.waitForTimeout(2000);
        return;
      }
    } catch (_) {}
  }

  console.warn('  [Plaid Link] No continue button found after account selection');
}

/**
 * Wait for the app to signal that the entire Plaid Link flow + post-Link API calls are done.
 *
 * Uses a compound condition: _plaidLinkComplete must be true AND the app must have
 * advanced past any intermediate Plaid Link step. This prevents a race condition where
 * onSuccess fires (setting the flag) before goToStep has been called to advance the UI.
 *
 * Throws PLAID_LINK_TIMEOUT if not resolved within 90s, aborting the recording.
 * Takes a diagnostic screenshot on timeout for post-mortem analysis.
 * 90s allows for Remember Me flow where onSuccess can fire 50-60s after CDP automation
 * completes (the SDK processes the saved session internally before calling onSuccess).
 */
async function plaidLinkWaitSuccess(page) {
  console.log('  [Plaid Link] Waiting for Link completion (window._plaidLinkComplete)...');

  // Pre-flight: warn if DOM contract is violated (getCurrentStep missing)
  const hasGetCurrentStep = await page.evaluate(() => typeof window.getCurrentStep === 'function');
  if (!hasGetCurrentStep) {
    console.warn('[Record] WARNING: window.getCurrentStep not defined — DOM contract violation. Will wait for _plaidLinkComplete only, which may advance recording prematurely.');
  }

  const TIMEOUT_MS = 90000;  // 90s — accommodates Remember Me flow (onSuccess fires late)
  // Intermediate step IDs that indicate Link is still in progress
  const PLAID_LINK_INTERMEDIATE_STEPS = [
    'step-link-consent', 'step-link-otp', 'step-link-account-select',
  ];

  try {
    await page.waitForFunction(
      (intermediateSteps) => {
        if (!window._plaidLinkComplete) return false;
        // Compound check: ensure app has advanced past intermediate Plaid steps.
        // If getCurrentStep is missing treat it as a DOM contract violation and keep waiting.
        if (typeof window.getCurrentStep !== 'function') return false;
        const current = window.getCurrentStep();
        if (current && intermediateSteps.includes(current)) return false;
        return true;
      },
      PLAID_LINK_INTERMEDIATE_STEPS,
      { timeout: TIMEOUT_MS }
    );
    console.log('  [Plaid Link] Link flow complete!');
  } catch (err) {
    // Take a diagnostic screenshot so the failure can be analyzed post-mortem
    const diagPath = path.join(OUT_DIR, `plaid-link-timeout-${Date.now()}.png`);
    await page.screenshot({ path: diagPath, fullPage: true }).catch(() => {});
    throw new Error(
      `PLAID_LINK_TIMEOUT: _plaidLinkComplete not set within ${TIMEOUT_MS / 1000}s. ` +
      `CDP automation likely failed silently. ` +
      `Diagnosis screenshot: ${path.relative(PROJECT_ROOT, diagPath)}`
    );
  }
}

/**
 * Dismiss the Plaid "Save with Plaid" phone-number screen that appears after
 * successful account selection. This screen offers to save the institution
 * connection to the Plaid network — we always skip it for clean demo recordings.
 *
 * @returns {boolean} true if the screen was found and dismissed
 */
async function plaidLinkDismissSaveScreen(page) {
  const frame = getPlaidLinkFrame(page);

  const selectors = [
    'button:has-text("Finish without saving")',
    'a:has-text("Finish without saving")',
    'button:has-text("without saving")',
    // Plaid sometimes shows "Continue" or "Skip" instead
    'button:has-text("Continue")',
  ];

  for (const selector of selectors) {
    try {
      const el = frame.locator(selector).first();
      if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
        await el.click({ timeout: 5000 });
        console.log(`  [Plaid Link] Dismissed save screen via: ${selector}`);
        await page.waitForTimeout(2000);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// ── Live Plaid Link step pattern matching ─────────────────────────────────────

/**
 * Known step-ID patterns that correspond to Plaid Link flow stages.
 * When PLAID_LINK_LIVE=true, steps matching these patterns get their actions
 * replaced with real Plaid Link iframe interactions.
 */
const PLAID_LINK_STEP_PATTERNS = [
  // launch: step where the Plaid Link iframe actually opens (NOT token-creation loading steps)
  // Deliberately excludes "link-token" to avoid matching "link-token-creation" loading screens
  // NOTE: 'add-external-account' is intentionally NOT matched here — it is a navigation
  // precursor step (calls goToStep), not the actual Plaid launch. Only the explicit
  // plaid-link step (with plaidPhase:'launch' in demo-script.json) should trigger launch.
  { pattern: /launch[-_]?plaid[-_]?link|connect[-_]?bank|open[-_]?link|initiate[-_]?link|plaid[-_]?link[-_]?open|link[-_]?open|link[-_]?launch|plaid.*opens?$/i,
    phase: 'launch' },
  // Matches both "search-institution" and "institution-search" orderings
  { pattern: /institution[-_]?search|search[-_]?.*(?:institution|bank)|select[-_]?.*(?:institution|bank)/i,
    phase: 'search-select' },
  // Matches: plaid-link-chase-auth, oauth-step, login, credentials, etc.
  // Anchors "-auth$" with lookbehind for "link" or "plaid" to avoid matching "insight-auth",
  // "plaid-auth-insight", "api-auth-get" etc. Only Plaid Link auth/credentials steps should match.
  { pattern: /oauth|consent(?!.*insight)|authorize|credential|login|sign[-_]?in|(?:link|plaid)[-_]auth(?:entication|enticate)?$/i,
    phase: 'credentials' },
  { pattern: /select[-_]?.*account|choose[-_]?.*account|link[-_]?account/i,
    phase: 'select-account' },
  { pattern: /plaid[-_]?link[-_]?(?:success|complete|done|finish)|link[-_]?success|connection[-_]?success/i,
    phase: 'success' },
];

/**
 * Determine if a step ID matches a Plaid Link flow step.
 * Returns the phase name or null if no match.
 */
function matchPlaidLinkPhase(stepId) {
  for (const { pattern, phase } of PLAID_LINK_STEP_PATTERNS) {
    if (pattern.test(stepId)) return phase;
  }
  return null;
}

/**
 * Execute the live Plaid Link actions for a given phase.
 *
 * When USE_BROWSER_AGENT=true (default when PLAID_LINK_LIVE + ANTHROPIC_API_KEY):
 *   Uses Claude vision + pixel-level mouse clicks — works across cross-origin iframes
 *   without needing CSS selectors.
 *
 * When USE_BROWSER_AGENT=false:
 *   Falls back to heuristic CSS-selector approach (may fail on cross-origin iframes).
 */
async function executePlaidLinkPhase(page, phase) {
  const base = _sandboxCredentials || {
    username:    PLAID_SANDBOX_USERNAME,
    password:    PLAID_SANDBOX_PASSWORD,
    institution: PLAID_SANDBOX_INSTITUTION,
  };
  // demo-script plaidSandboxConfig overrides (CRA personas, etc.)
  const creds = {
    ...base,
    username: _sandboxConfig?.username || base.username,
    password: _sandboxConfig?.password || base.password,
    institution: base.institution || PLAID_SANDBOX_INSTITUTION,
    mfa: _sandboxConfig?.mfa != null && _sandboxConfig.mfa !== '' ? _sandboxConfig.mfa : base.mfa,
  };

  // ── LIVE PLAID LINK MODE ─────────────────────────────────────────────────
  // The built app has a single initiate-link step with a button that calls handler.open().
  // The real Plaid SDK opens its own iframe. The automation here:
  //   - 'launch' phase: clicks the button, automates the real iframe via CDP frameLocator
  //     (skip Remember Me → search institution → enter credentials → select account),
  //     then waits for _plaidLinkComplete (set by onSuccess) before advancing.
  //   - onSuccess in the app calls goToStep(firstPostLinkStep) to advance the UI.
  // No simulated Plaid step divs exist in the built app.

  if (USE_BROWSER_AGENT) {
    // ── Vision-based agent path ────────────────────────────────────────────
    switch (phase) {
      case 'launch': {
        // Wait for _plaidHandler to be initialized — the link token fetch is async and
        // the handler is only set after Plaid.create() is called with the fetched token.
        // Clicking the button while _plaidHandler is null silently does nothing.
        console.log('  [Plaid Link] Waiting for _plaidHandler to be initialized (link token)...');
        await page.waitForFunction(
          () => window._plaidHandler != null && typeof window._plaidHandler.open === 'function',
          null,
          { timeout: 20000 }
        ).catch(() => {
          console.warn('  [Plaid Link] _plaidHandler not ready after 20s — proceeding anyway');
        });

        // Wait for the link token to be ready and button to appear (up to 12s)
        await page.waitForSelector(
          '[data-testid="link-external-account-btn"], [data-testid*="btn-link"], [data-testid="btn-link-bank"], [data-testid*="connect-bank"], [data-testid*="open-link"]',
          { state: 'visible', timeout: 12000 }
        ).catch(() => {});
        await page.waitForTimeout(500);

        // Click the button to trigger initiateLink()
        const visionClicked = await agent.visionClick(page,
          'Find the button that opens Plaid Link or links a bank account. ' +
          'It may say "Connect a bank", "Add external account", "Link External Account", "Link Bank Account", "Add Bank", or similar. ' +
          'It is a prominent action button on the current app page. Click this button.',
          { retries: 4, waitAfterMs: 1500 }
        );
        if (!visionClicked) {
          // CSS fallback: direct selector click when vision can't find the button
          const cssSelectors = [
            '[data-testid="link-external-account-btn"]',
            '[data-testid="btn-link-bank"]',
            '[data-testid*="btn-link"]',
            '[data-testid*="connect-bank"]',
            '[data-testid*="open-link"]',
            '[data-testid*="link-account"]',
            'button[onclick*="openPlaidLink"]',
            'button[onclick*="initiateLink"]',
            'button[onclick*="_plaidHandler"]',
            'button:has-text("Link External Account")',
            'button:has-text("Connect a bank")',
            'button:has-text("Add External")',
            'button:has-text("Link Bank")',
            'button:has-text("Add Bank")',
          ];
          let cssFallbackClicked = false;
          for (const sel of cssSelectors) {
            try {
              const btn = page.locator(sel).first();
              if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await btn.click({ force: true, timeout: 5000 });
                console.log(`  [Plaid Link] CSS fallback: clicked launch button via "${sel}"`);
                cssFallbackClicked = true;
                break;
              }
            } catch (_) {}
          }
          // Last resort: call handler.open() directly — _plaidHandler is guaranteed initialized above
          if (!cssFallbackClicked) {
            const jsFallbackResult = await page.evaluate(() => {
              if (typeof window.openPlaidLink === 'function') {
                window.openPlaidLink();
                return 'openPlaidLink()';
              }
              if (window._plaidHandler && typeof window._plaidHandler.open === 'function') {
                window._plaidHandler.open();
                return 'handler.open()';
              }
              return null;
            }).catch(() => null);
            if (jsFallbackResult) {
              console.log(`  [Plaid Link] JS fallback: triggered Plaid Link via ${jsFallbackResult}`);
            } else {
              console.warn('  [Plaid Link] No way to open Plaid Link found — will wait for iframe');
            }
          }
        }
        await page.waitForTimeout(1500);

        // Also try to automate the real Plaid iframe in background (for token exchange).
        // This is optional — if it fails, the pre-populated sandbox data is used instead.
        // We only try if the iframe actually appeared.
        const iframePresent = await page.locator(
          'iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]'
        ).isVisible({ timeout: 5000 }).catch(() => false);

        // Wait for the real Plaid iframe to be ready before interacting.
        // plaidLinkWaitReady waits up to 30s for attachment + injects sandbox/branding CSS.
        await plaidLinkWaitReady(page);

        // Sequential CDP automation — no setImmediate, no fire-and-forget.
        // The main recording already waits for _plaidLinkComplete so we can block here.
        //
        // Flow-type-aware phase skipping:
        //   remember-me: Plaid shows phone → OTP → saved institution list → account selection
        //                Skips institution search (steps 4-6) and credentials (step 7).
        //   standard:    Plaid shows phone → consent → institution search → credentials → account
        //   oauth:       Like standard but institution search triggers OAuth redirect.
        const plaidLinkFlow = _sandboxConfig?.plaidLinkFlow || 'standard';
        const isRememberMe  = plaidLinkFlow === 'remember-me';
        console.log(`  [Plaid Link] Flow type: ${plaidLinkFlow}`);

        // ── Smart Plaid Agent path ─────────────────────────────────────────────
        // When SMART_PLAID_AGENT=true, delegate the entire CDP automation block
        // to the Claude Sonnet-powered agent instead of the explicit selector waterfall.
        if (SMART_PLAID_AGENT) {
          try {
            console.log('  [Plaid Link] Using SmartPlaidAgent for CDP automation...');
            await executeSmartPlaidPhase(page, 'launch', _sandboxConfig || {}, {
              markPlaidStep,
              PLAID_SCREEN_DWELL_MS,
            });
            // Dismiss "Save with Plaid" phone screen (agent stops at confirm; save screen follows)
            await plaidLinkDismissSaveScreen(page);
            console.log('  [Plaid Link] SmartPlaidAgent: CDP automation complete');
          } catch (err) {
            console.warn(`  [Plaid Link] SmartPlaidAgent error (non-fatal): ${err.message}`);
          }
          // Fall through to plaidLinkWaitSuccess below
        } else

        try {
          const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

          // ── 1. Phone entry screen (Remember Me) ─────────────────────────────
          // Plaid shows a phone number input as the first screen.
          // Strategy: try to fill the phone number (which auto-submits per Plaid sandbox
          // behaviour). If no phone input is visible within 5s, skip via the text link.
          console.log('  [Plaid Link] Handling phone screen...');
          const phoneInput = frame.locator('input[type="tel"], input[name="phone"], input[placeholder*="phone" i], input[placeholder*="Phone" i]').first();
          const phoneVisible = await phoneInput.isVisible({ timeout: 5000 }).catch(() => false);
          if (phoneVisible) {
            // Requirement: keep initial Plaid Link screen visible ~3s before continuing.
            await page.waitForTimeout(3000);
            const phone = _sandboxConfig?.phone || '+14155550011';
            await phoneInput.fill(phone);
            await plaidWaitForTransition(page, 8000, PLAID_SCREEN_DWELL_MS);
            markPlaidStep('phone-submitted', page);
            console.log('  [Plaid Link] Phone filled — auto-submitted');
          } else {
            // Phone input not found — try the "Continue without phone number" skip link
            for (const text of ['Continue without phone number', 'without phone number', 'Skip']) {
              const el = frame.getByText(text, { exact: false }).first();
              if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
                await el.click();
                await plaidWaitForTransition(page, 8000, PLAID_SCREEN_DWELL_MS);
                console.log(`  [Plaid Link] Skipped phone screen via: "${text}"`);
                break;
              }
            }
          }

          // ── 2. OTP screen (Remember Me verification code) ───────────────────
          // After phone entry, Plaid may show an OTP input. Sandbox OTP = 123456.
          // Plaid uses inputmode="numeric" or type="tel" — NOT just maxlength="6".
          console.log('  [Plaid Link] Checking for OTP screen...');
          const otpSelectors = ['input[inputmode="numeric"]', 'input[type="tel"]', 'input[maxlength="6"]', 'input[maxlength="4"]', 'input[placeholder*="code" i]', 'input[autocomplete*="one-time-code"]'];
          let otpDone = false;
          let otpSubmittedWallMs = null;
          for (const otpSel of otpSelectors) {
            const otpInput = frame.locator(otpSel).first();
            if (await otpInput.isVisible({ timeout: otpSel.includes('inputmode') ? 8000 : 2000 }).catch(() => false)) {
              markPlaidStep('otp-screen', page);
              const otp = _sandboxConfig?.otp || '123456';
              // Requirement: simulate human typing (~1–2s) + 1s pause.
              await otpInput.click({ force: true, timeout: 3000 }).catch(() => {});
              const typed = await otpInput.pressSequentially(String(otp), { delay: 220 }).then(() => true).catch(() => false);
              if (!typed) await otpInput.fill(String(otp)).catch(() => {});
              await page.waitForTimeout(1000);
              markPlaidStep('otp-filled');
              for (const btnSel of ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Verify")', 'button:has-text("Confirm")']) {
                const btn = frame.locator(btnSel).first();
                if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
                  try { await btn.click({ timeout: 5000 }); } catch (_) { await otpInput.press('Enter', { timeout: 1500 }).catch(() => {}); }
                  markPlaidStep('otp-submitted', page);
                  otpSubmittedWallMs = Date.now();
                  // List DOM usually beats the next TRANSITION_VIEW; avoid waiting on count here.
                  await page.waitForTimeout(250);
                  otpDone = true;
                  console.log(`  [Plaid Link] OTP filled via "${otpSel}" + submitted`);
                  break;
                }
              }
              if (!otpDone) {
                await otpInput.press('Enter', { timeout: 1500 }).catch(() => {});
                markPlaidStep('otp-submitted', page);
                otpSubmittedWallMs = Date.now();
                await page.waitForTimeout(250);
                otpDone = true;
                console.log(`  [Plaid Link] OTP filled via "${otpSel}" + Enter`);
              }
              break;
            }
          }
          if (!otpDone) console.log('  [Plaid Link] No OTP screen found');

          // ── 2b. Saved institution selection (Remember Me returning-user) ────
          await plaidSelectSavedInstitution(page, otpSubmittedWallMs);

          // ── 3. Consent / "Get started" screen ──────────────────────────────
          console.log('  [Plaid Link] Handling consent screen...');
          for (const label of ['Get started', 'I agree', 'Agree', 'Continue', 'Next']) {
            const btn = frame.getByRole('button', { name: label, exact: false }).first();
            if (await btn.isVisible({ timeout: 4000 }).catch(() => false)) {
              await btn.click();
              await plaidWaitForTransition(page, 8000, PLAID_SCREEN_DWELL_MS);
              console.log(`  [Plaid Link] Consent: clicked "${label}"`);
              break;
            }
          }

          // ── 4–7: Institution search + credentials (standard flow only) ────────
          // Remember Me flow skips these — the SDK goes directly from saved institution
          // selection to account selection without showing search or credentials screens.
          if (!isRememberMe) {
            // ── 4. Institution search ──────────────────────────────────────────
            console.log(`  [Plaid Link] Searching for institution: ${PLAID_SANDBOX_INSTITUTION}...`);
            let searchDone = false;
            for (const sel of ['input[placeholder*="Search" i]', 'input[type="search"]', 'input[name="search"]', 'input[aria-label*="Search" i]']) {
              const input = frame.locator(sel).first();
              if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
                await input.fill(PLAID_SANDBOX_INSTITUTION);
                await plaidWaitForTransition(page, 5000, PLAID_SCREEN_DWELL_MS);
                console.log(`  [Plaid Link] Institution search via: ${sel}`);
                searchDone = true;
                break;
              }
            }
            if (!searchDone) console.log('  [Plaid Link] Institution search input not found — skipping');

            // ── 5. Select institution from results ────────────────────────────
            console.log('  [Plaid Link] Selecting institution...');
            let institutionSelected = false;
            const byText = frame.getByText(PLAID_SANDBOX_INSTITUTION, { exact: false }).first();
            if (await byText.isVisible({ timeout: 6000 }).catch(() => false)) {
              await byText.click();
              await plaidWaitForTransition(page, 8000, PLAID_SCREEN_DWELL_MS);
              console.log(`  [Plaid Link] Institution selected by text: "${PLAID_SANDBOX_INSTITUTION}"`);
              institutionSelected = true;
            }
            if (!institutionSelected) {
              for (const sel of ['li[role="option"]', 'button[role="option"]', 'ul li button', '[data-testid*="institution"]']) {
                const el = frame.locator(sel).first();
                if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
                  await el.click();
                  await plaidWaitForTransition(page, 8000, PLAID_SCREEN_DWELL_MS);
                  console.log(`  [Plaid Link] Institution selected via: ${sel}`);
                  break;
                }
              }
            }

            // ── 6. Connection type (non-OAuth: pick first option) ─────────────
            const connType = frame.locator('li:first-of-type button').first();
            if (await connType.isVisible({ timeout: 3000 }).catch(() => false)) {
              await connType.click();
              await plaidWaitForTransition(page, 5000, PLAID_SCREEN_DWELL_MS);
              console.log('  [Plaid Link] Selected connection type (first option)');
            }

            // ── 7. Credentials ────────────────────────────────────────────────
            console.log('  [Plaid Link] Entering credentials...');
          for (const sel of ['input[name="username"]', 'input[id*="username" i]', 'input[type="text"]:first-of-type']) {
            const el = frame.locator(sel).first();
            if (await el.isVisible({ timeout: 6000 }).catch(() => false)) {
              await el.fill(creds.username || PLAID_SANDBOX_USERNAME);
              console.log(`  [Plaid Link] Username filled via: ${sel}`);
              break;
            }
          }
          await page.waitForTimeout(400);
          for (const sel of ['input[name="password"]', 'input[type="password"]']) {
            const el = frame.locator(sel).first();
            if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
              await el.fill(creds.password || PLAID_SANDBOX_PASSWORD);
              console.log(`  [Plaid Link] Password filled via: ${sel}`);
              break;
            }
          }
          await page.waitForTimeout(400);
          for (const sel of ['button[type="submit"]', 'button:has-text("Submit")', 'button:has-text("Log in")', 'button:has-text("Sign in")']) {
            const btn = frame.locator(sel).first();
            if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await btn.click();
              await plaidWaitForTransition(page, 12000, PLAID_SCREEN_DWELL_MS);
              console.log(`  [Plaid Link] Credentials submitted via: ${sel}`);
              // Screen-state validation: confirm account selection screen loaded (finding 1.5)
              await plaidVerifyScreen(frame,
                ['li[role="listitem"]', '[role="radio"]', 'input[type="checkbox"]', '[class*="Account"]'],
                'account selection', 5000);
              break;
            }
          }

          // ── 8. MFA if shown ──────────────────────────────────────────────────
          if (creds.mfa) {
            for (const sel of ['input[placeholder*="code" i]', 'input[maxlength="4"]', 'input[maxlength="6"]']) {
              const el = frame.locator(sel).first();
              if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
                await el.fill(creds.mfa);
                const submit = frame.locator('button[type="submit"]').first();
                if (await submit.isVisible({ timeout: 2000 }).catch(() => false)) await submit.click();
                await plaidWaitForTransition(page, 8000, PLAID_SCREEN_DWELL_MS);
                console.log('  [Plaid Link] MFA submitted');
                break;
              }
            }
          }

          } // end if (!isRememberMe) — institution search + credentials block

          // ── 9. Account selection ─────────────────────────────────────────────
          console.log('  [Plaid Link] Selecting account...');
          for (const sel of ['li[role="listitem"]', '[role="radio"]', 'input[type="radio"]']) {
            const el = frame.locator(sel).first();
            if (await el.isVisible({ timeout: 6000 }).catch(() => false)) {
              await el.click({ force: true });
              console.log(`  [Plaid Link] Account row selected via: ${sel}`);
              await page.waitForTimeout(1000);
              break;
            }
          }
          for (const sel of ['button:has-text("Continue")', 'button:has-text("Confirm")', 'button:has-text("Link account")', 'button:has-text("Share")', 'button[type="submit"]']) {
            const btn = frame.locator(sel).first();
            if (await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
              try {
                await btn.click({ timeout: 5000 });
              } catch (_) {
                await btn.click({ force: true, timeout: 3000 }).catch(() => {});
              }
              await plaidWaitForTransition(page, 8000, PLAID_SCREEN_DWELL_MS);
              markPlaidStep('confirm-clicked');
              console.log(`  [Plaid Link] Account selection confirmed via: ${sel}`);
              // Screen-state validation: confirm success or save-screen appeared (finding 1.5)
              // Either _plaidLinkComplete fires (fast path) or a success/save element is visible
              await page.waitForFunction(
                () => window._plaidLinkComplete === true,
                null,
                { timeout: 5000, polling: 200 }
              ).catch(() =>
                plaidVerifyScreen(frame,
                  ['button:has-text("Finish")', 'button:has-text("without saving")', '[class*="Success"]', 'h2'],
                  'post-account screen', 3000)
              );
              break;
            }
          }

          // ── 10. Dismiss "Save with Plaid" phone screen ───────────────────────
          await plaidLinkDismissSaveScreen(page);
          console.log('  [Plaid Link] CDP automation complete — waiting for onSuccess');

        } catch (err) {
          console.warn(`  [Plaid Link] CDP automation error (non-fatal): ${err.message}`);
        }

        // Wait for the real onSuccess callback to fire and set _plaidLinkComplete = true.
        // onSuccess also calls goToStep(firstPostLinkStep) to advance the app.
        console.log('  [Plaid Link] Waiting for _plaidLinkComplete (real onSuccess)...');
        await plaidLinkWaitSuccess(page);
        markPlaidStep('link-complete', page);
        // CRITICAL: destroy the Plaid iframe so it does not overlay post-link steps in the recording.
        // The Plaid SDK iframe persists in the DOM after onSuccess unless handler.destroy() is called.
        await page.evaluate(() => {
          if (window._plaidHandler) {
            try { window._plaidHandler.destroy(); } catch (e) {}
          }
        }).catch(() => {});
        console.log('  [Plaid Link] iframe destroyed');
        await page.waitForTimeout(2000);
        break;
      }

      case 'success':
        // Legacy fallback: apps that still have a simulated plaid-link-success step.
        // Newer builds set _plaidLinkComplete in onSuccess — the launch phase waits for it.
        // This case is a no-op for new builds but kept so old apps don't error.
        console.log('  [Plaid Link] success phase (legacy simulated step — no-op for real-SDK builds)');
        break;

      default:
        console.warn(`  [Plaid Link] Unknown phase: ${phase}`);
    }
    return;
  }

  // ── CSS-selector fallback path (when ANTHROPIC_API_KEY is unavailable) ──
  switch (phase) {
    case 'launch':
      // Wait for _plaidHandler before clicking — link token fetch is async
      await page.waitForFunction(
        () => window._plaidHandler != null && typeof window._plaidHandler.open === 'function',
        null,
        { timeout: 20000 }
      ).catch(() => {
        console.warn('  [Plaid Link] CSS path: _plaidHandler not ready after 20s — proceeding anyway');
      });
      await page.waitForTimeout(500);
      try {
        const btnSelectors = [
          '[data-testid="link-external-account-btn"]',
          '[data-testid="btn-link-bank"]',
          '[data-testid*="btn-link"]',
          '[data-testid*="connect"] button',
          '[data-testid*="link"] button',
          '[data-testid*="add-external"] button',
          'button[onclick*="_plaidHandler"]',
          'button:has-text("Connect")',
          'button:has-text("Add External")',
          'button:has-text("Link Account")',
          'button:has-text("Link Bank")',
          'button:has-text("Open Link")',
        ];
        let btnClicked = false;
        for (const sel of btnSelectors) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await btn.click({ timeout: 5000 });
            console.log(`  [Plaid Link] Clicked launch button: ${sel}`);
            btnClicked = true;
            break;
          }
        }
        if (!btnClicked) {
          // JS fallback — _plaidHandler guaranteed initialized above
          await page.evaluate(() => {
            if (window._plaidHandler) window._plaidHandler.open();
          }).catch(() => {});
          console.log('  [Plaid Link] CSS path JS fallback: called _plaidHandler.open()');
        }
      } catch (err) {
        console.warn(`  [Plaid Link] Could not click launch button: ${err.message}`);
      }
      await plaidLinkWaitReady(page);

      // Sequential CDP automation — mirrors the vision-agent path.
      try {
        const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

        // ── 1. Phone entry screen (Remember Me) ───────────────────────────────
        console.log('  [Plaid Link] CSS: Handling phone screen...');
        const phoneInput = frame.locator('input[type="tel"], input[name="phone"], input[placeholder*="phone" i], input[placeholder*="Phone" i]').first();
        const phoneVisible = await phoneInput.isVisible({ timeout: 5000 }).catch(() => false);
        if (phoneVisible) {
          // Requirement: keep initial Plaid Link screen visible ~3s before continuing.
          await page.waitForTimeout(3000);
          const phone = _sandboxConfig?.phone || '+14155550011';
          await phoneInput.fill(phone);
          await page.waitForTimeout(3000);
          console.log('  [Plaid Link] CSS: Phone filled — auto-submitted');
        } else {
          for (const text of ['Continue without phone number', 'without phone number', 'Skip']) {
            const el = frame.getByText(text, { exact: false }).first();
            if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
              await el.click();
              await page.waitForTimeout(2500);
              console.log(`  [Plaid Link] CSS: Skipped phone screen via: "${text}"`);
              break;
            }
          }
        }

        // ── 2. OTP screen (Remember Me verification code) ─────────────────────
        // Plaid uses inputmode="numeric" or type="tel" for OTP — NOT just maxlength="6".
        console.log('  [Plaid Link] CSS: Checking for OTP screen...');
        let cssOtpSubmittedWallMs = null;
        {
          const cssOtpSelectors = ['input[inputmode="numeric"]', 'input[type="tel"]', 'input[maxlength="6"]', 'input[maxlength="4"]', 'input[placeholder*="code" i]', 'input[autocomplete*="one-time-code"]'];
          for (const otpSel of cssOtpSelectors) {
            const otpEl = frame.locator(otpSel).first();
            if (await otpEl.isVisible({ timeout: otpSel.includes('inputmode') ? 8000 : 2000 }).catch(() => false)) {
              const otp = _sandboxConfig?.otp || '123456';
              // Requirement: simulate human typing (~1–2s) + 1s pause.
              await otpEl.click({ force: true, timeout: 3000 }).catch(() => {});
              const typed = await otpEl.pressSequentially(String(otp), { delay: 220 }).then(() => true).catch(() => false);
              if (!typed) await otpEl.fill(String(otp)).catch(() => {});
              await page.waitForTimeout(1000);
              let otpSent = false;
              for (const btnSel of ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Verify")', 'button:has-text("Confirm")']) {
                const btn = frame.locator(btnSel).first();
                if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
                  try { await btn.click({ timeout: 5000 }); } catch (_) { await otpEl.press('Enter', { timeout: 1500 }).catch(() => {}); }
                  markPlaidStep('otp-submitted', page);
                  cssOtpSubmittedWallMs = Date.now();
                  await page.waitForTimeout(250);
                  otpSent = true;
                  console.log(`  [Plaid Link] CSS: OTP filled via "${otpSel}" + submitted`);
                  break;
                }
              }
              if (!otpSent) {
                await otpEl.press('Enter', { timeout: 1500 }).catch(() => {});
                markPlaidStep('otp-submitted', page);
                cssOtpSubmittedWallMs = Date.now();
                await page.waitForTimeout(250);
                console.log(`  [Plaid Link] CSS: OTP filled via "${otpSel}" + Enter`);
              }
              break;
            }
          }
        }

        await plaidSelectSavedInstitution(page, cssOtpSubmittedWallMs);

        // ── 3. Consent / "Get started" screen ─────────────────────────────────
        console.log('  [Plaid Link] CSS: Handling consent screen...');
        for (const label of ['Get started', 'I agree', 'Agree', 'Continue', 'Next']) {
          const btn = frame.getByRole('button', { name: label, exact: false }).first();
          if (await btn.isVisible({ timeout: 4000 }).catch(() => false)) {
            await btn.click();
            await page.waitForTimeout(2500);
            console.log(`  [Plaid Link] CSS: Consent clicked "${label}"`);
            break;
          }
        }

        // ── 4. Institution search ──────────────────────────────────────────────
        console.log(`  [Plaid Link] CSS: Searching for ${PLAID_SANDBOX_INSTITUTION}...`);
        for (const sel of ['input[placeholder*="Search" i]', 'input[type="search"]', 'input[name="search"]']) {
          const input = frame.locator(sel).first();
          if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
            await input.fill(PLAID_SANDBOX_INSTITUTION);
            await page.waitForTimeout(2500);
            break;
          }
        }

        // ── 5. Select institution ──────────────────────────────────────────────
        console.log('  [Plaid Link] CSS: Selecting institution...');
        let institutionSelected = false;
        const byText = frame.getByText(PLAID_SANDBOX_INSTITUTION, { exact: false }).first();
        if (await byText.isVisible({ timeout: 6000 }).catch(() => false)) {
          await byText.click();
          await page.waitForTimeout(2500);
          institutionSelected = true;
        }
        if (!institutionSelected) {
          for (const sel of ['li[role="option"]', 'button[role="option"]', 'ul li button']) {
            const el = frame.locator(sel).first();
            if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
              await el.click();
              await page.waitForTimeout(2500);
              break;
            }
          }
        }

        // ── 6. Connection type (first option) ─────────────────────────────────
        const connType = frame.locator('li:first-of-type button').first();
        if (await connType.isVisible({ timeout: 3000 }).catch(() => false)) {
          await connType.click();
          await page.waitForTimeout(2000);
          console.log('  [Plaid Link] CSS: Connection type selected');
        }

        // ── 7. Credentials ────────────────────────────────────────────────────
        console.log('  [Plaid Link] CSS: Entering credentials...');
        const cssUser = _sandboxConfig?.username || PLAID_SANDBOX_USERNAME;
        const cssPass = _sandboxConfig?.password || PLAID_SANDBOX_PASSWORD;
        for (const sel of ['input[name="username"]', 'input[id*="username" i]', 'input[type="text"]:first-of-type']) {
          const el = frame.locator(sel).first();
          if (await el.isVisible({ timeout: 6000 }).catch(() => false)) {
            await el.fill(cssUser);
            break;
          }
        }
        await page.waitForTimeout(400);
        for (const sel of ['input[name="password"]', 'input[type="password"]']) {
          const el = frame.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
            await el.fill(cssPass);
            break;
          }
        }
        await page.waitForTimeout(400);
        for (const sel of ['button[type="submit"]', 'button:has-text("Submit")', 'button:has-text("Log in")', 'button:has-text("Sign in")']) {
          const btn = frame.locator(sel).first();
          if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await btn.click();
            await page.waitForTimeout(5000);
            console.log('  [Plaid Link] CSS: Credentials submitted');
            break;
          }
        }

        // ── 8. Account selection ──────────────────────────────────────────────
        console.log('  [Plaid Link] CSS: Selecting account...');
        for (const sel of ['li[role="listitem"]', '[role="radio"]', 'input[type="radio"]']) {
          const el = frame.locator(sel).first();
          if (await el.isVisible({ timeout: 6000 }).catch(() => false)) {
            await el.click({ force: true });
            await page.waitForTimeout(1000);
            break;
          }
        }
        for (const sel of ['button:has-text("Continue")', 'button:has-text("Confirm")', 'button:has-text("Link account")', 'button:has-text("Share")', 'button[type="submit"]']) {
          const btn = frame.locator(sel).first();
          if (await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
            try {
              await btn.click({ timeout: 5000 });
            } catch (_) {
              await btn.click({ force: true, timeout: 3000 }).catch(() => {});
            }
            await page.waitForTimeout(2500);
            console.log('  [Plaid Link] CSS: Account selection confirmed');
            break;
          }
        }

        // ── 9. Dismiss "Save with Plaid" phone screen ─────────────────────────
        await plaidLinkDismissSaveScreen(page);
        console.log('  [Plaid Link] CSS: CDP automation complete');

      } catch (err) {
        console.warn(`  [Plaid Link] CSS fallback CDP error (non-fatal): ${err.message}`);
      }

      // Wait for real onSuccess to fire and set _plaidLinkComplete
      console.log('  [Plaid Link] CSS fallback: waiting for _plaidLinkComplete...');
      await plaidLinkWaitSuccess(page);
      // CRITICAL: destroy the Plaid iframe so it does not overlay post-link steps
      await page.evaluate(() => {
        if (window._plaidHandler) {
          try { window._plaidHandler.destroy(); } catch (e) {}
        }
      }).catch(() => {});
      console.log('  [Plaid Link] CSS fallback: iframe destroyed');
      await page.waitForTimeout(2000);
      break;

    case 'success':
      // Legacy no-op — new builds wait in the launch phase above.
      console.log('  [Plaid Link] CSS fallback success phase (legacy no-op)');
      break;

    default:
      console.warn(`  [Plaid Link] Unknown phase: ${phase}`);
  }
}

// ── Teardown: finalize video + write step-timing.json ─────────────────────────

/**
 * Finds the most recently modified .webm file in a directory.
 */
function findLatestWebm(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.webm'))
    .map(f => ({
      name:  f,
      mtime: fs.statSync(path.join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}

function writeStepTiming(totalMs) {
  const fps = TARGET_FPS;
  // Compute per-step durations and frame numbers
  for (let i = 0; i < stepTimings.length; i++) {
    const next = stepTimings[i + 1];
    stepTimings[i].endMs          = next ? next.startMs : totalMs;
    stepTimings[i].durationMs     = stepTimings[i].endMs - stepTimings[i].startMs;
    stepTimings[i].startFrame     = Math.round(stepTimings[i].startMs  / 1000 * fps);
    stepTimings[i].endFrame       = Math.round(stepTimings[i].endMs    / 1000 * fps);
    stepTimings[i].durationFrames = stepTimings[i].endFrame - stepTimings[i].startFrame;
  }

  const timing = {
    totalMs,
    totalFrames: Math.round(totalMs / 1000 * fps),
    fps,
    steps: stepTimings,
  };

  fs.writeFileSync(TIMING_FILE, JSON.stringify(timing, null, 2));

  // Write click coordinates for Remotion ClickRipple overlay
  if (Object.keys(clickCoords).length > 0) {
    fs.writeFileSync(CLICK_COORDS_FILE, JSON.stringify(clickCoords, null, 2));
    console.log(`[Record] Wrote click-coords.json (${Object.keys(clickCoords).length} entries)`);
  }

  // Write granular Plaid Link phase timing for post-process-recording.js
  const plaidKeys = Object.keys(plaidLinkTimings);
  if (plaidKeys.length > 0) {
    const plaidTimingArr = plaidKeys.map(step => ({
      step,
      recordingOffsetS: plaidLinkTimings[step],
    }));
    const plaidTimingFile = path.join(OUT_DIR, 'plaid-link-timing.json');
    fs.writeFileSync(plaidTimingFile, JSON.stringify(plaidTimingArr, null, 2));
    console.log(`[Record] Wrote plaid-link-timing.json (${plaidTimingArr.length} checkpoints)`);
  }
}

/**
 * Post-process the raw Playwright recording:
 * - Re-encode at the target FPS with motion interpolation for smoother playback
 * - Apply high-quality encoding (CRF 18)
 *
 * @param {string} rawPath  - Path to the raw webm from Playwright
 * @param {string} outPath  - Path for the processed webm
 * @returns {boolean} true if successful
 */
function postProcessRecording(rawPath, outPath) {
  if (TARGET_FPS <= 30) {
    // No re-encode needed — just return
    return false;
  }

  console.log(`[Record] Post-processing: re-encoding at ${TARGET_FPS}fps with quality boost...`);
  const tmpOut = outPath + '.tmp.webm';

  try {
    // Use simple frame duplication (fps filter) instead of motion interpolation.
    // minterpolate is orders of magnitude slower and not worth the quality gain for demo videos.
    execSync(
      `ffmpeg -i "${rawPath}" ` +
      `-vf fps=${TARGET_FPS} ` +
      `-c:v libvpx-vp9 -crf 18 -b:v 0 -cpu-used 4 ` +
      `-y "${tmpOut}"`,
      { stdio: 'pipe', timeout: 900000 }
    );

    if (fs.existsSync(tmpOut)) {
      fs.renameSync(tmpOut, outPath);
      const rawSize = Math.round(fs.statSync(rawPath).size / 1024);
      const outSize = Math.round(fs.statSync(outPath).size / 1024);
      console.log(`[Record] Post-processing complete: ${rawSize}KB → ${outSize}KB at ${TARGET_FPS}fps`);
      return true;
    }
  } catch (err) {
    console.warn(`[Record] Post-processing failed (using raw recording): ${err.message}`);
    // Clean up partial output
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (_) {}
  }
  return false;
}

// ── Manual record helpers ─────────────────────────────────────────────────────

/**
 * Wait for the user to press Enter in the terminal.
 * Falls back to a 3-minute auto-timeout if stdin is not a TTY (CI/piped contexts).
 */
function waitForEnter() {
  return new Promise(resolve => {
    const readline = require('readline');
    if (!process.stdin.isTTY) {
      const AUTO_TIMEOUT_MS = 3 * 60 * 1000;
      console.warn(`[Record] stdin is not a TTY — auto-stopping in ${AUTO_TIMEOUT_MS / 1000}s`);
      setTimeout(resolve, AUTO_TIMEOUT_MS);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); resolve(); });
  });
}

/**
 * Write a synthetic step-timing.json for manual recordings.
 * Distributes the total elapsed time proportionally based on each step's
 * declared waitMs, giving downstream stages (voiceover, render) reasonable
 * per-step durations without requiring real-time step markers.
 *
 * @param {object} playwrightScript - Parsed playwright-script.json
 * @param {object} demoScript       - Parsed demo-script.json
 * @param {number} totalMs          - Total recording duration in ms
 */
function writeSyntheticStepTiming(playwrightScript, demoScript, totalMs) {
  const stepLabelMap = {};
  for (const step of demoScript.steps) {
    stepLabelMap[step.id] = step.label;
  }

  const steps        = playwrightScript.steps;
  const totalWaitMs  = steps.reduce((sum, s) => sum + (s.waitMs || 5000), 0);
  let   elapsedMs    = 0;

  for (const step of steps) {
    const stepId           = step.stepId || step.id;
    const label            = stepLabelMap[stepId] || stepId;
    const waitMs           = step.waitMs || 5000;
    const proportionalMs   = Math.round((waitMs / totalWaitMs) * totalMs);
    stepTimings.push({ id: stepId, label, startMs: elapsedMs });
    elapsedMs += proportionalMs;
  }

  writeStepTiming(totalMs);
}

// ── Manual recording main ─────────────────────────────────────────────────────

/**
 * MANUAL_RECORD mode:
 *  1. Starts the app server
 *  2. Launches a visible (non-headless) Chromium window with Playwright recording
 *  3. Prints instructions and waits for the human to press Enter
 *  4. Closes the browser (finalizes webm), saves recording, writes synthetic timing
 */
async function manualRecordMain() {
  // Reset module-level state
  recordingStartMs = null;
  stepTimings.length = 0;

  if (!fs.existsSync(PLAYWRIGHT_SCRIPT)) {
    console.error('[Record] Missing: scratch-app/playwright-script.json — run build-app.js first');
    process.exit(1);
  }
  if (!fs.existsSync(DEMO_SCRIPT_FILE)) {
    console.error('[Record] Missing: out/demo-script.json — run generate-script.js first');
    process.exit(1);
  }

  const playwrightScript = JSON.parse(fs.readFileSync(PLAYWRIGHT_SCRIPT, 'utf8'));
  const demoScript       = JSON.parse(fs.readFileSync(DEMO_SCRIPT_FILE,  'utf8'));

  fs.mkdirSync(OUT_DIR,           { recursive: true });
  fs.mkdirSync(RECORDING_TMP_DIR, { recursive: true });

  const appServer = await startServer(3737, SCRATCH_APP_DIR);
  console.log(`[Record] App server: ${appServer.url} (serving ${SCRATCH_APP_DIR})`);
  console.log(`[Record] MANUAL_RECORD mode — opening visible browser`);

  // Non-headless browser so the human can interact
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    recordVideo: {
      dir:  RECORDING_TMP_DIR,
      size: { width: 1440, height: 900 },
    },
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  await page.goto(appServer.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Build ordered step list for keyboard navigation.
  // Use the playwright-script goToStep targets in order, de-duplicated.
  // This gives the human arrow-key navigation through all app steps.
  const manualNavSteps = [];
  for (const s of playwrightScript.steps) {
    if (s.action === 'goToStep' && s.target && !manualNavSteps.includes(s.target)) {
      manualNavSteps.push(s.target);
    }
  }
  // Ensure the first step is in the list (some scripts start with a click step)
  if (manualNavSteps.length === 0) manualNavSteps.push('problem-narrative');

  // Inject manual-record helpers into the page:
  //  1. Recording CSS fixes (hide link-events panel, step visibility)
  //  2. Arrow-key navigation (← → to move between steps)
  //  3. initiateLink() override → opens REAL Plaid Link SDK (not simulated overlay)
  //  4. After Plaid onSuccess → auto-advances to the post-link step
  const stepsJson = JSON.stringify(manualNavSteps);
  await page.evaluate(`(() => {
    // ── Recording CSS ───────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.id = 'recording-fixes';
    style.textContent = [
      '.step:not(.active) { display: none !important; }',
      '#link-events-panel { display: none !important; }',
    ].join('\\n');
    document.head.appendChild(style);

    // Patch goToStep to always suppress link-events panel visibility
    const origGoToStep = window.goToStep;
    window.goToStep = function(id) {
      if (origGoToStep) origGoToStep(id);
      const panel = document.getElementById('link-events-panel');
      if (panel) {
        panel.classList.remove('visible');
        panel.style.setProperty('display', 'none', 'important');
      }
    };

    // ── Keyboard navigation ─────────────────────────────────────────────────
    // ← / → arrows step through the app. Home = first step, End = last step.
    const NAV_STEPS = ${stepsJson};
    let _navIdx = 0;
    // Activate first step
    window.goToStep(NAV_STEPS[0]);

    document.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowRight' && _navIdx < NAV_STEPS.length - 1) {
        _navIdx++;
        window.goToStep(NAV_STEPS[_navIdx]);
        e.preventDefault();
      } else if (e.key === 'ArrowLeft' && _navIdx > 0) {
        _navIdx--;
        window.goToStep(NAV_STEPS[_navIdx]);
        e.preventDefault();
      } else if (e.key === 'Home') {
        _navIdx = 0;
        window.goToStep(NAV_STEPS[0]);
        e.preventDefault();
      } else if (e.key === 'End') {
        _navIdx = NAV_STEPS.length - 1;
        window.goToStep(NAV_STEPS[_navIdx]);
        e.preventDefault();
      }
    });

    // ── Real Plaid Link override ─────────────────────────────────────────────
    // Override initiateLink() so clicking the button opens the REAL Plaid Link
    // SDK directly — no simulated overlay. After Plaid onSuccess, auto-advance
    // to the first post-Plaid step in NAV_STEPS that follows 'initiate-funding'.
    function findPostPlaidStep() {
      // First step after 'initiate-funding' (or any step containing 'link') in NAV_STEPS
      const linkIdx = NAV_STEPS.findIndex(s => s.includes('initiate') || s.includes('fund'));
      if (linkIdx >= 0 && linkIdx + 1 < NAV_STEPS.length) return { idx: linkIdx + 1, id: NAV_STEPS[linkIdx + 1] };
      return { idx: 0, id: NAV_STEPS[0] };
    }

    window.initiateLink = function() {
      // Always fetch a fresh link token so we can open real Plaid
      fetch('/api/create-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Wells Fargo' })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.link_token || !window.Plaid) {
          console.error('[ManualRecord] Could not get link token or Plaid SDK not loaded');
          return;
        }
        const handler = Plaid.create({
          token: data.link_token,
          onSuccess: function(public_token, metadata) {
            window._plaidPublicToken = public_token;
            window._plaidLinkComplete = true;
            // Auto-advance to the first post-link step
            const next = findPostPlaidStep();
            _navIdx = next.idx;
            window.goToStep(next.id);
          },
          onEvent: function(eventName, metadata) {
            if (window.logLinkEvents) window.logLinkEvents(eventName);
          },
          onExit: function(err, metadata) {
            if (err) console.warn('[ManualRecord] Plaid Link exited with error:', err);
          }
        });
        handler.open();
      })
      .catch(function(err) {
        console.error('[ManualRecord] Link token fetch failed:', err);
      });
    };
  })()`).catch(e => console.warn('[Record] Patch warning:', e.message));

  await page.waitForTimeout(500);

  console.log('\n========================================');
  console.log('[Record] Browser open: ' + appServer.url);
  console.log('[Record] NAVIGATION: ← → arrow keys to move between steps');
  console.log('[Record]   → RIGHT ARROW  = advance to next step');
  console.log('[Record]   ← LEFT ARROW   = go back one step');
  console.log('[Record]   Home / End     = jump to first / last step');
  console.log('[Record] PLAID LINK: Click the "Link External Account" button');
  console.log('[Record]   → Real Plaid Link modal will open');
  console.log('[Record]   → After Plaid completes, app auto-advances');
  console.log('[Record] Sandbox credentials: user_good / pass_good');
  console.log('[Record] Press ENTER in this terminal when you are done recording.');
  console.log('========================================\n');

  recordingStartMs = Date.now();

  await waitForEnter();

  const totalMs = Date.now() - recordingStartMs;
  console.log(`\n[Record] Recording stopped after ${(totalMs / 1000).toFixed(1)}s`);

  const videoPagePath = await page.video()?.path().catch(() => null);
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  await appServer.close().catch(() => {});

  // ── Save the recording ────────────────────────────────────────────────────
  const rawVideoPath   = path.join(OUT_DIR, 'recording-raw.webm');
  const finalVideoPath = path.join(OUT_DIR, 'recording.webm');

  if (videoPagePath && fs.existsSync(videoPagePath)) {
    fs.copyFileSync(videoPagePath, rawVideoPath);
    try { fs.unlinkSync(videoPagePath); } catch (_) {}
    console.log(`[Record] Raw video: ${path.relative(PROJECT_ROOT, rawVideoPath)}`);
  } else {
    const latestWebm = findLatestWebm(RECORDING_TMP_DIR);
    if (latestWebm) {
      fs.copyFileSync(latestWebm, rawVideoPath);
      try { fs.unlinkSync(latestWebm); } catch (_) {}
      console.log(`[Record] Raw video: ${path.relative(PROJECT_ROOT, rawVideoPath)} (directory scan)`);
    } else {
      console.warn('[Record] Warning: recording.webm not found — check _recording-tmp/');
    }
  }

  if (fs.existsSync(rawVideoPath)) {
    const didPostProcess = postProcessRecording(rawVideoPath, finalVideoPath);
    if (!didPostProcess) {
      fs.copyFileSync(rawVideoPath, finalVideoPath);
    }
    if (didPostProcess) {
      try { fs.unlinkSync(rawVideoPath); } catch (_) {}
    }
    console.log(`[Record] Video: ${path.relative(PROJECT_ROOT, finalVideoPath)}`);
  }

  // Clean up temp recording directory
  try {
    const tmpFiles = fs.readdirSync(RECORDING_TMP_DIR);
    for (const f of tmpFiles) { try { fs.unlinkSync(path.join(RECORDING_TMP_DIR, f)); } catch (_) {} }
    fs.rmdirSync(RECORDING_TMP_DIR);
  } catch (_) {}

  // Write synthetic step-timing.json based on proportional waitMs distribution
  writeSyntheticStepTiming(playwrightScript, demoScript, totalMs);
  console.log(`[Record] Timing: ${path.relative(PROJECT_ROOT, TIMING_FILE)} (synthetic)`);
  console.log(`[Record] Total: ${(totalMs / 1000).toFixed(1)}s — Next: voiceover`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(opts = {}) {
  // Dispatch to manual recording mode when MANUAL_RECORD=true
  if (MANUAL_RECORD) {
    return manualRecordMain();
  }

  // Reset module-level state for clean runs (Node caches modules between orchestrator calls)
  recordingStartMs = null;
  stepTimings.length = 0;
  _sandboxConfig = null;

  // Reset vision circuit breaker so each recording iteration starts fresh
  if (agent.resetVisionCircuitBreaker) {
    agent.resetVisionCircuitBreaker();
  }

  // Validate inputs
  if (!fs.existsSync(PLAYWRIGHT_SCRIPT)) {
    console.error('[Record] Missing: scratch-app/playwright-script.json — run build-app.js first');
    process.exit(1);
  }
  if (!fs.existsSync(DEMO_SCRIPT_FILE)) {
    console.error('[Record] Missing: out/demo-script.json — run generate-script.js first');
    process.exit(1);
  }

  const playwrightScript = JSON.parse(fs.readFileSync(PLAYWRIGHT_SCRIPT, 'utf8'));
  const demoScript       = JSON.parse(fs.readFileSync(DEMO_SCRIPT_FILE, 'utf8'));

  // Load sandbox config from demo-script.json (overrides env vars and defaults)
  if (PLAID_LINK_LIVE) {
    _sandboxConfig = loadSandboxConfig(demoScript);
  }

  // Build label and plaidPhase lookups from demo-script steps.
  // plaidPhaseMap is the authoritative source for Plaid Link phase detection —
  // it overrides the regex pattern matching in matchPlaidLinkPhase(), ensuring
  // custom step IDs (e.g. "chime-add-external") correctly resolve their phase.
  const stepLabelMap   = {};
  const plaidPhaseMap  = {};
  for (const step of demoScript.steps) {
    stepLabelMap[step.id] = step.label;
    if (step.plaidPhase) plaidPhaseMap[step.id] = step.plaidPhase;
  }

  console.log(`[Record] Loaded playwright-script.json: ${playwrightScript.steps.length} steps`);
  console.log(`[Record] Product: ${demoScript.product}`);

  // ── Per-step overrun watchdog ─────────────────────────────────────────────
  // If a non-Plaid-launch step takes more than its waitMs + OVERRUN_GRACE_MS,
  // force-advance to the next step via goToStep so the recording doesn't stall.
  // Plaid Link launch steps are exempt — they have their own 45s PLAID_LINK_TIMEOUT.
  const OVERRUN_GRACE_MS = 8000; // extra buffer beyond waitMs before auto-advance kicks in
  let _stepOverrunTimer = null;
  function clearStepOverrun() {
    if (_stepOverrunTimer) { clearTimeout(_stepOverrunTimer); _stepOverrunTimer = null; }
  }
  function armStepOverrun(page, stepId, waitMs, nextStepId, isPlaidLaunch) {
    clearStepOverrun();
    if (isPlaidLaunch || !nextStepId) return; // launch phase has its own timeout
    const budget = (waitMs || 5000) + OVERRUN_GRACE_MS;
    _stepOverrunTimer = setTimeout(async () => {
      console.warn(`[Record] Step "${stepId}" overran budget (${budget}ms) — auto-advancing to "${nextStepId}"`);
      // Destroy any open Plaid modal before advancing so it doesn't overlay subsequent steps.
      await page.evaluate(`if (window._plaidHandler) { try { window._plaidHandler.destroy(); } catch(e) {} }`).catch(() => {});
      await page.evaluate(`window.goToStep && window.goToStep('${nextStepId}')`).catch(() => {});
    }, budget);
  }

  // Resolve Plaid sandbox credentials (queries Glean plaid_docs if available)
  if (PLAID_LINK_LIVE) {
    const flowTypeFromEnv = (process.env.PLAID_FLOW_TYPE || '').trim().toLowerCase();
    const flowType = flowTypeFromEnv ||
      ((PLAID_LINK_RECORDING_PROFILE === 'cra' || isCraFamilyDemoScript(demoScript)) ? 'cra' : 'link');
    if (!flowTypeFromEnv && flowType === 'cra') {
      console.log('[Record] Using CRA sandbox institution credentials (inferred from demo-script or profile)');
    }
    console.log(`[Record] Resolving Plaid sandbox credentials (flow: ${flowType})...`);
    _sandboxCredentials = await agent.resolveSandboxCredentials(flowType);
    if (USE_BROWSER_AGENT) {
      console.log('[Record] Browser agent: ENABLED (vision-based Plaid Link automation)');
    } else {
      console.log('[Record] Browser agent: DISABLED (no ANTHROPIC_API_KEY — using CSS selectors)');
    }
  }

  fs.mkdirSync(OUT_DIR,           { recursive: true });
  fs.mkdirSync(RECORDING_TMP_DIR, { recursive: true });

  // Start local server — serve from this run's scratch-app directory
  const appServer = await startServer(3737, SCRATCH_APP_DIR);
  console.log(`[Record] App server: ${appServer.url} (serving ${SCRATCH_APP_DIR})`);

  // Launch non-headless Chromium — headless:false uses GPU compositor which captures
  // cross-origin OOPIFs (real Plaid Link modal) in recordVideo. deviceScaleFactor:2 with
  // CSS viewport 1440×900 produces native 2880×1800 physical pixels in the recording.
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    recordVideo: {
      dir:  RECORDING_TMP_DIR,
      size: { width: 2880, height: 1800 },
    },
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Navigate to the locally-served app
  console.log(`[Record] Navigating to ${appServer.url}...`);
  await page.goto(appServer.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Critical recording fixes injected via page.evaluate() — more reliable than addStyleTag()
  // which can fail silently due to CSP or timing issues.
  //
  // 1. Force non-active steps hidden (overrides inline display:flex that some generated steps use)
  // 2. Hide LINK EVENTS panel permanently — never visible in recordings
  //    NOTE: We also override window.goToStep to prevent it from adding the 'visible' class.
  //    NOTE: Playwright recordVideo in headless Chromium does NOT reliably capture cross-origin
  //    OOPIFs (the real Plaid Link modal). The recording automation completes the real Plaid flow
  //    via CDP frameLocator so onSuccess fires and the app advances to the post-link steps.
  //    The LINK EVENTS panel showing raw event names is a developer artifact that must never
  //    appear in demo recordings.
  // 3. Hide Plaid sandbox disclosure banner (inside cross-origin iframe — cannot target with CSS).
  //    We add a thin opaque bottom strip to the host page to cover the banner visually.
  await page.evaluate(`(() => {
    // Inject recording CSS
    const style = document.createElement('style');
    style.id = 'recording-fixes';
    style.textContent = [
      '.step:not(.active) { display: none !important; }',
      '#link-events-panel { display: none !important; }',
      // NOTE: Do NOT hide #api-response-panel — insight steps show it (JSON body may be collapsed via .api-json-collapsed).
      // Only the link-events-panel is permanently hidden (developer artifact).
      '[id*="plaid"][id*="sandbox"], [class*="plaid-sandbox"], [class*="sandbox-disclosure"],',
      '[id*="sandbox-banner"], [class*="sandbox-banner"] { display: none !important; }',
    ].join('\\n');
    document.head.appendChild(style);

    // Add a thin bottom strip to cover Plaid's "You are currently in Sandbox mode."
    // banner, which is inside the cross-origin Plaid Link iframe and cannot be
    // targeted by CSS. The strip sits above the iframe in the host-page stacking context.
    const sandboxCover = document.createElement('div');
    sandboxCover.id = 'sandbox-banner-cover';
    sandboxCover.style.cssText = [
      'position:fixed',
      'bottom:0',
      'left:0',
      'right:0',
      'height:40px',
      'background:#F4F4F4',
      'z-index:2147483647',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(sandboxCover);

    // Override goToStep to:
    // 1. Suppress LINK EVENTS panel visibility (developer artifact)
    // 2. Auto-show API response panel when a step has pre-populated response data.
    //    The panel is hidden by default; insight steps show the chrome with JSON collapsed until toggle expands it.
    const origGoToStep = window.goToStep;
    if (origGoToStep) {
      window.goToStep = function(id) {
        origGoToStep(id);
        // Suppress link-events-panel (always)
        const eventsPanel = document.getElementById('link-events-panel');
        if (eventsPanel) {
          eventsPanel.classList.remove('visible');
          eventsPanel.style.setProperty('display', 'none', 'important');
        }
        // Auto-show api-response-panel for insight steps (by ID pattern) or steps with data
        const apiPanel = document.getElementById('api-response-panel');
        if (apiPanel) {
          const isInsightStep = /insight|api.?response|plaid.?result|plaid.?data/i.test(id);
          // Check both _stepApiResponses (app-set) and _recordApiResponses (record-local-injected)
          const appData    = window._stepApiResponses    && window._stepApiResponses[id];
          const recordData = window._recordApiResponses  && window._recordApiResponses[id];
          const data       = appData || recordData;
          if (isInsightStep || data) {
            // Populate JSON panel content if data available
            if (data && typeof window._showApiPanelStub === 'function') {
              window._showApiPanelStub(data);
              apiPanel.classList.add('api-json-collapsed');
            } else {
              // Fallback: show panel chrome only; keep JSON body collapsed
              apiPanel.style.display = 'flex';
              apiPanel.classList.add('visible', 'api-json-collapsed');
            }
          } else {
            // Hide panel between non-insight steps
            apiPanel.style.setProperty('display', 'none', 'important');
            apiPanel.classList.remove('visible', 'expanded', 'open', 'active', 'api-json-collapsed');
          }
        }
      };
    }

    // The built app button calls window._plaidHandler.open() directly.
    // The real Plaid SDK opens its cross-origin iframe.
    // CDP frameLocator automation (in executePlaidLinkPhase 'launch') interacts with it.
  })()`).catch(e => console.warn('[Record] CSS/goToStep patch warning:', e.message));

  // Inject API response data from demo-script into the browser context.
  // This allows the goToStep override to call _showApiPanelStub(data) for insight steps
  // even when the build agent didn't wire up the goToStep handlers correctly.
  const _apiResponsesByStep = {};
  for (const step of (demoScript.steps || [])) {
    if (step.apiResponse && step.apiResponse.response) {
      _apiResponsesByStep[step.id] = step.apiResponse.response;
    }
  }
  if (Object.keys(_apiResponsesByStep).length > 0) {
    await page.evaluate(
      (apiResponses) => { window._recordApiResponses = apiResponses; },
      _apiResponsesByStep
    ).catch(e => console.warn('[Record] API response injection warning:', e.message));
    console.log(`[Record] Injected API responses for ${Object.keys(_apiResponsesByStep).length} steps`);
  }

  // Brief pause for the app to fully initialize
  await page.waitForTimeout(1000);

  // Start timing
  recordingStartMs = Date.now();
  console.log('[Record] Recording started');

  // Log Plaid Link mode
  if (PLAID_LINK_LIVE) {
    console.log(`[Record] Plaid Link mode: LIVE (institution: ${PLAID_SANDBOX_INSTITUTION})`);
  }

  // Execute each step's actions
  // Playwright script can have two formats:
  //   Format A: { stepId, actions: [...] }  (multi-action per step)
  //   Format B: { id, action, target, waitMs }  (single-action per step — from build-app.js)
  for (let _si = 0; _si < playwrightScript.steps.length; _si++) {
    const stepEntry = playwrightScript.steps[_si];
    const stepId = stepEntry.stepId || stepEntry.id;
    const label  = stepLabelMap[stepId] || stepId;
    _currentStepId = stepId;   // track for click-coord capture in executeAction
    markStep(stepId, label);

    // Arm overrun watchdog for this step
    const _nextEntry = playwrightScript.steps[_si + 1];
    const _nextStepId = _nextEntry ? (_nextEntry.stepId || _nextEntry.id) : null;
    // _isLaunch: also check plaidPhaseMap (explicit "plaidPhase":"launch" in demo-script.json)
    // and the click-target regex so the overrun timer is never armed for Plaid launch steps
    // regardless of step ID naming (e.g. "chime-link-entry" wouldn't match the regex alone).
    const _clickIsLaunch = PLAID_LINK_LIVE &&
      !plaidPhaseMap[stepId] && !matchPlaidLinkPhase(stepId) &&
      stepEntry.action === 'click' &&
      (stepEntry.target || '').match(/link[-_]external[-_]account|connect[-_]bank|open[-_]link|link[-_]account[-_]btn|btn[-_]link|link[-_]bank|start[-_]link|initiate[-_]link|plaid[-_]link[-_]btn/i);
    const _isLaunch = PLAID_LINK_LIVE && (
      matchPlaidLinkPhase(stepId) === 'launch' ||
      plaidPhaseMap[stepId] === 'launch' ||
      !!_clickIsLaunch
    );
    armStepOverrun(page, stepId, stepEntry.waitMs, _nextStepId, _isLaunch);

    // ── Live Plaid Link override ──────────────────────────────────────────
    // When PLAID_LINK_LIVE=true, check if this step matches a Plaid Link
    // flow phase. If so, first run the standard goToStep action (to advance
    // the app UI), then execute real iframe interactions instead of the
    // generated mock actions.
    if (PLAID_LINK_LIVE) {
      // Primary: check plaidPhase field from demo-script.json (authoritative, handles any step ID)
      // Fallback: regex pattern matching (for steps without explicit plaidPhase field)
      let plaidPhase = plaidPhaseMap[stepId] || matchPlaidLinkPhase(stepId);
      if (plaidPhaseMap[stepId]) {
        console.log(`  [Record] Live Plaid Link phase from demo-script: step "${stepId}" → "${plaidPhase}"`);
      }
      // Fallback: if a click action targets the Plaid Link button, treat as launch phase.
      // This handles build-agent step IDs like "wf-link-initiate-click" that don't match
      // the standard naming patterns but represent the same action.
      let plaidLaunchStepId = null; // step ID to goToStep before executing launch
      if (!plaidPhase && stepEntry.action === 'click' &&
          (stepEntry.target || '').match(/link[-_]external[-_]account|connect[-_]bank|open[-_]link|link[-_]account[-_]btn|btn[-_]link|link[-_]bank|start[-_]link|initiate[-_]link|plaid[-_]link[-_]btn/i)) {
        plaidPhase = 'launch';
        // For synthetic click steps (e.g. "wf-link-initiate-click"), there's no corresponding
        // HTML div. Prefer:
        //   1. Current step ID if it has an HTML div (e.g. "wf-link-launch" → step-wf-link-launch)
        //   2. Previous step's goToStep TARGET (the HTML step ID, not the playwright step ID)
        //   3. Current step ID as last resort
        const currentStepIndex = playwrightScript.steps.findIndex(s => s.id === stepId);
        const prevStep = currentStepIndex > 0 ? playwrightScript.steps[currentStepIndex - 1] : null;
        const prevGoToTarget = prevStep?.action === 'goToStep' ? (prevStep.target || '').replace(/^window\.goToStep\(['"](.+)['"]\)$/, '$1').replace(/^goToStep\(['"](.+)['"]\)$/, '$1') : null;
        plaidLaunchStepId = prevGoToTarget || stepId;
        console.log(`  [Record] Detected Plaid Link button click in step "${stepId}" → treating as launch phase (using goToStep("${plaidLaunchStepId}"))`);
      }
      if (plaidPhase) {
        console.log(`  [Record] Live Plaid Link override: step "${stepId}" → phase "${plaidPhase}"`);

        // Always call goToStep to activate the current step before running Plaid actions.
        // For 'launch' phase this ensures the Link button (inside this step's div) is visible.
        // For other phases this shows the simulated Plaid overlay screen.
        // Use plaidLaunchStepId if set (for synthetic click steps with no matching div).
        const goToStepId = plaidLaunchStepId || stepId;
        await page.evaluate(`window.goToStep('${goToStepId}')`).catch(() => {});
        await page.waitForTimeout(500);

        // Execute the real Plaid Link iframe actions for this phase
        try {
          await executePlaidLinkPhase(page, plaidPhase);
        } catch (plaidErr) {
          console.warn(`  [Plaid Link] Phase "${plaidPhase}" failed: ${plaidErr.message}`);
        }

        // Ensure the Plaid modal is closed before advancing — if onSuccess fired, destroy()
        // was already called. If the automation timed out, we must force-close it here so
        // the modal doesn't overlay all subsequent steps in the recording.
        if (plaidPhase === 'launch') {
          const closed = await page.evaluate(`
            (function() {
              if (window._plaidHandler) {
                try { window._plaidHandler.destroy(); } catch(e) {}
                return true;
              }
              return false;
            })()
          `).catch(() => false);
          if (closed) console.log('  [Plaid Link] Ensured Plaid modal closed after launch phase.');
        }

        // Add any additional wait from the step entry
        if (stepEntry.waitMs) {
          await page.waitForTimeout(Math.min(stepEntry.waitMs, 5000));
        }

        continue; // Skip the normal action execution for this step
      }
    }

    if (stepEntry.actions && Array.isArray(stepEntry.actions)) {
      // Format A: explicit actions array
      await executeActions(page, stepEntry.actions);
    } else if (stepEntry.action) {
      // Format B: single action with target + waitMs
      const actions = [];
      if (stepEntry.action === 'goToStep') {
        // target may already be "window.goToStep('...')" or just the step ID
        const target = stepEntry.target || '';
        // target may be: "window.goToStep('id')", "goToStep('id')", or just "id"
        const expression = target.startsWith('window.')
          ? target
          : target.startsWith('goToStep(')
            ? `window.${target}`
            : `window.goToStep('${target}')`;
        actions.push({
          type: 'evalStep',
          expression,
        });
      } else if (stepEntry.action === 'click') {
        actions.push({
          type: 'click',
          selector: stepEntry.target,
        });
      } else if (stepEntry.action === 'fill') {
        actions.push({
          type: 'fill',
          selector: stepEntry.target,
          value: stepEntry.value || '',
        });
      } else if (stepEntry.action === 'wait') {
        // Just wait — no interaction
      }
      // Add a wait for the step's declared duration
      if (stepEntry.waitMs) {
        actions.push({
          type: 'wait',
          ms: stepEntry.waitMs,
        });
      }
      await executeActions(page, actions);
    }
    clearStepOverrun(); // step completed normally — cancel watchdog
  }
  clearStepOverrun();

  // ── Teardown ──────────────────────────────────────────────────────────────
  const totalMs = Date.now() - recordingStartMs;

  // Retrieve the video path BEFORE closing context (context.close() finalizes the webm)
  const videoPagePath = await page.video()?.path().catch(() => null);
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  // Stop the local server
  await appServer.close().catch(() => {});

  // Locate and move the webm to the run directory
  const rawVideoPath = path.join(OUT_DIR, 'recording-raw.webm');
  let finalVideoPath = path.join(OUT_DIR, 'recording.webm');

  if (videoPagePath && fs.existsSync(videoPagePath)) {
    fs.copyFileSync(videoPagePath, rawVideoPath);
    try { fs.unlinkSync(videoPagePath); } catch (_) {}
    console.log(`[Record] Raw video: ${path.relative(PROJECT_ROOT, rawVideoPath)}`);
  } else {
    // Fallback: find latest webm in RECORDING_TMP_DIR
    const latestWebm = findLatestWebm(RECORDING_TMP_DIR);
    if (latestWebm) {
      fs.copyFileSync(latestWebm, rawVideoPath);
      try { fs.unlinkSync(latestWebm); } catch (_) {}
      console.log(`[Record] Raw video: ${path.relative(PROJECT_ROOT, rawVideoPath)} (found via directory scan)`);
    } else {
      console.warn('[Record] Warning: recording.webm not found — check _recording-tmp/ directory');
    }
  }

  // Post-process for higher FPS if requested (> 30fps)
  if (fs.existsSync(rawVideoPath)) {
    const didPostProcess = postProcessRecording(rawVideoPath, finalVideoPath);
    if (!didPostProcess) {
      // No post-processing needed or it failed — use raw recording directly
      if (rawVideoPath !== finalVideoPath) {
        fs.copyFileSync(rawVideoPath, finalVideoPath);
      }
    }
    // Keep raw recording for debugging but remove if post-processing succeeded
    if (didPostProcess) {
      try { fs.unlinkSync(rawVideoPath); } catch (_) {}
    }
    console.log(`[Record] Video: ${path.relative(PROJECT_ROOT, finalVideoPath)}`);
  }

  // Clean up temp recording directory
  try {
    const tmpFiles = fs.readdirSync(RECORDING_TMP_DIR);
    for (const f of tmpFiles) { try { fs.unlinkSync(path.join(RECORDING_TMP_DIR, f)); } catch (_) {} }
    fs.rmdirSync(RECORDING_TMP_DIR);
  } catch (_) {}

  // Write step-timing.json
  writeStepTiming(totalMs);
  console.log(`[Record] Timing: ${path.relative(PROJECT_ROOT, TIMING_FILE)}`);
  console.log(`[Record] Total: ${(totalMs / 1000).toFixed(1)}s — Next: qa-review.js`);
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[Record] Fatal error:', err.message);
    process.exit(1);
  });
}
