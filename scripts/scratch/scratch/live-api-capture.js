#!/usr/bin/env node
/**
 * live-api-capture — deterministic, ZERO-LLM stage.
 *
 * Calls the demo's *featured* Plaid backend routes against the sandbox and
 * captures the REAL responses into `artifacts/live-api-responses.json`, keyed by
 * step id. Two consumers downstream (both wired in post-panels.js):
 *   A) console.log of each live response → Developer Console (off-camera dev/QA aid)
 *   B) the JSON panel AUGMENTS — shows the live payload with a " — live" tag when
 *      present, falling back to the curated mock otherwise.
 *
 * No interactive Plaid Link is required: we seed a real sandbox item server-side
 * (`createSandboxItemAccessToken`) to obtain an access_token for post-Link routes
 * (auth/get, identity/match, signal/evaluate, balance, …). Link-token routes are
 * called directly. Everything is best-effort: any endpoint that can't be
 * exercised standalone (e.g. async CRA reports) is recorded as `skipped` with a
 * reason and never blocks the build.
 *
 * Gated on PLAID_LINK_LIVE === 'true'. Idempotent — safe to re-run on a built
 * run dir as a post-build patch (mirrors how post-panels is re-applied).
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const { requireRunDir } = require('../utils/run-io');

function getPlaidBackend() {
  return require('../utils/plaid-backend');
}

/** "POST /auth/get" | "/auth/get  ·  /transactions/get" → first clean "/path". */
function normalizeEndpointPath(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') return null;
  // Take the first route token (panels sometimes show "A  ·  B"); strip verb.
  const first = endpoint.split(/[·,\n]/)[0].trim();
  const m = first.match(/\/[a-z0-9_\/-]+/i);
  return m ? m[0].replace(/\/+$/, '') : null;
}

/** Map a featured endpoint path → the Plaid product needed to seed the item. */
function seedProductForPath(p) {
  if (/\/auth(\/|$)/.test(p)) return 'auth';
  if (/\/identity(\/|$)/.test(p)) return 'identity';
  if (/\/transactions(\/|$)/.test(p)) return 'transactions';
  if (/\/liabilities(\/|$)/.test(p)) return 'liabilities';
  if (/\/investments(\/|$)/.test(p)) return 'investments';
  return null; // signal/balance/etc. ride on a standard item
}

/**
 * Execute one featured endpoint against the sandbox and return its real
 * response, or throw. `ctx` carries the seeded access_token + a cached
 * account_id (from auth/get) for signal.
 */
async function callEndpoint(plaid, p, ctx) {
  const token = ctx.accessToken;
  switch (true) {
    case /\/auth\/get$/.test(p): {
      const data = await plaid.getAuth(token);
      // cache an account_id for signal/evaluate
      const acct = data?.accounts?.[0]?.account_id;
      if (acct && !ctx.accountId) ctx.accountId = acct;
      return { request: { access_token: '<access_token>' }, response: data };
    }
    case /\/identity\/match$/.test(p): {
      const data = await plaid.getIdentityMatch(token, ctx.legalName || 'Sarah Mitchell');
      return { request: { access_token: '<access_token>', user: { legal_name: ctx.legalName || 'Sarah Mitchell' } }, response: data };
    }
    case /\/signal\/evaluate$/.test(p): {
      if (!ctx.accountId) {
        // need an account_id — fetch one via auth/get
        const auth = await plaid.getAuth(token);
        ctx.accountId = auth?.accounts?.[0]?.account_id;
      }
      if (!ctx.accountId) throw new Error('no account_id available for signal/evaluate');
      const data = await plaid.evaluateSignal(token, ctx.accountId, 2500.0);
      return { request: { access_token: '<access_token>', account_id: ctx.accountId, amount: 2500.0 }, response: data };
    }
    case /\/link\/token\/create$/.test(p): {
      // Standalone — no access_token. Use the run's resolved config when present.
      const cfg = ctx.linkTokenConfig || {};
      const isCra = /cra|consumer_report|check/i.test(JSON.stringify(cfg.products || []));
      const opts = {
        clientName: ctx.clientName || '<BrandName>',
        userId: 'demo-user-001',
        products: cfg.products,
        productFamily: cfg.productFamily,
        credentialScope: cfg.credentialScope,
      };
      const data = isCra ? await plaid.createConsumerReportLinkToken(opts) : await plaid.createLinkToken(opts);
      return { request: { products: cfg.products || [], client_name: ctx.clientName || '<BrandName>' }, response: data };
    }
    case /\/cra\/check_report\//.test(p):
      throw new Error('CRA Consumer Report requires a user_token + async report-ready flow (not standalone)');
    case /\/credit\/(bank_income|payroll_income)\//.test(p):
      // Legacy non-CRA income endpoints take a user_token from a COMPLETED
      // income Link session — none exists at capture time. Skip honestly
      // instead of POSTing { access_token } and surfacing a misleading 400.
      throw new Error('Bank/Payroll Income requires a user_token from a completed income Link session (not standalone)');
    default: {
      // Generic best-effort: most read routes accept { access_token }.
      const data = await plaid.plaidRequest(p, { access_token: token });
      return { request: { access_token: '<access_token>' }, response: data };
    }
  }
}

