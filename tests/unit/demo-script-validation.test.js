'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  validateDemoScript,
  isInsightLikeStep,
  isAmountEntryStep,
} = require(path.join(__dirname, '../../scripts/scratch/scratch/generate-script'));

describe('demo-script validation', () => {
  test('insight step without apiResponse → error', () => {
    const result = validateDemoScript({
      steps: [
        { id: 'identity-match-insight', label: 'Identity insight', visualState: 'Plaid API insight screen' },
      ],
    });
    assert.ok(result.errors.some(e => /apiResponse/.test(e)));
  });

  test('identity/auth/signal out of order → errors', () => {
    const result = validateDemoScript({
      steps: [
        { id: 'signal-insight', apiResponse: { endpoint: 'POST /signal/evaluate', response: {} } },
        { id: 'auth-insight', apiResponse: { endpoint: 'POST /auth/get', response: {} } },
        { id: 'identity-match-insight', apiResponse: { endpoint: 'POST /identity/match', response: {} } },
      ],
    }, { productFamily: 'funding' });
    assert.ok(result.errors.some(e => /Identity Match must appear before Auth/.test(e)));
    assert.ok(result.errors.some(e => /Auth must appear before Signal/.test(e)));
  });

  test('warns when amount step missing between auth and signal', () => {
    const result = validateDemoScript({
      steps: [
        { id: 'auth-insight', apiResponse: { endpoint: 'POST /auth/get', response: {} } },
        { id: 'signal-insight', apiResponse: { endpoint: 'POST /signal/evaluate', response: {} } },
      ],
    }, { productFamily: 'funding' });
    assert.ok(result.warnings.some(w => /amount-entry step/.test(w)));
  });

  test('valid funding flow → no validation errors', () => {
    const result = validateDemoScript({
      steps: [
        { id: 'identity-match-insight', apiResponse: { endpoint: 'POST /identity/match', response: {} } },
        { id: 'auth-insight', apiResponse: { endpoint: 'POST /auth/get', response: {} } },
        { id: 'amount-entry', label: 'Enter amount', narration: 'Enter the transfer amount.' },
        { id: 'signal-insight', apiResponse: { endpoint: 'POST /signal/evaluate', response: {} } },
      ],
    }, { productFamily: 'funding' });
    assert.deepEqual(result.errors, []);
  });

  test('CRA Base Report requires report endpoint and favors report-ready beat', () => {
    const result = validateDemoScript({
      steps: [
        { id: 'cra-launch', narration: 'User links account.' },
        { id: 'cra-summary', narration: 'Underwriter reviews the report.' },
      ],
    }, { productFamily: 'cra_base_report' });
    assert.ok(result.errors.some(e => /base_report\/get/.test(e)));
    assert.ok(result.warnings.some(w => /report-ready/.test(w)));
  });

  test('CRA Income Insights flow requires CRA income endpoint and report-ready beat', () => {
    const result = validateDemoScript({
      steps: [
        { id: 'income-launch', narration: 'User completes the CRA income flow.' },
        { id: 'income-summary', narration: 'Income summary is visible.' },
      ],
    }, { productFamily: 'income_insights' });
    assert.ok(result.errors.some(e => /income_insights\/get/.test(e)));
    assert.ok(result.warnings.some(w => /report-ready or report-available beat/.test(w)));
  });

  test('helper detects insight-like and amount-entry steps', () => {
    assert.equal(isInsightLikeStep({ id: 'signal-insight' }), true);
    assert.equal(isInsightLikeStep({ label: 'Signal API Insight' }), true);
    assert.equal(isInsightLikeStep({ id: 'instant-approval' }), false);
    assert.equal(isAmountEntryStep({ id: 'amount-entry' }), true);
    assert.equal(isAmountEntryStep({ narration: 'The user enters the funding amount.' }), true);
  });
});
