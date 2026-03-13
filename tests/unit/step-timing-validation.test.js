'use strict';
/**
 * Tests for step timing JSON schema validation.
 * Documents the expected shape of step-timing.json / processed-step-timing.json.
 * No API calls, no I/O beyond reading fixture files.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, '../fixtures');

/**
 * Validates a step timing JSON object.
 * Returns { errors: string[], warnings: string[] }.
 */
function validateStepTiming(timing) {
  const errors = [];
  const warnings = [];

  if (!timing || !Array.isArray(timing.steps)) {
    errors.push('timing.steps must be an array');
    return { errors, warnings };
  }

  let prevOffset = -Infinity;
  for (let i = 0; i < timing.steps.length; i++) {
    const step = timing.steps[i];

    if (!step.step || typeof step.step !== 'string') {
      errors.push(`steps[${i}]: missing required field "step" (string)`);
    }

    if (!('recordingOffsetS' in step)) {
      errors.push(`steps[${i}]: missing required field "recordingOffsetS"`);
    } else if (step.recordingOffsetS !== null && typeof step.recordingOffsetS !== 'number') {
      errors.push(`steps[${i}]: recordingOffsetS must be a number or null`);
    }

    // Monotonically increasing offsets (nulls are allowed for live Plaid steps)
    if (step.recordingOffsetS !== null && step.recordingOffsetS < prevOffset) {
      warnings.push(`steps[${i}] (${step.step}): recordingOffsetS ${step.recordingOffsetS} is less than previous ${prevOffset} — not monotonically increasing`);
    }
    if (step.recordingOffsetS !== null) prevOffset = step.recordingOffsetS;
  }

  return { errors, warnings };
}

describe('step-timing-validation', () => {
  test('valid timing JSON → no errors or warnings', () => {
    const timing = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'step-timing-valid.json'), 'utf8'));
    const { errors, warnings } = validateStepTiming(timing);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });

  test('invalid timing JSON → errors for missing fields', () => {
    const timing = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'step-timing-invalid.json'), 'utf8'));
    const { errors } = validateStepTiming(timing);
    assert.ok(errors.length > 0, 'Should have errors for missing required fields');
  });

  test('non-monotonic offsets → warning (not error)', () => {
    const timing = {
      steps: [
        { step: 'intro',   recordingOffsetS: 5.0 },
        { step: 'outcome', recordingOffsetS: 2.0 }, // goes backwards
      ],
    };
    const { errors, warnings } = validateStepTiming(timing);
    assert.equal(errors.length, 0, 'Non-monotonic offset should be a warning, not an error');
    assert.ok(warnings.length > 0, 'Should have a monotonicity warning');
  });

  test('null offsets → allowed (Plaid Link live steps)', () => {
    const timing = {
      steps: [
        { step: 'link-consent', recordingOffsetS: null },
      ],
    };
    const { errors } = validateStepTiming(timing);
    assert.deepEqual(errors, []);
  });

  test('missing step field → error', () => {
    const timing = {
      steps: [{ recordingOffsetS: 0.0 }],
    };
    const { errors } = validateStepTiming(timing);
    assert.ok(errors.some(e => /missing.*"step"/.test(e)));
  });

  test('missing recordingOffsetS field → error', () => {
    const timing = {
      steps: [{ step: 'intro' }],
    };
    const { errors } = validateStepTiming(timing);
    assert.ok(errors.some(e => /recordingOffsetS/.test(e)));
  });

  test('null timing → error', () => {
    const { errors } = validateStepTiming(null);
    assert.ok(errors.length > 0);
  });
});
