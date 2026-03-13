#!/usr/bin/env node
'use strict';
/**
 * debug-plaid-link.js
 *
 * Standalone troubleshooting script for live Plaid Link sandbox.
 *
 * What it does:
 *   1. Validates env vars (PLAID_CLIENT_ID, PLAID_SANDBOX_SECRET, ANTHROPIC_API_KEY)
 *   2. Calls /link/token/create with link_customization_name: 'ascend' and logs the result
 *   3. Starts a local server on port 3838 serving a minimal debug page
 *   4. The debug page loads Plaid Link with verbose event logging + error display
 *   5. Prints the URL and waits for Ctrl-C
 *
 * Usage:
 *   node scripts/scratch/debug-plaid-link.js
 *   node scripts/scratch/debug-plaid-link.js --customization=ascend
 *   node scripts/scratch/debug-plaid-link.js --products=auth,identity
 *   node scripts/scratch/debug-plaid-link.js --no-open   # don't auto-open browser
 */

require('dotenv').config({ override: true });

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const { execSync } = require('child_process');

const plaid = require('./utils/plaid-backend');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const getArg = (prefix) => (args.find(a => a.startsWith(prefix)) || '').replace(prefix, '');

const DEBUG_PORT     = parseInt(getArg('--port=')          || '3838', 10);
const CUSTOMIZATION  = getArg('--customization=')          || process.env.PLAID_LINK_CUSTOMIZATION || 'ascend';
const PRODUCTS_ARG   = getArg('--products=');
const PRODUCTS       = PRODUCTS_ARG ? PRODUCTS_ARG.split(',') : ['auth', 'identity'];
const AUTO_OPEN      = !args.includes('--no-open');

// ── Step 1: Validate env ──────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║       Plaid Link Sandbox Debug Tool              ║');
console.log('╚══════════════════════════════════════════════════╝\n');

const requiredEnv = ['PLAID_CLIENT_ID', 'PLAID_SANDBOX_SECRET'];
const missing = requiredEnv.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`✗ Missing env vars: ${missing.join(', ')}`);
  console.error('  Add them to .env and rerun.');
  process.exit(1);
}

console.log('✓ Env vars present');
console.log(`  PLAID_CLIENT_ID:        ${process.env.PLAID_CLIENT_ID}`);
console.log(`  PLAID_ENV:              ${process.env.PLAID_ENV || 'sandbox'}`);
console.log(`  PLAID_LINK_LIVE:        ${process.env.PLAID_LINK_LIVE}`);
console.log(`  Link customization:     ${CUSTOMIZATION}`);
console.log(`  Products:               ${PRODUCTS.join(', ')}`);

// ── Step 2: Create link token ─────────────────────────────────────────────────

let linkToken = null;
let tokenError = null;

async function fetchLinkToken() {
  console.log('\n── Creating link token ──────────────────────────────');
  console.log(`  Endpoint: POST https://${process.env.PLAID_ENV || 'sandbox'}.plaid.com/link/token/create`);
  console.log(`  link_customization_name: "${CUSTOMIZATION}"`);
  console.log(`  products: [${PRODUCTS.join(', ')}]`);

  try {
    const result = await plaid.createLinkToken({
      clientName:           'Plaid Debug Tool',
      userId:               `debug-user-${Date.now()}`,
      products:             PRODUCTS,
      linkCustomizationName: CUSTOMIZATION,
    });

    linkToken = result.link_token;
    console.log(`\n✓ Link token created successfully`);
    console.log(`  link_token:  ${linkToken.substring(0, 40)}...`);
    console.log(`  expiration:  ${result.expiration}`);
    console.log(`  request_id:  ${result.request_id}`);
  } catch (err) {
    tokenError = err.message;
    console.error(`\n✗ Link token creation FAILED:`);
    console.error(`  ${err.message}`);

    // Common error diagnosis
    if (err.message.includes('INVALID_CONFIGURATION')) {
      console.error(`\n  ⚠ Likely cause: Link customization "${CUSTOMIZATION}" not found in Plaid Dashboard`);
      console.error(`  → Log in to dashboard.plaid.com → Link → Customizations → verify "${CUSTOMIZATION}" exists`);
      console.error(`  → Or retry without customization: --customization= (empty)`);
    } else if (err.message.includes('INVALID_API_KEYS')) {
      console.error(`\n  ⚠ Likely cause: Invalid PLAID_CLIENT_ID or PLAID_SANDBOX_SECRET`);
    } else if (err.message.includes('INVALID_PRODUCT')) {
      console.error(`\n  ⚠ Likely cause: Product not enabled for this client`);
      console.error(`  → Check dashboard.plaid.com → Team Settings → Allowed products`);
    }
  }
}

