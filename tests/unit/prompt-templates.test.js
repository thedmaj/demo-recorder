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

  test('buildAppGenerationPrompt() enforces single global JSON panel contract', () => {
    const result = templates.buildAppGenerationPrompt(
      MINIMAL_DEMO_SCRIPT,
      'Simple single-page demo app'
    );
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(fullText.includes('api-response-panel: the ONE AND ONLY mechanism'),
      'Prompt should enforce one global api-response-panel contract');
    assert.ok(fullText.includes('No "insight-right", no "auth-json-panel"'),
      'Prompt should explicitly forbid duplicate inline raw JSON panels');
  });

  test('buildAppGenerationPrompt() requires narrative-driven API attribute highlights', () => {
    const result = templates.buildAppGenerationPrompt(
      MINIMAL_DEMO_SCRIPT,
      'Simple single-page demo app'
    );
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(fullText.includes('top response attributes that drive the outcome'),
      'Prompt should require highlighting key API attributes tied to story outcomes');
    assert.ok(fullText.includes('Signal risk drivers + recommendation'),
      'Prompt should include concrete product-contextual attribute examples');
    assert.ok(fullText.includes('data-testid="api-panel-toggle"'),
      'Prompt should require JSON panel toggle control');
    assert.ok(fullText.includes('window.toggleApiPanel()'),
      'Prompt should require runtime toggle handler');
    assert.ok(fullText.includes('keep panel collapsed until toggled open'),
      'Prompt should enforce collapsed-by-default API panel behavior');
    assert.ok(fullText.includes('render JSON expanded by default via renderjson'),
      'Prompt should require expanded JSON when panel opens');
    assert.ok(fullText.includes('renderjson@1.4.0/renderjson.min.js'),
      'Prompt should require renderjson viewer script for API payload display');
    assert.ok(fullText.includes('side-panel-body is vertically scrollable'),
      'Prompt should require scrollable API panel body for long JSON payloads');
    assert.ok(fullText.includes('request/response content aligns with the slide claim'),
      'Prompt should require request/response alignment with slide narrative');
    assert.ok(fullText.includes('HOST UI METRICS GUARDRAIL'),
      'Prompt should include host UI metrics leakage guardrail');
  });

  test('buildAppGenerationPrompt() includes AskBill verification for link/token/create payload syntax', () => {
    const result = templates.buildAppGenerationPrompt(
      MINIMAL_DEMO_SCRIPT,
      'Simple single-page demo app'
    );
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(fullText.includes('ASKBILL PLAID LINK TOKEN PARAMETER VERIFICATION'),
      'Prompt should include AskBill link/token/create parameter verification guardrail');
    assert.ok(fullText.includes('linkMode/link_mode as INTERNAL wrapper-only variables'),
      'Prompt should enforce linkMode/link_mode as internal-only fields');
    assert.ok(fullText.includes('MUST NEVER be included in the payload sent to Plaid /link/token/create'),
      'Prompt should forbid sending internal mode fields to Plaid');
  });

  test('buildAppGenerationPrompt() includes global refinement feedback contracts', () => {
    const result = templates.buildAppGenerationPrompt(
      MINIMAL_DEMO_SCRIPT,
      'Simple single-page demo app'
    );
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(fullText.includes('GLOBAL REFINEMENT FEEDBACK (NON-NEGOTIABLE)'),
      'Prompt should include global refinement feedback block');
    assert.ok(fullText.includes('STEP ACTIVATION CONTRACT'),
      'Prompt should require non-empty active-step state');
    assert.ok(fullText.includes('LINK LAUNCH CONTRACT'),
      'Prompt should include required link launch selector visibility contract');
    assert.ok(fullText.includes('API PANEL CONTRACT'),
      'Prompt should include non-empty API panel contract');
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

  test('buildScriptGenerationPrompt() includes Plaid Link UX skill block when provided', () => {
    const result = templates.buildScriptGenerationPrompt(
      { texts: [{ filename: 'prompt.txt', content: 'Build account verification demo' }], screenshots: [], transcriptions: [] },
      {
        synthesizedInsights: '',
        internalKnowledge: [],
        apiSpec: {},
        plaidLinkUxSkillMarkdown: '## PLAID LINK PRE-LINK UX SKILL (use-case-specific)\n\nFlow type selected: generic.',
      }
    );
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(fullText.includes('PLAID LINK PRE-LINK UX SKILL'), 'Expected link UX skill block in script prompt');
  });

  test('buildScriptGenerationPrompt() enforces merged pre-link + launch rule', () => {
    const result = templates.buildScriptGenerationPrompt(
      { texts: [{ filename: 'prompt.txt', content: 'Build funding demo with Plaid Link.' }], screenshots: [], transcriptions: [] },
      { synthesizedInsights: '', internalKnowledge: [], apiSpec: {} }
    );
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(fullText.includes('Do NOT create a standalone pre-Link explainer step before launch.'),
      'Script prompt should forbid standalone pre-Link explainer steps');
    assert.ok(fullText.includes('must be merged into the SAME launch step'),
      'Script prompt should require merged pre-Link + launch composition');
    assert.ok(fullText.includes('FINAL VALUE SUMMARY SLIDE RULE'),
      'Script prompt should require a final value summary slide');
    assert.ok(fullText.includes('The LAST step in the demo MUST be a Plaid-branded value-summary slide'),
      'Script prompt should enforce final-step value-summary placement');
  });

  test('buildAppGenerationPrompt() requires a visible host logo shell container', () => {
    const result = templates.buildAppGenerationPrompt(
      MINIMAL_DEMO_SCRIPT,
      'Simple single-page demo app',
      null,
      {
        brand: {
          name: 'Citi',
          slug: 'citi',
          mode: 'light',
          colors: { bgPrimary: '#ffffff', accentCta: '#0052a5', textPrimary: '#111827', textSecondary: '#475569', textTertiary: '#64748b', accentBorder: 'rgba(15,23,42,0.2)', accentBgTint: 'rgba(15,23,42,0.06)', error: '#ef4444', success: '#22c55e' },
          typography: { fontHeading: 'Arial, sans-serif', fontBody: 'Arial, sans-serif', fontMono: 'monospace', scaleH1: '32px/700', scaleH2: '24px/600', scaleH3: '18px/600', scaleBody: '15px/400', headingLetterSpacing: '-0.02em', headingLineHeight: '1.2', bodyLineHeight: '1.6' },
          motion: { stepTransition: 'opacity 0.3s ease', cardEntrance: 'fade 0.4s', buttonHover: 'all 0.2s', modalScale: 'scale(1)', loadingIndicatorColor: '#0052a5' },
          atmosphere: { overlayBackdropFilter: 'blur(8px)', cardBorderRadius: '8px', cardBoxShadow: '0 2px 8px rgba(0,0,0,0.08)', maxContentWidth: '1440px' },
          sidePanels: { bg: '#111827', accentColor: '#0052a5', jsonKeyColor: '#7dd3fc', jsonStringColor: '#fff', jsonNumberColor: '#86efac' },
          logo: { imageUrl: 'https://example.com/logo.svg' },
        },
      }
    );
    const fullText = result.system + JSON.stringify(result.userMessages);
    assert.ok(fullText.includes('host-bank-logo-shell'),
      'App generation prompt should require a visible logo shell container');
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
