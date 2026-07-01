'use strict';
// Regression suite for the LIGHT-HOST FLOOR (2026-07-01): brand-extract sometimes
// classifies a host as mode:"dark" and emits a dark bgPrimary; the build then
// painted the whole host page/card dark with dark text → black-on-black (Gringo).
// renderBrandBlock must force host SURFACES light + dark text for a dark brand,
// keeping the brand's dark color for nav/chrome/accents only.
const test = require('node:test');
const assert = require('node:assert');
const { renderBrandBlock } = require('../../scripts/scratch/utils/prompt-templates');

const darkBrand = {
  name: 'Gringo Coin', mode: 'dark',
  colors: { bgPrimary: '#2e3128', surfaceCard: '#3a3f33', textPrimary: '#ffffff', textSecondary: '#c0c0c0', textTertiary: '#808080', accentCta: '#649c75', navBg: '#2e3128', footerBg: '#252a21' },
  typography: {}, motion: {}, atmosphere: {}, sidePanels: {}, logo: {},
};
const str = (b) => (Array.isArray(b) ? b.join('\n') : String(b));

test('light-host floor: dark brand → light host surfaces + dark text', () => {
  const s = str(renderBrandBlock(darkBrand));
  // Case-sensitive "Background:" so we match the standalone host-bg line, not "Nav background:".
  assert.match(s, /\bBackground:\s*#ffffff/, 'host page/card background must be light');
  assert.match(s, /Card surface:\s*#ffffff/i, 'content cards must be light');
  assert.match(s, /Text primary:\s*#111827/i, 'text must be dark on the light host');
  assert.match(s, /Mode:\s*light/i, 'mode reported as light for the host');
  assert.match(s, /LIGHT-HOST RULE/, 'authoritative light-host rule must be emitted');
  assert.doesNotMatch(s, /\bBackground:\s*#2e3128/, 'the dark brand color must NOT be the host background');
});

test('light-host floor: brand dark color still allowed for nav/footer chrome', () => {
  const s = str(renderBrandBlock(darkBrand));
  assert.match(s, /Nav background:\s*#2e3128/i, 'nav may keep the brand dark color (chrome)');
});

test('light-host floor: a genuinely light brand passes its bg through unchanged', () => {
  const lightBrand = { ...darkBrand, mode: 'light', colors: { ...darkBrand.colors, bgPrimary: '#f7f8fa', surfaceCard: '#ffffff', textPrimary: '#111827' } };
  const s = str(renderBrandBlock(lightBrand));
  assert.match(s, /\bBackground:\s*#f7f8fa/i, 'light brand keeps its light bg');
  assert.doesNotMatch(s, /LIGHT-HOST RULE/, 'no override rule needed for an already-light host');
});
