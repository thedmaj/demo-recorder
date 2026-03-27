'use strict';

const fs = require('fs');
const path = require('path');
const { getProductProfile } = require('./product-profiles');

const PROJECT_ROOT = path.resolve(__dirname, '../..', '..');
const INPUTS_DIR   = path.join(PROJECT_ROOT, 'inputs');
const PRODUCTS_DIR = path.join(INPUTS_DIR, 'products');
const QA_FIX_LOG   = path.join(INPUTS_DIR, 'qa-fix-log.md');

function readIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function extractSection(markdown, heading) {
  if (!markdown) return '';
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = markdown.match(re);
  return match ? match[1].trim() : '';
}

function loadProductKnowledgeForFamily(family) {
  const profile = getProductProfile(family);
  const knowledgeFiles = [];

  for (const slug of profile.kbSlugs || []) {
    const filePath = path.join(PRODUCTS_DIR, `plaid-${slug}.md`);
    const markdown = readIfExists(filePath);
    if (!markdown) continue;
    knowledgeFiles.push({
      slug,
      filePath,
      markdown,
      overview: extractSection(markdown, 'Overview'),
      whereItFits: extractSection(markdown, 'Where It Fits'),
      narrationTalkTracks: extractSection(markdown, 'Narration Talk Tracks'),
      accurateTerminology: extractSection(markdown, 'Accurate Terminology'),
      differentiators: extractSection(markdown, 'Competitive Differentiators'),
      aiResearchNotes: extractSection(markdown, 'AI Research Notes'),
    });
  }

  return knowledgeFiles;
}

function loadQaFixLogExcerpt(family) {
  const markdown = readIfExists(QA_FIX_LOG);
  if (!markdown) return '';

  const genericSections = [
    'Category 1 — Missing Right-Side JSON Panel',
    'Category 2 — Navigation / goToStep Not Firing',
    'Category 3 — Late Step Transitions (Start Frame Shows Previous Step)',
    'Category 5 — Two-Layer Branding Bleed',
  ];

  const familySpecific = {
    funding: ['Category 6 — Insight Screen Layout Collapse (Right Half Empty/Gray)'],
    cra_base_report: ['Category 6 — Insight Screen Layout Collapse (Right Half Empty/Gray)'],
    income_insights: ['Category 6 — Insight Screen Layout Collapse (Right Half Empty/Gray)'],
  };

  const headings = [...genericSections, ...(familySpecific[family] || [])];
  const excerpts = [];
  for (const heading of headings) {
    const section = extractSection(markdown, heading);
    if (section) excerpts.push(`## ${heading}\n${section}`);
  }
  return excerpts.join('\n\n');
}

function buildCuratedProductKnowledge(family) {
  const knowledgeFiles = loadProductKnowledgeForFamily(family);
  const qaFixLogExcerpt = loadQaFixLogExcerpt(family);
  return {
    family,
    knowledgeFiles: knowledgeFiles.map(file => ({
      slug: file.slug,
      source: path.relative(PROJECT_ROOT, file.filePath),
      overview: file.overview,
      whereItFits: file.whereItFits,
      narrationTalkTracks: file.narrationTalkTracks,
      accurateTerminology: file.accurateTerminology,
      differentiators: file.differentiators,
      aiResearchNotes: file.aiResearchNotes,
    })),
    qaFixLogExcerpt,
  };
}

/**
 * Truncate long section text to first N bullet lines + char budget (context engineering).
 * @param {string} text
 * @param {{ maxBullets?: number, maxChars?: number }} opts
 */
function truncateSectionByBullets(text, opts = {}) {
  if (!text) return '';
  const maxBullets = opts.maxBullets != null ? opts.maxBullets : 14;
  const maxChars = opts.maxChars != null ? opts.maxChars : 2800;
  const lines = text.split('\n');
  const out = [];
  let bullets = 0;
  for (const line of lines) {
    const t = line.trim();
    if (/^[-*]\s+/.test(t)) {
      bullets++;
      if (bullets > maxBullets) break;
    }
    out.push(line);
    if (out.join('\n').length > maxChars) {
      return out.slice(0, -1).join('\n').slice(0, maxChars) + '\n…';
    }
  }
  const joined = out.join('\n');
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}\n…`;
}

/**
 * Budgeted digest for prompts (replaces dumping full sections).
 * @param {ReturnType<typeof buildCuratedProductKnowledge>} curated
 * @param {{ maxBulletsPerSection?: number, maxCharsPerSection?: number, maxQaFixLogChars?: number }} opts
 */
function buildCuratedDigest(curated, opts = {}) {
  if (!curated || typeof curated !== 'object') return { family: 'generic', files: [], qaFixLogExcerpt: '' };
  const maxBullets = opts.maxBulletsPerSection != null
    ? opts.maxBulletsPerSection
    : parseInt(process.env.CONTEXT_MAX_BULLETS_PER_SECTION || '14', 10);
  const maxChars = opts.maxCharsPerSection != null
    ? opts.maxCharsPerSection
    : parseInt(process.env.CONTEXT_MAX_SECTION_CHARS || '2800', 10);
  const maxQa = opts.maxQaFixLogChars != null
    ? opts.maxQaFixLogChars
    : parseInt(process.env.CONTEXT_MAX_QA_FIXLOG_CHARS || '2400', 10);

  const secOpts = { maxBullets, maxChars };
  const knowledgeFiles = (curated.knowledgeFiles || []).map(f => ({
    slug: f.slug,
    source: f.source,
    overview: truncateSectionByBullets(f.overview, secOpts),
    whereItFits: truncateSectionByBullets(f.whereItFits, secOpts),
    narrationTalkTracks: truncateSectionByBullets(f.narrationTalkTracks, secOpts),
    accurateTerminology: truncateSectionByBullets(f.accurateTerminology, secOpts),
    differentiators: truncateSectionByBullets(f.differentiators, secOpts),
    aiResearchNotes: truncateSectionByBullets(f.aiResearchNotes, { maxBullets: Math.min(maxBullets, 8), maxChars: Math.min(maxChars, 2000) }),
  }));

  let qaFix = curated.qaFixLogExcerpt || '';
  if (qaFix.length > maxQa) qaFix = `${qaFix.slice(0, maxQa)}\n…`;

  return {
    family: curated.family,
    knowledgeFiles,
    qaFixLogExcerpt: qaFix,
  };
}

module.exports = {
  buildCuratedProductKnowledge,
  buildCuratedDigest,
  extractSection,
  loadProductKnowledgeForFamily,
  loadQaFixLogExcerpt,
};
