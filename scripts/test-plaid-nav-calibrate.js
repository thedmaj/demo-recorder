'use strict';
/**
 * test-plaid-nav-calibrate.js
 *
 * Calibration harness for the human-like Plaid navigation system. Launches a
 * Plaid experience inside an already-BUILT demo app, drives the flow with the
 * same CSS-first selectors the recorder uses, and captures per-screen:
 *   - entry timestamp + screenshot (out/calibration/<experience>/<ts>/screens/)
 *   - visible Plaid-pane text word count  → profile typicalWordCount
 *   - transition latency (action done → next screen arrival)
 *     → profile observed.p50/p90TransitionMs (p90 = minimum-safe-wait floor)
 *
 * Merges results into inputs/plaid-nav-profiles/<experience>.json, appends a
 * human-readable section to inputs/plaid-link-nav-learnings.md, and emits
 * knowledgeGaps[] for unrecognized screens (resolve via AskBill, re-run).
 *
 * Usage:
 *   node scripts/test-plaid-nav-calibrate.js --experience classic-link \
 *     --app out/demos/2026-06-10-Td-Bank-...-v1 [--samples 1] [--css-only] \
 *     [--headless] [--launch-step STEP_ID] [--port 3750] [--timeout 240]
 *
 * Experiences: classic-link | embedded-link | layer | cra-link | idv
 * Calibration drives at machine speed on purpose — transition latency is
 * measured action→arrival, so sandbox timing is isolated from our pacing.
 */

require('dotenv').config({ override: true });
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const navProfile = require('./scratch/utils/plaid-nav-profile');
const { startServer } = require('./scratch/utils/app-server');

const LEARNINGS_FILE = path.join(PROJECT_ROOT, 'inputs', 'plaid-link-nav-learnings.md');
const CALIBRATION_DIR = path.join(PROJECT_ROOT, 'out', 'calibration');
const PLAID_IFRAME_SELECTOR = 'iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"], iframe[src*="plaid.com"]';

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv = process.argv.slice(2)) {
  const get = (k, d) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;
  return {
    experience: get('experience', null),
    app: get('app', null),
    samples: parseInt(get('samples', '1'), 10),
    cssOnly: argv.includes('--css-only'),
    headless: argv.includes('--headless'),
    launchStep: get('launch-step', null),
    port: parseInt(get('port', '3750'), 10),
    timeoutS: parseInt(get('timeout', '240'), 10),
  };
}

// ── Frame helpers (mirror plaid-recipe-executor semantics) ───────────────────

async function frameVisible(frame, selector, timeout = 600) {
  if (!selector) return false;
  try {
    return await frame.locator(selector).filter({ visible: true }).first()
      .isVisible({ timeout }).catch(() => false);
  } catch (_) { return false; }
}

async function frameClick(frame, selectors) {
  for (const sel of [].concat(selectors)) {
    try {
      const loc = frame.locator(sel).filter({ visible: true }).first();
      if (await loc.isVisible({ timeout: 1200 }).catch(() => false)) {
        await loc.click({ force: true, timeout: 5000 });
        return sel;
      }
    } catch (_) {}
    if (!sel.startsWith('button') && !sel.includes(':has-text') && !sel.includes('[')) {
      try {
        const loc = frame.getByText(sel, { exact: false }).first();
        if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
          await loc.click({ force: true, timeout: 5000 });
          return `text:${sel}`;
        }
      } catch (_) {}
    }
  }
  return null;
}

async function frameFill(frame, selector, value) {
  try {
    const loc = frame.locator(selector).filter({ visible: true }).first();
    if (await loc.isVisible({ timeout: 1200 }).catch(() => false)) {
      await loc.click({ force: true, timeout: 2000 }).catch(() => {});
      await loc.fill(String(value));
      return true;
    }
  } catch (_) {}
  return false;
}

async function frameBodyText(frame) {
  try {
    return await frame.locator('body').innerText({ timeout: 2000 });
  } catch (_) { return null; }
}

function wordCountOf(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : null;
}

