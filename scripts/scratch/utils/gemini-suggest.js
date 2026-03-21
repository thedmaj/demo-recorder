'use strict';
/**
 * gemini-suggest.js
 * Two-tier Gemini client for Remotion overlay suggestion generation.
 *
 * Tier 1 (cheap/fast): gemini-embedding-2-preview (or GEMINI_EMBED_MODEL)
 *   → embed narration + overlay description, compare cosine similarity
 *   → if similarity >= AI_SUGGEST_SCREEN_THRESHOLD, skip Flash call
 *
 * Tier 2 (expensive/thorough): gemini-2.0-flash (or GEMINI_SUGGEST_MODEL)
 *   → send 3 frame PNGs + text context → structured JSON suggestion patches
 *
 * Auth routing (same priority order as vertex-embed.js):
 *   1. GOOGLE_API_KEY  → generativelanguage.googleapis.com (both models)
 *   2. VERTEX_AI_PROJECT_ID (no API key) → Vertex AI Gemini endpoint + OAuth2
 *   3. Neither → throw Error('CREDENTIALS_ABSENT')
 */

const fs   = require('fs');
const path = require('path');

const { embedTextDense, cosineSimilarity, getAccessToken } = require('./vertex-embed');

const FLASH_MODEL  = process.env.GEMINI_SUGGEST_MODEL || 'gemini-2.0-flash';
const EMBED_MODEL  = process.env.GEMINI_EMBED_MODEL   || 'gemini-embedding-2-preview';
const SCREEN_THRESHOLD = parseFloat(process.env.AI_SUGGEST_SCREEN_THRESHOLD || '0.85');

const PROJECT_ID = process.env.VERTEX_AI_PROJECT_ID;
const REGION     = process.env.VERTEX_AI_REGION || 'us-central1';

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * Checks that at least one credential is available.
 * Throws Error('CREDENTIALS_ABSENT') if neither GOOGLE_API_KEY nor VERTEX_AI_PROJECT_ID is set.
 */
function checkCredentials() {
  if (!process.env.GOOGLE_API_KEY && !PROJECT_ID) {
    throw new Error('CREDENTIALS_ABSENT');
  }
}

/**
 * Calls the Gemini generative API (Flash model).
 * Routes to generativelanguage.googleapis.com (API key) or Vertex AI (OAuth2).
 */
async function callFlash(contents) {
  const apiKey = process.env.GOOGLE_API_KEY;

  if (apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${FLASH_MODEL}:generateContent?key=${apiKey}`;
    const resp = await fetchWithRetry(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        contents,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature:       0.2,
          maxOutputTokens:   2048,
        },
      }),
    });
    return resp;
  }

  // Vertex AI path
  const token = await getAccessToken();
  const url   = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${FLASH_MODEL}:generateContent`;
  const resp  = await fetchWithRetry(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      contents,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature:       0.2,
        maxOutputTokens:   2048,
      },
    }),
  });
  return resp;
}

/**
 * fetch with one retry on timeout/network error.
 */
async function fetchWithRetry(url, opts, attempt = 0) {
  let controller;
  let timeoutId;
  try {
    controller = new AbortController();
    timeoutId  = setTimeout(() => controller.abort(), 30000);
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timeoutId);
    return resp;
  } catch (err) {
    clearTimeout(timeoutId);
    if (attempt === 0 && (err.name === 'AbortError' || err.code === 'ECONNRESET')) {
      await new Promise(r => setTimeout(r, 1000));
      return fetchWithRetry(url, opts, 1);
    }
    throw err;
  }
}

// ── Tier 1: Embedding pre-screen ──────────────────────────────────────────────

/**
 * Returns true when the step likely needs Flash analysis (similarity below threshold).
 * Uses gemini-embedding-2-preview (via embedTextDense in vertex-embed.js with EMBED_MODEL override).
 *
 * @param {object} step           - Step entry from demo-script.json
 * @param {object} voiceoverInfo  - { narration: string } from voiceover-manifest
 * @param {object} currentOverlay - Current overlay state for this step from remotion-props.json
 * @returns {Promise<boolean>}    - true = send to Flash; false = already coherent, skip
 */
