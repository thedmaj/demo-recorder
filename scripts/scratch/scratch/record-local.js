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

// Preserve explicit shell-provided env values before dotenv override.
const PRESERVED_ENV_KEYS = ['RECORDING_FPS', 'RECORD_POSTPROCESS_TIMEOUT_MS'];
const preservedEnv = {};
for (const key of PRESERVED_ENV_KEYS) {
  if (process.env[key] != null) preservedEnv[key] = process.env[key];
}
require('../utils/load-env').loadEnv();
for (const [key, value] of Object.entries(preservedEnv)) {
  process.env[key] = value;
}
const { chromium }  = require('playwright');
const fs             = require('fs');
const path           = require('path');
const { execSync }   = require('child_process');
const { startServer } = require('../utils/app-server');
const agent          = require('../utils/plaid-browser-agent');
const { executeSmartPlaidPhase } = require('../utils/smart-plaid-agent');
const { loadRecipe: loadPlaidRecipe, executeRecipe: executePlaidRecipe } = require('../utils/plaid-recipe-executor');
const { inferProductFamily } = require('../utils/product-profiles');
const { createPacer } = require('../utils/human-pacing');
const navProfile = require('../utils/plaid-nav-profile');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT      = path.resolve(__dirname, '../../..');
const OUT_DIR           = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');

/**
 * Mirror the page's browser console to artifacts/browser-console.log so the
 * live-api `console.log('[live-api]', …)` output (and any other console
 * messages) is inspectable off-camera. Best-effort; never throws.
 */
function attachConsoleCapture(page) {
  try {
    const logPath = path.join(OUT_DIR, 'artifacts', 'browser-console.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    page.on('console', (msg) => {
      try {
        const line = `[${new Date().toISOString()}] [${msg.type()}] ${msg.text()}\n`;
        fs.appendFileSync(logPath, line);
      } catch (_) { /* non-fatal */ }
    });
  } catch (_) { /* non-fatal */ }
}
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
const PLAID_IFRAME_SELECTOR = 'iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"], iframe[src*="plaid.com"]';
// Transition-safe step timing: when a step begins with goToStep(), stamp timing only
// after the step is active and DOM settles to avoid transition bleed in QA boundary frames.
const RECORD_TRANSITION_SAFE_TIMING = !(
  process.env.RECORD_TRANSITION_SAFE_TIMING === 'false' ||
  process.env.RECORD_TRANSITION_SAFE_TIMING === '0'
);
const STEP_TRANSITION_SETTLE_MS = parseInt(process.env.STEP_TRANSITION_SETTLE_MS || '300', 10);
// Extra boundary guard immediately after Plaid launch completion.
const POST_LINK_STEP_BOUNDARY_GUARD_MS = parseInt(process.env.POST_LINK_STEP_BOUNDARY_GUARD_MS || '700', 10);
const RECORD_POSTPROCESS_TIMEOUT_MS = parseInt(process.env.RECORD_POSTPROCESS_TIMEOUT_MS || '360000', 10);
const RECORD_POSTPROCESS_MAX_RETRIES = parseInt(process.env.RECORD_POSTPROCESS_MAX_RETRIES || '1', 10);

// Human-pacing engine (PLAID_NAV_STYLE=human|fast). DEFAULT IS 'human' as of
// 2026-06-12 — validated across classic/CRA/Layer/IDV/embedded (QA 84–95);
// set PLAID_NAV_STYLE=fast to reproduce the pre-pacer machine-speed constants
// exactly (byte-identical fast path, verified by checkpoint regression).
// Initialized in main() once the flow type and nav profile are known;
// getPacer() lazily provides a profile-less pacer for earlier call paths.
const PLAID_NAV_STYLE_DEFAULT = 'human';
let _pacer = null;
function getPacer() {
  if (!_pacer) _pacer = createPacer({ style: process.env.PLAID_NAV_STYLE || PLAID_NAV_STYLE_DEFAULT });
  return _pacer;
}
// Iframe-relative interaction coords (data for the future pointer-overlay
// phase — written to plaid-interactions.json, never rendered today).
const plaidInteractions = [];
async function recordPlaidInteraction(page, locator, screenId) {
  try {
    const box = await locator.boundingBox({ timeout: 800 });
    if (!box || !recordingStartMs) return;
    const iframeEl = page.locator(PLAID_IFRAME_SELECTOR).first();
    const ibox = await iframeEl.boundingBox({ timeout: 800 }).catch(() => null);
    plaidInteractions.push({
      screenId: screenId || null,
      t: (Date.now() - recordingStartMs) / 1000,
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      frameRelative: !!ibox,
      frameX: ibox ? box.x - ibox.x + box.width / 2 : null,
      frameY: ibox ? box.y - ibox.y + box.height / 2 : null,
    });
  } catch (_) { /* best-effort — data capture only */ }
}

// Resolved sandbox credentials (populated in main() after async Glean lookup)
let _sandboxCredentials = null;

// Sandbox config loaded from demo-script.json (overrides env vars and defaults)
let _sandboxConfig = null;
let _plaidLinkMode = 'modal';

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
  // Dedupe: if the most recent mark is the same stepId, skip. This lets
  // armStepOverrun pre-mark a forced step transition without colliding with
  // the iterator's own later markStep call for that step. Different stepIds
  // are always allowed (handles the legitimate "wf-link-launch ×2" case the
  // post-Plaid de-dup elsewhere relies on).
  if (stepTimings.length > 0 && stepTimings[stepTimings.length - 1].id === stepId) {
    return;
  }
  stepTimings.push({ id: stepId, label: label || stepId, startMs: elapsedMs });
  console.log(`  [${String(Math.round(elapsedMs / 1000)).padStart(3)}s] Step: ${label || stepId}`);
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
  return page.frameLocator(PLAID_IFRAME_SELECTOR);
}

/**
 * Wait for the Plaid Link iframe to appear and be ready.
 */
