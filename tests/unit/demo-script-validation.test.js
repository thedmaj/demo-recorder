'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  validateDemoScript,
  isInsightLikeStep,
  isAmountEntryStep,
  ensureFinalValueSummarySlide,
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

  test('ensureFinalValueSummarySlide appends final summary slide from research value props', () => {
    const script = {
      steps: [
        { id: 'intro', label: 'Intro', narration: 'Intro narration for host step.', durationHintMs: 5000 },
      ],
    };
    const research = {
      synthesizedInsights: {
        valuePropositions: ['Approve good users faster', 'Reduce fraud losses'],
      },
    };
    const result = ensureFinalValueSummarySlide(script, research);
    assert.ok(result, 'Expected value summary normalization result');
    const finalStep = script.steps[script.steps.length - 1];
    assert.equal(finalStep.id, 'value-summary-slide');
    assert.equal(finalStep.sceneType, 'slide');
    assert.ok(/approve good users faster/i.test(finalStep.narration));
  });

  test('validateDemoScript requires final value summary slide when enabled', () => {
    const missing = validateDemoScript({
      steps: [{ id: 'intro', label: 'Intro', narration: 'Welcome screen.' }],
    }, { requireFinalValueSummarySlide: true });
    assert.ok(missing.errors.some((e) => /Final step must be a value-summary slide/.test(e)));

    const passing = validateDemoScript({
      steps: [{ id: 'value-summary-slide', label: 'Value Summary', sceneType: 'slide', narration: 'Clear value outcomes for users and business.', visualState: '.slide-root summary.' }],
    }, { requireFinalValueSummarySlide: true });
    assert.equal(passing.errors.length, 0);
  });

  test('app-only host step warns when visualState names a Plaid product on-screen', () => {
    const result = validateDemoScript({
      steps: [
        {
          id: 'ownership-confirmed',
          label: 'Ownership confirmed',
          sceneType: 'host',
          narration: 'BofA confirms ownership of the external account.',
          visualState: 'BofA-branded ownership page showing Identity Match scores grid (NAME 88, ADDRESS 95, PHONE 95, EMAIL 62) with "Powered by Plaid" footer.',
        },
      ],
    }, { pipelineAppOnlyHostUi: true });
    assert.equal(result.errors.length, 0, 'soft warning only — should not block the build');
    assert.ok(result.warnings.some((w) => /ownership-confirmed/.test(w) && /Plaid product/i.test(w)),
      'warning should call out naming a Plaid product on-screen');
    assert.ok(result.warnings.some((w) => /Plaid attribution/i.test(w)),
      'warning should call out "Powered by Plaid" attribution');
    assert.ok(result.warnings.some((w) => /API score breakdowns|raw API fields/i.test(w)),
      'warning should flag the NAME/ADDRESS/PHONE/EMAIL score grid');
  });

  test('app-only host step with plain-English visualState → no warning', () => {
    const result = validateDemoScript({
      steps: [
        {
          id: 'ownership-confirmed',
          label: 'Ownership confirmed',
          sceneType: 'host',
          narration: 'Under the hood, Identity Match confirmed ownership; here the customer sees the plain confirmation.',
          visualState: 'Ownership confirmed page: green check, bank name + masked account, "Verified owner" pill, Continue button.',
        },
      ],
    }, { pipelineAppOnlyHostUi: true });
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.filter((w) => /ownership-confirmed/.test(w)).length, 0,
      'plain host-UI visualState must not trigger the app-only leak warning');
  });

  test('app-only does not restrict narration (Plaid names allowed in voiceover)', () => {
    const result = validateDemoScript({
      steps: [
        {
          id: 'ownership-confirmed',
          label: 'Ownership confirmed',
          sceneType: 'host',
          // Narration MAY name Plaid products — it's the voiceover, not the UI.
          narration: 'Under the hood, Plaid Identity Match compared Bank of America KYC with the external bank and cleared ownership.',
          visualState: 'Ownership confirmed page with verified badge and Continue button.',
        },
      ],
    }, { pipelineAppOnlyHostUi: true });
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0, 'narration fields are explicitly allowed to name Plaid products');
  });
});
