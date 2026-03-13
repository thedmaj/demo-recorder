'use strict';
/**
 * Tests for prompt-building functions from scripts/scratch/utils/prompt-templates.js.
 * The module is pure (no I/O, no API calls) so it can be required safely.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const templates = require(path.join(__dirname, '../../scripts/scratch/utils/prompt-templates'));

const MINIMAL_DEMO_SCRIPT = {
  product: 'Plaid Auth',
  steps: [
    {
      id: 'intro',
      label: 'Introduction',
      narration: 'Plaid Auth gives developers instant access to bank account and routing numbers securely.',
      durationMs: 5000,
    },
  ],
};

describe('prompt-templates', () => {
  test('buildResearchPrompt() returns { system, userMessages }', () => {
    const result = templates.buildResearchPrompt({
      product: 'Plaid Auth',
      productShortName: 'Auth',
      persona: 'fintech developer',
      targetAudience: 'fintech companies',
      researchTopics: ['instant auth', 'account verification'],
    });
    assert.ok(result.system && typeof result.system === 'string', 'system must be a non-empty string');
    assert.ok(Array.isArray(result.userMessages) && result.userMessages.length >= 1,
      'userMessages must be a non-empty array');
  });

  test('buildAppGenerationPrompt() returns { system, userMessages } and includes DOM contract', () => {
    const result = templates.buildAppGenerationPrompt(
      MINIMAL_DEMO_SCRIPT,
      'Simple single-page demo app'
    );
    assert.ok(result.system && typeof result.system === 'string');
    assert.ok(Array.isArray(result.userMessages) && result.userMessages.length >= 1);
    // System prompt must reference the DOM contract (goToStep or data-testid)
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(/goToStep|data-testid/i.test(fullText),
      'Prompt should include DOM contract requirements (goToStep / data-testid)');
  });

  test('buildAppGenerationPrompt() includes Plaid teal brand color in default brand output', () => {
    const result = templates.buildAppGenerationPrompt(
      MINIMAL_DEMO_SCRIPT,
      'Simple single-page demo app'
    );
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(fullText.includes('#00A67E') || fullText.includes('00A67E'),
      'Default brand output should include Plaid teal #00A67E');
  });

  test('buildQAReviewPrompt() returns { system, userMessages } and includes expected state', () => {
    const step = { id: 'intro', label: 'Introduction', narration: 'Test narration here.', durationMs: 3000 };
    const expectedState = 'A dark background with a teal Confirm button visible';
    const result = templates.buildQAReviewPrompt(step, [], expectedState);
    assert.ok(result.system && typeof result.system === 'string');
    assert.ok(Array.isArray(result.userMessages) && result.userMessages.length >= 1);
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(fullText.includes(expectedState),
      'Prompt should include the expected state description');
  });
});
