#!/usr/bin/env node
/**
 * Plaid Coast Demo recorder.
 * Records a walkthrough of the Plaid use case demo, selecting Instant Auth
 * and completing sandbox bank authentication.
 *
 * Usage: npm run record
 */

require('dotenv').config({ quiet: true });
const Steel = require('steel-sdk').default;
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET_URL = process.env.DEMO_URL ||
  'https://plaid.coastdemo.com/share/67d0ce0df465686c02cc4fd2?zoom=100';

// How long to pause on each slide so a viewer can read it (ms)
const READ_PAUSE = 3500;

// Plaid sandbox credentials
const PLAID_USERNAME = 'user_good';
const PLAID_PASSWORD = 'pass_good';

async function clickNext(page, stepLabel) {
  console.log(`  Waiting for Next button (${stepLabel})...`);
  // Coast demo uses uppercase "NEXT" in bottom-right corner
  const nextSelectors = [
    'button:has-text("NEXT")',
    'button:has-text("Next")',
    'text=/next/i',
    '[aria-label="Next"]',
    'button:has-text("Continue")',
    '.next-button',
    '[data-testid="next"]',
  ];

  for (const sel of nextSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      console.log(`  ✓ Clicked Next (${stepLabel})`);
      await page.waitForTimeout(1000); // let transition animate
      return true;
    }
  }
  console.warn(`  ⚠ No Next button found at step: ${stepLabel}`);
  return false;
}

