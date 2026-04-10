'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildLayerMockBrandTokensStyle } = require(
  path.join(__dirname, '../../scripts/scratch/utils/layer-mock-brand-tokens')
);

describe('layer-mock-brand-tokens', () => {
  test('buildLayerMockBrandTokensStyle maps brand.colors to :root Layer variables', () => {
    const html = buildLayerMockBrandTokensStyle({
      name: 'TestCo',
      slug: 'testco',
      colors: {
        accentCta: '#2e5cff',
        bgPrimary: '#ffffff',
        accentBgTint: 'rgba(46, 92, 255, 0.08)',
        accentBorder: '#2e5cff',
        surfaceCard: '#f8f9fa',
      },
    });
    assert.match(html, /id="layer-mock-brand-tokens"/);
    assert.match(html, /--layer-brand-accent:#2e5cff/);
    assert.match(html, /--layer-brand-tint-bg:rgba\(46, 92, 255, 0\.08\)/);
    assert.match(html, /--layer-host-page-bg-from:#ffffff/);
    assert.match(html, /--layer-host-page-bg-to:#f8f9fa/);
    assert.match(html, /--layer-brand-accent-hover:color-mix/);
  });

  test('buildLayerMockBrandTokensStyle throws without accentCta', () => {
    assert.throws(
      () => buildLayerMockBrandTokensStyle({ colors: { bgPrimary: '#fff' } }),
      /accentCta is required/
    );
  });
});
