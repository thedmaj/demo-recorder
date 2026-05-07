'use strict';

/**
 * dotenv-loader.js
 *
 * Load `.env` for the Plaid demo pipeline in a way that survives Cursor /
 * Claude Code git worktrees. Cursor worktrees live under
 * `~/.cursor/worktrees/<repo>/<branch>/` and share `.git` with the main
 * repo, but every file that is gitignored — including `.env` and the
 * Google Vertex service-account JSON under `credentials/` — is **absent**
 * from the worktree. A bare `require('dotenv').config()` therefore loads
 * 0 variables and the pipeline fails with opaque "API key missing" errors
 * a few seconds into the run.
 *
 * Resolution order:
 *   1. `PLAID_DEMO_RECORDER_ENV` (explicit path override — for CI / tests).
 *   2. `<projectRoot>/.env` if it contains at least one KEY=VALUE line.
 *   3. If `<projectRoot>/.git` is a file (git worktree), parse
 *      `gitdir: <path>` → walk up to the common git dir → the main repo
 *      working tree → its `.env`.
 *   4. Give up; return `{ loaded: false, ... }` so callers can print a
 *      helpful diagnostic instead of dying silently.
 *
 * Zero runtime deps beyond `fs` + `path`. Optional: `dotenv` when available
 * (the repo ships it). If dotenv is not installed for some reason, a
 * minimal inline parser handles the same `KEY=VALUE` format (no quotes,
 * escaping, or multi-line values — matches the rest of the repo's usage).
 */

const fs = require('fs');
const path = require('path');

function countKeyValueLines(text) {
  let n = 0;
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    n += 1;
  }
  return n;
}

function readGitWorktreeMainRoot(projectRoot) {
  const gitPath = path.join(projectRoot, '.git');
  let st;
  try { st = fs.statSync(gitPath); } catch (_) { return null; }
  if (!st.isFile()) return null; // Regular git repo, not a worktree.
  let raw;
  try { raw = fs.readFileSync(gitPath, 'utf8'); } catch (_) { return null; }
  const match = raw.match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;
  const gitDir = path.resolve(projectRoot, match[1].trim());
  // In a worktree, gitDir looks like `<main>/.git/worktrees/<branch>`.
  // Git also writes a `commondir` file pointing at the main `.git`.
  const commondirFile = path.join(gitDir, 'commondir');
  let mainGitDir;
  if (fs.existsSync(commondirFile)) {
    try {
      const rel = fs.readFileSync(commondirFile, 'utf8').trim();
      mainGitDir = path.resolve(gitDir, rel);
    } catch (_) { /* fall through to heuristic */ }
  }
  if (!mainGitDir) {
    // Heuristic: `<main>/.git/worktrees/<branch>` → `<main>/.git`.
    mainGitDir = path.dirname(path.dirname(gitDir));
  }
  if (path.basename(mainGitDir) !== '.git') return null;
  return path.dirname(mainGitDir);
}

/**
 * @param {string} projectRoot absolute path to the package/app root
 * @returns {{ path: string, source: 'env_var' | 'project_root' | 'worktree_main' } | null}
 */
function findRepoEnvPath(projectRoot) {
  const explicit = process.env.PLAID_DEMO_RECORDER_ENV;
  if (explicit && explicit.trim() && fs.existsSync(explicit)) {
    return { path: explicit, source: 'env_var' };
  }
  const localEnv = path.join(projectRoot, '.env');
  if (fs.existsSync(localEnv)) {
    try {
      const raw = fs.readFileSync(localEnv, 'utf8');
      if (countKeyValueLines(raw) > 0) {
        return { path: localEnv, source: 'project_root' };
      }
    } catch (_) { /* fall through to worktree probe */ }
  }
  // `<projectRoot>/.env` missing or empty — try the worktree's main repo.
  const mainRoot = readGitWorktreeMainRoot(projectRoot);
  if (mainRoot) {
    const mainEnv = path.join(mainRoot, '.env');
    if (fs.existsSync(mainEnv)) {
      try {
        const raw = fs.readFileSync(mainEnv, 'utf8');
        if (countKeyValueLines(raw) > 0) {
          return { path: mainEnv, source: 'worktree_main' };
        }
      } catch (_) { /* ignore — caller will treat as not-loaded */ }
    }
  }
  return null;
}

function applyEnvMap(map, override) {
  let applied = 0;
  for (const [key, val] of Object.entries(map || {})) {
    if (override || !(key in process.env)) {
      process.env[key] = val;
      applied += 1;
    }
  }
  return applied;
}

function parseDotenvFallback(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding single/double quotes but otherwise leave as-is.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith('\'') && val.endsWith('\''))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * @param {string} projectRoot
 * @param {{ override?: boolean, quiet?: boolean }} [opts]
 * @returns {{
 *   loaded: boolean,
 *   path: string | null,
 *   source: string | null,
 *   loadedCount: number,
 *   appliedCount: number,
 *   message: string,
 * }}
 */
function loadRepoEnv(projectRoot, opts = {}) {
  const override = opts.override !== false;
  const found = findRepoEnvPath(projectRoot);
  if (!found) {
    return {
      loaded: false,
      path: null,
      source: null,
      loadedCount: 0,
      appliedCount: 0,
      message:
        'No usable .env found. Checked PLAID_DEMO_RECORDER_ENV, ' +
        `${path.join(projectRoot, '.env')}, and (if applicable) the main ` +
        'worktree. Ask the repo owner for .env — see README.md §2a.',
    };
  }

  let parsed = null;
  try {
    // Prefer dotenv when available so we inherit its parsing behavior.
    const dotenv = require('dotenv');
    const result = dotenv.config({ path: found.path, override, quiet: true });
    if (result && result.parsed) parsed = result.parsed;
  } catch (_) {
    // dotenv not installed — fall back to the minimal parser below.
  }
  if (!parsed) {
    const raw = fs.readFileSync(found.path, 'utf8');
    parsed = parseDotenvFallback(raw);
    applyEnvMap(parsed, override);
  }

  const loadedCount = Object.keys(parsed).length;
  return {
    loaded: true,
    path: found.path,
    source: found.source,
    loadedCount,
    appliedCount: loadedCount,
    message:
      `Loaded ${loadedCount} env var${loadedCount === 1 ? '' : 's'} from ` +
      `${found.path} [source=${found.source}]`,
  };
}

module.exports = {
  loadRepoEnv,
  findRepoEnvPath,
  readGitWorktreeMainRoot,
};