/** detect.textProbe / textProbeAny must appear (and notTextProbe must NOT) in pane text. */
function probesPass(screen, bodyText) {
  const text = (bodyText || '').toLowerCase();
  const any = screen.detect?.textProbeAny;
  if (Array.isArray(any) && any.length &&
      !any.some((p) => text.includes(String(p).toLowerCase()))) return false;
  const probe = screen.detect?.textProbe;
  if (!Array.isArray(any) && probe && !text.includes(String(probe).toLowerCase())) return false;
  const notProbe = screen.detect?.notTextProbe;
  if (notProbe && text.includes(String(notProbe).toLowerCase())) return false;
  return true;
}

// ── Per-screen action drivers (keyed by profile screen id) ───────────────────
// CSS selectors match the recorder's confirmed set (plaid-link-nav-learnings.md
// 2026-03-10 + inputs/plaid-recipes/remember-me.json).

const CONTINUE_BUTTONS = [
  "button:has-text('Continue')", "button:has-text('Get started')",
  "button:has-text('Accept')", "button:has-text('Agree')", "button[type='submit']",
];
const CONFIRM_BUTTONS = [
  "button:has-text('Confirm')", "button:has-text('Link account')",
  "button:has-text('Continue')", "button:has-text('Share')",
  "button:has-text('Done')", "button[type='submit']",
];

