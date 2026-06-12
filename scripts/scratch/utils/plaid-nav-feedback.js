'use strict';
/**
 * plaid-nav-feedback.js
 *
 * Continuous-learning loop for the Plaid nav profiles: after a recording,
 * merge what the run actually observed back into the matching profile in
 * inputs/plaid-nav-profiles/ and append a compact line to
 * inputs/plaid-link-nav-learnings.md.
 *
 * Sources (all per run dir, all optional):
 *   - plaid-link-timing.json        checkpoint timestamps → inter-checkpoint gaps
 *   - plaid-pacing-manifest.json    human-style dwell ledger (style, perScreen)
 *   - plaid-recipe-telemetry.json   recipe executor per-screen arrivalMs + selector outcomes
 *
 * Called from record-local.js at the end of a recording (best-effort, never
 * throws) and runnable standalone:
 *   node scripts/scratch/utils/plaid-nav-feedback.js <runDir> [experience]
 */

const fs = require('fs');
const path = require('path');
const navProfile = require('./plaid-nav-profile');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const LEARNINGS_FILE = path.join(PROJECT_ROOT, 'inputs', 'plaid-link-nav-learnings.md');

// Checkpoint pair → the profile screen whose transition the gap approximates.
const CHECKPOINT_SCREEN_MAP = [
  { from: 'phone-submitted', to: 'otp-screen', screen: 'otp-screen' },
  { from: 'otp-filled', to: 'institution-list-shown', screen: 'saved-institution-list' },
  { from: 'confirm-clicked', to: 'link-complete', screen: 'success' },
];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

/**
 * @param {object} opts
 * @param {string} opts.runDir
 * @param {object} [opts.profile]     already-resolved profile (record-local passes its own)
 * @param {string} [opts.experience]  profile name when no profile object given
 * @param {boolean} [opts.completed]  whether the Link flow completed (default true)
 * @returns {object|null} summary of what was merged
 */
function recordNavFeedback({ runDir, profile, experience, completed = true } = {}) {
  try {
    if (!runDir) return null;
    let prof = profile ||
      (experience ? navProfile.loadProfileByName(experience) : null);
    if (!prof) {
      // Infer from demo-script like the recorder does
      const script = readJson(path.join(runDir, 'demo-script.json'));
      if (!script) return null;
      const launch = (script.steps || []).find((s) => s.plaidPhase === 'launch');
      prof = navProfile.resolveProfile({
        product: launch?.launchProduct,
        embedded: String(script.plaidLinkMode || '').toLowerCase() === 'embedded',
        flowType: /cra/i.test(String(script.plaidSandboxConfig?.plaidLinkFlow || '')) ? 'cra' : 'link',
      });
      if (!prof) return null;
    }

    const timingArr = readJson(path.join(runDir, 'plaid-link-timing.json')) || [];
    const T = {};
    for (const t of timingArr) T[t.step] = t.recordingOffsetS;
    const telemetry = readJson(path.join(runDir, 'plaid-recipe-telemetry.json'));
    const manifest = readJson(path.join(runDir, 'plaid-pacing-manifest.json'));

    let merged = 0;
    // 1. Checkpoint gaps → screen transition samples
    for (const m of CHECKPOINT_SCREEN_MAP) {
      if (T[m.from] != null && T[m.to] != null && T[m.to] > T[m.from]) {
        let gapMs = Math.round((T[m.to] - T[m.from]) * 1000);
        // Subtract our own added dwell so sandbox latency is what gets learned
        const added = manifest?.perScreen?.[m.screen]?.addedMs || 0;
        gapMs = Math.max(0, gapMs - added);
        if (gapMs > 0 && gapMs < 60000 &&
            navProfile.mergeObservation(prof, m.screen, [gapMs])) merged++;
      }
    }
    // 2. Recipe telemetry arrivals + selector outcomes
    for (const s of telemetry?.perScreen || []) {
      if (Number.isFinite(s.arrivalMs) && s.arrivalMs > 0 &&
          navProfile.mergeObservation(prof, s.id, [s.arrivalMs])) merged++;
      if (s.status === 'arrival-timeout' || s.status === 'transition-timeout') {
        prof.lastBrokenAt = new Date().toISOString();
      }
    }

    if (completed) {
      prof.verifiedRuns = (prof.verifiedRuns || 0) + 1;
      prof.lastVerifiedAt = new Date().toISOString();
    } else {
      prof.lastBrokenAt = new Date().toISOString();
    }
    navProfile.saveProfile(prof);

    // Compact learnings line
    const date = new Date().toISOString().slice(0, 10);
    const line = `- ${date} [nav-feedback] ${prof.experience} ` +
      `run=${path.basename(runDir)} completed=${completed} ` +
      `style=${manifest?.style || 'fast'} screensMerged=${merged}` +
      (manifest ? ` humanDwell=+${Math.round((manifest.totalAddedMs || 0) / 1000)}s` : '');
    fs.appendFileSync(LEARNINGS_FILE, line + '\n', 'utf8');

    console.log(`[nav-feedback] merged ${merged} observation(s) into ${prof.experience} profile`);
    return { experience: prof.experience, merged, completed };
  } catch (err) {
    console.warn(`[nav-feedback] non-fatal: ${err.message}`);
    return null;
  }
}

module.exports = { recordNavFeedback };

if (require.main === module) {
  const [runDir, experience] = process.argv.slice(2);
  if (!runDir) {
    console.error('Usage: node plaid-nav-feedback.js <runDir> [experience]');
    process.exit(64);
  }
  const r = recordNavFeedback({ runDir: path.resolve(runDir), experience });
  process.exit(r ? 0 : 1);
}
