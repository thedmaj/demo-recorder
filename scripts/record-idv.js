#!/usr/bin/env node
/**
 * record-idv.js
 * Records the Plaid Identity Verification Coast demo walkthrough using
 * Steel.dev (cloud browser) + Playwright (video capture).
 *
 * Follows the 12-step IDV script with Leslie Knope / Smith & Cedar persona.
 * Saves: public/recording.webm, out/step-timing.json
 *
 * Usage: node scripts/record-idv.js
 */

require('dotenv').config();
const Steel        = require('steel-sdk').default;
const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');

const TARGET_URL  = process.env.DEMO_URL ||
  'https://plaid.coastdemo.com/share/68a50b5fc54642a282e49c0e?zoom=100';
const PUBLIC_DIR  = path.resolve(__dirname, '../public');
const OUT_DIR     = path.resolve(__dirname, '../out');
const TIMING_FILE = path.join(OUT_DIR, 'step-timing.json');

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR,    { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

let recordingStartMs = null;
const stepTimings    = [];

function markStep(id, label) {
  const elapsedMs = Date.now() - recordingStartMs;
  stepTimings.push({ id, label, startMs: elapsedMs });
  console.log(`  [${String(Math.round(elapsedMs / 1000)).padStart(3)}s] Step: ${label}`);
}

const wait  = (page, ms) => page.waitForTimeout(ms);
const shot  = (page, name) =>
  page.screenshot({ path: path.join(PUBLIC_DIR, `${name}.png`) }).catch(() => {});

async function smoothScroll(page, deltaY, durationMs = 1000) {
  const steps = Math.max(1, Math.round(durationMs / 50));
  const stepY = deltaY / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepY);
    await page.waitForTimeout(50);
  }
}

// Traverse ALL shadow roots recursively and click a button by text.
// Required for Smith & Cedar web component (shadow DOM, not reachable via CSS selectors).
// Uses composed: true so the event crosses shadow boundaries.
async function shadowClick(page, textOptions, label) {
  const result = await page.evaluate((texts) => {
    function traverse(root) {
      for (const tag of ['button', 'a', '[role="button"]', 'input[type="submit"]']) {
        for (const el of root.querySelectorAll(tag)) {
          const t = (el.textContent || el.value || '').trim();
          if (texts.some(m => t.toLowerCase() === m.toLowerCase() || t.toLowerCase().startsWith(m.toLowerCase()))) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
              el.click();
              return { found: true, text: t, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
          }
        }
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const r = traverse(el.shadowRoot);
          if (r) return r;
        }
      }
      return null;
    }
    return traverse(document);
  }, textOptions);
  if (result && result.found) {
    console.log(`    ✓ Shadow click: "${result.text}" for ${label} at (${Math.round(result.x)}, ${Math.round(result.y)})`);
    return result;
  }
  console.log(`    ⚠ Shadow click failed: ${label}`);
  return null;
}

// Search all frames (main + iframes) for a selector
async function findInAllFrames(page, selectors, timeoutMs = 4000) {
  const frames = [page, ...page.frames().filter(f => f !== page.mainFrame())];
  for (const frame of frames) {
    for (const sel of selectors) {
      try {
        const el = frame.locator(sel).first();
        if (await el.isVisible({ timeout: timeoutMs }).catch(() => false)) {
          return el;
        }
      } catch {}
    }
  }
  return null;
}

async function tryClick(page, selectors, label, timeoutMs = 5000) {
  const el = await findInAllFrames(page, selectors, timeoutMs);
  if (el) {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click();
    console.log(`    ✓ Clicked: ${label}`);
    return true;
  }
  console.warn(`    ⚠ Not found: ${label}`);
  return false;
}

async function tryHover(page, selectors, durationMs = 500) {
  const el = await findInAllFrames(page, selectors, 2000);
  if (el) {
    await el.hover().catch(() => {});
    await page.waitForTimeout(durationMs);
    return true;
  }
  return false;
}

// Coordinate click helper — reliable for elements Playwright can't reach via selectors
async function coordClick(page, x, y, label) {
  await page.mouse.click(x, y);
  console.log(`    → Coord click: ${label} at (${x}, ${y})`);
  await page.waitForTimeout(600);
}

