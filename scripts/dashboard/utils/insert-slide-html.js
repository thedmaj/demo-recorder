'use strict';
/**
 * insert-slide-html.js
 *
 * When the dashboard's `/api/runs/:runId/insert-library-slide` endpoint
 * adds a slide to `demo-script.json`, the running demo-app preview
 * server has nothing to display until the next pipeline run because the
 * slide's HTML never gets spliced into `<run>/scratch-app/index.html`.
 *
 * This helper closes that gap by reading the library slide's HTML
 * fragment and splicing it into the running app's index.html — same
 * mechanism the orchestrator's `post-slides` stage uses, just invoked
 * eagerly at insert time so the user can see the slide on next reload.
 *
 * Pure helper: no Express, no SSE, no logging. Returns a structured
 * result so the caller decides whether to broadcast a reload event.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

// Reuse the canonical splicer from post-slides so behavior matches
// what the pipeline does at the post-slides stage.
const { spliceSlideFragmentIntoHtml } = require(
  path.join(PROJECT_ROOT, 'scripts', 'scratch', 'scratch', 'post-slides.js')
);

/**
 * Rewire a step's primary CTA to advance to a different next step.
 *
 * When a slide is inserted between step A and step B, A's primary button
 * still calls `goToStep('B')` — clicking it skips the slide. This helper
 * finds the primary CTA inside the previous step's div and rewrites its
 * `onclick` to `goToStep('<slideStepId>')` so the user lands on the slide.
 *
 * Picks the CTA in this order:
 *   1. First `<button>` with `class="...btn-primary..."` and an `onclick`
 *      that calls `goToStep('...')`.
 *   2. First `<button>` with any `goToStep('...')` onclick.
 *   3. First clickable `.card[onclick*="goToStep"]` (some scenes use a
 *      whole card as the CTA — e.g. dashboard tiles).
 *
 * Returns `{ html, rewired, reason, previousTarget }`. Pure helper — no I/O.
 */
function rewirePreviousStepCta(html, prevStepId, slideStepId) {
  if (typeof html !== 'string' || !html) {
    return { html, rewired: false, reason: 'empty-html', previousTarget: null };
  }
  if (!prevStepId || !slideStepId) {
    return { html, rewired: false, reason: 'missing-args', previousTarget: null };
  }
  const safeId = String(prevStepId).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  // Match the previous step's div block (open tag + content up to the next
  // step / side-panels marker / </body>). Mirrors the sentinel pattern used
  // elsewhere so we don't grab content outside the step.
  const blockRe = new RegExp(
    `(<div[^>]*\\bdata-testid="step-${safeId}"[^>]*>)([\\s\\S]*?)` +
    `(?=<div[^>]*\\bdata-testid="step-|<!--[\\s\\S]*?[Ss]ide [Pp]anels|` +
    `<div[^>]*\\bid="(?:link-events-panel|api-response-panel)"|<\\/body>|$)`,
    'i'
  );
  const m = html.match(blockRe);
  if (!m) return { html, rewired: false, reason: 'prev-step-not-found', previousTarget: null };

  const prevBlock = m[0];
  const openTag = m[1];
  const blockContent = m[2];

  // Collect candidate CTAs inside the previous step's content.
  const candidates = [];
  const buttonRe = /<button\b[^>]*\bonclick\s*=\s*"[^"]*\bgoToStep\(\s*['"]([^'"]+)['"]\s*\)[^"]*"[^>]*>/gi;
  let bm;
  while ((bm = buttonRe.exec(blockContent)) !== null) {
    candidates.push({
      kind: /\bbtn-primary\b/.test(bm[0]) ? 'primary-button' : 'button',
      full: bm[0],
      target: bm[1],
      index: bm.index,
    });
  }
  if (candidates.length === 0) {
    // Fallback: a clickable `.card` with an onclick that calls goToStep.
    const cardRe = /<div\b[^>]*\bclass="[^"]*\bcard\b[^"]*"[^>]*\bonclick\s*=\s*"[^"]*\bgoToStep\(\s*['"]([^'"]+)['"]\s*\)[^"]*"[^>]*>/gi;
    let cm;
    while ((cm = cardRe.exec(blockContent)) !== null) {
      candidates.push({ kind: 'card', full: cm[0], target: cm[1], index: cm.index });
    }
  }
  if (candidates.length === 0) {
    return { html, rewired: false, reason: 'no-cta-found', previousTarget: null };
  }

  // Prefer the first primary-button; otherwise the first candidate of any kind.
  const chosen =
    candidates.find((c) => c.kind === 'primary-button') ||
    candidates[0];

  if (chosen.target === slideStepId) {
    return { html, rewired: false, reason: 'already-points-at-slide', previousTarget: chosen.target };
  }

  const updatedFull = chosen.full.replace(
    /\bgoToStep\(\s*['"][^'"]+['"]\s*\)/,
    `goToStep('${slideStepId}')`
  );
  const updatedContent =
    blockContent.slice(0, chosen.index) +
    updatedFull +
    blockContent.slice(chosen.index + chosen.full.length);
  const updatedBlock = openTag + updatedContent;

  return {
    html: html.replace(prevBlock, updatedBlock),
    rewired: true,
    reason: `cta-rewired:${chosen.kind}`,
    previousTarget: chosen.target,
  };
}

