'use strict';

/**
 * Pipeline slides omit `.chrome-foot` — footers overlap body copy at 1280×800.
 * Partnership / section labels belong in `.eyebrow-tag` only.
 */

/**
 * Remove all `.chrome-foot` blocks from slide HTML (fragment or step block).
 * @param {string} html
 * @returns {string}
 */
function stripChromeFootFromHtml(html) {
  if (!html) return html;
  let out = String(html);
  const pattern = /<div\b[^>]*\bclass="[^"]*\bchrome-foot\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi;
  for (let i = 0; i < 32; i += 1) {
    const next = out.replace(pattern, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

module.exports = {
  stripChromeFootFromHtml,
};
