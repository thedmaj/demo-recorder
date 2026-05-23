'use strict';
/**
 * slide-content-hash.js
 *
 * Drift checkpoint for slide HTML between build-qa, record, voiceover, and
 * sync stages. After build-qa passes, this module writes a SHA-256 hash of
 * every `<div data-testid="step-{id}">…</div>` block in scratch-app/index.html.
 * Downstream stages re-compute the hash and compare:
 *
 *   - If a hash matches → HTML is still what build-qa blessed
 *   - If a hash drifts → block recording start with a clear recovery hint
 *
 * Editor mutations (storyboard `/api/runs/:runId/script`, /insert-library-slide,
 * /remove-step, /reorder-steps) recompute hashes with `source: 'storyboard-edit'`
 * and `userModifiedSinceQa: true` so downstream stages know the drift is
 * USER-INITIATED and surface it as a "QA not re-run since edit" banner
 * instead of a hard-fail.
 *
 * On app-only runs:
 *   - Slide-tier entries are OMITTED entirely (no `slide` key in the JSON).
 *     The app-only invariant says zero slide artifacts; nothing to hash.
 *
 * Schema (slide-content-hash.json):
 *   {
 *     "schemaVersion": 1,
 *     "computedAt": "<ISO8601>",
 *     "source": "build-qa" | "storyboard-edit",
 *     "buildMode": "app-only" | "app+slides",
 *     "steps": {
 *       "<step-id>": {
 *         "tier": "app" | "slide",
 *         "sha256": "<64-hex>",
 *         "userModifiedSinceQa": false,
 *         "modifiedAt": null | "<ISO8601>"
 *       }
 *     }
 *   }
 *
 * Public API:
 *   - extractStepBlocks(html)                          → { stepId, html }[]
 *   - hashStepBlock(blockHtml)                          → "<hex64>"
 *   - computeHashesForRun(runDir, opts)                 → hashFile written
 *   - readHashes(runDir)                                → JSON | null
 *   - detectDrift(runDir, currentHtml, manifestBuildMode) → drift report
 *   - markUserModified(runDir, stepIds, opts)           → mutates JSON
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readRunManifest } = require('./run-io');
const { isSlideStep } = require('./step-kind');

const HASH_FILE_NAME = 'slide-content-hash.json';
const SCHEMA_VERSION = 1;

/**
 * Extract per-step HTML blocks from a scratch-app index.html. Mirrors the
 * same `data-testid="step-..."` boundary that post-slides + dashboard helpers
 * use. The outer wrapper (incl. attributes) is part of the hashed block.
 *
 * @param {string} html
 * @returns {Array<{ stepId: string, html: string }>}
 */
function extractStepBlocks(html) {
  if (typeof html !== 'string' || !html) return [];
  const out = [];
  // Match each step block up to (but not including) the next step, side-panel
  // marker, side-panel div, or </body>. Same lookahead pattern as
  // stepBlockRegex in strip-slide-roots-for-post-slides.js.
  const re = /<div[^>]*\bdata-testid="step-([^"]+)"[^>]*>[\s\S]*?(?=<div[^>]*\bdata-testid="step-|<!--[\s\S]*?SIDE PANELS|<div[^>]*\bid="(?:link-events-panel|api-response-panel)"|<\/body>|$)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ stepId: m[1], html: m[0] });
  }
  return out;
}

/**
 * SHA-256 hex of a step block. Whitespace is normalized so insignificant
 * formatting differences (extra spaces / trailing newlines after a tooling
 * pass) don't fire false-positive drift warnings.
 *
 * @param {string} blockHtml
 * @returns {string}
 */
