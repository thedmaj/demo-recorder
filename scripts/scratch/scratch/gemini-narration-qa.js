'use strict';
/**
 * gemini-narration-qa.js
 *
 * Extracts timed screenshots from demo-scratch.mp4 (start, mid, end of each step),
 * sends them to Gemini Flash with the step narration, and reports whether the
 * on-screen content matches what the narrator is saying.
 *
 * Usage:
 *   PIPELINE_RUN_DIR=out/demos/2026-03-14-layer-v4 node scripts/scratch/scratch/gemini-narration-qa.js
 */

require('dotenv').config({ override: true });

const fs   = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const RUN_DIR      = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out', 'latest');

const VIDEO_PATH    = path.join(RUN_DIR, 'demo-scratch.mp4');
const MANIFEST_PATH = path.join(RUN_DIR, 'voiceover-manifest.json');
const FRAMES_DIR    = path.join(RUN_DIR, 'narration-qa-frames');

const API_KEY = process.env.GOOGLE_API_KEY;
const MODEL   = process.env.GEMINI_QA_MODEL || 'gemini-2.5-flash';

if (!API_KEY)         { console.error('GOOGLE_API_KEY not set'); process.exit(1); }
if (!fs.existsSync(VIDEO_PATH))    { console.error(`Video not found: ${VIDEO_PATH}`); process.exit(1); }
if (!fs.existsSync(MANIFEST_PATH)) { console.error(`Manifest not found: ${MANIFEST_PATH}`); process.exit(1); }

fs.mkdirSync(FRAMES_DIR, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

// ── Frame extraction ──────────────────────────────────────────────────────────

function extractFrame(videoPath, timestampS, outPath) {
  const r = spawnSync('ffmpeg', [
    '-ss', String(timestampS),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '3',
    '-y', outPath,
  ], { stdio: 'pipe' });
  return r.status === 0 && fs.existsSync(outPath);
}

function toBase64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}

// ── Gemini API call ───────────────────────────────────────────────────────────

async function callGemini(parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Strip markdown code fences if present
  const clean = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    return { raw: text };
  }
}

// ── QA prompt ─────────────────────────────────────────────────────────────────

function buildPrompt(step, frameBase64s) {
  const imageParts = frameBase64s.map((b64, i) => ({
    inlineData: { mimeType: 'image/jpeg', data: b64 },
  }));

  const labels = ['start', 'mid', 'end'];
  const imageRefs = frameBase64s.map((_, i) => `Frame ${i + 1} (${labels[i]})`).join(', ');

  const textPart = {
    text: `You are QA-reviewing a product demo video for Plaid (a financial data platform).

You have ${frameBase64s.length} screenshot(s) from the demo video: ${imageRefs}.
These frames span the following step: "${step.label}"

NARRATION TEXT (what the voice-over says during this step):
"${step.script}"

Evaluate whether the on-screen content matches the narration. Specifically check:
1. Is the correct screen/UI visible for what the narrator describes?
2. Are any specific data values mentioned in narration visible on screen (scores, dollar amounts, names, etc.)?
3. Is the API response panel shown when the narration references API data?
4. Is there any obvious mismatch between what is said and what is shown?
5. Are all key UI elements fully rendered (no blank/white areas, no missing content)?

Return JSON only (no markdown):
{
  "stepId": "${step.id}",
  "match": true|false,
  "score": 0-100,
  "issues": ["list any specific problems"],
  "narrationElements": ["list each data point/UI element mentioned in narration"],
  "visibleElements": ["list key UI elements/data you can actually see in the frames"],
  "summary": "one sentence assessment"
}`,
  };

  return [...imageParts, textPart];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[GeminiNarrationQA] Video: ${VIDEO_PATH}`);
  console.log(`[GeminiNarrationQA] Model: ${MODEL}`);
  console.log(`[GeminiNarrationQA] Steps: ${manifest.clips.length}\n`);

  const results = [];

  for (const clip of manifest.clips) {
    const startS = clip.startMs / 1000;
    const endS   = clip.endMs   / 1000;
    const midS   = (startS + endS) / 2;
    const dur    = endS - startS;

    // Skip very short steps (< 1s — likely transition artifacts)
    if (dur < 1.0) {
      console.log(`[${clip.id}] Skipping (duration ${dur.toFixed(1)}s too short)`);
      results.push({ stepId: clip.id, skipped: true, reason: 'too short' });
      continue;
    }

    // Extract 3 frames: +0.5s from start, mid, -0.5s from end
    const timestamps = [
      Math.min(startS + 0.5, midS),
      midS,
      Math.max(endS - 0.5, midS),
    ];

    process.stdout.write(`[${clip.id}] Extracting frames (${startS.toFixed(1)}s–${endS.toFixed(1)}s)... `);
    const framePaths = [];
    for (let i = 0; i < timestamps.length; i++) {
      const outPath = path.join(FRAMES_DIR, `${clip.id}-${['start', 'mid', 'end'][i]}.jpg`);
      const ok = extractFrame(VIDEO_PATH, timestamps[i], outPath);
      if (ok) framePaths.push(outPath);
    }
    process.stdout.write(`${framePaths.length} frames extracted\n`);

    if (framePaths.length === 0) {
      results.push({ stepId: clip.id, error: 'frame extraction failed' });
      continue;
    }

    // Send to Gemini
    process.stdout.write(`[${clip.id}] Sending to Gemini Flash... `);
    try {
      const frameBase64s = framePaths.map(toBase64);
      const parts  = buildPrompt(clip, frameBase64s);
      const result = await callGemini(parts);
      results.push(result);

      const score  = result.score ?? '?';
      const match  = result.match ? '✓' : '✗';
      const issues = result.issues?.length ? ` — ${result.issues[0]}` : '';
      console.log(`${match} score=${score}${issues}`);
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
      results.push({ stepId: clip.id, error: err.message.slice(0, 200) });
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('NARRATION vs. VISUAL QA — RESULTS');
  console.log('═══════════════════════════════════════════════════════════\n');

  let totalScore = 0;
  let scored = 0;

  for (const r of results) {
    if (r.skipped || r.error) {
      console.log(`  ${(r.stepId || '?').padEnd(30)} SKIPPED/ERROR`);
      continue;
    }
    const match = r.match ? '✓ MATCH' : '✗ MISMATCH';
    const score = r.score ?? 0;
    totalScore += score;
    scored++;
    console.log(`  ${(r.stepId || '?').padEnd(30)} ${String(score).padStart(3)}/100  ${match}`);
    if (r.summary) console.log(`    ${r.summary}`);
    if (r.issues?.length) {
      r.issues.forEach(i => console.log(`    ⚠ ${i}`));
    }
    console.log();
  }

  if (scored > 0) {
    console.log(`═══════════════════════════════════════════════════════════`);
    console.log(`Overall narration-visual alignment: ${(totalScore / scored).toFixed(0)}/100 across ${scored} steps`);
  }

  // Write full results JSON
  const outPath = path.join(RUN_DIR, 'narration-qa-report.json');
  fs.writeFileSync(outPath, JSON.stringify({ model: MODEL, generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nFull report: ${outPath}`);
}

main().catch(err => {
  console.error('[GeminiNarrationQA] Fatal:', err.message);
  process.exit(1);
});
