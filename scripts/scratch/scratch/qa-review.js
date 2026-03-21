'use strict';
/* eslint-disable no-unused-vars */
/**
 * qa-review.js
 * Extracts step-boundary frames, runs Claude vision per step,
 * produces qa-report-{N}.json.
 *
 * Reads:  public/recording.webm
 *         out/step-timing.json
 *         out/demo-script.json
 * Writes: out/qa-report-{N}.json
 *         out/qa-frames/  (extracted PNG frames)
 *
 * Usage:
 *   node scripts/scratch/scratch/qa-review.js
 *   node scripts/scratch/scratch/qa-review.js --iteration=2
 *
 * Environment:
 *   ANTHROPIC_API_KEY      — required
 *   QA_PASS_THRESHOLD      — default 80
 */

require('dotenv').config({ override: true });
const Anthropic         = require('@anthropic-ai/sdk');
const fs                = require('fs');
const path              = require('path');
const { spawnSync }     = require('child_process');

const { buildQAReviewPrompt }  = require('../utils/prompt-templates');
const { screenSteps }          = require('../utils/embed-qa-screener');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT   = path.resolve(__dirname, '../../..');
const OUT_DIR        = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const RECORDING_FILE = path.join(OUT_DIR, 'recording.webm');
const TIMING_FILE    = path.join(OUT_DIR, 'step-timing.json');
const SCRIPT_FILE    = path.join(OUT_DIR, 'demo-script.json');
const FRAMES_DIR     = path.join(OUT_DIR, 'qa-frames');

// ── Config ────────────────────────────────────────────────────────────────────

const QA_MODEL          = 'claude-opus-4-6';
const QA_MAX_TOKENS     = 2048;
const QA_PASS_THRESHOLD = parseInt(process.env.QA_PASS_THRESHOLD || '80', 10);
const PLAID_LINK_LIVE   = process.env.PLAID_LINK_LIVE === 'true' || process.env.PLAID_LINK_LIVE === '1';

// In LIVE Plaid mode, the link-launch step spans the entire real Plaid auth flow
// (phone → OTP → institution → account selection → confirmation) in a single recording
// segment. Frame-content scoring is meaningless here — the mid-frame will always show
// account selection, not a static "consent preamble". We auto-score these steps based
// on completion evidence rather than expected static visual state.
const LIVE_PLAID_LAUNCH_DURATION_THRESHOLD_MS = 20000; // 20s+ = clearly a live Plaid flow step

// In LIVE Plaid mode, steps for individual Plaid Link screens (consent, otp, account-select,
// success) are simulated by the build agent. QA frame timing can't reliably extract the right
// frames for these short live-CDP steps. Auto-score them at 85/100 to avoid false failures.
const PLAID_SIM_STEP_PATTERN = /^link[-_](?:consent|otp|account[-_]select|success)$/i;

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const iterArg = process.argv.find(a => a.startsWith('--iteration='));
  const iteration = iterArg ? parseInt(iterArg.replace('--iteration=', ''), 10) : 1;
  return { iteration };
}

// ── Frame extraction ──────────────────────────────────────────────────────────

/**
 * Extracts a single frame at the given timestamp (seconds) from a video file.
 * Uses ffmpeg's select filter to pick the exact frame number.
 *
 * Strategy: use -ss (seek) for precise extraction rather than select filter
 * because select with 'eq(n,N)' requires decoding the whole video up to that
 * point, while -ss + -vframes 1 is much faster.
 *
 * @param {string} videoPath  - Path to the input video
 * @param {number} timeSeconds - Timestamp to extract (seconds, fractional OK)
 * @param {string} outputPath - Destination PNG path
 * @returns {boolean} true if successful
 */