async function main() {
  const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });

  console.log('Creating Steel session...');
  const session = await client.sessions.create({ timeout: 600000 }); // 10 min

  console.log('\n── Session created ──────────────────────────');
  console.log(`Session ID : ${session.id}`);
  console.log(`Live view  : ${session.sessionViewerUrl}`);
  console.log('─────────────────────────────────────────────');
  console.log('Open the Live view URL in your browser to watch the recording.\n');

  const browser = await chromium.connectOverCDP(
    `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`
  );

  // ── Local video recording via Playwright ──────────────────────────────────
  // Creates a new context on the Steel browser with video capture enabled.
  // The video saves to public/ automatically when the context closes.
  const recordingDir = path.resolve('public');
  const context = await browser.newContext({
    recordVideo: { dir: recordingDir, size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  // ── 1. Load the demo ───────────────────────────────────────────────────────
  console.log('Loading demo...');
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(READ_PAUSE);
  await page.screenshot({ path: 'public/step-01-loaded.png' });
  console.log('✓ Page loaded');

  // ── 2. Click "Get started" on the welcome slide ───────────────────────────
  console.log('Clicking Get started...');
  const getStarted = page.locator('button:has-text("Get started"), a:has-text("Get started")').first();
  if (await getStarted.isVisible({ timeout: 5000 }).catch(() => false)) {
    await getStarted.click();
    console.log('✓ Clicked Get started');
    await page.waitForTimeout(1000);
  }

  // ── 3. Navigate through intro slides ──────────────────────────────────────
  for (let i = 1; i <= 6; i++) {
    await page.waitForTimeout(READ_PAUSE);
    await page.screenshot({ path: `public/step-slide-${i}.png` }).catch(() => {});
    const advanced = await clickNext(page, `slide ${i}`);
    if (!advanced) break;
  }

  // ── 3. Select "Instant Auth" ───────────────────────────────────────────────
  console.log('\nLooking for Instant Auth option...');
  await page.waitForTimeout(READ_PAUSE);

  const instantAuthSelectors = [
    'text=/instant auth/i',
    'button:has-text("Instant Auth")',
    'button:has-text("INSTANT AUTH")',
    '[data-testid="instant-auth"]',
    'label:has-text("Instant Auth")',
    ':has-text("Instant Auth") >> button',
    ':has-text("Instant Auth") >> nth=0',
  ];

  let selectedInstantAuth = false;
  for (const sel of instantAuthSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await el.click();
      console.log('✓ Selected Instant Auth');
      selectedInstantAuth = true;
      await page.waitForTimeout(1000);
      break;
    }
  }
  if (!selectedInstantAuth) {
    console.warn('⚠ Could not find Instant Auth — check public/step-instant-auth.png');
  }
  await page.screenshot({ path: 'public/step-instant-auth.png' }).catch(() => {});

  // ── 4. Click NEXT through the Instant Auth intro slide ───────────────────
  await page.waitForTimeout(READ_PAUSE);
  await clickNext(page, 'Instant Auth intro slide');

  // ── 5. Now on the interactive demo slide — wait for Oryn Finance iframe ──
  console.log('\nWaiting for interactive demo slide to load...');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'public/step-interactive-demo.png' }).catch(() => {});

  // The "Connect with Plaid" button lives inside the Oryn Finance demo iframe
  // Find it by searching all frames for the button
  let demoFrame = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const allFrames = page.frames();
    console.log(`  Frames found: ${allFrames.map(f => f.url()).join(', ')}`);
    demoFrame = allFrames.find(f =>
      f.url().includes('oryn') ||
      f.url().includes('demo') ||
      f.url().includes('coastdemo') ||
      (f.url() !== page.url() && f.url() !== 'about:blank' && f.url() !== '')
    );
    if (demoFrame) break;
    await page.waitForTimeout(2000);
    console.log(`  Waiting for demo iframe... (attempt ${attempt + 1})`);
  }

  // ── 6. Click "Connect with Plaid" on the main page ───────────────────────
  // The button text is "Connect with" + a Plaid logo image, so we match on
  // partial text "Connect with" or find the black button in the demo widget.
  console.log('\nLooking for Connect with Plaid button...');
  let clickedConnect = false;

  // The demo widget uses divs/anchors with onclick handlers, not <button> elements
  const connectSelectors = [
    'text=/connect with/i',
    '[class*="connect" i]',
    'a:has-text("Connect")',
    'div:has-text("Connect with") >> nth=-1',
    'span:has-text("Connect with")',
    '[role="button"]:has-text("Connect")',
  ];

  for (const sel of connectSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await el.click();
        console.log(`✓ Clicked "${sel}"`);
        clickedConnect = true;
        break;
      }
    } catch {}
  }

  // Last resort: click by coordinates where the button appears in the screenshot
  // (~379, 535 in a 1366x768 viewport scaled for the left demo panel)
  if (!clickedConnect) {
    console.warn('⚠ Falling back to coordinate click on Connect with Plaid button');
    const vp = page.viewportSize();
    // Button is roughly 25% from left, 72% from top of viewport
    await page.mouse.click(Math.round((vp?.width ?? 1366) * 0.25), Math.round((vp?.height ?? 768) * 0.72));
    console.log('✓ Coordinate click sent');
    clickedConnect = true;
  }

  // ── 7. Wait for Plaid Link iframe to appear ────────────────────────────────
  console.log('\nWaiting for Plaid Link to open...');
  await page.waitForTimeout(4000);

  let plaidFrame = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const allFrames = page.frames();
    plaidFrame = allFrames.find(f =>
      f.url().includes('plaid.com') || f.url().includes('cdn.plaid')
    );
    if (plaidFrame) break;
    await page.waitForTimeout(2000);
    console.log(`  Waiting for Plaid iframe... (attempt ${attempt + 1})`);
  }

  if (plaidFrame) {
    console.log(`✓ Plaid Link iframe detected: ${plaidFrame.url()}`);
    await handlePlaidLink(plaidFrame, page);
  } else {
    const popup = await page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
    if (popup) {
      console.log('✓ Plaid Link popup detected');
      await handlePlaidLink(popup, page);
    } else {
      console.warn('⚠ No Plaid Link iframe found — check public/step-interactive-demo.png');
    }
  }

  // ── 7. Post-auth: wait then continue through remaining slides ─────────────
  console.log('\nContinuing through remaining demo slides...');
  await page.waitForTimeout(READ_PAUSE);
  for (let i = 1; i <= 6; i++) {
    await page.screenshot({ path: `public/step-post-auth-${i}.png` }).catch(() => {});
    const advanced = await clickNext(page, `post-auth slide ${i}`);
    if (!advanced) break;
    await page.waitForTimeout(READ_PAUSE);
  }

  await page.waitForTimeout(READ_PAUSE).catch(() => {});
  await page.screenshot({ path: 'public/step-final.png' }).catch(() => {});
  console.log('✓ Final screenshot saved');

  // Retrieve the video path before closing the context
  const videoPath = await page.video()?.path().catch(() => null);

  await context.close().catch(() => {}); // flushes video to disk
  await browser.close().catch(() => {});
  await client.sessions.release(session.id).catch(() => {});

  // Rename the video to a predictable filename
  if (videoPath && fs.existsSync(videoPath)) {
    const dest = path.join(recordingDir, 'recording.webm');
    fs.renameSync(videoPath, dest);
    console.log(`\n✓ Video saved: public/recording.webm`);
  } else {
    console.warn('\n⚠ Video file not found — check public/ for a .webm file');
  }

  console.log('\n── Recording complete ───────────────────────');
  console.log(`Session ID : ${session.id}`);
  console.log('Video saved to: public/recording.webm');
  console.log('Next: npm run studio');
  console.log('─────────────────────────────────────────────\n');
}

