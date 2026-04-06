#!/usr/bin/env node
/**
 * research.js
 * Stage 0: Agentic product research using AskBill (Plaid docs) + Glean (internal knowledge).
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

const { askPlaidDocs, gleanChat } = require('./utils/mcp-clients');
const { buildResearchPrompt } = require('./utils/prompt-templates');
const { inferProductFamilyFromText } = require('./utils/product-profiles');
const {
  getPlaidSkillBundleForFamily,
  writePlaidSkillManifest,
  resolveResearchMode,
  effectiveResearchMode,
} = require('./utils/plaid-skill-loader');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const OUT_DIR      = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const INPUTS_DIR   = path.join(PROJECT_ROOT, 'inputs');
const OUTPUT_FILE  = path.join(OUT_DIR, 'product-research.json');

fs.mkdirSync(OUT_DIR, { recursive: true });

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
    'When you have gathered sufficient information (12–18 tool calls minimum), call this tool ' +
    'to synthesize all research into structured output. This is your FINAL action — call it once. ' +
    'Do NOT output JSON as free text; always use this tool for the final synthesis.'
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
        },
        required: ['question'],
      },
    },
    {
      name: 'glean_chat',
      description:
        'Chat with Glean AI to query Plaid\'s internal knowledge base. Use this for sales materials, ' +
        'demo scripts, customer stories, pitch decks, competitive intel, one-pagers, Gong call ' +
        'transcripts, and other internal docs. Ask natural-language questions for best results.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language question or message for Glean AI (e.g. "What are Gong calls about Plaid Signal?")',
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
  if (name === 'ask_plaid_docs') {
    return await askPlaidDocs(input.question);
  }
  if (name === 'glean_chat') {
    return await gleanChat(input.query);
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
  const slugMap = {
    'cra-base-report': /\b(base report|consumer report|check base report|cra base report)\b/i,
    'income-insights': /\b(cra income insights|income insights|cra_income_insights)\b/i,
    'auth':     /\bauth\b|\baccount.verif|\bIAV\b|\bEAV\b/i,
    'signal':   /\bsignal\b|\bach.risk\b/i,
    'layer':    /\blayer\b/i,
    'idv':      /\bIDV\b|\bidentity.verif/i,
    'monitor':  /\bmonitor\b/i,
    'assets':   /\bassets\b/i,
    'transfer': /\btransfer\b|\bpay.by.bank\b/i,
  };
  for (const [slug, pattern] of Object.entries(slugMap)) {
    if (pattern.test(promptContent)) return slug;
  }
  return null;
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

/**
 * Transforms the raw context from loadResearchContext() into a system prompt
 * and initial messages array suitable for the Claude API.
 *
 * Value props from inputs/plaid-value-props.md are injected as PRIORITY CONTEXT —
 * they define what to say. Research from AskBill + Glean supplements them with
 * API accuracy, Gong stories, and customer evidence; it does not replace them.
 *
 * @param {{ mode?: string, skillMarkdown?: string, skillLoaded?: boolean }} researchOpts
 */
