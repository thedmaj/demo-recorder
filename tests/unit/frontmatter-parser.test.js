'use strict';
/**
 * Tests for YAML frontmatter parsing logic (mirrors server.js parseFrontmatter).
 * No API calls, no I/O.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseFrontmatter } = require(path.join(__dirname, '../../scripts/scratch/utils/markdown-knowledge'));

describe('frontmatter-parser', () => {
  test('valid frontmatter → correct key/value pairs', () => {
    const content = '---\nproduct: plaid-auth\nslug: auth\n---\n# Body';
    const fm = parseFrontmatter(content);
    assert.equal(fm.product, 'plaid-auth');
    assert.equal(fm.slug, 'auth');
  });

  test('quoted string values → strips quotes', () => {
    const content = '---\nlast_ai_update: "2026-03-01T00:00:00.000Z"\ntitle: \'Plaid Auth\'\n---\n';
    const fm = parseFrontmatter(content);
    assert.equal(fm.last_ai_update, '2026-03-01T00:00:00.000Z');
    assert.equal(fm.title, 'Plaid Auth');
  });

  test('no frontmatter → returns {}', () => {
    const content = '# Just a heading\n\nNo frontmatter here.';
    const fm = parseFrontmatter(content);
    assert.deepEqual(fm, {});
  });

  test('CRLF line endings → parses correctly', () => {
    const content = '---\r\nproduct: plaid-auth\r\nslug: auth\r\n---\r\n# Body';
    const fm = parseFrontmatter(content);
    assert.equal(fm.product, 'plaid-auth');
    assert.equal(fm.slug, 'auth');
  });

  test('needs_review: false → readable as string "false"', () => {
    const content = '---\nneeds_review: false\n---\n';
    const fm = parseFrontmatter(content);
    assert.equal(fm.needs_review, 'false');
  });

  test('needs_review: true → readable as string "true"', () => {
    const content = '---\nneeds_review: true\n---\n';
    const fm = parseFrontmatter(content);
    assert.equal(fm.needs_review, 'true');
  });

  test('fixture product-auth.md → parses expected fields', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '../fixtures/product-auth.md'), 'utf8'
    );
    const fm = parseFrontmatter(content);
    assert.equal(fm.product, 'plaid-auth');
    assert.equal(fm.slug, 'auth');
    assert.equal(fm.needs_review, 'false');
  });
});
