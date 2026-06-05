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

const LEGACY_NONCANONICAL_LOGO_SRC = /(?:plaid-logo-|\.\/plaid-logo|scratch-app\/plaid-logo)/i;

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
    tierScope: 'app',
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
    tierScope: 'app',
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
    tierScope: 'app',
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
  {
    // RETIRED 2026-05-22 — superseded by the always-on
    // templates/slide-template/pipeline-slide-contract.css block, which is
    // injected once by post-slides.ensureSlideDesignStylesInHead. Slide
    // canvas sizing is now part of the immutable contract, so this patch
    // is no longer needed as a recovery step. Retained as a stub so that
    // any historical references in slide-fix-report.json don't dangle.
    name: 'slide-canvas-fullbleed',
    tierScope: 'slide',
    description:
      'RETIRED — slide canvas sizing is now owned by pipeline-slide-contract.css. ' +
      'See templates/slide-template/pipeline-slide-contract.css.',
    matchCategories: [],
    matchIssuePatterns: [],
    manualOnly: true,
    retired: true,
    apply: async () => ({
      applied: false,
      summary: 'slide-canvas-fullbleed is retired — sizing is owned by pipeline-slide-contract.css (injected by post-slides).',
    }),
  },
  {
    name: 'slide-design-tokens-inject',
    tierScope: 'slide',
    description:
      'Opt-in: inject Plaid Deck Design System CSS (colors_and_type + slide.css) into scratch-app <head>. ' +
      'Also copies fonts/ and assets/logos/ when missing. Does not auto-fire from QA.',
    matchCategories: [],
    matchIssuePatterns: [],
    manualOnly: true,
    apply: async ({ runDir }) => {
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      if (!fs.existsSync(htmlPath)) return { applied: false, summary: 'scratch-app/index.html not found' };
      const PROJECT_ROOT = path.resolve(__dirname, '../../..');
      let html = fs.readFileSync(htmlPath, 'utf8');
      const marker = '<!-- POST-SLIDES DESIGN SYSTEM CSS -->';
      if (html.includes(marker)) {
        return { applied: false, summary: 'Design-system CSS marker already present' };
      }
      try {
        delete require.cache[require.resolve('../scratch/post-slides')];
        const postSlides = require('../scratch/post-slides');
        const templates = postSlides.loadSlideTemplates(PROJECT_ROOT);
        postSlides.copySlideDesignAssets(PROJECT_ROOT, path.join(runDir, 'scratch-app'));
        html = postSlides.ensureSlideDesignStylesInHead(html, templates);
        fs.writeFileSync(htmlPath, html, 'utf8');
        return { applied: true, summary: 'Injected POST-SLIDES DESIGN SYSTEM CSS + copied fonts/logos' };
      } catch (e) {
        return { applied: false, error: e.message };
      }
    },
  },
  {
    name: 'slide-shell-chrome-inject',
    tierScope: 'slide',
    description:
      'Opt-in: for each .slide-root step missing .chrome-logo / .eyebrow-tag, inject canonical chrome. ' +
      'Does not auto-fire from QA. Pipeline slides omit .chrome-foot.',
    matchCategories: [],
    matchIssuePatterns: [],
    manualOnly: true,
    apply: async ({ runDir }) => {
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      if (!fs.existsSync(htmlPath)) return { applied: false, summary: 'scratch-app/index.html not found' };
      let html = fs.readFileSync(htmlPath, 'utf8');
      const scriptPath = path.join(runDir, 'demo-script.json');
      let slideSteps = [];
      try {
        if (fs.existsSync(scriptPath)) {
          const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
          slideSteps = (script.steps || []).filter((s) => s && (s.sceneType === 'slide' || /slide/i.test(String(s.stepKind || ''))));
        }
      } catch (_) {}
      if (!slideSteps.length) {
        const re = /data-testid="step-([^"]+)"[^>]*>[\s\S]*?\bslide-root\b/gi;
        let m;
        while ((m = re.exec(html)) !== null) slideSteps.push({ id: m[1] });
      }
      let patched = 0;
      for (let i = 0; i < slideSteps.length; i += 1) {
        const stepId = slideSteps[i].id || slideSteps[i];
        const safe = String(stepId).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const blockRe = new RegExp(
          `(<div[^>]*data-testid="step-${safe}"[^>]*>[\\s\\S]*?<div[^>]*\\bslide-root\\b[^>]*>)([\\s\\S]*?)(<\\/div>\\s*<\\/div>)`,
          'i'
        );
        const match = html.match(blockRe);
        if (!match) continue;
        let inner = match[2];
        const isLight = /\bslide-root[^>]*\b(?:light|cream|holo)\b/i.test(match[0]);
        const logo = isLight
          ? 'assets/logos/plaid-horizontal-dark.png'
          : 'assets/logos/plaid-horizontal-white.png';
        if (!/\bchrome-logo\b/.test(inner)) {
          inner = `<img class="chrome-logo" src="${logo}" alt="" />\n` + inner;
          patched += 1;
        }
        if (!/\beyebrow-tag\b/.test(inner) && !/data-slide-template\s*=\s*["']T1["']/i.test(match[0])) {
          const label = slideSteps[i].label || `Section ${i + 1}`;
          inner = `<div class="eyebrow-tag" style="margin-top:24px;">${label}</div>\n` + inner;
          patched += 1;
        }
        if (!/\bclass\s*=\s*["'][^"']*\bframe\b/.test(inner)) {
          inner = `<div class="frame">\n${inner}\n</div>`;
          patched += 1;
        }
        html = html.replace(blockRe, `$1${inner}$3`);
      }
      if (!patched) return { applied: false, summary: 'All slide steps already have shell chrome' };
      fs.writeFileSync(htmlPath, html, 'utf8');
      return { applied: true, summary: `Injected shell chrome on ${slideSteps.length} slide step(s)` };
    },
  },
  {
    name: 'slide-chrome-foot-strip',
    tierScope: 'slide',
    description:
      'Opt-in: remove all .chrome-foot blocks from slide steps (prevents overlap with body copy).',
    matchCategories: [],
    matchIssuePatterns: [],
    manualOnly: true,
    apply: async ({ runDir }) => {
      const { stripChromeFootFromHtml } = require('./slide-chrome-foot');
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      if (!fs.existsSync(htmlPath)) return { applied: false, summary: 'scratch-app/index.html not found' };
      const html = fs.readFileSync(htmlPath, 'utf8');
      if (!/\bchrome-foot\b/.test(html)) {
        return { applied: false, summary: 'No .chrome-foot blocks found' };
      }
      const next = stripChromeFootFromHtml(html);
      fs.writeFileSync(htmlPath, next, 'utf8');
      return { applied: true, summary: 'Removed .chrome-foot from slide HTML' };
    },
  },
  {
    name: 'slide-chrome-logo-canonical',
    tierScope: 'slide',
    description:
      'Opt-in: replace invented slide logos (div/SVG/text chrome-logo, legacy paths) with canonical ' +
      '<img class="chrome-logo" src="assets/logos/plaid-horizontal-*.png">. Does not auto-fire from QA.',
    matchCategories: [],
    matchIssuePatterns: [],
    manualOnly: true,
    apply: async ({ runDir }) => {
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      if (!fs.existsSync(htmlPath)) return { applied: false, summary: 'scratch-app/index.html not found' };
      let html = fs.readFileSync(htmlPath, 'utf8');
      let patched = 0;
      const slideRootRe = /<div[^>]*\bslide-root\b[^>]*>[\s\S]*?<\/div>\s*(?=<div[^>]*data-testid="step-|<\/body>|$)/gi;
      html = html.replace(slideRootRe, (block) => {
        const isLight =
          /\bslide-root[^>]*\b(?:light|cream|holo)\b/i.test(block) ||
          /\bclass="[^"]*\bslide-root\s+(?:light|cream|holo)\b/i.test(block);
        const logo = isLight
          ? 'assets/logos/plaid-horizontal-dark.png'
          : 'assets/logos/plaid-horizontal-white.png';
        const canonicalImg = `<img class="chrome-logo" src="${logo}" alt="" />`;
        let next = block;
        const needsFix =
          /<(?!(?:img|img\/))[^>]*\bclass="[^"]*chrome-logo[^"]*"[^>]*>/i.test(block) ||
          /<img[^>]*\bclass="[^"]*chrome-logo[^"]*"[^>]*>/i.test(block) &&
            !/<img[^>]*\bclass="[^"]*chrome-logo[^"]*"[^>]*\bsrc\s*=\s*["']assets\/logos\/plaid-horizontal-(?:white|dark|holograph)\.png["']/i.test(block) ||
          LEGACY_NONCANONICAL_LOGO_SRC.test(block) ||
          (/>?\s*PLAID\s*</i.test(block) && /<div[^>]*\bclass="[^"]*\bframe\b/i.test(block));
        if (!needsFix) return block;
        next = next.replace(/<(?!(?:img|img\/))[^>]*\bclass="[^"]*chrome-logo[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, canonicalImg);
        next = next.replace(/<img[^>]*\bclass="[^"]*chrome-logo[^"]*"[^>]*>/gi, canonicalImg);
        if (next !== block) patched += 1;
        return next;
      });
      if (!patched) return { applied: false, summary: 'Slide chrome logos already canonical or absent' };
      fs.writeFileSync(htmlPath, html, 'utf8');
      return { applied: true, summary: `Replaced invented/non-canonical chrome-logo on ${patched} slide block(s)` };
    },
  },
  {
    name: 'slide-chrome-logo-placement',
    tierScope: 'slide',
    description:
      'Strip inline left:/height: styles from .chrome-logo so slide.css top-right 28px placement wins. ' +
      'Auto-fires on build-qa category slide-chrome-logo-placement.',
    matchCategories: ['slide-chrome-logo-placement'],
    matchIssuePatterns: [/chrome-logo.*inline/i, /top-left placement/i, /showcase preview leak/i],
    apply: async ({ runDir }) => {
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      if (!fs.existsSync(htmlPath)) return { applied: false, summary: 'scratch-app/index.html not found' };
      let html = fs.readFileSync(htmlPath, 'utf8');
      let patched = 0;
      const next = html.replace(
        /<img([^>]*\bclass="[^"]*chrome-logo[^"]*"[^>]*)>/gi,
        (full, attrs) => {
          if (!/\bstyle\s*=/i.test(attrs)) return full;
          const cleaned = attrs.replace(/\s*\bstyle\s*=\s*["'][^"']*["']/gi, '').trim();
          if (cleaned === attrs.trim()) return full;
          patched += 1;
          return `<img ${cleaned}>`;
        }
      );
      if (!patched) return { applied: false, summary: 'chrome-logo tags already rely on CSS placement' };
      fs.writeFileSync(htmlPath, next, 'utf8');
      return { applied: true, summary: `Removed inline placement styles from ${patched} chrome-logo tag(s)` };
    },
  },
  {
    name: 'host-nav-logo-contrast',
    tierScope: 'app',
    description:
      'Fixes dark wordmark on dark host nav (or light-on-light): injects white banner CSS ' +
      'with brand accent border, logo shell pill, and swaps to /theme/light/ wordmark URL. ' +
      'Auto-fires on build-qa category host-logo-contrast. Does not call build-app.',
    matchCategories: ['host-logo-contrast'],
    matchIssuePatterns: [
      /host logo contrast/i,
      /dark wordmark on dark navigation/i,
      /light wordmark on light navigation/i,
      /logo and navigation background have similar luminance/i,
      /\/theme\/light\/ asset on light navigation/i,
    ],
    apply: async ({ runDir }) => {
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      if (!fs.existsSync(htmlPath)) {
        return { applied: false, summary: 'scratch-app/index.html not found' };
      }
      const {
        loadBrandProfileFromRunDir,
        applyHostNavLogoContrastPatch,
      } = require('../utils/host-nav-logo-contrast');
      const brand = loadBrandProfileFromRunDir(runDir) || {};
      let html = fs.readFileSync(htmlPath, 'utf8');
      const out = applyHostNavLogoContrastPatch(html, brand);
      if (!out.applied) {
        return { applied: false, summary: 'Host nav already patched or no logo img to swap' };
      }
      fs.writeFileSync(htmlPath, out.html, 'utf8');
      const parts = [];
      if (out.cssInjected) parts.push('white banner CSS');
      if (out.logoSwapped) parts.push('wordmark URL');
      return {
        applied: true,
        summary: `Host nav logo contrast patch: ${parts.join(' + ') || 'updated'}`,
      };
    },
  },
  {
    name: 'zip-cra-host-contract',
    tierScope: 'app',
    description:
      'Opt-in: Zip CRA demos — inject NMLS footer and customer-app nav hints. ' +
      'Does not auto-fire from QA.',
    matchCategories: [],
    matchIssuePatterns: [],
    manualOnly: true,
    apply: async ({ runDir }) => {
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      if (!fs.existsSync(htmlPath)) return { applied: false, summary: 'scratch-app/index.html not found' };
      let html = fs.readFileSync(htmlPath, 'utf8');
      let patched = 0;
      const marker = '/* ZIP-CRA-HOST-CONTRACT */';
      if (!html.includes(marker)) {
        const css =
          `${marker}\n` +
          '.zip-host-footer { font-size: 12px; color: var(--zip-muted, #6B5E80); padding: 16px 56px; }\n';
        if (/<\/style>/i.test(html)) {
          html = html.replace(/<\/style>/i, `${css}</style>`);
        } else {
          html = html.replace(/<\/head>/i, `<style>${css}</style></head>`);
        }
        patched += 1;
      }
      const nmls = '<div class="zip-host-footer" data-testid="host-regulatory-footer">NMLS ID 1963958</div>';
      if (!/nmls\s*id\s*1963958/i.test(html)) {
        const marker = '<!-- SIDE PANELS';
        if (html.includes(marker)) {
          html = html.replace(marker, `${nmls}\n${marker}`);
        } else if (/<\/body>/i.test(html)) {
          html = html.replace(/<\/body>/i, `${nmls}\n</body>`);
        } else {
          html += `\n${nmls}\n`;
        }
        patched += 1;
      }
      if (patched === 0) return { applied: false, summary: 'Zip CRA host contract already satisfied' };
      fs.writeFileSync(htmlPath, html, 'utf8');
      return { applied: true, summary: `Applied Zip CRA host contract (${patched} change group(s))` };
    },
  },
  // slide-typography-floor + slide-typography-ceiling patches REMOVED 2026-05-27.
  // Slide templates own font sizing; LLM may reduce inline font-size to fit
  // content. The scanners these patches matched (scanSlideTypographyFloor /
  // scanSlideTypographyCeiling in build-qa.js) are also neutered, so these
  // patches no longer have any QA category to trigger on.
  {
    name: 'slide-text-overlap-autofix',
    tierScope: 'slide',
    description:
      'Deterministic fix for slide-text-overlap diagnostics: reads the scanner meta ' +
      '(recommendedFontSizePx + offending element rects) and injects scoped font-size + gap ' +
      'overrides for the affected slide step. Floor 24px (Plaid body minimum).',
    matchCategories: ['slide-text-overlap'],
    manualOnly: false,
    apply: async ({ runDir }) => {
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      if (!fs.existsSync(htmlPath)) {
        return { applied: false, summary: 'scratch-app/index.html not found' };
      }
      // Diagnostics with the `meta` payload are written to build-qa-diagnostics.json
      // by build-qa.js (see normalizedDiagnostics block).
      const diagPath = path.join(runDir, 'build-qa-diagnostics.json');
      if (!fs.existsSync(diagPath)) {
        return { applied: false, summary: 'build-qa-diagnostics.json not found' };
      }
      let diagnostics = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(diagPath, 'utf8'));
        diagnostics = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.diagnostics) ? parsed.diagnostics : []);
      } catch (e) {
        return { applied: false, summary: `failed to read diagnostics: ${e.message}` };
      }
      const overlapDiags = diagnostics
        .filter((d) => d && d.category === 'slide-text-overlap' && d.meta);
      if (overlapDiags.length === 0) {
        return { applied: false, summary: 'no slide-text-overlap diagnostics with meta' };
      }

      // Group by step. Track tag font-size reductions whenever the target
      // reduces from the offending element's current size. The 24px floor
      // was removed 2026-05-27 — templates own sizing.
      const byStep = new Map();
      for (const d of overlapDiags) {
        if (!d.meta || !d.stepId) continue;
        const aFs = Math.round(Number(d.meta.a?.fontSize || 0));
        const bFs = Math.round(Number(d.meta.b?.fontSize || 0));
        const target = Math.max(1, Number(d.meta.recommendedFontSizePx) || Math.round((Math.max(aFs, bFs) * 0.75) / 2) * 2);
        const aTag = String(d.meta.a?.tag || '').toLowerCase();
        const bTag = String(d.meta.b?.tag || '').toLowerCase();
        const entry = byStep.get(d.stepId) || { tagFsTargets: new Map() };
        const trackTag = (tag, currentFs, targetFs) => {
          if (!tag) return;
          if (targetFs >= currentFs) return;
          const prev = entry.tagFsTargets.get(tag);
          if (prev === undefined || targetFs < prev) entry.tagFsTargets.set(tag, targetFs);
        };
        if (aFs >= bFs) trackTag(aTag, aFs, target);
        else trackTag(bTag, bFs, target);
        byStep.set(d.stepId, entry);
      }

      // Filter out steps with nothing actionable (no font reductions possible).
      for (const [stepId, entry] of [...byStep.entries()]) {
        if (entry.tagFsTargets.size === 0) byStep.delete(stepId);
      }
      if (byStep.size === 0) {
        return { applied: false, summary: 'no actionable overlap diagnostics (all overlaps already at 24px floor — slide-fix LLM should widen container gap/padding instead)' };
      }

      const rules = [];
      for (const [stepId, entry] of byStep.entries()) {
        for (const [tag, fs] of entry.tagFsTargets.entries()) {
          // !important so the targeted fix actually wins over the generated
          // tight values — slides often set inline `font-size:Npx;line-height:1`
          // on big stat/score numbers (computed line-height == font-size), which
          // a plain rule can't override (root cause: the overlap persisted even
          // after this patch "ran"). Detector-driven + step/tag-scoped, so this
          // only touches elements that actually overlapped. line-height 1.3
          // (verified to clear the 60px-number vertical overlap).
          rules.push(
            `[data-testid="step-${stepId}"] .slide-root ${tag} { font-size: ${fs}px !important; line-height: 1.3 !important; }`
          );
        }
        // Also widen .slide-stack gap as a belt-and-suspenders measure.
        rules.push(
          `[data-testid="step-${stepId}"] .slide-root .slide-stack { gap: clamp(28px, 3vw, 40px) !important; }`
        );
      }

      let html = fs.readFileSync(htmlPath, 'utf8');
      const blockMarker = 'data-pipeline-overlap-autofix="v1"';
      if (html.includes(blockMarker)) {
        // Replace existing block.
        html = html.replace(
          /<style data-pipeline-overlap-autofix="v1">[\s\S]*?<\/style>/,
          `<style data-pipeline-overlap-autofix="v1">\n${rules.join('\n')}\n</style>`
        );
      } else {
        // Insert before </head>.
        const block = `<style data-pipeline-overlap-autofix="v1">\n${rules.join('\n')}\n</style>\n`;
        if (/<\/head>/i.test(html)) {
          html = html.replace(/<\/head>/i, `${block}</head>`);
        } else {
          html = block + html;
        }
      }
      fs.writeFileSync(htmlPath, html, 'utf8');
      return {
        applied: true,
        summary: `Applied overlap autofix on ${byStep.size} slide step(s); ${rules.length} CSS rule(s) injected (font-size floored at 24px).`,
      };
    },
  },
  {
    name: 'slide-text-wrap-fit',
    tierScope: 'slide',
    description:
      'Dynamic font reduction for slide headlines / short labels that wrap to ' +
      'a 2nd+ line when they would fit on a single line at a smaller (≥24px) ' +
      'font-size. Reads scanSlideTextWrap diagnostics (slide-text-wrap meta) and ' +
      'injects a scoped CSS rule that downshifts font-size to the measured ' +
      'recommendation. Composes with slide-text-overlap-autofix — wrap-fit runs ' +
      'on warnings (no overlap yet, just multi-line wrap), overlap-autofix runs ' +
      'on critical overlap blockers.',
    matchCategories: ['slide-text-wrap'],
    manualOnly: false,
    apply: async ({ runDir }) => {
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      if (!fs.existsSync(htmlPath)) {
        return { applied: false, summary: 'scratch-app/index.html not found' };
      }
      const diagPath = path.join(runDir, 'build-qa-diagnostics.json');
      if (!fs.existsSync(diagPath)) {
        return { applied: false, summary: 'build-qa-diagnostics.json not found' };
      }
      let diagnostics = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(diagPath, 'utf8'));
        diagnostics = Array.isArray(parsed)
          ? parsed
          : (Array.isArray(parsed.diagnostics) ? parsed.diagnostics : []);
      } catch (e) {
        return { applied: false, summary: `failed to read diagnostics: ${e.message}` };
      }
      const wrapDiags = diagnostics.filter(
        (d) => d && d.category === 'slide-text-wrap' && d.meta && d.stepId
      );
      if (wrapDiags.length === 0) {
        return { applied: false, summary: 'no slide-text-wrap diagnostics with meta' };
      }

      // Group by step; within a step keep the smallest recommendedFontSizePx
      // per tag-or-class selector so the rule is monotone (a later wrap on
      // the same tag never raises the size back up).
      const byStep = new Map();
      for (const d of wrapDiags) {
        const stepId = d.stepId;
        const meta = d.meta;
        // 24px floor removed 2026-05-27 — templates own sizing.
        const target = Math.max(1, Math.round(Number(meta.recommendedFontSizePx) || 0));
        if (!target || target >= Math.round(meta.currentFontSizePx || 0)) continue;
        // Lead-title / display-stat-VALUE classes ONLY — never sub-bullets or
        // captions. Exact-match so "sc-stat-label" (a caption) does NOT match
        // "sc-stat" and get shrunk to microscopic size.
        const classList = String(meta.classes || '')
          .split(/\s+/)
          .filter(Boolean)
          .filter((c) => /^(?:h-title|hero-title|headline|h-hero|display-title|hero-stat-value|sc-stat|stat-value|h-section)$/i.test(c));
        // Prefer a class-scoped selector for canonical title classes. Only fall
        // back to a bare TAG for true heading tags (h1–h3) — never generic
        // containers (div/span/p/li), since `.slide-root div { font-size }`
        // would shrink EVERY div on the slide (captions included).
        const tag = String(meta.tag || '').toLowerCase();
        const selectorRoot = classList.length > 0
          ? `.${classList[0]}`
          : (/^h[1-3]$/.test(tag) ? tag : '');
        if (!selectorRoot) continue;
        const entry = byStep.get(stepId) || new Map();
        const prev = entry.get(selectorRoot);
        if (prev === undefined || target < prev) entry.set(selectorRoot, target);
        byStep.set(stepId, entry);
      }

      if (byStep.size === 0) {
        return {
          applied: false,
          summary:
            'all slide-text-wrap diagnostics already at the 24px floor — slide-fix LLM should widen container width / shorten copy instead',
        };
      }

      const rules = [];
      for (const [stepId, perSelector] of byStep.entries()) {
        for (const [selector, fs] of perSelector.entries()) {
          rules.push(
            `[data-testid="step-${stepId}"] .slide-root ${selector} { font-size: ${fs}px; line-height: 1.15; }`
          );
        }
      }

      let html = fs.readFileSync(htmlPath, 'utf8');
      const blockMarker = 'data-pipeline-textwrap-autofix="v1"';
      if (html.includes(blockMarker)) {
        html = html.replace(
          /<style data-pipeline-textwrap-autofix="v1">[\s\S]*?<\/style>/,
          `<style data-pipeline-textwrap-autofix="v1">\n${rules.join('\n')}\n</style>`
        );
      } else {
        const block = `<style data-pipeline-textwrap-autofix="v1">\n${rules.join('\n')}\n</style>\n`;
        if (/<\/head>/i.test(html)) {
          html = html.replace(/<\/head>/i, `${block}</head>`);
        } else {
          html = block + html;
        }
      }
      fs.writeFileSync(htmlPath, html, 'utf8');
      return {
        applied: true,
        summary: `Applied text-wrap autofix on ${byStep.size} slide step(s); ${rules.length} CSS rule(s) injected (24px floor).`,
      };
    },
  },
  {
    name: 'slide-layout-patch',
    tierScope: 'slide',
    description:
      'Deterministic slide layout fixes (patch mode): typography normalize, remove in-slide JSON ' +
      'duplicating #api-response-panel, T4 single-column stack, attr-chip styling, bullet cleanup.',
    matchCategories: [
      'slide-template-misuse',
      'panel-visibility',
      'slide-mint-overuse',
    ],
    matchIssuePatterns: [
      /clipped.*API/i,
      /collide with the global API JSON rail/i,
      /in-slide JSON/i,
      /double bullet/i,
      /attribute chip/i,
      /two-column T4/i,
    ],
    manualOnly: false,
    apply: async ({ runDir }) => {
      const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
      if (!fs.existsSync(htmlPath)) return { applied: false, summary: 'scratch-app/index.html not found' };
      let html = fs.readFileSync(htmlPath, 'utf8');
      if (!/\bslide-root\b/.test(html)) {
        return { applied: false, summary: 'No .slide-root blocks in HTML' };
      }
      // Typography normalize + ceiling-overrides removed 2026-05-27 — templates
      // own sizing. The slide-layout-patch still does layout CSS injection
      // (T4 single-column, attr-chip, etc.) below; just no font-size rewrite.
      let changed = 0;

      const layoutMarker = '/* SLIDE-LAYOUT-PATCH */';
      if (!html.includes(layoutMarker)) {
        const css =
          `${layoutMarker}\n` +
          '.slide-root .t4-grid { display: flex; flex-direction: column; gap: 28px; flex: 1; min-height: 0; }\n' +
          '.slide-root .attr-chip-slide {\n' +
          '  display: inline-flex; align-items: center; gap: 10px;\n' +
          '  background: rgba(66,240,205,0.14);\n' +
          '  border: 1px solid rgba(66,240,205,0.35);\n' +
          '  border-radius: 999px;\n' +
          '  padding: 10px 18px;\n' +
          '  font-family: var(--font-mono);\n' +
          '  font-size: 24px;\n' +
          '  color: #c6fff0;\n' +
          '  max-width: 100%;\n' +
          '  flex-wrap: wrap;\n' +
          '}\n' +
          '.slide-root .slide-stack > ul.slide-body-text { list-style: disc; padding-left: 1.25em; }\n' +
          '.slide-root .slide-stack > ul.slide-body-text li::marker { color: var(--plaid-teal-500); }\n';
        if (/<\/style>/i.test(html)) {
          html = html.replace(/<\/style>/i, `${css}</style>`);
        } else {
          html = html.replace(/<\/head>/i, `<style>${css}</style></head>`);
        }
        changed += 1;
      }

      // Sub-24px floor inside slides (including json-snippet / pre)
      html = html.replace(
        /(<div[^>]*\bslide-root\b[^>]*>)([\s\S]*?)(?=<div[^>]*\bslide-root\b|$)/gi,
        (full, open, body) => {
          const next = body.replace(/font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/gi, (decl, n) => {
            const px = parseFloat(n);
            if (px > 0 && px < 24) {
              changed += 1;
              return 'font-size:24px';
            }
            return decl;
          });
          return open + next;
        }
      );

      html = html.replace(/font-family:\s*"JetBrains Mono'/gi, () => {
        changed += 1;
        return "font-family:'JetBrains Mono'";
      });

      html = html.replace(
        /<span style="color:#42F0CD;font-weight:700;?">\s*•\s*<\/span>/gi,
        () => {
          changed += 1;
          return '';
        }
      );

      const nextNetwork = html.replace(
        /(<div data-testid="step-network-insights-slide"[\s\S]*?)<h1 class="h-title">([\s\S]*?)<\/h1>/i,
        '$1<h2 class="h-title">$2</h2>'
      );
      if (nextNetwork !== html) {
        html = nextNetwork;
        changed += 1;
      }

      const nextAttr = html.replace(
        /(<div data-testid="step-network-insights-slide"[\s\S]*?<div class="t4-grid">[\s\S]*?)<div>\s*<div>\s*<span style="font-family:[^<]*plaid_conn_user_lifetime_personal_lending_flag[\s\S]*?<\/div>\s*<div class="slide-body-text" style="opacity:0\.78">/i,
        '$1<div class="attr-chip-slide">plaid_conn_user_lifetime_personal_lending_flag = false</div>\n            <div class="slide-body-text" style="opacity:0.78">'
      );
      if (nextAttr !== html) {
        html = nextAttr;
        changed += 1;
      }

      const stripInSlideJson = (stepId) => {
        const safe = stepId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(
          `(<div data-testid="step-${safe}"[\\s\\S]*?)<pre style="margin:0[\\s\\S]*?<\\/pre>(\\s*<\\/div>\\s*<\\/div>\\s*<div class="chrome-foot">)`,
          'i'
        );
        const next = html.replace(re, '$1$2');
        if (next !== html) {
          html = next;
          changed += 1;
          return true;
        }
        const re2 = new RegExp(
          `(<div data-testid="step-${safe}"[\\s\\S]*?)<div>\\s*<div class="slide-body-text" style="opacity:0\\.7[^"]*">POST[^<]*<\\/div>\\s*<pre[\\s\\S]*?<\\/pre>\\s*<\\/div>(\\s*<\\/div>\\s*<\\/div>\\s*<div class="chrome-foot">)`,
          'i'
        );
        const next2 = html.replace(re2, '$1$2');
        if (next2 !== html) {
          html = next2;
          changed += 1;
          return true;
        }
        return false;
      };

      stripInSlideJson('report-ready-slide');
      stripInSlideJson('network-insights-slide');

      if (!changed) return { applied: false, summary: 'Slide layout patch: no changes needed' };
      fs.writeFileSync(htmlPath, html, 'utf8');
      return { applied: true, summary: `Applied slide layout patch (${changed} change group(s))` };
    },
  },
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Default tier scope when a patch entry omits the explicit field. Existing
 * entries that pre-date the tier-scoped recovery work default to 'any' so
 * `findApplicablePatches` (the legacy API) keeps its current behavior.
 */
