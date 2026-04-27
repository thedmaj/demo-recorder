'use strict';
/**
 * quickstart.js
 *
 * Pure helpers for the `pipe quickstart` wizard: catalogs of supported
 * products / industries / link modes, a template filler that turns a
 * structured answers object into a draft `inputs/prompt.txt`, and a
 * research-task builder that produces an agent-ready handoff for
 * AskBill + Glean enrichment.
 *
 * The wizard itself (interactive readline) lives in `bin/pipe.js`. Keeping
 * I/O-free helpers here makes them unit-testable and reusable.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const TEMPLATE_PATH = path.join(PROJECT_ROOT, 'inputs', 'prompt-template-app-only.txt');

// ─── Catalogs ────────────────────────────────────────────────────────────────

const KNOWN_PRODUCTS = [
  { slug: 'auth',              label: 'Plaid Auth',              hint: 'ACH account + routing verification' },
  { slug: 'identity-match',    label: 'Plaid Identity Match',    hint: 'name / address / phone match scores' },
  { slug: 'signal',            label: 'Plaid Signal',            hint: 'ACH return-risk scoring (low score = low risk)' },
  { slug: 'transfer',          label: 'Plaid Transfer',          hint: 'ACH money-movement orchestration' },
  { slug: 'statements',        label: 'Plaid Statements',        hint: 'PDF statement retrieval + parsing' },
  { slug: 'cra-base-report',   label: 'Plaid CRA Base Report',   hint: 'consumer-report cash-flow underwriting' },
  { slug: 'bank-income',       label: 'Plaid Bank Income',       hint: 'streamlined income verification' },
  { slug: 'income-insights',   label: 'Plaid Income Insights',   hint: 'pay-cycle + employer cashflow signal' },
  { slug: 'layer',             label: 'Plaid Layer',             hint: 'one-tap returning-user account opening' },
  { slug: 'idv',               label: 'Plaid Identity Verification', hint: 'document + selfie KYC' },
];

const INDUSTRIES = [
  { id: 'retail-banking',         label: 'Retail / consumer banking' },
  { id: 'lending',                label: 'Lending / consumer credit' },
  { id: 'wealth-brokerage',       label: 'Wealth / brokerage' },
  { id: 'fintech-neobank',        label: 'Fintech / neobank' },
  { id: 'payroll-b2b',            label: 'B2B SaaS / payroll' },
  { id: 'gig-marketplace',        label: 'Gig / marketplace' },
  { id: 'insurance',              label: 'Insurance' },
  { id: 'crypto',                 label: 'Crypto / digital assets' },
  { id: 'other',                  label: 'Other (specify in pitch)' },
];

const LINK_MODES = [
  { id: 'modal',    label: 'Modal (default — Plaid Link opens in a popover)' },
  { id: 'embedded', label: 'Embedded (Link tile rendered in-page; iframe-launched)' },
];

const RESEARCH_DEPTHS = [
  { id: 'gapfill',   label: 'Gapfill — fill only what the prompt is missing (default)' },
  { id: 'broad',     label: 'Broad — refresh all VPs + customer context' },
  { id: 'messaging', label: 'Messaging — re-pull positioning + Gong color only' },
  { id: 'skip',      label: 'Skip — wizard already enriched everything; no extra research stage' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findProduct(slugOrLabel) {
  if (!slugOrLabel) return null;
  const s = String(slugOrLabel).trim().toLowerCase();
  return KNOWN_PRODUCTS.find(p => p.slug === s || p.label.toLowerCase() === s) || null;
}

function findIndustry(idOrLabel) {
  if (!idOrLabel) return null;
  const s = String(idOrLabel).trim().toLowerCase();
  return INDUSTRIES.find(i => i.id === s || i.label.toLowerCase() === s) || null;
}

function slugifyForRunId(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function suggestRunId(answers) {
  const parts = [
    todayISO(),
    answers.brand,
    (answers.industryLabel || '').replace(/\s*\/\s*/, '-'),
    (answers.products || []).map(p => p.label.replace(/^Plaid /, '')).join('-'),
    'v1',
  ];
  return parts.filter(Boolean).map(slugifyForRunId).join('-').replace(/-{2,}/g, '-');
}

// ─── Template filler ─────────────────────────────────────────────────────────

