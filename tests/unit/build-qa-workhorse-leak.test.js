'use strict';

/**
 * Unit tests for Plaid × Workhorse leak scanners in build-qa.js.
 * Pipeline rule (see .claude/skills/plaid-workhorse-slides/SKILL.md):
 * - Workhorse layout patterns OK inside .slide-root
 * - Workhorse themes / runtime.js / Chart.js / data-anim NOT OK
 */

const path = require('node:path');
process.env.PIPELINE_RUN_DIR ||= path.join(__dirname, '../../out');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scanSlideWorkhorseThemeLeak,
  scanSlideWorkhorseRuntimeLeak,
  scanSlideMotionAttributes,
  scanSlideDesignSystem,
} = require('../../scripts/scratch/scratch/build-qa');

const SLIDE_IDS = ['plaid-summary-slide'];

const CLEAN_SLIDE = `
<div data-testid="step-plaid-summary-slide" class="step">
  <div class="slide-root" data-slide-template="T3" data-workhorse-layout="bullets">
    <div class="frame">
      <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="">
      <div class="eyebrow-tag">Summary</div>
      <div class="slide-stack">
        <h2 class="h-title">Plaid turns linked accounts into <em>actionable intelligence.</em></h2>
      </div>
      <div class="chrome-foot"><span>01 / 01</span></div>
    </div>
  </div>
</div>`;

// ── scanSlideWorkhorseThemeLeak ──────────────────────────────────────────────

test('scanSlideWorkhorseThemeLeak: clean Plaid slide -> no diagnostics', () => {
  const out = scanSlideWorkhorseThemeLeak(CLEAN_SLIDE, SLIDE_IDS);
  assert.equal(out.length, 0);
});

test('scanSlideWorkhorseThemeLeak: html-ppt theme CSS link inside slide -> critical blocker', () => {
  const html = CLEAN_SLIDE.replace(
    '<div class="frame">',
    '<link rel="stylesheet" href="assets/themes/tokyo-night.css"><div class="frame">'
  );
  const out = scanSlideWorkhorseThemeLeak(html, SLIDE_IDS);
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'slide-workhorse-theme-leak');
  assert.equal(out[0].severity, 'critical');
  assert.equal(out[0].deterministicBlocker, true);
  assert.match(out[0].issue, /Workhorse html-ppt theme CSS/);
});

test('scanSlideWorkhorseThemeLeak: Google Fonts Inter import inside slide -> critical', () => {
  const html = CLEAN_SLIDE.replace(
    '<div class="frame">',
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400" rel="stylesheet"><div class="frame">'
  );
  const out = scanSlideWorkhorseThemeLeak(html, SLIDE_IDS);
  assert.ok(out.some((d) => d.category === 'slide-workhorse-theme-leak'));
  assert.ok(out.some((d) => /Non-Plaid webfont/.test(d.issue)));
});

test('scanSlideWorkhorseThemeLeak: returns [] when no slide-root in document', () => {
  const out = scanSlideWorkhorseThemeLeak('<html><body>no slides here</body></html>', []);
  assert.deepEqual(out, []);
});

// ── scanSlideWorkhorseRuntimeLeak ────────────────────────────────────────────

test('scanSlideWorkhorseRuntimeLeak: clean slide -> no diagnostics', () => {
  const out = scanSlideWorkhorseRuntimeLeak(CLEAN_SLIDE, SLIDE_IDS);
  assert.equal(out.length, 0);
});

test('scanSlideWorkhorseRuntimeLeak: runtime.js script tag -> critical blocker', () => {
  const html = CLEAN_SLIDE.replace(
    '</div>\n</div>',
    '<script src="../assets/runtime.js"></script></div></div>'
  );
  const out = scanSlideWorkhorseRuntimeLeak(html, SLIDE_IDS);
  assert.ok(out.length >= 1);
  const d = out.find((x) => /runtime\.js/.test(x.issue));
  assert.ok(d, 'should flag runtime.js');
  assert.equal(d.category, 'slide-workhorse-runtime-leak');
  assert.equal(d.severity, 'critical');
});

test('scanSlideWorkhorseRuntimeLeak: fx-runtime.js script -> critical blocker', () => {
  const html = CLEAN_SLIDE.replace(
    '</div>\n</div>',
    '<script src="assets/animations/fx-runtime.js"></script></div></div>'
  );
  const out = scanSlideWorkhorseRuntimeLeak(html, SLIDE_IDS);
  assert.ok(out.length >= 1);
});

test('scanSlideWorkhorseRuntimeLeak: Chart.js CDN -> critical blocker', () => {
  const html = CLEAN_SLIDE.replace(
    '<div class="frame">',
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script><div class="frame">'
  );
  const out = scanSlideWorkhorseRuntimeLeak(html, SLIDE_IDS);
  const d = out.find((x) => /Chart\.js/.test(x.issue));
  assert.ok(d, 'should flag chart.js');
  assert.equal(d.severity, 'critical');
});

// ── scanSlideMotionAttributes ────────────────────────────────────────────────

test('scanSlideMotionAttributes: clean slide -> no diagnostics', () => {
  const out = scanSlideMotionAttributes(CLEAN_SLIDE, SLIDE_IDS);
  assert.equal(out.length, 0);
});

test('scanSlideMotionAttributes: data-anim attribute -> warning (not critical)', () => {
  const html = CLEAN_SLIDE.replace('<h2 class="h-title"', '<h2 class="h-title" data-anim="fade-up"');
  const out = scanSlideMotionAttributes(html, SLIDE_IDS);
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'slide-motion-attributes');
  assert.equal(out[0].severity, 'warning');
  assert.equal(out[0].deterministicBlocker, false);
  assert.match(out[0].issue, /data-anim/);
});

test('scanSlideMotionAttributes: anim-* class -> warning', () => {
  const html = CLEAN_SLIDE.replace(
    '<div class="slide-stack">',
    '<div class="slide-stack anim-fade-up">'
  );
  const out = scanSlideMotionAttributes(html, SLIDE_IDS);
  assert.equal(out.length, 1);
  assert.match(out[0].issue, /anim-\* class/);
});

test('scanSlideMotionAttributes: data-fx canvas FX -> warning', () => {
  const html = CLEAN_SLIDE.replace(
    '<div class="slide-stack">',
    '<div class="slide-stack" data-fx="knowledge-graph">'
  );
  const out = scanSlideMotionAttributes(html, SLIDE_IDS);
  assert.equal(out.length, 1);
  assert.match(out[0].issue, /data-fx/);
});

// ── Integration: scanSlideDesignSystem aggregates all three ─────────────────

test('scanSlideDesignSystem includes Workhorse leak scanners', () => {
  const html = CLEAN_SLIDE.replace(
    '<div class="frame">',
    '<link rel="stylesheet" href="assets/themes/dracula.css"><script src="../assets/runtime.js"></script><div class="frame">'
  ).replace('<h2 class="h-title"', '<h2 class="h-title" data-anim="rise-in"');
  const demoScript = { steps: [{ id: 'plaid-summary-slide', stepKind: 'slide', sceneType: 'slide' }] };
  const out = scanSlideDesignSystem(html, demoScript);
  const cats = new Set(out.map((d) => d.category));
  assert.ok(cats.has('slide-workhorse-theme-leak'), 'theme leak fires');
  assert.ok(cats.has('slide-workhorse-runtime-leak'), 'runtime leak fires');
  assert.ok(cats.has('slide-motion-attributes'), 'motion attribute fires');
});
