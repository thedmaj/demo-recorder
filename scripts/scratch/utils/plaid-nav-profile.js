'use strict';
/**
 * plaid-nav-profile.js
 *
 * Loader/resolver for the per-experience Plaid navigation profiles in
 * inputs/plaid-nav-profiles/*.json. A profile is a recipe-schema superset
 * (screens[] with detect/arrival/transition signals) plus:
 *   - pacingDefaults + per-screen pacing blocks (consumed by human-pacing.js)
 *   - observed transition stats (p50/p90, merged in by calibration and the
 *     plaid-nav-feedback loop; p90 is the minimum-safe-wait floor)
 *   - knowledgeConfidence (<0.75 → calibration emits knowledgeGaps)
 *
 * Experiences: classic-link | embedded-link | layer | cra-link | idv
 *
 * Resolution mirrors record-local.js: PLAID_FLOW_TYPE env / CRA inference →
 * flowType; demo-script plaidLinkMode 'embedded' → embedded-link; Layer/IDV
 * launches resolve by product. Missing profile → null and every call site
 * falls back to pre-existing behavior.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PROFILE_DIR = path.join(PROJECT_ROOT, 'inputs', 'plaid-nav-profiles');
const STALE_AFTER_DAYS = 30;

/**
 * Map runtime context → profile name.
 * @param {object} ctx
 * @param {string} [ctx.flowType]  'link' | 'cra' | 'oauth' | 'remember_me' | ...
 * @param {string} [ctx.product]   launch product: 'layer' | 'idv' | undefined
 * @param {boolean} [ctx.embedded] plaidLinkMode === 'embedded'
 */
function resolveProfileName(ctx = {}) {
  const product = String(ctx.product || '').toLowerCase();
  if (product === 'layer') return 'layer';
  if (product === 'idv' || product === 'identity_verification') return 'idv';
  if (ctx.embedded) return 'embedded-link';
  const flow = String(ctx.flowType || '').toLowerCase();
  if (flow === 'cra') return 'cra-link';
  return 'classic-link';
}

function loadProfileByName(name) {
  const p = path.join(PROFILE_DIR, `${name}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const profile = JSON.parse(fs.readFileSync(p, 'utf8'));
    profile.__filePath = p;
    return profile;
  } catch (err) {
    console.warn(`[nav-profile] Failed to parse ${p}: ${err.message}`);
    return null;
  }
}

/** Resolve + load; warns (never throws) on staleness. Returns profile|null. */
function resolveProfile(ctx = {}) {
  const name = resolveProfileName(ctx);
  const profile = loadProfileByName(name);
  if (!profile) {
    console.warn(`[nav-profile] No profile "${name}" in inputs/plaid-nav-profiles/ — pacing falls back to engine defaults`);
    return null;
  }
  const staleness = checkStaleness(profile);
  if (staleness) {
    console.warn(`[nav-profile] Profile "${name}" is STALE (${staleness}) — consider: node scripts/test-plaid-nav-calibrate.js --experience ${name}`);
  }
  return profile;
}

/** Returns a human-readable staleness reason, or null when fresh. */
function checkStaleness(profile) {
  const verified = profile.lastVerifiedAt ? Date.parse(profile.lastVerifiedAt) : null;
  const broken = profile.lastBrokenAt ? Date.parse(profile.lastBrokenAt) : null;
  if (broken && (!verified || broken > verified)) return 'broken after last verification';
  if (!verified) return 'never calibrated';
  const ageDays = (Date.now() - verified) / 86400000;
  if (ageDays > STALE_AFTER_DAYS) return `last verified ${Math.round(ageDays)}d ago`;
  return null;
}

/**
 * Merged pacing for a screen: screen.pacing → profile.pacingDefaults.
 * Accepts a screen id or a detectPlaidScreen() label. Also surfaces the
 * screen's typicalWordCount so the read-time model has a basis.
 */
function getScreenPacing(profile, screenIdOrLabel) {
  if (!profile) return null;
  const screen = findScreen(profile, screenIdOrLabel);
  return {
    ...(profile.pacingDefaults || {}),
    ...(screen?.pacing || {}),
    ...(screen?.typicalWordCount ? { typicalWordCount: screen.typicalWordCount } : {}),
  };
}

function findScreen(profile, idOrLabel) {
  if (!profile?.screens || !idOrLabel) return null;
  return profile.screens.find((s) => s.id === idOrLabel) ||
    profile.screens.find((s) => s.detect?.label === idOrLabel) || null;
}

// ── Observation merging (used by calibration + plaid-nav-feedback) ───────────

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Merge raw transition samples into a screen's rolling observed stats.
 * @param {object} profile
 * @param {string} screenId
 * @param {number[]} transitionMsSamples  new samples (action → next arrival)
 * @param {object} [extra]                e.g. { wordCount, selectorOutcome }
 */
function mergeObservation(profile, screenId, transitionMsSamples, extra = {}) {
  const screen = findScreen(profile, screenId);
  if (!screen) return false;
  screen.observed = screen.observed || { samples: 0, recent: [] };
  const recent = Array.isArray(screen.observed.recent) ? screen.observed.recent : [];
  for (const ms of transitionMsSamples || []) {
    if (Number.isFinite(ms) && ms >= 0) recent.push(Math.round(ms));
  }
  while (recent.length > 20) recent.shift(); // rolling window
  const sorted = [...recent].sort((a, b) => a - b);
  screen.observed.recent = recent;
  screen.observed.samples = (screen.observed.samples || 0) + (transitionMsSamples?.length || 0);
  screen.observed.p50TransitionMs = percentile(sorted, 50);
  screen.observed.p90TransitionMs = percentile(sorted, 90);
  if (extra.wordCount != null) screen.typicalWordCount = extra.wordCount;
  if (extra.selectorOutcome) {
    screen.observed.lastSelectorOutcome = extra.selectorOutcome;
  }
  return true;
}

/** Persist a (mutated) profile back to its file. */
function saveProfile(profile) {
  if (!profile?.__filePath) return false;
  const toWrite = { ...profile };
  delete toWrite.__filePath;
  fs.writeFileSync(profile.__filePath, JSON.stringify(toWrite, null, 2) + '\n', 'utf8');
  return true;
}

module.exports = {
  PROFILE_DIR,
  resolveProfileName,
  resolveProfile,
  loadProfileByName,
  getScreenPacing,
  findScreen,
  mergeObservation,
  saveProfile,
  checkStaleness,
};
