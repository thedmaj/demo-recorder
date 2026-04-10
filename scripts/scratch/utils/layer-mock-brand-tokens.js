'use strict';

/**
 * Maps brand-profile `colors` onto Layer mobile mock CSS custom properties.
 * Accent and host chrome come only from the current run's brand extract — no
 * pipeline default palette (no green, no Plaid teal, no generic blue).
 *
 * Optional fields fall back to color-mix() expressions that reference
 * `--layer-brand-accent` or `--layer-host-page-bg-from`, never hardcoded hues.
 */

function cssCustomPropValue(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s || /[;{}]/.test(s)) return '';
  return s;
}

/**
 * @param {object} brand  Brand profile (brand/*.json)
 * @returns {string} Full `<style id="layer-mock-brand-tokens">…</style>` block
 */
function buildLayerMockBrandTokensStyle(brand) {
  const c = brand && brand.colors;
  if (!c || typeof c !== 'object') {
    throw new Error('[Build] Layer mock brand tokens: missing brand.colors');
  }
  const accent = cssCustomPropValue(c.accentCta);
  if (!accent) {
    throw new Error('[Build] Layer mock brand tokens: brand.colors.accentCta is required');
  }
  /* Single stop only — full bgGradient belongs in host layout elsewhere, not here */
  const bgFromSafe = cssCustomPropValue(c.bgPrimary) || 'transparent';

  const tint = cssCustomPropValue(c.accentBgTint);
  const border = cssCustomPropValue(c.accentBorder);
  const bgToCandidate =
    cssCustomPropValue(c.surfaceCard) ||
    cssCustomPropValue(c.accentBgTint) ||
    '';

  const lines = [
    ':root{',
    `  --layer-brand-accent:${accent};`,
    '  --layer-brand-accent-hover:color-mix(in srgb,var(--layer-brand-accent) 85%,#000);',
  ];
  if (tint) {
    lines.push(`  --layer-brand-tint-bg:${tint};`);
  } else {
    lines.push('  --layer-brand-tint-bg:color-mix(in srgb,var(--layer-brand-accent) 12%,transparent);');
  }
  if (border) {
    lines.push(`  --layer-phone-input-border:${border};`);
  } else {
    lines.push('  --layer-phone-input-border:color-mix(in srgb,var(--layer-brand-accent) 38%,transparent);');
  }
  lines.push(`  --layer-host-page-bg-from:${bgFromSafe};`);
  if (bgToCandidate) {
    lines.push(`  --layer-host-page-bg-to:${bgToCandidate};`);
  } else {
    lines.push(
      '  --layer-host-page-bg-to:color-mix(in srgb,var(--layer-brand-accent) 8%,var(--layer-host-page-bg-from));'
    );
  }
  lines.push('}');

  return `<style id="layer-mock-brand-tokens">\n${lines.join('\n')}\n</style>`;
}

module.exports = { buildLayerMockBrandTokensStyle };
