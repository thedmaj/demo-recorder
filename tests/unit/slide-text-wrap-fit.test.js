'use strict';

/**
 * Unit tests for the slide-text-wrap-fit patch (qa-patch-library.js).
 *
 * The build-qa scanner that produces `slide-text-wrap` diagnostics runs
 * inside a Playwright walk — covered separately. This test verifies the
 * patch's deterministic side of the contract:
 *   - reads build-qa-diagnostics.json from a run dir
 *   - emits scoped CSS rules per stepId + canonical class
 *   - skips when targets are already at the 24px floor
 *   - preserves an existing autofix block (idempotent replace)
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
process.env.PIPELINE_RUN_DIR ||= path.join(PROJECT_ROOT, 'out');

const { PATCHES } = require(path.join(PROJECT_ROOT, 'scripts/scratch/utils/qa-patch-library'));
const PATCH = PATCHES.find((p) => p.name === 'slide-text-wrap-fit');

function makeRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wrap-fit-'));
}

function writeRun(runDir, { html, diagnostics }) {
  fs.mkdirSync(path.join(runDir, 'scratch-app'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'scratch-app', 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(runDir, 'build-qa-diagnostics.json'), JSON.stringify({ diagnostics }, null, 2), 'utf8');
  return runDir;
}

function diag(stepId, opts = {}) {
  return {
    stepId,
    category: 'slide-text-wrap',
    severity: 'warning',
    deterministicBlocker: false,
    issue: 'demo',
    meta: {
      tag: opts.tag || 'H2',
      classes: opts.classes || 'h-title',
      text: opts.text || 'A long headline that wraps',
      currentFontSizePx: opts.currentFontSizePx || 72,
      recommendedFontSizePx: opts.recommendedFontSizePx || 48,
      lines: opts.lines || 2,
      rect: { x: 0, y: 0, w: 1000, h: 100 },
      isHeadlineLike: true,
    },
  };
}

const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length) {
    const dir = cleanupDirs.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

describe('slide-text-wrap-fit', () => {
  test('patch is registered and slide-tier', () => {
    assert.ok(PATCH, 'slide-text-wrap-fit not registered in PATCHES');
    assert.equal(PATCH.tierScope, 'slide');
    assert.ok(PATCH.matchCategories.includes('slide-text-wrap'));
  });

  test('emits scoped CSS for a wrapping h-title and writes to index.html', async () => {
    const runDir = makeRunDir();
    cleanupDirs.push(runDir);
    writeRun(runDir, {
      html: '<html><head></head><body><div data-testid="step-opener-slide" class="step"><div class="slide-root"><h2 class="h-title">Hi</h2></div></div></body></html>',
      diagnostics: [diag('opener-slide', { recommendedFontSizePx: 48, currentFontSizePx: 72 })],
    });

    const result = await PATCH.apply({ runDir });
    assert.equal(result.applied, true);
    const written = fs.readFileSync(path.join(runDir, 'scratch-app', 'index.html'), 'utf8');
    assert.match(written, /data-pipeline-textwrap-autofix="v1"/);
    assert.match(written, /\[data-testid="step-opener-slide"\] \.slide-root \.h-title \{ font-size: 48px;/);
  });

  test('skips when target already at 24px floor (caller has nothing to shrink)', async () => {
    const runDir = makeRunDir();
    cleanupDirs.push(runDir);
    writeRun(runDir, {
      html: '<html><head></head><body><div data-testid="step-x" class="step"><div class="slide-root"><h2 class="h-title">x</h2></div></div></body></html>',
      diagnostics: [diag('x', { currentFontSizePx: 25, recommendedFontSizePx: 24 })],
    });
    const result = await PATCH.apply({ runDir });
    // 24px target with 25px current → reduction is allowed (1px). Use truly floor case.
    // Recreate with currentFontSizePx == recommendedFontSizePx so the patch refuses.
    writeRun(runDir, {
      html: '<html><head></head><body><div data-testid="step-x" class="step"><div class="slide-root"><h2 class="h-title">x</h2></div></div></body></html>',
      diagnostics: [diag('x', { currentFontSizePx: 24, recommendedFontSizePx: 24 })],
    });
    const noopResult = await PATCH.apply({ runDir });
    assert.equal(noopResult.applied, false);
    assert.match(noopResult.summary, /already at the 24px floor/);
  });

  test('keeps smallest target per (step, selector) when multiple diagnostics overlap', async () => {
    const runDir = makeRunDir();
    cleanupDirs.push(runDir);
    writeRun(runDir, {
      html: '<html><head></head><body><div data-testid="step-a" class="step"><div class="slide-root"><h2 class="h-title">A</h2></div></div></body></html>',
      diagnostics: [
        diag('a', { recommendedFontSizePx: 56 }),
        diag('a', { recommendedFontSizePx: 40 }),
        diag('a', { recommendedFontSizePx: 48 }),
      ],
    });
    const result = await PATCH.apply({ runDir });
    assert.equal(result.applied, true);
    const written = fs.readFileSync(path.join(runDir, 'scratch-app', 'index.html'), 'utf8');
    assert.match(written, /font-size: 40px/);
    assert.equal((written.match(/font-size: \d+px/g) || []).length, 1);
  });

  test('idempotent: re-applying replaces the existing block instead of stacking it', async () => {
    const runDir = makeRunDir();
    cleanupDirs.push(runDir);
    writeRun(runDir, {
      html: '<html><head></head><body><div data-testid="step-a" class="step"><div class="slide-root"><h2 class="h-title">A</h2></div></div></body></html>',
      diagnostics: [diag('a', { recommendedFontSizePx: 48 })],
    });
    await PATCH.apply({ runDir });
    await PATCH.apply({ runDir });
    const written = fs.readFileSync(path.join(runDir, 'scratch-app', 'index.html'), 'utf8');
    const blockMatches = written.match(/data-pipeline-textwrap-autofix="v1"/g) || [];
    assert.equal(blockMatches.length, 1, 'autofix block should not stack');
  });
});
