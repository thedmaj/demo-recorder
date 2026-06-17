'use strict';
/**
 * generate-script.js
 * Calls Claude to generate out/demo-script.json from ingested inputs +
 * optional product research.
 *
 * Reads:  out/ingested-inputs.json
 *         out/product-research.json   (optional)
 * Writes: out/demo-script.json
 *
 * Usage: node scripts/scratch/scratch/generate-script.js
 *
 * Environment:
 *   ANTHROPIC_API_KEY        — required
 *   SCRATCH_AUTO_APPROVE     — set to 'true' to skip the ENTER pause
 */

require('../utils/load-env').loadEnv();
const Anthropic  = require('@anthropic-ai/sdk');
const fs         = require('fs');
const path       = require('path');
const readline   = require('readline');

const {
  buildScriptGenerationPrompt,
} = require('../utils/prompt-templates');
const {
  inferProductFamily,
} = require('../utils/product-profiles');
const {
  getPlaidSkillBundleForFamily,
  getPlaidLinkUxSkillBundle,
  getEmbeddedLinkSkillBundle,
  writePlaidLinkUxSkillManifest,
} = require('../utils/plaid-skill-loader');
const { buildCuratedProductKnowledge, buildCuratedDigest } = require('../utils/product-knowledge');
const { writePipelineRunContext, buildRunContextPayload } = require('../utils/run-context');
const { annotateScriptWithStepKinds } = require('../utils/step-kind');
const { routeSlideTemplate } = require('../utils/slide-template-router');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT    = path.resolve(__dirname, '../../..');
const OUT_DIR         = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const INGESTED_FILE   = path.join(OUT_DIR, 'ingested-inputs.json');
const RESEARCH_FILE   = path.join(OUT_DIR, 'product-research.json');
const OUT_FILE        = path.join(OUT_DIR, 'demo-script.json');

// ── Model config ──────────────────────────────────────────────────────────────

const { OPUS_PRIMARY } = require('../utils/anthropic-models');
const MODEL          = process.env.SCRIPT_MODEL || OPUS_PRIMARY;
const BUDGET_TOKENS  = 8000;
const MAX_TOKENS     = 16000;

// ── Structured output tool schema ─────────────────────────────────────────────
// Using Claude's tools parameter guarantees structured JSON output without
// relying on regex extraction of fenced code blocks in the response text.

const GENERATE_DEMO_SCRIPT_TOOL = {
  name: 'generate_demo_script',
  description:
    'Generate a complete structured demo script for a Plaid product demo video. ' +
    'Call this tool once you have designed the full narrative arc with all steps.',
  input_schema: {
    type: 'object',
    properties: {
      title:   { type: 'string', description: 'Demo title' },
      product: { type: 'string', description: 'Plaid product name (e.g. "Plaid Signal")' },
      persona: {
        type: 'object',
        properties: {
          name:    { type: 'string' },
          company: { type: 'string' },
          useCase: { type: 'string' },
        },
        required: ['name', 'company', 'useCase'],
      },
      plaidSandboxConfig: {
        type: 'object',
        description:
          'Optional overrides for live Plaid Link recording (phone, otp, institutionId, username, password, mfa, plaidLinkFlow). ' +
          'For CRA / Plaid Check (Base Report or Income Insights), use institution login user_credit_profile_good or another ' +
          'user_credit_* sandbox persona with password pass_good. Do not use user_good/pass_good for CRA Link or user_bank_income/{} ' +
          '(that pair is for traditional Bank Income only). Non-OAuth institutions only (e.g. First Platypus Bank).',
      },
      steps: {
        type: 'array',
        description: 'Ordered list of demo steps (8–14 steps, each 20–35 words narration)',
        items: {
          type: 'object',
          properties: {
            id:              { type: 'string', description: 'kebab-case step identifier' },
            label:           { type: 'string' },
            sceneType:       { type: 'string', description: '"host" | "link" | "insight" | "slide"' },
            narration:       { type: 'string', description: '20–35 words for ElevenLabs TTS' },
            durationHintMs:  { type: 'number', description: 'Expected screen duration in ms' },
            plaidPhase:      { type: 'string', description: '"launch" for the Plaid Link step' },
            visualState:     { type: 'string', description: 'What is visible on screen' },
            voiceoverStartOffsetMs: { type: 'number' },
            interaction: {
              type: 'object',
              properties: {
                action: { type: 'string' },
                target: { type: 'string', description: 'CSS/data-testid selector' },
                waitMs: { type: 'number' },
              },
            },
            apiResponse: {
              type: 'object',
              properties: {
                endpoint: { type: 'string' },
                response: { type: 'object' },
              },
            },
            slideTemplate: {
              type: 'string',
              description: 'Optional Plaid deck template id T1–T11 (hard override for post-slides router)',
            },
            workhorseLayout: {
              type: 'string',
              description: 'Optional showcase workhorse layout slug (e.g. kpi-grid, stat-highlight)',
            },
            slideCategory: {
              type: 'string',
              description: 'Optional router category hint: opening|explainer|metrics|comparison_flow|plans_proof|close',
            },
            slideRole: {
              type: 'string',
              description: 'For sceneType "slide"/"insight" slides ONLY — the narrative job this slide performs. The router maps it to the right template, so prefer this over slideTemplate/workhorseLayout. One of: opening | section-break | problem-statement | concept-explainer | three-pillars | pull-quote | hero-metrics | kpi-dashboard | api-field-reveal | data-comparison-table | bar-chart | before-after | transformation-rows | sequential-steps | flow-diagram | architecture | timeline | roadmap | code-proof | customer-proof | value-summary. Use api-field-reveal when the slide shows the key fields an API returns with their sample values.',
            },
            showcaseTemplateId: {
              type: 'string',
              description: 'Optional showcase section id from templates/slide-template/showcase/index.html',
            },
          },
          required: ['id', 'label', 'narration', 'durationHintMs'],
        },
      },
    },
    required: ['title', 'product', 'persona', 'steps'],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extracts JSON from a Claude response content array.
 * Fallback used when the tool_use block is absent (should be rare with tool_choice).
 * Looks for a text block containing a fenced JSON block or raw JSON object.
 */
function extractJSON(content) {
  // Find the first text block
  const textBlock = content.find(b => b.type === 'text');
  if (!textBlock) {
    throw new Error('[Script] No text block in Claude response');
  }
  const raw = textBlock.text;

  // Try fenced JSON block first (```json ... ```)
  const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch (err) {
      throw new Error(`[Script] JSON parse error in fenced block: ${err.message}\n\nRaw:\n${fencedMatch[1].substring(0, 500)}`);
    }
  }

  // Try plain fenced block (``` ... ```)
  const plainFencedMatch = raw.match(/```\s*([\s\S]*?)```/);
  if (plainFencedMatch) {
    try {
      return JSON.parse(plainFencedMatch[1].trim());
    } catch (_) {
      // Fall through to raw JSON attempt
    }
  }

  // Try to find raw JSON object in the response
  const jsonMatch = raw.match(/(\{[\s\S]*\})/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (err) {
      throw new Error(`[Script] JSON parse error in raw response: ${err.message}\n\nFirst 500 chars:\n${raw.substring(0, 500)}`);
    }
  }

  throw new Error(`[Script] Could not locate JSON in Claude response.\nFirst 500 chars:\n${raw.substring(0, 500)}`);
}

/**
 * Waits for the user to press ENTER (unless SCRATCH_AUTO_APPROVE is set).
 */
function waitForApproval(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
    });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

function isInsightLikeStep(step) {
  if (isValueSummaryStep(step)) return false;
  const sceneType = String(step?.sceneType || '').toLowerCase();
  if (sceneType === 'slide') return false;
  if (sceneType === 'insight') return true;
  const haystack = [step?.id, step?.label, step?.visualState].filter(Boolean).join(' ').toLowerCase();
  return /\binsight\b|\bapi insight\b|\bplaid insight\b/.test(haystack);
}

/**
 * Deterministic auto-corrections applied AFTER the LLM produces a demo-script
 * but BEFORE `validateDemoScript` runs. Each fix has a single, narrow,
 * safe-by-construction rule. The goal is to keep the pipeline running without
 * an extra LLM round-trip when the LLM's mistake is unambiguous.
 *
 * Mutates `demoScript` in place. Returns `{ fixed, fixes: [{ stepId, rule, before, after }] }`.
 *
 * Rules:
 *   - **orphan-insight-to-slide**: a step is marked `sceneType: "insight"` but
 *     has no `apiResponse.endpoint` (or no `apiResponse.response`) → demote to
 *     `sceneType: "slide"` and strip any half-built `apiResponse` stub. This
 *     is what the LLM does when it labels a marketing slide an "insight" by
 *     accident. Demoting is safer than failing the run: the slide still
 *     renders, just without a JSON panel.
 *   - **value-summary-strip-apiresponse**: the final value-summary slide must
 *     not carry an `apiResponse` (the validator forbids it). Strip if present.
 *   - **insight-with-empty-apiresponse**: an insight step that has an
 *     `apiResponse` object but missing `endpoint` or `response` → if the body
 *     is empty (no meaningful payload), demote to slide; otherwise leave it
 *     for the validator to flag explicitly.
 */
