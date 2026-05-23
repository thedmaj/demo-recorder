'use strict';
/**
 * scanSlideNarrationConcreteValues tests.
 *
 * The scanner catches a critical class of LLM hallucinations: a slide whose
 * rendered text contains values that disagree with the demo-script's
 * narration. Voiceover is generated from narration; recording captures
 * the rendered slide; if the two disagree, the published video has the
 * narrator saying "Trust Index 87" while the screen shows "Score 92".
 *
 * Covers:
 *   - app-only mode: scanner is a no-op (correct — no slides to scan)
 *   - app+slides clean: zero diagnostics
 *   - numeric token leak (narration says "47%", slide shows nothing)
 *   - decision token leak (narration says "ACCEPT", slide shows nothing)
 *   - product name leak (narration says "Trust Index", slide shows nothing)
 *   - clean match: narration text appears in rendered slide
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
process.env.PIPELINE_RUN_DIR ||= path.join(PROJECT_ROOT, 'out');

const bq = require(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/build-qa'));

function html(steps) {
  return `<body>${steps}<!-- SIDE PANELS --><div id="link-events-panel"></div></body>`;
}

describe('scanSlideNarrationConcreteValues — gating', () => {
  test('returns [] on app-only', () => {
    const out = bq.scanSlideNarrationConcreteValues(
      html('<div data-testid="step-x" class="step"><div class="slide-root"></div></div>'),
      { steps: [{ id: 'x', stepKind: 'slide', narration: 'Trust Index 87 ACCEPT.' }] },
      'app-only',
    );
    assert.deepEqual(out, []);
  });

  test('returns [] when buildMode is empty/undefined', () => {
    assert.deepEqual(bq.scanSlideNarrationConcreteValues('', {}, ''), []);
    assert.deepEqual(bq.scanSlideNarrationConcreteValues('', {}, undefined), []);
  });

  test('returns [] when demoScript has no slide steps', () => {
    const out = bq.scanSlideNarrationConcreteValues(
      html('<div data-testid="step-x" class="step">app step</div>'),
      { steps: [{ id: 'x', stepKind: 'app' }] },
      'app+slides',
    );
    assert.deepEqual(out, []);
  });
});

describe('scanSlideNarrationConcreteValues — concrete value detection', () => {
  test('flags missing numeric token (47% in narration, not in slide)', () => {
    const slideHtml = html(
      '<div data-testid="step-opener" class="step">' +
      '<div class="slide-root">' +
      '<h2>Faster onboarding</h2><p>Less friction, more conversions.</p>' +
      '</div></div>',
    );
    const out = bq.scanSlideNarrationConcreteValues(
      slideHtml,
      { steps: [{
        id: 'opener',
        stepKind: 'slide',
        narration: 'Conversion lifts by 47% after deploying Plaid Layer in three weeks.',
      }] },
      'app+slides',
    );
    assert.ok(out.length > 0, 'expected drift diagnostic');
    const d = out[0];
    assert.equal(d.stepId, 'opener');
    assert.equal(d.category, 'slide-narration-drift');
    assert.equal(d.severity, 'critical');
    assert.equal(d.deterministicBlocker, true);
    assert.match(d.issue, /47%/);
  });

  test('flags missing decision token (ACCEPT in narration, not on slide)', () => {
    const slideHtml = html(
      '<div data-testid="step-decision" class="step">' +
      '<div class="slide-root"><h2>Score 12</h2></div></div>',
    );
    const out = bq.scanSlideNarrationConcreteValues(
      slideHtml,
      { steps: [{
        id: 'decision',
        stepKind: 'slide',
        narration: 'Signal returns score 12 — ACCEPT.',
      }] },
      'app+slides',
    );
    const tokens = out[0].missingTokens.join(' ');
    assert.match(tokens, /ACCEPT/);
  });

  test('flags missing product name (Trust Index in narration, not on slide)', () => {
    const slideHtml = html(
      '<div data-testid="step-protect" class="step">' +
      '<div class="slide-root"><h2>87</h2></div></div>',
    );
    const out = bq.scanSlideNarrationConcreteValues(
      slideHtml,
      { steps: [{
        id: 'protect',
        stepKind: 'slide',
        narration: 'Trust Index returns 87, well above the cohort baseline.',
      }] },
      'app+slides',
    );
    assert.ok(out.length > 0);
    const tokens = out[0].missingTokens.join(' ');
    assert.match(tokens, /Trust Index/);
  });

  test('clean match: narration concrete values present in slide → zero diagnostics', () => {
    const slideHtml = html(
      '<div data-testid="step-clean" class="step">' +
      '<div class="slide-root">' +
      '<h2>Trust Index 87 — ACCEPT</h2><p>Conversion lifts by 47%.</p>' +
      '</div></div>',
    );
    const out = bq.scanSlideNarrationConcreteValues(
      slideHtml,
      { steps: [{
        id: 'clean',
        stepKind: 'slide',
        narration: 'Trust Index 87 returns ACCEPT, conversion lifts by 47%.',
      }] },
      'app+slides',
    );
    assert.deepEqual(out, []);
  });

  test('ignores tiny standalone numbers (likely step counts, not claims)', () => {
    const slideHtml = html(
      '<div data-testid="step-counts" class="step">' +
      '<div class="slide-root"><h2>Onboarding</h2></div></div>',
    );
    const out = bq.scanSlideNarrationConcreteValues(
      slideHtml,
      { steps: [{
        id: 'counts',
        stepKind: 'slide',
        narration: 'In 3 quick steps, the user onboards.',
      }] },
      'app+slides',
    );
    // "3" alone shouldn't be flagged. (Larger numbers / numbers with units would be.)
    assert.deepEqual(out, []);
  });

  test('exported from build-qa', () => {
    assert.equal(typeof bq.scanSlideNarrationConcreteValues, 'function');
  });
});
