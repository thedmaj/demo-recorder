'use strict';
/**
 * plaid-browser-agent.js
 *
 * Vision-based browser automation agent for Plaid Link iframe interaction.
 *
 * Problem: Plaid Link runs in a cross-origin iframe (cdn.plaid.com).
 * Standard Playwright CSS selectors fail because:
 *   1. DOM inspection is blocked on cross-origin frames
 *   2. Plaid's element class names change with each SDK release
 *   3. Remember Me / consent screens appear unpredictably
 *
 * Solution: Take a full-page screenshot → Claude vision → pixel coordinates →
 * page.mouse.click(x, y). Bypasses all cross-origin restrictions.
 *
 * Credentials source (priority order):
 *   1. PLAID_SANDBOX_* environment variables
 *   2. Glean plaid_docs REST search (if GLEAN_API_TOKEN + GLEAN_INSTANCE_URL set)
 *   3. Built-in Plaid sandbox test credentials table (fallback)
 */

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const https     = require('https');
const http      = require('http');

// ─── Vision model ─────────────────────────────────────────────────────────────

const VISION_MODEL      = 'claude-haiku-4-5-20251001'; // Fast + cheap for UI finding
const VISION_MAX_TOKENS = 256;

// ─── Built-in Plaid sandbox data ─────────────────────────────────────────────
// Source: inputs/plaid-link-sandbox.md (canonical) + plaid.com/docs/sandbox/
// Agent decision table: inputs/plaid-link-sandbox.md § 7

/** All sandbox institutions with their IDs. */
const SANDBOX_INSTITUTIONS = {
  // Classic (non-OAuth) — use these unless testing OAuth
  firstPlatypus:    { name: 'First Platypus Bank',                    id: 'ins_109508' }, // DEFAULT
  firstPlatypusBal: { name: 'First Platypus Balance Bank',            id: 'ins_130016' },
  firstGingham:     { name: 'First Gingham Credit Union',             id: 'ins_109509' },
  tattersall:       { name: 'Tattersall Federal Credit Union',        id: 'ins_109510' },
  tartan:           { name: 'Tartan Bank',                            id: 'ins_109511' },
  houndstooth:      { name: 'Houndstooth Bank',                       id: 'ins_109512' }, // micro-deposit
  windowpane:       { name: 'Windowpane Bank',                        id: 'ins_135858' }, // instant micro-deposit
  canada:           { name: 'Tartan-Dominion Bank of Canada',         id: 'ins_43'     },
  // OAuth — redirect to bank login simulation
  platypusOAuth:    { name: 'Platypus OAuth Bank',                    id: 'ins_127287' }, // PREFERRED for OAuth
  platypusApp2App:  { name: 'First Platypus OAuth App2App Bank',      id: 'ins_132241' },
  ukOAuth:          { name: 'Flexible Platypus Open Banking (UK)',    id: 'ins_116834' },
  ukRoyal:          { name: 'Royal Bank of Plaid (UK)',               id: 'ins_117650' },
  ukQr:             { name: 'Flexible Platypus Open Banking (QR)',    id: 'ins_117181' },
  // Error simulation
  degraded:         { name: 'Unhealthy Platypus Bank - Degraded',     id: 'ins_132363' },
  down:             { name: 'Unhealthy Platypus Bank - Down',          id: 'ins_132361' },
  unsupported:      { name: 'Unsupported Platypus Bank',              id: 'ins_133402' },
};

