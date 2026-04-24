'use strict';
/**
 * identity.js
 *
 * Per-user identity for the centralized demo-app distribution layer. We do NOT
 * run an auth server. Trust is enforced upstream by the GitHub Enterprise
 * artifact repository (`plaid-demo-apps`) via CODEOWNERS + branch protection:
 *
 *   /demos/<ghe-login>/**    @<ghe-login>
 *
 * This module resolves the caller's GHE login with the following priority:
 *   1. Cached identity at `~/.plaid-demo-recorder/identity.json` (unless
 *      `opts.refresh === true`).
 *   2. `gh api user --jq .login` (requires `gh auth login` against GHE).
 *   3. `PLAID_DEMO_USER` env var — useful for CI / headless setups.
 *   4. Null. Callers decide whether to interactively prompt.
 *
 * Exported shape:
 *   { login: string, name: string|null, resolvedAt: string (ISO), source: 'cache'|'gh'|'env' }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const CACHE_DIR = path.join(HOME, '.plaid-demo-recorder');
const CACHE_FILE = path.join(CACHE_DIR, 'identity.json');

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
}

function readCachedIdentity() {
  try {
    const txt = fs.readFileSync(CACHE_FILE, 'utf8');
    const json = JSON.parse(txt);
    if (json && typeof json === 'object' && typeof json.login === 'string' && json.login.trim()) {
      return json;
    }
  } catch (_) {}
  return null;
}

function writeCachedIdentity(identity) {
  ensureDir(CACHE_DIR);
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(identity, null, 2), 'utf8');
  } catch (e) {
    // Cache write failure is non-fatal; identity resolves fresh next time.
    return null;
  }
  return identity;
}

function tryGhUser() {
  const bin = process.env.GH_BIN || 'gh';
  try {
    const result = spawnSync(bin, ['api', 'user'], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0 || !result.stdout) return null;
    const json = JSON.parse(result.stdout);
    const login = typeof json.login === 'string' ? json.login.trim() : '';
    if (!login) return null;
    return { login, name: typeof json.name === 'string' && json.name.trim() ? json.name.trim() : null };
  } catch (_) {
    return null;
  }
}

function tryEnvUser() {
  const login = String(process.env.PLAID_DEMO_USER || '').trim();
  if (!login) return null;
  return { login, name: String(process.env.PLAID_DEMO_USER_NAME || '').trim() || null };
}

function normalizeLogin(login) {
  return String(login || '').trim().replace(/^@/, '');
}

/**
 * Resolve the caller's identity.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.refresh]  Skip cache and re-resolve via `gh`/env.
 * @param {boolean} [opts.noCache]  Do not persist the resolved identity.
 * @returns {{ login: string, name: string|null, resolvedAt: string, source: string } | null}
 */
function resolveIdentity(opts = {}) {
  if (!opts.refresh) {
    const cached = readCachedIdentity();
    if (cached && cached.login) {
      return {
        login: normalizeLogin(cached.login),
        name: cached.name || null,
        resolvedAt: cached.resolvedAt || new Date().toISOString(),
        source: 'cache',
      };
    }
  }
  const gh = tryGhUser();
  if (gh) {
    const identity = {
      login: normalizeLogin(gh.login),
      name: gh.name || null,
      resolvedAt: new Date().toISOString(),
      source: 'gh',
    };
    if (!opts.noCache) writeCachedIdentity(identity);
    return identity;
  }
  const env = tryEnvUser();
  if (env) {
    const identity = {
      login: normalizeLogin(env.login),
      name: env.name || null,
      resolvedAt: new Date().toISOString(),
      source: 'env',
    };
    if (!opts.noCache) writeCachedIdentity(identity);
    return identity;
  }
  return null;
}

function clearIdentity() {
  try {
    fs.unlinkSync(CACHE_FILE);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  resolveIdentity,
  readCachedIdentity,
  writeCachedIdentity,
  clearIdentity,
  CACHE_FILE,
};
