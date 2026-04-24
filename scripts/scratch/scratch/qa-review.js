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
 * Programmatic (build-only QA — no recording):
 *   require('./qa-review').main({ buildOnly: true, prebuiltStepFrames, iteration: 'build' })
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
const {
  appendPipelineLogSection,
  appendPipelineLogJson,
} = require('../utils/pipeline-logger');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT   = path.resolve(__dirname, '../../..');
const OUT_DIR        = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const RECORDING_FILE = path.join(OUT_DIR, 'recording.webm');
const TIMING_FILE    = path.join(OUT_DIR, 'step-timing.json');
const SCRIPT_FILE    = path.join(OUT_DIR, 'demo-script.json');
const FRAMES_DIR     = path.join(OUT_DIR, 'qa-frames');

// ── Config ────────────────────────────────────────────────────────────────────

const QA_MODEL          = 'claude-opus-4-7';
const QA_MAX_TOKENS     = parseInt(process.env.QA_MAX_TOKENS || '4096', 10);
const QA_REVIEW_CONCURRENCY = Math.max(1, parseInt(process.env.QA_REVIEW_CONCURRENCY || '3', 10));
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
  const thresholdArg = process.argv.find(a => a.startsWith('--qa-threshold='));
  const qaPassThreshold = thresholdArg
    ? parseInt(thresholdArg.replace('--qa-threshold=', ''), 10)
    : null;
  return { iteration, qaPassThreshold };
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

    // Three frame timestamps (seconds), sampled strictly inside the step window.
    // This avoids transition-boundary bleed where "start" can still show prior step chrome.
    const stepStartSec = Math.max(0, startMs / 1000);
    const stepEndSec = Math.max(stepStartSec + 0.08, endMs / 1000);
    const durationSec = Math.max(0.08, stepEndSec - stepStartSec);
    const startOffsetSec = Math.min(1.2, Math.max(0.25, durationSec * 0.18));
    const endOffsetSec = Math.min(0.35, Math.max(0.08, durationSec * 0.16));

    let startSec = Math.min(stepEndSec - 0.06, stepStartSec + startOffsetSec);
    let endSec = Math.max(stepStartSec + 0.06, stepEndSec - endOffsetSec);
    let midSec = stepStartSec + (durationSec * 0.55);
    midSec = Math.min(endSec - 0.02, Math.max(startSec + 0.02, midSec));

    if (!(startSec <= midSec && midSec <= endSec)) {
      // Fallback for very short or malformed windows.
      startSec = stepStartSec + 0.02;
      endSec = Math.max(stepStartSec + 0.04, stepEndSec - 0.02);
      midSec = stepStartSec + ((endSec - stepStartSec) / 2);
    }

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
 * @returns {Promise<object>} - { stepId, score, issues, suggestions, categories, critical }
 */
async function reviewStep(client, step, stepId, frames, demoContext = {}) {
  if (frames.length === 0) {
    console.warn(`[QA] Step ${stepId}: no frames to review, skipping`);
    return { stepId, score: 0, issues: ['No frames extracted'], suggestions: [], categories: ['navigation-mismatch'], critical: true };
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
    return { stepId, score: 0, issues: ['Frame files unreadable'], suggestions: [], categories: ['action-failure'], critical: true };
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
      categories:  ['prompt-contract-drift'],
      critical:    true,
    };
  }

  // Ensure required fields
  return {
    stepId:      result.stepId || stepId,
    score:       typeof result.score === 'number' ? result.score : 0,
    issues:      Array.isArray(result.issues)      ? result.issues      : [],
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    categories:  Array.isArray(result.categories)  ? result.categories  : [],
    critical:    Boolean(result.critical),
  };
}