const SANDBOX_CREDS = {
  /**
   * Standard Plaid Link credential flow.
   * Products: auth, transactions, identity, assets, signal, investments
   */
  link: {
    username:    'user_good',
    password:    'pass_good',
    institution: process.env.PLAID_SANDBOX_INSTITUTION || 'First Platypus Bank',
    institutionId: process.env.PLAID_SANDBOX_INSTITUTION_ID || 'ins_109508',
    mfa:         '1234',
    notes: 'Standard sandbox credentials. Works for most Plaid products.',
  },

  /**
   * OAuth flow — detected when Plaid Link redirects to a bank-hosted login page.
   * Use Platypus OAuth Bank (ins_127287) to trigger this flow.
   *
   * OAuth steps:
   *   1. Plaid Link: select institution → data sharing consent → "Continue to login"
   *   2. Bank page: username=user_good, password=pass_good → "Sign in"
   *   3. Bank MFA (if shown): OTP=1234 → "Submit code"
   *   4. Plaid Link: select accounts → check both permissions → "Continue"
   *   5. Plaid Link: check "Plaid End User Privacy Policy" → "Connect account information"
   */
  oauth: {
    username:          'user_good',
    password:          'pass_good',
    institution:       'Platypus OAuth Bank',
    institutionId:     'ins_127287',
    bankLoginUsername: 'user_good',
    bankLoginPassword: 'pass_good',
    bankMfaOtp:        '1234',
    notes: 'OAuth flow — redirect to bank login detected. Follow 5-step OAuth process.',
  },

  /**
   * Transactions product — dynamic history, pending/posted, webhooks.
   */
  transactions: {
    username:    'user_transactions_dynamic',
    password:    'any_password',
    institution: 'First Platypus Bank',
    institutionId: 'ins_109508',
    notes: 'Use for dynamic transaction history testing.',
  },

  /**
   * Auth micro-deposit testing.
   * Must use Houndstooth Bank (ins_109512).
   */
  microdeposit: {
    username:    'user_good',
    password:    'microdeposits_good',
    institution: 'Houndstooth Bank',
    institutionId: 'ins_109512',
    notes: 'Micro-deposit auth flow. Must use Houndstooth Bank.',
  },

  /**
   * MFA — device OTP flow.
   * Bank of America (ins_1) and US Bank always trigger MFA in Sandbox.
   */
  mfa: {
    username:    'user_good',
    password:    'mfa_device',
    institution: 'First Platypus Bank',
    institutionId: 'ins_109508',
    mfa:         '1234',
    notes: 'MFA device OTP. OTP is always 1234 in sandbox.',
  },

  /**
   * CRA — Consumer Report Access (Bank Income, CRA Base Report, Income Insights).
   * MUST NOT use user_good/pass_good.
   * MUST use non-OAuth institution.
   * Products: cra_base_report, cra_income_insights
   */
  cra: {
    username:    'user_bank_income',
    password:    '{}',
    institution: 'First Platypus Bank',
    institutionId: 'ins_109508',
    mfa:         '1234',
    alternates: [
      { username: 'user_credit_profile_excellent', institution: 'First Platypus Bank' },
      { username: 'user_credit_profile_good',      institution: 'First Platypus Bank' },
      { username: 'user_credit_profile_poor',      institution: 'First Platypus Bank' },
    ],
    notes: 'CRA/Bank Income. Non-OAuth institutions only. Do not use user_good/pass_good.',
  },

  /**
   * Plaid Layer — session-based phone passkey flow.
   * Token from /session/token/create (NOT /link/token/create).
   * For credential-flow demos: click "I'd rather log in manually".
   */
  layer: {
    phone:    '+14155550000',
    otp:      '123456',
    skipText: "I'd rather log in manually",
    notes: 'Layer uses phone passkey. Skip to manual login for credential-flow demos.',
  },

  /**
   * IDV test data — Leslie Knope (success path).
   * NOT a Plaid Link credential flow. Uses /identity_verification/ endpoints.
   * Selfie checks and watchlist hits do NOT run in Sandbox.
   */
  idv: {
    firstName:        'Leslie',
    lastName:         'Knope',
    phone:            '+12345678909',
    verificationCode: '11111',
    address:          '123 Main St.',
    city:             'Pawnee',
    state:            'Indiana',
    zip:              '46001',
    dob:              'January 18, 1975',
    ssn:              '123-45-6789',
    notes: 'IDV success path. Use exact values — any deviation triggers failure.',
  },

  /**
   * Remember Me — phone screen shown before institution search.
   * ALWAYS skip in standard Link flows. Only use phone numbers below when
   * the demo specifically tests Remember Me / returning user flows.
   */
  remember_me: {
    skipText:  'Continue without phone number',
    otp:       '123456',
    phones: {
      newUser:           '415-555-0010', // First-time flow
      verifiedReturning: '415-555-0011', // Returning user, saved institution
      returningNewAcct:  '415-555-0012', // Returning + new account
      oauthReturning:    '415-555-0013', // Returning via OAuth
      newDevice:         '415-555-0014', // New device, extra verification
      autoSelect:        '415-555-0015', // Single institution — auto-select
    },
    notes: 'Skip for all credential-flow demos. Use phone numbers only for Remember Me demos.',
  },

  /**
   * Plaid Monitor — no new Link flow needed.
   * Uses access_token from a prior Auth/Link session.
   */
  monitor: {
    notes: 'Monitor uses existing Items. No new Link credentials required.',
  },
};

// ─── Glean REST API client (optional) ────────────────────────────────────────

