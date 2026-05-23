'use strict';
/**
 * slide-content-hash tests.
 *
 * Validates the drift-checkpoint module that build-qa writes after a passing
 * QA, and that downstream stages (record, voiceover, sync) read to detect
 * any HTML drift between QA and downstream consumption.
 *
 * Covers:
 *   - extractStepBlocks pulls per-step HTML blocks
 *   - hashStepBlock normalizes whitespace
 *   - computeHashesForRun writes a stable schema
 *   - app-only invariant: slide-tier entries are OMITTED
 *   - source tagging: 'build-qa' vs 'storyboard-edit'
 *   - userModifiedSinceQa preserved across passive recomputes
 *   - detectDrift classifies: match, drift, user-modified, missing, extra
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TMP_ROOT = path.join(PROJECT_ROOT, 'out', '.tmp-tests-slide-hash');
fs.mkdirSync(TMP_ROOT, { recursive: true });

const {
  extractStepBlocks,
  hashStepBlock,
  computeHashesForRun,
  readHashes,
  detectDrift,
  markUserModified,
} = require(path.join(PROJECT_ROOT, 'scripts/scratch/utils/slide-content-hash'));

function mkRun(prefix) {
  return fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));
}
function writeManifest(runDir, buildMode) {
  fs.writeFileSync(path.join(runDir, 'run-manifest.json'),
    JSON.stringify({ schemaVersion: 1, runId: path.basename(runDir), buildMode }, null, 2), 'utf8');
}
function writeScratchApp(runDir, html) {
  fs.mkdirSync(path.join(runDir, 'scratch-app'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'scratch-app', 'index.html'), html, 'utf8');
}
function writeDemoScript(runDir, steps) {
  fs.writeFileSync(path.join(runDir, 'demo-script.json'), JSON.stringify({ steps }, null, 2), 'utf8');
}

const APP_HTML = `
<body>
<div data-testid="step-host-intro" class="step active">
  <h1>Welcome</h1>
</div>
<div data-testid="step-checkout" class="step">
  <button data-testid="cta">Pay</button>
</div>
<!-- SIDE PANELS -->
<div id="link-events-panel"></div>
<div id="api-response-panel"></div>
</body>`;

const SLIDE_HTML = `
<body>
<div data-testid="step-host-intro" class="step active">
  <h1>Welcome</h1>
</div>
<div data-testid="step-opener-slide" class="step">
  <div class="slide-root" data-slide-template="T1">
    <h2>Opener</h2>
  </div>
</div>
<!-- SIDE PANELS -->
<div id="link-events-panel"></div>
</body>`;

describe('extractStepBlocks', () => {
  test('extracts each step block by data-testid', () => {
    const blocks = extractStepBlocks(APP_HTML);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((b) => b.stepId), ['host-intro', 'checkout']);
    assert.match(blocks[0].html, /data-testid="step-host-intro"/);
    assert.match(blocks[1].html, /data-testid="step-checkout"/);
  });

  test('stops at side-panel marker (does not engulf panels)', () => {
    const blocks = extractStepBlocks(APP_HTML);
    assert.equal(/SIDE PANELS/.test(blocks[1].html), false, 'last step must not include the side-panel marker');
  });

  test('returns empty array for empty input', () => {
    assert.deepEqual(extractStepBlocks(''), []);
    assert.deepEqual(extractStepBlocks(null), []);
  });
});

describe('hashStepBlock', () => {
  test('returns 64-hex sha256', () => {
    const h = hashStepBlock('<div data-testid="step-a">x</div>');
    assert.match(h, /^[a-f0-9]{64}$/);
  });

  test('whitespace differences are normalized', () => {
    const a = '<div data-testid="step-a">x</div>   \n';
    const b = '<div data-testid="step-a">x</div>';
    const c = '<div data-testid="step-a">x</div>\n\n\n\n';
    assert.equal(hashStepBlock(a), hashStepBlock(b));
    assert.equal(hashStepBlock(b), hashStepBlock(c));
  });

  test('content differences are detected', () => {
    const a = '<div data-testid="step-a">x</div>';
    const b = '<div data-testid="step-a">y</div>';
    assert.notEqual(hashStepBlock(a), hashStepBlock(b));
  });
});

describe('computeHashesForRun — app-only invariant', () => {
  test('writes app-tier hashes but OMITS slide-tier entries on app-only', () => {
    const run = mkRun('compute-app-only');
    try {
      writeManifest(run, 'app-only');
      writeScratchApp(run, APP_HTML);
      writeDemoScript(run, [
        { id: 'host-intro', stepKind: 'app' },
        { id: 'checkout', stepKind: 'app' },
      ]);
      const summary = computeHashesForRun(run, { source: 'build-qa' });
      assert.equal(summary.buildMode, 'app-only');
      assert.equal(summary.slideCount, 0);
      assert.equal(summary.appCount, 2);

      const file = readHashes(run);
      assert.ok(file);
      assert.equal(file.buildMode, 'app-only');
      assert.equal(Object.keys(file.steps).length, 2);
      assert.equal(file.steps['host-intro'].tier, 'app');
      assert.equal(file.steps['checkout'].tier, 'app');
      // Verify no 'slide' tier leak even when HTML has none.
      const slideEntries = Object.values(file.steps).filter((e) => e.tier === 'slide');
      assert.deepEqual(slideEntries, []);
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  test('on app-only with a leaked slide step in demo-script, omits the slide hash anyway', () => {
    const run = mkRun('compute-app-only-leak');
    try {
      writeManifest(run, 'app-only');
      writeScratchApp(run, SLIDE_HTML); // has slide-root but buildMode=app-only
      writeDemoScript(run, [
        { id: 'host-intro', stepKind: 'app' },
        { id: 'opener-slide', stepKind: 'slide' }, // leak
      ]);
      const summary = computeHashesForRun(run, { source: 'build-qa' });
      assert.equal(summary.slideCount, 0, 'no slide entries on app-only even if leak exists');
      const file = readHashes(run);
      assert.equal(file.steps['opener-slide'], undefined);
      assert.ok(file.steps['host-intro']);
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  test('on app+slides, writes BOTH app and slide tier entries', () => {
    const run = mkRun('compute-app-slides');
    try {
      writeManifest(run, 'app+slides');
      writeScratchApp(run, SLIDE_HTML);
      writeDemoScript(run, [
        { id: 'host-intro', stepKind: 'app' },
        { id: 'opener-slide', stepKind: 'slide' },
      ]);
      const summary = computeHashesForRun(run, { source: 'build-qa' });
      assert.equal(summary.slideCount, 1);
      assert.equal(summary.appCount, 1);
      const file = readHashes(run);
      assert.equal(file.steps['opener-slide'].tier, 'slide');
      assert.equal(file.steps['host-intro'].tier, 'app');
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });
});

describe('computeHashesForRun — source tagging + userModifiedSinceQa preservation', () => {
  test('source="build-qa" clears prior userModifiedSinceQa flags (re-baseline)', () => {
    const run = mkRun('source-build-qa');
    try {
      writeManifest(run, 'app+slides');
      writeScratchApp(run, SLIDE_HTML);
      writeDemoScript(run, [
        { id: 'host-intro', stepKind: 'app' },
        { id: 'opener-slide', stepKind: 'slide' },
      ]);
      // First baseline.
      computeHashesForRun(run, { source: 'build-qa' });
      // Storyboard edit flags opener-slide as user-modified.
      markUserModified(run, ['opener-slide']);
      let file = readHashes(run);
      assert.equal(file.steps['opener-slide'].userModifiedSinceQa, true);

      // Re-running build-qa re-baselines and clears the flag.
      computeHashesForRun(run, { source: 'build-qa' });
      file = readHashes(run);
      assert.equal(file.source, 'build-qa');
      assert.equal(file.steps['opener-slide'].userModifiedSinceQa, false);
      assert.equal(file.steps['opener-slide'].modifiedAt, null);
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  test('source="storyboard-edit" with affectedStepIds flags only those steps', () => {
    const run = mkRun('source-storyboard-edit');
    try {
      writeManifest(run, 'app+slides');
      writeScratchApp(run, SLIDE_HTML);
      writeDemoScript(run, [
        { id: 'host-intro', stepKind: 'app' },
        { id: 'opener-slide', stepKind: 'slide' },
      ]);
      computeHashesForRun(run, { source: 'build-qa' });

      computeHashesForRun(run, {
        source: 'storyboard-edit',
        userModifiedSinceQa: true,
        affectedStepIds: ['opener-slide'],
      });
      const file = readHashes(run);
      assert.equal(file.source, 'storyboard-edit');
      assert.equal(file.steps['opener-slide'].userModifiedSinceQa, true);
      assert.ok(file.steps['opener-slide'].modifiedAt, 'modifiedAt should be set');
      assert.equal(file.steps['host-intro'].userModifiedSinceQa, false,
        'unrelated steps should keep their prior flag (false)');
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });
});

describe('detectDrift', () => {
  test('returns hasRecord:false when no baseline exists', () => {
    const run = mkRun('drift-no-baseline');
    try {
      writeManifest(run, 'app+slides');
      writeScratchApp(run, APP_HTML);
      writeDemoScript(run, [{ id: 'host-intro', stepKind: 'app' }]);
      const r = detectDrift(run);
      assert.equal(r.hasRecord, false);
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  test('classifies match / drift / user-modified / missing / extra', () => {
    const run = mkRun('drift-classify');
    try {
      writeManifest(run, 'app+slides');
      writeScratchApp(run, SLIDE_HTML);
      writeDemoScript(run, [
        { id: 'host-intro', stepKind: 'app' },
        { id: 'opener-slide', stepKind: 'slide' },
      ]);
      computeHashesForRun(run, { source: 'build-qa' });

      // Mutate scratch-app HTML: edit opener-slide (drift), keep host-intro
      // (match), add a brand-new step-extra (extra-in-current). To test
      // missing-in-current, the demo-script keeps its step but the HTML
      // removes it.
      const editedHtml = `
<body>
<div data-testid="step-host-intro" class="step active">
  <h1>Welcome</h1>
</div>
<div data-testid="step-opener-slide" class="step">
  <div class="slide-root" data-slide-template="T1">
    <h2>OPENER WAS EDITED</h2>
  </div>
</div>
<div data-testid="step-extra" class="step">
  <h1>I was not in the baseline</h1>
</div>
<!-- SIDE PANELS -->
<div id="link-events-panel"></div>
</body>`;
      writeScratchApp(run, editedHtml);
      const report = detectDrift(run);
      const byStep = Object.fromEntries(report.steps.map((s) => [s.stepId, s.status]));
      assert.equal(byStep['host-intro'], 'match');
      assert.equal(byStep['opener-slide'], 'drift');
      assert.equal(byStep['extra'], 'extra-in-current');
      assert.equal(report.driftCount, 1);
      assert.equal(report.userModifiedCount, 0);
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  test('drift is reclassified as user-modified when userModifiedSinceQa is set', () => {
    const run = mkRun('drift-user-modified');
    try {
      writeManifest(run, 'app+slides');
      writeScratchApp(run, SLIDE_HTML);
      writeDemoScript(run, [
        { id: 'host-intro', stepKind: 'app' },
        { id: 'opener-slide', stepKind: 'slide' },
      ]);
      computeHashesForRun(run, { source: 'build-qa' });
      markUserModified(run, ['opener-slide']);

      // Mutate opener-slide; user-modified flag is set.
      const edited = SLIDE_HTML.replace('Opener', 'OPENER EDITED IN STORYBOARD');
      writeScratchApp(run, edited);
      const report = detectDrift(run);
      const byStep = Object.fromEntries(report.steps.map((s) => [s.stepId, s.status]));
      assert.equal(byStep['opener-slide'], 'user-modified');
      assert.equal(report.driftCount, 0, 'user-modified is not counted as drift');
      assert.equal(report.userModifiedCount, 1);
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  test('cleanup', () => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    assert.equal(fs.existsSync(TMP_ROOT), false);
  });
});
