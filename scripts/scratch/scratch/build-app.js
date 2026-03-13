'use strict';
/**
 * build-app.js
 * Two Claude calls: architecture brief, then full HTML app generation
 * with streaming.
 *
 * Reads:  out/demo-script.json
 *         out/qa-report-{N}.json   (optional, passed via --qa=path)
 * Writes: scratch-app/index.html
 *         scratch-app/playwright-script.json
 *
 * Usage:
 *   node scripts/scratch/scratch/build-app.js
 *   node scripts/scratch/scratch/build-app.js --qa=out/qa-report-1.json
 *
 * Environment:
 *   ANTHROPIC_API_KEY   — required
 */

require('dotenv').config({ override: true });
const Anthropic  = require('@anthropic-ai/sdk');
const fs         = require('fs');
const path       = require('path');

const {
  buildAppArchitectureBriefPrompt,
  buildAppGenerationPrompt,
} = require('../utils/prompt-templates');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT    = path.resolve(__dirname, '../../..');
const OUT_DIR         = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const INPUTS_DIR      = path.join(PROJECT_ROOT, 'inputs');
const SCRIPT_FILE     = path.join(OUT_DIR, 'demo-script.json');
const SCRATCH_APP_DIR = path.join(OUT_DIR, 'scratch-app');
const HTML_OUT        = path.join(SCRATCH_APP_DIR, 'index.html');
const PLAYWRIGHT_OUT  = path.join(SCRATCH_APP_DIR, 'playwright-script.json');
const FEEDBACK_FILE   = path.join(INPUTS_DIR, 'build-feedback.md');

// Delimiter that separates HTML from Playwright JSON in Claude's response
const PLAYWRIGHT_MARKER = '<!-- PLAYWRIGHT_SCRIPT_JSON -->';

// ── Model config ──────────────────────────────────────────────────────────────

const ARCH_MODEL         = 'claude-sonnet-4-6';
const ARCH_MAX_TOKENS    = 1024;
const BUILD_MODEL        = 'claude-opus-4-6';
const BUILD_BUDGET_TOKENS = 12000;
const BUILD_MAX_TOKENS   = 32000;

// ── Live Plaid Link flag ──────────────────────────────────────────────────────
const PLAID_LINK_LIVE = process.env.PLAID_LINK_LIVE === 'true';

// ── Plaid Link capture screenshots ───────────────────────────────────────────
const PLAID_LINK_SCREENS_DIR = path.join(OUT_DIR, 'plaid-link-screens');

// ── Design plugin (assetlib) ──────────────────────────────────────────────────
const ASSETLIB_DIR     = path.join(PROJECT_ROOT, 'assetlib');
const ASSETLIB_HTML    = path.join(ASSETLIB_DIR, 'index.html');
const ASSETLIB_CSS     = path.join(ASSETLIB_DIR, 'plaid-link.css');

function loadDesignPlugin() {
  if (!fs.existsSync(ASSETLIB_HTML)) {
    console.log('[Build] Design plugin: assetlib/index.html not found — skipping');
    return { html: null, css: null };
  }
  const html = fs.readFileSync(ASSETLIB_HTML, 'utf8');
  const css  = fs.existsSync(ASSETLIB_CSS) ? fs.readFileSync(ASSETLIB_CSS, 'utf8') : '';
  console.log(`[Build] Design plugin loaded: assetlib/index.html (${Math.round(html.length / 1024)}KB), plaid-link.css (${Math.round(css.length / 1024)}KB)`);
  return { html, css };
}

// ── Brand profile loading ─────────────────────────────────────────────────────
const BRAND_DIR = path.join(PROJECT_ROOT, 'brand');

/**
 * Resolves and loads a brand profile JSON.
 *
 * Resolution order:
 *   1. --brand=<slug> CLI argument
 *   2. BRAND_PROFILE environment variable
 *   3. Auto-detect from demoScript.persona.company
 *   4. Returns null → prompt-templates uses PLAID_DEFAULT_BRAND inline
 *
 * @param {object|null} demoScript  Parsed demo-script.json, or null
 * @returns {object|null}
 */
