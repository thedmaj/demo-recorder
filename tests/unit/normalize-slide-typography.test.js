'use strict';

/**
 * normalize-slide-typography is intentionally a no-op as of 2026-05-27.
 * Slide templates own font sizing; the LLM may reduce inline font-size to
 * fit content without any pipeline-side floor or ceiling enforcement.
 *
 * These tests pin the no-op contract so a future refactor can't silently
 * resurrect the old enforcement.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSlideTypography,
  getSlideTypographyCeilings,
  injectSlideTypographyOverrides,
  TEMPLATE_CEILINGS,
  DEFAULT_CEILING,
} = require('../../scripts/scratch/utils/normalize-slide-typography');

describe('normalizeSlideTypography (neutered no-op)', () => {
  test('does not cap oversized hero stat inline font-size — templates own sizing', () => {
    const html = `
<div data-testid="step-n" class="step">
  <div class="slide-root" data-slide-template="T4">
    <div class="hero-stat-value" style="font-size:280px">+25%</div>
  </div>
</div>`;
    const { html: out, capped, stripped, floored } = normalizeSlideTypography(html);
    assert.equal(capped, 0, 'no font-size capping performed');
    assert.equal(stripped, 0, 'no inline font-size stripping performed');
    assert.equal(floored, 0, 'no 24px floor enforcement performed');
    assert.equal(out, html, 'input HTML returned unchanged');
  });

  test('does not raise sub-24px inline font-size — there is no body floor', () => {
    const html = `
<div class="slide-root" data-slide-template="T8">
  <p class="slide-body-text" style="font-size:12px">tiny caption</p>
</div>`;
    const { html: out, floored } = normalizeSlideTypography(html);
    assert.equal(floored, 0);
    assert.equal(out, html);
  });

  test('injectSlideTypographyOverrides returns input unchanged (no <style> injection)', () => {
    const html = '<html><head></head><body><div class="slide-root">x</div></body></html>';
    assert.equal(injectSlideTypographyOverrides(html), html);
  });

  test('getSlideTypographyCeilings returns Infinity ceilings (= no ceiling)', () => {
    const c = getSlideTypographyCeilings('T3');
    assert.equal(c.hTitle, Infinity);
    assert.equal(c.hero, Infinity);
    assert.equal(c.body, Infinity);
  });

  test('TEMPLATE_CEILINGS + DEFAULT_CEILING are empty objects (no per-template caps)', () => {
    assert.equal(Object.keys(TEMPLATE_CEILINGS).length, 0);
    assert.equal(Object.keys(DEFAULT_CEILING).length, 0);
  });
});
