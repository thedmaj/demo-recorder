'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  spliceLibrarySlideIntoRunHtml,
  rewirePreviousStepCta,
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

  test('also strips the matching POST-SLIDES STYLES block from <head>', () => {
    const html =
      '<html><head><title>App</title>' +
      '<!-- POST-SLIDES STYLES: slide-x -->\n' +
      '<style>:where([data-testid="step-slide-x"]) .a {color:red}</style>\n' +
      '<!-- /POST-SLIDES STYLES: slide-x -->' +
      '</head><body>' +
      '<div data-testid="step-home" class="step">home</div>' +
      '<div data-testid="step-slide-x" class="step slide-root">slide</div>' +
      '<!-- SIDE PANELS --></body></html>';
    const out = removeStepBlockFromHtml(html, 'slide-x');
    assert.equal(out.removed, true);
    assert.equal(out.reason, 'step-block-and-styles-removed');
    // BOTH the body div AND the head styles block are gone:
    assert.doesNotMatch(out.html, /data-testid="step-slide-x"/);
    assert.doesNotMatch(out.html, /POST-SLIDES STYLES: slide-x/);
    // Other content untouched:
    assert.match(out.html, /data-testid="step-home"/);
  });

  test('strips an orphaned POST-SLIDES STYLES block even when the slide div is already gone', () => {
    // This is the exact scenario that caused the host formatting bleed: a
    // slide was removed from the body via an earlier (buggy) flow, but its
    // unscoped CSS lingered in <head> and kept overriding the host's layout.
    const html =
      '<html><head>' +
      '<!-- POST-SLIDES STYLES: orphan -->\n' +
      '<style>* {margin:0}</style>\n' +
      '<!-- /POST-SLIDES STYLES: orphan -->' +
      '</head><body><div data-testid="step-home" class="step">home</div></body></html>';
    const out = removeStepBlockFromHtml(html, 'orphan');
    assert.equal(out.removed, true);
    assert.equal(out.reason, 'styles-only-removed');
    assert.doesNotMatch(out.html, /POST-SLIDES STYLES: orphan/);
    assert.match(out.html, /data-testid="step-home"/);
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

// ─── rewirePreviousStepCta — pure helper ────────────────────────────────────

describe('rewirePreviousStepCta', () => {
  test('rewrites the primary CTA to point at the slide step', () => {
    const html =
      '<html><body>' +
      '<div data-testid="step-home" class="step active">' +
      '<button class="btn btn-primary" data-testid="get-started" onclick="window.goToStep(\'next-real\')">Get started</button>' +
      '</div>' +
      '<div data-testid="step-next-real" class="step">next</div>' +
      '<!-- SIDE PANELS --></body></html>';
    const out = rewirePreviousStepCta(html, 'home', 'inserted-slide');
    assert.equal(out.rewired, true);
    assert.equal(out.previousTarget, 'next-real');
    assert.match(out.html, /goToStep\('inserted-slide'\)/);
    assert.doesNotMatch(out.html, /goToStep\('next-real'\)/);
    // Other parts of the HTML untouched:
    assert.match(out.html, /data-testid="step-next-real"/);
  });

  test('prefers btn-primary over a plain button when both have goToStep', () => {
    const html =
      '<div data-testid="step-home" class="step">' +
      '<button class="btn" onclick="window.goToStep(\'plain-target\')">Plain</button>' +
      '<button class="btn btn-primary" onclick="window.goToStep(\'primary-target\')">Primary</button>' +
      '</div>' +
      '<!-- SIDE PANELS -->';
    const out = rewirePreviousStepCta(html, 'home', 'slide');
    assert.equal(out.rewired, true);
    assert.equal(out.previousTarget, 'primary-target');
    // Only the primary CTA was rewired:
    assert.match(out.html, /goToStep\('plain-target'\)/);
    assert.match(out.html, /goToStep\('slide'\)/);
    assert.doesNotMatch(out.html, /goToStep\('primary-target'\)/);
  });

  test('falls back to a clickable card when no buttons match', () => {
    const html =
      '<div data-testid="step-home" class="step">' +
      '<div class="card" onclick="window.goToStep(\'card-target\')">click me</div>' +
      '</div>' +
      '<!-- SIDE PANELS -->';
    const out = rewirePreviousStepCta(html, 'home', 'slide');
    assert.equal(out.rewired, true);
    assert.equal(out.previousTarget, 'card-target');
    assert.match(out.html, /goToStep\('slide'\)/);
    assert.match(out.reason, /card/);
  });

  test('returns rewired=false when prev step is not present', () => {
    const html = '<div data-testid="step-other" class="step">x</div>';
    const out = rewirePreviousStepCta(html, 'missing', 'slide');
    assert.equal(out.rewired, false);
    assert.equal(out.reason, 'prev-step-not-found');
  });

  test('returns rewired=false when CTA already points at the slide (idempotent)', () => {
    const html =
      '<div data-testid="step-home" class="step">' +
      '<button class="btn btn-primary" onclick="window.goToStep(\'slide-id\')">Continue</button>' +
      '</div>' +
      '<!-- SIDE PANELS -->';
    const out = rewirePreviousStepCta(html, 'home', 'slide-id');
    assert.equal(out.rewired, false);
    assert.equal(out.reason, 'already-points-at-slide');
  });

  test('returns rewired=false when previous step has no goToStep CTA', () => {
    const html =
      '<div data-testid="step-home" class="step">' +
      '<button class="btn">Inert</button>' +
      '</div>' +
      '<!-- SIDE PANELS -->';
    const out = rewirePreviousStepCta(html, 'home', 'slide');
    assert.equal(out.rewired, false);
    assert.equal(out.reason, 'no-cta-found');
  });

  test('handles malformed input gracefully', () => {
    assert.equal(rewirePreviousStepCta(null, 'a', 'b').rewired, false);
    assert.equal(rewirePreviousStepCta('<div/>', '', 'b').rewired, false);
    assert.equal(rewirePreviousStepCta('<div/>', 'a', '').rewired, false);
  });
});

// ─── spliceLibrarySlideIntoRunHtml — insertAfterId & styles preservation ────

describe('spliceLibrarySlideIntoRunHtml — DOM ordering, styles, CTA rewire', () => {
  test('preserves slide <style> blocks by injecting them into the host <head>', () => {
    const slideHtml =
      '<!doctype html><html><head>' +
      '<style>.insight-layout{background:#0d1117;color:#fff}</style>' +
      '<title>Slide</title>' +
      '</head><body>' +
      '<div data-testid="step-original" class="step slide-root"><div class="insight-layout">CONTENT</div></div>' +
      '</body></html>';
    const indexHtml =
      '<!doctype html><html><head><title>App</title><style>.host{display:block}</style></head><body>' +
      '<div data-testid="step-home" class="step active"><button class="btn btn-primary" onclick="window.goToStep(\'old-next\')">Continue</button></div>' +
      '<div data-testid="step-old-next" class="step">next</div>' +
      '<!-- SIDE PANELS -->' +
      '</body></html>';
    const fx = makeFixture(
      'splice-styles-' + Date.now(),
      'slide-styles-' + Date.now(),
      slideHtml,
      indexHtml
    );
    try {
      const out = spliceLibrarySlideIntoRunHtml(fx.runDir, 'inserted-slide', fx.slide, { insertAfterId: 'home' });
      assert.equal(out.applied, true);
      assert.equal(out.stylesInjected, 1);
      assert.equal(out.ctaRewired, true);

      const written = fs.readFileSync(path.join(fx.runDir, 'scratch-app', 'index.html'), 'utf8');
      // Slide CSS now lives in the head, SCOPED to the slide subtree so it
      // never bleeds into the host:
      assert.match(written, /POST-SLIDES STYLES: inserted-slide/);
      assert.match(
        written,
        /:where\(\[data-testid="step-inserted-slide"\]\) \.insight-layout\s*\{background:#0d1117/
      );
      // Host's own CSS rules are still intact (untouched by the slide CSS):
      assert.match(written, /\.host\s*\{display:block\}/);
      // Stray <title>/<meta> from the slide head did NOT leak into the body:
      const bodyOnly = written.split('</head>')[1] || '';
      assert.doesNotMatch(bodyOnly, /<title[\s>]/i);
      // Outer slide div has the user-picked stepId AND no duplicate attributes
      // on the actual element (count only attribute occurrences inside <div>
      // tags — the data-testid string also appears in the scoped CSS prefix
      // `:where([data-testid="step-..."])`, which is correct, not a dupe):
      const slideOpenMatch = written.match(/<div[^>]*\bdata-testid="step-inserted-slide"[^>]*>/);
      assert.ok(slideOpenMatch, 'slide opening div should have the new step id');
      const dupesOnDiv = (slideOpenMatch[0].match(/data-testid="step-inserted-slide"/g) || []).length;
      assert.equal(dupesOnDiv, 1, 'no duplicate data-testid attribute on the slide div');
      // The slide-root class survived (NOT clobbered by a duplicate class attr):
      assert.match(slideOpenMatch[0], /class="[^"]*\bslide-root\b/);
      assert.match(slideOpenMatch[0], /class="[^"]*\bstep\b/);
      // Previous step's CTA now points at the slide, not at old-next:
      assert.match(written, /goToStep\('inserted-slide'\)/);
      assert.doesNotMatch(written, /goToStep\('old-next'\)/);
    } finally {
      fx.cleanup();
    }
  });

  test('splices slide RIGHT AFTER the insertAfterId step in DOM order', () => {
    const fx = makeFixture(
      'splice-domorder-' + Date.now(),
      'slide-domorder-' + Date.now(),
      '<div class="slide-root">SLIDE</div>',
      '<!doctype html><html><head></head><body>' +
        '<div data-testid="step-a" class="step">A</div>' +
        '<div data-testid="step-b" class="step">B</div>' +
        '<div data-testid="step-c" class="step">C</div>' +
        '<!-- SIDE PANELS --></body></html>'
    );
    try {
      const out = spliceLibrarySlideIntoRunHtml(fx.runDir, 'mid-slide', fx.slide, { insertAfterId: 'b' });
      assert.equal(out.applied, true);
      assert.match(out.reason, /inserted-after-prev-step/);

      const written = fs.readFileSync(path.join(fx.runDir, 'scratch-app', 'index.html'), 'utf8');
      const orderRe = /data-testid="step-(a|b|c|mid-slide)"/g;
      const order = [];
      let m;
      while ((m = orderRe.exec(written)) !== null) order.push(m[1]);
      assert.deepEqual(order, ['a', 'b', 'mid-slide', 'c']);
    } finally {
      fx.cleanup();
    }
  });

  test('falls back to side-panels append when insertAfterId step is missing', () => {
    const fx = makeFixture(
      'splice-fallback-' + Date.now(),
      'slide-fallback-' + Date.now(),
      '<div class="slide-root">x</div>',
      '<!doctype html><html><body>' +
        '<div data-testid="step-only" class="step">only</div>' +
        '<!-- SIDE PANELS --></body></html>'
    );
    try {
      const out = spliceLibrarySlideIntoRunHtml(fx.runDir, 'orphan-slide', fx.slide, { insertAfterId: 'nonexistent' });
      assert.equal(out.applied, true);
      assert.match(out.reason, /side-panels|inserted-after/);
    } finally {
      fx.cleanup();
    }
  });

  test('idempotent re-insert: does not stack duplicate <style> nodes', () => {
    const slideHtml =
      '<html><head><style>.x{color:red}</style></head><body>' +
      '<div class="slide-root">v1</div></body></html>';
    const fx = makeFixture(
      'splice-idem-' + Date.now(),
      'slide-idem-' + Date.now(),
      slideHtml,
      '<!doctype html><html><head></head><body>' +
        '<div data-testid="step-home" class="step">home</div>' +
        '<!-- SIDE PANELS --></body></html>'
    );
    try {
      spliceLibrarySlideIntoRunHtml(fx.runDir, 'reinsert-slide', fx.slide, { insertAfterId: 'home' });
      // Mutate the slide on disk and re-splice (simulating a re-import):
      const slideAbs = path.join(SLIDE_LIBRARY_SLIDES_DIR, fx.slide.id, 'index.html');
      fs.writeFileSync(
        slideAbs,
        '<html><head><style>.x{color:blue}</style></head><body>' +
        '<div class="slide-root">v2</div></body></html>'
      );
      const out2 = spliceLibrarySlideIntoRunHtml(fx.runDir, 'reinsert-slide', fx.slide, { insertAfterId: 'home' });
      assert.equal(out2.applied, true);

      const written = fs.readFileSync(path.join(fx.runDir, 'scratch-app', 'index.html'), 'utf8');
      const startMarkers = (written.match(/POST-SLIDES STYLES: reinsert-slide/g) || []).length;
      // Exactly ONE start marker + ONE end marker — re-insert removed the
      // prior block before adding the new one:
      assert.equal(startMarkers, 2, 'expect exactly one start + one end marker after re-insert');
      // CSS is scoped to the slide; v2 replaces v1:
      assert.match(written, /:where\(\[data-testid="step-reinsert-slide"\]\) \.x\s*\{color:\s*blue\}/);
      assert.doesNotMatch(written, /color:\s*red/);
      // Step content also replaced:
      assert.match(written, />v2</);
      assert.doesNotMatch(written, />v1</);
    } finally {
      fx.cleanup();
    }
  });

  test('no insertAfterId argument keeps legacy fallback behavior (and skips CTA rewire)', () => {
    const fx = makeFixture(
      'splice-legacy-' + Date.now(),
      'slide-legacy-' + Date.now(),
      '<div class="slide-root">L</div>',
      '<!doctype html><html><body>' +
        '<div data-testid="step-home" class="step">' +
        '<button class="btn btn-primary" onclick="window.goToStep(\'kept\')">Continue</button>' +
        '</div>' +
        '<!-- SIDE PANELS --></body></html>'
    );
    try {
      const out = spliceLibrarySlideIntoRunHtml(fx.runDir, 'legacy-slide', fx.slide);
      assert.equal(out.applied, true);
      assert.equal(out.ctaRewired, false);
      assert.equal(out.ctaRewireReason, 'no-insert-after-id');
      const written = fs.readFileSync(path.join(fx.runDir, 'scratch-app', 'index.html'), 'utf8');
      // Legacy CTA target preserved:
      assert.match(written, /goToStep\('kept'\)/);
    } finally {
      fx.cleanup();
    }
  });
});
