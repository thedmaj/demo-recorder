'use strict';

/**
 * Load the Plaid integration skill (.skill ZIP) for injection into pipeline prompts.
 * Default archive: skills/plaid-integration.skill (override with PLAID_SKILL_ZIP).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let AdmZip;
try {
  AdmZip = require('adm-zip');
} catch (_) {
  AdmZip = null;
}

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_SKILL_REL = path.join('skills', 'plaid-integration.skill');
const ZIP_INTERNAL_PREFIX = 'plaid-integration/';

/** @type {Record<string, string[]>} base paths inside plaid-integration/ */
const FAMILY_BASE_FILES = {
  generic: ['SKILL.md', 'references/quick-start.md'],
  funding: [
    'references/quick-start.md',
    'references/products/auth.md',
    'references/products/identity.md',
    'references/products/signal.md',
  ],
  cra_base_report: ['references/quick-start.md', 'references/products/cra.md'],
  income_insights: [
    'references/quick-start.md',
    'references/products/cra.md',
    'references/products/income.md',
  ],
};

/** Keyword in prompt / endpoint substring → skill file under references/products/ */
const PRODUCT_FILE_TRIGGERS = [
  { re: /\blayer\b|\/session\/token/i, file: 'references/products/layer.md' },
  { re: /\boauth\b|oauth/i, file: 'references/oauth.md' },
  { re: /\/signal\/|signal\/evaluate|\bsignal\b/i, file: 'references/products/signal.md' },
  { re: /\/auth\/|auth\/get|\binstant auth\b/i, file: 'references/products/auth.md' },
  { re: /identity\/match|identity match|\bidentity\b/i, file: 'references/products/identity.md' },
  { re: /\bidv\b|identity.verif/i, file: 'references/products/idv.md' },
  { re: /\bmonitor\b/i, file: 'references/products/monitor.md' },
  { re: /\bassets\b|\/assets\//i, file: 'references/products/assets.md' },
  { re: /\btransfer\b|\/transfer\//i, file: 'references/products/transfer.md' },
  { re: /\btransactions\b/i, file: 'references/products/transactions.md' },
  { re: /\bcra\b|consumer report|base report|cra_base/i, file: 'references/products/cra.md' },
  { re: /income_insights|income insights|\/income_insights/i, file: 'references/products/income.md' },
  { re: /\bbank income\b|payroll income/i, file: 'references/products/income.md' },
  { re: /\bprotect\b/i, file: 'references/products/protect.md' },
  { re: /\benrich\b/i, file: 'references/products/enrich.md' },
  { re: /\bstatements\b/i, file: 'references/products/statements.md' },
  { re: /\bbalance\b/i, file: 'references/products/balance.md' },
  { re: /\binvestments\b/i, file: 'references/products/investments.md' },
  { re: /\bliabilities\b/i, file: 'references/products/liabilities.md' },
];

const DEFAULT_MAX_CHARS = parseInt(process.env.PLAID_SKILL_MAX_CHARS || '28000', 10);
const SKILL_MD_TRIM = parseInt(process.env.PLAID_SKILL_SKILLMD_MAX_CHARS || '9000', 10);

function getDefaultSkillZipPath() {
  const env = process.env.PLAID_SKILL_ZIP;
  if (env && fs.existsSync(env)) return path.resolve(env);
  const def = path.join(PROJECT_ROOT, DEFAULT_SKILL_REL);
  return def;
}

function sha256File(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(absPath));
  return h.digest('hex');
}

/**
 * @param {string} zipPath
 * @returns {import('adm-zip')|null}
 */
function openSkillZip(zipPath) {
  if (!AdmZip || !zipPath || !fs.existsSync(zipPath)) return null;
  try {
    return new AdmZip(zipPath);
  } catch (_) {
    return null;
  }
}

/**
 * @param {import('adm-zip')} zip
 * @param {string} relativePath path under plaid-integration/ (no prefix)
 */
function readZipMember(zip, relativePath) {
  if (!zip) return null;
  const full = ZIP_INTERNAL_PREFIX + relativePath.replace(/^\//, '');
  const entry = zip.getEntry(full);
  if (!entry || entry.isDirectory) return null;
  try {
    return entry.getData().toString('utf8');
  } catch (_) {
    return null;
  }
}

/**
 * Collect skill member paths to include for this run.
 * @param {string} productFamily
 * @param {{ promptText?: string, demoScript?: object }} signals
 * @returns {string[]} relative paths under plaid-integration/
 */
function resolveMemberPaths(productFamily, signals = {}) {
  const family = FAMILY_BASE_FILES[productFamily] ? productFamily : 'generic';
  const paths = [...FAMILY_BASE_FILES[family]];
  const text = `${signals.promptText || ''}\n${JSON.stringify(signals.demoScript || {})}`;
  for (const { re, file } of PRODUCT_FILE_TRIGGERS) {
    if (re.test(text) && !paths.includes(file)) paths.push(file);
  }
  if (/\boauth\b/i.test(text) && !paths.includes('references/oauth.md')) {
    paths.push('references/oauth.md');
  }
  return paths;
}

function truncateSkillMd(content) {
  if (!content || content.length <= SKILL_MD_TRIM) return content;
  return (
    content.slice(0, SKILL_MD_TRIM) +
    '\n\n… [SKILL.md truncated by PLAID_SKILL_SKILLMD_MAX_CHARS for context budget]\n'
  );
}

/**
 * @param {string} productFamily
 * @param {{ zipPath?: string, maxChars?: number, promptText?: string, demoScript?: object }} opts
 * @returns {{
 *   text: string,
 *   skillLoaded: boolean,
 *   zipPath: string|null,
 *   sha256: string|null,
 *   members: Array<{ path: string, chars: number }>,
 * }}
 */
function getPlaidSkillBundleForFamily(productFamily, opts = {}) {
  const zipPath = opts.zipPath || getDefaultSkillZipPath();
  const maxChars = opts.maxChars != null ? opts.maxChars : DEFAULT_MAX_CHARS;
  const zip = openSkillZip(zipPath);
  const sha256 = sha256File(zipPath);

  if (!zip) {
    return {
      text: '',
      skillLoaded: false,
      zipPath: fs.existsSync(zipPath) ? zipPath : null,
      sha256,
      members: [],
    };
  }

  const memberRelPaths = resolveMemberPaths(productFamily, {
    promptText: opts.promptText,
    demoScript: opts.demoScript,
  });

  const parts = [];
  const members = [];
  let total = 0;

  const header =
    '## PLAID INTEGRATION SKILL (authoritative technical baseline)\n\n' +
    'The following excerpts are from the repo-bundled Plaid integration skill. ' +
    'Prefer this content for product flows, endpoints, and Link integration. ' +
    'Demo-specific DOM, Playwright, and recording rules in the build prompt still apply.\n\n';

  total += header.length;
  let budget = maxChars - total;

  for (const rel of memberRelPaths) {
    let body = readZipMember(zip, rel);
    if (body == null) continue;
    if (rel === 'SKILL.md') body = truncateSkillMd(body);
    const block = `### Skill file: \`${rel}\`\n\n${body}\n\n`;
    if (block.length > budget) {
      const slice = block.slice(0, Math.max(0, budget - 80));
      parts.push(
        slice +
          (block.length > budget ? '\n… [truncated for context budget]\n' : '')
      );
      members.push({ path: rel, chars: slice.length });
      break;
    }
    parts.push(block);
    members.push({ path: rel, chars: body.length });
    budget -= block.length;
  }

  const text = header + parts.join('');
  return {
    text,
    skillLoaded: members.length > 0,
    zipPath,
    sha256,
    members,
  };
}

/**
 * Write manifest for audit / reproducibility.
 * @param {string} runDir
 * @param {object} meta
 */
function writePlaidSkillManifest(runDir, meta) {
  if (!runDir) return;
  try {
    fs.mkdirSync(runDir, { recursive: true });
    const out = path.join(runDir, 'plaid-skill-manifest.json');
    fs.writeFileSync(out, JSON.stringify({ ...meta, writtenAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch (_) {
    /* best-effort */
  }
}

/**
 * @returns {'full'|'gapfill'|'skip'|'messaging'}
 */
function resolveResearchMode(promptText = '') {
  const env = (process.env.RESEARCH_MODE || '').toLowerCase().trim();
  if (['full', 'gapfill', 'skip', 'messaging'].includes(env)) return env;

  const t = String(promptText);
  const m = t.match(/\*\*Research depth:\*\*\s*([a-z0-9_-]+)/i) ||
    t.match(/Research depth:\s*([a-z0-9_-]+)/i);
  if (m) {
    const v = m[1].toLowerCase().replace(/-/g, '_');
    if (v === 'full') return 'full';
    if (v === 'skip') return 'skip';
    if (v === 'messaging' || v === 'messaging_only' || v === 'messagingonly') return 'messaging';
    if (v === 'technical_gapfill' || v === 'gapfill') return 'gapfill';
  }
  return '';
}

/**
 * Effective mode: **gapfill** whenever prompt/env did not set a mode (pipeline default).
 * @param {string} explicit from resolveResearchMode (may be '')
 * @param {boolean} [_skillLoaded] unused — kept for call-site compatibility
 */
function effectiveResearchMode(explicit, _skillLoaded) {
  if (explicit === 'full' || explicit === 'gapfill' || explicit === 'skip' || explicit === 'messaging') {
    return explicit;
  }
  return 'gapfill';
}

module.exports = {
  PROJECT_ROOT,
  DEFAULT_SKILL_REL,
  getDefaultSkillZipPath,
  sha256File,
  openSkillZip,
  readZipMember,
  resolveMemberPaths,
  getPlaidSkillBundleForFamily,
  writePlaidSkillManifest,
  resolveResearchMode,
  effectiveResearchMode,
  FAMILY_BASE_FILES,
};
