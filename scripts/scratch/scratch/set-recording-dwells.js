'use strict';
/**
 * set-recording-dwells.js
 *
 * Compute per-step recording dwell durations from narration text BEFORE the
 * record stage runs. This makes the recorded video FIT the narration, not
 * the other way around — the philosophy the rest of the pipeline assumed
 * but never enforced upstream.
 *
 * Why this exists: previously the playwright-script.json's waitMs was set
 * by build-app from `durationHintMs` (a coarse scripted intent) plus its
 * own click-pacing heuristics. Narration generated later by ElevenLabs
 * frequently outran the recorded screen time, then auto-gap had to either
 * (a) speed the video to ≤ 1.4× — looking rushed, or (b) freeze the last
 * frame for multi-second tails — looking stuck. The user feedback after
 * loop 10 of the Tilt v2 run: "the demo scenes seemed rushed because the
 * narration is short. … determine appropriate length of scene according
 * to narration and have playwright adjust recording length appropriately."
 *
 * What this does:
 *   • Read demo-script.json (narration per step).
 *   • Estimate narration duration per step at NARRATION_WPM (default 170,
 *     same as measure-sync-debt).
 *   • For every entry in playwright-script.json: set waitMs to the larger
 *     of (a) the entry's existing waitMs (preserves Plaid Link 120 s
 *     safety budget and any author override) and (b) the narration
 *     estimate plus an inter-scene buffer.
 *   • Write back to playwright-script.json AND record an audit-trail at
 *     recording-dwell-plan.json.
 *
 * Idempotent: stamps `dwellPlanAt` in playwright-script.json so re-runs
 * detect when the dwells are already current.
 *
 * Reads:
 *   demo-script.json
 *   scratch-app/playwright-script.json   (or the root-level fallback)
 *
 * Writes:
 *   scratch-app/playwright-script.json   (waitMs overrides, dwellPlanAt)
 *   recording-dwell-plan.json            (per-step audit)
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const RUN_DIR = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');

// Same WPM calibration that measure-sync-debt uses so the two stages agree
// on what "narration takes N seconds" means.
const NARRATION_WPM = parseInt(process.env.DWELL_PLAN_NARRATION_WPM || process.env.SYNC_DEBT_NARRATION_WPM || '170', 10);

// Inter-scene buffer added on top of the narration estimate. The recording
// captures the step for narration + buffer so the last syllable lands a
// half-second before the next step's click. ElevenLabs sentence pauses
// and the natural eye-saccade time after a key UI change put this around
// 1.5 s for clear readability.
const INTER_SCENE_BUFFER_MS = parseInt(process.env.DWELL_PLAN_BUFFER_MS || '1500', 10);

// Hard ceiling so a stray long narration (e.g. 90 words on a click step)
// doesn't pin Playwright to a 30+ s dwell where the screen has nothing
// new to show. Above the ceiling the operator is expected to either trim
// the narration or split the step.
const MAX_DWELL_MS = parseInt(process.env.DWELL_PLAN_MAX_MS || '30000', 10);

// Floor — even a one-word narration should give the eye time to read the
// transition. Matches the existing build-app pacing minimums.
const MIN_DWELL_MS = parseInt(process.env.DWELL_PLAN_MIN_MS || '2500', 10);

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return null; }
}

function wordsOf(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

function estimateNarrationMs(narration) {
  const words = wordsOf(narration);
  if (words === 0) return 0;
  return Math.round((words / NARRATION_WPM) * 60000);
}

/**
 * Compute the recommended dwell (post-narration buffer included), clamped
 * to [MIN_DWELL_MS, MAX_DWELL_MS]. Plaid Link launch steps (waitMs >= 60 s)
 * are passed through — they have their own success-flag wait that this
 * function must not shorten.
 */
function recommendedDwellMs(narration, existingWaitMs, isPlaidLaunch) {
  if (isPlaidLaunch) return existingWaitMs || 120000;
  const narrationMs = estimateNarrationMs(narration);
  if (narrationMs === 0) return existingWaitMs || MIN_DWELL_MS;
  const target = narrationMs + INTER_SCENE_BUFFER_MS;
  const clamped = Math.max(MIN_DWELL_MS, Math.min(MAX_DWELL_MS, target));
  // Never shrink the existing waitMs — Plaid Link safety windows and any
  // author-supplied longer values must be preserved. We only ever extend.
  return Math.max(existingWaitMs || 0, clamped);
}

function isPlaidLaunchEntry(entry) {
  if (!entry) return false;
  if ((entry.plaidPhase || '').toLowerCase() === 'launch') return true;
  if (entry.action === 'click' && typeof entry.target === 'string' &&
      /link[-_]external[-_]account|connect[-_]bank|open[-_]link|link[-_]account[-_]btn|btn[-_]link|link[-_]bank|start[-_]link|initiate[-_]link|plaid[-_]link[-_]btn/i.test(entry.target)) {
    return true;
  }
  // 60 s+ existing waitMs is the historical signal for "this is a Plaid
  // safety budget, don't touch it."
  if (Number(entry.waitMs) >= 60000) return true;
  return false;
}

