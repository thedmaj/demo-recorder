'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spliceLibrarySlideIntoRunHtml } = require(
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
