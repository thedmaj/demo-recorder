'use strict';
/**
 * post-slides.js
 *
 * Agent-driven per-slide insertion stage. Runs AFTER the host app has been
 * built and QA'd in app-only mode, OR when the storyboard later inserts slide
 * steps into an existing run. For each demo-script step where
 * `stepKind === 'slide'` and the rendered `scratch-app/index.html` has no
 * matching `.slide-root` block, we call the LLM with a narrowly-scoped
 * single-slide prompt (no giant slide template trio stuffed into system),
 * then deterministically splice the returned fragment into the HTML.
 *
 * This trades one-shot-all-slides quality for per-slide focus: the full token
 * budget goes to one slide at a time, so each slide gets high-quality copy,
 * endpoint framing, and layout. Follow-up scoped QA can re-invoke this stage
 * per step (`--steps=id1,id2`) for targeted rework.
 *
 * Reads:   PIPELINE_RUN_DIR/scratch-app/index.html
 *          PIPELINE_RUN_DIR/demo-script.json
 *          templates/slide-template/*
 *          PIPELINE_RUN_DIR/pipeline-run-context.json   (for brand + VPs, optional)
 *          PIPELINE_RUN_DIR/brand-extract.json          (for brand, optional)
 * Writes:  PIPELINE_RUN_DIR/scratch-app/index.html (spliced in-place)
 *          PIPELINE_RUN_DIR/post-slides-report.json
 *          PIPELINE_RUN_DIR/artifacts/build/post-slides-report.json
 *
 * Usage:
 *   PIPELINE_RUN_DIR=... node scripts/scratch/scratch/post-slides.js
 *   PIPELINE_RUN_DIR=... node scripts/scratch/scratch/post-slides.js --steps=a,b
 *   PIPELINE_RUN_DIR=... node scripts/scratch/scratch/post-slides.js --max-iters=1 --dry-run
 *
 * Env:
 *   ANTHROPIC_API_KEY         required
 *   POST_SLIDES_MODEL         default 'claude-opus-4-7'
 *   POST_SLIDES_MAX_TOKENS    default 6000
 */

require('../utils/load-env').loadEnv();
const fs = require('fs');
const path = require('path');

const { requireRunDir, getRunLayout, readRunManifest } = require('../utils/run-io');
const { annotateScriptWithStepKinds, isSlideStep } = require('../utils/step-kind');
const { buildSlideInsertionPrompt } = require('../utils/prompt-templates');
const { loadSlideDesignSkill } = require('../utils/slide-design-skill');
const { routeSlideTemplate } = require('../utils/slide-template-router');
const { getShowcaseTemplateSkeletonForRouting } = require('../utils/showcase-template-extract');
const { scopeSlideCss } = require('../utils/slide-css-scoper');
const {
  normalizeSlideTypography,
  injectSlideTypographyOverrides,
} = require('../utils/normalize-slide-typography');

const MODEL = process.env.POST_SLIDES_MODEL || 'claude-opus-4-7';
const MAX_TOKENS = Number(process.env.POST_SLIDES_MAX_TOKENS || 6000);
const DEFAULT_MAX_ITERS = 1;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function resolveHtmlPath(outDir, layout) {
  const root = path.join(outDir, 'scratch-app', 'index.html');
  if (fs.existsSync(root)) return root;
  const artifactRoot = path.join(layout.buildDir, 'scratch-app', 'index.html');
  if (fs.existsSync(artifactRoot)) return artifactRoot;
  return root;
}

function stepBlockRegex(stepId) {
  const id = String(stepId).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(
    `<div[^>]*\\bdata-testid="step-${id}"[^>]*>[\\s\\S]*?(?=<div[^>]*\\bdata-testid="step-|<!--[\\s\\S]*?SIDE PANELS[\\s\\S]*?-->|<div[^>]*\\bid="(?:link-events-panel|api-response-panel)"|<\\/body>)`,
    'i'
  );
}

function stepHasSlideRoot(html, stepId) {
  const re = stepBlockRegex(stepId);
  const m = html.match(re);
  if (!m) return false;
  return /\bslide-root\b/.test(m[0]);
}

