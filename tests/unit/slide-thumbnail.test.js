'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// We deliberately don't exercise the Playwright path in unit tests — that's
// a heavy integration concern. We test the pure helpers (buildPlaceholderHtml,
// resolveTargets) and the dispatcher's pre-Playwright logic (skip paths /
// arg validation), which is what would regress most often.
const SLIDE_THUMB = require(path.join(__dirname, '../../scripts/dashboard/utils/slide-thumbnail'));

// ─── buildPlaceholderHtml ───────────────────────────────────────────────────

describe('buildPlaceholderHtml', () => {
  test('renders the step label as the slide title', () => {
    const html = SLIDE_THUMB.buildPlaceholderHtml({
      label: 'Auth verifies external account',
      narration: '',
      sceneType: 'slide',
    });
    assert.match(html, /Auth verifies external account/);
    assert.match(html, /class="slide-title"/);
  });

  test('renders narration as the subtitle when provided', () => {
    const html = SLIDE_THUMB.buildPlaceholderHtml({
      label: 'X',
      narration: 'Plaid Auth confirms ownership of the external account in real time.',
      sceneType: 'slide',
    });
    assert.match(html, /Plaid Auth confirms ownership/);
  });

  test('falls back to a default narration when none provided', () => {
    const html = SLIDE_THUMB.buildPlaceholderHtml({ label: 'X' });
    assert.match(html, /Pending build|post-slides/i);
  });

  test('truncates very long narrations to keep the slide readable', () => {
    const long = 'A'.repeat(1000);
    const html = SLIDE_THUMB.buildPlaceholderHtml({ label: 'X', narration: long });
    // The placeholder should NOT contain the full 1000 chars + literal '…' marker added on truncation:
    assert.ok(!html.includes('A'.repeat(900)), 'narration should be truncated');
    assert.match(html, /…/);
  });

  test('escapes HTML special characters in label and narration', () => {
    const html = SLIDE_THUMB.buildPlaceholderHtml({
      label: '<script>alert(1)</script> & "wow"',
      narration: 'a < b > c & "d"',
    });
    assert.doesNotMatch(html, /<script>alert\(1\)/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&amp; "wow"/);
    assert.match(html, /a &lt; b &gt; c &amp; "d"/);
  });

  test('renders the sceneType tag in uppercase in the header', () => {
    const slideHtml = SLIDE_THUMB.buildPlaceholderHtml({ label: 'X', sceneType: 'slide' });
    const insightHtml = SLIDE_THUMB.buildPlaceholderHtml({ label: 'X', sceneType: 'insight' });
    assert.match(slideHtml, /SLIDE · placeholder preview/);
    assert.match(insightHtml, /INSIGHT · placeholder preview/);
  });

  test('uses the dark Plaid-style aesthetic (navy bg, teal accent)', () => {
    const html = SLIDE_THUMB.buildPlaceholderHtml({ label: 'X' });
    // Background gradient anchored on the same navy used by the slide-template:
    assert.match(html, /#0d1117/);
    // Plaid teal:
    assert.match(html, /#00A67E/i);
  });

  test('always includes the "Pending build" badge so users know it is provisional', () => {
    const html = SLIDE_THUMB.buildPlaceholderHtml({ label: 'X' });
    assert.match(html, /Pending build/);
  });
});

// ─── resolveTargets ─────────────────────────────────────────────────────────

describe('resolveTargets', () => {
  test('returns build-frames + qa-frames paths for a stepId', () => {
    const out = SLIDE_THUMB.resolveTargets('/run', 'my-step');
    assert.equal(out.length, 2);
    assert.match(out[0], /build-frames\/my-step-mid\.png$/);
    assert.match(out[1], /qa-frames\/my-step-mid\.png$/);
  });
});

// ─── generateLibrarySlideThumbnail — skip paths (no Playwright) ─────────────

describe('generateLibrarySlideThumbnail (skip paths)', () => {
  test('returns skipped when slide.htmlPath is missing', async () => {
    const out = await SLIDE_THUMB.generateLibrarySlideThumbnail('/tmp', 'step', { id: 'x' });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'missing-args');
    assert.deepEqual(out.written, []);
  });

  test('returns skipped when slide path is outside the slide library dir', async () => {
    const out = await SLIDE_THUMB.generateLibrarySlideThumbnail('/tmp', 'step', {
      htmlPath: 'inputs/elsewhere/index.html',
    });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'outside-library-dir');
  });

  test('returns skipped when slide HTML file is missing on disk', async () => {
    const out = await SLIDE_THUMB.generateLibrarySlideThumbnail('/tmp', 'step', {
      htmlPath: 'out/slide-library/slides/nonexistent/index.html',
    });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'slide-html-missing');
  });

  test('returns skipped when args are missing', async () => {
    assert.equal((await SLIDE_THUMB.generateLibrarySlideThumbnail(null, 'step', {})).skipped, true);
    assert.equal((await SLIDE_THUMB.generateLibrarySlideThumbnail('/tmp', '', {})).skipped, true);
    assert.equal((await SLIDE_THUMB.generateLibrarySlideThumbnail('/tmp', 'step', null)).skipped, true);
  });
});

// ─── generatePlaceholderSlideThumbnail — skip paths ─────────────────────────

describe('generatePlaceholderSlideThumbnail (skip paths)', () => {
  test('returns skipped when args are missing (does not invoke Playwright)', async () => {
    const out = await SLIDE_THUMB.generatePlaceholderSlideThumbnail(null, 'x', {});
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'missing-args');
  });
});
