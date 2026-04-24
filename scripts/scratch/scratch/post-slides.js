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

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');

const { requireRunDir, getRunLayout } = require('../utils/run-io');
const { annotateScriptWithStepKinds, isSlideStep } = require('../utils/step-kind');
const { buildSlideInsertionPrompt } = require('../utils/prompt-templates');

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

function sanitizeSlideFragment(fragment, stepId) {
  if (!fragment) return '';
  let s = String(fragment).trim();
  s = s.replace(/^```(?:html|HTML)?\s*/m, '').replace(/```\s*$/m, '');
  s = s.replace(/<!DOCTYPE[^>]*>/i, '');
  s = s.replace(/<\/?html[^>]*>/gi, '');
  s = s.replace(/<\/?body[^>]*>/gi, '');
  s = s.replace(/<\/?head[^>]*>/gi, '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.trim();

  const openingMatch = s.match(/<div[^>]*>/i);
  if (!openingMatch) return '';
  const opening = openingMatch[0];
  const hasTestid = new RegExp(`data-testid="step-${stepId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}"`).test(opening);
  if (!hasTestid) {
    const replaced = opening.replace(/<div\b/, `<div data-testid="step-${stepId}" class="step"`);
    s = s.replace(opening, replaced);
  }
  s = s.replace(/\sstyle="[^"]*\bdisplay\s*:[^";]+;?[^"]*"/gi, '');
  return s.trim();
}

function spliceSlideFragmentIntoHtml(html, stepId, fragment) {
  const cleaned = sanitizeSlideFragment(fragment, stepId);
  if (!cleaned) {
    return { html, applied: false, reason: 'empty-fragment' };
  }

  if (hasStepContainer(html, stepId)) {
    const re = stepBlockRegex(stepId);
    const m = html.match(re);
    if (m) {
      return {
        html: html.replace(m[0], cleaned + '\n'),
        applied: true,
        reason: 'replaced-existing-step-block',
      };
    }
  }

  const beforeEndMarker =
    html.indexOf('<!-- SIDE PANELS') >= 0 ? '<!-- SIDE PANELS' :
    html.indexOf('<div id="link-events-panel"') >= 0 ? '<div id="link-events-panel"' :
    html.indexOf('<div id="api-response-panel"') >= 0 ? '<div id="api-response-panel"' :
    '</body>';
  if (html.includes(beforeEndMarker)) {
    return {
      html: html.replace(beforeEndMarker, `${cleaned}\n${beforeEndMarker}`),
      applied: true,
      reason: 'appended-before-side-panels',
    };
  }
  return { html, applied: false, reason: 'no-insertion-point' };
}

function loadSlideTemplates(PROJECT_ROOT) {
  const cssPath = path.join(PROJECT_ROOT, 'templates/slide-template/slide.css');
  const rulesPath = path.join(PROJECT_ROOT, 'templates/slide-template/PIPELINE_SLIDE_SHELL_RULES.md');
  const shellPath = path.join(PROJECT_ROOT, 'templates/slide-template/pipeline-slide-shell.html');
  const read = (p) => {
    try {
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    } catch (_) {
      return '';
    }
  };
  return {
    slideTemplateCss: read(cssPath),
    slideTemplateRules: read(rulesPath),
    slideTemplateShellHtml: read(shellPath),
  };
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
  const out = { steps: null, maxIters: DEFAULT_MAX_ITERS, dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
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
    totalSlideSteps: slideSteps.length,
    slidesProcessed: [],
    slidesSkipped: [],
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
  const brand = loadBrand(outDir);
  const vps = loadValueProps(outDir);

  for (const step of targets) {
    const hostHasExistingSlide = hostAlreadyHasAnySlide(html);
    if (cli.dryRun) {
      report.slidesSkipped.push({ stepId: step.id, reason: 'dry-run' });
      console.log(`[post-slides] (dry-run) would insert slide "${step.id}"`);
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
          slideTemplateCss: hostHasExistingSlide ? '' : templates.slideTemplateCss,
          slideTemplateRules: hostHasExistingSlide ? '' : templates.slideTemplateRules,
          slideTemplateShellHtml: hostHasExistingSlide ? '' : templates.slideTemplateShellHtml,
          hostHasExistingSlide,
          valuePropositionStatements: vps,
          narration: step.narration,
        });
        lastRaw = raw;
        const { html: updated, applied: ok, reason } = spliceSlideFragmentIntoHtml(html, step.id, raw);
        lastReason = reason;
        if (ok) {
          html = updated;
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
      report.slidesProcessed.push({ stepId: step.id, attempts, reason: lastReason });
      console.log(`[post-slides] ✓ Inserted slide "${step.id}" on attempt ${attempts}.`);
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
  stepHasSlideRoot,
  hostAlreadyHasAnySlide,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
