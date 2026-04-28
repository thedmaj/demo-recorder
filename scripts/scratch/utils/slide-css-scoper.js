'use strict';
/**
 * slide-css-scoper.js
 *
 * Rewrite a slide's CSS so every rule applies ONLY to the slide's step div
 * (and its descendants), never to the host app. Without this, slide styles
 * — universal resets like `*{margin:0}`, `html,body{min-width:1440px}`, and
 * `.step{position:absolute;...}` — bleed into the host and clobber its
 * layout, spacing, and step navigation.
 *
 * Strategy: walk the CSS as top-level blocks (tracking string + comment +
 * brace depth so braces inside attribute selectors / `:is(...)` / strings
 * don't confuse the parser), then for each rule:
 *
 *   - `@media`, `@supports`, `@container` → recurse into the body.
 *   - `@keyframes`, `@font-face`, `@page`, `@charset`, `@import`,
 *     `@namespace`         → leave alone (animation names are global; let
 *                            them be — collisions are handled at the slide
 *                            authoring level).
 *   - selector { decls }   → rewrite each comma-separated selector:
 *       * `html`, `body`, `:root`        → drop (cannot be scoped to a
 *                                          descendant of the host body).
 *       * starts with `.step` or
 *         `[data-testid="step-`          → `:where(scope)<sel>` (no space:
 *                                          attaches the rule to the slide
 *                                          root div itself).
 *       * everything else                → `:where(scope) <sel>` (descendant:
 *                                          applies inside the slide only).
 *
 * `:where(...)` adds zero specificity, so the host's existing rules still
 * win on equal specificity (which is what we want — slide CSS only fills in
 * the gaps inside the slide subtree, never overrides outside it).
 *
 * Pure module — no I/O, no dependencies. Caller is `injectSlideStylesIntoHead`
 * in `post-slides.js`.
 */

/**
 * Walk `cssText` and return its top-level blocks. Each block is
 * `{ prelude, body, raw }`:
 *   - `prelude` = the selector or `@<at-rule>(args)` portion before `{`.
 *   - `body`    = the contents between `{` and the matching `}` (still raw).
 *   - `raw`     = the full block including braces (used to preserve
 *                 trailing whitespace + comments verbatim if we choose not
 *                 to rewrite the block).
 *
 * Whitespace and comments BETWEEN top-level blocks are preserved as
 * "filler" entries with `prelude=null` (so the original layout / comment
 * structure round-trips through the scoper).
 */
function splitTopLevelBlocks(cssText) {
  const blocks = [];
  let i = 0;
  const len = cssText.length;
  let blockStart = 0;
  let braceStart = -1;
  let depth = 0;
  let inString = null;   // '"' or "'" or null
  let inComment = false;

  while (i < len) {
    const ch = cssText[i];
    const next = i + 1 < len ? cssText[i + 1] : '';

    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      i++;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) braceStart = i;
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && braceStart >= 0) {
        const filler = cssText.slice(blockStart, /* up to prelude start */ findPreludeStart(cssText, blockStart, braceStart));
        const prelude = cssText.slice(findPreludeStart(cssText, blockStart, braceStart), braceStart).trim();
        const body = cssText.slice(braceStart + 1, i);
        if (filler && /\S/.test(filler)) {
          blocks.push({ prelude: null, body: '', raw: filler });
        }
        blocks.push({
          prelude,
          body,
          raw: cssText.slice(braceStart - prelude.length /* approx */, i + 1),
        });
        blockStart = i + 1;
        braceStart = -1;
      }
      i++;
      continue;
    }
    i++;
  }
  // Trailing filler (whitespace / comments after the last block).
  if (blockStart < len) {
    const tail = cssText.slice(blockStart);
    if (/\S/.test(tail)) blocks.push({ prelude: null, body: '', raw: tail });
  }
  return blocks;
}

/**
 * Find where the prelude begins (skip leading whitespace + standalone
 * comments after `blockStart`). Used so a comment between two rules stays
 * grouped with the previous rule's filler rather than the next rule's
 * prelude.
 */
function findPreludeStart(cssText, blockStart, braceStart) {
  let i = blockStart;
  while (i < braceStart) {
    const ch = cssText[i];
    const next = i + 1 < cssText.length ? cssText[i + 1] : '';
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && next === '*') {
      // Skip past comment.
      const end = cssText.indexOf('*/', i + 2);
      if (end < 0) return i; // unterminated → bail
      i = end + 2;
      continue;
    }
    return i;
  }
  return i;
}

/**
 * Split a selector list on top-level commas (respecting parens for
 * `:is(...)`, `:where(...)`, `:not(...)`, attribute selectors with brackets,
 * etc.). Returns a list of trimmed selector strings.
 */