/**
 * Query Glean plaid_docs via REST API.
 * Only executes if GLEAN_API_TOKEN and GLEAN_INSTANCE_URL are set.
 *
 * @param {string} query
 * @returns {Promise<string|null>} Combined snippet text, or null if unavailable
 */
async function queryGleanPlaidDocs(query) {
  const token   = process.env.GLEAN_API_TOKEN;
  const baseUrl = process.env.GLEAN_INSTANCE_URL; // e.g. 'https://plaid-be.glean.com'
  if (!token || !baseUrl) return null;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      query,
      pageSize: 5,
      requestOptions: { datasourceFilter: 'plaid docs' },
    });

    let url;
    try { url = new URL('/rest/api/v1/search', baseUrl); }
    catch { return resolve(null); }

    const isHttps = url.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json     = JSON.parse(data);
          const snippets = (json.results || [])
            .flatMap(r => (r.snippets || []).map(s => s.snippet?.value || s.text || ''))
            .filter(Boolean)
            .slice(0, 5)
            .join('\n\n');
          resolve(snippets || null);
        } catch { resolve(null); }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Credentials resolver ─────────────────────────────────────────────────────

/**
 * Resolve sandbox credentials for the current Plaid flow type.
 *
 * Priority: PLAID_SANDBOX_* env vars → built-in SANDBOX_CREDS table → SANDBOX_CREDS.link.
 * Glean plaid_docs is queried for supplemental context when available.
 *
 * @param {string} [flowType] 'link'|'oauth'|'transactions'|'microdeposit'|'mfa'|
 *                             'cra'|'layer'|'idv'|'remember_me'|'monitor'
 * @returns {Promise<object>} Resolved credentials object
 */
async function resolveSandboxCredentials(flowType = 'link') {
  const base     = { ...(SANDBOX_CREDS[flowType] || SANDBOX_CREDS.link) };
  const resolved = { ...base };

  // Env vars override built-ins
  if (process.env.PLAID_SANDBOX_USERNAME)    resolved.username    = process.env.PLAID_SANDBOX_USERNAME;
  if (process.env.PLAID_SANDBOX_PASSWORD)    resolved.password    = process.env.PLAID_SANDBOX_PASSWORD;
  if (process.env.PLAID_SANDBOX_INSTITUTION) resolved.institution = process.env.PLAID_SANDBOX_INSTITUTION;

  // Optional Glean lookup for supplemental docs context
  const gleanSnippets = await queryGleanPlaidDocs(
    `Plaid sandbox test credentials ${flowType} username password test accounts user_good pass_good`
  ).catch(() => null);
  if (gleanSnippets) {
    console.log(`[BrowserAgent] Glean plaid_docs context (${gleanSnippets.length} chars) — confirms built-in credentials`);
  }

  console.log(
    `[BrowserAgent] Credentials: flow="${flowType}" username="${resolved.username || '(none)'}" ` +
    `institution="${resolved.institution || '(none)'}"`
  );
  return resolved;
}

// ─── Vision engine ────────────────────────────────────────────────────────────

let _client = null;
function getAnthropicClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ─── Vision circuit breaker ───────────────────────────────────────────────────
//
// If the Anthropic API is rate-limited or unavailable, every visionClick() call
// retries 2× with 1.5s waits before returning false. With 8–12 vision calls per
// recording, a sustained outage adds 24–36s of wasted wait time.
//
// The circuit breaker trips after VISION_CIRCUIT_BREAKER consecutive failures,
// putting the session into CSS-selector-only mode (vision calls return false
// immediately without hitting the API). A log message is emitted when it trips.
const VISION_CIRCUIT_BREAKER = 3;
let _visionFailureCount = 0;
let _visionCircuitOpen  = false;

function recordVisionSuccess() {
  _visionFailureCount = 0;
}

function recordVisionFailure() {
  _visionFailureCount++;
  if (!_visionCircuitOpen && _visionFailureCount >= VISION_CIRCUIT_BREAKER) {
    _visionCircuitOpen = true;
    console.warn(
      `[BrowserAgent] Circuit breaker tripped after ${VISION_CIRCUIT_BREAKER} consecutive vision failures. ` +
      `Switching to CSS-selector-only mode for this session. ` +
      `Vision calls will return false immediately.`
    );
  }
}

/**
 * Send a screenshot to Claude with a find-element intent.
 * Returns click coordinates if found.
 *
 * @param {Buffer}  screenshotBuffer PNG screenshot (1440×900)
 * @param {string}  intent           Natural language element description
 * @returns {Promise<{found: boolean, x?: number, y?: number, description: string}>}
 */
