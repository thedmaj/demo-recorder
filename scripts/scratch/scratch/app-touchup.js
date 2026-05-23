'use strict';
/**
 * app-touchup.js
 *
 * App-tier recovery lane. Used when:
 *   - buildMode is `app-only` and `tierSummary.app.passed === false`, OR
 *   - buildMode is `app+slides` and `tierSummary.app.passed === false`
 *     (slide tier passed or is skipped — slide-fix has its own lane).
 *
 * This is the **primary** agent-touchup path on app-only runs. The
 * existing LLM `--build-fix-mode=touchup` regenerates the entire
 * `index.html`; this lane never does that.
 *
 * Deterministic loop (≤ APP_TOUCHUP_MAX_ITERATIONS, default 2):
 *
 *   1. findAppApplicablePatches → applyPatches  (api-panel toggle, CTA, NMLS,
 *                                                 link-token products)
 *   2. post-panels                                (idempotent — refreshes
 *                                                  api-response-panel chrome)
 *   3. build-qa stepScope=app                     (re-score app-tier steps only)
 *
 * Final step (one-shot, on agent context): emit `qa-app-touchup-task.md`
 * via `buildQaTouchupPrompt({ tierFilter: 'app' })` so the agent can make
 * surgical edits the deterministic loop could not address.
 *
 * **Never** calls `build-app` / `generateApp` and never edits `.slide-root`
 * blocks. The slide tier is frozen by contract.
 *
 * Programmatic:
 *   require('./app-touchup').main({ runDir, maxIterations: 2, emitAgentTask: true })
 *
 * CLI:
 *   PIPELINE_RUN_DIR=… node scripts/scratch/scratch/app-touchup.js
 *   PIPELINE_RUN_DIR=… node scripts/scratch/scratch/app-touchup.js --max-iters=1 --skip-agent-task
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const RUN_DIR = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');

const APP_TOUCHUP_MAX_ITERATIONS_DEFAULT = Number(process.env.APP_TOUCHUP_MAX_ITERATIONS || '2');

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
    systemicReasons: Array.isArray(report.systemicReasons) ? report.systemicReasons : [],
  };
}

async function runPatches(runDir, qaReport, failingAppStepIds, iteration) {
  delete require.cache[require.resolve('../utils/qa-patch-library')];
  const lib = require('../utils/qa-patch-library');
  const matches = lib.findAppApplicablePatches(qaReport, { failingAppStepIds });
  if (matches.length === 0) {
    return { applied: 0, results: [], skipped: true };
  }
  console.log(`[app-touchup] iter=${iteration}: ${matches.length} app patch candidate(s): ${matches.map((m) => m.patch.name).join(', ')}`);
  const out = await lib.applyPatches({
    runDir,
    matches,
    iteration: `app-touchup-${iteration}`,
  });
  console.log(`[app-touchup] iter=${iteration}: applied ${out.applied} patch(es)`);
  return out;
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

async function runAppScopedBuildQa(runDir, buildMode) {
  // On app-only runs there are no slide steps, so 'app' scope and 'all' scope
  // are equivalent. We still pass 'app' so the report's tierSummary stays
  // consistent and so app+slides runs walk only the app tier.
  const stepScope = buildMode === 'app-only' ? 'all' : 'app';
  const priorRunDir = process.env.PIPELINE_RUN_DIR;
  process.env.PIPELINE_RUN_DIR = runDir;
  try {
    delete require.cache[require.resolve('./build-qa')];
    const mod = require('./build-qa');
    return await mod.main({ stepScope });
  } finally {
    if (priorRunDir == null) delete process.env.PIPELINE_RUN_DIR;
    else process.env.PIPELINE_RUN_DIR = priorRunDir;
  }
}

function emitAgentAppTouchupTask(runDir) {
  delete require.cache[require.resolve('../utils/qa-touchup')];
  const { buildQaTouchupPrompt } = require('../utils/qa-touchup');
  const result = buildQaTouchupPrompt(runDir, {
    tierFilter: 'app',
    suppressSystemicGate: true,
    orchestratorDriven: false,
  });
  // On app+slides runs we use the tier-explicit filename so the user can tell
  // the two task files apart. On app-only there is no other tier — preserve
  // the legacy `qa-touchup-task.md` filename for backward compat.
  const buildMode = result.summary.buildMode || 'app-only';
  const taskPath = path.join(
    runDir,
    buildMode === 'app-only' ? 'qa-touchup-task.md' : 'qa-app-touchup-task.md'
  );
  fs.writeFileSync(taskPath, result.promptMarkdown, 'utf8');
  return { taskPath, summary: result.summary };
}

/**
 * Main entry.
 *
 * @param {object} opts
 * @param {string} opts.runDir
 * @param {number} [opts.maxIterations=2]
 * @param {boolean} [opts.emitAgentTask=true]
 * @returns {Promise<{ iterations, finalTierSummary, appPassed, agentTaskPath, sentinelPath, skipped? }>}
 */
