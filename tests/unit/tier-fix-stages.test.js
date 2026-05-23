'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const slideFix = require(path.join(__dirname, '../../scripts/scratch/scratch/slide-fix'));
const appTouchup = require(path.join(__dirname, '../../scripts/scratch/scratch/app-touchup'));
const stripper = require(path.join(__dirname, '../../scripts/scratch/utils/strip-slide-roots-for-post-slides'));

function makeRunDir({
  buildMode = 'app+slides',
  tierSummary,
  recommendedRecovery = null,
  systemicReasons = [],
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-fix-test-'));
  const scratch = path.join(dir, 'scratch-app');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'index.html'), '<!doctype html><html><body></body></html>', 'utf8');
  fs.writeFileSync(path.join(dir, 'demo-script.json'), JSON.stringify({
    buildMode,
    steps: buildMode === 'app+slides'
      ? [
          { id: 'wf-app', stepKind: 'app' },
          { id: 'value-summary-slide', stepKind: 'slide' },
        ]
      : [
          { id: 'wf-app', stepKind: 'app' },
        ],
  }), 'utf8');
  const report = {
    iteration: 'build',
    overallScore: 70,
    passThreshold: 80,
    passed: false,
    buildMode,
    tierSummary,
    recommendedRecovery,
    systemicReasons,
    steps: [],
  };
  fs.writeFileSync(path.join(dir, 'qa-report-build.json'), JSON.stringify(report), 'utf8');
  return dir;
}

function tier({
  appPassed = true,
  appFailing = [],
  slidePassed = true,
  slideFailing = [],
  slideSkipped = false,
} = {}) {
  return {
    threshold: 80,
    app: {
      passed: appPassed,
      skipped: false,
      stepCount: 1,
      stepIds: ['wf-app'],
      failingStepIds: appFailing,
      criticalStepIds: [],
      minScore: appPassed ? 95 : 60,
      avgScore: appPassed ? 95 : 60,
    },
    slide: {
      passed: slidePassed,
      skipped: slideSkipped,
      stepCount: slideSkipped ? 0 : 1,
      stepIds: slideSkipped ? [] : ['value-summary-slide'],
      failingStepIds: slideFailing,
      criticalStepIds: [],
      minScore: slidePassed ? 90 : 40,
      avgScore: slidePassed ? 90 : 40,
    },
  };
}

// ── slide-fix gating ───────────────────────────────────────────────────────

describe('slide-fix gating', () => {
  test('skips on app-only build mode', async () => {
    const dir = makeRunDir({
      buildMode: 'app-only',
      tierSummary: tier({ appPassed: true, slideSkipped: true }),
    });
    const out = await slideFix.main({ runDir: dir, maxIterations: 1, emitAgentTask: false });
    assert.equal(out.skipped, true);
    const sentinel = JSON.parse(fs.readFileSync(path.join(dir, 'slide-fix-report.json'), 'utf8'));
    assert.equal(sentinel.reason, 'buildMode_not_app_plus_slides');
  });

  test('skips when slide tier already passed', async () => {
    const dir = makeRunDir({
      buildMode: 'app+slides',
      tierSummary: tier({ appPassed: true, slidePassed: true }),
    });
    const out = await slideFix.main({ runDir: dir, maxIterations: 1, emitAgentTask: false });
    assert.equal(out.skipped, true);
    assert.equal(out.slidePassed, true);
  });

  test('skips when app tier has not passed (refuse to fix slides on top of broken app)', async () => {
    const dir = makeRunDir({
      buildMode: 'app+slides',
      tierSummary: tier({ appPassed: false, appFailing: ['wf-app'], slidePassed: false, slideFailing: ['value-summary-slide'] }),
    });
    const out = await slideFix.main({ runDir: dir, maxIterations: 1, emitAgentTask: false });
    assert.equal(out.skipped, true);
    const sentinel = JSON.parse(fs.readFileSync(path.join(dir, 'slide-fix-report.json'), 'utf8'));
    assert.equal(sentinel.reason, 'app_tier_failed');
  });

  test('skips when slide step count is zero', async () => {
    const dir = makeRunDir({
      buildMode: 'app+slides',
      tierSummary: {
        ...tier({ appPassed: true, slidePassed: true }),
        slide: { passed: true, skipped: false, stepCount: 0, stepIds: [], failingStepIds: [], criticalStepIds: [], minScore: null, avgScore: null },
      },
    });
    const out = await slideFix.main({ runDir: dir, maxIterations: 1, emitAgentTask: false });
    assert.equal(out.skipped, true);
  });
});

// ── app-touchup gating ─────────────────────────────────────────────────────

describe('app-touchup gating', () => {
  test('skips when app tier already passed', async () => {
    const dir = makeRunDir({
      buildMode: 'app-only',
      tierSummary: tier({ appPassed: true, slideSkipped: true }),
    });
    const out = await appTouchup.main({ runDir: dir, maxIterations: 1, emitAgentTask: false });
    assert.equal(out.skipped, true);
    assert.equal(out.appPassed, true);
  });

  test('skips when tierSummary missing', async () => {
    const dir = makeRunDir({ tierSummary: null });
    const out = await appTouchup.main({ runDir: dir, maxIterations: 1, emitAgentTask: false });
    assert.equal(out.skipped, true);
    const sentinel = JSON.parse(fs.readFileSync(path.join(dir, 'app-touchup-report.json'), 'utf8'));
    assert.equal(sentinel.reason, 'no_tier_summary');
  });
});

// ── stripSlideRoots whitelist behavior ─────────────────────────────────────

describe('stripSlideRoots --steps whitelist', () => {
  test('strips only listed slide ids', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-test-'));
    const scratch = path.join(dir, 'scratch-app');
    fs.mkdirSync(scratch, { recursive: true });
    const html =
      '<!doctype html><html><body>' +
      '<div data-testid="step-wf-app" class="step"><p>App</p></div>' +
      '<div data-testid="step-a-slide" class="step"><div class="slide-root">A</div></div>' +
      '<div data-testid="step-b-slide" class="step"><div class="slide-root">B</div></div>' +
      '<div id="link-events-panel"></div>' +
      '</body></html>';
    fs.writeFileSync(path.join(scratch, 'index.html'), html, 'utf8');
    fs.writeFileSync(path.join(dir, 'demo-script.json'), JSON.stringify({
      steps: [
        { id: 'wf-app', stepKind: 'app' },
        { id: 'a-slide', stepKind: 'slide' },
        { id: 'b-slide', stepKind: 'slide' },
      ],
    }), 'utf8');
    const result = stripper.stripSlideRoots({ runDir: dir, steps: ['a-slide'] });
    assert.deepEqual(result.stripped, ['a-slide']);
    const after = fs.readFileSync(path.join(scratch, 'index.html'), 'utf8');
    const aSlideBlock = after.match(/step-a-slide[\s\S]+?(?=step-b-slide)/)[0];
    assert.ok(/data-slide-pending="true"/.test(aSlideBlock),
      'a-slide should carry data-slide-pending="true"');
    assert.ok(/data-slide-template="T\d+"/.test(aSlideBlock),
      'a-slide placeholder should carry canonical data-slide-template');
    assert.ok(/Slide placeholder/.test(aSlideBlock),
      'a-slide placeholder body text should be present');
    assert.ok(/<div class="slide-root">B<\/div>/.test(after), 'b-slide should not be touched');
  });
});