function hostAlreadyHasAnySlide(html) {
  return /class="[^"]*\bslide-root\b/.test(html);
}

function hasStepContainer(html, stepId) {
  const id = String(stepId).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`<div[^>]*\\bdata-testid="step-${id}"[^>]*>`, 'i').test(html);
}

/**
 * Sanitize a raw slide fragment for splicing into the host app.
 *
 * Returns `{ html, styles }`:
 *   - `html`   = body-safe markup with a single outer `<div data-testid="step-<id>" class="step ...">`
 *                whose existing classes (e.g. `slide-root`) are preserved.
 *   - `styles` = array of full `<style>...</style>` blocks lifted out of the
 *                fragment (caller injects them into the host `<head>` so the
 *                slide's CSS — gradients, insight-layout, score cards, etc. —
 *                actually applies).
 *
 * Earlier behavior (string return, stripping `<style>`) lost the slide's
 * styling entirely AND prepended duplicate `class`/`data-testid` attributes
 * onto the outer div, which produced malformed HTML and an invisible (or
 * unstyled) slide. This implementation:
 *   - Extracts and preserves `<style>` blocks instead of stripping them.
 *   - Strips `<head>` content (the previous regex only removed the tags,
 *     leaving stray `<meta>`/`<title>` text leaking into the body).
 *   - Updates the outer `<div>`'s `data-testid` and `class` attributes
 *     IN PLACE — replacing existing values rather than prepending new ones.
 */
function sanitizeSlideFragment(fragment, stepId) {
  if (!fragment) return { html: '', styles: [] };
  let s = String(fragment).trim();
  s = s.replace(/^```(?:html|HTML)?\s*/m, '').replace(/```\s*$/m, '');

  // Extract <style> blocks BEFORE stripping anything else, so we can return
  // them for injection into the host <head>.
  const styles = [];
  s = s.replace(/<style[\s\S]*?<\/style>/gi, (match) => {
    styles.push(match);
    return '';
  });

  // Strip everything that doesn't belong in <body>. Note: we strip the
  // <head>...</head> block *as a whole* (not just the tags), and also nuke
  // any stray <meta>/<title>/<link> nodes that the LLM might emit outside
  // <head>. The previous regex only removed the head tags, so meta/title
  // contents leaked into the body as visible text.
  s = s.replace(/<!DOCTYPE[^>]*>/i, '');
  s = s.replace(/<\/?html[^>]*>/gi, '');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<meta[^>]*\/?>/gi, '');
  s = s.replace(/<link[^>]*\/?>/gi, '');
  s = s.replace(/<title[\s\S]*?<\/title>/gi, '');
  s = s.replace(/<\/?body[^>]*>/gi, '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.trim();

  if (!s) return { html: '', styles };

  const openingMatch = s.match(/<div[^>]*>/i);
  if (!openingMatch) return { html: '', styles };
  const opening = openingMatch[0];

  // Update outer-div attributes IN PLACE so we don't end up with duplicates.
  // Browsers keep the FIRST of any duplicated attribute and silently drop
  // the rest, which previously meant `class="slide-root"` (the slide's
  // styling hook) got dropped in favor of a prepended `class="step"`.
  let updatedOpening = opening;

  if (/\bdata-testid\s*=/.test(updatedOpening)) {
    updatedOpening = updatedOpening.replace(
      /\bdata-testid\s*=\s*"[^"]*"/i,
      `data-testid="step-${stepId}"`
    );
  } else {
    updatedOpening = updatedOpening.replace(
      /<div\b/,
      `<div data-testid="step-${stepId}"`
    );
  }

  const classMatch = updatedOpening.match(/\bclass\s*=\s*"([^"]*)"/i);
  if (classMatch) {
    const existing = classMatch[1].split(/\s+/).filter(Boolean);
    if (!existing.includes('step')) existing.unshift('step');
    updatedOpening = updatedOpening.replace(
      /\bclass\s*=\s*"[^"]*"/i,
      `class="${existing.join(' ')}"`
    );
  } else {
    updatedOpening = updatedOpening.replace(/<div\b/, `<div class="step"`);
  }

  s = s.replace(opening, updatedOpening);

  // Strip inline `style="display:..."` so a stale `display:none` left over
  // from the slide's authoring environment doesn't override the host's
  // `.step.active { display: ... }` rule once the slide becomes the active
  // step. Any other inline styles are preserved.
  s = s.replace(/\sstyle="[^"]*\bdisplay\s*:[^";]+;?[^"]*"/gi, '');

  return { html: s.trim(), styles };
}

