#!/usr/bin/env node
'use strict';

/**
 * Strip all slide roots, re-run post-slides (showcase router), post-panels,
 * slide-scoped build-qa, slide-fix loop, and qa-slide-fix task emission.
 *
 * Usage: node scripts/batch-redo-slides-showcase.js RUN_ID [RUN_ID ...]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function run(cmd, args, env = {}) {
  console.log(`\n>> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  return r.status ?? 1;
}

async function redoRun(runId) {
  const runDir = path.join(PROJECT_ROOT, 'out', 'demos', runId);
  if (!fs.existsSync(runDir)) {
    console.error(`[skip] run not found: ${runId}`);
    return { runId, ok: false, error: 'not_found' };
  }
  console.log(`\n${'='.repeat(72)}\nREDO SLIDES (showcase router): ${runId}\n${'='.repeat(72)}`);

  const freeze = path.join(runDir, 'post-record-freeze.sentinel');
  if (fs.existsSync(freeze)) {
    fs.unlinkSync(freeze);
    console.log('[redo] removed post-record-freeze.sentinel (slides stale after redo)');
  }

  const scriptPath = path.join(runDir, 'demo-script.json');
  if (fs.existsSync(scriptPath)) {
    const { enrichSlideTemplateHints } = require('./scratch/scratch/generate-script');
    const demoScript = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    const hints = enrichSlideTemplateHints(demoScript);
    fs.writeFileSync(scriptPath, JSON.stringify(demoScript, null, 2));
    console.log(`[redo] enriched template hints on ${hints.steps} slide step(s)`);
  }

  let code = run('node', ['scripts/scratch/utils/strip-slide-roots-for-post-slides.js'], { PIPELINE_RUN_DIR: runDir });
  if (code !== 0) return { runId, ok: false, error: 'strip' };

  code = run('node', ['scripts/scratch/scratch/post-slides.js'], { PIPELINE_RUN_DIR: runDir });
  if (code !== 0) return { runId, ok: false, error: 'post-slides' };

  code = run('node', ['scripts/scratch/scratch/post-panels.js'], { PIPELINE_RUN_DIR: runDir });
  if (code !== 0) return { runId, ok: false, error: 'post-panels' };

  code = run('node', ['scripts/scratch/scratch/build-qa.js'], {
    PIPELINE_RUN_DIR: runDir,
    BUILD_QA_STEP_SCOPE: 'slides',
  });
  // build-qa may exit non-zero on QA fail — continue to slide-fix

  const { main: slideFixMain } = require('./scratch/scratch/slide-fix');
  let slideFixResult;
  try {
    slideFixResult = await slideFixMain({
      runDir,
      emitAgentTask: true,
      requireAppPassed: false,
      allowPostRecord: true,
    });
    console.log('[redo] slide-fix result:', JSON.stringify(slideFixResult, null, 2));
  } catch (e) {
    console.error('[redo] slide-fix error:', e.message);
  }

  run('node', ['bin/pipe.js', 'qa-slide-fix', runId]);

  const reportPath = path.join(runDir, 'qa-report-build.json');
  let summary = {};
  if (fs.existsSync(reportPath)) {
    const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    summary = {
      slidePassed: r.tierSummary?.slide?.passed,
      slideMinScore: r.tierSummary?.slide?.minScore,
      failingSlides: r.tierSummary?.slide?.failingStepIds || [],
      agentTask: fs.existsSync(path.join(runDir, 'qa-slide-fix-task.md')),
    };
  }
  return { runId, ok: true, slideFixResult, summary };
}

async function main() {
  const runIds = process.argv.slice(2);
  if (runIds.length === 0) {
    console.error('Usage: node scripts/batch-redo-slides-showcase.js RUN_ID [...]');
    process.exit(1);
  }
  const results = [];
  for (const id of runIds) {
    results.push(await redoRun(id));
  }
  const outPath = path.join(PROJECT_ROOT, 'artifacts', 'batch-redo-slides-showcase-report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\n[batch] report → ${outPath}`);
  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
