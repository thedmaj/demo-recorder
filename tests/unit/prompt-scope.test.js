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
});