async function screenStepNeedsAnalysis(step, voiceoverInfo, currentOverlay) {
  try {
    const narration = voiceoverInfo?.narration || step.narration || '';
    if (!narration.trim()) return true; // no narration → always analyze

    // Build a textual description of the current overlay state
    const overlayDesc = describeOverlay(currentOverlay);

    const [narVec, overlayVec] = await Promise.all([
      embedWithModel(narration),
      embedWithModel(overlayDesc),
    ]);

    const sim = cosineSimilarity(narVec, overlayVec);
    return sim < SCREEN_THRESHOLD;
  } catch (_) {
    // If embedding fails, default to analyzing
    return true;
  }
}

/**
 * Wraps embedTextDense but temporarily overrides the model via env (vertex-embed reads GEMINI_EMBED_MODEL).
 * Since vertex-embed uses a module-level constant, we pass a custom call here.
 */
async function embedWithModel(text) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${apiKey}`;
    const resp = await fetchWithRetry(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:    `models/${EMBED_MODEL}`,
        content:  { parts: [{ text }] },
        taskType: 'SEMANTIC_SIMILARITY',
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Embed (${EMBED_MODEL}) failed ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = await resp.json();
    const vals = data?.embedding?.values;
    if (!vals) throw new Error('No embedding values');
    return new Float32Array(vals);
  }
  // Fall back to vertex-embed's embedTextDense (uses GOOGLE_API_KEY or Vertex AI)
  return embedTextDense(text);
}

/**
 * Build a short text description of the current overlay state for embedding.
 */
function describeOverlay(overlay) {
  if (!overlay) return 'no overlay configured';
  const parts = [];
  if (overlay.zoomPunch) {
    const z = overlay.zoomPunch;
    const scale = typeof z === 'object' ? z.scale || 1.08 : 1.08;
    parts.push(`zoom punch scale ${scale}`);
    if (z.originX) parts.push(`origin ${z.originX} ${z.originY}`);
  }
  if (overlay.clickRipple) {
    parts.push(`click ripple at ${overlay.clickRipple.xFrac?.toFixed(2)},${overlay.clickRipple.yFrac?.toFixed(2)}`);
  }
  if (overlay.callouts && overlay.callouts.length > 0) {
    parts.push(`callouts: ${overlay.callouts.map(c => c.type || 'callout').join(', ')}`);
  }
  if (overlay.spotlight) {
    parts.push(`spotlight at ${overlay.spotlight.xFrac},${overlay.spotlight.yFrac}`);
  }
  if (!parts.length) parts.push('no overlays');
  return parts.join('; ');
}

// ── Tier 2: Flash generative analysis ─────────────────────────────────────────

/**
 * Analyzes a step's frames and context to generate specific overlay suggestion patches.
 *
 * @param {object}   step         - Step entry from demo-script.json
 * @param {string[]} framePaths   - Array of up to 3 absolute PNG file paths [start, mid, end]
 * @param {object}   voiceoverInfo - { narration, durationMs }
 * @param {object}   currentOverlay - Current overlay state from remotion-props.json for this step
 * @param {object}   demoContext   - { productName, persona, stepIndex, totalSteps, stepLabel }
 * @returns {Promise<Array>}       - Array of suggestion objects
 */
async function analyzeStepForSuggestions(step, framePaths, voiceoverInfo, currentOverlay, demoContext) {
  const narration   = voiceoverInfo?.narration || step.narration || '';
  const durationMs  = voiceoverInfo?.durationMs || step.durationMs || 0;
  const overlayDesc = describeOverlay(currentOverlay);

  // Build inline image parts from frame PNGs
  const imageParts = [];
  for (const fp of framePaths) {
    if (fp && fs.existsSync(fp)) {
      try {
        const buf = fs.readFileSync(fp);
        imageParts.push({
          inlineData: {
            mimeType: 'image/png',
            data:     buf.toString('base64'),
          },
        });
      } catch (_) { /* skip unreadable frame */ }
    }
  }

  const systemPrompt = buildSystemPrompt(demoContext);
  const userPrompt   = buildUserPrompt({
    step,
    narration,
    durationMs,
    currentOverlay: overlayDesc,
    stepIndex:      demoContext.stepIndex,
    totalSteps:     demoContext.totalSteps,
  });

  const contents = [
    {
      role: 'user',
      parts: [
        { text: systemPrompt + '\n\n' + userPrompt },
        ...imageParts,
        { text: 'Respond with a JSON array of suggestion objects as described above. If no changes are needed, respond with an empty array [].' },
      ],
    },
  ];

  const resp = await callFlash(contents);
  if (!resp.ok) {
    const txt = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`auth_failed: ${resp.status}`);
    }
    throw new Error(`Gemini Flash failed (${resp.status}): ${txt.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  return parseGeminiSuggestions(text);
}