/**
 * Splice a library slide's HTML into the running demo app's index.html.
 *
 * The library slide file lives at `slide.htmlPath` (relative to PROJECT_ROOT,
 * always inside `out/slide-library/slides/<slug>/index.html`). The function:
 *
 *   1. Reads slide HTML from disk.
 *   2. Reads the run's index.html (preferring the legacy mirror
 *      `<run>/scratch-app/index.html` since that's what the demo-app preview
 *      server serves; falls back to `artifacts/build/scratch-app/`).
 *   3. Calls `spliceSlideFragmentIntoHtml(html, stepId, fragment, { insertAfterId })`.
 *      With `insertAfterId`, the slide is spliced RIGHT AFTER that step's
 *      closing div (DOM order = script order — required for the host's
 *      arrow-key + click-to-advance handlers to walk to the slide as
 *      "the next step"). Without it, slide is appended before the
 *      side-panels marker (legacy fallback).
 *   4. Rewires the previous step's primary CTA via `rewirePreviousStepCta`
 *      so clicking that button lands on the slide instead of skipping it.
 *   5. Writes the updated HTML back. Mirrors the write to BOTH `scratch-app/`
 *      paths if both exist, so a subsequent QA / record stage sees consistent
 *      content.
 *
 * Args:
 *   runDir   — absolute path to the run directory.
 *   stepId   — the slide's step id (will become `data-testid="step-<id>"`).
 *   slide    — `{ htmlPath: <relative path inside out/slide-library/...> }`.
 *   options  — `{ insertAfterId?: string }`. The id of the step the slide is
 *              inserted AFTER (from the dashboard). Pass it whenever the
 *              caller knows the previous step — required for correct DOM
 *              order, arrow-key navigation, and CTA rewiring. Optional for
 *              legacy callsites; absence falls back to the side-panels
 *              append behavior with no CTA rewire.
 *
 * Returns:
 *   {
 *     applied:        boolean,    // true if the splice happened
 *     reason:         string,     // splice helper's reason string
 *     htmlPath:       string|null,
 *     mirrorPath:     string|null,
 *     ctaRewired:     boolean,    // true if previous step's CTA was rewired
 *     ctaRewireReason: string|null,
 *     stylesInjected: number,     // count of <style> blocks added to <head>
 *     skipped:        boolean,
 *     skippedReason:  string|null,
 *   }
 *
 * Never throws on missing inputs — returns `{ skipped: true, ... }` so the
 * calling endpoint stays resilient to partial library slides.
 */
