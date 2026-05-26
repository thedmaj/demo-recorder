#!/usr/bin/env node
'use strict';
/**
 * record-plaid-manual.js — Layer 3 of the Plaid Link recipe system.
 *
 * Launches a headed Playwright session against a self-contained harness
 * page that opens Plaid Link in sandbox. Captures every operator click +
 * fill across the host page and inside the cross-origin Plaid iframe via
 * `context.addInitScript`, then emits a recipe JSON when the operator
 * presses ESC (or hits the "Save recipe" button on the overlay).
 *
 * Output: inputs/plaid-recipes/{flow}.json
 *   • Existing file (if any) is rotated to inputs/plaid-recipes/_backups/
 *     before write — backups are gitignored.
 *
 * Per-screen `dwellBeforeMs` / `dwellAfterMs` are derived from real
 * wall-clock gaps between operator clicks (capped at 4s to avoid
 * accidentally recording bathroom breaks).
 *
 * Usage:
 *   node scripts/scratch/scratch/record-plaid-manual.js --flow=remember-me
 *   node scripts/scratch/scratch/record-plaid-manual.js --flow=standard --institution=ins_109508
 *   node scripts/scratch/scratch/record-plaid-manual.js --flow=oauth --phone=+14155550000
 *
 * Hotkeys (in the floating overlay):
 *   • Click "Save recipe"  → write recipe + close browser
 *   • Click "Discard"      → exit without writing
 *   • ESC                  → save + close
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const RECIPES_DIR = path.join(PROJECT_ROOT, 'inputs', 'plaid-recipes');
const BACKUPS_DIR = path.join(RECIPES_DIR, '_backups');

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET    = process.env.PLAID_SECRET;
const PLAID_ENV       = process.env.PLAID_ENV || 'sandbox';
const PLAID_HOST      = PLAID_ENV === 'sandbox'
  ? 'https://sandbox.plaid.com'
  : (PLAID_ENV === 'development' ? 'https://development.plaid.com' : 'https://production.plaid.com');

// Maximum gap (ms) between captured events that we treat as a "natural
// pause". Anything beyond this is clamped — the operator probably stepped
// away from the keyboard, that pause shouldn't end up in production.
const MAX_NATURAL_DWELL_MS = 4000;

function parseArgs(argv) {
  const out = { flow: 'remember-me', institution: null, phone: null, otp: null,
    username: 'user_good', password: 'pass_good' };
  for (const a of argv) {
    if (a.startsWith('--flow=')) out.flow = a.slice('--flow='.length);
    else if (a.startsWith('--institution=')) out.institution = a.slice('--institution='.length);
    else if (a.startsWith('--phone=')) out.phone = a.slice('--phone='.length);
    else if (a.startsWith('--otp=')) out.otp = a.slice('--otp='.length);
    else if (a.startsWith('--username=')) out.username = a.slice('--username='.length);
    else if (a.startsWith('--password=')) out.password = a.slice('--password='.length);
  }
  // Sensible defaults per flow type
  if (out.flow === 'remember-me') {
    out.institution = out.institution || 'ins_109511';   // Tartan Bank
    out.phone = out.phone || '+14155550011';
    out.otp = out.otp || '123456';
  } else if (out.flow === 'oauth') {
    out.institution = out.institution || 'ins_127287';   // Platypus OAuth
    out.phone = out.phone || '+14155550000';
  } else {
    out.institution = out.institution || 'ins_109508';   // First Platypus
    out.phone = out.phone || '+14155550000';
  }
  return out;
}

function isoNow() { return new Date().toISOString(); }

async function createSandboxLinkToken(products = ['transactions']) {
  if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
    throw new Error('PLAID_CLIENT_ID + PLAID_SECRET must be set in .env to create a Link token.');
  }
  const body = {
    client_id: PLAID_CLIENT_ID,
    secret: PLAID_SECRET,
    client_name: 'Plaid Recipe Recorder',
    products,
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: `recipe-recorder-${Date.now()}` },
  };
  const res = await fetch(`${PLAID_HOST}/link/token/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/link/token/create failed (${res.status}): ${text}`);
  }
  const j = await res.json();
  return j.link_token;
}

function buildHarnessHtml(linkToken, flow) {
  // Single-file harness page that loads the Plaid Web SDK, opens the
  // modal automatically, and renders an instructions overlay so the
  // operator knows what flow they're recording.
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Plaid Recipe Recorder · ${flow}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 40px;
         background: #0a0a16; color: #e8e8f0; }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 500; }
  .flow { color: #42F0CD; font-weight: 600; }
  .instructions { background: #14142a; padding: 24px; border-radius: 12px; max-width: 680px;
                  border: 1px solid #2a2a4a; margin-bottom: 24px; }
  .instructions li { margin: 8px 0; line-height: 1.4; }
  button#open { background: #42F0CD; color: #0a0a16; border: 0; padding: 14px 28px;
                font-size: 16px; font-weight: 600; border-radius: 8px; cursor: pointer; }
</style>
</head><body>
  <h1>Plaid Recipe Recorder — <span class="flow">${flow}</span></h1>
  <div class="instructions">
    <p><strong>Click "Open Plaid Link" below, then click through the entire flow as a real user would.</strong></p>
    <ol>
      <li>Every click and fill is captured along with the wall-clock dwell between them.</li>
      <li>The Plaid iframe (cross-origin) is captured too — the recorder injects into all frames.</li>
      <li>When you reach the success screen, the recipe is auto-saved. Or click <em>Save</em> in the floating overlay.</li>
      <li>Press <kbd>Esc</kbd> at any time to save what you have so far.</li>
    </ol>
  </div>
  <button id="open">Open Plaid Link</button>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <script>
    const handler = Plaid.create({
      token: ${JSON.stringify(linkToken)},
      onSuccess: (public_token, metadata) => {
        window.__recipeSuccess = true;
        document.title = 'SUCCESS · Plaid Recipe Recorder';
        try { console.log('[RECIPE-CAPTURE]' + JSON.stringify({ kind: 'success', metadata, t: Date.now() })); } catch (_) {}
      },
      onExit: (err, metadata) => {
        try { console.log('[RECIPE-CAPTURE]' + JSON.stringify({ kind: 'exit', err, metadata, t: Date.now() })); } catch (_) {}
      },
      onEvent: (eventName, metadata) => {
        try { console.log('[RECIPE-CAPTURE]' + JSON.stringify({ kind: 'plaidEvent', eventName, metadata, t: Date.now() })); } catch (_) {}
      },
    });
    document.getElementById('open').addEventListener('click', () => handler.open());
  </script>
</body></html>`;
}

// This script runs INSIDE every frame (host + Plaid iframe) via
// context.addInitScript. It captures clicks and input fills, ranks
// selectors, and emits a tagged console.log line that the Node
// recorder process tails via page.on('console').
function buildCaptureScript() {
  return `
(() => {
  if (window.__recipeCaptureInstalled) return;
  window.__recipeCaptureInstalled = true;

  function escAttr(v) { return String(v).replace(/"/g, '\\\\"'); }

  function rankedSelectorsFor(el) {
    if (!el || el.nodeType !== 1) return [];
    const sels = [];
    // 1. data-testid
    if (el.dataset && el.dataset.testid) sels.push('[data-testid="' + escAttr(el.dataset.testid) + '"]');
    // 2. id
    if (el.id) sels.push('#' + CSS.escape(el.id));
    // 3. aria-label
    const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    if (ariaLabel) sels.push(el.tagName.toLowerCase() + '[aria-label="' + escAttr(ariaLabel) + '"]');
    // 4. role + accessible name (heuristic via textContent)
    const role = el.getAttribute && el.getAttribute('role');
    if (role) sels.push(el.tagName.toLowerCase() + '[role="' + escAttr(role) + '"]');
    // 5. type attribute (inputs)
    if (el.tagName === 'INPUT') {
      const t = el.getAttribute('type');
      if (t) sels.push('input[type="' + escAttr(t) + '"]');
      const im = el.getAttribute('inputmode');
      if (im) sels.push('input[inputmode="' + escAttr(im) + '"]');
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) sels.push('input[placeholder*="' + escAttr(placeholder.slice(0, 20)) + '" i]');
    }
    // 6. button:has-text("…") (button only)
    if (el.tagName === 'BUTTON') {
      const text = (el.textContent || '').trim().slice(0, 40);
      if (text) sels.push('button:has-text("' + escAttr(text) + '")');
    }
    // 7. tagName + first-of-type
    sels.push(el.tagName.toLowerCase() + ':first-of-type');
    // Dedup
    return Array.from(new Set(sels));
  }

  function snapshot(el) {
    if (!el || el.nodeType !== 1) return null;
    return {
      tag: el.tagName,
      text: (el.textContent || '').trim().slice(0, 80),
      sels: rankedSelectorsFor(el),
      visible: !!(el.offsetParent || el === document.body),
    };
  }

  function emit(payload) {
    try {
      console.log('[RECIPE-CAPTURE]' + JSON.stringify({
        ...payload,
        frameUrl: location.href,
        t: Date.now(),
      }));
    } catch (_) {}
  }

  document.addEventListener('click', (e) => {
    let el = e.target;
    // Walk up to the nearest interactive ancestor (li, button) if we
    // landed on a child like svg / span inside a button.
    while (el && el !== document.body && !['BUTTON','LI','A','INPUT','LABEL'].includes(el.tagName)) {
      el = el.parentElement;
    }
    emit({ kind: 'click', element: snapshot(el || e.target),
            position: { x: e.clientX, y: e.clientY } });
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'INPUT') return;
    emit({ kind: 'fill', element: snapshot(el), value: String(el.value || '').slice(0, 64) });
  }, true);

  // Mark when the document changes — useful for screen-arrival detection
  // when we replay this recipe.
  if (window.MutationObserver) {
    let lastFireMs = 0;
    const obs = new MutationObserver(() => {
      const now = Date.now();
      if (now - lastFireMs < 500) return;
      lastFireMs = now;
      emit({ kind: 'mutation', visibleHeadings: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 3).map((h) => (h.textContent || '').trim().slice(0, 60)) });
    });
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
})();
`;
}

function buildOverlayScript() {
  // Floating overlay on the harness page (host frame only). Shows the
  // captured click count and exposes a "Save" button that toggles a flag
  // the Node recorder polls.
  return `
(() => {
  if (window.__recipeOverlayInstalled) return;
  window.__recipeOverlayInstalled = true;
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#14142a;color:#e8e8f0;border:1px solid #2a2a4a;border-radius:8px;padding:12px 16px;font-family:-apple-system,sans-serif;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,0.5);max-width:280px;';
  el.innerHTML = '<div style="margin-bottom:8px;font-weight:600;color:#42F0CD;">RECIPE RECORDER</div>' +
                 '<div id="__recCount">0 events captured</div>' +
                 '<div style="margin-top:10px;display:flex;gap:6px;">' +
                 '<button id="__recSave" style="flex:1;background:#42F0CD;color:#0a0a16;border:0;padding:6px 10px;border-radius:4px;cursor:pointer;font-weight:600;">Save</button>' +
                 '<button id="__recDiscard" style="flex:1;background:#3a3a5a;color:#e8e8f0;border:0;padding:6px 10px;border-radius:4px;cursor:pointer;">Discard</button>' +
                 '</div>' +
                 '<div style="margin-top:8px;font-size:11px;opacity:0.6;">ESC also saves.</div>';
  document.body.appendChild(el);
  let count = 0;
  const orig = console.log;
  console.log = (...args) => {
    if (args[0] && typeof args[0] === 'string' && args[0].startsWith('[RECIPE-CAPTURE]')) {
      count += 1;
      const c = document.getElementById('__recCount');
      if (c) c.textContent = count + ' events captured';
    }
    return orig.apply(console, args);
  };
  document.getElementById('__recSave').addEventListener('click', () => { window.__recipeShouldSave = true; });
  document.getElementById('__recDiscard').addEventListener('click', () => { window.__recipeShouldDiscard = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__recipeShouldSave = true; });
})();
`;
}

// ── Recipe synthesis ────────────────────────────────────────────────────

const PLAID_FRAME_HINTS = ['plaid.com', 'cdn.plaid.com', 'production.plaid.com', 'sandbox.plaid.com'];
function isPlaidFrame(url) {
  if (!url) return false;
  return PLAID_FRAME_HINTS.some((h) => url.includes(h));
}

/**
 * Group captured events into "screens" by:
 *   1. Plaid TRANSITION_VIEW events break a screen.
 *   2. A 1.5s+ idle gap with intervening mutation also breaks.
 */
