/**
 * overlay-plan.js
 *
 * Mode B/C pipeline — Stage 4: Plan visual enhancements (zoom punches, callouts,
 * lower-thirds) for the demo recording.
 *
 * Reads:  out/video-analysis.json (required)
 *         out/step-timing.json    (required)
 *         out/demo-script.json    (required)
 *         inputs/prompt.txt       (optional — explicit effect requests)
 * Calls:  claude-sonnet-4-6 (no extended thinking)
 * Writes: out/overlay-plan.json
 *
 * Usage:
 *   node scripts/scratch/enhance/overlay-plan.js
 */

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = process.env.PIPELINE_RUN_DIR || path.join(ROOT, 'out');
const INPUTS_DIR = path.join(ROOT, 'inputs');
const VIDEO_ANALYSIS_FILE = path.join(OUT_DIR, 'video-analysis.json');
const STEP_TIMING_FILE = path.join(OUT_DIR, 'step-timing.json');
const DEMO_SCRIPT_FILE = path.join(OUT_DIR, 'demo-script.json');
const PROMPT_TXT_FILE = path.join(INPUTS_DIR, 'prompt.txt');
const OUT_FILE = path.join(OUT_DIR, 'overlay-plan.json');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract JSON from a Claude response that may contain fenced or raw JSON.
 * Looks for a top-level object with known overlay-plan keys.
 * @param {string} text
 * @returns {object}
 */
function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    return JSON.parse(fenced[1].trim());
  }
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    return JSON.parse(text.slice(firstBrace));
  }
  throw new Error('No JSON found in response');
}

// ── Build Claude prompt ───────────────────────────────────────────────────────

function buildPrompt(videoAnalysis, stepTiming, demoScript, promptTxt) {
  const explicitRequests = promptTxt
    ? `\n\n## EXPLICIT EFFECT REQUESTS FROM USER\n${promptTxt}\nIncorporate these requests into the overlay plan.`
    : '';

  const userText =
    `You are a video producer enhancing a Plaid demo recording. ` +
    `Review the frame descriptions and polished narration script. ` +
    `Decide what visual overlays Remotion should add to make the demo more compelling.\n\n` +
    `Guidelines:\n` +
    `- Zoom punches: highlight key reveal moments (scores, approval states, data matches)\n` +
    `- Callouts: floating badges that reinforce numbers or UI elements the narrator mentions\n` +
    `- Lower-thirds: title cards at start of major sections (welcome, key reveal, outcome)\n` +
    `- Highlights: reserved for click targets or form fields being interacted with\n` +
    `- Overlays should feel purposeful — do not add more than 1–2 per step\n` +
    `- Use absolute timestamps (ms from video start) for startMs values\n` +
    explicitRequests +
    `\n\n## STEP TIMING\n${JSON.stringify(stepTiming, null, 2)}` +
    `\n\n## DEMO SCRIPT (polished narration)\n${JSON.stringify(demoScript, null, 2)}` +
    `\n\n## FRAME DESCRIPTIONS\n${JSON.stringify(videoAnalysis.frames || [], null, 2)}` +
    `\n\nOutput ONLY a JSON object — no prose, no markdown fences:\n\n` +
    `{\n` +
    `  "zoomPunches": [\n` +
    `    {\n` +
    `      "stepId": "<string>",\n` +
    `      "startMs": <number — absolute ms from video start>,\n` +
    `      "endMs": <number>,\n` +
    `      "target": "<center|top-left|top-right|bottom-left|bottom-right|custom>",\n` +
    `      "scale": <number, e.g. 1.4>,\n` +
    `      "description": "<why this zoom>"\n` +
    `    }\n` +
    `  ],\n` +
    `  "callouts": [\n` +
    `    {\n` +
    `      "stepId": "<string>",\n` +
    `      "startMs": <number>,\n` +
    `      "durationMs": <number>,\n` +
    `      "type": "<badge|arrow|box>",\n` +
    `      "text": "<short label>",\n` +
    `      "position": "<top-right|top-left|bottom-right|bottom-left|center>"\n` +
    `    }\n` +
    `  ],\n` +
    `  "lowerThirds": [\n` +
    `    {\n` +
    `      "stepId": "<string>",\n` +
    `      "startMs": <number>,\n` +
    `      "durationMs": <number>,\n` +
    `      "text": "<primary label>",\n` +
    `      "subtext": "<secondary label, optional>"\n` +
    `    }\n` +
    `  ],\n` +
    `  "highlights": [\n` +
    `    {\n` +
    `      "stepId": "<string>",\n` +
    `      "startMs": <number>,\n` +
    `      "durationMs": <number>,\n` +
    `      "region": { "x": <0–1>, "y": <0–1>, "width": <0–1>, "height": <0–1> }\n` +
    `    }\n` +
    `  ]\n` +
    `}`;

  return userText;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Load required inputs
  if (!fs.existsSync(VIDEO_ANALYSIS_FILE)) {
    throw new Error(`Required input not found: ${VIDEO_ANALYSIS_FILE}`);
  }
  if (!fs.existsSync(STEP_TIMING_FILE)) {
    throw new Error(`Required input not found: ${STEP_TIMING_FILE}`);
  }
  if (!fs.existsSync(DEMO_SCRIPT_FILE)) {
    throw new Error(`Required input not found: ${DEMO_SCRIPT_FILE}`);
  }

  const videoAnalysis = JSON.parse(fs.readFileSync(VIDEO_ANALYSIS_FILE, 'utf8'));
  const stepTiming = JSON.parse(fs.readFileSync(STEP_TIMING_FILE, 'utf8'));
  const demoScript = JSON.parse(fs.readFileSync(DEMO_SCRIPT_FILE, 'utf8'));

  // Load optional prompt.txt for explicit effect requests
  let promptTxt = null;
  if (fs.existsSync(PROMPT_TXT_FILE)) {
    promptTxt = fs.readFileSync(PROMPT_TXT_FILE, 'utf8').trim();
    if (promptTxt) {
      console.log('[overlay-plan] Found prompt.txt with explicit effect requests');
    }
  }

  console.log('[overlay-plan] Calling claude-sonnet-4-6 for overlay planning...');

  const prompt = buildPrompt(videoAnalysis, stepTiming, demoScript, promptTxt);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const textContent = response.content.find(b => b.type === 'text');
  if (!textContent) {
    throw new Error('Claude returned no text content');
  }

  let overlayPlan;
  try {
    overlayPlan = extractJSON(textContent.text);
  } catch (err) {
    throw new Error(`Failed to parse Claude response as JSON: ${err.message}\nRaw: ${textContent.text.slice(0, 500)}`);
  }

  // Ensure all expected keys exist
  overlayPlan.zoomPunches = overlayPlan.zoomPunches || [];
  overlayPlan.callouts = overlayPlan.callouts || [];
  overlayPlan.lowerThirds = overlayPlan.lowerThirds || [];
  overlayPlan.highlights = overlayPlan.highlights || [];

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(overlayPlan, null, 2));

  const totalOverlays =
    overlayPlan.zoomPunches.length +
    overlayPlan.callouts.length +
    overlayPlan.lowerThirds.length +
    overlayPlan.highlights.length;

  console.log(
    `[overlay-plan] Written: ${OUT_FILE} ` +
    `(${overlayPlan.zoomPunches.length} zooms, ${overlayPlan.callouts.length} callouts, ` +
    `${overlayPlan.lowerThirds.length} lower-thirds, ${overlayPlan.highlights.length} highlights — ` +
    `${totalOverlays} total)`
  );
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[overlay-plan] Fatal error:', err.message);
    process.exit(1);
  });
}
