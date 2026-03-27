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

  test('buildAppGenerationPrompt() uses inline Heroicons guidance without CDN exception', () => {
    const result = templates.buildAppGenerationPrompt(
      MINIMAL_DEMO_SCRIPT,
      'Simple single-page demo app'
    );
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(/Heroicons SVG/.test(fullText), 'Prompt should mention Heroicons SVG usage');
    assert.ok(!/unpkg\.com\/heroicons/i.test(fullText), 'Prompt should not allow Heroicons CDN script injection');
  });

  test('buildAppGenerationPrompt() includes human feedback even without qaReport', () => {
    const result = templates.buildAppGenerationPrompt(
      MINIMAL_DEMO_SCRIPT,
      'Simple single-page demo app',
      null,
      { humanFeedback: 'Keep the JSON rail hidden on consumer steps.' }
    );
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(fullText.includes('Human Reviewer Feedback'), 'Human feedback block should be present');
    assert.ok(fullText.includes('JSON rail hidden on consumer steps'), 'Human feedback content should be included');
  });

  test('buildScriptGenerationPrompt() lifts slide block out of prompt.txt duplication', () => {
    const promptText = `Intro\n[[SLIDE_OUTPUT_BEGIN]]\nSlide rules here\n[[SLIDE_OUTPUT_END]]\nOutro`;
    const result = templates.buildScriptGenerationPrompt(
      { texts: [{ filename: 'prompt.txt', content: promptText }], screenshots: [], transcriptions: [] },
      { synthesizedInsights: '', internalKnowledge: [], apiSpec: {} }
    );
    const userText = JSON.stringify(result.userMessages);
    assert.ok(userText.includes('SLIDE OUTPUT REQUIREMENTS'), 'Slide block should be extracted explicitly');
    const textInputsIdx = userText.indexOf('## TEXT INPUTS');
    assert.ok(textInputsIdx >= 0, 'TEXT INPUTS block should still exist');
    const textInputsTail = userText.slice(textInputsIdx);
    assert.ok(!textInputsTail.includes('[[SLIDE_OUTPUT_BEGIN]]'), 'Slide markers should be stripped from duplicated TEXT INPUTS content');
  });

  test('buildScriptGenerationPrompt() injects family-specific accuracy and curated knowledge', () => {
    const result = templates.buildScriptGenerationPrompt(
      { texts: [{ filename: 'prompt.txt', content: 'Build a CRA Base Report underwriting demo' }], screenshots: [], transcriptions: [] },
      {
        synthesizedInsights: 'CRA research summary',
        internalKnowledge: [],
        apiSpec: {},
        productFamily: 'cra_base_report',
        curatedProductKnowledge: {
          family: 'cra_base_report',
          knowledgeFiles: [{
            source: 'inputs/products/plaid-cra-base-report.md',
            overview: 'CRA overview',
            whereItFits: 'CRA where it fits',
            narrationTalkTracks: 'CRA talk tracks',
            accurateTerminology: 'consumer_report',
            differentiators: 'CRA differentiators',
            aiResearchNotes: 'CRA notes',
          }],
          qaFixLogExcerpt: 'Category 1 — Missing Right-Side JSON Panel',
        },
      }
    );
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(fullText.includes('cra_base_report'), 'Expected product family to be injected');
    assert.ok(fullText.includes('consumer_report'), 'Expected curated product knowledge to be included');
    assert.ok(fullText.includes('Category 1'), 'Expected QA learnings to be included');
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

  test('buildQAReviewPrompt() requests categories in JSON output', () => {
    const step = { id: 'identity-match-insight', label: 'Identity', narration: 'Test narration here.', durationMs: 3000 };
    const result = templates.buildQAReviewPrompt(step, [], 'Expected state');
    const contentText = JSON.stringify(result.userMessages);
    const rawTextBlocks = (result.userMessages[0]?.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
    const fullText = result.system + contentText + rawTextBlocks;
    assert.ok(fullText.includes('"categories"'), 'QA review prompt should request issue categories');
  });
});
