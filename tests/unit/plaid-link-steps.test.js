'use strict';
/**
 * Tests the Plaid Link launch-step validation in generate-script.js.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { validateDemoScript } = require(path.join(__dirname, '../../scripts/scratch/scratch/generate-script'));

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
});
