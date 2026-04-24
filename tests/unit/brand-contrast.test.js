'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  parseColor,
  relativeLuminance,
  contrastRatio,
  detectLogoTone,
  recommendHostBanner,
} = require(path.join(__dirname, '../../scripts/scratch/utils/brand-contrast'));

describe('brand-contrast', () => {
  test('parseColor handles hex and rgb', () => {
    assert.deepEqual(parseColor('#ffffff'), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(parseColor('#012169'), { r: 1, g: 33, b: 105, a: 1 });
    const rgba = parseColor('rgba(10, 20, 30, 0.5)');
    assert.equal(rgba.r, 10);
    assert.equal(rgba.g, 20);
    assert.equal(rgba.b, 30);
    assert.equal(rgba.a, 0.5);
    assert.equal(parseColor(''), null);
    assert.equal(parseColor('not-a-color'), null);
  });

  test('relativeLuminance anchors white at 1 and black at 0', () => {
    assert.ok(Math.abs(relativeLuminance({ r: 255, g: 255, b: 255 }) - 1) < 1e-6);
    assert.ok(relativeLuminance({ r: 0, g: 0, b: 0 }) < 1e-6);
  });

  test('contrastRatio: white vs black is 21:1, white vs white is 1:1', () => {
    assert.ok(Math.abs(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }) - 21) < 1e-3);
    assert.ok(Math.abs(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 }) - 1) < 1e-6);
  });

  test('detectLogoTone uses brandfetch theme URL as authoritative signal', () => {
    const brandDark = { logo: { imageUrl: 'https://cdn.brandfetch.io/abc/theme/dark/logo.svg' } };
    assert.equal(detectLogoTone(brandDark).tone, 'light');
    assert.equal(detectLogoTone(brandDark).source, 'brandfetch-theme-dark');

    const brandLight = { logo: { imageUrl: 'https://cdn.brandfetch.io/abc/theme/light/logo.svg' } };
    assert.equal(detectLogoTone(brandLight).tone, 'dark');
    assert.equal(detectLogoTone(brandLight).source, 'brandfetch-theme-light');
  });

  test('detectLogoTone falls back to logo.color luminance when no URL hint', () => {
    const darkLogo = { logo: { color: '#012169' } };
    assert.equal(detectLogoTone(darkLogo).tone, 'dark');
    const lightLogo = { logo: { color: '#f5f5f5' } };
    assert.equal(detectLogoTone(lightLogo).tone, 'light');
  });

  test('recommendHostBanner respects a light-tone logo on a navy navBg', () => {
    const bofa = {
      logo: { imageUrl: 'https://cdn.brandfetch.io/xyz/theme/dark/logo.svg', color: '#012169' },
      colors: { navBg: '#012169', bgPrimary: '#ffffff', navAccentStripe: '#e31837' },
    };
    const result = recommendHostBanner(bofa);
    assert.equal(result.logoTone, 'light');
    assert.equal(result.bg, '#012169');
    assert.equal(result.fallback, false);
  });

  test('recommendHostBanner switches to white when logo would collide with navBg (dark logo on dark nav)', () => {
    const collision = {
      logo: { color: '#012169' },
      colors: { navBg: '#012169', bgPrimary: '#ffffff' },
    };
    const result = recommendHostBanner(collision);
    assert.equal(result.bg, '#ffffff');
    assert.equal(result.fallback, true);
    assert.equal(result.logoTone, 'dark');
    assert.ok(/too dark|navBg too dark/i.test(result.reason));
  });

  test('recommendHostBanner switches to white when logo.color is light-gray-on-white text wordmark', () => {
    // Light-gray logo color + white navBg → unknown tone path → low contrast → white fallback
    const collision = {
      logo: { color: '#b0b0b0' },
      colors: { navBg: '#ffffff' },
    };
    const result = recommendHostBanner(collision);
    assert.equal(result.bg, '#ffffff');
    assert.equal(result.fallback, true);
    assert.ok(/contrast/i.test(result.reason));
  });

  test('recommendHostBanner defaults to white when logo tone is unknown and no colors', () => {
    const thin = { logo: {}, colors: {} };
    const result = recommendHostBanner(thin);
    assert.equal(result.bg, '#ffffff');
    assert.equal(result.fallback, true);
  });

  test('recommendHostBanner for dark-tone logo on dark navBg switches to white', () => {
    const brand = {
      logo: { imageUrl: 'https://cdn.brandfetch.io/abc/theme/light/logo.svg' },
      colors: { navBg: '#0d1117' },
    };
    const result = recommendHostBanner(brand);
    assert.equal(result.logoTone, 'dark');
    assert.equal(result.bg, '#ffffff');
    assert.equal(result.fallback, true);
  });
});
