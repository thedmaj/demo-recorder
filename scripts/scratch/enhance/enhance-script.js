/**
 * enhance-script.js
 *
 * Mode B/C pipeline — Stage 3: Generate a polished narration script timed to
 * the original video.
 *
 * Reads:  out/video-analysis.json (required)
 *         out/step-timing.json    (required)
 *         out/product-research.json (optional)
 * Calls:  claude-opus-4-6 (no extended thinking — creative polish pass)
 * Writes: out/demo-script.json
 *
 * Optional human review pause controlled by SCRATCH_AUTO_APPROVE env var.
 *
 * Usage:
 *   node scripts/scratch/enhance/enhance-script.js
 *   SCRATCH_AUTO_APPROVE=true node scripts/scratch/enhance/enhance-script.js
 */

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = process.env.PIPELINE_RUN_DIR || path.join(ROOT, 'out');
const VIDEO_ANALYSIS_FILE = path.join(OUT_DIR, 'video-analysis.json');
const STEP_TIMING_FILE = path.join(OUT_DIR, 'step-timing.json');
const PRODUCT_RESEARCH_FILE = path.join(OUT_DIR, 'product-research.json');
const OUT_FILE = path.join(OUT_DIR, 'demo-script.json');

const WORDS_PER_MINUTE = 150;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract JSON from a Claude response that may contain fenced or raw JSON.
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

/**
 * Calculate max words a narrator can say in a given duration at 150 wpm.
 * @param {number} durationMs
 * @returns {number}
 */
function maxWordsForDuration(durationMs) {
  return Math.floor(durationMs / 1000 / 60 * WORDS_PER_MINUTE);
}

/**
 * Extract transcript words that fall within a time range.
 * @param {{ text: string, words: Array<{ word: string, start: number, end: number }> }} transcript
 * @param {number} startMs
 * @param {number} endMs
 * @returns {string} joined text snippet
 */
function transcriptSlice(transcript, startMs, endMs) {
  if (!transcript || !Array.isArray(transcript.words) || transcript.words.length === 0) {
    return '';
  }
  const startSec = startMs / 1000;
  const endSec = endMs / 1000;
  const words = transcript.words
    .filter(w => w.start >= startSec && w.end <= endSec)
    .map(w => w.word);
  return words.join(' ').trim();
}

/**
 * Pause for human review if SCRATCH_AUTO_APPROVE is not 'true'.
 * @param {object} scriptSummary
 */
async function maybeWaitForApproval(scriptSummary) {
  if (process.env.SCRATCH_AUTO_APPROVE === 'true') return;

  console.log('\n[enhance-script] ── Script Summary ─────────────────────────────────');
  console.log(`Product: ${scriptSummary.product}`);
  console.log(`Persona: ${scriptSummary.persona.name} @ ${scriptSummary.persona.company}`);
  console.log(`Steps: ${scriptSummary.steps.length}`);
  console.log('');
  scriptSummary.steps.forEach((s, i) => {
    const words = (s.narration || '').split(/\s+/).filter(Boolean).length;
    console.log(`  ${i + 1}. [${s.id}] ${s.label} (${words} words, ${s.durationHintMs}ms)`);
    console.log(`     "${s.narration}"`);
    console.log('');
  });
  console.log('[enhance-script] ─────────────────────────────────────────────────────');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => {
    rl.question('Press ENTER to continue or Ctrl+C to edit...\n', () => {
      rl.close();
      resolve();
    });
  });
}

// ── Build Claude prompt ───────────────────────────────────────────────────────

function buildPrompt(steps, transcript, productResearch) {
  const productContext = productResearch
    ? `\n\n## PRODUCT RESEARCH (use for accurate Plaid terminology)\n${
        productResearch.synthesizedInsights || JSON.stringify(productResearch, null, 2)
      }`
    : '';

  const stepDetails = steps.map(step => {
    const maxWords = maxWordsForDuration(step.durationMs);
    const originalText = transcriptSlice(transcript, step.startMs, step.endMs);
    return (
      `Step "${step.id}" — ${step.label}\n` +
      `  Duration: ${step.durationMs}ms (max ${maxWords} words at 150 wpm)\n` +
      `  Original narration: ${originalText || '(no transcript for this segment)'}`
    );
  }).join('\n\n');

  const userText =
    `You are polishing the narration for a Plaid product demo recording. ` +
    `For each step below, write a polished narration that:\n` +
    `- Stays within the word limit (the narrator speaks at ${WORDS_PER_MINUTE} wpm)\n` +
    `- Uses active voice, outcome-focused language\n` +
    `- Uses accurate Plaid product names and terminology\n` +
    `- Preserves the meaning and flow of the original narration where possible\n` +
    `- Never uses: "simply", "just", "unfortunately", "robust", "seamless"\n` +
    `\nAlso infer:\n` +
    `- product: the Plaid product being demoed (e.g. "Identity Verification")\n` +
    `- persona: a realistic name, company, and use case from the transcript context\n` +
    productContext +
    `\n\n## STEPS TO POLISH\n\n${stepDetails}` +
    `\n\nOutput ONLY a JSON object — no prose, no markdown fences:\n\n` +
    `{\n` +
    `  "product": "<string>",\n` +
    `  "persona": {\n` +
    `    "name": "<realistic first + last name>",\n` +
    `    "company": "<realistic company name>",\n` +
    `    "useCase": "<brief use case description>"\n` +
    `  },\n` +
    `  "steps": [\n` +
    `    {\n` +
    `      "id": "<step id>",\n` +
    `      "label": "<step label>",\n` +
    `      "narration": "<polished narration within word limit>",\n` +
    `      "durationHintMs": <original durationMs>\n` +
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

  const videoAnalysis = JSON.parse(fs.readFileSync(VIDEO_ANALYSIS_FILE, 'utf8'));
  const stepTiming = JSON.parse(fs.readFileSync(STEP_TIMING_FILE, 'utf8'));

  let productResearch = null;
  if (fs.existsSync(PRODUCT_RESEARCH_FILE)) {
    console.log('[enhance-script] Loading product research...');
    productResearch = JSON.parse(fs.readFileSync(PRODUCT_RESEARCH_FILE, 'utf8'));
  } else {
    console.log('[enhance-script] product-research.json not found — proceeding without it');
  }

  const transcript = videoAnalysis.transcript || { text: '', words: [] };
  const steps = stepTiming.steps;

  console.log(`[enhance-script] Polishing narration for ${steps.length} steps...`);

  const prompt = buildPrompt(steps, transcript, productResearch);

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const textContent = response.content.find(b => b.type === 'text');
  if (!textContent) {
    throw new Error('Claude returned no text content');
  }

  let demoScript;
  try {
    demoScript = extractJSON(textContent.text);
  } catch (err) {
    throw new Error(`Failed to parse Claude response as JSON: ${err.message}\nRaw: ${textContent.text.slice(0, 500)}`);
  }

  // Optional human review
  await maybeWaitForApproval(demoScript);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(demoScript, null, 2));
  console.log(`[enhance-script] Written: ${OUT_FILE}`);
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[enhance-script] Fatal error:', err.message);
    process.exit(1);
  });
}