function spliceLibrarySlideIntoRunHtml(runDir, stepId, slide, options = {}) {
  const insertAfterId = options && options.insertAfterId
    ? String(options.insertAfterId).trim()
    : '';

  if (!runDir || !stepId) {
    return { applied: false, skipped: true, skippedReason: 'missing-rundir-or-stepid', htmlPath: null, mirrorPath: null, reason: null, ctaRewired: false, ctaRewireReason: null, stylesInjected: 0 };
  }
  if (!slide || typeof slide !== 'object' || !slide.htmlPath) {
    return { applied: false, skipped: true, skippedReason: 'slide-has-no-htmlpath', htmlPath: null, mirrorPath: null, reason: null, ctaRewired: false, ctaRewireReason: null, stylesInjected: 0 };
  }

  const fragmentAbs = path.resolve(PROJECT_ROOT, slide.htmlPath);
  // Path-traversal guard: the slide library lives under out/slide-library.
  // Reject any htmlPath that resolves outside it.
  const SLIDE_LIBRARY_DIR = path.join(PROJECT_ROOT, 'out', 'slide-library');
  if (!fragmentAbs.startsWith(SLIDE_LIBRARY_DIR + path.sep)) {
    return { applied: false, skipped: true, skippedReason: 'slide-outside-library-dir', htmlPath: null, mirrorPath: null, reason: null, ctaRewired: false, ctaRewireReason: null, stylesInjected: 0 };
  }
  if (!fs.existsSync(fragmentAbs)) {
    return { applied: false, skipped: true, skippedReason: 'slide-html-missing', htmlPath: null, mirrorPath: null, reason: null, ctaRewired: false, ctaRewireReason: null, stylesInjected: 0 };
  }

  // Pick the run's index.html. The demo-app preview server serves
  // `<run>/scratch-app/index.html` (the "legacy mirror") — that's the file
  // the user is looking at in their browser. Always write that one. If the
  // canonical artifacts/build/scratch-app/index.html also exists, mirror to
  // it so subsequent QA / record stages are consistent.
  const legacyHtmlPath  = path.join(runDir, 'scratch-app', 'index.html');
  const canonicalHtmlPath = path.join(runDir, 'artifacts', 'build', 'scratch-app', 'index.html');

  let primaryHtmlPath = null;
  if (fs.existsSync(legacyHtmlPath)) {
    primaryHtmlPath = legacyHtmlPath;
  } else if (fs.existsSync(canonicalHtmlPath)) {
    primaryHtmlPath = canonicalHtmlPath;
  } else {
    return { applied: false, skipped: true, skippedReason: 'no-index-html-in-run', htmlPath: null, mirrorPath: null, reason: null, ctaRewired: false, ctaRewireReason: null, stylesInjected: 0 };
  }

  let html;
  try { html = fs.readFileSync(primaryHtmlPath, 'utf8'); }
  catch (err) { return { applied: false, skipped: true, skippedReason: `read-failed: ${err.message}`, htmlPath: null, mirrorPath: null, reason: null, ctaRewired: false, ctaRewireReason: null, stylesInjected: 0 }; }

  let fragment;
  try { fragment = fs.readFileSync(fragmentAbs, 'utf8'); }
  catch (err) { return { applied: false, skipped: true, skippedReason: `fragment-read-failed: ${err.message}`, htmlPath: null, mirrorPath: null, reason: null, ctaRewired: false, ctaRewireReason: null, stylesInjected: 0 }; }

  const spliceOptions = insertAfterId ? { insertAfterId } : {};
  const result = spliceSlideFragmentIntoHtml(html, stepId, fragment, spliceOptions);
  if (!result.applied) {
    return {
      applied: false,
      skipped: false,
      skippedReason: null,
      htmlPath: null,
      mirrorPath: null,
      reason: result.reason || 'splice-failed',
      ctaRewired: false,
      ctaRewireReason: null,
      stylesInjected: 0,
    };
  }

  // After splicing, rewire the previous step's primary CTA so clicking it
  // advances to the slide rather than skipping it. Best-effort: if the
  // previous step or its CTA can't be found, the splice still stands and
  // arrow-key navigation + click-anywhere still work because we placed the
  // slide div in the correct DOM order.
  let finalHtml = result.html;
  let ctaRewired = false;
  let ctaRewireReason = null;
  if (insertAfterId) {
    const wired = rewirePreviousStepCta(finalHtml, insertAfterId, stepId);
    finalHtml = wired.html;
    ctaRewired = wired.rewired;
    ctaRewireReason = wired.reason;
  } else {
    ctaRewireReason = 'no-insert-after-id';
  }

  try {
    const tmp = primaryHtmlPath + '.tmp';
    fs.writeFileSync(tmp, finalHtml, 'utf8');
    fs.renameSync(tmp, primaryHtmlPath);
  } catch (err) {
    return { applied: false, skipped: true, skippedReason: `write-failed: ${err.message}`, htmlPath: null, mirrorPath: null, reason: null, ctaRewired: false, ctaRewireReason: null, stylesInjected: 0 };
  }

  // Best-effort mirror to the other location if it exists (don't fail if it
  // can't be written — primary already succeeded).
  let mirrorPath = null;
  const otherPath = primaryHtmlPath === legacyHtmlPath ? canonicalHtmlPath : legacyHtmlPath;
  if (otherPath !== primaryHtmlPath && fs.existsSync(otherPath)) {
    try {
      const tmp2 = otherPath + '.tmp';
      fs.writeFileSync(tmp2, finalHtml, 'utf8');
      fs.renameSync(tmp2, otherPath);
      mirrorPath = otherPath;
    } catch (_) { /* mirror is best-effort */ }
  }

  return {
    applied: true,
    skipped: false,
    skippedReason: null,
    htmlPath: primaryHtmlPath,
    mirrorPath,
    reason: result.reason,
    ctaRewired,
    ctaRewireReason,
    stylesInjected: typeof result.styleCount === 'number' ? result.styleCount : 0,
  };
}