function autoFixDemoScript(demoScript) {
  const fixes = [];
  const steps = Array.isArray(demoScript?.steps) ? demoScript.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const sceneType = String(step.sceneType || '').toLowerCase();
    const ar = step.apiResponse || null;
    const hasEndpoint = !!(ar && typeof ar.endpoint === 'string' && ar.endpoint.trim());
    const hasResponse = !!(ar && ar.response && typeof ar.response === 'object'
      && Object.keys(ar.response).length > 0);

    if (sceneType === 'insight' && (!hasEndpoint || !hasResponse)) {
      const before = sceneType;
      step.sceneType = 'slide';
      const beforeAr = ar ? JSON.stringify(ar).slice(0, 80) : null;
      if (ar && (!hasEndpoint || !hasResponse)) {
        delete step.apiResponse;
      }
      fixes.push({
        stepId: step.id || '(no-id)',
        rule: 'orphan-insight-to-slide',
        before: `sceneType=${before}` + (beforeAr ? ` apiResponse=${beforeAr}` : ''),
        after: 'sceneType=slide; apiResponse stripped',
      });
      continue;
    }

    if (isValueSummaryStep(step) && step.apiResponse) {
      fixes.push({
        stepId: step.id || '(no-id)',
        rule: 'value-summary-strip-apiresponse',
        before: 'apiResponse present on value-summary',
        after: 'apiResponse removed',
      });
      delete step.apiResponse;
    }

    // Strip INCOMPLETE apiResponse from any non-insight step (host/slide/link/
    // launch). The LLM sometimes attaches a partial apiResponse (missing endpoint
    // or response) to non-insight steps — those render no JSON panel and otherwise
    // fail validation ("incomplete apiResponse block"), halting the whole pipeline
    // at the script stage. A COMPLETE apiResponse on a non-insight step is left intact.
    if (step.apiResponse && !isInsightLikeStep(step) && !isValueSummaryStep(step)) {
      const ar2 = step.apiResponse;
      const complete = ar2.endpoint && ar2.response && typeof ar2.response === 'object'
        && Object.keys(ar2.response).length > 0;
      if (!complete) {
        const beforeAr = JSON.stringify(ar2).slice(0, 80);
        delete step.apiResponse;
        fixes.push({
          stepId: step.id || '(no-id)',
          rule: 'strip-incomplete-apiresponse',
          before: `incomplete apiResponse on non-insight step: ${beforeAr}`,
          after: 'apiResponse removed',
        });
      }
    }
  }

  // Multi-launch contract: a demo MAY have more than one real plaidPhase:"launch"
  // step when each launches a DISTINCT Plaid session — legitimate multi-product
  // journeys span Plaid Layer (network prefill) → Identity Verification (KYC) →
  // Plaid Link / CRA (bank connection). Each distinct session is its own real
  // modal. We only collapse: (a) launches placed on a slide, and (b) duplicate
  // launches of the SAME product (accidental). Distinct-product launches are kept.
  const launchSteps = steps.filter((s) => s && s.plaidPhase === 'launch');
  if (launchSteps.length > 1) {
    const seenProducts = new Set();
    for (const step of launchSteps) {
      const scene = String(step.sceneType || '').toLowerCase();
      if (scene === 'slide') {
        fixes.push({
          stepId: step.id || '(no-id)',
          rule: 'dedupe-plaid-launch-phase',
          before: 'plaidPhase:"launch" on slide',
          after: 'plaidPhase removed',
        });
        delete step.plaidPhase;
        continue;
      }
      const product = inferLaunchProduct(step);
      if (seenProducts.has(product)) {
        fixes.push({
          stepId: step.id || '(no-id)',
          rule: 'dedupe-plaid-launch-phase',
          before: `duplicate plaidPhase:"launch" for product "${product}"`,
          after: 'plaidPhase removed (only one launch per product)',
        });
        delete step.plaidPhase;
        continue;
      }
      seenProducts.add(product);
      if (scene !== 'link') step.sceneType = 'link';
      // Annotate the resolved product so build / build-qa / record-local can wire
      // the correct token endpoint + completion flag per launch.
      if (!step.launchProduct) step.launchProduct = product;
    }
  }

  // Promote mislabeled marketing slides that are actually the embedded Link beat.
  for (const step of steps) {
    if (!step || isValueSummaryStep(step)) continue;
    const scene = String(step.sceneType || '').toLowerCase();
    if (scene !== 'slide') continue;
    const text = [step.id, step.label, step.visualState, step.narration].filter(Boolean).join(' ').toLowerCase();
    if (
      /plaid-embedded-link-container/.test(text) ||
      (/\bplaid\s+link\b/.test(text) && /\b(institution search|embedded|connect|external account)\b/.test(text))
    ) {
      step.sceneType = 'link';
      fixes.push({
        stepId: step.id || '(no-id)',
        rule: 'promote-embedded-link-slide-to-link',
        before: 'sceneType:"slide" on embedded Link beat',
        after: 'sceneType:"link"',
      });
    }
  }

  // Infer missing plaidPhase:"launch" on the obvious Link step — the LLM often
  // emits sceneType:"host" for embedded pre-link + link beats without plaidPhase.
  if (!steps.some((s) => s && s.plaidPhase === 'launch') && !isLayerUseCase(demoScript)) {
    const scoreLaunchInfer = (step) => {
      if (!step || isValueSummaryStep(step)) return -1;
      const scene = String(step.sceneType || '').toLowerCase();
      if (scene === 'slide') return -1;
      let n = 0;
      if (scene === 'link') n += 100;
      const text = [step.id, step.label, step.visualState, step.narration].filter(Boolean).join(' ').toLowerCase();
      if (/plaid-embedded-link-container/.test(text)) n += 95;
      if (/\b(embed(?:ded)?\s+plaid\s+link|plaid\s+link|link-launch|plaid-link-launch|wf-link|institution search|link(?:ing)?\s+(?:your\s+)?external|external account|connect (?:your )?(?:bank|account)|link (?:your )?(?:bank|account|checking))\b/.test(text)) {
        n += 85;
      }
      if (/\b(add external|fund(?:ing)?.*external|recommended.*instant)\b/.test(text)) n += 50;
      if (scene === 'host') n += 15;
      return n;
    };

    let candidate = steps.find((s) => s && String(s.sceneType || '').toLowerCase() === 'link');
    if (!candidate) {
      let best = null;
      let bestScore = 0;
      for (const s of steps) {
        const sc = scoreLaunchInfer(s);
        if (sc > bestScore) {
          bestScore = sc;
          best = s;
        }
      }
      if (best && bestScore >= 40) candidate = best;
    }
    if (candidate) {
      candidate.plaidPhase = 'launch';
      candidate.sceneType = 'link';
      fixes.push({
        stepId: candidate.id || '(no-id)',
        rule: 'infer-plaid-launch-phase',
        before: 'missing plaidPhase:"launch"',
        after: 'plaidPhase:"launch" sceneType:"link"',
      });
    }
  }

  return { fixed: fixes.length, fixes };
}

function isAmountEntryStep(step) {
  const haystack = [step?.id, step?.label, step?.visualState, step?.narration].filter(Boolean).join(' ').toLowerCase();
  return /\bamount\b|\bfunding amount\b|\btransfer amount\b/.test(haystack);
}

function normalizeSceneType(step) {
  const raw = String(step?.sceneType || '').trim().toLowerCase();
  if (raw === 'slide') {
    const text = [step?.id, step?.label, step?.visualState].filter(Boolean).join(' ').toLowerCase();
    const explicitlySlide = /\bslide\b/.test(text) && /\.slide-root\b/.test(text);
    const likelyInsight = /\binsight\b/.test(text) || !!step?.apiResponse?.endpoint || !!step?.apiResponse?.response;
    return explicitlySlide || !likelyInsight ? 'slide' : 'insight';
  }
  if (raw === 'host' || raw === 'link' || raw === 'insight') return raw;
  if (step?.plaidPhase === 'launch') return 'link';
  if (step?.apiResponse?.endpoint || step?.apiResponse?.response) return 'insight';
  return 'host';
}

// Infer which distinct Plaid session a plaidPhase:"launch" step launches, so the
// multi-launch contract can keep one launch PER product (Layer / IDV / CRA / Link)
// and downstream stages (build wiring, plaid-link-qa token endpoint, record-local
// modal driver) can pick the right token endpoint + completion flag. Order matters:
// IDV and CRA are checked before the generic "link" fallback. "identity match" is
// NOT IDV — it is an /identity/match product carried on a standard Link token.
function inferLaunchProduct(step) {
  if (!step) return 'link';
  const text = [step.launchProduct, step.id, step.label, step.visualState, step.narration]
    .filter(Boolean).join(' ').toLowerCase();
  // Layer detection must NOT trip on incidental prose like "connection layer"
  // or "layer of security" (2026-06-17: a Citi Auth launch whose visualState
  // said "Plaid as the secure connection layer" was misclassified as a Plaid
  // Layer launch → plaid-link-qa demanded /api/create-session-token and failed).
  // Require Plaid-Layer-AS-PRODUCT phrasing: an explicit launchProduct/id signal
  // (authored ids like "layer-launch"), "plaid layer", or "layer" adjacent to a
  // Layer keyword (launch/session/token/template/prefill/eligible/modal/flow).
  const strong = [step.launchProduct, step.id].filter(Boolean).join(' ').toLowerCase();
  const isLayer = /\blayer\b/.test(strong)
    || /\bplaid[\s-]?layer\b/.test(text)
    || /\blayer[\s-]?(?:launch|session|token|template|prefill|eligib|modal|flow)\b/.test(text);
  if (isLayer) return 'layer';
  if (/\bidv\b|identity[\s-]?verification/.test(text)) return 'idv';
  if (/\bcra\b|consumer[\s-]?report|income[\s-]?insights|base[\s-]?report|check[\s-]?report/.test(text)) return 'cra';
  return 'link';
}