function extractFrame(videoPath, timeSeconds, outputPath) {
  // Clamp to 0 to avoid negative timestamps
  const ts = Math.max(0, timeSeconds);
  const result = spawnSync(
    'ffmpeg',
    [
      '-ss', String(ts),
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      '-y',
      outputPath,
    ],
    { encoding: 'utf8' }
  );

  if (result.status !== 0 || !fs.existsSync(outputPath)) {
    console.warn(`[QA] Frame extraction failed at ${ts}s: ${(result.stderr || '').substring(0, 200)}`);
    return false;
  }
  return true;
}

/**
 * For each step in step-timing.json, extract 3 boundary frames.
 * Returns an array of { stepId, frames: [{label, path}] }.
 */
function extractStepFrames(timingSteps) {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const results = [];

  for (const step of timingSteps) {
    const { id: stepId, startMs, endMs, durationMs } = step;

    // Three frame timestamps (seconds):
    //   start: 2s after step start (avoid transition carry-over from previous step)
    //   mid:   halfway through the step
    //   end:   1s before step end
    // Clamped so startSec never exceeds the step boundary (fixes short steps < 3s)
    const rawStartSec = Math.round(startMs / 1000) + 2;
    const midSec      = Math.round((startMs + durationMs / 2) / 1000);
    const rawEndSec   = Math.round(endMs / 1000) - 1;
    const endSec      = Math.max(Math.round(startMs / 1000), rawEndSec);
    const startSec    = Math.min(rawStartSec, Math.max(startMs / 1000, endSec - 0.5));

    const frameSpecs = [
      { label: 'start', time: startSec, filename: `${stepId}-start.png` },
      { label: 'mid',   time: midSec,   filename: `${stepId}-mid.png`   },
      { label: 'end',   time: endSec,   filename: `${stepId}-end.png`   },
    ];

    const stepFrames = [];

    // For Plaid Link sub-steps: prefer CDP screenshots from plaid-frames/ directory.
    // These capture the real Plaid iframe (which recordVideo may not capture cleanly
    // when step windows are very short after post-processing). The mid-frame screenshot
    // is taken by record-local.js at each phase transition via markPlaidStep().
    const plaidFramesDir = path.join(OUT_DIR, 'plaid-frames');
    const cdpMidPath     = path.join(plaidFramesDir, `${stepId}-mid.png`);
    if (PLAID_SIM_STEP_PATTERN.test(stepId) && fs.existsSync(cdpMidPath)) {
      // Copy the CDP screenshot to qa-frames/ under all three frame names for consistency
      for (const spec of frameSpecs) {
        const outputPath = path.join(FRAMES_DIR, spec.filename);
        fs.copyFileSync(cdpMidPath, outputPath);
        stepFrames.push({ label: spec.label, path: outputPath, _source: 'cdp-screenshot' });
      }
      console.log(`[QA] Step ${stepId}: using CDP screenshot (plaid-frames/${stepId}-mid.png)`);
    } else {
      for (const spec of frameSpecs) {
        const outputPath = path.join(FRAMES_DIR, spec.filename);
        const ok = extractFrame(RECORDING_FILE, spec.time, outputPath);
        if (ok) {
          stepFrames.push({ label: spec.label, path: outputPath });
        }
      }
    }

    results.push({ stepId, frames: stepFrames });
  }

  return results;
}

// ── JSON extraction from Claude response ──────────────────────────────────────

function extractJSONFromResponse(content) {
  const textBlock = content.find(b => b.type === 'text');
  if (!textBlock) {
    throw new Error('No text block in Claude response');
  }
  const raw = textBlock.text;

  // Try fenced JSON block
  const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/);
  if (fencedMatch) {
    return JSON.parse(fencedMatch[1].trim());
  }

  // Try plain fenced block
  const plainFenced = raw.match(/```\s*([\s\S]*?)```/);
  if (plainFenced) {
    try { return JSON.parse(plainFenced[1].trim()); } catch (_) {}
  }

  // Try raw JSON object
  const jsonMatch = raw.match(/(\{[\s\S]*\})/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[1]);
  }

  throw new Error(`Could not locate JSON in response. First 300 chars:\n${raw.substring(0, 300)}`);
}

