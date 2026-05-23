'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSlideTypography,
  getSlideTypographyCeilings,
} = require('../../scripts/scratch/utils/normalize-slide-typography');

describe('normalizeSlideTypography', () => {
  test('caps oversized hero stat inline font-size', () => {
    const html = `
<div data-testid="step-n" class="step">
  <div class="slide-root" data-slide-template="T4">
    <div class="hero-stat-value" style="font-size:280px">+25%</div>
  </div>
</div>`;
    const { html: out, capped, stripped } = normalizeSlideTypography(html);
    assert.ok(capped >= 1 || stripped >= 1);
    assert.ok(!/font-size:\s*280px/i.test(out));
  });

  test('caps oversized h-title inline font-size', () => {
    const html = `
<div class="slide-root" data-slide-template="T3">
  <h2 class="h-title" style="font-size:140px">Big <em>idea.</em></h2>
</div>`;
    const { html: out, stripped } = normalizeSlideTypography(html);
    assert.ok(stripped >= 1 || !/font-size:\s*140px/i.test(out));
  });

  test('T3 ceiling is 96px for h-title class context', () => {
    assert.equal(getSlideTypographyCeilings('T3').hTitle, 96);
  });
});
