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
      'Re-runs post-panels to apply the latest JSON panel patch (v7 as of ' +
      '2026-05-20). Cumulative fixes: renders apiData.response (not the ' +
      '{endpoint,response} wrapper), sizes panel to fit content, versioned ' +
      '__buildApiPanelPatchVersion flag (no more stale build-app shadow), ' +
      'clones the existing toggle node before re-binding to STRIP stale ' +
      'click listeners (v4), vertically centered icon-only chevron whose ' +
      'direction signals the next action — right=collapse, left=expand (v5), ' +
      'panels default to COLLAPSED on every step navigation with JSON ' +
      'pre-rendered for instant expand (v6), auto-injects a "Plaid Link ' +
      'onSuccess (callback)" apiResponse panel on the host step immediately ' +
      'after plaidPhase:"launch" when the step lacks its own apiResponse ' +
      '(v6), and (v7) live-captures the REAL Plaid SDK ' +
      'onSuccess(public_token, metadata) callback args via a runtime ' +
      'window.Plaid.create monkey-patch, so the onSuccess panel shows the ' +
      'actual session payload (with " — live" suffix in the endpoint label) ' +
      'instead of the synthesized sandbox fallback. post-panels also strips ' +
      'the build-app legacy IIFE so only one live patch script remains in ' +
      'the HTML.',
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
    name: 'plaid-link-token-products-prune',
    description:
      'Prunes incompatible CRA + non-CRA Income products from the host app\'s ' +
      '/api/create-link-token request body. Plaid rejects products lists that ' +
      'mix `cra_income_insights` / `cra_base_report` with `income_verification` ' +
      '/ `bank_income` / `payroll_income`: the CRA path mints a Plaid Check ' +
      '`user_id` while the non-CRA Income path needs a legacy `user_token`, ' +
      'and the API enforces a single auth model per token. When the demo-' +
      'script.json clearly intends one path (via `product`, `productFamily`, ' +
      'or `apiResponse.endpoint` signals), this patch keeps that path\'s ' +
      'products and removes the conflicting ones. The fix is a single ' +
      'idempotent string replacement against the `products:[...]` array ' +
      'inside the inline fetch(/api/create-link-token) body. No rebuild ' +
      'needed; once patched the SDK bootstrap call succeeds.',
    matchCategories: [
      'panel-visibility', // historical — still triggers panel re-render
      'plaid-link-token-create',
    ],
    matchIssuePatterns: [
      /user_token is required for (income_verification|bank_income|payroll_income|document_income)/i,
      /\/link\/token\/create.*(failed|rejected|400)/i,
      /cra_income_insights.*(conflict|invalid|reject)|income_verification.*(conflict|invalid|reject)/i,
      /link[\s_-]?token[\s_-]?(create|bootstrap)[^.]*(fail|error|not work)/i,
    ],
    apply: async ({ runDir }) => {
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      const scriptPath = path.join(runDir, 'demo-script.json');
      const configPath = path.join(runDir, 'link-token-create-config.json');
      if (!fs.existsSync(htmlPath)) return { applied: false, summary: 'scratch-app/index.html not found' };
      const html = fs.readFileSync(htmlPath, 'utf8');
      // Find the products: [...] array literal inside the fetch call body.
      const productsMatch = html.match(
        /\bproducts\s*:\s*\[\s*((?:'[^']*'|"[^"]*")(?:\s*,\s*(?:'[^']*'|"[^"]*"))*)\s*\]/
      );
      if (!productsMatch) {
        return { applied: false, summary: 'No products:[...] array literal found in scratch-app HTML' };
      }
      const productsRaw = productsMatch[1];
      const products = productsRaw
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);

      // Plaid /link/token/create enforces several product-mix constraints that
      // the LLM-generated demo-script often violates by listing everything it
      // thinks the demo needs. We handle two layers of constraints here:
      //
      //   Layer 1: CRA + non-CRA Income are mutually exclusive (different auth
      //     models, different user_id formats).
      //   Layer 2: `income_verification` / `bank_income` / `payroll_income` /
      //     `document_income` (the modern non-CRA Income family) can only be
      //     combined with `employment`. Plaid rejects mixes with `identity`,
      //     `auth`, `transactions`, etc. with HTTP 400 "only income_verification
      //     and employment may be configured."
      //
      // Both layers are detectable from the products array alone.
      const CRA_PRODUCTS = new Set(['cra_base_report', 'cra_income_insights']);
      const NON_CRA_INCOME = new Set([
        'income_verification',
        'bank_income',
        'payroll_income',
        'document_income',
      ]);
      const INCOME_VERIFICATION_COMPATIBLE = new Set([
        'income_verification',
        'bank_income',
        'payroll_income',
        'document_income',
        'employment',
      ]);

      const hasCra = products.some((p) => CRA_PRODUCTS.has(p));
      const hasNonCraIncome = products.some((p) => NON_CRA_INCOME.has(p));
      const hasIncomeVerificationIncompatible =
        hasNonCraIncome && products.some((p) => !INCOME_VERIFICATION_COMPATIBLE.has(p) && !CRA_PRODUCTS.has(p));

      if (!hasCra && !hasIncomeVerificationIncompatible) {
        return {
          applied: false,
          summary: `No CRA + non-CRA Income conflict and no income-verification incompatibility (products=[${products.join(', ')}])`,
        };
      }

      // Decide which path to keep based on demo-script intent. Prefer the
      // non-CRA Income path when the script labels the product as Bank Income
      // / Payroll Income / Identity Match (or the script's primary apiResponse
      // endpoint is /credit/bank_income or /identity/match). Prefer CRA when
      // the script's primary endpoint is /cra/check_report/*.
      let keep = 'non-cra'; // default to non-CRA Income when intent is ambiguous
      try {
        if (fs.existsSync(scriptPath)) {
          const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
          const productLabel = String(script.product || '').toLowerCase();
          const endpoints = (script.steps || [])
            .map((s) => String(s.apiResponse && s.apiResponse.endpoint || '').toLowerCase())
            .join(' ');
          const text = productLabel + ' ' + endpoints;
          const craSignals = /\bcra (income insights|base report)\b|\/cra\/check_report\//.test(text);
          const bankIncomeSignals =
            /\bbank income\b|\bpayroll income\b|\/credit\/bank_income\b|\/credit\/payroll_income\b/.test(text);
          if (craSignals && !bankIncomeSignals) keep = 'cra';
          else if (bankIncomeSignals && !craSignals) keep = 'non-cra';
          // If both signals present, prefer the non-CRA Income path — the demo
          // explicitly authored Bank Income endpoints AND CRA labels, which is
          // unusual; the inferred intent is Bank Income (FCRA scope is opt-in
          // and would normally drop bank_income).
        }
      } catch (_) {}

      // Two-pass prune:
      //   Pass 1: drop CRA vs non-CRA Income mismatch.
      //   Pass 2: when keeping non-CRA Income, also drop ANY product not in
      //           INCOME_VERIFICATION_COMPATIBLE (because Plaid will 400).
      let pruned = products.filter((p) => {
        if (keep === 'non-cra') return !CRA_PRODUCTS.has(p);
        return !NON_CRA_INCOME.has(p);
      });
      if (keep === 'non-cra') {
        pruned = pruned.filter((p) => INCOME_VERIFICATION_COMPATIBLE.has(p));
      }

      if (pruned.length === products.length) {
        return { applied: false, summary: 'Nothing to prune' };
      }
      if (pruned.length === 0) {
        return {
          applied: false,
          summary: `Refusing to prune to empty product list (would have left zero products from [${products.join(', ')}])`,
        };
      }
      const before = `products: [${productsRaw}]`;
      const after = `products: ${JSON.stringify(pruned)}`;
      const newHtml = html.replace(productsMatch[0], after);
      if (newHtml === html) {
        return { applied: false, summary: 'Replacement no-op (regex matched but replace did not change the source)' };
      }
      fs.writeFileSync(htmlPath, newHtml, 'utf8');

      // Also prune the persisted link-token-create-config.json so resume /
      // dashboard inspectors agree with the live HTML.
      try {
        if (fs.existsSync(configPath)) {
          const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (Array.isArray(cfg.products)) {
            cfg.products = cfg.products.filter((p) =>
              keep === 'non-cra' ? !CRA_PRODUCTS.has(p) : !NON_CRA_INCOME.has(p)
            );
          }
          if (cfg.suggestedClientRequest && Array.isArray(cfg.suggestedClientRequest.products)) {
            cfg.suggestedClientRequest.products = cfg.suggestedClientRequest.products.filter((p) =>
              keep === 'non-cra' ? !CRA_PRODUCTS.has(p) : !NON_CRA_INCOME.has(p)
            );
          }
          fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
        }
      } catch (_) {}

      return {
        applied: true,
        summary:
          `Pruned conflicting products. before=[${products.join(', ')}] ` +
          `keep=${keep}-path after=[${pruned.join(', ')}]`,
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