async function plaidLinkWaitReady(page) {
  console.log('  [Plaid Link] Waiting for Link iframe to appear...');
  const iframeSelector = PLAID_IFRAME_SELECTOR;
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
  // Human style: content-proportional read dwell replaces the uniform constant.
  const resolvedDwell = getPacer().isHuman
    ? getPacer().screenDwellMs({ fallbackMs: dwell })
    : dwell;
  if (resolvedDwell > 0) await page.waitForTimeout(resolvedDwell);
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

  // Dwell so the viewer sees the institution list before selection.
  // Do NOT scroll — Tartan Bank is always visible at the top of the list.
  // Human style: visual-search scan dwell; fast: the original fixed 2s.
  if (getPacer().isHuman) {
    await getPacer().scanList(page, 5, 'saved-institution-list');
  } else {
    await page.waitForTimeout(2000);
  }

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

  // ONLY attempt known non-OAuth saved banks. If the saved list contains only OAuth
  // banks (e.g. "Merrill" for the +14155550011 returning-user phone), return null so
  // the CALLER falls back to searching the configured non-OAuth institution — clicking
  // an OAuth saved bank dead-ends the recording (it opens OAuth, onSuccess never fires;
  // YNAB 2026-06-24). Tartan Bank is always first in the sandbox Remember Me list.
  const preferred = ['Tartan Bank', 'First Platypus Bank', 'First Gingham'];
  const ordered = listItems.filter(i => preferred.some(p => i.text.includes(p)));
  if (ordered.length === 0) {
    console.log(`  [Plaid Link] Saved institutions are all OAuth/unknown (${JSON.stringify(listItems.map(i => i.text))}) — will search the configured non-OAuth bank instead.`);
    return null;
  }

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
 * On the returning-user saved-institution screen, click the affordance that leads to
 * searching for a DIFFERENT bank ("Connect a different institution" / "I don't see my
 * bank" / "Search for your bank" / a search input). Used when the saved institutions
 * are all OAuth/un-automatable so the recorder can connect the configured non-OAuth
 * bank instead and still complete onSuccess (YNAB returning-user fix, 2026-06-24).
 * Returns true if it reached/opened a search affordance.
 */
async function plaidConnectDifferentInstitution(page) {
  const frame = getPlaidLinkFrame(page);
  // If a bank-search input is already on screen, nothing to click.
  const searchNow = frame.locator('input[placeholder*="Search" i], input[type="search"], input[role="searchbox"]').first();
  if (await searchNow.isVisible({ timeout: 1500 }).catch(() => false)) {
    console.log('  [Plaid Link] Search input already present on saved-institution screen.');
    return true;
  }
  const labels = [
    'Connect a different institution', 'connect a different', 'a different institution',
    "I don't see my bank", 'see my bank', 'Search for your bank', 'Search for a bank',
    'Add a different account', 'Connect a different account', 'Add another bank',
    'Search', 'Find your bank',
  ];
  for (const label of labels) {
    try {
      const el = frame.getByText(label, { exact: false }).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await el.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(1200);
        console.log(`  [Plaid Link] Connect-different-institution via: "${label}"`);
        return true;
      }
    } catch (_) { /* try next */ }
  }
  // Last resort: an in-iframe DOM click on any element whose text matches.
  const clicked = await (page.frames().find(f => /plaid\.com/.test(f.url())) || page.mainFrame())
    .evaluate(() => {
      const rx = /different institution|see my bank|search for (your|a) bank|different account|another bank/i;
      const el = Array.from(document.querySelectorAll('button, a, [role="button"], li'))
        .find(n => rx.test(n.textContent || ''));
      if (el) { el.click(); return true; }
      return false;
    }).catch(() => false);
  if (clicked) { await page.waitForTimeout(1200); console.log('  [Plaid Link] Connect-different-institution via in-iframe DOM click.'); }
  return clicked;
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

  // Scroll-free DOM-dispatch first. Playwright's frameLocator.click() runs
  // scrollIntoViewIfNeeded, which scrolls the modal's (scrollable) account list
  // up/down to bring the checkbox / Confirm button into view — the visible
  // "scroll jitter before selecting a bank" (2026-06-17). A DOM .click() inside
  // the iframe selects + confirms WITHOUT scrolling (same pattern already used by
  // plaidSelectSavedInstitution). Falls through to the Playwright path on miss.
  const plaidFrame = page.frames().find(f => /plaid\.com/.test(f.url()));
  if (plaidFrame) {
    try {
      const picked = await plaidFrame.evaluate(() => {
        const vis = (el) => el && el.offsetParent !== null;
        for (const s of ['input[type="checkbox"]', '[data-testid="account-select"]', '[role="checkbox"]', '[class*="AccountItem"]', 'li[role="listitem"]']) {
          const el = document.querySelector(s);
          if (vis(el)) { el.click(); return s; }
        }
        return null;
      });
      if (picked) {
        await page.waitForTimeout(1000);
        const cont = await plaidFrame.evaluate(() => {
          const vis = (el) => el && el.offsetParent !== null;
          const btns = Array.from(document.querySelectorAll('button'));
          for (const t of ['Confirm', 'Continue', 'Link account', 'Connect']) {
            const b = btns.find((x) => vis(x) && (x.textContent || '').trim().includes(t));
            if (b) { b.click(); return t; }
          }
          const sub = document.querySelector('button[type="submit"]');
          if (vis(sub)) { sub.click(); return 'submit'; }
          return null;
        });
        if (cont) {
          console.log(`  [Plaid Link] Account+Continue via scroll-free DOM dispatch (${picked} → ${cont})`);
          await page.waitForTimeout(2000);
          return;
        }
      }
    } catch (e) {
      console.warn(`  [Plaid Link] scroll-free account select failed, falling back to selectors: ${e.message}`);
    }
  }

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
/**
 * Records how the Plaid Link flow actually ended so QA can flag an UNSUCCESSFUL
 * link (e.g. a wrong sandbox OTP that Plaid rejected — YNAB 2026-06-24). Written to
 * plaid-link-outcome.json; read by plaid-link-integrity.js.
 *   outcome: 'success'              — app onSuccess fired (token exchanged)
 *            'forced-no-success'    — recorder force-completed; onSuccess NEVER fired → link FAILED
 *            'timeout'              — hard timeout, no completion
 */
function recordLinkOutcome(outcome, detail = {}) {
  try {
    const p = path.join(OUT_DIR, 'plaid-link-outcome.json');
    fs.writeFileSync(p, JSON.stringify({ outcome, ...detail, at: new Date().toISOString() }, null, 2));
  } catch (_) { /* best-effort */ }
}

async function plaidLinkWaitSuccess(page) {
  console.log('  [Plaid Link] Waiting for Link completion (window._plaidLinkComplete)...');

  // Pre-flight: warn if DOM contract is violated (getCurrentStep missing)
  const hasGetCurrentStep = await page.evaluate(() => typeof window.getCurrentStep === 'function');
  if (!hasGetCurrentStep) {
    console.warn('[Record] WARNING: window.getCurrentStep not defined — DOM contract violation. Will wait for _plaidLinkComplete only, which may advance recording prematurely.');
  }

  // 90s — accommodates Remember Me flow (onSuccess fires late). Human pacing
  // extends the budget by the dwell it added, so the 25s-remaining deterministic
  // fallback can never fire mid-dwell.
  const TIMEOUT_MS = 90000 + (getPacer().isHuman ? getPacer().dwellBudgetMs() : 0);
  // Intermediate step IDs that indicate Link is still in progress
  const PLAID_LINK_INTERMEDIATE_STEPS = [
    'step-link-consent', 'step-link-otp', 'step-link-account-select',
  ];

  const deadline = Date.now() + TIMEOUT_MS;
  let lastRescueAt = 0;
  let rescueCount = 0;
  while (Date.now() < deadline) {
    const ready = await page.evaluate((intermediateSteps) => {
      if (!window._plaidLinkComplete) return false;
      if (typeof window.getCurrentStep !== 'function') return false;
      const current = window.getCurrentStep();
      if (current && intermediateSteps.includes(current)) return false;
      return true;
    }, PLAID_LINK_INTERMEDIATE_STEPS).catch(() => false);
    if (ready) {
      console.log('  [Plaid Link] Link flow complete!');
      recordLinkOutcome('success', { via: 'onSuccess' });
      return;
    }
    // Embedded flows can surface late phone/save prompts after account selection.
    // Actively try to dismiss every ~2.5s while waiting.
    if (Date.now() - lastRescueAt > 2500) {
      lastRescueAt = Date.now();
      const rescued = await plaidLinkDismissSaveScreen(page).catch(() => false);
      if (rescued) rescueCount += 1;
    }
    // Deterministic fallback: if we are clearly stuck in post-link prompts for too long,
    // force completion and advance to the next host step to avoid hard timeout stalls.
    if (Date.now() > deadline - 25000) {
      const fallback = await page.evaluate(() => {
        try {
          // Did the APP's onSuccess already fire? If not, the recorder is about to
          // force-complete a link that never succeeded (e.g. rejected OTP).
          const hadAppSuccess = window._plaidLinkComplete === true;
          if (!window._plaidLinkComplete) window._plaidLinkComplete = true;
          if (typeof window.getCurrentStep === 'function' && typeof window.goToStep === 'function') {
            const current = String(window.getCurrentStep() || '').replace(/^step-/, '');
            const ids = Array.from(document.querySelectorAll('.step[data-testid]'))
              .map((s) => String(s.dataset.testid || '').replace(/^step-/, ''))
              .filter(Boolean);
            const idx = ids.indexOf(current);
            const next = idx >= 0 ? ids[idx + 1] : null;
            if (next) window.goToStep(next);
            return { forced: true, hadAppSuccess, current, next: next || null };
          }
          return { forced: true, hadAppSuccess, current: null, next: null };
        } catch (e) {
          return { forced: false, error: String(e && e.message ? e.message : e) };
        }
      }).catch(() => ({ forced: false }));
      if (fallback && fallback.forced) {
        console.warn(
          `  [Plaid Link] Forced deterministic completion after repeated post-link prompt loop ` +
          `(current=${fallback.current || 'unknown'} next=${fallback.next || 'none'}).`
        );
        // Distinguish a real link that just stalled on late post-link prompts
        // (app onSuccess already fired) from a link that NEVER succeeded (no
        // onSuccess — e.g. a rejected OTP). The latter ships a broken demo and
        // must be flagged by QA.
        if (fallback.hadAppSuccess) {
          recordLinkOutcome('success', { via: 'forced-after-onSuccess', current: fallback.current || null });
        } else {
          console.warn('  [Plaid Link] ⚠ onSuccess never fired — link was NOT successful (forced). Flagging for QA.');
          recordLinkOutcome('forced-no-success', { current: fallback.current || null, next: fallback.next || null });
        }
        return;
      }
    }
    await page.waitForTimeout(300);
  }
  {
    // Take a diagnostic screenshot so the failure can be analyzed post-mortem
    const diagPath = path.join(OUT_DIR, `plaid-link-timeout-${Date.now()}.png`);
    await page.screenshot({ path: diagPath, fullPage: true }).catch(() => {});
    recordLinkOutcome('timeout', { timeoutSec: TIMEOUT_MS / 1000 });
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
  const fallbackPhone = (_sandboxConfig && _sandboxConfig.phone) ? String(_sandboxConfig.phone) : '+14155550011';

  // If embedded flow is on the optional phone capture prompt, satisfy it directly.
  try {
    const phoneInput = frame.locator('input[type="tel"], input[name="phone"], input[inputmode="tel"], input[placeholder*="phone" i]').first();
    if (await phoneInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await phoneInput.fill(fallbackPhone).catch(() => {});
      for (const cta of ['button:has-text("Continue")', 'button[type="submit"]', 'a:has-text("Continue")']) {
        const btn = frame.locator(cta).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await btn.click({ timeout: 2000 }).catch(async () => {
            await btn.click({ force: true, timeout: 1200 }).catch(() => {});
          });
          console.log('  [Plaid Link] Completed phone prompt with sandbox number and continued.');
          await page.waitForTimeout(1200);
          return true;
        }
      }
    }
  } catch (_) {}

  const selectors = [
    'button:has-text("Finish without saving")',
    'a:has-text("Finish without saving")',
    'button:has-text("Continue without phone number")',
    'a:has-text("Continue without phone number")',
    'button:has-text("without saving")',
    // Plaid sometimes shows "Continue" or "Skip" instead
    'button:has-text("Continue")',
    'a:has-text("Continue")',
    'button:has-text("Skip")',
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
  for (const txt of ['Continue without phone number', 'without phone number', 'Finish without saving', 'Continue', 'Skip']) {
    try {
      const el = frame.getByText(txt, { exact: false }).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await el.click({ timeout: 3000 }).catch(async () => {
          await el.click({ force: true, timeout: 2000 }).catch(() => {});
        });
        console.log(`  [Plaid Link] Dismissed save/phone prompt via text: "${txt}"`);
        await page.waitForTimeout(1200);
        return true;
      }
    } catch (_) {}
  }
  // Some embedded flows surface the prompt outside the primary Plaid iframe.
  for (const txt of ['Continue without phone number', 'without phone number', 'Finish without saving', 'Continue', 'Skip']) {
    try {
      const pageHit = page.getByText(txt, { exact: false }).first();
      if (await pageHit.isVisible({ timeout: 700 }).catch(() => false)) {
        await pageHit.click({ timeout: 2000 }).catch(async () => {
          await pageHit.click({ force: true, timeout: 1200 }).catch(() => {});
        });
        console.log(`  [Plaid Link] Dismissed prompt from page context via text: "${txt}"`);
        await page.waitForTimeout(1200);
        return true;
      }
    } catch (_) {}
  }
  for (const frm of page.frames()) {
    for (const txt of ['Continue without phone number', 'without phone number', 'Finish without saving', 'Continue', 'Skip']) {
      try {
        const hit = frm.getByText(txt, { exact: false }).first();
        if (await hit.isVisible({ timeout: 500 }).catch(() => false)) {
          await hit.click({ timeout: 1500 }).catch(async () => {
            await hit.click({ force: true, timeout: 1000 }).catch(() => {});
          });
          console.log(`  [Plaid Link] Dismissed prompt from frame context via text: "${txt}"`);
          await page.waitForTimeout(1200);
          return true;
        }
      } catch (_) {}
    }
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
 * Detect which Plaid product a `plaidPhase:"launch"` step launches.
 * @returns {'idv'|'layer'|'link'}
 */
function detectLaunchProduct(stepId, target) {
  const hay = `${stepId || ''} ${target || ''}`.toLowerCase();
  if (/\bidv\b|identity[-_]?verification|idv[-_]launch/.test(hay)) return 'idv';
  if (/\blayer\b/.test(hay)) return 'layer';
  return 'link';
}

/**
 * Human-like OTP entry INSIDE a live Plaid Layer / IDV modal.
 *
 * The Layer returning-user sandbox flow (eligible phone +14155550011) shows a
 * phone-verification OTP screen inside the modal before the prefilled review.
 * The generic vision-click nav loop in executeLayerOrIdvLaunch can't fill it, so
 * it would just dwell on the OTP pane — the "Layer OTP entry too long" symptom
 * (Credit Genie, 2026-06-17: ~5–6s read-dwells sat on the code screen).
 *
 * RULE (moving forward): when an OTP input appears in the Layer/IDV modal, wait
 * AT MOST 1.5s before entry begins (PLAID_LAYER_OTP_BEFORE_MS, default 1500,
 * HARD-CAPPED at 1500ms — a "receive the code" beat), then human-type the
 * sandbox OTP (123456) at keystroke speed and submit SCROLL-FREE (Enter; in-
 * iframe DOM .click() fallback) — same scroll-free contract as classic Link
 * (never a frameLocator click, whose scrollIntoViewIfNeeded bounces the modal's
 * inner scroll container).
 *
 * Lean, fast probe (canonical Plaid OTP attributes only) so it adds negligible
 * latency on screens with no OTP (e.g. IDV). Guards against the phone field
 * (type=tel/numeric also match it) via the ≥7-digit heuristic.
 *
 * @returns {Promise<boolean>} true if an OTP screen was found and filled.
 */
async function enterModalOtpIfPresent(page, { label = 'Layer' } = {}) {
  const frame = page.frameLocator(PLAID_IFRAME_SELECTOR);
  // Canonical Plaid OTP attributes, probed fast (most-specific first).
  const otpSelectors = [
    ['input[autocomplete*="one-time-code"]', 400],
    ['input[inputmode="numeric"]', 250],
    ['input[type="tel"]', 200],
  ];
  for (const [otpSel, timeout] of otpSelectors) {
    const otpInput = frame.locator(otpSel).first();
    if (!(await otpInput.isVisible({ timeout }).catch(() => false))) continue;
    // Guard: type=tel / numeric also match the PHONE input. ≥7 digits = phone.
    const existing = (await otpInput.inputValue().catch(() => '')).replace(/\D/g, '');
    if (existing.length >= 7) continue;

    // Short "receive the code" beat before entry begins. Default trimmed 1500→500ms
    // (operator 2026-06-24: OTP entry starts ~1s sooner); still hard-capped at 1500ms.
    const beforeCap = Math.min(
      Math.max(0, parseInt(process.env.PLAID_LAYER_OTP_BEFORE_MS || '500', 10) || 0),
      1500,
    );
    markPlaidStep('otp-screen', page);
    if (beforeCap > 0) await page.waitForTimeout(beforeCap);
    await otpInput.click({ force: true, timeout: 3000 }).catch(() => {});
    await recordPlaidInteraction(page, otpInput, 'otp-screen').catch(() => {});
    // Length-aware sandbox OTP (same fix as classic Link): 6-digit phone code is
    // 123456, 4-digit device-MFA is 1234; ignore a mismatched LLM config value.
    const otpMax = parseInt((await otpInput.getAttribute('maxlength').catch(() => '')) || '0', 10);
    const otpCfg = String(_sandboxConfig?.otp || '');
    const otp = otpMax === 4
      ? (otpCfg.length === 4 ? otpCfg : '1234')
      : (otpCfg.length === 6 ? otpCfg : '123456');
    if (otpCfg && otpCfg !== otp) {
      console.log(`  [Plaid ${label}] OTP corrected: config "${otpCfg}" != ${otpMax || 6}-digit field → using sandbox ${otp}`);
    }
    const typed = await getPacer().humanType(otpInput, String(otp), {
      kind: 'numeric', screenId: 'otp-screen', fastDelayMs: 220,
    }).then(() => true).catch(() => false);
    if (!typed) await otpInput.fill(String(otp)).catch(() => {});
    markPlaidStep('otp-filled');

    // Submit SCROLL-FREE — Enter on the focused input, then an in-iframe DOM
    // .click() fallback. Never frameLocator click (scrollIntoViewIfNeeded jitter).
    await otpInput.press('Enter', { timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(450);
    const stillOtp = await otpInput.isVisible({ timeout: 500 }).catch(() => false);
    if (stillOtp) {
      const plaidFr = page.frames().find(f => /plaid\.com/.test(f.url()));
      if (plaidFr) {
        await plaidFr.evaluate(() => {
          const vis = (el) => el && el.offsetParent !== null;
          const btns = Array.from(document.querySelectorAll('button'));
          for (const t of ['Verify', 'Confirm', 'Continue']) {
            const b = btns.find((x) => vis(x) && (x.textContent || '').trim().includes(t));
            if (b) { b.click(); return; }
          }
          const sub = document.querySelector('button[type="submit"]');
          if (vis(sub)) sub.click();
        }).catch(() => {});
      }
    }
    markPlaidStep('otp-submitted', page);
    await page.waitForTimeout(250);
    console.log(`  [Plaid ${label}] OTP entered human-style (≤${beforeCap}ms pre-delay) + submitted scroll-free`);
    return true;
  }
  return false;
}

/**
 * Launch a LIVE Plaid Layer or IDV modal (real Plaid SDK) and — above all —
 * VERIFY the modal loads. Mirrors the verified app behavior: the CTA onclick
 * opens the modal (Layer: eligibility ran on load → open on Continue; IDV:
 * open on click). Optionally vision-navigates the modal screens, then waits on
 * the product-specific completion flag (Layer: _plaidLinkComplete, IDV:
 * _idvComplete). Recording proceeds even if completion can't be auto-driven —
 * the priority is capturing the live modal loading.
 * @param {'layer'|'idv'} product
 */
/** Is the live Plaid modal iframe still on screen? */
function plaidModalPresent(page) {
  return !!page.frames().find(f => /plaid\.com/.test(f.url()));
}

/**
 * Guarantee the Plaid Link modal actually OPENED and is VISIBLE after the launch
 * CTA click. agent.visionClick can report a successful click that visually missed
 * the CTA, so the app's opener never fires and the host pre-link card stays up —
 * the recorder then navigates the host card, the modal never composites, and the
 * integrity gate halts (Citi funding funnel, 2026-06-23: a "Securely connect your
 * bank" explainer card with a "Link external account" button stayed on screen,
 * institution-list-shown stuck at a fixed ~57s fallback, modal-missing).
 *
 * If no VISIBLE Plaid iframe (real size, not the hidden preload iframe) is present
 * shortly after the click, directly invoke the app's own opener — covering every
 * common name (openPlaid / openPlaidLink / initiateLink) and finally
 * _plaidHandler.open(). Idempotent: re-opening an already-open modal is a no-op.
 * Returns true once a visible modal is detected.
 */
async function ensurePlaidModalOpen(page, { timeoutMs = 8000 } = {}) {
  const isVisible = async () => {
    try {
      return await page.evaluate((sel) => {
        const ifr = document.querySelector(sel);
        if (!ifr) return false;
        const r = ifr.getBoundingClientRect();
        const cs = getComputedStyle(ifr);
        return r.width > 200 && r.height > 200 &&
          cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || '1') > 0.1;
      }, PLAID_IFRAME_SELECTOR);
    } catch (_) { return false; }
  };
  if (await isVisible()) return true;
  const opened = await page.evaluate(() => {
    const tryFns = ['openPlaid', 'openPlaidLink', 'initiateLink'];
    for (const fn of tryFns) {
      if (typeof window[fn] === 'function') { try { window[fn](); return fn + '()'; } catch (_) {} }
    }
    if (window._plaidHandler && typeof window._plaidHandler.open === 'function') {
      try { window._plaidHandler.open(); return 'handler.open()'; } catch (_) {}
    }
    return null;
  }).catch(() => null);
  if (opened) console.log(`  [Plaid Link] ensureModalOpen: modal not visible after click — directly invoked ${opened}`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isVisible()) { console.log('  [Plaid Link] ensureModalOpen: modal is visible'); return true; }
    await page.waitForTimeout(400);
  }
  console.warn('  [Plaid Link] ensureModalOpen: Plaid modal still not visible after direct open fallback');
  return false;
}

/**
 * Launch-step lock: during a live Plaid launch, prevent the host app from
 * advancing to a DIFFERENT step while the modal is being recorded. The app's
 * onSuccess (or a stray timer) can call goToStep(postLink) mid-flow, painting a
 * post-link insight/result screen over the modal — the recorder then captures
 * host UI instead of the modal and the integrity gate halts (Citi Auth+Identity,
 * 2026-06-23: identity-match screen advanced over the live Plaid Link modal).
 * This wraps goToStep so calls to the launch step pass through but calls to any
 * other step are CAPTURED (deferred), then flushed on release so the app advances
 * to the correct post-link step AFTER the modal recording completes. Generalizes
 * the CRA modal-hold's goToStep defer to classic Link + Layer/IDV. Idempotent.
 */
async function installPlaidLaunchLock(page, launchStepId) {
  if (!launchStepId) return;
  await page.evaluate((id) => {
    if (window.__plaidLaunchLock) return;
    const orig = window.goToStep;
    if (typeof orig !== 'function') return;
    window.__plaidLaunchOrigGoToStep = orig;
    window.__plaidLaunchLock = { launchStepId: id, pending: null };
    window.goToStep = function (target) {
      if (target === id) return orig.apply(window, arguments); // re-assert launch step is fine
      window.__plaidLaunchLock.pending = target;               // defer advancing away
      return undefined;
    };
  }, launchStepId).catch(() => {});
}

/** Release the launch-step lock and flush the deferred post-link advance (if any). */
async function releasePlaidLaunchLock(page) {
  await page.evaluate(() => {
    const lock = window.__plaidLaunchLock;
    const orig = window.__plaidLaunchOrigGoToStep;
    if (orig) window.goToStep = orig;
    delete window.__plaidLaunchLock;
    delete window.__plaidLaunchOrigGoToStep;
    if (lock && lock.pending && typeof orig === 'function') {
      try { orig.call(window, lock.pending); } catch (_) {}
    }
  }).catch(() => {});
}

/**
 * Click the primary CTA inside the live Plaid modal DETERMINISTICALLY via in-iframe
 * DOM .click() (scroll-free) — no vision. Returns the clicked label, or null if no
 * known CTA is visible. Makes Share/Confirm/Continue an explicit part of the
 * Layer/IDV nav path: the old vision-only loop was non-deterministic and stalled
 * ~30 min when the Anthropic vision API degraded (Credit Genie Layer+CRA hung on
 * the "Confirm the details to share with Acme Co." screen, 2026-06-23). Labels are
 * matched most-specific-first so "Continue with Plaid" wins over "Continue".
 */
async function clickModalCtaDeterministic(page, labels) {
  const plaidFr = page.frames().find(f => /plaid\.com/.test(f.url()));
  if (!plaidFr) return null;
  try {
    return await plaidFr.evaluate((wanted) => {
      const vis = (el) => el && el.offsetParent !== null && !el.disabled;
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const label of wanted) {
        const b = btns.find((x) => vis(x) && (x.textContent || '').trim().toLowerCase().includes(label.toLowerCase()));
        if (b) { b.click(); return label; }
      }
      return null;
    }, labels);
  } catch (_) { return null; }
}

async function executeLayerOrIdvLaunch(page, product) {
  const isIdv = product === 'idv';
  const ctaSelectors = isIdv
    ? ['[data-testid="idv-launch-btn"]', 'button[onclick*="launchIdv"]']
    : ['[data-testid="link-external-account-btn"]', 'button[onclick*="launchLayer"]'];
  const doneFlag = isIdv ? '_idvComplete' : '_plaidLinkComplete';
  console.log(`  [Plaid ${product}] launching live modal...`);

  // 1. Click the launch CTA (opens the modal via the app's launch handler).
  let clicked = false;
  for (const sel of ctaSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click({ force: true, timeout: 5000 });
        console.log(`  [Plaid ${product}] clicked launch CTA "${sel}"`);
        clicked = true;
        break;
      }
    } catch (_) {}
  }
  if (!clicked) console.warn(`  [Plaid ${product}] launch CTA not found — modal may open via on-load logic`);

  // 2. VERIFY the modal loads (the live Plaid iframe appears). PRIMARY GOAL.
  let modalLoaded = false;
  try {
    await plaidLinkWaitReady(page);
    modalLoaded = true;
    console.log(`  [Plaid ${product}] live modal loaded ✓`);
  } catch (e) {
    console.warn(`  [Plaid ${product}] modal did not load within timeout: ${e.message}`);
  }

  // 3. Modal navigation — DETERMINISTIC in-iframe CTA clicks first (scroll-free),
  //    vision only as a bounded last resort. The Layer/IDV modal screens
  //    (welcome → OTP → identity review → Share → CRA "Share consumer report"
  //    Confirm) are driven by clicking their known buttons, so Share/Confirm are
  //    always in the nav path and we never depend on (slow, degradation-prone)
  //    vision for the happy path. Breaks as soon as the modal closes.
  if (modalLoaded) {
    // Most-specific-first so "Continue with Plaid" wins over "Continue".
    const MODAL_CTAS = ['Continue with Plaid', 'Share', 'Confirm', 'Allow', 'Agree', 'Get started', 'Continue', 'Done', 'Submit'];
    const productPacer = getPacer().isHuman
      ? createPacer({
          style: 'human',
          seed: path.basename(OUT_DIR),
          profile: navProfile.resolveProfile({ product }),
          getScreenPacing: navProfile.getScreenPacing,
        })
      : null;
    const dwell = (fallbackMs) => productPacer ? productPacer.screenDwellMs({ fallbackMs }) : fallbackMs;
    let otpHandled = false;
    let visionFallbacks = 0;
    for (let i = 0; i < 8; i++) {
      const done = await page.evaluate((f) => window[f] === true, doneFlag).catch(() => false);
      if (done) break;
      if (!plaidModalPresent(page)) break;               // modal closed → flow complete
      // OTP screen → human-type it (≤1.5s pre-delay, scroll-free); once.
      if (!otpHandled && await enterModalOtpIfPresent(page, { label: product }).catch(() => false)) {
        otpHandled = true;
        await page.waitForTimeout(dwell(1200));
        continue;
      }
      // Deterministic CTA click (Share / Confirm / Continue …).
      const clickedLabel = await clickModalCtaDeterministic(page, MODAL_CTAS);
      if (clickedLabel) {
        console.log(`  [Plaid ${product}] clicked modal CTA "${clickedLabel}" (deterministic)`);
        await page.waitForTimeout(dwell(1500));
        continue;
      }
      // No known CTA visible — bounded vision fallback (≤2, retries:1) so a
      // degraded vision API can't stall the recording.
      if (USE_BROWSER_AGENT && visionFallbacks < 2) {
        visionFallbacks += 1;
        await agent.visionClick(
          page,
          'Inside the Plaid modal, click the primary action button to proceed ' +
          '(Continue, Continue with Plaid, Share, Confirm, Allow, Agree, Done). ' +
          'Click only inside the Plaid modal/sheet, not the host page behind it.',
          { retries: 1, waitAfterMs: 800 }
        ).catch(() => {});
      } else {
        await page.waitForTimeout(1000);
      }
    }
    if (productPacer) getPacer().absorb(productPacer);
  }

  // 4. Wait for the product completion flag (best effort — recording proceeds regardless).
  await page.waitForFunction((f) => window[f] === true, doneFlag, { timeout: isIdv ? 60000 : 45000 })
    .then(() => console.log(`  [Plaid ${product}] ${doneFlag} fired ✓`))
    .catch(() => console.warn(`  [Plaid ${product}] ${doneFlag} not set within timeout — advancing recording`));

  return { modalLoaded };
}

/**
 * Option B — CRA modal-hold (recorder-only; no app/build change).
 *
 * The CRA / Plaid Check (Passport) flow tears its modal down within ~7s of
 * opening: onSuccess/HANDOFF calls handler.destroy() + goToStep('generating-report'),
 * faster than the recorder can capture the modal — so the launch step recorded
 * pure host UI (Zip + Scrub.io CRA, 2026-06-13). This HOLDS the modal visible:
 * it defers BOTH the first post-link goToStep AND the Plaid handler teardown for
 * a hold window, marks institution-list-shown immediately (modal on screen, so
 * the post-process keep-window lands on the modal), dwells so the modal is
 * visibly recorded, marks confirm-clicked while still held, then RELEASES the
 * hold so the app advances normally. Recording-stage only; the app is untouched.
 * Disable with PLAID_CRA_MODAL_HOLD=false.
 */
async function executeCraModalHold(page) {
  const HOLD_MS = parseInt(process.env.PLAID_CRA_MODAL_HOLD_MS || '10000', 10);
  console.log(`  [Plaid Link] CRA modal-hold: defer teardown + post-link transition for up to ${HOLD_MS}ms so the modal is recorded`);
  // Install: defer the first post-link goToStep and the Plaid handler.destroy()
  // until released. Exposes __craReleaseHold() to flush + restore.
  await page.evaluate(() => {
    if (window.__craHoldInstalled) return;
    window.__craHoldInstalled = true;
    // The generic launch-step lock (installPlaidLaunchLock) already defers
    // goToStep during the launch; only wrap goToStep here when it ISN'T present,
    // so we don't double-wrap. The handler.destroy() defer below always applies
    // (it's CRA-specific and the generic lock doesn't do it).
    const genericLock = !!window.__plaidLaunchLock;
    const origGoTo = window.goToStep;
    let pendingStep = null;
    if (!genericLock) {
      window.goToStep = function (id) {
        if (pendingStep === null && typeof id === 'string') {
          // First post-link advance during the hold — queue it, don't run yet.
          pendingStep = id;
          return;
        }
        return origGoTo.apply(window, arguments);
      };
    }
    const patchDestroy = () => {
      const h = window._plaidHandler;
      if (h && typeof h.destroy === 'function' && !h.__holdPatched) {
        const od = h.destroy.bind(h);
        h.__holdPatched = true;
        h.__origDestroy = od;
        h.destroy = function () { h.__destroyRequested = true; };
      }
    };
    patchDestroy();
    const iv = setInterval(patchDestroy, 150);
    window.__craReleaseHold = function () {
      clearInterval(iv);
      if (!genericLock) {
        window.goToStep = origGoTo;
        if (pendingStep !== null) { try { origGoTo.call(window, pendingStep); } catch (_) {} }
      }
      const h = window._plaidHandler;
      if (h && h.__origDestroy) { try { h.destroy = h.__origDestroy; if (h.__destroyRequested) h.destroy(); } catch (_) {} }
    };
  });

  // Modal is open + visible → mark institution-list-shown NOW (early, accurate).
  markPlaidStep('institution-list-shown', page);

  // Light progression so multiple modal panes are recorded (best-effort; the
  // hold keeps the modal up regardless of whether these clicks land).
  const frame = page.frameLocator(PLAID_IFRAME_SELECTOR);
  const CTA = ['button:has-text("Continue")', 'button:has-text("Share")', 'button:has-text("Confirm")',
    'button:has-text("Allow")', 'button:has-text("Agree")', 'button[type="submit"]'];
  const deadline = Date.now() + HOLD_MS - 1500;
  let clicks = 0;
  while (Date.now() < deadline && clicks < 3) {
    const dwell = getPacer().isHuman ? getPacer().screenDwellMs({ fallbackMs: 2600 }) : 2600;
    await page.waitForTimeout(dwell);
    let clicked = false;
    for (const sel of CTA) {
      const b = frame.locator(sel).first();
      if (await b.isVisible({ timeout: 700 }).catch(() => false)) {
        await b.click({ force: true, timeout: 3000 }).catch(() => {});
        clicked = true; clicks += 1; break;
      }
    }
    if (clicks === 1 && plaidLinkTimings['confirm-clicked'] == null) markPlaidStep('confirm-clicked', page);
    if (!clicked && clicks === 0) { /* modal idle on one pane — keep dwelling, it's still visibly recorded */ }
  }
  if (plaidLinkTimings['confirm-clicked'] == null) markPlaidStep('confirm-clicked', page);

  // Release: flush the deferred teardown + transition so the app proceeds.
  await page.evaluate(() => { if (window.__craReleaseHold) window.__craReleaseHold(); }).catch(() => {});
  console.log(`  [Plaid Link] CRA modal-hold released (${clicks} progression click(s))`);
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

  // ── Scroll diagnostic (env-gated: PLAID_SCROLL_TRACE=1) ───────────────────
  // Polls host + Plaid-iframe scroll position every 150ms during the Link phase
  // and writes plaid-scroll-trace.json, to pinpoint the source of the mid-flow
  // "scroll up/down before selecting a bank" jitter. Fire-and-forget; self-stops
  // on _plaidLinkComplete or after 100s. Zero effect when the flag is unset.
  if (process.env.PLAID_SCROLL_TRACE === '1') {
    (async () => {
      const trace = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 100000) {
        const host = await page.evaluate(() => window.scrollY).catch(() => null);
        let frameY = null;
        try {
          const fr = page.frames().find(f => /plaid\.com/.test(f.url()));
          if (fr) frameY = await fr.evaluate(() => {
            const se = document.scrollingElement || document.documentElement;
            const sc = Array.from(document.querySelectorAll('*')).reduce((m, el) => Math.max(m, el.scrollTop || 0), 0);
            return { doc: se ? se.scrollTop : 0, maxInner: sc };
          }).catch(() => null);
        } catch (_) {}
        trace.push({ t: Date.now() - t0, host, frameY });
        if (await page.evaluate(() => window._plaidLinkComplete === true).catch(() => false)) break;
        await page.waitForTimeout(150);
      }
      try {
        const outDir = process.env.PIPELINE_RUN_DIR || OUT_DIR;
        require('fs').writeFileSync(require('path').join(outDir, 'plaid-scroll-trace.json'), JSON.stringify(trace, null, 1));
        console.log(`  [ScrollTrace] wrote ${trace.length} samples → plaid-scroll-trace.json`);
      } catch (_) {}
    })();
  }

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
        const embeddedMode = String(_plaidLinkMode || 'modal') === 'embedded';
        if (embeddedMode) {
          console.log('  [Plaid Link] Embedded mode detected — waiting for preloaded in-page widget...');
          const embeddedReady = await page.waitForFunction(
            () =>
              !!window.__embeddedLinkWidgetLoaded ||
              !!window.__plaidEmbeddedInstance ||
              !!document.querySelector('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"], iframe[src*="plaid.com"]'),
            null,
            { timeout: 20000 }
          ).then(() => true).catch(() => false);
          if (!embeddedReady) {
            console.warn('  [Plaid Link] Embedded widget not preloaded within 20s — trying launch CTA fallback');
            const fallbackClicked = await page.evaluate(() => {
              const btn = document.querySelector('[data-testid="link-external-account-btn"]');
              if (btn) {
                btn.click();
                return true;
              }
              return false;
            }).catch(() => false);
            if (fallbackClicked) {
              await page.waitForTimeout(1500);
            }
          }
        } else {
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
          // Guarantee the modal actually opened — vision can report a click that
          // missed the CTA, leaving the host pre-link card up and the modal closed.
          await ensurePlaidModalOpen(page);
        }

        // Also try to automate the real Plaid iframe in background (for token exchange).
        // This is optional — if it fails, the pre-populated sandbox data is used instead.
        // We only try if the iframe actually appeared.
        const iframePresent = await page.locator(
          PLAID_IFRAME_SELECTOR
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

        // ── Recipe-first executor (Layer 2) ────────────────────────────────────
        // If inputs/plaid-recipes/{flow}.json exists, drive Plaid Link via the
        // deterministic per-screen recipe. Vision-fallback is delegated via a
        // hook back to BrowserAgent so missed selectors still complete the
        // run and get appended to recipe.candidateSelectors[].
        const plaidRecipe = process.env.PLAID_RECIPES_DISABLED === 'true'
          ? null
          : loadPlaidRecipe(plaidLinkFlow);
        // CRA / Plaid Check: the modal tears down ~7s after opening, faster than
        // capture. Hold it visible (Option B, recorder-only) instead of the CSS
        // waterfall whose selectors miss the varying CRA/Passport panes and which
        // mis-timed the markers. Disable with PLAID_CRA_MODAL_HOLD=false.
        //
        // Detect a CRA launch ROBUSTLY: prefer the explicit plaidSandboxConfig
        // flow, but fall back to the launch step id (e.g. "cra-link-launch",
        // "plaid-cra-link") so the hold still fires when the script generator
        // didn't stamp plaidLinkFlow:"cra". Scrub.io (2026-06-15) regressed exactly
        // this way — plaidLinkFlow defaulted to "standard" → hold skipped → modal
        // not captured → QA LIVE-PLAID-NO-MODAL (35). detectLaunchProduct() never
        // returns 'cra', so the step id is the reliable signal here.
        const isCraLaunch = plaidLinkFlow === 'cra'
          || /\bcra\b|cra[-_]link|consumer[-_ ]?report|credit[-_ ]?profile|check[-_ ]?report/i.test(_currentStepId || '');
        if (isCraLaunch && process.env.PLAID_CRA_MODAL_HOLD !== 'false') {
          if (plaidLinkFlow !== 'cra') {
            console.log(`  [Plaid Link] CRA launch detected from step id "${_currentStepId}" (plaidLinkFlow="${plaidLinkFlow}") — engaging modal-hold`);
          }
          try {
            await executeCraModalHold(page);
          } catch (err) {
            console.warn(`  [Plaid Link] CRA modal-hold error (non-fatal): ${err.message}`);
          }
        } else if (plaidRecipe) {
          try {
            console.log(`  [Plaid Link] Using recipe: ${plaidLinkFlow} (${plaidRecipe.screens.length} screens, ~${(plaidRecipe.totalEstimatedDwellMs || 0) / 1000}s budgeted)`);
            await executePlaidRecipe({
              page,
              recipe: plaidRecipe,
              plaidIframeSelector: PLAID_IFRAME_SELECTOR,
              markPlaidStep,
              runDir: process.env.PIPELINE_RUN_DIR || null,
              // Human style: profile pacing overrides recipe dwell constants
              // (before = pre-action hesitation, after = read/settle dwell).
              // fast → null → raw recipe constants, unchanged.
              // Per operator request (2026-06-17, retrimmed 2026-06-24): the phone
              // number is typed AS SOON AS Plaid Link loads — no "read the screen"
              // hesitation before it (PLAID_PHONE_BEFORE_MS, default 0) — and the OTP
              // is entered after a short ~0.5s "receive the code" pause once the phone
              // is submitted (PLAID_OTP_BEFORE_MS, default 500 — ~1s sooner than before).
              // Typing itself stays at human keystroke speed via the pacer's typeInto.
              pacingResolver: getPacer().isHuman
                ? ({ screen, phase, defaultMs }) => {
                    const id = String((screen && screen.id) || '').toLowerCase();
                    if (phase === 'before') {
                      if (/phone/.test(id)) {
                        return parseInt(process.env.PLAID_PHONE_BEFORE_MS || '0', 10);
                      }
                      if (/\botp\b|one[-\s]?time|verif|\bcode\b/.test(id)) {
                        // Trimmed 1500→500ms (operator 2026-06-24: OTP entry starts ~1s sooner).
                        return parseInt(process.env.PLAID_OTP_BEFORE_MS || '500', 10);
                      }
                      return Math.max(defaultMs, getPacer().hesitateMs('primary', screen.id));
                    }
                    return getPacer().screenDwellMs({ screenId: screen.id, fallbackMs: defaultMs });
                  }
                : null,
              hooks: {
                visionFallback: async ({ page: p, screenId, actionType, hint }) => {
                  if (actionType !== 'click') return null;
                  const winner = await agent.visionClick(p, hint, { retries: 2, waitAfterMs: 800 });
                  return winner ? { winnerSelector: '(vision)' } : null;
                },
              },
            });
            await plaidLinkDismissSaveScreen(page);
            console.log('  [Plaid Link] Recipe automation complete');
          } catch (err) {
            console.warn(`  [Plaid Link] Recipe execution error (non-fatal): ${err.message} — falling back to legacy path on subsequent recordings`);
          }
        } else if (SMART_PLAID_AGENT) {
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
          const frame = page.frameLocator(PLAID_IFRAME_SELECTOR);

          // ── 1. Phone entry screen (Remember Me) ─────────────────────────────
          // Plaid shows a phone number input as the first screen.
          // Strategy: try to fill the phone number (which auto-submits per Plaid sandbox
          // behaviour). If no phone input is visible within 5s, skip via the text link.
          console.log('  [Plaid Link] Handling phone screen...');
          const phoneInput = frame.locator('input[type="tel"], input[name="phone"], input[placeholder*="phone" i], input[placeholder*="Phone" i]').first();
          const phoneVisible = await phoneInput.isVisible({ timeout: 5000 }).catch(() => false);
          if (phoneVisible) {
            // Hold the initial Plaid Link screen briefly before typing the phone.
            // Trimmed 3000→1000ms (operator 2026-06-24: phone entry should start ~2s
            // sooner so it overlaps the modal-load beat rather than dead-airing).
            // Override with PLAID_PHONE_HOLD_MS.
            await page.waitForTimeout(parseInt(process.env.PLAID_PHONE_HOLD_MS || '1000', 10));
            const phone = _sandboxConfig?.phone || '+14155550011';
            await recordPlaidInteraction(page, phoneInput, 'phone-entry');
            await getPacer().humanType(phoneInput, phone, { kind: 'numeric', screenId: 'phone-entry' });
            if (getPacer().isHuman) {
              // Keystroke entry can be mangled by the input mask (and does not
              // trigger Plaid's fill-based auto-submit). Verify the digits; on
              // mismatch fall back to fill(), then click Continue explicitly.
              const wantDigits = phone.replace(/\D/g, '').slice(-10);
              const gotDigits = (await phoneInput.inputValue().catch(() => '')).replace(/\D/g, '');
              if (!gotDigits.endsWith(wantDigits)) {
                console.log('  [Plaid Link] human-typed phone mangled by mask — falling back to fill()');
                await phoneInput.fill(phone).catch(() => {});
              }
              const phoneCont = frame.locator('button[type="submit"], button:has-text("Continue")').first();
              if (await phoneCont.isVisible({ timeout: 2000 }).catch(() => false)) {
                await getPacer().hesitate(page, 'primary', 'phone-entry');
                await phoneCont.click({ force: true, timeout: 3000 }).catch(() => {});
              }
            }
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
              // Guard: 'input[type=tel]' also matches the PHONE input. If the
              // candidate already holds ≥7 digits it's the filled phone field
              // (pane didn't advance) — not an OTP box. Try the next selector.
              const existing = (await otpInput.inputValue().catch(() => '')).replace(/\D/g, '');
              if (existing.length >= 7) {
                console.log(`  [Plaid Link] "${otpSel}" matches the filled phone input — not an OTP box, skipping`);
                continue;
              }
              markPlaidStep('otp-screen', page);
              // Sandbox OTP is length-specific and a FIXED Plaid constant: the
              // 6-digit phone-verification code is 123456, the 4-digit device-MFA
              // code is 1234. An LLM-authored plaidSandboxConfig.otp is unreliable
              // (YNAB 2026-06-24: "1234" sent to a 6-digit phone screen → rejected,
              // link silently failed). Pick by the input's maxlength; honor a config
              // value ONLY when it matches that length; otherwise use the canonical
              // sandbox code (default 123456). Never send the wrong-length code.
              const otpMax = parseInt((await otpInput.getAttribute('maxlength').catch(() => '')) || '0', 10);
              const otpCfg = String(_sandboxConfig?.otp || '');
              const otp = otpMax === 4
                ? (otpCfg.length === 4 ? otpCfg : '1234')
                : (otpCfg.length === 6 ? otpCfg : '123456');
              if (otpCfg && otpCfg !== otp) {
                console.log(`  [Plaid Link] OTP corrected: config "${otpCfg}" != ${otpMax || 6}-digit field → using sandbox ${otp}`);
              }
              // Requirement: simulate human typing (~1–2s) + 1s pause.
              await otpInput.click({ force: true, timeout: 3000 }).catch(() => {});
              await recordPlaidInteraction(page, otpInput, 'otp-screen');
              const typed = await getPacer().humanType(otpInput, String(otp), {
                kind: 'numeric', screenId: 'otp-screen', fastDelayMs: 220,
              }).then(() => true).catch(() => false);
              if (!typed) await otpInput.fill(String(otp)).catch(() => {});
              await page.waitForTimeout(1000);
              markPlaidStep('otp-filled');
              // Submit SCROLL-FREE. The OTP input is already focused from typing,
              // so press Enter (no scroll). Clicking the submit button via
              // frameLocator runs scrollIntoViewIfNeeded, bouncing the modal's
              // inner scroll container 0↔80px — the visible "scroll up/down before
              // the bank list" (2026-06-17, trace-confirmed in plaid-scroll-trace.json).
              await otpInput.press('Enter', { timeout: 1500 }).catch(() => {});
              await page.waitForTimeout(450);
              // If the OTP pane is still up, submit via in-iframe DOM .click()
              // (still scroll-free); frameLocator click only as a last resort.
              const stillOtp = await otpInput.isVisible({ timeout: 500 }).catch(() => false);
              if (stillOtp) {
                const plaidFr = page.frames().find(f => /plaid\.com/.test(f.url()));
                let domSubmitted = false;
                if (plaidFr) {
                  domSubmitted = await plaidFr.evaluate(() => {
                    const vis = (el) => el && el.offsetParent !== null;
                    const btns = Array.from(document.querySelectorAll('button'));
                    for (const t of ['Verify', 'Confirm', 'Continue']) {
                      const b = btns.find((x) => vis(x) && (x.textContent || '').trim().includes(t));
                      if (b) { b.click(); return true; }
                    }
                    const sub = document.querySelector('button[type="submit"]');
                    if (vis(sub)) { sub.click(); return true; }
                    return false;
                  }).catch(() => false);
                }
                if (!domSubmitted) {
                  const btn = frame.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Verify"), button:has-text("Confirm")').first();
                  if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                    await btn.click({ timeout: 5000 }).catch(() => {});
                  }
                }
              }
              markPlaidStep('otp-submitted', page);
              otpSubmittedWallMs = Date.now();
              await page.waitForTimeout(250);
              otpDone = true;
              console.log(`  [Plaid Link] OTP submitted scroll-free (Enter${stillOtp ? ' + DOM-click fallback' : ''})`);
              break;
            }
          }
          if (!otpDone) console.log('  [Plaid Link] No OTP screen found');

          // ── 2b. Saved institution selection (Remember Me returning-user) ────
          // Tartan Bank is ALWAYS at the top of the sandbox Remember Me list and is
          // non-OAuth — `plaidSelectSavedInstitution` clicks it directly per
          // CLAUDE.md's "Tartan Bank at top, no scroll, no search" rule.
          const selectedSavedInstitution = await plaidSelectSavedInstitution(page, otpSubmittedWallMs);
          // Only treat the flow as "remember-me complete" (skip search/credentials) when a
          // NON-OAuth saved bank was actually selected. If the saved list had only OAuth
          // banks, plaidSelectSavedInstitution returns null — we must NOT skip search;
          // instead click "connect a different institution" and search the configured
          // non-OAuth bank so the link completes (YNAB returning-user fix, 2026-06-24).
          let rememberMeActive = !!selectedSavedInstitution;
          if (selectedSavedInstitution) {
            console.log(
              `  [Plaid Link] Remember Me detected at runtime — saved institution "${selectedSavedInstitution}" selected; skipping consent/search/credentials.`
            );
          } else if (otpDone) {
            // A returning-user OTP happened but no automatable saved bank — switch to
            // searching the configured non-OAuth institution (then standard search runs below).
            const switched = await plaidConnectDifferentInstitution(page).catch(() => false);
            console.log(`  [Plaid Link] Returning-user with no non-OAuth saved bank → ${switched ? 'opened search for' : 'falling through to'} the configured institution.`);
          }

          // ── 3. Consent / "Get started" screen ──────────────────────────────
          // Skip consent when Remember Me flow is active — the SDK jumps directly
          // from saved-institution selection to account selection.
          if (!rememberMeActive) {
            console.log('  [Plaid Link] Handling consent screen...');
            for (const label of ['Get started', 'I agree', 'Agree', 'Continue', 'Next']) {
              const btn = frame.getByRole('button', { name: label, exact: false }).first();
              if (await btn.isVisible({ timeout: 4000 }).catch(() => false)) {
                await getPacer().hesitate(page, 'consent', 'consent');
                await recordPlaidInteraction(page, btn, 'consent');
                await btn.click();
                await plaidWaitForTransition(page, 8000, PLAID_SCREEN_DWELL_MS);
                console.log(`  [Plaid Link] Consent: clicked "${label}"`);
                break;
              }
            }
          }

          // ── 4–7: Institution search + credentials (standard flow only) ────────
          // Remember Me flow skips these — the SDK goes directly from saved institution
          // selection to account selection without showing search or credentials screens.
          if (!rememberMeActive) {
            // ── 4. Institution search ──────────────────────────────────────────
            console.log(`  [Plaid Link] Searching for institution: ${PLAID_SANDBOX_INSTITUTION}...`);
            let searchDone = false;
            // Embedded widget content renders inside its iframe after the host page loads it,
            // so give it a longer first-check timeout (20s) vs modal mode (5s).
            const searchFirstTimeout = embeddedMode ? 20000 : 5000;
            const searchFallbackTimeout = embeddedMode ? 10000 : 5000;
            // Extended selector list covers both modal (type=search) and embedded (type=text with search placeholder)
            const searchSelectors = [
              'input[placeholder*="Search" i]',
              'input[placeholder*="bank" i]',
              'input[type="search"]',
              'input[name="search"]',
              'input[aria-label*="Search" i]',
              'input[role="searchbox"]',
              'input[type="text"]',
            ];
            for (let si = 0; si < searchSelectors.length; si++) {
              const sel = searchSelectors[si];
              const timeout = si === 0 ? searchFirstTimeout : searchFallbackTimeout;
              const input = frame.locator(sel).first();
              if (await input.isVisible({ timeout }).catch(() => false)) {
                await getPacer().humanType(input, PLAID_SANDBOX_INSTITUTION, { kind: 'text', screenId: 'institution-search' });
                await plaidWaitForTransition(page, 5000, PLAID_SCREEN_DWELL_MS);
                console.log(`  [Plaid Link] Institution search via: ${sel} (timeout=${timeout}ms)`);
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
              await getPacer().scanList(page, 6, 'institution-search');
              await recordPlaidInteraction(page, byText, 'institution-search');
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
                  institutionSelected = true;
                  break;
                }
              }
            }
            if (!institutionSelected) {
              for (const sel of [`button:has-text("${PLAID_SANDBOX_INSTITUTION}")`, 'button:has(img)', 'button:has-text("Chase")', 'button:has-text("Bank of America")', 'button:has-text("Wells Fargo")', 'button:has-text("Citi")', '[aria-label*="institution" i]']) {
                const el = frame.locator(sel).first();
                if (await el.isVisible({ timeout: 2500 }).catch(() => false)) {
                  await el.click({ force: true }).catch(() => {});
                  await plaidWaitForTransition(page, 8000, PLAID_SCREEN_DWELL_MS);
                  console.log(`  [Plaid Link] Institution selected via embedded tile selector: ${sel}`);
                  institutionSelected = true;
                  break;
                }
              }
            }
            if (!institutionSelected && USE_BROWSER_AGENT) {
              const visionSelected = await agent.visionClick(page,
                `Inside the Plaid embedded widget, find the search input (it may say "Search for your bank" or similar), type "${PLAID_SANDBOX_INSTITUTION}", then click the "${PLAID_SANDBOX_INSTITUTION}" institution tile/result that appears.`,
                { retries: 3, waitAfterMs: 1200 }
              );
              if (visionSelected) {
                await plaidWaitForTransition(page, 8000, PLAID_SCREEN_DWELL_MS);
                console.log('  [Plaid Link] Institution selected via vision fallback');
                institutionSelected = true;
              }
            }
            if (!institutionSelected) {
              console.warn('  [Plaid Link] Institution tile not selected — flow may stall on institution picker');
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
              await getPacer().humanType(el, creds.username || PLAID_SANDBOX_USERNAME, { kind: 'text', screenId: 'credentials' });
              console.log(`  [Plaid Link] Username filled via: ${sel}`);
              break;
            }
          }
          await page.waitForTimeout(400);
          for (const sel of ['input[name="password"]', 'input[type="password"]']) {
            const el = frame.locator(sel).first();
            if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
              await getPacer().humanType(el, creds.password || PLAID_SANDBOX_PASSWORD, { kind: 'password', screenId: 'credentials' });
              console.log(`  [Plaid Link] Password filled via: ${sel}`);
              break;
            }
          }
          await page.waitForTimeout(400);
          for (const sel of ['button[type="submit"]', 'button:has-text("Submit")', 'button:has-text("Log in")', 'button:has-text("Sign in")']) {
            const btn = frame.locator(sel).first();
            if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await getPacer().hesitate(page, 'primary', 'credentials');
              await recordPlaidInteraction(page, btn, 'credentials');
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

          } // end if (!rememberMeActive) — institution search + credentials block

          // ── 9. Account selection ─────────────────────────────────────────────
          console.log('  [Plaid Link] Selecting account...');
          for (const sel of ['li[role="listitem"]', '[role="radio"]', 'input[type="radio"]']) {
            const el = frame.locator(sel).first();
            if (await el.isVisible({ timeout: 6000 }).catch(() => false)) {
              await getPacer().scanList(page, 3, 'account-select');
              await recordPlaidInteraction(page, el, 'account-select');
              await el.click({ force: true });
              console.log(`  [Plaid Link] Account row selected via: ${sel}`);
              await page.waitForTimeout(1000);
              break;
            }
          }
          for (const sel of ['button:has-text("Continue")', 'button:has-text("Confirm")', 'button:has-text("Link account")', 'button:has-text("Share")', 'button[type="submit"]']) {
            const btn = frame.locator(sel).first();
            if (await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
              await getPacer().hesitate(page, 'consent', 'confirm');
              await recordPlaidInteraction(page, btn, 'confirm');
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
        // Defensive: if the vision-fallback path (or forced-completion path)
        // reached Link success without firing confirm-clicked, emit a synthetic
        // marker just before link-complete so post-process-recording.js has
        // both anchors for Range 3 keep-range. Without this, modal flows with
        // missing markers would be collapsed to a tiny institution-list window.
        if (plaidLinkTimings['confirm-clicked'] == null && recordingStartMs) {
          const nowS = (Date.now() - recordingStartMs) / 1000;
          plaidLinkTimings['confirm-clicked'] = Math.max(0, nowS - 0.25);
          console.log(`  [PlaidTiming] confirm-clicked (synthetic) = ${plaidLinkTimings['confirm-clicked'].toFixed(2)}s`);
        }
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
        const frame = page.frameLocator(PLAID_IFRAME_SELECTOR);

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
              // Guard: a candidate already holding ≥7 digits is the filled
              // phone field, not an OTP box (see vision-path note).
              const cssExisting = (await otpEl.inputValue().catch(() => '')).replace(/\D/g, '');
              if (cssExisting.length >= 7) {
                console.log(`  [Plaid Link] CSS: "${otpSel}" matches the filled phone input — skipping`);
                continue;
              }
              const otp = _sandboxConfig?.otp || '123456';
              // Requirement: simulate human typing (~1–2s) + 1s pause.
              await otpEl.click({ force: true, timeout: 3000 }).catch(() => {});
              const typed = await getPacer().humanType(otpEl, String(otp), {
                kind: 'numeric', screenId: 'otp-screen', fastDelayMs: 220,
              }).then(() => true).catch(() => false);
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

        const cssSavedInstitution = await plaidSelectSavedInstitution(page, cssOtpSubmittedWallMs);
        const cssRememberMeActive = !!cssSavedInstitution;
        if (cssSavedInstitution) {
          console.log(
            `  [Plaid Link] CSS: Remember Me detected at runtime — saved institution "${cssSavedInstitution}" selected; skipping consent/search/credentials.`
          );
        }

        // ── 3. Consent / "Get started" screen ─────────────────────────────────
        if (!cssRememberMeActive) {
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
          for (const sel of ['input[placeholder*="Search" i]', 'input[placeholder*="bank" i]', 'input[type="search"]', 'input[name="search"]', 'input[role="searchbox"]', 'input[type="text"]']) {
            const input = frame.locator(sel).first();
            if (await input.isVisible({ timeout: sel === 'input[type="text"]' ? 8000 : 5000 }).catch(() => false)) {
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
        } // end if (!cssRememberMeActive) — CSS-path institution search + credentials block

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

  // Defense in depth: if two consecutive markStep() calls emitted the same
  // step id (e.g., playwright-script had a duplicate row, or the recorder
  // re-entered the Plaid launch phase after an iframe destroy), merge the
  // adjacent windows so step-timing.json contains one window per step.
  // Without this, voiceover.js generates a duplicate clip per step id and the
  // final video plays the same narration twice — observed on Banner run where
  // plaid-link-launch duplicated ~41s of content at the ~42s mark.
  if (stepTimings.length > 1) {
    const mergedTimings = [];
    const mergedIds = [];
    for (const entry of stepTimings) {
      const prev = mergedTimings[mergedTimings.length - 1];
      if (prev && prev.id === entry.id) {
        // Absorb this marker into the prior window; keep the earlier startMs.
        mergedIds.push(entry.id);
        continue;
      }
      mergedTimings.push(entry);
    }
    if (mergedIds.length > 0) {
      console.warn(
        `[Record] Merged ${mergedIds.length} duplicate step-timing marker(s) ` +
        `for step id(s): ${Array.from(new Set(mergedIds)).join(', ')}. ` +
        `(Upstream playwright-script likely had duplicate entries.)`
      );
      stepTimings.length = 0;
      stepTimings.push(...mergedTimings);
    }
  }

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

  // Human-pacing manifest (read by post-process cut presets + nav feedback loop)
  if (_pacer && _pacer.isHuman) {
    const manifestFile = path.join(OUT_DIR, 'plaid-pacing-manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(_pacer.manifest(), null, 2));
    console.log(`[Record] Wrote plaid-pacing-manifest.json (+${Math.round(_pacer.dwellBudgetMs() / 1000)}s human dwell)`);
  }

  // Iframe-relative interaction coords (future pointer-overlay phase — data only)
  if (plaidInteractions.length > 0) {
    fs.writeFileSync(path.join(OUT_DIR, 'plaid-interactions.json'), JSON.stringify(plaidInteractions, null, 2));
    console.log(`[Record] Wrote plaid-interactions.json (${plaidInteractions.length} interactions)`);
  }

  // Continuous-learning loop: fold observed transitions back into the nav profile.
  if (plaidKeys.length > 0) {
    try {
      const { recordNavFeedback } = require('../utils/plaid-nav-feedback');
      recordNavFeedback({
        runDir: OUT_DIR,
        completed: plaidLinkTimings['link-complete'] != null,
      });
    } catch (err) {
      console.warn(`[Record] nav-feedback skipped: ${err.message}`);
    }
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
  const timeoutMs = Math.max(30000, RECORD_POSTPROCESS_TIMEOUT_MS);

  // Primary attempt uses high-quality VP9 (crf 18). On timeout we fall back to
  // a faster VP9 preset (crf 24, cpu-used 6) and record the error to disk so
  // post-hoc audits can see the ETIMEDOUT without tailing pipeline logs.
  const attempts = [
    {
      label: 'primary (crf 18, cpu-used 4)',
      cmd:
        `ffmpeg -i "${rawPath}" ` +
        `-vf fps=${TARGET_FPS} ` +
        `-c:v libvpx-vp9 -crf 18 -b:v 0 -cpu-used 4 ` +
        `-y "${tmpOut}"`,
    },
    {
      label: 'fallback (crf 24, cpu-used 6)',
      cmd:
        `ffmpeg -i "${rawPath}" ` +
        `-vf fps=${TARGET_FPS} ` +
        `-c:v libvpx-vp9 -crf 24 -b:v 0 -cpu-used 6 ` +
        `-y "${tmpOut}"`,
    },
  ];

  const maxAttempts = Math.min(attempts.length, 1 + Math.max(0, RECORD_POSTPROCESS_MAX_RETRIES));
  const errors = [];
  for (let i = 0; i < maxAttempts; i++) {
    const attempt = attempts[i];
    try {
      if (i > 0) {
        console.log(`[Record] Post-processing: retrying with ${attempt.label}...`);
      }
      execSync(attempt.cmd, { stdio: 'pipe', timeout: timeoutMs });

      if (fs.existsSync(tmpOut)) {
        fs.renameSync(tmpOut, outPath);
        const rawSize = Math.round(fs.statSync(rawPath).size / 1024);
        const outSize = Math.round(fs.statSync(outPath).size / 1024);
        console.log(`[Record] Post-processing complete: ${rawSize}KB → ${outSize}KB at ${TARGET_FPS}fps (${attempt.label})`);
        return true;
      }
    } catch (err) {
      errors.push(`${attempt.label}: ${err.code || err.message}`);
      console.warn(`[Record] Post-processing attempt ${i + 1}/${maxAttempts} failed: ${err.message}`);
      try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (_) {}
    }
  }

  console.warn(`[Record] Post-processing failed after ${maxAttempts} attempt(s) — using raw recording.`);
  // Persist the error trail so downstream QA can surface it without tailing logs.
  try {
    const outDir = path.dirname(outPath);
    const errReport = {
      status: 'fallback-to-raw',
      raw: rawPath,
      target: outPath,
      attempts: maxAttempts,
      errors,
      timeoutMs,
      at: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(outDir, 'record-postprocess-error.json'),
      JSON.stringify(errReport, null, 2),
      'utf8'
    );
  } catch (_) {}
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
  _plaidLinkMode = String(demoScript?.plaidLinkMode || '').toLowerCase() === 'embedded' ? 'embedded' : 'modal';

  fs.mkdirSync(OUT_DIR,           { recursive: true });
  fs.mkdirSync(RECORDING_TMP_DIR, { recursive: true });

  const appServer = await startServer(3737, SCRATCH_APP_DIR);
  console.log(`[Record] App server: ${appServer.url} (serving ${SCRATCH_APP_DIR})`);
  console.log(`[Record] MANUAL_RECORD mode — opening visible browser`);

  // Non-headless browser so the human can interact
  // Match automated recording: 1440×900 CSS viewport + deviceScaleFactor:2 → 2880×1800 physical
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    recordVideo: {
      dir:  RECORDING_TMP_DIR,
      size: { width: 2880, height: 1800 },
    },
    viewport:          { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  attachConsoleCapture(page);

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

  // Record-stale guards. The recording captures the host app's rendered
  // HTML at this moment in time, so if the HTML carries unresolved
  // placeholders (post-slides hasn't filled them yet), the recording will
  // ship a broken slide. Refuse to start with a clear recovery hint.
  const SCRATCH_HTML = path.join(OUT_DIR, 'scratch-app', 'index.html');
  if (fs.existsSync(SCRATCH_HTML)) {
    try {
      const html = fs.readFileSync(SCRATCH_HTML, 'utf8');
      if (/\bdata-slide-pending\s*=\s*"true"/i.test(html)) {
        console.error(
          '[Record] Refusing to start — scratch-app/index.html contains data-slide-pending="true" ' +
          'placeholders that post-slides has not filled. Run "pipe stage post-slides" or "pipe slide-fix" ' +
          'to insert the missing slides before recording.'
        );
        process.exit(1);
      }
    } catch (_) { /* fall through and let normal flow surface the error */ }
  }

  const playwrightScript = JSON.parse(fs.readFileSync(PLAYWRIGHT_SCRIPT, 'utf8'));
  const demoScript       = JSON.parse(fs.readFileSync(DEMO_SCRIPT_FILE, 'utf8'));
  _plaidLinkMode = String(demoScript?.plaidLinkMode || '').toLowerCase() === 'embedded' ? 'embedded' : 'modal';

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
  // When the demo-script declares ANY explicit plaidPhase metadata it is
  // AUTHORITATIVE — disable the regex/click-target phase heuristics entirely
  // (2026-06-12). The fallbacks exist only for legacy scripts without
  // plaidPhase fields; with metadata present they HIJACK host steps whose ids
  // or targets merely sound Plaid-ish: Ascend "application-consent" matched a
  // link-phase pattern → live-override path skipped the step's dwell+click
  // (1s window, frames stuck on the prior slide, QA 10/100); Gringo
  // "host-link-bank" was similarly at risk via the click-target launch regex.
  const hasExplicitPlaidPhases = Object.keys(plaidPhaseMap).length > 0;
  const phaseForStep = (id) => plaidPhaseMap[id] || (hasExplicitPlaidPhases ? null : matchPlaidLinkPhase(id));

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
      // Mark the next step's recording boundary at the overrun moment so step-
      // timing.json reflects what's actually visible on screen. Without this,
      // the current step's recording window stretches until the iterator's
      // own action returns — which can be 30+ seconds while the Plaid Link
      // modal renders over the host page or the click selector misses. The
      // result is exactly the "frozen at step 2" pattern: scene-match-check
      // sees one step's narration playing while the previous step's content
      // is still being captured. Force the mark NOW so downstream stages
      // (measure-sync-debt, scene-match-check) see correct boundaries.
      try {
        markStep(nextStepId);
      } catch (_) { /* best-effort — recorder's own loop will mark again if it gets there */ }
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
    // Initialize the human-pacing engine with the flow's nav profile.
    // Default 'human'; PLAID_NAV_STYLE=fast reproduces pre-pacer behavior exactly.
    const navStyle = process.env.PLAID_NAV_STYLE || PLAID_NAV_STYLE_DEFAULT;
    const profileForFlow = navProfile.resolveProfile({
      flowType,
      embedded: _plaidLinkMode === 'embedded',
    });
    _pacer = createPacer({
      style: navStyle,
      seed: path.basename(OUT_DIR),
      profile: profileForFlow,
      getScreenPacing: navProfile.getScreenPacing,
    });
    console.log(`[Record] Nav pacing: style=${navStyle}${profileForFlow ? `, profile=${profileForFlow.experience}` : ' (no profile — engine defaults)'}`);
    agent.setNavPacer(_pacer); // vision-driven typing inherits the cadence
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
  attachConsoleCapture(page);

  // Navigate to the locally-served app
  console.log(`[Record] Navigating to ${appServer.url}...`);
  await page.goto(appServer.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // WRONG-APP GUARD: confirm we actually loaded the generated demo app, not some
  // other server squatting on the port (e.g. a dashboard left running on 3737 —
  // which silently recorded the dashboard UI: goToStep missing, every click
  // timed out, modal never opened, QA 10/100; Ascend/Gringo 2026-06-30). The
  // real app always exposes window.goToStep and at least one [data-testid^="step-"].
  {
    const looksLikeApp = await page.evaluate(() =>
      typeof window.goToStep === 'function' &&
      !!document.querySelector('[data-testid^="step-"]')
    ).catch(() => false);
    if (!looksLikeApp) {
      const title = await page.title().catch(() => '');
      throw new Error(
        `WRONG_APP_AT_RECORD_URL: ${appServer.url} did not serve the demo app ` +
        `(window.goToStep / [data-testid^="step-"] missing; page title="${title}"). ` +
        `Almost always a PORT COLLISION — another server (often a dashboard) is on ` +
        `that port. Free it (lsof -iTCP:<port> -sTCP:LISTEN) and re-record.`
      );
    }
  }

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
  function entryStartsWithGoToStep(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.action === 'goToStep') return true;
    if (Array.isArray(entry.actions) && entry.actions.length > 0) {
      const first = entry.actions[0];
      return first && first.type === 'evalStep' && /goToStep\(/.test(String(first.expression || ''));
    }
    return false;
  }
  function entryIsPlaidLaunch(entry, stepId, idx) {
    if (!PLAID_LINK_LIVE) return false;
    const phase = phaseForStep(stepId);
    if (phase === 'launch') return true;
    if (hasExplicitPlaidPhases) return false; // metadata authoritative — no target-regex guessing
    if (
      entry &&
      entry.action === 'click' &&
      (entry.target || '').match(/link[-_]external[-_]account|connect[-_]bank|open[-_]link|link[-_]account[-_]btn|btn[-_]link|link[-_]bank|start[-_]link|initiate[-_]link|plaid[-_]link[-_]btn/i)
    ) {
      return true;
    }
    const prev = idx > 0 ? playwrightScript.steps[idx - 1] : null;
    return !!(
      prev &&
      prev.action === 'click' &&
      (prev.target || '').match(/link[-_]external[-_]account|connect[-_]bank|open[-_]link|link[-_]account[-_]btn|btn[-_]link|link[-_]bank|start[-_]link|initiate[-_]link|plaid[-_]link[-_]btn/i)
    );
  }

  for (let _si = 0; _si < playwrightScript.steps.length; _si++) {
    const stepEntry = playwrightScript.steps[_si];
    const stepId = stepEntry.stepId || stepEntry.id;
    const label  = stepLabelMap[stepId] || stepId;
    _currentStepId = stepId;   // track for click-coord capture in executeAction
    const prevEntry = _si > 0 ? playwrightScript.steps[_si - 1] : null;
    const prevStepId = prevEntry ? (prevEntry.stepId || prevEntry.id) : null;
    const isPostPlaidBoundary = entryIsPlaidLaunch(prevEntry, prevStepId, _si - 1);
    const shouldDeferMark = RECORD_TRANSITION_SAFE_TIMING && entryStartsWithGoToStep(stepEntry);
    let didDeferredMark = false;

    // Arm overrun watchdog for this step
    const _nextEntry = playwrightScript.steps[_si + 1];
    const _nextStepId = _nextEntry ? (_nextEntry.stepId || _nextEntry.id) : null;
    // _isLaunch: also check plaidPhaseMap (explicit "plaidPhase":"launch" in demo-script.json)
    // and the click-target regex so the overrun timer is never armed for Plaid launch steps
    // regardless of step ID naming (e.g. "chime-link-entry" wouldn't match the regex alone).
    const _clickIsLaunch = PLAID_LINK_LIVE && !hasExplicitPlaidPhases &&
      !plaidPhaseMap[stepId] && !matchPlaidLinkPhase(stepId) &&
      stepEntry.action === 'click' &&
      (stepEntry.target || '').match(/link[-_]external[-_]account|connect[-_]bank|open[-_]link|link[-_]account[-_]btn|btn[-_]link|link[-_]bank|start[-_]link|initiate[-_]link|plaid[-_]link[-_]btn/i);
    const _isLaunch = PLAID_LINK_LIVE && (
      phaseForStep(stepId) === 'launch' ||
      !!_clickIsLaunch
    );
    armStepOverrun(page, stepId, stepEntry.waitMs, _nextStepId, _isLaunch);

    if (!shouldDeferMark) {
      if (isPostPlaidBoundary && POST_LINK_STEP_BOUNDARY_GUARD_MS > 0) {
        await page.waitForTimeout(POST_LINK_STEP_BOUNDARY_GUARD_MS);
      }
      markStep(stepId, label);
    }

    // ── Live Plaid Link override ──────────────────────────────────────────
    // When PLAID_LINK_LIVE=true, check if this step matches a Plaid Link
    // flow phase. If so, first run the standard goToStep action (to advance
    // the app UI), then execute real iframe interactions instead of the
    // generated mock actions.
    if (PLAID_LINK_LIVE) {
      // Primary: check plaidPhase field from demo-script.json (authoritative, handles any step ID)
      // Fallback: regex pattern matching — ONLY for legacy scripts with no
      // explicit plaidPhase metadata anywhere (see hasExplicitPlaidPhases:
      // 'application-consent' matched a link-phase pattern and the override
      // skipped the host step's dwell+click entirely, Ascend 2026-06-12).
      let plaidPhase = phaseForStep(stepId);
      if (plaidPhaseMap[stepId]) {
        console.log(`  [Record] Live Plaid Link phase from demo-script: step "${stepId}" → "${plaidPhase}"`);
      }
      // Fallback: if a click action targets the Plaid Link button, treat as launch phase.
      // This handles build-agent step IDs like "wf-link-initiate-click" that don't match
      // the standard naming patterns but represent the same action. Disabled when the
      // demo-script carries explicit plaidPhase metadata (authoritative).
      let plaidLaunchStepId = null; // step ID to goToStep before executing launch
      if (!plaidPhase && !hasExplicitPlaidPhases && stepEntry.action === 'click' &&
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

        // Lock the launch step so the app can't advance away (covering the modal
        // with a post-link screen) mid-recording. Released after the modal closes;
        // the deferred post-link advance is flushed then. CRA modal-hold yields to
        // this lock (it keeps its own handler.destroy() defer).
        if (plaidPhase === 'launch') {
          await installPlaidLaunchLock(page, goToStepId);
        }

        // Multi-launch / product-aware live modal. A demo may launch Plaid Link,
        // Plaid Layer, AND/OR live IDV — each is a real Plaid modal. Layer/IDV use
        // a different open contract and completion flag than classic Link, so they
        // go through executeLayerOrIdvLaunch (verifies the modal LOADS, optional
        // vision navigation, waits the right flag). Classic Plaid Link is unchanged.
        const launchProduct = (plaidPhase === 'launch')
          ? detectLaunchProduct(stepId, stepEntry.target)
          : 'link';
        try {
          if (plaidPhase === 'launch' && (launchProduct === 'layer' || launchProduct === 'idv')) {
            await executeLayerOrIdvLaunch(page, launchProduct);
          } else {
            await executePlaidLinkPhase(page, plaidPhase);
          }
        } catch (plaidErr) {
          console.warn(`  [Plaid ${launchProduct}] Phase "${plaidPhase}" failed: ${plaidErr.message}`);
        }

        // Ensure the modal is closed before advancing — if onSuccess fired, the
        // app advanced already; if automation timed out, force-close the correct
        // handler so it doesn't overlay subsequent steps in the recording.
        if (plaidPhase === 'launch') {
          const closed = await page.evaluate((product) => {
            var h = product === 'idv' ? window._idvHandler : window._plaidHandler;
            window._plaidModalOpened = false;
            if (h && h.destroy) { try { h.destroy(); } catch (e) {} return true; }
            return false;
          }, launchProduct).catch(() => false);
          if (closed) console.log(`  [Plaid ${launchProduct}] Ensured modal closed after launch phase.`);
          // Release the launch-step lock and flush the deferred post-link advance
          // so the app proceeds to the correct first post-link step now that the
          // modal recording is complete.
          await releasePlaidLaunchLock(page);
        }

        // Add a short tail wait so the Plaid modal fade-out doesn't bleed into
        // the next step's step-timing window. We intentionally DO NOT honor the
        // stepEntry.waitMs (often 120s safety budget) here: at this point
        // plaidLinkWaitSuccess has already confirmed onSuccess fired and the
        // app advanced (usually to the first post-link step via
        // goToStep inside onSuccess). Blocking for the full step wait would
        // keep the step-timing window for plaid-link-launch open for 5+ more
        // seconds while the screen already shows the next step's content —
        // that misattribution is what desynchronizes narration from visuals
        // (observed: ~5s of Plaid Link narration playing over the
        // identity-match-pass screen). Keep the wait minimal and deterministic.
        const PLAID_LAUNCH_TAIL_SETTLE_MS = Math.max(
          0,
          parseInt(process.env.PLAID_LAUNCH_TAIL_SETTLE_MS || '400', 10) || 400
        );
        if (PLAID_LAUNCH_TAIL_SETTLE_MS > 0) {
          await page.waitForTimeout(PLAID_LAUNCH_TAIL_SETTLE_MS);
        }

        continue; // Skip the normal action execution for this step
      }
    }

    if (stepEntry.actions && Array.isArray(stepEntry.actions)) {
      // Format A: explicit actions array
      if (shouldDeferMark && stepEntry.actions.length > 0) {
        const [first, ...rest] = stepEntry.actions;
        await executeAction(page, first);
        if (isPostPlaidBoundary && POST_LINK_STEP_BOUNDARY_GUARD_MS > 0) {
          await page.waitForTimeout(POST_LINK_STEP_BOUNDARY_GUARD_MS);
        }
        if (STEP_TRANSITION_SETTLE_MS > 0) await page.waitForTimeout(STEP_TRANSITION_SETTLE_MS);
        markStep(stepId, label);
        didDeferredMark = true;
        if (rest.length > 0) await executeActions(page, rest);
      } else {
        await executeActions(page, stepEntry.actions);
      }
    } else if (stepEntry.action) {
      // Format B: single action with target + waitMs
      const actions = [];

      // CRITICAL: ensure the step's div is the active one BEFORE any click /
      // fill / wait. Scratch-app step divs are display:none until
      // window.goToStep(stepId) flips the active class — the buttons /
      // inputs inside an inactive step are never visible to Playwright, so
      // a click here times out, the recorder logs "click failed", and the
      // recording continues to capture the PREVIOUS step's content while
      // step-timing.json claims the current step is active. (Tilt v2: 3/9
      // clicks failed for exactly this reason — apply-now-btn,
      // approve-advance-btn, and link-external-account-btn never landed.)
      //
      // For action: 'goToStep' entries, the explicit target already drives
      // the transition; we skip the implicit activation to avoid clobbering
      // the author's intent (the goToStep target may legitimately differ
      // from the step id, e.g. Plaid Link launch routing).
      if (stepEntry.action !== 'goToStep' && stepId) {
        await executeAction(page, {
          type: 'evalStep',
          expression: `window.goToStep && window.goToStep('${stepId}')`,
        });
        // Give the DOM a tick to render the newly-active step before the
        // following action queries it. Without this, click's
        // `waitFor visible` race condition can still miss the just-revealed
        // element on slower machines.
        if (STEP_TRANSITION_SETTLE_MS > 0) {
          await page.waitForTimeout(STEP_TRANSITION_SETTLE_MS);
        } else {
          await page.waitForTimeout(150);
        }
      }

      if (stepEntry.action === 'goToStep') {
        // target may already be "window.goToStep('...')" or just the step ID
        const target = stepEntry.target || '';
        // target may be: "window.goToStep('id')", "goToStep('id')", or just "id"
        const expression = target.startsWith('window.')
          ? target
          : target.startsWith('goToStep(')
            ? `window.${target}`
            : `window.goToStep('${target}')`;
        if (shouldDeferMark) {
          await executeAction(page, { type: 'evalStep', expression });
          if (isPostPlaidBoundary && POST_LINK_STEP_BOUNDARY_GUARD_MS > 0) {
            await page.waitForTimeout(POST_LINK_STEP_BOUNDARY_GUARD_MS);
          }
          if (STEP_TRANSITION_SETTLE_MS > 0) await page.waitForTimeout(STEP_TRANSITION_SETTLE_MS);
          markStep(stepId, label);
          didDeferredMark = true;
        } else {
          actions.push({
            type: 'evalStep',
            expression,
          });
        }
      } else if (stepEntry.action === 'click') {
        // DWELL BEFORE THE CLICK (2026-06-11). In this pipeline's grammar a
        // click row's click is the TRANSITION TRIGGER into the next beat
        // ("…she taps Link Your Bank"). The old order [click, wait(waitMs)]
        // clicked ~150–650ms after the step activated and then spent the
        // ENTIRE dwell on the NEXT screen — the step's own content flashed
        // for under a second, so post-record QA frames showed the previous/
        // next screens (Zip v1: zip-checkout 5/100, lendscore-reveal 10/100,
        // approval-success 0/100 — all click rows following slides). Wait the
        // narration dwell first, click at the end, then a short settle so the
        // click and resulting transition land on camera.
        if (stepEntry.waitMs) {
          actions.push({ type: 'wait', ms: stepEntry.waitMs });
        }
        actions.push({
          type: 'click',
          selector: stepEntry.target,
        });
        actions.push({ type: 'wait', ms: 400 });
      } else if (stepEntry.action === 'fill') {
        actions.push({
          type: 'fill',
          selector: stepEntry.target,
          value: stepEntry.value || '',
        });
      } else if (stepEntry.action === 'wait') {
        // Just wait — no interaction
      }
      // Add a wait for the step's declared duration (clicks already spent the
      // dwell BEFORE the interaction — no tail wait for them).
      if (stepEntry.waitMs && stepEntry.action !== 'click') {
        actions.push({
          type: 'wait',
          ms: stepEntry.waitMs,
        });
      }
      await executeActions(page, actions);
    }
    if (shouldDeferMark && !didDeferredMark) {
      if (isPostPlaidBoundary && POST_LINK_STEP_BOUNDARY_GUARD_MS > 0) {
        await page.waitForTimeout(POST_LINK_STEP_BOUNDARY_GUARD_MS);
      }
      if (STEP_TRANSITION_SETTLE_MS > 0) await page.waitForTimeout(STEP_TRANSITION_SETTLE_MS);
      markStep(stepId, label);
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

  // Write post-record-freeze sentinel. Automated post-slides and slide-fix
  // runs refuse to mutate slide HTML while this sentinel exists — once the
  // recording captures the host app, automated re-rolls would invalidate the
  // recorded video. Editor mutations are still allowed (with a stale flag
  // surfaced via the dashboard). To re-record, the operator runs the record
  // stage again, which overwrites the sentinel with a fresh timestamp.
  try {
    const sentinelPath = path.join(OUT_DIR, 'post-record-freeze.sentinel');
    fs.writeFileSync(sentinelPath, JSON.stringify({
      schemaVersion: 1,
      frozenAt: new Date().toISOString(),
      recordingPath: path.relative(OUT_DIR, finalVideoPath),
      recordingExists: fs.existsSync(finalVideoPath),
      totalDurationMs: totalMs,
      note: 'Automated slide-fix / post-slides re-runs refuse while this sentinel exists. Storyboard editor mutations are allowed but will flag voiceover-stale or recording-stale. Re-run "pipe stage record" to overwrite.',
    }, null, 2), 'utf8');
    console.log(`[Record] Freeze sentinel: ${path.relative(PROJECT_ROOT, sentinelPath)}`);
  } catch (sentinelErr) {
    console.warn(`[Record] Could not write post-record-freeze.sentinel: ${sentinelErr.message}`);
  }

  console.log(`[Record] Total: ${(totalMs / 1000).toFixed(1)}s — Next: qa-review.js`);
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[Record] Fatal error:', err.message);
    process.exit(1);
  });
}