/**
 * Inject extracted slide `<style>` blocks into the host's `<head>`, wrapped
 * in per-step marker comments so re-inserts don't keep stacking duplicate
 * style nodes.
 *
 * CRITICAL: every block is run through `scopeSlideCss` so its rules are
 * limited to the slide's subtree (`:where([data-testid="step-<id>"]) ...`).
 * Without this, slide CSS — universal resets, `html`/`body` rules, generic
 * `.step` rules — bleeds into the host app and clobbers its layout. The
 * scoper:
 *   - Drops `html`, `body`, and `:root` rules outright (cannot be scoped).
 *   - Prefixes selectors that target `.step` / `[data-testid="step-..."]`
 *     with the scope attached (no space) so they apply to the slide root
 *     div itself.
 *   - Prefixes everything else with `:where(scope) <sel>` so it applies
 *     only inside the slide.
 *
 * If the host has no `<head>`, fall back to before `<body>` or the top of
 * the document.
 */
function injectSlideStylesIntoHead(html, styles, stepId) {
  if (!Array.isArray(styles) || styles.length === 0) return html;
  const safeId = String(stepId).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const startMarker = `<!-- POST-SLIDES STYLES: ${stepId} -->`;
  const endMarker = `<!-- /POST-SLIDES STYLES: ${stepId} -->`;
  const reExisting = new RegExp(
    `<!--\\s*POST-SLIDES STYLES:\\s*${safeId}\\s*-->[\\s\\S]*?<!--\\s*/POST-SLIDES STYLES:\\s*${safeId}\\s*-->`,
    'g'
  );
  let out = html.replace(reExisting, '');

  // Scope each <style> block so its rules stay inside the slide subtree.
  // The scoper accepts either raw CSS or a full <style>...</style> tag and
  // returns the same shape; we pass the tag verbatim so any attributes on
  // the original tag (e.g. data-* hooks) survive.
  const scopedStyles = styles.map((s) => scopeSlideCss(s, stepId));
  const block = `${startMarker}\n${scopedStyles.join('\n')}\n${endMarker}`;

  if (/<\/head>/i.test(out)) {
    return out.replace(/<\/head>/i, `${block}\n</head>`);
  }
  if (/<body\b/i.test(out)) {
    return out.replace(/<body\b/i, `${block}\n<body`);
  }
  return block + '\n' + out;
}

