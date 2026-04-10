#!/usr/bin/env node
/**
 * research.js
 * Stage 0: Agentic product research using AskBill (Plaid docs) + Glean (internal knowledge).
 *
 * Optional env (tool caps / compaction / logs):
 *   RESEARCH_TOOL_CAP_GLEAN, RESEARCH_TOOL_CAP_ASK_PLAID_DOCS, RESEARCH_TOOL_CAP_DEFAULT,
 *   RESEARCH_LOG_TOOL_EXCHANGE_MAX_CHARS, RESEARCH_COMPACT_KEEP_TAIL, RESEARCH_COMPACT_KEEP_TAIL_RECOVERY
 *
 * Claude runs a tool-use loop to autonomously gather and synthesize product information
 * before any demo script is generated.
 *
 * Reads:  inputs/prompt.txt or inputs/config.json
 * Writes: out/product-research.json
 *
 * Usage: node scripts/scratch/research.js
 */

require('dotenv').config({ override: true });
const fs   = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const {
  askPlaidDocs,
  gleanChat,
  resolveSolutionsMasterContext,
} = require('./utils/mcp-clients');
const { buildResearchPrompt } = require('./utils/prompt-templates');
const { inferProductFamilyFromText } = require('./utils/product-profiles');
const { detectProductSlugFromPrompt } = require('./utils/prompt-scope');
const {
  getPlaidSkillBundleForFamily,
  writePlaidSkillManifest,
  resolveResearchMode,
  effectiveResearchMode,
} = require('./utils/plaid-skill-loader');
const {
  appendPipelineLogSection,
  appendPipelineLogJson,
  appendResearchToolExchange,
} = require('./utils/pipeline-logger');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const OUT_DIR      = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const INPUTS_DIR   = path.join(PROJECT_ROOT, 'inputs');
const OUTPUT_FILE  = path.join(OUT_DIR, 'product-research.json');

fs.mkdirSync(OUT_DIR, { recursive: true });

/** Env-tunable caps for research tool results and log size (see plan: throughput + Glean/AskBill shaping). */
function getResearchToolCaps() {
  return {
    glean: Math.max(400, parseInt(process.env.RESEARCH_TOOL_CAP_GLEAN || '1800', 10)),
    ask_plaid_docs: Math.max(400, parseInt(process.env.RESEARCH_TOOL_CAP_ASK_PLAID_DOCS || '2600', 10)),
    default: Math.max(400, parseInt(process.env.RESEARCH_TOOL_CAP_DEFAULT || '3000', 10)),
    logMaxChars: Math.max(500, parseInt(process.env.RESEARCH_LOG_TOOL_EXCHANGE_MAX_CHARS || '4000', 10)),
    compactKeepTail: Math.max(4, parseInt(process.env.RESEARCH_COMPACT_KEEP_TAIL || '14', 10)),
    compactKeepTailRecovery: Math.max(4, parseInt(process.env.RESEARCH_COMPACT_KEEP_TAIL_RECOVERY || '10', 10)),
  };
}

// ── Tool definitions for Claude ────────────────────────────────────────────────

const SYNTHESIZE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    product: { type: 'string' },
    priorityMessaging: {
      type: 'object',
      properties: {
        preserved: { type: 'boolean' },
        source: { type: 'string' },
      },
    },
    synthesizedInsights: {
      type: 'object',
      properties: {
        keyFeatures:              { type: 'array', items: { type: 'string' } },
        valuePropositions:        { type: 'array', items: { type: 'string' } },
        accurateTerminology:      { type: 'object' },
        customerUseCases:         { type: 'array', items: { type: 'string' } },
        demoTalkingPoints:        { type: 'array', items: { type: 'string' } },
        competitiveDifferentiators: { type: 'array', items: { type: 'object' } },
      },
      required: ['keyFeatures', 'valuePropositions'],
    },
    gongInsights: {
      type: 'object',
      properties: {
        commonQuestions:       { type: 'array', items: { type: 'string' } },
        customerPainPoints:    { type: 'array', items: { type: 'object' } },
        objectionsAndResponses: { type: 'array', items: { type: 'object' } },
        successStories:        { type: 'array', items: { type: 'object' } },
        callCount:             { type: 'number' },
      },
    },
    salesCollateral: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title:       { type: 'string' },
          type:        { type: 'string', description: 'pitch_deck|one_pager|battle_card|brief' },
          keyMessages: { type: 'array', items: { type: 'string' } },
          url:         { type: 'string' },
        },
      },
    },
    internalKnowledge: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source:  { type: 'string' },
          snippet: { type: 'string' },
          url:     { type: 'string' },
        },
      },
    },
    apiSpec: {
      type: 'object',
      properties: {
        linkEvents:        { type: 'array', items: { type: 'string' } },
        sampleApiResponse: { type: 'object' },
        requiredCallbacks: { type: 'array', items: { type: 'string' } },
      },
      required: ['linkEvents', 'requiredCallbacks'],
    },
    gapQuestions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Questions or API details still unknown after research; reviewers use out/plaid-skill-gaps.json. ' +
        'Use in gapfill/messaging modes when anything material is unresolved.',
    },
    researchedAt: { type: 'string', description: 'ISO 8601 timestamp' },
  },
  required: ['product', 'synthesizedInsights', 'apiSpec'],
};

function synthesizeToolDescription(mode) {
  if (mode === 'gapfill') {
    return (
      'When remaining technical or messaging gaps are addressed (typically 3–8 targeted tool calls), ' +
      'call this tool once to synthesize output. The PLAID INTEGRATION SKILL baseline already covers ' +
      'common flows — use ask_plaid_docs only for gaps (exact field names, sample JSON, sandbox nuances). ' +
      'Use glean_chat sparingly (0–2 calls) unless the brief needs Gong/collateral. ' +
      'Put unresolved items in gapQuestions. Do NOT output JSON as free text.'
    );
  }
  if (mode === 'messaging') {
    return (
      'When you have enough internal messaging evidence (typically 4–10 tool calls), call this tool once. ' +
      'Prioritize glean_chat for Gong, collateral, and customer stories. Limit ask_plaid_docs to 0–2 calls ' +
      'for explicit API verification only. Put unresolved technical items in gapQuestions. ' +
      'Do NOT output JSON as free text.'
    );
  }
  return (
    'When you have gathered sufficient information (typically 12–18 tool calls in full mode, fewer if ' +
    'evidence is already decisive), call this tool to synthesize all research into structured output. ' +
    'This is your FINAL action — call it once. Do NOT output JSON as free text; always use this tool ' +
    'for the final synthesis.'
  );
}

