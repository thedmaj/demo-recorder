/**
 * segment.js
 *
 * Mode B/C pipeline — Stage 2: Identify logical demo step boundaries.
 *
 * Reads:  out/video-analysis.json (required)
 *         out/product-research.json (optional)
 * Calls:  claude-opus-4-7 with extended thinking (budget_tokens: 8000)
 * Writes: out/step-timing.json
 *
 * Fallback: if transcript has no word timestamps, distributes frames evenly
 * into 8 steps based on total duration.
 *
 * Usage:
 *   node scripts/scratch/enhance/segment.js
 */

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = process.env.PIPELINE_RUN_DIR || path.join(ROOT, 'out');
const VIDEO_ANALYSIS_FILE = path.join(OUT_DIR, 'video-analysis.json');
const PRODUCT_RESEARCH_FILE = path.join(OUT_DIR, 'product-research.json');
const OUT_FILE = path.join(OUT_DIR, 'step-timing.json');

const FPS = 30;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract JSON from a Claude response that may contain fenced or raw JSON.
 * @param {string} text
 * @returns {object}
 */
function extractJSON(text) {
  // Try fenced JSON first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    return JSON.parse(fenced[1].trim());
  }
  // Try raw JSON starting with {
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    return JSON.parse(text.slice(firstBrace));
  }
  throw new Error('No JSON found in response');
}

/**
 * Build frame numbers from millisecond timestamps.
 * @param {number} ms
 * @returns {number}
 */
function msToFrame(ms) {
  return Math.round(ms / 1000 * FPS);
}

// ── Fallback segmentation ────────────────────────────────────────────────────

/**
 * When no word-level timestamps are available, distribute frames evenly into
 * 8 steps covering the full duration.
 * @param {{ durationMs: number, frames: Array }} videoAnalysis
 * @returns {object} step-timing.json structure
 */
function buildFallbackSteps(videoAnalysis) {
  const { durationMs, frames } = videoAnalysis;
  const totalFrames = frames.length;
  const NUM_STEPS = 8;
  const stepDurationMs = Math.floor(durationMs / NUM_STEPS);

  const steps = [];
  for (let i = 0; i < NUM_STEPS; i++) {
    const startMs = i * stepDurationMs;
    const endMs = i === NUM_STEPS - 1 ? durationMs : (i + 1) * stepDurationMs;
    const durationMs_ = endMs - startMs;
    const id = String(i + 1).padStart(2, '0') + '-step';
    steps.push({
      id,
      label: `Step ${i + 1}`,
      startMs,
      endMs,
      durationMs: durationMs_,
      startFrame: msToFrame(startMs),
      endFrame: msToFrame(endMs),
      durationFrames: msToFrame(durationMs_),
    });
  }

  return {
    totalMs: durationMs,
    totalFrames,
    steps,
  };
}

// ── Claude segmentation ──────────────────────────────────────────────────────

