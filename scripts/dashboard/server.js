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

// ── Pipeline state ────────────────────────────────────────────────────────────
let activeProcess = null;
let logBuffer = [];
const logClients = new Set();

const PIPELINE_STAGES = [
  'research', 'ingest', 'brand-extract', 'script', 'script-critique',
  /* 'plaid-link-capture', */ 'build', 'record', 'qa', 'figma-review', 'post-process',
  'voiceover', 'resync-audio', 'audio-qa', 'render', 'ppt', 'touchup',
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
  ['script-critique',     'demo-script.json'],       // critique updates script in-place; use same sentinel
  // ['plaid-link-capture',  'plaid-link-screens/manifest.json'],  // DISABLED
  ['build',               'scratch-app/index.html'],
  ['record',          'recording.webm'],
  ['qa',              'qa-report-1.json'],
  ['figma-review',    'figma-review.json'],
  ['post-process',    'recording-processed.webm'],
  ['voiceover',       'voiceover-manifest.json'],
  ['resync-audio',    'voiceover-manifest.json'],  // resync updates manifest in-place (adds resyncedAt)
  ['audio-qa',        'audio-qa-report.json'],
  ['render',          'demo-scratch.mp4'],
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
    // Check qa-frames first, then build-frames
    let filePath = path.join(dir, 'qa-frames', filename);
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

// ── Pipeline runner ───────────────────────────────────────────────────────────

app.get('/api/pipeline/stages', (req, res) => {
  res.json({ stages: PIPELINE_STAGES });
});

app.post('/api/pipeline/run', (req, res) => {
  try {
    if (activeProcess !== null) {
      return res.status(409).json({ error: 'Already running' });
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

// ── Start server ──────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
