'use strict';
/**
 * product-vp-freshness.js
 *
 * Per-product Value Proposition freshness tracking. Replaces the legacy
 * `inputs/plaid-value-props.md` monolith with per-product markdown files in
 * `inputs/products/plaid-<slug>.md`, each carrying a `last_vp_research` date
 * in its YAML frontmatter.
 *
 * The pipeline consults `isProductVpFresh(slug)` before doing a Glean /
 * AskBill lookup:
 *   - fresh (<30d)  → reuse the file's `## Value Proposition Statements`
 *                     section; do NOT query.
 *   - stale / new   → research runs the query and writes the results back
 *                     into the file via `upsertValuePropositionsSection`,
 *                     then bumps `last_vp_research` via `stampVpResearchDate`.
 *
 * Research for industry context, use-case nuance, Gong color, competitive
 * positioning, and deal mechanics is NOT covered by this freshness check —
 * those signals change frequently and always need a fresh query.
 *
 * Pure I/O helpers; safe to unit test.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const INPUTS_DIR = path.join(PROJECT_ROOT, 'inputs');
const PRODUCTS_DIR = path.join(INPUTS_DIR, 'products');

const DEFAULT_MAX_AGE_DAYS = 30;
const VP_SECTION_HEADING = '## Value Proposition Statements';

/**
 * Slug normalization: `'auth'`, `'plaid-auth'`, `'Plaid Auth'`, `'plaid-auth.md'`
 * → `'auth'`. Leaves kebab-case multi-word slugs alone (`'cra-base-report'`).
 */
function normalizeSlug(input) {
  if (input == null) return '';
  let s = String(input).trim().toLowerCase();
  s = s.replace(/\.md$/i, '');
  s = s.replace(/^plaid[-_ ]?/, '');
  s = s.replace(/\s+/g, '-');
  return s;
}

function slugToPath(slug) {
  const clean = normalizeSlug(slug);
  if (!clean) return null;
  return path.join(PRODUCTS_DIR, `plaid-${clean}.md`);
}

/**
 * Minimal YAML frontmatter parser — top-level scalar / array / quoted strings.
 * Keeps deps zero. Matches what the dashboard server's parseFrontmatter does.
 */
