'use strict';

// Brand isolation wall.
//
// A demo build uses EITHER the default Gingham brand OR a real brand (Brandfetch /
// crawl / curated reference) — never both. The Gingham *design system* (its
// `var(--gg-*)` tokens and `assets/gingham-brand/*`) must never appear in a
// real-brand build, and a Gingham build must carry `gingham-default` provenance.
//
// This is the enforcement half of the wall the brand-extract `gingham-default`
// branch establishes: it makes a cross-contamination impossible to ship silently.

/**
 * @param {string} html   The generated app HTML.
 * @param {object} brand  The loaded brand profile (has `_brandSource` / `_source`).
 * @returns {{ok:boolean, brandSource:'gingham-default'|'real', violations:string[]}}
 */
function checkBrandIsolation(html, brand) {
  const src = String((brand && (brand._brandSource || brand._source)) || 'real');
  const isGingham = src === 'gingham-default';
  const h = String(html || '');
  // Gingham's token namespace (`--gg-*`) and asset path are unique to the brand.
  const hasGinghamMarkers = /--gg-[a-z0-9-]+/i.test(h) || /gingham-brand\//i.test(h);

  const violations = [];
  if (!isGingham && hasGinghamMarkers) {
    violations.push(
      'Gingham design-system markers (var(--gg-*) or gingham-brand/ assets) found in a NON-Gingham build — brand cross-contamination.'
    );
  }
  if (isGingham && brand && brand._source && brand._source !== 'gingham-default') {
    violations.push(
      `Gingham build has unexpected _source="${brand._source}" — Brandfetch/crawl may have run on the walled path.`
    );
  }

  return {
    ok: violations.length === 0,
    brandSource: isGingham ? 'gingham-default' : 'real',
    violations,
  };
}

module.exports = { checkBrandIsolation };
