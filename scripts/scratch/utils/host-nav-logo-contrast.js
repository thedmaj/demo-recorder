'use strict';
/**
 * Host nav logo contrast — detect luminance collisions and patch HTML in place
 * (white banner + accent border + dark wordmark URL). Used by build-qa and
 * qa-patch-library `host-nav-logo-contrast` (app-touchup lane — no build-app).
 */

const fs = require('fs');
const path = require('path');
const { parseColor, relativeLuminance, recommendHostBanner } = require('./brand-contrast');

const HOST_NAV_CONTRAST_MARKER = '/* HOST-NAV-LOGO-CONTRAST v1 */';

const NAV_SELECTORS = [
  'header',
  '[data-testid="host-header"]',
  '[data-testid="host-nav"]',
  '[data-testid="top-nav"]',
  '.app-header',
  '.host-header',
  '.top-nav',
  'nav.app-nav',
].join(',\n');

function replaceThemeInUrl(url, fromTheme, toTheme) {
  const s = String(url || '');
  if (!s) return s;
  return s
    .replace(new RegExp(`/theme/${fromTheme}/`, 'gi'), `/theme/${toTheme}/`)
    .replace(new RegExp(`theme/${fromTheme}`, 'gi'), `theme/${toTheme}`);
}

/**
 * Pick a dark wordmark URL suitable for a white/light host banner.
 */
function pickDarkWordmarkUrl(brand) {
  const logo = (brand && brand.logo) || {};
  const candidates = [
    logo.imageUrl,
    logo.iconUrl,
    replaceThemeInUrl(logo.imageUrl, 'dark', 'light'),
    replaceThemeInUrl(logo.iconUrl, 'dark', 'light'),
  ].filter((u) => /^https?:\/\//i.test(String(u || '')));

  for (const url of candidates) {
    if (/\/theme\/light\//i.test(url)) return url;
  }
  return candidates[0] || null;
}

function loadBrandProfileFromRunDir(runDir) {
  const roots = [
    path.join(runDir, 'artifacts', 'brand'),
    path.join(runDir, 'brand'),
  ];
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || /brand-extract\.json$/i.test(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j && (j.logo || j.colors || j.hostBanner)) return j;
      } catch (_) {}
    }
  }
  return null;
}

function resolveAccentStripe(brand) {
  const hb = brand && brand.hostBanner;
  const colors = (brand && brand.colors) || {};
  return (
    (hb && hb.accentStripe) ||
    colors.navAccentStripe ||
    colors.accentCta ||
    colors.accentBorder ||
    '#42F0CD'
  );
}

function buildHostNavContrastCss(brand) {
  const accent = resolveAccentStripe(brand);
  return (
    `${HOST_NAV_CONTRAST_MARKER}\n` +
    `${NAV_SELECTORS} {\n` +
    '  background-color: #ffffff !important;\n' +
    '  background-image: none !important;\n' +
    '  border-top: 1px solid rgba(0, 0, 0, 0.06) !important;\n' +
    `  border-bottom: 2px solid ${accent} !important;\n` +
    '  box-shadow: none !important;\n' +
    '}\n' +
    '[data-testid="host-bank-logo-shell"] {\n' +
    '  background: #ffffff !important;\n' +
    '  border: 1px solid rgba(0, 0, 0, 0.08) !important;\n' +
    '  border-radius: 10px !important;\n' +
    '  padding: 6px 10px !important;\n' +
    '}\n'
  );
}

function swapHostLogoSrc(html, brand) {
  const nextUrl = pickDarkWordmarkUrl(brand);
  if (!nextUrl) return { html, swapped: false };

  const imgRe =
    /(<img[^>]*\bdata-testid=["']host-bank-logo-img["'][^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/i;
  const m = html.match(imgRe);
  if (!m) return { html, swapped: false };
  if (m[2] === nextUrl) return { html, swapped: false };

  return {
    html: html.replace(imgRe, `$1${nextUrl}$3`),
    swapped: true,
    from: m[2],
    to: nextUrl,
  };
}

function injectHostNavContrastCss(html, brand) {
  const css = buildHostNavContrastCss(brand);
  if (html.includes(HOST_NAV_CONTRAST_MARKER)) {
    return { html, injected: false };
  }
  if (/<\/style>/i.test(html)) {
    return { html: html.replace(/<\/style>/i, `${css}</style>`), injected: true };
  }
  if (/<\/head>/i.test(html)) {
    return { html: html.replace(/<\/head>/i, `<style>${css}</style></head>`), injected: true };
  }
  return { html, injected: false };
}

/**
 * Idempotent in-place patch for scratch-app/index.html.
 */
function applyHostNavLogoContrastPatch(html, brand) {
  let out = String(html || '');
  const cssOut = injectHostNavContrastCss(out, brand);
  out = cssOut.html;
  const logoOut = swapHostLogoSrc(out, brand);
  out = logoOut.html;
  const applied = cssOut.injected || logoOut.swapped;
  return {
    html: out,
    applied,
    cssInjected: cssOut.injected,
    logoSwapped: logoOut.swapped,
    logoFrom: logoOut.from || null,
    logoTo: logoOut.to || null,
  };
}

/**
 * Runtime collision: dark wordmark asset on dark nav, or light asset on light nav.
 */
function isLogoNavLuminanceCollision({ logoSrc, navBgLuminance }) {
  if (typeof navBgLuminance !== 'number' || !Number.isFinite(navBgLuminance)) return false;
  const src = String(logoSrc || '');
  const navIsLight = navBgLuminance > 0.82;
  const navIsDark = navBgLuminance < 0.35;
  const logoIsLightAsset = /\/theme\/dark\//i.test(src);
  const logoIsDarkAsset = /\/theme\/light\//i.test(src);
  if (logoIsDarkAsset && navIsDark) return true;
  if (logoIsLightAsset && navIsLight) return true;
  return false;
}

function collisionIssueText({ logoSrc, navBgLuminance, viewportLabel }) {
  const src = String(logoSrc || '');
  const navIsDark = typeof navBgLuminance === 'number' && navBgLuminance < 0.35;
  const kind = /\/theme\/light\//i.test(src) && navIsDark
    ? 'dark wordmark on dark navigation background'
    : /\/theme\/dark\//i.test(src) && navBgLuminance > 0.82
      ? 'light wordmark on light navigation background'
      : 'logo and navigation background have similar luminance';
  return `Host logo contrast failure at ${viewportLabel || 'viewport'}: ${kind} (nav luminance ${navBgLuminance != null ? navBgLuminance.toFixed(2) : 'n/a'}).`;
}

module.exports = {
  HOST_NAV_CONTRAST_MARKER,
  pickDarkWordmarkUrl,
  loadBrandProfileFromRunDir,
  buildHostNavContrastCss,
  applyHostNavLogoContrastPatch,
  isLogoNavLuminanceCollision,
  collisionIssueText,
  resolveAccentStripe,
  recommendHostBanner,
};
