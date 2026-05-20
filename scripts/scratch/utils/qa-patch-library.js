'use strict';
/**
 * qa-patch-library.js
 *
 * Registry of *deterministic* patches that fix common QA findings without
 * invoking the LLM full-rebuild path. Each patch is a small, idempotent
 * function that mutates the existing `scratch-app/index.html` (or related
 * artifacts) in place.
 *
 * The orchestrator consults this library between build-qa iterations:
 *
 *   1. build-qa fails with diagnostic categories like `panel-visibility`
 *      or specific issue text patterns.
 *   2. orchestrator calls `findApplicablePatches(qaReport)` which returns
 *      patches whose `matchCategories` / `matchIssuePatterns` fire.
 *   3. orchestrator calls `applyPatches({ runDir, patches })`.
 *   4. orchestrator re-runs `build-qa` (skipping the LLM rebuild stage) to
 *      see if the patches were sufficient.
 *
 * Patches are tracked in `qa-patch-history.json` so the same patch is not
 * applied twice on the same iteration — preventing infinite loops when a
 * patch fails to address the underlying QA finding.
 */

const fs = require('fs');
const path = require('path');

// ─── Patch entries ──────────────────────────────────────────────────────────
//
// Each patch:
//   - name             unique kebab-case identifier (also used in audit log)
//   - description      short human-readable summary
//   - matchCategories  QA-report `categories` strings that signal this patch
//   - matchIssuePatterns  regex array tested against QA-report `issues` strings
//   - apply({ runDir, runManifest }) → Promise<{ applied, summary, error? }>
//     Idempotent. Returns `applied: false` when there's nothing to do.

const PATCHES = [
  {
    name: 'api-panel-toggle-latest',
    description:
      'Re-runs post-panels to apply the latest JSON panel patch (v6 as of ' +
      '2026-05-20). Cumulative fixes since v1: renders apiData.response (not ' +
      'the {endpoint,response} wrapper), sizes the panel to fit content, ' +
      'uses a versioned __buildApiPanelPatchVersion flag so stale build-app ' +
      'IIFEs no longer short-circuit the new patch, clones the existing ' +
      'toggle node before re-binding to STRIP stale click listeners ' +
      '(v4 — fixes the double-toggle no-op bug), renders a vertically ' +
      'centered icon-only chevron whose direction signals the next action ' +
      '(v5 — right when open, left when collapsed), and (v6) defaults the ' +
      'panel to COLLAPSED on every step navigation while pre-rendering the ' +
      'JSON content so expanding is instant. v6 also auto-injects a ' +
      '"Plaid Link onSuccess (callback)" apiResponse panel on the host step ' +
      'immediately after a plaidPhase:"launch" step when that step lacks an ' +
      'apiResponse of its own. post-panels also strips the build-app legacy ' +
      'IIFE so only one live patch script remains in the HTML.',
    matchCategories: ['panel-visibility', 'missing-panel'],
    matchIssuePatterns: [
      /api[^a-z]?(json[^a-z]?)?panel[^.]*?(clipped|cut[\s-]?off|truncated|hidden|partially obscured)/i,
      /json[^a-z]?panel[^.]*?(clipped|cut[\s-]?off|truncated)/i,
      /(expand|collapse|toggle)[^.]*?(broken|wrong|not work|missing|render|visible|invisible)/i,
      /panel[^a-z]?toggle[^.]*?(missing|wrong|broken|not (rendered|render|visible))/i,
      /toggle\s+button[^.]*?(not (visible|render)|missing|invisible)/i,
    ],
    apply: async ({ runDir }) => {
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      if (!fs.existsSync(htmlPath)) return { applied: false, summary: 'scratch-app/index.html not found' };
      const before = fs.readFileSync(htmlPath, 'utf8');
      try {
        // post-panels reads PIPELINE_RUN_DIR from env; set it for the call.
        const priorRunDir = process.env.PIPELINE_RUN_DIR;
        process.env.PIPELINE_RUN_DIR = runDir;
        try {
          delete require.cache[require.resolve('../scratch/post-panels')];
          const mod = require('../scratch/post-panels');
          if (typeof mod.main !== 'function') return { applied: false, summary: 'post-panels.main missing' };
          await mod.main();
        } finally {
          if (priorRunDir == null) delete process.env.PIPELINE_RUN_DIR;
          else process.env.PIPELINE_RUN_DIR = priorRunDir;
        }
      } catch (e) {
        return { applied: false, error: e.message };
      }
      const after = fs.readFileSync(htmlPath, 'utf8');
      const currentVersionMatch = after.match(/data-post-panels-patch="(v[0-9]+)"/);
      const currentVersion = currentVersionMatch ? currentVersionMatch[1] : null;
      const changed = before !== after;
      return {
        applied: changed && !!currentVersion,
        summary: changed
          ? `Re-ran post-panels; HTML updated, current patch version: ${currentVersion || 'none'}`
          : currentVersion
            ? `Re-ran post-panels; HTML already at ${currentVersion} — no changes needed`
            : 'Re-ran post-panels; no patch script detected (may be app-only or missing apiResponse)',
      };
    },
  },
  {
    name: 'plaid-launch-cta-icon-ratio',
    description:
      'Re-injects the Plaid Link launch CTA layout stylesheet to enforce the ' +
      'modest inline-icon sizing contract (icon ≤40% of button height).',
    matchCategories: ['plaid-launch-cta-icon'],
    matchIssuePatterns: [
      /icon[^.]*disproportionately large/i,
      /icon[^.]*ratio[^.]*max allowed/i,
      /stock[-\s]?link[-\s]?icon[^.]*(too large|oversized)/i,
    ],
    apply: async ({ runDir }) => {
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      if (!fs.existsSync(htmlPath)) return { applied: false, summary: 'scratch-app/index.html not found' };
      const buildAppPath = path.resolve(__dirname, '../scratch/build-app.js');
      const buildAppSrc = fs.readFileSync(buildAppPath, 'utf8');
      // Extract the canonical launch-CTA style block from build-app's helper.
      const styleMatch = buildAppSrc.match(
        /function injectPlaidLaunchCtaLayoutStyles[\s\S]*?const STYLE_TAG\s*=\s*`([\s\S]*?)`;[\s\S]*?const MARKER\s*=\s*'([^']+)';/
      );
      if (!styleMatch) return { applied: false, summary: 'Could not locate injectPlaidLaunchCtaLayoutStyles in build-app.js' };
      const styleTag = styleMatch[1];
      const marker = styleMatch[2];
      const before = fs.readFileSync(htmlPath, 'utf8');
      if (before.includes(marker)) {
        return { applied: false, summary: 'Launch CTA layout style already present (marker found)' };
      }
      if (!before.includes('</head>')) {
        return { applied: false, summary: 'No </head> tag — cannot inject style' };
      }
      const after = before.replace('</head>', `${styleTag}\n</head>`);
      fs.writeFileSync(htmlPath, after, 'utf8');
      return {
        applied: true,
        summary: `Injected Plaid launch-CTA layout styles (marker=${marker})`,
      };
    },
  },
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Inspect a qa-report-build.json (or post-record qa-report-N.json) and return
 * the patches whose match criteria fire on at least one step's diagnostic.
 *
 * The match check is OR across categories and issue patterns. A patch matches
 * if any step's categories overlap with `matchCategories` OR any step's issue
 * text matches one of `matchIssuePatterns`.
 *
 * @param {object} qaReport The QA report object (with `steps[]` array)
 * @returns {Array<{ patch: object, matchedSteps: string[], matchedCategories: string[], matchedIssues: string[] }>}
 */
