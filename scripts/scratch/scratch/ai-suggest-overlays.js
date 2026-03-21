'use strict';
/**
 * ai-suggest-overlays.js
 * Pipeline stage: AI-powered Remotion overlay suggestion engine.
 *
 * Reads:  qa-frames/{stepId}-{start|mid|end}.png
 *         remotion-props.json  (REQUIRED — CRITICAL error if absent)
 *         voiceover-manifest.json  (optional)
 *         demo-script.json  (for step labels + narration)
 *
 * Writes: overlay-suggestions.json
 *         (optionally patches remotion-props.json when AI_SUGGEST_AUTO_APPLY=true)
 *
 * Usage:
 *   PIPELINE_RUN_DIR=out/demos/... node scripts/scratch/scratch/ai-suggest-overlays.js
 */

require('dotenv').config({ override: true });

const fs   = require('fs');
const path = require('path');

const {
  checkCredentials,
  screenStepNeedsAnalysis,
  analyzeStepForSuggestions,
} = require('../utils/gemini-suggest');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT  = path.resolve(__dirname, '../../..');
const RUN_DIR       = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out', 'latest');
const MAX_CONCURRENCY = 4;

function runPath(rel) { return path.join(RUN_DIR, rel); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return null; }
}

/**
 * Atomic JSON write: writes to .tmp file then renames.
 */
