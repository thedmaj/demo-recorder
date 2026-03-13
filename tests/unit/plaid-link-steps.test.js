'use strict';
/**
 * Tests that required Plaid Link step IDs are present in a demo script
 * when PLAID_LINK_LIVE=true (mirrors generate-script.js validation).
 * No API calls, no I/O beyond reading fixture files.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, '../fixtures');
const REQUIRED_PLAID_STEPS = ['link-consent', 'link-otp', 'link-account-select', 'link-success'];

function validatePlaidLinkSteps(demoScript) {
  const errors = [];
  const ids = (demoScript.steps || []).map(s => s.id);

  // Check for required steps
  for (const required of REQUIRED_PLAID_STEPS) {
    if (!ids.includes(required)) {
      errors.push(`Missing required Plaid Link step: "${required}"`);
    }
  }

  // Check for duplicate step IDs
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) {
      errors.push(`Duplicate step ID: "${id}"`);
    }
    seen.add(id);
  }

  return errors;
}

describe('plaid-link-steps', () => {
  test('all 4 required steps present → no errors', () => {
    const script = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'script-valid.json'), 'utf8'));
    const errors = validatePlaidLinkSteps(script);
    assert.deepEqual(errors, []);
  });

  test('missing link steps → errors for each missing step', () => {
    const script = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'script-missing-link.json'), 'utf8'));
    const errors = validatePlaidLinkSteps(script);
    assert.equal(errors.length, REQUIRED_PLAID_STEPS.length,
      `Expected ${REQUIRED_PLAID_STEPS.length} errors, got: ${errors}`);
  });

  test('missing link-consent → error', () => {
    const script = {
      steps: [
        { id: 'link-otp' }, { id: 'link-account-select' }, { id: 'link-success' }
      ]
    };
    const errors = validatePlaidLinkSteps(script);
    assert.ok(errors.some(e => e.includes('link-consent')));
  });

  test('missing link-success → error', () => {
    const script = {
      steps: [
        { id: 'link-consent' }, { id: 'link-otp' }, { id: 'link-account-select' }
      ]
    };
    const errors = validatePlaidLinkSteps(script);
    assert.ok(errors.some(e => e.includes('link-success')));
  });

  test('duplicate step IDs → error', () => {
    const script = {
      steps: [
        { id: 'link-consent' }, { id: 'link-otp' }, { id: 'link-account-select' },
        { id: 'link-success' }, { id: 'link-consent' }  // duplicate
      ]
    };
    const errors = validatePlaidLinkSteps(script);
    assert.ok(errors.some(e => /Duplicate/.test(e)));
  });
});