/**
 * Read the canonical app-only template and substitute the wizard's
 * structured answers in. Keeps unfilled regions of the template intact
 * so the agent's research pass can refine them.
 *
 * Anything the user did not supply remains as `«PLACEHOLDER»` so the
 * downstream research task knows what to enrich.
 */
function fillTemplateFromAnswers(answers, opts = {}) {
  if (!answers || typeof answers !== 'object') throw new Error('quickstart: answers required');
  const templatePath = opts.templatePath || TEMPLATE_PATH;
  if (!fs.existsSync(templatePath)) throw new Error(`quickstart: template not found at ${templatePath}`);
  const tpl = fs.readFileSync(templatePath, 'utf8');

  const productLabels = (answers.products || []).map(p => p.label).join(', ') || '«PRODUCTS»';
  const productSlugs  = (answers.products || []).map(p => `inputs/products/plaid-${p.slug}.md`).join(', ');
  const linkModeLine  = answers.linkMode === 'embedded'
    ? 'Plaid Link mode: embedded (in-page tile)'
    : 'Plaid Link mode: modal';
  const brandUrl = answers.brandDomain
    ? `Brand URL (optional): https://${String(answers.brandDomain).replace(/^https?:\/\//, '')}`
    : 'Brand URL (optional): «https://...»';

  const demoTitle = answers.demoTitle ||
    `${answers.brand || '«BRAND»'} — ${(answers.products || []).map(p => p.label.replace(/^Plaid /, '')).join(' + ') || '«PRODUCTS»'}`;
  const oneLineVP = answers.oneLineVP || answers.useCase || '«ONE-LINE VALUE PROPOSITION»';
  const userJourney = answers.useCase || '«PRIMARY_USER_JOURNEY_IN_ONE_SENTENCE»';

  // The wizard intentionally inserts a HEADER section at the very top that
  // captures the user's structured answers. The rest of the template is
  // preserved so the research pass + the LLM both keep their familiar
  // section structure.
  const wizardHeader =
    `WIZARD-COLLECTED INPUT (do not delete — research task reads these)\n` +
    `===============================================================================\n` +
    `Brand: ${answers.brand || '«BRAND»'}\n` +
    `Brand domain: ${answers.brandDomain || '«domain»'}\n` +
    `Industry: ${answers.industryLabel || '«industry»'} (id: ${answers.industry || 'other'})\n` +
    `Products: ${productLabels}\n` +
    `Per-product KB: ${productSlugs || '«none — add as research finds them»'}\n` +
    `${linkModeLine}\n` +
    `Persona: ${answers.persona || '«persona name + role»'}\n` +
    `Use case (user pitch): ${answers.useCase || '«one-sentence pitch»'}\n` +
    `Research depth: ${answers.researchDepth || 'gapfill'}\n` +
    `Suggested run id: ${suggestRunId(answers)}\n` +
    `===============================================================================\n\n` +
    `STATUS: DRAFT — generated by \`npm run quickstart\` on ${new Date().toISOString()}\n` +
    `        The matching \`inputs/quickstart-research-task.md\` will be picked up by your\n` +
    `        AI agent (Cursor / Claude Code) to run AskBill + Glean and refine the body.\n\n`;

  // Substitute the most-filled-in placeholders. We intentionally leave the
  // storyboard beats / sample data tables blank — those are filled by the
  // agent's research pass with real numbers.
  let body = tpl;
  body = body.replace(/«DEMO TITLE» — «ONE-LINE VALUE PROPOSITION»/, `${demoTitle} — ${oneLineVP}`);
  body = body.replace(/«HOST_APP_NAME» — «industry \/ segment»/, `${answers.brand || '«HOST_APP_NAME»'} — ${answers.industryLabel || '«industry / segment»'}`);
  body = body.replace(/Canonical URL: «https:\/\/\.\.\.»/, answers.brandDomain
    ? `Canonical URL: https://${String(answers.brandDomain).replace(/^https?:\/\//, '')}`
    : 'Canonical URL: «https://...»');
  body = body.replace(/Brand URL \(optional\): «https:\/\/\.\.\.»/, brandUrl);
  body = body.replace(/«PRIMARY_USER_JOURNEY_IN_ONE_SENTENCE»/, userJourney);
  body = body.replace(
    /«e\.g\. Plaid Link, Plaid Layer, Plaid Identity Verification \(IDV\), Plaid Auth, Plaid Signal»/,
    productLabels
  );

  return wizardHeader + body;
}

