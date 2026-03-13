'use strict';
/**
 * Tests for confidence threshold comparison (mirrors research.js meetsConfidenceThreshold).
 * CONFIDENCE_ORDER = ['high', 'medium', 'low'] — lower index = higher confidence.
 * No API calls, no I/O.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Mirrors constants and meetsConfidenceThreshold() from scripts/scratch/research.js
const CONFIDENCE_ORDER = ['high', 'medium', 'low'];

function meetsConfidenceThreshold(level, threshold) {
  const li = CONFIDENCE_ORDER.indexOf((level     || 'low').toLowerCase());
  const ti = CONFIDENCE_ORDER.indexOf((threshold || 'medium').toLowerCase());
  return li !== -1 && ti !== -1 && li <= ti;
}

describe('confidence-threshold', () => {
  test('high >= medium → true', () => {
    assert.equal(meetsConfidenceThreshold('high', 'medium'), true);
  });

  test('medium >= medium → true', () => {
    assert.equal(meetsConfidenceThreshold('medium', 'medium'), true);
  });

  test('low >= medium → false', () => {
    assert.equal(meetsConfidenceThreshold('low', 'medium'), false);
  });

  test('high >= high → true', () => {
    assert.equal(meetsConfidenceThreshold('high', 'high'), true);
  });

  test('medium >= high → false', () => {
    assert.equal(meetsConfidenceThreshold('medium', 'high'), false);
  });

  test('low >= low → true', () => {
    assert.equal(meetsConfidenceThreshold('low', 'low'), true);
  });

  test('unknown level → false (not crash)', () => {
    assert.equal(meetsConfidenceThreshold('unknown', 'medium'), false);
  });

  test('undefined level → false', () => {
    assert.equal(meetsConfidenceThreshold(undefined, 'medium'), false);
  });

  test('case-insensitive: "HIGH" → treated as high', () => {
    assert.equal(meetsConfidenceThreshold('HIGH', 'medium'), true);
  });
});
