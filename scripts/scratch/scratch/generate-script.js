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

require('dotenv').config({ override: true });
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

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT    = path.resolve(__dirname, '../../..');
const OUT_DIR         = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const INGESTED_FILE   = path.join(OUT_DIR, 'ingested-inputs.json');
const RESEARCH_FILE   = path.join(OUT_DIR, 'product-research.json');
const OUT_FILE        = path.join(OUT_DIR, 'demo-script.json');

// ── Model config ──────────────────────────────────────────────────────────────

const MODEL          = 'claude-opus-4-7';
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
  if (String(step?.sceneType || '').toLowerCase() === 'insight') return true;
  const haystack = [step?.id, step?.label, step?.visualState].filter(Boolean).join(' ').toLowerCase();
  return /\binsight\b|\bapi insight\b|\bplaid insight\b/.test(haystack);
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

function isLayerUseCase(demoScript) {
  if (!demoScript || !Array.isArray(demoScript.steps)) return false;
  const header = [demoScript.title, demoScript.product].filter(Boolean).join(' ').toLowerCase();
  if (/\bplaid layer\b/.test(header)) return true;
  const stepsText = demoScript.steps
    .map((step) => [step?.id, step?.label, step?.narration, step?.visualState].filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();
  // Keep broad "layer" matching for backwards compatibility with existing step IDs
  // like "layer-launch" and "layer-confirm" in mobile Layer demos.
  return /\blayer\b/.test(`${header} ${stepsText}`);
}

function enforceCanonicalLaunchInteraction(demoScript) {
  if (!demoScript || !Array.isArray(demoScript.steps)) return null;
  const launchStep = demoScript.steps.find((s) => s && s.plaidPhase === 'launch');
  if (!launchStep) return null;
  launchStep.sceneType = 'link';
  launchStep.interaction = launchStep.interaction || {};
  launchStep.interaction.action = 'click';
  launchStep.interaction.target = 'link-external-account-btn';
  launchStep.interaction.waitMs = 120000;
  return launchStep.id || null;
}

function isPreLinkExplainerStep(step) {
  if (!step || step.plaidPhase === 'launch') return false;
  if (step.apiResponse?.endpoint) return false;
  const text = [step?.id, step?.label, step?.narration, step?.visualState]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /\b(pre[-\s]?link|link (?:your )?bank|connect (?:your )?bank|add (?:a )?bank(?: account)?|open plaid|launch plaid|continue with plaid|link externally)\b/.test(text);
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

  const idx = demoScript.steps.findIndex((s) => isValueSummaryStep(s));
  let action = 'inserted';
  if (idx >= 0) {
    const existing = demoScript.steps[idx] || {};
    const merged = {
      ...existing,
      ...normalized,
      narration: typeof existing.narration === 'string' && existing.narration.trim()
        ? existing.narration
        : normalized.narration,
      visualState: typeof existing.visualState === 'string' && existing.visualState.trim()
        ? existing.visualState
        : normalized.visualState,
    };
    delete merged.apiResponse;
    delete merged.plaidPhase;
    demoScript.steps.splice(idx, 1);
    demoScript.steps.push(merged);
    action = idx === demoScript.steps.length - 1 ? 'normalized' : 'moved-to-final';
  } else {
    demoScript.steps.push(normalized);
  }
  return { action, id: normalized.id };
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
    if (indexByEndpoint.identity != null && indexByEndpoint.auth != null &&
        indexByEndpoint.identity > indexByEndpoint.auth) {
      errors.push('Identity Match must appear before Auth in the demo step order.');
    }
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
      errors.push('CRA Base Report demos should include an insight step with /cra/check_report/base_report/get.');
    }
    const hasReadyBeat = steps.some(step => {
      const haystack = [step?.id, step?.label, step?.narration, step?.visualState].filter(Boolean).join(' ').toLowerCase();
      return /\bready\b|\breport ready\b|\breport available\b|\bunderwriting review\b/.test(haystack);
    });
    if (!hasReadyBeat) {
      warnings.push('CRA Base Report demos usually need a report-ready or report-available beat before reviewing the Base Report.');
    }
  }

  if (productFamily === 'income_insights') {
    const hasIncomeEndpoint = steps.some(step => /\/cra\/check_report\/income_insights\/get\b/i.test(step.apiResponse?.endpoint || ''));
    if (!hasIncomeEndpoint) {
      errors.push('CRA Income Insights demos should include an insight step using /cra/check_report/income_insights/get.');
    }
    const hasReadyBeat = steps.some(step => {
      const haystack = [step?.id, step?.label, step?.narration, step?.visualState].filter(Boolean).join(' ').toLowerCase();
      return /\bready\b|\breport ready\b|\breport available\b|\bprocessing\b/.test(haystack);
    });
    if (!hasReadyBeat) {
      warnings.push('CRA Income Insights demos usually need a report-ready or report-available beat before showing retrieved income insights.');
    }
  }

  const launchSteps = steps.filter(step => step.plaidPhase === 'launch');
  if (launchSteps.length > 1) {
    errors.push(`Multiple plaidPhase:"launch" steps found (${launchSteps.map(s => s.id).join(', ')}). Use exactly one launch step.`);
  }
  if (launchSteps.length === 1) {
    const narration = launchSteps[0].narration || '';
    if (/\b(plaid link opens|opens plaid link|clicks .*link|taps .*link|launches plaid link)\b/i.test(narration)) {
      errors.push(`Launch step "${launchSteps[0].id}" narration violates the Plaid Link boundary rule. Narrate what is visible inside the modal, not the trigger action.`);
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

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log('[Script] Calling Claude (claude-opus-4-7 with extended thinking + structured output)...');

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

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    thinking: {
      type: 'adaptive',
    },
    output_config: {
      effort: 'high',
    },
    system:      systemPrompt,
    messages:    messagesWithToolDirective,
    tools:       [GENERATE_DEMO_SCRIPT_TOOL],
    tool_choice: { type: 'auto' },
  });

  // Extract demo script — prefer tool_use block (structured output), fall back to text extraction
  let demoScript;
  const toolBlock = response.content.find(
    b => b.type === 'tool_use' && b.name === 'generate_demo_script'
  );

  if (toolBlock) {
    console.log('[Script] Extracted demo script from tool_use block (structured output).');
    demoScript = toolBlock.input;
  } else {
    console.warn('[Script] No tool_use block found — falling back to text extraction.');
    try {
      demoScript = extractJSON(response.content);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // Validate minimum structure
  if (!demoScript.steps || !Array.isArray(demoScript.steps) || demoScript.steps.length === 0) {
    console.error('[Script] Claude response did not contain valid steps array');
    process.exit(1);
  }
  demoScript.plaidLinkMode = embeddedLinkSkillBundle.mode;

  const mergedLaunch = mergeAllPreLinkExplainersBeforeLaunch(demoScript);
  if (mergedLaunch) {
    console.log(
      `[Script] Merged pre-Link explainer step(s) [${mergedLaunch.removedStepIds.join(', ')}] into launch "${mergedLaunch.launchStepId}".`
    );
  }
  const canonicalLaunchId = enforceCanonicalLaunchInteraction(demoScript);
  if (canonicalLaunchId) {
    console.log(`[Script] Normalized launch interaction target for "${canonicalLaunchId}" to data-testid="link-external-account-btn".`);
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

  // ── Required Plaid Link launch step ───────────────────────────────────────
  // When PLAID_LINK_LIVE=true, at least one step must have plaidPhase:"launch".
  // record-local.js uses this to run the full CDP Plaid Link automation and wait
  // for _plaidLinkComplete without an overrun timer killing the step early.
  //
  // The script agent should produce a SINGLE Plaid Link step (e.g. "wf-link-launch")
  // with plaidPhase:"launch" — NOT four separate link-consent/otp/account/success sub-steps.
  // The no-capture build mode renders the real Plaid iframe (visible in headless:false).
  if (process.env.PLAID_LINK_LIVE === 'true') {
    const launchStep = demoScript.steps.find(s => s.plaidPhase === 'launch');
    if (!launchStep) {
      if (isLayerUseCase(demoScript)) {
        console.log('[Script] No plaidPhase:"launch" step found; allowing Layer-native flow without launch step.');
      } else {
        console.error('[Script] No step with plaidPhase:"launch" found in demo-script.json.');
        console.error('[Script] Add plaidPhase:"launch" to the step that opens Plaid Link.');
        process.exit(1);
      }
    } else {
      console.log(`[Script] Plaid launch step: "${launchStep.id}" (plaidPhase: launch) ✓`);
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

  const scriptValidation = validateDemoScript(demoScript, {
    plaidLinkLive: process.env.PLAID_LINK_LIVE === 'true',
    productFamily,
    requireFinalValueSummarySlide,
    pipelineAppOnlyHostUi,
  });
  if (scriptValidation.errors.length > 0) {
    console.error('[Script] Demo script validation failed:');
    scriptValidation.errors.forEach(e => console.error(`  ✗ ${e}`));
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

  // Pause for human review unless auto-approved
  if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
    await waitForApproval(
      '\nReview out/demo-script.json and press ENTER to continue (CTRL+C to abort and edit)...'
    );
  }

  console.log('[Script] Approved — proceeding to build-app');
}

module.exports = {
  main,
  validateDemoScript,
  isInsightLikeStep,
  isAmountEntryStep,
  normalizeSceneType,
  enforceCanonicalLaunchInteraction,
  isPreLinkExplainerStep,
  mergePreLinkIntoLaunchStep,
  mergeAllPreLinkExplainersBeforeLaunch,
  extractTopValuePropositions,
  buildValueSummaryNarration,
  isValueSummaryStep,
  ensureFinalValueSummarySlide,
};

if (require.main === module) {
  main().catch(err => {
    console.error('[Script] Fatal error:', err.message);
    process.exit(1);
  });
}