function hashStepBlock(blockHtml) {
  const normalized = String(blockHtml || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')   // strip trailing spaces per line
    .replace(/\n{3,}/g, '\n\n')   // collapse 3+ blank lines
    .trim();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Resolve which tier a step belongs to. Reads demo-script.json so we can
 * tag each hash with `'app'` or `'slide'` for downstream consumers.
 *
 * @param {object} demoScript
 * @returns {Map<string, 'app'|'slide'>}
 */
function buildStepTierMap(demoScript) {
  const map = new Map();
  const steps = Array.isArray(demoScript && demoScript.steps) ? demoScript.steps : [];
  for (const s of steps) {
    if (!s || !s.id) continue;
    map.set(s.id, isSlideStep(s) ? 'slide' : 'app');
  }
  return map;
}

/**
 * Compute hashes for every step block in scratch-app/index.html and write
 * `slide-content-hash.json` to the run dir.
 *
 * @param {string} runDir
 * @param {object} [opts]
 * @param {'build-qa'|'storyboard-edit'} [opts.source='build-qa']
 * @param {boolean} [opts.userModifiedSinceQa=false]
 * @param {string[]|null} [opts.affectedStepIds=null]   when source=storyboard-edit,
 *   only flag these step ids as userModifiedSinceQa (others stay clean)
 * @returns {{ hashFile, source, buildMode, stepCount, slideCount, appCount }}
 */
function computeHashesForRun(runDir, opts = {}) {
  if (!runDir || !fs.existsSync(runDir)) {
    throw new Error(`[slide-content-hash] runDir not found: ${runDir}`);
  }
  const source = opts.source === 'storyboard-edit' ? 'storyboard-edit' : 'build-qa';
  const userModifiedSinceQa = !!opts.userModifiedSinceQa;
  const affectedSet = Array.isArray(opts.affectedStepIds)
    ? new Set(opts.affectedStepIds.map(String))
    : null;

  const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
  const scriptPath = path.join(runDir, 'demo-script.json');
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`[slide-content-hash] scratch-app/index.html not found in ${runDir}`);
  }
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`[slide-content-hash] demo-script.json not found in ${runDir}`);
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const demoScript = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const tierMap = buildStepTierMap(demoScript);
  const blocks = extractStepBlocks(html);

  const manifest = readRunManifest(runDir) || {};
  const buildMode = String(manifest.buildMode || 'app-only').toLowerCase();
  const isAppOnly = buildMode === 'app-only';

  // Preserve prior userModifiedSinceQa flags when re-computing (so a previous
  // storyboard edit doesn't get cleared by a subsequent passive recompute).
  // The only call that should CLEAR the flag is a fresh build-qa pass that
  // intentionally re-baselines.
  const priorRaw = readHashes(runDir);
  const priorSteps = priorRaw && priorRaw.steps ? priorRaw.steps : {};

  const steps = {};
  for (const { stepId, html: blockHtml } of blocks) {
    const tier = tierMap.get(stepId) || 'app';
    // App-only invariant: omit slide-tier entries on app-only runs.
    if (isAppOnly && tier === 'slide') continue;

    const sha = hashStepBlock(blockHtml);
    const prior = priorSteps[stepId] || {};
    let flag = false;
    let modifiedAt = null;

    if (source === 'build-qa') {
      // build-qa re-baselines: clear userModifiedSinceQa flags.
      flag = false;
      modifiedAt = null;
    } else if (affectedSet && affectedSet.has(stepId)) {
      // storyboard-edit: mark only the explicitly affected step(s).
      flag = userModifiedSinceQa;
      modifiedAt = userModifiedSinceQa ? new Date().toISOString() : prior.modifiedAt || null;
    } else {
      // storyboard-edit without affectedStepIds: preserve prior flag state.
      flag = !!prior.userModifiedSinceQa;
      modifiedAt = prior.modifiedAt || null;
    }

    steps[stepId] = {
      tier,
      sha256: sha,
      userModifiedSinceQa: flag,
      modifiedAt,
    };
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    computedAt: new Date().toISOString(),
    source,
    buildMode,
    steps,
  };
  const hashFile = path.join(runDir, HASH_FILE_NAME);
  const tmp = hashFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, hashFile);

  const slideCount = Object.values(steps).filter((s) => s.tier === 'slide').length;
  const appCount = Object.values(steps).filter((s) => s.tier === 'app').length;
  return {
    hashFile,
    source,
    buildMode,
    stepCount: Object.keys(steps).length,
    slideCount,
    appCount,
  };
}

/**
 * Read slide-content-hash.json (or null if absent / unparseable).
 *
 * @param {string} runDir
 * @returns {object|null}
 */
