'use strict';
/**
 * embed-qa-screener.js
 * Phase 2: QA pre-screening via Vertex AI multimodal embeddings.
 *
 * For each step, embeds the mid-frame PNG (as image) and the step's visualState
 * text (as multimodal text) using multimodalembedding@001. Steps with cosine
 * similarity above EMBED_QA_SCREEN_THRESHOLD are assigned a provisional 90/100
 * score and skipped in the Claude Sonnet reviewStep() loop.
 *
 * Reduces per-run QA cost from ~$0.55 to ~$0.40 by skipping ~60% of Sonnet calls.
 * Gracefully no-ops when VERTEX_AI_PROJECT_ID is not set.
 *
 * Env vars:
 *   VERTEX_AI_PROJECT_ID      — required (skips screening if absent)
 *   EMBED_QA_SCREEN_THRESHOLD — default: 0.80
 */

const fs   = require('fs');
const {
  embedImage,
  embedTextMultimodal,
  cosineSimilarity,
  hasVertexServiceAccountEnv,
} = require('./vertex-embed');

const QA_SCREEN_THRESHOLD = parseFloat(process.env.EMBED_QA_SCREEN_THRESHOLD || '0.80');

/**
 * Pre-screens a batch of steps via embedding similarity.
 *
 * @param {Array<{ stepId: string, frames: Array<{label:string,path:string}>, step: object }>} inputs
 * @returns {Promise<Map<string, { screened: boolean, similarity: number, score: number }>>}
 *   Map from stepId to screening result.
 *   screened=true means step can skip Claude vision review.
 */
async function screenSteps(inputs) {
  const results = new Map();

  // Graceful skip when Vertex AI OAuth2 is not configured.
  // Note: QA pre-screening uses image embedding (multimodalembedding@001) which requires
  // OAuth2 — GOOGLE_API_KEY alone is not sufficient for this stage.
  if (!process.env.VERTEX_AI_PROJECT_ID || !hasVertexServiceAccountEnv()) {
    for (const { stepId } of inputs) {
      results.set(stepId, { screened: false, similarity: 0, score: 0 });
    }
    return results;
  }

  for (const { stepId, frames, step } of inputs) {
    const midFrame = frames.find(f => f.label === 'mid');
    if (!midFrame || !fs.existsSync(midFrame.path)) {
      results.set(stepId, { screened: false, similarity: 0, score: 0, _reason: 'no-mid-frame' });
      continue;
    }

    const visualState = step.visualState || step.uiDescription || step.label || '';
    if (!visualState.trim()) {
      results.set(stepId, { screened: false, similarity: 0, score: 0, _reason: 'no-visual-state' });
      continue;
    }

    try {
      const frameBuffer = fs.readFileSync(midFrame.path);
      const [frameVec, textVec] = await Promise.all([
        embedImage(frameBuffer),
        embedTextMultimodal(visualState),
      ]);

      const similarity = cosineSimilarity(frameVec, textVec);
      const sim3       = Math.round(similarity * 1000) / 1000;
      const screened   = similarity >= QA_SCREEN_THRESHOLD;

      results.set(stepId, {
        screened,
        similarity:     sim3,
        score:          screened ? 90 : 0,
        _embedScreened: screened,
      });
    } catch (err) {
      // Never fail QA pre-screening — fall through to Claude Sonnet review
      results.set(stepId, {
        screened:   false,
        similarity: 0,
        score:      0,
        _error:     err.message,
      });
    }
  }

  return results;
}

module.exports = { screenSteps, QA_SCREEN_THRESHOLD };