/**
 * Strip a step's `<div data-testid="step-<id>">…</div>` block from an HTML
 * string. Used by the "remove slide" flow so the running demo app actually
 * loses the slide on next reload (we already updated demo-script.json
 * separately; this catches the HTML side).
 *
 * Boundary: we match the step's div start tag and consume up to (but not
 * including) the next `<div data-testid="step-`, the side-panels marker,
 * `</body>`, or end-of-string — same pattern post-slides + qa-touchup +
 * figma-conversion all use to extract a step block. Returns
 * `{ html, removed: bool, reason: string }`.
 *
 * Pure function — no I/O.
 */
function removeStepBlockFromHtml(html, stepId) {
  if (typeof html !== 'string' || !html) return { html, removed: false, reason: 'empty-input' };
  if (!stepId) return { html, removed: false, reason: 'no-stepid' };
  const safeId = String(stepId).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  // Match the step's opening div + everything up to the next step div /
  // side-panels marker / </body> / end-of-string. Greedy stop-on-sentinel
  // mirrors stepBlockRegex from post-slides.js and extractStepHtmlBlock
  // from figma-conversion.js (we already fixed the trailing-step edge
  // case in those — same fix applies here).
  const re = new RegExp(
    `<div[^>]*\\bdata-testid="step-${safeId}"[^>]*>[\\s\\S]*?` +
    `(?=<div[^>]*\\bdata-testid="step-|<!--[\\s\\S]*?SIDE PANELS|` +
    `<div[^>]*\\bid="(?:link-events-panel|api-response-panel)"|<\\/body>|$)`,
    'i'
  );
  const m = String(html).match(re);
  if (!m) return { html, removed: false, reason: 'step-block-not-found' };
  // Strip the matched block + any trailing whitespace it left behind so we
  // don't accumulate ragged blank lines on repeated insert/remove cycles.
  const cleaned = html.replace(re, '').replace(/\n{3,}/g, '\n\n');
  return { html: cleaned, removed: true, reason: 'step-block-removed' };
}

/**
 * Remove a step's HTML block from the run's index.html (legacy mirror +
 * canonical artifacts/build/scratch-app/ when both exist). Idempotent —
 * returns `{ removed: false, ... }` when nothing matched, never throws.
 */
function removeStepBlockFromRunHtml(runDir, stepId) {
  if (!runDir || !stepId) {
    return { removedFrom: [], notFoundIn: [], skipped: true, skippedReason: 'missing-rundir-or-stepid' };
  }
  const candidates = [
    path.join(runDir, 'scratch-app', 'index.html'),
    path.join(runDir, 'artifacts', 'build', 'scratch-app', 'index.html'),
  ].filter((p) => fs.existsSync(p));
  if (candidates.length === 0) {
    return { removedFrom: [], notFoundIn: [], skipped: true, skippedReason: 'no-index-html' };
  }

  const removedFrom = [];
  const notFoundIn = [];
  for (const p of candidates) {
    let html;
    try { html = fs.readFileSync(p, 'utf8'); }
    catch (_) { notFoundIn.push(p); continue; }
    const result = removeStepBlockFromHtml(html, stepId);
    if (!result.removed) { notFoundIn.push(p); continue; }
    try {
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, result.html, 'utf8');
      fs.renameSync(tmp, p);
      removedFrom.push(p);
    } catch (_) { /* best-effort per file */ }
  }
  return {
    removedFrom,
    notFoundIn,
    skipped: false,
    skippedReason: null,
  };
}

module.exports = {
  spliceLibrarySlideIntoRunHtml,
  rewirePreviousStepCta,
  removeStepBlockFromHtml,
  removeStepBlockFromRunHtml,
};
