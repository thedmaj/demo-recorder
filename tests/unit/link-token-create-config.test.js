const test = require('node:test');
const assert = require('node:assert');
const {
  inferPlaidLinkProductsFromPrompt,
  inferProductsFromApiSignals,
  detectInvestmentsMoveInvestmentsAuthGetAskBillOnly,
} = require('../../scripts/scratch/utils/link-token-create-config');

test('inferPlaidLinkProductsFromPrompt detects investments move / ACATS', () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'Plaid Investments Move for ACATS transfer and held-away brokerage IRA'
  );
  assert.ok(p.includes('investments'), p.join(','));
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