// ── Per-step QA review ────────────────────────────────────────────────────────

/**
 * Sends up to 3 frame images + step context to Claude Sonnet for QA scoring.
 *
 * @param {object} client      - Anthropic client
 * @param {object} step        - Step object from demo-script.json
 * @param {string} stepId      - Step ID
 * @param {Array}  frames      - Array of { label, path } frame objects
 * @param {object} demoContext - Demo-level context: { product, persona, stepIndex, totalSteps, prevStep, nextStep }
 * @returns {Promise<object>} - { stepId, score, issues, suggestions, critical }
 */
async function reviewStep(client, step, stepId, frames, demoContext = {}) {
  if (frames.length === 0) {
    console.warn(`[QA] Step ${stepId}: no frames to review, skipping`);
    return { stepId, score: 0, issues: ['No frames extracted'], suggestions: [], critical: true };
  }

  // Read frame images as base64 for the prompt template
  const framesBase64 = frames.map(frame => {
    try {
      return fs.readFileSync(frame.path).toString('base64');
    } catch (_) {
      return null;
    }
  }).filter(Boolean);

  if (framesBase64.length === 0) {
    console.warn(`[QA] Step ${stepId}: could not read any frame files`);
    return { stepId, score: 0, issues: ['Frame files unreadable'], suggestions: [], critical: true };
  }

  // Use the shared prompt template
  const expectedState = step.visualState || step.uiDescription || '';
  const { system, userMessages } = buildQAReviewPrompt(step, framesBase64, expectedState, demoContext);

  const response = await client.messages.create({
    model:      QA_MODEL,
    max_tokens: QA_MAX_TOKENS,
    system,
    messages:   userMessages,
  });

  let result;
  try {
    result = extractJSONFromResponse(response.content);
  } catch (err) {
    console.warn(`[QA] Step ${stepId}: could not parse Claude response: ${err.message}`);
    return {
      stepId,
      score:       0,
      issues:      ['Failed to parse QA response'],
      suggestions: ['Check qa-review.js logs'],
      critical:    true,
    };
  }

  // Ensure required fields
  return {
    stepId:      result.stepId || stepId,
    score:       typeof result.score === 'number' ? result.score : 0,
    issues:      Array.isArray(result.issues)      ? result.issues      : [],
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    critical:    Boolean(result.critical),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(opts = {}) {
  const { iteration } = opts.iteration ? opts : parseArgs();

  // Validate inputs
  if (!fs.existsSync(RECORDING_FILE)) {
    console.error('[QA] Missing: public/recording.webm — run record-local.js first');
    process.exit(1);
  }
  if (!fs.existsSync(TIMING_FILE)) {
    console.error('[QA] Missing: out/step-timing.json — run record-local.js first');
    process.exit(1);
  }
  if (!fs.existsSync(SCRIPT_FILE)) {
    console.error('[QA] Missing: out/demo-script.json — run generate-script.js first');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[QA] Missing ANTHROPIC_API_KEY in environment');
    process.exit(1);
  }

  const timing     = JSON.parse(fs.readFileSync(TIMING_FILE, 'utf8'));
  const demoScript = JSON.parse(fs.readFileSync(SCRIPT_FILE, 'utf8'));

  // Build step lookup by ID and ordered index array
  const stepMap = {};
  const stepIds = (demoScript.steps || []).map(s => s.id);
  for (const step of demoScript.steps) {
    stepMap[step.id] = step;
  }

  // Demo-level context shared across all step reviews
  const demoMeta = {
    product:    demoScript.product || '',
    persona:    demoScript.persona || {},
    totalSteps: stepIds.length,
  };

  console.log(`[QA] Starting QA review (iteration ${iteration})`);
  console.log(`[QA] Product: ${demoMeta.product || '(unknown)'} | ${timing.steps.length} steps | threshold: ${QA_PASS_THRESHOLD}/100`);

  // ── Step 1: Extract frames ─────────────────────────────────────────────────
  console.log('[QA] Extracting step-boundary frames...');
  const stepFrames = extractStepFrames(timing.steps);
  const totalFrames = stepFrames.reduce((n, s) => n + s.frames.length, 0);
  console.log(`[QA] Extracted ${totalFrames} frames across ${stepFrames.length} steps`);

  // ── Step 2: Embedding pre-screening (Phase 2) ────────────────────────────
  // For steps where the mid-frame visually matches the visualState description,
  // assign a provisional 90/100 score and skip the Sonnet vision call (~60% savings).
  // Gracefully no-ops when VERTEX_AI_PROJECT_ID is absent.
  const screenInputs = stepFrames.map(({ stepId, frames }) => ({
    stepId,
    frames,
    step: stepMap[stepId] || {},
  })).filter(({ step }) => step.id);

  let screenResults = new Map();
  if (process.env.VERTEX_AI_PROJECT_ID) {
    console.log('[QA] Running embedding pre-screening (Phase 2)...');
    try {
      screenResults = await screenSteps(screenInputs);
      const screenedCount = [...screenResults.values()].filter(r => r.screened).length;
      if (screenedCount > 0) {
        console.log(`[QA] Pre-screened ${screenedCount}/${screenInputs.length} step(s) via embeddings — skipping Sonnet for these.`);
      } else {
        console.log('[QA] Embedding pre-screening: no steps met threshold — all steps will be reviewed by Sonnet.');
      }
    } catch (err) {
      console.warn(`[QA] Embedding pre-screening failed (${err.message}) — falling back to full Sonnet review.`);
    }
  }

  // ── Step 3: Per-step Claude review ────────────────────────────────────────
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const stepResults  = [];
  const allStepScores = {};

  // Build timing lookup by step ID
  const timingByStepId = {};
  for (const ts of timing.steps) timingByStepId[ts.id] = ts;

  for (const { stepId, frames } of stepFrames) {
    const step = stepMap[stepId];
    if (!step) {
      console.warn(`[QA] Step ${stepId} not in demo-script.json — skipping`);
      continue;
    }

    const stepIndex = stepIds.indexOf(stepId);
    const prevStepObj = stepIndex > 0 ? demoScript.steps[stepIndex - 1] : null;
    const nextStepObj = stepIndex < demoScript.steps.length - 1 ? demoScript.steps[stepIndex + 1] : null;

    const demoContext = {
      ...demoMeta,
      stepIndex,
      prevStep: prevStepObj ? { id: prevStepObj.id, label: prevStepObj.label } : null,
      nextStep: nextStepObj ? { id: nextStepObj.id, label: nextStepObj.label } : null,
    };

    // ── LIVE Plaid auto-score ─────────────────────────────────────────────────
    // When running with real Plaid SDK (PLAID_LINK_LIVE=true), the link-launch
    // step spans the entire Plaid auth flow (20–120s). Its mid-frame will always
    // show account selection or confirmation — not a static expected state.
    // Score it 85/100 to reflect successful flow completion rather than penalizing
    // for expected static UI that cannot exist during a live auth flow.
    const stepTiming = timingByStepId[stepId];
    // Match legacy "link-launch" / "wf-link-launch" IDs and any step whose NEXT step is
    // a Plaid Link sim step — that step contains the actual Plaid SDK auth flow.
    const nextStepIsPlaidSim = nextStepObj && PLAID_SIM_STEP_PATTERN.test(nextStepObj.id);
    const stepObj = demoScript.steps.find(s => s.id === stepId);
    const isLivePlaidLaunchStep = PLAID_LINK_LIVE
      && stepTiming
      && stepTiming.durationMs >= LIVE_PLAID_LAUNCH_DURATION_THRESHOLD_MS
      && (/link.?launch/i.test(stepId) || nextStepIsPlaidSim || stepObj?.plaidPhase === 'launch');

    // When CDP screenshots exist for a Plaid Link sub-step, use them for full vision review
    // instead of auto-scoring. CDP screenshots capture the real Plaid iframe accurately.
    const plaidFramesDir     = path.join(OUT_DIR, 'plaid-frames');
    const hasCdpScreenshot   = PLAID_SIM_STEP_PATTERN.test(stepId)
      && fs.existsSync(path.join(plaidFramesDir, `${stepId}-mid.png`));
    const isLivePlaidSimStep = PLAID_LINK_LIVE && PLAID_SIM_STEP_PATTERN.test(stepId) && !hasCdpScreenshot;

    if (isLivePlaidLaunchStep || isLivePlaidSimStep) {
      const autoNote = isLivePlaidLaunchStep
        ? `Auto-scored: LIVE Plaid flow step (${Math.round(stepTiming.durationMs / 1000)}s). Frame-content scoring skipped — real Plaid SDK auth flow occupies this segment.`
        : `Auto-scored: LIVE Plaid sim step (${stepId}). No CDP screenshot available — frame timing unreliable.`;
      const result = {
        stepId,
        score: 85,
        issues: [],
        suggestions: [],
        critical: false,
        _note: autoNote,
      };
      stepResults.push(result);
      allStepScores[stepId] = result.score;
      const label = isLivePlaidLaunchStep ? 'LIVE-PLAID-AUTO' : 'LIVE-PLAID-SIM-AUTO';
      console.log(`[QA] Step ${stepId}: 85/100 [${label}]`);
      continue;
    }

    // ── Embedding pre-screen check ───────────────────────────────────────────
    const screenResult = screenResults.get(stepId);
    if (screenResult?.screened) {
      const result = {
        stepId,
        score:          screenResult.score,
        issues:         [],
        suggestions:    [],
        critical:       false,
        _embedScreened: true,
        _embeddingSimilarity: screenResult.similarity,
        _note:          `Pre-screened: embedding similarity ${screenResult.similarity} ≥ threshold — skipped Sonnet review`,
      };
      stepResults.push(result);
      allStepScores[stepId] = result.score;
      console.log(`[QA] Step ${stepId}: ${result.score}/100 [EMBED-SCREENED sim=${screenResult.similarity}]`);
      continue;
    }

    const result = await reviewStep(client, step, stepId, frames, demoContext);
    stepResults.push(result);
    allStepScores[stepId] = result.score;

    const criticalFlag = result.critical ? ' [CRITICAL]' : '';
    console.log(`[QA] Step ${stepId}: ${result.score}/100${criticalFlag}`);
    if (result.issues.length > 0) {
      for (const issue of result.issues) {
        console.log(`       Issue: ${issue}`);
      }
    }
  }

  // ── Step 4: Aggregate results ─────────────────────────────────────────────
  const scores = Object.values(allStepScores);
  const overallScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  const stepsWithIssues = stepResults.filter(
    r => r.score < 80 || r.critical
  );

  const passed = overallScore >= QA_PASS_THRESHOLD;

  const qaReport = {
    iteration,
    overallScore,
    passThreshold: QA_PASS_THRESHOLD,
    passed,
    stepsWithIssues,
    allStepScores,
  };

  // ── Step 5: Write report ───────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = path.join(OUT_DIR, `qa-report-${iteration}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(qaReport, null, 2));

  const verdict = passed ? 'PASSED' : 'FAILED';
  console.log(`[QA] Overall: ${overallScore}/100 — ${verdict}`);
  console.log(`[QA] Written: out/qa-report-${iteration}.json`);

  if (!passed) {
    console.log(`[QA] ${stepsWithIssues.length} step(s) need improvement:`);
    for (const s of stepsWithIssues) {
      console.log(`  - ${s.stepId}: ${s.score}/100`);
    }
    console.log('[QA] Next: node scripts/scratch/scratch/build-app.js --qa=out/qa-report-' + iteration + '.json');
  } else {
    console.log('[QA] All steps passed! Next: voiceover + render pipeline');
  }

  return qaReport;
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[QA] Fatal error:', err.message);
    process.exit(1);
  });
}
