'use strict';
/**
 * brand-contrast.js
 *
 * Detects whether a brand's logo is a light-tone or dark-tone asset and
 * recommends a host app banner / nav background that keeps the logo visible.
 * Writes the recommendation into the brand profile so `build-app.js` can
 * trust a single authoritative field rather than re-deriving contrast each
 * run.
 *
 * Detection priority:
 *   1. Brandfetch URL heuristic — Brandfetch serves logos under
 *      `/theme/dark/` (logo drawn for dark bg = light tone) or
 *      `/theme/light/` (logo drawn for light bg = dark tone). This is
 *      a deliberate, 1:1 signal and takes priority over heuristics.
 *   2. `brand.logo.color` luminance — when the brand provides a text
 *      wordmark color, compute its WCAG relative luminance.
 *   3. Fallback — default to a white banner with brand accents so at
 *      minimum the logo is visible against a neutral surface.
 *
 * WCAG contrast ratio is computed between `logo.color` (as used for a text
 * wordmark) and the proposed banner background. A ratio < 4.5:1 is treated
 * as a collision and the banner is switched to white.
 *
 * Exports are intentionally pure; safe to unit test.
 */

function parseColor(str) {
  const s = String(str || '').trim().toLowerCase();
  if (!s) return null;
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const m = s.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/);
  if (m) {
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
  }
  return null;
}

function relativeLuminance({ r, g, b }) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(colorA, colorB) {
  if (!colorA || !colorB) return null;
  const la = relativeLuminance(colorA);
  const lb = relativeLuminance(colorB);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function classifyLuminance(value) {
  if (!Number.isFinite(value)) return null;
  if (value < 0.35) return 'dark';
  if (value > 0.6) return 'light';
  return 'mid';
}

/**
 * Return { tone: 'light'|'dark'|'unknown', source, luminance? }.
 * Tone is the **tone of the logo pixels themselves**, not of the intended
 * background. A "light" logo is meant to be displayed on a dark background.
 */
function detectLogoTone(brand) {
  const logo = (brand && brand.logo) || {};
  const url = String(logo.imageUrl || logo.iconUrl || '').toLowerCase();
  if (/[/?&]theme\/dark\//.test(url) || /\/theme\/dark\//.test(url)) {
    return { tone: 'light', source: 'brandfetch-theme-dark' };
  }
  if (/[/?&]theme\/light\//.test(url) || /\/theme\/light\//.test(url)) {
    return { tone: 'dark', source: 'brandfetch-theme-light' };
  }
  const logoColor = parseColor(logo.color);
  if (logoColor) {
    const lum = relativeLuminance(logoColor);
    const band = classifyLuminance(lum);
    if (band === 'dark') return { tone: 'dark', source: 'logo-color-luminance', luminance: lum };
    if (band === 'light') return { tone: 'light', source: 'logo-color-luminance', luminance: lum };
    // Mid-tone → treat as unknown so we fall back to safe defaults.
  }
  return { tone: 'unknown', source: 'none' };
}

/**
 * Recommend a host app banner background that preserves logo visibility.
 * Returns an object saved under `brand.hostBanner`:
 *
 *   {
 *     bg:              string (hex)           — recommended banner background
 *     logoTone:        'light'|'dark'|'unknown'
 *     toneSource:      string                  — how tone was detected
 *     accentStripe:    string|null             — accent color to use along the banner
 *     contrastRatio:   number|null             — logo.color vs bg, when measurable
 *     reason:          string                  — human-readable explanation
 *     recommendation:  string                  — narrative for the prompt
 *     fallback:        boolean                 — true when defaulting to white
 *   }
 */
function recommendHostBanner(brand) {
  const logo = (brand && brand.logo) || {};
  const colors = (brand && brand.colors) || {};
  const toneResult = detectLogoTone(brand);
  const tone = toneResult.tone;

  const navBgRaw = colors.navBg || colors.bgPrimary || '#ffffff';
  const navBg = parseColor(navBgRaw);
  const logoColor = parseColor(logo.color);
  const textPrimary = parseColor(colors.textPrimary);

  let bg = navBgRaw;
  let reason;
  let fallback = false;
  let contrast = null;

  if (tone === 'light') {
    const lum = navBg ? relativeLuminance(navBg) : null;
    if (lum != null && lum < 0.35) {
      reason = `navBg is dark (luminance ${lum.toFixed(2)}); logo is light — good contrast`;
    } else if (colors.textPrimary && textPrimary && relativeLuminance(textPrimary) < 0.35) {
      bg = colors.textPrimary;
      reason = `navBg too light for a light-tone logo; using textPrimary (${colors.textPrimary}) as banner`;
    } else {
      bg = '#0d1117';
      reason = 'navBg too light for a light-tone logo; using neutral dark #0d1117';
    }
  } else if (tone === 'dark') {
    const lum = navBg ? relativeLuminance(navBg) : null;
    if (lum != null && lum > 0.6) {
      reason = `navBg is light (luminance ${lum.toFixed(2)}); logo is dark — good contrast`;
    } else {
      bg = '#ffffff';
      reason = 'navBg too dark for a dark-tone logo; defaulted to white banner';
      fallback = true;
    }
  } else {
    // Unknown logo tone — use text wordmark contrast as the signal.
    if (logoColor && navBg) {
      contrast = contrastRatio(logoColor, navBg);
      if (contrast != null && contrast < 4.5) {
        bg = '#ffffff';
        reason = `low contrast (${contrast.toFixed(2)}:1) between logo.color and navBg; defaulted to white banner with brand accent`;
        fallback = true;
      } else if (contrast != null) {
        reason = `acceptable contrast (${contrast.toFixed(2)}:1) between logo.color and navBg`;
      } else {
        bg = '#ffffff';
        reason = 'logo tone not derivable; defaulted to white banner with brand accents';
        fallback = true;
      }
    } else {
      bg = '#ffffff';
      reason = 'no logo color or navBg to compare; defaulted to white banner with brand accents';
      fallback = true;
    }
  }

  const bgParsed = parseColor(bg);
  const finalContrast = logoColor && bgParsed ? contrastRatio(logoColor, bgParsed) : contrast;

  const accentStripe = colors.navAccentStripe || colors.accentCta || colors.accentBorder || null;

  const recommendation = fallback
    ? `Use a **white (#ffffff) banner** with a ${accentStripe || 'brand accent'} stripe or border (logo tone could not be safely matched to the brand's preferred nav color).`
    : `Use a banner background of \`${bg}\`. Logo is ${tone}-tone — do not change the banner to a background of similar luminance.`;

  return {
    bg,
    logoTone: tone,
    toneSource: toneResult.source,
    accentStripe,
    contrastRatio: finalContrast != null ? Math.round(finalContrast * 100) / 100 : null,
    reason,
    recommendation,
    fallback,
  };
}

module.exports = {
  parseColor,
  relativeLuminance,
  contrastRatio,
  detectLogoTone,
  classifyLuminance,
  recommendHostBanner,
};
