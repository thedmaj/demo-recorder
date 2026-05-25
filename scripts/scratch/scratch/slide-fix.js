'use strict';
/**
 * slide-fix.js
 *
 * Slide-tier recovery lane. Used when:
 *   - buildMode is `app+slides`, and
 *   - the run's qa-report-build.json shows the **app tier passed** but the
 *     **slide tier failed** (`tierSummary.app.passed && !tierSummary.slide.passed`).
 *
 * Deterministic loop (≤ SLIDE_QA_MAX_ITERATIONS, default 3):
 *
 *   1. findSlideApplicablePatches → applyPatches  (typography, layout, chrome)
 *   2. stripSlideRoots(failingSlideStepIds)        (reset blocks to placeholders)
 *   3. post-slides --steps=…                       (LLM re-insert with current contract)
 *   4. post-panels                                  (idempotent — keeps panel chrome consistent)
 *   5. build-qa stepScope=slides                    (re-score slides only)
 *
 * Final step (one-shot, on agent context): emit `qa-slide-fix-task.md`
 * via `buildQaTouchupPrompt({ tierFilter: 'slide' })` for surgical fixes
 * the deterministic loop could not address.
 *
 * **Never** calls `build-app` / `generateApp`. The app tier is frozen by
 * contract — if it regresses, that is a bug in this lane.
 *
 * Programmatic:
 *   require('./slide-fix').main({ runDir, maxIterations: 3, emitAgentTask: true })
 *
 * CLI:
 *   PIPELINE_RUN_DIR=… node scripts/scratch/scratch/slide-fix.js
 *   PIPELINE_RUN_DIR=… node scripts/scratch/scratch/slide-fix.js --max-iters=1 --skip-agent-task
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const RUN_DIR = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');

const { resolveSlideQaMaxIterations } = require('../utils/slide-qa-config');

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readTierSummary(runDir) {
  const file = path.join(runDir, 'qa-report-build.json');
  const report = safeReadJson(file);
  if (!report) return null;
  return {
    report,
    buildMode: report.buildMode || null,
    tierSummary: report.tierSummary || null,
    recommendedRecovery: report.recommendedRecovery || null,
  };
}

async function runPatches(runDir, qaReport, failingSlideStepIds, iteration) {
  delete require.cache[require.resolve('../utils/qa-patch-library')];
  const lib = require('../utils/qa-patch-library');
  const matches = lib.findSlideApplicablePatches(qaReport, { failingSlideStepIds });
  if (matches.length === 0) {
    return { applied: 0, results: [], skipped: true };
  }
  console.log(`[slide-fix] iter=${iteration}: ${matches.length} slide patch candidate(s): ${matches.map((m) => m.patch.name).join(', ')}`);
  const out = await lib.applyPatches({
    runDir,
    matches,
    iteration: `slide-fix-${iteration}`,
  });
  console.log(`[slide-fix] iter=${iteration}: applied ${out.applied} patch(es)`);
  return out;
}

function stripSlides(runDir, stepIds) {
  if (!stepIds || stepIds.length === 0) return { stripped: [], skipped: [] };
  delete require.cache[require.resolve('../utils/strip-slide-roots-for-post-slides')];
  const { stripSlideRoots } = require('../utils/strip-slide-roots-for-post-slides');
  const { stripped, skipped } = stripSlideRoots({ runDir, steps: stepIds });
  console.log(`[slide-fix] stripped ${stripped.length} slide block(s): ${stripped.join(', ') || '(none)'}`);
  if (skipped.length) console.warn(`[slide-fix] strip: skipped ${skipped.length}: ${skipped.join(', ')}`);
  return { stripped, skipped };
}

async function runPostSlides(runDir, stepIds) {
  // post-slides reads PIPELINE_RUN_DIR + parses argv for --steps=…; load
  // module fresh and synthesize argv via env override so the stage thinks
  // it was invoked with the right CLI args.
  const priorRunDir = process.env.PIPELINE_RUN_DIR;
  const priorArgv = process.argv.slice();
  process.env.PIPELINE_RUN_DIR = runDir;
  if (stepIds && stepIds.length > 0) {
    process.argv = [process.argv[0], process.argv[1], `--steps=${stepIds.join(',')}`];
  } else {
    process.argv = [process.argv[0], process.argv[1]];
  }
  try {
    delete require.cache[require.resolve('./post-slides')];
    const mod = require('./post-slides');
    if (typeof mod.main !== 'function') {
      console.warn('[slide-fix] post-slides.main missing — skipping LLM re-insert');
      return;
    }
    await mod.main();
  } finally {
    process.argv = priorArgv;
    if (priorRunDir == null) delete process.env.PIPELINE_RUN_DIR;
    else process.env.PIPELINE_RUN_DIR = priorRunDir;
  }
}

async function runPostPanels(runDir) {
  const priorRunDir = process.env.PIPELINE_RUN_DIR;
  process.env.PIPELINE_RUN_DIR = runDir;
  try {
    delete require.cache[require.resolve('./post-panels')];
    const mod = require('./post-panels');
    if (typeof mod.main !== 'function') return;
    await mod.main();
  } finally {
    if (priorRunDir == null) delete process.env.PIPELINE_RUN_DIR;
    else process.env.PIPELINE_RUN_DIR = priorRunDir;
  }
}

async function runSlidesScopedBuildQa(runDir) {
  const priorRunDir = process.env.PIPELINE_RUN_DIR;
  process.env.PIPELINE_RUN_DIR = runDir;
  try {
    delete require.cache[require.resolve('./build-qa')];
    const mod = require('./build-qa');
    return await mod.main({ stepScope: 'slides' });
  } finally {
    if (priorRunDir == null) delete process.env.PIPELINE_RUN_DIR;
    else process.env.PIPELINE_RUN_DIR = priorRunDir;
  }
}

function emitAgentSlideFixTask(runDir) {
  delete require.cache[require.resolve('../utils/qa-touchup')];
  const { buildQaTouchupPrompt } = require('../utils/qa-touchup');
  const result = buildQaTouchupPrompt(runDir, {
    tierFilter: 'slide',
    suppressSystemicGate: true,
    orchestratorDriven: false,
  });
  const taskPath = path.join(runDir, 'qa-slide-fix-task.md');
  fs.writeFileSync(taskPath, result.promptMarkdown, 'utf8');
  return { taskPath, summary: result.summary };
}

/**
 * Main entry. Honors the contract documented at top of file.
 *
 * @param {object} opts
 * @param {string} opts.runDir
 * @param {number} [opts.maxIterations=3]
 * @param {boolean} [opts.emitAgentTask=true]   write qa-slide-fix-task.md on residual failures
 * @param {boolean} [opts.requireAppPassed=true] hard fail when app tier hasn't passed
 * @returns {Promise<{ iterations, finalTierSummary, slidePassed, agentTaskPath, sentinelPath }>}
 */
