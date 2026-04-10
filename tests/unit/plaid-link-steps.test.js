'use strict';
/**
 * Tests the Plaid Link launch-step validation in generate-script.js.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  validateDemoScript,
  mergePreLinkIntoLaunchStep,
  mergeAllPreLinkExplainersBeforeLaunch,
} = require(path.join(__dirname, '../../scripts/scratch/scratch/generate-script'));

describe('plaid-link-launch-validation', () => {
  test('single launch step in live mode → no launch-related errors', () => {
    const script = {
      steps: [
        {
          id: 'wf-link-launch',
          narration: 'Recognized as a returning user, Berta confirms with a one-time code, selects her checking account, and connects in seconds.',
          plaidPhase: 'launch',
        },
      ],
    };
    const result = validateDemoScript(script, { plaidLinkLive: true });
    assert.deepEqual(result.errors, []);
  });

  test('missing launch step in live mode → error', () => {
    const result = validateDemoScript({ steps: [{ id: 'intro' }] }, { plaidLinkLive: true });
    assert.ok(result.errors.some(e => /plaidPhase:"launch"/.test(e)));
  });

  test('Layer use case without launch step in live mode → allowed', () => {
    const result = validateDemoScript({
      title: 'Polymarket Layer onboarding',
      product: 'Plaid Layer',
      steps: [
        { id: 'layer-consent', sceneType: 'link', narration: 'Maya consents to share verified onboarding details in the Layer flow.' },
      ],
    }, { plaidLinkLive: true });
    assert.equal(result.errors.length, 0);
    assert.ok(result.warnings.some((w) => /Layer-native flow/.test(w)));
  });

  test('multiple launch steps → error', () => {
    const result = validateDemoScript({
      steps: [
        { id: 'launch-one', plaidPhase: 'launch', narration: 'Inside modal narration.' },
        { id: 'launch-two', plaidPhase: 'launch', narration: 'Inside modal narration.' },
      ],
    }, { plaidLinkLive: true });
    assert.ok(result.errors.some(e => /Multiple plaidPhase:"launch"/.test(e)));
  });

  test('launch narration that says "Plaid Link opens" → error', () => {
    const result = validateDemoScript({
      steps: [
        {
          id: 'wf-link-launch',
          plaidPhase: 'launch',
          narration: 'Plaid Link opens, and Berta selects her bank account to continue.',
        },
      ],
    }, { plaidLinkLive: true });
    assert.ok(result.errors.some(e => /boundary rule/.test(e)));
  });

  test('standalone pre-link step before launch → error', () => {
    const result = validateDemoScript({
      steps: [
        {
          id: 'pre-link-explainer',
          label: 'Why we need to link',
          narration: 'Taylor reviews why Citi needs account ownership data before funding.',
          visualState: 'A pre-link explainer card with Link your bank CTA.',
        },
        {
          id: 'plaid-link-flow',
          plaidPhase: 'launch',
          narration: 'Recognized as a returning user, Taylor confirms with OTP and links the checking account in seconds.',
        },
      ],
    }, { plaidLinkLive: true });
    assert.ok(result.errors.some(e => /Merge pre-Link explainer \+ launch into one step/.test(e)));
  });

  test('mergePreLinkIntoLaunchStep collapses immediate pre-link step', () => {
    const script = {
      steps: [
        {
          id: 'pre-link-explainer',
          label: 'Link your bank',
          narration: 'Citi explains security and data use.',
          durationHintMs: 6000,
          interaction: { action: 'click', target: '[data-testid="link-your-bank"]' },
          visualState: 'Pre-link trust screen with CTA.',
        },
        {
          id: 'plaid-link-flow',
          plaidPhase: 'launch',
          narration: 'Recognized as a returning user, Taylor confirms with OTP and links the checking account in seconds.',
          durationHintMs: 18000,
          visualState: 'Plaid modal visible with institution and account selection.',
        },
      ],
    };
    const merged = mergePreLinkIntoLaunchStep(script);
    assert.equal(script.steps.length, 1);
    assert.equal(script.steps[0].id, 'plaid-link-flow');
    assert.equal(script.steps[0].durationHintMs, 24000);
    assert.equal(script.steps[0].interaction.target, '[data-testid="link-your-bank"]');
    assert.ok(/Pre-link trust screen/.test(script.steps[0].visualState));
    assert.deepEqual(merged, { removedStepId: 'pre-link-explainer', launchStepId: 'plaid-link-flow' });
  });

  test('mergeAllPreLinkExplainersBeforeLaunch removes non-adjacent explainer; validation passes', () => {
    const script = {
      steps: [
        { id: 'intro', narration: 'Taylor starts onboarding at KeyBank digital.' },
        {
          id: 'host-account-ready',
          label: 'Account ready',
          narration: 'The account shell is ready; next she will link your bank for funding verification.',
          visualState: 'Host screen with Link your bank as the primary CTA.',
        },
        { id: 'spacer-beat', narration: 'Brief transition confirming disclosures were accepted.' },
        {
          id: 'link-launch',
          plaidPhase: 'launch',
          narration: 'Inside Plaid she picks her institution and checking account and completes in seconds.',
          durationHintMs: 20000,
        },
      ],
    };
    assert.ok(
      validateDemoScript(structuredClone(script), { plaidLinkLive: true }).errors.some((e) =>
        /Merge pre-Link explainer/.test(e)
      ),
      'validate flags standalone explainer before merge'
    );
    const merged = mergeAllPreLinkExplainersBeforeLaunch(script);
    assert.ok(merged && merged.removedStepIds.includes('host-account-ready'));
    assert.equal(script.steps.find((s) => s.id === 'host-account-ready'), undefined);
    assert.equal(script.steps.some((s) => s.plaidPhase === 'launch'), true);
    const after = validateDemoScript(script, { plaidLinkLive: true });
    assert.deepEqual(
      after.errors.filter((e) => /Merge pre-Link explainer/.test(e)),
      []
    );
  });
});