function splitSelectorList(selectorList) {
  const parts = [];
  let parens = 0;
  let brackets = 0;
  let inString = null;
  let start = 0;
  for (let i = 0; i < selectorList.length; i++) {
    const ch = selectorList[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
    else if (ch === ',' && parens === 0 && brackets === 0) {
      parts.push(selectorList.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(selectorList.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * Rewrite a single selector so it applies ONLY to the slide subtree.
 * Returns `null` to drop the selector (e.g. `html`, `body`, `:root`).
 *
 * The choice between attached scope (`:where(scope)<sel>`) and descendant
 * scope (`:where(scope) <sel>`) hinges on whether the selector is meant to
 * match the slide root div itself or one of its descendants. Selectors
 * that target `.step` (the slide root's class) or `[data-testid="step-..."]`
 * are attached. Everything else is descendant-scoped.
 */
function scopeOneSelector(sel, scope) {
  const trimmed = sel.trim();
  if (!trimmed) return null;

  // Drop selectors that target the document root (or its children with no
  // wrap-able ancestor). They cannot meaningfully be scoped to a child of
  // the host body.
  if (/^(?:html|body|:root)\b/i.test(trimmed)) return null;

  // Selectors that target the slide root itself (the div carrying the
  // step's data-testid + `.step` class) get attached scope so they don't
  // become descendant-only.
  //   `.step`                         → `:where(scope).step`
  //   `.step.active`                  → `:where(scope).step.active`
  //   `.step:hover`                   → `:where(scope).step:hover`
  //   `[data-testid="step-foo"]`      → `:where(scope)[data-testid="step-foo"]`
  if (/^\.step(?:\b|\.|:|\[)/.test(trimmed)) {
    return `:where(${scope})${trimmed}`;
  }
  if (/^\[data-testid="step-/i.test(trimmed)) {
    return `:where(${scope})${trimmed}`;
  }

  // Default: descendant scope. Universal selectors (`*`, `*::before`,
  // `*::after`) become `:where(scope) *`, which correctly limits the
  // slide's universal reset (`*{margin:0;padding:0}`) to slide descendants
  // and keeps it OUT of the host.
  return `:where(${scope}) ${trimmed}`;
}

/**
 * At-rules whose body contains nested rules that need scoping.
 */
const NESTED_AT_RULES = new Set(['media', 'supports', 'container']);
/**
 * At-rules whose body should NOT be touched (animation names / fonts /
 * imports are global by design; rewriting them risks breaking refs).
 */
const PASSTHROUGH_AT_RULES = new Set([
  'keyframes',
  '-webkit-keyframes',
  '-moz-keyframes',
  '-o-keyframes',
  'font-face',
  'page',
  'charset',
  'import',
  'namespace',
  'property',
  'counter-style',
  'font-feature-values',
]);

function getAtRuleName(prelude) {
  const m = prelude.match(/^@([\w-]+)/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Rewrite one block (rule or at-rule) for the given scope. Returns the
 * rewritten CSS text for the block, or `''` to drop it entirely.
 */
function rewriteBlock(prelude, body, scope) {
  if (prelude === null) {
    // Filler (comment / whitespace).
    return body;
  }

  if (prelude.startsWith('@')) {
    const name = getAtRuleName(prelude);
    if (name && NESTED_AT_RULES.has(name)) {
      // Recurse into the body.
      const inner = scopeCssBody(body, scope);
      return `${prelude} {\n${inner}\n}`;
    }
    if (name && PASSTHROUGH_AT_RULES.has(name)) {
      return `${prelude} {${body}}`;
    }
    // Unknown at-rule (e.g. `@layer foo { ... }`): leave alone.
    return `${prelude} {${body}}`;
  }

  // Selector list.
  const selectors = splitSelectorList(prelude);
  const scoped = selectors.map((s) => scopeOneSelector(s, scope)).filter(Boolean);
  if (scoped.length === 0) {
    // All selectors dropped → drop the whole rule.
    return '';
  }
  return `${scoped.join(', ')} {${body}}`;
}

/**
 * Scope a CSS body (which may contain multiple top-level rules + filler).
 */
function scopeCssBody(cssText, scope) {
  if (!cssText) return '';
  const blocks = splitTopLevelBlocks(cssText);
  const out = [];
  for (const b of blocks) {
    if (b.prelude === null) {
      out.push(b.raw);
      continue;
    }
    const rewritten = rewriteBlock(b.prelude, b.body, scope);
    if (rewritten) out.push(rewritten);
  }
  return out.join('').replace(/\n{3,}/g, '\n\n');
}

/**
 * Scope the contents of a `<style>...</style>` block (or a raw CSS string)
 * to a specific slide step's data-testid. The returned CSS only applies
 * inside the slide subtree.
 *
 * @param {string} input        Raw CSS text OR a `<style>...</style>` HTML
 *                              fragment.
 * @param {string} slideStepId  The slide's data-testid suffix (the part
 *                              after `step-`).
 * @returns {string}            Scoped CSS. If `input` was a `<style>` tag,
 *                              the returned text is also wrapped in a
 *                              matching `<style>` tag (preserving any
 *                              attributes from the original tag).
 */
function scopeSlideCss(input, slideStepId) {
  if (typeof input !== 'string' || !input) return '';
  if (!slideStepId) return input;

  const scope = `[data-testid="step-${String(slideStepId).replace(/"/g, '\\"')}"]`;

  // If wrapped in <style>...</style>, peel off, scope, and re-wrap.
  const styleTagMatch = input.match(/^([ \t]*<style\b[^>]*>)([\s\S]*?)(<\/style>[ \t]*)$/i);
  if (styleTagMatch) {
    const open = styleTagMatch[1];
    const css = styleTagMatch[2];
    const close = styleTagMatch[3];
    return `${open}\n${scopeCssBody(css, scope).trim()}\n${close}`;
  }

  return scopeCssBody(input, scope);
}

module.exports = {
  scopeSlideCss,
  // Exported for unit tests:
  scopeCssBody,
  scopeOneSelector,
  splitSelectorList,
  splitTopLevelBlocks,
};
