'use strict';
/**
 * qa-tier-summary.js
 *
 * Helpers for computing a "tier-aware" view of a build-QA report. The
 * single overall score that build-qa already writes hides the fact that
 * `stepKind === 'app'` and `stepKind === 'slide'` are two independent
 * deliverables. The orchestrator needs to know whether the app tier
 * passed independently of slides (and vice versa) so it can route to a
 * surgical recovery lane instead of regenerating the whole HTML via
 * `build-app` touchup / fullbuild.
 *
 * Schema added to `qa-report-build.json` (and `qa-report-N.json`):
 *
 *   {
 *     buildMode: 'app-only' | 'app+slides',
 *     tierSummary: {
 *       threshold: number,
 *       app:   { passed: bool, minScore, avgScore, stepIds, failingStepIds,
 *                criticalStepIds, stepCount, skipped: false },
 *       slide: { passed: bool, ...same shape, skipped: bool (true on app-only) }
 *     },
 *     recommendedRecovery: 'app-touchup' | 'slide-fix' | 'app-touchup+slide-fix' |
 *                         'fullbuild' | null
 *   }
 *
 * Pure functions. No I/O outside `safeReadJson`. Used by:
 *   - scripts/scratch/scratch/build-qa.js  (writes tierSummary on the report)
 *   - scripts/scratch/scratch/slide-fix.js + app-touchup.js (entry conditions)
 *   - scripts/scratch/orchestrator.js (tier-aware routing in runBuildPhase)
 *   - scripts/scratch/utils/stage-state.js (tier-aware nextRecoveryCommand)
 */

const fs = require('fs');
const path = require('path');

const { isSlideStep, getSlideStepIds, getAppStepIds } = require('./step-kind');

const DEFAULT_THRESHOLD = 80;

// Reasons that should force a fullbuild instead of a tier-scoped recovery
// even when only one tier "should" be re-run. Mirrors
// `analyzeSystemicSignals` / `analyzeFixModeForQaIteration`.
const SYSTEMIC_CATEGORIES = new Set([
  'qa-target-mismatch',
  'runtime-js-error',
  'selector-missing',
  'navigation-mismatch',
]);

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Resolve the run's build mode by checking, in order:
 *   1. opts.buildMode (caller override)
 *   2. run-manifest.json (orchestrator-written sentinel)
 *   3. demo-script.json `buildMode` field (build-app stamp)
 *   4. PIPELINE_WITH_SLIDES env (true → app+slides)
 *   5. Fallback: derive from demo-script — any `stepKind === 'slide'` → app+slides
 *
 * Always returns one of: 'app-only' | 'app+slides'.
 */
function resolveBuildMode({ runDir, demoScript, buildMode: overrideMode } = {}) {
  if (overrideMode === 'app-only' || overrideMode === 'app+slides') return overrideMode;

  if (runDir) {
    const manifest = safeReadJson(path.join(runDir, 'run-manifest.json'));
    if (manifest && typeof manifest.buildMode === 'string') {
      const v = manifest.buildMode.toLowerCase().trim();
      if (v === 'app-only' || v === 'app+slides') return v;
    }
  }

  if (demoScript && typeof demoScript === 'object') {
    const v = String(demoScript.buildMode || '').toLowerCase().trim();
    if (v === 'app-only' || v === 'app+slides') return v;
  }

  if (process.env.PIPELINE_WITH_SLIDES != null) {
    const v = String(process.env.PIPELINE_WITH_SLIDES).toLowerCase().trim();
    if (v === 'true' || v === '1') return 'app+slides';
    if (v === 'false' || v === '0') return 'app-only';
  }

  // Last-resort derivation from demo-script step shapes.
  if (demoScript && Array.isArray(demoScript.steps)) {
    const hasSlide = demoScript.steps.some((s) => isSlideStep(s));
    return hasSlide ? 'app+slides' : 'app-only';
  }

  return 'app-only';
}

