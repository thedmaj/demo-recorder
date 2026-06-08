'use strict';
/**
 * load-env.js — shared dotenv loader for pipeline stage scripts.
 *
 * The orchestrator loads `.env` once at startup and then mutates process.env
 * during runtime (e.g., resolveBuildMode() sets PIPELINE_WITH_SLIDES based on
 * CLI flags / dashboard injection). When a stage script then runs
 * `dotenv.config({ override: true })`, it re-reads .env and *overwrites* the
 * orchestrator's carefully-computed runtime state with stale .env values.
 *
 * This loader does the dotenv refresh (so standalone stage invocations still
 * pick up .env changes) BUT preserves a known list of pipeline-state keys
 * the orchestrator owns. The result: orchestrator-set state always wins
 * over .env in stage scripts; .env still works for unset values.
 *
 * Usage in any stage script (replaces `require('dotenv').config({ override: true })`):
 *
 *     require('../utils/load-env').loadEnv();
 *
 * Standalone callers (e.g., `node scripts/scratch/scratch/generate-script.js`)
 * still get .env injection because the preserve-set is empty in that path.
 */

// Keys the orchestrator owns at runtime. .env values for these must NEVER
// clobber what the orchestrator set, because they encode CLI flags and
// per-run state that the user explicitly chose for this invocation.
const PRESERVED_PIPELINE_KEYS = Object.freeze([
  // Build-mode resolution (the bug that motivated this helper).
  'PIPELINE_WITH_SLIDES',
  'PIPELINE_WITH_SLIDES_SOURCE',
  // Panels axis — same hazard as slides: a stale .env PIPELINE_WITH_PANELS must
  // never clobber the orchestrator's CLI-flag-derived runtime value mid-run.
  'PIPELINE_WITH_PANELS',
  'PIPELINE_WITH_PANELS_SOURCE',
  'BUILD_PHASE_SEQUENCE',
  'BUILD_PHASE_SLIDES_ENABLED',
  'BUILD_PHASE_APP_ENABLED',
  'DEMO_MARKETING_SLIDE',
  'SCRIPT_ZERO_SLIDE',
  // Per-run identity.
  'PIPELINE_RUN_DIR',
  'PIPELINE_RUN_ID',
  'PIPELINE_RUN_MANIFEST',
  'PIPELINE_BUILD_LOG_FILE',
  'PIPELINE_FRESH_CLEANUP',
  'PIPELINE_REUSE_RESEARCH',
  // QA / build behavior the orchestrator sometimes injects from CLI flags.
  'BUILD_QA_DETERMINISTIC_GATE',
  'BUILD_QA_STRICT',
  'BUILD_FIX_MODE',
  'QA_PASS_THRESHOLD',
  'MAX_REFINEMENT_ITERATIONS',
  // Brand/asset behavior occasionally toggled per-run.
  'BRAND_LOGO_CONTRAST_STRICT',
  // Research mode override.
  'RESEARCH_MODE',
  // Plaid Link / recording mode.
  'PLAID_LINK_LIVE',
  'PLAID_LINK_QA_MODE',
  'BUILD_QA_PLAID_MODE',
  'RECORD_MODE',
]);

/**
 * Load .env with override semantics that respect orchestrator-set runtime
 * state. Returns the dotenv result so callers can inspect it if needed.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.extraPreservedKeys] Additional env keys to preserve.
 * @param {boolean} [opts.override] Force override behavior. Default true
 *   (matches the prior `dotenv.config({ override: true })` semantics for
 *   non-preserved keys). Pass false to layer .env under existing env (rare).
 * @returns {{parsed: object|null, error?: Error}}
 */
function loadEnv(opts = {}) {
  const dotenv = require('dotenv');
  const preservedKeys = [
    ...PRESERVED_PIPELINE_KEYS,
    ...(Array.isArray(opts.extraPreservedKeys) ? opts.extraPreservedKeys : []),
  ];
  const override = opts.override !== false;

  // Snapshot orchestrator-owned state BEFORE dotenv may overwrite it.
  const snapshot = {};
  for (const key of preservedKeys) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      snapshot[key] = process.env[key];
    }
  }

  const result = dotenv.config({ override });

  // Restore preserved keys that the orchestrator (or parent process) set
  // explicitly. This guarantees the orchestrator wins any tug-of-war with
  // .env over pipeline-state keys.
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }

  return result;
}

module.exports = {
  loadEnv,
  PRESERVED_PIPELINE_KEYS,
};
