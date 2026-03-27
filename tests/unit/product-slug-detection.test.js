'use strict';
/**
 * Tests for product slug detection logic (mirrors research.js detectProductSlug).
 * Documents the insertion-order priority: first match in slugMap wins.
 * No API calls, no I/O.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Mirrors detectProductSlug() from scripts/scratch/research.js
const SLUG_MAP = {
  'cra-base-report': /\b(base report|consumer report|check base report|cra base report)\b/i,
  'income-insights': /\b(cra income insights|income insights|cra_income_insights)\b/i,
  'auth':     /\bauth\b|\baccount.verif|\bIAV\b|\bEAV\b/i,
  'signal':   /\bsignal\b|\bach.risk\b/i,
  'layer':    /\blayer\b/i,
  'idv':      /\bIDV\b|\bidentity.verif/i,
  'monitor':  /\bmonitor\b/i,
  'assets':   /\bassets\b/i,
  'transfer': /\btransfer\b|\bpay.by.bank\b/i,
};

function detectProductSlug(promptContent) {
  for (const [slug, pattern] of Object.entries(SLUG_MAP)) {
    if (pattern.test(promptContent)) return slug;
  }
  return null;
}

describe('product-slug-detection', () => {
  test('"Build a Plaid Layer demo" → layer', () => {
    assert.equal(detectProductSlug('Build a Plaid Layer demo'), 'layer');
  });

  test('"Auth flow for Wells Fargo" → auth', () => {
    assert.equal(detectProductSlug('Auth flow for Wells Fargo'), 'auth');
  });

  test('"ACH risk with Signal" → signal', () => {
    assert.equal(detectProductSlug('ACH risk with Signal'), 'signal');
  });

  test('"Identity Verification for Leslie Knope" → idv', () => {
    assert.equal(detectProductSlug('Identity Verification for Leslie Knope'), 'idv');
  });

  test('"Monitor adverse media" → monitor', () => {
    assert.equal(detectProductSlug('Monitor adverse media screening'), 'monitor');
  });

  test('"Random unrelated text" → null', () => {
    assert.equal(detectProductSlug('Random unrelated text about nothing'), null);
  });

  test('"CRA Base Report underwriting flow" → cra-base-report', () => {
    assert.equal(detectProductSlug('CRA Base Report underwriting flow'), 'cra-base-report');
  });

  test('"CRA Income Insights underwriting review" → income-insights', () => {
    assert.equal(detectProductSlug('CRA Income Insights underwriting review'), 'income-insights');
  });

  test('"Signal auth flow" → auth (auth listed first in slugMap)', () => {
    // NOTE: Because SLUG_MAP iterates in insertion order and "auth" comes before "signal",
    // "auth" wins when both patterns match the same string.
    // If priority should change, reorder SLUG_MAP in research.js.
    const result = detectProductSlug('Signal auth flow');
    assert.equal(result, 'auth', 'auth appears first in SLUG_MAP so it wins over signal');
  });

  test('case-insensitive match for IDV', () => {
    assert.equal(detectProductSlug('idv demo for onboarding'), 'idv');
  });

  test('IAV abbreviation → auth', () => {
    assert.equal(detectProductSlug('Using IAV for instant auth'), 'auth');
  });
});