// ── Step 3: Build debug HTML ───────────────────────────────────────────────────

function buildDebugHtml(token, error) {
  const tokenJson = token ? JSON.stringify(token) : 'null';
  const errorHtml = error
    ? `<div class="error-box">✗ Token creation failed: ${escHtml(error)}</div>`
    : '';
  const tokenStatus = token
    ? `<div class="ok-box">✓ Link token ready: <code>${token.substring(0, 40)}...</code></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Plaid Link Debug</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; padding: 32px; min-height: 100vh; }
    h1 { font-size: 20px; margin-bottom: 24px; color: #00A67E; }
    h2 { font-size: 14px; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 1px; margin: 24px 0 10px; }
    .row { display: flex; gap: 16px; align-items: flex-start; }
    .panel { flex: 1; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 16px; }
    .status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .dot.green { background: #00A67E; }
    .dot.red   { background: #f87171; }
    .dot.grey  { background: rgba(255,255,255,0.3); }
    .dot.yellow { background: #fbbf24; }
    button { background: #00A67E; color: #fff; border: none; padding: 12px 24px; border-radius: 6px; font-size: 15px; cursor: pointer; font-weight: 600; }
    button:hover { background: #009970; }
    button:disabled { background: #444; cursor: not-allowed; }
    .error-box { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.4); border-radius: 6px; padding: 12px; font-size: 13px; color: #f87171; margin-bottom: 12px; }
    .ok-box { background: rgba(0,166,126,0.1); border: 1px solid rgba(0,166,126,0.4); border-radius: 6px; padding: 12px; font-size: 13px; color: #00A67E; margin-bottom: 12px; }
    .ok-box code, .error-box code { font-family: monospace; font-size: 12px; }
    #log { background: #000; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 12px; height: 340px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
    .log-info  { color: #e6edf3; }
    .log-event { color: #00A67E; }
    .log-error { color: #f87171; }
    .log-warn  { color: #fbbf24; }
    .log-ok    { color: #60a5fa; }
    #sdk-status { font-size: 12px; color: rgba(255,255,255,0.4); margin-top: 8px; }
    .meta { font-size: 11px; color: rgba(255,255,255,0.3); margin-top: 4px; font-family: monospace; }
  </style>
</head>
<body>
  <h1>Plaid Link Sandbox Debug — customization: "${CUSTOMIZATION}"</h1>

  ${errorHtml}
  ${tokenStatus}

  <div class="row">
    <div class="panel" style="flex: 0 0 280px;">
      <h2>Status</h2>
      <div class="status-row">
        <div class="dot" id="dot-sdk"></div>
        <span id="status-sdk">SDK loading…</span>
      </div>
      <div class="status-row">
        <div class="dot" id="dot-token"></div>
        <span id="status-token">${token ? 'Token ready' : 'Token missing'}</span>
      </div>
      <div class="status-row">
        <div class="dot" id="dot-link"></div>
        <span id="status-link">Link not opened</span>
      </div>
      <div id="sdk-status"></div>

      <div style="margin-top: 20px;">
        <button id="btn-open" onclick="openLink()" ${!token ? 'disabled' : ''}>
          ${token ? 'Open Plaid Link' : '⚠ Token missing'}
        </button>
      </div>

      <div style="margin-top: 16px;">
        <button onclick="fetchNewToken()" style="background: rgba(255,255,255,0.08); font-size: 13px; padding: 8px 14px;">
          ↻ Refresh token
        </button>
      </div>
    </div>

    <div class="panel">
      <h2>Event Log <span style="float:right;cursor:pointer;font-size:11px;color:rgba(255,255,255,0.3);" onclick="clearLog()">clear</span></h2>
      <div id="log"></div>
    </div>
  </div>

  <script>
    const INITIAL_TOKEN = ${tokenJson};
    let linkToken = INITIAL_TOKEN;
    let handler   = null;

    // ── Logging ──────────────────────────────────────────────────────────────
    const logEl = document.getElementById('log');
    function logLine(cls, msg) {
      const ts = new Date().toISOString().substring(11, 23);
      logEl.innerHTML += '<span class="' + cls + '">[' + ts + '] ' + msg + '\\n</span>';
      logEl.scrollTop = logEl.scrollHeight;
    }
    function clearLog() { logEl.innerHTML = ''; }
    function logInfo(m)  { logLine('log-info',  m); }
    function logEvent(m) { logLine('log-event', m); }
    function logErr(m)   { logLine('log-error', '✗ ' + m); }
    function logWarn(m)  { logLine('log-warn',  '⚠ ' + m); }
    function logOk(m)    { logLine('log-ok',    '✓ ' + m); }

    // Capture console errors
    const origError = console.error.bind(console);
    console.error = (...a) => { origError(...a); logErr(a.join(' ')); };
    const origWarn = console.warn.bind(console);
    console.warn = (...a) => { origWarn(...a); logWarn(a.join(' ')); };
    window.addEventListener('error', e => logErr('Uncaught: ' + e.message + ' (' + e.filename + ':' + e.lineno + ')'));
    window.addEventListener('unhandledrejection', e => logErr('Unhandled rejection: ' + e.reason));

    // ── SDK detection ─────────────────────────────────────────────────────────
    function setDot(id, color, label) {
      document.getElementById('dot-' + id).className = 'dot ' + color;
      document.getElementById('status-' + id).textContent = label;
    }

    function checkSdk() {
      if (typeof Plaid !== 'undefined' && typeof Plaid.create === 'function') {
        setDot('sdk', 'green', 'SDK loaded ✓');
        document.getElementById('sdk-status').textContent =
          'Version: ' + (Plaid.version || 'unknown');
        logOk('Plaid SDK loaded from cdn.plaid.com');
        return true;
      }
      setDot('sdk', 'red', 'SDK NOT loaded ✗');
      logErr('Plaid SDK not available — check network/CDN access');
      return false;
    }

    // Poll for SDK load (it loads async from CDN)
    let sdkPollCount = 0;
    const sdkPoll = setInterval(() => {
      if (checkSdk()) {
        clearInterval(sdkPoll);
        if (linkToken) initHandler(linkToken);
      } else if (++sdkPollCount > 20) {
        clearInterval(sdkPoll);
        logErr('SDK failed to load after 10s. Check browser network tab.');
      }
    }, 500);

    // ── Token status ──────────────────────────────────────────────────────────
    if (linkToken) {
      setDot('token', 'green', 'Token ready');
      logOk('Link token received from server');
      logInfo('  Token prefix: ' + linkToken.substring(0, 40) + '...');
    } else {
      setDot('token', 'red', 'Token missing — see error above');
      logErr('No link token — link/token/create failed');
    }

    // ── Fetch a fresh token from the server ───────────────────────────────────
    async function fetchNewToken() {
      logInfo('Fetching fresh link token from /api/create-link-token...');
      try {
        const res = await fetch('/api/create-link-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            link_customization_name: '${CUSTOMIZATION}',
            products: ${JSON.stringify(PRODUCTS)},
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        linkToken = data.link_token;
        setDot('token', 'green', 'Token ready');
        logOk('New token: ' + linkToken.substring(0, 40) + '...');
        document.getElementById('btn-open').disabled = false;
        if (typeof Plaid !== 'undefined') initHandler(linkToken);
      } catch (err) {
        logErr('Token fetch failed: ' + err.message);
        setDot('token', 'red', 'Token error');
      }
    }

    // ── Plaid.create ──────────────────────────────────────────────────────────
    function initHandler(token) {
      logInfo('Calling Plaid.create({token: "' + token.substring(0,30) + '..."})');
      try {
        handler = Plaid.create({
          token,
          onSuccess: (publicToken, metadata) => {
            logOk('onSuccess — public_token: ' + publicToken.substring(0,30) + '...');
            logInfo('  institution: ' + JSON.stringify(metadata.institution));
            logInfo('  accounts: ' + metadata.accounts.length);
            setDot('link', 'green', 'Link completed ✓');
            document.getElementById('status-link').textContent = 'onSuccess fired ✓';
          },
          onExit: (err, metadata) => {
            if (err) {
              logErr('onExit with error: ' + JSON.stringify(err));
              setDot('link', 'red', 'Exited with error');
            } else {
              logWarn('onExit (user closed) — status: ' + (metadata?.status || 'unknown'));
              setDot('link', 'yellow', 'User exited');
            }
            logInfo('  exit metadata: ' + JSON.stringify(metadata?.institution || {}));
          },
          onEvent: (eventName, metadata) => {
            logEvent('EVENT: ' + eventName);
            // Log key metadata fields
            const keys = ['view_name','error_type','error_code','error_message',
                          'institution_name','institution_id','link_session_id'];
            const relevant = {};
            keys.forEach(k => { if (metadata[k]) relevant[k] = metadata[k]; });
            if (Object.keys(relevant).length) {
              logInfo('  ' + JSON.stringify(relevant));
            }
            // Specific event diagnosis
            if (eventName === 'ERROR') {
              logErr('Link ERROR — type: ' + metadata.error_type + ', code: ' + metadata.error_code);
              logErr('  msg: ' + metadata.error_message);
              setDot('link', 'red', 'Link error: ' + metadata.error_code);
            }
            if (eventName === 'OPEN') {
              setDot('link', 'green', 'Link open ✓');
              logOk('Plaid Link iframe opened successfully');
            }
          },
        });
        logOk('Plaid.create() succeeded — handler ready');
      } catch (err) {
        logErr('Plaid.create() threw: ' + err.message);
        setDot('link', 'red', 'create() failed');
      }
    }

    function openLink() {
      if (!handler) {
        logErr('No handler — SDK not ready or token missing');
        return;
      }
      logInfo('Calling handler.open()...');
      setDot('link', 'yellow', 'Opening…');
      handler.open();
    }
  </script>
</body>
</html>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Step 4: Start debug server ────────────────────────────────────────────────

async function startDebugServer(token, error) {
  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    // Proxy /api/* to plaid-backend (same as app-server.js)
    if (req.method === 'POST' && url.startsWith('/api/')) {
      let body = {};
      try {
        const raw = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', c => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks).toString()));
          req.on('error', reject);
        });
        if (raw) body = JSON.parse(raw);
      } catch (_) {}

      try {
        let result;
        if (url === '/api/create-link-token') {
          result = await plaid.createLinkToken({
            clientName:           'Plaid Debug Tool',
            userId:               `debug-user-${Date.now()}`,
            products:             body.products || PRODUCTS,
            linkCustomizationName: body.link_customization_name || CUSTOMIZATION,
          });
        } else {
          result = { error: `Unknown route: ${url}` };
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return;
    }

    // Debug page
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildDebugHtml(token, error));
  });

  await new Promise((resolve, reject) => {
    server.listen(DEBUG_PORT, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  const url = `http://localhost:${DEBUG_PORT}`;
  console.log(`\n── Debug server started ──────────────────────────────`);
  console.log(`  URL: ${url}`);
  console.log(`\n  Open this URL in Chrome to test Plaid Link interactively.`);
  console.log(`  The page shows: SDK load status, token status, event log, errors.\n`);

  // Auto-open browser
  if (AUTO_OPEN) {
    try {
      execSync(`open "${url}"`, { stdio: 'ignore' });
      console.log('  ✓ Opened in browser');
    } catch (_) {
      console.log('  (Could not auto-open browser — open URL manually)');
    }
  }

  console.log('\nPress Ctrl-C to stop.\n');

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('\nStopped.');
    server.close();
    process.exit(0);
  });
}

// ── Run ───────────────────────────────────────────────────────────────────────

(async () => {
  await fetchLinkToken();
  await startDebugServer(linkToken, tokenError);
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
