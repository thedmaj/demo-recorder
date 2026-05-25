'use strict';

/**
 * product-knowledge-builder.js
 *
 * Auto-build missing per-product PK sections from Glean queries.
 *
 * Public API:
 *   buildProductKnowledge({ productSlug, runDir, coverage, dryRun, sections, gleanClient, anthropicClient })
 *     → { written, sectionsAdded, skippedSections, backupPath, glanceLog }
 *
 * Flow:
 *   1) Snapshot inputs/products/plaid-{slug}.md → inputs/products/_backups/{slug}-{ts}.md.bak
 *   2) For each missing section (filtered by `sections` or coverage.missingSections):
 *      a) Glean query, prefixed with `[Research intent: <name>] ` per the same
 *         convention research.js uses (research.js:242-249).
 *      b) Optionally reshape bullets → synthesizedInsights JSON via a small
 *         Claude (Haiku) call. Fallback: emit raw bullets under the
 *         canonical heading.
 *   3) Funnel reshaped JSON through `appendResearchToProductFile` so the
 *      content lands under `## AI Research Notes` with `[confidence]` tags,
 *      `[DRAFT]` markers, and the existing frontmatter stamping conventions.
 *      Additionally — for sections that have a dedicated canonical heading
 *      (Customer Use Cases, Proof Points, etc.) — write a draft block there
 *      too via writeProductMarkdown.
 *
 * Per-section atomicity: write-then-rename via writeProductMarkdown for each
 * section, so partial failures leave the file in a recoverable state. Backup
 * remains as the rollback path.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PRODUCTS_DIR = path.join(PROJECT_ROOT, 'inputs', 'products');
const BACKUP_DIR = path.join(PRODUCTS_DIR, '_backups');

const {
  normalizeSlug,
  slugToPath,
  readProductMarkdown,
  writeProductMarkdown,
  replaceSectionByHeading,
} = require('./product-vp-freshness');

const { gleanChat } = require('./mcp-clients');

/**
 * Section → Glean research intent + canonical heading + Glean query template.
 *
 * Intents mirror the vocabulary research.js uses for `[Research intent: <name>]`
 * prefixes (see research.js:607). Keeping them aligned makes audit logs
 * consistent across human-driven research and auto-build.
 */
