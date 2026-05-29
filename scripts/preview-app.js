#!/usr/bin/env node
/**
 * preview-app.js
 *
 * Serve a built demo's scratch-app/ with the LIVE Plaid /api backend so the
 * real Layer + IDV modals actually load when previewing in a browser. The live
 * modals fetch /api/create-session-token, /api/create-idv-link-token, and
 * /api/user-account-session-get — without this backend they fail with
 * net::ERR_CONNECTION_REFUSED and the modal never opens.
 *
 * Usage:
 *   npm run preview                       # serves out/latest
 *   npm run preview -- out/demos/<run>    # serves a specific run
 *   PREVIEW_PORT=4000 npm run preview     # custom port (default 3760)
 *
 * Loads .env (PLAID_CLIENT_ID / PLAID_SANDBOX_SECRET / PLAID_LAYER_TEMPLATE_ID /
 * IDV_TEMPLATE_IDENTITY_BANK_OPTIONAL etc.) and forces PLAID_LINK_LIVE=true.
 */
require('dotenv/config');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./scratch/utils/app-server');

function resolveRunDir() {
  const PROJECT_ROOT = path.resolve(__dirname, '..');
  const arg = process.argv[2];
  if (arg) {
    const p = path.resolve(arg);
    if (fs.existsSync(p)) return p;
    throw new Error(`Run dir not found: ${arg}`);
  }
  const latest = path.join(PROJECT_ROOT, 'out', 'latest');
  if (fs.existsSync(latest)) {
    try { return fs.realpathSync(latest); } catch (_) { return latest; }
  }
  throw new Error('No run dir found — pass one: npm run preview -- out/demos/<run>');
}

(async () => {
  const runDir = resolveRunDir();
  const scratchApp = path.join(runDir, 'scratch-app');
  if (!fs.existsSync(path.join(scratchApp, 'index.html'))) {
    throw new Error(`No scratch-app/index.html in ${runDir}`);
  }
  // The app-server reads research config + Plaid backend from the run dir, and
  // only registers /api/* routes when PLAID_LINK_LIVE === 'true'.
  process.env.PIPELINE_RUN_DIR = runDir;
  if (process.env.PLAID_LINK_LIVE !== 'true') process.env.PLAID_LINK_LIVE = 'true';

  const port = Number(process.env.PREVIEW_PORT || 3760);
  const server = await startServer(port, scratchApp);
  console.log(`\n[preview] Serving "${path.basename(runDir)}" with the live /api backend`);
  console.log(`[preview]   ${server.url}/index.html`);
  console.log(`[preview]   PLAID_LINK_LIVE=${process.env.PLAID_LINK_LIVE} — Layer + IDV modals will load.`);
  console.log('[preview] Press Ctrl-C to stop.\n');
})().catch((e) => {
  console.error('[preview]', e.message);
  process.exit(1);
});
