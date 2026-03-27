'use strict';

/**
 * manual-record.js
 *
 * Studio recording mode driver. Called by orchestrator.js when --record-mode=studio.
 *
 * Replaces Playwright automation with a human-driven session:
 *   1. Serves scratch-app on :3739 with a goToStep timing hook injected
 *   2. Guides the user through the our-recorder workflow (3 phases)
 *   3. Captures step timing as the user navigates with Arrow keys
 *   4. Locates the saved recording in our-recorder/public/, copies to recording.webm
 *   5. Writes step-timing.json and click-coords.json
 *
 * Status is written to studio-record-status.json for the dashboard to display.
 * Log lines tagged [Studio: phase-name] are parsed by the dashboard live-log viewer.
 *
 * Exports: async function main({ iteration })
 */

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const readline  = require('readline');
const { spawnSync, execSync } = require('child_process');

const OUR_RECORDER_ROOT    = path.resolve(process.env.OUR_RECORDER_ROOT || '/Users/dmajetic/Claude Test/our-recorder');
const OUR_RECORDER_PROJECT = process.env.OUR_RECORDER_PROJECT || 'my-video';
const FPS                  = 30;
const STUDIO_PORT          = 3739;

// ── MIME map (matches app-server.js) ─────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
};

// ── Status file ───────────────────────────────────────────────────────────────

function writeStatus(runDir, phase, message, stepCount, totalSteps, extras) {
  try {
    fs.writeFileSync(
      path.join(runDir, 'studio-record-status.json'),
      JSON.stringify({
        phase,        // 'idle' | 'setup' | 'recording' | 'file-ready' | 'saving' | 'processing' | 'done' | 'error'
        message,
        stepCount:  stepCount  || 0,
        totalSteps: totalSteps || 0,
        updatedAt:  new Date().toISOString(),
        ...extras,
      }, null, 2)
    );
  } catch (_) {}
}

// ── ffprobe duration ──────────────────────────────────────────────────────────

function getVideoDurationMs(filePath) {
  const r = spawnSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', filePath,
  ], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error('ffprobe failed: ' + (r.stderr || ''));
  const fmt = JSON.parse(r.stdout).format;
  return Math.round(parseFloat(fmt.duration) * 1000);
}

// ── Recording file detection ──────────────────────────────────────────────────

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv']);

// ── Project folder helpers ─────────────────────────────────────────────────────

function getProjectDir() {
  return path.join(OUR_RECORDER_ROOT, 'public', OUR_RECORDER_PROJECT);
}

function findNewestVideoFile(ourRecorderRoot) {
  // Search our-recorder/public/<any-subfolder>/ for any video file, newest first.
  // Prefers OUR_RECORDER_PROJECT folder; falls back to scanning all subfolders.
  const publicDir = path.join(ourRecorderRoot, 'public');
  if (!fs.existsSync(publicDir)) return null;
  let best = null, bestMtime = 0;
  for (const entry of fs.readdirSync(publicDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'sounds') continue;
    const dir = path.join(publicDir, entry.name);
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of files) {
      if (!VIDEO_EXTS.has(path.extname(f).toLowerCase())) continue;
      const full  = path.join(dir, f);
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > bestMtime) { bestMtime = mtime; best = full; }
    }
  }
  return best;
}

// Watch OUR_RECORDER_PROJECT folder for a new video file.
// Resolves with the file path when found; rejects after timeoutMs.
function waitForNewVideoFile(runDir, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const projectDir = getProjectDir();
    fs.mkdirSync(projectDir, { recursive: true });

    // Snapshot existing files so we only react to NEW ones
    const existing = new Set(
      fs.existsSync(projectDir)
        ? fs.readdirSync(projectDir).filter(f => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
        : []
    );

    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`[manual-record] Timed out waiting for video in ${projectDir}`));
    }, timeoutMs);

    const watcher = fs.watch(projectDir, { persistent: false }, (event, filename) => {
      if (!filename) return;
      if (!VIDEO_EXTS.has(path.extname(filename).toLowerCase())) return;
      if (existing.has(filename)) return; // pre-existing file, ignore

      // Wait briefly for the file to be fully written before resolving
      const full = path.join(projectDir, filename);
      setTimeout(() => {
        if (!fs.existsSync(full)) return;
        clearTimeout(timer);
        watcher.close();
        console.log(`\n[Studio] New recording detected: ${filename}`);
        writeStatus(runDir, 'file-ready', `Recording ready: ${filename}`, 0, 0, { detectedFile: full });
        resolve(full);
      }, 1500);
    });

    console.log(`[Studio] Watching for new video in: ${projectDir}`);
    console.log(`[Studio] (project: OUR_RECORDER_PROJECT=${OUR_RECORDER_PROJECT})`);
  });
}