function readHashes(runDir) {
  const p = path.join(runDir, HASH_FILE_NAME);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Detect drift between the recorded hashes and the current HTML on disk.
 * Returns a drift report with per-step status:
 *
 *   - 'match'                : hash matches
 *   - 'drift'                : hash mismatch (probable regression)
 *   - 'user-modified'        : hash mismatch but step is marked
 *                              userModifiedSinceQa (expected; banner-worthy)
 *   - 'missing-in-current'   : recorded step is not in current HTML
 *   - 'extra-in-current'     : current HTML has a step not in recorded hashes
 *
 * @param {string} runDir
 * @returns {{
 *   hasRecord: boolean,
 *   buildMode: string,
 *   driftCount: number,
 *   userModifiedCount: number,
 *   steps: Array<{ stepId, tier, status, recordedSha, currentSha }>,
 * } | { hasRecord: false }}
 */
function detectDrift(runDir) {
  const recorded = readHashes(runDir);
  if (!recorded) return { hasRecord: false };

  const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return { hasRecord: true, buildMode: recorded.buildMode, error: 'index.html missing' };
  }
  const currentHtml = fs.readFileSync(htmlPath, 'utf8');
  const currentBlocks = extractStepBlocks(currentHtml);
  const currentByStep = new Map(currentBlocks.map((b) => [b.stepId, hashStepBlock(b.html)]));
  const recordedSteps = recorded.steps || {};

  const out = [];
  let driftCount = 0;
  let userModifiedCount = 0;

  for (const [stepId, entry] of Object.entries(recordedSteps)) {
    const currentSha = currentByStep.get(stepId);
    if (currentSha == null) {
      out.push({ stepId, tier: entry.tier, status: 'missing-in-current', recordedSha: entry.sha256, currentSha: null });
      driftCount += 1;
    } else if (currentSha === entry.sha256) {
      out.push({ stepId, tier: entry.tier, status: 'match', recordedSha: entry.sha256, currentSha });
    } else if (entry.userModifiedSinceQa) {
      out.push({ stepId, tier: entry.tier, status: 'user-modified', recordedSha: entry.sha256, currentSha });
      userModifiedCount += 1;
    } else {
      out.push({ stepId, tier: entry.tier, status: 'drift', recordedSha: entry.sha256, currentSha });
      driftCount += 1;
    }
  }

  // Extra steps in current HTML that weren't in the recorded hashes (e.g.
  // storyboard-editor inserted a slide after build-qa). These are flagged
  // separately so the caller can decide policy.
  for (const { stepId } of currentBlocks) {
    if (!recordedSteps[stepId]) {
      out.push({ stepId, tier: null, status: 'extra-in-current', recordedSha: null, currentSha: currentByStep.get(stepId) });
    }
  }

  return {
    hasRecord: true,
    buildMode: recorded.buildMode,
    source: recorded.source,
    computedAt: recorded.computedAt,
    driftCount,
    userModifiedCount,
    steps: out,
  };
}

/**
 * Mark specific step ids as `userModifiedSinceQa: true` without recomputing
 * other steps' hashes. Used by storyboard-editor endpoints that mutate HTML
 * for one step (e.g. /script narration edit reflowed text inside step-x
 * but didn't touch step-y, step-z).
 *
 * @param {string} runDir
 * @param {string[]} stepIds
 */
function markUserModified(runDir, stepIds) {
  if (!Array.isArray(stepIds) || stepIds.length === 0) return null;
  const recorded = readHashes(runDir);
  if (!recorded) return null;
  const now = new Date().toISOString();
  const steps = { ...(recorded.steps || {}) };
  for (const id of stepIds) {
    if (!steps[id]) continue;
    steps[id] = {
      ...steps[id],
      userModifiedSinceQa: true,
      modifiedAt: now,
    };
  }
  const payload = {
    ...recorded,
    computedAt: now,
    steps,
  };
  const p = path.join(runDir, HASH_FILE_NAME);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return payload;
}

module.exports = {
  HASH_FILE_NAME,
  SCHEMA_VERSION,
  extractStepBlocks,
  hashStepBlock,
  computeHashesForRun,
  readHashes,
  detectDrift,
  markUserModified,
};
