'use strict';
/**
 * Canonical slide-pending-host placeholder shape tests.
 *
 * The placeholder is a load-bearing contract: three different regex helpers
 * in the codebase grep for the same outer `<div data-testid="step-{id}" ...>`
 * wrapper to find/strip/splice slide blocks:
 *
 *   1. scripts/scratch/scratch/post-slides.js                  → stepBlockRegex
 *      (used by orchestrator + dashboard insert-library-slide)
 *   2. scripts/dashboard/utils/insert-slide-html.js            → removeStepBlockFromHtml
 *   3. scripts/scratch/utils/strip-slide-roots-for-post-slides.js → stepBlockRegex
 *
 * These tests guarantee any future change to the placeholder shape stays
 * compatible with all three.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const {
  buildCanonicalSlidePlaceholder,
  stripSlideRoots,
  stepBlockRegex,
} = require(path.join(PROJECT_ROOT, 'scripts/scratch/utils/strip-slide-roots-for-post-slides'));
const {
  removeStepBlockFromHtml,
} = require(path.join(PROJECT_ROOT, 'scripts/dashboard/utils/insert-slide-html'));

describe('buildCanonicalSlidePlaceholder', () => {
  test('emits the canonical outer wrapper shape', () => {
    const html = buildCanonicalSlidePlaceholder({ id: 'opener-slide' });
    assert.match(html, /^<div data-testid="step-opener-slide" class="step">/);
    assert.match(html, /<\/div>$/);
    assert.match(html, /slide-pending-host/);
    assert.match(html, /data-slide-pending="true"/);
    assert.match(html, /data-slide-template="T1"/);
  });

  test('respects step.slideTemplate when provided', () => {
    const html = buildCanonicalSlidePlaceholder({ id: 'value-slide', slideTemplate: 'T11' });
    assert.match(html, /data-slide-template="T11"/);
  });

  test('falls back to T1 for invalid templates', () => {
    const html = buildCanonicalSlidePlaceholder({ id: 'x', slideTemplate: 'not-a-template' });
    assert.match(html, /data-slide-template="T1"/);
  });

  test('escapes label HTML special chars', () => {
    const html = buildCanonicalSlidePlaceholder({ id: 'x', label: '<script>alert(1)</script>' });
    assert.equal(/<script>/.test(html), false);
    assert.match(html, /&lt;script&gt;/);
  });

  test('throws on missing step.id', () => {
    assert.throws(() => buildCanonicalSlidePlaceholder({}), /step\.id is required/);
    assert.throws(() => buildCanonicalSlidePlaceholder({ id: '' }), /step\.id is required/);
  });
});

describe('canonical placeholder + step-block regex helpers', () => {
  const stepId = 'value-summary-slide';
  const placeholder = buildCanonicalSlidePlaceholder({ id: stepId, slideTemplate: 'T11', label: 'Recap' });

  test('post-slides stepBlockRegex matches the placeholder block', () => {
    // Wrap the placeholder in a realistic surrounding context: a prior step
    // div + post-panels side-panel marker so the lookahead anchors fire.
    const html = `<div data-testid="step-prev" class="step"><div>before</div></div>${placeholder}<!-- SIDE PANELS --><div id="link-events-panel"></div>`;
    const re = stepBlockRegex(stepId);
    const m = html.match(re);
    assert.ok(m, 'stepBlockRegex should find the placeholder block');
    assert.match(m[0], new RegExp(`data-testid="step-${stepId}"`));
  });

  test('removeStepBlockFromHtml (dashboard) strips the placeholder block cleanly', () => {
    const html = `<body><div data-testid="step-prev" class="step">x</div>${placeholder}<div data-testid="step-next" class="step">y</div></body>`;
    const out = removeStepBlockFromHtml(html, stepId);
    assert.equal(out.removed, true, 'should report removal success');
    assert.equal(/data-testid="step-value-summary-slide"/.test(out.html), false, 'placeholder div should be gone');
    assert.match(out.html, /data-testid="step-prev"/);
    assert.match(out.html, /data-testid="step-next"/);
  });
});

describe('stripSlideRoots — replaces .slide-root with canonical placeholder', () => {
  const fs = require('fs');
  const os = require('os');

  function mkRun(slideHtml, scriptSteps) {
    const TMP_ROOT = path.join(PROJECT_ROOT, 'out', '.tmp-tests-placeholder-shape');
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(TMP_ROOT, 'run-'));
    fs.mkdirSync(path.join(tmp, 'scratch-app'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'scratch-app', 'index.html'), slideHtml, 'utf8');
    fs.writeFileSync(path.join(tmp, 'demo-script.json'), JSON.stringify({ steps: scriptSteps }, null, 2), 'utf8');
    return tmp;
  }

  test('replaces .slide-root with canonical placeholder including data-slide-template', () => {
    const slideHtml = `<body>
<div data-testid="step-host-intro" class="step active">host</div>
<div data-testid="step-opener" class="step">
  <div class="slide-root" data-slide-template="T1">old slide content</div>
</div>
<!-- SIDE PANELS -->
<div id="link-events-panel"></div>
</body>`;
    const tmp = mkRun(slideHtml, [
      { id: 'host-intro', stepKind: 'app' },
      { id: 'opener', stepKind: 'slide', slideTemplate: 'T3', label: 'Opener' },
    ]);
    try {
      const { stripped, skipped } = stripSlideRoots({ runDir: tmp });
      assert.deepEqual(stripped, ['opener']);
      assert.deepEqual(skipped, []);
      const html = require('fs').readFileSync(path.join(tmp, 'scratch-app', 'index.html'), 'utf8');
      assert.match(html, /data-testid="step-opener"/);
      assert.match(html, /data-slide-pending="true"/);
      assert.match(html, /data-slide-template="T3"/);
      assert.match(html, /data-workhorse-layout="/);
      assert.match(html, /data-showcase-template="/);
      assert.equal(/old slide content/.test(html), false);
      assert.equal(/<div class="slide-root"/.test(html), false);
    } finally {
      require('fs').rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Cleanup the tmp root after all tests in this describe finish
  test('cleanup', () => {
    const fs2 = require('fs');
    const TMP_ROOT = path.join(PROJECT_ROOT, 'out', '.tmp-tests-placeholder-shape');
    fs2.rmSync(TMP_ROOT, { recursive: true, force: true });
    assert.equal(fs2.existsSync(TMP_ROOT), false);
  });
});
