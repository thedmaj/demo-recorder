'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// build-qa.js touches run-io.js at load time, which requires PIPELINE_RUN_DIR.
// Stub a dummy run dir so the module loads in unit-test context.
process.env.PIPELINE_RUN_DIR ||= path.join(__dirname, '../../out');

const { scanSlideCanvasSize } = require(path.join(
  __dirname,
  '../../scripts/scratch/scratch/build-qa'
));
const {
  PATCHES,
  findApplicablePatches,
  applyPatches,
  buildManualPatchMatch,
} = require(path.join(__dirname, '../../scripts/scratch/utils/qa-patch-library'));

// ── Fixtures ────────────────────────────────────────────────────────────────

function slideStep(id) {
  return { id, sceneType: 'slide', stepKind: 'slide', label: id };
}

function appStep(id) {
  return { id, sceneType: 'host', stepKind: 'app', label: id };
}

function state({ w, h, vw = 1440, vh = 900 } = {}) {
  return {
    slideRootRenderedWidth: w,
    slideRootRenderedHeight: h,
    viewportWidth: vw,
    viewportHeight: vh,
  };
}

// ── scanSlideCanvasSize ─────────────────────────────────────────────────────

describe('scanSlideCanvasSize — happy path (no diagnostics)', () => {
  test('1280×800 16:10 slide on 1440×900 viewport passes', () => {
    const out = scanSlideCanvasSize(state({ w: 1280, h: 800 }), slideStep('opener-slide'));
    assert.equal(out.length, 0);
  });

  test('1280×720 16:9 slide on 1440×900 viewport passes (aspect 1.78)', () => {
    const out = scanSlideCanvasSize(state({ w: 1280, h: 720 }), slideStep('opener-slide'));
    assert.equal(out.length, 0);
  });

  test('exactly at the 75% width / 67% height contract passes', () => {
    const out = scanSlideCanvasSize(state({ w: 1080, h: 603 }), slideStep('opener-slide'));
    assert.equal(out.length, 0);
  });
});

describe('scanSlideCanvasSize — failures', () => {
  test('fires `slide-canvas-size` critical when width < 75% of viewport', () => {
    const out = scanSlideCanvasSize(state({ w: 820, h: 512 }), slideStep('opener-slide'));
    const widthHit = out.find((d) => /width \d+px is below/.test(d.issue));
    assert.ok(widthHit, 'expected a width-below diagnostic');
    assert.equal(widthHit.category, 'slide-canvas-size');
    assert.equal(widthHit.severity, 'critical');
    assert.equal(widthHit.stepId, 'opener-slide');
    // Also a height violation expected since 512 < 600
    assert.ok(out.some((d) => /height \d+px is below/.test(d.issue)));
  });

  test('fires when aspect ratio is too square (1:1)', () => {
    const out = scanSlideCanvasSize(state({ w: 1100, h: 1100 }), slideStep('robinhood'));
    const aspectHit = out.find((d) => /aspect ratio/.test(d.issue));
    assert.ok(aspectHit);
    assert.equal(aspectHit.category, 'slide-canvas-size');
    assert.equal(aspectHit.severity, 'critical');
  });

  test('fires when aspect ratio is too wide (2.5:1)', () => {
    const out = scanSlideCanvasSize(state({ w: 1500, h: 600 }), slideStep('opener'));
    const aspectHit = out.find((d) => /aspect ratio/.test(d.issue));
    assert.ok(aspectHit);
  });

  test('respects custom widthFraction / heightFraction opts', () => {
    // With widthFraction=0.5 the 720 width passes; with default 0.75 it would fail.
    const passes = scanSlideCanvasSize(
      state({ w: 720, h: 450 }),
      slideStep('s'),
      { widthFraction: 0.5, heightFraction: 0.5 }
    );
    assert.equal(passes.length, 0);
    const fails = scanSlideCanvasSize(state({ w: 720, h: 450 }), slideStep('s'));
    assert.ok(fails.length >= 1);
  });
});

describe('scanSlideCanvasSize — guard paths', () => {
  test('skips non-slide steps entirely', () => {
    const out = scanSlideCanvasSize(state({ w: 100, h: 100 }), appStep('host-1'));
    assert.equal(out.length, 0);
  });

  test('skips when slide not yet measured (width=0)', () => {
    const out = scanSlideCanvasSize(state({ w: 0, h: 0 }), slideStep('opener'));
    assert.equal(out.length, 0);
  });

  test('skips when state / step missing', () => {
    assert.deepEqual(scanSlideCanvasSize(null, slideStep('x')), []);
    assert.deepEqual(scanSlideCanvasSize(state({ w: 1280, h: 800 }), null), []);
    assert.deepEqual(scanSlideCanvasSize(null, null), []);
  });
});

// ── slide-canvas-fullbleed patch (RETIRED 2026-05-22) ───────────────────────

describe('slide-canvas-fullbleed patch — retired stub', () => {
  test('registry entry is marked retired with manualOnly=true', () => {
    const entry = PATCHES.find((p) => p.name === 'slide-canvas-fullbleed');
    assert.ok(entry, 'retired stub must remain registered (for historical references)');
    assert.equal(entry.retired, true, 'must be flagged retired=true');
    assert.equal(entry.manualOnly, true, 'must be manualOnly=true');
    assert.deepEqual(entry.matchCategories, [], 'retired stub must not match any categories');
  });

  test('findApplicablePatches no longer auto-matches slide-canvas-size diagnostics', () => {
    // Canvas sizing is now owned by the always-on pipeline-slide-contract.css
    // injected by post-slides. A `slide-canvas-size` diagnostic post-rebuild
    // means a real contract violation that should NOT be papered over by a
    // patch — it should be escalated to slide-fix or a build-app regression
    // investigation.
    const qaReport = {
      steps: [
        {
          stepId: 'opener-slide',
          score: 35,
          categories: ['slide-canvas-size'],
          issues: ['Slide canvas width 820px is below the 1080px contract (viewport 1440x900).'],
        },
      ],
    };
    const matches = findApplicablePatches(qaReport);
    const fullbleed = matches.find((m) => m.patch.name === 'slide-canvas-fullbleed');
    assert.equal(fullbleed, undefined, 'retired stub must not match slide-canvas-size');
  });

  test('manual invocation returns the retired-no-op summary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-fullbleed-retired-'));
    fs.mkdirSync(path.join(dir, 'scratch-app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scratch-app', 'index.html'), '<html></html>', 'utf8');
    const match = buildManualPatchMatch('slide-canvas-fullbleed');
    const r = await applyPatches({ runDir: dir, matches: [match], iteration: 'retired' });
    assert.equal(r.applied, 0, 'retired stub must not apply');
    assert.match(r.results[0].summary || '', /retired|pipeline-slide-contract/i);
  });
});
