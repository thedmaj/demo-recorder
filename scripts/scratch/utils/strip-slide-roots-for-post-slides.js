'use strict';
/**
 * Reset slide-kind step blocks to placeholders without `.slide-root` so
 * post-slides will LLM-insert with the current prompt contract.
 *
 * The canonical placeholder shape emitted here is shared with the build-app
 * minimal-tier prompt (see `buildCanonicalSlidePlaceholder` below). All three
 * regex helpers in the codebase grep for the same outer wrapper:
 *   - post-slides.spliceSlideFragmentIntoHtml (stepBlockRegex)
 *   - dashboard/utils/insert-slide-html.removeStepBlockFromHtml
 *   - figma-conversion.extractStepHtmlBlock
 * All three match `<div ... data-testid="step-{id}" ...>...</div>` so the
 * outer shape must stay stable. Inner placeholder content is free-form.
 *
 * Usage:
 *   PIPELINE_RUN_DIR=out/demos/<run> node scripts/scratch/utils/strip-slide-roots-for-post-slides.js
 *   PIPELINE_RUN_DIR=out/demos/<run> node scripts/scratch/utils/strip-slide-roots-for-post-slides.js --steps=a,b
 *
 * Programmatic:
 *   const { stripSlideRoots, buildCanonicalSlidePlaceholder } = require('./strip-slide-roots-for-post-slides');
 *   const { stripped } = stripSlideRoots({ runDir, steps: ['value-summary-slide'] });
 */
const fs = require('fs');
const path = require('path');
const { annotateScriptWithStepKinds, isSlideStep } = require('./step-kind');

/**
 * Single source of truth for the canonical slide-pending placeholder.
 * `buildMode === 'app+slides'` MUST be true before any caller emits one of
 * these — app-only runs should never contain `data-slide-pending="true"`
 * markers (see scanAppOnlyNoSlides in build-qa.js).
 *
 * @param {object} step          demo-script step (used to read .id, .label,
 *                               .slideTemplate)
 * @returns {string}             HTML fragment
 */
function buildCanonicalSlidePlaceholder(step) {
  const id = String((step && step.id) || '').trim();
  if (!id) throw new Error('buildCanonicalSlidePlaceholder: step.id is required');
  const tmplRaw = (step && step.slideTemplate) ? String(step.slideTemplate).trim().toUpperCase() : '';
  const tmpl = /^T\d+$/.test(tmplRaw) ? tmplRaw : 'T1';
  const labelRaw = (step && step.label) ? String(step.label) : '';
  const label = labelRaw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const labelLine = label ? ` &middot; ${label}` : '';
  return (
    `<div data-testid="step-${id}" class="step">\n` +
    `  <div class="slide-pending-host" data-slide-pending="true" data-slide-template="${tmpl}">` +
    `<p style="font-size:24px">Slide placeholder${labelLine} &middot; awaiting post-slides.</p></div>\n</div>`
  );
}

function stepBlockRegex(stepId) {
  const id = String(stepId).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(
    `<div[^>]*\\bdata-testid="step-${id}"[^>]*>[\\s\\S]*?(?=<div[^>]*\\bdata-testid="step-|<!--[\\s\\S]*?SIDE PANELS|<div[^>]*\\bid="(?:link-events-panel|api-response-panel)"|<\\/body>)`,
    'i'
  );
}

/**
 * Programmatic API. Strips the listed slide step blocks (or all slide-kind
 * steps when `steps` is null/undefined) by replacing them with a placeholder
 * that post-slides will fill via LLM insertion.
 *
 * @param {object} opts
 * @param {string} opts.runDir            Run directory (required).
 * @param {string[]|null} [opts.steps]    Optional whitelist of slide step ids.
 * @returns {{ stripped: string[], skipped: string[] }}
 */
function stripSlideRoots({ runDir, steps = null } = {}) {
  if (!runDir) throw new Error('strip-slide-roots: runDir is required');
  const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
  const scriptPath = path.join(runDir, 'demo-script.json');
  if (!fs.existsSync(htmlPath)) throw new Error(`strip-slide-roots: scratch-app/index.html not found in ${runDir}`);
  if (!fs.existsSync(scriptPath)) throw new Error(`strip-slide-roots: demo-script.json not found in ${runDir}`);
  let html = fs.readFileSync(htmlPath, 'utf8');
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  annotateScriptWithStepKinds(script);
  const allSlides = (script.steps || []).filter(isSlideStep);
  const whitelist = Array.isArray(steps) && steps.length > 0
    ? new Set(steps.map(String))
    : null;
  const targets = whitelist ? allSlides.filter((s) => whitelist.has(String(s.id))) : allSlides;
  const stripped = [];
  const skipped = [];
  for (const s of targets) {
    const re = stepBlockRegex(s.id);
    const m = html.match(re);
    if (!m) { skipped.push(s.id); continue; }
    html = html.replace(m[0], buildCanonicalSlidePlaceholder(s));
    stripped.push(s.id);
  }
  if (stripped.length > 0) fs.writeFileSync(htmlPath, html);
  return { stripped, skipped };
}

function parseArgs(argv) {
  let steps = null;
  for (const a of argv) {
    if (a.startsWith('--steps=')) {
      steps = a.slice('--steps='.length).split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return { steps };
}

function main() {
  const runDir = process.env.PIPELINE_RUN_DIR;
  if (!runDir) {
    console.error('PIPELINE_RUN_DIR is required');
    process.exit(1);
  }
  const { steps } = parseArgs(process.argv.slice(2));
  try {
    const { stripped, skipped } = stripSlideRoots({ runDir, steps });
    console.log(`[strip] Reset ${stripped.length} slide step(s): ${stripped.join(', ') || '(none)'}`);
    if (skipped.length) console.warn(`[strip] Skipped ${skipped.length} (missing block): ${skipped.join(', ')}`);
  } catch (e) {
    console.error(`[strip] ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  stripSlideRoots,
  stepBlockRegex,
  buildCanonicalSlidePlaceholder,
};

if (require.main === module) {
  main();
}
