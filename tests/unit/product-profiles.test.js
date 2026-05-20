'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  PRODUCT_FAMILIES,
  inferProductFamilyFromText,
  inferProductFamily,
  getProductProfile,
} = require(path.join(__dirname, '../../scripts/scratch/utils/product-profiles'));

describe('product-profiles', () => {
  test('CRA wording resolves to cra_base_report', () => {
    assert.equal(inferProductFamilyFromText('Build a CRA Base Report underwriting demo'), 'cra_base_report');
  });

  test('income wording resolves to income_insights', () => {
    assert.equal(inferProductFamilyFromText('CRA Income Insights underwriting review'), 'income_insights');
  });

  test('funding wording resolves to funding', () => {
    assert.equal(inferProductFamilyFromText('Signal plus Auth account funding flow'), 'funding');
  });

  test('demoScript endpoint inference resolves to CRA', () => {
    const family = inferProductFamily({
      demoScript: {
        product: 'Plaid Check Base Report',
        steps: [{ id: 'base-report-insight', apiResponse: { endpoint: '/cra/check_report/base_report/get' } }],
      },
    });
    assert.equal(family, 'cra_base_report');
  });

  test('returns generic profile for unknown text', () => {
    assert.equal(inferProductFamilyFromText('Something unrelated'), 'generic');
    assert.equal(getProductProfile('unknown').key, 'generic');
  });
});

// ─── 2026 expanded families ─────────────────────────────────────────────────

describe('product-profiles — 2026 expanded families', () => {
  const EXPECTED_NEW_FAMILIES = [
    'bank_income',
    'assets',
    'cra_underwriting',
    'cra_lend_score',
    'cra_network_insights',
    'cra_cashflow_insights',
    'cra_partner_insights',
    'cra_cashflow_updates',
    'cra_home_lending',
    'investments_move',
    'investments',
    'liabilities',
    'transactions',
    'recurring_transactions',
    'enrich',
    'identity_verification',
    'transfer',
    'guaranteed_ach',
    'monitor',
    'plaid_protect',
    'cash_advance_score',
  ];

  for (const fam of EXPECTED_NEW_FAMILIES) {
    test(`PRODUCT_FAMILIES["${fam}"] is registered with required fields`, () => {
      const p = PRODUCT_FAMILIES[fam];
      assert.ok(p, `family "${fam}" must be present`);
      assert.equal(p.key, fam, 'key must match registry index');
      assert.ok(typeof p.label === 'string' && p.label.length > 0, 'label must be a non-empty string');
      assert.ok(Array.isArray(p.kbSlugs), 'kbSlugs must be an array');
      assert.ok(Array.isArray(p.accuracyRules) && p.accuracyRules.length >= 3,
        `accuracyRules must have at least 3 entries (got ${p.accuracyRules?.length})`);
      assert.ok(Array.isArray(p.critiqueRules) && p.critiqueRules.length >= 1,
        'critiqueRules must have at least 1 entry');
    });
  }

  test('total registered families is at least 25 (4 legacy + 21 new)', () => {
    assert.ok(Object.keys(PRODUCT_FAMILIES).length >= 25);
  });

  test('explicit "Primary product family: bank_income" in prompt selects bank_income', () => {
    const prompt = `# Demo Title\n\n**Primary product family** (pick one):\nbank_income\n\n... rest of prompt ...`;
    assert.equal(inferProductFamilyFromText(prompt), 'bank_income');
  });

  test('explicit "Primary product family: transfer" selects transfer', () => {
    const prompt = `Some prompt body that is long enough to hit the explicit-family parsing path.\n` +
      `Padding line padding line padding line padding line padding line padding line padding line.\n` +
      `Padding line padding line padding line padding line padding line padding line padding line.\n` +
      `Padding line padding line padding line padding line padding line padding line padding line.\n` +
      `Padding line padding line padding line padding line padding line padding line padding line.\n` +
      `**Primary product family**:\ntransfer\n\n...`;
    assert.equal(inferProductFamilyFromText(prompt), 'transfer');
  });

  test('hyphenated slug "investments-move" is normalized to investments_move', () => {
    const prompt = `Padding line padding line padding line padding line padding line padding line.\n` +
      `Padding line padding line padding line padding line padding line padding line padding.\n` +
      `Padding line padding line padding line padding line padding line padding line padding.\n` +
      `Padding line padding line padding line padding line padding line padding line padding.\n` +
      `Padding line padding line padding line padding line padding line padding line padding.\n` +
      `**Primary product family**:\ninvestments-move\n`;
    assert.equal(inferProductFamilyFromText(prompt), 'investments_move');
  });

  test('keyword inference for "funding" still wins when family is not declared explicitly', () => {
    // Back-compat: bank_income / transfer / etc. require explicit opt-in. Legacy
    // prompts with Signal/Auth keywords still map to funding.
    const prompt = 'Signal plus Auth account funding flow for a checking deposit.';
    assert.equal(inferProductFamilyFromText(prompt), 'funding');
  });

  test('each new family profile is retrievable via getProductProfile()', () => {
    for (const fam of EXPECTED_NEW_FAMILIES) {
      const p = getProductProfile(fam);
      assert.equal(p.key, fam);
    }
  });
});
