'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const postSlides = require(path.join(__dirname, '../../scripts/scratch/scratch/post-slides'));

describe('post-slides design system helpers', () => {
  test('extractSlideTemplateId parses T1–T11', () => {
    assert.equal(
      postSlides.extractSlideTemplateId('<div class="slide-root" data-slide-template="T7"></div>'),
      'T7'
    );
    assert.equal(postSlides.extractSlideTemplateId('<div class="slide-root"></div>'), null);
  });

  test('loadSlideTemplates reads brand-design-briefs', () => {
    const root = path.join(__dirname, '../..');
    const t = postSlides.loadSlideTemplates(root);
    assert.ok(t.deckTemplates.includes('T1 — Title'));
    assert.ok(t.deckDesignSystem.includes('Plaid Deck Design System'));
    assert.ok(t.colorsAndTypeCss.includes('--plaid-ink-900'));
  });

  test('ensureSlideDesignStylesInHead injects marker once', () => {
    const root = path.join(__dirname, '../..');
    const templates = postSlides.loadSlideTemplates(root);
    const html = '<html><head></head><body></body></html>';
    const out = postSlides.ensureSlideDesignStylesInHead(html, templates);
    assert.ok(out.includes('POST-SLIDES DESIGN SYSTEM CSS'));
    assert.equal(postSlides.ensureSlideDesignStylesInHead(out, templates), out);
  });
});
