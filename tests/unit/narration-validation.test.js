'use strict';
/**
 * Tests for narration word-count validation logic (mirrors generate-script.js).
 * No API calls, no I/O.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Mirrors the validation logic in scripts/scratch/scratch/generate-script.js
function validateNarration(text) {
  if (!text || !text.trim()) throw new Error('Narration is empty');
  const words = text.trim().split(/\s+/).length;
  if (words < 8)  throw new Error(`Narration too short: ${words} words (min 8)`);
  if (words > 35) throw new Error(`Narration too long: ${words} words (max 35)`);
  return words;
}

describe('narration-validation', () => {
  test('8 words → passes', () => {
    assert.doesNotThrow(() => validateNarration('one two three four five six seven eight'));
  });

  test('35 words → passes', () => {
    assert.doesNotThrow(() => validateNarration(Array(35).fill('word').join(' ')));
  });

  test('7 words → throws', () => {
    assert.throws(
      () => validateNarration('one two three four five six seven'),
      /too short/
    );
  });

  test('36 words → throws', () => {
    assert.throws(
      () => validateNarration(Array(36).fill('word').join(' ')),
      /too long/
    );
  });

  test('empty string → throws', () => {
    assert.throws(() => validateNarration(''), /empty/);
  });

  test('whitespace-only string → throws', () => {
    assert.throws(() => validateNarration('   '), /empty/);
  });

  test('returns word count on success', () => {
    const count = validateNarration('one two three four five six seven eight nine');
    assert.equal(count, 9);
  });
});