/**
 * @param {'full'|'gapfill'|'messaging'} mode
 */
function buildResearchTools(mode) {
  return [
    {
      name: 'ask_plaid_docs',
      description:
        'Query the Plaid product documentation and AskBill AI assistant for authoritative ' +
        'product information, feature descriptions, API capabilities, API response schemas, ' +
        'Plaid Link event names, and official messaging.',
      input_schema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask about the Plaid product',
          },
          answerFormat: {
            type: 'string',
            enum: ['bullet_list', 'prose', 'json_sample', 'field_list'],
            description:
              'How AskBill should answer. Prefer bullet_list for facts; json_sample for example payloads; ' +
              'field_list for schema-only; prose only when narrative is required.',
          },
        },
        required: ['question'],
      },
    },
    {
      name: 'glean_chat',
      description:
        'Chat with Glean AI to query Plaid\'s internal knowledge base. Use this for sales materials, ' +
        'demo scripts, customer stories, pitch decks, competitive intel, one-pagers, Gong call ' +
        'transcripts, and other internal docs. Pass intent + a focused query; prefer few high-value calls.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language question for Glean AI (focused, one topic per call).',
          },
          intent: {
            type: 'string',
            enum: ['gong', 'collateral', 'objections', 'customer_story', 'competitive', 'general'],
            description: 'Optional: what you are looking for so Glean prioritizes the right sources.',
          },
          maxBullets: {
            type: 'integer',
            description: 'Optional: max synthesized bullets to return (1–8). Default 5.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'synthesize_research',
      description: synthesizeToolDescription(mode),
      input_schema: SYNTHESIZE_INPUT_SCHEMA,
    },
  ];
}

// ── Tool execution ─────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  const caps = getResearchToolCaps();
  if (name === 'ask_plaid_docs') {
    const fmt = input.answerFormat && String(input.answerFormat).trim()
      ? String(input.answerFormat).trim()
      : 'bullet_list';
    return await askPlaidDocs(input.question, { answerFormat: fmt });
  }
  if (name === 'glean_chat') {
    let q = String(input.query || '').trim();
    if (input.intent && String(input.intent).trim()) {
      q = `[Research intent: ${String(input.intent).trim()}]\n${q}`;
    }
    const mb = Math.min(8, Math.max(1, parseInt(input.maxBullets, 10) || 5));
    return await gleanChat(q, { maxBullets: mb, maxOutputChars: caps.glean });
  }
  // synthesize_research is intercepted before executeTool is called
  throw new Error(`Unknown tool: ${name}`);
}

// ── Product slug detection ─────────────────────────────────────────────────────

/**
 * Detects the Plaid product slug from the prompt content.
 * Returns the slug string (e.g. 'auth', 'signal') or null if unknown.
 */
function detectProductSlug(promptContent) {
  return detectProductSlugFromPrompt(promptContent);
}

// ── Load research context from inputs ─────────────────────────────────────────

function loadResearchContext() {
  // Try prompt.txt first (preferred)
  const promptFile = path.join(INPUTS_DIR, 'prompt.txt');
  if (fs.existsSync(promptFile)) {
    return { type: 'prompt', content: fs.readFileSync(promptFile, 'utf8').trim() };
  }

  // Fall back to config.json
  const configFile = path.join(INPUTS_DIR, 'config.json');
  if (fs.existsSync(configFile)) {
    return { type: 'config', content: JSON.parse(fs.readFileSync(configFile, 'utf8')) };
  }

  console.warn('⚠ No inputs/prompt.txt or inputs/config.json found — using generic IDV research.');
  return {
    type: 'default',
    content: {
      product: 'Identity Verification',
      targetAudience: 'technical decision-makers at fintech companies',
      persona: { name: 'Leslie Knope', company: 'Smith & Cedar', useCase: 'new user onboarding' },
    },
  };
}

// ── Extract JSON from model response ──────────────────────────────────────────

function extractJson(text) {
  // Try fenced block first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1].trim());
  // Try raw JSON object
  const raw = text.match(/(\{[\s\S]*\})/);
  if (raw) return JSON.parse(raw[1].trim());
  throw new Error('No JSON found in response');
}

// ── Build research messages from context ──────────────────────────────────────

/**
 * Loads the value props file for the given product slug.
 * 1. Per-product file: inputs/products/plaid-{slug}.md
 * 2. Fallback: inputs/plaid-value-props.md (legacy monolithic file)
 * Returns the file content as a string, or null if not found.
 */
function loadValueProps(productSlug) {
  if (productSlug) {
    const perProduct = path.join(INPUTS_DIR, 'products', `plaid-${productSlug}.md`);
    if (fs.existsSync(perProduct)) {
      console.log(`  Using per-product knowledge file: inputs/products/plaid-${productSlug}.md`);
      return fs.readFileSync(perProduct, 'utf8').trim();
    }
  }
  const vpFile = path.join(INPUTS_DIR, 'plaid-value-props.md');
  if (fs.existsSync(vpFile)) {
    console.log(`  Using legacy value-props file: inputs/plaid-value-props.md`);
    return fs.readFileSync(vpFile, 'utf8').trim();
  }
  return null;
}

// ── Confidence-gated product KB append ────────────────────────────────────────

/**
 * Confidence levels in order of descending trust.
 * Only findings at or above MIN_CONFIDENCE are appended to the product file.
 */
const CONFIDENCE_ORDER = ['high', 'medium', 'low'];

