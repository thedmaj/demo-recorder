'use strict';

/**
 * Unit tests for scripts/scratch/utils/export-plaid-deck.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  exportPlaidDeck,
  validateManifest,
  detectLeaks,
  buildDeckHtml,
  CANVAS_PROFILES,
} = require('../../scripts/scratch/utils/export-plaid-deck');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plaid-deck-export-'));
}

// ── validateManifest ─────────────────────────────────────────────────────────

test('validateManifest: rejects missing title', () => {
  const r = validateManifest({ slides: [{ id: 's1', sourceHtml: '<div></div>' }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /title/.test(e)));
});

test('validateManifest: rejects empty slides[]', () => {
  const r = validateManifest({ title: 'Test', slides: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /slides/.test(e)));
});

test('validateManifest: rejects slide without id or sourceHtml', () => {
  const r = validateManifest({ title: 'Test', slides: [{ id: 's1' }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /sourceHtml/.test(e)));
});

test('validateManifest: accepts minimal valid manifest', () => {
  const r = validateManifest({
    title: 'Plaid Q2 Roadmap',
    slides: [{ id: 'cover', sourceHtml: '<div class="frame">Hi</div>' }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

// ── detectLeaks ──────────────────────────────────────────────────────────────

test('detectLeaks: clean Plaid sourceHtml -> []', () => {
  const html = '<div class="frame"><h2 class="h-title">Clean</h2></div>';
  assert.deepEqual(detectLeaks(html), []);
});

test('detectLeaks: catches Workhorse theme CSS', () => {
  const html = '<link href="assets/themes/tokyo-night.css"><div class="frame"></div>';
  const leaks = detectLeaks(html);
  assert.ok(leaks.some((l) => /theme CSS/.test(l)));
});

test('detectLeaks: catches runtime.js and data-anim', () => {
  const html = '<script src="../runtime.js"></script><div data-anim="fade-up"></div>';
  const leaks = detectLeaks(html);
  assert.ok(leaks.some((l) => /runtime\.js/.test(l)));
  assert.ok(leaks.some((l) => /data-anim/.test(l)));
});

// ── buildDeckHtml ────────────────────────────────────────────────────────────

test('buildDeckHtml: assembles cover + body slides with first .active', () => {
  const html = buildDeckHtml({
    manifest: {
      title: 'Test',
      slides: [
        { id: 'cover', template: 'T1', workhorseLayout: 'cover', sourceHtml: '<div>cover body</div>' },
        { id: 'kpi', template: 'T4', workhorseLayout: 'kpi-grid', background: 'light', sourceHtml: '<div>kpi body</div>' },
      ],
    },
    canvasProfile: CANVAS_PROFILES.pipeline,
    keyboardNav: false,
    colorsAndTypeCss: '/* tokens */',
    slideCss: '/* slide */',
    contractCss: '/* contract */',
  });
  assert.match(html, /<title>Test<\/title>/);
  assert.match(html, /data-testid="step-cover" class="step active"/);
  assert.match(html, /data-testid="step-kpi" class="step"/);
  assert.match(html, /data-slide-template="T1"/);
  assert.match(html, /data-workhorse-layout="kpi-grid"/);
  assert.match(html, /class="slide-root light"/);
  assert.match(html, /aspect-ratio: 1280 \/ 800/);
  // No nav script by default
  assert.doesNotMatch(html, /ArrowRight/);
});

test('buildDeckHtml: includes keyboard nav script when keyboardNav=true', () => {
  const html = buildDeckHtml({
    manifest: { title: 'Nav', slides: [{ id: 's1', sourceHtml: '<div>1</div>' }, { id: 's2', sourceHtml: '<div>2</div>' }] },
    canvasProfile: CANVAS_PROFILES.authoring,
    keyboardNav: true,
    colorsAndTypeCss: '',
    slideCss: '',
    contractCss: '',
  });
  assert.match(html, /ArrowRight/);
  assert.match(html, /aspect-ratio: 1920 \/ 1080/);
});

test('buildDeckHtml: escapes HTML in title and attributes', () => {
  const html = buildDeckHtml({
    manifest: {
      title: 'Plaid & <Demo>',
      slides: [{ id: 'a"b', sourceHtml: '<div>x</div>' }],
    },
    canvasProfile: CANVAS_PROFILES.pipeline,
    keyboardNav: false,
    colorsAndTypeCss: '',
    slideCss: '',
    contractCss: '',
  });
  assert.match(html, /<title>Plaid &amp; &lt;Demo&gt;<\/title>/);
  assert.match(html, /data-testid="step-a&quot;b"/);
});

