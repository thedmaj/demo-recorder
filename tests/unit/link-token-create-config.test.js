const test = require('node:test');
const assert = require('node:assert');
const {
  inferPlaidLinkProductsFromPrompt,
  inferProductsFromApiSignals,
  detectInvestmentsMoveInvestmentsAuthGetAskBillOnly,
  sanitizeProductsForLinkTokenMix,
} = require('../../scripts/scratch/utils/link-token-create-config');

test("inferPlaidLinkProductsFromPrompt detects investments move / ACATS → emits 'investments_auth'", () => {
  // Investments Move is enabled by 'investments_auth' on /link/token/create,
  // NOT 'investments'. The original assertion (`includes('investments')`)
  // accepted the wrong wire string — which would have called
  // /investments/holdings/get instead of /investments/auth/get after Link.
  // Verified via AskBill + Glean (GTM Playbook Feb 2026) on 2026-05-21.
  const p = inferPlaidLinkProductsFromPrompt(
    'Plaid Investments Move for ACATS transfer and held-away brokerage IRA'
  );
  assert.ok(p.includes('investments_auth'), `expected investments_auth, got: ${p.join(',')}`);
  assert.ok(!p.includes('investments'), `Move prompt must NOT emit 'investments' wire string: ${p.join(',')}`);
});

test('inferPlaidLinkProductsFromPrompt adds identity + auth from API hints', () => {
  const fromApis = inferProductsFromApiSignals(['identity/match', 'auth/get']);
  assert.ok(fromApis.includes('identity'));
  assert.ok(fromApis.includes('auth'));
});

test('inferPlaidLinkProductsFromPrompt picks transactions from prompt', () => {
  const p = inferPlaidLinkProductsFromPrompt('Use /transactions/sync for categorization');
  assert.ok(p.includes('transactions'));
});

// ── Plaid Protect default: protect_linked_bank ─────────────────────────────
// Verified 2026-05-22 via AskBill + Glean GTM Playbook 2026 + Protect Megadoc.
// Default Protect demos MUST emit `protect_linked_bank` (US-only, public)
// unless the prompt explicitly references IDV / identity verification.

test("Plaid Protect prompt defaults to ['protect_linked_bank'] (no IDV mention)", () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'Tilt — Plaid Protect Trust Index for cash-advance and LOC fraud screening using TI Score Full'
  );
  assert.ok(p.includes('protect_linked_bank'), `expected protect_linked_bank, got: ${p.join(',')}`);
  assert.ok(!p.includes('identity_verification'), `must NOT add identity_verification unless prompt mentions IDV: ${p.join(',')}`);
});

test('Plaid Protect prompt adds identity_verification ONLY when IDV explicitly mentioned', () => {
  const p1 = inferPlaidLinkProductsFromPrompt(
    'Plaid Protect with Trust Index and Plaid IDV at signup'
  );
  assert.ok(p1.includes('protect_linked_bank'));
  assert.ok(p1.includes('identity_verification'), `IDV explicitly mentioned → expected identity_verification: ${p1.join(',')}`);

  const p2 = inferPlaidLinkProductsFromPrompt(
    'Plaid Protect for fraud screening. Use identity verification at onboarding.'
  );
  assert.ok(p2.includes('identity_verification'), `"identity verification" phrase → expected identity_verification: ${p2.join(',')}`);
});

test('Plaid Protect prompt with transaction-time scoring adds `signal`', () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'Plaid Protect Trust Index for underwriting decisions; call /signal/evaluate at transaction time'
  );
  assert.ok(p.includes('protect_linked_bank'));
  assert.ok(p.includes('signal'), `transaction scoring intent → expected signal: ${p.join(',')}`);
});

test('Plaid Protect prompt with monitor adds `monitor`', () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'Plaid Protect plus Plaid Monitor for sanctions and PEP screening'
  );
  assert.ok(p.includes('protect_linked_bank'));
  assert.ok(p.includes('monitor'));
});

test('EWA / Cash Advance Score prompts do NOT route to protect_linked_bank (separate family)', () => {
  // Per CLAUDE.md, EWA Score is its own family `cash_advance_score` and uses
  // `['auth', 'signal']` — not protect_linked_bank.
  const p = inferPlaidLinkProductsFromPrompt(
    'Plaid Protect Cash Advance Score for EWA underwriting using /signal/evaluate'
  );
  assert.ok(!p.includes('protect_linked_bank'), `EWA must NOT route to protect_linked_bank: ${p.join(',')}`);
  assert.ok(p.includes('signal'));
  assert.ok(p.includes('auth'));
});

