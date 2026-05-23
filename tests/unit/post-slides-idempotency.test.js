'use strict';
/**
 * post-slides idempotency tests.
 *
 * post-slides.main() is invoked TWICE in the orchestrator on app+slides runs:
 *   1. Inline (inside the build phase loop, before build-qa, so QA sees real slides)
 *   2. Canonical (after the build phase loop, as a standalone stage)
 *
 * The second invocation must be a NO-OP when every slide step already has a
 * `.slide-root` block, otherwise the LLM rolls a different slide on each run
 * and downstream stages (recording, voiceover) see different visuals than
 * build-qa scored.
 *
 * These tests lock in the idempotency guard so a future refactor doesn't
 * accidentally re-LLM slides on the canonical pass.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TMP_ROOT = path.join(PROJECT_ROOT, 'out', '.tmp-tests-postslides-idempotent');
fs.mkdirSync(TMP_ROOT, { recursive: true });

function mkRun(prefix) { return fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`)); }
function writeManifest(runDir, buildMode) {
  fs.writeFileSync(path.join(runDir, 'run-manifest.json'),
    JSON.stringify({ schemaVersion: 1, runId: path.basename(runDir), buildMode }, null, 2), 'utf8');
}

describe('post-slides idempotency — second invocation is a noop', () => {
  test('returns noop:true when every slide step already has .slide-root', async () => {
    const prev = process.env.PIPELINE_RUN_DIR;
    const run = mkRun('postslides-noop');
    try {
      writeManifest(run, 'app+slides');
      fs.mkdirSync(path.join(run, 'scratch-app'), { recursive: true });
      // Slide block has .slide-root already — the canonical 2nd run should
      // see this and return without LLM-rolling a different slide.
      fs.writeFileSync(path.join(run, 'scratch-app', 'index.html'), `
<body>
<div data-testid="step-host-intro" class="step active">app</div>
<div data-testid="step-opener-slide" class="step">
  <div class="slide-root" data-slide-template="T1"><h2>Opener already rendered</h2></div>
</div>
<!-- SIDE PANELS -->
<div id="link-events-panel"></div>
</body>`, 'utf8');
      fs.writeFileSync(path.join(run, 'demo-script.json'), JSON.stringify({
        steps: [
          { id: 'host-intro', stepKind: 'app' },
          { id: 'opener-slide', stepKind: 'slide' },
        ],
      }, null, 2), 'utf8');

      process.env.PIPELINE_RUN_DIR = run;
      const prevArgv = process.argv;
      process.argv = ['node', 'post-slides.js'];
      try {
        delete require.cache[require.resolve(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/post-slides'))];
        const ps = require(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/post-slides'));
        await ps.main();

        const report = JSON.parse(fs.readFileSync(path.join(run, 'post-slides-report.json'), 'utf8'));
        assert.equal(report.noop, true,
          'when all slide steps already have .slide-root, post-slides must noop without LLM call');
        assert.equal((report.slidesProcessed || []).length, 0,
          'no slides should be processed on the noop run');
      } finally {
        process.argv = prevArgv;
      }
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