function buildActionMap(creds) {
  const fillNumericAndAdvance = async ({ frame, page }) => {
    const otp = creds.otp || creds.smsCode || '123456';
    await frameFill(frame, "input[inputmode='numeric']", otp);
    await page.waitForTimeout(1000); // keep digits visible; Plaid auto-advances
    if (await frameVisible(frame, "input[inputmode='numeric']", 800)) {
      await frame.locator("input[inputmode='numeric']").first().press('Enter').catch(() => {});
    }
    return 'otp-filled';
  };

  return {
    'phone-entry': async ({ frame }) => {
      const phone = creds.phone || '+14155550011';
      const filledTel = await frameFill(frame, "input[type='tel']", phone);
      if (!filledTel) {
        // IDV phone pane: masked inputmode=numeric input with a separate +1 code —
        // masks reject fill(); type national digits as keystrokes.
        const national = phone.replace(/^\+1/, '').replace(/^\+/, '');
        try {
          const loc = frame.locator("input[inputmode='numeric'], input[inputmode='tel']").first();
          await loc.click({ force: true, timeout: 2000 });
          await loc.pressSequentially(national, { delay: 40 });
        } catch (_) {}
      }
      return frameClick(frame, ["button:has-text('Send verification code')", ...CONTINUE_BUTTONS]);
    },
    'otp-screen': fillNumericAndAdvance,
    'sms-code': async ({ frame, page }) => {
      // IDV: five separate digit boxes; focus auto-advances on each keystroke
      const code = creds.smsCode || creds.otp || '11111';
      try {
        const first = frame.locator("input[inputmode='numeric']").first();
        await first.click({ force: true, timeout: 2000 });
        await first.pressSequentially(code, { delay: 120 });
      } catch (_) {}
      await page.waitForTimeout(1000);
      return 'sms-filled';
    },
    'dob-entry': async ({ frame, page }) => {
      // Month = react-select combo; Day/Year = numeric inputs (#dob-day/#dob-year)
      const [y, m, d] = String(creds.dob || '1975-01-18').split('-');
      const monthName = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'][parseInt(m, 10) - 1];
      try {
        const month = frame.locator("input[id*='react-select']").first();
        await month.click({ force: true, timeout: 2000 });
        await month.pressSequentially(monthName, { delay: 40 });
        await month.press('Enter');
      } catch (_) {}
      for (const [sel, val] of [
        ["input[id='dob-day'], input[name='dob.day'], input[placeholder='Day']", String(parseInt(d, 10))],
        ["input[id='dob-year'], input[name='dob.year'], input[placeholder='Year']", y],
      ]) {
        try {
          const loc = frame.locator(sel).first();
          await loc.click({ force: true, timeout: 2000 });
          await loc.pressSequentially(val, { delay: 50 });
        } catch (_) {}
      }
      await page.waitForTimeout(400);
      return frameClick(frame, CONTINUE_BUTTONS);
    },
    'layer-otp': fillNumericAndAdvance,
    'mfa-otp': async ({ frame, page }) => {
      await frameFill(frame, "input[inputmode='numeric']", creds.mfaOtp || '1234');
      await page.waitForTimeout(800);
      return frameClick(frame, CONTINUE_BUTTONS) || 'auto-advance';
    },
    'cra-institution-select': async ({ frame, page }) => {
      // CRA pane: institution rows + Confirm (disabled until a row is picked)
      await page.waitForTimeout(600);
      const row = await frameClick(frame, ['ul li button', 'ul li', "li[role='listitem']"]);
      await page.waitForTimeout(700);
      const confirmed = await frameClick(frame, CONFIRM_BUTTONS);
      return confirmed ? `${row} → ${confirmed}` : row;
    },
    'saved-institution-list': async ({ frame, page }) => {
      await page.waitForTimeout(500); // load-bearing pre-click pause (CLAUDE.md)
      return frameClick(frame, ['ul li:first-of-type button', 'ul li']);
    },
    'consent': async ({ frame }) => frameClick(frame, CONTINUE_BUTTONS),
    'country-select': async ({ frame }) => frameClick(frame, CONTINUE_BUTTONS),
    'share-consumer-report': async ({ frame }) => frameClick(frame, ["button:has-text('Confirm')", ...CONTINUE_BUTTONS]),
    'cra-consent': async ({ frame }) => frameClick(frame, CONTINUE_BUTTONS),
    'layer-consent': async ({ frame }) => frameClick(frame, CONTINUE_BUTTONS),
    'idv-consent': async ({ frame }) => frameClick(frame, CONTINUE_BUTTONS),
    'institution-search': async ({ frame, page }) => {
      const name = creds.institutionName || 'First Platypus Bank';
      await frameFill(frame, "input[placeholder*='Search' i]", name);
      await page.waitForTimeout(1500);
      return frameClick(frame, [name]);
    },
    'embedded-search': async ({ frame, page }) => {
      const name = creds.institutionName || 'First Platypus Bank';
      if (await frameVisible(frame, "input[placeholder*='Search' i]", 1500)) {
        await frameFill(frame, "input[placeholder*='Search' i]", name);
        await page.waitForTimeout(1500);
      }
      return frameClick(frame, [name]);
    },
    'credentials': async ({ frame }) => {
      await frameFill(frame, "input[type='text']", creds.username || 'user_good');
      await frameFill(frame, "input[type='password']", creds.password || 'pass_good');
      return frameClick(frame, ["button[type='submit']", ...CONTINUE_BUTTONS]);
    },
    'account-select': async ({ frame, page }) => {
      // Account select + Confirm/Continue are the SAME pane — pick a row, then confirm.
      await page.waitForTimeout(800);
      const row = await frameClick(frame, [
        "li[role='listitem']", "[role='radio']", "input[type='radio']",
        "input[type='checkbox']", 'label:has(input)', 'ul li',
      ]);
      await page.waitForTimeout(700);
      const confirmed = await frameClick(frame, CONFIRM_BUTTONS);
      return confirmed ? `${row} → ${confirmed}` : row;
    },
    'confirm': async ({ frame }) => frameClick(frame, CONFIRM_BUTTONS),
    'layer-review': async ({ frame }) => frameClick(frame, ["button:has-text('Share')", ...CONFIRM_BUTTONS]),
    'save-with-plaid': async ({ frame }) => frameClick(frame, [
      "button:has-text('Finish without saving')", "button:has-text('No thanks')", "button:has-text('Skip')",
    ]),
    'identity-review': async ({ frame }) => frameClick(frame, [
      "button:has-text('Confirm and Continue')", ...CONTINUE_BUTTONS,
    ]),
    'pii-form': async ({ frame, page }) => {
      const fields = [
        ["input[autocomplete='given-name'], input[name*='first' i]", creds.firstName],
        ["input[autocomplete='family-name'], input[name*='last' i]", creds.lastName],
        ["input[autocomplete*='address' i], input[name*='address' i], input[name*='street' i]", creds.address],
        ["input[name*='city' i]", creds.city],
        ["input[name*='zip' i], input[name*='postal' i]", creds.zip],
        ["input[name*='ssn' i], input[autocomplete='off'][inputmode='numeric']", creds.ssn],
        ["input[name*='dob' i], input[autocomplete='bday'], input[placeholder*='MM' i]", creds.dobUi || creds.dob],
      ];
      for (const [sel, val] of fields) {
        if (val) { await frameFill(frame, sel, val); await page.waitForTimeout(150); }
      }
      // State may be a select
      try {
        const st = frame.locator("select[name*='state' i], select[autocomplete='address-level1']").first();
        if (await st.isVisible({ timeout: 600 }).catch(() => false)) {
          await st.selectOption({ label: 'Indiana' }).catch(() => st.selectOption(creds.state || 'IN').catch(() => {}));
        }
      } catch (_) {}
      return frameClick(frame, ["button[type='submit']", ...CONTINUE_BUTTONS]);
    },
    'kyc-running': async () => 'wait',
    'doc-upload': async ({ frame }) => {
      try {
        const fileInput = frame.locator("input[type='file']").first();
        if (await fileInput.count() > 0) {
          const tmpImg = path.join(CALIBRATION_DIR, '_sandbox-doc.png');
          if (!fs.existsSync(tmpImg)) {
            // 1×1 white PNG — sandbox treats any upload as a genuine Leslie Knope doc
            fs.mkdirSync(CALIBRATION_DIR, { recursive: true });
            fs.writeFileSync(tmpImg, Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
          }
          await fileInput.setInputFiles(tmpImg);
          return 'uploaded';
        }
      } catch (_) {}
      return frameClick(frame, CONTINUE_BUTTONS);
    },
    'selfie': async ({ frame }) => frameClick(frame, [...CONTINUE_BUTTONS, "button:has-text('Skip')"]),
    'success': async () => 'terminal',
  };
}

// ── Host-app navigation to the launch step ───────────────────────────────────

function resolveLaunchStep(demoScript, experience, explicit) {
  const launches = demoScript.steps.filter((s) => s.plaidPhase === 'launch');
  if (explicit) {
    const found = launches.find((s) => s.id === explicit);
    if (!found) throw new Error(`--launch-step ${explicit} is not a plaidPhase:launch step`);
    return found;
  }
  if (launches.length === 0) throw new Error('No plaidPhase:launch steps in demo-script.json');
  if (launches.length === 1) return launches[0];
  const want = experience === 'idv' ? 'idv' : experience === 'layer' ? 'layer' : 'link';
  return launches.find((s) => String(s.launchProduct || '').toLowerCase() === want) || launches[0];
}

function launchClickTarget(appDir, launchStepId) {
  try {
    const ps = JSON.parse(fs.readFileSync(path.join(appDir, 'scratch-app', 'playwright-script.json'), 'utf8'));
    const row = (ps.steps || ps).find((s) => (s.id || s.stepId) === launchStepId);
    if (row?.target) return row.target;
  } catch (_) {}
  return '[data-testid="link-external-account-btn"]';
}

async function navigateHostToLaunch(page, demoScript, launchStepId) {
  await page.waitForFunction(() => typeof window.goToStep === 'function', null, { timeout: 15000 });
  for (const step of demoScript.steps) {
    await page.evaluate((id) => window.goToStep(id), step.id).catch(() => {});
    await page.waitForTimeout(250);
    if (step.id === launchStepId) break;
  }
}

// ── One calibration sample ───────────────────────────────────────────────────

/**
 * Resolve the ACTIVE Plaid iframe as a Frame object. Apps can carry several
 * Plaid iframes at once (e.g. a preloaded bank-Link handler plus a live IDV
 * session) — page.frameLocator() binds the FIRST match, which may be hidden.
 * Pick the last VISIBLE plaid frame instead (the one opened most recently).
 */
async function resolveActivePlaidFrame(page) {
  let best = null;
  for (const fr of page.frames()) {
    if (!/plaid\.com/.test(fr.url())) continue;
    try {
      const el = await fr.frameElement();
      if (el && await el.isVisible()) best = fr;
    } catch (_) {}
  }
  return best;
}

async function runSample({ page, profile, creds, experience, screensDir, sampleIdx, timeoutS, cssOnly, agent }) {
  const fallbackFrame = page.frameLocator(PLAID_IFRAME_SELECTOR);
  const actions = buildActionMap(creds);
  const visits = new Map();
  const observations = [];
  const gaps = [];
  const deadline = Date.now() + timeoutS * 1000;
  let lastActionDoneAt = Date.now();
  let lastScreenId = null;
  let lastScreenIdx = -1;
  let sameScreenActs = 0;
  let unknownSince = null;

  const isComplete = () => page.evaluate(
    () => !!(window._plaidLinkComplete || window._idvComplete)
  ).catch(() => false);

  while (Date.now() < deadline) {
    if (await isComplete()) {
      observations.push({ screenId: 'success', enteredAtMs: Date.now(), transitionMs: Date.now() - lastActionDoneAt, wordCount: null });
      console.log('  [calibrate] flow complete (_plaidLinkComplete/_idvComplete)');
      break;
    }
    const frame = (await resolveActivePlaidFrame(page)) || fallbackFrame;

    // Detect the active screen in two passes.
    //
    // Pass 1 — SPECIFIC detectors (tel/numeric/password inputs, probed lists):
    // unambiguous, so scan everywhere — forward from the current screen first,
    // then earlier screens (flows can loop, and a wrong index must not strand
    // the loop).
    //
    // Pass 2 — GENERIC detectors (detect.generic: Continue/Confirm buttons,
    // bare 'ul li'): these match on almost every Plaid pane, including the one
    // we just acted on. Only accept one when the pane has demonstrably changed
    // (previous screen's selector gone) and the action had time to land.
    const bodyText = await frameBodyText(frame);
    const lastScreen = lastScreenIdx >= 0 ? profile.screens[lastScreenIdx] : null;
    const scanOrder = [];
    for (let i = lastScreenIdx + 1; i < profile.screens.length; i++) scanOrder.push(i);
    for (let i = 0; i < lastScreenIdx; i++) scanOrder.push(i);
    if (lastScreenIdx >= 0) scanOrder.push(lastScreenIdx); // same screen, checked last

    let active = null;
    for (const i of scanOrder) {
      const screen = profile.screens[i];
      if ((visits.get(screen.id) || 0) >= 2 && screen.id !== lastScreenId) continue;
      if (!screen.detect?.selector || screen.detect?.generic) continue;
      if (!probesPass(screen, bodyText)) continue;
      if (await frameVisible(frame, screen.detect.selector, 350)) {
        active = screen;
        break;
      }
    }
    if (!active && Date.now() - lastActionDoneAt > 1200) {
      const lastStillVisible = lastScreen?.detect?.selector && !lastScreen.detect.generic
        ? await frameVisible(frame, lastScreen.detect.selector, 350)
        : false;
      if (!lastStillVisible) {
        for (const i of scanOrder) {
          const screen = profile.screens[i];
          if ((visits.get(screen.id) || 0) >= 2 && screen.id !== lastScreenId) continue;
          if (!screen.detect?.selector || !screen.detect?.generic) continue;
          if (!probesPass(screen, bodyText)) continue;
          if (await frameVisible(frame, screen.detect.selector, 350)) {
            active = screen;
            break;
          }
        }
      }
    }

    // Same screen still visible long after we acted → the action missed;
    // retry it once instead of polling forever.
    if (active && active.id === lastScreenId &&
        Date.now() - lastActionDoneAt > 8000 && sameScreenActs < 2) {
      sameScreenActs++;
      console.warn(`  [calibrate] still on ${active.id} ${Math.round((Date.now() - lastActionDoneAt) / 1000)}s after acting — retrying action (${sameScreenActs}/2)`);
      const act = actions[active.id];
      if (act) await act({ frame, page }).catch(() => {});
      lastActionDoneAt = Date.now();
      continue;
    }

    if (!active) {
      // Unknown / loading screen
      if (!unknownSince) unknownSince = Date.now();
      if (Date.now() - unknownSince > 12000) {
        const shot = path.join(screensDir, `s${sampleIdx}-unknown-${Date.now()}.png`);
        await page.screenshot({ path: shot }).catch(() => {});
        let visionLabel = null;
        if (!cssOnly && agent) {
          try { visionLabel = await agent.detectPlaidScreen(page); } catch (_) {}
        }
        gaps.push({ kind: 'unknown-screen', afterScreen: lastScreenId, visionLabel, screenshot: shot });
        console.warn(`  [calibrate] KNOWLEDGE GAP: unknown screen after "${lastScreenId}" (vision: ${visionLabel || 'n/a'})`);
        // One generic nudge, then bail if still stuck
        const nudged = await frameClick(frame, CONTINUE_BUTTONS);
        unknownSince = Date.now();
        if (!nudged) break;
      }
      await page.waitForTimeout(300);
      continue;
    }

    unknownSince = null;
    if (active.id !== lastScreenId) {
      const enteredAt = Date.now();
      const transitionMs = enteredAt - lastActionDoneAt;
      const wordCount = wordCountOf(bodyText);
      const shot = path.join(screensDir, `s${sampleIdx}-${active.id}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      observations.push({ screenId: active.id, enteredAtMs: enteredAt, transitionMs, wordCount, screenshot: shot });
      console.log(`  [calibrate] screen=${active.id} transition=${transitionMs}ms words=${wordCount}`);
      visits.set(active.id, (visits.get(active.id) || 0) + 1);
      lastScreenId = active.id;
      lastScreenIdx = profile.screens.findIndex((s) => s.id === active.id);
      sameScreenActs = 0;

      if (active.terminal) {
        console.log(`  [calibrate] terminal screen "${active.id}" reached — desktop flow ends here by design`);
        observations[observations.length - 1].terminal = true;
        break;
      }

      const act = actions[active.id];
      if (act) {
        const winner = await act({ frame, page }).catch((e) => {
          console.warn(`  [calibrate] action failed on ${active.id}: ${e.message}`);
          return null;
        });
        observations[observations.length - 1].actionWinner = winner || null;
        if (!winner && !cssOnly && agent) {
          gaps.push({ kind: 'action-miss', screenId: active.id });
        }
        lastActionDoneAt = Date.now();
      } else {
        gaps.push({ kind: 'no-action-mapping', screenId: active.id });
        lastActionDoneAt = Date.now();
      }
    }
    await page.waitForTimeout(300);
  }

  const reachedTerminal = observations.some((o) => o.terminal);
  const completed = (await isComplete()) || reachedTerminal;
  return { observations, gaps, completed, reachedTerminal };
}

// ── Profile + learnings persistence ──────────────────────────────────────────

function mergeIntoProfile(profile, allSamples, completedCount) {
  const byScreen = new Map();
  for (const sample of allSamples) {
    for (const obs of sample.observations) {
      const e = byScreen.get(obs.screenId) || { transitions: [], wordCounts: [] };
      // First screen's "transition" includes modal open time — still useful as arrival latency.
      if (Number.isFinite(obs.transitionMs)) e.transitions.push(obs.transitionMs);
      if (Number.isFinite(obs.wordCount)) e.wordCounts.push(obs.wordCount);
      byScreen.set(obs.screenId, e);
    }
  }
  for (const [screenId, e] of byScreen) {
    const wordCount = e.wordCounts.length
      ? Math.round(e.wordCounts.reduce((a, b) => a + b, 0) / e.wordCounts.length) : null;
    navProfile.mergeObservation(profile, screenId, e.transitions, wordCount != null ? { wordCount } : {});
  }
  const required = profile.screens.filter((s) => !s.optional);
  // Cumulative: sessions can resume mid-flow (IDV phone-linked identity), so
  // screens verified by earlier samples still count as covered.
  const seen = required.filter((s) => byScreen.has(s.id) || (s.observed?.samples || 0) > 0).length;
  const gapCount = allSamples.reduce((n, s) => n + s.gaps.length, 0);
  const coverage = required.length ? seen / required.length : 0;
  profile.knowledgeConfidence = Math.min(0.95,
    Math.round((coverage * 0.95 - gapCount * 0.05 + (completedCount > 0 ? 0 : -0.2)) * 100) / 100);
  if (completedCount > 0) {
    profile.verifiedRuns = (profile.verifiedRuns || 0) + completedCount;
    profile.lastVerifiedAt = new Date().toISOString();
  } else {
    profile.lastBrokenAt = new Date().toISOString();
  }
  navProfile.saveProfile(profile);
  return { byScreen, coverage, gapCount };
}

function appendLearnings({ experience, appDir, allSamples, completedCount, profile }) {
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const lines = [];
  lines.push('');
  lines.push(`## Calibration: ${date} — ${completedCount > 0 ? 'PASS' : 'FAIL'} [${experience}] — nav-profile calibration`);
  lines.push(`**App**: \`${path.basename(appDir)}\` | **Samples**: ${allSamples.length} | **Completed**: ${completedCount}/${allSamples.length} | **Confidence**: ${profile.knowledgeConfidence}`);
  lines.push('');
  lines.push('| Screen | Transition (ms) | Words | Action winner |');
  lines.push('|--------|-----------------|-------|---------------|');
  for (const obs of allSamples[0]?.observations || []) {
    lines.push(`| ${obs.screenId} | ${obs.transitionMs ?? '—'} | ${obs.wordCount ?? '—'} | ${obs.actionWinner || '—'} |`);
  }
  const gaps = allSamples.flatMap((s) => s.gaps);
  if (gaps.length) {
    lines.push('');
    lines.push('### Knowledge gaps:');
    for (const g of gaps) lines.push(`  - ${g.kind}: ${g.screenId || g.visionLabel || g.afterScreen || '?'}`);
  }
  lines.push('');
  lines.push('---');
  fs.appendFileSync(LEARNINGS_FILE, lines.join('\n') + '\n', 'utf8');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  if (!args.experience || !args.app) {
    console.error('Usage: node scripts/test-plaid-nav-calibrate.js --experience=<classic-link|embedded-link|layer|cra-link|idv> --app=out/demos/<run> [--samples=N] [--css-only] [--headless] [--launch-step=ID] [--port=N] [--timeout=S]');
    process.exit(64);
  }
  const appDir = path.resolve(PROJECT_ROOT, args.app);
  const scratchAppDir = path.join(appDir, 'scratch-app');
  if (!fs.existsSync(scratchAppDir)) throw new Error(`No scratch-app/ in ${appDir}`);
  const demoScript = JSON.parse(fs.readFileSync(path.join(appDir, 'demo-script.json'), 'utf8'));

  const profile = navProfile.loadProfileByName(args.experience);
  if (!profile) throw new Error(`No profile inputs/plaid-nav-profiles/${args.experience}.json`);

  // Credentials: profile seeds, demo-script plaidSandboxConfig overrides.
  const sc = demoScript.plaidSandboxConfig || {};
  const creds = { ...(profile.credentials || {}), ...Object.fromEntries(Object.entries(sc).filter(([, v]) => v)) };

  const launchStep = resolveLaunchStep(demoScript, args.experience, args.launchStep);
  const launchTarget = launchClickTarget(appDir, launchStep.id);
  console.log(`[calibrate] experience=${args.experience} app=${path.basename(appDir)} launch=${launchStep.id} target=${launchTarget}`);

  // Serve the built app with its run-dir API context (link-token config, CRA creds…)
  process.env.PLAID_LINK_LIVE = 'true';
  process.env.PIPELINE_RUN_DIR = appDir;
  const server = await startServer(args.port, scratchAppDir);
  console.log(`[calibrate] app server: ${server.url}`);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const screensDir = path.join(CALIBRATION_DIR, args.experience, ts, 'screens');
  fs.mkdirSync(screensDir, { recursive: true });

  let agent = null;
  if (!args.cssOnly && process.env.ANTHROPIC_API_KEY) {
    agent = require('./scratch/utils/plaid-browser-agent');
  }

  const allSamples = [];
  let completedCount = 0;
  const browser = await chromium.launch({ headless: args.headless });
  try {
    for (let i = 0; i < args.samples; i++) {
      console.log(`[calibrate] sample ${i + 1}/${args.samples}`);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      page.on('console', (m) => { if (/error/i.test(m.type())) console.log(`  [page:${m.type()}] ${m.text().slice(0, 160)}`); });
      try {
        await page.goto(server.url, { waitUntil: 'domcontentloaded' });
        await navigateHostToLaunch(page, demoScript, launchStep.id);
        // Wait for handler init (modal mode), then click the launch CTA
        await page.waitForFunction(
          () => window._plaidHandler != null || window.__embeddedLinkWidgetLoaded || window.__plaidEmbeddedInstance,
          null, { timeout: 20000 }
        ).catch(() => console.warn('  [calibrate] no handler flag after 20s — clicking anyway'));
        const launchedAt = Date.now();
        const embedded = String(demoScript.plaidLinkMode || '').toLowerCase() === 'embedded';
        if (embedded) {
          // Embedded mode: no launch button — the in-page widget IS the entry
          // point; the observe loop interacts with it directly.
          console.log('  [calibrate] embedded mode — widget preloads in-page, no launch click');
          await page.waitForTimeout(2000);
        } else {
          const btn = page.locator(launchTarget).first();
          if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
            await btn.click({ force: true });
          } else {
            console.warn(`  [calibrate] launch target ${launchTarget} not visible — trying window.openPlaidLink()/handler.open()`);
            await page.evaluate(() => {
              if (typeof window.openPlaidLink === 'function') return window.openPlaidLink();
              if (window._plaidHandler?.open) return window._plaidHandler.open();
            });
          }
        }
        const sample = await runSample({
          page, profile, creds, experience: args.experience, screensDir,
          sampleIdx: i, timeoutS: args.timeoutS, cssOnly: args.cssOnly, agent,
        });
        sample.launchToFirstScreenMs = sample.observations[0] ? sample.observations[0].enteredAtMs - launchedAt : null;
        allSamples.push(sample);
        if (sample.completed) completedCount++;
        console.log(`  [calibrate] sample ${i + 1}: ${sample.completed ? 'COMPLETED' : 'INCOMPLETE'} — ${sample.observations.length} screens, ${sample.gaps.length} gaps`);
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }

  const { coverage, gapCount } = mergeIntoProfile(profile, allSamples, completedCount);
  appendLearnings({ experience: args.experience, appDir, allSamples, completedCount, profile });

  const report = {
    experience: args.experience,
    app: path.basename(appDir),
    at: new Date().toISOString(),
    samples: allSamples.map((s) => ({
      completed: s.completed,
      launchToFirstScreenMs: s.launchToFirstScreenMs,
      observations: s.observations,
      gaps: s.gaps,
    })),
    completedCount,
    requiredScreenCoverage: coverage,
    knowledgeGaps: gapCount,
    knowledgeConfidence: profile.knowledgeConfidence,
  };
  const reportPath = path.join(CALIBRATION_DIR, `${args.experience}-${ts}.json`);
  fs.mkdirSync(CALIBRATION_DIR, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`[calibrate] report: ${path.relative(PROJECT_ROOT, reportPath)}`);
  console.log(`[calibrate] profile confidence: ${profile.knowledgeConfidence} (coverage ${(coverage * 100).toFixed(0)}%, gaps ${gapCount})`);
  process.exit(completedCount > 0 ? 0 : 2);
}

main().catch((err) => {
  console.error(`[calibrate] FATAL: ${err.message}`);
  process.exit(2);
});