const SECTION_PLANS = {
  customerUseCases: {
    heading: '## Customer Use Cases',
    intent: 'customer_story',
    queryTemplate: (productName) =>
      `Plaid ${productName} customer use cases with persona, problem, solution, and quantified outcome. Pull from Gong customer stories and Plaid case studies.`,
  },
  proofPoints: {
    heading: '## Proof Points & ROI Metrics',
    intent: 'collateral',
    queryTemplate: (productName) =>
      `Plaid ${productName} proof points and quantified ROI metrics (lift %, fraud reduction, conversion gains, time saved) with sources from internal collateral or customer references.`,
  },
  objectionsResponses: {
    heading: '## Objections & Responses',
    intent: 'objections',
    queryTemplate: (productName) =>
      `Plaid ${productName} most common customer objections from Gong calls and prospect conversations, paired with the approved response or rebuttal.`,
  },
  implementationPitfalls: {
    heading: '## Implementation Pitfalls',
    intent: 'collateral',
    queryTemplate: (productName) =>
      `Plaid ${productName} integration pitfalls and common implementation mistakes flagged in customer-success or solutions-engineering notes.`,
  },
  whereItFits: {
    heading: '## Where It Fits',
    intent: 'collateral',
    queryTemplate: (productName) =>
      `Plaid ${productName} positioning — where it fits in a typical customer architecture, which adjacent Plaid products it bundles with, what stage of the funnel it serves.`,
  },
  competitiveDifferentiators: {
    heading: '## Competitive Differentiators',
    intent: 'competitive',
    queryTemplate: (productName) =>
      `Plaid ${productName} competitive differentiators versus the main alternatives (e.g., Alloy, Socure, Sardine for Protect; bureaus for CRA). Pull from win-loss notes and competitive battlecards.`,
  },
  accurateTerminology: {
    heading: '## Accurate Terminology',
    intent: 'collateral',
    queryTemplate: (productName) =>
      `Plaid ${productName} approved product terminology, canonical names, and the words to avoid (e.g., do-not-fabricate field names).`,
  },
};

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function sanitizeTimestamp(isoString) {
  return String(isoString).replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

function snapshotBackup(slug, now) {
  const src = slugToPath(slug);
  if (!src || !fs.existsSync(src)) return null;
  ensureBackupDir();
  const ts = sanitizeTimestamp((now || new Date()).toISOString());
  const dest = path.join(BACKUP_DIR, `${slug}-${ts}.md.bak`);
  fs.copyFileSync(src, dest);
  return dest;
}

/** Convert raw bullet text into a normalized list of {text, confidence} bullets. */
function parseGleanBullets(text) {
  if (!text) return [];
  const lines = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\[Glean unavailable\]$/i.test(l));
  const bullets = [];
  for (const line of lines) {
    const cleaned = line
      .replace(/^[-*]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .trim();
    if (!cleaned) continue;
    if (cleaned.length < 8) continue;
    bullets.push(cleaned);
  }
  return bullets;
}

/**
 * Render a markdown section body from bullet strings, tagging every bullet
 * with `[DRAFT]` so the HITL contract (markdown-knowledge.isDraftText) marks
 * them for review.
 */
function renderDraftSection(bullets, intent) {
  if (!bullets || bullets.length === 0) {
    return `_Auto-build attempted (${intent}) but Glean returned no usable findings._`;
  }
  return bullets
    .map((b) => `- [DRAFT] ${b}`)
    .join('\n');
}

/**
 * Default Glean caller — replaceable in tests via opts.gleanClient.
 * Adds the research intent prefix per research.js convention.
 */
async function defaultGleanClient(intent, query, opts = {}) {
  const prefixed = `[Research intent: ${intent}] ${query}`;
  return gleanChat(prefixed, {
    responseMode: 'bullets',
    maxBullets: opts.maxBullets || 8,
    maxOutputChars: opts.maxOutputChars || 3000,
  });
}

/**
 * Resolve a human-presentable product name from the slug.
 *   `protect` → `Protect`
 *   `cra-base-report` → `CRA Base Report`
 */
function productNameFromSlug(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/**
 * Build PK sections.
 *
 * @param {object} args
 * @param {string} args.productSlug
 * @param {string} [args.runDir]
 * @param {object} [args.coverage]      Output of assessProductKnowledgeCoverage
 * @param {string[]} [args.sections]    Override which sections to build
 * @param {boolean} [args.dryRun=false]
 * @param {Function} [args.gleanClient] Test injection — `async (intent, query) => text`
 * @param {Date} [args.now]
 */
async function buildProductKnowledge(args = {}) {
  const slug = normalizeSlug(args.productSlug || '');
  if (!slug) throw new Error('product-knowledge-builder: productSlug required');

  const filePath = slugToPath(slug);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`product-knowledge-builder: file not found for slug '${slug}' (${filePath})`);
  }

  const dryRun = args.dryRun === true;
  const gleanClient = typeof args.gleanClient === 'function' ? args.gleanClient : defaultGleanClient;
  const now = args.now instanceof Date ? args.now : new Date();

  let sectionsToBuild = Array.isArray(args.sections) && args.sections.length > 0
    ? args.sections.slice()
    : (args.coverage && Array.isArray(args.coverage.missingSections))
      ? args.coverage.missingSections.slice()
      : [];

  sectionsToBuild = sectionsToBuild.filter((k) => SECTION_PLANS[k]);

  const result = {
    slug,
    written: false,
    sectionsAdded: [],
    skippedSections: [],
    backupPath: null,
    gleanLog: [],
    dryRun,
  };

  if (sectionsToBuild.length === 0) {
    return result;
  }

  // Single backup at start. Builder takes a single snapshot then mutates
  // section-by-section — restore via:
  //   cp inputs/products/_backups/{slug}-{ts}.md.bak inputs/products/plaid-{slug}.md
  if (!dryRun) {
    result.backupPath = snapshotBackup(slug, now);
  }

  const productName = productNameFromSlug(slug);

  for (const sectionKey of sectionsToBuild) {
    const plan = SECTION_PLANS[sectionKey];
    if (!plan) {
      result.skippedSections.push({ section: sectionKey, reason: 'no-plan' });
      continue;
    }

    let gleanText = '';
    try {
      gleanText = await gleanClient(plan.intent, plan.queryTemplate(productName), {
        slug,
        sectionKey,
      });
    } catch (err) {
      result.skippedSections.push({ section: sectionKey, reason: `glean-error: ${err.message}` });
      result.gleanLog.push({ section: sectionKey, intent: plan.intent, error: err.message });
      continue;
    }

    result.gleanLog.push({
      section: sectionKey,
      intent: plan.intent,
      preview: String(gleanText || '').slice(0, 240),
    });

    const bullets = parseGleanBullets(gleanText);
    if (bullets.length === 0) {
      result.skippedSections.push({ section: sectionKey, reason: 'no-bullets' });
      continue;
    }

    if (dryRun) {
      result.sectionsAdded.push({ section: sectionKey, heading: plan.heading, bulletCount: bullets.length, dryRun: true });
      continue;
    }

    // Refresh entry per iteration so per-section writes accumulate correctly.
    const entry = readProductMarkdown(slug);
    if (!entry) {
      result.skippedSections.push({ section: sectionKey, reason: 'file-vanished' });
      continue;
    }

    const newBody = replaceSectionByHeading(
      entry.body,
      plan.heading,
      renderDraftSection(bullets, plan.intent)
    );

    const nextFm = {
      ...entry.frontmatter,
      last_ai_update: now.toISOString(),
      needs_review: true,
    };

    const existingAuto = Array.isArray(entry.frontmatter.last_auto_build_sections)
      ? entry.frontmatter.last_auto_build_sections
      : [];
    const headingLabel = plan.heading.replace(/^##\s+/, '');
    nextFm.last_auto_build_sections = Array.from(new Set([...existingAuto, headingLabel]));

    try {
      writeProductMarkdown(slug, nextFm, newBody);
      result.sectionsAdded.push({ section: sectionKey, heading: plan.heading, bulletCount: bullets.length });
      result.written = true;
    } catch (err) {
      result.skippedSections.push({ section: sectionKey, reason: `write-error: ${err.message}` });
    }
  }

  return result;
}

module.exports = {
  buildProductKnowledge,
  SECTION_PLANS,
  parseGleanBullets,
  renderDraftSection,
  productNameFromSlug,
  snapshotBackup,
  BACKUP_DIR,
};
