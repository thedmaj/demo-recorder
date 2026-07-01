'use strict';
// Regression suite for Item 4a (Astera 2026-06-30): an EXPLICIT host step must
// not be treated as an API-insight step just because the word "insight" appears
// in its id/label/visualState — that forced an apiResponse and halted the run at
// validateDemoScript. The \binsight\b word-match survives only as a fallback for
// steps that omit sceneType.
const test = require('node:test');
const assert = require('node:assert');
const { isInsightLikeStep } = require('../../scripts/scratch/scratch/generate-script');

test('4a: explicit host step named "*-insight" is NOT insight-like', () => {
  assert.strictEqual(isInsightLikeStep({ sceneType: 'host', id: 'unified-portfolio-insight' }), false);
  assert.strictEqual(isInsightLikeStep({ sceneType: 'host', label: 'API insight story' }), false);
  assert.strictEqual(isInsightLikeStep({ sceneType: 'host', visualState: 'shows the plaid insight panel' }), false);
});

test('4a: explicit insight/slide steps are unchanged', () => {
  assert.strictEqual(isInsightLikeStep({ sceneType: 'insight', id: 'auth-insight' }), true);
  assert.strictEqual(isInsightLikeStep({ sceneType: 'slide', id: 'base-report-insight' }), false);
});

test('4a: untyped steps still fall back to the word-match', () => {
  assert.strictEqual(isInsightLikeStep({ id: 'signal-insight' }), true, 'untyped *-insight must still require apiResponse');
  assert.strictEqual(isInsightLikeStep({ id: 'onboarding-complete' }), false);
});

test('4a: "insightful" does not false-match (word boundary) and host still wins', () => {
  assert.strictEqual(isInsightLikeStep({ sceneType: 'host', id: 'insightful-summary' }), false);
  assert.strictEqual(isInsightLikeStep({ id: 'insightful-summary' }), false);
});
