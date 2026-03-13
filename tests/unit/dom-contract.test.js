'use strict';
/**
 * Tests for DOM contract validation against fixture HTML files.
 * Validates the same rules enforced by build-app.js at build time.
 * No API calls, no I/O beyond reading fixture files.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, '../fixtures');

/**
 * Validates an HTML string against the Plaid Demo DOM contract.
 * Returns an array of error strings (empty = valid).
 */
function validateDomContract(html) {
  const errors = [];

  // 1. At least one .step div with data-testid
  const stepMatches = [...html.matchAll(/<div[^>]+class="[^"]*\bstep\b[^"]*"[^>]*>/g)];
  const stepTestids = stepMatches
    .map(m => { const t = m[0].match(/data-testid="([^"]+)"/); return t ? t[1] : null; })
    .filter(Boolean);

  if (stepTestids.length === 0) {
    errors.push('No .step divs with data-testid found');
  }

  // 2. No duplicate data-testid values
  const allTestids = [...html.matchAll(/data-testid="([^"]+)"/g)].map(m => m[1]);
  const seen = new Set();
  for (const id of allTestids) {
    if (seen.has(id)) {
      errors.push(`Duplicate data-testid: "${id}"`);
    }
    seen.add(id);
  }

  // 3. goToStep function must be defined
  if (!/window\.goToStep\s*=/.test(html)) {
    errors.push('window.goToStep is not defined');
  }

  // 4. getCurrentStep function must be defined
  if (!/window\.getCurrentStep\s*=/.test(html)) {
    errors.push('window.getCurrentStep is not defined');
  }

  // 5. No .step div with inline display style (overrides .step { display:none })
  const inlineDisplayOnStep = /<div[^>]+class="[^"]*\bstep\b[^"]*"[^>]+style="[^"]*display\s*:/gi;
  if (inlineDisplayOnStep.test(html)) {
    errors.push('A .step div has an inline display: style — this overrides the hidden state');
  }

  return errors;
}

describe('dom-contract', () => {
  test('valid app HTML → no errors', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'valid-app.html'), 'utf8');
    const errors = validateDomContract(html);
    assert.deepEqual(errors, []);
  });

  test('missing data-testid on step div → error', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'invalid-missing-testid.html'), 'utf8');
    const errors = validateDomContract(html);
    assert.ok(errors.some(e => /No .step divs/.test(e)), `Expected testid error, got: ${errors}`);
  });

  test('duplicate data-testid → error', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'invalid-duplicate-testid.html'), 'utf8');
    const errors = validateDomContract(html);
    assert.ok(errors.some(e => /Duplicate/.test(e)), `Expected duplicate error, got: ${errors}`);
  });

  test('missing goToStep → error', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'invalid-missing-go-to-step.html'), 'utf8');
    const errors = validateDomContract(html);
    assert.ok(errors.some(e => /goToStep/.test(e)), `Expected goToStep error, got: ${errors}`);
  });

  test('inline display on .step div → error', () => {
    const html = fs.readFileSync(path.join(FIXTURES, 'invalid-inline-display.html'), 'utf8');
    const errors = validateDomContract(html);
    assert.ok(errors.some(e => /inline display/.test(e)), `Expected inline display error, got: ${errors}`);
  });
});