function resolvePlaywrightScriptPath(runDir) {
  const candidates = [
    path.join(runDir, 'scratch-app', 'playwright-script.json'),
    path.join(runDir, 'playwright-script.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function main(runDir) {
  const outDir = runDir || RUN_DIR;
  const demoScriptPath = path.join(outDir, 'demo-script.json');
  const playwrightScriptPath = resolvePlaywrightScriptPath(outDir);

  const demoScript = safeReadJson(demoScriptPath);
  if (!demoScript) {
    console.log('[set-recording-dwells] demo-script.json missing — skipping.');
    return { skipped: true, reason: 'no-demo-script' };
  }
  if (!playwrightScriptPath) {
    console.log('[set-recording-dwells] playwright-script.json missing — skipping (run build first).');
    return { skipped: true, reason: 'no-playwright-script' };
  }
  const playwrightScript = safeReadJson(playwrightScriptPath);
  if (!playwrightScript || !Array.isArray(playwrightScript.steps)) {
    console.log('[set-recording-dwells] playwright-script.json has no steps[].');
    return { skipped: true, reason: 'no-steps' };
  }

  const narrationByStep = new Map(
    (demoScript.steps || []).map((s) => [s.id, s.narration || ''])
  );

  const rows = [];
  let changed = 0;
  for (const entry of playwrightScript.steps) {
    const stepId = entry.id || entry.stepId;
    if (!stepId) {
      rows.push({ stepId: null, skipped: true, reason: 'no-stepId' });
      continue;
    }
    const narration = narrationByStep.get(stepId) || '';
    const existingMs = Number(entry.waitMs || 0) || 0;
    const plaidLaunch = isPlaidLaunchEntry(entry);
    const recommendedMs = recommendedDwellMs(narration, existingMs, plaidLaunch);
    const row = {
      stepId,
      action: entry.action || null,
      wordCount: wordsOf(narration),
      narrationMs: estimateNarrationMs(narration),
      existingWaitMs: existingMs,
      recommendedWaitMs: recommendedMs,
      plaidLaunch,
      action_taken: recommendedMs !== existingMs ? 'extended' : 'unchanged',
    };
    if (recommendedMs !== existingMs) {
      entry.waitMs = recommendedMs;
      changed += 1;
    }
    rows.push(row);
  }

  if (changed > 0) {
    playwrightScript.dwellPlanAt = new Date().toISOString();
    playwrightScript.dwellPlanWpm = NARRATION_WPM;
    playwrightScript.dwellPlanBufferMs = INTER_SCENE_BUFFER_MS;
    fs.writeFileSync(
      playwrightScriptPath,
      JSON.stringify(playwrightScript, null, 2),
      'utf8'
    );
    console.log(`[set-recording-dwells] Updated ${changed}/${rows.length} entries in ${path.relative(PROJECT_ROOT, playwrightScriptPath)} (WPM=${NARRATION_WPM}, buffer=${INTER_SCENE_BUFFER_MS}ms).`);
  } else {
    console.log(`[set-recording-dwells] No dwell adjustments needed — ${rows.length} step(s) already match narration.`);
  }

  // Human-readable summary
  for (const r of rows) {
    if (r.skipped) {
      console.log(`  ${(r.stepId || '?').padEnd(34)} SKIP ${r.reason}`);
      continue;
    }
    const arrow = r.action_taken === 'extended' ? '→' : ' ';
    console.log(`  ${r.stepId.padEnd(34)} narr=${(r.narrationMs / 1000).toFixed(1)}s ` +
      `(${r.wordCount}w) wait=${(r.existingWaitMs / 1000).toFixed(1)}s ${arrow} ${(r.recommendedWaitMs / 1000).toFixed(1)}s ` +
      (r.plaidLaunch ? '[plaid-launch]' : ''));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      narrationWpm: NARRATION_WPM,
      interSceneBufferMs: INTER_SCENE_BUFFER_MS,
      minDwellMs: MIN_DWELL_MS,
      maxDwellMs: MAX_DWELL_MS,
    },
    summary: {
      totalSteps: rows.length,
      extended: rows.filter((r) => r.action_taken === 'extended').length,
      unchanged: rows.filter((r) => r.action_taken === 'unchanged').length,
      plaidLaunchSteps: rows.filter((r) => r.plaidLaunch).length,
    },
    rows,
  };
  fs.writeFileSync(
    path.join(outDir, 'recording-dwell-plan.json'),
    JSON.stringify(report, null, 2),
    'utf8'
  );

  return { skipped: false, ...report };
}

module.exports = {
  main,
  estimateNarrationMs,
  recommendedDwellMs,
  isPlaidLaunchEntry,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[set-recording-dwells] Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
