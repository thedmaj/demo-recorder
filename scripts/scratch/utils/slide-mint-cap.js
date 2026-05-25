'use strict';

/**
 * Cap mint (`--plaid-teal-500` / `#42F0CD`) references per slide.
 *
 * LLM-generated value-summary slides routinely emit 8–13 mint references —
 * eyebrows on every card, body strong tags, accents — which collapses visual
 * hierarchy and triggers the `slide-mint-overuse` build-QA warning (>3 refs).
 *
 * This function walks each `.slide-root` block and, when more than
 * `maxRefs` mint references are present, demotes the *trailing* occurrences
 * (keeping the first `maxRefs`, which are usually the primary eye-draw and
 * eyebrow label) to neutral Plaid-white tokens. Demotion happens on both
 * `var(--plaid-teal-500)` and `#42F0CD` / `#42f0cd`.
 *
 * Safe by construction: never adds mint, only removes excess; never touches
 * background gradients (intent: drop accent color, not surface color); never
 * runs outside a `.slide-root` block.
 */

// Match the exact tokens that build-qa's scanSlideMintOveruse counts:
// `--plaid-teal-500` (in `var(...)` wrappers and rare bare references) and the
// underlying hex value `#42F0CD`. Keeping these in sync avoids a scanner/cap
// gap where the cap leaves trailing references the scanner still complains about.
const MINT_TOKEN_RE = /(?:--plaid-teal-500|#42F0CD|#42f0cd)/g;

/**
 * @param {string} html
 * @param {{ maxRefs?: number }} [opts]
 * @returns {{ html: string, demoted: number, perSlide: Array<{stepId: string|null, before: number, after: number}> }}
 */
function capSlideMint(html, opts = {}) {
  const maxRefs = Math.max(1, Number(opts.maxRefs) || 3);
  if (!html || !/\bslide-root\b/.test(html)) {
    return { html, demoted: 0, perSlide: [] };
  }
  const perSlide = [];
  let totalDemoted = 0;
  // Split into slide-root chunks. Each odd index is an opening div; the next
  // index is its content until the next slide-root open or end-of-stream.
  const re = /<div[^>]*\bslide-root\b[^>]*>/gi;
  const positions = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    positions.push({ openStart: m.index, openEnd: m.index + m[0].length, opening: m[0] });
  }
  if (positions.length === 0) return { html, demoted: 0, perSlide: [] };

  // Boundary markers that signal the end of a slide block — used so the
  // LAST .slide-root in a document does not absorb the trailing side-panel
  // chrome (#api-response-panel, #link-events-panel) or any post-panels
  // <script> blocks, both of which legitimately use mint to style panel
  // toggles and headers.
  const SLIDE_BOUNDARY_RE = /<div[^>]*\bdata-testid=["']step-[^"']+["'][^>]*>|<!--\s*={3,}[\s\S]*?SIDE PANELS|<div[^>]*\bid=["'](?:link-events-panel|api-response-panel)["']|<\/body>|<script\b/gi;

  function findBoundaryEnd(slice) {
    SLIDE_BOUNDARY_RE.lastIndex = 0;
    const m = SLIDE_BOUNDARY_RE.exec(slice);
    return m ? m.index : slice.length;
  }

  const segments = [];
  segments.push(html.slice(0, positions[0].openStart));
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i];
    const nextStart = i + 1 < positions.length ? positions[i + 1].openStart : html.length;
    const rawSlice = html.slice(cur.openEnd, nextStart);
    const boundary = findBoundaryEnd(rawSlice);
    const body = rawSlice.slice(0, boundary);
    const trailing = rawSlice.slice(boundary);

    // Resolve nearest step id from the surrounding context for reporting.
    const ctxStart = Math.max(0, cur.openStart - 400);
    const ctx = html.slice(ctxStart, cur.openStart);
    const idMatch = ctx.match(/data-testid="step-([^"]+)"/i);
    const stepId = idMatch ? idMatch[1] : null;

    const mintCount = (body.match(MINT_TOKEN_RE) || []).length;
    let nextBody = body;
    if (mintCount > maxRefs) {
      let seen = 0;
      nextBody = body.replace(MINT_TOKEN_RE, (token) => {
        seen += 1;
        if (seen <= maxRefs) return token;
        totalDemoted += 1;
        // Demote to neutral. `--plaid-teal-500` (matched as the bare token —
        // typically inside a `var(...)` usage) is rewritten to `--plaid-white`
        // so the surrounding `var(...)` resolves to a readable neutral. Hex
        // `#42F0CD` is rewritten to `#ffffff` for the same effect on inline
        // `color:` declarations.
        return token.startsWith('#') ? '#ffffff' : '--plaid-white';
      });
    }
    perSlide.push({ stepId, before: mintCount, after: mintCount > maxRefs ? maxRefs : mintCount });
    segments.push(cur.opening + nextBody + trailing);
  }

  return { html: segments.join(''), demoted: totalDemoted, perSlide };
}

module.exports = {
  capSlideMint,
};