function loadBrand(demoScript) {
  const brandArg = process.argv.find(a => a.startsWith('--brand='));
  const cliSlug  = brandArg ? brandArg.replace('--brand=', '').toLowerCase() : null;
  const envSlug  = process.env.BRAND_PROFILE ? process.env.BRAND_PROFILE.toLowerCase() : null;

  let autoSlug = null;
  if (demoScript && demoScript.persona && demoScript.persona.company) {
    autoSlug = demoScript.persona.company.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  const slug = cliSlug || envSlug || autoSlug;

  if (!slug || slug === 'plaid') {
    console.log('[Build] Brand: Plaid defaults');
    return null;
  }

  const profilePath = path.join(BRAND_DIR, `${slug}.json`);
  if (!fs.existsSync(profilePath)) {
    console.warn(`[Build] Brand profile not found: brand/${slug}.json — using Plaid defaults`);
    return null;
  }

  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    console.log(`[Build] Brand profile loaded: brand/${slug}.json (${profile.name}, mode: ${profile.mode})`);
    return profile;
  } catch (err) {
    console.warn(`[Build] Could not parse brand/${slug}.json: ${err.message} — using Plaid defaults`);
    return null;
  }
}

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const qaArg    = process.argv.find(a => a.startsWith('--qa='));
  const brandArg = process.argv.find(a => a.startsWith('--brand='));
  return {
    qaReportPath: qaArg    ? qaArg.replace('--qa=', '')    : null,
    brandSlug:    brandArg ? brandArg.replace('--brand=', '') : null,
  };
}

// ── Response parsing ──────────────────────────────────────────────────────────

/**
 * Strips leading/trailing markdown fences from a string.
 * Handles ```html, ```json, ``` etc.
 */
function stripFences(text) {
  return text
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

/**
 * Splits the raw Claude response into HTML and Playwright JSON parts.
 * The response must contain PLAYWRIGHT_MARKER.
 *
 * @param {string} raw - Full response text from Claude
 * @returns {{ html: string, playwrightScript: object }}
 */
function parseAppResponse(raw) {
  const markerIdx = raw.indexOf(PLAYWRIGHT_MARKER);
  if (markerIdx === -1) {
    throw new Error(
      `[Build] Response missing separator "${PLAYWRIGHT_MARKER}".\n` +
      `First 300 chars: ${raw.substring(0, 300)}`
    );
  }

  let htmlPart = raw.substring(0, markerIdx).trim();
  const jsonPart = raw.substring(markerIdx + PLAYWRIGHT_MARKER.length).trim();

  // Strip markdown fences from HTML if present
  htmlPart = stripFences(htmlPart);
  if (!htmlPart.startsWith('<!DOCTYPE') && !htmlPart.startsWith('<html')) {
    // Try to find the actual HTML start
    const doctypeIdx = htmlPart.indexOf('<!DOCTYPE');
    const htmlIdx    = htmlPart.indexOf('<html');
    const startIdx   = doctypeIdx !== -1 ? doctypeIdx : (htmlIdx !== -1 ? htmlIdx : 0);
    htmlPart = htmlPart.substring(startIdx);
  }

  // Parse the Playwright JSON (may be in a fenced block)
  let playwrightRaw = stripFences(jsonPart);
  // Handle ```json prefix leftover
  playwrightRaw = playwrightRaw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  let playwrightScript;
  try {
    playwrightScript = JSON.parse(playwrightRaw);
  } catch (err) {
    // Attempt to extract JSON object from surrounding text
    const jsonMatch = playwrightRaw.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      try {
        playwrightScript = JSON.parse(jsonMatch[1]);
      } catch {
        throw new Error(`[Build] Could not parse playwright-script.json: ${err.message}\nRaw:\n${playwrightRaw.substring(0, 500)}`);
      }
    } else {
      throw new Error(`[Build] Could not parse playwright-script.json: ${err.message}\nRaw:\n${playwrightRaw.substring(0, 500)}`);
    }
  }

  return { html: htmlPart, playwrightScript };
}