function meetsConfidenceThreshold(level, threshold) {
  const li = CONFIDENCE_ORDER.indexOf((level || 'low').toLowerCase());
  const ti = CONFIDENCE_ORDER.indexOf((threshold || 'medium').toLowerCase());
  return li !== -1 && ti !== -1 && li <= ti;
}

/**
 * Appends qualified research findings to the ## AI Research Notes section
 * of inputs/products/plaid-{slug}.md (if it exists).
 *
 * Only appends findings whose confidence is >= minConfidence (default: 'medium').
 * Updates YAML frontmatter last_ai_update and sets needs_review: true.
 * Atomic write: writes to .tmp then renames.
 *
 * @param {string} productSlug
 * @param {string} runId          - e.g. "2026-03-12-auth-v1"
 * @param {object} researchJson   - the synthesized research object
 */
function appendResearchToProductFile(productSlug, runId, researchJson) {
  if (!productSlug) return;

  const productFile = path.join(INPUTS_DIR, 'products', `plaid-${productSlug}.md`);
  if (!fs.existsSync(productFile)) {
    console.log(`  No product KB file for slug '${productSlug}' — skipping append`);
    return;
  }

  const minConfidence = (process.env.PRODUCT_KB_MIN_CONFIDENCE || 'medium').toLowerCase();
  const now = new Date().toISOString();
  const today = now.split('T')[0];

  // Collect findings that meet the confidence threshold
  const lines = [];

  // --- Gong insights ---
  const gong = researchJson.gongInsights || {};

  const gongSuccesses = (gong.successStories || []).filter(s => {
    if (!s || typeof s !== 'object') return false;
    const conf = (s.confidence || s.confidenceLevel || 'medium').toLowerCase();
    return meetsConfidenceThreshold(conf, minConfidence);
  });
  if (gongSuccesses.length > 0) {
    lines.push('**Gong — Success Stories**');
    for (const s of gongSuccesses) {
      const conf = s.confidence || s.confidenceLevel || 'medium';
      lines.push(`- [${conf}] ${s.story || s.summary || JSON.stringify(s)}`);
    }
  }

  const gongPains = (gong.customerPainPoints || []).filter(p => {
    if (!p || typeof p !== 'object') return false;
    const conf = (p.confidence || p.confidenceLevel || 'medium').toLowerCase();
    return meetsConfidenceThreshold(conf, minConfidence);
  });
  if (gongPains.length > 0) {
    lines.push('**Gong — Customer Pain Points**');
    for (const p of gongPains) {
      const conf = p.confidence || p.confidenceLevel || 'medium';
      const text = typeof p === 'string' ? p : (p.painPoint || p.point || JSON.stringify(p));
      lines.push(`- [${conf}] ${text}`);
    }
  }

  const gongObj = (gong.objectionsAndResponses || []).filter(o => {
    if (!o || typeof o !== 'object') return false;
    const conf = (o.confidence || o.confidenceLevel || 'medium').toLowerCase();
    return meetsConfidenceThreshold(conf, minConfidence);
  });
  if (gongObj.length > 0) {
    lines.push('**Gong — Objections & Responses**');
    for (const o of gongObj) {
      const conf = o.confidence || o.confidenceLevel || 'medium';
      lines.push(`- [${conf}] Objection: ${o.objection} → Response: ${o.response}`);
    }
  }

  // --- Sales collateral highlights ---
  const collateral = (researchJson.salesCollateral || []).filter(c => {
    if (!c || typeof c !== 'object') return false;
    const conf = (c.confidence || c.confidenceLevel || 'medium').toLowerCase();
    return meetsConfidenceThreshold(conf, minConfidence);
  });
  if (collateral.length > 0) {
    lines.push('**Sales Collateral**');
    for (const c of collateral) {
      const conf = c.confidence || c.confidenceLevel || 'medium';
      const msgs = (c.keyMessages || []).slice(0, 3).join(' | ');
      lines.push(`- [${conf}] ${c.title} (${c.type}): ${msgs}`);
    }
  }

  // --- Synthesized insights (key features / competitive differentiators) ---
  const synth = researchJson.synthesizedInsights || {};
  const diffs = (synth.competitiveDifferentiators || []).filter(d => {
    const conf = (d.confidence || d.confidenceLevel || 'high').toLowerCase();
    return meetsConfidenceThreshold(conf, minConfidence);
  });
  if (diffs.length > 0) {
    lines.push('**Competitive Differentiators (AI-synthesized)**');
    for (const d of diffs) {
      const conf = d.confidence || d.confidenceLevel || 'high';
      const text = typeof d === 'string' ? d : (d.differentiator || d.point || JSON.stringify(d));
      lines.push(`- [${conf}] ${text}`);
    }
  }

  if (lines.length === 0) {
    console.log(`  No findings at or above '${minConfidence}' confidence — nothing appended to product KB`);
    return;
  }

  // Build the note block
  const noteBlock = [
    `### ${today} — Run: ${runId || 'unknown'} (min_confidence: ${minConfidence})`,
    ...lines,
    '',
  ].join('\n');

  let content = fs.readFileSync(productFile, 'utf8');

  // Append to ## AI Research Notes section
  const notesMarker = '## AI Research Notes';
  const notesIdx = content.indexOf(notesMarker);
  if (notesIdx === -1) {
    console.warn(`  Could not find '## AI Research Notes' in ${productFile} — skipping append`);
    return;
  }

  // Find end of the comment block that follows the section heading
  const afterMarker = content.indexOf('\n', notesIdx) + 1;
  // Skip the HTML comment if present
  let insertAt = afterMarker;
  const commentStart = content.indexOf('<!--', afterMarker);
  const nextHeadingIdx = content.indexOf('\n##', afterMarker);
  if (commentStart !== -1 && (nextHeadingIdx === -1 || commentStart < nextHeadingIdx)) {
    const commentEnd = content.indexOf('-->', commentStart);
    if (commentEnd !== -1) insertAt = commentEnd + 4;
  }

  content = content.slice(0, insertAt) + '\n' + noteBlock + content.slice(insertAt);

  // Update YAML frontmatter — scope replacements to the frontmatter block only
  // to avoid matching identically-named keys anywhere in the document body
  const fmMatch = content.match(/^---\n[\s\S]*?\n---/);
  if (fmMatch) {
    const fmEnd = fmMatch.index + fmMatch[0].length;
    const updatedFm = fmMatch[0]
      .replace(/^last_ai_update:.*$/m, `last_ai_update: "${now}"`)
      .replace(/^needs_review:.*$/m, 'needs_review: true');
    content = updatedFm + content.slice(fmEnd);
  }

  const tmpFile = productFile + '.tmp';
  fs.writeFileSync(tmpFile, content, 'utf8');
  fs.renameSync(tmpFile, productFile);

  console.log(`  ✓ Appended ${lines.length} finding(s) to ${path.relative(PROJECT_ROOT, productFile)} (confidence >= ${minConfidence})`);
}

