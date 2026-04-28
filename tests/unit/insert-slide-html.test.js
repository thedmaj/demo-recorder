'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  spliceLibrarySlideIntoRunHtml,
  removeStepBlockFromHtml,
  removeStepBlockFromRunHtml,
} = require(
  path.join(__dirname, '../../scripts/dashboard/utils/insert-slide-html')
);

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SLIDE_LIBRARY_DIR = path.join(PROJECT_ROOT, 'out', 'slide-library');
const SLIDE_LIBRARY_SLIDES_DIR = path.join(SLIDE_LIBRARY_DIR, 'slides');

// Build a fake run dir + a fake library slide on disk inside the canonical
// out/slide-library directory (the splice helper enforces a path-traversal
// guard against that).
function makeFixture(runName, slideName, slideHtml, indexHtml) {
  const runDir = path.join(PROJECT_ROOT, 'out', 'demos', runName);
  fs.mkdirSync(path.join(runDir, 'scratch-app'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'scratch-app', 'index.html'), indexHtml);

  const slideDir = path.join(SLIDE_LIBRARY_SLIDES_DIR, slideName);
  fs.mkdirSync(slideDir, { recursive: true });
  const slideHtmlAbs = path.join(slideDir, 'index.html');
  fs.writeFileSync(slideHtmlAbs, slideHtml);
  const htmlPath = path.relative(PROJECT_ROOT, slideHtmlAbs);

  return {
    runDir,
    slide: { id: slideName, name: slideName, htmlPath },
    cleanup: () => {
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(slideDir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

// ─── Happy path ─────────────────────────────────────────────────────────────

describe('spliceLibrarySlideIntoRunHtml — happy path', () => {
  test('appends slide HTML before SIDE PANELS marker and writes file', () => {
    const fx = makeFixture(
      'splice-test-' + Date.now(),
      'slide-' + Date.now(),
      `<div class="slide-root">Slide content</div>`,
      `<!doctype html><html><body>
<div data-testid="step-home" class="step active">Home</div>
<!-- SIDE PANELS -->
<div id="api-response-panel" style="display:none"></div>
</body></html>`
    );
    try {
      const out = spliceLibrarySlideIntoRunHtml(fx.runDir, 'new-slide-step', fx.slide);
      assert.equal(out.applied, true);
      assert.equal(out.skipped, false);
      // Splice helper picked the side-panels marker as insertion point:
      assert.match(out.reason, /side-panels|step-block/);
      // File on disk reflects the change:
      const writtenHtml = fs.readFileSync(path.join(fx.runDir, 'scratch-app', 'index.html'), 'utf8');
      assert.match(writtenHtml, /data-testid="step-new-slide-step"/);
      assert.match(writtenHtml, /Slide content/);
      // Original step still present:
      assert.match(writtenHtml, /data-testid="step-home"/);
    } finally {
      fx.cleanup();
    }
  });

  test('replaces an existing step block when one is already in the HTML', () => {
    const fx = makeFixture(
      'splice-replace-' + Date.now(),
      'slide-replace-' + Date.now(),
      `<div data-testid="step-target" class="slide-root">NEW content</div>`,
      `<!doctype html><html><body>
<div data-testid="step-target" class="step">OLD content</div>
<!-- SIDE PANELS -->
</body></html>`
    );
    try {
      const out = spliceLibrarySlideIntoRunHtml(fx.runDir, 'target', fx.slide);
      assert.equal(out.applied, true);
      const writtenHtml = fs.readFileSync(path.join(fx.runDir, 'scratch-app', 'index.html'), 'utf8');
      assert.match(writtenHtml, /NEW content/);
      assert.doesNotMatch(writtenHtml, /OLD content/);
    } finally {
      fx.cleanup();
    }
  });

  test('mirrors to artifacts/build/scratch-app/index.html when both exist', () => {
    const runName = 'splice-mirror-' + Date.now();
    const slideName = 'slide-mirror-' + Date.now();
    const fx = makeFixture(
      runName,
      slideName,
      `<div class="slide-root">M</div>`,
      `<!doctype html><html><body>
<div data-testid="step-home" class="step">home</div>
<!-- SIDE PANELS -->
</body></html>`
    );
    // Also write the canonical artifacts path:
    const canonicalPath = path.join(fx.runDir, 'artifacts', 'build', 'scratch-app', 'index.html');
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, fs.readFileSync(path.join(fx.runDir, 'scratch-app', 'index.html'), 'utf8'));
    try {
      const out = spliceLibrarySlideIntoRunHtml(fx.runDir, 'mirror-step', fx.slide);
      assert.equal(out.applied, true);
      assert.ok(out.mirrorPath, 'mirrorPath set when canonical exists');
      const mirrorHtml = fs.readFileSync(canonicalPath, 'utf8');
      assert.match(mirrorHtml, /data-testid="step-mirror-step"/);
    } finally {
      fx.cleanup();
    }
  });
});

// ─── Skip / error paths (helper never throws) ───────────────────────────────

describe('spliceLibrarySlideIntoRunHtml — skip paths', () => {
  test('returns skipped when slide has no htmlPath', () => {
    const out = spliceLibrarySlideIntoRunHtml('/tmp', 'step', { id: 'x' });
    assert.equal(out.applied, false);
    assert.equal(out.skipped, true);
    assert.match(out.skippedReason, /no-htmlpath/);
  });

  test('returns skipped when slide htmlPath is outside the slide library dir', () => {
    const out = spliceLibrarySlideIntoRunHtml('/tmp', 'step', {
      id: 'evil',
      htmlPath: 'inputs/some-other-place/index.html',
    });
    assert.equal(out.applied, false);
    assert.equal(out.skipped, true);
    assert.match(out.skippedReason, /outside-library-dir/);
  });

  test('returns skipped when slide HTML file is missing on disk', () => {
    const out = spliceLibrarySlideIntoRunHtml('/tmp', 'step', {
      id: 'missing',
      htmlPath: 'out/slide-library/slides/nonexistent/index.html',
    });
    assert.equal(out.applied, false);
    assert.equal(out.skipped, true);
    assert.match(out.skippedReason, /slide-html-missing/);
  });

  test('returns skipped when run has no index.html in either layout', () => {
    const slideDir = path.join(SLIDE_LIBRARY_SLIDES_DIR, 'no-rundir-slide-' + Date.now());
    fs.mkdirSync(slideDir, { recursive: true });
    fs.writeFileSync(path.join(slideDir, 'index.html'), '<div class="slide-root">x</div>');
    try {
      const out = spliceLibrarySlideIntoRunHtml('/tmp/no-such-run-dir', 'step', {
        id: 'x',
        htmlPath: path.relative(PROJECT_ROOT, path.join(slideDir, 'index.html')),
      });
      assert.equal(out.applied, false);
      assert.equal(out.skipped, true);
      assert.match(out.skippedReason, /no-index-html-in-run/);
    } finally {
      try { fs.rmSync(slideDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('returns skipped when called with missing args', () => {
    assert.equal(spliceLibrarySlideIntoRunHtml(null, 'step', {}).skipped, true);
    assert.equal(spliceLibrarySlideIntoRunHtml('/tmp', '', {}).skipped, true);
    assert.equal(spliceLibrarySlideIntoRunHtml('/tmp', 'step', null).skipped, true);
  });
});

// ─── removeStepBlockFromHtml — pure helper ──────────────────────────────────

describe('removeStepBlockFromHtml', () => {
  test('strips the targeted step div and leaves the rest intact', () => {
    const html =
      '<html><body>' +
      '<div data-testid="step-a" class="step">A</div>' +
      '<div data-testid="step-b" class="slide-root">B (slide)</div>' +
      '<div data-testid="step-c" class="step">C</div>' +
      '<!-- SIDE PANELS --></body></html>';
    const out = removeStepBlockFromHtml(html, 'b');
    assert.equal(out.removed, true);
    assert.equal(out.reason, 'step-block-removed');
    assert.match(out.html, /data-testid="step-a"/);
    assert.match(out.html, /data-testid="step-c"/);
    assert.doesNotMatch(out.html, /data-testid="step-b"/);
    assert.doesNotMatch(out.html, /B \(slide\)/);
  });

  test('handles the LAST step (no closing sentinel before </body>)', () => {
    const html =
      '<html><body>' +
      '<div data-testid="step-a" class="step">A</div>' +
      '<div data-testid="step-final" class="slide-root">final</div>' +
      '</body></html>';
    const out = removeStepBlockFromHtml(html, 'final');
    assert.equal(out.removed, true);
    assert.doesNotMatch(out.html, /data-testid="step-final"/);
    assert.match(out.html, /data-testid="step-a"/);
  });

  test('returns removed=false when stepId is not present', () => {
    const html = '<div data-testid="step-a">a</div>';
    const out = removeStepBlockFromHtml(html, 'nonexistent');
    assert.equal(out.removed, false);
    assert.equal(out.reason, 'step-block-not-found');
    assert.equal(out.html, html);
  });

  test('escapes regex special characters in stepId', () => {
    const html =
      '<div data-testid="step-with.dots+plus" class="slide-root">danger</div>' +
      '<!-- SIDE PANELS -->';
    const out = removeStepBlockFromHtml(html, 'with.dots+plus');
    assert.equal(out.removed, true);
    assert.doesNotMatch(out.html, /data-testid="step-with\.dots\+plus"/);
  });

  test('handles malformed input gracefully (no throw)', () => {
    assert.deepEqual(removeStepBlockFromHtml(null, 'a'), { html: null, removed: false, reason: 'empty-input' });
    assert.deepEqual(removeStepBlockFromHtml('', 'a'), { html: '', removed: false, reason: 'empty-input' });
    assert.deepEqual(removeStepBlockFromHtml('<div/>', '').reason, 'no-stepid');
    assert.deepEqual(removeStepBlockFromHtml('<div/>', null).reason, 'no-stepid');
  });

  test('collapses ragged blank lines after the strip', () => {
    const html =
      '<div data-testid="step-a">A</div>\n\n\n\n\n' +
      '<div data-testid="step-b">B</div>';
    const out = removeStepBlockFromHtml(html, 'a');
    // No more than 2 consecutive newlines should remain:
    assert.doesNotMatch(out.html, /\n{3,}/);
  });
});

// ─── removeStepBlockFromRunHtml — disk integration ──────────────────────────

describe('removeStepBlockFromRunHtml', () => {
  test('removes the step from both legacy and canonical index.html when both exist', () => {
    const runDir = path.join(PROJECT_ROOT, 'out', 'demos', 'remove-test-' + Date.now());
    const legacy = path.join(runDir, 'scratch-app', 'index.html');
    const canonical = path.join(runDir, 'artifacts', 'build', 'scratch-app', 'index.html');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    const baseHtml =
      '<html><body>' +
      '<div data-testid="step-home" class="step">home</div>' +
      '<div data-testid="step-slide-x" class="slide-root">slide-x</div>' +
      '<!-- SIDE PANELS --></body></html>';
    fs.writeFileSync(legacy, baseHtml);
    fs.writeFileSync(canonical, baseHtml);
    try {
      const out = removeStepBlockFromRunHtml(runDir, 'slide-x');
      assert.equal(out.skipped, false);
      assert.equal(out.removedFrom.length, 2);
      // Disk reflects the change in BOTH files:
      assert.doesNotMatch(fs.readFileSync(legacy, 'utf8'), /data-testid="step-slide-x"/);
      assert.doesNotMatch(fs.readFileSync(canonical, 'utf8'), /data-testid="step-slide-x"/);
    } finally {
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('returns notFoundIn entries when the step is not in a given file (idempotent re-run)', () => {
    const runDir = path.join(PROJECT_ROOT, 'out', 'demos', 'remove-idem-' + Date.now());
    const legacy = path.join(runDir, 'scratch-app', 'index.html');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '<html><body><div data-testid="step-home">home</div></body></html>');
    try {
      const out = removeStepBlockFromRunHtml(runDir, 'nonexistent-step');
      assert.equal(out.skipped, false);
      assert.equal(out.removedFrom.length, 0);
      assert.equal(out.notFoundIn.length, 1);
    } finally {
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('returns skipped when the run dir has no index.html', () => {
    const runDir = path.join(PROJECT_ROOT, 'out', 'demos', 'remove-empty-' + Date.now());
    fs.mkdirSync(runDir, { recursive: true });
    try {
      const out = removeStepBlockFromRunHtml(runDir, 'whatever');
      assert.equal(out.skipped, true);
      assert.equal(out.skippedReason, 'no-index-html');
    } finally {
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test('returns skipped on missing args', () => {
    assert.equal(removeStepBlockFromRunHtml(null, 'a').skipped, true);
    assert.equal(removeStepBlockFromRunHtml('/tmp', '').skipped, true);
  });
});
