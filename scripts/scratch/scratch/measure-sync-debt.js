'use strict';
/**
 * measure-sync-debt.js
 *
 * Compares recorded video step durations against narration-audio durations
 * (or word-count estimates when audio doesn't exist yet) and classifies
 * each step's drift so the downstream pipeline can decide whether to:
 *   - leave audio as-is (within tolerance)
 *   - rewrite + regenerate narration (audio-too-long / audio-too-short)
 *   - clip video at the conservative 1.4× cap (video-too-long)
 *   - request re-record OR substitute a build-qa frame (video-too-short)
 *
 * The historical pipeline used `auto-gap.js` for this planning role, but
 * auto-gap was hard-coded to make the *video* fit the *narration* (speeds
 * up to 2.5× or freezes for any duration). The result was unwatchable
 * "speedrun" video on long steps and multi-second freezes on short ones.
 *
 * This module inverts the relationship: the recording is treated as the
 * schedule, the narration must fit. auto-gap remains as the sync-map
 * writer, but only after sync-debt has trimmed the cases where it would
 * have to do something extreme.
 *
 * Reads:
 *   step-timing.json                  (raw recording boundaries)
 *   processed-step-timing.json        (post-process keepRanges, optional)
 *   demo-script.json                  (per-step narration text + classification hints)
 *   voiceover-manifest.json           (optional — when audio already exists)
 *
 * Writes:
 *   sync-debt-report.json             (per-step classification + targets)
 *
 * Public API:
 *   const { main, classifyStep, computeWordTarget } = require('./measure-sync-debt');
 *   await main();                    // reads PIPELINE_RUN_DIR, writes the report
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const RUN_DIR = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');

// Calibration ─ measured on multiple Tilt / Zip / Betterment runs.
//   • ElevenLabs multilingual_v2 at stability=0.75 averages ~170 WPM for
//     pipeline narration (including inter-sentence pauses).
//   • A 1.5-second tolerance band keeps the classifier from churning on
//     micro-drift caused by ffmpeg key-frame snapping.
//   • Video-too-short threshold is 40% of scripted duration — below that
//     the step was almost certainly skipped (Tilt v2's `advance-approved`
//     at 1.8 s out of a 6 s scripted = 30%).
const NARRATION_WPM = parseInt(process.env.SYNC_DEBT_NARRATION_WPM || '170', 10);
const TOLERANCE_MS = parseInt(process.env.SYNC_DEBT_TOLERANCE_MS || '1500', 10);
const AUDIO_DRIFT_TRIGGER_MS = parseInt(process.env.SYNC_DEBT_AUDIO_DRIFT_TRIGGER_MS || '1500', 10);
const VIDEO_LONG_DRIFT_MAX_MS = parseInt(process.env.SYNC_DEBT_VIDEO_LONG_DRIFT_MAX_MS || '3000', 10);
const VIDEO_SHORT_RATIO = parseFloat(process.env.SYNC_DEBT_VIDEO_SHORT_RATIO || '0.4');

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function wordsOf(text) {
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Convert an audio target duration (ms) to a word count under the
 * configured speech rate. Used when the audio doesn't yet exist and we
 * need to predict how many words to rewrite the narration to.
 *
 * @param {number} targetMs
 * @returns {number}
 */
function computeWordTarget(targetMs) {
  const minutes = Math.max(0.05, targetMs / 60000);
  return Math.max(4, Math.round(minutes * NARRATION_WPM));
}

/**
 * Classify a single step. Pure function — feed it numbers, get a verdict.
 *
 * @param {object} args
 * @param {string} args.stepId
 * @param {number} args.videoMs           recorded duration
 * @param {number} args.narrationMs       current audio duration (or estimate)
 * @param {number} args.scriptedMs        durationHintMs from demo-script
 * @param {boolean} [args.isPlaidLink]    Plaid sub-step (looser tolerance)
 * @returns {{ classification, driftMs, recommendedVideoMs, recommendedNarrationMs, wordTarget, reason }}
 */
