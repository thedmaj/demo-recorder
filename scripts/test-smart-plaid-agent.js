'use strict';
/**
 * test-smart-plaid-agent.js
 *
 * Tests the SmartPlaidAgent (Claude Sonnet CDP loop) against the explicit-selector
 * baseline. Runs standard and remember-me flows, reports per-phase timing and turn
 * counts, and appends timing results to inputs/plaid-link-nav-learnings.md.
 *
 * Usage:
 *   node scripts/test-smart-plaid-agent.js                     # standard flow
 *   node scripts/test-smart-plaid-agent.js --flow=remember-me  # remember-me flow
 *   node scripts/test-smart-plaid-agent.js --flow=both         # run both flows
 *   node scripts/test-smart-plaid-agent.js --headless          # no visible browser
 *   node scripts/test-smart-plaid-agent.js --phone=+14155550011
 *
 * Reads:  .env (PLAID_CLIENT_ID, PLAID_SECRET / PLAID_SANDBOX_SECRET, ANTHROPIC_API_KEY)
 * Writes: out/smart-plaid-test-{timestamp}.json
 *         inputs/plaid-link-nav-learnings.md (appended)
 */

require('dotenv').config({ override: true });
const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');
const http         = require('http');
const https        = require('https');

const { SmartPlaidAgent } = require('./scratch/utils/smart-plaid-agent');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT   = path.resolve(__dirname, '..');
const OUT_DIR        = path.join(PROJECT_ROOT, 'out');
const LEARNINGS_FILE = path.join(PROJECT_ROOT, 'inputs', 'plaid-link-nav-learnings.md');

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv = process.argv.slice(2)) {
  const flow     = (argv.find(a => a.startsWith('--flow='))?.replace('--flow=', '') || 'standard').toLowerCase();
  const phone    = argv.find(a => a.startsWith('--phone='))?.replace('--phone=',  '') || '+14155550011';
  const otp      = argv.find(a => a.startsWith('--otp='))?.replace('--otp=',      '') || '123456';
  const username = argv.find(a => a.startsWith('--username='))?.replace('--username=', '') || 'user_good';
  const password = argv.find(a => a.startsWith('--password='))?.replace('--password=', '') || 'pass_good';
  const headless = argv.includes('--headless');
  return { flow, phone, otp, username, password, headless };
}

// ── Plaid API helpers ─────────────────────────────────────────────────────────

function plaidPost(endpoint, body) {
  const plaidEnv = process.env.PLAID_ENV || 'sandbox';
  const baseUrl  = {
    sandbox:     'https://sandbox.plaid.com',
    development: 'https://development.plaid.com',
    production:  'https://production.plaid.com',
  }[plaidEnv] || 'https://sandbox.plaid.com';

  const fullBody = JSON.stringify({
    client_id: process.env.PLAID_CLIENT_ID,
    secret:    process.env.PLAID_SANDBOX_SECRET || process.env.PLAID_SECRET,
    ...body,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, baseUrl);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(fullBody) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'parse_error', raw: data.substring(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });
}

// ── Minimal test server ───────────────────────────────────────────────────────

async function startTestServer(htmlContent, startPort = 3940) {
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    if (req.method === 'GET' && ['/', '/index.html'].includes(req.url.split('?')[0])) {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlContent);
      return;
    }

    if (req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch (_) {}

      if (req.url === '/api/create-link-token') {
        const user = { client_user_id: 'smart-agent-test-001' };
        if (body.phone_number) user.phone_number = body.phone_number;
        const result = await plaidPost('/link/token/create', {
          user,
          client_name:   'SmartPlaid Test',
          products:      ['auth', 'identity'],
          country_codes: ['US'],
          language:      'en',
        });
        res.writeHead(result.link_token ? 200 : 400, cors);
        res.end(JSON.stringify(result));
        return;
      }

      if (req.url === '/api/exchange-token') {
        const result = await plaidPost('/item/public_token/exchange', { public_token: body.public_token });
        res.writeHead(result.access_token ? 200 : 400, cors);
        res.end(JSON.stringify(result));
        return;
      }
    }

    res.writeHead(404, cors); res.end('{}');
  });

  let usedPort = startPort;
  for (let i = 0; i < 10; i++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(startPort + i, '127.0.0.1', () => { usedPort = startPort + i; resolve(); });
      });
      break;
    } catch { if (i === 9) throw new Error('No port available 3940–3949'); }
  }

  return { url: `http://127.0.0.1:${usedPort}`, close: () => new Promise(r => server.close(r)) };
}

// ── Test page HTML ────────────────────────────────────────────────────────────

