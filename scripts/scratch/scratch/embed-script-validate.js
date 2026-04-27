#!/usr/bin/env node
'use strict';
/**
 * embed-script-validate.js
 * Phase 3: Script narration / visual-state coherence check.
 *
 * Two backends, picked in priority order:
 *
 *   1. Vertex / Gemini embeddings (preferred when VERTEX_AI_PROJECT_ID or
 *      GOOGLE_API_KEY is set). Computes cosine similarity between narration
 *      and visualState; flags steps below SCRIPT_VALIDATE_THRESHOLD.
 *
 *   2. Anthropic Haiku fallback (when no Vertex / Google credentials are
 *      available). Asks Haiku to grade narration-vs-visualState alignment
 *      0–100 per step; flags steps below SCRIPT_VALIDATE_LLM_THRESHOLD.
 *      Cheap (~200 tokens per step) and runs everywhere ANTHROPIC_API_KEY
 *      is configured — which is the same set of users who can run the
 *      pipeline at all, so this stage now ALWAYS runs instead of silently
 *      no-op'ing on most SE setups.
 *
 * This catches issues like:
 *   - Narration about "account balance" but visualState describes "IDV selfie"
 *   - Narration mentioning a score that doesn't match the step type
 *   - Hallucinated claim that references the wrong product step
 *
 * Runs between script-critique and build. Returns a structured report;
 * blocking behavior under PIPE_AGENT_MODE=1 is owned by the orchestrator.
 *
 * Usage:
 *   PIPELINE_RUN_DIR=... node scripts/scratch/scratch/embed-script-validate.js
 *
 * Env vars:
 *   VERTEX_AI_PROJECT_ID            — preferred (Vertex embeddings)
 *   GOOGLE_API_KEY                  — alt for Vertex embeddings
 *   ANTHROPIC_API_KEY               — required for Haiku fallback
 *   SCRIPT_VALIDATE_THRESHOLD       — embedding cosine threshold (default 0.78)
 *   SCRIPT_VALIDATE_LLM_THRESHOLD   — Haiku 0-100 threshold (default 75)
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
const LLM_THRESHOLD = parseFloat(process.env.SCRIPT_VALIDATE_LLM_THRESHOLD || '75');

/**
 * Anthropic Haiku-backed coherence grader. Used when neither Vertex nor
 * Google API credentials are available. Returns the same shape as the
 * embeddings path so downstream code (orchestrator + agent task md) stays
 * backend-agnostic.
 *
 * @param {Array<{id, narration, visualState}>} steps
 * @returns {Promise<{ results: Array, flags: Array, model: string }>}
 */
async function gradeWithHaiku(steps) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY missing — cannot use Haiku fallback for script-validate');
  }
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const model = 'claude-haiku-4-5-20251001';

  // One Haiku call per step keeps the prompt tight (~200 tokens in / out
  // each) and isolates per-step failures. Steps with empty narration or
  // visualState short-circuit to skipped, mirroring the embedding path.
  const flags = [];
  const results = [];
  for (const step of steps) {
    const narration   = (step.narration   || '').trim();
    const visualState = (step.visualState || step.uiDescription || step.label || '').trim();
    if (!narration || !visualState) {
      results.push({ id: step.id, similarity: null, status: 'skipped-missing-text' });
      continue;
    }
    let score;
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: 256,
        messages: [{
          role: 'user',
          content:
            `Grade how well a demo step's narration aligns with its expected visual state.\n\n` +
            `NARRATION (what the voiceover says):\n> ${narration}\n\n` +
            `EXPECTED VISUAL STATE (what the screen shows):\n> ${visualState}\n\n` +
            `Score 0–100, where 100 = the narration is fully evidenced by the visual state, ` +
            `and 0 = totally unrelated. Output JSON only:\n` +
            `{"score": <0-100>, "reason": "<one sentence>"}`,
        }],
      });
      const raw = (resp.content || []).map(b => b.text || '').join('').trim();
      const json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      score = Number(json.score);
      results.push({ id: step.id, score, reason: json.reason || null, status: score >= LLM_THRESHOLD ? 'ok' : 'mismatch' });
    } catch (err) {
      console.warn(`[embed-script-validate] Haiku grade failed for step "${step.id}": ${err.message}`);
      results.push({ id: step.id, score: null, status: 'haiku-failed', error: err.message });
      continue;
    }
    if (score < LLM_THRESHOLD) {
      flags.push({
        stepId:      step.id,
        score,
        threshold:   LLM_THRESHOLD,
        narration:   narration.substring(0, 80),
        visualState: visualState.substring(0, 80),
        reason:      results[results.length - 1].reason || null,
        message:     `Narration and visual state may be misaligned (Haiku score ${score} < threshold ${LLM_THRESHOLD})`,
      });
      console.warn(`[embed-script-validate] Step "${step.id}": haikuScore=${score} — ${flags[flags.length - 1].message}`);
    } else {
      console.log(`[embed-script-validate] Step "${step.id}": haikuScore=${score} — ok`);
    }
  }
  return { results, flags, model };
}

async function main() {
  // Backend selection:
  //   1. Vertex / Google embeddings if creds present (cheaper, faster)
  //   2. Anthropic Haiku fallback otherwise
  //   3. Hard skip only when NO backend at all is reachable.
  const hasVertex = !!(process.env.VERTEX_AI_PROJECT_ID || process.env.GOOGLE_API_KEY);
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasVertex && !hasAnthropic) {
    console.log('[embed-script-validate] No embedding or LLM backend available — skipping.');
    console.log('[embed-script-validate] Set GOOGLE_API_KEY (preferred) or ANTHROPIC_API_KEY in .env to enable.');
    return { flags: [], passed: true, skipped: true };
  }
  const backend = hasVertex ? 'embeddings' : 'haiku';

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

  console.log(`[embed-script-validate] Validating ${steps.length} steps via ${backend}...`);

  const flags   = [];
  const results = [];

  if (backend === 'haiku') {
    const haikuOut = await gradeWithHaiku(steps);
    flags.push(...haikuOut.flags);
    results.push(...haikuOut.results);
  } else {
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
  }

  const passed = flags.length === 0;
  const report = {
    generatedAt: new Date().toISOString(),
    backend,
    model:       backend === 'haiku' ? 'claude-haiku-4-5-20251001' : 'text-embedding-004',
    threshold:   backend === 'haiku' ? LLM_THRESHOLD : THRESHOLD,
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