/**
 * Map a step id → kind ('slide' | 'app') using the demo-script as the
 * source of truth. Falls back to {} when demo-script is missing.
 */
function buildStepKindMap(demoScript) {
  const map = Object.create(null);
  if (!demoScript || !Array.isArray(demoScript.steps)) return map;
  for (const step of demoScript.steps) {
    if (!step || !step.id) continue;
    map[String(step.id)] = isSlideStep(step) ? 'slide' : 'app';
  }
  return map;
}

/**
 * Compute the per-tier summary for a qa-report. Pure function.
 *
 * @param {object}  qaReport      Already-loaded qa-report-build.json
 * @param {object}  demoScript    Already-loaded demo-script.json (for stepKind)
 * @param {object}  opts
 * @param {string}  [opts.buildMode]  Force build mode (otherwise resolved)
 * @param {string}  [opts.runDir]     Run dir (for resolveBuildMode fallback)
 * @param {number}  [opts.threshold]  Pass threshold (default: report.passThreshold)
 * @returns {{
 *   buildMode: string,
 *   threshold: number,
 *   tierSummary: object,
 *   recommendedRecovery: string|null,
 * }}
 */
function computeTierSummary(qaReport, demoScript, opts = {}) {
  const threshold = Number.isFinite(Number(opts.threshold))
    ? Number(opts.threshold)
    : Number.isFinite(Number(qaReport && qaReport.passThreshold))
      ? Number(qaReport.passThreshold)
      : DEFAULT_THRESHOLD;

  const buildMode = resolveBuildMode({
    runDir: opts.runDir,
    demoScript,
    buildMode: opts.buildMode,
  });

  const kindMap = buildStepKindMap(demoScript);
  const slideIds = new Set(getSlideStepIds(demoScript));
  const appIds = new Set(getAppStepIds(demoScript));

  const stepsArr = Array.isArray(qaReport && qaReport.steps) ? qaReport.steps : [];
  const failingByTier = { app: [], slide: [] };
  const criticalByTier = { app: [], slide: [] };
  const scoresByTier = { app: [], slide: [] };

  for (const s of stepsArr) {
    if (!s || !s.stepId) continue;
    const id = String(s.stepId);
    const kind = kindMap[id] || (slideIds.has(id) ? 'slide' : appIds.has(id) ? 'app' : 'app');
    const score = Number(s.score);
    if (Number.isFinite(score)) scoresByTier[kind].push(score);
    const failed = (Number.isFinite(score) && score < threshold) || !!s.critical;
    if (failed) failingByTier[kind].push(id);
    if (s.critical) criticalByTier[kind].push(id);
  }

  // Deterministic critical step ids (vision-independent contract failures)
  const deterministicCritical = new Set(
    Array.isArray(qaReport && qaReport.deterministicCriticalStepIds)
      ? qaReport.deterministicCriticalStepIds
      : []
  );
  for (const id of deterministicCritical) {
    const kind = kindMap[id] || (slideIds.has(id) ? 'slide' : 'app');
    if (!failingByTier[kind].includes(id)) failingByTier[kind].push(id);
    if (!criticalByTier[kind].includes(id)) criticalByTier[kind].push(id);
  }

  function tierEntry(kind, { skipped } = {}) {
    const ids = kind === 'slide' ? [...slideIds] : [...appIds];
    if (skipped) {
      return {
        passed: true,
        skipped: true,
        stepCount: 0,
        stepIds: [],
        failingStepIds: [],
        criticalStepIds: [],
        minScore: null,
        avgScore: null,
      };
    }
    const scores = scoresByTier[kind];
    const minScore = scores.length ? Math.min(...scores) : null;
    const avgScore = scores.length
      ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
      : null;
    return {
      passed: failingByTier[kind].length === 0,
      skipped: false,
      stepCount: ids.length,
      stepIds: ids,
      failingStepIds: [...failingByTier[kind]],
      criticalStepIds: [...criticalByTier[kind]],
      minScore,
      avgScore,
    };
  }

  // app-only runs: no slide steps in demo-script and no slide diagnostics
  // → mark slide tier as skipped so the orchestrator never enters slide-fix.
  const slideSkipped = buildMode === 'app-only' || slideIds.size === 0;

  const tierSummary = {
    threshold,
    app: tierEntry('app'),
    slide: tierEntry('slide', { skipped: slideSkipped }),
  };

  // Systemic signals — when present we recommend fullbuild instead of a
  // tier-scoped recovery. This mirrors `analyzeSystemicSignals` but the
  // tier-aware view drops "shared chrome on N steps" when those N are all
  // in a single tier (handled by the lane itself).
  const systemicReasons = collectSystemicReasons(qaReport, stepsArr);
  const recommendedRecovery = resolveRecommendedRecovery({
    buildMode,
    tierSummary,
    systemicReasons,
  });

  return {
    buildMode,
    threshold,
    tierSummary,
    recommendedRecovery,
    systemicReasons,
  };
}

