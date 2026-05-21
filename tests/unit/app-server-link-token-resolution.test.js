'use strict';
/**
 * Tests for the research-driven /link/token/create products[] resolution
 * inside `scripts/scratch/utils/app-server.js`.
 *
 * Contract under test (CLAUDE.md):
 *   "the pipeline build should not hardcode Plaid Products but leverage
 *    the proper and recommended parameters based on the research phase
 *    or indexed product knowledge."
 *
 * These tests exercise the pure helpers exported from app-server.js. They
 * do NOT spin up an HTTP server or call the Plaid backend.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadResearchLinkTokenConfig,
  resolveCreateLinkTokenProducts,
} = require('../../scripts/scratch/utils/app-server');

function writeTempRunDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-server-research-'));
  if (config !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'link-token-create-config.json'),
      JSON.stringify(config, null, 2)
    );
  }
  return dir;
}

test('loadResearchLinkTokenConfig returns null when runDir is null', () => {
  assert.equal(loadResearchLinkTokenConfig(null), null);
});

test('loadResearchLinkTokenConfig returns null when file is missing', () => {
  const dir = writeTempRunDir(undefined);
  assert.equal(loadResearchLinkTokenConfig(dir), null);
});

test('loadResearchLinkTokenConfig reads link-token-create-config.json', () => {
  const dir = writeTempRunDir({
    products: ['auth', 'identity'],
    productFamily: 'funding',
  });
  const cfg = loadResearchLinkTokenConfig(dir);
  assert.ok(cfg);
  assert.deepEqual(cfg.products, ['auth', 'identity']);
  assert.equal(cfg.productFamily, 'funding');
});

test('resolveCreateLinkTokenProducts: research config wins over body products', () => {
  const result = resolveCreateLinkTokenProducts({
    bodyProducts: ['identity', 'auth', 'income_verification', 'cra_income_insights'],
    researchConfig: { products: ['auth', 'identity'], productFamily: 'funding' },
  });
  assert.deepEqual(result.products, ['auth', 'identity']);
  assert.equal(result.source, 'research-config');
  assert.equal(result.driftDetected, true);
});

test('resolveCreateLinkTokenProducts: research config wins (no drift when bodies match)', () => {
  const result = resolveCreateLinkTokenProducts({
    bodyProducts: ['auth', 'identity'],
    researchConfig: { products: ['auth', 'identity'], productFamily: 'funding' },
  });
  assert.deepEqual(result.products, ['auth', 'identity']);
  assert.equal(result.source, 'research-config');
  assert.equal(result.driftDetected, false);
});

test('resolveCreateLinkTokenProducts: falls back to body products when no research config', () => {
  const result = resolveCreateLinkTokenProducts({
    bodyProducts: ['auth', 'identity'],
    researchConfig: null,
  });
  assert.deepEqual(result.products, ['auth', 'identity']);
  assert.equal(result.source, 'request-body');
});

test('resolveCreateLinkTokenProducts: falls back to safe default when nothing provided', () => {
  const result = resolveCreateLinkTokenProducts({
    bodyProducts: [],
    researchConfig: null,
  });
  assert.deepEqual(result.products, ['auth', 'identity']);
  assert.equal(result.source, 'fallback-default');
});

test('resolveCreateLinkTokenProducts: filters invalid product slugs from body', () => {
  // 'bank_income' is a knowledge-base slug but is NOT a Plaid Link product
  // string; the wire product is 'income_verification'. The resolver should
  // drop it silently.
  const result = resolveCreateLinkTokenProducts({
    bodyProducts: ['bank_income', 'auth', 'identity'],
    researchConfig: null,
  });
  assert.deepEqual(result.products.sort(), ['auth', 'identity']);
  assert.equal(result.source, 'request-body');
});

test('resolveCreateLinkTokenProducts: BofA-style bad mix sanitizes to non-CRA Income (auto intent)', () => {
  // This is the exact failure mode that motivated the contract: the LLM
  // hardcoded a CRA + non-CRA mix in the generated HTML and Plaid rejected
  // it. With no research config and 'auto' intent, sanitizer keeps the
  // non-CRA Income path.
  const result = resolveCreateLinkTokenProducts({
    bodyProducts: ['identity', 'auth', 'income_verification', 'cra_income_insights'],
    researchConfig: null,
  });
  assert.deepEqual(result.products, ['income_verification']);
  assert.equal(result.source, 'request-body');
  assert.ok(result.sanitization);
  assert.deepEqual(result.sanitization.droppedCra, ['cra_income_insights']);
});

test('resolveCreateLinkTokenProducts: productFamilyHint=cra steers sanitization to CRA path', () => {
  const result = resolveCreateLinkTokenProducts({
    bodyProducts: ['identity', 'auth', 'income_verification', 'cra_income_insights', 'cra_base_report'],
    researchConfig: null,
    productFamilyHint: 'cra_base_report',
  });
  assert.ok(result.products.includes('cra_base_report'));
  assert.ok(result.products.includes('cra_income_insights'));
  assert.ok(!result.products.includes('income_verification'));
});

test('resolveCreateLinkTokenProducts: research productFamily inferred when not provided in hint', () => {
  const result = resolveCreateLinkTokenProducts({
    bodyProducts: [],
    researchConfig: {
      products: ['cra_base_report', 'cra_income_insights'],
      productFamily: 'cra_base_report',
    },
  });
  assert.deepEqual(result.products.sort(), ['cra_base_report', 'cra_income_insights']);
  assert.equal(result.source, 'research-config');
});