/**
 * Extracts the text content from a Claude response (handles both streaming
 * accumulated text and non-streaming content arrays).
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
  }
  return String(content);
}

// ── Claude calls ──────────────────────────────────────────────────────────────

/**
 * Call 1: Architecture brief (claude-sonnet-4-6, non-streaming, 1024 tokens).
 */
async function getArchitectureBrief(client, demoScript) {
  console.log('[Build] Call 1: Generating architecture brief (claude-sonnet-4-6)...');

  const { system, userMessages } = buildAppArchitectureBriefPrompt(demoScript, { plaidLinkLive: PLAID_LINK_LIVE });

  const response = await client.messages.create({
    model:      ARCH_MODEL,
    max_tokens: ARCH_MAX_TOKENS,
    system,
    messages:   userMessages,
  });

  const brief = extractText(response.content);
  console.log('[Build] Architecture brief received');
  return brief;
}

/**
 * Call 2: Full app generation (claude-opus-4-6, streaming, extended thinking).
 * Streams progress dots to stdout.
 */
async function generateApp(client, demoScript, architectureBrief, qaReport, brand, refinementOpts = {}) {
  console.log('[Build] Call 2: Generating full HTML app (claude-opus-4-6 streaming)...');
  console.log('[Build] Progress: ');

  const designPlugin = loadDesignPlugin();
  const { system: buildSystem, userMessages: buildMessages } = buildAppGenerationPrompt(
    demoScript, architectureBrief, qaReport,
    {
      plaidLinkLive:      PLAID_LINK_LIVE,
      plaidLinkScreens:   refinementOpts.plaidLinkScreens || [],
      designPluginHtml:   designPlugin.html,
      designPluginCss:    designPlugin.css,
      brand,
      qaFrames:           refinementOpts.qaFrames   || [],
      prevTestids:        refinementOpts.prevTestids || [],
    }
  );

  const stream = await client.messages.stream({
    model:      BUILD_MODEL,
    max_tokens: BUILD_MAX_TOKENS,
    thinking: {
      type:          'enabled',
      budget_tokens: BUILD_BUDGET_TOKENS,
    },
    system:   buildSystem,
    messages: buildMessages,
  });

  let fullText = '';
  let chunkCount = 0;

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      fullText += event.delta.text;
      chunkCount++;
      // Print a dot every 10 chunks to show progress without flooding stdout
      if (chunkCount % 10 === 0) {
        process.stdout.write('.');
      }
    }
  }

  process.stdout.write('\n');
  console.log(`[Build] Generation complete (${fullText.length} chars)`);

  return fullText;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(opts = {}) {
  // Accept qaReportFile from orchestrator, fall back to CLI args
  const { qaReportPath: cliQaPath } = parseArgs();
  const qaReportPath = opts.qaReportFile || cliQaPath;

  // Validate inputs
  if (!fs.existsSync(SCRIPT_FILE)) {
    console.error('[Build] Missing: out/demo-script.json — run generate-script.js first');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[Build] Missing ANTHROPIC_API_KEY in environment');
    process.exit(1);
  }

  // Validate Plaid credentials when live mode is enabled
  if (PLAID_LINK_LIVE) {
    if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SANDBOX_SECRET) {
      console.error('[Build] PLAID_LINK_LIVE=true but missing PLAID_CLIENT_ID or PLAID_SANDBOX_SECRET in .env');
      process.exit(1);
    }
    console.log('[Build] Plaid Link mode: LIVE (sandbox) — will generate app with real Plaid Link SDK');
  } else {
    console.log('[Build] Plaid Link mode: MOCK (self-contained HTML)');
  }

  const demoScript = JSON.parse(fs.readFileSync(SCRIPT_FILE, 'utf8'));
  console.log(`[Build] Loaded demo-script.json: ${demoScript.steps.length} steps for "${demoScript.product}"`);

  // Load brand profile (auto-detects from persona.company, --brand=, or BRAND_PROFILE env)
  const brand = loadBrand(demoScript);

  // Load optional QA report + associated frame images for refinement context
  let qaReport    = null;
  let qaFrames    = [];   // base64 PNG frames for failed steps (visual context for build agent)
  let prevTestids = [];   // data-testid inventory from previous build (structural context)

  if (qaReportPath) {
    const resolvedQaPath = path.isAbsolute(qaReportPath)
      ? qaReportPath
      : path.join(PROJECT_ROOT, qaReportPath);
    if (fs.existsSync(resolvedQaPath)) {
      try {
        qaReport = JSON.parse(fs.readFileSync(resolvedQaPath, 'utf8'));
        console.log(`[Build] Loaded QA report: ${resolvedQaPath} (score: ${qaReport.overallScore}/100)`);

        // Load QA frame images for steps that failed — visual context for the build agent.
        // Without frames, the agent is fixing visual problems from a text description alone.
        const framesDir   = path.join(OUT_DIR, 'qa-frames');
        const failedSteps = (qaReport.stepsWithIssues || []).map(s => s.stepId);
        if (failedSteps.length > 0 && fs.existsSync(framesDir)) {
          if (failedSteps.length > 8) {
            console.warn(`[Build] WARNING: ${failedSteps.length} failed steps but only 8 included in refinement context — subsequent passes needed`);
          }
          for (const stepId of failedSteps.slice(0, 8)) { // cap to limit token budget
            for (const suffix of ['start', 'mid']) {
              const framePath = path.join(framesDir, `${stepId}-${suffix}.png`);
              if (fs.existsSync(framePath)) {
                try {
                  const base64 = fs.readFileSync(framePath).toString('base64');
                  qaFrames.push({ stepId, suffix, base64 });
                } catch (_) {}
              }
            }
          }
          console.log(`[Build] Loaded ${qaFrames.length} QA frame(s) for refinement visual context (${failedSteps.length} failed steps)`);
        }

        // Extract data-testid inventory from previous HTML for structural context.
        // Gives the agent a quick reference to what it previously built without
        // including the full ~8KB HTML in the prompt.
        if (fs.existsSync(HTML_OUT)) {
          try {
            const prevHtml = fs.readFileSync(HTML_OUT, 'utf8');
            const matches  = [...prevHtml.matchAll(/data-testid="([^"]+)"/g)];
            prevTestids    = [...new Set(matches.map(m => m[1]))];
            console.log(`[Build] Previous build: ${prevTestids.length} unique data-testid attributes`);
          } catch (_) {}
        }
      } catch (err) {
        console.warn(`[Build] Warning: could not parse QA report: ${err.message}`);
      }
    } else {
      console.warn(`[Build] Warning: QA report not found at ${resolvedQaPath}`);
    }
  }

  // ── Load human reviewer feedback (optional) ──────────────────────────────
  let humanFeedback = null;
  if (fs.existsSync(FEEDBACK_FILE)) {
    try {
      humanFeedback = fs.readFileSync(FEEDBACK_FILE, 'utf8').trim();
      if (humanFeedback) {
        const lineCount = humanFeedback.split('\n').length;
        console.log(`[Build] Human feedback loaded: inputs/build-feedback.md (${lineCount} lines)`);
        console.log('[Build] ⭐ Human feedback will be injected as highest-priority guidance');
      } else {
        humanFeedback = null;
      }
    } catch (err) {
      console.warn(`[Build] Could not read inputs/build-feedback.md: ${err.message}`);
    }
  }

  // ── Plaid Link capture screenshots — DISABLED ─────────────────────────────
  // plaid-link-capture stage is disabled; Plaid Link recorded via Playwright directly.
  // To restore: uncomment this block and re-enable the stage in orchestrator.js STAGES.
  /*
  let plaidLinkScreens = [];
  if (PLAID_LINK_LIVE && fs.existsSync(path.join(PLAID_LINK_SCREENS_DIR, 'manifest.json'))) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(PLAID_LINK_SCREENS_DIR, 'manifest.json'), 'utf8')
      );
      for (const stepId of (manifest.steps || [])) {
        const imgPath = path.join(PLAID_LINK_SCREENS_DIR, `${stepId}.png`);
        if (fs.existsSync(imgPath)) {
          const base64 = fs.readFileSync(imgPath).toString('base64');
          plaidLinkScreens.push({ stepId, base64 });
        }
      }
      console.log(
        `[Build] Loaded ${plaidLinkScreens.length} Plaid Link capture screenshot(s) ` +
        `(flow: ${manifest.flowType}) — will generate simulated step divs`
      );
    } catch (err) {
      console.warn(`[Build] Could not load Plaid Link capture screenshots: ${err.message}`);
    }
  }
  */
  const plaidLinkScreens = [];

  fs.mkdirSync(SCRATCH_APP_DIR, { recursive: true });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // ── Call 1: Architecture brief ────────────────────────────────────────────
  const architectureBrief = await getArchitectureBrief(client, demoScript);

  // ── Call 2: Full app generation (streaming) ───────────────────────────────
  const rawResponse = await generateApp(client, demoScript, architectureBrief, qaReport, brand,
    { qaFrames, prevTestids, humanFeedback, plaidLinkScreens });

  // ── Parse response ────────────────────────────────────────────────────────
  let html, playwrightScript;
  try {
    ({ html, playwrightScript } = parseAppResponse(rawResponse));
  } catch (err) {
    console.error(err.message);
    // Save raw response for debugging
    const debugPath = path.join(OUT_DIR, 'build-app-raw-response.txt');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(debugPath, rawResponse);
    console.error(`[Build] Raw response saved to ${debugPath} for debugging`);
    process.exit(1);
  }

  // ── Validate DOM contract ──────────────────────────────────────────────────
  // These are hard errors — a contract violation means the recording will fail.
  const domErrors = [];

  // 1. Every step in demo-script.json must have a corresponding step div.
  //    When PLAID_LINK_LIVE=true WITHOUT capture screenshots: skip Plaid Link sim steps
  //    (the real SDK iframe handles them; no host-page divs are needed).
  //    When PLAID_LINK_LIVE=true WITH capture screenshots: the build agent IS expected to
  //    generate simulated step divs (using the captured screenshots as reference), so we
  //    validate all steps including Plaid Link ones.
  const PLAID_SIM_STEP_PATTERN = /^link[-_](?:consent|otp|account[-_]select|success)$/i;
  const stepIds = demoScript.steps.map(s => s.id);
  // When PLAID_LINK_LIVE=true, skip Plaid Link sim step validation — record-local.js handles
  // these steps via real iframe CDP automation; no host-page divs are required.
  const stepsToCheck = PLAID_LINK_LIVE
    ? stepIds.filter(id => !PLAID_SIM_STEP_PATTERN.test(id))
    : stepIds;
  const missingSteps = stepsToCheck.filter(id => !html.includes(`data-testid="step-${id}"`));
  if (missingSteps.length > 0) {
    domErrors.push(`Missing data-testid for steps: ${missingSteps.join(', ')}`);
  }
  if (PLAID_LINK_LIVE) {
    const skippedSimSteps = stepIds.filter(id => PLAID_SIM_STEP_PATTERN.test(id));
    if (skippedSimSteps.length > 0) {
      console.log(`[Build] Skipping Plaid simulation steps (PLAID_LINK_LIVE=true): ${skippedSimSteps.join(', ')}`);
    }
  }

  // 2. Navigation functions must exist (record-local.js calls them on every step)
  if (!html.includes('window.goToStep')) {
    domErrors.push('window.goToStep not found in generated HTML');
  }
  if (!html.includes('window.getCurrentStep')) {
    domErrors.push('window.getCurrentStep not found in generated HTML');
  }

  // 3. Duplicate data-testid attributes cause Playwright strict-mode errors
  const testidMatches = [...html.matchAll(/data-testid="([^"]+)"/g)];
  const testidCounts = {};
  for (const m of testidMatches) {
    testidCounts[m[1]] = (testidCounts[m[1]] || 0) + 1;
  }
  const dupeTestids = Object.entries(testidCounts)
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (dupeTestids.length > 0) {
    domErrors.push(`Duplicate data-testid attributes: ${dupeTestids.join(', ')}`);
  }

  // 4. Step divs must NOT have inline style="display:..." — this permanently overrides
  //    .step visibility and makes the step visible on all other steps' video frames.
  //    (Pattern matches class="step" or data-testid="step-..." with a display style)
  const stepDisplayStyle = html.match(/data-testid="step-[^"]*"[^>]*style="[^"]*display\s*:/);
  if (stepDisplayStyle) {
    domErrors.push(
      'A step div has inline style with "display:" — this overrides .step.active visibility. ' +
      'Remove all inline display styles from step divs.'
    );
  }

  // 5. Every interaction.target in demo-script.json must have a matching data-testid in HTML.
  //    When PLAID_LINK_LIVE=true, skip interaction targets from Plaid simulation steps.
  const stepsForTargets = PLAID_LINK_LIVE
    ? demoScript.steps.filter(s => !PLAID_SIM_STEP_PATTERN.test(s.id))
    : demoScript.steps;
  const interactionTargets = stepsForTargets
    .map(s => s.interaction?.target)
    .filter(t => t && t !== 'none' && t !== 'n/a' && t !== '' && t !== null);
  const missingTargets = [...new Set(
    interactionTargets.filter(t => !html.includes(`data-testid="${t}"`))
  )];
  if (missingTargets.length > 0) {
    domErrors.push(`Missing data-testid for interaction targets: ${missingTargets.join(', ')}`);
  }

  if (domErrors.length > 0) {
    console.error('[Build] DOM contract violations (recording will fail):');
    domErrors.forEach(e => console.error(`  ✗ ${e}`));
    process.exit(1);
  }
  console.log('[Build] DOM contract: OK');

  // ── Validate playwright-script.json step IDs match demo-script.json ────────
  // The LLM generates playwright-script.json and can invent arbitrary step IDs.
  // If playwright-script IDs don't match demo-script IDs, record-local.js will:
  //   - fail to resolve Plaid Link phases (regex can't match unknown IDs)
  //   - write step-timing.json with wrong IDs (QA then can't find steps → skips them)
  //   - cause "step not in demo-script.json" QA warnings for every step
  const demoStepIds = new Set(demoScript.steps.map(s => s.id));
  const pwSteps     = playwrightScript.steps || [];
  const inventedIds = pwSteps
    .map(s => s.stepId || s.id)
    .filter(id => id && !demoStepIds.has(id));
  if (inventedIds.length > 0) {
    console.error('[Build] playwright-script.json step ID mismatch (recording will fail):');
    console.error(`  ✗ These IDs are not in demo-script.json: ${inventedIds.join(', ')}`);
    console.error(`  ✓ Valid IDs from demo-script.json: ${[...demoStepIds].join(', ')}`);
    process.exit(1);
  }
  console.log(`[Build] playwright-script step IDs: OK (${pwSteps.length} steps match demo-script)`);

  // ── Post-process: ensure handler.destroy() is called in onSuccess ─────────
  // The Plaid iframe persists in the DOM after onSuccess unless destroy() is called,
  // causing it to overlay all post-link steps in the recording.
  if (html.includes('window._plaidLinkComplete = true') && !html.includes('handler.destroy()')) {
    html = html.replace(
      /window\._plaidLinkComplete\s*=\s*true;/g,
      'window._plaidLinkComplete = true;\n        if (window._plaidHandler) { try { window._plaidHandler.destroy(); } catch(e) {} }'
    );
    console.log('[Build] Injected handler.destroy() into onSuccess (Plaid modal cleanup)');
  }

  // ── Write outputs ──────────────────────────────────────────────────────────
  fs.writeFileSync(HTML_OUT, html, 'utf8');
  fs.writeFileSync(PLAYWRIGHT_OUT, JSON.stringify(playwrightScript, null, 2), 'utf8');

  console.log(`[Build] Written: scratch-app/index.html (${Math.round(html.length / 1024)}KB)`);
  console.log(`[Build] Written: scratch-app/playwright-script.json (${playwrightScript.steps.length} steps)`);
  console.log('[Build] Done — next: node scripts/scratch/scratch/record-local.js');
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[Build] Fatal error:', err.message);
    process.exit(1);
  });
}