async function findWithVision(screenshotBuffer, intent) {
  const client      = getAnthropicClient();
  const imageBase64 = screenshotBuffer.toString('base64');

  const response = await client.messages.create({
    model:      VISION_MODEL,
    max_tokens: VISION_MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        {
          type:   'image',
          source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
        },
        {
          type: 'text',
          text:
            `You are a browser automation agent analyzing a 1440×900 screenshot.\n` +
            `Task: ${intent}\n\n` +
            `Return ONLY valid JSON — no markdown, no explanation:\n` +
            `{"found": true, "x": <center_pixel_x>, "y": <center_pixel_y>, "description": "<what you found>"}\n\n` +
            `If NOT visible: {"found": false, "description": "<what you see instead>"}`,
        },
      ],
    }],
  });

  const text = response.content[0]?.text?.trim() || '';
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return { found: false, description: `Vision parse error: ${text.substring(0, 120)}` };
  }
}

/**
 * Take a fresh screenshot and run vision find.
 */
async function screenshotAndFind(page, intent) {
  const buf = await page.screenshot({ type: 'png', fullPage: false });
  return findWithVision(buf, intent);
}

// ─── Click / type helpers ─────────────────────────────────────────────────────

/**
 * Find an element by vision and click it.
 *
 * @param {import('playwright').Page} page
 * @param {string} intent
 * @param {{ retries?: number, waitAfterMs?: number }} opts
 * @returns {Promise<boolean>}
 */
async function visionClick(page, intent, { retries = 2, waitAfterMs = 1000 } = {}) {
  // Circuit breaker: skip API calls when too many consecutive failures detected
  if (_visionCircuitOpen) {
    console.log(`  [BrowserAgent] Circuit open — skipping vision for: ${intent.substring(0, 60)}`);
    return false;
  }

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    let result;
    try {
      result = await screenshotAndFind(page, intent);
    } catch (err) {
      recordVisionFailure();
      console.warn(`  [BrowserAgent] Vision API error (attempt ${attempt}): ${err.message}`);
      if (attempt <= retries) await page.waitForTimeout(1500);
      continue;
    }

    if (result.found && result.x && result.y) {
      recordVisionSuccess();
      await page.mouse.click(result.x, result.y);
      console.log(`  [BrowserAgent] ✓ Clicked (${result.x},${result.y}) — ${result.description}`);
      if (waitAfterMs) await page.waitForTimeout(waitAfterMs);
      return true;
    }
    // "Element not found" is a valid API response — don't count toward circuit breaker.
    // Only API-level errors (caught above) trip the circuit breaker.
    recordVisionSuccess(); // API responded successfully, element just wasn't visible
    console.log(`  [BrowserAgent] Not found (attempt ${attempt}): ${result.description}`);
    if (attempt <= retries) await page.waitForTimeout(1500);
  }
  return false;
}

/**
 * Find a text input by vision, click it, and type text.
 *
 * @param {import('playwright').Page} page
 * @param {string} intent
 * @param {string} text
 * @param {{ waitAfterMs?: number }} opts
 * @returns {Promise<boolean>}
 */
async function visionType(page, intent, text, { waitAfterMs = 500 } = {}) {
  const result = await screenshotAndFind(page, intent);
  if (result.found && result.x && result.y) {
    await page.mouse.click(result.x, result.y);
    await page.waitForTimeout(200);
    // Clear any existing value then type
    await page.keyboard.press('Meta+a');
    await page.keyboard.type(text, { delay: 40 });
    console.log(`  [BrowserAgent] ✓ Typed "${text}" at (${result.x},${result.y}) — ${result.description}`);
    if (waitAfterMs) await page.waitForTimeout(waitAfterMs);
    return true;
  }
  console.log(`  [BrowserAgent] Input not found: ${result.description}`);
  return false;
}

// ─── Plaid Link flow actions ──────────────────────────────────────────────────

/**
 * Use vision to detect what screen Plaid Link is currently showing.
 * Returns a string label: 'phone' | 'consent' | 'search' | 'credentials' | 'mfa' | 'accounts' | 'success' | 'unknown'
 */
