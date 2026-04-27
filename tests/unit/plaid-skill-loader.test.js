'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  getPlaidSkillBundleForFamily,
  getPlaidLinkUxSkillBundle,
  detectPlaidLinkUxFlowType,
  resolveResearchMode,
  effectiveResearchMode,
  resolveMemberPaths,
} = require('../../scripts/scratch/utils/plaid-skill-loader');

const skillZip = path.join(__dirname, '../../skills/plaid-integration.skill');

test('getPlaidSkillBundleForFamily loads funding family from default zip', () => {
  const b = getPlaidSkillBundleForFamily('funding', { zipPath: skillZip, maxChars: 50000 });
  assert.ok(b.skillLoaded, 'skill should load');
  assert.ok(b.text.includes('PLAID INTEGRATION SKILL'), 'banner present');
  assert.ok(b.members.length >= 3, 'expects quick-start + product files');
  assert.ok(b.sha256 && b.sha256.length === 64, 'sha256 hex');
});

test('resolveResearchMode reads prompt line', () => {
  const prev = process.env.RESEARCH_MODE;
  delete process.env.RESEARCH_MODE;
  try {
    assert.strictEqual(
      resolveResearchMode('foo\n**Research depth:** gapfill\n'),
      'gapfill'
    );
    assert.strictEqual(
      resolveResearchMode('Research depth: messaging'),
      'messaging'
    );
  } finally {
    if (prev !== undefined) process.env.RESEARCH_MODE = prev;
  }
});

test('effectiveResearchMode defaults and aliases', () => {
  const prev = process.env.RESEARCH_MODE;
  delete process.env.RESEARCH_MODE;
  try {
    // Default is now `full` (was `gapfill` prior to the hyper-realism upgrade).
    // Tokens are not a constraint; broader research = more grounded sample data.
    assert.strictEqual(effectiveResearchMode('', true), 'full');
    assert.strictEqual(effectiveResearchMode('', false), 'full');
    // Native modes pass through:
    assert.strictEqual(effectiveResearchMode('skip', true), 'skip');
    assert.strictEqual(effectiveResearchMode('gapfill', true), 'gapfill');
    assert.strictEqual(effectiveResearchMode('messaging', true), 'messaging');
    assert.strictEqual(effectiveResearchMode('full', true), 'full');
    // CLI-vocabulary aliases map to `full`:
    assert.strictEqual(effectiveResearchMode('broad', true), 'full');
    assert.strictEqual(effectiveResearchMode('deep', true), 'full');
    // Case-insensitive + whitespace-tolerant:
    assert.strictEqual(effectiveResearchMode('  GAPFILL  ', true), 'gapfill');
  } finally {
    if (prev !== undefined) process.env.RESEARCH_MODE = prev;
  }
});

test('resolveMemberPaths adds oauth when prompt mentions OAuth', () => {
  const p = resolveMemberPaths('funding', { promptText: 'Use OAuth bank flow' });
  assert.ok(p.some((x) => x.includes('oauth')), 'oauth.md included');
});

test('detectPlaidLinkUxFlowType distinguishes credit-specific and generic', () => {
  assert.strictEqual(
    detectPlaidLinkUxFlowType({ promptText: 'Loan underwriting and repayment setup flow' }),
    'credit-specific'
  );
  assert.strictEqual(
    detectPlaidLinkUxFlowType({ promptText: 'P2P payments and account verification flow' }),
    'generic'
  );
});

test('getPlaidLinkUxSkillBundle loads markdown skill excerpt', () => {
  const b = getPlaidLinkUxSkillBundle({
    promptText: 'Build a credit decision lending onboarding flow',
    maxChars: 6000,
  });
  assert.ok(b.skillLoaded, 'markdown skill should load');
  assert.ok(b.text.includes('PLAID LINK PRE-LINK UX SKILL'), 'expected header');
  assert.strictEqual(b.flowType, 'credit-specific');
});
