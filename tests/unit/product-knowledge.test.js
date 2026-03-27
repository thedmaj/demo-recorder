'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  buildCuratedProductKnowledge,
  buildCuratedDigest,
  extractSection,
} = require(path.join(__dirname, '../../scripts/scratch/utils/product-knowledge'));

describe('product-knowledge', () => {
  test('extractSection returns the requested markdown section', () => {
    const md = '# Title\n\n## Overview\nHello world\n\n## Accurate Terminology\nAPI';
    assert.equal(extractSection(md, 'Overview'), 'Hello world');
    assert.equal(extractSection(md, 'Accurate Terminology'), 'API');
  });

  test('buildCuratedProductKnowledge loads CRA knowledge file', () => {
    const result = buildCuratedProductKnowledge('cra_base_report');
    assert.equal(result.family, 'cra_base_report');
    assert.ok(result.knowledgeFiles.length >= 1);
    assert.ok(result.knowledgeFiles.some(f => f.slug === 'cra-base-report'));
  });

  test('buildCuratedProductKnowledge loads Income knowledge file', () => {
    const result = buildCuratedProductKnowledge('income_insights');
    assert.ok(result.knowledgeFiles.some(f => f.slug === 'income-insights'));
  });

  test('buildCuratedProductKnowledge includes QA fix log excerpt', () => {
    const result = buildCuratedProductKnowledge('funding');
    assert.ok(result.qaFixLogExcerpt.includes('Category 1'), 'Expected QA fix log excerpt to be included');
  });

  test('buildCuratedDigest truncates to knowledgeFiles with bounded sections', () => {
    const full = buildCuratedProductKnowledge('funding');
    const digest = buildCuratedDigest(full, { maxBulletsPerSection: 2, maxCharsPerSection: 500 });
    assert.equal(digest.family, full.family);
    assert.ok(digest.knowledgeFiles.length >= 1);
    for (const f of digest.knowledgeFiles) {
      if (f.overview) assert.ok(f.overview.length <= 520);
    }
  });
});