function buildTestHtml(phone) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1440">
  <title>SmartPlaid Agent Test</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 1440px; height: 900px; overflow: hidden;
      background: #0d1117;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, Helvetica, Arial, sans-serif;
      color: #fff;
    }
    .card {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(0,166,126,0.35);
      border-radius: 16px;
      padding: 48px 56px;
      max-width: 560px;
      width: 100%;
      text-align: center;
    }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 12px; }
    p  { color: rgba(255,255,255,0.65); margin-bottom: 32px; font-size: 14px; }
    #connect-btn {
      background: #00A67E; color: #fff; border: none;
      border-radius: 8px; padding: 14px 36px;
      font-size: 16px; font-weight: 600; cursor: pointer;
    }
    #connect-btn:disabled { background: #555; cursor: not-allowed; }
    #status { margin-top: 20px; font-size: 13px; color: rgba(255,255,255,0.5); min-height: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>SmartPlaid Agent Test</h1>
    <p>Tests the Claude Sonnet navigation loop against the Plaid Link iframe.</p>
    <button id="connect-btn" data-testid="connect-btn">Connect Bank Account</button>
    <div id="status">Initializing...</div>
  </div>
  <script>
    window._plaidLinkComplete = false;
    window._plaidHandler      = null;
    const PHONE = '${phone}';

    async function init() {
      document.getElementById('status').textContent = 'Creating link token...';
      try {
        const resp = await fetch('/api/create-link-token', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ phone_number: PHONE }),
        });
        const data = await resp.json();
        if (!data.link_token) throw new Error(data.error || 'No link_token');

        window._plaidHandler = Plaid.create({
          token:     data.link_token,
          onSuccess: (public_token, metadata) => {
            window._plaidInstitutionName = metadata?.institution?.name || '';
            window._plaidAccountName     = metadata?.accounts?.[0]?.name || '';
            window._plaidAccountMask     = metadata?.accounts?.[0]?.mask || '';
            window._plaidLinkComplete    = true;
            document.getElementById('status').textContent =
              'Connected: ' + window._plaidInstitutionName;
          },
          onExit: (err) => {
            document.getElementById('status').textContent =
              err ? 'Exit with error: ' + err.error_code : 'Exited';
          },
          onEvent: (name) => {
            console.log('[Plaid Event]', name);
          },
        });

        document.getElementById('connect-btn').disabled = false;
        document.getElementById('status').textContent = 'Ready — click to open Plaid Link';
      } catch (e) {
        document.getElementById('status').textContent = 'Init error: ' + e.message;
      }
    }

    document.getElementById('connect-btn').addEventListener('click', () => {
      if (window._plaidHandler) window._plaidHandler.open();
    });

    init();
  </script>