async function segmentWithClaude(videoAnalysis, productResearch) {
  const productContext = productResearch
    ? `\n\n## PRODUCT RESEARCH (use for accurate Plaid terminology in step labels)\n${
        productResearch.synthesizedInsights || JSON.stringify(productResearch, null, 2)
      }`
    : '';

  const transcriptSection = videoAnalysis.transcript && videoAnalysis.transcript.words && videoAnalysis.transcript.words.length > 0
    ? `\n\n## TRANSCRIPT (word-level timestamps)\n${JSON.stringify(videoAnalysis.transcript, null, 2)}`
    : `\n\n## TRANSCRIPT\nNo word-level timestamps available. Full text: ${
        (videoAnalysis.transcript && videoAnalysis.transcript.text) || '(none)'
      }`;

  const userText =
    `You are analyzing a rough demo recording to identify the logical demo steps. ` +
    `You have word-level timestamps from the narration and frame-by-frame descriptions. ` +
    `Group the content into 8–15 distinct steps. For each step: find the start/end times ` +
    `from word timestamps, label the step using official Plaid terminology, output timing ` +
    `in the step-timing.json schema.\n` +
    `\nVideo duration: ${videoAnalysis.durationMs}ms` +
    `\nTotal frames: ${videoAnalysis.frames ? videoAnalysis.frames.length : 0}` +
    productContext +
    transcriptSection +
    `\n\n## FRAME DESCRIPTIONS (1 per second)\n${JSON.stringify(videoAnalysis.frames || [], null, 2)}` +
    `\n\nOutput ONLY a JSON object matching this schema — no prose, no markdown fences:\n\n` +
    `{\n` +
    `  "totalMs": <number>,\n` +
    `  "totalFrames": <number>,\n` +
    `  "steps": [\n` +
    `    {\n` +
    `      "id": "<kebab-case, e.g. 01-welcome>",\n` +
    `      "label": "<Plaid-accurate label>",\n` +
    `      "startMs": <number>,\n` +
    `      "endMs": <number>,\n` +
    `      "durationMs": <number>,\n` +
    `      "startFrame": <number at 30fps>,\n` +
    `      "endFrame": <number at 30fps>,\n` +
    `      "durationFrames": <number>\n` +
    `    }\n` +
    `  ]\n` +
    `}`;

  console.log('[segment] Calling claude-opus-4-7 with extended thinking...');

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 16000,
    thinking: {
      type: 'enabled',
      budget_tokens: 8000,
    },
    messages: [{ role: 'user', content: userText }],
  });

  // Extract text content (skip thinking blocks)
  const textContent = response.content.find(b => b.type === 'text');
  if (!textContent) {
    throw new Error('Claude returned no text content');
  }

  return extractJSON(textContent.text);
}

// ── Normalise and validate output ────────────────────────────────────────────

/**
 * Ensure all frame numbers are recalculated at 30fps and fields are present.
 * @param {object} timing
 * @returns {object}
 */
function normaliseStepTiming(timing) {
  timing.steps = timing.steps.map(step => {
    const startFrame = msToFrame(step.startMs);
    const endFrame = msToFrame(step.endMs);
    return {
      ...step,
      durationMs: step.endMs - step.startMs,
      startFrame,
      endFrame,
      durationFrames: endFrame - startFrame,
    };
  });
  return timing;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load required input
  if (!fs.existsSync(VIDEO_ANALYSIS_FILE)) {
    throw new Error(`Required input not found: ${VIDEO_ANALYSIS_FILE}. Run analyze-video.js first.`);
  }
  const videoAnalysis = JSON.parse(fs.readFileSync(VIDEO_ANALYSIS_FILE, 'utf8'));

  // Load optional product research
  let productResearch = null;
  if (fs.existsSync(PRODUCT_RESEARCH_FILE)) {
    console.log('[segment] Loading product research...');
    productResearch = JSON.parse(fs.readFileSync(PRODUCT_RESEARCH_FILE, 'utf8'));
  } else {
    console.log('[segment] product-research.json not found — proceeding without it');
  }

  // Decide whether we have usable timestamps
  const hasWordTimestamps =
    videoAnalysis.transcript &&
    Array.isArray(videoAnalysis.transcript.words) &&
    videoAnalysis.transcript.words.length > 0;

  let stepTiming;

  if (!hasWordTimestamps) {
    console.log('[segment] No word timestamps in transcript — using fallback even distribution');
    stepTiming = buildFallbackSteps(videoAnalysis);
  } else {
    try {
      const raw = await segmentWithClaude(videoAnalysis, productResearch);
      stepTiming = normaliseStepTiming(raw);
    } catch (err) {
      console.warn(`[segment] Claude segmentation failed: ${err.message}. Falling back to even distribution.`);
      stepTiming = buildFallbackSteps(videoAnalysis);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(stepTiming, null, 2));
  console.log(`[segment] Written: ${OUT_FILE} (${stepTiming.steps.length} steps)`);
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[segment] Fatal error:', err.message);
    process.exit(1);
  });
}
