'use strict';
/**
 * research-reuse.js
 *
 * Single source of truth for "should the orchestrator skip the `research`
 * stage and reuse the existing `product-research.json`?".
 *
 * Rule (May 2026 — default-on):
 *   1. RESEARCH_REUSE defaults to `true` (was opt-in until this change).
 *      Pass `RESEARCH_REUSE=false` to force a fresh research pass.
 *   2. If the operator explicitly restarts from `--from=research`, never
 *      reuse — the operator's intent is to re-run.
 *   3. `product-research.json` must exist in the run dir.
 *   4. The cached research must have an `inputPromptFingerprint` field
 *      matching the current `prompt.txt`. The fingerprint is computed by
 *      `utils/prompt-fingerprint.js` and changes whenever prompt content
 *      (or whitespace-normalized content) changes.
 *
 * Why default-on:
 *   - The fingerprint check is exact — different prompts produce different
 *     fingerprints, so reuse is safe by construction.
 *   - Research is the slowest agentic stage (200+ seconds, several LLM calls).
 *   - The common UX failure was re-running a successful research stage on a
 *     simple resume, costing 3+ minutes and several dollars for no gain.
 */

const fs = require('fs');
const path = require('path');

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function parseBoolEnv(value, defaultValue = false) {
  if (value == null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (v === '' ) return defaultValue;
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/**
 * @param {object} opts
 * @param {string} opts.runDir              Run directory holding product-research.json.
 * @param {string} opts.promptText          Current prompt text (for fingerprinting).
 * @param {string} [opts.effectiveFromStage] Optional `--from=<stage>` value.
 * @param {function} [opts.fingerprintPrompt] Injected fingerprint fn for tests.
 * @param {boolean} [opts.envReuseDefault=true] Default value of RESEARCH_REUSE when unset.
 * @returns {{ shouldReuse: boolean, reason: string, fingerprint?: string }}
 */
function shouldReuseExistingResearch(opts = {}) {
  const {
    runDir,
    promptText,
    effectiveFromStage,
    envReuseDefault = true,
  } = opts;
  const fingerprintPrompt = opts.fingerprintPrompt
    || require('./prompt-fingerprint').fingerprintPrompt;

  if (!parseBoolEnv(process.env.RESEARCH_REUSE, envReuseDefault)) {
    return { shouldReuse: false, reason: 'env_research_reuse_false' };
  }
  if (effectiveFromStage === 'research') {
    return { shouldReuse: false, reason: 'explicit_from_research' };
  }
  if (!runDir) return { shouldReuse: false, reason: 'no_run_dir' };

  const prPath = path.join(runDir, 'product-research.json');
  if (!fs.existsSync(prPath)) {
    return { shouldReuse: false, reason: 'no_existing_research_artifact' };
  }
  const fp = fingerprintPrompt(promptText || '');
  if (!fp) return { shouldReuse: false, reason: 'empty_prompt_fingerprint' };

  const data = readJsonSafe(prPath);
  if (!data || typeof data.inputPromptFingerprint !== 'string') {
    return { shouldReuse: false, reason: 'cached_research_missing_fingerprint' };
  }
  if (data.inputPromptFingerprint !== fp) {
    return { shouldReuse: false, reason: 'prompt_fingerprint_mismatch', fingerprint: fp };
  }
  return { shouldReuse: true, reason: 'fingerprint_match', fingerprint: fp };
}

module.exports = {
  shouldReuseExistingResearch,
  parseBoolEnv,
};