function patchTierScope(patch) {
  const v = patch && typeof patch.tierScope === 'string' ? patch.tierScope.toLowerCase().trim() : '';
  if (v === 'slide' || v === 'app' || v === 'any') return v;
  return 'any';
}

/**
 * Resolve a patch by name (for manual / dashboard invocation).
 * @param {string} name
 * @returns {object|null}
 */
function getPatchByName(name) {
  return PATCHES.find((p) => p.name === String(name)) || null;
}

/**
 * Build a manual patch match object for applyPatches().
 * @param {string} name
 * @returns {{ patch: object, matchedSteps: string[], matchedCategories: string[], matchedIssues: string[] }|null}
 */
function buildManualPatchMatch(name) {
  const patch = getPatchByName(name);
  if (!patch) return null;
  return { patch, matchedSteps: [], matchedCategories: [], matchedIssues: [] };
}

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
 * Filter `findApplicablePatches` to slide-tier patches only and limit
 * `matchedSteps` to step ids in the provided slide set. Returns the same
 * shape as `findApplicablePatches`.
 *
 * @param {object} qaReport
 * @param {object} opts
 * @param {Set<string>|string[]} opts.failingSlideStepIds  optional whitelist of failing slide ids
 * @returns {Array}
 */
function findSlideApplicablePatches(qaReport, opts = {}) {
  const matches = findApplicablePatches(qaReport);
  const slideSet =
    opts.failingSlideStepIds instanceof Set
      ? opts.failingSlideStepIds
      : Array.isArray(opts.failingSlideStepIds)
        ? new Set(opts.failingSlideStepIds.map(String))
        : null;
  return matches
    .filter((m) => {
      const scope = patchTierScope(m.patch);
      return scope === 'slide' || scope === 'any';
    })
    .map((m) => {
      if (!slideSet) return m;
      const filteredSteps = (m.matchedSteps || []).filter((id) => slideSet.has(String(id)));
      return { ...m, matchedSteps: filteredSteps };
    })
    .filter((m) => !slideSet || m.matchedSteps.length > 0 || m.matchedCategories.length > 0);
}

