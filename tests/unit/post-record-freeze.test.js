'use strict';
/**
 * Post-record-freeze sentinel tests.
 *
 * Once record/recording.webm is captured, automated slide-fix / post-slides
 * re-runs would invalidate the recording. The sentinel file at
 * `<runDir>/post-record-freeze.sentinel` blocks those automated runs while
 * the storyboard editor (which passes allowPostRecord) is still allowed to
 * mutate (and flag voiceover/recording stale via separate mechanisms).
 *
 * Covers:
 *   1. post-slides skips with reason="post_record_freeze" when sentinel exists
 *   2. post-slides bypasses freeze when --allow-post-record passed
 *   3. slide-fix skips with reason="post_record_freeze" when sentinel exists
 *   4. slide-fix bypasses freeze when allowPostRecord:true opt passed
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TMP_ROOT = path.join(PROJECT_ROOT, 'out', '.tmp-tests-post-record-freeze');
fs.mkdirSync(TMP_ROOT, { recursive: true });

function mkRun(prefix) { return fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`)); }
function writeManifest(runDir, buildMode) {
  fs.writeFileSync(path.join(runDir, 'run-manifest.json'),
    JSON.stringify({ schemaVersion: 1, runId: path.basename(runDir), buildMode }, null, 2), 'utf8');
}
function writeFreezeSentinel(runDir) {
  fs.writeFileSync(path.join(runDir, 'post-record-freeze.sentinel'),
    JSON.stringify({ schemaVersion: 1, frozenAt: new Date().toISOString() }, null, 2), 'utf8');
}
function writeScratchApp(runDir) {
  fs.mkdirSync(path.join(runDir, 'scratch-app'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'scratch-app', 'index.html'),
    '<html><body><div data-testid="step-x" class="step active">x</div></body></html>', 'utf8');
}
function writeDemoScript(runDir, steps) {
  fs.writeFileSync(path.join(runDir, 'demo-script.json'), JSON.stringify({ steps }, null, 2), 'utf8');
}

describe('post-slides — post-record-freeze sentinel', () => {
  test('skips with reason="post_record_freeze" when sentinel exists', async () => {
    const prev = process.env.PIPELINE_RUN_DIR;
    const run = mkRun('postslides-freeze');
    try {
      writeManifest(run, 'app+slides');
      writeScratchApp(run);
      writeDemoScript(run, [{ id: 'opener-slide', stepKind: 'slide' }]);
      writeFreezeSentinel(run);
      process.env.PIPELINE_RUN_DIR = run;
      // Clear argv overrides to ensure CLI parser doesn't pick up stray args
      const prevArgv = process.argv;
      process.argv = ['node', 'post-slides.js'];
      try {
        delete require.cache[require.resolve(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/post-slides'))];
        const ps = require(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/post-slides'));
        const out = await ps.main();
        assert.equal(out.skipped, true);
        assert.equal(out.reason, 'post_record_freeze');
        assert.match(out.recoveryHint || '', /pipe stage record/);
      } finally {
        process.argv = prevArgv;
      }
    } finally {
      process.env.PIPELINE_RUN_DIR = prev;
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  test('bypasses freeze when --allow-post-record CLI flag is present', async () => {
    const prev = process.env.PIPELINE_RUN_DIR;
    const run = mkRun('postslides-allow');
    try {
      writeManifest(run, 'app+slides');
      writeScratchApp(run);
      writeDemoScript(run, [{ id: 'opener-slide', stepKind: 'slide' }]);
      writeFreezeSentinel(run);
      process.env.PIPELINE_RUN_DIR = run;
      const prevArgv = process.argv;
      process.argv = ['node', 'post-slides.js', '--allow-post-record', '--dry-run'];
      try {
        delete require.cache[require.resolve(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/post-slides'))];
        const ps = require(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/post-slides'));
        const out = await ps.main();
        // With bypass, main() does NOT short-circuit on freeze. It may still
        // skip for other reasons (dry-run, no slide steps), but it must not
        // return reason="post_record_freeze".
        assert.notEqual(out && out.reason, 'post_record_freeze');
      } finally {
        process.argv = prevArgv;
      }
    } finally {
      process.env.PIPELINE_RUN_DIR = prev;
      fs.rmSync(run, { recursive: true, force: true });
    }
  });
});

describe('slide-fix — post-record-freeze sentinel', () => {
  test('skips with reason="post_record_freeze" when sentinel exists', async () => {
    const prev = process.env.PIPELINE_RUN_DIR;
    const run = mkRun('slidefix-freeze');
    try {
      writeManifest(run, 'app+slides');
      writeFreezeSentinel(run);
      fs.writeFileSync(path.join(run, 'qa-report-build.json'), JSON.stringify({
        buildMode: 'app+slides',
        tierSummary: {
          threshold: 80,
          app: { passed: true, skipped: false, stepCount: 1, failingStepIds: [] },
          slide: { passed: false, skipped: false, stepCount: 1, failingStepIds: ['opener-slide'] },
        },
      }, null, 2));
      process.env.PIPELINE_RUN_DIR = run;
      delete require.cache[require.resolve(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/slide-fix'))];
      const sf = require(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/slide-fix'));
      const out = await sf.main({ runDir: run });
      assert.equal(out.skipped, true);
      // Sentinel is in slide-fix-report.json
      const sentinel = JSON.parse(fs.readFileSync(path.join(run, 'slide-fix-report.json'), 'utf8'));
      assert.equal(sentinel.skipped, true);
      assert.equal(sentinel.reason, 'post_record_freeze');
      assert.match(sentinel.recoveryHint || '', /pipe stage record/);
    } finally {
      process.env.PIPELINE_RUN_DIR = prev;
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  test('bypasses freeze when opts.allowPostRecord:true is passed', async () => {
    const prev = process.env.PIPELINE_RUN_DIR;
    const run = mkRun('slidefix-allow');
    try {
      writeManifest(run, 'app+slides');
      writeFreezeSentinel(run);
      // slide tier already passes so we don't actually iterate; the test
      // only verifies the freeze guard is bypassed.
      fs.writeFileSync(path.join(run, 'qa-report-build.json'), JSON.stringify({
        buildMode: 'app+slides',
        tierSummary: {
          threshold: 80,
          app: { passed: true, skipped: false, stepCount: 1, failingStepIds: [] },
          slide: { passed: true, skipped: false, stepCount: 1, failingStepIds: [] },
        },
      }, null, 2));
      process.env.PIPELINE_RUN_DIR = run;
      delete require.cache[require.resolve(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/slide-fix'))];
      const sf = require(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/slide-fix'));
      const out = await sf.main({ runDir: run, allowPostRecord: true });
      // With bypass, slide_tier_already_passed reason is returned (not
      // post_record_freeze).
      const sentinel = JSON.parse(fs.readFileSync(path.join(run, 'slide-fix-report.json'), 'utf8'));
      assert.notEqual(sentinel.reason, 'post_record_freeze');
      assert.equal(out.skipped, true);
    } finally {
      process.env.PIPELINE_RUN_DIR = prev;
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  test('cleanup', () => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    assert.equal(fs.existsSync(TMP_ROOT), false);
  });
});
