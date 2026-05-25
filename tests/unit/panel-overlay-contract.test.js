'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.PIPELINE_RUN_DIR ||= path.join(__dirname, '../../out');

const { scanPanelOverlayContract } = require(path.join(
  __dirname,
  '../../scripts/scratch/scratch/build-qa'
));
const { PATCHES } = require(path.join(
  __dirname,
  '../../scripts/scratch/utils/qa-patch-library'
));

const SLIDE_CSS = fs.readFileSync(
  path.join(__dirname, '../../templates/slide-template/slide.css'),
  'utf8'
);
const PIPELINE_CONTRACT_CSS = fs.readFileSync(
  path.join(__dirname, '../../templates/slide-template/pipeline-slide-contract.css'),
  'utf8'
);

describe('panel overlay contract — CSS sources', () => {
  test('slide.css has no body.api-panel-open slide-shrink rule', () => {
    assert.doesNotMatch(SLIDE_CSS, /body\.api-panel-open\s+\.step\.active\s+\.slide-root/);
  });

  test('pipeline-slide-contract.css has no body.api-panel-open slide-shrink rule', () => {
    assert.doesNotMatch(
      PIPELINE_CONTRACT_CSS,
      /body\.api-panel-open\s+\.step\.active\s+\.slide-root/
    );
  });

  test('slide.css sets side-panel z-index 2100', () => {
    assert.match(SLIDE_CSS, /\.side-panel[\s\S]*z-index:\s*2100/);
  });
});

describe('panel overlay contract — zip-cra-host-contract patch', () => {
  test('no longer injects 520px reserve CSS', () => {
    const entry = PATCHES.find((p) => p.name === 'zip-cra-host-contract');
    assert.ok(entry);
  });

  test('apply function source omits 520px reserve rules', async () => {
    const entry = PATCHES.find((p) => p.name === 'zip-cra-host-contract');
    const src = entry.apply.toString();
    assert.doesNotMatch(src, /padding-right:\s*520px/);
    assert.doesNotMatch(src, /max-width:\s*calc\(100% - 520px\)/);
    assert.match(src, /zip-host-footer/);
  });
});

describe('scanPanelOverlayContract', () => {
  test('flags body.api-panel-open + slide-root shrink rules in global CSS', () => {
    const html = `<style>
body.api-panel-open .step.active .slide-root { max-width: 820px; }
</style>`;
    const out = scanPanelOverlayContract(html, { steps: [] });
    assert.equal(out.length, 1);
    assert.equal(out[0].category, 'panel-overlay-contract');
    assert.equal(out[0].severity, 'critical');
    assert.equal(out[0].deterministicBlocker, true);
  });

  test('flags padding-right: 520px on a host step block', () => {
    const html = `
<div data-testid="step-lendscore-reveal" class="step">
  <style>.zip-main { padding-right: 520px; }</style>
  <main class="zip-main">Underwriting</main>
</div>`;
    const demoScript = { steps: [{ id: 'lendscore-reveal', stepKind: 'app' }] };
    const out = scanPanelOverlayContract(html, demoScript);
    assert.ok(out.some((d) => d.stepId === 'lendscore-reveal'));
    assert.ok(out.every((d) => d.category === 'panel-overlay-contract'));
  });

  test('passes clean HTML without reserve rules', () => {
    const html = `
<div data-testid="step-intro" class="step active">
  <main class="zip-main">No reserve</main>
</div>`;
    const demoScript = { steps: [{ id: 'intro', stepKind: 'app' }] };
    const out = scanPanelOverlayContract(html, demoScript);
    assert.equal(out.length, 0);
  });
});