function formatSolutionsMasterContextBlock(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const names = Array.isArray(ctx.requestedSolutionNames) ? ctx.requestedSolutionNames : [];
  const resolved = Array.isArray(ctx.resolvedSolutions) ? ctx.resolvedSolutions : [];
  const unresolved = Array.isArray(ctx.unresolvedSolutionNames) ? ctx.unresolvedSolutionNames : [];
  const valueProps = Array.isArray(ctx.valuePropositionStatements) ? ctx.valuePropositionStatements.slice(0, 20) : [];
  const apis = Array.isArray(ctx.apiNames) ? ctx.apiNames.slice(0, 30) : [];
  if (!names.length && !resolved.length && !valueProps.length && !apis.length) return '';
  const lines = [];
  if (names.length) lines.push(`Requested solutions: ${names.join(' | ')}`);
  if (resolved.length) lines.push(`Resolved solutions (${resolved.length}): ${resolved.map((s) => s.name).join(' | ')}`);
  if (unresolved.length) lines.push(`Unresolved solution names: ${unresolved.join(' | ')}`);
  if (apis.length) lines.push(`APIs/components referenced (sample): ${apis.join(' | ')}`);
  if (valueProps.length) {
    lines.push('Value proposition statements from solution plays/content:');
    valueProps.forEach((v) => lines.push(`- ${v}`));
  }
  if (Array.isArray(ctx.warnings) && ctx.warnings.length) {
    lines.push(`Lookup notes: ${ctx.warnings.slice(0, 6).join(' | ')}`);
  }
  return `## SOLUTIONS MASTER FOUNDATIONAL CONTEXT\n\n${lines.join('\n')}`;
}

/**
 * Transforms the raw context from loadResearchContext() into a system prompt
 * and initial messages array suitable for the Claude API.
 *
 * Value props from inputs/plaid-value-props.md are injected as PRIORITY CONTEXT —
 * they define what to say. Research from AskBill + Glean supplements them with
 * API accuracy, Gong stories, and customer evidence; it does not replace them.
 *
 * @param {{ mode?: string, skillMarkdown?: string, skillLoaded?: boolean, solutionsMasterContext?: object }} researchOpts
 */
