'use strict';
/**
 * One-off driver: regenerate slides + re-QA across a list of run dirs.
 * Bypasses the slide-fix app-tier gate so we can iterate purely on slides.
 *
 * Usage:
 *   node scripts/scratch/scratch/_slide_regen_driver.js \
 *     out/demos/RUN1 out/demos/RUN2 out/demos/RUN3
 *
 * Loads .env first so OPENAI/Anthropic API keys are available.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node _slide_regen_driver.js <runDir> [<runDir>...]');
    process.exit(1);
  }
  const PROJECT_ROOT = path.resolve(__dirname, '../../..');
  const slideFix = require('./slide-fix');
  const summary = [];
  for (const runArg of args) {
    const runDir = path.isAbsolute(runArg) ? runArg : path.join(PROJECT_ROOT, runArg);
    if (!fs.existsSync(runDir)) {
      console.error(`[regen] runDir not found: ${runDir}`);
      continue;
    }
    console.log(`\n\n==============================`);
    console.log(`[regen] BEGIN ${path.basename(runDir)}`);
    console.log(`==============================`);
    process.env.PIPELINE_RUN_DIR = runDir;
    try {
      const result = await slideFix.main({
        runDir,
        requireAppPassed: false,
        emitAgentTask: false,
        maxIterations: 3,
      });
      summary.push({ run: path.basename(runDir), result });
      console.log(`[regen] DONE ${path.basename(runDir)} — slidePassed=${result.slidePassed} iters=${result.iterations}`);
      console.log(`[regen] tierSummary.slide=${JSON.stringify(result.finalTierSummary?.slide || null)}`);
    } catch (e) {
      console.error(`[regen] ERROR on ${runDir}: ${e.message}`);
      summary.push({ run: path.basename(runDir), error: e.message });
    }
  }
  console.log('\n\n========= SUMMARY =========');
  for (const s of summary) {
    if (s.error) {
      console.log(`  ${s.run}: ERROR — ${s.error}`);
    } else {
      const slide = s.result.finalTierSummary?.slide || {};
      console.log(`  ${s.run}: slidePassed=${s.result.slidePassed} minScore=${slide.minScore ?? '?'} avgScore=${slide.avgScore ?? '?'} failing=${(slide.failingStepIds||[]).join(',')||'-'}`);
    }
  }
}

main().catch((e) => {
  console.error('[regen] fatal:', e);
  process.exit(1);
});
