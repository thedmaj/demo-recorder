'use strict';

/**
 * product-knowledge-coverage.js
 *
 * Assess `inputs/products/plaid-{slug}.md` coverage BEFORE the research tool
 * loop runs, so research can shrink to true gap-fill instead of re-running
 * the whole tool budget against information the PK file already contains.
 *
 * Public API:
 *   assessProductKnowledgeCoverage({ productSlug, runDir, solutionsMasterContext })
 *     → { slug, filePath, fileExists, frontmatter, sections, presentCount,
 *         missingSections, staleSections, confidence, recommendedMode,
 *         blockingGapsForScript }
 *
 * Heading detection: canonical headings first (per _template.md), then a
 * per-slug heading-alias map at inputs/products/_heading-aliases.json so
 * non-canonically-titled files like plaid-protect.md register correctly.
 *
 * Each section carries a `consumers: string[]` so callers can rank missing
 * sections by downstream impact (script-generator > dashboard-review).
 */

const fs = require('fs');
const path = require('path');

const {
  normalizeSlug,
  slugToPath,
  readProductMarkdown,
  extractSectionByHeading,
} = require('./product-vp-freshness');
const { computeStaleness } = require('./markdown-knowledge');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PRODUCTS_DIR = path.join(PROJECT_ROOT, 'inputs', 'products');
const ALIAS_FILE = path.join(PRODUCTS_DIR, '_heading-aliases.json');

/**
 * Canonical section catalog. Order matters for human-readable reports — keep
 * highest-stake (script-generator) sections first.
 *
 * `consumers` mirrors the actual downstream stages that read the section's
 * content; see scripts/scratch/utils/product-knowledge.js (script generator)
 * and scripts/scratch/utils/run-context.js (digest builder).
 */
const SECTION_CATALOG = [
  {
    key: 'valuePropositions',
    heading: '## Value Proposition Statements',
    minBullets: 3,
    consumers: ['script-generator', 'run-context'],
  },
  {
    key: 'customerUseCases',
    heading: '## Customer Use Cases',
    minBullets: 2,
    consumers: ['script-generator'],
  },
  {
    key: 'narrationTalkTracks',
    heading: '## Narration Talk Tracks',
    minBullets: 1,
    consumers: ['voiceover', 'run-context'],
  },
  {
    key: 'accurateTerminology',
    heading: '## Accurate Terminology',
    minBullets: 4,
    consumers: ['script-generator', 'build-qa'],
  },
  {
    key: 'competitiveDifferentiators',
    heading: '## Competitive Differentiators',
    minBullets: 2,
    consumers: ['script-generator'],
  },
  {
    key: 'proofPoints',
    heading: '## Proof Points & ROI Metrics',
    minBullets: 2,
    consumers: ['run-context'],
  },
  {
    key: 'objectionsResponses',
    heading: '## Objections & Responses',
    minBullets: 1,
    consumers: ['dashboard-review'],
  },
  {
    key: 'implementationPitfalls',
    heading: '## Implementation Pitfalls',
    minBullets: 1,
    consumers: ['dashboard-review'],
  },
  {
    key: 'overview',
    heading: '## Overview',
    minBullets: 0,
    minChars: 80,
    consumers: ['script-generator'],
  },
  {
    key: 'whereItFits',
    heading: '## Where It Fits',
    minBullets: 0,
    minChars: 80,
    consumers: ['script-generator'],
  },
];

