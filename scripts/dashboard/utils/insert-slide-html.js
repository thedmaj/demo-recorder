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
 * Splice a library slide's HTML into the running demo app's index.html.
 *
 * The library slide file lives at `slide.htmlPath` (relative to PROJECT_ROOT,
 * always inside `out/slide-library/slides/<slug>/index.html`). The function:
 *
 *   1. Reads slide HTML from disk.
 *   2. Reads the run's index.html (preferring the legacy mirror
 *      `<run>/scratch-app/index.html` since that's what the demo-app preview
 *      server serves; falls back to `artifacts/build/scratch-app/`).
 *   3. Calls `spliceSlideFragmentIntoHtml(html, stepId, fragment)` — same
 *      splice logic as `post-slides`. If the step has an existing div, it's
 *      replaced; otherwise the slide is appended before the side-panels marker.
 *   4. Writes the updated HTML back. Mirrors the write to BOTH `scratch-app/`
 *      paths if both exist, so a subsequent QA / record stage sees consistent
 *      content.
 *
 * Returns:
 *   {
 *     applied:     boolean,             // true if the splice happened
 *     reason:      string,              // splice helper's reason string
 *     htmlPath:    string|null,         // path to the HTML we wrote
 *     mirrorPath:  string|null,         // optional second path mirrored
 *     skipped:     boolean,             // true when nothing to splice (slide had no htmlPath, etc.)
 *     skippedReason: string|null,
 *   }
 *
 * Never throws on missing inputs — returns `{ skipped: true, ... }` so the
 * calling endpoint stays resilient to partial library slides.
 */
function spliceLibrarySlideIntoRunHtml(runDir, stepId, slide) {
  if (!runDir || !stepId) {
    return { applied: false, skipped: true, skippedReason: 'missing-rundir-or-stepid', htmlPath: null, mirrorPath: null, reason: null };
  }
  if (!slide || typeof slide !== 'object' || !slide.htmlPath) {
    return { applied: false, skipped: true, skippedReason: 'slide-has-no-htmlpath', htmlPath: null, mirrorPath: null, reason: null };
  }

  const fragmentAbs = path.resolve(PROJECT_ROOT, slide.htmlPath);
  // Path-traversal guard: the slide library lives under out/slide-library.
  // Reject any htmlPath that resolves outside it.
  const SLIDE_LIBRARY_DIR = path.join(PROJECT_ROOT, 'out', 'slide-library');
  if (!fragmentAbs.startsWith(SLIDE_LIBRARY_DIR + path.sep)) {
    return { applied: false, skipped: true, skippedReason: 'slide-outside-library-dir', htmlPath: null, mirrorPath: null, reason: null };
  }
  if (!fs.existsSync(fragmentAbs)) {
    return { applied: false, skipped: true, skippedReason: 'slide-html-missing', htmlPath: null, mirrorPath: null, reason: null };
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
    return { applied: false, skipped: true, skippedReason: 'no-index-html-in-run', htmlPath: null, mirrorPath: null, reason: null };
  }

  let html;
  try { html = fs.readFileSync(primaryHtmlPath, 'utf8'); }
  catch (err) { return { applied: false, skipped: true, skippedReason: `read-failed: ${err.message}`, htmlPath: null, mirrorPath: null, reason: null }; }

  let fragment;
  try { fragment = fs.readFileSync(fragmentAbs, 'utf8'); }
  catch (err) { return { applied: false, skipped: true, skippedReason: `fragment-read-failed: ${err.message}`, htmlPath: null, mirrorPath: null, reason: null }; }

  const result = spliceSlideFragmentIntoHtml(html, stepId, fragment);
  if (!result.applied) {
    return {
      applied: false,
      skipped: false,
      skippedReason: null,
      htmlPath: null,
      mirrorPath: null,
      reason: result.reason || 'splice-failed',
    };
  }

  try {
    const tmp = primaryHtmlPath + '.tmp';
    fs.writeFileSync(tmp, result.html, 'utf8');
    fs.renameSync(tmp, primaryHtmlPath);
  } catch (err) {
    return { applied: false, skipped: true, skippedReason: `write-failed: ${err.message}`, htmlPath: null, mirrorPath: null, reason: null };
  }

  // Best-effort mirror to the other location if it exists (don't fail if it
  // can't be written — primary already succeeded).
  let mirrorPath = null;
  const otherPath = primaryHtmlPath === legacyHtmlPath ? canonicalHtmlPath : legacyHtmlPath;
  if (otherPath !== primaryHtmlPath && fs.existsSync(otherPath)) {
    try {
      const tmp2 = otherPath + '.tmp';
      fs.writeFileSync(tmp2, result.html, 'utf8');
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
  };
}

module.exports = {
  spliceLibrarySlideIntoRunHtml,
};