function atomicWriteJson(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Deep-merge a suggestion patch into a remotion-props step entry.
 * - Array fields (callouts): appends new items rather than replacing
 * - Nested objects (zoomPunch): merges fields
 * - action=remove: deletes the top-level key named by patch key
 */
function deepMergePatch(stepEntry, patch, action) {
  if (!stepEntry || !patch) return stepEntry;
  const result = Object.assign({}, stepEntry);

  for (const [key, val] of Object.entries(patch)) {
    if (action === 'remove') {
      delete result[key];
    } else if (Array.isArray(val) && Array.isArray(result[key])) {
      // Append array items (e.g. callouts)
      result[key] = [...result[key], ...val];
    } else if (val && typeof val === 'object' && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      // Merge nested objects
      result[key] = Object.assign({}, result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Build a concurrency-limited queue (similar to p-limit).
 */
function buildQueue(maxConcurrent) {
  let active = 0;
  const pending = [];

  function next() {
    while (active < maxConcurrent && pending.length > 0) {
      active++;
      const { fn, resolve, reject } = pending.shift();
      Promise.resolve().then(fn).then(v => { active--; resolve(v); next(); }, e => { active--; reject(e); next(); });
    }
  }

  return function enqueue(fn) {
    return new Promise((resolve, reject) => {
      pending.push({ fn, resolve, reject });
      next();
    });
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[ai-suggest-overlays] Starting overlay suggestion analysis…');
  const startTime = Date.now();

  // ── 1. Validate: remotion-props.json MUST exist ───────────────────────────
  const remotionPropsPath = runPath('remotion-props.json');
  if (!fs.existsSync(remotionPropsPath)) {
    // Gracefully skip on fresh pipeline (render hasn't run yet to create remotion-props.json).
    // Write a sentinel so downstream stages and the dashboard know the stage was skipped.
    console.log('[ai-suggest-overlays] remotion-props.json not found — skipping (run after render for suggestions).');
    fs.writeFileSync(runPath('overlay-suggestions.json'), JSON.stringify({
      skipped: true,
      reason: 'remotion-props.json not found — run this stage after the render stage',
      totalSuggestions: 0,
      steps: {},
    }, null, 2));
    return;
  }
  const remotionProps = safeReadJson(remotionPropsPath);
  if (!remotionProps) {
    throw new Error('CRITICAL: remotion-props.json is unreadable or invalid JSON.');
  }

  // ── 2. Load optional inputs ───────────────────────────────────────────────
  const manifest    = safeReadJson(runPath('voiceover-manifest.json'));
  const demoScript  = safeReadJson(runPath('demo-script.json'));

  // Build manifest lookup: stepId → { narration, durationMs }
  const manifestMap = {};
  if (manifest?.clips) {
    for (const clip of manifest.clips) {
      if (clip.stepId) manifestMap[clip.stepId] = { narration: clip.narration, durationMs: clip.durationMs };
    }
  }

  // Extract step list from remotion-props or demo-script
  const steps = demoScript?.steps || [];
  const stepMap = {};
  for (const s of steps) stepMap[s.id] = s;

  // Extract overlay map from remotion-props
  // remotion-props.json has scratchSteps: { [stepId]: { ... overlay fields ... } }
  const scratchSteps = remotionProps.scratchSteps || {};
  const stepIds = Object.keys(scratchSteps).length > 0
    ? Object.keys(scratchSteps)
    : steps.map(s => s.id);

  // ── 3. Inventory qa-frames/ ───────────────────────────────────────────────
  const qaFramesDir = runPath('qa-frames');
  const framesExist = fs.existsSync(qaFramesDir);
  let frameInventory = {};  // stepId → { start, mid, end } (absolute paths or null)

  if (framesExist) {
    const files = fs.readdirSync(qaFramesDir).filter(f => /\.png$/i.test(f));
    for (const f of files) {
      const m = f.match(/^(.+)-(start|mid|end)\.png$/i);
      if (m) {
        const [, sid, pos] = m;
        if (!frameInventory[sid]) frameInventory[sid] = {};
        frameInventory[sid][pos] = path.join(qaFramesDir, f);
      }
    }
  }

  const hasAnyFrames = Object.keys(frameInventory).length > 0;

  // ── 4. Check credentials ──────────────────────────────────────────────────
  let credentialsAbsent = false;
  try {
    checkCredentials();
  } catch (err) {
    if (err.message === 'CREDENTIALS_ABSENT') {
      credentialsAbsent = true;
      console.log('[ai-suggest-overlays] No credentials (GOOGLE_API_KEY / VERTEX_AI_PROJECT_ID) — skipping.');
    } else {
      throw err;
    }
  }

  if (credentialsAbsent) {
    atomicWriteJson(runPath('overlay-suggestions.json'), {
      skipped:         true,
      reason:          'no credentials',
      totalSuggestions: 0,
      generatedAt:     new Date().toISOString(),
      steps:           {},
    });
    return;
  }

  // ── 5. Handle no frames gracefully ───────────────────────────────────────
  if (!hasAnyFrames) {
    console.warn('[ai-suggest-overlays] No qa-frames found — writing warning, skipping analysis.');
    atomicWriteJson(runPath('overlay-suggestions.json'), {
      warning:          'no frames available — run qa stage first',
      totalSuggestions: 0,
      generatedAt:      new Date().toISOString(),
      steps:            {},
    });
    return;
  }

  // ── 6. Demo context ───────────────────────────────────────────────────────
  const productName = demoScript?.product || remotionProps?.productName || 'Plaid';
  const persona     = demoScript?.persona?.name || demoScript?.persona || 'developer';

  // ── 7. Per-step analysis (max 4 concurrent) ────────────────────────────────
  const enqueue = buildQueue(MAX_CONCURRENCY);
  const results = {};  // stepId → result entry

  let totalSuggestions = 0;
  let screened = 0;
  let autoApplied = 0;
  const autoApply = process.env.AI_SUGGEST_AUTO_APPLY === 'true';
  const autoApplyThreshold = parseFloat(process.env.AI_SUGGEST_THRESHOLD || '0.90');

  const analysisPromises = stepIds.map((stepId, idx) => enqueue(async () => {
    const step    = stepMap[stepId] || { id: stepId, narration: '', label: stepId };
    const frames  = frameInventory[stepId];
    const voInfo  = manifestMap[stepId] || { narration: step.narration || '', durationMs: step.durationMs || 0 };
    const overlay = scratchSteps[stepId] || {};
    const ctx     = { productName, persona, stepIndex: idx, totalSteps: stepIds.length, stepLabel: step.label || step.id };

    // Skip Plaid Link launch steps — they're auto-handled
    if (step.plaidPhase === 'launch' || (step.id && /link.?launch/i.test(step.id))) {
      results[stepId] = { skipped: true, reason: 'plaid-link-step', suggestions: [] };
      return;
    }

    // Skip if no frames for this step
    if (!frames || (!frames.start && !frames.mid && !frames.end)) {
      results[stepId] = { skipped: true, reason: 'no-frames', suggestions: [] };
      return;
    }

    // Tier 1: embedding pre-screen
    let needsAnalysis = true;
    try {
      needsAnalysis = await screenStepNeedsAnalysis(step, voInfo, overlay);
    } catch (_) {
      needsAnalysis = true;  // on error, always analyze
    }

    if (!needsAnalysis) {
      screened++;
      results[stepId] = { screened: true, suggestions: [] };
      return;
    }

    // Tier 2: Flash analysis
    const framePaths = [frames.start, frames.mid, frames.end].filter(Boolean);
    try {
      const suggestions = await analyzeStepForSuggestions(step, framePaths, voInfo, overlay, ctx);
      results[stepId]   = { suggestions };
      totalSuggestions += suggestions.length;

      if (suggestions.length > 0) {
        console.log(`[ai-suggest-overlays] ${stepId}: ${suggestions.length} suggestion(s)`);
      }
    } catch (err) {
      const isAuth = err.message.includes('auth_failed') || err.message.includes('401') || err.message.includes('403');
      const isTimeout = err.message.includes('timeout') || err.name === 'AbortError';
      results[stepId] = {
        error:       isAuth ? 'auth_failed' : isTimeout ? 'timeout' : err.message.slice(0, 200),
        suggestions: [],
      };
      console.warn(`[ai-suggest-overlays] ${stepId}: ${results[stepId].error}`);
    }
  }));

  await Promise.all(analysisPromises);

  // ── 8. Write overlay-suggestions.json ─────────────────────────────────────
  const output = {
    totalSuggestions,
    screened,
    generatedAt: new Date().toISOString(),
    steps:       results,
  };
  atomicWriteJson(runPath('overlay-suggestions.json'), output);
  console.log(`[ai-suggest-overlays] ${totalSuggestions} suggestion(s) across ${Object.keys(results).length} step(s) (${screened} screened/skipped).`);

  // ── 9. Auto-apply high-confidence suggestions if requested ────────────────
  if (autoApply && totalSuggestions > 0) {
    let patchedProps = JSON.parse(JSON.stringify(remotionProps));  // deep clone
    for (const [stepId, entry] of Object.entries(results)) {
      if (!entry.suggestions?.length) continue;
      const highConf = entry.suggestions.filter(s => s.confidence >= autoApplyThreshold && s.action !== 'remove');
      if (!highConf.length) continue;
      for (const suggestion of highConf) {
        patchedProps.scratchSteps[stepId] = deepMergePatch(
          patchedProps.scratchSteps[stepId] || {},
          suggestion.patch,
          suggestion.action
        );
        autoApplied++;
      }
    }
    if (autoApplied > 0) {
      atomicWriteJson(remotionPropsPath, patchedProps);
      console.log(`[ai-suggest-overlays] Auto-applied ${autoApplied} high-confidence suggestion(s) to remotion-props.json.`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[ai-suggest-overlays] Done in ${elapsed}s.`);
}

module.exports = { main, deepMergePatch };

if (require.main === module) {
  main().catch(err => {
    console.error('[ai-suggest-overlays] Fatal:', err.message);
    process.exit(1);
  });
}
