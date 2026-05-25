'use strict';

/**
 * Slide-tier build-QA loop budget (slide-fix lane + slides-scoped build-qa).
 * Pipeline stops after max iterations OR when slide tier passes — whichever first.
 */

const SLIDE_QA_MAX_ITERATIONS_DEFAULT = 3;

/**
 * @param {number|null|undefined} override explicit cap from caller (e.g. CLI --max-iters)
 * @returns {number} positive integer iteration ceiling
 */
function resolveSlideQaMaxIterations(override) {
  if (Number.isFinite(Number(override)) && Number(override) > 0) {
    return Math.floor(Number(override));
  }
  const raw =
    process.env.SLIDE_QA_MAX_ITERATIONS ||
    process.env.SLIDE_FIX_MAX_ITERATIONS ||
    String(SLIDE_QA_MAX_ITERATIONS_DEFAULT);
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : SLIDE_QA_MAX_ITERATIONS_DEFAULT;
}

module.exports = {
  SLIDE_QA_MAX_ITERATIONS_DEFAULT,
  resolveSlideQaMaxIterations,
};
