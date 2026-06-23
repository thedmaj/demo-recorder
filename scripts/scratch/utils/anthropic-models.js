'use strict';
/**
 * anthropic-models.js
 *
 * Central registry of the Anthropic models the demo pipeline calls.
 *
 * Decision (2026-05-29): Default to **Claude Opus 4.8 (1M context)**
 * for every Opus-tier stage. The 1M context gives ~5x headroom for:
 *   • Large storyboards (>14 beats) where structured-output script gen
 *     burns input on schema + skill files + product KBs.
 *   • Build-app iter-3 refinement runs that stack prior HTML + vision
 *     frames + diagnostics in a single call.
 *   • post-slides / slide-fix calls that load the full deck design
 *     system + showcase templates alongside the demo state.
 *
 * Sonnet and Haiku tiers are kept as-is — they handle short-horizon
 * per-clip or per-frame work where 200K is plenty and 1M would only
 * raise cost without changing quality.
 *
 * Override paths (in priority order, top wins):
 *   1. Per-stage env (e.g. SCRIPT_MODEL, BUILD_APP_MODEL) — when set,
 *      bypasses the registry entirely
 *   2. PIPELINE_OPUS_MODEL — global override of OPUS_PRIMARY
 *   3. The constants below
 *
 * Bumping the default: change OPUS_PRIMARY here, every file picks it
 * up on next process start. No model-IDs scattered across the codebase.
 */

// Primary Opus model — used for every Opus-tier pipeline stage:
// research synthesis, script generation, build-app HTML generation,
// post-slides, post-panels, qa-review, touchup, slide-fix,
// smart-plaid-agent, enhance/segment, enhance/overlay-plan,
// enhance/enhance-script, enhance/analyze-video, sync-audio.
//
// Note on the 1M-context variant: the bracket-suffix form
// `claude-opus-4-8[1m]` is Claude Code's INTERNAL notation, not an
// Anthropic API model ID. To enable the 1M context window in API calls,
// pass `betas: ['context-1m-2025-08-07']` to messages.create — see
// OPUS_PRIMARY_BETAS below. The model ID itself is `claude-opus-4-8`.
const OPUS_PRIMARY = process.env.PIPELINE_OPUS_MODEL || 'claude-opus-4-8';

// Beta flags to enable on every Opus call. Stages that take the
// registry path (read OPUS_PRIMARY) should also read this array and
// forward it as `betas` on the messages.create call. 1M context is ON by
// default for the Opus tier (large storyboards / iter-3 refinement / deck
// templates routinely exceed 200K). Set PIPELINE_OPUS_1M=false to disable.
const OPUS_PRIMARY_BETAS = process.env.PIPELINE_OPUS_1M === 'false'
  ? []
  : ['context-1m-2025-08-07'];

// Opus fallback — used when the primary (Opus 4.8) is unavailable / stalls via
// the Anthropic API after the primary retries are exhausted (e.g.
// BUILD_STREAM_IDLE during availability blips). build-app generation switches to
// this model rather than failing the build. Override with PIPELINE_OPUS_FALLBACK.
const OPUS_FALLBACK = process.env.PIPELINE_OPUS_FALLBACK || 'claude-opus-4-7';

// Sonnet — narration repace, story-echo, multi-modal recording analysis.
// Short-horizon per-clip work; 200K context is plenty.
const SONNET_PRIMARY = process.env.PIPELINE_SONNET_MODEL || 'claude-sonnet-4-6';

// Haiku — per-step vision QA, brand extraction, data realism, scene
// matching, embed validation, plaid browser agent vision, dashboard
// AI edits. Cost-sensitive micro-evaluations.
const HAIKU_PRIMARY = process.env.PIPELINE_HAIKU_MODEL || 'claude-haiku-4-5-20251001';

module.exports = {
  OPUS_PRIMARY,
  OPUS_FALLBACK,
  OPUS_PRIMARY_BETAS,
  SONNET_PRIMARY,
  HAIKU_PRIMARY,
};
