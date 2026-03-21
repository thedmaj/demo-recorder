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

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const OUT_DIR      = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const INPUTS_DIR   = path.join(PROJECT_ROOT, 'inputs');
const OUTPUT_FILE  = path.join(OUT_DIR, 'product-research.json');

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Tool definitions for Claude ────────────────────────────────────────────────

const TOOLS = [
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
];

// ── Tool execution ─────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  if (name === 'ask_plaid_docs') {
    return await askPlaidDocs(input.question);
  }
  if (name === 'glean_chat') {
    return await gleanChat(input.query);
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ── Product slug detection ─────────────────────────────────────────────────────

/**
 * Detects the Plaid product slug from the prompt content.
 * Returns the slug string (e.g. 'auth', 'signal') or null if unknown.
 */
function detectProductSlug(promptContent) {
  const slugMap = {
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
 */
function buildResearchMessages(context, productSlug) {
  const valuePropsMd = loadValueProps(productSlug);
  const valuePropSection = valuePropsMd
    ? `\n\n## PRIORITY MESSAGING (treat as ground truth — do not replace or contradict)\n\n` +
      `The following value propositions, proof points, and talk tracks are pre-approved. ` +
      `Use them verbatim or closely adapted in the synthesized output. ` +
      `Research confirms and supplements them — it does NOT override them.\n\n` +
      valuePropsMd + `\n\n## END PRIORITY MESSAGING\n`
    : '';

  if (context.type === 'prompt') {
    const systemPrompt =
      `You are a Plaid product expert preparing for demo video production. ` +
      `Use the ask_plaid_docs tool for authoritative product facts and the glean_chat ` +
      `tool to query Plaid's internal knowledge base for one-pagers, demo scripts, customer ` +
      `success stories, Gong call transcripts, and sales collateral. ` +
      `Be thorough — accuracy matters more than speed. Do not invent field names, status codes, ` +
      `or metric ranges; verify everything against official sources.\n\n` +
      `IMPORTANT: You MUST query Glean for Gong call transcripts to find real customer conversations ` +
      `discussing this product. Ask natural-language questions like "Gong calls about Plaid Signal" ` +
      `or "customer objections to Plaid Auth". Extract actual customer pain points, objections, ` +
      `questions, and success stories. Also search for sales collateral (pitch decks, one-pagers, ` +
      `battle cards) to understand how the sales team positions this product. ` +
      `These real-world insights are critical for creating an authentic demo.` +
      valuePropSection;

    const userText =
      `Research Plaid products in preparation for building a demo video based on this brief:\n\n` +
      `${context.content}\n\n` +
      (valuePropsMd
        ? `The PRIORITY MESSAGING section in your system prompt contains pre-approved value ` +
          `propositions and talk tracks. Preserve these in the synthesized output. ` +
          `Research should confirm API accuracy and add Gong evidence — not replace the messaging.\n\n`
        : '') +
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
      `Aim for 12-18 tool calls total. At least 4-5 glean_chat calls for Gong, 2-3 for sales collateral.\n\n` +
      `Synthesize findings into a single JSON object — no prose, no markdown fences:\n\n` +
      `{\n` +
      `  "product": "<string>",\n` +
      `  "priorityMessaging": { "preserved": true, "source": "inputs/plaid-value-props.md" },\n` +
      `  "synthesizedInsights": { "keyFeatures": [...], "valuePropositions": [...], ` +
      `"accurateTerminology": {}, "customerUseCases": [...], "demoTalkingPoints": [...], ` +
      `"competitiveDifferentiators": [...] },\n` +
      `  "gongInsights": { "commonQuestions": [...], "customerPainPoints": [...], ` +
      `"objectionsAndResponses": [...], "successStories": [...], "callCount": <number> },\n` +
      `  "salesCollateral": [{ "title": "...", "type": "pitch_deck|one_pager|battle_card|brief", ` +
      `"keyMessages": [...], "url": "..." }],\n` +
      `  "internalKnowledge": [{ "source": "...", "snippet": "...", "url": "..." }],\n` +
      `  "apiSpec": { "linkEvents": [...], "sampleApiResponse": {}, "requiredCallbacks": [...] },\n` +
      `  "researchedAt": "<ISO 8601 timestamp>"\n` +
      `}`;

    return {
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    };
  }

  // Structured config.json or default — use the template, prepend value props to system
  const { system, userMessages } = buildResearchPrompt(context.content);
  return {
    system: system + valuePropSection,
    messages: userMessages,
  };
}

// ── Main research loop ─────────────────────────────────────────────────────────

async function runResearch(context, productSlug) {
  const client = new Anthropic();
  const { system, messages: initialMessages } = buildResearchMessages(context, productSlug);

  console.log('Starting product research with Claude + AskBill + Glean...\n');

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
      tools: TOOLS,
      messages,
    });

    process.stdout.write(` stop_reason=${response.stop_reason}\n`);

    if (response.stop_reason === 'end_turn') {
      // Final synthesis — extract the JSON
      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock) throw new Error('No text block in final response');
      finalText = textBlock.text;
      console.log('\nResearch complete — synthesizing results...\n');
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolBlocks = response.content.filter(b => b.type === 'tool_use');
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

  // Run the agentic research loop
  const rawText = await runResearch(context, productSlug);

  // Parse the synthesized JSON
  let research;
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

  // Ensure required fields exist
  research.researchedAt = new Date().toISOString();
  research.synthesizedInsights = research.synthesizedInsights || {};
  research.apiSpec = research.apiSpec || { linkEvents: [], sampleApiResponse: {}, requiredCallbacks: [] };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(research, null, 2));
  console.log(`✓ Product research written: out/product-research.json`);
  console.log(`  Features: ${(research.synthesizedInsights.keyFeatures || []).length}`);
  console.log(`  Value props: ${(research.synthesizedInsights.valuePropositions || []).length}`);
  console.log(`  Internal docs: ${(research.internalKnowledge || []).length}`);
  console.log(`  Link events: ${(research.apiSpec.linkEvents || []).length}\n`);

  // Append qualified findings to per-product knowledge base
  const runId = process.env.PIPELINE_RUN_ID || path.basename(process.env.PIPELINE_RUN_DIR || '') || null;
  appendResearchToProductFile(productSlug, runId, research);

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
