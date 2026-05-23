'use strict';

/**
 * Cap oversized inline font-size inside .slide-root per DECK_DESIGN_SYSTEM.md (1920×1080 scale).
 * Post-slides LLM output often inflates headlines/hero stats beyond token ceilings.
 */

/** @type {Record<string, { hTitle: number, hero: number, display: number, body: number, mono: number }>} */
const TEMPLATE_CEILINGS = {
  T1: { hTitle: 140, hero: 180, display: 140, body: 42, mono: 28 },
  T2: { hTitle: 96, hero: 180, display: 110, body: 36, mono: 28 },
  T3: { hTitle: 96, hero: 180, display: 120, body: 30, mono: 28 },
  T4: { hTitle: 72, hero: 180, display: 110, body: 30, mono: 28 },
  T5: { hTitle: 72, hero: 180, display: 110, body: 30, mono: 28 },
  T6: { hTitle: 72, hero: 140, display: 110, body: 30, mono: 28 },
  T7: { hTitle: 72, hero: 120, display: 110, body: 30, mono: 28 },
  T8: { hTitle: 72, hero: 120, display: 110, body: 30, mono: 28 },
  T9: { hTitle: 72, hero: 120, display: 110, body: 30, mono: 28 },
  T10: { hTitle: 72, hero: 120, display: 110, body: 30, mono: 28 },
  T11: { hTitle: 72, hero: 120, display: 110, body: 30, mono: 28 },
};

const DEFAULT_CEILING = TEMPLATE_CEILINGS.T3;

const MOCKUP_ALLOW_RE = /\.(?:mockup-chrome|phone-mockup|avatar|confidence-pill|status-bar)\b/i;