test('protect_linked_bank and protect_transactions survive the CRA/Income mix sanitizer', () => {
  // The sanitizer is for CRA-vs-Income conflict resolution; it must not strip
  // Protect-family products (verified 2026-05-22 — these are public Link product
  // strings per AskBill, not NDA as the prior KB had said).
  const out = sanitizeProductsForLinkTokenMix(
    ['protect_linked_bank', 'protect_transactions', 'signal', 'identity_verification', 'monitor'],
    'auto'
  );
  assert.ok(out.products.includes('protect_linked_bank'), `protect_linked_bank must survive sanitizer: ${out.products.join(',')}`);
  assert.ok(out.products.includes('protect_transactions'), `protect_transactions must survive sanitizer: ${out.products.join(',')}`);
  assert.ok(out.products.includes('signal'));
  assert.ok(out.products.includes('identity_verification'));
  assert.ok(out.products.includes('monitor'));
});

test('inferProductsFromApiSignals routes /protect/event/send → protect_linked_bank', () => {
  const out = inferProductsFromApiSignals(['protect/event/send', 'protect/user/insights/get']);
  assert.ok(out.includes('protect_linked_bank'));
});

test("inferProductsFromApiSignals routes /identity_verification/get → 'identity_verification' (not 'identity')", () => {
  const out = inferProductsFromApiSignals(['identity_verification/get']);
  assert.ok(out.includes('identity_verification'), `expected identity_verification: ${out.join(',')}`);
  assert.ok(!out.includes('identity'), `must NOT also emit 'identity' (different product): ${out.join(',')}`);
});

test('detectInvestmentsMoveInvestmentsAuthGetAskBillOnly requires Move + investments/auth/get', () => {
  assert.ok(
    detectInvestmentsMoveInvestmentsAuthGetAskBillOnly(
      'Plaid Investments Move demo; call POST /investments/auth/get after link.',
      []
    )
  );
  assert.ok(
    detectInvestmentsMoveInvestmentsAuthGetAskBillOnly('Betterment ACATS', ['investments/auth/get']) === false,
    'Investments Move wording required'
  );
  assert.ok(
    detectInvestmentsMoveInvestmentsAuthGetAskBillOnly('Plaid Investments Move', [
      'investments/auth/get',
    ])
  );
  assert.ok(
    detectInvestmentsMoveInvestmentsAuthGetAskBillOnly(
      'Windows path style investments\\auth\\get for Investments Move',
      []
    )
  );
});

// ── Product-mix sanitizer ──────────────────────────────────────────────────
// These tests pin the rules that protect /link/token/create from invalid
// product combinations. They cover the exact BofA-style failure mode that
// motivated this sanitizer (CRA + non-CRA Income mixed by an over-eager
// keyword resolver) plus the income_verification compatibility rule.

test('sanitizeProductsForLinkTokenMix passes through valid simple mixes unchanged', () => {
  const out = sanitizeProductsForLinkTokenMix(['auth', 'identity']);
  assert.deepStrictEqual(out.products, ['auth', 'identity']);
  assert.deepStrictEqual(out.droppedCra, []);
  assert.deepStrictEqual(out.droppedNonCraIncomeIncompatible, []);
});

test('sanitizeProductsForLinkTokenMix preserves CRA-only mix', () => {
  const out = sanitizeProductsForLinkTokenMix(
    ['cra_base_report', 'cra_income_insights'],
    'cra'
  );
  assert.deepStrictEqual(out.products, ['cra_base_report', 'cra_income_insights']);
  assert.deepStrictEqual(out.droppedCra, []);
});

test('sanitizeProductsForLinkTokenMix: CRA + non-CRA Income with auto intent keeps non-CRA Income', () => {
  // BofA-style bad mix: prompt mentions both Bank Income and CRA Income
  // Insights, resolver naively merges. Sanitizer keeps the non-CRA path.
  const out = sanitizeProductsForLinkTokenMix(
    ['identity', 'auth', 'income_verification', 'cra_income_insights']
    // intent defaults to 'auto'
  );
  assert.deepStrictEqual(out.products, ['income_verification']);
  assert.deepStrictEqual(out.droppedCra, ['cra_income_insights']);
  // identity and auth get dropped by Layer 2 (income_verification compat)
  assert.ok(out.droppedNonCraIncomeIncompatible.includes('identity'));
  assert.ok(out.droppedNonCraIncomeIncompatible.includes('auth'));
});