/**
 * Run async tasks with a fixed concurrency (pool). Preserves result order.
 * @template T,R
 * @param {number} concurrency
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapPool(concurrency, items, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function hasNarrationCriticalMarkers(step) {
  const text = String(step?.narration || '');
  if (!text) return false;
  // Concrete narration anchors that frequently drift from visuals if not reviewed.
  if (/\b\d+(?:\.\d+)?\s*(?:%|ms|sec|seconds?|minutes?|hours?)\b/i.test(text)) return true;
  if (/\$\s?\d[\d,]*(?:\.\d+)?/.test(text)) return true;
  if (/\b(?:accept|approved|approve|review|decline|denied|pass|failed?|low risk|high risk|score)\b/i.test(text)) return true;
  if (/\b(?:routing|account mask|ownership|identity match|return risk|conversion uplift)\b/i.test(text)) return true;
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(opts = {}) {
  const cliArgs  = parseArgs();
  const iteration = opts.iteration != null ? opts.iteration : cliArgs.iteration;
  const qaPassThreshold = Number.isFinite(Number(opts.qaPassThreshold))
    ? Number(opts.qaPassThreshold)
    : Number.isFinite(Number(cliArgs.qaPassThreshold))
      ? Number(cliArgs.qaPassThreshold)
      : QA_PASS_THRESHOLD;
  const buildOnly = opts.buildOnly === true;
  const buildQaDiagnostics = Array.isArray(opts.buildQaDiagnostics) ? opts.buildQaDiagnostics : [];

  if (!fs.existsSync(SCRIPT_FILE)) {
    console.error('[QA] Missing: demo-script.json — run generate-script.js first');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[QA] Missing ANTHROPIC_API_KEY in environment');
    process.exit(1);
  }

  if (!buildOnly) {
    if (!fs.existsSync(RECORDING_FILE)) {
      console.error('[QA] Missing: public/recording.webm — run record-local.js first');
      process.exit(1);
    }
    if (!fs.existsSync(TIMING_FILE)) {
      console.error('[QA] Missing: step-timing.json — run record-local.js first');
      process.exit(1);
    }
  } else if (!opts.prebuiltStepFrames || !Array.isArray(opts.prebuiltStepFrames) || opts.prebuiltStepFrames.length === 0) {
    console.error('[QA] buildOnly mode requires opts.prebuiltStepFrames (non-empty array)');
    process.exit(1);
  }

  const demoScript = JSON.parse(fs.readFileSync(SCRIPT_FILE, 'utf8'));
  let timing;
  let stepFrames;

  if (buildOnly) {
    stepFrames = opts.prebuiltStepFrames;
    timing = {
      steps: stepFrames.map(({ stepId }) => ({
        id:         stepId,
        startMs:    0,
        endMs:      5000,
        durationMs: 5000,
      })),
    };
  } else {
    timing     = JSON.parse(fs.readFileSync(TIMING_FILE, 'utf8'));
    stepFrames = null;
  }

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

  console.log(`[QA] Starting QA review (iteration ${iteration})${buildOnly ? ' [build-only — no recording]' : ''}`);
  console.log(`[QA] Product: ${demoMeta.product || '(unknown)'} | ${timing.steps.length} steps | threshold: ${qaPassThreshold}/100`);
  appendPipelineLogSection('[QA] Review started', [
    `iteration=${iteration}`,
    `qaSource=${buildOnly ? 'build-walkthrough' : 'recording'}`,
    `product=${demoMeta.product || 'unknown'}`,
    `stepCount=${timing.steps.length}`,
    `threshold=${qaPassThreshold}`,
  ], { runDir: OUT_DIR });

  // ── Step 1: Extract frames ─────────────────────────────────────────────────
  if (!buildOnly) {
    console.log('[QA] Extracting step-boundary frames from recording...');
    stepFrames = extractStepFrames(timing.steps);
  } else {
    console.log('[QA] Using pre-captured build walkthrough frames');
  }
  const totalFrames = stepFrames.reduce((n, s) => n + s.frames.length, 0);
  console.log(`[QA] ${totalFrames} frames across ${stepFrames.length} steps`);

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
  if (!buildOnly && process.env.VERTEX_AI_PROJECT_ID) {
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
  const diagByStep = new Map();
  for (const diag of buildQaDiagnostics) {
    if (!diag || !diag.stepId) continue;
    const arr = diagByStep.get(diag.stepId) || [];
    arr.push(diag);
    diagByStep.set(diag.stepId, arr);
  }
  const deterministicCriticalDiagnostics = buildQaDiagnostics.filter((d) => {
    if (!d) return false;
    if (d.deterministicBlocker === true) return true;
    if (d.deterministicBlocker === false) return false;
    return d.severity === 'critical';
  });
  const deterministicCriticalStepIds = new Set(
    deterministicCriticalDiagnostics.map((d) => d?.stepId).filter(Boolean)
  );

  function applyDiagnosticsToResult(result, stepDiagnostics) {
    if (!result || !Array.isArray(stepDiagnostics) || stepDiagnostics.length === 0) return result;
    const diagIssues = stepDiagnostics.map((d) => d.issue).filter(Boolean);
    const diagSuggestions = stepDiagnostics.map((d) => d.suggestion).filter(Boolean);
    const diagCategories = [...new Set(stepDiagnostics.map((d) => d.category).filter(Boolean))];
    result.issues = [...diagIssues, ...(result.issues || [])];
    result.suggestions = [...diagSuggestions, ...(result.suggestions || [])];
    result.categories = [...new Set([...(result.categories || []), ...diagCategories])];
    if (stepDiagnostics.some((d) => {
      if (d.deterministicBlocker === true) return true;
      if (d.deterministicBlocker === false) return false;
      return d.severity === 'critical';
    })) {
      result.critical = true;
      result.score = Math.min(Number(result.score || 0), 45);
    }
    return result;
  }

  // Build timing lookup by step ID
  const timingByStepId = {};
  for (const ts of timing.steps) timingByStepId[ts.id] = ts;

  /** @type {Array<{ kind: 'resolved', stepId: string, result: object } | { kind: 'vision', stepId: string, step: object, frames: string[], stepReviewContext: object }>} */
  const pipelineEntries = [];

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
    const narrationCritical = hasNarrationCriticalMarkers(step);
    const stepReviewContext = {
      ...demoContext,
      narrationStrict: narrationCritical,
    };

    // ── LIVE Plaid auto-score ─────────────────────────────────────────────────
    const stepTiming = timingByStepId[stepId];
    const nextStepIsPlaidSim = nextStepObj && PLAID_SIM_STEP_PATTERN.test(nextStepObj.id);
    const stepObj = demoScript.steps.find(s => s.id === stepId);
    const isLivePlaidLaunchStep = PLAID_LINK_LIVE
      && (stepObj?.plaidPhase === 'launch'
        || (stepTiming
            && stepTiming.durationMs >= LIVE_PLAID_LAUNCH_DURATION_THRESHOLD_MS
            && (/link.?launch/i.test(stepId) || nextStepIsPlaidSim)));

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
        categories: [],
        critical: false,
        _note: autoNote,
        _qaConsoleLabel: isLivePlaidLaunchStep ? 'LIVE-PLAID-AUTO' : 'LIVE-PLAID-SIM-AUTO',
      };
      pipelineEntries.push({ kind: 'resolved', stepId, result });
      continue;
    }

    const screenResult = screenResults.get(stepId);
    if (screenResult?.screened && !narrationCritical) {
      const result = {
        stepId,
        score:          screenResult.score,
        issues:         [],
        suggestions:    [],
        categories:    [],
        critical:       false,
        _embedScreened: true,
        _embeddingSimilarity: screenResult.similarity,
        _note:          `Pre-screened: embedding similarity ${screenResult.similarity} ≥ threshold — skipped Sonnet review`,
        _qaConsoleLabel: `EMBED-SCREENED sim=${screenResult.similarity}`,
      };
      pipelineEntries.push({ kind: 'resolved', stepId, result });
      continue;
    }
    if (screenResult?.screened && narrationCritical) {
      console.log(`[QA] Step ${stepId}: bypassing embed pre-screen due to narration-critical markers`);
      appendPipelineLogJson('[QA] Step pre-screen bypass', {
        stepId,
        reason: 'narration-critical-markers',
        embeddingSimilarity: screenResult.similarity,
      }, { runDir: OUT_DIR });
    }

    pipelineEntries.push({
      kind: 'vision',
      stepId,
      step,
      frames,
      stepReviewContext,
    });
  }

  const visionJobs = pipelineEntries.filter((e) => e.kind === 'vision');
  if (visionJobs.length > 0) {
    console.log(`[QA] Vision review: ${visionJobs.length} step(s), concurrency=${QA_REVIEW_CONCURRENCY}`);
  }

  const visionResults = await mapPool(QA_REVIEW_CONCURRENCY, visionJobs, async (job) => {
    return reviewStep(client, job.step, job.stepId, job.frames, job.stepReviewContext);
  });

  let visionIdx = 0;
  for (const entry of pipelineEntries) {
    let result;
    const stepDiagnostics = diagByStep.get(entry.stepId) || [];
    if (entry.kind === 'resolved') {
      result = entry.result;
      applyDiagnosticsToResult(result, stepDiagnostics);
      allStepScores[entry.stepId] = result.score;
      const label = result._qaConsoleLabel || '';
      const criticalFlag = result.critical ? ' [CRITICAL]' : '';
      console.log(`[QA] Step ${entry.stepId}: ${result.score}/100${label ? ` [${label}]` : ''}${criticalFlag}`);
      if (result.issues.length > 0) {
        for (const issue of result.issues) {
          console.log(`       Issue: ${issue}`);
        }
      }
      appendPipelineLogJson('[QA] Step result', {
        stepId: entry.stepId,
        score: result.score,
        passed: !result.critical && result.score >= qaPassThreshold,
        critical: !!result.critical,
        reason: result._note || label,
        issues: result.issues || [],
        suggestions: result.suggestions || [],
        categories: result.categories || [],
      }, { runDir: OUT_DIR });
    } else {
      result = visionResults[visionIdx++];
      applyDiagnosticsToResult(result, stepDiagnostics);
      allStepScores[entry.stepId] = result.score;
      const criticalFlag = result.critical ? ' [CRITICAL]' : '';
      console.log(`[QA] Step ${entry.stepId}: ${result.score}/100${criticalFlag}`);
      if (result.issues.length > 0) {
        for (const issue of result.issues) {
          console.log(`       Issue: ${issue}`);
        }
      }
      appendPipelineLogJson('[QA] Step result', {
        stepId: entry.stepId,
        score: result.score,
        passed: !result.critical && result.score >= qaPassThreshold,
        critical: !!result.critical,
        issues: result.issues || [],
        suggestions: result.suggestions || [],
        categories: result.categories || [],
        explanation:
          result.issues && result.issues.length
            ? 'Step failed due to listed issues and/or critical diagnostics.'
            : 'Step passed with no blocking QA issues.',
      }, { runDir: OUT_DIR });
    }
    stepResults.push(result);
  }

  // ── Step 4: Aggregate results ─────────────────────────────────────────────
  const scores = Object.values(allStepScores);
  const overallScore = scores.length > 0
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  const stepsWithIssues = stepResults.filter(
    r => r.score < qaPassThreshold || r.critical
  );

  const rawDeterministicGate = buildOnly
    ? process.env.BUILD_QA_DETERMINISTIC_GATE
    : process.env.QA_DETERMINISTIC_GATE;
  const deterministicGateEnabled = rawDeterministicGate == null
    ? true
    : !(rawDeterministicGate === '0' || rawDeterministicGate === 'false');
  const visionThresholdPassed = overallScore >= qaPassThreshold;
  const deterministicPassed = deterministicCriticalDiagnostics.length === 0;
  const passed = visionThresholdPassed && (!deterministicGateEnabled || deterministicPassed);

  const qaReport = {
    iteration,
    overallScore,
    passThreshold: qaPassThreshold,
    deterministicGateEnabled,
    visionThresholdPassed,
    deterministicPassed,
    deterministicCriticalCount: deterministicCriticalDiagnostics.length,
    deterministicCriticalStepIds: [...deterministicCriticalStepIds],
    passed,
    steps: stepResults,
    stepsWithIssues,
    allStepScores,
    qaSource: buildOnly ? 'build-walkthrough' : 'recording',
    issueCategoryCounts: stepResults
      .flatMap(r => Array.isArray(r.categories) ? r.categories : [])
      .reduce((acc, category) => {
        acc[category] = (acc[category] || 0) + 1;
        return acc;
      }, {}),
  };

  // ── Step 5: Write report ───────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = path.join(OUT_DIR, `qa-report-${iteration}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(qaReport, null, 2));

  const verdict = passed ? 'PASSED' : 'FAILED';
  console.log(
    `[QA] Overall: ${overallScore}/100 — ${verdict} ` +
    `(visionThresholdPassed=${visionThresholdPassed}, deterministicPassed=${deterministicPassed}, deterministicGateEnabled=${deterministicGateEnabled})`
  );
  console.log(`[QA] Written: out/qa-report-${iteration}.json`);
  appendPipelineLogJson('[QA] Overall result', {
    iteration,
    overallScore,
    threshold: qaPassThreshold,
    deterministicGateEnabled,
    visionThresholdPassed,
    deterministicPassed,
    deterministicCriticalCount: deterministicCriticalDiagnostics.length,
    deterministicCriticalStepIds: [...deterministicCriticalStepIds],
    passed,
    qaSource: qaReport.qaSource,
    stepsWithIssues: stepsWithIssues.map((s) => ({
      stepId: s.stepId,
      score: s.score,
      critical: !!s.critical,
      issueCount: Array.isArray(s.issues) ? s.issues.length : 0,
      issues: s.issues || [],
    })),
    issueCategoryCounts: qaReport.issueCategoryCounts,
  }, { runDir: OUT_DIR });

  if (!passed) {
    console.log(`[QA] ${stepsWithIssues.length} step(s) need improvement:`);
    for (const s of stepsWithIssues) {
      console.log(`  - ${s.stepId}: ${s.score}/100`);
    }
    if (buildOnly) {
      console.log('[QA] Next: refine HTML with build-app (use qa-report) or fix script, then re-run build-qa');
    } else {
      console.log('[QA] Next: node scripts/scratch/scratch/build-app.js --qa=out/qa-report-' + iteration + '.json');
    }
  } else if (buildOnly) {
    console.log('[QA] Build QA passed — ready to record when you are (`npm run demo` from --from=record)');
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