function classifyStep(args) {
  const stepId = args.stepId || '(unknown)';
  const videoMs = Number(args.videoMs) || 0;
  const narrationMs = Number(args.narrationMs) || 0;
  const scriptedMs = Number(args.scriptedMs) || 0;
  const isPlaidLink = Boolean(args.isPlaidLink);

  const driftMs = narrationMs - videoMs;
  const absDrift = Math.abs(driftMs);

  // Special case: the recording captured almost nothing. The step was
  // clicked through too fast or never rendered. No amount of narration
  // rewriting fixes this — the operator must re-record OR the pipeline
  // must paste a still frame from build-qa.
  if (scriptedMs > 0 && videoMs > 0 && videoMs < scriptedMs * VIDEO_SHORT_RATIO) {
    return {
      stepId,
      classification: 'video-too-short',
      driftMs,
      recommendedVideoMs: Math.max(scriptedMs, narrationMs),
      recommendedNarrationMs: narrationMs,
      wordTarget: computeWordTarget(narrationMs),
      reason: `recorded ${videoMs}ms is below ${Math.round(VIDEO_SHORT_RATIO * 100)}% of scripted ${scriptedMs}ms — step was likely skipped or unrendered`,
    };
  }

  // Within tolerance — keep both audio and video as-is.
  const tolerance = isPlaidLink ? TOLERANCE_MS * 2 : TOLERANCE_MS;
  if (absDrift <= tolerance) {
    return {
      stepId,
      classification: 'within-tolerance',
      driftMs,
      recommendedVideoMs: videoMs,
      recommendedNarrationMs: narrationMs,
      wordTarget: null,
      reason: `drift ${driftMs}ms within ±${tolerance}ms`,
    };
  }

  // Audio longer than video → narration should be rewritten shorter so
  // it fits the actual on-screen duration. Target = videoMs + a 600 ms
  // breathing tail so the last word doesn't crash into the next step.
  if (driftMs > 0) {
    const targetNarrationMs = Math.max(2500, videoMs + 600);
    return {
      stepId,
      classification: 'audio-too-long',
      driftMs,
      recommendedVideoMs: videoMs,
      recommendedNarrationMs: targetNarrationMs,
      wordTarget: computeWordTarget(targetNarrationMs),
      reason: `audio overruns video by ${driftMs}ms; rewrite narration to ~${computeWordTarget(targetNarrationMs)} words`,
    };
  }

  // Video longer than audio by a lot → rewrite narration LONGER so it
  // covers the dwell time without forcing auto-gap to clip past 1.4×.
  // The 3 s ceiling stops us from chasing every tiny gap.
  if (absDrift > VIDEO_LONG_DRIFT_MAX_MS) {
    const targetNarrationMs = Math.max(narrationMs, videoMs - 800);
    return {
      stepId,
      classification: 'audio-too-short',
      driftMs,
      recommendedVideoMs: videoMs,
      recommendedNarrationMs: targetNarrationMs,
      wordTarget: computeWordTarget(targetNarrationMs),
      reason: `video overruns audio by ${absDrift}ms; rewrite narration to ~${computeWordTarget(targetNarrationMs)} words OR trim dead air`,
    };
  }

  // Small video overrun (1.5–3 s). Tolerable for auto-gap to clip at
  // ≤1.4× speed — no narration rewrite required.
  return {
    stepId,
    classification: 'video-too-long',
    driftMs,
    recommendedVideoMs: videoMs,
    recommendedNarrationMs: narrationMs,
    wordTarget: null,
    reason: `video overruns audio by ${absDrift}ms; auto-gap will clip at ≤1.4×`,
  };
}

/**
 * @typedef {object} SyncDebtReport
 * @property {string} generatedAt
 * @property {string} sources
 * @property {object} summary
 * @property {Array<object>} steps
 */

/**
 * @param {string} [runDir]
 * @returns {Promise<SyncDebtReport>}
 */