async function main(opts = {}) {
  const runDir = opts.runDir || RUN_DIR;
  const maxIterations = Number.isFinite(Number(opts.maxIterations))
    ? Math.max(1, Number(opts.maxIterations))
    : APP_TOUCHUP_MAX_ITERATIONS_DEFAULT;
  const emitAgentTask = opts.emitAgentTask !== false;

  if (!fs.existsSync(runDir)) {
    throw new Error(`[app-touchup] runDir not found: ${runDir}`);
  }
  const sentinelPath = path.join(runDir, 'app-touchup-report.json');

  let tier = readTierSummary(runDir);
  if (!tier) {
    throw new Error('[app-touchup] qa-report-build.json not found — run build-qa first');
  }
  if (!tier.tierSummary || !tier.tierSummary.app) {
    console.warn('[app-touchup] qa-report-build.json is missing tierSummary — re-running build-qa might be required');
    writeSentinel(sentinelPath, { skipped: true, reason: 'no_tier_summary' });
    return { iterations: 0, finalTierSummary: null, appPassed: false, skipped: true };
  }
  if (tier.tierSummary.app.passed) {
    console.log('[app-touchup] app tier already passing — nothing to do');
    writeSentinel(sentinelPath, { skipped: true, reason: 'app_tier_already_passed' });
    return { iterations: 0, finalTierSummary: tier.tierSummary, appPassed: true, skipped: true };
  }
  if (tier.systemicReasons && tier.systemicReasons.length > 0) {
    console.warn(`[app-touchup] systemic reasons present (${tier.systemicReasons.join(', ')}) — proceeding but recommending fullbuild on residual failures`);
  }

  const buildMode = tier.buildMode || 'app-only';
  let iter = 0;
  const iterationLog = [];

  while (iter < maxIterations) {
    iter += 1;
    const failingAppIds = (tier.tierSummary.app.failingStepIds || []).slice();
    console.log(`[app-touchup] iteration ${iter}/${maxIterations} — failing app steps: ${failingAppIds.join(', ') || '(none)'}`);

    const patchOut = await runPatches(runDir, tier.report, failingAppIds, iter);
    await runPostPanels(runDir);

    const qaResult = await runAppScopedBuildQa(runDir, buildMode);
    tier = readTierSummary(runDir);
    iterationLog.push({
      iteration: iter,
      patchesApplied: patchOut.applied || 0,
      appPassed: tier?.tierSummary?.app?.passed === true,
      appMinScore: tier?.tierSummary?.app?.minScore ?? null,
      appFailingStepIds: tier?.tierSummary?.app?.failingStepIds || [],
      overallScore: qaResult?.overallScore || null,
    });
    if (tier?.tierSummary?.app?.passed) {
      console.log(`[app-touchup] app tier passed on iteration ${iter}`);
      break;
    }
  }

  let agentTaskPath = null;
  if (emitAgentTask && tier?.tierSummary?.app?.passed === false) {
    try {
      const { taskPath } = emitAgentAppTouchupTask(runDir);
      agentTaskPath = taskPath;
      console.log(`[app-touchup] residual failures — wrote agent task: ${path.relative(runDir, taskPath)}`);
    } catch (err) {
      console.warn(`[app-touchup] could not write agent task: ${err.message}`);
    }
  }

  writeSentinel(sentinelPath, {
    skipped: false,
    iterations: iter,
    maxIterations,
    appPassed: tier?.tierSummary?.app?.passed === true,
    finalTierSummary: tier?.tierSummary || null,
    buildMode,
    iterationLog,
    agentTaskPath,
  });

  return {
    iterations: iter,
    finalTierSummary: tier?.tierSummary || null,
    appPassed: tier?.tierSummary?.app?.passed === true,
    agentTaskPath,
    sentinelPath,
  };
}

function writeSentinel(file, payload) {
  try {
    fs.writeFileSync(file, JSON.stringify({
      stage: 'app-touchup',
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
      console.log('[app-touchup] skipped — see app-touchup-report.json');
      process.exit(0);
    }
    if (result.appPassed) {
      console.log('[app-touchup] PASSED');
      process.exit(0);
    }
    console.warn('[app-touchup] residual failures — see qa-touchup-task.md or qa-app-touchup-task.md');
    process.exit(0);
  }).catch((err) => {
    console.error(`[app-touchup] Fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  main,
  readTierSummary,
};
