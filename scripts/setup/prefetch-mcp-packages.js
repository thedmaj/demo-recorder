#!/usr/bin/env node
/**
 * Prefetch npm packages used at runtime by scripts/scratch/utils/mcp-clients.js
 * so the first research run does not block on `npx -y` downloads.
 *
 * Reads repo-root `.env` (simple KEY=value parser; no shell semantics).
 * Merge order: file first, then process.env overrides (matches dotenv behavior).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '../..');
const envPath = path.join(root, '.env');

function parseEnvFile(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function main() {
  const fileEnv = parseEnvFile(envPath);
  const env = { ...fileEnv, ...process.env };

  const packages = new Set();
  const gleanToken = String(env.GLEAN_API_TOKEN || '').trim();
  const gleanInst = String(env.GLEAN_INSTANCE || '').trim();

  if (gleanToken && gleanInst) {
    packages.add('@gleanwork/local-mcp-server');
  } else if (gleanToken && !gleanInst) {
    console.warn(
      '[mcp-prefetch] GLEAN_API_TOKEN is set but GLEAN_INSTANCE is empty — set GLEAN_INSTANCE (tenant name, e.g. plaid) so glean_chat matches mcp-clients.js.'
    );
  }

  const askUrl = String(env.ASKBILL_API_URL || env.ASKBILL_MCP_URL || '').trim();
  const askWs = /^wss?:\/\//i.test(askUrl);
  const askCmd = String(env.ASKBILL_MCP_COMMAND || '').trim();
  if (askWs) packages.add('mcp-remote');
  if (!askWs && askCmd && /mcp-remote/i.test(askCmd)) packages.add('mcp-remote');

  if (packages.size === 0) {
    console.log(
      '[mcp-prefetch] No complete Glean MCP pair (GLEAN_API_TOKEN + GLEAN_INSTANCE) or AskBill mcp-remote bridge in .env — skipping prefetch.'
    );
    process.exit(0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-recorder-mcp-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'mcp-prefetch', private: true, version: '1.0.0' })
    );
    const pkgs = [...packages].join(' ');
    console.log('[mcp-prefetch] Prefetching MCP packages:', pkgs);
    execSync(`npm install --no-save --no-audit --no-fund ${pkgs}`, {
      cwd: tmp,
      stdio: 'inherit',
      env: process.env,
      timeout: 300000,
    });
    console.log('[mcp-prefetch] Done — npm cache warmed for npx.');
  } catch (e) {
    console.warn('[mcp-prefetch] npm install failed:', (e && e.message) || e);
    console.warn('[mcp-prefetch] First pipeline research run may download packages.');
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
  }
  process.exit(0);
}

main();