function parseFrontmatter(markdown) {
  const text = String(markdown || '');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { frontmatter: {}, body: text, raw: '' };
  const block = m[1];
  const out = {};
  const lines = block.split('\n');
  let pendingKey = null;
  let pendingArr = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const arrayItem = line.match(/^\s*-\s+(.*)$/);
    if (arrayItem && pendingKey) {
      if (!Array.isArray(pendingArr)) pendingArr = [];
      let v = arrayItem[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      pendingArr.push(v);
      out[pendingKey] = pendingArr;
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    pendingKey = kv[1];
    let val = kv[2].trim();
    if (!val) {
      pendingArr = [];
      out[pendingKey] = pendingArr;
      continue;
    }
    pendingArr = null;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[pendingKey] = val;
  }
  return { frontmatter: out, body: text.slice(m[0].length), raw: m[0] };
}

function serializeFrontmatter(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
    } else if (v === null || v === undefined) {
      lines.push(`${k}: ""`);
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      lines.push(`${k}: ${v}`);
    } else {
      const s = String(v);
      const needsQuote = /[:#\-\[\]\{\}"']/.test(s) || /^\s|\s$/.test(s);
      lines.push(`${k}: ${needsQuote ? `"${s.replace(/"/g, '\\"')}"` : s}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

function readProductMarkdown(slug) {
  const file = slugToPath(slug);
  if (!file) return null;
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const { frontmatter, body } = parseFrontmatter(text);
  return { slug: normalizeSlug(slug), filePath: file, frontmatter, body, raw: text };
}

function writeProductMarkdown(slug, frontmatter, body) {
  const file = slugToPath(slug);
  if (!file) throw new Error(`Invalid slug: ${slug}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = serializeFrontmatter(frontmatter) + '\n' + body.replace(/^\n+/, '');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Extracts the Value Proposition Statements section (heading + body up to
 * the next `## ` heading or EOF). Returns null when missing.
 */
function readValuePropositionsSection(slug) {
  const entry = readProductMarkdown(slug);
  if (!entry) return null;
  return extractSectionByHeading(entry.body, VP_SECTION_HEADING);
}

function extractSectionByHeading(body, heading) {
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`);
  const m = String(body || '').match(re);
  if (!m) return null;
  return m[2].trim();
}

function replaceSectionByHeading(body, heading, newContent) {
  const source = String(body || '');
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)${escaped}\\s*\\n[\\s\\S]*?(?=\\n## |\\n# |$)`);
  const replacement = `${heading}\n${String(newContent).replace(/\s+$/, '')}\n`;
  if (re.test(source)) {
    return source.replace(re, (full, prefix) => `${prefix}${replacement.trim()}\n`);
  }
  // Append section just before the next `## ` block, or at the end.
  const trimmed = source.replace(/\s+$/, '');
  return `${trimmed}\n\n${replacement}`;
}

/**
 * Upsert the `## Value Proposition Statements` section for the given slug.
 * Creates the product file if it does not exist (minimal frontmatter).
 * Also stamps `last_vp_research` to today's ISO date.
 *
 * @param {string} slug
 * @param {string} valuePropMarkdown  Contents of the section (NO heading; we add it).
 * @param {{ now?: Date, extraFrontmatter?: object }} [opts]
 * @returns {{ filePath: string, created: boolean, dateIso: string }}
 */
function upsertValuePropositionsSection(slug, valuePropMarkdown, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dateIso = now.toISOString().split('T')[0];
  const existing = readProductMarkdown(slug);

  if (existing) {
    const fm = { ...existing.frontmatter };
    fm.last_vp_research = dateIso;
    if (opts.extraFrontmatter && typeof opts.extraFrontmatter === 'object') {
      Object.assign(fm, opts.extraFrontmatter);
    }
    const newBody = replaceSectionByHeading(existing.body, VP_SECTION_HEADING, valuePropMarkdown);
    const filePath = writeProductMarkdown(slug, fm, newBody);
    return { filePath, created: false, dateIso };
  }

  const clean = normalizeSlug(slug);
  const fm = {
    product: `Plaid ${clean.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')}`,
    slug: clean,
    last_vp_research: dateIso,
    source: 'research-auto-seed',
    version: 1,
    ...(opts.extraFrontmatter || {}),
  };
  const body =
    `# ${fm.product}\n\n` +
    `## Overview\n_Pending human review — auto-seeded from research phase on ${dateIso}._\n\n` +
    `${VP_SECTION_HEADING}\n${String(valuePropMarkdown).replace(/\s+$/, '')}\n`;
  const filePath = writeProductMarkdown(clean, fm, body);
  return { filePath, created: true, dateIso };
}

/**
 * Returns true when the product file exists, has a `last_vp_research` date,
 * has a `## Value Proposition Statements` section with content, and the
 * research date is within `maxAgeDays` of now.
 */
function isProductVpFresh(slug, opts = {}) {
  const maxAgeDays = Number.isFinite(opts.maxAgeDays) ? opts.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const entry = readProductMarkdown(slug);
  if (!entry) return false;
  const raw = entry.frontmatter && entry.frontmatter.last_vp_research;
  if (!raw) return false;
  const ageDays = daysBetween(new Date(String(raw)), now);
  if (ageDays == null || ageDays < 0 || ageDays > maxAgeDays) return false;
  const section = extractSectionByHeading(entry.body, VP_SECTION_HEADING);
  if (!section || section.trim().length < 10) return false;
  return true;
}

function daysBetween(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date) || isNaN(a) || isNaN(b)) return null;
  const diffMs = b.getTime() - a.getTime();
  return diffMs / (24 * 60 * 60 * 1000);
}

/**
 * Diagnostic: returns { fresh, ageDays, reason, vpSectionPresent, filePath } for a slug.
 * Useful for dashboards and pipeline logging.
 */
function describeProductVpFreshness(slug, opts = {}) {
  const maxAgeDays = Number.isFinite(opts.maxAgeDays) ? opts.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const file = slugToPath(slug);
  if (!file) return { fresh: false, reason: 'invalid-slug' };
  if (!fs.existsSync(file)) return { fresh: false, reason: 'file-missing', filePath: file };
  const entry = readProductMarkdown(slug);
  const fmDate = entry && entry.frontmatter && entry.frontmatter.last_vp_research;
  if (!fmDate) return { fresh: false, reason: 'no-last-vp-research', filePath: file, vpSectionPresent: !!extractSectionByHeading(entry.body, VP_SECTION_HEADING) };
  const ageDays = daysBetween(new Date(String(fmDate)), now);
  if (ageDays == null) return { fresh: false, reason: 'invalid-date', filePath: file, lastVpResearch: fmDate };
  const vpSection = extractSectionByHeading(entry.body, VP_SECTION_HEADING);
  const vpSectionPresent = !!(vpSection && vpSection.trim().length >= 10);
  if (!vpSectionPresent) return { fresh: false, reason: 'no-vp-section', ageDays, lastVpResearch: fmDate, filePath: file, vpSectionPresent };
  if (ageDays > maxAgeDays) return { fresh: false, reason: 'stale', ageDays, lastVpResearch: fmDate, filePath: file, vpSectionPresent };
  return { fresh: true, reason: 'ok', ageDays, lastVpResearch: fmDate, filePath: file, vpSectionPresent };
}

/**
 * Stamp `last_vp_research` without touching the VP section. Useful when a
 * human has edited the VP body directly via the dashboard and wants to
 * signal "this is now fresh for 30 days".
 */
function stampVpResearchDate(slug, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dateIso = now.toISOString().split('T')[0];
  const entry = readProductMarkdown(slug);
  if (!entry) return null;
  const fm = { ...entry.frontmatter, last_vp_research: dateIso };
  const filePath = writeProductMarkdown(slug, fm, entry.body);
  return { filePath, dateIso };
}

module.exports = {
  DEFAULT_MAX_AGE_DAYS,
  VP_SECTION_HEADING,
  normalizeSlug,
  slugToPath,
  parseFrontmatter,
  serializeFrontmatter,
  readProductMarkdown,
  writeProductMarkdown,
  readValuePropositionsSection,
  extractSectionByHeading,
  replaceSectionByHeading,
  upsertValuePropositionsSection,
  isProductVpFresh,
  describeProductVpFreshness,
  stampVpResearchDate,
};