async function main(opts = {}) {
  const runDir = opts.runDir || RUN_DIR;
  const maxIterations = resolveSlideQaMaxIterations(opts.maxIterations);
  const emitAgentTask = opts.emitAgentTask !== false;
  const requireAppPassed = opts.requireAppPassed !== false;

  if (!fs.existsSync(runDir)) {
    throw new Error(`[slide-fix] runDir not found: ${runDir}`);
  }
  const sentinelPath = path.join(runDir, 'slide-fix-report.json');

  // Post-record freeze sentinel gate. Once recording.webm has been captured,
  // automated slide HTML mutations would invalidate the recorded video. The
  // freeze is bypassable via opts.allowPostRecord (storyboard editor path).
  const freezeSentinelPath = path.join(runDir, 'post-record-freeze.sentinel');
  if (fs.existsSync(freezeSentinelPath) && !opts.allowPostRecord) {
    console.log('[slide-fix] Skipping: post-record-freeze.sentinel exists. Re-run "pipe stage record" to clear, or pass allowPostRecord:true to bypass.');
    writeSentinel(sentinelPath, {
      skipped: true,
      reason: 'post_record_freeze',
      recoveryHint: 'Run `pipe stage record` to overwrite the freeze sentinel before re-running slide-fix.',
    });
    return { iterations: 0, finalTierSummary: null, slidePassed: false, skipped: true };
  }

  let tier = readTierSummary(runDir);
  if (!tier) {
    throw new Error('[slide-fix] qa-report-build.json not found — run build-qa first');
  }
  if (tier.buildMode && tier.buildMode !== 'app+slides') {
    const msg = `[slide-fix] buildMode is "${tier.buildMode}" — slide-fix only applies to app+slides runs. Use app-touchup instead.`;
    console.error(msg);
    writeSentinel(sentinelPath, { skipped: true, reason: 'buildMode_not_app_plus_slides', buildMode: tier.buildMode });
    return { iterations: 0, finalTierSummary: tier.tierSummary, slidePassed: tier.tierSummary?.slide?.passed === true, skipped: true };
  }
  if (!tier.tierSummary || !tier.tierSummary.slide || tier.tierSummary.slide.stepCount === 0) {
    const msg = '[slide-fix] no slide steps in tierSummary — nothing to fix';
    console.warn(msg);
    writeSentinel(sentinelPath, { skipped: true, reason: 'no_slide_steps' });
    return { iterations: 0, finalTierSummary: tier.tierSummary, slidePassed: true, skipped: true };
  }
  if (requireAppPassed && tier.tierSummary.app && tier.tierSummary.app.passed === false) {
    const msg = '[slide-fix] app tier did not pass — refusing to run slide-fix until app tier passes (use app-touchup first)';
    console.warn(msg);
    writeSentinel(sentinelPath, {
      skipped: true,
      reason: 'app_tier_failed',
      tierSummary: tier.tierSummary,
    });
    return { iterations: 0, finalTierSummary: tier.tierSummary, slidePassed: false, skipped: true };
  }
  if (tier.tierSummary.slide.passed) {
    console.log('[slide-fix] slide tier already passing — nothing to do');
    writeSentinel(sentinelPath, { skipped: true, reason: 'slide_tier_already_passed' });
    return { iterations: 0, finalTierSummary: tier.tierSummary, slidePassed: true, skipped: true };
  }

  let iter = 0;
  const iterationLog = [];
  while (iter < maxIterations) {
    iter += 1;
    const failingSlideIds = (tier.tierSummary.slide.failingStepIds || []).slice();
    console.log(`[slide-fix] iteration ${iter}/${maxIterations} — failing slides: ${failingSlideIds.join(', ') || '(none)'}`);

    // 1) Strip + LLM re-insert FIRST. The patches are mostly CSS-overlay fixes
    //    that target the *current* HTML state — applying them before strip+
    //    reinsert means the LLM regeneration immediately wipes them. So we
    //    swap the order: regenerate the failing slides first, then apply
    //    deterministic patches to the fresh output, then re-QA.
    const stripOut = stripSlides(runDir, failingSlideIds);
    if (stripOut.stripped.length > 0) {
      await runPostSlides(runDir, stripOut.stripped);
    }
    await runPostPanels(runDir);

    // 2) Apply deterministic patches (typography, overlap autofix, etc.) to
    //    the freshly inserted slides. Uses the tier-summary's diagnostics
    //    from the previous QA pass — fine since the patches target either
    //    universal contracts (typography ceilings/floors) or per-step CSS
    //    overrides that the LLM does not own.
    const patchOut = await runPatches(runDir, tier.report, failingSlideIds, iter);

    const qaResult = await runSlidesScopedBuildQa(runDir);
    tier = readTierSummary(runDir);
    iterationLog.push({
      iteration: iter,
      patchesApplied: patchOut.applied || 0,
      stripped: stripOut.stripped,
      postSlidesRan: stripOut.stripped.length > 0,
      slidePassed: tier?.tierSummary?.slide?.passed === true,
      slideMinScore: tier?.tierSummary?.slide?.minScore ?? null,
      slideFailingStepIds: tier?.tierSummary?.slide?.failingStepIds || [],
      overallScore: qaResult?.overallScore || null,
    });
    if (tier?.tierSummary?.slide?.passed) {
      console.log(`[slide-fix] slide tier passed on iteration ${iter}`);
      break;
    }
  }

  let agentTaskPath = null;
  if (emitAgentTask && tier?.tierSummary?.slide?.passed === false) {
    try {
      const { taskPath } = emitAgentSlideFixTask(runDir);
      agentTaskPath = taskPath;
      console.log(`[slide-fix] residual failures — wrote agent task: ${path.relative(runDir, taskPath)}`);
    } catch (err) {
      console.warn(`[slide-fix] could not write agent task: ${err.message}`);
    }
  }

  writeSentinel(sentinelPath, {
    skipped: false,
    iterations: iter,
    maxIterations,
    slidePassed: tier?.tierSummary?.slide?.passed === true,
    finalTierSummary: tier?.tierSummary || null,
    iterationLog,
    agentTaskPath,
  });

  return {
    iterations: iter,
    finalTierSummary: tier?.tierSummary || null,
    slidePassed: tier?.tierSummary?.slide?.passed === true,
    agentTaskPath,
    sentinelPath,
  };
}

