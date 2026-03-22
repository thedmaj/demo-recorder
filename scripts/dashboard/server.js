'use strict';

require('dotenv').config({ override: true });

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const chokidar = require('chokidar');

// ── Paths ────────────────────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const INPUTS_DIR = path.join(PROJECT_ROOT, 'inputs');
const OUT_DIR = path.join(PROJECT_ROOT, 'out');
const DEMOS_DIR = path.join(OUT_DIR, 'demos');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

const PORT = process.env.PORT || 4040;

// ── ENV whitelist ─────────────────────────────────────────────────────────────
const ENV_WHITELIST = new Set([
  'SCRATCH_AUTO_APPROVE', 'MANUAL_RECORD', 'FIGMA_REVIEW',
  'MAX_REFINEMENT_ITERATIONS', 'RECORDING_FPS', 'QA_PASS_THRESHOLD',
  'PLAID_ENV', 'PLAID_LINK_LIVE', 'PLAID_LINK_CUSTOMIZATION',
  'PLAID_LAYER_TEMPLATE_ID', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_OUTPUT_FORMAT',
]);

// ── Overlay suggestion patch helper ──────────────────────────────────────────
/**
 * Deep-merges a suggestion patch into a remotion-props step entry.
 * - Array fields (callouts): appends items rather than replacing
 * - Nested objects (zoomPunch): merges fields
 * - action=remove: deletes the key named by the patch key
 */