function spliceSlideFragmentIntoHtml(html, stepId, fragment, options = {}) {
  const insertAfterId = options && options.insertAfterId
    ? String(options.insertAfterId).trim()
    : '';

  const { html: cleaned, styles } = sanitizeSlideFragment(fragment, stepId);
  const stamped = stampShowcaseTemplateId(cleaned, options.showcaseTemplateId);
  if (!stamped) {
    return { html, applied: false, reason: 'empty-fragment', styleCount: 0 };
  }

  // Always inject styles up-front (idempotent per step id).
  let workingHtml = injectSlideStylesIntoHead(html, styles, stepId);

  // If a step block for this id already exists, replace it in place.
  if (hasStepContainer(workingHtml, stepId)) {
    const re = stepBlockRegex(stepId);
    const m = workingHtml.match(re);
    if (m) {
      return {
        html: workingHtml.replace(m[0], stamped + '\n'),
        applied: true,
        reason: 'replaced-existing-step-block',
        styleCount: styles.length,
      };
    }
  }

  // Preferred: splice the slide div RIGHT AFTER the previous step's closing
  // div. This keeps DOM order in sync with demo-script.json order, which is
  // critical because the host's arrow-key handler and click-to-advance
  // handler both walk `.step` divs in DOM order to figure out "the next
  // step". Without this, arrow keys (and click-anywhere) skip the slide.
  if (insertAfterId && hasStepContainer(workingHtml, insertAfterId)) {
    const prevRe = stepBlockRegex(insertAfterId);
    const prevMatch = workingHtml.match(prevRe);
    if (prevMatch) {
      const prevBlock = prevMatch[0];
      const idx = workingHtml.indexOf(prevBlock) + prevBlock.length;
      const before = workingHtml.slice(0, idx);
      const after = workingHtml.slice(idx);
      // Ensure the inserted block ends with a trailing newline so the next
      // step's div starts on its own line — keeps stepBlockRegex sentinels
      // happy on subsequent splices.
      return {
        html: before + stamped + '\n' + after,
        applied: true,
        reason: 'inserted-after-prev-step',
        styleCount: styles.length,
      };
    }
  }

  // Fallback: append before the side-panels marker (legacy behavior). Used
  // when no `insertAfterId` is provided or the previous step doesn't exist
  // in the HTML yet (e.g. orchestrator's post-slides stage runs before the
  // host has all of its step divs rendered).
  const beforeEndMarker =
    workingHtml.indexOf('<!-- SIDE PANELS') >= 0 ? '<!-- SIDE PANELS' :
    workingHtml.indexOf('<!-- Side panels') >= 0 ? '<!-- Side panels' :
    workingHtml.indexOf('<div id="link-events-panel"') >= 0 ? '<div id="link-events-panel"' :
    workingHtml.indexOf('<div id="api-response-panel"') >= 0 ? '<div id="api-response-panel"' :
    '</body>';
  if (workingHtml.includes(beforeEndMarker)) {
    return {
      html: workingHtml.replace(beforeEndMarker, `${stamped}\n${beforeEndMarker}`),
      applied: true,
      reason: 'appended-before-side-panels',
      styleCount: styles.length,
    };
  }
  return { html: workingHtml, applied: false, reason: 'no-insertion-point', styleCount: styles.length };
}

const SLIDE_TEMPLATE_DIR = 'templates/slide-template';

function readUtf8File(p) {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  } catch (_) {
    return '';
  }
}

function loadSlideTemplates(PROJECT_ROOT) {
  const base = path.join(PROJECT_ROOT, SLIDE_TEMPLATE_DIR);
  const briefDir = path.join(base, 'brand-design-briefs');
  return {
    slideTemplateCss: readUtf8File(path.join(base, 'slide.css')),
    colorsAndTypeCss: readUtf8File(path.join(base, 'colors_and_type.css')),
    // Canonical pipeline contract — single source of truth for slide canvas
    // sizing + inner overflow + typography ceilings. Injected AFTER slide.css
    // so cascade order makes its rules authoritative. Replaces four prior
    // competing patches (see file header).
    pipelineSlideContractCss: readUtf8File(path.join(base, 'pipeline-slide-contract.css')),
    slideTemplateRules: readUtf8File(path.join(base, 'PIPELINE_SLIDE_SHELL_RULES.md')),
    slideTemplateShellHtml: readUtf8File(path.join(base, 'pipeline-slide-shell.html')),
    deckDesignSystem: readUtf8File(path.join(briefDir, 'DECK_DESIGN_SYSTEM.md')),
    deckTemplates: readUtf8File(path.join(briefDir, 'DECK_TEMPLATES.md')),
    deckComposition: readUtf8File(path.join(briefDir, 'DECK_COMPOSITION.md')),
  };
}

/**
 * Copy bundled fonts + logos into scratch-app once per post-slides run.
 * Paths in slide HTML/CSS use assets/logos/... and fonts/... relative to scratch-app root.
 */
function copySlideDesignAssets(PROJECT_ROOT, scratchAppDir) {
  const templateBase = path.join(PROJECT_ROOT, SLIDE_TEMPLATE_DIR);
  const pairs = [
    [path.join(templateBase, 'fonts'), path.join(scratchAppDir, 'fonts')],
    [path.join(templateBase, 'assets', 'logos'), path.join(scratchAppDir, 'assets', 'logos')],
  ];
  let copied = 0;
  for (const [srcDir, destDir] of pairs) {
    if (!fs.existsSync(srcDir)) continue;
    fs.mkdirSync(destDir, { recursive: true });
    for (const name of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, name);
      if (!fs.statSync(src).isFile()) continue;
      const dest = path.join(destDir, name);
      if (!fs.existsSync(dest) || fs.statSync(src).mtimeMs > fs.statSync(dest).mtimeMs) {
        fs.copyFileSync(src, dest);
        copied += 1;
      }
    }
  }
  return { copied };
}

