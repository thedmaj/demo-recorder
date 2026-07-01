'use strict';
// Regression suite for Item 4b-ii (Astera 2026-06-30): negated product mentions
// must not leak into Link products[]. inferPlaidLinkProductsFromPrompt now applies
// a WINDOWED negation guard (not a whole-line strip — that over-suppressed real
// products co-mentioned with a benign "no"/"without"). These cases lock in both
// the fix and the anti-over-suppression edge. See also the corpus diagnostic:
// tests/corpus-product-inference-diff.js (run before changing this inference).
const test = require('node:test');
const assert = require('node:assert');
const {
  inferPlaidLinkProductsFromPrompt,
} = require('../../scripts/scratch/utils/link-token-create-config');

test('4b-ii: negated investments_auth / ACATS-N/A does NOT leak into products[]', () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'Read-only bundle: investments (holdings), transactions, liabilities. ' +
    'Do NOT use investments_auth. ACATS/transfer fields N/A.'
  );
  assert.ok(!p.includes('investments_auth'), 'negated investments_auth must be excluded; got ' + JSON.stringify(p));
  assert.ok(p.includes('investments'), 'data-access investments should still be present; got ' + JSON.stringify(p));
});

test('4b-ii: affirmative Investments Move still adds investments_auth', () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'Plaid Investments Move — initiate an ACATS brokerage transfer via /investments/auth/get.'
  );
  assert.ok(p.includes('investments_auth'), 'affirmative Move/ACATS must add investments_auth; got ' + JSON.stringify(p));
});

test('4b-ii: benign "no"/"without" near a product does NOT over-suppress it', () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'KeyBank Instant Auth and Plaid Signal — verified account and routing, ' +
    'no micro-deposit round trip. /auth/get and /signal/evaluate.'
  );
  assert.ok(p.includes('auth'), 'auth must survive a nearby benign "no"; got ' + JSON.stringify(p));
  assert.ok(p.includes('signal'), 'signal must survive; got ' + JSON.stringify(p));
});

test('4b-ii: "IDV — N/A" reminder does not add identity', () => {
  const p = inferPlaidLinkProductsFromPrompt(
    'Auth + Signal demo. IDV — N/A this run. Endpoints: /auth/get, /signal/evaluate.'
  );
  assert.ok(!p.includes('identity'), 'negated IDV must not add identity; got ' + JSON.stringify(p));
  assert.ok(p.includes('auth') && p.includes('signal'), 'auth+signal expected; got ' + JSON.stringify(p));
});
