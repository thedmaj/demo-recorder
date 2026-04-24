'use strict';
/**
 * Unified step classification for the pipeline.
 *
 * Single source of truth for "is this step a slide or a host/app/insight screen?".
 * Replaces scattered heuristics (`sceneType`, `visualState`, `slideLibraryRef`,
 * `isSlideLikeStep`) with a persistable `stepKind` field on each `demo-script.json`
 * step.
 *
 *   stepKind: 'slide' | 'app'
 *
 *   - 'slide'  → Plaid-branded narrative slide rendered via `.slide-root`
 *                (value-summary, transition explainers, insight framing slides).
 *   - 'app'    → Any other step: host product UI, Plaid Link launches, insight
 *                screens that overlay API JSON panels on the host app, etc.
 *
 * Downstream consumers:
 *   - `post-slides` stage only touches steps where stepKind === 'slide'.
 *   - `post-panels` stage only hydrates JSON for `stepKind === 'app'` steps
 *     whose `apiResponse` is present (insight app screens).
 *   - Dashboard badges use it to detect runs where slides were added after an
 *     originally `app-only` build.
 */

/**
 * @param {object} step A demo-script step object.
 * @returns {'slide' | 'app'}
 *
 * Plaid-branded interstitials — BOTH narrative slides (`sceneType: 'slide'`)
 * and API-insight screens (`sceneType: 'insight'`, which render `.slide-root`
 * dark-navy Plaid chrome with a JSON rail) — classify as `stepKind: 'slide'`.
 * They share the same build contract (slide template trio, api-response-panel
 * hydration) and the same audience expectation: "this is a Plaid-branded
 * full-viewport screen, not part of the host product UI". App-only builds
 * must therefore strip BOTH varieties.
 */
function deriveStepKind(step) {
  if (!step || typeof step !== 'object') return 'app';

  const rawKind = typeof step.stepKind === 'string' ? step.stepKind.toLowerCase().trim() : '';
  if (rawKind === 'slide' || rawKind === 'app') return rawKind;

  const sceneType = String(step.sceneType || '').toLowerCase().trim();
  if (sceneType === 'slide' || sceneType === 'insight') return 'slide';
  if (sceneType === 'host' || sceneType === 'link') return 'app';

  if (step.slideLibraryRef && typeof step.slideLibraryRef === 'object') {
    return 'slide';
  }

  const haystack = [step.id, step.label, step.visualState]
    .filter(Boolean)
    .map(String)
    .join(' ')
    .toLowerCase();

  if (/\binsight\b/.test(haystack)) return 'slide';
  if (/\bslide\b/.test(haystack)) return 'slide';
  if (/\.slide-root\b/.test(haystack)) return 'slide';

  return 'app';
}

/**
 * Mutates the provided demoScript in-place, stamping `stepKind` on every step.
 * Safe to call more than once (idempotent): existing valid values are preserved.
 *
 * @param {object} demoScript Parsed `demo-script.json`.
 * @returns {{ script: object, counts: { slide: number, app: number }, mutated: number }}
 */
function annotateScriptWithStepKinds(demoScript) {
  const counts = { slide: 0, app: 0 };
  let mutated = 0;
  if (!demoScript || !Array.isArray(demoScript.steps)) {
    return { script: demoScript, counts, mutated };
  }

  for (const step of demoScript.steps) {
    if (!step || typeof step !== 'object') continue;
    const previous = typeof step.stepKind === 'string' ? step.stepKind.toLowerCase() : null;
    const kind = deriveStepKind(step);
    if (previous !== kind) {
      step.stepKind = kind;
      mutated += 1;
    }
    counts[kind] = (counts[kind] || 0) + 1;
  }

  return { script: demoScript, counts, mutated };
}

/**
 * Returns true when a step should be considered a slide for QA/insertion purposes.
 * Shortcut wrapper around `deriveStepKind` for callers that only care about the
 * slide/not-slide distinction.
 */
function isSlideStep(step) {
  return deriveStepKind(step) === 'slide';
}

/**
 * Returns the list of step IDs with `stepKind === 'slide'` according to either
 * the persisted field or the derived classification.
 */
function getSlideStepIds(demoScript) {
  if (!demoScript || !Array.isArray(demoScript.steps)) return [];
  return demoScript.steps
    .filter((s) => isSlideStep(s))
    .map((s) => s && s.id)
    .filter(Boolean);
}

/**
 * Returns the list of step IDs with `stepKind === 'app'`.
 */
function getAppStepIds(demoScript) {
  if (!demoScript || !Array.isArray(demoScript.steps)) return [];
  return demoScript.steps
    .filter((s) => !isSlideStep(s))
    .map((s) => s && s.id)
    .filter(Boolean);
}

module.exports = {
  deriveStepKind,
  annotateScriptWithStepKinds,
  isSlideStep,
  getSlideStepIds,
  getAppStepIds,
};
