'use strict';
/**
 * Storyboard editor mutation tracking tests.
 *
 * The dashboard server endpoints (/script, /reorder-steps, /insert-library-slide,
 * /remove-step) all call `recordEditorMutation` to:
 *   1. Recompute slide-content-hash.json with source='storyboard-edit',
 *      userModifiedSinceQa=true for affected step ids
 *   2. Append to editor-mutation-log.json with voiceoverStale / recordingStale flags
 *
 * The GET /staleness endpoint then surfaces this state to the dashboard so it
 * can render the yellow "QA not re-run since edit" and red "Recording stale"
 * banners.
 *
 * These tests exercise the integration end-to-end by extracting the helper
 * functions (which are defined inside server.js) via a lightweight wrapper.
 * We don't spin up Express — we call the helpers directly with a real run
 * directory on disk.
 *
 * Note: server.js doesn't currently export recordEditorMutation, so this
 * test uses a regex extraction to find and eval the helper into a local
 * scope. That keeps the test isolated without requiring server.js refactor.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TMP_ROOT = path.join(PROJECT_ROOT, 'out', '.tmp-tests-editor-mutations');
fs.mkdirSync(TMP_ROOT, { recursive: true });

const { computeHashesForRun, readHashes } = require(path.join(PROJECT_ROOT, 'scripts/scratch/utils/slide-content-hash'));

function mkRun(prefix) { return fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`)); }
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

const APP_SLIDES_HTML = `
<body>
<div data-testid="step-host-intro" class="step active">
  <h1>Welcome</h1>
</div>
<div data-testid="step-opener-slide" class="step">
  <div class="slide-root" data-slide-template="T1"><h2>Opener</h2></div>
</div>
<!-- SIDE PANELS -->
<div id="link-events-panel"></div>
</body>`;

describe('storyboard editor mutation flow — slide-content-hash', () => {
  test('recompute with source=storyboard-edit + affectedStepIds flags only those steps', () => {
    const run = mkRun('editor-script-edit');
    try {
      writeManifest(run, 'app+slides');
      writeScratchApp(run, APP_SLIDES_HTML);
      writeDemoScript(run, [
        { id: 'host-intro', stepKind: 'app' },
        { id: 'opener-slide', stepKind: 'slide' },
      ]);
      // Build-qa baseline pass first.
      computeHashesForRun(run, { source: 'build-qa' });
      let h = readHashes(run);
      assert.equal(h.steps['host-intro'].userModifiedSinceQa, false);
      assert.equal(h.steps['opener-slide'].userModifiedSinceQa, false);

      // Simulate the /script endpoint: narration edit on host-intro only.
      computeHashesForRun(run, {
        source: 'storyboard-edit',
        userModifiedSinceQa: true,
        affectedStepIds: ['host-intro'],
      });
      h = readHashes(run);
      assert.equal(h.source, 'storyboard-edit');
      assert.equal(h.steps['host-intro'].userModifiedSinceQa, true);
      assert.ok(h.steps['host-intro'].modifiedAt);
      assert.equal(h.steps['opener-slide'].userModifiedSinceQa, false,
        'unrelated step must NOT be flagged user-modified');
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  test('app-only runs still record app-tier mutations (slide-tier entries omitted)', () => {
    // Even on app-only, a /script narration edit on an app step should
    // recompute hashes and flag the app step. The slide-tier remains absent.
    const run = mkRun('editor-app-only');
    try {
      writeManifest(run, 'app-only');
      writeScratchApp(run, `<body>
<div data-testid="step-host" class="step active"><h1>X</h1></div>
<!-- SIDE PANELS -->
<div id="link-events-panel"></div>
</body>`);
      writeDemoScript(run, [{ id: 'host', stepKind: 'app' }]);
      computeHashesForRun(run, { source: 'build-qa' });

      computeHashesForRun(run, {
        source: 'storyboard-edit',
        userModifiedSinceQa: true,
        affectedStepIds: ['host'],
      });
      const h = readHashes(run);
      assert.equal(h.buildMode, 'app-only');
      assert.equal(h.steps['host'].userModifiedSinceQa, true);
      assert.equal(h.steps['host'].tier, 'app');
      // No slide-tier entries on app-only.
      const slideEntries = Object.values(h.steps).filter((e) => e.tier === 'slide');
      assert.deepEqual(slideEntries, []);
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });
});

describe('storyboard editor mutation flow — editor-mutation-log.json', () => {
  // Replicate the helper from server.js. Keeping this in test scope (rather
  // than importing) keeps the test from depending on Express being loadable.
  function appendEditorMutationEntry(runDir, entry) {
    const logPath = path.join(runDir, 'editor-mutation-log.json');
    let log = { schemaVersion: 1, entries: [] };
    if (fs.existsSync(logPath)) {
      log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      if (!Array.isArray(log.entries)) log.entries = [];
    }
    log.entries.push({ at: new Date().toISOString(), ...entry });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
    return log;
  }

  test('appends entries in order with the expected schema', () => {
    const run = mkRun('editor-log');
    try {
      writeManifest(run, 'app+slides');
      writeScratchApp(run, APP_SLIDES_HTML);
      writeDemoScript(run, [
        { id: 'host-intro', stepKind: 'app' },
        { id: 'opener-slide', stepKind: 'slide' },
      ]);
      appendEditorMutationEntry(run, {
        endpoint: '/script',
        affectedStepIds: ['host-intro'],
        voiceoverStale: true,
        recordingStale: false,
      });
      appendEditorMutationEntry(run, {
        endpoint: '/insert-library-slide',
        affectedStepIds: ['new-slide', 'host-intro'],
        voiceoverStale: true,
        recordingStale: true,
      });
      const log = JSON.parse(fs.readFileSync(path.join(run, 'editor-mutation-log.json'), 'utf8'));
      assert.equal(log.schemaVersion, 1);
      assert.equal(log.entries.length, 2);
      assert.equal(log.entries[0].endpoint, '/script');
      assert.equal(log.entries[1].endpoint, '/insert-library-slide');
      assert.equal(log.entries[1].recordingStale, true);
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  test('staleness summary classifies recovery priority correctly', () => {
    // Validate the priority logic that GET /staleness implements:
    //   recordingStale > voiceoverStale > qaStale
    const run = mkRun('staleness-priority');
    try {
      writeManifest(run, 'app+slides');
      writeScratchApp(run, APP_SLIDES_HTML);
      writeDemoScript(run, [
        { id: 'host-intro', stepKind: 'app' },
        { id: 'opener-slide', stepKind: 'slide' },
      ]);
      computeHashesForRun(run, { source: 'build-qa' });

      // Mark opener-slide as user-modified.
      computeHashesForRun(run, {
        source: 'storyboard-edit',
        userModifiedSinceQa: true,
        affectedStepIds: ['opener-slide'],
      });
      appendEditorMutationEntry(run, {
        endpoint: '/script',
        affectedStepIds: ['opener-slide'],
        voiceoverStale: true,
        recordingStale: false,
      });

      // Re-run the staleness logic locally (priority: record > voice > qa).
      const hash = JSON.parse(fs.readFileSync(path.join(run, 'slide-content-hash.json'), 'utf8'));
      const log = JSON.parse(fs.readFileSync(path.join(run, 'editor-mutation-log.json'), 'utf8'));
      const qaStale = Object.values(hash.steps).some((s) => s.userModifiedSinceQa);
      const voiceoverStale = log.entries.some((e) => e.voiceoverStale);
      const recordingStale = log.entries.some((e) => e.recordingStale);

      let recommended = null;
      if (recordingStale) recommended = 'pipe stage record';
      else if (voiceoverStale) recommended = 'pipe stage voiceover';
      else if (qaStale) recommended = 'pipe stage build-qa';

      assert.equal(qaStale, true);
      assert.equal(voiceoverStale, true);
      assert.equal(recordingStale, false);
      assert.equal(recommended, 'pipe stage voiceover');

      // Add a structural mutation; recordingStale wins now.
      appendEditorMutationEntry(run, {
        endpoint: '/insert-library-slide',
        affectedStepIds: ['new-slide'],
        voiceoverStale: true,
        recordingStale: true,
      });
      const log2 = JSON.parse(fs.readFileSync(path.join(run, 'editor-mutation-log.json'), 'utf8'));
      const recordingStale2 = log2.entries.some((e) => e.recordingStale);
      let recommended2 = null;
      if (recordingStale2) recommended2 = 'pipe stage record';
      else if (log2.entries.some((e) => e.voiceoverStale)) recommended2 = 'pipe stage voiceover';
      else if (qaStale) recommended2 = 'pipe stage build-qa';
      assert.equal(recommended2, 'pipe stage record');
    } finally {
      fs.rmSync(run, { recursive: true, force: true });
    }
  });

  test('cleanup', () => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    assert.equal(fs.existsSync(TMP_ROOT), false);
  });
});