function writeSentinel(file, payload) {
  try {
    fs.writeFileSync(file, JSON.stringify({
      stage: 'slide-fix',
      at: new Date().toISOString(),
      ...payload,
    }, null, 2));
  } catch (_) { /* best-effort */ }
}

function parseCliArgs(argv) {
  const out = { maxIterations: null, emitAgentTask: true };
  for (const a of argv) {
    if (a.startsWith('--max-iters=')) {
      const n = parseInt(a.slice('--max-iters='.length), 10);
      if (Number.isFinite(n) && n > 0) out.maxIterations = n;
    } else if (a === '--skip-agent-task') {
      out.emitAgentTask = false;
    }
  }
  return out;
}

if (require.main === module) {
  const cli = parseCliArgs(process.argv.slice(2));
  main({
    runDir: RUN_DIR,
    maxIterations: cli.maxIterations || undefined,
    emitAgentTask: cli.emitAgentTask,
  }).then((result) => {
    if (result.skipped) {
      console.log('[slide-fix] skipped — see slide-fix-report.json');
      process.exit(0);
    }
    if (result.slidePassed) {
      console.log('[slide-fix] PASSED');
      process.exit(0);
    }
    console.warn('[slide-fix] residual failures — see qa-slide-fix-task.md');
    process.exit(0);
  }).catch((err) => {
    console.error(`[slide-fix] Fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  main,
  readTierSummary,
};
