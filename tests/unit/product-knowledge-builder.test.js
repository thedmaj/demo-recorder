'use strict';

/**
 * Unit tests for product-knowledge-builder.js.
 *
 * Uses an injected gleanClient stub so tests don't hit Glean, plus a
 * dedicated test slug so the file lives at inputs/products/plaid-__pk-builder-test.md
 * and is cleaned up after each test.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const PRODUCTS_DIR = path.join(PROJECT_ROOT, 'inputs', 'products');
const BACKUP_DIR = path.join(PRODUCTS_DIR, '_backups');

const {
  buildProductKnowledge,
  parseGleanBullets,
  renderDraftSection,
  productNameFromSlug,
} = require(path.join(PROJECT_ROOT, 'scripts/scratch/utils/product-knowledge-builder'));

const TEST_SLUG = '__pk-builder-test';
const TEST_FILE = path.join(PRODUCTS_DIR, `plaid-${TEST_SLUG}.md`);

function writeBaseFile() {
  const content = [
    '---',
    'product: "Plaid Builder Test"',
    'slug: __pk-builder-test',
    '---',
    '',
    '## Overview',
    'Existing overview content here so the file is not empty.',
    '',
    '## Value Proposition Statements',
    '- Existing VP',
    '',
  ].join('\n');
  fs.writeFileSync(TEST_FILE, content, 'utf8');
}

function cleanupBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (f.startsWith(`${TEST_SLUG}-`)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
    }
  }
}

afterEach(() => {
  try { fs.unlinkSync(TEST_FILE); } catch (_) {}
  cleanupBackups();
});

describe('parseGleanBullets', () => {
  test('strips bullet markers, drops too-short lines, drops [Glean unavailable]', () => {
    const text = [
      '- First useful bullet that is long enough.',
      '* Second one also valid here.',
      '1. Third numbered bullet ok.',
      '[Glean unavailable]',
      '- short',
      '',
      '- Fourth one with more content.',
    ].join('\n');
    const bullets = parseGleanBullets(text);
    assert.equal(bullets.length, 4);
    assert.match(bullets[0], /^First useful bullet/);
    // Numbered prefix stripped.
    assert.match(bullets[2], /^Third numbered/);
    assert.equal(bullets.includes('short'), false);
    // Glean-unavailable sentinel dropped.
    assert.equal(bullets.some((b) => /Glean unavailable/.test(b)), false);
  });

  test('empty / unavailable input → empty array', () => {
    assert.deepEqual(parseGleanBullets(''), []);
    assert.deepEqual(parseGleanBullets('[Glean unavailable]'), []);
  });
});

describe('renderDraftSection', () => {
  test('emits [DRAFT] on every bullet (HITL contract)', () => {
    const out = renderDraftSection(['First', 'Second', 'Third'], 'customer_story');
    const lines = out.split('\n');
    assert.equal(lines.length, 3);
    for (const line of lines) assert.match(line, /^- \[DRAFT\] /);
  });

  test('empty bullets → fallback note tagged with intent', () => {
    const out = renderDraftSection([], 'collateral');
    assert.match(out, /Auto-build attempted \(collateral\)/);
  });
});

describe('productNameFromSlug', () => {
  test('title-cases hyphenated slugs', () => {
    assert.equal(productNameFromSlug('protect'), 'Protect');
    assert.equal(productNameFromSlug('cra-base-report'), 'Cra Base Report');
    assert.equal(productNameFromSlug('investments-move'), 'Investments Move');
  });
});

describe('buildProductKnowledge — happy path (injected glean client)', () => {
  test('writes a backup, fills missing sections, tags content [DRAFT]', async () => {
    writeBaseFile();
    const seen = [];
    const fakeGlean = async (intent, query) => {
      seen.push({ intent, query });
      // Return a different set of bullets per intent so we can verify routing.
      if (intent === 'customer_story') {
        return [
          '- Persona: Risk lead at a neobank — Problem: bureau-thin applicants — Solution: Protect — Outcome: 30% fraud lift.',
          '- Persona: Lending PM at fintech — Problem: false declines — Solution: Trust Index — Outcome: 12% approve lift.',
          '- Persona: Compliance — Problem: lack of explainability — Solution: Core Attributes — Outcome: passes audit.',
        ].join('\n');
      }
      if (intent === 'collateral') {
        return ['- Quantified: 30% fraud-loss reduction at a top neobank (Plaid Protect retro)'].join('\n');
      }
      return '';
    };

    const result = await buildProductKnowledge({
      productSlug: TEST_SLUG,
      sections: ['customerUseCases', 'proofPoints'],
      gleanClient: fakeGlean,
    });

    assert.equal(result.written, true);
    assert.ok(result.backupPath, 'expected a backup path');
    assert.ok(fs.existsSync(result.backupPath), 'backup file should exist on disk');
    assert.equal(result.sectionsAdded.length, 2);
    assert.deepEqual(result.sectionsAdded.map((s) => s.section).sort(), ['customerUseCases', 'proofPoints']);

    // File now has both sections.
    const written = fs.readFileSync(TEST_FILE, 'utf8');
    assert.match(written, /## Customer Use Cases/);
    assert.match(written, /## Proof Points & ROI Metrics/);
    // [DRAFT] markers required.
    assert.match(written, /- \[DRAFT\] Persona: Risk lead/);
    assert.match(written, /- \[DRAFT\] Quantified: 30% fraud-loss/);
    // last_ai_update + needs_review stamped.
    assert.match(written, /needs_review: true/);
    assert.match(written, /last_ai_update:/);
    assert.match(written, /last_auto_build_sections:/);

    // Glean was called with intent-prefixed query strings per builder convention.
    assert.equal(seen.length, 2);
    const intents = seen.map((s) => s.intent).sort();
    assert.deepEqual(intents, ['collateral', 'customer_story']);
  });

  test('dry-run does not mutate the file or create a backup', async () => {
    writeBaseFile();
    const before = fs.readFileSync(TEST_FILE, 'utf8');
    const fakeGlean = async () => '- A useful sentence that is comfortably above the eight-character bar.';
    const result = await buildProductKnowledge({
      productSlug: TEST_SLUG,
      sections: ['proofPoints'],
      gleanClient: fakeGlean,
      dryRun: true,
    });
    assert.equal(result.written, false);
    assert.equal(result.backupPath, null);
    assert.equal(result.sectionsAdded.length, 1);
    assert.equal(result.sectionsAdded[0].dryRun, true);
    const after = fs.readFileSync(TEST_FILE, 'utf8');
    assert.equal(after, before, 'file should be unchanged after dry-run');
  });

  test('Glean error on one section is recorded but does not abort the run', async () => {
    writeBaseFile();
    let calls = 0;
    const fakeGlean = async (intent) => {
      calls += 1;
      if (intent === 'customer_story') throw new Error('Glean timeout');
      return '- Working bullet content that should land in the file.';
    };
    const result = await buildProductKnowledge({
      productSlug: TEST_SLUG,
      sections: ['customerUseCases', 'proofPoints'],
      gleanClient: fakeGlean,
    });
    assert.equal(calls, 2);
    const failedNames = result.skippedSections.map((s) => s.section);
    assert.ok(failedNames.includes('customerUseCases'));
    assert.equal(result.sectionsAdded.length, 1);
    assert.equal(result.sectionsAdded[0].section, 'proofPoints');
  });

  test('throws if the product file does not exist yet', async () => {
    try { fs.unlinkSync(TEST_FILE); } catch (_) {}
    await assert.rejects(
      () => buildProductKnowledge({ productSlug: TEST_SLUG, sections: ['proofPoints'], gleanClient: async () => '' }),
      /file not found/
    );
  });
});
