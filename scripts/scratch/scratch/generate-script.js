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
const { buildCuratedProductKnowledge, buildCuratedDigest } = require('../utils/product-knowledge');
const { writePipelineRunContext, buildRunContextPayload } = require('../utils/run-context');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT    = path.resolve(__dirname, '../../..');
const OUT_DIR         = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const INGESTED_FILE   = path.join(OUT_DIR, 'ingested-inputs.json');
const RESEARCH_FILE   = path.join(OUT_DIR, 'product-research.json');
const OUT_FILE        = path.join(OUT_DIR, 'demo-script.json');

// ── Model config ──────────────────────────────────────────────────────────────

const MODEL          = 'claude-opus-4-6';
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
        description: 'Optional sandbox credentials / config for Plaid Link recording',
      },
      steps: {
        type: 'array',
        description: 'Ordered list of demo steps (8–14 steps, each 20–35 words narration)',
        items: {
          type: 'object',
          properties: {
            id:              { type: 'string', description: 'kebab-case step identifier' },
            label:           { type: 'string' },
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
  const haystack = [step?.id, step?.label, step?.visualState].filter(Boolean).join(' ').toLowerCase();
  return /\binsight\b|\bapi insight\b|\bplaid insight\b/.test(haystack);
}

function isAmountEntryStep(step) {
  const haystack = [step?.id, step?.label, step?.visualState, step?.narration].filter(Boolean).join(' ').toLowerCase();
  return /\bamount\b|\bfunding amount\b|\btransfer amount\b/.test(haystack);
}

function validateDemoScript(demoScript, opts = {}) {
  const errors = [];
  const warnings = [];
  const steps = Array.isArray(demoScript?.steps) ? demoScript.steps : [];
  const plaidLinkLive = opts.plaidLinkLive === true;
  const productFamily = opts.productFamily || 'generic';

  const idCounts = new Map();
  for (const step of steps) {
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
    errors.push('PLAID_LINK_LIVE=true requires exactly one step with plaidPhase:"launch".');
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
  const curatedProductKnowledge = buildCuratedProductKnowledge(productFamily);
  const curatedDigest = buildCuratedDigest(curatedProductKnowledge);
  if (productResearch && typeof productResearch === 'object') {
    productResearch.productFamily = productFamily;
    productResearch.curatedProductKnowledge = curatedProductKnowledge;
    productResearch.curatedDigest = curatedDigest;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log('[Script] Calling Claude (claude-opus-4-6 with extended thinking + structured output)...');

  // Build prompts from the shared template
  const { system: systemPrompt, userMessages } = buildScriptGenerationPrompt(
    ingestedInputs || { texts: [], screenshots: [], transcriptions: [] },
    productResearch || {
      synthesizedInsights: {},
      internalKnowledge: [],
      apiSpec: {},
      productFamily,
      curatedProductKnowledge,
      curatedDigest,
    }
  );

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
      type:          'enabled',
      budget_tokens: BUDGET_TOKENS,
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
      console.error('[Script] No step with plaidPhase:"launch" found in demo-script.json.');
      console.error('[Script] Add plaidPhase:"launch" to the step that opens Plaid Link.');
      process.exit(1);
    }
    console.log(`[Script] Plaid launch step: "${launchStep.id}" (plaidPhase: launch) ✓`);
  }

  const scriptValidation = validateDemoScript(demoScript, {
    plaidLinkLive: process.env.PLAID_LINK_LIVE === 'true',
    productFamily,
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

  // Write to disk
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
};

if (require.main === module) {
  main().catch(err => {
    console.error('[Script] Fatal error:', err.message);
    process.exit(1);
  });
}
