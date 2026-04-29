'use strict';
/**
 * vertex-embed.js
 * Shared Vertex AI embedding client for the Plaid demo pipeline.
 *
 * Provides:
 *   embedVideo(buffer)         → Float32Array[1408]  multimodalembedding@001
 *   embedImage(buffer)         → Float32Array[1408]  multimodalembedding@001
 *   embedAudioAsVideo(buffer)  → Float32Array[1408]  multimodalembedding@001 (audio-in-black-video)
 *   embedTextMultimodal(text)  → Float32Array[1408]  multimodalembedding@001
 *   embedTextDense(text)       → Float32Array[768]   text-embedding-004
 *   cosineSimilarity(a, b)     → number
 *   getAccessToken()           → string
 *
 * Rate-limited to 120 req/min (Vertex AI multimodalembedding@001 limit).
 * All functions throw when VERTEX_AI_PROJECT_ID is not set.
 *
 * OAuth2 service account (Vertex when GOOGLE_API_KEY is unset), priority:
 *   1. GCP_SERVICE_ACCOUNT_JSON_B64 — base64 of the standard GCP JSON key file (single .env line)
 *   2. GCP_SERVICE_ACCOUNT_JSON — same JSON as a single-line string (escaped newlines in private_key)
 *   3. GOOGLE_APPLICATION_CREDENTIALS — filesystem path to that JSON (Google ADC default)
 *   4. Application Default Credentials otherwise (e.g. gcloud auth application-default login)
 */

const { GoogleAuth } = require('google-auth-library');

const PROJECT_ID  = process.env.VERTEX_AI_PROJECT_ID;
const REGION      = process.env.VERTEX_AI_REGION || 'us-central1';
const MM_MODEL    = 'multimodalembedding@001';
const TEXT_MODEL  = 'text-embedding-004';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// ── Rate limiter ──────────────────────────────────────────────────────────────
// 120 req/min = 1 per 500ms minimum gap
const RATE_LIMIT_MS = 500;
let _lastReqTime = 0;

async function rateLimitedFetch(url, opts) {
  const now  = Date.now();
  const wait = RATE_LIMIT_MS - (now - _lastReqTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastReqTime = Date.now();
  return fetch(url, opts);
}

/**
 * True when env provides material for a service-account OAuth client (file path or inline JSON).
 * GOOGLE_API_KEY alone does not count — multimodal Vertex paths need OAuth.
 */
function hasVertexServiceAccountEnv() {
  if (process.env.GCP_SERVICE_ACCOUNT_JSON_B64 && String(process.env.GCP_SERVICE_ACCOUNT_JSON_B64).trim()) {
    return true;
  }
  if (process.env.GCP_SERVICE_ACCOUNT_JSON && String(process.env.GCP_SERVICE_ACCOUNT_JSON).trim()) {
    return true;
  }
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return !!(p && String(p).trim());
}

function createGoogleAuth() {
  const scopes = [CLOUD_PLATFORM_SCOPE];
  const b64 = process.env.GCP_SERVICE_ACCOUNT_JSON_B64;
  if (b64 != null && String(b64).trim() !== '') {
    const json = JSON.parse(Buffer.from(String(b64).trim(), 'base64').toString('utf8'));
    return new GoogleAuth({ credentials: json, scopes });
  }
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (raw != null && String(raw).trim() !== '') {
    const json = JSON.parse(String(raw).trim());
    return new GoogleAuth({ credentials: json, scopes });
  }
  return new GoogleAuth({ scopes });
}

// ── Auth headers ──────────────────────────────────────────────────────────────
// Priority: GOOGLE_API_KEY (simple key) → OAuth2 ADC (service account / gcloud)
let _auth = null;

async function getAccessToken() {
  if (!_auth) {
    _auth = createGoogleAuth();
  }
  const client = await _auth.getClient();
  const tok    = await client.getAccessToken();
  return tok.token || tok;
}

/**
 * Returns auth headers for a Vertex AI request.
 * Uses GOOGLE_API_KEY if set; falls back to OAuth2 ADC (service account).
 */
async function getAuthHeaders() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (apiKey) {
    return { 'x-goog-api-key': apiKey };
  }
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

// ── Internal: call multimodalembedding@001 ────────────────────────────────────

async function _callMM(instances) {
  if (!PROJECT_ID) throw new Error('VERTEX_AI_PROJECT_ID not set — Vertex AI embeddings unavailable');
  const authHeaders = await getAuthHeaders();
  const url   = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${MM_MODEL}:predict`;
  const resp  = await rateLimitedFetch(url, {
    method:  'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ instances }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Vertex AI multimodalembedding failed (${resp.status}): ${txt.substring(0, 300)}`);
  }
  return resp.json();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed a video clip.
 * @param {Buffer} videoBuffer  Raw .webm/.mp4 bytes
 * @returns {Promise<Float32Array>} 1408-dim embedding
 */
async function embedVideo(videoBuffer) {
  const b64  = videoBuffer.toString('base64');
  const data = await _callMM([{ video: { bytesBase64Encoded: b64, videoSegmentConfig: { startOffsetSec: 0 } } }]);
  const vals = data?.predictions?.[0]?.videoEmbeddings?.[0]?.embedding;
  if (!vals) throw new Error('No videoEmbedding in Vertex AI response');
  return new Float32Array(vals);
}

/**
 * Embed a still image (PNG/JPEG).
 * @param {Buffer} imageBuffer
 * @returns {Promise<Float32Array>} 1408-dim embedding
 */