// ── step-timing.json builder ──────────────────────────────────────────────────

function buildStepTiming(stepEvents, recordingStartMs, totalDurationMs) {
  const sorted = [...stepEvents].sort((a, b) => a.timestampMs - b.timestampMs);
  const steps  = sorted.map((ev, i) => {
    const startMs    = Math.max(0, ev.timestampMs - recordingStartMs);
    const endMs      = i + 1 < sorted.length
      ? Math.max(startMs + 1, sorted[i + 1].timestampMs - recordingStartMs)
      : totalDurationMs;
    const durationMs = Math.max(0, endMs - startMs);
    return {
      id:             ev.stepId,
      label:          ev.stepId,
      startMs,
      endMs,
      durationMs,
      startFrame:     Math.round(startMs    / 1000 * FPS),
      endFrame:       Math.round(endMs      / 1000 * FPS),
      durationFrames: Math.round(durationMs / 1000 * FPS),
    };
  });
  return {
    totalMs:     totalDurationMs,
    totalFrames: Math.round(totalDurationMs / 1000 * FPS),
    fps:         FPS,
    steps,
  };
}

// ── Prompt helper (compatible with orchestrator promptContinue) ───────────────

// HTTP advance queue: POST /studio-advance resolves the next pending promptUser call
const _advanceQueue = [];
function httpAdvance() {
  if (_advanceQueue.length > 0) {
    const resolve = _advanceQueue.shift();
    resolve();
    return true;
  }
  return false;
}

function promptUser(question) {
  return new Promise((resolve) => {
    _advanceQueue.push(resolve);
    console.log(`\n[Studio] Waiting: ${question.trim()}`);
    console.log('[Studio] → POST http://localhost:3739/studio-advance   OR   press ENTER in terminal');

    // Also listen on stdin if available
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, () => {
        rl.close();
        const idx = _advanceQueue.indexOf(resolve);
        if (idx !== -1) { _advanceQueue.splice(idx, 1); resolve(); }
      });
    } else {
      const onData = () => {
        process.stdin.removeListener('data', onData);
        const idx = _advanceQueue.indexOf(resolve);
        if (idx !== -1) { _advanceQueue.splice(idx, 1); resolve(); }
      };
      process.stdin.once('data', onData);
    }
  });
}

// ── Phase banner ──────────────────────────────────────────────────────────────