test('sanitizeProductsForLinkTokenMix: CRA + non-CRA Income with cra intent keeps CRA path', () => {
  const out = sanitizeProductsForLinkTokenMix(
    ['identity', 'auth', 'income_verification', 'cra_income_insights', 'cra_base_report'],
    'cra'
  );
  assert.ok(out.products.includes('cra_base_report'));
  assert.ok(out.products.includes('cra_income_insights'));
  assert.ok(!out.products.includes('income_verification'));
  assert.deepStrictEqual(out.droppedNonCraIncomeIncompatible, ['income_verification']);
});

test('sanitizeProductsForLinkTokenMix: income_verification + auth + identity drops auth and identity (Layer 2)', () => {
  // Plaid: "only income_verification and employment may be configured"
  const out = sanitizeProductsForLinkTokenMix(['income_verification', 'auth', 'identity']);
  assert.deepStrictEqual(out.products, ['income_verification']);
  assert.deepStrictEqual(out.droppedNonCraIncomeIncompatible.sort(), ['auth', 'identity']);
});

test('sanitizeProductsForLinkTokenMix: income_verification + employment is valid combo', () => {
  const out = sanitizeProductsForLinkTokenMix(['income_verification', 'employment']);
  assert.deepStrictEqual(out.products.sort(), ['employment', 'income_verification']);
  assert.deepStrictEqual(out.droppedNonCraIncomeIncompatible, []);
});

test('sanitizeProductsForLinkTokenMix: empty / null inputs normalize to []', () => {
  assert.deepStrictEqual(sanitizeProductsForLinkTokenMix([]).products, []);
  assert.deepStrictEqual(sanitizeProductsForLinkTokenMix(null).products, []);
  assert.deepStrictEqual(sanitizeProductsForLinkTokenMix(undefined).products, []);
});

// ── EWA / Cash Advance Score — 'signal' is a valid Link product ───────────
// 'signal' was added to /link/token/create products in Oct 2024 (verified via
// AskBill 2026-05-21). Cash Advance Score requires it. These tests pin both
// the ALLOWED_LINK_PRODUCTS membership and the inference behavior.

test("ALLOWED_LINK_PRODUCTS includes 'signal' (required for Cash Advance Score)", () => {
  const { ALLOWED_LINK_PRODUCTS } = require('../../scripts/scratch/utils/link-token-create-config');
  assert.ok(ALLOWED_LINK_PRODUCTS.has('signal'), "'signal' must be a valid Link product since Oct 2024");
});

test("ALLOWED_LINK_PRODUCTS does NOT include 'protect' (umbrella name, not a Link product string)", () => {
  // Verified via AskBill 2026-05-21: sending products: ['protect'] returns
  // an error. The Plaid Protect umbrella is enabled by combining its
  // component product strings (signal, identity_verification, monitor),
  // never via a top-level 'protect' string.
  const { ALLOWED_LINK_PRODUCTS } = require('../../scripts/scratch/utils/link-token-create-config');
  assert.ok(!ALLOWED_LINK_PRODUCTS.has('protect'), "'protect' must NEVER be a valid Link product string");
});

test("inferPlaidLinkProductsFromPrompt does NOT emit 'protect' for Plaid Protect prompts", () => {
  // Bundled Plaid Protect demos default to 'signal' (the core
  // documented component); demos that need IDV/Monitor opt in via prompt
  // and their respective separate flows. We must never produce a 'protect'
  // wire string.
  const products = inferPlaidLinkProductsFromPrompt(
    'Plaid Protect demo featuring Trust Index and bundled signal scoring.'
  );
  assert.ok(!products.includes('protect'), "Resolver must never emit 'protect' as a Link product");
});

// ── Investments Move vs Investments wire format ───────────────────────────
// Two distinct products in the 'investments' family share keywords but use
// DIFFERENT Link product strings. The resolver MUST emit the correct one or
// the host app will call the wrong endpoint after Link.

test("ALLOWED_LINK_PRODUCTS includes 'investments_auth' (required for Investments Move)", () => {
  const { ALLOWED_LINK_PRODUCTS } = require('../../scripts/scratch/utils/link-token-create-config');
  assert.ok(
    ALLOWED_LINK_PRODUCTS.has('investments_auth'),
    "'investments_auth' must be allowed — it's the wire string for Plaid Investments Move"
  );
});

test("ALLOWED_LINK_PRODUCTS includes 'investments' (data-access product)", () => {
  const { ALLOWED_LINK_PRODUCTS } = require('../../scripts/scratch/utils/link-token-create-config');
  assert.ok(ALLOWED_LINK_PRODUCTS.has('investments'));
});