let _aliasCache = null;
function loadHeadingAliases() {
  if (_aliasCache) return _aliasCache;
  try {
    const raw = fs.readFileSync(ALIAS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    _aliasCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    _aliasCache = {};
  }
  return _aliasCache;
}

/** Reset cache. Test-only. */
function _resetAliasCache() {
  _aliasCache = null;
}

function aliasesFor(slug) {
  const map = loadHeadingAliases();
  const fromSlug = (map && map[slug]) || {};
  const fromDefault = (map && map._default) || {};
  return { ...fromDefault, ...fromSlug };
}

function countBulletsInSection(text) {
  if (!text) return 0;
  return text
    .split('\n')
    .filter((line) => /^[-*]\s+/.test(line.trim()) || /^\|.*\|/.test(line.trim()))
    .length;
}

/**
 * Extract a section's body by trying the canonical heading first, then any
 * aliases configured for this slug. Returns { body, headingUsed } or null.
 */
function extractSectionWithAliases(body, canonicalHeading, aliasHeadings) {
  const canonical = extractSectionByHeading(body, canonicalHeading);
  if (canonical && canonical.trim().length > 0) {
    return { body: canonical, headingUsed: canonicalHeading };
  }
  for (const alias of aliasHeadings || []) {
    const aliasHeading = alias.startsWith('## ') ? alias : `## ${alias}`;
    const aliasBody = extractSectionByHeading(body, aliasHeading);
    if (aliasBody && aliasBody.trim().length > 0) {
      return { body: aliasBody, headingUsed: aliasHeading };
    }
  }
  return null;
}

/**
 * @param {object} args
 * @param {string} args.productSlug
 * @param {string} [args.runDir]                 Not used directly but kept for
 *                                               symmetry with builder + future
 *                                               write-back of pk-coverage.json
 *                                               (research.js writes it itself).
 * @param {object} [args.solutionsMasterContext] Optional Solutions Master
 *                                               cache; lets the assessor mark
 *                                               valuePropositions as
 *                                               consumer-satisfied even if
 *                                               the markdown file is thin.
 * @param {Date}   [args.now]                    For deterministic testing.
 * @param {number} [args.staleDaysThreshold]     Override (default 30).
 */
function assessProductKnowledgeCoverage(args = {}) {
  const slug = normalizeSlug(args.productSlug || '');
  const now = args.now instanceof Date ? args.now : new Date();
  const staleDaysThreshold = Number.isFinite(args.staleDaysThreshold)
    ? args.staleDaysThreshold
    : 30;

  const filePath = slugToPath(slug);
  const result = {
    slug,
    filePath: filePath ? path.relative(PROJECT_ROOT, filePath) : null,
    fileExists: false,
    frontmatter: {},
    sections: {},
    presentCount: 0,
    missingSections: [],
    staleSections: [],
    confidence: 'low',
    recommendedMode: 'full',
    blockingGapsForScript: [],
  };

  if (!slug || !filePath) {
    return result;
  }

  if (!fs.existsSync(filePath)) {
    for (const def of SECTION_CATALOG) {
      result.sections[def.key] = {
        present: false,
        bulletCount: 0,
        charCount: 0,
        stale: false,
        consumers: def.consumers.slice(),
        headingUsed: null,
      };
      result.missingSections.push(def.key);
    }
    return result;
  }

  const entry = readProductMarkdown(slug);
  if (!entry) return result;

  result.fileExists = true;
  result.frontmatter = entry.frontmatter || {};
  result.filePath = path.relative(PROJECT_ROOT, entry.filePath);

  const aliasMap = aliasesFor(slug);

  // Staleness — uses last_ai_update if present, falls back to last_vp_research.
  // computeStaleness reads `last_human_review` by default; we feed it the
  // freshest "ai-content-touched" timestamp.
  const aiStamp =
    result.frontmatter.last_ai_update ||
    result.frontmatter.last_auto_build ||
    result.frontmatter.last_vp_research ||
    null;
  const stalenessProbe = computeStaleness(
    { last_human_review: aiStamp },
    { staleDaysThreshold }
  );

  for (const def of SECTION_CATALOG) {
    const aliases = aliasMap[def.key] || [];
    const extracted = extractSectionWithAliases(entry.body, def.heading, aliases);
    if (!extracted) {
      result.sections[def.key] = {
        present: false,
        bulletCount: 0,
        charCount: 0,
        stale: false,
        consumers: def.consumers.slice(),
        headingUsed: null,
      };
      result.missingSections.push(def.key);
      continue;
    }

    const bulletCount = countBulletsInSection(extracted.body);
    const charCount = extracted.body.length;
    const hasEnoughBullets = (def.minBullets || 0) === 0 || bulletCount >= def.minBullets;
    const hasEnoughChars = (def.minChars || 0) === 0 || charCount >= def.minChars;
    const present = hasEnoughBullets && hasEnoughChars;
    const stale = stalenessProbe.staleByAge === true;

    result.sections[def.key] = {
      present,
      bulletCount,
      charCount,
      stale,
      consumers: def.consumers.slice(),
      headingUsed: extracted.headingUsed,
    };

    if (!present) result.missingSections.push(def.key);
    if (stale && present) result.staleSections.push(def.key);
  }

  result.presentCount = SECTION_CATALOG.length - result.missingSections.length;

  // Blocking-for-script: missing sections whose consumers include the script
  // generator. These are the gaps research must close before script can run.
  result.blockingGapsForScript = result.missingSections.filter((key) => {
    const def = SECTION_CATALOG.find((d) => d.key === key);
    return def && def.consumers.includes('script-generator');
  });

  // Solutions Master can satisfy valuePropositions without a markdown section.
  if (
    result.blockingGapsForScript.includes('valuePropositions') &&
    args.solutionsMasterContext &&
    Array.isArray(args.solutionsMasterContext.valuePropositionStatements) &&
    args.solutionsMasterContext.valuePropositionStatements.length > 0
  ) {
    result.blockingGapsForScript = result.blockingGapsForScript.filter(
      (k) => k !== 'valuePropositions'
    );
  }

  // Confidence + recommended mode.
  //
  //  HIGH   (skip)     — no blocking script-tier gaps, ≥8/10 present, not stale.
  //                      The PK file alone is enough to drive script/build.
  //  MEDIUM (gapfill)  — ≤2 blocking gaps and ≥5/10 present. Research only
  //                      runs targeted tool calls to fill the gaps.
  //  LOW    (full)     — otherwise. Research runs its full tool budget.
  if (
    result.blockingGapsForScript.length === 0 &&
    result.presentCount >= 8 &&
    result.staleSections.length === 0
  ) {
    result.confidence = 'high';
    result.recommendedMode = 'skip';
  } else if (
    result.blockingGapsForScript.length <= 2 &&
    result.presentCount >= 5
  ) {
    result.confidence = 'medium';
    result.recommendedMode = 'gapfill';
  } else {
    result.confidence = 'low';
    result.recommendedMode = 'full';
  }

  return result;
}

/**
 * Human-readable rendering of the coverage result for pipeline logs / CLI.
 */
function formatCoverageReport(coverage) {
  if (!coverage) return '';
  const rows = [];
  rows.push(`Coverage for ${coverage.slug || '(unknown)'} — ${coverage.filePath || 'file missing'}`);
  rows.push(`Confidence: ${coverage.confidence}  recommendedMode: ${coverage.recommendedMode}`);
  rows.push(`Present: ${coverage.presentCount}/${SECTION_CATALOG.length}` +
    (coverage.staleSections.length ? `  staleSections: ${coverage.staleSections.join(', ')}` : ''));
  if (coverage.blockingGapsForScript.length) {
    rows.push(`Blocking gaps (script-tier): ${coverage.blockingGapsForScript.join(', ')}`);
  }
  rows.push('');
  rows.push('  Section                       Present  Bullets  Stale  Heading');
  rows.push('  ----------------------------- -------  -------  -----  -------------------------------');
  for (const def of SECTION_CATALOG) {
    const s = coverage.sections[def.key] || {};
    rows.push(
      '  ' +
      def.key.padEnd(29) + ' ' +
      String(s.present ? 'yes' : 'no').padEnd(8) +
      String(s.bulletCount || 0).padEnd(9) +
      String(s.stale ? 'yes' : 'no').padEnd(7) +
      (s.headingUsed || '(none)')
    );
  }
  return rows.join('\n');
}

module.exports = {
  assessProductKnowledgeCoverage,
  formatCoverageReport,
  SECTION_CATALOG,
  _resetAliasCache,
  _aliasesFor: aliasesFor,
};
