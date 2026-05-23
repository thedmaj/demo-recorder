'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require(path.join(__dirname, '../../scripts/scratch/utils/qa-patch-library'));

describe('slide design opt-in patches', () => {
  test('slide-design patches do not auto-match QA reports', () => {
    const report = {
      steps: [{
        stepId: 'x',
        categories: ['slide-design-tokens', 'slide-shell-chrome'],
        issues: ['Slide missing canonical shell chrome'],
      }],
    };
    const matches = lib.findApplicablePatches(report);
    const names = matches.map((m) => m.patch.name);
    assert.ok(!names.includes('slide-design-tokens-inject'));
    assert.ok(!names.includes('slide-shell-chrome-inject'));
    assert.ok(!names.includes('slide-typography-floor'));
    assert.ok(!names.includes('slide-chrome-logo-canonical'));
  });

  test('getPatchByName + buildManualPatchMatch resolve opt-in patches', () => {
    const p = lib.getPatchByName('slide-design-tokens-inject');
    assert.ok(p);
    assert.equal(p.manualOnly, true);
    const m = lib.buildManualPatchMatch('slide-design-tokens-inject');
    assert.ok(m && m.patch.name === 'slide-design-tokens-inject');
  });

  test('slide-design-tokens-inject is idempotent', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-patch-'));
    const appDir = path.join(tmpDir, 'scratch-app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, 'index.html'),
      '<html><head></head><body><div class="slide-root"></div></body></html>',
      'utf8'
    );
    const match = lib.buildManualPatchMatch('slide-design-tokens-inject');
    const first = await lib.applyPatches({ runDir: tmpDir, matches: [match] });
    assert.equal(first.applied, 1);
    const second = await lib.applyPatches({ runDir: tmpDir, matches: [match] });
    assert.equal(second.applied, 0);
    const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
    assert.ok(html.includes('POST-SLIDES DESIGN SYSTEM CSS'));
    assert.ok(fs.existsSync(path.join(appDir, 'fonts', 'PlaidSans-Regular.otf')));
  });

  test('slide-shell-chrome-inject adds missing chrome', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-patch-'));
    const appDir = path.join(tmpDir, 'scratch-app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, 'index.html'),
      `<html><body>
<div data-testid="step-a" class="step"><div class="slide-root" data-slide-template="T3">
  <h2 class="h-title">Hi <em>there.</em></h2>
</div></div>
</body></html>`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'demo-script.json'),
      JSON.stringify({ steps: [{ id: 'a', sceneType: 'slide', label: 'Act 1' }] }),
      'utf8'
    );
    const out = await lib.applyPatches({
      runDir: tmpDir,
      matches: [lib.buildManualPatchMatch('slide-shell-chrome-inject')],
    });
    assert.equal(out.applied, 1);
    const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
    assert.ok(/\bchrome-logo\b/.test(html));
    assert.ok(/\beyebrow-tag\b/.test(html));
    assert.ok(/\bchrome-foot\b/.test(html));
  });

  test('slide-typography-floor raises sub-24px inline sizes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-patch-'));
    const appDir = path.join(tmpDir, 'scratch-app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, 'index.html'),
      '<div class="slide-root"><div class="frame"><p style="font-size:16px">x</p></div></div>',
      'utf8'
    );
    const out = await lib.applyPatches({
      runDir: tmpDir,
      matches: [lib.buildManualPatchMatch('slide-typography-floor')],
    });
    assert.equal(out.applied, 1);
    const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
    assert.ok(/font-size:\s*24px/i.test(html));
    assert.ok(!/font-size:\s*16px/i.test(html));
  });
});