function buildResearchMessages(context, productSlug, researchOpts = {}) {
  const mode = researchOpts.mode || 'full';
  const skillMarkdown = (researchOpts.skillMarkdown || '').trim();
  const skillLoaded = !!researchOpts.skillLoaded;

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
        `IMPORTANT: You MUST query Glean for Gong call transcripts to find real customer conversations ` +
        `discussing this product. Ask natural-language questions like "Gong calls about Plaid Signal" ` +
        `or "customer objections to Plaid Auth". Extract actual customer pain points, objections, ` +
        `questions, and success stories. Also search for sales collateral (pitch decks, one-pagers, ` +
        `battle cards) to understand how the sales team positions this product. ` +
        `These real-world insights are critical for creating an authentic demo.\n`;
    } else if (mode === 'gapfill') {
      systemPrompt +=
        `RESEARCH MODE: technical gap-fill. The Plaid integration skill (below) already covers most ` +
        `integration patterns. Use ask_plaid_docs only for missing API/schema/sample-response details. ` +
        `Use glean_chat 0–2 times unless the brief explicitly needs Gong or collateral.\n`;
    } else if (mode === 'messaging') {
      systemPrompt +=
        `RESEARCH MODE: messaging-first. Prioritize glean_chat for Gong, collateral, objections, ` +
        `and customer stories. Use at most 1–2 ask_plaid_docs calls for critical API fact-checking only.\n`;
    }

    systemPrompt += valuePropSection + skillSection;

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
        `7. **Gong call transcripts**: Use glean_chat with queries like "Gong call transcripts about ` +
        `<product>", "customer concerns about <feature>", "success stories <product>". ` +
        `Extract: customer pain points, objections, how reps use the approved talk tracks, ` +
        `and quantified results. Try multiple different queries.\n` +
        `8. **Sales collateral**: Use glean_chat to find pitch decks, battle cards, one-pagers. ` +
        `Ask: "Plaid <product> one-pager", "<product> pitch deck", "<product> competitive". ` +
        `Extract key positioning and competitive comparisons.\n\n` +
        `Aim for 12-18 tool calls total. At least 4-5 glean_chat calls for Gong, 2-3 for sales collateral.\n\n`;
    } else if (mode === 'gapfill') {
      userText +=
        `Use a **targeted** research pass:\n` +
        `1. Identify APIs or response shapes in the brief that are NOT fully specified in the integration skill.\n` +
        `2. Use ask_plaid_docs to fetch exact field names and a realistic sandbox-flavored sample JSON if needed.\n` +
        `3. Optional: up to 2 glean_chat calls for Gong/collateral only if the brief asks for sales voice.\n\n` +
        `Aim for **3–8** tool calls total.\n\n`;
    } else if (mode === 'messaging') {
      userText +=
        `Focus on **sales and customer evidence**:\n` +
        `1. Multiple glean_chat queries for Gong, objections, success stories, and collateral.\n` +
        `2. At most 1–2 ask_plaid_docs calls for must-have API terminology.\n\n` +
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
  let systemOut = system + valuePropSection + skillSection;
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

// ── Main research loop ─────────────────────────────────────────────────────────

async function runResearch(context, productSlug, researchOpts = {}) {
  const client = new Anthropic();
  const mode = researchOpts.mode || 'full';
  const tools = buildResearchTools(mode === 'messaging' ? 'messaging' : mode === 'gapfill' ? 'gapfill' : 'full');
  const { system, messages: initialMessages } = buildResearchMessages(context, productSlug, researchOpts);

  console.log(`Starting product research (mode=${mode}) with Claude + AskBill + Glean...\n`);

  const messages = [...initialMessages];
  let iteration = 0;
  let finalText = null;

  while (true) {
    iteration++;
    process.stdout.write(`[Research loop ${iteration}] Calling Claude...`);

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

      // Check for synthesize_research — this is the final structured output
      const synthesizeBlock = toolBlocks.find(b => b.name === 'synthesize_research');
      if (synthesizeBlock) {
        console.log('\nResearch complete — structured synthesis received via tool call.\n');
        return { structured: synthesizeBlock.input };
      }

      console.log(`  → ${toolBlocks.length} tool call(s): ${toolBlocks.map(b => `${b.name}("${(b.input.question || b.input.query || '').substring(0, 50)}")`).join(', ')}`);

      // Add assistant message with all content blocks
      messages.push({ role: 'assistant', content: response.content });

      // Execute tools in parallel
      const toolResults = await Promise.all(
        toolBlocks.map(async (block) => {
          try {
            const result = await executeTool(block.name, block.input);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            console.log(`  ✓ ${block.name} → ${resultStr.length} chars`);
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: resultStr.substring(0, 8000), // cap to avoid huge context
            };
          } catch (err) {
            console.warn(`  ✗ ${block.name} error: ${err.message}`);
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

  const productFamilyEarly = inferProductFamilyFromText(promptContent);
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
