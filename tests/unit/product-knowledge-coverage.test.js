'use strict';

/**
 * Unit tests for product-knowledge-coverage.js.
 *
 * Uses dedicated test slugs (prefixed with `__pk-coverage-`) written into
 * inputs/products/ so the coverage module's slug→path resolution works without
 * refactoring. Each test cleans up after itself.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const PRODUCTS_DIR = path.join(PROJECT_ROOT, 'inputs', 'products');
const ALIAS_FILE = path.join(PRODUCTS_DIR, '_heading-aliases.json');

const {
  assessProductKnowledgeCoverage,
  formatCoverageReport,
  _resetAliasCache,
  SECTION_CATALOG,
} = require(path.join(PROJECT_ROOT, 'scripts/scratch/utils/product-knowledge-coverage'));

const TEST_SLUG = '__pk-coverage-test';
const TEST_FILE = path.join(PRODUCTS_DIR, `plaid-${TEST_SLUG}.md`);

// Aliases stored under the same slug so we can exercise alias resolution
// without mutating the real alias file. Tests append + remove the section
// surgically via a save/restore.
let savedAliasFile = null;

function writeTestFile(content) {
  fs.writeFileSync(TEST_FILE, content, 'utf8');
}

function withAliases(slug, aliasMap) {
  if (savedAliasFile == null) {
    savedAliasFile = fs.existsSync(ALIAS_FILE) ? fs.readFileSync(ALIAS_FILE, 'utf8') : '';
  }
  const existing = savedAliasFile ? JSON.parse(savedAliasFile) : { _default: {} };
  const next = { ...existing, [slug]: aliasMap };
  fs.writeFileSync(ALIAS_FILE, JSON.stringify(next, null, 2), 'utf8');
  _resetAliasCache();
}

afterEach(() => {
  try { fs.unlinkSync(TEST_FILE); } catch (_) {}
  if (savedAliasFile != null) {
    fs.writeFileSync(ALIAS_FILE, savedAliasFile, 'utf8');
    savedAliasFile = null;
    _resetAliasCache();
  }
});

describe('assessProductKnowledgeCoverage — canonical headings', () => {
  test('empty file → confidence=low, recommendedMode=full, every section missing', () => {
    writeTestFile('---\nproduct: Plaid Test\n---\n\n# Plaid Test\n');
    const c = assessProductKnowledgeCoverage({ productSlug: TEST_SLUG });
    assert.equal(c.fileExists, true);
    assert.equal(c.presentCount, 0);
    assert.equal(c.confidence, 'low');
    assert.equal(c.recommendedMode, 'full');
    for (const def of SECTION_CATALOG) {
      assert.equal(c.sections[def.key].present, false, `${def.key} should be absent`);
    }
  });

  test('file missing entirely → fileExists=false, low confidence', () => {
    try { fs.unlinkSync(TEST_FILE); } catch (_) {}
    const c = assessProductKnowledgeCoverage({ productSlug: TEST_SLUG });
    assert.equal(c.fileExists, false);
    assert.equal(c.confidence, 'low');
    assert.equal(c.recommendedMode, 'full');
    assert.equal(c.missingSections.length, SECTION_CATALOG.length);
  });

  test('all canonical sections populated → confidence=high, mode=skip', () => {
    writeTestFile([
      '---', 'product: Plaid Test', 'slug: __pk-coverage-test',
      'last_ai_update: "2026-05-25T00:00:00.000Z"', '---', '',
      '## Overview',
      'A long-enough overview body with at least eighty characters to clear the minChars threshold for narrative sections.',
      '',
      '## Where It Fits',
      'Equally long body explaining where the product fits in the architecture and which adjacent products it complements.',
      '',
      '## Value Proposition Statements',
      '- VP 1', '- VP 2', '- VP 3',
      '',
      '## Customer Use Cases',
      '- Use case 1', '- Use case 2',
      '',
      '## Narration Talk Tracks',
      '- Talk track beat',
      '',
      '## Accurate Terminology',
      '- Term 1', '- Term 2', '- Term 3', '- Term 4',
      '',
      '## Competitive Differentiators',
      '- Diff 1', '- Diff 2',
      '',
      '## Proof Points & ROI Metrics',
      '- Metric 1', '- Metric 2',
      '',
      '## Objections & Responses',
      '- Objection 1',
      '',
      '## Implementation Pitfalls',
      '- Pitfall 1',
      '',
    ].join('\n'));
    const c = assessProductKnowledgeCoverage({
      productSlug: TEST_SLUG,
      now: new Date('2026-05-26T00:00:00.000Z'),
    });
    assert.equal(c.presentCount, SECTION_CATALOG.length);
    assert.equal(c.missingSections.length, 0);
    assert.equal(c.blockingGapsForScript.length, 0);
    assert.equal(c.confidence, 'high');
    assert.equal(c.recommendedMode, 'skip');
  });
});

describe('assessProductKnowledgeCoverage — heading-alias resolution', () => {
  test('non-canonical heading registers when aliased', () => {
    writeTestFile([
      '---', 'product: Plaid Test', '---', '',
      '## Approved talk track',
      '- Talk track A',
      '- Talk track B',
      '',
    ].join('\n'));
    withAliases(TEST_SLUG, {
      narrationTalkTracks: ['Approved talk track'],
    });
    const c = assessProductKnowledgeCoverage({ productSlug: TEST_SLUG });
    assert.equal(c.sections.narrationTalkTracks.present, true);
    assert.equal(c.sections.narrationTalkTracks.headingUsed, '## Approved talk track');
  });

  test('non-aliased non-canonical heading stays missing', () => {
    writeTestFile([
      '---', 'product: Plaid Test', '---', '',
      '## My Special Section',
      '- something',
      '',
    ].join('\n'));
    const c = assessProductKnowledgeCoverage({ productSlug: TEST_SLUG });
    assert.equal(c.sections.narrationTalkTracks.present, false);
  });
});

describe('assessProductKnowledgeCoverage — Solutions Master injection', () => {
  test('solutionsMasterContext.valuePropositionStatements removes valuePropositions from blocking gaps', () => {
    writeTestFile('---\nproduct: Plaid Test\n---\n\n# Plaid Test\n');
    const c = assessProductKnowledgeCoverage({
      productSlug: TEST_SLUG,
      solutionsMasterContext: { valuePropositionStatements: ['VP from Solutions Master'] },
    });
    assert.ok(
      !c.blockingGapsForScript.includes('valuePropositions'),
      'Solutions Master VPs should satisfy the script-tier gap'
    );
  });
});

describe('assessProductKnowledgeCoverage — confidence threshold', () => {
  test('5 sections present + 2 blocking gaps → medium / gapfill', () => {
    writeTestFile([
      '---', 'product: Plaid Test', '---', '',
      '## Value Proposition Statements',
      '- VP 1', '- VP 2', '- VP 3',
      '',
      '## Narration Talk Tracks',
      '- Beat',
      '',
      '## Accurate Terminology',
      '- T1', '- T2', '- T3', '- T4',
      '',
      '## Competitive Differentiators',
      '- D1', '- D2',
      '',
      '## Overview',
      'A long-enough overview body with at least eighty characters to clear the minChars threshold for narrative sections.',
      '',
    ].join('\n'));
    const c = assessProductKnowledgeCoverage({ productSlug: TEST_SLUG });
    // Present: VP, Talk, Term, Diffs, Overview = 5
    // Blocking-for-script missing: customerUseCases, whereItFits = 2
    assert.equal(c.presentCount, 5);
    assert.deepEqual(c.blockingGapsForScript.sort(), ['customerUseCases', 'whereItFits']);
    assert.equal(c.confidence, 'medium');
    assert.equal(c.recommendedMode, 'gapfill');
  });

  test('3 blocking gaps → low / full', () => {
    writeTestFile([
      '---', 'product: Plaid Test', '---', '',
      '## Value Proposition Statements',
      '- VP 1', '- VP 2', '- VP 3',
      '',
      '## Narration Talk Tracks',
      '- Beat',
      '',
    ].join('\n'));
    const c = assessProductKnowledgeCoverage({ productSlug: TEST_SLUG });
    assert.equal(c.confidence, 'low');
    assert.equal(c.recommendedMode, 'full');
  });
});

describe('formatCoverageReport', () => {
  test('renders a recognizable table for the empty case', () => {
    writeTestFile('---\nproduct: Plaid Test\n---\n\n# Plaid Test\n');
    const c = assessProductKnowledgeCoverage({ productSlug: TEST_SLUG });
    const out = formatCoverageReport(c);
    assert.match(out, /Coverage for __pk-coverage-test/);
    assert.match(out, /recommendedMode: full/);
    assert.match(out, /Section\s+Present/);
  });
});