function buildResearchMessages(context, productSlug, researchOpts = {}) {
  const mode = researchOpts.mode || 'full';
  const skillMarkdown = (researchOpts.skillMarkdown || '').trim();
  const skillLoaded = !!researchOpts.skillLoaded;
  const solutionsMasterContext = researchOpts.solutionsMasterContext || null;
  const solutionsMasterSection = formatSolutionsMasterContextBlock(solutionsMasterContext);

  const skillSection = skillMarkdown
    ? `\n\n${skillMarkdown}\n\n` +
      'Treat the integration skill excerpts above as the primary technical baseline for flows, ' +
      'endpoints, and Link setup. AskBill should fill gaps, not re-derive what is already stated there.\n'
    : '';

  const valuePropsMd = loadValueProps(productSlug);
  const valuePropSection = valuePropsMd
    ? `\n\n## PRIORITY MESSAGING (treat as ground truth — do not replace or contradict)\n\n` +
      `The following value propositions, proof points, and talk tracks are pre-approved. ` +
      `Use them verbatim or closely adapted in the synthesized output. ` +
      `Research confirms and supplements them — it does NOT override them.\n\n` +
      valuePropsMd + `\n\n## END PRIORITY MESSAGING\n`
    : '';

  if (context.type === 'prompt') {
    let systemPrompt =
      `You are a Plaid product expert preparing for demo video production. ` +
      `Use the ask_plaid_docs tool for authoritative product facts and the glean_chat ` +
      `tool to query Plaid's internal knowledge base for one-pagers, demo scripts, customer ` +
      `success stories, Gong call transcripts, and sales collateral. ` +
      `Do not invent field names, status codes, or metric ranges; verify against official sources.\n\n`;

    if (mode === 'full') {
      systemPrompt +=
        `Be thorough — accuracy matters more than speed.\n\n` +
        `Use Glean for Gong transcripts and sales collateral when they add **high-value** demo voice — ` +
        `customer pain points, objections, success stories, and positioning. Prefer **fewer, sharper** ` +
        `glean_chat calls with explicit intent (gong | collateral | objections | customer_story | competitive) ` +
        `over many broad searches. Stop adding Glean calls once you have enough ranked evidence to support ` +
        `the brief; put remaining uncertainty in gapQuestions.\n`;
    } else if (mode === 'gapfill') {
      systemPrompt +=
        `RESEARCH MODE: technical gap-fill. The Plaid integration skill (below) already covers most ` +
        `integration patterns. Use ask_plaid_docs only for missing API/schema/sample-response details. ` +
        `Use glean_chat 0–2 times unless the brief explicitly needs Gong or collateral. ` +
        `When you use glean_chat, request only top synthesized findings (no process logs).\n`;
    } else if (mode === 'messaging') {
      systemPrompt +=
        `RESEARCH MODE: messaging-first. Prioritize glean_chat for Gong, collateral, objections, ` +
        `and customer stories. Use at most 1–2 ask_plaid_docs calls for critical API fact-checking only. ` +
        `Keep glean_chat outputs concise and ranked by relevance.\n`;
    }

    if (solutionsMasterSection) {
      systemPrompt +=
        `${solutionsMasterSection}\n\n` +
        'Treat SOLUTIONS MASTER FOUNDATIONAL CONTEXT as the first source for solution scope, components, APIs, and value-proposition statements.\n\n';
    }
    systemPrompt += skillSection + valuePropSection;

    let userText =
      `Research Plaid products in preparation for building a demo video based on this brief:\n\n` +
      `${context.content}\n\n` +
      (valuePropsMd
        ? `The PRIORITY MESSAGING section in your system prompt contains pre-approved value ` +
          `propositions and talk tracks. Preserve these in the synthesized output. ` +
          `Research should confirm API accuracy and add evidence — not replace the messaging.\n\n`
        : '');

    if (mode === 'full') {
      userText +=
        `Use ask_plaid_docs and glean_chat to research:\n` +
        `1. Core product features and how each one works technically\n` +
        `2. Accurate API terminology, field names, response schemas, and Plaid Link event names\n` +
        `3. Verify (do not replace) the proof points in the priority messaging above\n` +
        `4. Customer use cases and examples that reinforce the value props\n` +
        `5. Any existing demo scripts, one-pagers, or video scripts\n` +
        `6. Competitive differentiators vs. alternatives\n` +
        `7. **Gong / customer voice** (only if additive): glean_chat with intent=gong or objections — ` +
        `e.g. top objections, rep talk-track usage, quantified outcomes. Prefer **2–4 total** Glean calls ` +
        `that each return **ranked, demo-ready** bullets, not transcript dumps.\n` +
        `8. **Sales collateral** (only if additive): glean_chat with intent=collateral or competitive — ` +
        `one-pagers, battle cards, pitch angles. Merge duplicate topics into a single query.\n\n` +
        `Aim for **12–18 tool calls total**, but **quality over count**: stop early if synthesis is already ` +
        `well supported. For Glean specifically, treat **~3–5 calls** as sufficient unless gapQuestions ` +
        `require more. Use ask_plaid_docs.answerFormat (bullet_list | json_sample | field_list) for tight API facts.\n\n`;
    } else if (mode === 'gapfill') {
      userText +=
        `Use a **targeted** research pass:\n` +
        `1. Identify APIs or response shapes in the brief that are NOT fully specified in SOLUTIONS MASTER context and integration skill.\n` +
        `2. Use ask_plaid_docs to fetch exact field names and a realistic sandbox-flavored sample JSON if needed.\n` +
        `3. Optional: up to 2 glean_chat calls for Gong/collateral only if the brief asks for sales voice. ` +
        `For each glean call, request top synthesized most-relevant bullets only.\n\n` +
        `Aim for **3–8** tool calls total.\n\n`;
    } else if (mode === 'messaging') {
      userText +=
        `Focus on **sales and customer evidence**:\n` +
        `1. Multiple glean_chat queries for Gong, objections, success stories, and collateral.\n` +
        `2. At most 1–2 ask_plaid_docs calls for must-have API terminology.\n` +
        `3. Keep each glean result to top-ranked synthesized findings only; avoid long transcript dumps.\n\n` +
        `Aim for **4–10** tool calls total.\n\n`;
    }

    userText +=
      `When ready, call the synthesize_research tool with all ` +
      `your findings. Do NOT output JSON as free text — always use the synthesize_research tool ` +
      `to ensure structured, validated output that the pipeline can reliably parse.`;

    if (!skillLoaded) {
      userText += `\n\nNote: Plaid integration skill archive was not loaded — rely on AskBill for technical depth.\n`;
    }

    return {
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    };
  }

  // Structured config.json or default — use the template, prepend value props + skill to system
  const { system, userMessages } = buildResearchPrompt(context.content);
  let systemOut = system;
  if (solutionsMasterSection) {
    systemOut += `\n\n${solutionsMasterSection}\n\nTreat this as foundational context before optional gap research.`;
  }
  systemOut += valuePropSection + skillSection;
  if (mode === 'gapfill') {
    systemOut += '\n\nRESEARCH MODE: gap-fill — minimal Glean; targeted AskBill for API gaps only.\n';
  } else if (mode === 'messaging') {
    systemOut += '\n\nRESEARCH MODE: messaging-first — prioritize Glean.\n';
  }
  const u0 = userMessages[0];
  const extra =
    mode === 'gapfill'
      ? '\n\nUse 3–8 targeted tool calls; list unresolved items in gapQuestions.\n'
      : mode === 'messaging'
        ? '\n\nPrioritize glean_chat; limit ask_plaid_docs to 0–2 calls.\n'
        : '';
  const patchedMessages = userMessages.map((m, i) => {
    if (i !== 0 || !m.content) return m;
    const c = m.content;
    if (typeof c === 'string') return { ...m, content: c + extra };
    return m;
  });
  return {
    system: systemOut,
    messages: patchedMessages,
  };
}

const DEFAULT_LINK_EVENTS = [
  'OPEN', 'HANDOFF', 'TRANSITION_VIEW', 'SELECT_INSTITUTION', 'SUBMIT_CREDENTIALS', 'SUBMIT_MFA',
  'EXIT', 'ERROR',
];

/** @param {object} bundle result of getPlaidSkillBundleForFamily */
function buildSkipModeResearch(context, bundle, productFamily) {
  const brief =
    context.type === 'prompt'
      ? context.content
      : JSON.stringify(context.content || {});
  const title =
    brief.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('##')) || 'Plaid product demo';
  return {
    product: title.slice(0, 200),
    researchMode: 'skip',
    skillZipSha256: bundle.sha256,
    plaidIntegrationSkillFiles: (bundle.members || []).map((m) => m.path),
    skipResearchAgent: true,
    synthesizedInsights: {
      keyFeatures: [
        'Technical baseline: see PLAID INTEGRATION SKILL excerpts injected at script/build stages.',
      ],
      valuePropositions: [
        'Messaging: use PRIORITY MESSAGING / curated product knowledge from inputs — research agent skipped.',
      ],
      accurateTerminology: {},
      customerUseCases: [],
      demoTalkingPoints: [],
      competitiveDifferentiators: [],
    },
    gongInsights: {},
    salesCollateral: [],
    internalKnowledge: [],
    apiSpec: {
      linkEvents: DEFAULT_LINK_EVENTS,
      sampleApiResponse: {},
      requiredCallbacks: ['onSuccess', 'onExit', 'onEvent'],
    },
    gapQuestions: [
      'RESEARCH_MODE=skip: no AskBill/Glean pass ran. Run full or gapfill research if you need fresh API samples or Gong notes.',
    ],
    productFamily,
    researchedAt: new Date().toISOString(),
  };
}

