'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  getEffectiveProductFamily,
  textHasPositiveCraKeywordSignal,
  shouldIncludeCraRunNameToken,
  shouldAllowCraSkillFileTrigger,
  detectProductSlugFromPrompt,
} = require(path.join(__dirname, '../../scripts/scratch/utils/prompt-scope'));

const { resolveMemberPaths } = require(path.join(
  __dirname,
  '../../scripts/scratch/utils/plaid-skill-loader'
));

describe('prompt-scope', () => {
  const disclaimerBlock =
    '**Compliance / user data (one line):**\n' +
    'Consumer checking onboarding with customer consent for account linking and verification; no CRA consumer report storyline unless explicitly added later.\n\n' +
    '**Primary product family**\n' +
    'funding\n\n' +
    '**Story arc:** Plaid Signal scores a low-risk ACH payment during onboarding.';

  test('disclaimer with CRA substrings + explicit funding does not select CRA', () => {
    assert.equal(getEffectiveProductFamily(disclaimerBlock), 'funding');
    assert.equal(textHasPositiveCraKeywordSignal(disclaimerBlock), false);
    assert.equal(shouldIncludeCraRunNameToken(disclaimerBlock), false);
    assert.equal(shouldAllowCraSkillFileTrigger(disclaimerBlock, 'funding'), false);
    assert.equal(detectProductSlugFromPrompt(disclaimerBlock), 'signal');
  });

  test('explicit CRA base report family wins', () => {
    const p =
      '**Primary product family**\n' +
      'cra_base_report\n\n' +
      'Underwriting demo using Plaid Check.';
    assert.equal(getEffectiveProductFamily(p), 'cra_base_report');
    assert.equal(shouldIncludeCraRunNameToken(p), true);
    assert.equal(detectProductSlugFromPrompt(p), 'cra-base-report');
  });

  test('no primary family: positive consumer report line selects CRA', () => {
    const p = 'Short prompt.\n\nWe pull a consumer report for underwriting with Plaid Check.';
    assert.equal(getEffectiveProductFamily(p), 'cra_base_report');
    assert.equal(textHasPositiveCraKeywordSignal(p), true);
    assert.equal(shouldIncludeCraRunNameToken(p), true);
    assert.equal(detectProductSlugFromPrompt(p), 'cra-base-report');
  });

  test('resolveMemberPaths skips cra.md trigger when prompt scope is funding-only', () => {
    const paths = resolveMemberPaths('funding', { promptText: disclaimerBlock, demoScript: {} });
    assert.equal(paths.includes('references/products/cra.md'), false);
  });

  // ── EWA / Cash Advance Score routing ─────────────────────────────────────
  // Regression tests for the bug where EWA Score demos were misclassified
  // as standard Plaid Signal demos. Cash Advance Score IS delivered via
  // /signal/evaluate, but it's a distinct product (different field name,
  // different narrative, Sales-enabled). The pipeline must load
  // inputs/products/plaid-ewa-score.md, not plaid-signal.md.

  test('EWA prompt with explicit cash_advance_score family routes to EWA, not Signal', () => {
    const p =
      '**Primary product family**\n' +
      'cash_advance_score\n\n' +
      'Plaid EWA Score runs at disbursement; not Plaid Signal ACH return-risk framing.';
    assert.equal(getEffectiveProductFamily(p), 'cash_advance_score');
    assert.equal(detectProductSlugFromPrompt(p), 'ewa-score');
  });

  test('EWA prompt with NO explicit family but "Cash Advance Score" keyword routes to EWA', () => {
    const p =
      'Earned Wage Access demo. Plaid Cash Advance Score evaluates the request and approves a $150 advance.';
    assert.equal(getEffectiveProductFamily(p), 'cash_advance_score');
    assert.equal(detectProductSlugFromPrompt(p), 'ewa-score');
  });

  test('"EWA" abbreviation alone routes to ewa-score, not signal', () => {
    const p = 'Current adds EWA Score to underwrite paycheck advances.';
    assert.equal(getEffectiveProductFamily(p), 'cash_advance_score');
    assert.equal(detectProductSlugFromPrompt(p), 'ewa-score');
  });

  test('"Earned Wage Access" phrase routes to ewa-score even when prompt mentions Signal comparatively', () => {
    // Pattern matching the canonical user prompt: EWA demo that explicitly
    // disclaims standard-Signal framing.
    const p =
      'Earned Wage Access for advance underwriting. NOT standard Plaid Signal ACH risk; this is the EWA-specific Cash Advance Score via Auth + Signal evaluate.';
    assert.equal(getEffectiveProductFamily(p), 'cash_advance_score');
    assert.equal(detectProductSlugFromPrompt(p), 'ewa-score');
  });

  test('standard Signal prompt (without EWA wording) still routes to funding/signal', () => {
    const p = 'Onboarding ACH risk demo. Plaid Signal scores account-funding pull as low risk.';
    assert.equal(getEffectiveProductFamily(p), 'funding');
    assert.equal(detectProductSlugFromPrompt(p), 'signal');
  });

  test('EWA prompt with "scores.cash_advance.score" reference routes to ewa-score', () => {
    // The literal response field path is enough on its own. This guards
    // against build-app.js generated HTML that embeds the response shape.
    const p = 'Read response.scores.cash_advance.score to decide the advance amount.';
    assert.equal(getEffectiveProductFamily(p), 'cash_advance_score');
    assert.equal(detectProductSlugFromPrompt(p), 'ewa-score');
  });

  // ── Plaid Protect (umbrella) routing ─────────────────────────────────────
  // Regression tests for routing Protect / Trust Index / Ti2 demos to the
  // plaid_protect family + plaid-protect knowledge file, rather than the
  // generic 'signal' / 'funding' bucket. Verified via AskBill + Glean GTM
  // Playbook (2026).

  test('Explicit plaid_protect family routes to plaid-protect', () => {
    const p =
      '**Primary product family**\n' +
      'plaid_protect\n\n' +
      'Bundled Plaid Protect demo with Trust Index reveal.';
    assert.equal(getEffectiveProductFamily(p), 'plaid_protect');
    assert.equal(detectProductSlugFromPrompt(p), 'plaid-protect');
  });

  test('"Plaid Protect" keyword without explicit family routes to plaid-protect', () => {
    const p = 'Onboarding demo featuring Plaid Protect: identity, signal, monitor in one decision.';
    assert.equal(getEffectiveProductFamily(p), 'plaid_protect');
    assert.equal(detectProductSlugFromPrompt(p), 'plaid-protect');
  });

  test('"Trust Index" keyword routes to plaid-protect (not signal)', () => {
    // Trust Index is the current Plaid public marketing term for the Protect
    // core score (Ti2 shipped Oct 2025). Prompts mentioning Trust Index must
    // load plaid-protect.md, not plaid-signal.md.
    const p = 'Demo reveal: Trust Index 87 — verified user, accept onboarding.';
    assert.equal(getEffectiveProductFamily(p), 'plaid_protect');
    assert.equal(detectProductSlugFromPrompt(p), 'plaid-protect');
  });

  test('"Ti2" keyword routes to plaid-protect', () => {
    const p = 'Reference the Ti2 launch when narrating the trust score.';
    assert.equal(getEffectiveProductFamily(p), 'plaid_protect');
    assert.equal(detectProductSlugFromPrompt(p), 'plaid-protect');
  });

  test('Plaid Protect prompt with comparative Signal mention still routes to plaid-protect', () => {
    // Common GTM pattern: position Protect as the umbrella over Signal.
    // Must NOT fall through to the funding/signal family.
    const p =
      'Plaid Protect bundles transaction risk (the same engine as Plaid Signal) with identity verification and monitor — one ruleset, one decision.';
    assert.equal(getEffectiveProductFamily(p), 'plaid_protect');
    assert.equal(detectProductSlugFromPrompt(p), 'plaid-protect');
  });

  test('EWA prompt that name-drops "Plaid Protect" still routes to ewa-score (EWA wins over Protect)', () => {
    // Order in the resolver: cash_advance_score is checked BEFORE
    // plaid_protect because EWA demos often mention the parent solution
    // ("Plaid Protect Cash Advance Score") but are tactically EWA, not the
    // bundled Trust Index story.
    const p =
      'Plaid Protect Cash Advance Score (EWA) approves a $150 advance; read scores.cash_advance.score.';
    assert.equal(getEffectiveProductFamily(p), 'cash_advance_score');
    assert.equal(detectProductSlugFromPrompt(p), 'ewa-score');
  });

  test('Standard Signal-only prompt (no Protect/Trust Index wording) still routes to funding/signal', () => {
    const p =
      'Onboarding ACH risk demo. Plaid Signal evaluates the funding pull as low risk (score 12 — ACCEPT).';
    assert.equal(getEffectiveProductFamily(p), 'funding');
    assert.equal(detectProductSlugFromPrompt(p), 'signal');
  });

  // ── Plaid Investments vs Plaid Investments Move ──────────────────────────
  // Same family of words ("investments") but two completely different
  // products with different Link product strings, endpoints, and use cases.
  // Misrouting calls the wrong endpoint after Link and breaks the demo.

  test('Explicit investments_move family routes to investments-move slug', () => {
    const p =
      '**Primary product family**\n' +
      'investments_move\n\n' +
      'Robinhood-style ACATS transfer initiation demo.';
    assert.equal(getEffectiveProductFamily(p), 'investments_move');
    assert.equal(detectProductSlugFromPrompt(p), 'investments-move');
  });

  test('Explicit investments family routes to investments slug', () => {
    const p =
      '**Primary product family**\n' +
      'investments\n\n' +
      'PFM portfolio holdings demo.';
    assert.equal(getEffectiveProductFamily(p), 'investments');
    assert.equal(detectProductSlugFromPrompt(p), 'investments');
  });

  test('"ACATS" keyword alone routes to investments_move (not investments)', () => {
    const p = 'New brokerage onboarding with ACATS transfer initiation.';
    assert.equal(getEffectiveProductFamily(p), 'investments_move');
    assert.equal(detectProductSlugFromPrompt(p), 'investments-move');
  });

  test('"/investments/auth/get" endpoint path routes to investments_move', () => {
    const p = 'Call POST /investments/auth/get after Link to populate the receiving broker form.';
    assert.equal(getEffectiveProductFamily(p), 'investments_move');
    assert.equal(detectProductSlugFromPrompt(p), 'investments-move');
  });

  test('"portfolio holdings" / "/investments/holdings/get" routes to investments (data access)', () => {
    const p = 'PFM dashboard pulls portfolio holdings via /investments/holdings/get to show net worth.';
    assert.equal(getEffectiveProductFamily(p), 'investments');
    assert.equal(detectProductSlugFromPrompt(p), 'investments');
  });

  test('Bare "investments" routes to investments (data access) when Move keywords are absent', () => {
    const p = 'Plaid Investments demo: connect a brokerage, show top three holdings.';
    assert.equal(getEffectiveProductFamily(p), 'investments');
    assert.equal(detectProductSlugFromPrompt(p), 'investments');
  });

  test('"Investments Move" wins over bare "investments" mention in the same prompt', () => {
    // GTM language often says "we use Plaid Investments for transfers" or
    // similar. The Move-specific signal must win — otherwise the demo would
    // call the wrong endpoint.
    const p = 'Plaid Investments Move for ACATS transfers; our investments product story.';
    assert.equal(getEffectiveProductFamily(p), 'investments_move');
    assert.equal(detectProductSlugFromPrompt(p), 'investments-move');
  });

  test('ATON Canada keyword routes to investments_move', () => {
    const p = 'Canadian brokerage transfer initiation via ATON.';
    assert.equal(getEffectiveProductFamily(p), 'investments_move');
    assert.equal(detectProductSlugFromPrompt(p), 'investments-move');
  });

  test('"held-away" account routes to investments_move (not investments)', () => {
    const p = 'Customer wants to transfer their held-away brokerage account to our platform.';
    assert.equal(getEffectiveProductFamily(p), 'investments_move');
    assert.equal(detectProductSlugFromPrompt(p), 'investments-move');
  });

  // ── Plaid Liabilities routing ────────────────────────────────────────────
  // Non-FCRA debt-data product. Routes prompts about debt paydown, credit
  // card APRs, mortgage refi (PFM-style), net-worth dashboards, and the LIT
  // bundle to family `liabilities`. Critical rule: lending / underwriting
  // narratives must continue to route to cra_base_report (FCRA), NOT to
  // Liabilities (non-FCRA).

  test('Explicit liabilities family routes to liabilities slug', () => {
    const p =
      '**Primary product family**\n' +
      'liabilities\n\n' +
      'Debt-paydown app linking credit cards + mortgage + private student loan.';
    assert.equal(getEffectiveProductFamily(p), 'liabilities');
    assert.equal(detectProductSlugFromPrompt(p), 'liabilities');
  });

  test('Bare "liabilities" keyword routes to liabilities', () => {
    const p = 'Customer wants to add Plaid Liabilities to surface debt details in their PFM app.';
    assert.equal(getEffectiveProductFamily(p), 'liabilities');
    assert.equal(detectProductSlugFromPrompt(p), 'liabilities');
  });

  test('"/liabilities/get" endpoint reference routes to liabilities', () => {
    const p = 'After Link, call POST /liabilities/get to retrieve credit, mortgage, and student loan data.';
    assert.equal(getEffectiveProductFamily(p), 'liabilities');
    assert.equal(detectProductSlugFromPrompt(p), 'liabilities');
  });

  test('"debt paydown" keyword routes to liabilities', () => {
    const p = 'DoorDash Crimson debt-paydown calculator for Dashers — show APR + minimum + due date.';
    assert.equal(getEffectiveProductFamily(p), 'liabilities');
    assert.equal(detectProductSlugFromPrompt(p), 'liabilities');
  });

  test('"net-worth dashboard" routes to liabilities (LIT bundle entry point)', () => {
    const p = 'Build a Copilot-style net-worth dashboard: assets minus debts in one view.';
    assert.equal(getEffectiveProductFamily(p), 'liabilities');
    assert.equal(detectProductSlugFromPrompt(p), 'liabilities');
  });

  test('"LIT bundle" keyword routes to liabilities', () => {
    const p = 'LIT bundle demo for a wealth-tracking app — Liabilities, Investments, Transactions on one Link token.';
    assert.equal(getEffectiveProductFamily(p), 'liabilities');
    assert.equal(detectProductSlugFromPrompt(p), 'liabilities');
  });

  test('"credit card APR" routes to liabilities (PFM intent, not Signal)', () => {
    const p = 'Surface each credit card APR and minimum payment to help users prioritize debt paydown.';
    assert.equal(getEffectiveProductFamily(p), 'liabilities');
    assert.equal(detectProductSlugFromPrompt(p), 'liabilities');
  });

  test('"mortgage refinance" routes to liabilities (PFM/refi narrative)', () => {
    const p = 'LendingTree mortgage refinance amortization view with escrow balance and ytd_interest_paid.';
    assert.equal(getEffectiveProductFamily(p), 'liabilities');
    assert.equal(detectProductSlugFromPrompt(p), 'liabilities');
  });

  test('Lending / underwriting prompt with "debt" keyword still routes to cra_base_report (NOT liabilities)', () => {
    // The non-FCRA boundary: Liabilities cannot drive underwriting decisions.
    // A prompt explicitly about consumer-report underwriting must route to
    // cra_base_report, not Liabilities, even if it mentions debts.
    const p = 'Personal loan underwriting demo using Plaid Check consumer report to assess debt-to-income.';
    assert.equal(getEffectiveProductFamily(p), 'cra_base_report');
    assert.equal(detectProductSlugFromPrompt(p), 'cra-base-report');
  });

  test('Liabilities prompt that also mentions Auth still routes to liabilities (LIT bundle)', () => {
    // The LIT bundle often mentions Plaid Auth for account-routing context.
    // The Liabilities family must win over the generic 'funding'/'auth'
    // detection — Liabilities is the primary intent.
    const p =
      'Net-worth dashboard with Plaid Auth for routing context plus Liabilities for debts plus Investments for holdings.';
    assert.equal(getEffectiveProductFamily(p), 'liabilities');
    assert.equal(detectProductSlugFromPrompt(p), 'liabilities');
  });
});