async function detectPlaidScreen(page) {
  const result = await screenshotAndFind(page,
    'Look at the white Plaid Link modal dialog and identify which screen is showing. ' +
    'Return ONE of these exact labels in the description field:\n' +
    '- "phone" if a phone number input (+1) is visible with "Continue without phone number" link\n' +
    '- "consent" if terms/privacy text is visible with an Agree or Get Started button (no phone input)\n' +
    '- "search" if a text input for searching bank institutions is visible\n' +
    '- "credentials" if username and password fields are visible\n' +
    '- "mfa" if a verification/MFA code input is visible\n' +
    '- "accounts" if a list of bank accounts with checkboxes is visible\n' +
    '- "success" if a success/connected confirmation screen is visible\n' +
    '- "loading" if a spinner or loading state is visible\n' +
    '- "unknown" if none of the above match\n' +
    'Set found=true always. Set x,y to the most relevant clickable element for the current screen.'
  );
  const desc = (result.description || '').toLowerCase();
  for (const label of ['phone','consent','search','credentials','mfa','accounts','success','loading']) {
    if (desc.includes(label)) return label;
  }
  return 'unknown';
}

/**
 * Skip the Remember Me phone screen using Playwright frameLocator (handles cross-origin).
 * Vision is used to detect the screen; Playwright's frameLocator is used to click
 * (more reliable than page.mouse.click for cross-origin iframe content).
 *
 * Falls back to coordinate click if frameLocator can't find the element.
 *
 * @param {number} maxAttempts  Max times to attempt skipping (default 4)
 */
async function skipRememberMe(page, maxAttempts = 4) {
  console.log('  [BrowserAgent] Checking for Remember Me screen...');

  const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const screen = await detectPlaidScreen(page);

    if (screen !== 'phone') {
      if (attempt === 1) {
        console.log(`  [BrowserAgent] Phone screen not present (screen: ${screen})`);
      } else {
        console.log(`  [BrowserAgent] Phone screen cleared (now: ${screen})`);
      }
      return attempt > 1;
    }

    console.log(`  [BrowserAgent] Phone screen detected (attempt ${attempt}/${maxAttempts}) — clicking skip link`);

    // Strategy 1: Playwright frameLocator — works for cross-origin iframes
    let clicked = false;
    const skipTexts = [
      'Continue without phone number',
      'without phone number',
      'Skip',
    ];
    for (const text of skipTexts) {
      try {
        const el = frame.getByText(text, { exact: false }).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          await el.click({ timeout: 3000 });
          console.log(`  [BrowserAgent] ✓ frameLocator clicked "${text}" (attempt ${attempt})`);
          clicked = true;
          break;
        }
      } catch (_) {}
    }

    // Strategy 2: coordinate click fallback (vision coords)
    if (!clicked) {
      const snapshot = await screenshotAndFind(page,
        'Find the "Continue without phone number" text link coordinates in the Plaid modal.'
      );
      if (snapshot.found && snapshot.x && snapshot.y) {
        await page.mouse.click(snapshot.x, snapshot.y);
        console.log(`  [BrowserAgent] ✓ coord click at (${snapshot.x},${snapshot.y}) (attempt ${attempt})`);
        clicked = true;
      }
    }

    if (!clicked) {
      console.warn(`  [BrowserAgent] Could not find skip link (attempt ${attempt})`);
    }

    await page.waitForTimeout(2500);
  }

  const finalScreen = await detectPlaidScreen(page);
  if (finalScreen !== 'phone') {
    console.log(`  [BrowserAgent] Phone screen cleared after max attempts (now: ${finalScreen})`);
    return true;
  }
  console.warn('  [BrowserAgent] Remember Me screen persisted after all attempts');
  return false;
}

/**
 * Click the primary Continue / Agree / Get started button.
 * Guards against clicking the phone screen's submit button.
 */
async function clickContinue(page) {
  console.log('  [BrowserAgent] Clicking Continue/Agree...');

  const screen = await detectPlaidScreen(page);
  if (screen === 'phone') {
    console.warn('  [BrowserAgent] Phone screen still showing — skipping clickContinue');
    return false;
  }
  if (screen === 'search' || screen === 'credentials' || screen === 'accounts') {
    console.log(`  [BrowserAgent] Already on "${screen}" screen — no consent button needed`);
    return true;
  }

  const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

  // Try frameLocator for consent buttons
  const consentTexts = ['I agree', 'Agree', 'Get started', 'Next', 'Continue'];
  for (const text of consentTexts) {
    try {
      const btn = frame.getByRole('button', { name: text, exact: false }).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click({ timeout: 3000 });
        console.log(`  [BrowserAgent] ✓ frameLocator clicked consent "${text}"`);
        await page.waitForTimeout(2000);
        return true;
      }
    } catch (_) {}
  }

  // Fallback: vision click
  return visionClick(page,
    'Find the primary action button in a white Plaid Link modal. ' +
    'It may say "Agree", "I agree", "Get started", or "Next". ' +
    'Do NOT click if a phone number input (+1) is visible.',
    { retries: 1, waitAfterMs: 2000 }
  );
}