function findApplicablePatches(qaReport) {
  const out = [];
  if (!qaReport || !Array.isArray(qaReport.steps)) return out;
  for (const patch of PATCHES) {
    const catSet = new Set((patch.matchCategories || []).map((s) => String(s).toLowerCase()));
    const patterns = patch.matchIssuePatterns || [];
    const matchedSteps = new Set();
    const matchedCategories = new Set();
    const matchedIssues = new Set();
    for (const step of qaReport.steps) {
      const categories = Array.isArray(step.categories) ? step.categories : [];
      const issues = Array.isArray(step.issues) ? step.issues : [];
      let hit = false;
      for (const c of categories) {
        if (catSet.has(String(c).toLowerCase())) {
          matchedCategories.add(c);
          hit = true;
        }
      }
      for (const issue of issues) {
        const issueText = String(issue || '');
        for (const re of patterns) {
          try {
            if (re.test(issueText)) {
              matchedIssues.add(issueText);
              hit = true;
              break;
            }
          } catch (_) {}
        }
      }
      if (hit && step.stepId) matchedSteps.add(step.stepId);
    }
    if (matchedSteps.size > 0 || matchedCategories.size > 0 || matchedIssues.size > 0) {
      out.push({
        patch,
        matchedSteps: [...matchedSteps],
        matchedCategories: [...matchedCategories],
        matchedIssues: [...matchedIssues],
      });
    }
  }
  return out;
}

/**
 * Apply a list of patches in sequence. Each patch's `apply()` is awaited.
 * History is appended to `qa-patch-history.json` in the runDir.
 *
 * @param {object} opts
 * @param {string} opts.runDir
 * @param {Array<object>} opts.matches  output of `findApplicablePatches`
 * @param {string} [opts.iteration]      orchestrator iteration tag for audit
 * @returns {Promise<{ applied: number, results: Array }>}
 */
async function applyPatches({ runDir, matches, iteration }) {
  const results = [];
  for (const m of matches || []) {
    const t0 = Date.now();
    let outcome;
    try {
      outcome = await m.patch.apply({ runDir });
    } catch (e) {
      outcome = { applied: false, error: String(e && e.message || e) };
    }
    results.push({
      name: m.patch.name,
      description: m.patch.description,
      matchedSteps: m.matchedSteps,
      matchedCategories: m.matchedCategories,
      durationMs: Date.now() - t0,
      ...outcome,
    });
  }
  // Persist history
  try {
    const historyPath = path.join(runDir, 'qa-patch-history.json');
    const prior = fs.existsSync(historyPath)
      ? JSON.parse(fs.readFileSync(historyPath, 'utf8'))
      : { entries: [] };
    prior.entries.push({
      at: new Date().toISOString(),
      iteration: iteration || null,
      results,
    });
    fs.writeFileSync(historyPath, JSON.stringify(prior, null, 2), 'utf8');
  } catch (_) {
    // history is best-effort; don't fail the patch run if write fails
  }
  return {
    applied: results.filter((r) => r.applied).length,
    results,
  };
}

module.exports = {
  PATCHES,
  findApplicablePatches,
  applyPatches,
};