async function embedImage(imageBuffer) {
  const b64  = imageBuffer.toString('base64');
  const data = await _callMM([{ image: { bytesBase64Encoded: b64 } }]);
  const vals = data?.predictions?.[0]?.imageEmbedding;
  if (!vals) throw new Error('No imageEmbedding in Vertex AI response');
  return new Float32Array(vals);
}

/**
 * Embed audio by wrapping it in a black-video container.
 * (multimodalembedding@001 has no standalone audio endpoint.)
 * NOTE: The caller is responsible for creating the wrapped .webm via ffmpeg before calling this.
 * @param {Buffer} audioVideoBuffer  .webm file with audio track on black video
 * @returns {Promise<Float32Array>} 1408-dim embedding
 */
async function embedAudioAsVideo(audioVideoBuffer) {
  return embedVideo(audioVideoBuffer);
}

/**
 * Embed text in the multimodal (1408-dim) embedding space.
 * Use when comparing against image/video embeddings.
 * @param {string} text
 * @returns {Promise<Float32Array>} 1408-dim embedding
 */
async function embedTextMultimodal(text) {
  const data = await _callMM([{ text }]);
  const vals = data?.predictions?.[0]?.textEmbedding;
  if (!vals) throw new Error('No textEmbedding in Vertex AI response');
  return new Float32Array(vals);
}

/**
 * Embed text in the dense text-only embedding space for text-to-text comparison (Phase 3).
 *
 * Routing logic:
 *   - GOOGLE_API_KEY set  → Google AI Studio API (generativelanguage.googleapis.com, 768-dim)
 *     This endpoint supports API keys and is equivalent for semantic similarity tasks.
 *   - Otherwise           → Vertex AI text-embedding-004 via OAuth2 (requires service account)
 *
 * @param {string} text
 * @returns {Promise<Float32Array>} 768-dim embedding
 */
async function embedTextDense(text) {
  const apiKey = process.env.GOOGLE_API_KEY;

  // Google AI Studio path — accepts API keys, no OAuth2 needed
  // Uses gemini-embedding-001 (3072-dim); falls back to text-embedding-004 if not available.
  if (apiKey) {
    const AI_MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-2-preview';
    const url  = `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:embedContent?key=${apiKey}`;
    const resp = await rateLimitedFetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:    `models/${AI_MODEL}`,
        content:  { parts: [{ text }] },
        taskType: 'SEMANTIC_SIMILARITY',
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Google AI ${AI_MODEL} failed (${resp.status}): ${txt.substring(0, 300)}`);
    }
    const data = await resp.json();
    const vals = data?.embedding?.values;
    if (!vals) throw new Error('No embedding values in Google AI response');
    return new Float32Array(vals);
  }

  // Vertex AI path — requires OAuth2 / service account
  if (!PROJECT_ID) throw new Error('VERTEX_AI_PROJECT_ID not set — Vertex AI embeddings unavailable');
  const authHeaders = await getAuthHeaders();
  const url   = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${TEXT_MODEL}:predict`;
  const resp  = await rateLimitedFetch(url, {
    method:  'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ instances: [{ content: text }], parameters: { outputDimensionality: 768 } }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Vertex AI text-embedding-004 failed (${resp.status}): ${txt.substring(0, 300)}`);
  }
  const data = await resp.json();
  const vals = data?.predictions?.[0]?.embeddings?.values;
  if (!vals) throw new Error('No text embeddings in Vertex AI response');
  return new Float32Array(vals);
}

/**
 * Cosine similarity between two float vectors.
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number} similarity in [-1, 1]
 */
function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom < 1e-10 ? 0 : dot / denom;
}

function resetGoogleAuthClient() {
  _auth = null;
}

/**
 * One-shot check: API key presence, or obtain an OAuth2 access token via inline/path ADC.
 * Does not call Vertex predict endpoints (no quota burn).
 * @returns {Promise<{ ok: boolean, mode: string, message: string, tokenPreview?: string }>}
 */
async function verifyVertexConnectivity() {
  resetGoogleAuthClient();
  const apiKey = process.env.GOOGLE_API_KEY;
  if (apiKey && String(apiKey).trim()) {
    return {
      ok: true,
      mode: 'api_key',
      message:
        'GOOGLE_API_KEY is set — embedding routes that support API keys will use x-goog-api-key.',
    };
  }
  if (!hasVertexServiceAccountEnv()) {
    return {
      ok: true,
      mode: 'skipped',
      message:
        'No GOOGLE_API_KEY and no service-account env (GCP_SERVICE_ACCOUNT_JSON_B64, GCP_SERVICE_ACCOUNT_JSON, or GOOGLE_APPLICATION_CREDENTIALS). Nothing to verify.',
    };
  }
  try {
    const token = await getAccessToken();
    const s = token && String(token);
    if (!s) {
      return { ok: false, mode: 'oauth2', message: 'OAuth client returned an empty access token.' };
    }
    return {
      ok: true,
      mode: 'oauth2',
      message: 'OAuth2 access token obtained (google-auth-library + service account or ADC).',
      tokenPreview: `${s.slice(0, 10)}…`,
    };
  } catch (err) {
    return {
      ok: false,
      mode: 'oauth2',
      message: err && err.message ? err.message : String(err),
    };
  }
}

module.exports = {
  embedVideo,
  embedImage,
  embedAudioAsVideo,
  embedTextMultimodal,
  embedTextDense,
  cosineSimilarity,
  getAccessToken,
  getAuthHeaders,
  hasVertexServiceAccountEnv,
  resetGoogleAuthClient,
  verifyVertexConnectivity,
  /** @internal unit tests only — prefer verifyVertexConnectivity */
  createGoogleAuth,
};