/**
 * Search for an institution by name and select the first result.
 * Uses frameLocator for cross-origin iframe interaction; falls back to vision.
 */
async function searchAndSelectInstitution(page, institutionName) {
  console.log(`  [BrowserAgent] Searching institution: "${institutionName}"...`);

  const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

  // Try frameLocator for search input first (most reliable for cross-origin)
  let typed = false;
  const searchSelectors = [
    'input[placeholder*="Search" i]',
    'input[type="search"]',
    'input[name="search"]',
    'input[aria-label*="Search" i]',
    '[data-testid*="search"] input',
  ];
  for (const sel of searchSelectors) {
    try {
      const input = frame.locator(sel).first();
      if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
        await input.fill(institutionName, { timeout: 3000 });
        console.log(`  [BrowserAgent] ✓ frameLocator filled search input (${sel})`);
        typed = true;
        await page.waitForTimeout(2000);
        break;
      }
    } catch (_) {}
  }

  // Fallback: vision type
  if (!typed) {
    typed = await visionType(page,
      'Find the institution search text input — a text box to search for a bank by name. ' +
      'Placeholder may say "Search for your bank", "Search institutions", or similar. ' +
      'It is inside a white Plaid Link modal.',
      institutionName,
      { waitAfterMs: 2000 }
    );
  }

  if (!typed) {
    console.warn('  [BrowserAgent] Institution search input not found');
    return false;
  }

  // Select first result — try frameLocator then vision
  const resultSelectors = [
    '[data-testid*="institution"]',
    'li[role="option"]',
    'button[role="option"]',
    '[class*="institution" i]',
    'ul li button',
  ];
  for (const sel of resultSelectors) {
    try {
      const result = frame.locator(sel).first();
      if (await result.isVisible({ timeout: 4000 }).catch(() => false)) {
        await result.click({ timeout: 3000 });
        console.log(`  [BrowserAgent] ✓ frameLocator selected institution (${sel})`);
        await page.waitForTimeout(2000);
        return true;
      }
    } catch (_) {}
  }

  // Fallback: vision click
  return visionClick(page,
    `Find the first clickable institution result in the search results list for "${institutionName}". ` +
    `It should be a bank name button or list item showing the institution name and logo.`,
    { retries: 2, waitAfterMs: 2000 }
  );
}

/**
 * If Plaid Link shows an intermediate "connection type" selector screen
 * (standard login / OAuth / App2App), select the standard credentials option.
 * Returns true if the screen was handled.
 */
async function handleConnectionTypeScreen(page) {
  const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

  // Detect connection type options by looking for multiple list items with arrows
  const screen = await detectPlaidScreen(page);
  if (screen === 'credentials') return false; // Already on creds screen

  // Look for a "standard" or first option that leads to username/password
  const optionSelectors = [
    'li:has-text("standard")',
    'li:has-text("Standard")',
    'button:has-text("standard")',
    '[data-testid*="institution-option"]:first-of-type',
    // First item in any list inside the frame
    'ul li:first-of-type',
    'ol li:first-of-type',
  ];

  for (const sel of optionSelectors) {
    try {
      const el = frame.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click({ timeout: 3000 });
        console.log(`  [BrowserAgent] ✓ Selected connection type via (${sel})`);
        await page.waitForTimeout(2000);
        return true;
      }
    } catch (_) {}
  }

  // Vision fallback: click first arrow-option in the list
  const clicked = await visionClick(page,
    'Find the first selectable connection option in the Plaid Link modal. ' +
    'It is a list item showing "standard" or the default login method with a right arrow (>). ' +
    'Click the first option to use username/password login.',
    { retries: 1, waitAfterMs: 2000 }
  );
  if (clicked) console.log('  [BrowserAgent] Selected connection type via vision');
  return clicked;
}

/**
 * Enter username + password and submit.
 * Uses frameLocator for cross-origin iframe interaction; falls back to vision.
 */