test("inferPlaidLinkProductsFromPrompt emits 'investments_auth' (NOT 'investments') for Move prompts", () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'Robinhood ACATS transfer initiation: call /investments/auth/get to get DTC numbers.'
  );
  assert.ok(p.includes('investments_auth'), 'Move prompts must emit investments_auth');
  assert.ok(!p.includes('investments'), "Move prompts must NOT emit 'investments' (wrong product)");
});

test("inferPlaidLinkProductsFromPrompt emits 'investments' (NOT 'investments_auth') for data-access prompts", () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'PFM dashboard: portfolio holdings and 12 months of investment transactions for wealth tracking.'
  );
  assert.ok(p.includes('investments'), 'Data-access prompts must emit investments');
  assert.ok(!p.includes('investments_auth'), 'Data-access prompts must NOT emit investments_auth');
});

test('inferPlaidLinkProductsFromPrompt emits Move product when both Move and Investments keywords appear', () => {
  // GTM-style narrative often says "Plaid Investments Move (part of our
  // Investments product line)". The Move signal must win — picking
  // 'investments' here would silently break the demo.
  const p = inferPlaidLinkProductsFromPrompt(
    'Plaid Investments Move demo as part of the broader Plaid Investments product family. ACATS transfer.'
  );
  assert.ok(p.includes('investments_auth'));
  assert.ok(!p.includes('investments'));
});

test('inferProductsFromApiSignals routes /investments/auth/get to investments_auth (not investments)', () => {
  const p = inferProductsFromApiSignals(['/investments/auth/get']);
  assert.ok(p.includes('investments_auth'));
  assert.ok(!p.includes('investments'));
});

test('inferProductsFromApiSignals routes /investments/holdings/get to investments', () => {
  const p = inferProductsFromApiSignals(['/investments/holdings/get']);
  assert.ok(p.includes('investments'));
  assert.ok(!p.includes('investments_auth'));
});

test('inferProductsFromApiSignals does NOT add bare auth product when only /investments/auth/get is signalled', () => {
  // Without the Investments Move-aware override, the substring 'auth' in
  // '/investments/auth/get' would have added 'auth' to the products list,
  // accidentally enabling Plaid Auth (account/routing) for a demo that
  // only needs Investments Move.
  const p = inferProductsFromApiSignals(['/investments/auth/get']);
  assert.ok(!p.includes('auth'), "Bare 'auth' must not appear when only the Move endpoint is signalled");
});

test("inferPlaidLinkProductsFromPrompt adds 'auth' + 'signal' for EWA prompts", () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'Plaid EWA Score / Cash Advance Score demo: read scores.cash_advance at disbursement.'
  );
  assert.ok(p.includes('signal'), 'EWA prompts need signal in products[]');
  assert.ok(p.includes('auth'), 'EWA prompts need auth in products[]');
});

test("inferPlaidLinkProductsFromPrompt adds 'auth' + 'signal' for Earned Wage Access prompts", () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'Earned Wage Access for advance underwriting; approve $150 advance.'
  );
  assert.ok(p.includes('signal'));
  assert.ok(p.includes('auth'));
});

test("inferPlaidLinkProductsFromPrompt adds signal for standalone Auth + Identity Match + Signal funding demos", () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'Huntington external account funding with Plaid Auth POST /auth/get, Plaid Identity Match, and Plaid Signal. POST /signal/evaluate before ACH release.'
  );
  assert.ok(p.includes('identity'));
  assert.ok(p.includes('auth'));
  assert.ok(p.includes('signal'), `expected signal in products[]: ${p.join(',')}`);
});

test('inferProductsFromApiSignals maps /signal/evaluate to signal', () => {
  const p = inferProductsFromApiSignals(['POST /signal/evaluate']);
  assert.ok(p.includes('signal'));
});

test('sanitizeProductsForLinkTokenMix passes [auth, signal] through unchanged', () => {
  // The canonical EWA Link products list must survive the product-mix
  // sanitizer (no Layer 1 CRA / Layer 2 income_verification triggers).
  const out = sanitizeProductsForLinkTokenMix(['auth', 'signal']);
  assert.deepStrictEqual(out.products.sort(), ['auth', 'signal']);
  assert.deepStrictEqual(out.droppedCra, []);
  assert.deepStrictEqual(out.droppedNonCraIncomeIncompatible, []);
});