// ─── Research-task builder ───────────────────────────────────────────────────

/**
 * Produce an agent-ready markdown handoff that walks Cursor / Claude Code
 * through enriching the draft prompt with AskBill + Glean research.
 *
 * The agent reads the wizard-header in `inputs/prompt.txt`, runs the queries
 * we list below, persists VP refreshes to `inputs/products/plaid-<slug>.md`
 * (using the existing product-vp-freshness helper), and rewrites
 * `inputs/prompt.txt` with the storyboard + persona + sample data filled in.
 */
function buildResearchTaskMarkdown(answers, opts = {}) {
  if (!answers) throw new Error('quickstart: answers required');
  const products = answers.products || [];
  const buildAfter = !!opts.buildAfter;

  const productLines = products.length
    ? products.map(p => `- **${p.label}** (\`${p.slug}\`) — ${p.hint}`).join('\n')
    : '- _(no products selected — research task should pause and ask the user)_';

  const askBillBlock = products.length
    ? products.map(p =>
        `   - Product **${p.label}** (slug \`${p.slug}\`):\n` +
        `     - First check freshness via \`scripts/scratch/utils/product-vp-freshness.js\` ` +
        `→ \`isProductVpFresh('${p.slug}', 30)\`. If fresh, skip AskBill for this product.\n` +
        `     - If stale or missing, call \`mcp__user-askbill-plaid__ask_bill\` with:\n` +
        `       \`"What are the 3-5 strongest customer-facing value propositions for ${p.label}, ` +
        `with proof points, for a ${answers.industryLabel || 'fintech'} use case?"\`\n` +
        `     - Then call \`mcp__user-askbill-plaid__plaid_docs\` with:\n` +
        `       \`"Show the canonical request/response shape and key fields for ${p.label} on the ${answers.industry || 'retail'} flow."\`\n` +
        `     - Persist the VPs back via \`upsertValuePropositionsSection('${p.slug}', vpMarkdown)\` and ` +
        `\`stampVpResearchDate('${p.slug}', new Date())\` so future runs skip this work.`
      ).join('\n')
    : '   - _(no products — pause and ask the user which Plaid products to feature.)_';

  const gleanBlock =
    `   - Customer + industry context (Glean — \`mcp__user-glean_local__chat\`):\n` +
    `     - \`"Summarize how ${answers.brand || '<the customer>'} currently handles ${answers.useCase || 'this user journey'} ` +
    `and what their public messaging emphasizes."\`\n` +
    `     - \`"What recent Gong calls or sales conversations mention ${answers.brand || '<the customer>'}, ` +
    `${answers.industryLabel || answers.industry || 'this segment'}, or the products ${products.map(p => p.label).join(', ') || 'we plan to demo'}? ` +
    `Cite quotes."\`\n` +
    `     - \`"What are the most common objections from ${answers.industryLabel || 'this segment'} customers ` +
    `against ${products.map(p => p.label).join(', ') || 'these Plaid products'}, and how do reps overcome them?"\`\n` +
    `   - (Optional) \`mcp__user-glean_local__company_search\` with \`"${answers.brand || ''}"\` ` +
    `to confirm the canonical website + competitor set.`;

  const buildCmd = answers.researchDepth === 'skip'
    ? 'npm run pipe -- new --app-only --research=skip'
    : 'npm run pipe -- new --app-only';

  return (
    `# Quickstart research task — ${answers.brand || '(no brand)'}\n\n` +
    `> **What this is:** an agent-ready handoff produced by \`npm run quickstart\`. ` +
    `Open this file in Cursor or Claude Code in **Agent mode** and say "Run this task." ` +
    `The agent will use AskBill + Glean to enrich \`inputs/prompt.txt\`, then optionally start the build.\n\n` +
    `> **Why a handoff and not in-CLI?** AskBill + Glean are MCP servers and can only be invoked ` +
    `from inside an agent context (Cursor / Claude Code). The wizard cannot reach them from pure Node.js, ` +
    `so it pre-stages the inputs and lets the agent run the queries.\n\n` +
    `---\n\n` +
    `## CONTEXT\n\n` +
    `- **Brand:** ${answers.brand || '(unset)'}\n` +
    `- **Brand domain:** ${answers.brandDomain || '(unset)'}\n` +
    `- **Industry:** ${answers.industryLabel || '(unset)'} (\`${answers.industry || 'other'}\`)\n` +
    `- **Plaid Link mode:** ${answers.linkMode || 'modal'}\n` +
    `- **Persona:** ${answers.persona || '(unset)'}\n` +
    `- **Use case (user pitch):** ${answers.useCase || '(unset)'}\n` +
    `- **Research depth:** ${answers.researchDepth || 'gapfill'}\n\n` +
    `**Products to feature:**\n\n` +
    `${productLines}\n\n` +
    `---\n\n` +
    `## STEP 1 — Read the draft prompt the wizard wrote\n\n` +
    `\`inputs/prompt.txt\` already contains a \`WIZARD-COLLECTED INPUT\` header followed by the ` +
    `app-only template skeleton. Keep its structure; your job is to fill in the storyboard beats, ` +
    `persona details, and sample data with researched facts (not invented numbers).\n\n` +
    `---\n\n` +
    `## STEP 2 — AskBill: refresh per-product VPs (only when stale)\n\n` +
    `Use Plaid's per-product Markdown KB as the authority for baseline value props (\`inputs/products/plaid-*.md\`). ` +
    `Each file's frontmatter has a \`last_vp_research\` field with a 30-day freshness window. ` +
    `Only call AskBill for products whose VPs are missing or stale.\n\n` +
    askBillBlock + `\n\n` +
    `---\n\n` +
    `## STEP 3 — Glean: customer + industry context\n\n` +
    `Glean provides internal context (Gong calls, recent docs, competitive landing pages, ` +
    `objection-handling decks). Use it for what AskBill cannot answer: customer-specific deal mechanics, ` +
    `Gong color, recent objections, real numbers from past pilots.\n\n` +
    gleanBlock + `\n\n` +
    `---\n\n` +
    `## STEP 4 — Rewrite \`inputs/prompt.txt\`\n\n` +
    `With the research in hand, refine the prompt:\n\n` +
    `1. Replace remaining \`«placeholders»\` in the template body with concrete values ` +
    `(real persona name + occupation, plausible amounts, branded sample data).\n` +
    `2. Fill the **STORYBOARD BEATS** table with one row per scene, ordered. ` +
    `Use only \`host\` / \`link\` / \`insight\` scene types — no slides, this is app-only.\n` +
    `3. Add a **Compliance / user data** line if any product has regulatory implications ` +
    `(CRA permissible purpose, Signal sandbox personas, IDV jurisdiction).\n` +
    `4. Confirm the \`Products featured\` line matches what was selected in the wizard ` +
    `and that the per-product KB paths under \`Primary messaging file\` are real.\n` +
    `5. Drop the \`STATUS: DRAFT\` line at the top once the body is complete.\n\n` +
    `---\n\n` +
    `## STEP 5 — Sanity gate\n\n` +
    `Before kicking off the build, confirm:\n\n` +
    `- [ ] No remaining \`«...»\` placeholders in \`inputs/prompt.txt\`.\n` +
    `- [ ] Every featured product has a non-stale VP section in \`inputs/products/plaid-*.md\`.\n` +
    `- [ ] Storyboard ends on a host/insight outcome (no slide scenes).\n` +
    `- [ ] At least one quoted Gong / customer detail from Glean is woven into the storyboard or persona.\n\n` +
    `---\n\n` +
    `## STEP 6 — Build (${buildAfter ? 'auto' : 'optional'})\n\n` +
    (buildAfter
      ? `The user opted into "build after research". Once Step 5 passes, run:\n\n` +
        '```bash\n' + buildCmd + '\n```\n\n' +
        `…then monitor with \`npm run pipe -- logs --follow\`.\n`
      : `If the user wants to start the pipeline immediately:\n\n` +
        '```bash\n' + buildCmd + '\n```\n\n' +
        `Otherwise hand back to the user with a short summary of what changed in \`inputs/prompt.txt\`.\n`) +
    `\n---\n\n` +
    `_Generated by \`npm run quickstart\` at ${new Date().toISOString()}._\n`
  );
}

module.exports = {
  KNOWN_PRODUCTS,
  INDUSTRIES,
  LINK_MODES,
  RESEARCH_DEPTHS,
  findProduct,
  findIndustry,
  slugifyForRunId,
  suggestRunId,
  fillTemplateFromAnswers,
  buildResearchTaskMarkdown,
  TEMPLATE_PATH,
};