function extractWorkhorseLayout(fragment) {
  if (!fragment) return null;
  const m = String(fragment).match(/\bdata-workhorse-layout\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/** Extract T1–T11 from LLM fragment for post-slides-report templatesUsed. */
function extractSlideTemplateId(fragment) {
  if (!fragment) return null;
  const m = String(fragment).match(/\bdata-slide-template\s*=\s*["'](T(?:1[01]|[1-9]))["']/i);
  return m ? m[1].toUpperCase() : null;
}

/** Stamp routed showcase template id on `.slide-root` for auditability in scratch-app HTML. */
function stampShowcaseTemplateId(fragment, showcaseTemplateId) {
  if (!fragment || !showcaseTemplateId) return fragment;
  const id = String(showcaseTemplateId).replace(/"/g, '');
  if (/\bdata-showcase-template\s*=/.test(fragment)) return fragment;
  return String(fragment).replace(
    /(<motion\b[^>]*\bclass="[^"]*\bslide-root\b[^"]*"[^>]*)/i,
    (tag) => (/\bdata-showcase-template\b/.test(tag) ? tag : `${tag} data-showcase-template="${id}"`)
  ).replace(
    /(<div\b[^>]*\bclass="[^"]*\bslide-root\b[^"]*"[^>]*)/i,
    (tag) => (/\bdata-showcase-template\b/.test(tag) ? tag : `${tag} data-showcase-template="${id}"`)
  );
}

/**
 * Ensure host <head> links slide design CSS once (colors + slide shell).
 */
function ensureSlideDesignStylesInHead(html, templates) {
  if (!html || !templates) return html;
  const markerStart = '<!-- POST-SLIDES DESIGN SYSTEM CSS -->';
  const markerEnd = '<!-- /POST-SLIDES DESIGN SYSTEM CSS -->';
  if (html.includes(markerStart)) return html;

  const colors = String(templates.colorsAndTypeCss || '').trim();
  const slide = String(templates.slideTemplateCss || '').trim();
  const contract = String(templates.pipelineSlideContractCss || '').trim();
  if (!colors && !slide && !contract) return html;

  // Rewrite @import and font URLs for scratch-app layout (served from run root).
  const scopedColors = colors
    .replace(/@import\s+url\(["']?\.\/colors_and_type\.css["']?\)\s*;?/gi, '')
    .replace(/url\(\s*["']?\.\/fonts\//gi, 'url("./fonts/');
  const scopedSlide = slide
    .replace(/@import\s+url\(["']?\.\/colors_and_type\.css["']?\)\s*;?/gi, '')
    .replace(/url\(\s*["']?\.\/fonts\//gi, 'url("./fonts/');

  // Cascade order matters: emit base design system FIRST, then the canonical
  // pipeline contract as a SEPARATE marked block AFTER. The contract's
  // selector specificity (`.step.active .slide-root`) beats slide.css's
  // bare `.slide-root` rule, and the later position closes any tie.
  const designBlock =
    `${markerStart}\n` +
    `<style data-post-slides-design-system="v1">\n${scopedColors}\n${scopedSlide}\n</style>\n` +
    markerEnd;
  const contractBlock = contract
    ? `\n<!-- PIPELINE SLIDE CONTRACT v1 -->\n` +
      `<style data-pipeline-slide-contract="v1">\n${contract}\n</style>\n` +
      `<!-- /PIPELINE SLIDE CONTRACT v1 -->\n`
    : '';
  const block = designBlock + contractBlock;

  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${block}\n</head>`);
  if (/<body\b/i.test(html)) return html.replace(/<body\b/i, `${block}\n<body`);
  return block + '\n' + html;
}

function loadBrand(outDir) {
  const candidates = [
    path.join(outDir, 'brand-extract.json'),
    path.join(outDir, 'artifacts', 'brand', 'brand-extract.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const json = JSON.parse(fs.readFileSync(p, 'utf8'));
        return json && typeof json === 'object' ? json : null;
      }
    } catch (_) {}
  }
  return null;
}

function loadValueProps(outDir) {
  const candidates = [
    path.join(outDir, 'pipeline-run-context.json'),
    path.join(outDir, 'product-research.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      const vps =
        (json && json.solutionsMasterContext && json.solutionsMasterContext.valuePropositionStatements) ||
        (json && json.valuePropositionStatements) ||
        null;
      if (Array.isArray(vps) && vps.length > 0) return vps.filter((s) => typeof s === 'string');
    } catch (_) {}
  }
  return [];
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { steps: null, maxIters: DEFAULT_MAX_ITERS, dryRun: false, allowPostRecord: false };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--allow-post-record') out.allowPostRecord = true;
    else if (a.startsWith('--steps=')) {
      out.steps = a.slice('--steps='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith('--max-iters=')) {
      const n = parseInt(a.slice('--max-iters='.length), 10);
      if (Number.isFinite(n) && n >= 1) out.maxIters = n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function generateSlideFragment(client, promptInputs) {
  const { system, userMessages } = buildSlideInsertionPrompt(promptInputs);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: userMessages,
  });
  const content = response.content || [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return text;
}

// ---------------------------------------------------------------------------
// Stage entry
// ---------------------------------------------------------------------------

async function main() {
  const PROJECT_ROOT = path.resolve(__dirname, '../../..');
  const outDir = requireRunDir(PROJECT_ROOT, 'post-slides');
  const layout = getRunLayout(outDir);
  const cli = parseArgs(process.argv.slice(2));

  const htmlPath = resolveHtmlPath(outDir, layout);
  const scriptPath = path.join(outDir, 'demo-script.json');

  if (!fs.existsSync(htmlPath) || !fs.existsSync(scriptPath)) {
    console.error('[post-slides] Missing scratch-app/index.html or demo-script.json.');
    process.exit(1);
  }

  // App-only invariant gate (manifest-authoritative).
  // App-only runs must never produce slide artifacts. This gate is read from
  // run-manifest.json (not env) so that the storyboard editor's app-only ->
  // app+slides upgrade via stampInsertedStepKindAndMaybeUpgradeBuildMode is
  // honored on the next stage invocation.
  const manifest = readRunManifest(outDir);
  const manifestBuildMode = String((manifest && manifest.buildMode) || '').toLowerCase().trim();
  if (manifestBuildMode === 'app-only') {
    const reason = 'app-only';
    console.log(`[post-slides] Skipping: run-manifest.buildMode="app-only" (reason=${reason}).`);
    const skipReport = {
      at: new Date().toISOString(),
      skipped: true,
      reason,
      buildMode: 'app-only',
      noop: true,
      slidesProcessed: [],
      slidesSkipped: [],
      templatesUsed: [],
    };
    writeReports(outDir, layout, skipReport);
    return skipReport;
  }

  // Post-record freeze sentinel gate. After record/recording.webm exists,
  // automated re-runs would clobber the slides the recording captured.
  // The freeze is bypassable via opts.allowPostRecord (storyboard editor
  // sets this when the operator confirmed they want to mutate post-record
  // with the explicit understanding that they'll need to re-record).
  const freezeSentinelPath = path.join(outDir, 'post-record-freeze.sentinel');
  if (fs.existsSync(freezeSentinelPath) && !cli.allowPostRecord) {
    const reason = 'post_record_freeze';
    console.log(`[post-slides] Skipping: post-record-freeze.sentinel exists (reason=${reason}). Re-run "pipe stage record" to clear.`);
    const skipReport = {
      at: new Date().toISOString(),
      skipped: true,
      reason,
      buildMode: manifestBuildMode || 'app+slides',
      noop: true,
      slidesProcessed: [],
      slidesSkipped: [],
      templatesUsed: [],
      recoveryHint: 'Run `pipe stage record` to overwrite the freeze sentinel before mutating slides, or pass --allow-post-record to bypass (storyboard editor path).',
    };
    writeReports(outDir, layout, skipReport);
    return skipReport;
  }

  const demoScript = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  annotateScriptWithStepKinds(demoScript);

  const steps = Array.isArray(demoScript.steps) ? demoScript.steps : [];
  const slideSteps = steps.filter((s) => isSlideStep(s));
  const filterSet = cli.steps && cli.steps.length ? new Set(cli.steps) : null;

  let html = fs.readFileSync(htmlPath, 'utf8');
  const report = {
    at: new Date().toISOString(),
    dryRun: cli.dryRun,
    onlyStepIds: cli.steps || null,
    model: MODEL,
    buildMode: manifestBuildMode || 'app+slides',
    totalSlideSteps: slideSteps.length,
    slidesProcessed: [],
    slidesSkipped: [],
    templatesUsed: [],
    routing: [],
    designAssetsCopied: null,
  };

  if (slideSteps.length === 0) {
    console.log('[post-slides] No slide-kind steps found — nothing to do.');
    report.noop = true;
    writeReports(outDir, layout, report);
    return;
  }

  const targets = slideSteps.filter((s) => {
    if (filterSet && !filterSet.has(s.id)) return false;
    if (stepHasSlideRoot(html, s.id)) return false;
    return true;
  });

  if (targets.length === 0) {
    console.log('[post-slides] All slide steps already have .slide-root markup.');
    report.noop = true;
    writeReports(outDir, layout, report);
    return;
  }

  console.log(`[post-slides] Inserting ${targets.length}/${slideSteps.length} slide(s) one at a time.`);

  let client = null;
  if (!cli.dryRun) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      if (!process.env.ANTHROPIC_API_KEY) {
        console.error('[post-slides] ANTHROPIC_API_KEY is missing.');
        process.exit(1);
      }
      client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } catch (e) {
      console.error(`[post-slides] Could not load Anthropic SDK: ${e.message}`);
      process.exit(1);
    }
  }

  const templates = loadSlideTemplates(PROJECT_ROOT);
  const slideDesignSkill = loadSlideDesignSkill({ projectRoot: PROJECT_ROOT });
  const brand = loadBrand(outDir);
  const vps = loadValueProps(outDir);
  const scratchAppDir = path.join(outDir, 'scratch-app');

  if (!cli.dryRun) {
    report.designAssetsCopied = copySlideDesignAssets(PROJECT_ROOT, scratchAppDir);
    html = ensureSlideDesignStylesInHead(html, templates);
  }

  // Map each slide step to its predecessor in script order so we can
  // splice it into the host HTML right after that step's div (preserves
  // DOM order = script order, which the host's arrow-key + click-to-advance
  // handlers depend on).
  const stepIndexById = new Map(steps.map((s, i) => [s.id, i]));
  const prevStepIdFor = (stepId) => {
    const idx = stepIndexById.get(stepId);
    if (typeof idx !== 'number' || idx <= 0) return null;
    return steps[idx - 1] && steps[idx - 1].id ? steps[idx - 1].id : null;
  };

  const slideIndexById = new Map(slideSteps.map((s, i) => [s.id, i]));
  const recentLayouts = [];

  for (const step of targets) {
    const slideIdx = slideIndexById.get(step.id) ?? 0;
    const routing = routeSlideTemplate(step, {
      stepIndex: slideIdx,
      totalSlides: slideSteps.length,
      recentLayouts: recentLayouts.slice(-2),
    });
    if (routing?.workhorseLayout) recentLayouts.push(routing.workhorseLayout);
    const showcaseTemplate = getShowcaseTemplateSkeletonForRouting(routing, { projectRoot: PROJECT_ROOT });
    if (cli.dryRun) {
      report.routing.push({ stepId: step.id, ...routing });
      report.slidesSkipped.push({ stepId: step.id, reason: 'dry-run' });
      console.log(`[post-slides] (dry-run) would insert slide "${step.id}" → ${routing.templateId} (${routing.workhorseLayout})`);
      continue;
    }
    let applied = false;
    let attempts = 0;
    let lastReason = null;
    let lastRaw = null;
    while (attempts < cli.maxIters && !applied) {
      attempts += 1;
      try {
        const raw = await generateSlideFragment(client, {
          step,
          brand,
          slideTemplateCss: templates.slideTemplateCss,
          slideTemplateRules: templates.slideTemplateRules,
          deckDesignSystem: templates.deckDesignSystem,
          deckComposition: templates.deckComposition,
          valuePropositionStatements: vps,
          narration: step.narration,
          slideDesignSkillMarkdown: slideDesignSkill.text,
          templateRouting: routing,
          showcaseTemplate,
        });
        lastRaw = raw;
        const { html: updated, applied: ok, reason } = spliceSlideFragmentIntoHtml(
          html,
          step.id,
          raw,
          { insertAfterId: prevStepIdFor(step.id), showcaseTemplateId: routing.templateId }
        );
        lastReason = reason;
        if (ok) {
          const norm = normalizeSlideTypography(updated);
          html = norm.html;
          if (norm.capped || norm.stripped) {
            console.log(
              `[post-slides] Typography normalize "${step.id}": capped=${norm.capped}, stripped=${norm.stripped}`
            );
          }
          applied = true;
        } else {
          console.warn(`[post-slides] Splice attempt ${attempts} for "${step.id}" failed: ${reason}`);
        }
      } catch (e) {
        lastReason = `llm-error: ${e.message}`;
        console.warn(`[post-slides] LLM error on attempt ${attempts} for "${step.id}": ${e.message}`);
      }
    }
    if (applied) {
      const templateId = extractSlideTemplateId(lastRaw);
      const workhorseLayout = extractWorkhorseLayout(lastRaw);
      report.routing.push({ stepId: step.id, ...routing, renderedTemplate: templateId, renderedWorkhorseLayout: workhorseLayout });
      report.slidesProcessed.push({ stepId: step.id, attempts, reason: lastReason, templateId, workhorseLayout });
      if (templateId) {
        report.templatesUsed.push({
          stepId: step.id,
          template: templateId,
          workhorseLayout: workhorseLayout || routing.workhorseLayout,
          showcaseTemplateId: routing.templateId,
        });
      }
      console.log(`[post-slides] ✓ Inserted slide "${step.id}" on attempt ${attempts}${templateId ? ` (${templateId}/${workhorseLayout || routing.workhorseLayout})` : ''}.`);
    } else {
      report.slidesSkipped.push({ stepId: step.id, attempts, reason: lastReason || 'unknown' });
      console.warn(`[post-slides] Skipped "${step.id}" after ${attempts} attempt(s).`);
      if (lastRaw) {
        const debugPath = path.join(layout.buildDir, `post-slides-debug-${step.id}.txt`);
        try {
          fs.mkdirSync(path.dirname(debugPath), { recursive: true });
          fs.writeFileSync(debugPath, lastRaw);
        } catch (_) {}
      }
    }
  }

  if (!cli.dryRun && report.slidesProcessed.length > 0) {
    const finalNorm = normalizeSlideTypography(html);
    html = finalNorm.html;
    if (finalNorm.capped || finalNorm.stripped) {
      report.typographyNormalized = { capped: finalNorm.capped, stripped: finalNorm.stripped };
      console.log(
        `[post-slides] Final typography pass: capped=${finalNorm.capped}, stripped=${finalNorm.stripped}`
      );
    }
    html = injectSlideTypographyOverrides(html);
    fs.writeFileSync(htmlPath, html, 'utf8');
    console.log(`[post-slides] Wrote updated HTML with ${report.slidesProcessed.length} slide(s).`);
  }
  writeReports(outDir, layout, report);
}

function writeReports(outDir, layout, report) {
  const primary = path.join(outDir, 'post-slides-report.json');
  const artifact = path.join(layout.buildDir, 'post-slides-report.json');
  try {
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(primary, JSON.stringify(report, null, 2));
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify(report, null, 2));
  } catch (e) {
    console.warn(`[post-slides] Could not write report: ${e.message}`);
  }
}

module.exports = {
  main,
  sanitizeSlideFragment,
  spliceSlideFragmentIntoHtml,
  injectSlideStylesIntoHead,
  stepHasSlideRoot,
  hostAlreadyHasAnySlide,
  loadSlideTemplates,
  copySlideDesignAssets,
  extractSlideTemplateId,
  ensureSlideDesignStylesInHead,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