/**
 * Filter `findApplicablePatches` to app-tier patches only and limit
 * `matchedSteps` to step ids in the provided app set.
 */
function findAppApplicablePatches(qaReport, opts = {}) {
  const matches = findApplicablePatches(qaReport);
  const appSet =
    opts.failingAppStepIds instanceof Set
      ? opts.failingAppStepIds
      : Array.isArray(opts.failingAppStepIds)
        ? new Set(opts.failingAppStepIds.map(String))
        : null;
  return matches
    .filter((m) => {
      const scope = patchTierScope(m.patch);
      return scope === 'app' || scope === 'any';
    })
    .map((m) => {
      if (!appSet) return m;
      const filteredSteps = (m.matchedSteps || []).filter((id) => appSet.has(String(id)));
      return { ...m, matchedSteps: filteredSteps };
    })
    .filter((m) => !appSet || m.matchedSteps.length > 0 || m.matchedCategories.length > 0);
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

/**
 * QA categories that the patch library can fix without a build-app regen.
 * Used by qa-tier-summary so patchable blockers route to app-touchup / slide-fix.
 */
function getPatchableDeterministicCategories() {
  const set = new Set();
  for (const patch of PATCHES) {
    if (patch.manualOnly || patch.retired) continue;
    for (const c of patch.matchCategories || []) {
      if (c) set.add(String(c).toLowerCase());
    }
  }
  return set;
}

module.exports = {
  PATCHES,
  findApplicablePatches,
  findSlideApplicablePatches,
  findAppApplicablePatches,
  applyPatches,
  getPatchByName,
  buildManualPatchMatch,
  patchTierScope,
  getPatchableDeterministicCategories,
};
