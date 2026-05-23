'use strict';
/**
 * App-only invariant tests.
 *
 * Verifies that runs with run-manifest.json.buildMode === 'app-only' produce
 * zero slide artifacts. These tests exercise the safety floor that prevents
 * any future change from accidentally leaking slide DOM into an app-only
 * build.
 *
 * Covers:
 *   1. scanAppOnlyNoSlides flags every documented slide-leak pattern
 *   2. scanAppOnlyNoSlides is a no-op on app+slides runs
 *   3. scanAppOnlyNoSlides flags slide steps in demo-script.json on app-only
 *   4. post-slides.main() returns { skipped, reason: 'app-only' } when manifest
 *      says app-only (without depending on demo-script step count)
 *   5. slide-fix.main() returns { skipped, reason: 'buildMode_not_app_plus_slides' }
 *      on app-only (existing behavior — sanity check)
 *   6. tierSummary.slide on app-only is { passed:true, skipped:true } shape
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
// `requireRunDir` enforces PIPELINE_RUN_DIR be under `<projectRoot>/out`.
// Create a per-test sandbox there.
const TMP_ROOT = path.join(PROJECT_ROOT, 'out', '.tmp-tests-app-only');
fs.mkdirSync(TMP_ROOT, { recursive: true });

process.env.PIPELINE_RUN_DIR ||= path.join(PROJECT_ROOT, 'out');

const bq = require(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/build-qa'));
const { computeTierSummary } = require(path.join(PROJECT_ROOT, 'scripts/scratch/utils/qa-tier-summary'));

function mkTmpRun(prefix) {
  return fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));
}
function writeManifest(runDir, buildMode) {
  fs.writeFileSync(
    path.join(runDir, 'run-manifest.json'),
    JSON.stringify({ schemaVersion: 1, runId: path.basename(runDir), buildMode }, null, 2),
    'utf8'
  );
}

describe('app-only invariant — scanAppOnlyNoSlides', () => {
  test('is a no-op when buildMode !== "app-only"', () => {
    const html = '<div class="slide-root">leaked but not app-only</div>';
    assert.deepEqual(bq.scanAppOnlyNoSlides(html, {}, 'app+slides'), []);
    assert.deepEqual(bq.scanAppOnlyNoSlides(html, {}, ''), []);
    assert.deepEqual(bq.scanAppOnlyNoSlides(html, {}, undefined), []);
  });

  test('is a no-op when html is empty', () => {
    assert.deepEqual(bq.scanAppOnlyNoSlides('', {}, 'app-only'), []);
    assert.deepEqual(bq.scanAppOnlyNoSlides(null, {}, 'app-only'), []);
  });

  test('flags .slide-root div leak as critical deterministic blocker', () => {
    const html = '<div class="slide-root">leaked</div>';
    const d = bq.scanAppOnlyNoSlides(html, {}, 'app-only');
    assert.equal(d.length, 1);
    assert.equal(d[0].severity, 'critical');
    assert.equal(d[0].category, 'app-only-slide-leak');
    assert.equal(d[0].deterministicBlocker, true);
    assert.match(d[0].issue, /\.slide-root/);
    assert.match(d[0].suggestion, /build-app|script-stage/);
  });

  test('flags slide-pending placeholder leak', () => {
    const html = '<div data-slide-pending="true">placeholder</div>';
    const d = bq.scanAppOnlyNoSlides(html, {}, 'app-only');
    assert.equal(d.length, 1);
    assert.equal(d[0].category, 'app-only-slide-leak');
    assert.match(d[0].issue, /data-slide-pending/);
  });

  test('flags pipeline-slide-contract CSS leak', () => {
    const html = '<style data-pipeline-slide-contract="v1">.slide-root{}</style>';
    const d = bq.scanAppOnlyNoSlides(html, {}, 'app-only');
    assert.equal(d.length, 1);
    assert.match(d[0].issue, /pipeline-slide-contract/);
  });

  test('flags data-slide-template marker leak', () => {
    const html = '<div data-slide-template="T3">slide</div>';
    const d = bq.scanAppOnlyNoSlides(html, {}, 'app-only');
    assert.equal(d.length, 1);
    assert.match(d[0].issue, /data-slide-template/);
  });

  test('flags multiple leak patterns independently', () => {
    const html = '<div class="slide-root" data-slide-template="T3" data-slide-pending="true"></div>';
    const d = bq.scanAppOnlyNoSlides(html, {}, 'app-only');
    assert.ok(d.length >= 3, 'expected at least 3 leak diagnostics');
    for (const diag of d) {
      assert.equal(diag.category, 'app-only-slide-leak');
      assert.equal(diag.deterministicBlocker, true);
    }
  });

  test('flags slide steps in demo-script.json on app-only', () => {
    const demoScript = {
      steps: [
        { id: 'host-intro', stepKind: 'app' },
        { id: 'opener-slide', stepKind: 'slide' },
        { id: 'value-summary-slide', sceneType: 'slide' },
      ],
    };
    const d = bq.scanAppOnlyNoSlides('<div></div>', demoScript, 'app-only');
    assert.equal(d.length, 1);
    assert.equal(d[0].category, 'app-only-slide-leak');
    assert.match(d[0].issue, /demo-script.*slide step\(s\)/);
    assert.match(d[0].issue, /opener-slide/);
    assert.match(d[0].issue, /value-summary-slide/);
    assert.match(d[0].suggestion, /generate-script\.js/);
  });

  test('clean app-only HTML emits zero diagnostics', () => {
    const html = `
<div data-testid="step-host-intro" class="step active">
  <h1>Welcome</h1>
  <button data-testid="cta-continue">Continue</button>
</div>
<div data-testid="step-plaid-link-launch" class="step">
  <button data-testid="link-external-account-btn">Link bank</button>
</div>`;
    const demoScript = {
      steps: [
        { id: 'host-intro', stepKind: 'app' },
        { id: 'plaid-link-launch', stepKind: 'link' },
      ],
    };
    assert.deepEqual(bq.scanAppOnlyNoSlides(html, demoScript, 'app-only'), []);
  });

  test('is exported from build-qa', () => {
    assert.equal(typeof bq.scanAppOnlyNoSlides, 'function');
  });
});

describe('app-only invariant — tierSummary shape', () => {
  test('tierSummary.slide is { passed:true, skipped:true } on app-only', () => {
    const tmp = mkTmpRun('app-only-tier');
    try {
      writeManifest(tmp, 'app-only');
      const report = { steps: [{ stepId: 'host-intro', score: 90, critical: false }] };
      const demoScript = { steps: [{ id: 'host-intro', stepKind: 'app' }] };
      const out = computeTierSummary(report, demoScript, { runDir: tmp });
      assert.equal(out.buildMode, 'app-only');
      assert.equal(out.tierSummary.slide.passed, true);
      assert.equal(out.tierSummary.slide.skipped, true);
      assert.equal(out.tierSummary.slide.stepCount, 0);
      assert.deepEqual(out.tierSummary.slide.failingStepIds, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('tierSummary.slide has stepCount > 0 on app+slides', () => {
    const tmp = mkTmpRun('app-slides-tier');
    try {
      writeManifest(tmp, 'app+slides');
      const report = {
        steps: [
          { stepId: 'host-intro', score: 90, critical: false },
          { stepId: 'opener-slide', score: 85, critical: false },
        ],
      };
      const demoScript = {
        steps: [
          { id: 'host-intro', stepKind: 'app' },
          { id: 'opener-slide', stepKind: 'slide' },
        ],
      };
      const out = computeTierSummary(report, demoScript, { runDir: tmp });
      assert.equal(out.buildMode, 'app+slides');
      assert.equal(out.tierSummary.slide.skipped, false);
      assert.equal(out.tierSummary.slide.stepCount, 1);
      assert.deepEqual(out.tierSummary.slide.stepIds, ['opener-slide']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('app-only invariant — post-slides.main() skip behavior', () => {
  // Helper: stub the minimum pipeline-run-context for post-slides.main()
  // to read, then invoke main() with manifest set to app-only.
  function setupAppOnlyRun(stepKind /* 'slide' | 'app' */) {
    const tmp = mkTmpRun('post-slides-app-only');
    fs.mkdirSync(path.join(tmp, 'scratch-app'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'scratch-app', 'index.html'),
      '<html><body><div data-testid="step-x" class="step active">x</div></body></html>',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmp, 'demo-script.json'),
      JSON.stringify({ steps: [{ id: 'x', stepKind }] }, null, 2),
      'utf8'
    );
    writeManifest(tmp, 'app-only');
    return tmp;
  }

  test('post-slides.main() skips with reason="app-only" on app-only manifest', async () => {
    const prevRunDir = process.env.PIPELINE_RUN_DIR;
    const tmp = setupAppOnlyRun('app');
    process.env.PIPELINE_RUN_DIR = tmp;
    try {
      delete require.cache[require.resolve(path.join(__dirname, '../../scripts/scratch/scratch/post-slides'))];
      const ps = require(path.join(__dirname, '../../scripts/scratch/scratch/post-slides'));
      const out = await ps.main();
      assert.ok(out, 'main() should return a report on skip');
      assert.equal(out.skipped, true);
      assert.equal(out.reason, 'app-only');
      assert.equal(out.buildMode, 'app-only');
      assert.equal(out.noop, true);

      // Verify report file written
      const reportPath = path.join(tmp, 'post-slides-report.json');
      assert.ok(fs.existsSync(reportPath), 'post-slides-report.json should exist');
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      assert.equal(report.skipped, true);
      assert.equal(report.reason, 'app-only');
    } finally {
      process.env.PIPELINE_RUN_DIR = prevRunDir;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('post-slides.main() skips even if demo-script has slide steps (manifest wins)', async () => {
    // Defense-in-depth: a script-stage bug that leaks slide steps must NOT
    // silently activate post-slides on an app-only run. The manifest is
    // authoritative; demo-script steps are not consulted before the gate.
    const prevRunDir = process.env.PIPELINE_RUN_DIR;
    const tmp = setupAppOnlyRun('slide');
    process.env.PIPELINE_RUN_DIR = tmp;
    try {
      delete require.cache[require.resolve(path.join(__dirname, '../../scripts/scratch/scratch/post-slides'))];
      const ps = require(path.join(__dirname, '../../scripts/scratch/scratch/post-slides'));
      const out = await ps.main();
      assert.equal(out.skipped, true);
      assert.equal(out.reason, 'app-only');
      // Confirm we did NOT write a .slide-root into the HTML
      const html = fs.readFileSync(path.join(tmp, 'scratch-app', 'index.html'), 'utf8');
      assert.equal(/slide-root/i.test(html), false, 'no .slide-root should be injected on app-only');
    } finally {
      process.env.PIPELINE_RUN_DIR = prevRunDir;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('app-only invariant — slide-fix.main() skip behavior (existing gate)', () => {
  test('slide-fix.main() skips on app-only and writes reason="buildMode_not_app_plus_slides" sentinel', async () => {
    const prevRunDir = process.env.PIPELINE_RUN_DIR;
    const tmp = mkTmpRun('slide-fix-app-only');
    try {
      writeManifest(tmp, 'app-only');
      fs.writeFileSync(
        path.join(tmp, 'qa-report-build.json'),
        JSON.stringify({
          buildMode: 'app-only',
          tierSummary: {
            threshold: 80,
            app: { passed: true, skipped: false, stepCount: 1, failingStepIds: [] },
            slide: { passed: true, skipped: true, stepCount: 0, failingStepIds: [] },
          },
          recommendedRecovery: null,
          systemicReasons: [],
        }, null, 2),
        'utf8'
      );
      process.env.PIPELINE_RUN_DIR = tmp;
      delete require.cache[require.resolve(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/slide-fix'))];
      const sf = require(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/slide-fix'));
      const out = await sf.main({ runDir: tmp });
      assert.equal(out.skipped, true);

      // The reason lives in the sentinel file (the returned object intentionally
      // omits it — slide-fix-report.json is the canonical artifact).
      const sentinelPath = path.join(tmp, 'slide-fix-report.json');
      assert.ok(fs.existsSync(sentinelPath), 'slide-fix-report.json should exist');
      const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
      assert.equal(sentinel.skipped, true);
      assert.equal(sentinel.reason, 'buildMode_not_app_plus_slides');
      assert.equal(sentinel.buildMode, 'app-only');
    } finally {
      process.env.PIPELINE_RUN_DIR = prevRunDir;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