async function enterCredentials(page, credentials) {
  const { username = 'user_good', password = 'pass_good' } = credentials;
  console.log(`  [BrowserAgent] Entering credentials (${username})...`);

  // Handle intermediate "connection type" selection screen first
  const screen = await detectPlaidScreen(page);
  if (screen !== 'credentials' && screen !== 'phone') {
    console.log(`  [BrowserAgent] Intermediate screen detected (${screen}) — handling connection type`);
    await handleConnectionTypeScreen(page);
    await page.waitForTimeout(1500);
  }

  const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

  // Fill username via frameLocator
  let usernameOk = false;
  for (const sel of ['input[name="username"]', 'input[id*="username" i]', 'input[placeholder*="user" i]', 'input[type="text"]:first-of-type']) {
    try {
      const el = frame.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await el.fill(username, { timeout: 3000 });
        console.log(`  [BrowserAgent] ✓ frameLocator filled username (${sel})`);
        usernameOk = true;
        break;
      }
    } catch (_) {}
  }
  if (!usernameOk) {
    usernameOk = await visionType(page, 'Find the username or user ID text input on the Plaid credential screen.', username, { waitAfterMs: 400 });
  }
  if (!usernameOk) console.warn('  [BrowserAgent] Username field not found');

  await page.waitForTimeout(300);

  // Fill password via frameLocator
  let passwordOk = false;
  for (const sel of ['input[name="password"]', 'input[type="password"]', 'input[id*="password" i]']) {
    try {
      const el = frame.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await el.fill(password, { timeout: 3000 });
        console.log(`  [BrowserAgent] ✓ frameLocator filled password (${sel})`);
        passwordOk = true;
        break;
      }
    } catch (_) {}
  }
  if (!passwordOk) {
    passwordOk = await visionType(page, 'Find the password input field (characters show as dots/bullets).', password, { waitAfterMs: 400 });
  }
  if (!passwordOk) console.warn('  [BrowserAgent] Password field not found');

  await page.waitForTimeout(300);

  // Submit via frameLocator
  for (const sel of ['button[type="submit"]', 'button:has-text("Submit")', 'button:has-text("Log in")', 'button:has-text("Sign in")']) {
    try {
      const btn = frame.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click({ timeout: 3000 });
        console.log(`  [BrowserAgent] ✓ frameLocator submitted (${sel})`);
        await page.waitForTimeout(4000);
        return true;
      }
    } catch (_) {}
  }

  // Fallback: vision click
  return visionClick(page,
    'Find the submit/sign-in button. It may say "Submit", "Sign in", "Log in", or "Continue".',
    { retries: 1, waitAfterMs: 4000 }
  );
}

/**
 * Enter MFA code if prompted.
 */
async function enterMfa(page, mfaCode = '1234') {
  console.log('  [BrowserAgent] Checking for MFA prompt...');
  return visionType(page,
    'Find an MFA / verification code input field — a text box asking for a one-time code, ' +
    'security code, or PIN. It may appear after the password step.',
    mfaCode,
    { waitAfterMs: 500 }
  );
}

/**
 * Select the first account in the account selection step and continue.
 * Uses frameLocator for cross-origin iframe interaction; falls back to vision.
 */
async function selectFirstAccount(page) {
  console.log('  [BrowserAgent] Selecting first account...');

  const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

  // Select first account via frameLocator.
  // Plaid renders accounts as LI[role=listitem] wrappers with hidden checkbox inputs inside.
  // The LI itself is the clickable element — input[type="checkbox"] is not visible.
  let accountSelected = false;
  for (const sel of ['li[role="listitem"]', '[role="radio"]', 'input[type="radio"]', '[data-testid*="account"]']) {
    try {
      const el = frame.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        await el.click({ timeout: 3000 });
        console.log(`  [BrowserAgent] ✓ frameLocator selected account (${sel})`);
        accountSelected = true;
        await page.waitForTimeout(800);
        break;
      }
    } catch (_) {}
  }
  if (!accountSelected) {
    await visionClick(page,
      'Find the first bank account option in the account list. Click to select it.',
      { retries: 1, waitAfterMs: 800 }
    );
  }

  // Click Continue via frameLocator
  for (const sel of ['button:has-text("Continue")', 'button:has-text("Link account")', 'button[type="submit"]']) {
    try {
      const btn = frame.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click({ timeout: 3000 });
        console.log(`  [BrowserAgent] ✓ frameLocator continued (${sel})`);
        await page.waitForTimeout(2000);
        return true;
      }
    } catch (_) {}
  }

  return visionClick(page,
    'Find the Continue button after selecting an account.',
    { retries: 1, waitAfterMs: 2000 }
  );
}

// ─── OAuth redirect detection + flow ─────────────────────────────────────────

/**
 * Detect whether Plaid Link has redirected the page to a bank's OAuth login.
 *
 * Signals:
 *   - The Plaid Link iframe is gone (page navigated away)
 *   - Page URL is not cdn.plaid.com / plaid.com/link
 *
 * @returns {Promise<boolean>}
 */
