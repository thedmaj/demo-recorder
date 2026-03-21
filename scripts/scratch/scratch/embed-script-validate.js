#!/usr/bin/env node
'use strict';
/**
 * embed-script-validate.js
 * Phase 3: Script narration / visual-state coherence check via text embeddings.
 *
 * For each step in demo-script.json, embeds the narration text and the
 * visualState text using Vertex AI text-embedding-004. Steps with cosine
 * similarity below SCRIPT_VALIDATE_THRESHOLD are flagged as potential
 * narration/visual mismatches — the audio says one thing but the screen
 * shows something unrelated.
 *
 * This catches issues like:
 *   - Narration about "account balance" but visualState describes "IDV selfie"
 *   - Narration mentioning a score that doesn't match the step type
 *   - Hallucinated claim that references the wrong product step
 *
 * Runs between script-critique and build. Gracefully skips when
 * VERTEX_AI_PROJECT_ID is not set (non-critical).
 *
 * Usage:
 *   PIPELINE_RUN_DIR=... node scripts/scratch/scratch/embed-script-validate.js
 *
 * Env vars:
 *   VERTEX_AI_PROJECT_ID       — required (skip gracefully if absent)
 *   SCRIPT_VALIDATE_THRESHOLD  — default: 0.65
 */

require('dotenv').config({ override: true });

const fs   = require('fs');
const path = require('path');
const { embedTextDense, cosineSimilarity } = require('../utils/vertex-embed');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR      = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
// Default 0.78 calibrated for gemini-embedding-001 (3072-dim); unrelated sentences score ~0.74,
// so threshold must be above that baseline. Lower to 0.65 if using text-embedding-004.
const THRESHOLD    = parseFloat(process.env.SCRIPT_VALIDATE_THRESHOLD || '0.78');

async function main() {
  // Phase 3 uses text-only embeddings which work with GOOGLE_API_KEY (Google AI Studio)
  // OR with VERTEX_AI_PROJECT_ID (Vertex AI OAuth2). Either is sufficient.
  if (!process.env.VERTEX_AI_PROJECT_ID && !process.env.GOOGLE_API_KEY) {
    console.log('[embed-script-validate] Neither VERTEX_AI_PROJECT_ID nor GOOGLE_API_KEY set — skipping script validation.');
    console.log('[embed-script-validate] Set GOOGLE_API_KEY in .env to enable semantic script checks.');
    return { flags: [], passed: true, skipped: true };
  }

  const scriptFile = path.join(OUT_DIR, 'demo-script.json');
  if (!fs.existsSync(scriptFile)) {
    console.log('[embed-script-validate] No demo-script.json found — skipping.');
    return { flags: [], passed: true, skipped: true };
  }

  const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  const steps  = script.steps || [];

  if (steps.length === 0) {
    console.log('[embed-script-validate] No steps in demo-script.json — skipping.');
    return { flags: [], passed: true, skipped: true };
  }

  console.log(`[embed-script-validate] Validating ${steps.length} steps via text embeddings...`);

  const flags   = [];
  const results = [];

  for (const step of steps) {
    const narration   = (step.narration   || '').trim();
    const visualState = (step.visualState || step.uiDescription || step.label || '').trim();

    if (!narration || !visualState) {
      results.push({ id: step.id, similarity: null, status: 'skipped-missing-text' });
      continue;
    }

    let similarity;
    try {
      const [narVec, visVec] = await Promise.all([
        embedTextDense(narration),
        embedTextDense(visualState),
      ]);
      similarity = cosineSimilarity(narVec, visVec);
    } catch (err) {
      console.warn(`[embed-script-validate] Embedding failed for step "${step.id}": ${err.message}`);
      results.push({ id: step.id, similarity: null, status: 'embed-failed', error: err.message });
      continue;
    }

    const sim3   = Math.round(similarity * 1000) / 1000;
    const passed = similarity >= THRESHOLD;
    results.push({ id: step.id, similarity: sim3, status: passed ? 'ok' : 'mismatch' });

    if (!passed) {
      flags.push({
        stepId:      step.id,
        similarity:  sim3,
        threshold:   THRESHOLD,
        narration:   narration.substring(0, 80),
        visualState: visualState.substring(0, 80),
        message:     `Narration and visual state may be misaligned (similarity ${sim3} < threshold ${THRESHOLD})`,
      });
      console.warn(`[embed-script-validate] Step "${step.id}": similarity=${sim3} — ${flags[flags.length - 1].message}`);
    } else {
      console.log(`[embed-script-validate] Step "${step.id}": similarity=${sim3} — ok`);
    }
  }

  const passed = flags.length === 0;
  const report = {
    generatedAt: new Date().toISOString(),
    model:       'text-embedding-004',
    threshold:   THRESHOLD,
    passed,
    flagCount:   flags.length,
    flags,
    steps:       results,
  };

  const reportPath = path.join(OUT_DIR, 'script-validate-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[embed-script-validate] Report written: ${reportPath}`);

  if (flags.length > 0) {
    console.warn(`\n[embed-script-validate] ${flags.length} step(s) have potential narration/visual mismatches:`);
    for (const f of flags) {
      console.warn(`  [${f.stepId}] sim=${f.similarity} — "${f.narration.substring(0, 60)}..." vs "${f.visualState.substring(0, 60)}..."`);
    }

    if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
      // Non-critical: log but don't halt
      console.warn('[embed-script-validate] Review the flags above before building the app.');
      console.warn('[embed-script-validate] To fix: edit narration or visualState in demo-script.json.');
    }
  } else {
    console.log('[embed-script-validate] All steps passed narration/visual coherence check.');
  }

  return report;
}

if (require.main === module) {
  main().catch(err => {
    console.error('[embed-script-validate] Fatal error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main };