function printBanner(lines) {
  const W      = 56;
  const border = '─'.repeat(W);
  console.log('\n┌' + border + '┐');
  for (const line of lines) {
    console.log('│ ' + line.padEnd(W - 1) + '│');
  }
  console.log('└' + border + '┘');
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type':                'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               'no-store',
  });
  res.end(body);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main({ iteration = 1 } = {}) {  // eslint-disable-line no-unused-vars
  const runDir = process.env.PIPELINE_RUN_DIR;
  if (!runDir) throw new Error('[manual-record] PIPELINE_RUN_DIR not set');

  const scratchAppDir = path.join(runDir, 'scratch-app');
  if (!fs.existsSync(path.join(scratchAppDir, 'index.html'))) {
    throw new Error('[manual-record] scratch-app/index.html not found — run build stage first');
  }

  // Load demo-script for step count / IDs
  let totalSteps = 0;
  try {
    const script = JSON.parse(fs.readFileSync(path.join(runDir, 'demo-script.json'), 'utf8'));
    totalSteps = (script.steps || []).length;
  } catch (_) {}

  // ── State ─────────────────────────────────────────────────────────────────
  const stepEvents   = [];    // { stepId, timestampMs }
  let recordingActive   = false;
  let recordingStartMs  = null;

  // Plaid backend (lazy)
  let _plaidBackend = null;
  function getPlaidBackend() {
    if (!_plaidBackend) _plaidBackend = require('./utils/plaid-backend');
    return _plaidBackend;
  }

  // ── Timing hook injected into HTML before </body> ─────────────────────────
  const TIMING_HOOK = `
<script id="__studio-timing-hook">
/* Studio recording timing hook — injected by manual-record.js */
(function() {
  var _orig = window.goToStep;
  if (!_orig) { return; }
  window.goToStep = function(id) {
    _orig.call(window, id);
    try {
      fetch('/__step-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepId: id, timestampMs: Date.now() }),
      }).catch(function(){});
    } catch(_) {}
  };
  /* Fire initial-step event after short delay (page must be rendered) */
  setTimeout(function() {
    var cur = window.getCurrentStep ? window.getCurrentStep() : null;
    if (cur) {
      var id = cur.replace(/^step-/, '');
      fetch('/__step-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepId: id, timestampMs: Date.now() }),
      }).catch(function(){});
    }
  }, 600);
})();
</script>`;

  // ── Studio HTTP server ─────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch (_) { urlPath = '/'; }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
      res.end(); return;
    }

    // Advance current phase (POST or GET both work)
    if (urlPath === '/studio-advance') {
      const advanced = httpAdvance();
      sendJson(res, 200, { advanced, pending: _advanceQueue.length });
      return;
    }

    // Internal: step event receiver
    if (urlPath === '/__step-event' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const { stepId, timestampMs } = body;
        if (stepId && recordingActive) {
          const ts = timestampMs || Date.now();
          stepEvents.push({ stepId, timestampMs: ts });
          if (!recordingStartMs) recordingStartMs = ts;
          const count = stepEvents.length;
          const label = `${count}/${totalSteps || '?'}`;
          process.stdout.write(
            `\r  [Studio] Steps recorded [${label}]: ${stepEvents.map(e => e.stepId).join(' → ')}`.padEnd(120)
          );
          // Log tag for dashboard SSE parsing
          console.log(`\n[Studio: step-captured] ${stepId} (${label})`);
          writeStatus(runDir, 'recording', `Step: ${stepId}`, count, totalSteps);
        }
      } catch (_) {}
      sendJson(res, 200, { ok: true });
      return;
    }

    // Internal: retrieve all events (used at end of session)
    if (urlPath === '/__step-events' && req.method === 'GET') {
      sendJson(res, 200, { events: stepEvents, recordingStartMs });
      return;
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    // Plaid API proxy routes
    if (req.method === 'POST' && urlPath.startsWith('/api/') && process.env.PLAID_LINK_LIVE === 'true') {
      const plaid = getPlaidBackend();
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch (_) {}
      try {
        let result;
        switch (urlPath) {
          case '/api/create-link-token':
            result = await plaid.createLinkToken({
              ...body,
              products: body.products,
              clientName: body.clientName || body.client_name,
              userId: body.userId || body.user_id,
              phoneNumber: body.phoneNumber ?? body.phone_number ?? null,
              linkCustomizationName: body.linkCustomizationName || body.link_customization_name,
              productFamily: body.productFamily || body.product_family || null,
              credentialScope: body.credentialScope || body.credential_scope || null,
            });
            break;
          case '/api/exchange-public-token': result = await plaid.exchangePublicToken(body.public_token, { productFamily: body.productFamily || body.product_family || null, credentialScope: body.credentialScope || body.credential_scope || null }); break;
          case '/api/auth-get':             result = await plaid.getAuth(body.access_token, { credentialScope: body.credentialScope || body.credential_scope || null }); break;
          case '/api/identity-match':       result = await plaid.getIdentityMatch(body.access_token, body.legal_name, { credentialScope: body.credentialScope || body.credential_scope || null }); break;
          case '/api/signal-evaluate':      result = await plaid.evaluateSignal(body.access_token, body.account_id, body.amount, { credentialScope: body.credentialScope || body.credential_scope || null }); break;
          case '/api/plaid-request':        result = await plaid.plaidRequest(body.endpoint, body.body || {}, { productFamily: body.productFamily || body.product_family || null, credentialScope: body.credentialScope || body.credential_scope || null }); break;
          default: sendJson(res, 404, { error: 'Unknown API route' }); return;
        }
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // Static file serving with timing hook injection
    const relPath  = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
    const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(scratchAppDir, safePath);

    if (!filePath.startsWith(scratchAppDir + path.sep) && filePath !== scratchAppDir) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
      const ext = path.extname(filePath).toLowerCase();
      const ct  = MIME_TYPES[ext] || 'application/octet-stream';
      if (ext === '.html') {
        // Inject timing hook and no-cache headers
        const html = data.toString('utf8').replace(/<\/body>/i, TIMING_HOOK + '</body>');
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store, no-cache' });
        res.end(html);
      } else {
        res.writeHead(200, { 'Content-Type': ct });
        res.end(data);
      }
    });
  });

  // Bind to port 3739
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(STUDIO_PORT, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  console.log(`[Studio] App server started at http://localhost:${STUDIO_PORT}`);

  // Open demo app in browser
  try { execSync(`open http://localhost:${STUDIO_PORT}`, { stdio: 'ignore' }); } catch (_) {}

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 1 — Setup: start screen recorder
  // ────────────────────────────────────────────────────────────────────────────
  writeStatus(runDir, 'setup', 'Waiting for you to start screen recorder', 0, totalSteps);
  console.log('\n[Studio: phase-1-setup] Phase 1 of 3 — Setup your screen recorder');

  printBanner([
    'STUDIO RECORDING — Phase 1 of 3: Setup',
    '',
    `  Steps in this demo: ${totalSteps}`,
    '',
    '  What to do now:',
    '    1. Open our-recorder:  http://localhost:4000',
    '    2. Click "+ New Recording" and select your screen',
    '    3. Make sure the demo app is visible in your browser:',
    `       http://localhost:${STUDIO_PORT}`,
    '    4. Start the recording in our-recorder',
    '',
    '  When the recorder is running and capturing your screen',
    '  → press ENTER (or click ▶ Continue in the dashboard)',
  ]);
  console.log('[Studio: awaiting-input] Waiting for screen recorder to start...');

  await promptUser('\n  ▶  Press ENTER when your screen recorder is active: ');

  // Recording is now active — start accepting step events
  recordingActive  = true;
  recordingStartMs = Date.now();

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 2 — Navigate: user steps through the demo
  // ────────────────────────────────────────────────────────────────────────────
  writeStatus(runDir, 'recording', 'Navigate demo with Arrow keys', 0, totalSteps);
  console.log('\n[Studio: phase-2-recording] Phase 2 of 3 — Navigate the demo');

  printBanner([
    'STUDIO RECORDING — Phase 2 of 3: Navigate',
    '',
    '  Controls:',
    '    Arrow Right / Arrow Down  →  next step',
    '    Arrow Left  / Arrow Up    →  previous step',
    '    Click non-button area     →  also advances',
    '',
    `  Navigate through all ${totalSteps} steps at your own pace.`,
    '  Pause on each step as long as needed.',
    '  Step events are captured automatically (see below).',
    '',
    `  Save folder: our-recorder/public/${OUR_RECORDER_PROJECT}/`,
    '  Pipeline auto-detects the file when saved — no ENTER needed.',
    '  Or: POST http://localhost:' + STUDIO_PORT + '/studio-advance to confirm manually.',
  ]);
  console.log('[Studio: awaiting-input] Waiting for recording to be saved...');

  // Live step counter interval
  const _counterInterval = setInterval(() => {
    const count = stepEvents.length;
    if (count === 0) return;
    const list  = stepEvents.map(e => e.stepId).join(' → ');
    const label = `[${count}/${totalSteps || '?'}]`;
    writeStatus(runDir, 'recording', `Steps captured: ${count}/${totalSteps}`, count, totalSteps);
    process.stdout.write(`\r  [Studio] Live steps ${label}: ${list}`.padEnd(120));
  }, 2000);

  // Wait for file to appear in the project folder OR manual advance
  let detectedFile = null;
  await Promise.race([
    waitForNewVideoFile(runDir).then(f => { detectedFile = f; }),
    promptUser('\n\n  ▶  Or press ENTER / POST /studio-advance to confirm manually: '),
  ]);
  clearInterval(_counterInterval);

  const capturedCount = stepEvents.length;
  console.log(`\n[Studio: navigation-complete] Navigation complete — ${capturedCount} step event(s) captured`);

  if (capturedCount === 0) {
    console.warn('[Studio] WARNING: No step events were captured.');
    console.warn('[Studio] Check that you navigated the demo app at http://localhost:' + STUDIO_PORT);
    console.warn('[Studio] step-timing.json will have no steps — voiceover will use even distribution.');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 3 — Locate and copy the recording file
  // ────────────────────────────────────────────────────────────────────────────
  writeStatus(runDir, 'saving', 'Locating recording file in our-recorder', capturedCount, totalSteps);
  console.log('\n[Studio: phase-3-saving] Phase 3 of 3 — Locating recording file');

  printBanner([
    'STUDIO RECORDING — Phase 3 of 3: Locate file',
    '',
    `  Project folder: our-recorder/public/${OUR_RECORDER_PROJECT}/`,
    '  Accepts: .webm (our-recorder), .mp4 / .mov (system recorder)',
  ]);

  // Use auto-detected file if available, otherwise fall back to scan
  let recordingFilePath = detectedFile || findNewestVideoFile(OUR_RECORDER_ROOT);

  if (recordingFilePath) {
    const stat  = fs.statSync(recordingFilePath);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    const mtime  = new Date(stat.mtimeMs).toLocaleTimeString();
    console.log(`\n  Found:    ${recordingFilePath}`);
    console.log(`  Size:     ${sizeMB} MB`);
    console.log(`  Modified: ${mtime}`);
  } else {
    console.warn('\n  [Studio] No video file (.mp4/.webm/.mov) found in our-recorder/public/<subfolder>/');
    console.warn('  Did you click "Use This Take" → "Keep on server" in our-recorder?');
    recordingFilePath = await new Promise((resolve) => {
      if (!process.stdin.isTTY) { resolve(null); return; }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('  Enter full path to recording file (or press ENTER to abort): ', (ans) => {
        rl.close();
        resolve(ans.trim() || null);
      });
    });
  }

  if (!recordingFilePath || !fs.existsSync(recordingFilePath)) {
    server.close();
    throw new Error('[manual-record] No recording file found or provided. Re-run with --from=record after saving the recording.');
  }

  // ── Copy / remux to recording.webm ────────────────────────────────────────
  writeStatus(runDir, 'processing', 'Copying recording file', capturedCount, totalSteps);
  console.log('\n[Studio] Processing recording file...');
  const destPath = path.join(runDir, 'recording.webm');
  const srcExt   = path.extname(recordingFilePath).toLowerCase();

  if (srcExt === '.mp4' || srcExt === '.mov') {
    console.log('[Studio] Transcoding MP4 → WebM (VP9/Opus)...');
    execSync(
      `ffmpeg -y -i "${recordingFilePath}" -c:v libvpx-vp9 -crf 18 -b:v 0 -c:a libopus "${destPath}"`,
      { stdio: 'inherit' }
    );
  } else {
    fs.copyFileSync(recordingFilePath, destPath);
    console.log(`[Studio] Copied ${path.basename(recordingFilePath)} → recording.webm`);
  }

  // ── Get video duration via ffprobe ────────────────────────────────────────
  let totalDurationMs;
  try {
    totalDurationMs = getVideoDurationMs(destPath);
    console.log(`[Studio] Recording duration: ${(totalDurationMs / 1000).toFixed(1)}s`);
  } catch (err) {
    console.warn(`[Studio] ffprobe failed (${err.message}) — estimating duration from step events`);
    totalDurationMs = capturedCount > 0
      ? (stepEvents[capturedCount - 1].timestampMs - (recordingStartMs || 0)) + 8000
      : 60000;
    console.warn(`[Studio] Estimated: ${(totalDurationMs / 1000).toFixed(1)}s`);
  }

  // ── Build and write step-timing.json ─────────────────────────────────────
  const timing     = buildStepTiming(stepEvents, recordingStartMs || Date.now(), totalDurationMs);
  const timingPath = path.join(runDir, 'step-timing.json');
  fs.writeFileSync(timingPath, JSON.stringify(timing, null, 2));
  console.log(`[Studio] step-timing.json written — ${timing.steps.length} step(s)`);
  timing.steps.forEach(s =>
    console.log(`  ${s.id}: ${(s.startMs / 1000).toFixed(1)}s → ${(s.endMs / 1000).toFixed(1)}s`)
  );

  // ── click-coords.json (no automated clicks in studio mode) ───────────────
  const clickCoordsPath = path.join(runDir, 'click-coords.json');
  if (!fs.existsSync(clickCoordsPath)) {
    fs.writeFileSync(clickCoordsPath, JSON.stringify({}, null, 2));
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  writeStatus(runDir, 'done',
    `Complete — ${capturedCount}/${totalSteps} steps, ${(totalDurationMs / 1000).toFixed(0)}s`,
    capturedCount, totalSteps);

  console.log('\n[Studio: recording-complete] Studio recording complete');
  printBanner([
    'STUDIO RECORDING — Complete ✓',
    '',
    `  Steps captured:     ${capturedCount} / ${totalSteps}`,
    `  Recording duration: ${(totalDurationMs / 1000).toFixed(1)}s`,
    '  Files written:',
    '    recording.webm      (video)',
    '    step-timing.json    (step timing)',
    '',
    '  Next: QA review → post-process → voiceover → render',
  ]);

  server.close();
}

module.exports = { main };
