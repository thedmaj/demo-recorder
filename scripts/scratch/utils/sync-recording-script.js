'use strict';
/**
 * sync-recording-script.js
 *
 * Keep `scratch-app/playwright-script.json` (the recorder's navigation script)
 * in sync with `demo-script.json`'s `steps[]`.
 *
 * WHY THIS EXISTS — the recorder reads playwright-script.json, NOT
 * demo-script.json. That nav script is generated ONCE by build-app. Any step
 * added AFTER build — via the dashboard storyboard (insert-step /
 * insert-library-slide), an agent editing demo-script.json + post-slides, or a
 * hand edit — is otherwise invisible to record-local.js: it iterates the OLD
 * row set, records the old steps, and the new slide never appears in the video.
 * Observed 2026-06-17: a setup slide inserted at index 0 of the Credit Genie
 * demo was dropped because playwright-script.json still held the pre-insert 9
 * rows ("Loaded playwright-script.json: 9 steps"); the recording opened on the
 * Plaid Layer step, not the new slide.
 *
 * reconcileRecordingScript() rebuilds steps[] in demo-script.json order so the
 * recording order always matches the storyboard order:
 *   • every demo step gets exactly one row;
 *   • existing rows are preserved VERBATIM (waitMs / author overrides / Plaid
 *     120 s safety budgets survive);
 *   • a missing step gets a fresh row — `goToStep` for slide/host steps,
 *     `click` for plaidPhase:"launch" steps (mirrors build-app's launch row);
 *   • id'd rows with no matching demo step are pruned (orphans from a hand
 *     delete); rows with no id (non-step automation) are preserved;
 *   • when anything changed, `dwellPlanAt` is cleared so the next
 *     set-recording-dwells pass re-sizes dwells from narration.
 *
 * Idempotent: an unchanged demo yields byte-identical output (no-op).
 */

const fs = require('fs');
const path = require('path');

/** Default dwell for a freshly-added step before set-recording-dwells sizes it. */
const DEFAULT_STEP_WAIT_MS = 9000;
/** Plaid Link/Layer/IDV launch safety budget (set-recording-dwells preserves it). */
const LAUNCH_WAIT_MS = 120000;

function recordingScriptPaths(runDir) {
  return [
    path.join(runDir, 'scratch-app', 'playwright-script.json'),
    path.join(runDir, 'playwright-script.json'),
  ].filter((p) => fs.existsSync(p));
}

function isLaunchStep(step) {
  return String((step && step.plaidPhase) || '').toLowerCase() === 'launch';
}

/**
 * Canonical launch-button selector for a freshly-added launch step. Prefer the
 * selector build-app already resolved on an existing launch row; otherwise pick
 * by product (mirrors build-app + record-local launch CTA selectors).
 */
function launchSelectorFor(step, fallbackFromExisting) {
  if (fallbackFromExisting) return fallbackFromExisting;
  const hay = `${(step && step.id) || ''} ${(step && step.label) || ''} ${(step && step.launchProduct) || ''}`.toLowerCase();
  if (/\blayer\b/.test(hay)) return '[data-testid="link-external-account-btn"]';
  if (/\bidv\b|identity[-_ ]?verification/.test(hay)) return '[data-testid="idv-launch-btn"]';
  return '[data-testid="link-launch-btn"]'; // classic Plaid Link default
}

/** Build a recording-script row for a demo step that has none yet. */
function makeRecordingRowForStep(step, opts = {}) {
  const id = step.id;
  if (isLaunchStep(step)) {
    return { id, action: 'click', target: launchSelectorFor(step, opts.launchSelector), waitMs: LAUNCH_WAIT_MS };
  }
  return { id, action: 'goToStep', target: id, waitMs: DEFAULT_STEP_WAIT_MS };
}

function rowId(r) {
  return String((r && (r.id || r.stepId)) || '');
}

/**
 * Reconcile playwright-script.json with demo-script.json.
 * @param {string} runDir            run directory (contains demo-script.json + scratch-app/)
 * @param {object} [opts]
 * @param {boolean} [opts.prune=true] drop id'd orphan rows (steps removed from demo-script)
 * @returns {{changed:boolean, added:string[], pruned:string[], reordered:boolean, files:string[]}}
 */
function reconcileRecordingScript(runDir, { prune = true } = {}) {
  const result = { changed: false, added: [], pruned: [], reordered: false, files: [] };
  const demoPath = path.join(runDir, 'demo-script.json');
  let demo;
  try { demo = JSON.parse(fs.readFileSync(demoPath, 'utf8')); } catch (_) { return result; }
  const steps = Array.isArray(demo.steps) ? demo.steps : [];
  if (!steps.length) return result;

  const psPaths = recordingScriptPaths(runDir);
  if (!psPaths.length) return result; // pre-build — nothing to sync yet

  for (const p of psPaths) {
    let ps;
    try { ps = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { continue; }
    if (!ps || !Array.isArray(ps.steps)) continue;

    const rowById = new Map();
    for (const r of ps.steps) { const id = rowId(r); if (id) rowById.set(id, r); }
    // Reuse a resolved launch selector if build-app already produced one.
    const existingLaunchSelector =
      (ps.steps.find((r) => r && r.action === 'click'
        && /link[-_]external|launch|link[-_]account|connect[-_]bank|open[-_]link/i.test(String(r.target || ''))) || {}).target || null;

    const beforeOrder = ps.steps.map(rowId).join(',');
    const knownIds = new Set();
    const newRows = [];
    const added = [];
    for (const st of steps) {
      const id = st && st.id;
      if (!id) continue;
      knownIds.add(id);
      let row = rowById.get(id);
      if (!row) {
        row = makeRecordingRowForStep(st, { launchSelector: isLaunchStep(st) ? existingLaunchSelector : null });
        added.push(id);
      }
      newRows.push(row);
    }

    // Handle rows that weren't consumed by any demo step.
    const pruned = [];
    for (const r of ps.steps) {
      const id = rowId(r);
      if (!id) { newRows.push(r); continue; }     // non-step automation row → always keep
      if (knownIds.has(id)) continue;             // consumed above
      if (prune) pruned.push(id);                 // id'd orphan → drop
      else newRows.push(r);                       // keep orphan at tail
    }

    const afterOrder = newRows.map(rowId).join(',');
    const reordered = beforeOrder !== afterOrder && !added.length && !pruned.length;

    if (added.length || pruned.length || beforeOrder !== afterOrder) {
      ps.steps = newRows;
      delete ps.dwellPlanAt; // force set-recording-dwells to re-size from narration
      try {
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(ps, null, 2), 'utf8');
        fs.renameSync(tmp, p);
        result.files.push(p);
        result.changed = true;
        for (const a of added) if (!result.added.includes(a)) result.added.push(a);
        for (const x of pruned) if (!result.pruned.includes(x)) result.pruned.push(x);
        if (reordered || added.length || pruned.length) result.reordered = result.reordered || reordered;
      } catch (_) { /* best-effort per file */ }
    }
  }
  return result;
}

module.exports = {
  reconcileRecordingScript,
  makeRecordingRowForStep,
  recordingScriptPaths,
  isLaunchStep,
};
