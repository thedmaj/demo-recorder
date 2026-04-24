'use strict';
/**
 * check-publish-safety.js
 *
 * Pure, dependency-free secret sweep used by both `run-package.js` (publish
 * mode) and any standalone CI/pre-commit hook. Given an absolute path or an
 * array of file paths, returns a list of offending matches:
 *
 *   [{ path, line, pattern, snippet }]
 *
 * Designed to be cheap and paranoid: false positives are fine, silent leaks
 * are not.
 */

const fs = require('fs');
const path = require('path');

const SECRET_PATTERNS = [
  { name: 'anthropic-api-key-env', re: /ANTHROPIC_API_KEY\s*=\s*\S+/g },
  { name: 'plaid-secret-env',     re: /PLAID_SECRET\s*=\s*\S+/g },
  { name: 'plaid-client-id-env',  re: /PLAID_CLIENT_ID\s*=\s*\S+/g },
  { name: 'elevenlabs-key-env',   re: /ELEVENLABS_API_KEY\s*=\s*\S+/g },
  { name: 'generic-sk-token',     re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'plaid-sandbox-secret', re: /\b[a-f0-9]{30}\b.*PLAID/gi },
  { name: 'json-client-secret',   re: /["']client_secret["']\s*:\s*["'][A-Za-z0-9_-]{12,}/g },
  { name: 'bearer-token',         re: /Bearer\s+[A-Za-z0-9_-]{20,}/g },
  { name: 'aws-access-key',       re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github-pat',           re: /\bgh[pous]_[A-Za-z0-9]{36,}\b/g },
];

// These file globs are NEVER considered safe to publish, independent of content.
// The allow-list in `run-package.js` is the primary defense; this is a backup.
const HARD_DENY_FILENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'credentials.json',
  'service-account.json',
]);

function isBinaryLike(buffer) {
  if (!buffer || buffer.length === 0) return false;
  // Scan the first 4 KB for NUL bytes; treat as binary if found.
  const sample = buffer.slice(0, Math.min(buffer.length, 4096));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}

/**
 * Scan a single file for secret patterns + hard-deny filenames.
 *
 * @param {string} filePath Absolute path to scan.
 * @param {object} [opts]
 * @param {string} [opts.rootDir] Optional base for pretty-printing paths.
 * @returns {Array<{ path, line, pattern, snippet, reason }>}
 */
function scanFile(filePath, opts = {}) {
  const findings = [];
  const base = path.basename(filePath);
  const pretty = opts.rootDir ? path.relative(opts.rootDir, filePath) : filePath;

  if (HARD_DENY_FILENAMES.has(base)) {
    findings.push({
      path: pretty,
      line: 0,
      pattern: 'hard-deny-filename',
      snippet: base,
      reason: 'filename matches the hard-deny list for publish bundles',
    });
    return findings;
  }

  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (_) {
    return findings;
  }
  if (isBinaryLike(buf)) return findings;

  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const idx = text.slice(0, m.index).split(/\r?\n/).length;
      const line = lines[idx - 1] || '';
      findings.push({
        path: pretty,
        line: idx,
        pattern: name,
        snippet: (m[0] || '').slice(0, 120),
        reason: `matched ${name}`,
      });
    }
  }
  return findings;
}

/**
 * Scan a list of file paths (or a directory recursively when `opts.recursive`
 * is true). Returns an array of findings; empty array means safe.
 */
function scanPaths(paths, opts = {}) {
  const all = [];
  const queue = Array.isArray(paths) ? paths.slice() : [paths];
  const rootDir = opts.rootDir || null;
  while (queue.length) {
    const p = queue.shift();
    if (!p) continue;
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (st.isDirectory()) {
      if (!opts.recursive) continue;
      for (const child of fs.readdirSync(p)) queue.push(path.join(p, child));
      continue;
    }
    all.push(...scanFile(p, { rootDir }));
  }
  return all;
}

module.exports = {
  SECRET_PATTERNS,
  HARD_DENY_FILENAMES,
  scanFile,
  scanPaths,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const recursive = args.includes('--recursive');
  const targets = args.filter((a) => a !== '--recursive');
  if (targets.length === 0) {
    console.error('Usage: node check-publish-safety.js <path...> [--recursive]');
    process.exit(64);
  }
  const findings = scanPaths(targets, { recursive });
  if (findings.length === 0) {
    console.log('[check-publish-safety] OK — no secret patterns detected.');
    process.exit(0);
  }
  console.error('[check-publish-safety] Found potential secrets:');
  for (const f of findings) {
    console.error(`  ${f.path}:${f.line}  [${f.pattern}]  ${f.snippet}`);
  }
  process.exit(2);
}