function groupIntoScreens(events) {
  const screens = [];
  let current = { events: [] };
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const prev = events[i - 1];
    if (e.kind === 'plaidEvent' && e.eventName === 'TRANSITION_VIEW') {
      if (current.events.length > 0) { screens.push(current); current = { events: [] }; }
      current.transitionViewMetadata = e.metadata;
      continue;
    }
    if (prev && e.kind !== 'plaidEvent' && (e.t - prev.t) > 1500
        && e.kind !== 'mutation' && current.events.some((x) => x.kind !== 'mutation')) {
      screens.push(current);
      current = { events: [] };
    }
    current.events.push(e);
  }
  if (current.events.length > 0) screens.push(current);
  return screens;
}

function nameScreen(screen, idx, flow) {
  if (screen.transitionViewMetadata && screen.transitionViewMetadata.view_name) {
    return screen.transitionViewMetadata.view_name.toLowerCase().replace(/_/g, '-');
  }
  // Heuristic naming based on the first action's element
  for (const e of screen.events) {
    if (e.kind === 'fill' && e.element && e.element.tag === 'INPUT') {
      const sel = (e.element.sels || []).join(' ').toLowerCase();
      if (sel.includes('tel') || sel.includes('phone')) return 'phone-entry';
      if (sel.includes('numeric') || sel.includes('one-time')) return 'otp-screen';
      if (sel.includes('search') || sel.includes('bank')) return 'institution-search';
      if (sel.includes('username') || sel.includes('user')) return 'credentials';
    }
    if (e.kind === 'click' && e.element) {
      const text = (e.element.text || '').toLowerCase();
      if (text.includes('confirm') || text.includes('link account')) return 'confirm';
      if (text.includes('continue') && idx === 0) return 'consent';
      if (text.includes('finish without saving') || text.includes('no thanks')) return 'save-with-plaid';
    }
  }
  return `screen-${String(idx + 1).padStart(2, '0')}`;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function synthesizeRecipe(args, capturedEvents) {
  const screens = groupIntoScreens(capturedEvents);
  const recipeScreens = [];
  for (let si = 0; si < screens.length; si++) {
    const s = screens[si];
    const id = nameScreen(s, si, args.flow);
    const interactive = s.events.filter((e) => e.kind === 'click' || e.kind === 'fill');
    if (interactive.length === 0) continue;

    const primarySelectors = {};
    const actions = [];
    let prevT = null;
    for (let ai = 0; ai < interactive.length; ai++) {
      const e = interactive[ai];
      const sels = (e.element && e.element.sels) || [];
      if (sels.length === 0) continue;
      const targetKey = `${e.element.tag.toLowerCase()}-${ai + 1}`;
      const fallbackKeys = [];
      primarySelectors[targetKey] = sels[0];
      for (let fi = 1; fi < Math.min(sels.length, 4); fi++) {
        const fkey = `${targetKey}-alt${fi}`;
        primarySelectors[fkey] = sels[fi];
        fallbackKeys.push(fkey);
      }
      const dwellBeforeMs = prevT == null ? 0 : clamp(e.t - prevT, 0, MAX_NATURAL_DWELL_MS);
      // dwellAfter is filled in on the next iteration's prevT calc; for
      // the last action we use the screen-tail gap or a 1500ms default.
      const action = {
        type: e.kind,                          // 'click' | 'fill'
        target: targetKey,
        ...(fallbackKeys.length > 0 ? { fallbackTargets: fallbackKeys } : {}),
        ...(e.kind === 'fill' ? { value: resolveCapturedValue(e.value, args) } : {}),
        dwellBeforeMs,
        dwellAfterMs: 1500,                    // tentative; rewritten below
      };
      actions.push(action);
      prevT = e.t;
    }
    // Set dwellAfterMs on each action from the gap to the *next* action.
    for (let ai = 0; ai < actions.length - 1; ai++) {
      actions[ai].dwellAfterMs = actions[ai + 1].dwellBeforeMs || 1500;
      actions[ai + 1].dwellBeforeMs = 0;       // dwell now lives on the predecessor
    }

    recipeScreens.push({
      id,
      narrationHint: '',                       // operator fills in
      primarySelectors,
      actions,
      arrivalSignals: actions[0]
        ? [{ type: 'frameLocator', selector: primarySelectors[actions[0].target] }]
        : [],
      transitionSignals: [{ type: 'plaidEvent', name: 'TRANSITION_VIEW', minCount: 1 }],
    });
  }

  return {
    flowType: args.flow,
    description: `Manually recorded ${args.flow} flow.`,
    institution: { id: args.institution, name: '', isOAuth: args.flow === 'oauth' },
    credentials: {
      phone: args.phone || '',
      otp: args.otp || '',
      username: args.username,
      password: args.password,
    },
    recordedAt: isoNow(),
    recordedBy: `record-plaid-manual --flow=${args.flow}`,
    playwrightVersion: (() => { try { return require('playwright/package.json').version; } catch (_) { return null; } })(),
    verifiedRuns: 0,
    lastVerifiedAt: null,
    lastBrokenAt: null,
    candidateSelectors: [],
    screens: recipeScreens,
    totalEstimatedDwellMs: recipeScreens.reduce((sum, s) =>
      sum + s.actions.reduce((ss, a) => ss + (a.dwellBeforeMs || 0) + (a.dwellAfterMs || 0), 0), 0),
    _notes: [
      'Auto-generated from a manual record session. Operator should:',
      '  1. Fill in narrationHint on each screen.',
      '  2. Verify primarySelectors picked the right ranking (data-testid > id > aria-label > …).',
      '  3. Replay via Layer 2 executor to bump verifiedRuns.',
    ],
  };
}

/**
 * If captured fill value is the same as a credential we passed in, write
 * a ${credentials.x} template instead of the literal — keeps the recipe
 * portable across personas.
 */
function resolveCapturedValue(captured, args) {
  if (captured === args.phone) return '${credentials.phone}';
  if (captured === args.otp) return '${credentials.otp}';
  if (captured === args.username) return '${credentials.username}';
  if (captured === args.password) return '${credentials.password}';
  return captured;
}

function backupExistingRecipe(flow) {
  const target = path.join(RECIPES_DIR, `${flow}.json`);
  if (!fs.existsSync(target)) return null;
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const ts = isoNow().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUPS_DIR, `${flow}-${ts}.json.bak`);
  fs.copyFileSync(target, backupPath);
  return backupPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[recorder] Flow: ${args.flow}, institution: ${args.institution}, phone: ${args.phone || '(none)'}`);

  console.log('[recorder] Requesting sandbox /link/token/create...');
  const products = (args.flow === 'oauth' || args.flow === 'standard' || args.flow === 'remember-me')
    ? ['transactions'] : ['transactions'];
  const linkToken = await createSandboxLinkToken(products);

  const harnessHtml = buildHarnessHtml(linkToken, args.flow);
  const harnessPath = path.join(PROJECT_ROOT, 'tmp-recipe-harness.html');
  fs.writeFileSync(harnessPath, harnessHtml, 'utf8');

  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript({ content: buildCaptureScript() });

  const page = await context.newPage();
  const captured = [];
  let saveRequested = false;
  let discardRequested = false;

  function attachConsoleListener(target) {
    target.on('console', (msg) => {
      const text = msg.text();
      if (!text.startsWith('[RECIPE-CAPTURE]')) return;
      try {
        const payload = JSON.parse(text.slice('[RECIPE-CAPTURE]'.length));
        captured.push(payload);
      } catch (_) {}
    });
  }
  attachConsoleListener(page);

  await page.goto('file://' + harnessPath);
  await page.evaluate(buildOverlayScript());

  console.log('[recorder] Browser is open. Click "Open Plaid Link" and step through the flow.');
  console.log('[recorder] Press ESC or click "Save" in the overlay when you reach success.');

  // Poll for save / discard / unhandled close.
  const startMs = Date.now();
  const HARD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  while (true) {
    if (Date.now() - startMs > HARD_TIMEOUT_MS) {
      console.warn('[recorder] Hard timeout reached. Saving what we have.');
      saveRequested = true;
      break;
    }
    try {
      const state = await page.evaluate(() => ({
        save: !!window.__recipeShouldSave,
        discard: !!window.__recipeShouldDiscard,
        success: !!window.__recipeSuccess,
      }));
      if (state.save) { saveRequested = true; break; }
      if (state.discard) { discardRequested = true; break; }
      if (state.success) {
        // Give the operator 2s to inspect, then auto-save
        await page.waitForTimeout(2000);
        saveRequested = true;
        break;
      }
    } catch (err) {
      // Page closed unexpectedly — save what we have.
      console.warn(`[recorder] Page eval error (likely closed): ${err.message}`);
      saveRequested = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`[recorder] Captured ${captured.length} event(s).`);

  await browser.close().catch(() => {});
  try { fs.unlinkSync(harnessPath); } catch (_) {}

  if (discardRequested) {
    console.log('[recorder] Discard requested. Nothing written.');
    return;
  }
  if (!saveRequested) {
    console.log('[recorder] No save signal. Exiting.');
    return;
  }

  if (captured.length === 0) {
    console.log('[recorder] No captured events. Nothing to write.');
    return;
  }

  const recipe = synthesizeRecipe(args, captured);
  fs.mkdirSync(RECIPES_DIR, { recursive: true });
  const backup = backupExistingRecipe(args.flow);
  const outPath = path.join(RECIPES_DIR, `${args.flow}.json`);
  fs.writeFileSync(outPath, JSON.stringify(recipe, null, 2) + '\n', 'utf8');

  console.log(`\n[recorder] Wrote ${path.relative(PROJECT_ROOT, outPath)}`);
  if (backup) console.log(`[recorder] Previous version backed up to ${path.relative(PROJECT_ROOT, backup)}`);
  console.log(`[recorder] ${recipe.screens.length} screen(s), total estimated dwell ${(recipe.totalEstimatedDwellMs / 1000).toFixed(1)}s`);
  console.log('[recorder] NEXT: open the recipe and (a) fill narrationHint on each screen, (b) sanity-check primarySelectors picked sensibly.');
}

main().catch((err) => {
  console.error(`[recorder] Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