function buildSystemPrompt(ctx) {
  return `You are an expert Remotion video overlay analyst for Plaid product demo videos.
Your task: examine 3 screenshot frames of a demo step and propose specific JSON patches to improve Remotion overlays.

Demo context:
- Product: ${ctx.productName || 'Plaid'}
- Persona: ${ctx.persona || 'developer'}
- Step ${ctx.stepIndex + 1} of ${ctx.totalSteps}: "${ctx.stepLabel || ''}"
- Design viewport: 1440×900 (rendered at 2880×1800 with deviceScaleFactor:2)

Plaid design system reference:
- Background: #0d1117 (dark navy)
- Accent: #00A67E (teal)
- Text primary: #ffffff

Coordinate system: xFrac and yFrac are fractions of viewport width/height (0.0–1.0).
The three frames are: start+2s, mid-point, end-1s (in that order).`;
}

function buildUserPrompt({ step, narration, durationMs, currentOverlay, stepIndex, totalSteps }) {
  return `Step ID: ${step.id}
Step label: ${step.label || step.id}
Narration (${narration.split(/\s+/).filter(Boolean).length} words): "${narration}"
Duration: ${(durationMs / 1000).toFixed(1)}s
Current overlays: ${currentOverlay}
Step position: ${stepIndex + 1} / ${totalSteps}

Analyze the three frames above and suggest improvements as a JSON array. Each suggestion object must follow this schema:
{
  "type": "zoomPunch | clickRipple | callout | spotlight | syncAdjust | narration",
  "action": "add | update | remove",
  "patch": { /* exact JSON to merge into the step's remotion-props entry */ },
  "confidence": 0.0 to 1.0,
  "reasoning": "brief explanation"
}

Suggestion types and when to use them:
- zoomPunch: key UI element off-center or text too small. patch: { "zoomPunch": { "scale": 1.08–1.15, "originX": "55%", "originY": "40%" } }
- clickRipple: visible click target; current ripple position appears off. patch: { "clickRipple": { "xFrac": 0.44, "yFrac": 0.71 } }
- callout: stat/metric visible on screen but no counter overlay; or lower-third title is misleading. patch: { "callouts": [...] }
- spotlight: important UI element needs vignette focus. patch: { "spotlight": { "xFrac": 0.5, "yFrac": 0.3, "radius": 320 } }
- syncAdjust: visible screen transition doesn't match narration timing (advisory only). patch: { "_syncHint": { "stepId": "${step.id}", "suggestedOffsetMs": -500 } }
- narration: word count outside 8–35 range, or narration references an element not visible on screen. patch: { "narration": "revised text" }

Rules:
- Only suggest changes with clear visual evidence from the frames
- confidence >= 0.85: strong evidence; 0.70–0.84: moderate; < 0.70: uncertain
- Do NOT suggest removing existing overlays unless they are clearly wrong
- Do NOT zoom the wf-link-launch step
- Keep narration suggestions to 20–35 words, active voice, no "simply/just/seamless"`;
}

/**
 * Extracts JSON array from Gemini response text (handles markdown code fences + partial JSON).
 *
 * @param {string} text - Raw text from Gemini response
 * @returns {Array}     - Parsed suggestions (empty array on parse failure)
 */
function parseGeminiSuggestions(text) {
  if (!text || typeof text !== 'string') return [];

  // Strip markdown code fences
  let clean = text.trim();
  const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    clean = fenceMatch[1].trim();
  }

  // Find first [ ... ] block
  const startIdx = clean.indexOf('[');
  const endIdx   = clean.lastIndexOf(']');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return [];

  try {
    const arr = JSON.parse(clean.slice(startIdx, endIdx + 1));
    if (!Array.isArray(arr)) return [];
    // Validate each entry has required fields
    return arr.filter(s =>
      s && typeof s === 'object' &&
      typeof s.type === 'string' &&
      typeof s.action === 'string' &&
      typeof s.patch === 'object' &&
      typeof s.confidence === 'number'
    );
  } catch (_) {
    return [];
  }
}

module.exports = {
  checkCredentials,
  screenStepNeedsAnalysis,
  analyzeStepForSuggestions,
  parseGeminiSuggestions,
  describeOverlay,
};