function extractTemplateId(openTag) {
  const m = String(openTag || '').match(/\bdata-slide-template\s*=\s*["'](T(?:1[01]|[1-9]))["']/i);
  return m ? m[1].toUpperCase() : null;
}

function ceilingsForTemplate(templateId) {
  return TEMPLATE_CEILINGS[templateId] || DEFAULT_CEILING;
}

/**
 * Resolve max px for an inline font-size by nearest semantic context in the tag snippet.
 * @param {string} tagSnippet - opening tag + optional class list context
 * @param {{ hTitle: number, hero: number, display: number, body: number, mono: number }} ceilings
 */
function maxForTag(tagSnippet, ceilings) {
  const s = String(tagSnippet || '');
  if (/\bhero-stat-value\b/i.test(s)) return ceilings.hero;
  if (/\bh-title\b/i.test(s)) return ceilings.hTitle;
  if (/\beyebrow-tag\b/i.test(s) || /\bchrome-foot\b/i.test(s)) return 24;
  if (/\bslide-body-text\b/i.test(s)) return ceilings.body;
  if (/\bmono-block\b/i.test(s) || /\bfont-mono\b/i.test(s)) return ceilings.mono;
  if (/<h1\b/i.test(s)) return ceilings.display;
  if (/<h2\b/i.test(s)) return ceilings.hTitle;
  if (/<h3\b/i.test(s)) return 64;
  return ceilings.body;
}

/**
 * Strip inline font-size from canonical shell classes (CSS owns sizing).
 * @param {string} styleAttr
 */
function stripFontSizeFromStyle(styleAttr) {
  if (!styleAttr) return styleAttr;
  const cleaned = styleAttr
    .replace(/(?:^|;)\s*font-size\s*:\s*[^;]+/gi, '')
    .replace(/;\s*;/g, ';')
    .replace(/^\s*;\s*|\s*;\s*$/g, '')
    .trim();
  return cleaned;
}

/**
 * @param {string} html
 * @param {{ stripCanonicalInline?: boolean }} [opts]
 * @returns {{ html: string, capped: number, stripped: number }}
 */
function normalizeSlideTypography(html, opts = {}) {
  const stripCanonical = opts.stripCanonicalInline !== false;
  let capped = 0;
  let stripped = 0;

  const parts = String(html || '').split(/(<div[^>]*\bslide-root\b[^>]*>)/gi);
  if (parts.length < 2) return { html, capped: 0, stripped: 0 };

  let out = parts[0] || '';
  for (let i = 1; i < parts.length; i += 2) {
    const open = parts[i] || '';
    let body = parts[i + 1] || '';
    const templateId = extractTemplateId(open);
    const ceilings = ceilingsForTemplate(templateId);

    if (MOCKUP_ALLOW_RE.test(body)) {
      out += open + body;
      continue;
    }

    // Cap inline font-size on any tag inside this slide-root block.
    body = body.replace(
      /style\s*=\s*["']([^"']*)["']/gi,
      (match, styleVal, offset) => {
        const ctx = body.slice(Math.max(0, offset - 220), offset + match.length);
        const maxPx = maxForTag(ctx, ceilings);

        if (
          stripCanonical &&
          /\b(?:h-title|hero-stat-value|eyebrow-tag|chrome-foot|slide-body-text)\b/i.test(ctx)
        ) {
          const next = stripFontSizeFromStyle(styleVal);
          if (next !== styleVal) stripped += 1;
          if (!next) return '';
          return `style="${next}"`;
        }

        const nextStyle = styleVal.replace(
          /font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/gi,
          (decl, n) => {
            const px = parseFloat(n);
            if (!Number.isFinite(px) || px <= maxPx) return decl;
            capped += 1;
            return `font-size:${maxPx}px`;
          }
        );
        if (nextStyle === styleVal) return match;
        return `style="${nextStyle}"`;
      }
    );

    // Cap bare style blocks inside slide (rare LLM <style> in fragment)
    body = body.replace(
      /(\.[^{]+)\{([^}]*)\}/g,
      (rule, sel, decls) => {
        if (!/\bslide-root\b/.test(sel) && !/\.h-title|\.hero-stat|\.eyebrow|\.chrome-foot/.test(sel)) {
          return rule;
        }
        const maxPx = /\.hero-stat/i.test(sel)
          ? ceilings.hero
          : /\.h-title/i.test(sel)
            ? ceilings.hTitle
            : ceilings.body;
        const nextDecls = decls.replace(
          /font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/gi,
          (d, n) => {
            const px = parseFloat(n);
            if (!Number.isFinite(px) || px <= maxPx) return d;
            capped += 1;
            return `font-size:${maxPx}px`;
          }
        );
        return `${sel}{${nextDecls}}`;
      }
    );

    out += open + body;
  }

  return { html: out, capped, stripped };
}

/** Export ceilings for build-QA scanner parity */
function getSlideTypographyCeilings(templateId) {
  return ceilingsForTemplate(templateId);
}

const TYPOGRAPHY_OVERRIDE_MARKER = '<!-- slide-typography-ceilings-v1 -->';
const TYPOGRAPHY_OVERRIDE_ID = 'slide-typography-ceilings-v1';

const TYPOGRAPHY_OVERRIDE_CSS = `${TYPOGRAPHY_OVERRIDE_MARKER}
<style id="${TYPOGRAPHY_OVERRIDE_ID}">
/* Pipeline slide typography ceilings — DECK_DESIGN_SYSTEM.md §1.4
 *
 * SCOPE (post architecture rebuild):
 *   - Font ceilings + per-template title sizing
 *   - Chrome foot positioning
 *   - Wrap behavior on long content
 *
 * REMOVED (now owned by templates/slide-template/pipeline-slide-contract.css):
 *   - .step.active .slide-root max-width (the 820px override that caused
 *     the "fonts too big, content bleeds" regression)
 *   - .slide-root .frame overflow:hidden
 *   - .slide-root .slide-stack overflow:hidden (contract now uses overflow:visible)
 *
 * The contract CSS is injected by post-slides AFTER this block, but its
 * selectors (.step.active .slide-root) match this block's specificity.
 * Cascade order in <head> resolves ties in the contract's favor.
 */
.step.active .slide-root .slide-stack,
.step.active .slide-root .h-title,
.step.active .slide-root .attr-chip-slide {
  max-width: 100%;
  overflow-wrap: anywhere;
}
.slide-root .chrome-foot {
  position: relative !important;
  margin-top: auto !important;
  bottom: auto !important;
  left: auto !important;
  right: auto !important;
  padding-top: 32px !important;
  flex-shrink: 0 !important;
  font-size: 24px !important;
  z-index: 2 !important;
}
.slide-root .h-title {
  font-size: min(var(--type-title, 72px), 84px) !important;
  margin-bottom: 40px !important;
  flex-shrink: 0;
}
.slide-root[data-slide-template="T1"] .h-title {
  font-size: min(140px, var(--type-display, 110px)) !important;
}
.slide-root[data-slide-template="T2"] .h-title,
.slide-root[data-slide-template="T3"] .h-title {
  font-size: min(96px, var(--type-title, 72px)) !important;
}
.slide-root .hero-stat-value {
  font-size: min(var(--type-mega, 180px), 180px) !important;
  line-height: 0.9 !important;
  flex-shrink: 0;
}
.slide-root .slide-body-text {
  font-size: min(var(--type-body, 30px), 36px) !important;
}
.slide-root .eyebrow-tag {
  font-size: max(24px, var(--type-meta, 24px)) !important;
}
.slide-root .slide-stack {
  display: flex !important;
  flex-direction: column !important;
  gap: 24px !important;
  flex: 1 !important;
  min-height: 0 !important;
}
.slide-root .json-snippet,
.slide-root .slide-code-block {
  flex-shrink: 1;
  min-height: 0;
  overflow: auto;
  max-height: 220px;
}
</style>`;

/**
 * Inject (or refresh) global slide typography override CSS into host HTML <head>.
 * @param {string} html
 * @returns {string}
 */
function injectSlideTypographyOverrides(html) {
  if (!html || !/\bslide-root\b/.test(html)) return html;
  const without = String(html).replace(
    new RegExp(`${TYPOGRAPHY_OVERRIDE_MARKER}[\\s\\S]*?<\\/style>\\s*`, 'i'),
    ''
  );
  if (/<\/head>/i.test(without)) {
    return without.replace(/<\/head>/i, `${TYPOGRAPHY_OVERRIDE_CSS}\n</head>`);
  }
  if (/<body\b/i.test(without)) {
    return without.replace(/<body\b/i, `${TYPOGRAPHY_OVERRIDE_CSS}\n<body`);
  }
  return `${TYPOGRAPHY_OVERRIDE_CSS}\n${without}`;
}

module.exports = {
  normalizeSlideTypography,
  injectSlideTypographyOverrides,
  getSlideTypographyCeilings,
  TEMPLATE_CEILINGS,
  DEFAULT_CEILING,
};