async function main(runDir) {
  const outDir = runDir || RUN_DIR;
  const stepTimingPath = path.join(outDir, 'step-timing.json');
  const demoScriptPath = path.join(outDir, 'demo-script.json');
  const voiceoverManifestPath = path.join(outDir, 'voiceover-manifest.json');

  const stepTiming = safeReadJson(stepTimingPath);
  const demoScript = safeReadJson(demoScriptPath);
  const voiceoverManifest = safeReadJson(voiceoverManifestPath);

  if (!stepTiming) {
    console.warn('[measure-sync-debt] step-timing.json missing — skipping (run record first).');
    return { generatedAt: new Date().toISOString(), skipped: true, reason: 'no-step-timing' };
  }
  if (!demoScript) {
    console.warn('[measure-sync-debt] demo-script.json missing — skipping.');
    return { generatedAt: new Date().toISOString(), skipped: true, reason: 'no-demo-script' };
  }

  const recordedSteps = Array.isArray(stepTiming.steps) ? stepTiming.steps : [];
  const scriptSteps = Array.isArray(demoScript.steps) ? demoScript.steps : [];
  const audioClips = Array.isArray(voiceoverManifest?.clips) ? voiceoverManifest.clips : [];

  const audioByStep = new Map();
  for (const clip of audioClips) {
    if (clip?.stepId) audioByStep.set(clip.stepId, clip);
  }
  const scriptByStep = new Map();
  for (const s of scriptSteps) {
    if (s?.id) scriptByStep.set(s.id, s);
  }

  const reportSteps = [];
  for (const recorded of recordedSteps) {
    const scriptStep = scriptByStep.get(recorded.id) || {};
    const audioClip = audioByStep.get(recorded.id) || null;

    // narrationMs: prefer existing audio; otherwise estimate from word count.
    const narrationFromAudio = audioClip ? Number(audioClip.audioDurationMs || audioClip.durationMs || 0) : 0;
    const narrationFromText = computeNarrationFromText(scriptStep.narration);
    const narrationMs = narrationFromAudio > 0 ? narrationFromAudio : narrationFromText;
    const narrationSource = narrationFromAudio > 0 ? 'audio' : 'estimate';

    const isPlaidLink = /^(plaid-link|wf-link-|link-)/i.test(recorded.id || '');

    const verdict = classifyStep({
      stepId: recorded.id,
      videoMs: recorded.durationMs || 0,
      narrationMs,
      scriptedMs: Number(scriptStep.durationHintMs || 0),
      isPlaidLink,
    });

    reportSteps.push({
      ...verdict,
      videoMs: recorded.durationMs || 0,
      narrationMs,
      narrationSource,
      scriptedMs: Number(scriptStep.durationHintMs || 0),
      isPlaidLink,
      narrationText: scriptStep.narration || '',
      currentWordCount: wordsOf(scriptStep.narration || ''),
    });
  }

  const summary = summarize(reportSteps);
  const report = {
    generatedAt: new Date().toISOString(),
    sources: {
      stepTiming: 'step-timing.json',
      demoScript: 'demo-script.json',
      voiceoverManifest: voiceoverManifest ? 'voiceover-manifest.json' : null,
    },
    config: {
      narrationWpm: NARRATION_WPM,
      toleranceMs: TOLERANCE_MS,
      videoLongDriftMaxMs: VIDEO_LONG_DRIFT_MAX_MS,
      videoShortRatio: VIDEO_SHORT_RATIO,
    },
    summary,
    steps: reportSteps,
  };

  const outFile = path.join(outDir, 'sync-debt-report.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(`[measure-sync-debt] Wrote ${path.relative(PROJECT_ROOT, outFile)} — ` +
    `${summary.withinTolerance} ok, ${summary.audioTooLong} audio-too-long, ${summary.audioTooShort} audio-too-short, ` +
    `${summary.videoTooLong} video-too-long, ${summary.videoTooShort} video-too-short.`);
  return report;
}

function computeNarrationFromText(text) {
  if (!text) return 0;
  const words = wordsOf(text);
  return Math.round((words / NARRATION_WPM) * 60000);
}

function summarize(steps) {
  const summary = {
    totalSteps: steps.length,
    withinTolerance: 0,
    audioTooLong: 0,
    audioTooShort: 0,
    videoTooLong: 0,
    videoTooShort: 0,
    needsNarrationRepace: 0,
    needsReRecord: 0,
  };
  for (const s of steps) {
    switch (s.classification) {
      case 'within-tolerance': summary.withinTolerance += 1; break;
      case 'audio-too-long': summary.audioTooLong += 1; summary.needsNarrationRepace += 1; break;
      case 'audio-too-short': summary.audioTooShort += 1; summary.needsNarrationRepace += 1; break;
      case 'video-too-long': summary.videoTooLong += 1; break;
      case 'video-too-short': summary.videoTooShort += 1; summary.needsReRecord += 1; break;
    }
  }
  return summary;
}

module.exports = {
  main,
  classifyStep,
  computeWordTarget,
  computeNarrationFromText,
  summarize,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[measure-sync-debt] Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
