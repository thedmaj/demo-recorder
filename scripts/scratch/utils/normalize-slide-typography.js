'use strict';

/**
 * normalize-slide-typography — NEUTERED 2026-05-27
 *
 * Previously: this module enforced a 24px body floor + per-template H-title
 * / hero-stat / body / mono CEILINGS by rewriting inline `font-size: Npx`
 * declarations inside `.slide-root` and injecting a
 * `<style id="slide-typography-ceilings-v1">` block with `!important` rules.
 *
 * Now: typography is owned by the slide-template CSS
 * (templates/slide-template/slide.css + pipeline-slide-contract.css +
 * colors_and_type.css). The LLM follows the template defaults and may
 * reduce a specific font-size with an inline style only when content
 * density or rendered overlap genuinely demands it. There is no
 * pipeline-side floor or ceiling enforcement; rendering bugs (overlap,
 * wrap) are still detected at QA time but no longer floor-clamped.
 *
 * This file is kept as a no-op shim so existing callers don't crash.
 * Once the call sites are deleted across build-app.js / post-slides.js
 * the file itself can be deleted.
 */

/**
 * @param {string} html
 * @param {object} [_opts]
 * @returns {{ html: string, capped: number, stripped: number, floored: number }}
 */
function normalizeSlideTypography(html, _opts = {}) {
  return {
    html: typeof html === 'string' ? html : '',
    capped: 0,
    stripped: 0,
    floored: 0,
  };
}

/**
 * @param {string} html
 * @returns {string}
 */
function injectSlideTypographyOverrides(html) {
  return typeof html === 'string' ? html : '';
}

/**
 * @param {string} [_templateId]
 * @returns {object}
 */
function getSlideTypographyCeilings(_templateId) {
  // Returns the same neutral shape the old fn returned, so callers that
  // destructure don't blow up. All values are effectively "no ceiling".
  return { hTitle: Infinity, hero: Infinity, display: Infinity, body: Infinity, mono: Infinity };
}

// Empty maps preserved so destructuring imports don't crash.
const TEMPLATE_CEILINGS = Object.freeze({});
const DEFAULT_CEILING = Object.freeze({});

module.exports = {
  normalizeSlideTypography,
  injectSlideTypographyOverrides,
  getSlideTypographyCeilings,
  TEMPLATE_CEILINGS,
  DEFAULT_CEILING,
};