function compactResearchMessages(messages, keepTail = 12) {
  if (!Array.isArray(messages) || messages.length <= keepTail + 1) return messages;
  const first = messages[0];
  const tail = messages.slice(-keepTail);
  return [first, ...tail];
}

// ── Main research loop ─────────────────────────────────────────────────────────

async function runResearch(context, productSlug, researchOpts = {}) {
  const client = new Anthropic();
  const mode = researchOpts.mode || 'full';
  const tools = buildResearchTools(mode === 'messaging' ? 'messaging' : mode === 'gapfill' ? 'gapfill' : 'full');
  const { system, messages: initialMessages } = buildResearchMessages(context, productSlug, researchOpts);

  console.log(`Starting product research (mode=${mode}) with Claude + AskBill + Glean...\n`);
  appendPipelineLogSection('[RESEARCH] Started', [
    `mode=${mode}`,
    `contextType=${context.type}`,
    `productSlug=${productSlug || 'unknown'}`,
  ], { runDir: OUT_DIR });
  appendPipelineLogJson('[RESEARCH] Prompt scaffolding', {
    mode,
    systemPromptPreview: String(system || '').slice(0, 3000),
    initialMessageCount: Array.isArray(initialMessages) ? initialMessages.length : 0,
  }, { runDir: OUT_DIR });

  const messages = [...initialMessages];
  const toolCaps = getResearchToolCaps();
  let iteration = 0;
  let finalText = null;
  let maxTokenRecoveries = 0;
  const MAX_TOKEN_RECOVERIES = 2;
  const MAX_TOOL_LOOPS = mode === 'gapfill' ? 8 : mode === 'messaging' ? 12 : 18;
  let forcedSynthesisPrompted = false;

  while (true) {
    iteration++;
    process.stdout.write(`[Research loop ${iteration}] Calling Claude...`);

    // Defensive guard: never send an empty message list to Anthropic.
    if (!Array.isArray(messages) || messages.length === 0) {
      messages.push({
        role: 'user',
        content: 'Continue with targeted research and call synthesize_research once ready.',
      });
    }

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system,
      tools,
      messages,
    });

    process.stdout.write(` stop_reason=${response.stop_reason}\n`);

    if (response.stop_reason === 'end_turn') {
      // Final synthesis via text (fallback — model should use synthesize_research tool instead)
      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock) throw new Error('No text block in final response');
      finalText = textBlock.text;
      console.log('\nResearch complete — synthesizing results from text (tool not used)...\n');
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolBlocks = response.content.filter(b => b.type === 'tool_use');
      if (!toolBlocks.length) {
        // Avoid creating an empty tool_result message, which can cause invalid request payloads.
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: 'No tool calls were emitted. Continue and call synthesize_research with current findings.',
        });
        continue;
      }

      // Check for synthesize_research — this is the final structured output
      const synthesizeBlock = toolBlocks.find(b => b.name === 'synthesize_research');
      if (synthesizeBlock) {
        console.log('\nResearch complete — structured synthesis received via tool call.\n');
        appendPipelineLogJson('[RESEARCH] Structured synthesis (tool)', synthesizeBlock.input, { runDir: OUT_DIR });
        return { structured: synthesizeBlock.input };
      }

      if (iteration >= MAX_TOOL_LOOPS) {
        console.warn(
          `Research tool-loop cap reached (${MAX_TOOL_LOOPS}) for mode=${mode}; forcing synthesis.`
        );
        messages.push({ role: 'assistant', content: response.content });
        const skippedToolResults = toolBlocks.map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Skipped due to research tool-loop cap; synthesize using collected evidence.',
          is_error: true,
        }));
        messages.push({ role: 'user', content: skippedToolResults });
        if (forcedSynthesisPrompted) {
          finalText = '{}';
          break;
        }
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Tool budget reached. Do not call any more tools. Immediately call synthesize_research ' +
                'using the best available findings and include any unresolved items in gapQuestions.',
            },
          ],
        });
        forcedSynthesisPrompted = true;
        continue;
      }

      console.log(`  → ${toolBlocks.length} tool call(s): ${toolBlocks.map(b => `${b.name}("${(b.input.question || b.input.query || '').substring(0, 50)}")`).join(', ')}`);
      appendPipelineLogSection('[RESEARCH] Tool batch', [
        `iteration=${iteration}`,
        `toolCount=${toolBlocks.length}`,
        `tools=${toolBlocks.map((b) => b.name).join(',')}`,
      ], { runDir: OUT_DIR });

      // Add assistant message with all content blocks
      messages.push({ role: 'assistant', content: response.content });

      // Execute tools in parallel
      const toolResults = await Promise.all(
        toolBlocks.map(async (block) => {
          try {
            const result = await executeTool(block.name, block.input);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            console.log(`  ✓ ${block.name} → ${resultStr.length} chars`);
            appendResearchToolExchange({
              iteration,
              toolName: block.name,
              query: block.input.question || block.input.query || '',
              response: resultStr,
              maxChars: toolCaps.logMaxChars,
            }, { runDir: OUT_DIR });
            const cap =
              block.name === 'glean_chat'
                ? toolCaps.glean
                : block.name === 'ask_plaid_docs'
                  ? toolCaps.ask_plaid_docs
                  : toolCaps.default;
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: resultStr.substring(0, cap), // tighter cap to avoid context bloat
            };
          } catch (err) {
            console.warn(`  ✗ ${block.name} error: ${err.message}`);
            appendResearchToolExchange({
              iteration,
              toolName: block.name,
              query: block.input.question || block.input.query || '',
              error: err.message,
            }, { runDir: OUT_DIR });
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: ${err.message}`,
              is_error: true,
            };
          }
        })
      );

      messages.push({ role: 'user', content: toolResults });
      const compacted = compactResearchMessages(messages, toolCaps.compactKeepTail);
      messages.length = 0;
      messages.push(...compacted);
      continue;
    }

    if (response.stop_reason === 'max_tokens') {
      console.warn('Research response hit max_tokens; attempting constrained synthesis recovery.');
      appendPipelineLogSection('[RESEARCH] Max token recovery', [
        `iteration=${iteration}`,
        `recoveries=${maxTokenRecoveries + 1}/${MAX_TOKEN_RECOVERIES}`,
      ], { runDir: OUT_DIR });
      if (maxTokenRecoveries >= MAX_TOKEN_RECOVERIES) {
        console.warn('Max-token recovery exhausted; stopping loop with fallback.');
        const textBlock = response.content.find((b) => b.type === 'text');
        finalText = textBlock?.text || '{}';
        break;
      }
      maxTokenRecoveries += 1;
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Token budget reached. Do not call additional tools. Immediately call synthesize_research ' +
              'using the most relevant findings already collected. Keep arrays concise and prioritized.',
          },
        ],
      });
      const compacted = compactResearchMessages(messages, toolCaps.compactKeepTailRecovery);
      messages.length = 0;
      messages.push(...compacted);
      continue;
    }

    // Unexpected stop reason
    console.warn(`Unexpected stop_reason: ${response.stop_reason}. Stopping loop.`);
    const textBlock = response.content.find(b => b.type === 'text');
    finalText = textBlock?.text || '{}';
    break;
  }

  return finalText;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const context = loadResearchContext();
  console.log(`Research context: ${context.type}`);

  // Detect product slug for per-product KB loading and post-run append
  const promptContent = context.type === 'prompt'
    ? context.content
    : JSON.stringify(context.content);
  const productSlug = detectProductSlug(promptContent);
  if (productSlug) {
    console.log(`  Detected product slug: ${productSlug}`);
  } else {
    console.log(`  No product slug detected — will use legacy value-props fallback`);
  }

  if (context.type === 'prompt') {
    console.log(`  Prompt: "${context.content.substring(0, 100)}..."\n`);
  } else {
    console.log(`  Product: ${context.content.product}\n`);
  }
  appendPipelineLogSection('[RESEARCH] Context loaded', [
    `contextType=${context.type}`,
    `promptPreview=${context.type === 'prompt' ? context.content.substring(0, 180).replace(/\n/g, ' ') : '(config)'}`,
  ], { runDir: OUT_DIR });

  const productFamilyEarly = inferProductFamilyFromText(promptContent);
  let solutionsMasterContext = null;
  try {
    solutionsMasterContext = await resolveSolutionsMasterContext(promptContent);
    if (Array.isArray(solutionsMasterContext.requestedSolutionNames) && solutionsMasterContext.requestedSolutionNames.length > 0) {
      console.log(
        `  Solutions Master: requested=${solutionsMasterContext.requestedSolutionNames.length}, resolved=${(solutionsMasterContext.resolvedSolutions || []).length}`
      );
    }
  } catch (e) {
    console.warn(`  Solutions Master lookup unavailable: ${e.message}`);
    solutionsMasterContext = {
      requestedSolutionNames: [],
      resolvedSolutions: [],
      unresolvedSolutionNames: [],
      valuePropositionStatements: [],
      apiNames: [],
      transportUsed: null,
      warnings: [e.message],
    };
  }

  const bundle = getPlaidSkillBundleForFamily(productFamilyEarly, { promptText: promptContent });
  writePlaidSkillManifest(OUT_DIR, {
    sha256: bundle.sha256,
    zipPath: bundle.zipPath,
    members: bundle.members,
    skillLoaded: bundle.skillLoaded,
  });
  if (bundle.skillLoaded) {
    console.log(`  Plaid integration skill: ${bundle.members.length} file(s) from archive (${(bundle.sha256 || '').slice(0, 12)}…)`);
  } else {
    console.warn('  Plaid integration skill not loaded — check skills/plaid-integration.skill or PLAID_SKILL_ZIP');
  }

  const explicitMode = resolveResearchMode(context.type === 'prompt' ? context.content : '');
  let mode = effectiveResearchMode(explicitMode, bundle.skillLoaded);
  if (explicitMode) console.log(`  Research mode: ${mode} (from prompt or RESEARCH_MODE)`);
  else console.log(`  Research mode: ${mode} (default gapfill; skillLoaded=${bundle.skillLoaded})`);

  let research;
  if (mode === 'skip') {
    if (!bundle.skillLoaded) {
      console.warn('  RESEARCH_MODE=skip but skill not loaded — falling back to full research.');
      mode = 'full';
    } else {
      console.log('  Skipping agentic research (RESEARCH_MODE=skip).\n');
      research = buildSkipModeResearch(context, bundle, productFamilyEarly);
    }
  }

  if (!research) {
    const rawResult = await runResearch(context, productSlug, {
      mode,
      skillMarkdown: bundle.text,
      skillLoaded: bundle.skillLoaded,
      solutionsMasterContext,
    });

    if (rawResult && typeof rawResult === 'object' && rawResult.structured) {
      console.log('  Using structured tool output (synthesize_research).');
      research = rawResult.structured;
    } else {
      const rawText = typeof rawResult === 'string' ? rawResult : '{}';
      try {
        research = extractJson(rawText);
      } catch (err) {
        console.warn('Could not parse JSON from research response — writing minimal fallback');
        research = {
          product: context.type === 'config' ? context.content.product : 'Unknown',
          researchedAt: new Date().toISOString(),
          plaidDocs: [],
          internalKnowledge: [],
          synthesizedInsights: {
            keyFeatures: [],
            valuePropositions: [],
            accurateTerminology: {},
            customerUseCases: [],
            demoTalkingPoints: [],
            competitiveDifferentiators: [],
          },
          apiSpec: {
            linkEvents: [],
            sampleApiResponse: {},
            requiredCallbacks: ['onSuccess', 'onExit', 'onEvent'],
          },
          _rawResponse: rawText,
        };
      }
    }
  }

  // Ensure required fields exist
  research.researchedAt = new Date().toISOString();
  research.synthesizedInsights = research.synthesizedInsights || {};
  research.apiSpec = research.apiSpec || { linkEvents: [], sampleApiResponse: {}, requiredCallbacks: [] };
  research.skillZipSha256 = bundle.sha256;
  research.plaidIntegrationSkillFiles = (bundle.members || []).map((m) => m.path);
  research.researchMode = research.researchMode || mode;
  research.solutionsMasterContext = solutionsMasterContext || null;
  if (solutionsMasterContext && Array.isArray(solutionsMasterContext.valuePropositionStatements)) {
    research.solutionsMasterValueProps = solutionsMasterContext.valuePropositionStatements;
  }
  if (
    solutionsMasterContext &&
    Array.isArray(solutionsMasterContext.unresolvedSolutionNames) &&
    solutionsMasterContext.unresolvedSolutionNames.length > 0
  ) {
    research.gapQuestions = Array.isArray(research.gapQuestions) ? research.gapQuestions : [];
    for (const nm of solutionsMasterContext.unresolvedSolutionNames) {
      research.gapQuestions.push(`Could not resolve requested solution in Solutions Master: ${nm}`);
    }
  }

  const gaps = research.gapQuestions;
  if (Array.isArray(gaps) && gaps.length > 0) {
    try {
      fs.writeFileSync(
        path.join(OUT_DIR, 'plaid-skill-gaps.json'),
        JSON.stringify({ gapQuestions: gaps, researchedAt: research.researchedAt }, null, 2),
        'utf8'
      );
      console.log(`  Wrote out/plaid-skill-gaps.json (${gaps.length} gap question(s))`);
    } catch (e) {
      console.warn(`  Could not write plaid-skill-gaps.json: ${e.message}`);
    }
  }

  // Run-level context: product family + budgeted curated digest + approved-claims snapshot
  try {
    const { inferProductFamily } = require('./utils/product-profiles');
    const { buildCuratedProductKnowledge, buildCuratedDigest } = require('./utils/product-knowledge');
    const { writePipelineRunContext, buildRunContextPayload } = require('./utils/run-context');
    const productFamily = inferProductFamily({ promptText: promptContent, productResearch: research });
    research.productFamily = productFamily;
    research.curatedProductKnowledge = buildCuratedProductKnowledge(productFamily);
    research.curatedDigest = buildCuratedDigest(research.curatedProductKnowledge);
    const ctxPayload = buildRunContextPayload({
      phase: 'research',
      productFamily,
      productResearch: research,
      demoScript: null,
      promptText: promptContent,
    });
    ctxPayload.skillZipSha256 = bundle.sha256;
    ctxPayload.researchMode = research.researchMode;
    ctxPayload.plaidIntegrationSkillFiles = research.plaidIntegrationSkillFiles;
    ctxPayload.solutionsMaster = {
      requestedSolutionNames: solutionsMasterContext?.requestedSolutionNames || [],
      resolvedSolutionNames: (solutionsMasterContext?.resolvedSolutions || []).map((s) => s.name),
      unresolvedSolutionNames: solutionsMasterContext?.unresolvedSolutionNames || [],
      apiNames: solutionsMasterContext?.apiNames || [],
      valuePropCount: Array.isArray(solutionsMasterContext?.valuePropositionStatements)
        ? solutionsMasterContext.valuePropositionStatements.length
        : 0,
      transportUsed: solutionsMasterContext?.transportUsed || null,
    };
    writePipelineRunContext(OUT_DIR, ctxPayload);
  } catch (e) {
    console.warn(`  Could not write pipeline run context: ${e.message}`);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(research, null, 2));
  console.log(`✓ Product research written: out/product-research.json`);
  console.log(`  Features: ${(research.synthesizedInsights.keyFeatures || []).length}`);
  console.log(`  Value props: ${(research.synthesizedInsights.valuePropositions || []).length}`);
  console.log(`  Internal docs: ${(research.internalKnowledge || []).length}`);
  console.log(`  Link events: ${(research.apiSpec.linkEvents || []).length}\n`);
  appendPipelineLogJson('[RESEARCH] Final output summary', {
    outputFile: OUTPUT_FILE,
    product: research.product || null,
    researchMode: research.researchMode || mode,
    featureCount: (research.synthesizedInsights.keyFeatures || []).length,
    valuePropCount: (research.synthesizedInsights.valuePropositions || []).length,
    internalDocCount: (research.internalKnowledge || []).length,
    linkEventCount: (research.apiSpec.linkEvents || []).length,
    gapQuestions: Array.isArray(research.gapQuestions) ? research.gapQuestions : [],
  }, { runDir: OUT_DIR });

  const runId = process.env.PIPELINE_RUN_ID || path.basename(process.env.PIPELINE_RUN_DIR || '') || null;
  if (!research.skipResearchAgent) {
    appendResearchToProductFile(productSlug, runId, research);
  } else {
    console.log('  skipResearchAgent: not appending to product KB file.');
  }

  return research;
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('Research failed:', err.message);
    // Write empty fallback so pipeline can continue
    const fallback = {
      product: 'Unknown',
      researchedAt: new Date().toISOString(),
      plaidDocs: [],
      internalKnowledge: [],
      synthesizedInsights: { keyFeatures: [], valuePropositions: [], accurateTerminology: {}, customerUseCases: [], demoTalkingPoints: [], competitiveDifferentiators: [] },
      apiSpec: { linkEvents: [], sampleApiResponse: {}, requiredCallbacks: ['onSuccess', 'onExit', 'onEvent'] },
      _error: err.message,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'product-research.json'), JSON.stringify(fallback, null, 2));
    console.warn('Wrote empty fallback product-research.json — pipeline will continue without research.');
    process.exit(0); // soft exit so orchestrator can continue
  });
}