async function handlePlaidLink(context, mainPage) {
  const pause = (ms) => mainPage.waitForTimeout(ms);
  const shot = (name) => mainPage.screenshot({ path: `public/${name}.png` }).catch(() => {});
  const visible = (loc, ms = 5000) => loc.isVisible({ timeout: ms }).catch(() => false);

  try {
    await pause(3000); // let iframe fully render
    await shot('plaid-01-open');

    // ── Step A: Consent screen — click "Continue" ──────────────────────────
    console.log('  [Plaid] Checking for consent screen...');
    const continueOnConsent = context.locator('button:has-text("Continue")').first();
    if (await visible(continueOnConsent, 6000)) {
      await continueOnConsent.click();
      console.log('  [Plaid] ✓ Clicked Continue on consent screen');
      await pause(2000);
      await shot('plaid-02-post-consent');
    }

    // ── Step B: Institution search ─────────────────────────────────────────
    console.log('  [Plaid] Waiting for institution search...');
    const searchBox = context.locator('input').first();
    if (await visible(searchBox, 8000)) {
      await searchBox.fill('First Platypus');
      console.log('  [Plaid] Typed "First Platypus"');
      await pause(1500);
      await shot('plaid-03-search');

      // Click the top-level "First Platypus Bank" result in the search list
      const bankResult = context.locator('text=/first platypus bank/i').first();
      if (await visible(bankResult, 4000)) {
        await bankResult.click();
        console.log('  [Plaid] ✓ Clicked First Platypus Bank from search');
      }
    } else {
      console.warn('  [Plaid] ⚠ Search box not found — trying featured banks');
      const ally = context.locator('text=/ally/i').first();
      if (await visible(ally, 4000)) {
        await ally.click();
        console.log('  [Plaid] ✓ Selected Ally');
      }
    }

    // ── Step B2: Sub-institution selection (non-OAuth variant) ────────────
    await pause(2000);
    await shot('plaid-04-sub-selection');

    // Three options appear: "First Platypus Bank", "...OAuth", "...OAuth App2App"
    // We want the plain (non-OAuth) one — it's an exact match for "First Platypus Bank"
    const subOptions = context.locator('li, [role="option"], [role="button"]');
    const subCount = await subOptions.count().catch(() => 0);
    console.log(`  [Plaid] Sub-options found: ${subCount}`);

    if (subCount > 0) {
      // Click the first option (plain "First Platypus Bank", not OAuth)
      await subOptions.first().click();
      console.log('  [Plaid] ✓ Selected sub-institution (First Platypus Bank)');
    } else {
      // Try exact text match
      const plainBank = context.locator('text="First Platypus Bank"').first();
      if (await visible(plainBank, 3000)) {
        await plainBank.click();
        console.log('  [Plaid] ✓ Selected First Platypus Bank (exact match)');
      }
    }

    await pause(3000);
    await shot('plaid-05-bank-selected');

    // ── Step C: Credentials screen ────────────────────────────────────────
    console.log('  [Plaid] Entering credentials...');
    const inputs = context.locator('input');
    const inputCount = await inputs.count().catch(() => 0);
    console.log(`  [Plaid] Input fields found: ${inputCount}`);

    if (inputCount >= 2) {
      await inputs.nth(0).fill(PLAID_USERNAME);
      console.log('  [Plaid] ✓ Username entered');
      await inputs.nth(1).fill(PLAID_PASSWORD);
      console.log('  [Plaid] ✓ Password entered');
    } else if (inputCount === 1) {
      await inputs.nth(0).fill(PLAID_USERNAME);
      console.log('  [Plaid] ✓ Single field filled (username)');
    } else {
      console.warn('  [Plaid] ⚠ No input fields found on credential screen');
    }

    await shot('plaid-05-credentials');

    const submitBtn = context.locator('button[type="submit"], button:has-text("Submit"), button:has-text("Log in"), button:has-text("Sign in")').first();
    if (await visible(submitBtn, 3000)) {
      await submitBtn.click();
      console.log('  [Plaid] ✓ Credentials submitted');
    }

    // ── Step D: Wait for account selection screen ────────────────────────
    console.log('  [Plaid] Waiting for account selection screen...');
    await pause(7000); // allow credential validation + screen transition
    await shot('plaid-06-post-login');

    // ── Step E: MFA if prompted (single non-checkbox input = MFA) ────────
    const postLoginInputs = await context.locator('input').count().catch(() => 0);
    if (postLoginInputs === 1) {
      const singleInput = context.locator('input').first();
      const inputType = await singleInput.getAttribute('type').catch(() => '');
      if (inputType !== 'checkbox') {
        console.log('  [Plaid] MFA prompted — entering 1234...');
        await singleInput.fill('1234');
        const mfaSubmit = context.locator('button[type="submit"], button:has-text("Submit"), button:has-text("Continue")').first();
        if (await visible(mfaSubmit, 2000)) {
          await mfaSubmit.click();
          console.log('  [Plaid] ✓ MFA submitted');
        }
        await pause(4000);
        await shot('plaid-07-post-mfa');
      }
    }

    // ── Step F: Select account — radio buttons or checkboxes ─────────────
    await shot('plaid-07-account-screen');

    // Try radio buttons first (Plaid uses radio for single-select)
    const radios = context.locator('input[type="radio"]');
    const radioCount = await radios.count().catch(() => 0);
    console.log(`  [Plaid] Radio buttons found: ${radioCount}`);

    if (radioCount > 0) {
      // Use evaluate to fire a real DOM click inside the iframe — works with React
      const clicked = await context.evaluate(() => {
        const radio = document.querySelector('input[type="radio"]');
        if (radio) {
          radio.click();
          // Also fire on the parent label if present
          const label = radio.closest('label') || radio.parentElement;
          if (label) label.click();
          return true;
        }
        return false;
      }).catch(() => false);
      console.log(`  [Plaid] ✓ Radio click via evaluate: ${clicked}`);
      await pause(1500);
      await shot('plaid-08-account-selected');
    } else {
      const checkboxes = context.locator('input[type="checkbox"]');
      const cbCount = await checkboxes.count().catch(() => 0);
      if (cbCount > 0) {
        await context.evaluate(() => {
          const cb = document.querySelector('input[type="checkbox"]');
          if (cb) { cb.click(); const lbl = cb.closest('label') || cb.parentElement; if (lbl) lbl.click(); }
        }).catch(() => {});
        console.log('  [Plaid] ✓ Selected first account (checkbox evaluate)');
        await pause(1500);
        await shot('plaid-08-account-selected');
      } else {
        console.log('  [Plaid] No account inputs found — accounts may be pre-selected');
      }
    }

    // ── Step G: Wait for #aut-button to become enabled, then click ────────
    console.log('  [Plaid] Waiting for Continue to enable...');
    await context.locator('#aut-button:not([disabled]):not([aria-disabled="true"])').waitFor({ timeout: 15000 }).catch(() => {
      console.warn('  [Plaid] ⚠ Continue button did not enable — clicking with force');
    });

    const doneBtn = context.locator('#aut-button').first();
    if (await visible(doneBtn, 3000)) {
      await doneBtn.click({ force: true });
      console.log('  [Plaid] ✓ Clicked Continue');
    }

    await pause(4000);
    await shot('plaid-09-complete');
    console.log('  [Plaid] ✓ Bank account linking complete');

  } catch (err) {
    console.warn('  [Plaid] ⚠ Error:', err.message);
    await mainPage.screenshot({ path: 'public/plaid-error.png' }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('Recording failed:', err.message);
  process.exit(1);
});
