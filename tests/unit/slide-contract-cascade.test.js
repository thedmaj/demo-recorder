'use strict';
/**
 * Pipeline slide contract CSS cascade tests.
 *
 * After app-first/slides-after consolidation, there is ONE canonical contract
 * (`templates/slide-template/pipeline-slide-contract.css`) that owns slide
 * canvas sizing + inner overflow + typography ceilings. The contract is
 * injected ONCE into the host HTML by post-slides.ensureSlideDesignStylesInHead
 * inside a `<style data-pipeline-slide-contract="v1">` block, AFTER the base
 * design-system block, so cascade order is authoritative.
 *
 * These tests guard against the regressions that produced the original "fonts
 * too big, content bleeds" bug:
 *   - No `!important` in the contract (cascade order does the work)
 *   - Contract block appears AFTER base design system block
 *   - Idempotent — re-running does not duplicate the block
 *   - Contract rules are present in the injected HTML
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const contractPath = path.join(PROJECT_ROOT, 'templates/slide-template/pipeline-slide-contract.css');
const slideCssPath = path.join(PROJECT_ROOT, 'templates/slide-template/slide.css');
const colorsPath = path.join(PROJECT_ROOT, 'templates/slide-template/colors_and_type.css');
const { ensureSlideDesignStylesInHead } = require(path.join(PROJECT_ROOT, 'scripts/scratch/scratch/post-slides'));

describe('pipeline-slide-contract.css — file shape', () => {
  test('contract file exists', () => {
    assert.equal(fs.existsSync(contractPath), true, 'pipeline-slide-contract.css must exist');
  });

  test('contract contains NO !important declarations (cascade arms race prevention)', () => {
    const css = fs.readFileSync(contractPath, 'utf8');
    // Allow !important inside comments only — strip block comments first.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/!important/i.test(stripped), false,
      'pipeline-slide-contract.css must not use !important — cascade order is authoritative');
  });

  test('contract declares canonical .step.active .slide-root max-width', () => {
    const css = fs.readFileSync(contractPath, 'utf8');
    assert.match(css, /\.step\.active \.slide-root\s*\{[\s\S]*?max-width\s*:\s*min\(1280px,\s*calc\(100vw\s*-\s*80px\)\)/,
      'canonical max-width must be min(1280px, calc(100vw - 80px))');
  });

  test('contract declares body.api-panel-open narrower max-width', () => {
    const css = fs.readFileSync(contractPath, 'utf8');
    assert.match(css, /body\.api-panel-open[\s\S]*?max-width\s*:\s*min\(820px,\s*calc\(100vw\s*-\s*560px\)\)/);
  });

  test('contract sets .slide-stack overflow:visible (not hidden)', () => {
    const css = fs.readFileSync(contractPath, 'utf8');
    assert.match(css, /\.slide-root \.slide-stack\s*\{\s*overflow\s*:\s*visible/);
  });
});

describe('ensureSlideDesignStylesInHead — contract injection', () => {
  function loadTemplates() {
    return {
      slideTemplateCss: fs.readFileSync(slideCssPath, 'utf8'),
      colorsAndTypeCss: fs.readFileSync(colorsPath, 'utf8'),
      pipelineSlideContractCss: fs.readFileSync(contractPath, 'utf8'),
    };
  }

  test('injects contract block AFTER base design system block', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const out = ensureSlideDesignStylesInHead(html, loadTemplates());
    const baseIdx = out.indexOf('<style data-post-slides-design-system="v1">');
    const contractIdx = out.indexOf('<style data-pipeline-slide-contract="v1">');
    assert.ok(baseIdx > 0, 'base design system block must be present');
    assert.ok(contractIdx > 0, 'pipeline contract block must be present');
    assert.ok(contractIdx > baseIdx, 'contract block must appear AFTER base block in source order (cascade)');
  });

  test('contract block uses canonical marker', () => {
    const html = '<html><head></head><body></body></html>';
    const out = ensureSlideDesignStylesInHead(html, loadTemplates());
    assert.match(out, /<style data-pipeline-slide-contract="v1">/);
    assert.match(out, /<!-- PIPELINE SLIDE CONTRACT v1 -->/);
    assert.match(out, /<!-- \/PIPELINE SLIDE CONTRACT v1 -->/);
  });

  test('idempotent — re-running does not duplicate the block', () => {
    const html = '<html><head></head><body></body></html>';
    const once = ensureSlideDesignStylesInHead(html, loadTemplates());
    const twice = ensureSlideDesignStylesInHead(once, loadTemplates());
    // Use the HTML comment delimiter (lives OUTSIDE the <style> body) to count
    // injections. The CSS file's own header documentation mentions the
    // `<style data-pipeline-slide-contract="v1">` string for human readers,
    // so counting that tag double-counts on each injection. The HTML comment
    // marker is unambiguous.
    const openMarkers = (twice.match(/<!-- PIPELINE SLIDE CONTRACT v1 -->/g) || []).length;
    const closeMarkers = (twice.match(/<!-- \/PIPELINE SLIDE CONTRACT v1 -->/g) || []).length;
    assert.equal(openMarkers, 1, 'contract block opening marker must appear exactly once');
    assert.equal(closeMarkers, 1, 'contract block closing marker must appear exactly once');
  });

  test('contract rules appear inside the injected block (not just the marker)', () => {
    const html = '<html><head></head><body></body></html>';
    const out = ensureSlideDesignStylesInHead(html, loadTemplates());
    // Verify the actual rule body made it in.
    assert.match(out, /max-width\s*:\s*min\(1280px,\s*calc\(100vw\s*-\s*80px\)\)/);
    assert.match(out, /body\.api-panel-open/);
    assert.match(out, /\.slide-root \.slide-stack/);
  });

  test('handles missing contract gracefully (legacy templates)', () => {
    const html = '<html><head></head><body></body></html>';
    const partial = {
      slideTemplateCss: 'body{margin:0}',
      colorsAndTypeCss: ':root{--x:1}',
      // pipelineSlideContractCss omitted
    };
    const out = ensureSlideDesignStylesInHead(html, partial);
    assert.equal(/data-pipeline-slide-contract/.test(out), false,
      'no contract block when contract CSS is empty');
    assert.match(out, /data-post-slides-design-system="v1"/);
  });
});

describe('first-step bootstrap injection (build-app)', () => {
  test('marker is consistent (v1)', () => {
    // The marker string is used both for the <script id> and the idempotency
    // check in build-app. Verifying via grep is the most reliable signal
    // that the wire-up is correct.
    const buildAppPath = path.join(PROJECT_ROOT, 'scripts/scratch/scratch/build-app.js');
    const buildAppSrc = fs.readFileSync(buildAppPath, 'utf8');
    assert.match(buildAppSrc, /pipeline-first-step-bootstrap-v1/);
    assert.match(buildAppSrc, /activateFirstStepIfNoneActive/);
  });

  test('bootstrap is idempotent (does not activate already-active step)', () => {
    // Simulate the injected script's logic against a small DOM model.
    function activateFirstStepIfNoneActive(dom) {
      if (dom.steps.find((s) => s.active)) return;
      const first = dom.steps.find((s) => s.testid);
      if (first) first.active = true;
    }

    const domNoneActive = {
      steps: [{ testid: 'a', active: false }, { testid: 'b', active: false }],
    };
    activateFirstStepIfNoneActive(domNoneActive);
    assert.equal(domNoneActive.steps[0].active, true);
    assert.equal(domNoneActive.steps[1].active, false);

    // Idempotent: when storyboard-editor's STORYBOARD_SET_STEP postMessage
    // already activated step "b", the bootstrap must NOT clobber it.
    const domStoryboardSetB = {
      steps: [{ testid: 'a', active: false }, { testid: 'b', active: true }],
    };
    activateFirstStepIfNoneActive(domStoryboardSetB);
    assert.equal(domStoryboardSetB.steps[0].active, false, 'must not reactivate first when another is active');
    assert.equal(domStoryboardSetB.steps[1].active, true);
  });
});