function isLayerUseCase(demoScript) {
  if (!demoScript || !Array.isArray(demoScript.steps)) return false;
  const header = [demoScript.title, demoScript.product].filter(Boolean).join(' ').toLowerCase();
  if (/\bplaid layer\b/.test(header)) return true;
  const stepsText = demoScript.steps
    .map((step) => [step?.id, step?.label, step?.narration, step?.visualState].filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();
  // Match Plaid-Layer-as-product, not incidental prose ("connection layer").
  // Authored Layer step ids ("layer-launch"/"layer-confirm") still match via the
  // adjacent-keyword form; "plaid layer" in the header already returned above.
  return /\bplaid[\s-]?layer\b|\blayer[\s-]?(?:launch|confirm|session|token|template|prefill|eligib|modal|flow)\b/.test(`${header} ${stepsText}`);
}

function enforceCanonicalLaunchInteraction(demoScript) {
  if (!demoScript || !Array.isArray(demoScript.steps)) return null;
  const launchStep = demoScript.steps.find((s) => s && s.plaidPhase === 'launch');
  if (!launchStep) return null;
  if (String(launchStep.sceneType || '').toLowerCase() === 'slide') return null;
  launchStep.sceneType = 'link';
  launchStep.interaction = launchStep.interaction || {};
  const embedded = String(demoScript.plaidLinkMode || '').toLowerCase() === 'embedded';
  if (embedded) {
    launchStep.interaction.action = 'goToStep';
    launchStep.interaction.target = launchStep.id;
    launchStep.interaction.waitMs = 120000;
  } else {
    launchStep.interaction.action = 'click';
    launchStep.interaction.target = 'link-external-account-btn';
    launchStep.interaction.waitMs = 120000;
  }
  return launchStep.id || null;
}

function isPreLinkExplainerStep(step) {
  if (!step || step.plaidPhase === 'launch') return false;
  if (step.apiResponse?.endpoint) return false;
  const text = [step?.id, step?.label, step?.narration, step?.visualState]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (
    /\b(plaid-embedded-link-container|embedded plaid link)\b/.test(text) &&
    /\b(add external account|link your external|external account|institution search)\b/.test(text)
  ) {
    return true;
  }
  return /\b(pre[-\s]?link|link (?:your )?bank|connect (?:your )?bank|add (?:a )?bank(?: account)?|open plaid|launch plaid|continue with plaid|link externally)\b/.test(text);
}

function isEmbeddedPreLinkHostStep(step) {
  if (!step || step.plaidPhase === 'launch') return false;
  if (step.apiResponse?.endpoint) return false;
  const scene = String(step.sceneType || '').toLowerCase();
  if (scene === 'link' || scene === 'slide' || scene === 'insight') return false;
  const text = [step?.id, step?.label, step?.narration, step?.visualState]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return (
    /\bplaid-embedded-link-container\b/.test(text) ||
    (/\b(embedded|embed)\b/.test(text) &&
      /\b(add external account|external account|link your external|institution search|plaid link)\b/.test(text))
  );
}

/**
 * Embedded mode: collapse host pre-link + separate plaid-link-launch into one integrated launch step.
 * Keeps the host-named step id (e.g. add-external-account-embedded) as the canonical launch step.
 */
function mergeEmbeddedPreLinkSplit(demoScript) {
  if (!demoScript || !Array.isArray(demoScript.steps)) return null;
  if (String(demoScript.plaidLinkMode || '').toLowerCase() !== 'embedded') return null;
  const launchIdx = demoScript.steps.findIndex((s) => s && s.plaidPhase === 'launch');
  if (launchIdx <= 0) return null;
  const launchStep = demoScript.steps[launchIdx];
  const preStep = demoScript.steps[launchIdx - 1];
  if (!isEmbeddedPreLinkHostStep(preStep)) return null;
  if (preStep.plaidPhase === 'launch') return null;

  preStep.plaidPhase = 'launch';
  preStep.sceneType = 'link';
  if (!preStep.label && launchStep.label) preStep.label = launchStep.label;
  if (preStep.visualState && launchStep.visualState) {
    preStep.visualState = `${preStep.visualState} Then ${launchStep.visualState}`;
  } else if (!preStep.visualState && launchStep.visualState) {
    preStep.visualState = launchStep.visualState;
  }
  if (preStep.narration && launchStep.narration) {
    preStep.narration = `${preStep.narration} ${launchStep.narration}`.replace(/\s{2,}/g, ' ').trim();
  } else if (!preStep.narration && launchStep.narration) {
    preStep.narration = launchStep.narration;
  }
  const preMs = Number(preStep.durationHintMs || 0);
  const launchMs = Number(launchStep.durationHintMs || 0);
  if (preMs > 0 || launchMs > 0) {
    preStep.durationHintMs = preMs + launchMs;
  }
  if (typeof launchStep.durationMs === 'number' || typeof preStep.durationMs === 'number') {
    preStep.durationMs = Number(preStep.durationMs || 0) + Number(launchStep.durationMs || 0);
  }

  demoScript.steps.splice(launchIdx, 1);
  enforceCanonicalLaunchInteraction(demoScript);
  return { removedStepId: launchStep.id, launchStepId: preStep.id };
}

function mergePreLinkIntoLaunchStep(demoScript) {
  if (!demoScript || !Array.isArray(demoScript.steps)) return null;
  const launchIdx = demoScript.steps.findIndex((s) => s && s.plaidPhase === 'launch');
  if (launchIdx <= 0) return null;
  const launchStep = demoScript.steps[launchIdx];
  const preLinkStep = demoScript.steps[launchIdx - 1];
  if (!isPreLinkExplainerStep(preLinkStep)) return null;

  if (!launchStep.interaction && preLinkStep.interaction) {
    launchStep.interaction = preLinkStep.interaction;
  }
  if (!launchStep.visualState && preLinkStep.visualState) {
    launchStep.visualState = preLinkStep.visualState;
  } else if (preLinkStep.visualState && launchStep.visualState) {
    launchStep.visualState = `${preLinkStep.visualState} Then ${launchStep.visualState}`;
  }
  if (!launchStep.label && preLinkStep.label) {
    launchStep.label = preLinkStep.label;
  }
  const preMs = Number(preLinkStep.durationHintMs || 0);
  const launchMs = Number(launchStep.durationHintMs || 0);
  if (preMs > 0 || launchMs > 0) {
    launchStep.durationHintMs = preMs + launchMs;
  }
  if (typeof launchStep.durationMs === 'number' || typeof preLinkStep.durationMs === 'number') {
    const preDurationMs = Number(preLinkStep.durationMs || 0);
    const launchDurationMs = Number(launchStep.durationMs || 0);
    launchStep.durationMs = preDurationMs + launchDurationMs;
  }

  demoScript.steps.splice(launchIdx - 1, 1);
  return { removedStepId: preLinkStep.id, launchStepId: launchStep.id };
}

/** Same 4-step window as validateDemoScript pre-link check — merges all explainers into launch (not only launchIdx-1). */
function mergeAllPreLinkExplainersBeforeLaunch(demoScript) {
  if (!demoScript || !Array.isArray(demoScript.steps)) return null;
  const launchIdx = demoScript.steps.findIndex((s) => s && s.plaidPhase === 'launch');
  if (launchIdx <= 0) return null;
  const windowStart = Math.max(0, launchIdx - 4);
  const entries = [];
  for (let i = windowStart; i < launchIdx; i++) {
    const step = demoScript.steps[i];
    if (isPreLinkExplainerStep(step)) entries.push({ idx: i, step });
  }
  if (entries.length === 0) return null;

  const launchStep = demoScript.steps[launchIdx];
  const vsParts = [];
  for (const { step } of entries) {
    if (step.visualState) vsParts.push(step.visualState);
  }
  if (launchStep.visualState) vsParts.push(launchStep.visualState);
  if (vsParts.length > 0) {
    launchStep.visualState = vsParts.join(' Then ');
  }
  if (!launchStep.label) {
    for (const { step } of entries) {
      if (step.label) {
        launchStep.label = step.label;
        break;
      }
    }
  }
  if (!launchStep.interaction) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const step = entries[i].step;
      if (step.interaction) {
        launchStep.interaction = step.interaction;
        break;
      }
    }
  }

  let hintMs = Number(launchStep.durationHintMs || 0);
  for (const { step } of entries) {
    hintMs += Number(step.durationHintMs || 0);
  }
  if (hintMs > 0) launchStep.durationHintMs = hintMs;

  let durSum = typeof launchStep.durationMs === 'number' ? launchStep.durationMs : 0;
  let anyDurMs = typeof launchStep.durationMs === 'number';
  for (const { step } of entries) {
    if (typeof step.durationMs === 'number') {
      anyDurMs = true;
      durSum += step.durationMs;
    }
  }
  if (anyDurMs) launchStep.durationMs = durSum;

  const indices = entries.map((e) => e.idx).sort((a, b) => b - a);
  const removedStepIds = [];
  for (const idx of indices) {
    removedStepIds.unshift(demoScript.steps[idx].id);
    demoScript.steps.splice(idx, 1);
  }
  return { removedStepIds, launchStepId: launchStep.id };
}

function extractTopValuePropositions(productResearch, maxItems = 3) {
  const candidates = [];
  const pushMany = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (typeof item !== 'string') continue;
      const cleaned = item.replace(/\s+/g, ' ').trim().replace(/^[-*]\s*/, '');
      if (cleaned) candidates.push(cleaned);
    }
  };
  pushMany(productResearch?.synthesizedInsights?.valuePropositions);
  pushMany(productResearch?.solutionsMasterValueProps);
  pushMany(productResearch?.solutionsMasterContext?.valuePropositionStatements);
  const seen = new Set();
  const deduped = [];
  for (const value of candidates) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
    if (deduped.length >= maxItems) break;
  }
  return deduped;
}

function buildValueSummaryNarration(valueProps) {
  const defaults = [
    'faster approvals with lower friction',
    'stronger account confidence before funds move',
    'safer funding decisions with clear auditability',
  ];
  const items = (Array.isArray(valueProps) && valueProps.length > 0 ? valueProps : defaults)
    .slice(0, 3)
    .map((v) => v.replace(/[.]+$/g, '').trim())
    .filter(Boolean);
  const summary = items.length >= 3
    ? `${items[0]}, ${items[1]}, and ${items[2]}`
    : items.join(' and ');
  return `Plaid closes with clear business value: ${summary}. The team moves faster with lower risk and a better customer approval experience.`;
}

function isValueSummaryStep(step) {
  if (!step) return false;
  const id = String(step.id || '').toLowerCase();
  const label = String(step.label || '').toLowerCase();
  const sceneType = String(step.sceneType || '').toLowerCase();
  if (sceneType === 'slide' && /\b(summary|value|outcome|wrap)\b/.test(label)) return true;
  return /\b(value-summary|summary-slide|plaid-outcome|final-summary)\b/.test(id);
}