// ── exportPlaidDeck (end-to-end) ─────────────────────────────────────────────

test('exportPlaidDeck: writes file + copies fonts and logos', () => {
  const dir = tmpDir();
  const manifestPath = path.join(dir, 'manifest.json');
  const outPath = path.join(dir, 'deck.html');

  const manifest = {
    title: 'Plaid Demo Deck',
    slides: [
      {
        id: 'cover',
        template: 'T1',
        workhorseLayout: 'cover',
        sourceHtml: '<div class="frame"><img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png"><h2 class="h-title">Hello.</h2></div>',
      },
      {
        id: 'kpi',
        template: 'T4',
        workhorseLayout: 'kpi-grid',
        background: 'light',
        sourceHtml: '<div class="frame"><div class="slide-stack"><h2 class="h-title">Three numbers.</h2></div></div>',
      },
    ],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const result = exportPlaidDeck({
    manifestPath,
    outPath,
    canvas: 'pipeline',
    nav: 'static',
    logger: () => {},
  });

  assert.ok(fs.existsSync(outPath), 'deck.html written');
  assert.ok(fs.existsSync(path.join(dir, 'fonts', 'PlaidSans-Regular.otf')), 'fonts copied');
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'logos', 'plaid-horizontal-white.png')), 'logos copied');

  const written = fs.readFileSync(outPath, 'utf8');
  assert.match(written, /data-slide-template="T1"/);
  assert.match(written, /data-workhorse-layout="kpi-grid"/);
  assert.match(written, /Plaid Demo Deck/);
  // Plaid tokens inlined
  assert.match(written, /--plaid-ink-900/);
  // contract css inlined
  assert.match(written, /\.step\.active \.slide-root/);
  assert.equal(result.manifest.slides.length, 2);
  assert.equal(result.leakReport.length, 2);
  assert.equal(result.leakReport[0].leaks.length, 0);

  // cleanup
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exportPlaidDeck: warns (does not throw) when Workhorse leaks present in sourceHtml', () => {
  const dir = tmpDir();
  const manifestPath = path.join(dir, 'manifest.json');
  const outPath = path.join(dir, 'deck.html');

  const manifest = {
    title: 'Leaky Deck',
    slides: [
      {
        id: 'leaky',
        sourceHtml: '<link href="assets/themes/dracula.css"><script src="runtime.js"></script><div data-anim="fade-up">body</div>',
      },
    ],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const logs = [];
  const result = exportPlaidDeck({ manifestPath, outPath, logger: (m) => logs.push(m) });

  assert.ok(fs.existsSync(outPath), 'still wrote output (leaks are warnings only)');
  assert.ok(logs.some((l) => /WARNING.*Workhorse leak/i.test(l)));
  assert.ok(result.leakReport[0].leaks.length >= 3);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('exportPlaidDeck: dryRun=true returns html without writing', () => {
  const dir = tmpDir();
  const manifestPath = path.join(dir, 'manifest.json');
  const outPath = path.join(dir, 'deck.html');
  fs.writeFileSync(manifestPath, JSON.stringify({ title: 'Dry', slides: [{ id: 's1', sourceHtml: '<div>x</div>' }] }));

  const result = exportPlaidDeck({ manifestPath, outPath, dryRun: true, logger: () => {} });
  assert.equal(fs.existsSync(outPath), false);
  assert.match(result.html, /<title>Dry<\/title>/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('exportPlaidDeck: throws on invalid manifest', () => {
  const dir = tmpDir();
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ slides: [] }));
  assert.throws(
    () => exportPlaidDeck({ manifestPath, outPath: path.join(dir, 'x.html'), logger: () => {} }),
    /Manifest invalid/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exportPlaidDeck: throws on unknown canvas profile', () => {
  const dir = tmpDir();
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ title: 'X', slides: [{ id: 's', sourceHtml: '<div></div>' }] }));
  assert.throws(
    () => exportPlaidDeck({ manifestPath, outPath: path.join(dir, 'x.html'), canvas: 'mobile', logger: () => {} }),
    /Unknown canvas profile/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