function collectSystemicReasons(qaReport, stepsArr) {
  const reasons = [];
  if (!qaReport) return reasons;
  if (qaReport.deterministicGateEnabled && qaReport.deterministicPassed === false) {
    const blockers = Array.isArray(qaReport.deterministicReasons)
      ? qaReport.deterministicReasons
      : [];
    let patchable;
    try {
      const { getPatchableDeterministicCategories } = require('./qa-patch-library');
      patchable = getPatchableDeterministicCategories();
    } catch (_) {
      patchable = new Set();
    }
    const hasNonPatchableBlocker = blockers.some(
      (c) => !patchable.has(String(c).toLowerCase())
    );
    if (hasNonPatchableBlocker) reasons.push('deterministic_blocker_gate');
  }
  if (typeof qaReport.overrideReason === 'string' && qaReport.overrideReason.trim()) {
    reasons.push('build_qa_guardrail_override');
  }
  // Treat selector / runtime / nav errors on ≥2 steps as systemic — they
  // typically point at the script or the build, not at individual blocks.
  const sysHits = new Set();
  for (const s of stepsArr) {
    if (!s || !Array.isArray(s.categories)) continue;
    for (const c of s.categories) {
      if (SYSTEMIC_CATEGORIES.has(String(c).toLowerCase())) sysHits.add(s.stepId);
    }
  }
  if (sysHits.size >= 2) reasons.push('systemic_multistep_runtime_or_selector');
  return reasons;
}

/**
 * Tier-aware recommended recovery resolver.
 *
 * @returns {'app-touchup' | 'slide-fix' | 'app-touchup+slide-fix' | 'fullbuild' | null}
 */
function resolveRecommendedRecovery({ buildMode, tierSummary, systemicReasons }) {
  const appOk = tierSummary.app.passed;
  const slideOk = tierSummary.slide.passed; // true when skipped
  if (appOk && slideOk) return null;

  if ((systemicReasons || []).length > 0) return 'fullbuild';

  if (buildMode === 'app-only') {
    // Slide tier is skipped on app-only — recovery is always app-touchup
    // (never slide-fix). When app patches+post-panels+agent-touchup cannot
    // fix it, the orchestrator will escalate to fullbuild via the systemic
    // gate at runtime.
    return appOk ? null : 'app-touchup';
  }

  // app+slides
  if (appOk && !slideOk) return 'slide-fix';
  if (!appOk && slideOk) return 'app-touchup';
  if (!appOk && !slideOk) return 'app-touchup+slide-fix';
  return null;
}

module.exports = {
  computeTierSummary,
  resolveBuildMode,
  resolveRecommendedRecovery,
  buildStepKindMap,
  collectSystemicReasons,
  DEFAULT_THRESHOLD,
  SYSTEMIC_CATEGORIES,
};