function parseBoolEnv(val, fallback = false) {
  if (val === undefined || val === null || val === '') return fallback;
  const raw = String(val).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function resolveBuildPhaseSequenceForScript() {
  // The orchestrator's resolveBuildMode() expands PIPELINE_WITH_SLIDES into the
  // four legacy envs before this stage runs. Default sequence is 'app' (no
  // slides) when nothing is set — slides are strictly opt-in.
  const raw = String(process.env.BUILD_PHASE_SEQUENCE || 'app')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const appEnabled = parseBoolEnv(process.env.BUILD_PHASE_APP_ENABLED, true);
  const slidesEnabled = parseBoolEnv(process.env.BUILD_PHASE_SLIDES_ENABLED, false);
  const allowed = new Set();
  if (appEnabled) allowed.add('app');
  if (slidesEnabled) allowed.add('slides');
  const deduped = [];
  for (const mode of raw) {
    if (mode !== 'app' && mode !== 'slides') continue;
    if (!allowed.has(mode)) continue;
    if (!deduped.includes(mode)) deduped.push(mode);
  }
  if (deduped.length > 0) return deduped;
  if (appEnabled) return ['app'];
  if (slidesEnabled) return ['slides'];
  return ['app'];
}

function shouldRequireFinalValueSummarySlide() {
  // PIPELINE_WITH_SLIDES is the single source of truth (set by orchestrator's
  // resolveBuildMode). Falls through to legacy envs only for back-compat with
  // any external caller invoking generate-script.js standalone.
  const explicit = process.env.PIPELINE_WITH_SLIDES;
  if (explicit != null && String(explicit).trim() !== '') {
    return parseBoolEnv(explicit, false);
  }
  if (parseBoolEnv(process.env.SCRIPT_ZERO_SLIDE, false)) return false;
  if (parseBoolEnv(process.env.DEMO_MARKETING_SLIDE, false) === false) return false;
  const phases = resolveBuildPhaseSequenceForScript();
  return phases.includes('slides');
}

function ensureFinalValueSummarySlide(demoScript, productResearch) {
  if (!demoScript || !Array.isArray(demoScript.steps) || demoScript.steps.length === 0) return null;
  const topValueProps = extractTopValuePropositions(productResearch, 3);
  const narration = buildValueSummaryNarration(topValueProps);
  const visualBullets = (topValueProps.length ? topValueProps : [
    'Faster approvals',
    'Lower funding risk',
    'Better customer conversion',
  ]).slice(0, 3).join(' | ');
  const normalized = {
    id: 'value-summary-slide',
    label: 'Value Summary',
    sceneType: 'slide',
    narration,
    durationHintMs: 9000,
    visualState: `.slide-root final summary with top value propositions: ${visualBullets}. Emphasize user outcomes and next-step confidence.`,
  };

  const existingSummaries = demoScript.steps.filter((s) => isValueSummaryStep(s));
  const withoutSummaries = demoScript.steps.filter((s) => !isValueSummaryStep(s));
  let action = 'inserted';
  const pickNarration = (steps) => {
    for (let i = steps.length - 1; i >= 0; i--) {
      const n = steps[i]?.narration;
      if (typeof n === 'string' && n.trim()) return n;
    }
    return null;
  };
  const pickVisual = (steps) => {
    for (let i = steps.length - 1; i >= 0; i--) {
      const v = steps[i]?.visualState;
      if (typeof v === 'string' && v.trim()) return v;
    }
    return null;
  };
  const merged = {
    ...normalized,
    narration: pickNarration(existingSummaries) || normalized.narration,
    visualState: pickVisual(existingSummaries) || normalized.visualState,
  };
  delete merged.apiResponse;
  delete merged.plaidPhase;
  demoScript.steps = withoutSummaries;
  demoScript.steps.push(merged);
  if (existingSummaries.length > 1) action = 'deduped-to-final';
  else if (existingSummaries.length === 1) {
    const wasLast = demoScript.steps.indexOf(merged) === demoScript.steps.length - 1;
    action = wasLast ? 'normalized' : 'moved-to-final';
  }
  return { action, id: normalized.id };
}

/**
 * Prefill optional slide template hint fields on slide steps when the script
 * author omitted them. Router treats explicit fields as hard overrides.
 */
function enrichSlideTemplateHints(demoScript) {
  if (!demoScript || !Array.isArray(demoScript.steps)) return { steps: 0 };
  const slideSteps = demoScript.steps.filter(
    (s) => String(s?.sceneType || '').toLowerCase() === 'slide' || s?.stepKind === 'slide'
  );
  if (!slideSteps.length) return { steps: 0 };
  const recentLayouts = [];
  let touched = 0;
  for (let slideIdx = 0; slideIdx < slideSteps.length; slideIdx++) {
    const step = slideSteps[slideIdx];
    const hasAll = step.showcaseTemplateId && step.workhorseLayout && step.slideTemplate && step.slideCategory;
    if (hasAll) continue;
    const routing = routeSlideTemplate(step, {
      stepIndex: slideIdx,
      totalSlides: slideSteps.length,
      recentLayouts: recentLayouts.slice(-2),
    });
    if (routing?.workhorseLayout) recentLayouts.push(routing.workhorseLayout);
    let changed = false;
    if (!step.showcaseTemplateId && routing.templateId) {
      step.showcaseTemplateId = routing.templateId;
      changed = true;
    }
    if (!step.workhorseLayout && routing.workhorseLayout) {
      step.workhorseLayout = routing.workhorseLayout;
      changed = true;
    }
    if (!step.slideTemplate && routing.slideTemplate) {
      step.slideTemplate = routing.slideTemplate;
      changed = true;
    }
    if (!step.slideCategory && routing.category) {
      step.slideCategory = routing.category;
      changed = true;
    }
    if (changed) touched += 1;
  }
  return { steps: touched };
}

function validateDemoScript(demoScript, opts = {}) {
  const errors = [];
  const warnings = [];
  const steps = Array.isArray(demoScript?.steps) ? demoScript.steps : [];
  const plaidLinkLive = opts.plaidLinkLive === true;
  const layerUseCase = isLayerUseCase(demoScript);
  const productFamily = opts.productFamily || 'generic';
  const requireFinalValueSummarySlide = opts.requireFinalValueSummarySlide === true;
  const pipelineAppOnlyHostUi = opts.pipelineAppOnlyHostUi === true;

  const idCounts = new Map();
  for (const step of steps) {
    const sceneType = normalizeSceneType(step);
    if (step.sceneType !== sceneType) step.sceneType = sceneType;
    if (pipelineAppOnlyHostUi && (sceneType === 'insight' || sceneType === 'slide')) {
      errors.push(
        `Step "${step.id}" has sceneType "${sceneType}" but this is an app-only build. ` +
          `App-only demos must use sceneType "host" or "link" only — Plaid-branded interstitials are not allowed.`
      );
    }
    // App-only visualState leak check — plain-English customer UI only. Plaid
    // API names, score breakdowns, and "Powered by Plaid" attribution belong
    // in `narration` (voiceover), not in the on-screen UI description.
    if (pipelineAppOnlyHostUi && sceneType === 'host' && typeof step.visualState === 'string') {
      const vs = step.visualState;
      const leaks = [];
      // Plaid API product names on-screen.
      if (/\b(identity[\s-]*match|plaid[\s-]*signal|plaid[\s-]*auth|plaid[\s-]*layer|plaid[\s-]*check|plaid[\s-]*idv|plaid[\s-]*income)\b/i.test(vs)) {
        leaks.push('names a Plaid product on-screen');
      }
      // Plaid attribution / "Powered by Plaid" footers.
      if (/(powered\s+by\s+plaid|via\s+plaid(?:'s|\s+)?[a-z]+\s+(algorithm|check|score|match)|using\s+plaid|plaid-powered)/i.test(vs)) {
        leaks.push('contains Plaid attribution / "powered by" language');
      }
      // Score-grid / per-field match grids rendered on host. Covers the
      // common on-screen formats:
      //   "NAME 88 MATCH / ADDRESS 95 MATCH"  (field + score + label)
      //   "NAME 88, ADDRESS 95, PHONE 95"     (field + score, comma-sep grid)
      //   "scores.name_score 88"              (raw field name)
      //   "is_nickname_match true"            (raw boolean field)
      //   "ruleset.result ACCEPT"             (raw Signal outcome)
      if (/\b(name|address|city|state|zip|phone|email)[\s:]+\d{1,3}\b/i.test(vs)
          || /\b(match|format)\s+(flag|score)\b.*\d{1,3}/i.test(vs)
          || /\b(risk[\s-]*score|ruleset\.?result|ACCEPT\/REVIEW|bank[_\s-]?initiated[_\s-]?return)\b/i.test(vs)
          || /\b(customer|bank)[_\s-]initiated[_\s-]return[_\s-]risk\b/i.test(vs)
          || /\bis_(nickname|postal_code)_match\b/i.test(vs)
          || /\bscores\.(name|address|phone|email|legal_name|phone_number|email_address)/i.test(vs)) {
        leaks.push('describes API score breakdowns / raw API fields as on-screen UI');
      }
      if (leaks.length > 0) {
        warnings.push(
          `Step "${step.id}" (host): visualState ${leaks.join('; ')}. In app-only mode this content belongs in \`narration\`, not in the end-user UI. ` +
            `Rewrite visualState to describe plain customer-facing UI (e.g. "Ownership confirmed" title + verified badge + bank name + masked account + Continue) and move the Plaid / score language into the voiceover narration.`
        );
      }
    }
    if (sceneType === 'link' && step.plaidPhase !== 'launch') {
      if (layerUseCase) {
        warnings.push(`Step "${step.id}" uses sceneType "link" without plaidPhase:"launch" in a Layer flow; treating as Layer-native step.`);
      } else {
        errors.push(`Step "${step.id}" has sceneType "link" but is missing plaidPhase:"launch".`);
      }
    }
    if (sceneType === 'slide' && step.apiResponse?.endpoint && /\binsight\b/i.test([step?.id, step?.label].join(' '))) {
      warnings.push(`Step "${step.id}" is marked sceneType "slide" but looks like an insight step. Use sceneType "insight" unless .slide-root is intentional.`);
    }
    if (!step?.id) {
      errors.push('A step is missing an id.');
      continue;
    }
    idCounts.set(step.id, (idCounts.get(step.id) || 0) + 1);
    const action = step.interaction?.action;
    if ((action === 'click' || action === 'fill') && !step.interaction?.target) {
      errors.push(`Step "${step.id}" uses interaction action "${action}" but has no interaction.target.`);
    }
    if (isInsightLikeStep(step)) {
      if (!step.apiResponse?.endpoint) {
        errors.push(`Insight step "${step.id}" is missing apiResponse.endpoint.`);
      }
      if (!step.apiResponse?.response || typeof step.apiResponse.response !== 'object') {
        errors.push(`Insight step "${step.id}" is missing apiResponse.response.`);
      }
    } else if (step.apiResponse && (!step.apiResponse.endpoint || !step.apiResponse.response)) {
      errors.push(`Step "${step.id}" has an incomplete apiResponse block.`);
    }
    if (isValueSummaryStep(step) && step.apiResponse) {
      errors.push('value-summary-slide must not include apiResponse. Keep final summary narrative-only.');
    }
  }

  for (const [id, count] of idCounts.entries()) {
    if (count > 1) errors.push(`Duplicate step id "${id}" found ${count} times.`);
  }

  const indexByEndpoint = {};
  steps.forEach((step, idx) => {
    const endpoint = step.apiResponse?.endpoint || '';
    if (/\/identity\/match\b/i.test(endpoint)) indexByEndpoint.identity = idx;
    if (/\/auth\/get\b/i.test(endpoint)) indexByEndpoint.auth = idx;
    if (/\/signal\/evaluate\b/i.test(endpoint)) indexByEndpoint.signal = idx;
    if (/\/cra\/check_report\/base_report\/get\b/i.test(endpoint)) indexByEndpoint.baseReport = idx;
    if (/\/credit\/(?:bank_income\/get|payroll_income\/get)\b/i.test(endpoint)) indexByEndpoint.income = idx;
  });

  if (productFamily === 'funding') {
    // Note: the prior "Identity Match must appear before Auth" rule was lifted
    // (2026-05-26). The canonical production order is Auth → Identity Match →
    // Signal/Transfer because Signal and Transfer authorization both need the
    // `account_id` returned by Auth. Demos may surface Identity Match either
    // before or after Auth depending on the host-app narrative; the script's
    // natural order wins.
    if (indexByEndpoint.auth != null && indexByEndpoint.signal != null &&
        indexByEndpoint.auth > indexByEndpoint.signal) {
      errors.push('Auth must appear before Signal in the demo step order.');
    }
    if (indexByEndpoint.identity != null && indexByEndpoint.signal != null &&
        indexByEndpoint.identity > indexByEndpoint.signal) {
      errors.push('Identity Match must appear before Signal in the demo step order.');
    }
    if (indexByEndpoint.auth != null && indexByEndpoint.signal != null) {
      const amountIdx = steps.findIndex((step, idx) =>
        idx > indexByEndpoint.auth && idx < indexByEndpoint.signal && isAmountEntryStep(step));
      if (amountIdx === -1) {
        warnings.push('No amount-entry step was found between Auth and Signal. Funding demos usually need a host-app amount step before Signal.');
      }
    }
  }

  if (productFamily === 'cra_base_report') {
    const hasBaseReport = indexByEndpoint.baseReport != null;
    if (!hasBaseReport) {
      (pipelineAppOnlyHostUi ? warnings : errors).push('CRA Base Report demos should include an insight step with /cra/check_report/base_report/get.');
    }
    const hasReadyBeat = steps.some(step => {
      const haystack = [step?.id, step?.label, step?.narration, step?.visualState].filter(Boolean).join(' ').toLowerCase();
      return /\bready\b|\breport ready\b|\breport available\b|\bunderwriting review\b/.test(haystack);
    });
    if (!hasReadyBeat) {
      warnings.push('CRA Base Report demos usually need a report-ready or report-available beat before reviewing the Base Report.');
    }
  }

  if (productFamily === 'cash_advance_score') {
    const hasEwaEvaluate = steps.some((step) => {
      const ep = step.apiResponse?.endpoint || '';
      const body = JSON.stringify(step.apiResponse?.response || step.apiResponse || '');
      return /\/signal\/evaluate\b/i.test(ep) || /\bcash_advance_score\b/i.test(body);
    });
    if (!hasEwaEvaluate) {
      (pipelineAppOnlyHostUi ? warnings : errors).push(
        'EWA Score demos should include an insight step using POST /signal/evaluate with cash_advance_score in the response.'
      );
    }
  }

  if (productFamily === 'cra_cashflow_insights') {
    const hasCashflowEndpoint = steps.some((step) =>
      /\/cra\/check_report\/cashflow_insights\/get\b/i.test(step.apiResponse?.endpoint || '')
    );
    if (!hasCashflowEndpoint) {
      (pipelineAppOnlyHostUi ? warnings : errors).push(
        'CRA Cash Flow Insights demos should include an insight step using /cra/check_report/cashflow_insights/get.'
      );
    }
    const hasReadyBeat = steps.some((step) => {
      const haystack = [step?.id, step?.label, step?.narration, step?.visualState].filter(Boolean).join(' ').toLowerCase();
      return /\bready\b|\breport ready\b|\breport available\b|\bprocessing\b|\bgenerating\b/.test(haystack);
    });
    if (!hasReadyBeat) {
      warnings.push('CRA Cash Flow Insights demos usually need a report-ready beat before showing cashflow_insights/get.');
    }
  }

  if (productFamily === 'income_insights') {
    const hasIncomeEndpoint = steps.some(step => /\/cra\/check_report\/income_insights\/get\b/i.test(step.apiResponse?.endpoint || ''));
    // A demo can be mislabeled `income_insights` (CRA Income Insights) when it is
    // really Plaid **Bank Income** (/credit/bank_income/get) — a DIFFERENT product
    // family with no Consumer Report / async report-ready beat. Forcing the CRA
    // endpoint + ready-beat on a Bank Income demo is a false-positive hard error
    // (observed: Scrub.io "Bank Income + Assets" prompt declared family
    // income_insights). Detect the real Bank Income endpoints and treat the demo
    // as Bank Income instead of erroring.
    const isReallyBankIncome = steps.some(step =>
      /\/credit\/(?:bank_income|payroll_income)\b/i.test(step.apiResponse?.endpoint || '')
    );
    if (!hasIncomeEndpoint && isReallyBankIncome) {
      warnings.push('Demo declared family "income_insights" but uses Plaid Bank Income (/credit/bank_income/get), not CRA Income Insights (/cra/check_report/income_insights/get) — treating as Bank Income. Set the prompt\'s Primary product family to bank_income to silence this.');
    } else if (!hasIncomeEndpoint) {
      (pipelineAppOnlyHostUi ? warnings : errors).push('CRA Income Insights demos should include an insight step using /cra/check_report/income_insights/get.');
    }
    if (!isReallyBankIncome) {
      const hasReadyBeat = steps.some(step => {
        const haystack = [step?.id, step?.label, step?.narration, step?.visualState].filter(Boolean).join(' ').toLowerCase();
        return /\bready\b|\breport ready\b|\breport available\b|\bprocessing\b/.test(haystack);
      });
      if (!hasReadyBeat) {
        warnings.push('CRA Income Insights demos usually need a report-ready or report-available beat before showing retrieved income insights.');
      }
    }
  }

  // ── IDV authenticity ─────────────────────────────────────────────────────────
  // A demo that features Identity Verification must actually LAUNCH a real IDV
  // session (plaidPhase:"launch" resolving to IDV → /api/create-idv-link-token),
  // not merely assert a verdict on a host screen. Observed: Scrub.io rendered an
  // "identity-verified" host beat + /identity_verification/get with NO IDV launch
  // step, so the IDV session never ran. Warn (don't hard-error): some demos
  // intentionally simulate a prior IDV pass. Matches IDV specifically, not the
  // Identity (identity-match) product.
  const featuresIdv = steps.some((s) => {
    const ep = String(s.apiResponse?.endpoint || '');
    const txt = [s.id, s.label, s.narration, s.visualState].filter(Boolean).join(' ');
    return /\/identity_verification\b/i.test(ep) || /\bidentity[\s-]?verification\b|\bIDV\b/i.test(txt);
  });
  if (featuresIdv) {
    const hasIdvLaunch = steps.some((s) => s.plaidPhase === 'launch' && inferLaunchProduct(s) === 'idv');
    if (!hasIdvLaunch) {
      warnings.push(
        'Demo features Identity Verification but NO step launches a real IDV session ' +
        '(needs a plaidPhase:"launch" step resolving to IDV → /api/create-idv-link-token). ' +
        'An "identity-verified" host beat or a /identity_verification/get verdict implies a ' +
        'verification session that never actually runs. Add an IDV launch step, or relabel the ' +
        'beat so it does not claim a live IDV verification.'
      );
    }
  }

  const launchSteps = steps.filter(step => step.plaidPhase === 'launch');
  // Multi-launch allowed for DISTINCT Plaid sessions (Layer / IDV / CRA / Link).
  // Error only on duplicate launches of the SAME product (an accidental dupe that
  // would open two identical modals).
  if (launchSteps.length > 1) {
    const byProduct = {};
    for (const ls of launchSteps) {
      const p = inferLaunchProduct(ls);
      (byProduct[p] = byProduct[p] || []).push(ls.id || '(no-id)');
    }
    const dupes = Object.entries(byProduct).filter(([, ids]) => ids.length > 1);
    if (dupes.length) {
      errors.push(
        `Duplicate plaidPhase:"launch" steps for the same Plaid product: ` +
        `${dupes.map(([p, ids]) => `${p} (${ids.join(', ')})`).join('; ')}. ` +
        `Each launch must be a DISTINCT session (Layer / IDV / CRA / Link).`
      );
    }
  }
  // Plaid Link narration-boundary rule applies to every launch step.
  for (const ls of launchSteps) {
    const narration = ls.narration || '';
    if (/\b(plaid link opens|opens plaid link|clicks .*link|taps .*link|launches plaid link)\b/i.test(narration)) {
      errors.push(`Launch step "${ls.id}" narration violates the Plaid Link boundary rule. Narrate what is visible inside the modal, not the trigger action.`);
    }
  }
  if (plaidLinkLive && launchSteps.length === 0) {
    if (layerUseCase) {
      warnings.push('PLAID_LINK_LIVE=true with no plaidPhase:"launch" is allowed for Layer-native flows.');
    } else {
      errors.push('PLAID_LINK_LIVE=true requires exactly one step with plaidPhase:"launch".');
    }
  }
  if (launchSteps.length === 1) {
    const launchId = launchSteps[0].id;
    const launchIdx = steps.findIndex(s => s.id === launchId);
    // Only inspect the immediate lead-in to launch to avoid flagging generic onboarding steps.
    const preLaunchWindow = launchIdx > 0 ? steps.slice(Math.max(0, launchIdx - 4), launchIdx) : [];
    const preLinkExplainers = preLaunchWindow.filter((step) => {
      return isPreLinkExplainerStep(step);
    });
    if (preLinkExplainers.length > 0) {
      errors.push(
        `Standalone pre-Link explainer step(s) detected before launch step "${launchId}": ` +
        `${preLinkExplainers.map(s => s.id).join(', ')}. Merge pre-Link explainer + launch into one step.`
      );
    }
  }

  if (requireFinalValueSummarySlide && steps.length > 0) {
    const finalStep = steps[steps.length - 1];
    if (!isValueSummaryStep(finalStep)) {
      errors.push('Final step must be a value-summary slide with sceneType:"slide".');
    } else {
      if (String(finalStep.sceneType || '').toLowerCase() !== 'slide') {
        errors.push('Final value-summary step must use sceneType:"slide".');
      }
      const text = [finalStep.label, finalStep.narration, finalStep.visualState]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!/\bvalue|outcome|benefit|faster|lower risk|conversion|confidence\b/.test(text)) {
        warnings.push('Final value-summary slide should clearly state user/business value outcomes.');
      }
    }
  }

  return { errors, warnings, productFamily };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Validate inputs
  if (!fs.existsSync(INGESTED_FILE)) {
    console.error(`[Script] Missing: out/ingested-inputs.json — run ingest.js first`);
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[Script] Missing ANTHROPIC_API_KEY in environment');
    process.exit(1);
  }

  const ingestedInputs = JSON.parse(fs.readFileSync(INGESTED_FILE, 'utf8'));
  const promptEntry = Array.isArray(ingestedInputs.texts)
    ? ingestedInputs.texts.find(t => t && typeof t === 'object' && t.filename === 'prompt.txt')
    : null;
  const promptText = promptEntry?.content || promptEntry?.text || '';

  let productResearch = null;
  if (fs.existsSync(RESEARCH_FILE)) {
    try {
      productResearch = JSON.parse(fs.readFileSync(RESEARCH_FILE, 'utf8'));
      console.log('[Script] Loaded product-research.json');
    } catch (err) {
      console.warn(`[Script] Warning: could not parse product-research.json: ${err.message}`);
    }
  }

  const productFamily = inferProductFamily({ promptText, productResearch });
  const requireFinalValueSummarySlide = shouldRequireFinalValueSummarySlide();
  console.log(
    `[Script] Final marketing slide requirement: ${requireFinalValueSummarySlide ? 'ENABLED' : 'disabled'}`
  );
  const curatedProductKnowledge = buildCuratedProductKnowledge(productFamily);
  const curatedDigest = buildCuratedDigest(curatedProductKnowledge);
  const skillBundle = getPlaidSkillBundleForFamily(productFamily, { promptText });
  const skillMd = skillBundle.skillLoaded ? skillBundle.text : '';
  const linkUxSkillBundle = getPlaidLinkUxSkillBundle({ promptText });
  const linkUxSkillMd = linkUxSkillBundle.skillLoaded ? linkUxSkillBundle.text : '';
  const embeddedLinkSkillBundle = getEmbeddedLinkSkillBundle({ promptText });
  const embeddedLinkSkillMd = embeddedLinkSkillBundle.skillLoaded ? embeddedLinkSkillBundle.text : '';
  if (linkUxSkillBundle.skillLoaded) {
    console.log(`[Script] Plaid Link UX skill loaded (${linkUxSkillBundle.flowType} flow)`);
  }
  console.log(`[Script] Plaid Link mode detected from prompt: ${embeddedLinkSkillBundle.mode}`);
  writePlaidLinkUxSkillManifest(OUT_DIR, {
    stage: 'script',
    flowType: linkUxSkillBundle.flowType,
    markdownPath: linkUxSkillBundle.markdownPath,
    skillLoaded: linkUxSkillBundle.skillLoaded,
    chars: linkUxSkillBundle.chars,
  });

  const productResearchForPrompt =
    productResearch && typeof productResearch === 'object'
      ? {
        ...productResearch,
        productFamily,
        curatedProductKnowledge,
        curatedDigest,
        plaidSkillMarkdown: skillMd,
        plaidLinkUxSkillMarkdown: linkUxSkillMd,
        plaidLinkMode: embeddedLinkSkillBundle.mode,
        embeddedLinkSkillMarkdown: embeddedLinkSkillMd,
      }
      : {
        synthesizedInsights: {},
        internalKnowledge: [],
        apiSpec: {},
        productFamily,
        curatedProductKnowledge,
        curatedDigest,
        plaidSkillMarkdown: skillMd,
        plaidLinkUxSkillMarkdown: linkUxSkillMd,
        plaidLinkMode: embeddedLinkSkillBundle.mode,
        embeddedLinkSkillMarkdown: embeddedLinkSkillMd,
      };

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 300000 });

  console.log(`[Script] Calling Claude (${MODEL} with extended thinking + structured output)...`);

  // App-only runs: the prompt explicitly forbids insight/slide steps so the
  // generator stays in host-app territory. The manifest is the single source
  // of truth; we fall back to PIPELINE_WITH_SLIDES so standalone invocations
  // (`node scripts/.../generate-script.js`) still work.
  const pipelineAppOnlyHostUi = !requireFinalValueSummarySlide;

  // Build prompts from the shared template
  const { system: systemPrompt, userMessages } = buildScriptGenerationPrompt(
    ingestedInputs || { texts: [], screenshots: [], transcriptions: [] },
    productResearchForPrompt,
    { requireFinalValueSummarySlide, pipelineAppOnlyHostUi }
  );
  if (pipelineAppOnlyHostUi) {
    console.log('[Script] App-only run: script prompt forbids sceneType "insight" and "slide"');
  } else {
    // Detect prompt-level "no slides" directives that are stripped automatically
    // by buildScriptGenerationPrompt when --with-slides is on. Log a single
    // visible warning so operators know their prompt was overridden by the flag.
    const promptEntry = Array.isArray(ingestedInputs?.texts)
      ? ingestedInputs.texts.find((t) => t && typeof t === 'object' && t.filename === 'prompt.txt')
      : null;
    const rawPrompt = promptEntry?.content || promptEntry?.text || '';
    const noSlideHit =
      /NO[-\s]?SLIDE\s+REQUIREMENT/i.test(rawPrompt) ||
      /This demo is APP[- ]ONLY/i.test(rawPrompt) ||
      /Do not generate\s+`?sceneType[^`]*`?\s*[:=]?\s*['"]?slide/i.test(rawPrompt) ||
      /Do not add a final value[- ]summary slide/i.test(rawPrompt);
    if (noSlideHit) {
      console.warn(
        '[Script] App+slides run: prompt contains no-slides directives that were ' +
        'auto-stripped (NO-SLIDE REQUIREMENT / APP-ONLY / sceneType:"slide" forbids). ' +
        'Slide steps will be generated per --with-slides.'
      );
    }
  }

  // NOTE: The Anthropic API does NOT allow combining extended thinking with
  // tool_choice: { type: 'tool' } or { type: 'any' } — these force tool use and
  // are incompatible with thinking. We use tool_choice: 'auto' so the model can
  // think freely and then choose to call the tool (which it will, given the prompt).

  // Append a strong tool-use directive to the last user message so Claude
  // calls generate_demo_script instead of outputting JSON as text.
  const messagesWithToolDirective = [...userMessages];
  const last = messagesWithToolDirective[messagesWithToolDirective.length - 1];
  if (last && last.role === 'user') {
    const lastContent = Array.isArray(last.content)
      ? [...last.content, { type: 'text', text: '\n\nIMPORTANT: Call the generate_demo_script tool with your completed script. Do NOT output JSON as text.' }]
      : last.content + '\n\nIMPORTANT: Call the generate_demo_script tool with your completed script. Do NOT output JSON as text.';
    messagesWithToolDirective[messagesWithToolDirective.length - 1] = { ...last, content: lastContent };
  }

  // Opus 4.7 removed extended thinking (`type: "enabled"` + `budget_tokens`)
  // — must use adaptive thinking + output_config.effort. Script generation is
  // intelligence-sensitive (structured output with multi-constraint per beat),
  // so default to `high` effort; `xhigh` for stricter quality at higher cost.
  // Retry the generation when the model returns an incomplete script — under
  // overload the structured-output call has returned (a) no valid steps array
  // or (b) a truncated script missing the Plaid Link launch step. Both hard-
  // failed the whole run; a retry succeeds once the transient window passes.
  const SCRIPT_MAX_ATTEMPTS = Math.max(1, Number(process.env.SCRIPT_MAX_ATTEMPTS || 3));
  const requireLaunchStep = String(process.env.PLAID_LINK_LIVE || '').trim() === 'true';
  let demoScript = null;
  let lastReason = '';
  for (let attempt = 1; attempt <= SCRIPT_MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await client.messages.create({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        thinking:   { type: 'adaptive' },
        output_config: { effort: process.env.SCRIPT_EFFORT || 'high' },
        system:      systemPrompt,
        messages:    messagesWithToolDirective,
        tools:       [GENERATE_DEMO_SCRIPT_TOOL],
        tool_choice: { type: 'auto' },
      });
    } catch (err) {
      // The retry loop must also cover THROWN errors, not just incomplete
      // responses. Transient API conditions (request timeout, overloaded,
      // rate limit, 5xx, dropped socket) otherwise fail the whole script
      // stage on the first blip — observed as "Request timed out." ~30s in.
      lastReason = `API error: ${(err && err.message) || err}`;
      const transient = /timed out|timeout|overloaded|rate.?limit|too many requests|connection error|connection reset|connection refused|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|network|fetch failed|\b(408|429|500|502|503|529)\b/i.test(lastReason);
      console.warn(`[Script] Generation attempt ${attempt}/${SCRIPT_MAX_ATTEMPTS} threw (${lastReason})${transient && attempt < SCRIPT_MAX_ATTEMPTS ? ' — backing off and retrying…' : ''}`);
      if (transient && attempt < SCRIPT_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw err;
    }

    // Extract — prefer tool_use block (structured output), fall back to text.
    let candidate = null;
    const toolBlock = response.content.find(
      b => b.type === 'tool_use' && b.name === 'generate_demo_script'
    );
    if (toolBlock) {
      console.log(`[Script] Extracted demo script from tool_use block (structured output)${attempt > 1 ? ` (attempt ${attempt})` : ''}.`);
      candidate = toolBlock.input;
    } else {
      console.warn('[Script] No tool_use block found — falling back to text extraction.');
      try { candidate = extractJSON(response.content); } catch (err) { lastReason = err.message; candidate = null; }
    }

    // Completeness gate (mirrors the downstream validations that used to hard-exit).
    if (!candidate || !candidate.steps || !Array.isArray(candidate.steps) || candidate.steps.length === 0) {
      lastReason = lastReason || 'no valid steps array';
    } else if (requireLaunchStep && !candidate.steps.some(s => s && (s.plaidPhase === 'launch' || s.sceneType === 'link'))) {
      lastReason = 'no Plaid Link launch step (plaidPhase:"launch" / sceneType:"link")';
    } else {
      demoScript = candidate;
      break;
    }
    console.warn(`[Script] Generation attempt ${attempt}/${SCRIPT_MAX_ATTEMPTS} incomplete (${lastReason})${attempt < SCRIPT_MAX_ATTEMPTS ? ' — retrying…' : ''}`);
  }

  if (!demoScript) {
    console.error(`[Script] Claude response did not contain a complete script after ${SCRIPT_MAX_ATTEMPTS} attempt(s): ${lastReason}`);
    process.exit(1);
  }
  demoScript.plaidLinkMode = embeddedLinkSkillBundle.mode;

  const preLaunchAutoFix = autoFixDemoScript(demoScript);
  if (preLaunchAutoFix.fixed > 0) {
    console.warn(`[Script] Auto-fixed ${preLaunchAutoFix.fixed} script issue(s) before launch normalization:`);
    for (const f of preLaunchAutoFix.fixes) {
      console.warn(`  · ${f.stepId} — ${f.rule}: ${f.before} → ${f.after}`);
    }
  }

  const mergedEmbedded = mergeEmbeddedPreLinkSplit(demoScript);
  if (mergedEmbedded) {
    console.log(
      `[Script] Merged embedded pre-link "${mergedEmbedded.launchStepId}" with separate launch ` +
        `"${mergedEmbedded.removedStepId}" into one integrated launch step.`
    );
  }

  const mergedLaunch = mergeAllPreLinkExplainersBeforeLaunch(demoScript);
  if (mergedLaunch) {
    console.log(
      `[Script] Merged pre-Link explainer step(s) [${mergedLaunch.removedStepIds.join(', ')}] into launch "${mergedLaunch.launchStepId}".`
    );
  }
  const canonicalLaunchId = enforceCanonicalLaunchInteraction(demoScript);
  if (canonicalLaunchId) {
    const modeLabel =
      String(demoScript.plaidLinkMode || '').toLowerCase() === 'embedded'
        ? 'goToStep → launch step id'
        : 'data-testid="link-external-account-btn"';
    console.log(`[Script] Normalized launch interaction target for "${canonicalLaunchId}" (${modeLabel}).`);
  }
  if (requireFinalValueSummarySlide) {
    const summarySlide = ensureFinalValueSummarySlide(demoScript, productResearchForPrompt);
    if (summarySlide) {
      console.log(`[Script] Final value summary slide ${summarySlide.action} (${summarySlide.id}).`);
    }
  } else {
    // Zero-slide mode: strip sceneType:"slide" steps. BUT: the LLM often
    // mislabels API-insight steps (Plaid endpoint responses rendered with the
    // slide shell template) as sceneType:"slide" when they should be
    // sceneType:"insight". Before stripping, promote any slide step carrying
    // an apiResponse.endpoint to "insight" so we don't accidentally drop the
    // canonical API insight screens (e.g., /cra/check_report/income_insights/get
    // required by CRA Income Insights demos).
    let promotedCount = 0;
    for (const step of demoScript.steps) {
      const sceneType = String(step?.sceneType || '').toLowerCase();
      if (sceneType !== 'slide') continue;
      if (isValueSummaryStep(step)) continue;
      if (step?.apiResponse?.endpoint) {
        step.sceneType = 'insight';
        promotedCount += 1;
      }
    }
    if (promotedCount > 0) {
      console.log(
        `[Script] Zero-slide mode: promoted ${promotedCount} API-carrying slide step(s) to "insight" ` +
        `to preserve Plaid endpoint coverage (e.g. CRA income_insights).`
      );
    }
    const originalCount = demoScript.steps.length;
    demoScript.steps = demoScript.steps.filter((step) => {
      const sceneType = String(step?.sceneType || '').toLowerCase();
      if (sceneType === 'slide') return false;
      if (isValueSummaryStep(step)) return false;
      return true;
    });
    const removedCount = Math.max(0, originalCount - demoScript.steps.length);
    if (removedCount > 0) {
      console.log(`[Script] Zero-slide mode removed ${removedCount} slide step(s) from demo script.`);
    }
  }

  // ── Narration word count validation ───────────────────────────────────────
  // CLAUDE.md spec: 20–35 words per step narration (fits ~8–12s of speech at 150 wpm)
  // We enforce 8–35 here (8 as floor to catch accidental one-liners).
  const narrationErrors = [];
  for (const step of demoScript.steps) {
    if (step.narration) {
      const words = step.narration.trim().split(/\s+/).length;
      if (words > 35) {
        narrationErrors.push(`  Step "${step.id}": narration has ${words} words (max 35)`);
      } else if (words < 8) {
        narrationErrors.push(`  Step "${step.id}": narration has ${words} words (min 8)`);
      }
    }
  }
  if (narrationErrors.length > 0) {
    console.warn('[Script] Narration word count issues:');
    narrationErrors.forEach(e => console.warn(e));
    if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
      await waitForApproval('\nNarration lengths are outside 8–35 word range. Press ENTER to continue with current narrations, or Ctrl+C to abort and regenerate...');
    } else {
      console.warn('[Script] SCRATCH_AUTO_APPROVE=true — continuing with out-of-range narrations.');
    }
  }

  // Auto-repair narrations that violate the Plaid Link boundary rule BEFORE
  // validation runs. CLAUDE.md requires the Plaid Link launch step to narrate
  // what is visible inside the modal (institution picker / account select /
  // success handoff), NOT the button-click that opens it. The LLM sometimes
  // forgets and writes "Elena taps Link Bank Account. Plaid Link opens...".
  // Rather than hard-failing and losing a ~90s research run, strip the
  // trigger-phrase sentence and keep the rest.
  {
    const launch = demoScript.steps.find((s) => s && s.plaidPhase === 'launch');
    if (launch && typeof launch.narration === 'string') {
      const original = launch.narration;
      const TRIGGER_PATTERNS = [
        /\b(plaid link opens|opens plaid link|launches plaid link)[^.?!]*[.?!]?\s*/gi,
        /\b(clicks?|taps?|presses?|selects?|hits?)\s+[^.?!]*\b(link bank|connect bank|link (?:my |her |his |your )?(?:external )?account|link (?:my |her |his |your )?bank|add (?:external )?bank|add (?:my |her |his |your )?bank|continue with bank)[^.?!]*[.?!]?\s*/gi,
      ];
      let rewritten = original;
      for (const re of TRIGGER_PATTERNS) rewritten = rewritten.replace(re, '');
      rewritten = rewritten.replace(/\s{2,}/g, ' ').trim();
      if (rewritten && rewritten !== original && rewritten.split(/\s+/).length >= 6) {
        launch.narration = rewritten;
        console.warn(
          `[Script] Auto-repaired Plaid Link boundary-rule violation on step "${launch.id}". ` +
          `Removed trigger-action sentence(s) so narration describes modal content only.`
        );
      }
    }
  }

  // App-only safety net: if the LLM still produced any Plaid-branded
  // interstitial (sceneType: insight | slide) despite the explicit prompt,
  // strip them BEFORE validation so a prompt-adherence glitch doesn't hard
  // fail the whole run. The customer-facing host flow stands on its own;
  // narration about API calls happens inline, not via dedicated Plaid-chrome
  // screens.
  if (pipelineAppOnlyHostUi && Array.isArray(demoScript.steps)) {
    const dropped = [];
    demoScript.steps = demoScript.steps.filter((s) => {
      const t = String(s && s.sceneType || '').toLowerCase();
      if (t === 'insight' || t === 'slide') {
        dropped.push({ id: s && s.id, sceneType: t });
        return false;
      }
      // apiResponse blocks only belong on insight/slide steps, which don't
      // exist in app-only mode. Strip any leftovers so the build stage knows
      // there is no JSON rail to hydrate.
      if (s && s.apiResponse) delete s.apiResponse;
      return true;
    });
    if (dropped.length > 0) {
      console.warn(
        `[Script] App-only safety net dropped ${dropped.length} non-host step(s): ` +
          dropped.map((d) => `${d.id} (${d.sceneType})`).join(', ')
      );
      console.warn('[Script] Review the remaining host flow for narrative continuity.');
    }
  }

  // Deterministic auto-fix pass — catches the LLM's most common slide vs.
  // insight mis-classification (e.g. a marketing slide labelled
  // `sceneType: "insight"` without any `apiResponse`). Runs BEFORE validation
  // so unambiguous LLM mistakes don't kill the orchestrator. Anything that
  // can't be auto-fixed (multiple steps with the same id, unknown product
  // family endpoints, etc.) still falls through to validateDemoScript's
  // error path.
  const autoFix = autoFixDemoScript(demoScript);
  if (autoFix.fixed > 0) {
    console.warn(`[Script] Auto-fixed ${autoFix.fixed} script issue(s) before validation:`);
    for (const f of autoFix.fixes) {
      console.warn(`  · ${f.stepId} — ${f.rule}: ${f.before} → ${f.after}`);
    }
  }

  const slideHints = enrichSlideTemplateHints(demoScript);
  if (slideHints.steps > 0) {
    console.log(`[Script] Prefilled showcase template hints on ${slideHints.steps} slide step(s).`);
  }

  const launchIdAfterFix = enforceCanonicalLaunchInteraction(demoScript);
  if (launchIdAfterFix) {
    const mode = String(demoScript.plaidLinkMode || '').toLowerCase() === 'embedded' ? 'goToStep' : 'click';
    console.log(`[Script] Normalized launch interaction for "${launchIdAfterFix}" (${mode}).`);
  }

  // ── Required Plaid Link launch step ───────────────────────────────────────
  if (process.env.PLAID_LINK_LIVE === 'true') {
    let launchStep = demoScript.steps.find(s => s.plaidPhase === 'launch');
    if (!launchStep) {
      const rescue = autoFixDemoScript(demoScript);
      if (rescue.fixed > 0) {
        console.warn(`[Script] Launch rescue auto-fixed ${rescue.fixed} issue(s):`);
        for (const f of rescue.fixes) {
          console.warn(`  · ${f.stepId} — ${f.rule}: ${f.before} → ${f.after}`);
        }
        enforceCanonicalLaunchInteraction(demoScript);
        launchStep = demoScript.steps.find(s => s.plaidPhase === 'launch');
      }
    }
    if (!launchStep) {
      const steps = (demoScript.steps || []).filter((s) => {
        if (!s || isValueSummaryStep(s)) return false;
        const scene = String(s.sceneType || '').toLowerCase();
        if (scene === 'slide') return false;
        return true;
      });
      const score = (step) => {
        const text = [step.id, step.label, step.visualState, step.narration].filter(Boolean).join(' ').toLowerCase();
        let n = 0;
        if (/plaid-embedded-link-container|institution search/.test(text)) n += 100;
        if (/\b(plaid link|embedded link|link external|external account|connect.*bank)\b/.test(text)) n += 70;
        if (/\blink\b/.test(String(step.id || '').toLowerCase())) n += 40;
        if (String(step.sceneType || '').toLowerCase() === 'host') n += 10;
        return n;
      };
      let best = null;
      let bestScore = 0;
      for (const s of steps) {
        const sc = score(s);
        if (sc > bestScore) {
          bestScore = sc;
          best = s;
        }
      }
      if (best && bestScore >= 30) {
        best.plaidPhase = 'launch';
        best.sceneType = 'link';
        enforceCanonicalLaunchInteraction(demoScript);
        launchStep = best;
        console.warn(
          `[Script] Emergency launch assign on "${best.id}" (score=${bestScore}) — LLM omitted plaidPhase:"launch".`
        );
      }
    }
    if (!launchStep) {
      if (isLayerUseCase(demoScript)) {
        console.log('[Script] No plaidPhase:"launch" step found; allowing Layer-native flow without launch step.');
      } else {
        try {
          fs.writeFileSync(
            path.join(OUT_DIR, 'demo-script.failed.json'),
            JSON.stringify(demoScript, null, 2)
          );
        } catch (_) { /* ignore */ }
        console.error('[Script] No step with plaidPhase:"launch" found in demo-script.json.');
        console.error('[Script] Steps in failed script:');
        for (const s of demoScript.steps || []) {
          console.error(
            `  · ${s.id || '(no-id)'}: sceneType=${s.sceneType || '?'} plaidPhase=${s.plaidPhase || '(none)'}`
          );
        }
        console.error('[Script] Wrote out/demo-script.failed.json — add plaidPhase:"launch" to the Link step.');
        process.exit(1);
      }
    } else {
      console.log(`[Script] Plaid launch step: "${launchStep.id}" (plaidPhase: launch) ✓`);
    }
  }

  const scriptValidation = validateDemoScript(demoScript, {
    plaidLinkLive: process.env.PLAID_LINK_LIVE === 'true',
    productFamily,
    requireFinalValueSummarySlide,
    pipelineAppOnlyHostUi,
  });
  if (scriptValidation.errors.length > 0) {
    // After auto-fix, any remaining errors are genuinely structural — log,
    // surface to the orchestrator's recovery flow, and exit non-zero. The
    // operator can re-run `npm run pipe -- stage script <RUN_ID>` to re-roll
    // the LLM with the same prompt.
    console.error('[Script] Demo script validation failed (after auto-fix pass):');
    scriptValidation.errors.forEach(e => console.error(`  ✗ ${e}`));
    console.error(
      '[Script] Hint: this is usually fixed by editing inputs/prompt.txt to be more ' +
      'explicit about slide vs. insight beats, then re-running `npm run pipe -- stage script <RUN_ID>`.'
    );
    process.exit(1);
  }
  if (scriptValidation.warnings.length > 0) {
    console.warn('[Script] Demo script validation warnings:');
    scriptValidation.warnings.forEach(w => console.warn(`  ! ${w}`));
    if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
      await waitForApproval('\nDemo script validation warnings were found. Press ENTER to continue, or Ctrl+C to abort and revise...');
    }
  }

  const { counts: stepKindCounts } = annotateScriptWithStepKinds(demoScript);
  console.log(
    `[Script] stepKind annotated: ${stepKindCounts.app} app / ${stepKindCounts.slide} slide`
  );

  fs.writeFileSync(OUT_FILE, JSON.stringify(demoScript, null, 2));

  try {
    const prMerged = {
      ...(productResearch && typeof productResearch === 'object' ? productResearch : {}),
      productFamily,
      curatedProductKnowledge,
      curatedDigest,
    };
    writePipelineRunContext(
      OUT_DIR,
      buildRunContextPayload({
        phase: 'post-script',
        productFamily,
        productResearch: prMerged,
        demoScript,
        promptText,
      })
    );
    if (fs.existsSync(RESEARCH_FILE) && productResearch && typeof productResearch === 'object') {
      fs.writeFileSync(RESEARCH_FILE, JSON.stringify(prMerged, null, 2));
    }
  } catch (e) {
    console.warn(`[Script] Could not update pipeline run context / product-research: ${e.message}`);
  }

  const stepCount       = demoScript.steps.length;
  const estimatedSeconds = demoScript.steps.reduce((sum, s) => sum + (s.durationHintMs || 0), 0) / 1000;

  console.log(`[Script] Generated: ${stepCount} steps, ~${estimatedSeconds.toFixed(0)}s estimated`);
  console.log(`[Script] Written: out/demo-script.json`);

  // ── Post-script agent handoff ──────────────────────────────────────────────
  // When PIPE_AGENT_HANDOFF=true, write a high-level summary + structured
  // options into the run dir's handoffs/ subdirectory, then block until the
  // operator resolves it via the /pipe-handoff slash command in Claude Code
  // (or by writing recovery-plan.json directly). Falls through to the
  // legacy terminal-pause path otherwise.
  const { pauseForHandoff, isHandoffEnabled } = require('../utils/pipeline-handoff');
  const { buildScriptSummary } = require('../utils/script-summary');
  if (isHandoffEnabled()) {
    const summaryMd = buildScriptSummary(demoScript, {
      runId: path.basename(OUT_DIR),
      productFamily,
      buildMode: stepKindCounts.slide > 0 ? 'app+slides' : 'app-only',
    });
    const plan = await pauseForHandoff({
      runDir: OUT_DIR,
      checkpoint: 'post-script',
      summaryMarkdown: summaryMd,
      options: [
        {
          id: 'confirm',
          label: 'Confirm — proceed to build',
          description: 'Continue the pipeline through brand-extract, build, and build-qa.',
          action: 'continue',
          recommended: true,
        },
        {
          id: 'modify',
          label: 'Modify — describe changes',
          description: 'Provide free-text instructions; appended to inputs/prompt.txt and the script stage is re-run.',
          action: 'modify',
        },
        {
          id: 'abort',
          label: 'Abort — stop the pipeline',
          description: 'Exit; demo-script.json stays on disk for inspection.',
          action: 'abort',
        },
      ],
    });
    if (plan.action === 'abort') {
      console.error(`[Script] Handoff: operator chose abort — halting pipeline. (source=${plan.source})`);
      process.exit(1);
    }
    if (plan.action === 'modify') {
      const instructions = (plan.instructions || '').trim();
      if (!instructions) {
        console.error('[Script] Handoff: modify chosen but no instructions provided — aborting.');
        process.exit(1);
      }
      // Append the operator's instructions to inputs/prompt.txt under a marked
      // block so a subsequent script-stage re-run incorporates them. We exit
      // with a non-zero code so the orchestrator surfaces the halt; the
      // operator (or the agent) then re-invokes `npm run pipe -- stage script`.
      const promptPath = path.join(__dirname, '..', '..', '..', 'inputs', 'prompt.txt');
      try {
        const stamp = new Date().toISOString();
        const block = `\n\n### Operator modifications (${stamp})\n${instructions}\n`;
        fs.appendFileSync(promptPath, block, 'utf8');
        console.log(`[Script] Handoff: appended modify instructions to inputs/prompt.txt.`);
        console.log(`[Script] Handoff: re-run with \`npm run pipe -- stage script ${path.basename(OUT_DIR)}\` (or restart from --from=script) to regenerate.`);
      } catch (err) {
        console.error(`[Script] Could not append to prompt.txt: ${err.message}`);
      }
      process.exit(75); // EX_TEMPFAIL: "user action required, retry"
    }
    console.log(`[Script] Handoff: confirmed (source=${plan.source}) — proceeding to build-app`);
  } else if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
    await waitForApproval(
      '\nReview out/demo-script.json and press ENTER to continue (CTRL+C to abort and edit)...'
    );
  }

  console.log('[Script] Approved — proceeding to build-app');
}

module.exports = {
  main,
  validateDemoScript,
  autoFixDemoScript,
  isInsightLikeStep,
  isAmountEntryStep,
  inferLaunchProduct,
  normalizeSceneType,
  enforceCanonicalLaunchInteraction,
  isPreLinkExplainerStep,
  isEmbeddedPreLinkHostStep,
  mergePreLinkIntoLaunchStep,
  mergeAllPreLinkExplainersBeforeLaunch,
  mergeEmbeddedPreLinkSplit,
  extractTopValuePropositions,
  buildValueSummaryNarration,
  isValueSummaryStep,
  ensureFinalValueSummarySlide,
  enrichSlideTemplateHints,
};

if (require.main === module) {
  main().catch(err => {
    console.error('[Script] Fatal error:', err.message);
    process.exit(1);
  });
}
