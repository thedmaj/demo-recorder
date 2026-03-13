/**
 * combine.js
 *
 * Mode C pipeline — Stitch multiple video segments (user-recorded + Claude-built)
 * into one combined video with globally consistent timestamps.
 *
 * Reads:  out/pipeline-plan.json  (required — segments array)
 *         per-segment step-timing files as referenced in pipeline-plan.json
 * Runs:   ffmpeg concat
 * Writes: out/step-timing.json  (merged, globally offset)
 *         public/recording.webm (canonical output for downstream stages)
 *
 * pipeline-plan.json segments schema:
 * {
 *   "segments": [
 *     {
 *       "type": "recorded" | "built",
 *       "videoFile": "path/to/segment.webm",
 *       "stepTimingFile": "path/to/seg-N-step-timing.json or null"
 *     }
 *   ]
 * }
 *
 * Usage (CLI):
 *   node scripts/scratch/enhance/combine.js
 *
 * Usage (programmatic):
 *   const { combine } = require('./combine');
 *   await combine(segments);  // segments array as above
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = process.env.PIPELINE_RUN_DIR || path.join(ROOT, 'out');
const PIPELINE_PLAN_FILE = path.join(OUT_DIR, 'pipeline-plan.json');
const COMBINED_VIDEO = path.join(OUT_DIR, 'combined.webm');
const OUT_STEP_TIMING = path.join(OUT_DIR, 'step-timing.json');

const FPS = 30;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recalculate frame numbers from ms at 30fps.
 * @param {number} ms
 * @returns {number}
 */
function msToFrame(ms) {
  return Math.round(ms / 1000 * FPS);
}

/**
 * Get video duration in ms using ffprobe.
 * Falls back to reading totalMs from the segment's step-timing file.
 * @param {string} videoFile
 * @param {object|null} stepTiming
 * @returns {number}
 */
function getSegmentDurationMs(videoFile, stepTiming) {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoFile}"`,
      { encoding: 'utf8' }
    );
    const secs = parseFloat(result.trim());
    if (!isNaN(secs)) return Math.round(secs * 1000);
  } catch (err) {
    console.warn(`[combine] Warning: ffprobe failed for ${videoFile}: ${err.message}`);
  }

  if (stepTiming && typeof stepTiming.totalMs === 'number') {
    console.warn(`[combine] Falling back to step-timing totalMs for duration: ${stepTiming.totalMs}ms`);
    return stepTiming.totalMs;
  }

  throw new Error(`Cannot determine duration for segment: ${videoFile}`);
}

/**
 * Apply a cumulative offset to all step timestamps in a step-timing object.
 * Returns a new array of steps with adjusted times.
 * @param {Array} steps
 * @param {number} offsetMs
 * @returns {Array}
 */
function applyOffset(steps, offsetMs) {
  return steps.map(step => {
    const startMs = step.startMs + offsetMs;
    const endMs = step.endMs + offsetMs;
    return {
      ...step,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      startFrame: msToFrame(startMs),
      endFrame: msToFrame(endMs),
      durationFrames: msToFrame(endMs - startMs),
    };
  });
}

// ── Core combine logic ────────────────────────────────────────────────────────

/**
 * Stitch segments and produce merged step-timing.json + public/recording.webm.
 *
 * @param {Array<{
 *   type: string,
 *   videoFile: string,
 *   stepTimingFile: string|null
 * }>} segments
 */
async function combine(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('combine() requires a non-empty segments array');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[combine] Processing ${segments.length} segment(s)...`);

  // Resolve absolute paths and load step timings
  const resolvedSegments = segments.map((seg, i) => {
    const videoFile = path.resolve(ROOT, seg.videoFile);
    if (!fs.existsSync(videoFile)) {
      throw new Error(`Segment ${i} video file not found: ${videoFile}`);
    }

    let stepTiming = null;
    if (seg.stepTimingFile) {
      const timingFile = path.resolve(ROOT, seg.stepTimingFile);
      if (fs.existsSync(timingFile)) {
        stepTiming = JSON.parse(fs.readFileSync(timingFile, 'utf8'));
      } else {
        console.warn(`[combine] Step timing file not found for segment ${i}: ${timingFile}`);
      }
    }

    return { ...seg, videoFile, stepTiming };
  });

  // Build ffmpeg concat list
  const concatListPath = path.join(OUT_DIR, 'segments.txt');
  const concatLines = resolvedSegments.map(seg => `file '${seg.videoFile}'`).join('\n');
  fs.writeFileSync(concatListPath, concatLines + '\n');
  console.log(`[combine] Wrote concat list: ${concatListPath}`);

  // Run ffmpeg concat
  console.log('[combine] Running ffmpeg concat...');
  execSync(
    `ffmpeg -f concat -safe 0 -i "${concatListPath}" -c copy "${COMBINED_VIDEO}" -y`,
    { stdio: 'inherit' }
  );
  console.log(`[combine] Combined video written: ${COMBINED_VIDEO}`);

  // Build merged step-timing with cumulative offsets
  const allSteps = [];
  let totalFrames = 0;
  let offsetMs = 0;

  for (let i = 0; i < resolvedSegments.length; i++) {
    const seg = resolvedSegments[i];
    const segDurationMs = getSegmentDurationMs(seg.videoFile, seg.stepTiming);

    if (seg.stepTiming && Array.isArray(seg.stepTiming.steps)) {
      const offsetSteps = applyOffset(seg.stepTiming.steps, offsetMs);
      allSteps.push(...offsetSteps);
      console.log(
        `[combine] Segment ${i} (${seg.type}): ${seg.stepTiming.steps.length} steps, ` +
        `offset +${offsetMs}ms, duration ${segDurationMs}ms`
      );
    } else {
      console.warn(`[combine] Segment ${i} (${seg.type}): no step timing available — skipping steps`);
    }

    offsetMs += segDurationMs;
    totalFrames += msToFrame(segDurationMs);
  }

  const mergedStepTiming = {
    totalMs: offsetMs,
    totalFrames,
    steps: allSteps,
  };

  fs.writeFileSync(OUT_STEP_TIMING, JSON.stringify(mergedStepTiming, null, 2));
  console.log(`[combine] Merged step-timing written: ${OUT_STEP_TIMING} (${allSteps.length} total steps)`);

  // Copy combined to recording.webm in run dir for downstream stages
  const runRecording = path.join(OUT_DIR, 'recording.webm');
  fs.copyFileSync(COMBINED_VIDEO, runRecording);
  console.log(`[combine] Canonical output: ${runRecording}`);

  return mergedStepTiming;
}

// ── Main (CLI entry point) ────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(PIPELINE_PLAN_FILE)) {
    throw new Error(`Required input not found: ${PIPELINE_PLAN_FILE}`);
  }

  const pipelinePlan = JSON.parse(fs.readFileSync(PIPELINE_PLAN_FILE, 'utf8'));

  if (!Array.isArray(pipelinePlan.segments) || pipelinePlan.segments.length === 0) {
    throw new Error('pipeline-plan.json must have a non-empty "segments" array');
  }

  await combine(pipelinePlan.segments);
}

module.exports = { combine, main };

if (require.main === module) {
  main().catch(err => {
    console.error('[combine] Fatal error:', err.message);
    process.exit(1);
  });
}