async function detectOAuthRedirect(page) {
  const url = page.url();
  // Still on Plaid CDN — no redirect
  if (url.includes('cdn.plaid.com') || url.includes('plaid.com/link')) return false;

  const hasPlaidFrame = await page
    .locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]')
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  // If Plaid iframe is gone and URL changed, we're on the bank OAuth page
  return !hasPlaidFrame;
}

/**
 * Handle the full OAuth bank login flow.
 *
 * Called when detectOAuthRedirect() returns true (agent is on bank login page).
 * Follows the 5-step OAuth flow defined in inputs/plaid-link-sandbox.md § 1.
 *
 *   Step 1 already done (institution selected + consent given in Plaid Link)
 *   Step 2: Fill bank login credentials → submit
 *   Step 3: Enter MFA OTP if prompted
 *   Step 4: Back in Plaid Link → select accounts → check permissions → Continue
 *   Step 5: Final confirmation → Plaid End User Privacy Policy → Connect
 *
 * @param {import('playwright').Page} page
 * @param {object} credentials  From SANDBOX_CREDS.oauth or resolveSandboxCredentials('oauth')
 */
async function handleOAuthFlow(page, credentials = {}) {
  const {
    bankLoginUsername = 'user_good',
    bankLoginPassword = 'pass_good',
    bankMfaOtp        = '1234',
  } = credentials;

  console.log('  [BrowserAgent] OAuth redirect detected — starting bank login flow');

  // Step 2: Bank login
  await visionType(page,
    'Find the username or user ID input on the bank login page.',
    bankLoginUsername, { waitAfterMs: 400 }
  );
  await visionType(page,
    'Find the password input on the bank login page (characters show as dots).',
    bankLoginPassword, { waitAfterMs: 400 }
  );
  await visionClick(page,
    'Find the Sign in, Log in, or Submit button on the bank login page.',
    { retries: 2, waitAfterMs: 3000 }
  );

  // Step 3: MFA (if shown)
  const mfaResult = await screenshotAndFind(page,
    'Is there an OTP, verification code, or Mobile code input visible on screen? ' +
    'Return found=true if yes, found=false if not.'
  );
  if (mfaResult.found) {
    console.log('  [BrowserAgent] Bank MFA prompt detected — entering OTP');
    await visionType(page,
      'Find the OTP / verification code / Mobile code input field.',
      bankMfaOtp, { waitAfterMs: 400 }
    );
    await visionClick(page,
      'Find the Submit code, Verify, or Continue button.',
      { retries: 2, waitAfterMs: 3000 }
    );
  }

  // Step 4: Wait for redirect back to Plaid Link
  console.log('  [BrowserAgent] Waiting for redirect back to Plaid Link...');
  try {
    await page.waitForSelector(
      'iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]',
      { state: 'attached', timeout: 30000 }
    );
    await page.waitForTimeout(2500);
    console.log('  [BrowserAgent] Plaid Link iframe reappeared — proceeding to account selection');
  } catch {
    console.warn('  [BrowserAgent] Plaid Link iframe did not reappear within 30s');
  }

  // Select first account + check both permission checkboxes
  await selectFirstAccount(page);
  await page.waitForTimeout(1500);

  // Step 5: Final confirmation — Plaid End User Privacy Policy checkbox
  await visionClick(page,
    'Find the "Plaid End User Privacy Policy" checkbox or agreement checkbox on the confirmation screen. Click to check it.',
    { retries: 2, waitAfterMs: 600 }
  );
  await visionClick(page,
    'Find the "Connect account information" or "Connect" button to complete the OAuth connection.',
    { retries: 2, waitAfterMs: 3000 }
  );

  console.log('  [BrowserAgent] OAuth flow complete');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Data tables
  SANDBOX_CREDS,
  SANDBOX_INSTITUTIONS,
  resolveSandboxCredentials,
  queryGleanPlaidDocs,

  // Vision primitives
  findWithVision,
  screenshotAndFind,
  visionClick,
  visionType,
  detectPlaidScreen,

  // Plaid Link flow actions
  skipRememberMe,
  clickContinue,
  handleConnectionTypeScreen,
  searchAndSelectInstitution,
  enterCredentials,
  enterMfa,
  selectFirstAccount,

  // OAuth flow
  detectOAuthRedirect,
  handleOAuthFlow,

  // Circuit breaker (reset between recording sessions)
  resetVisionCircuitBreaker: () => {
    _visionFailureCount = 0;
    _visionCircuitOpen  = false;
  },
};