/**
 * Pure capture: given a demoScript (+ optional link-token config), exercise the
 * featured endpoints and return a { stepId → entry } map.
 * @returns {Promise<{ map: object, seeded: boolean, summary: object }>}
 */
async function captureLiveApiResponses(demoScript, opts = {}) {
  const plaid = opts.plaid || getPlaidBackend();
  const steps = Array.isArray(demoScript?.steps) ? demoScript.steps : [];

  // Collect featured endpoints (skip narration-locked steps + onSuccess pseudo-endpoints).
  const targets = [];
  for (const step of steps) {
    if (step?.liveApiCapture === false) continue; // per-step opt-out (narration-locked)
    const ep = step?.apiResponse?.endpoint;
    const p = normalizeEndpointPath(ep);
    if (!p) continue;
    if (/onsuccess|callback/i.test(String(ep))) continue; // handled by the live onSuccess hook
    targets.push({ stepId: step.id, endpoint: ep, path: p });
  }

  const map = {};
  const summary = { captured: 0, skipped: 0, total: targets.length };
  if (!targets.length) return { map, seeded: false, summary };

  // Seed a sandbox item only if any post-Link route is featured.
  const needsToken = targets.some((t) => !/\/link\/token\/create$/.test(t.path));
  const ctx = {
    accessToken: null,
    accountId: null,
    legalName: (demoScript?.persona && (demoScript.persona.legalName || demoScript.persona.name)) || 'Sarah Mitchell',
    clientName: (demoScript?.persona && demoScript.persona.company) || '<BrandName>',
    linkTokenConfig: opts.linkTokenConfig || null,
  };
  let seeded = false;
  if (needsToken) {
    const seedProducts = Array.from(
      new Set(targets.map((t) => seedProductForPath(t.path)).filter(Boolean))
    );
    if (!seedProducts.length) seedProducts.push('auth', 'transactions');
    try {
      const item = await plaid.createSandboxItemAccessToken({ initialProducts: seedProducts });
      ctx.accessToken = item.access_token;
      seeded = true;
      console.log(`[live-api-capture] seeded sandbox item (products=[${seedProducts.join(', ')}])`);
    } catch (e) {
      console.warn(`[live-api-capture] sandbox seed failed (${e.message}) — only standalone routes will be captured`);
    }
  }

  for (const t of targets) {
    const needsT = !/\/link\/token\/create$/.test(t.path);
    if (needsT && !ctx.accessToken) {
      map[t.stepId] = { endpoint: t.endpoint, skipped: true, reason: 'no sandbox access_token' };
      summary.skipped++;
      continue;
    }
    try {
      const { request, response } = await callEndpoint(plaid, t.path, ctx);
      map[t.stepId] = { endpoint: t.endpoint, request, response, live: true, capturedAt: new Date().toISOString() };
      summary.captured++;
      console.log(`[live-api-capture] ✓ ${t.stepId} ${t.path}`);
    } catch (e) {
      map[t.stepId] = { endpoint: t.endpoint, skipped: true, reason: e.message };
      summary.skipped++;
      console.warn(`[live-api-capture] ⤬ ${t.stepId} ${t.path} — ${e.message}`);
    }
  }

  return { map, seeded, summary };
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

async function main() {
  const outDir = opts_runDir() || requireRunDir(PROJECT_ROOT, 'live-api-capture');
  const artifactsDir = path.join(outDir, 'artifacts');
  const outPath = path.join(artifactsDir, 'live-api-responses.json');

  if (String(process.env.PLAID_LINK_LIVE || '').trim().toLowerCase() !== 'true') {
    console.log('[live-api-capture] PLAID_LINK_LIVE!=true — skipping live capture (panels use curated mocks).');
    return { skipped: true, reason: 'PLAID_LINK_LIVE!=true' };
  }

  const demoScript = readJsonSafe(path.join(outDir, 'demo-script.json'));
  if (!demoScript) {
    console.warn('[live-api-capture] demo-script.json not found — nothing to capture.');
    return { skipped: true, reason: 'no demo-script.json' };
  }
  const linkTokenConfig = readJsonSafe(path.join(outDir, 'link-token-create-config.json'));

  const { map, seeded, summary } = await captureLiveApiResponses(demoScript, {
    linkTokenConfig: linkTokenConfig && (linkTokenConfig.suggestedClientRequest || linkTokenConfig),
  });

  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ seeded, summary, responses: map }, null, 2));
  console.log(`[live-api-capture] wrote ${path.relative(outDir, outPath)} — captured=${summary.captured}/${summary.total}, skipped=${summary.skipped}`);
  return { outPath, seeded, summary };
}

// Allow an explicit run dir via env (for standalone/patch invocation).
function opts_runDir() {
  const d = process.env.PIPELINE_RUN_DIR || process.env.LIVE_API_CAPTURE_RUN_DIR;
  return d && fs.existsSync(d) ? d : null;
}

module.exports = { main, captureLiveApiResponses, normalizeEndpointPath };

if (require.main === module) {
  main().catch((e) => { console.error(`[live-api-capture] ${e.stack || e.message}`); process.exit(1); });
}