function deepMergePatch(stepEntry, patch, action) {
  if (!stepEntry || !patch) return stepEntry || {};
  const result = Object.assign({}, stepEntry);
  for (const [key, val] of Object.entries(patch)) {
    if (action === 'remove') {
      delete result[key];
    } else if (Array.isArray(val) && Array.isArray(result[key])) {
      result[key] = [...result[key], ...val];
    } else if (val && typeof val === 'object' && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = Object.assign({}, result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ── Pipeline state ────────────────────────────────────────────────────────────
let activeProcess = null;
let logBuffer = [];
const logClients = new Set();

const PIPELINE_STAGES = [
  'research', 'ingest', 'brand-extract', 'script', 'script-critique',
  'embed-script-validate',
  /* 'plaid-link-capture', */ 'build', 'record', 'qa', 'figma-review', 'post-process',
  'voiceover', 'coverage-check', 'auto-gap', 'resync-audio', 'embed-sync', 'audio-qa', 'render', 'ppt', 'touchup',
];

// ── Helper functions ──────────────────────────────────────────────────────────

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function getRunDir(runId) {
  const resolved = path.resolve(DEMOS_DIR, runId);
  if (!resolved.startsWith(DEMOS_DIR + path.sep) && resolved !== DEMOS_DIR) {
    throw new Error('Invalid runId: path escapes DEMOS_DIR');
  }
  return resolved;
}

function readEnvWhitelisted() {
  const result = {};
  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (ENV_WHITELIST.has(key)) {
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result[key] = val;
      }
    }
  } catch (_) {
    // .env doesn't exist — return empty object
  }
  return result;
}

function writeEnvWhitelisted(updates) {
  for (const key of Object.keys(updates)) {
    if (!ENV_WHITELIST.has(key)) {
      throw new Error(`Key not in whitelist: ${key}`);
    }
  }

  let lines = [];
  try {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  } catch (_) {
    // File may not exist yet
  }

  const written = new Set();
  const newLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (ENV_WHITELIST.has(key) && key in updates) {
      written.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  // Append any keys not already present
  for (const [key, val] of Object.entries(updates)) {
    if (!written.has(key)) {
      newLines.push(`${key}=${val}`);
    }
  }

  const content = newLines.join('\n');
  const tmpFile = ENV_FILE + '.tmp';
  fs.writeFileSync(tmpFile, content, 'utf8');
  fs.renameSync(tmpFile, ENV_FILE);
}

function latestRunId() {
  try {
    const linkTarget = fs.readlinkSync(path.join(OUT_DIR, 'latest'));
    return path.basename(linkTarget);
  } catch (_) {
    const entries = safeReaddir(DEMOS_DIR).sort();
    return entries.length > 0 ? entries[entries.length - 1] : null;
  }
}

function getRunArtifacts(runId) {
  const dir = path.join(DEMOS_DIR, runId);
  function fileInfo(relPath) {
    const full = path.join(dir, relPath);
    if (!fs.existsSync(full)) return false;
    try {
      return fs.statSync(full).size;
    } catch (_) {
      return false;
    }
  }
  return {
    script:    fileInfo('demo-script.json'),
    recording: fileInfo('recording.webm'),
    processed: fileInfo('recording-processed.webm'),
    qa:        !!getLatestQaReport(runId),
    voiceover: fileInfo('audio/voiceover.mp3'),
    mp4:       fileInfo('demo-scratch.mp4'),
    pptx:      fileInfo('demo-summary.pptx'),
    remotion:  fileInfo('remotion-props.json'),
  };
}

// Stage → indicator artifact (ordered by pipeline sequence)
const STAGE_ARTIFACTS = [
  ['research',        'research-notes.md'],
  ['ingest',          'product-context.json'],
  ['brand-extract',   'demo-script.json'],   // brand is prereq; script existence implies it ran
  ['script',          'demo-script.json'],
  ['script-critique',       'demo-script.json'],       // critique updates script in-place; use same sentinel
  ['embed-script-validate', 'script-validate-report.json'],
  // ['plaid-link-capture',  'plaid-link-screens/manifest.json'],  // DISABLED
  ['build',               'scratch-app/index.html'],
  ['record',          'recording.webm'],
  ['qa',              'qa-report-1.json'],
  ['figma-review',    'figma-review.json'],
  ['post-process',    'recording-processed.webm'],
  ['voiceover',       'voiceover-manifest.json'],
  ['coverage-check',  'coverage-report.json'],
  ['auto-gap',        'auto-gap-report.json'],
  ['resync-audio',    'voiceover-manifest.json'],  // resync updates manifest in-place (adds resyncedAt)
  ['embed-sync',      'embed-sync-report.json'],
  ['audio-qa',              'audio-qa-report.json'],
  ['ai-suggest-overlays',   'overlay-suggestions.json'],
  ['render',                'demo-scratch.mp4'],
  ['ppt',             'demo-summary.pptx'],
  ['touchup',         'touchup-complete.json'],
];

function detectLastCompletedStage(runId) {
  const dir = path.join(DEMOS_DIR, runId);
  let lastStage = null;
  // Walk forward — last one present wins (handles non-unique sentinels like demo-script.json)
  for (const [stage, relPath] of STAGE_ARTIFACTS) {
    if (fs.existsSync(path.join(dir, relPath))) lastStage = stage;
  }
  return lastStage;
}

function readPipelineProgress(runId) {
  const progressFile = path.join(DEMOS_DIR, runId, 'pipeline-progress.json');
  try {
    if (!fs.existsSync(progressFile)) return null;
    return JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

function getCompletedStages(runId) {
  const progress = readPipelineProgress(runId);
  if (progress && Array.isArray(progress.completedStages) && progress.completedStages.length > 0) {
    return progress.completedStages;
  }
  // Fallback: infer from file sentinels (backward compat for old runs)
  const dir = path.join(DEMOS_DIR, runId);
  const completed = [];
  for (const [stage, relPath] of STAGE_ARTIFACTS) {
    if (fs.existsSync(path.join(dir, relPath)) && !completed.includes(stage)) {
      completed.push(stage);
    }
  }
  return completed;
}

function nextStageAfter(stageName) {
  const idx = PIPELINE_STAGES.indexOf(stageName);
  if (idx === -1 || idx === PIPELINE_STAGES.length - 1) return null;
  return PIPELINE_STAGES[idx + 1];
}

function getLatestQaReport(runId) {
  const dir = path.join(DEMOS_DIR, runId);
  const files = safeReaddir(dir).filter(f => /^qa-report-\d+\.json$/.test(f));
  if (files.length === 0) return null;
  files.sort((a, b) => {
    const nA = parseInt(a.match(/\d+/)[0], 10);
    const nB = parseInt(b.match(/\d+/)[0], 10);
    return nA - nB;
  });
  const latest = files[files.length - 1];
  return safeReadJson(path.join(dir, latest));
}

function broadcastLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.shift();
  const payload = `data: ${line}\n\n`;
  for (const res of logClients) {
    try { res.write(payload); } catch (_) { logClients.delete(res); }
  }
}

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.txt':  'text/plain',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Static assets
app.use('/static', express.static(path.join(__dirname, 'public')));

// Root → index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Run listing routes ────────────────────────────────────────────────────────

app.get('/api/runs', (req, res) => {
  try {
    const dirs = safeReaddir(DEMOS_DIR)
      .filter(name => {
        try { return fs.statSync(path.join(DEMOS_DIR, name)).isDirectory(); } catch (_) { return false; }
      })
      .sort()
      .reverse();

    const runs = dirs.map(runId => {
      const artifacts = getRunArtifacts(runId);
      const qa = getLatestQaReport(runId);
      const completedStages = getCompletedStages(runId);
      return { runId, artifacts, qaScore: qa ? qa.overallScore : null, completedStages };
    });

    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:runId', (req, res) => {
  try {
    const dir = getRunDir(req.params.runId);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Run not found' });

    const artifacts = getRunArtifacts(req.params.runId);
    const qa = getLatestQaReport(req.params.runId);
    const completedStages = getCompletedStages(req.params.runId);
    const lastCompletedStage = completedStages.length > 0
      ? completedStages[completedStages.length - 1]
      : detectLastCompletedStage(req.params.runId);
    const resumeFromStage = nextStageAfter(lastCompletedStage);

    const allFiles = safeReaddir(dir);
    const manifest = allFiles.map(name => {
      try {
        const stat = fs.statSync(path.join(dir, name));
        return stat.isFile() ? { name, size: stat.size } : null;
      } catch (_) { return null; }
    }).filter(Boolean);

    res.json({
      runId: req.params.runId, artifacts,
      qaScore: qa ? qa.overallScore : null, manifest,
      lastCompletedStage, resumeFromStage, completedStages,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:runId/script', (req, res) => {
  try {
    const dir = getRunDir(req.params.runId);
    const scriptPath = path.join(dir, 'demo-script.json');
    if (!fs.existsSync(scriptPath)) return res.status(404).json({ error: 'Script not found' });
    res.json(safeReadJson(scriptPath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:runId/qa', (req, res) => {
  try {
    getRunDir(req.params.runId); // validate
    const report = getLatestQaReport(req.params.runId);
    if (!report) return res.status(404).json({ error: 'No QA report found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Audio sync status ─────────────────────────────────────────────────────────

app.get('/api/runs/:runId/audio-sync-status', (req, res) => {
  try {
    const dir = getRunDir(req.params.runId);
    const syncMapPath    = path.join(dir, 'sync-map.json');
    const manifestPath   = path.join(dir, 'voiceover-manifest.json');
    const syncMap        = safeReadJson(syncMapPath);
    const manifest       = safeReadJson(manifestPath);

    const syncMapExists  = fs.existsSync(syncMapPath);
    const manifestExists = fs.existsSync(manifestPath);
    const syncMapMtime   = syncMapExists  ? fs.statSync(syncMapPath).mtimeMs  : null;
    const manifestMtime  = manifestExists ? fs.statSync(manifestPath).mtimeMs : null;

    const hasSegments    = syncMapExists && Array.isArray(syncMap?.segments) && syncMap.segments.length > 0;
    const resyncedAt     = manifest?.resyncedAt || null;
    const syncApplied    = manifest?.syncMapApplied === true;

    // Stale = sync-map has real segments AND manifest either predates sync-map or wasn't resynced
    const isStale = hasSegments && manifestExists &&
      (!syncApplied || (syncMapMtime != null && manifestMtime != null && syncMapMtime > manifestMtime));

    res.json({
      syncMapExists,
      manifestExists,
      hasSegments,
      segmentCount: hasSegments ? syncMap.segments.length : 0,
      resyncedAt,
      syncApplied,
      isStale,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:runId/frames', (req, res) => {
  try {
    const dir = getRunDir(req.params.runId);
    // Prefer qa-frames; fall back to build-frames
    // But only use qa-frames if its step IDs match the current demo-script.json
    // (stale qa-frames from a previous iteration would otherwise shadow a fresh build)
    const qaDir    = path.join(dir, 'qa-frames');
    const buildDir = path.join(dir, 'build-frames');
    let qaFiles = safeReaddir(qaDir).filter(f => /\.png$/i.test(f)).sort();

    if (qaFiles.length > 0) {
      // Check whether qa-frames are current by comparing step IDs with demo-script.json
      const scriptPath = path.join(dir, 'demo-script.json');
      const script = safeReadJson(scriptPath);
      if (script && script.steps && script.steps.length > 0) {
        const scriptIds = new Set(script.steps.map(s => s.id));
        const qaIds     = new Set(qaFiles.map(f => f.replace(/-(?:start|mid|end)\.png$/i, '')));
        const overlap   = [...scriptIds].filter(id => qaIds.has(id)).length;
        // If fewer than half the script steps have matching qa-frames, treat as stale
        if (overlap < scriptIds.size / 2) {
          qaFiles = [];
        }
      }
    }

    let files  = qaFiles;
    let source = 'qa-frames';
    if (files.length === 0) {
      files  = safeReaddir(buildDir).filter(f => /\.png$/i.test(f)).sort();
      source = 'build-frames';
    }
    res.json({ files, source });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:runId/frames/:filename', (req, res) => {
  try {
    const { runId, filename } = req.params;
    if (!/^[\w\-_.]+$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const dir = getRunDir(runId);
    // Check qa-frames first, then plaid-frames (CDP screenshots for Plaid Link steps), then build-frames
    let filePath = path.join(dir, 'qa-frames', filename);
    if (!fs.existsSync(filePath)) {
      // For Plaid Link steps the qa-frames file IS the CDP screenshot (copied there by qa-review.js),
      // but if qa hasn't run yet, serve directly from plaid-frames/.
      filePath = path.join(dir, 'plaid-frames', filename);
    }
    if (!fs.existsSync(filePath)) {
      filePath = path.join(dir, 'build-frames', filename);
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Frame not found' });
    res.setHeader('Content-Type', 'image/png');
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Build screenshot capture ──────────────────────────────────────────────────

// Shared capture function used by both the POST endpoint and the auto-watcher
async function captureRunScreenshots(runId) {
  const runDir     = path.join(DEMOS_DIR, runId);
  const scriptPath = path.join(runDir, 'demo-script.json');
  const scratchDir = path.join(runDir, 'scratch-app');

  if (!fs.existsSync(scriptPath) || !fs.existsSync(scratchDir)) return { captured: 0 };

  const script = safeReadJson(scriptPath);
  if (!script || !script.steps || script.steps.length === 0) return { captured: 0 };

  const outDir = path.join(runDir, 'build-frames');
  fs.mkdirSync(outDir, { recursive: true });

  const staticApp = express();
  staticApp.use(express.static(scratchDir));
  const staticServer = await new Promise((resolve, reject) => {
    const s = staticApp.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const port = staticServer.address().port;

  let captured = 0;
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(800);

    // plaid-link-capture disabled — link-* steps render blank tiles in storyboard
    // (no simulated step divs; real Plaid iframe is not visible in headless screenshot)
    for (const step of script.steps) {
      try {
        const outPath = path.join(outDir, `${step.id}-mid.png`);
        await page.evaluate(id => { if (window.goToStep) window.goToStep(id); }, step.id);
        await page.waitForTimeout(400);
        await page.screenshot({ path: outPath, fullPage: false });
        captured++;
      } catch (err) {
        console.error(`[BuildScreenshots] Step ${step.id}: ${err.message}`);
      }
    }
  } finally {
    if (browser) await browser.close();
    staticServer.close();
  }
  return { captured };
}

app.post('/api/runs/:runId/capture-build-screenshots', async (req, res) => {
  try {
    const runId  = req.params.runId;
    getRunDir(runId); // validate
    const result = await captureRunScreenshots(runId);
    if (result.captured === 0) {
      return res.status(404).json({ error: 'No scratch-app or script found for this run' });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-capture: watch for scratch-app/index.html creation ──────────────────

// Track in-progress captures to avoid duplicate triggers
const _captureInProgress = new Set();

async function handleIndexHtmlChange(filePath) {
    const rel = path.relative(DEMOS_DIR, filePath);
    // Match {runId}/scratch-app/index.html
    const m = rel.match(/^([^/\\]+)[/\\]scratch-app[/\\]index\.html$/);
    if (!m) return;
    const runId = m[1];
    if (_captureInProgress.has(runId)) return;
    _captureInProgress.add(runId);

    broadcastLog(`[Dashboard] Build complete for ${runId} — capturing screenshots in 4s…`);
    await new Promise(r => setTimeout(r, 4000)); // let the build finish writing

    try {
      const { captured } = await captureRunScreenshots(runId);
      broadcastLog(`[Dashboard] Auto-captured ${captured} build screenshots for ${runId}`);
    } catch (err) {
      broadcastLog(`[Dashboard] Screenshot capture failed: ${err.message}`);
    } finally {
      _captureInProgress.delete(runId);
    }
}

chokidar.watch(DEMOS_DIR, { ignoreInitial: true, depth: 3 })
  .on('add', handleIndexHtmlChange)
  .on('change', handleIndexHtmlChange);

// ── Range-capable file serving ────────────────────────────────────────────────

app.get('/api/files/:runId/*', (req, res) => {
  try {
    const runId = req.params.runId;
    const relFile = req.params[0];
    const runDir = getRunDir(runId);
    const filePath = path.resolve(runDir, relFile);

    // Security: must stay within run dir
    if (!filePath.startsWith(runDir + path.sep) && filePath !== runDir) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const stat = fs.statSync(filePath);
    const total = stat.size;
    const contentType = mimeFor(filePath);
    const rangeHeader = req.headers['range'];

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', chunkSize);
      res.setHeader('Content-Type', contentType);

      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.setHeader('Content-Length', total);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Config routes ─────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  try {
    res.json(readEnvWhitelisted());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config', (req, res) => {
  try {
    writeEnvWhitelisted(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/config/prompt', (req, res) => {
  try {
    const promptPath = path.join(INPUTS_DIR, 'prompt.txt');
    const content = fs.existsSync(promptPath)
      ? fs.readFileSync(promptPath, 'utf8')
      : '';
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config/prompt', (req, res) => {
  try {
    const { content } = req.body;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    const promptPath = path.join(INPUTS_DIR, 'prompt.txt');
    fs.mkdirSync(INPUTS_DIR, { recursive: true });
    fs.writeFileSync(promptPath, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Storyboard narration editing ──────────────────────────────────────────────

app.post('/api/runs/:runId/script', (req, res) => {
  try {
    const { stepId, narration } = req.body;
    if (!stepId || typeof narration !== 'string') {
      return res.status(400).json({ error: 'stepId and narration are required' });
    }

    const wordCount = narration.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount < 8 || wordCount > 35) {
      return res.status(400).json({
        error: `Narration must be 8–35 words (got ${wordCount})`,
        wordCount,
      });
    }

    const dir = getRunDir(req.params.runId);
    const scriptPath = path.join(dir, 'demo-script.json');
    if (!fs.existsSync(scriptPath)) return res.status(404).json({ error: 'Script not found' });

    const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    const steps = script.steps || [];
    const step = steps.find(s => s.id === stepId);
    if (!step) return res.status(404).json({ error: `Step '${stepId}' not found` });

    step.narration = narration;

    const tmpPath = scriptPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(script, null, 2), 'utf8');
    fs.renameSync(tmpPath, scriptPath);

    res.json({ ok: true, wordCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sync-map read/write ────────────────────────────────────────────────────────
// GET  /api/runs/:runId/sync-map  → { segments: [...] }
// POST /api/runs/:runId/sync-map-segment  { compStart, compEnd, videoStart, mode, speed?, _reason? }
//   Appends or updates a segment in sync-map.json, then sorts by compStart.

app.get('/api/runs/:runId/sync-map', (req, res) => {
  try {
    const dir = getRunDir(req.params.runId);
    const p   = path.join(dir, 'sync-map.json');
    if (!fs.existsSync(p)) return res.json({ segments: [] });
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    // sync-map.json is an array of segments
    const segments = Array.isArray(raw) ? raw : (raw.segments || []);
    res.json({ segments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/runs/:runId/sync-map-segment', (req, res) => {
  try {
    const { compStart, compEnd, videoStart, mode = 'freeze', speed, _reason } = req.body;
    if (compStart == null || compEnd == null || compEnd <= compStart) {
      return res.status(400).json({ error: 'compStart and compEnd required; compEnd must be > compStart' });
    }
    const dir = getRunDir(req.params.runId);
    const p   = path.join(dir, 'sync-map.json');
    let rawFile = {};
    let segments = [];
    if (fs.existsSync(p)) {
      rawFile = JSON.parse(fs.readFileSync(p, 'utf8'));
      segments = Array.isArray(rawFile) ? rawFile : (rawFile.segments || []);
      if (Array.isArray(rawFile)) rawFile = {};
    }
    const newSeg = { compStart, compEnd, videoStart: videoStart ?? compStart, mode };
    if (speed != null) newSeg.speed = speed;
    if (_reason) newSeg._reason = _reason;

    // Remove any existing segment that starts at the same compStart
    segments = segments.filter(s => Math.abs(s.compStart - compStart) > 0.01);
    segments.push(newSeg);
    segments.sort((a, b) => a.compStart - b.compStart);

    const out = { ...(rawFile._comment ? { _comment: rawFile._comment } : {}), segments };
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    res.json({ ok: true, segmentCount: segments.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Step reorder ──────────────────────────────────────────────────────────────
// POST /api/runs/:runId/reorder-steps  { stepIds: ['id1','id2',...] }
// Rewrites demo-script.json steps array to match the new order.
app.post('/api/runs/:runId/reorder-steps', (req, res) => {
  try {
    const { stepIds } = req.body;
    if (!Array.isArray(stepIds) || stepIds.length === 0) {
      return res.status(400).json({ error: 'stepIds array is required' });
    }
    const dir = getRunDir(req.params.runId);
    const scriptPath = path.join(dir, 'demo-script.json');
    if (!fs.existsSync(scriptPath)) return res.status(404).json({ error: 'Script not found' });

    const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    const byId = Object.fromEntries((script.steps || []).map(s => [s.id, s]));

    // Validate all IDs exist
    const missing = stepIds.filter(id => !byId[id]);
    if (missing.length > 0) return res.status(400).json({ error: `Unknown step IDs: ${missing.join(', ')}` });

    script.steps = stepIds.map(id => byId[id]);

    const tmpPath = scriptPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(script, null, 2), 'utf8');
    fs.renameSync(tmpPath, scriptPath);

    res.json({ ok: true, stepCount: script.steps.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Remotion Studio launcher (B4) ─────────────────────────────────────────────

app.post('/api/runs/:runId/open-studio', (req, res) => {
  try {
    const dir       = getRunDir(req.params.runId);
    const propsFile = path.join(dir, 'remotion-props.json');
    if (!fs.existsSync(propsFile)) {
      return res.status(404).json({ error: 'remotion-props.json not found for this run — render stage must complete first.' });
    }

    const studioArgs = ['remotion', 'studio', 'remotion/index.js', `--props=${propsFile}`];
    spawn('npx', studioArgs, {
      cwd:      PROJECT_ROOT,
      detached: true,
      stdio:    'ignore',
    }).unref();

    res.json({ ok: true, url: 'http://localhost:3000', propsFile: path.relative(PROJECT_ROOT, propsFile) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Rebuild remotion-props.json on demand ─────────────────────────────────────
// Runs scripts/build-remotion-props.js for the run, then writes remotion-props.json.
// Called after sync-map edits so Remotion Studio hot-reloads without a full render.

app.post('/api/runs/:runId/rebuild-props', (req, res) => {
  try {
    const dir    = getRunDir(req.params.runId);
    const script = path.join(PROJECT_ROOT, 'scripts', 'build-remotion-props.js');

    let stdout = '';
    try {
      stdout = require('child_process').execSync(
        `node "${script}" --runDir="${dir}"`,
        { cwd: PROJECT_ROOT, timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (execErr) {
      const msg = (execErr.stderr || execErr.stdout || execErr.message || '').toString().slice(0, 400);
      return res.status(500).json({ error: 'build-remotion-props failed: ' + msg });
    }

    // Parse the __RESULT__ summary line emitted by the script
    const resultMatch = stdout.match(/__RESULT__(\{.+\})/);
    const summary = resultMatch ? JSON.parse(resultMatch[1]) : {};

    res.json({ ok: true, ...summary });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Studio recording status ───────────────────────────────────────────────────

app.get('/api/runs/:runId/studio-status', (req, res) => {
  try {
    const statusFile = path.join(getRunDir(req.params.runId), 'studio-record-status.json');
    if (!fs.existsSync(statusFile)) return res.json(null);
    res.json(JSON.parse(fs.readFileSync(statusFile, 'utf8')));
  } catch (_) {
    res.json(null);
  }
});

// ── Pipeline runner ───────────────────────────────────────────────────────────

app.get('/api/pipeline/stages', (req, res) => {
  res.json({ stages: PIPELINE_STAGES });
});

app.post('/api/pipeline/run', (req, res) => {
  try {
    // If activeProcess is set but has already exited, clear the stale reference
    if (activeProcess !== null && activeProcess.exitCode !== null) {
      activeProcess = null;
    }

    const { force } = req.body || {};
    if (activeProcess !== null && !force) {
      return res.status(409).json({ error: 'Already running', pid: activeProcess.pid });
    }
    // force=true: kill the existing process and start fresh
    if (activeProcess !== null && force) {
      try { activeProcess.kill('SIGTERM'); } catch (_) {}
      activeProcess = null;
    }

    const { fromStage, noTouchup, resumeRunId } = req.body || {};
    const args = ['scripts/scratch/orchestrator.js'];
    if (fromStage) args.push(`--from=${fromStage}`);
    if (noTouchup) args.push('--no-touchup');

    // Build spawn env — pass PIPELINE_RUN_DIR to resume into an existing run directory
    const spawnEnv = { ...process.env };
    if (resumeRunId) {
      try {
        const resumeDir = getRunDir(resumeRunId);
        if (!fs.existsSync(resumeDir)) {
          return res.status(404).json({ error: `Run directory not found: ${resumeRunId}` });
        }
        spawnEnv.PIPELINE_RUN_DIR = resumeDir;
        broadcastLog(`[Dashboard] Resuming into run directory: ${resumeDir}`);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    logBuffer = [];

    activeProcess = spawn('node', args, {
      cwd: PROJECT_ROOT,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    activeProcess.stdout.on('data', data => {
      data.toString().split('\n').filter(Boolean).forEach(broadcastLog);
    });
    activeProcess.stderr.on('data', data => {
      data.toString().split('\n').filter(Boolean).forEach(broadcastLog);
    });
    activeProcess.on('close', code => {
      broadcastLog(`[Pipeline exited with code ${code}]`);
      activeProcess = null;
    });
    activeProcess.on('error', err => {
      broadcastLog(`[Pipeline error: ${err.message}]`);
      activeProcess = null;
    });

    res.json({ pid: activeProcess.pid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline/kill', (req, res) => {
  try {
    if (!activeProcess) return res.status(404).json({ error: 'No active process' });

    activeProcess.kill('SIGTERM');
    const proc = activeProcess;
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
    }, 5000);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pipeline/status', (req, res) => {
  // Clear stale reference if the process has already exited
  if (activeProcess !== null && activeProcess.exitCode !== null) {
    activeProcess = null;
  }
  res.json({ running: activeProcess !== null, pid: activeProcess ? activeProcess.pid : null });
});

app.post('/api/pipeline/stdin', (req, res) => {
  if (!activeProcess || !activeProcess.stdin) {
    return res.status(404).json({ error: 'No active process or stdin not available' });
  }
  try {
    const input = (req.body && typeof req.body.input === 'string') ? req.body.input : '\n';
    activeProcess.stdin.write(input);
    broadcastLog('[Dashboard] Sent continue signal to pipeline');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pipeline/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay buffered lines
  for (const line of logBuffer) {
    res.write(`data: ${line}\n\n`);
  }

  logClients.add(res);

  const keepAlive = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch (_) {}
  }, 20000);

  req.on('close', () => {
    logClients.delete(res);
    clearInterval(keepAlive);
  });
});

// ── File-system watcher (SSE) ─────────────────────────────────────────────────

app.get('/api/fs/watch', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const watcher = chokidar.watch(DEMOS_DIR, { ignoreInitial: true, depth: 2 });

  const send = (type, filePath) => {
    const rel = path.relative(DEMOS_DIR, filePath);
    try { res.write(`data: ${JSON.stringify({ type, path: rel })}\n\n`); } catch (_) {}
  };

  watcher.on('add',    p => send('add', p));
  watcher.on('change', p => send('change', p));
  watcher.on('unlink', p => send('unlink', p));

  const keepAlive = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch (_) {}
  }, 20000);

  req.on('close', () => {
    watcher.close();
    clearInterval(keepAlive);
  });
});

// ── Narration AI rewrite ─────────────────────────────────────────────────────

app.post('/api/runs/:runId/narration-rewrite', async (req, res) => {
  try {
    const { stepId, narration, direction, label } = req.body;
    if (!narration || !direction) {
      return res.status(400).json({ error: 'narration and direction are required' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const prompt = `You are editing demo narration for a Plaid product demo video.

Step: "${label || stepId}"
Current narration (${narration.trim().split(/\s+/).length} words):
"${narration}"

Human direction: ${direction}

Rewrite the narration following this direction. Rules:
- 8–35 words total (count carefully)
- Active voice, outcome-focused language
- Confident and precise — never apologetic or jargon-heavy
- Do NOT use: "simply", "just", "unfortunately", "robust", "seamless"
- Preserve all proper nouns (product names, persona names, dollar amounts, percentages)
- Return ONLY the rewritten narration text — no quotes, no explanation, no word count`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const rewritten = (message.content[0]?.text || '').trim();
    const wordCount = rewritten.split(/\s+/).filter(Boolean).length;
    res.json({ rewritten, wordCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Brand profile for a run ───────────────────────────────────────────────────
// GET /api/runs/:runId/brand
// Returns the brand profile (colors, typography, mode) for the run.
app.get('/api/runs/:runId/brand', (req, res) => {
  try {
    const dir = getRunDir(req.params.runId);
    const brandDir = path.join(PROJECT_ROOT, 'brand');
    let brandProfile = null;
    let brandSlug = null;

    const ingestedInputs = safeReadJson(path.join(dir, 'ingested-inputs.json'));
    if (ingestedInputs && Array.isArray(ingestedInputs.texts)) {
      const promptFile = ingestedInputs.texts.find(t => t.filename === 'prompt.txt');
      if (promptFile && promptFile.content) {
        const m = promptFile.content.match(/Brand URL:\s*https?:\/\/(?:www\.)?([^./\s]+)/i);
        if (m) brandSlug = m[1].toLowerCase();
      }
    }

    const brandFile = brandSlug && fs.existsSync(path.join(brandDir, `${brandSlug}.json`))
      ? path.join(brandDir, `${brandSlug}.json`)
      : path.join(brandDir, 'default.json');

    if (fs.existsSync(brandFile)) {
      brandProfile = JSON.parse(fs.readFileSync(brandFile, 'utf8'));
    }

    if (!brandProfile) return res.json({ slug: 'default', mode: 'dark', bgPrimary: '#0d1117', accentCta: '#00A67E', textPrimary: '#ffffff', font: 'system-ui', insightBg: '#0d1117', insightAccent: '#00A67E' });

    res.json({
      slug: brandProfile.slug || brandSlug || 'default',
      mode: brandProfile.mode || 'dark',
      bgPrimary: brandProfile.colors?.bgPrimary || '#0d1117',
      accentCta: brandProfile.colors?.accentCta || '#00A67E',
      textPrimary: brandProfile.colors?.textPrimary || '#ffffff',
      font: brandProfile.typography?.fontHeading || brandProfile.typography?.fontBody || 'system-ui',
      insightBg: brandProfile.sidePanels?.bg || '#0d1117',
      insightAccent: brandProfile.colors?.accentCta || '#00A67E',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Generate new step (Claude Haiku) ─────────────────────────────────────────
// POST /api/runs/:runId/generate-step
// body: { sceneType: 'demo'|'slide', description, insertAfterId? }
app.post('/api/runs/:runId/generate-step', async (req, res) => {
  try {
    const { sceneType, description, insertAfterId } = req.body;
    if (!sceneType || !description) return res.status(400).json({ error: 'sceneType and description required' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });

    const dir = getRunDir(req.params.runId);
    const script = safeReadJson(path.join(dir, 'demo-script.json'));
    if (!script) return res.status(404).json({ error: 'demo-script.json not found' });

    const steps = script.steps || [];
    const product = script.product || req.params.runId;
    const persona = script.persona || 'the user';
    const personaFirst = (persona.split(' ')[0] || 'the user');
    const stepContext = steps.map((s, i) => `${i + 1}. [${s.id}] "${s.label}": ${(s.narration || '').slice(0, 80)}`).join('\n');
    const isSlide = sceneType === 'slide';

    // ── Resolve brand JSON for this run ──────────────────────────────────────
    // Strategy: extract brand slug from ingested prompt.txt "Brand URL:" line,
    // then match against brand/<slug>.json. Falls back to brand/default.json.
    let brandProfile = null;
    try {
      const brandDir = path.join(PROJECT_ROOT, 'brand');
      const ingestedInputs = safeReadJson(path.join(dir, 'ingested-inputs.json'));
      let brandSlug = null;

      // Extract Brand URL from ingested prompt.txt content
      if (ingestedInputs && Array.isArray(ingestedInputs.texts)) {
        const promptFile = ingestedInputs.texts.find(t => t.filename === 'prompt.txt');
        if (promptFile && promptFile.content) {
          const brandUrlMatch = promptFile.content.match(/Brand URL:\s*https?:\/\/(?:www\.)?([^./\s]+)/i);
          if (brandUrlMatch) brandSlug = brandUrlMatch[1].toLowerCase();
        }
      }

      // Try to load brand/<slug>.json, fallback to default.json
      const brandFile = brandSlug && fs.existsSync(path.join(brandDir, `${brandSlug}.json`))
        ? path.join(brandDir, `${brandSlug}.json`)
        : path.join(brandDir, 'default.json');

      if (fs.existsSync(brandFile)) {
        brandProfile = JSON.parse(fs.readFileSync(brandFile, 'utf8'));
      }
    } catch (_e) { /* brand lookup best-effort */ }

    // Build brand context strings for prompt injection
    const brandMode = brandProfile?.mode || 'dark';
    const brandBg = brandProfile?.colors?.bgPrimary || '#0d1117';
    const brandAccent = brandProfile?.colors?.accentCta || '#00A67E';
    const brandTextPrimary = brandProfile?.colors?.textPrimary || '#ffffff';
    const brandFont = brandProfile?.typography?.fontHeading || brandProfile?.typography?.fontBody || 'system-ui';
    const brandInstructions = brandProfile?.promptInstructions || '';
    const brandSlugLabel = brandProfile?.slug || 'plaid';

    // For slide/insight screens: always dark regardless of brand mode
    const insightBg = brandProfile?.sidePanels?.bg || '#0d1117';
    const insightAccent = brandProfile?.colors?.accentCta || '#00A67E';

    // Parse CSS vars from built app if it exists (most accurate — these are in the video)
    let cssVars = {};
    try {
      const appHtml = path.join(dir, 'scratch-app', 'index.html');
      if (fs.existsSync(appHtml)) {
        const html = fs.readFileSync(appHtml, 'utf8');
        const rootMatch = html.match(/:root\s*\{([^}]+)\}/);
        if (rootMatch) {
          rootMatch[1].split(';').forEach(decl => {
            const [prop, val] = decl.split(':').map(s => s.trim());
            if (prop && val) cssVars[prop] = val;
          });
        }
      }
    } catch (_e) { /* best-effort */ }

    // Use CSS vars if available, fall back to brand JSON
    const demoBg = cssVars['--bg'] || brandBg;
    const demoAccent = cssVars['--primary'] || brandAccent;
    const demoText = cssVars['--text-primary'] || brandTextPrimary;
    const demoHeadingFont = cssVars['--heading-font'] || brandFont;

    const slideStyleDesc = isSlide
      ? `SLIDE — Plaid insight overlay screen (always dark, matches ${brandSlugLabel} demo's insight screens).
Background: ${insightBg}. Accent color: ${insightAccent} (${brandSlugLabel} brand color).
White body text on dark. Brand accent used for: header bottom border, badge colors, highlighted values.
Glassmorphism data cards: rgba(255,255,255,0.06) bg, rgba(255,255,255,0.1) border.
Must visually match existing insight steps: auth-insight, identity-match-insight, signal-insight.`
      : `DEMO — navigates the real product UI (${brandSlugLabel} host app). App CSS: bg=${demoBg}, accent=${demoAccent}, text=${demoText}, font: ${demoHeadingFont}.`;

    const slideVisualStatePrompt = isSlide
      ? `Dark insight screen (bg ${insightBg}). Header bar with endpoint label in ${insightAccent}. Left: heading in white + body text + data cards (rgba(255,255,255,0.06) bg). Right: api-response-panel JSON. ${insightAccent}-colored badges/highlights. No ${brandSlugLabel} host app branding.`
      : `What the user sees on screen in the ${brandSlugLabel} host app (bg=${demoBg}, accent=${demoAccent}): UI elements, state, content visible at this step.`;

    const prompt = `You are generating a new step for a Plaid product demo video storyboard.

Product: ${product}
Persona: ${persona}
Scene type: ${slideStyleDesc}

Existing steps:
${stepContext}

Insert after: ${insertAfterId || '(end of sequence)'}

New step description: "${description}"

Generate a single JSON object. Return ONLY valid JSON — no explanation, no markdown fences.

Required fields:
{
  "id": "kebab-case-id (3-4 words max)",
  "label": "Human-readable title (3-6 words)",
  "narration": "20-35 words. Active voice, outcome-focused. No: simply/just/seamless/robust. Lead with value. Use ${personaFirst}'s name.",
  "durationMs": <10000–18000>,
  "visualState": "${slideVisualStatePrompt}",
  ${isSlide
    ? '"apiResponse": { "endpoint": "product/method", "display": "expand" },'
    : '"interaction": { "type": "click|wait|scroll", "target": "data-testid-of-element" },'}
  "plaidPhase": ${isSlide ? '"insight"' : 'null'}
}

Brand voice rules: active voice ("Plaid verifies" not "is verified"), quantify outcomes, persona name = ${personaFirst}.`;

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = (message.content[0]?.text || '').trim();
    const jsonStr = (raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw])[1].trim();
    const step = JSON.parse(jsonStr);
    res.json({
      step,
      sceneType,
      brand: brandProfile ? {
        slug: brandProfile.slug,
        mode: brandMode,
        bgPrimary: brandBg,
        accentCta: brandAccent,
        textPrimary: brandTextPrimary,
        font: brandFont,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/runs/:runId/insert-step
// body: { step: {...}, insertAfterId? }
app.post('/api/runs/:runId/insert-step', (req, res) => {
  try {
    const { step, insertAfterId } = req.body;
    if (!step || !step.id) return res.status(400).json({ error: 'step with id required' });

    const dir = getRunDir(req.params.runId);
    const scriptPath = path.join(dir, 'demo-script.json');
    const script = safeReadJson(scriptPath);
    if (!script) return res.status(404).json({ error: 'demo-script.json not found' });

    const steps = script.steps || [];
    // Deduplicate id
    if (steps.some(s => s.id === step.id)) step.id = step.id + '-new';

    let insertIdx = steps.length;
    if (insertAfterId) {
      const idx = steps.findIndex(s => s.id === insertAfterId);
      if (idx >= 0) insertIdx = idx + 1;
    }
    steps.splice(insertIdx, 0, step);
    script.steps = steps;

    const tmp = scriptPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(script, null, 2), 'utf8');
    fs.renameSync(tmp, scriptPath);
    res.json({ ok: true, stepId: step.id, insertedAt: insertIdx, totalSteps: steps.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Human feedback export/read ────────────────────────────────────────────────

const FEEDBACK_FILE = path.join(INPUTS_DIR, 'build-feedback.md');

app.get('/api/feedback', (req, res) => {
  try {
    if (!fs.existsSync(FEEDBACK_FILE)) return res.json({ exists: false, content: '' });
    const content = fs.readFileSync(FEEDBACK_FILE, 'utf8');
    res.json({ exists: true, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/feedback/export', (req, res) => {
  try {
    const { globalNotes, stepNotes, runId } = req.body;
    if (typeof globalNotes !== 'string' && typeof stepNotes !== 'object') {
      return res.status(400).json({ error: 'globalNotes (string) and stepNotes (object) required' });
    }

    const lines = [
      `# Human Review Feedback`,
      `Generated: ${new Date().toISOString().split('T')[0]}${runId ? `  |  Run: ${runId}` : ''}`,
      ``,
      `> This file is read by the build stage when running a refinement pass.`,
      `> Edit or delete it between runs as needed.`,
      ``,
    ];

    const globalTrimmed = (globalNotes || '').trim();
    if (globalTrimmed) {
      lines.push(`## Global HTML Notes`);
      lines.push(``);
      lines.push(globalTrimmed);
      lines.push(``);
    }

    const stepEntries = Object.entries(stepNotes || {}).filter(([, v]) => v && v.trim());
    if (stepEntries.length > 0) {
      lines.push(`## Per-Step Visual Notes`);
      lines.push(``);
      for (const [stepId, note] of stepEntries) {
        lines.push(`### ${stepId}`);
        lines.push(``);
        lines.push(note.trim());
        lines.push(``);
      }
    }

    const content = lines.join('\n');
    const tmp = FEEDBACK_FILE + '.tmp';
    fs.mkdirSync(INPUTS_DIR, { recursive: true });
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, FEEDBACK_FILE);

    res.json({ ok: true, path: FEEDBACK_FILE, bytes: content.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Storyboard timing analysis ───────────────────────────────────────────────

app.get('/api/runs/:runId/timing', (req, res) => {
  try {
    const dir = getRunDir(req.params.runId);

    const script = safeReadJson(path.join(dir, 'demo-script.json'));
    if (!script || !script.steps) return res.status(404).json({ error: 'No script' });

    const manifest = safeReadJson(path.join(dir, 'voiceover-manifest.json'));
    const clipMap = {};
    if (manifest && manifest.clips) {
      for (const clip of manifest.clips) {
        // videoDurationMs = the window the step occupies in the composed timeline
        const videoDurationMs = clip.endMs - clip.startMs;
        clipMap[clip.id] = {
          audioDurationMs: clip.audioFile ? clip.audioDurationMs : null,
          videoDurationMs,
          startMs: clip.startMs,
          endMs: clip.endMs,
        };
      }
    }

    const steps = script.steps.map(step => {
      const clip = clipMap[step.id];
      const scriptDurationMs = step.durationMs || null;
      const audioDurationMs  = clip ? clip.audioDurationMs  : null;
      const videoDurationMs  = clip ? clip.videoDurationMs  : scriptDurationMs;
      const effectiveDurationMs = videoDurationMs || scriptDurationMs;

      let silenceMs   = null;
      let overflowMs  = null;
      if (audioDurationMs != null && effectiveDurationMs != null) {
        const diff = effectiveDurationMs - audioDurationMs;
        if (diff > 0)  silenceMs  = diff;   // voice ends before step does
        if (diff < 0)  overflowMs = -diff;  // voice runs past step end
      }

      return {
        id: step.id,
        label: step.label,
        scriptDurationMs,
        audioDurationMs,
        videoDurationMs: effectiveDurationMs,
        silenceMs,
        overflowMs,
      };
    });

    res.json({ steps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-gap report & overrides ──────────────────────────────────────────────

app.get('/api/runs/:runId/auto-gap', (req, res) => {
  try {
    const dir = getRunDir(req.params.runId);
    const reportPath = path.join(dir, 'auto-gap-report.json');
    if (!fs.existsSync(reportPath)) return res.json({});
    res.json(safeReadJson(reportPath) || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/runs/:runId/auto-gap-overrides', (req, res) => {
  try {
    const { overrides } = req.body;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      return res.status(400).json({ error: 'overrides must be an object' });
    }
    // Validate each entry has a numeric gapMs
    for (const [stepId, val] of Object.entries(overrides)) {
      if (!val || typeof val.gapMs !== 'number' || val.gapMs < 0) {
        return res.status(400).json({ error: `Invalid gapMs for step '${stepId}' — must be a non-negative number` });
      }
    }
    const dir = getRunDir(req.params.runId);
    const overridesPath = path.join(dir, 'auto-gap-overrides.json');
    const tmp = overridesPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(overrides, null, 2), 'utf8');
    fs.renameSync(tmp, overridesPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI Overlay Suggestions ────────────────────────────────────────────────────

app.get('/api/runs/:runId/overlay-suggestions', (req, res) => {
  try {
    const dir  = getRunDir(req.params.runId);
    const file = path.join(dir, 'overlay-suggestions.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'overlay-suggestions.json not found' });
    const data = safeReadJson(file);
    if (!data) return res.status(500).json({ error: 'Could not parse overlay-suggestions.json' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/runs/:runId/apply-suggestion', (req, res) => {
  try {
    const { stepId, suggestionIndex } = req.body || {};
    if (!stepId || typeof suggestionIndex !== 'number') {
      return res.status(400).json({ error: 'stepId and suggestionIndex are required' });
    }

    const dir = getRunDir(req.params.runId);

    // Load suggestions
    const suggestionsFile = path.join(dir, 'overlay-suggestions.json');
    const suggestions = safeReadJson(suggestionsFile);
    if (!suggestions) return res.status(404).json({ error: 'overlay-suggestions.json not found' });
    const stepEntry = suggestions.steps?.[stepId];
    if (!stepEntry?.suggestions?.[suggestionIndex]) {
      return res.status(404).json({ error: `Suggestion ${suggestionIndex} not found for step ${stepId}` });
    }
    const suggestion = stepEntry.suggestions[suggestionIndex];

    // Load remotion-props
    const propsFile = path.join(dir, 'remotion-props.json');
    const props = safeReadJson(propsFile);
    if (!props) return res.status(404).json({ error: 'remotion-props.json not found' });

    // Apply patch via deep-merge
    // deepMergePatch defined at top of server.js
    const current = props.scratchSteps?.[stepId] || {};
    const updated = deepMergePatch(current, suggestion.patch, suggestion.action);
    if (!props.scratchSteps) props.scratchSteps = {};
    props.scratchSteps[stepId] = updated;

    // Atomic write
    const tmp = propsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(props, null, 2));
    fs.renameSync(tmp, propsFile);

    res.json({ ok: true, appliedPatch: suggestion.patch, updatedStep: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/runs/:runId/apply-all-suggestions', (req, res) => {
  try {
    const minConfidence = parseFloat(req.body?.minConfidence ?? 0.85);

    const dir = getRunDir(req.params.runId);

    // Load suggestions
    const suggestionsFile = path.join(dir, 'overlay-suggestions.json');
    const suggestions = safeReadJson(suggestionsFile);
    if (!suggestions) return res.status(404).json({ error: 'overlay-suggestions.json not found' });

    // Load remotion-props
    const propsFile = path.join(dir, 'remotion-props.json');
    const props = safeReadJson(propsFile);
    if (!props) return res.status(404).json({ error: 'remotion-props.json not found' });
    if (!props.scratchSteps) props.scratchSteps = {};

    // deepMergePatch defined at top of server.js
    let applied = 0;
    let skipped = 0;
    const appliedStepIds = [];

    for (const [stepId, entry] of Object.entries(suggestions.steps || {})) {
      if (!entry?.suggestions?.length) continue;
      let stepApplied = false;
      for (const suggestion of entry.suggestions) {
        if (suggestion.confidence < minConfidence) { skipped++; continue; }
        const current = props.scratchSteps[stepId] || {};
        props.scratchSteps[stepId] = deepMergePatch(current, suggestion.patch, suggestion.action);
        applied++;
        stepApplied = true;
      }
      if (stepApplied) appliedStepIds.push(stepId);
    }

    // Atomic write
    const tmp = propsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(props, null, 2));
    fs.renameSync(tmp, propsFile);

    res.json({ applied, skipped, stepIds: appliedStepIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ElevenLabs voices proxy (cached) ─────────────────────────────────────────

let _voicesCache = null;
let _voicesCacheAt = 0;
const VOICES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.get('/api/elevenlabs/voices', async (req, res) => {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'ELEVENLABS_API_KEY not set' });

    const now = Date.now();
    if (_voicesCache && now - _voicesCacheAt < VOICES_CACHE_TTL) {
      return res.json(_voicesCache);
    }

    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
    });
    if (!r.ok) {
      return res.status(r.status).json({ error: `ElevenLabs API: ${r.status} ${r.statusText}` });
    }
    const data = await r.json();
    // Normalise: keep only fields needed by UI, sort premade first then cloned/generated
    const voices = (data.voices || [])
      .filter(v => v.voice_id && v.name)
      .map(v => ({
        voice_id:    v.voice_id,
        name:        v.name,
        category:    v.category || 'unknown',
        description: v.description || '',
        preview_url: v.preview_url || null,
        labels:      v.labels || {},
      }))
      .sort((a, b) => {
        const order = { premade: 0, professional: 1, cloned: 2, generated: 3 };
        return (order[a.category] ?? 9) - (order[b.category] ?? 9);
      });

    _voicesCache = { voices };
    _voicesCacheAt = now;
    res.json({ voices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Value props markdown routes ───────────────────────────────────────────────

const PRODUCTS_DIR = path.join(INPUTS_DIR, 'products');

// Allowed filename pattern: only *.md files within inputs/ or inputs/products/
function safeInputsPath(name) {
  // Allow "products/<filename>.md" sub-path
  if (!name || !/^(?:products\/)?[\w\-]+\.md$/i.test(name)) {
    throw new Error('Invalid filename');
  }
  const resolved = path.resolve(INPUTS_DIR, name);
  if (!resolved.startsWith(INPUTS_DIR + path.sep)) {
    throw new Error('Path escapes inputs dir');
  }
  return resolved;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns a plain object of key→value strings, or {} if no frontmatter.
 * No external deps — regex only.
 */
function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const obj = {};
  m[1].split('\n').forEach(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return;
    const k = line.slice(0, colonIdx).trim();
    if (!k) return;
    let v = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    obj[k] = v;
  });
  return obj;
}

app.get('/api/valueprop/list', (req, res) => {
  try {
    // Root inputs/ files
    const rootFiles = safeReaddir(INPUTS_DIR)
      .filter(f => f.toLowerCase().endsWith('.md'))
      .sort()
      .map(f => {
        const full = path.join(INPUTS_DIR, f);
        const stat = fs.statSync(full);
        const content = fs.readFileSync(full, 'utf8');
        const fm = parseFrontmatter(content);
        const needsReview = fm.needs_review === 'true' ||
          (fm.last_ai_update && fm.last_human_review && fm.last_ai_update > fm.last_human_review);
        return {
          name: f,
          size: stat.size,
          mtime: stat.mtimeMs,
          group: 'root',
          frontmatter: fm,
          needsReview,
        };
      });

    // inputs/products/ files
    const productFiles = safeReaddir(PRODUCTS_DIR)
      .filter(f => f.toLowerCase().endsWith('.md'))
      .sort()
      .map(f => {
        const full = path.join(PRODUCTS_DIR, f);
        const stat = fs.statSync(full);
        const content = fs.readFileSync(full, 'utf8');
        const fm = parseFrontmatter(content);
        const needsReview = fm.needs_review === 'true' ||
          (fm.last_ai_update && fm.last_human_review && fm.last_ai_update > fm.last_human_review);
        return {
          name: `products/${f}`,
          size: stat.size,
          mtime: stat.mtimeMs,
          group: 'products',
          frontmatter: fm,
          needsReview,
        };
      });

    res.json({ files: [...productFiles, ...rootFiles] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/valueprop/review', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const filePath = safeInputsPath(name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    let content = fs.readFileSync(filePath, 'utf8');
    const today = new Date().toISOString().split('T')[0];
    content = content.replace(/^last_human_review:.*$/m, `last_human_review: "${today}"`);
    content = content.replace(/^needs_review:.*$/m, 'needs_review: false');
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message === 'Invalid filename' ? 400 : 500).json({ error: err.message });
  }
});

app.get('/api/valueprop/:name', (req, res) => {
  try {
    const filePath = safeInputsPath(req.params.name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ name: req.params.name, content });
  } catch (err) {
    res.status(err.message === 'Invalid filename' ? 400 : 500).json({ error: err.message });
  }
});

app.put('/api/valueprop/:name', (req, res) => {
  try {
    const { content } = req.body;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
    const filePath = safeInputsPath(req.params.name);
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message === 'Invalid filename' ? 400 : 500).json({ error: err.message });
  }
});

// ── Remotion Studio ───────────────────────────────────────────────────────────

app.get('/api/studio/status', (req, res) => {
  try {
    const runId = latestRunId();
    let mp4Ready = false;
    if (runId) {
      mp4Ready = fs.existsSync(path.join(DEMOS_DIR, runId, 'demo-scratch.mp4'));
    }

    let running = false;
    try {
      const output = execSync('ps aux', { encoding: 'utf8', timeout: 3000 });
      running = output.includes('remotion');
    } catch (_) {
      running = false;
    }

    res.json({ running, mp4Ready, latestRunId: runId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/studio/start', (req, res) => {
  try {
    const child = spawn('node', ['node_modules/.bin/remotion', 'studio'], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── our-recorder project config + studio-advance proxy ───────────────────────

const OUR_RECORDER_ROOT    = process.env.OUR_RECORDER_ROOT    || '/Users/dmajetic/Claude Test/our-recorder';
const OUR_RECORDER_PROJECT = process.env.OUR_RECORDER_PROJECT || 'my-video';
const MANUAL_RECORD_PORT   = 3739;

app.get('/api/studio/our-recorder-project', (req, res) => {
  const projectDir = path.join(OUR_RECORDER_ROOT, 'public', OUR_RECORDER_PROJECT);
  res.json({
    root:    OUR_RECORDER_ROOT,
    project: OUR_RECORDER_PROJECT,
    dir:     projectDir,
    exists:  fs.existsSync(projectDir),
  });
});

app.post('/api/studio/our-recorder-project', (req, res) => {
  // Allowed to override only the project subfolder name (not root) at runtime.
  const { project } = req.body || {};
  if (!project || typeof project !== 'string' || project.includes('..') || project.includes('/')) {
    return res.status(400).json({ error: 'Invalid project name' });
  }
  // We can't mutate the module-level const, so just return what would be used.
  // The actual value is read from .env — tell the user to set OUR_RECORDER_PROJECT in .env.
  const projectDir = path.join(OUR_RECORDER_ROOT, 'public', project);
  res.json({ ok: true, project, dir: projectDir, note: 'Set OUR_RECORDER_PROJECT in .env and restart to persist.' });
});

app.post('/api/studio/advance', (req, res) => {
  // Proxy to manual-record.js HTTP advance endpoint on MANUAL_RECORD_PORT
  const http = require('http');
  const postData = JSON.stringify({});
  const options = {
    hostname: '127.0.0.1',
    port: MANUAL_RECORD_PORT,
    path: '/studio-advance',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    timeout: 3000,
  };
  const proxyReq = http.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => { body += chunk; });
    proxyRes.on('end', () => {
      try { res.json(JSON.parse(body)); } catch (_) { res.json({ ok: true }); }
    });
  });
  proxyReq.on('error', (err) => {
    res.status(502).json({ error: 'manual-record not running: ' + err.message });
  });
  proxyReq.write(postData);
  proxyReq.end();
});

// ── Recording status ──────────────────────────────────────────────────────────

app.get('/api/recording/status', (req, res) => {
  try {
    const runId = req.query.runId || latestRunId();
    if (!runId) return res.json({ state: 'idle', runId: null });

    const dir      = path.join(DEMOS_DIR, runId);
    const tmpDir   = path.join(dir, '_recording-tmp');
    const rawFile  = path.join(dir, 'recording-raw.webm');
    const doneFile = path.join(dir, 'recording.webm');

    let state = 'idle';
    let detail = null;

    if (fs.existsSync(tmpDir) && safeReaddir(tmpDir).some(f => f.endsWith('.webm'))) {
      state = 'recording';
      const tmpFiles = safeReaddir(tmpDir).filter(f => f.endsWith('.webm'));
      if (tmpFiles.length) {
        try { detail = { sizeBytes: fs.statSync(path.join(tmpDir, tmpFiles[0])).size }; } catch (_) {}
      }
    } else if (fs.existsSync(rawFile) && !fs.existsSync(doneFile)) {
      state = 'processing';
      try { detail = { rawSizeBytes: fs.statSync(rawFile).size }; } catch (_) {}
    } else if (fs.existsSync(doneFile)) {
      state = 'complete';
      try { detail = { sizeBytes: fs.statSync(doneFile).size }; } catch (_) {}
    }

    res.json({ state, runId, detail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Demo App Launcher ─────────────────────────────────────────────────────────

const demoAppServers = new Map(); // runId → { url, port, server }
const DEMO_APP_BASE_PORT = 3750;
const DEMO_APP_OVERLAY_FILE = path.join(__dirname, 'public', 'ai-overlay.js');

const DEMO_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
};

async function launchDemoAppServer(runId) {
  if (demoAppServers.has(runId)) return demoAppServers.get(runId);

  const scratchAppDir = path.join(DEMOS_DIR, runId, 'scratch-app');
  if (!fs.existsSync(path.join(scratchAppDir, 'index.html'))) {
    throw new Error(`No built app found for run: ${runId}`);
  }

  const demoApp = express();
  demoApp.use(express.json({ limit: '10mb' }));
  demoApp.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // Serve AI overlay script
  demoApp.get('/__ai-overlay.js', (req, res) => {
    try {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(fs.readFileSync(DEMO_APP_OVERLAY_FILE, 'utf8'));
    } catch (_) { res.status(404).end('// overlay not found'); }
  });

  // Plaid API proxy routes (only when live mode enabled)
  if (process.env.PLAID_LINK_LIVE === 'true') {
    let _plaid = null;
    const getPlaid = () => { if (!_plaid) _plaid = require('../scratch/utils/plaid-backend'); return _plaid; };
    demoApp.options('/api/*', (req, res) => res.status(204).end());
    demoApp.post('/api/create-link-token', async (req, res) => {
      try { res.json(await getPlaid().createLinkToken(req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
    demoApp.post('/api/exchange-public-token', async (req, res) => {
      try { res.json(await getPlaid().exchangePublicToken(req.body.public_token)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
    demoApp.post('/api/auth-get', async (req, res) => {
      try { res.json(await getPlaid().getAuth(req.body.access_token)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
    demoApp.post('/api/identity-match', async (req, res) => {
      try { res.json(await getPlaid().getIdentityMatch(req.body.access_token, req.body.legal_name)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
    demoApp.post('/api/signal-evaluate', async (req, res) => {
      try { res.json(await getPlaid().evaluateSignal(req.body.access_token, req.body.account_id, req.body.amount)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }

  // Root — inject overlay globals + script tag
  demoApp.get('/', (req, res) => {
    try {
      let html = fs.readFileSync(path.join(scratchAppDir, 'index.html'), 'utf8');
      const inject = `<script>window.__DEMO_RUN_ID__=${JSON.stringify(runId)};window.__DASHBOARD_ORIGIN__='http://localhost:${PORT}';</script><script src="/__ai-overlay.js" defer></script>`;
      html = html.includes('</body>') ? html.replace('</body>', inject + '\n</body>') : html + inject;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    } catch (e) { res.status(500).end(`Error: ${e.message}`); }
  });

  // Static files
  demoApp.use(express.static(scratchAppDir));

  // Find an available port
  let port = DEMO_APP_BASE_PORT;
  const usedPorts = new Set(Array.from(demoAppServers.values()).map(s => s.port));
  while (usedPorts.has(port)) port++;

  const server = await new Promise((resolve, reject) => {
    const s = demoApp.listen(port, '127.0.0.1', () => resolve(s)).once('error', reject);
  });

  const url = `http://localhost:${port}`;
  const entry = { url, port, server };
  demoAppServers.set(runId, entry);
  console.log(`[DemoApp] ${runId} → ${url}`);
  return entry;
}

// CORS for demo-app routes (overlay calls from port 3750 → 4040 are cross-origin)
app.use('/api/demo-apps', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/api/demo-apps', (req, res) => {
  try {
    const apps = safeReaddir(DEMOS_DIR)
      .filter(d => {
        try {
          return fs.statSync(path.join(DEMOS_DIR, d)).isDirectory() &&
            fs.existsSync(path.join(DEMOS_DIR, d, 'scratch-app/index.html'));
        } catch (_) { return false; }
      })
      .sort().reverse()
      .map(runId => ({
        runId,
        running: demoAppServers.has(runId),
        url: demoAppServers.get(runId)?.url || null,
        port: demoAppServers.get(runId)?.port || null,
      }));
    res.json({ apps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/demo-apps/launch', async (req, res) => {
  try {
    const { runId } = req.body;
    if (!runId) return res.status(400).json({ error: 'runId required' });
    const entry = await launchDemoAppServer(runId);
    res.json({ url: entry.url, port: entry.port });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/demo-apps/:runId/stop', async (req, res) => {
  try {
    const { runId } = req.params;
    const entry = demoAppServers.get(runId);
    if (!entry) return res.status(404).json({ error: 'Server not running' });
    await new Promise((resolve, reject) => entry.server.close(e => e ? reject(e) : resolve()));
    demoAppServers.delete(runId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AI edit helpers ───────────────────────────────────────────────────────────

const CSS_KEYWORDS = /\b(font|color|background|border|radius|padding|margin|size|spacing|shadow|opacity|weight|button|icon|badge|card|text|heading|label|link|hover|gradient|gap|flex|align|justify|width|height|display|transition|animation|cursor|outline|ring|accent|teal|dark|light|bright|bold|italic|rounded|pill|style)\b/i;
const STRUCTURAL_KEYWORDS = /\b(add|remove|delete|insert|create|new step|new screen|move|reorder|rename|duplicate|hide|show step)\b/i;

/** Extract all <style>…</style> blocks from HTML. Returns { css, ranges } */
function extractStyleBlocks(html) {
  const blocks = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    blocks.push({ start: m.index, end: m.index + m[0].length, inner: m[1], full: m[0] });
  }
  return blocks;
}

/** Splice updated CSS back into the original HTML (replaces first <style> block content). */
function spliceCSS(html, blocks, newCss) {
  if (!blocks.length) return html;
  const b = blocks[0];
  return html.slice(0, b.start) + `<style>\n${newCss}\n</style>` + html.slice(b.end);
}

/** Extract CSS rules relevant to a set of class names / id. */
function extractRelevantCSS(allCss, classNames, elementId) {
  const selectors = [...classNames, ...(elementId ? [`#${elementId}`] : [])];
  if (!selectors.length) return allCss.slice(0, 4000); // fallback: first 4KB
  const lines = allCss.split('\n');
  const relevant = [];
  let inBlock = false;
  let depth = 0;
  let currentSelector = '';
  for (const line of lines) {
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    if (!inBlock) {
      const isMatch = selectors.some(s => line.includes(s)) ||
        line.match(/^[^{]*\{/) && selectors.some(s => line.includes('.' + s) || line.includes('#' + s));
      if (opens > closes || (opens > 0 && isMatch)) {
        inBlock = true;
        currentSelector = line;
        relevant.push(line);
        depth = opens - closes;
        continue;
      }
    }
    if (inBlock) {
      relevant.push(line);
      depth += opens - closes;
      if (depth <= 0) { inBlock = false; depth = 0; }
    }
  }
  return relevant.join('\n') || allCss.slice(0, 4000);
}

/** Detect which edit mode to use based on message + context. */
function detectEditMode(message, selectedElementHtml) {
  if (STRUCTURAL_KEYWORDS.test(message)) return 'full';
  if (CSS_KEYWORDS.test(message) && !STRUCTURAL_KEYWORDS.test(message)) {
    return selectedElementHtml ? 'element-css' : 'css';
  }
  return selectedElementHtml ? 'element' : 'full';
}

app.post('/api/demo-apps/:runId/ai-edit', async (req, res) => {
  try {
    const { runId } = req.params;
    const { message, selectedElementHtml, selectedElementSelector, conversationHistory } = req.body;
    const appHtmlPath = path.join(DEMOS_DIR, runId, 'scratch-app/index.html');
    if (!fs.existsSync(appHtmlPath)) return res.status(404).json({ error: 'App HTML not found' });

    const currentHtml = fs.readFileSync(appHtmlPath, 'utf8');
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const mode = detectEditMode(message, selectedElementHtml);
    const styleBlocks = extractStyleBlocks(currentHtml);
    const allCss = styleBlocks.map(b => b.inner).join('\n');

    let systemPrompt, userContent, maxTokens, responseHandler;

    if (mode === 'css') {
      // Send only CSS — Claude returns only updated CSS
      systemPrompt = `You are editing the CSS of a Plaid demo app.
Design system: background #0d1117, accent #00A67E (teal), text #ffffff.
Respond with ONLY the raw updated CSS content — no <style> tags, no HTML, no explanation.`;
      userContent = `Request: ${message}\n\nCurrent CSS:\n${allCss}`;
      maxTokens = 4000;
      responseHandler = (text) => {
        const newHtml = spliceCSS(currentHtml, styleBlocks, text.trim());
        return { newHtml, valid: true };
      };

    } else if (mode === 'element-css') {
      // Send selected element + relevant CSS rules only
      const classNames = (selectedElementHtml.match(/class="([^"]+)"/g) || [])
        .flatMap(m => m.replace(/class="/, '').replace(/"$/, '').split(/\s+/));
      const idMatch = selectedElementHtml.match(/id="([^"]+)"/);
      const elementId = idMatch ? idMatch[1] : null;
      const relevantCss = extractRelevantCSS(allCss, classNames, elementId);

      systemPrompt = `You are editing CSS for a specific element in a Plaid demo app.
Design system: background #0d1117, accent #00A67E (teal), text #ffffff.
Respond with ONLY the complete updated CSS — no <style> tags, no HTML, no explanation.
Include ALL the original CSS rules plus your changes (do not drop unrelated rules).`;
      userContent = [
        `Selected element: ${selectedElementHtml.slice(0, 500)}`,
        selectedElementSelector ? `Selector: ${selectedElementSelector}` : '',
        `Request: ${message}`,
        `\nRelevant CSS:\n${relevantCss}`,
        `\nFull CSS (for reference — return the full updated version):\n${allCss}`,
      ].filter(Boolean).join('\n\n');
      maxTokens = 6000;
      responseHandler = (text) => {
        const newHtml = spliceCSS(currentHtml, styleBlocks, text.trim());
        return { newHtml, valid: true };
      };

    } else if (mode === 'element') {
      // Send element HTML + its CSS + minimal skeleton — Claude returns only the updated element outerHTML
      const classNames = (selectedElementHtml.match(/class="([^"]+)"/g) || [])
        .flatMap(m => m.replace(/class="/, '').replace(/"$/, '').split(/\s+/));
      const relevantCss = extractRelevantCSS(allCss, classNames, null);

      systemPrompt = `You are editing a specific HTML element in a Plaid demo app.
Design system: background #0d1117, accent #00A67E (teal), text #ffffff.
Respond with ONLY the updated outerHTML of the element — no surrounding tags, no explanation.
Preserve all data-testid attributes and event handlers (onclick etc).`;
      userContent = [
        `Element to edit:\n${selectedElementHtml}`,
        selectedElementSelector ? `Selector: ${selectedElementSelector}` : '',
        `Request: ${message}`,
        `\nRelevant CSS for context:\n${relevantCss}`,
      ].filter(Boolean).join('\n\n');
      maxTokens = 4000;
      responseHandler = (text) => {
        const updated = text.trim();
        // Replace the element in the full HTML by its outerHTML
        const escaped = selectedElementHtml.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const newHtml = currentHtml.replace(new RegExp(escaped.slice(0, 200)), updated);
        const valid = newHtml !== currentHtml;
        return { newHtml: valid ? newHtml : currentHtml, valid };
      };

    } else {
      // Full mode — send entire HTML
      systemPrompt = `You are an expert frontend developer editing a Plaid demo web application.
The app is a single-file HTML demo showing a Plaid product flow.
Respond with ONLY the complete updated HTML — no explanation, no markdown fences.
Design system: background #0d1117, accent #00A67E (teal), text #ffffff.
Preserve all data-testid attributes, goToStep, getCurrentStep, and step navigation.`;
      userContent = [
        selectedElementHtml ? `Selected element:\n${selectedElementHtml.slice(0, 1000)}` : '',
        selectedElementSelector ? `Selector: ${selectedElementSelector}` : '',
        `Request: ${message}`,
        `\nCurrent HTML:\n${currentHtml}`,
      ].filter(Boolean).join('\n\n');
      maxTokens = 16000;
      responseHandler = (text) => {
        const newHtml = text.trim();
        const valid = newHtml.includes('<html') || newHtml.includes('<!DOCTYPE') || newHtml.includes('<body');
        return { newHtml, valid };
      };
    }

    // Build message list (lightweight history only)
    const messages = [];
    if (Array.isArray(conversationHistory)) {
      for (const turn of conversationHistory) {
        if (turn.role && typeof turn.content === 'string' && turn.content.length < 500) {
          messages.push(turn);
        }
      }
    }
    messages.push({ role: 'user', content: userContent });

    // Use Haiku for css/element modes (fast, cheap) — Opus for full structural edits
    const model = (mode === 'full') ? 'claude-opus-4-6' : 'claude-haiku-4-5-20251001';
    console.log(`[AI Edit] mode=${mode} model=${model} tokens≈${Math.round(userContent.length / 4)} run=${runId}`);

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    });

    // Reject truncated responses before touching the file
    if (response.stop_reason === 'max_tokens') {
      return res.status(500).json({ error: `Response was truncated (hit max_tokens=${maxTokens}). File not modified. Try a more specific request or use element-pick to scope the change.` });
    }

    const { newHtml, valid } = responseHandler(response.content[0].text);

    if (!valid) {
      return res.status(500).json({ error: 'AI response could not be applied cleanly', mode, preview: response.content[0].text.slice(0, 300) });
    }

    // Backup before overwriting
    fs.writeFileSync(appHtmlPath + '.bak', currentHtml, 'utf8');
    fs.writeFileSync(appHtmlPath, newHtml, 'utf8');
    res.json({ ok: true, reply: `Done (${mode} mode) — changes written.` });
  } catch (err) {
    console.error('[AI Edit]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Timeline editor page ──────────────────────────────────────────────────────

app.get('/timeline', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'timeline.html'));
});

// ── GET /api/runs/:runId/timeline-data ────────────────────────────────────────
// Returns combined timeline data: step labels+narration, video timestamps,
// narration durations, and existing sync map.
app.get('/api/runs/:runId/timeline-data', (req, res) => {
  try {
    const dir = getRunDir(req.params.runId);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Run not found' });

    // 1. demo-script.json — step labels + narration
    const script = safeReadJson(path.join(dir, 'demo-script.json'));
    if (!script || !script.steps) {
      return res.status(404).json({ error: 'demo-script.json not found or has no steps' });
    }

    // 2. Video timestamps — prefer processed-step-timing.json, fall back to step-timing.json
    const processedTimingPath = path.join(dir, 'processed-step-timing.json');
    const rawTimingPath       = path.join(dir, 'step-timing.json');

    let timingData  = null;
    let timingSource = null;

    if (fs.existsSync(processedTimingPath)) {
      timingData   = safeReadJson(processedTimingPath);
      timingSource = 'processed';
    } else if (fs.existsSync(rawTimingPath)) {
      timingData   = safeReadJson(rawTimingPath);
      timingSource = 'raw';
    }

    // Normalise timing into [{id, recordingOffsetS, durationS}]
    // Format A (object): { steps: [{id, recordingOffsetS, durationS}] }
    // Format B (array):  [{step, recordingOffsetS}]
    let timingSteps = null;
    if (timingData) {
      if (Array.isArray(timingData)) {
        timingSteps = timingData.map(t => ({
          id:              t.step || t.id,
          recordingOffsetS: t.recordingOffsetS,
          durationS:       t.durationS || null,
        }));
      } else if (timingData.steps && Array.isArray(timingData.steps)) {
        timingSteps = timingData.steps.map(t => ({
          id:              t.id || t.step,
          recordingOffsetS: t.recordingOffsetS,
          durationS:       t.durationS || null,
        }));
      }
    }

    // Build a map from stepId → {videoStart, videoEnd}
    const timingMap = {};
    if (timingSteps) {
      // Infer durations: step i ends where step i+1 starts; last step uses durationS if present
      for (let i = 0; i < timingSteps.length; i++) {
        const cur  = timingSteps[i];
        const next = timingSteps[i + 1];
        const videoStart = cur.recordingOffsetS;
        let   videoEnd;
        if (cur.durationS != null) {
          videoEnd = videoStart + cur.durationS;
        } else if (next) {
          videoEnd = next.recordingOffsetS;
        } else {
          // Last step — try to get total duration from the recording file
          videoEnd = null;
        }
        timingMap[cur.id] = { videoStart, videoEnd };
      }
    }

    // Compute total video duration (use last step's end, or ffprobe the recording file)
    let videoDuration = null;
    const stepIds = script.steps.map(s => s.id);

    if (timingSteps && timingSteps.length > 0) {
      const lastTiming = timingSteps[timingSteps.length - 1];
      const lastStepId = lastTiming.id;
      const lastEntry  = timingMap[lastStepId];
      if (lastEntry && lastEntry.videoEnd != null) {
        videoDuration = lastEntry.videoEnd;
      } else {
        // Try ffprobe on the recording file
        const recFile = fs.existsSync(path.join(dir, 'recording-processed.webm'))
          ? path.join(dir, 'recording-processed.webm')
          : (fs.existsSync(path.join(dir, 'recording.webm')) ? path.join(dir, 'recording.webm') : null);
        if (recFile) {
          try {
            const dur = execSync(
              `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${recFile}"`,
              { encoding: 'utf8', timeout: 10000 }
            ).trim();
            videoDuration = parseFloat(dur) || null;
          } catch (_) { /* ffprobe unavailable */ }
        }
        // Fill in last step's videoEnd
        if (videoDuration != null && lastEntry) {
          lastEntry.videoEnd = videoDuration;
        }
      }
    }

    // 3. Narration durations — prefer voiceover-manifest.json, fall back to ffprobe
    const manifestPath = path.join(dir, 'voiceover-manifest.json');
    const manifest     = safeReadJson(manifestPath);
    const narrationMap = {}; // stepId → { durationS, startMs? }

    if (manifest && Array.isArray(manifest.clips)) {
      for (const clip of manifest.clips) {
        const id  = clip.stepId || clip.id;
        const dur = clip.durationMs != null ? clip.durationMs / 1000 : null;
        if (id && dur != null) {
          narrationMap[id] = { durationS: dur, startMs: clip.startMs || null };
        }
      }
    } else {
      // Fall back: ffprobe individual vo_*.mp3 files
      const audioDir = path.join(dir, 'audio');
      if (fs.existsSync(audioDir)) {
        const mp3Files = safeReaddir(audioDir).filter(f => /^vo_.*\.mp3$/i.test(f));
        for (const f of mp3Files) {
          // Extract step ID from filename: vo_{stepId}.mp3
          const m = f.match(/^vo_(.+)\.mp3$/i);
          if (!m) continue;
          const stepId = m[1];
          try {
            const durStr = execSync(
              `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${path.join(audioDir, f)}"`,
              { encoding: 'utf8', timeout: 8000 }
            ).trim();
            const dur = parseFloat(durStr);
            if (!isNaN(dur)) narrationMap[stepId] = { durationS: dur, startMs: null };
          } catch (_) { /* ignore */ }
        }
      }
    }

    // 4. Existing sync-map.json
    const syncMap = safeReadJson(path.join(dir, 'sync-map.json')) || { segments: [] };
    if (Array.isArray(syncMap)) {
      // Normalise legacy array format
    }

    // 5. Build output steps array
    const outSteps = script.steps.map(step => {
      const timing    = timingMap[step.id] || {};
      const narration = narrationMap[step.id] || {};

      // narrationOffset: from manifest startMs relative to step videoStart
      let narrationOffset = 0;
      if (narration.startMs != null && timing.videoStart != null) {
        narrationOffset = (narration.startMs / 1000) - timing.videoStart;
        narrationOffset = Math.max(0, narrationOffset);
      }

      return {
        id:              step.id,
        label:           step.label || step.id,
        narration:       step.narration || '',
        videoStart:      timing.videoStart   ?? null,
        videoEnd:        timing.videoEnd     ?? null,
        narrationDur:    narration.durationS ?? 0,
        narrationOffset,
      };
    });

    res.json({
      runId:         req.params.runId,
      videoDuration: videoDuration || null,
      timingSource:  timingSource || null,
      steps:         outSteps,
      syncMap:       Array.isArray(syncMap)
        ? { segments: syncMap }
        : (syncMap.segments ? syncMap : { segments: [] }),
    });
  } catch (err) {
    console.error('[timeline-data]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/runs/:runId/sync-map-update ─────────────────────────────────────
// Replaces all non-_autoGap manual segments in sync-map.json with the ones
// provided in the request body, then re-sorts by compStart.
app.post('/api/runs/:runId/sync-map-update', (req, res) => {
  try {
    const { segments } = req.body || {};
    if (!Array.isArray(segments)) {
      return res.status(400).json({ error: 'segments array is required' });
    }

    const dir       = getRunDir(req.params.runId);
    const syncPath  = path.join(dir, 'sync-map.json');

    // Load existing sync map (may be array or {segments:[...]})
    let existing = { segments: [] };
    if (fs.existsSync(syncPath)) {
      const raw = safeReadJson(syncPath);
      if (Array.isArray(raw)) {
        existing = { segments: raw };
      } else if (raw && Array.isArray(raw.segments)) {
        existing = raw;
      }
    }

    // Keep only _autoGap entries from the existing map
    const autoGapSegs = (existing.segments || []).filter(s => s._autoGap === true);

    // Validate incoming segments (basic sanity)
    for (const seg of segments) {
      if (seg.compStart == null || seg.compEnd == null || seg.compEnd <= seg.compStart) {
        return res.status(400).json({
          error: `Invalid segment: compStart=${seg.compStart} compEnd=${seg.compEnd}`,
        });
      }
    }

    // Merge and sort
    const merged = [...autoGapSegs, ...segments];
    merged.sort((a, b) => a.compStart - b.compStart);

    const out = {
      ...(existing._comment ? { _comment: existing._comment } : {}),
      segments: merged,
    };

    const tmp = syncPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
    fs.renameSync(tmp, syncPath);

    res.json({ ok: true, count: segments.length });
  } catch (err) {
    console.error('[sync-map-update]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────

app.listen(PORT, '::', () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
