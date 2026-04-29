#!/usr/bin/env node
/**
 * Verifies Google / Vertex credentials as configured in .env (or the environment).
 * - With GOOGLE_API_KEY: reports success without calling Google.
 * - With service account (file, GCP_SERVICE_ACCOUNT_JSON_B64, or GCP_SERVICE_ACCOUNT_JSON):
 *   obtains an OAuth2 access token via google-auth-library (no Vertex predict / no quota).
 * - With nothing configured: exits 0 with mode "skipped".
 *
 * Usage (from repo root):
 *   npm run test:vertex-auth
 *   node scripts/setup/test-vertex-auth.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const envPath = path.join(PROJECT_ROOT, '.env');

if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath, override: true });
}

const { verifyVertexConnectivity } = require(path.join(
  PROJECT_ROOT,
  'scripts',
  'scratch',
  'utils',
  'vertex-embed.js'
));

async function main() {
  const r = await verifyVertexConnectivity();
  const line = (k, v) => console.log(`  ${k}: ${v}`);
  console.log('[test-vertex-auth] Result:');
  line('ok', r.ok);
  line('mode', r.mode);
  line('message', r.message);
  if (r.tokenPreview) line('tokenPreview', r.tokenPreview);
  if (r.ok) {
    process.exit(0);
  }
  if (r.mode === 'skipped') {
    process.exit(0);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('[test-vertex-auth] Fatal:', err.message);
  process.exit(1);
});