</body>
</html>`;
}

// ── Single run ────────────────────────────────────────────────────────────────

async function runFlow(flowConfig, headless) {
  const { plaidLinkFlow, phone, otp, username, password } = flowConfig;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[SmartPlaid Test] Flow: ${plaidLinkFlow} | Headless: ${headless}`);
  console.log(`${'─'.repeat(60)}`);

  const html   = buildTestHtml(phone);
  const server = await startTestServer(html);
  console.log(`[SmartPlaid Test] Server: ${server.url}`);

  const browser = await chromium.launch({
    headless,
    args: ['--window-size=1440,900'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  await page.goto(server.url);

  // Wait for "Ready" status
  await page.waitForFunction(
    () => document.getElementById('connect-btn') && !document.getElementById('connect-btn').disabled,
    null,
    { timeout: 20000 }
  ).catch(() => console.warn('[SmartPlaid Test] Timeout waiting for init'));

  console.log('[SmartPlaid Test] Page initialized — clicking connect button');

  // Click the connect button to open Plaid Link
  await page.click('#connect-btn');
  await page.waitForTimeout(2000);

  // Wait for Plaid iframe to attach
  try {
    await page.waitForSelector(
      'iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]',
      { state: 'attached', timeout: 15000 }
    );
    console.log('[SmartPlaid Test] Plaid iframe attached');
    await page.waitForTimeout(1500);
  } catch {
    console.warn('[SmartPlaid Test] Plaid iframe did not appear in 15s');
  }

  // ── Timing markers ──────────────────────────────────────────────────────────
  const timings = {};
  const startMs = Date.now();
  function mark(key) {
    timings[key] = ((Date.now() - startMs) / 1000).toFixed(2) + 's';
    console.log(`[SmartPlaid Test] Mark: ${key} @ ${timings[key]}`);
  }

  // ── Run SmartPlaidAgent ─────────────────────────────────────────────────────
  const agent = new SmartPlaidAgent({ markPlaidStep: mark, PLAID_SCREEN_DWELL_MS: 0 });

  let agentError   = null;
  let agentSuccess = false;
  const agentStart = Date.now();
  let agentTurnCount = 0;

  // Intercept console for turn counting
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const patchedLog = (...args) => {
    const msg = args[0] || '';
    if (typeof msg === 'string' && msg.startsWith('[SmartPlaid] Turn')) agentTurnCount++;
    origLog(...args);
  };
  console.log  = patchedLog;
  console.warn = origWarn;

  try {
    await agent.runPhase(page, 'launch', flowConfig);
    agentSuccess = true;
    mark('agent-complete');
  } catch (err) {
    agentError = err.message;
    mark('agent-failed');
    console.warn('[SmartPlaid Test] Agent error:', err.message);
  } finally {
    console.log = origLog;
  }

  const agentDurationS = ((Date.now() - agentStart) / 1000).toFixed(1);

  // ── Wait for onSuccess ──────────────────────────────────────────────────────
  let onSuccessFired = false;
  if (agentSuccess) {
    try {
      await page.waitForFunction(
        () => window._plaidLinkComplete === true,
        null,
        { timeout: 30000, polling: 500 }
      );
      onSuccessFired = true;
      mark('on-success');
      console.log('[SmartPlaid Test] ✓ onSuccess fired');
    } catch {
      console.warn('[SmartPlaid Test] onSuccess did not fire within 30s');
    }
  }

  const totalDurationS = ((Date.now() - startMs) / 1000).toFixed(1);

  // ── Report ──────────────────────────────────────────────────────────────────
  const report = {
    flow:           plaidLinkFlow,
    headless,
    date:           new Date().toISOString(),
    agentSuccess,
    onSuccessFired,
    agentError:     agentError || null,
    agentDurationS: parseFloat(agentDurationS),
    totalDurationS: parseFloat(totalDurationS),
    turnCount:      agentTurnCount,
    timings,
  };

  console.log('\n[SmartPlaid Test] ── Report ──────────────────────────────────');
  console.log(`  Flow:           ${plaidLinkFlow}`);
  console.log(`  Agent success:  ${agentSuccess}`);
  console.log(`  onSuccess:      ${onSuccessFired}`);
  console.log(`  Agent duration: ${agentDurationS}s`);
  console.log(`  Total duration: ${totalDurationS}s`);
  console.log(`  Turn count:     ${agentTurnCount}`);
  if (agentError) console.log(`  Error:          ${agentError}`);
  console.log('──────────────────────────────────────────────────────────────');

  await browser.close();
  await server.close();

  return report;
}

// ── Write report + learnings ──────────────────────────────────────────────────

function writeReport(reports) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const ts       = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const outFile  = path.join(OUT_DIR, `smart-plaid-test-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify(reports, null, 2));
  console.log(`\n[SmartPlaid Test] Report written: ${outFile}`);

  // Append learnings
  const lines = [
    '',
    `## SmartPlaidAgent Run: ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
    '',
    '| Flow | Agent success | onSuccess | Agent duration | Turns | Error |',
    '|------|--------------|-----------|----------------|-------|-------|',
  ];
  for (const r of reports) {
    lines.push(
      `| ${r.flow} | ${r.agentSuccess} | ${r.onSuccessFired} | ${r.agentDurationS}s | ${r.turnCount} | ${r.agentError || '—'} |`
    );
  }
  lines.push('');
  fs.appendFileSync(LEARNINGS_FILE, lines.join('\n'));
  console.log(`[SmartPlaid Test] Learnings appended: ${LEARNINGS_FILE}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[SmartPlaid Test] ERROR: ANTHROPIC_API_KEY is required (SmartPlaidAgent uses Claude Sonnet)');
    process.exit(1);
  }
  if (!process.env.PLAID_CLIENT_ID || !(process.env.PLAID_SANDBOX_SECRET || process.env.PLAID_SECRET)) {
    console.error('[SmartPlaid Test] ERROR: PLAID_CLIENT_ID and PLAID_SANDBOX_SECRET (or PLAID_SECRET) are required');
    process.exit(1);
  }

  const flows = [];

  if (args.flow === 'both') {
    flows.push({ plaidLinkFlow: 'standard',    phone: '+14155550010', otp: args.otp, username: args.username, password: args.password, institutionId: 'ins_109508' });
    flows.push({ plaidLinkFlow: 'remember-me', phone: args.phone,     otp: args.otp, username: args.username, password: args.password, institutionId: 'ins_109508' });
  } else if (args.flow === 'remember-me') {
    flows.push({ plaidLinkFlow: 'remember-me', phone: args.phone, otp: args.otp, username: args.username, password: args.password, institutionId: 'ins_109508' });
  } else {
    flows.push({ plaidLinkFlow: 'standard', phone: '+14155550010', otp: args.otp, username: args.username, password: args.password, institutionId: 'ins_109508' });
  }

  const reports = [];
  for (const flowConfig of flows) {
    const report = await runFlow(flowConfig, args.headless);
    reports.push(report);
    // Brief pause between runs
    if (flows.length > 1) await new Promise(r => setTimeout(r, 3000));
  }

  writeReport(reports);

  const allOk = reports.every(r => r.agentSuccess && r.onSuccessFired);
  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error('[SmartPlaid Test] Fatal:', err);
  process.exit(1);
});