// The Coast Demo NEXT button sits in the bottom-right navigation bar.
// DOM scan confirmed centre at approximately (1375, 862) in 1440x900 viewport.
// The right panel content covers (1325, 830), which is why that old coord failed.
async function clickNext(page, label) {
  // Try locator by text (works if element is in regular DOM)
  const byText = page.locator('div').filter({ hasText: /^NEXT$/ }).last();
  if (await byText.isVisible({ timeout: 2000 }).catch(() => false)) {
    await byText.click();
    console.log(`    ✓ Clicked NEXT (${label}) via text locator`);
    await page.waitForTimeout(800);
    return true;
  }
  // Fallback: confirmed coord from DOM scan
  await coordClick(page, 1375, 862, `NEXT → (${label})`);
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const steelClient = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });

  console.log('Creating Steel session...');
  const session = await steelClient.sessions.create({ timeout: 900000 });

  console.log('\n── Steel Session ──────────────────────────────');
  console.log(`  ID       : ${session.id}`);
  console.log(`  Live view: ${session.sessionViewerUrl}`);
  console.log('───────────────────────────────────────────────\n');

  const browser = await chromium.connectOverCDP(
    `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`
  );

  const context = await browser.newContext({
    recordVideo: { dir: PUBLIC_DIR, size: { width: 1440, height: 900 } },
    viewport:    { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  recordingStartMs = Date.now();

  // ── Step 01 — Welcome Screen ──────────────────────────────────────────────
  markStep('01-welcome', 'Welcome Screen');
  console.log('Loading IDV demo...');
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });
  // Wait for the loading spinner to clear and hero content to render
  await wait(page, 4000);
  await page.waitForSelector('text=/identity verification/i', { timeout: 15000 }).catch(() => {});
  await wait(page, 1500);
  await shot(page, 'idv-01-welcome');
  await wait(page, 1500); // let viewer read title + trusted-by logos

  await tryHover(page, [
    'button:has-text("Get started")',
    'a:has-text("Get started")',
    'text=/get started/i',
  ], 500);

  await tryClick(page, [
    'button:has-text("Get started")',
    'a:has-text("Get started")',
    'text=/get started/i',
  ], 'Get started');
  await wait(page, 1000);

  // ── Step 03 — Configure Your Demo ────────────────────────────────────────
  await wait(page, 800);
  markStep('03-configure', 'Configure Demo');
  await shot(page, 'idv-03-configure');
  await wait(page, 2000);

  // Highlight "Fast! Data source verification only" radio
  await tryHover(page, [
    'text=/fast.*data source/i',
    'label:has-text("Fast")',
    'input[type="radio"]:first-of-type',
  ], 600);

  // Highlight "No, I already collect" radio
  await tryHover(page, [
    'text=/I already collect/i',
    'text=/No.*already collect/i',
    'label:has-text("already collect")',
  ], 600);

  await tryClick(page, [
    'button:has-text("Start")',
    'button:has-text("START")',
    'a:has-text("Start")',
  ], 'Start');
  await wait(page, 1500);

  // ── Step 07A — Sign Up Form ───────────────────────────────────────────────
  await wait(page, 800);
  markStep('07a-signup', 'Sign Up Form');
  await shot(page, 'idv-07a-signup');
  await wait(page, 1500);

  // 07a — show sign-up form (Intro tab is active)
  await shot(page, 'idv-07a-signup');
  await wait(page, 2000); // let form fully settle

  // page.getByRole() uses the accessibility tree which DOES pierce shadow DOM.
  // This is the most reliable way to find shadow DOM buttons in Playwright.
  let signupClicked = false;
  const signupBtn = page.getByRole('button', { name: 'Sign up', exact: true });
  if (await signupBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await signupBtn.click();
    console.log('    ✓ Sign up clicked via accessibility (getByRole)');
    signupClicked = true;
  }
  if (!signupClicked) {
    // Fallback: coord click with hover dwell
    await page.mouse.move(237, 665);
    await wait(page, 600);
    await page.mouse.click(237, 665);
    console.log('    → Sign up coord fallback at (237, 665)');
  }
  await wait(page, 4000); // transition can take 2-4s

  // ── Step 07B — Personal Info ──────────────────────────────────────────────
  markStep('07b-personal-info', 'Personal Info Form');
  await shot(page, 'idv-07b-personal-info');
  await wait(page, 800);

  // IDV completion detection — set up BEFORE clicking Create Account.
  // The Coast Demo backend (cape.herokuapp.com) proxies all Plaid API calls.
  // IDV completion: the initial Create Account triggers 2-3 quick cape calls,
  // then the result arrives later via a 3rd+ cape call OR WebSocket frame.
  let capeCallCount = 0;
  let idvCompleted = false;

  // HTTP response listener (catches cape.herokuapp.com polling)
  const onResponse = (response) => {
    const url = response.url();
    const status = response.status();
    if (url.match(/\.(css|js|woff2?|png|jpg|svg|ico|gif|webp|map)(\?|$)/)) return;
    const short = url.replace(/^https?:\/\//, '').substring(0, 80);
    if (url.includes('cape.herokuapp.com')) {
      capeCallCount++;
      console.log(`    [cape #${capeCallCount} ${status}] ${short}`);
      // 3rd+ cape call signals IDV result returned from Plaid
      if (capeCallCount >= 3 && status === 200) {
        idvCompleted = true;
        console.log('    ✓ IDV complete (cape call #' + capeCallCount + ')');
      }
    }
  };
  page.on('response', onResponse);

  // WebSocket listener (catches SSE/WS updates from Cape backend)
  page.on('websocket', ws => {
    console.log(`    [WS] opened: ${ws.url().substring(0, 80)}`);
    ws.on('framereceived', frame => {
      const data = frame.payload.toString();
      if (data.length > 2) {
        console.log(`    [WS] recv: ${data.substring(0, 120)}`);
        // Any WS data after Create Account likely signals form state update
        idvCompleted = true;
        console.log('    ✓ IDV complete (WebSocket frame)');
      }
    });
  });

  // Create Account: accessibility locator first, then coord
  let createClicked = false;
  const createBtn = page.getByRole('button', { name: 'Create Account', exact: true });
  if (await createBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await createBtn.click();
    console.log('    ✓ Create Account clicked via accessibility (getByRole)');
    createClicked = true;
  }
  if (!createClicked) {
    // Narrow left-aligned button, centre ≈ (149, 689) in 1440x900
    await page.mouse.move(149, 689);
    await wait(page, 400);
    await page.mouse.click(149, 689);
    console.log('    → Create Account coord fallback at (149, 689)');
  }

  // Wait for IDV backend — poll up to 120s, exit early on detection.
  // Detection: cape call #3+ (HTTP) OR WebSocket frame (SSE/WS push).
  console.log('    … Waiting for IDV backend (max 120s) …');
  let smsWaitDone = false;
  for (let poll = 1; poll <= 24 && !smsWaitDone; poll++) {
    await wait(page, 5000);
    if (idvCompleted) {
      console.log(`    ✓ IDV detected at poll ${poll} (${poll * 5}s) — capeCount=${capeCallCount}`);
      await wait(page, 2000); // allow SMS form to render
      smsWaitDone = true;
    } else {
      console.log(`    [poll ${poll}/24 ${poll * 5}s] cape=${capeCallCount} idv=${idvCompleted}`);
    }
  }
  page.off('response', onResponse);
  if (!smsWaitDone) console.log('    ⚠ IDV signal not received in 120s — proceeding anyway');
  await wait(page, 1000); // brief settle

  // ── Step 07C — SMS Confirmation ───────────────────────────────────────────
  markStep('07c-sms', 'SMS Confirmation');
  await shot(page, 'idv-07c-sms');
  await wait(page, 1500);

  // Simulate reading OTP digit boxes
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(222 + i * 37, 488);
    await wait(page, 200);
  }
  await wait(page, 500);

  // Confirm OTP
  let confirmClicked = false;
  const confirmBtn = page.getByRole('button', { name: 'Confirm', exact: true });
  if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await confirmBtn.click();
    console.log('    ✓ Confirm OTP clicked via accessibility (getByRole)');
    confirmClicked = true;
  }
  if (!confirmClicked) {
    await page.mouse.move(237, 575);
    await wait(page, 400);
    await page.mouse.click(237, 575);
    console.log('    → Confirm OTP coord fallback at (237, 575)');
  }
  await wait(page, 8000); // Account Created state can take up to 7-8s after OTP

  // ── Step 07D — Account Created ────────────────────────────────────────────
  markStep('07d-account-created', 'Account Created');
  await shot(page, 'idv-07d-account-created');
  await wait(page, 2000);


  await smoothScroll(page, 180, 800);
  await wait(page, 1000);

  await clickNext(page, 'Account Created');
  await wait(page, 3000); // allow outer demo to transition to step 08

  // ── Step 08 — Fetching IDV Data ───────────────────────────────────────────
  await wait(page, 800);
  markStep('08-backend-data', 'Fetching IDV Data');
  await shot(page, 'idv-08-backend');
  await wait(page, 2000);

  // Scroll through JSON response
  await smoothScroll(page, 300, 1500);
  await wait(page, 1000);

  await clickNext(page, 'IDV Data');
  await wait(page, 3000); // allow outer demo to transition to step 09

  // ── Step 09 — Dashboard Results ───────────────────────────────────────────
  // 9A: Trust Index + Identity Fields
  await wait(page, 800);
  markStep('09a-dashboard', 'Dashboard — Trust Index');
  await shot(page, 'idv-09a-dashboard');
  await wait(page, 2500);

  // Hover each risk score bar
  for (const label of ['behavior', 'database', 'device', 'email', 'phone', 'velocity']) {
    await tryHover(page, [`text=/${label}/i`], 300);
  }

  // 9B: Linked Accounts
  await smoothScroll(page, 300, 1200);
  markStep('09b-linked-accounts', 'Dashboard — Linked Accounts');
  await shot(page, 'idv-09b-linked');
  await wait(page, 1500);
  await wait(page, 1000);

  // 9C: Data Source Verification
  await smoothScroll(page, 300, 1200);
  markStep('09c-data-source', 'Dashboard — Data Source Verification');
  await shot(page, 'idv-09c-data-source');
  await wait(page, 2000);

  // 9D: Watchlist Screening
  await smoothScroll(page, 250, 1000);
  markStep('09d-watchlist', 'Dashboard — Watchlist Screening');
  await shot(page, 'idv-09d-watchlist');
  await wait(page, 1500);

  // 9E: Risk Check + Trust Index gauge
  await smoothScroll(page, 250, 1000);
  markStep('09e-risk-check', 'Dashboard — Risk Check');
  await shot(page, 'idv-09e-risk');
  await wait(page, 2000);

  // 9F: Behavior Analysis
  await smoothScroll(page, 200, 800);
  markStep('09f-behavior', 'Dashboard — Behavior Analysis');
  await shot(page, 'idv-09f-behavior');
  await wait(page, 1500);

  // Reveal "Session passed" text
  await smoothScroll(page, 100, 500);
  await wait(page, 1500);

  await clickNext(page, 'Dashboard');
  await wait(page, 3000); // allow outer demo to transition to step 11

  // ── Step 11 — All Set ─────────────────────────────────────────────────────
  await wait(page, 800);
  markStep('11-all-set', 'All Set — Verified');
  await shot(page, 'idv-11-all-set');
  await wait(page, 2500);

  await clickNext(page, 'All Set');
  await wait(page, 3000); // allow outer demo to transition to step 12

  // ── Step 12 — CTA Outro ───────────────────────────────────────────────────
  await wait(page, 800);
  markStep('12-cta', 'CTA — Book a Meeting');
  await shot(page, 'idv-12-cta');
  await wait(page, 2000);

  // Hover "Book a meeting" — do NOT click
  await tryHover(page, [
    'button:has-text("Book a meeting")',
    'a:has-text("Book a meeting")',
    'text=/book a meeting/i',
  ], 800);

  await shot(page, 'idv-12-cta-hover');
  await wait(page, 1500); // hold on final CTA

  // ── Teardown ──────────────────────────────────────────────────────────────
  const videoPath = await page.video()?.path().catch(() => null);
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  await steelClient.sessions.release(session.id).catch(() => {});

  if (videoPath && fs.existsSync(videoPath)) {
    fs.renameSync(videoPath, path.join(PUBLIC_DIR, 'recording.webm'));
    console.log('\n✓ Video: public/recording.webm');
  } else {
    console.warn('\n⚠ Video not found — check public/ for a .webm file');
  }

  // Compute per-step durations and frame numbers
  const totalMs = Date.now() - recordingStartMs;
  for (let i = 0; i < stepTimings.length; i++) {
    const next = stepTimings[i + 1];
    stepTimings[i].endMs         = next ? next.startMs : totalMs;
    stepTimings[i].durationMs    = stepTimings[i].endMs - stepTimings[i].startMs;
    stepTimings[i].startFrame    = Math.round(stepTimings[i].startMs  / 1000 * 30);
    stepTimings[i].endFrame      = Math.round(stepTimings[i].endMs    / 1000 * 30);
    stepTimings[i].durationFrames = stepTimings[i].endFrame - stepTimings[i].startFrame;
  }

  fs.writeFileSync(TIMING_FILE, JSON.stringify(
    { totalMs, totalFrames: Math.round(totalMs / 1000 * 30), steps: stepTimings }, null, 2
  ));
  console.log('✓ Timing: out/step-timing.json');
  console.log(`\nTotal: ${(totalMs / 1000).toFixed(1)}s — Next: node scripts/generate-voiceover.js\n`);
}

main().catch(err => {
  console.error('Recording failed:', err.message);
  process.exit(1);
});
