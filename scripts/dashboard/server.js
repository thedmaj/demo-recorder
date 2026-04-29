'use strict';

require('dotenv').config({ override: true });

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const AdmZip = require('adm-zip');
const chokidar = require('chokidar');
const { loadTimingContract } = require('../timing-contract');
const { processedToCompMs } = require('../sync-map-utils');
const { deriveStepKind } = require('../scratch/utils/step-kind');
const { readRunManifest: readRunManifestSafe, writeRunManifest: writeRunManifestSafe } = require('../scratch/utils/run-io');
const { resolveIdentity: resolveDashIdentity } = require('../scratch/utils/identity');

// ── Paths ────────────────────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const INPUTS_DIR = path.join(PROJECT_ROOT, 'inputs');
const OUT_DIR = path.join(PROJECT_ROOT, 'out');
const DEMOS_DIR = path.join(OUT_DIR, 'demos');
const SLIDE_LIBRARY_DIR = path.join(OUT_DIR, 'slide-library');
const SLIDE_LIBRARY_INDEX_FILE = path.join(SLIDE_LIBRARY_DIR, 'index.json');
const SLIDE_LIBRARY_SLIDES_DIR = path.join(SLIDE_LIBRARY_DIR, 'slides');
const DEMO_APP_NAMES_FILE = path.join(DEMOS_DIR, '.dashboard-demo-names.json');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

const {
  parseFrontmatter,
  computeStaleness,
  extractFactsFromMarkdown,
  countDraftFacts,
  applyFactOperation,
  parseFactLine,
} = require(path.join(__dirname, '../scratch/utils/markdown-knowledge.js'));
const pipelineStageState = require(path.join(__dirname, '../scratch/utils/stage-state.js'));

const PORT = process.env.PORT || 4040;

// ── ENV whitelist ─────────────────────────────────────────────────────────────
const ENV_WHITELIST = new Set([
  // Pipeline behavior (existing)
  'SCRATCH_AUTO_APPROVE', 'MANUAL_RECORD', 'FIGMA_REVIEW',
  'MAX_REFINEMENT_ITERATIONS', 'RECORDING_FPS', 'QA_PASS_THRESHOLD', 'BUILD_FIX_MODE',
  'RECORD_TRANSITION_SAFE_TIMING', 'STEP_TRANSITION_SETTLE_MS', 'POST_LINK_STEP_BOUNDARY_GUARD_MS',
  // Plaid SDK (existing)
  'PLAID_ENV', 'PLAID_LINK_LIVE', 'PLAID_LINK_CUSTOMIZATION', 'PLAID_LAYER_TEMPLATE_ID',
  // Voice / audio (existing)
  'ELEVENLABS_VOICE_ID', 'ELEVENLABS_OUTPUT_FORMAT',
  // Build strategy (2026-04 additions — replace ad-hoc .env edits)
  'PIPELINE_WITH_SLIDES', 'BUILD_SLIDES_STRATEGY', 'RESEARCH_MODE', 'LAYERED_BUILD_ENABLED',
  // QA & guardrails
  'PLAID_LINK_QA_MODE', 'BUILD_QA_PLAID_MODE', 'BUILD_QA_DETERMINISTIC_GATE',
  'CLAIM_CHECK_STRICT', 'PRODUCT_KB_MIN_CONFIDENCE',
  // Pipeline polish toggles
  'TOUCHUP_ENABLED', 'SKIP_BRAND_SITE_SCREENSHOT', 'AUTO_GAP_PRESERVE_MANUAL',
  'EMBED_SYNC_AUTO_APPLY', 'AI_SUGGEST_AUTO_APPLY', 'MOBILE_VISUAL_ENABLED', 'VERBOSE',
  // Dashboard meta
  'DASHBOARD_WRITE',
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
/** Run ID for the dashboard-spawned orchestrator (for Builds list live badge / current stage). */
let activePipelineRunId = null;

function isPipelineChildRunning() {
  if (activeProcess === null) return false;
  if (activeProcess.exitCode !== null) return false;
  return true;
}

/** Merge isRunning + currentStage onto the active run when a pipeline child is alive. */
function annotateRunsWithLivePipeline(runs) {
  if (!Array.isArray(runs) || !isPipelineChildRunning() || !activePipelineRunId) return runs;
  return runs.map((r) => {
    if (r.runId !== activePipelineRunId) return r;
    const completed = getCompletedStages(r.runId);
    const { resumeFromStage } = computePipelineResume(completed);
    const currentStage = resumeFromStage || PIPELINE_STAGES[0];
    return { ...r, isRunning: true, currentStage };
  });
}
/** @type {{ text: string, stream: string }[]} */
let logBuffer = [];
const logClients = new Set();
const LOG_BUFFER_MAX = parseInt(process.env.DASHBOARD_LOG_BUFFER_MAX || '5000', 10);
const PIPELINE_CONSOLE_LOG = 'pipeline-console.log';

/** Incomplete line tails from spawned orchestrator (pipe chunk boundaries). */
let pipelineOutRem = '';
let pipelineErrRem = '';
/** Append session log under the active run dir (same text as terminal would show). */
let pipelineDiskLogStream = null;

// Keep in lockstep with scripts/scratch/orchestrator.js STAGES (order matters for resume / --to).
const PIPELINE_STAGES = [
  'research', 'ingest', 'script', 'brand-extract', 'script-critique',
  'embed-script-validate',
  /* 'plaid-link-capture', */ 'build', 'plaid-link-qa', 'build-qa',
  'post-slides', 'post-panels',
  'record', 'qa', 'figma-review', 'post-process',
  'voiceover', 'coverage-check', 'auto-gap', 'resync-audio', 'embed-sync', 'audio-qa',
  'ai-suggest-overlays', 'render', 'ppt', 'touchup',
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

function readDemoAppNames() {
  const parsed = safeReadJson(DEMO_APP_NAMES_FILE);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

function writeDemoAppNames(map) {
  fs.mkdirSync(DEMOS_DIR, { recursive: true });
  const tmpPath = DEMO_APP_NAMES_FILE + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(map || {}, null, 2), 'utf8');
  fs.renameSync(tmpPath, DEMO_APP_NAMES_FILE);
}

function resolveDemoDisplayName(runId, namesMap) {
  const raw = namesMap && typeof namesMap === 'object' ? namesMap[runId] : null;
  const v = typeof raw === 'string' ? raw.trim() : '';
  return v || runId;
}

function getRunDir(runId) {
  const resolved = path.resolve(DEMOS_DIR, runId);
  if (!resolved.startsWith(DEMOS_DIR + path.sep) && resolved !== DEMOS_DIR) {
    throw new Error('Invalid runId: path escapes DEMOS_DIR');
  }
  return resolved;
}

function ensureSlideLibraryDirs() {
  fs.mkdirSync(SLIDE_LIBRARY_SLIDES_DIR, { recursive: true });
}

function readSlideLibraryIndex() {
  ensureSlideLibraryDirs();
  const parsed = safeReadJson(SLIDE_LIBRARY_INDEX_FILE);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { version: 1, slides: [] };
  }
  const slides = Array.isArray(parsed.slides) ? parsed.slides : [];
  return {
    version: Number(parsed.version || 1),
    slides,
  };
}

function writeSlideLibraryIndex(index) {
  ensureSlideLibraryDirs();
  const tmp = SLIDE_LIBRARY_INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
  fs.renameSync(tmp, SLIDE_LIBRARY_INDEX_FILE);
}

function sanitizeSlideLibraryName(input) {
  const text = String(input || '').trim().replace(/\s+/g, ' ');
  return text.slice(0, 120);
}

function slugifyForId(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'slide';
}

function makeUniqueLibrarySlideId(index, name) {
  const base = slugifyForId(name);
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  let candidate = `${base}-${ts}`;
  const used = new Set((index.slides || []).map(s => String(s.id || '')));
  let n = 1;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${base}-${ts}-${n}`;
  }
  return candidate;
}

function makeUniqueStepId(existingSteps, preferred) {
  const used = new Set((existingSteps || []).map(s => String(s && s.id || '')));
  let candidate = slugifyForId(preferred || 'library-slide');
  if (!candidate) candidate = 'library-slide';
  if (!used.has(candidate)) return candidate;
  let n = 2;
  while (used.has(`${candidate}-${n}`)) n += 1;
  return `${candidate}-${n}`;
}

function buildStandaloneSlideHtml({ title, css, stepHtml }) {
  const safeTitle = String(title || 'Slide Library Entry').replace(/[<>]/g, '');
  const safeCss = String(css || '');
  const safeStepHtml = String(stepHtml || '');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${safeTitle}</title>`,
    '  <style>',
    safeCss,
    '  .step { display: block !important; min-height: 100vh; }',
    '  </style>',
    '</head>',
    '<body>',
    safeStepHtml,
    '</body>',
    '</html>',
  ].join('\n');
}

function extractFirstStepIdFromHtml(html) {
  const m = String(html || '').match(/data-testid=["']step-([^"']+)["']/i);
  return m ? String(m[1] || '').trim() : '';
}

function extractInlineStylesFromHtml(html) {
  const styles = [];
  const source = String(html || '');
  for (const m of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = String(m[1] || '').trim();
    if (css) styles.push(css);
  }
  return styles;
}

/** Read UTF-8 text from end of file (avoids loading huge pipeline-console.log into memory). */
function readTextTailFromFile(absPath, maxBytes) {
  const stat = fs.statSync(absPath);
  if (stat.size === 0) return '';
  if (stat.size <= maxBytes) return fs.readFileSync(absPath, 'utf8');
  const fd = fs.openSync(absPath, 'r');
  try {
    const readLen = Math.min(maxBytes, stat.size);
    const buf = Buffer.allocUnsafe(readLen);
    fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
    let s = buf.toString('utf8');
    const firstNl = s.indexOf('\n');
    if (firstNl !== -1) s = s.slice(firstNl + 1);
    return s;
  } finally {
    fs.closeSync(fd);
  }
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

function parseEnvFileSimple(filePath) {
  const out = {};
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch (_) {}
  return out;
}

function addDirectoryToZip(zip, sourceDir, zipPrefix) {
  const entries = safeReaddir(sourceDir);
  for (const name of entries) {
    const abs = path.join(sourceDir, name);
    let stat = null;
    try { stat = fs.statSync(abs); } catch (_) { stat = null; }
    if (!stat) continue;
    const zipPath = path.posix.join(zipPrefix, name);
    if (stat.isDirectory()) addDirectoryToZip(zip, abs, zipPath);
    else if (stat.isFile()) zip.addLocalFile(abs, path.posix.dirname(zipPath), path.posix.basename(zipPath));
  }
}

function parseMaybeJson(value, fallback = null) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function localizeBrandfetchLogosInHtml(html, opts = {}) {
  const strict = !!opts.strict;
  const logoUrlMatches = String(html || '').match(/https:\/\/cdn\.brandfetch\.io\/[^\s"'<>]+/gi) || [];
  const uniqueUrls = [...new Set(logoUrlMatches)];
  if (!uniqueUrls.length) return { html: String(html || ''), files: [], failures: [] };

  const files = [];
  const failures = [];
  let nextHtml = String(html || '');
  let index = 0;

  for (const url of uniqueUrls) {
    index += 1;
    try {
      const res = await fetchWithTimeout(url, 12000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      const u = new URL(url);
      const pathExt = path.extname(u.pathname || '').toLowerCase();
      const extFromType =
        contentType.includes('svg') ? '.svg' :
        contentType.includes('png') ? '.png' :
        contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg' :
        pathExt || '.bin';
      const relPath = `frontend/brand-assets/logo-${index}${extFromType}`;
      const arrayBuf = await res.arrayBuffer();
      files.push({ relPath, buffer: Buffer.from(arrayBuf) });
      const escaped = new RegExp(escapeRegExp(url), 'g');
      nextHtml = nextHtml.replace(escaped, `./brand-assets/logo-${index}${extFromType}`);
    } catch (err) {
      failures.push({ url, error: err && err.message ? err.message : String(err) });
      if (strict) {
        throw new Error(`Strict portable mode could not download Brandfetch logo "${url}": ${err.message || err}`);
      }
    }
  }
  return { html: nextHtml, files, failures };
}

async function buildRunAppPackage(runId) {
  const strictPortable = true;
  const runDir = getRunDir(runId);
  const scratchDir = path.join(runDir, 'scratch-app');
  if (!fs.existsSync(scratchDir)) {
    throw new Error(`scratch-app not found for run ${runId}. Complete build stage first.`);
  }

  const zip = new AdmZip();
  const root = `${runId}-app-package`;
  const addText = (relPath, text) => {
    zip.addFile(path.posix.join(root, relPath), Buffer.from(String(text || ''), 'utf8'));
  };
  const addFile = (sourceAbs, targetRel) => {
    if (!fs.existsSync(sourceAbs)) return;
    zip.addLocalFile(
      sourceAbs,
      path.posix.join(root, path.posix.dirname(targetRel)),
      path.posix.basename(targetRel)
    );
  };

  // Frontend: generated demo app.
  addDirectoryToZip(zip, scratchDir, path.posix.join(root, 'frontend'));
  const sourceHtmlPath = path.join(scratchDir, 'index.html');
  if (fs.existsSync(sourceHtmlPath)) {
    const sourceHtml = fs.readFileSync(sourceHtmlPath, 'utf8');
    const localized = await localizeBrandfetchLogosInHtml(sourceHtml, { strict: strictPortable });
    try { zip.deleteFile(path.posix.join(root, 'frontend/index.html')); } catch (_) {}
    addText('frontend/index.html', localized.html);
    for (const f of localized.files) {
      zip.addFile(path.posix.join(root, f.relPath), f.buffer);
    }
    if (strictPortable) {
      const stillRemoteBrandfetch = /https:\/\/cdn\.brandfetch\.io\//i.test(localized.html);
      if (stillRemoteBrandfetch) {
        throw new Error('Strict portable mode failed: remote Brandfetch logo URLs remain in frontend/index.html');
      }
    }
  }
  // Bundle fallback assets used by app-server so package is offline-friendly.
  const assetsDir = path.join(PROJECT_ROOT, 'assets');
  if (fs.existsSync(assetsDir)) {
    addDirectoryToZip(zip, assetsDir, path.posix.join(root, 'assets'));
  } else if (strictPortable) {
    throw new Error('Strict portable mode requires local assets/ directory, but it was not found.');
  }

  // Core backend/server implementation needed to run the app locally.
  const utilsRoot = path.join(PROJECT_ROOT, 'scripts', 'scratch', 'utils');
  addFile(path.join(utilsRoot, 'app-server.js'), 'scripts/scratch/utils/app-server.js');
  addFile(path.join(utilsRoot, 'plaid-backend.js'), 'scripts/scratch/utils/plaid-backend.js');
  addFile(path.join(utilsRoot, 'link-mode', 'index.js'), 'scripts/scratch/utils/link-mode/index.js');
  addFile(path.join(utilsRoot, 'link-mode', 'modal.js'), 'scripts/scratch/utils/link-mode/modal.js');
  addFile(path.join(utilsRoot, 'link-mode', 'embedded.js'), 'scripts/scratch/utils/link-mode/embedded.js');

  // Include run metadata used by app-server/plaid-backend heuristics.
  addFile(path.join(runDir, 'demo-script.json'), 'demo-script.json');
  addFile(path.join(runDir, 'pipeline-run-context.json'), 'pipeline-run-context.json');

  const launcher = `'use strict';
const path = require('path');
const fs = require('fs');
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\\r?\\n/);
  for (const line of lines) {
    const raw = String(line || '').trim();
    if (!raw || raw.startsWith('#')) continue;
    const idx = raw.indexOf('=');
    if (idx <= 0) continue;
    const key = raw.slice(0, idx).trim();
    let val = raw.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) process.env[key] = val;
  }
}
process.env.PIPELINE_RUN_DIR = process.env.PIPELINE_RUN_DIR || __dirname;
loadDotEnv(path.join(__dirname, '.env'));
const strictPortable = ${strictPortable ? 'true' : 'false'};
const requiredEnv = ['PLAID_LINK_LIVE', 'PLAID_ENV', 'PLAID_CLIENT_ID', 'PLAID_SANDBOX_SECRET'];
if (strictPortable) requiredEnv.push('PORTABLE_MODE');
const missingEnv = requiredEnv.filter((k) => !String(process.env[k] || '').trim());
if (missingEnv.length) {
  console.error('[App Package] Missing required environment variables:', missingEnv.join(', '));
  console.error('[App Package] Edit .env and set values before starting.');
  process.exit(1);
}
const { startServer } = require('./scripts/scratch/utils/app-server');
const port = Number(process.env.PORT || 3737);
startServer(port, path.join(__dirname, 'frontend'))
  .then(({ url }) => console.log('[App Package] Server running at ' + url))
  .catch((err) => {
    console.error('[App Package] Failed to start server:', err && err.message ? err.message : err);
    process.exit(1);
  });
`;
  addText('server.js', launcher);

  const pkgJson = {
    name: `${runId}-demo-app-package`,
    private: true,
    version: '1.0.0',
    description: 'Portable Plaid demo app package',
    scripts: {
      start: 'node server.js',
    },
  };
  addText('package.json', JSON.stringify(pkgJson, null, 2));

  const envSource = parseEnvFileSimple(ENV_FILE);
  const envKeys = [
    'PLAID_LINK_LIVE',
    'PLAID_ENV',
    'PLAID_CLIENT_ID',
    'PLAID_SANDBOX_SECRET',
    'CRA_CLIENT_ID',
    'CRA_SECRET',
    'PLAID_LINK_CUSTOMIZATION',
    'PLAID_LAYER_TEMPLATE_ID',
    'PORT',
    'PORTABLE_MODE',
  ];
  const envPairs = {};
  for (const k of envKeys) {
    envPairs[k] = Object.prototype.hasOwnProperty.call(envSource, k) ? String(envSource[k] || '') : '';
  }
  if (strictPortable) envPairs.PORTABLE_MODE = 'strict';
  const envWithDefaults = envKeys.map((k) => `${k}=${envPairs[k] || ''}`).join('\n') + '\n';
  addText('.env', envWithDefaults);

  const readme = `# Demo App Package (${runId})

This package contains only the files needed to run this generated demo app.
Mode: **strict-portable**

## Included

- \`frontend/\`: generated demo app UI (scratch app)
- \`scripts/scratch/utils/app-server.js\`: static/API server
- \`scripts/scratch/utils/plaid-backend.js\`: Plaid API backend routes
- \`scripts/scratch/utils/link-mode/\`: Plaid link mode adapters
- \`assets/\`: bundled local fallback assets for offline logo rendering
- \`.env\`: environment file copied into the package (replace values as needed)
- \`server.js\`: package launcher
- \`demo-script.json\`: run metadata for link mode heuristics

## Requirements

- Node.js 18+ (for built-in \`fetch\`)

## Run

1. Install Node via Homebrew:
   - \`brew install node\`
2. Open \`.env\` and replace credentials/variables for your target environment.
3. Start:
   - \`node server.js\`
4. Open:
   - [http://localhost:3737](http://localhost:3737)

## Notes

- \`PLAID_LINK_LIVE\` should be \`true\` for live Plaid flows.
- If port 3737 is busy, set \`PORT=xxxx\` in \`.env\`.
- Brandfetch logos are localized into \`frontend/brand-assets/\` during packaging for offline portability.
- In strict-portable mode, package generation fails if remote Brandfetch URLs cannot be localized.
`;
  addText('README.md', readme);

  return zip;
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

function allocateDashboardRunDir() {
  fs.mkdirSync(DEMOS_DIR, { recursive: true });
  const today = new Date().toISOString().split('T')[0];
  const prefix = `${today}-dashboard-run-v`;
  const nums = safeReaddir(DEMOS_DIR)
    .filter((name) => name.startsWith(prefix))
    .map((name) => parseInt(name.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  const runId = `${prefix}${next}`;
  const runDir = path.join(DEMOS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  return { runId, runDir };
}

function normalizeCloneCompanyName(input) {
  const value = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  return value || '';
}

function normalizeCloneWebsite(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function touchClonedRunIdentity(runDir, runId, sourceRunId) {
  const nowIso = new Date().toISOString();
  const manifestPath = path.join(runDir, 'run-manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const next = {
          ...parsed,
          runId,
          runDir,
          updatedAt: nowIso,
          clonedFromRunId: sourceRunId,
        };
        if (!next.createdAt || typeof next.createdAt !== 'string') next.createdAt = nowIso;
        fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2), 'utf8');
      }
    } catch (_) {
      // best-effort clone metadata update
    }
  }

  const contextPath = path.join(runDir, 'pipeline-run-context.json');
  if (fs.existsSync(contextPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
      const existingRun = parsed && parsed.run && typeof parsed.run === 'object' ? parsed.run : {};
      const next = {
        ...(parsed && typeof parsed === 'object' ? parsed : {}),
        run: {
          ...existingRun,
          runId,
          clonedFromRunId: sourceRunId,
        },
        updatedAt: nowIso,
      };
      fs.writeFileSync(contextPath, JSON.stringify(next, null, 2), 'utf8');
    } catch (_) {
      // best-effort clone metadata update
    }
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

function getRunScriptSummary(runId) {
  const dir = path.join(DEMOS_DIR, runId);
  const script = safeReadJson(path.join(dir, 'demo-script.json'));
  if (!script || typeof script !== 'object') return null;
  const persona = script.persona && typeof script.persona === 'object' ? script.persona : {};
  const personaLabel = [persona.name, persona.role].filter(Boolean).join(' · ');
  return {
    product: script.product || '',
    company: persona.company || '',
    persona: personaLabel,
  };
}

/**
 * Return normalized Plaid Link mode for the run. Reads `demo-script.json`
 * first, then falls back to `pipeline-run-context.json`. Returns one of
 * 'embedded' | 'modal' | null.
 */
function getRunPlaidLinkMode(runId) {
  const dir = path.join(DEMOS_DIR, runId);
  const raw = (() => {
    const script = safeReadJson(path.join(dir, 'demo-script.json'));
    if (script && typeof script === 'object' && typeof script.plaidLinkMode === 'string') return script.plaidLinkMode;
    const ctx = safeReadJson(path.join(dir, 'pipeline-run-context.json'));
    if (ctx && typeof ctx === 'object') {
      if (typeof ctx.plaidLinkMode === 'string') return ctx.plaidLinkMode;
      if (ctx.linkTokenCreate && typeof ctx.linkTokenCreate.plaidLinkMode === 'string') return ctx.linkTokenCreate.plaidLinkMode;
    }
    return '';
  })();
  const norm = String(raw || '').trim().toLowerCase();
  if (norm === 'embedded') return 'embedded';
  if (norm === 'modal') return 'modal';
  return null;
}

function getRunOwnerFromManifest(runId) {
  const dir = path.join(DEMOS_DIR, runId);
  const manifest = safeReadJson(path.join(dir, 'run-manifest.json'));
  if (!manifest || typeof manifest !== 'object') return null;
  if (manifest.owner && typeof manifest.owner === 'object') {
    const login = typeof manifest.owner.login === 'string' ? manifest.owner.login : '';
    if (login) return { login, name: manifest.owner.name || login };
  }
  return null;
}

// Stage → indicator artifact (ordered by pipeline sequence; paths are under the run dir)
const STAGE_ARTIFACTS = [
  ['research',        'research-notes.md'],
  ['ingest',          'product-context.json'],
  ['script',          'demo-script.json'],
  ['brand-extract',   'brand-extract.json'],
  ['script-critique',       'script-critique.json'],
  ['embed-script-validate', 'script-validate-report.json'],
  // ['plaid-link-capture',  'plaid-link-screens/manifest.json'],  // DISABLED
  ['build',               'scratch-app/index.html'],
  ['plaid-link-qa',       'plaid-link-qa.json'],
  ['build-qa',            'build-qa-diagnostics.json'],
  ['post-slides',         'post-slides-report.json'],
  ['post-panels',         'post-panels-report.json'],
  ['record',          'recording.webm'],
  ['qa',              'qa-report-1.json'],
  ['figma-review',    'figma-review.json'],
  ['post-process',    'recording-processed.webm'],
  ['voiceover',       'voiceover-manifest.json'],
  ['coverage-check',  'coverage-report.json'],
  ['auto-gap',        'auto-gap-report.json'],
  ['resync-audio',    'voiceover-manifest.json'],  // manifest resyncedAt + timing-contract.json comp windows refreshed for governor
  ['embed-sync',      'embed-sync-report.json'],
  ['audio-qa',              'audio-qa-report.json'],
  ['ai-suggest-overlays',   'overlay-suggestions.json'],
  ['render',                'demo-scratch.mp4'],
  ['ppt',             'demo-summary.pptx'],
  ['touchup',         'touchup-complete.json'],
];

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

/**
 * Next stage to run, using canonical PIPELINE_STAGES order (not completion order in pipeline-progress.json).
 * Ignores ad-hoc stage names not in PIPELINE_STAGES (e.g. claim-check).
 */
function computePipelineResume(completedStages) {
  const plan = PIPELINE_STAGES;
  const set = new Set(completedStages || []);
  let lastIdx = -1;
  for (let i = 0; i < plan.length; i++) {
    if (set.has(plan[i])) lastIdx = i;
  }
  const lastCompletedStage = lastIdx >= 0 ? plan[lastIdx] : null;
  let resumeFromStage = null;
  if (lastIdx === -1) resumeFromStage = plan[0] || null;
  else if (lastIdx < plan.length - 1) resumeFromStage = plan[lastIdx + 1];
  return { lastCompletedStage, resumeFromStage };
}

// QA report naming has evolved across pipeline versions:
//   - qa-report-N.json                       (legacy numeric)
//   - qa-report-app-N.json                   (build-qa per-app-iteration)
//   - qa-report-slides-N.json                (post-slides per-iteration)
//   - qa-report-build.json                   (build-qa final)
//   - qa-report-build-iterN.json             (build-qa per-iteration)
//   - qa-report-build-fix-iterN.json         (build-qa post-touchup)
//
// The dashboard wants "the most relevant QA report" to surface on the
// Storyboard tab. Rather than encode a category preference (which keeps
// drifting as the pipeline evolves), accept all qa-report-*.json files
// and pick the one with the most recent mtime. That naturally surfaces
// the latest iteration regardless of which stage produced it.
function getLatestQaReport(runId) {
  const dir = path.join(DEMOS_DIR, runId);
  const files = safeReaddir(dir).filter((f) => /^qa-report-.+\.json$/.test(f));
  if (files.length === 0) return null;
  let latestPath = null;
  let latestMtime = -Infinity;
  for (const f of files) {
    const abs = path.join(dir, f);
    try {
      const st = fs.statSync(abs);
      if (st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latestPath = abs;
      }
    } catch (_) { /* skip unreadable entries */ }
  }
  if (!latestPath) return null;
  return safeReadJson(latestPath);
}

function closePipelineDiskLog() {
  if (pipelineDiskLogStream) {
    try {
      pipelineDiskLogStream.end();
    } catch (_) {
      /* ignore */
    }
    pipelineDiskLogStream = null;
  }
}

/**
 * @param {string} runDir
 * @param {string[]} orchestratorArgs argv after 'node'
 */
function openPipelineDiskLog(runDir, orchestratorArgs) {
  closePipelineDiskLog();
  try {
    const p = path.join(runDir, PIPELINE_CONSOLE_LOG);
    pipelineDiskLogStream = fs.createWriteStream(p, { flags: 'a' });
    const cmd = ['node', ...(orchestratorArgs || [])].join(' ');
    const banner =
      `\n${'='.repeat(72)}\n` +
      `[${new Date().toISOString()}] Dashboard pipeline session\n` +
      `CMD: ${cmd}\n` +
      `RUN_DIR: ${runDir}\n` +
      `${'='.repeat(72)}\n`;
    pipelineDiskLogStream.write(banner);
  } catch (_) {
    pipelineDiskLogStream = null;
  }
}

/**
 * Push one log line to buffer, SSE clients, optional parent terminal mirror, and disk log.
 * @param {string} line
 * @param {{ stream?: string, fromChild?: boolean }} [opts]
 *   stream: 'stdout' | 'stderr' | 'dashboard'
 *   fromChild: when true, mirror to the dashboard server's stdout/stderr (CLI parity).
 */
function broadcastLog(line, opts = {}) {
  const stream = opts.stream || 'dashboard';
  const fromChild = !!opts.fromChild;
  const at = new Date().toISOString();
  const entry = { text: line, stream, at };
  logBuffer.push(entry);
  while (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  const ssePayload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of logClients) {
    try {
      res.write(ssePayload);
    } catch (_) {
      logClients.delete(res);
    }
  }
  if (fromChild && process.env.DASHBOARD_MIRROR_PIPELINE_LOG !== '0') {
    const out = line + '\n';
    if (stream === 'stderr') process.stderr.write(out);
    else process.stdout.write(out);
  }
  if (pipelineDiskLogStream) {
    try {
      const pre = stream === 'dashboard' ? '[dashboard] ' : '';
      pipelineDiskLogStream.write(`[${at}] ${pre}${line}\n`);
    } catch (_) {
      /* ignore */
    }
  }
}

/** Parse one line from pipeline-console.log when written with [ISO] prefix (see broadcastLog). */
function parsePipelineConsoleLogLine(text) {
  const m = text.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s(.*)$/);
  if (m) return { text: m[2], stream: 'stdout', at: m[1] };
  return { text, stream: 'stdout' };
}

/**
 * Reassemble orchestrator stdout/stderr into full lines (matches TTY line breaks).
 */
function flushPipelineStreamChunk(chunk, isStderr) {
  let rem = isStderr ? pipelineErrRem : pipelineOutRem;
  const str = rem + chunk.toString('utf8');
  const lines = str.split(/\r?\n/);
  const nextRem = lines.pop();
  if (isStderr) pipelineErrRem = nextRem;
  else pipelineOutRem = nextRem;
  const stream = isStderr ? 'stderr' : 'stdout';
  for (const line of lines) {
    broadcastLog(line, { fromChild: true, stream });
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

// Slide library upload + AI edit accept large JSON bodies (base64-encoded
// images and full slide HTML). We register a per-route 50 MB JSON parser
// for those endpoints below, but Express runs middleware in registration
// order — so the GLOBAL `express.json()` (default 100 KB limit) intercepts
// and rejects the request before the per-route parser runs. To fix that,
// the global parser SKIPS those large-body routes; their dedicated
// `slideLibraryUploadJson` parser takes over and applies the 50 MB cap.
const _globalJsonParser = express.json();
const LARGE_BODY_ROUTE_RE = /^\/api\/slide-library\/(?:upload|slides\/[^/]+\/(?:ai-edit|rename))(?:\/|$)/;
app.use((req, res, next) => {
  if (LARGE_BODY_ROUTE_RE.test(req.path)) return next();
  return _globalJsonParser(req, res, next);
});
app.use('/api/slide-library', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Plaid Layer API (for demo-app-preview — app fetches from same origin)
if (process.env.PLAID_LINK_LIVE === 'true') {
  let _plaidLayer = null;
  const getPlaidLayer = () => { if (!_plaidLayer) _plaidLayer = require('../scratch/utils/plaid-backend'); return _plaidLayer; };
  app.post('/api/create-session-token', async (req, res) => {
    try { res.json(await getPlaidLayer().createSessionToken(req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/user-account-session-get', async (req, res) => {
    try { res.json(await getPlaidLayer().userAccountSessionGet(req.body.public_token)); } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

// Static assets
app.use('/static', express.static(path.join(__dirname, 'public')));

// Root → index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Run listing routes ────────────────────────────────────────────────────────

let _runsCache = null;
let _runsCacheAt = 0;
const RUNS_CACHE_TTL = 2000; // ms — burst-safe; invalidated by FS watch events too

function invalidateRunsCache() { _runsCache = null; }

function readRunBuildModeInfo(runId) {
  try {
    const manifestPath = path.join(DEMOS_DIR, runId, 'run-manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const buildMode = typeof parsed.buildMode === 'string' ? parsed.buildMode : null;
    if (!buildMode) return null;
    return {
      buildMode,
      buildModeSource: typeof parsed.buildModeSource === 'string' ? parsed.buildModeSource : null,
      label: buildMode === 'app+slides' ? 'App + Slides' : 'App-only',
    };
  } catch (_) {
    return null;
  }
}

function buildRunsList() {
  const namesMap = readDemoAppNames();
  const dirs = safeReaddir(DEMOS_DIR)
    .filter(name => {
      try { return fs.statSync(path.join(DEMOS_DIR, name)).isDirectory(); } catch (_) { return false; }
    })
    .sort()
    .reverse();

  return dirs.map(runId => {
    const artifacts = getRunArtifacts(runId);
    const qa = getLatestQaReport(runId);
    const completedStages = getCompletedStages(runId);
    const script = getRunScriptSummary(runId);
    const buildModeInfo = readRunBuildModeInfo(runId);
    return {
      runId,
      displayName: resolveDemoDisplayName(runId, namesMap),
      artifacts,
      qaScore: qa ? qa.overallScore : null,
      completedStages,
      script,
      buildMode: buildModeInfo ? buildModeInfo.buildMode : null,
      buildModeLabel: buildModeInfo ? buildModeInfo.label : null,
      buildModeSource: buildModeInfo ? buildModeInfo.buildModeSource : null,
    };
  });
}

app.get('/api/runs', (req, res) => {
  try {
    const now = Date.now();
    if (!_runsCache || now - _runsCacheAt > RUNS_CACHE_TTL) {
      _runsCache = buildRunsList();
      _runsCacheAt = now;
    }
    res.json({ runs: annotateRunsWithLivePipeline(_runsCache) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/slide-library', (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const index = readSlideLibraryIndex();
    let slides = Array.isArray(index.slides) ? index.slides.slice() : [];
    slides.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    if (q) {
      slides = slides.filter((slide) => {
        const haystack = [
          slide.name,
          slide.sourceRunId,
          slide.sourceStepId,
          slide.sceneType,
          ...(Array.isArray(slide.tags) ? slide.tags : []),
        ].map(v => String(v || '').toLowerCase()).join(' ');
        return haystack.includes(q);
      });
    }
    res.json({ slides });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/slide-library/slides/:slideId/html', (req, res) => {
  try {
    const slideId = String(req.params.slideId || '').trim();
    if (!slideId) return res.status(400).send('slideId required');
    const index = readSlideLibraryIndex();
    const slide = (index.slides || []).find(s => s && s.id === slideId);
    if (!slide || !slide.htmlPath) return res.status(404).send('Slide not found');
    const htmlAbs = path.resolve(PROJECT_ROOT, slide.htmlPath);
    if (!htmlAbs.startsWith(SLIDE_LIBRARY_DIR + path.sep) || !fs.existsSync(htmlAbs)) {
      return res.status(404).send('Slide HTML not found');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fs.readFileSync(htmlAbs, 'utf8'));
  } catch (err) {
    res.status(500).send(err.message || 'Unknown error');
  }
});

// ── Slide Templates subtab support ──────────────────────────────────────────
//
// The "Slide Templates" subtab under Storyboard exposes the same slide
// library that the storyboard's `+ Insert library slide` modal uses, but
// with three new capabilities:
//
//   1. Upload  — POST /api/slide-library/upload   (HTML or image, base64-in-JSON)
//   2. AI edit — POST /api/slide-library/slides/:slideId/ai-edit
//                Always-on (NOT gated by `DASHBOARD_WRITE`). Slide templates
//                are dashboard-local artifacts; allowing edits doesn't
//                touch any pipeline run.
//   3. Manage  — POST /api/slide-library/slides/:slideId/rename
//                DELETE /api/slide-library/slides/:slideId
//                Only user-owned (`source: 'upload'|'submit'`) entries are
//                writable; built-ins are read-only by design (they're
//                referenced by demos in flight).
//
// Image uploads land as `<id>.<ext>` next to a generated `<id>.html`
// wrapper that conforms to the slide-splice contract (`.step.slide-root`
// + `data-testid="step-..."`), so they flow through the existing splice
// pipeline without any special-casing on the consumer side.
const slideUploads = require(path.join(__dirname, 'utils', 'slide-library-uploads.js'));

// Per-route JSON parser with a 50 MB limit so base64-encoded image uploads
// fit. The default `express.json()` registered at module scope is 100 KB.
const slideLibraryUploadJson = require('express').json({ limit: '50mb' });

app.post('/api/slide-library/upload', slideLibraryUploadJson, (req, res) => {
  try {
    const body = req.body || {};
    const kind = String(body.kind || '').toLowerCase();
    const name = sanitizeSlideLibraryName(body.name);
    const tags = Array.isArray(body.tags)
      ? body.tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 12)
      : [];
    const sceneType = body.sceneType === 'demo' ? 'demo' : 'slide';
    const contentBase64 = String(body.contentBase64 || '').trim();
    const filename = String(body.filename || '').trim();
    const mimeType = String(body.mimeType || '').trim();

    if (!name) return res.status(400).json({ error: 'name required' });
    if (!contentBase64) return res.status(400).json({ error: 'contentBase64 required' });
    if (kind !== 'html' && kind !== 'image') {
      return res.status(400).json({ error: 'kind must be "html" or "image"' });
    }

    let buffer;
    try {
      buffer = Buffer.from(contentBase64, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'contentBase64 is not valid base64' });
    }
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'uploaded file is empty' });
    }
    // Hard cap (50 MB matches the JSON parser limit, with a small slack for
    // the surrounding JSON envelope; reject earlier to give a clear error).
    if (buffer.length > 48 * 1024 * 1024) {
      return res.status(413).json({ error: 'file exceeds 48 MB limit' });
    }

    const index = readSlideLibraryIndex();
    const slideId = makeUniqueLibrarySlideId(index, name);
    const createdAt = new Date().toISOString();
    ensureSlideLibraryDirs();

    let entry;
    if (kind === 'html') {
      const html = buffer.toString('utf8');
      // Tiny safety check: must look HTML-ish so the AI editor and splice
      // path don't get fed PDF / random bytes that decode to UTF-8 garbage.
      if (!/<html|<body|<div|<!doctype/i.test(html)) {
        return res.status(400).json({ error: 'uploaded HTML does not contain any recognizable tags' });
      }
      const htmlFilename = `${slideId}.html`;
      const htmlAbs = path.join(SLIDE_LIBRARY_SLIDES_DIR, htmlFilename);
      fs.writeFileSync(htmlAbs, html, 'utf8');
      entry = {
        id: slideId,
        name,
        createdAt,
        kind: 'html',
        source: 'upload',
        sceneType,
        tags,
        htmlPath: path.join('out', 'slide-library', 'slides', htmlFilename),
        sourceSnapshot: {
          label: name,
          narration: '',
          durationMs: 12000,
        },
      };
    } else {
      // image
      const ext = slideUploads.pickImageExt({ filename, mimeType });
      if (!ext) {
        return res.status(400).json({
          error: 'unsupported image type',
          hint: 'Use png, jpg, jpeg, webp, or gif',
        });
      }
      const imageBasename = `${slideId}.${ext}`;
      const htmlBasename = `${slideId}.html`;
      const imageAbs = path.join(SLIDE_LIBRARY_SLIDES_DIR, imageBasename);
      const htmlAbs = path.join(SLIDE_LIBRARY_SLIDES_DIR, htmlBasename);
      fs.writeFileSync(imageAbs, buffer);
      // Wrapper uses the dashboard's asset endpoint as an absolute URL —
      // see buildImageWrapperHtml's docblock for why relative paths break
      // when the wrapper is served at `/api/slide-library/slides/<id>/html`.
      const wrapperHtml = slideUploads.buildImageWrapperHtml({
        title: name,
        imageSrc: `/api/slide-library/slides/${encodeURIComponent(slideId)}/asset`,
        altText: name,
      });
      fs.writeFileSync(htmlAbs, wrapperHtml, 'utf8');
      entry = {
        id: slideId,
        name,
        createdAt,
        kind: 'image',
        source: 'upload',
        sceneType,
        tags,
        htmlPath: path.join('out', 'slide-library', 'slides', htmlBasename),
        imagePath: path.join('out', 'slide-library', 'slides', imageBasename),
        imageMimeType: slideUploads.mimeForExt(ext),
        sourceSnapshot: {
          label: name,
          narration: '',
          durationMs: 12000,
        },
      };
    }

    index.slides = Array.isArray(index.slides) ? index.slides : [];
    index.slides.unshift(entry);
    writeSlideLibraryIndex(index);
    res.json({ ok: true, slide: entry });
  } catch (err) {
    res.status(500).json({ error: err && err.message || 'Unknown error' });
  }
});

// Serve the raw image file for an image-kind slide so the wrapper HTML's
// `<img src="...">` resolves when the slide is previewed via
// `/api/slide-library/slides/:slideId/html`. Path-traversal guarded.
app.get('/api/slide-library/slides/:slideId/asset', (req, res) => {
  try {
    const slideId = String(req.params.slideId || '').trim();
    if (!slideId) return res.status(400).send('slideId required');
    const index = readSlideLibraryIndex();
    const slide = (index.slides || []).find((s) => s && s.id === slideId);
    if (!slide || !slide.imagePath) return res.status(404).send('Slide image not found');
    const { imageAbs } = slideUploads.pathsForSlide(slide, SLIDE_LIBRARY_SLIDES_DIR);
    if (!imageAbs || !imageAbs.startsWith(SLIDE_LIBRARY_SLIDES_DIR + path.sep) || !fs.existsSync(imageAbs)) {
      return res.status(404).send('Slide image not found');
    }
    const ext = (path.extname(imageAbs) || '').replace(/^\./, '').toLowerCase();
    const mime = slideUploads.mimeForExt(ext) || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(imageAbs).pipe(res);
  } catch (err) {
    res.status(500).send(err && err.message || 'Unknown error');
  }
});

// AI edit a slide template's HTML. Single mode (full-document rewrite) —
// simpler than the demo-app endpoint because there's no element picker
// and no per-step scoping.  Always-on: NO `guardWriteOrStage` because
// slide templates are dashboard-local artifacts.
app.post('/api/slide-library/slides/:slideId/ai-edit', slideLibraryUploadJson, async (req, res) => {
  try {
    const slideId = String(req.params.slideId || '').trim();
    if (!slideId) return res.status(400).json({ error: 'slideId required' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({
        error: 'AI editing unavailable',
        hint: 'Set ANTHROPIC_API_KEY in .env to enable the slide template editor',
      });
    }

    const message = String(req.body && req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'message required' });
    const conversationHistory = Array.isArray(req.body && req.body.conversationHistory)
      ? req.body.conversationHistory
      : [];

    const index = readSlideLibraryIndex();
    const slide = (index.slides || []).find((s) => s && s.id === slideId);
    if (!slide || !slide.htmlPath) return res.status(404).json({ error: 'Slide not found' });
    const htmlAbs = path.resolve(PROJECT_ROOT, slide.htmlPath);
    if (!htmlAbs.startsWith(SLIDE_LIBRARY_DIR + path.sep) || !fs.existsSync(htmlAbs)) {
      return res.status(404).json({ error: 'Slide HTML not found' });
    }
    const currentHtml = fs.readFileSync(htmlAbs, 'utf8');

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const cfg = getAiEditRuntimeConfig();

    const systemPrompt = [
      'You are editing a standalone slide template HTML file.',
      'It is a single self-contained document that includes its own <style> block.',
      'Design system: dark navy gradient backgrounds (#0d1117 → #0a2540), accent #00A67E (teal), light text on dark.',
      '',
      'CRITICAL CONTRACT (do not break or the slide stops working):',
      '  - Preserve the outermost <div data-testid="step-..." class="step ..."> element.',
      '    Keep the data-testid value AND the "step" class. Other classes (slide-root,',
      '    insight-layout, etc.) may be added or removed.',
      '  - Keep the entire output a valid full HTML document (<!doctype html>, <html>, <head>, <body>).',
      '  - Keep ALL <style> blocks inside <head>. Do not move them into <body>.',
      '',
      'Respond with ONLY the complete updated HTML document — no explanations,',
      'no markdown fences, no commentary. The first non-whitespace characters',
      'of your response MUST be "<!doctype" or "<!DOCTYPE".',
    ].join('\n');

    const messages = [];
    // Bound conversation history per the runtime config so we don't blow
    // the context window on long-lived sessions.
    const maxTurns = cfg.conversation.maxTurns;
    const maxCharsPerTurn = cfg.conversation.maxCharsPerTurn;
    const maxTotalChars = cfg.conversation.maxTotalChars;
    let totalChars = 0;
    const trimmedHistory = [];
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const turn = conversationHistory[i];
      if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
      const content = String(turn.content || '').slice(0, maxCharsPerTurn);
      if (totalChars + content.length > maxTotalChars) continue;
      trimmedHistory.unshift({ role: turn.role, content });
      totalChars += content.length;
      if (trimmedHistory.length >= maxTurns) break;
    }
    messages.push(...trimmedHistory);
    messages.push({
      role: 'user',
      content: `Request: ${message}\n\nCurrent slide HTML:\n${currentHtml}`,
    });

    const completion = await client.messages.create({
      model: cfg.models.full,
      max_tokens: cfg.maxTokens.full,
      system: systemPrompt,
      messages,
    });
    let responseText = (completion.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    // Strip optional code fences if the model ignored the contract.
    responseText = responseText.replace(/^```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '');
    if (!/^<!doctype/i.test(responseText) && !/^<html\b/i.test(responseText)) {
      return res.status(502).json({
        error: 'AI response did not return a valid HTML document',
        reason: 'invalid-response',
        rawPreview: responseText.slice(0, 240),
      });
    }
    // Slide must still carry a `step-...` container — otherwise splice
    // would break next time someone inserts it.
    if (!/<div[^>]*\bdata-testid="step-[^"]+"/i.test(responseText)) {
      return res.status(502).json({
        error: 'AI response dropped the step container — refusing to write',
        reason: 'missing-step-container',
      });
    }

    // Backup before overwriting so the user can recover if the AI breaks
    // a slide they cared about.
    try {
      fs.writeFileSync(htmlAbs + '.bak', currentHtml, 'utf8');
    } catch (_) { /* best-effort */ }
    fs.writeFileSync(htmlAbs, responseText, 'utf8');

    res.json({
      ok: true,
      slideId,
      reply: 'Slide updated. Reload the preview to see changes.',
      bytesWritten: Buffer.byteLength(responseText, 'utf8'),
    });
  } catch (err) {
    res.status(500).json({ error: err && err.message || 'Unknown error' });
  }
});

app.post('/api/slide-library/slides/:slideId/rename', slideLibraryUploadJson, (req, res) => {
  try {
    const slideId = String(req.params.slideId || '').trim();
    const newName = String(req.body && req.body.name || '').trim();
    if (!slideId) return res.status(400).json({ error: 'slideId required' });
    if (!newName) return res.status(400).json({ error: 'name required' });

    const index = readSlideLibraryIndex();
    const result = slideUploads.renameSlideInIndex(index, slideId, newName);
    if (!result.changed) {
      if (result.reason === 'slide-not-found') return res.status(404).json({ error: 'Slide not found' });
      // No-op rename or empty name — still 200 with reason for the client.
      return res.json({ ok: true, changed: false, reason: result.reason, slide: result.slide });
    }
    writeSlideLibraryIndex(result.index);
    res.json({ ok: true, changed: true, slide: result.slide });
  } catch (err) {
    res.status(500).json({ error: err && err.message || 'Unknown error' });
  }
});

app.delete('/api/slide-library/slides/:slideId', (req, res) => {
  try {
    const slideId = String(req.params.slideId || '').trim();
    if (!slideId) return res.status(400).json({ error: 'slideId required' });
    const index = readSlideLibraryIndex();
    const slide = (index.slides || []).find((s) => s && s.id === slideId);
    if (!slide) return res.status(404).json({ error: 'Slide not found' });
    if (!slideUploads.isUserOwnedSlide(slide)) {
      return res.status(403).json({
        error: 'Built-in slides are read-only',
        hint: 'Only user-uploaded or dashboard-submitted slides can be deleted',
      });
    }
    // Unlink files BEFORE rewriting the index — if file removal fails we
    // want the index to still match disk on retry.
    const { htmlAbs, imageAbs } = slideUploads.pathsForSlide(slide, SLIDE_LIBRARY_SLIDES_DIR);
    for (const p of [htmlAbs, imageAbs]) {
      if (p && fs.existsSync(p)) {
        try { fs.unlinkSync(p); }
        catch (_) { /* best-effort — index will still drop the entry */ }
      }
      // Also nuke the optional .bak created by the AI editor.
      const bak = p ? p + '.bak' : null;
      if (bak && fs.existsSync(bak)) {
        try { fs.unlinkSync(bak); } catch (_) {}
      }
    }
    const result = slideUploads.removeSlideFromIndex(index, slideId);
    writeSlideLibraryIndex(result.index);
    res.json({ ok: true, removed: result.removed });
  } catch (err) {
    res.status(500).json({ error: err && err.message || 'Unknown error' });
  }
});

app.post('/api/slide-library/submit', (req, res) => {
  try {
    const runId = String(req.body && req.body.runId || '').trim();
    const stepId = String(req.body && req.body.stepId || '').replace(/^step-/, '').trim();
    const name = sanitizeSlideLibraryName(req.body && req.body.name);
    const tags = Array.isArray(req.body && req.body.tags)
      ? req.body.tags.map(t => String(t || '').trim()).filter(Boolean).slice(0, 12)
      : [];

    if (!runId) return res.status(400).json({ error: 'runId required' });
    if (!stepId) return res.status(400).json({ error: 'stepId required' });
    if (!name) return res.status(400).json({ error: 'name required' });

    const runDir = getRunDir(runId);
    const script = safeReadJson(path.join(runDir, 'demo-script.json'));
    if (!script || !Array.isArray(script.steps)) {
      return res.status(404).json({ error: 'demo-script.json not found' });
    }
    const sourceStep = script.steps.find(s => s && s.id === stepId);
    if (!sourceStep) return res.status(404).json({ error: `step "${stepId}" not found in demo-script.json` });

    const appIndex = getAppIndex(runId);
    if (!appIndex) return res.status(404).json({ error: 'scratch-app/index.html not found' });
    const stepHtml = appIndex.steps[stepId] || extractStepHtml(appIndex.html, stepId);
    if (!stepHtml) return res.status(404).json({ error: `step "${stepId}" not found in app HTML` });
    const stepCss = extractStepCss(appIndex.cssRules || [], stepHtml) || appIndex.allCss || '';

    const index = readSlideLibraryIndex();
    const slideId = makeUniqueLibrarySlideId(index, name);
    const htmlFilename = `${slideId}.html`;
    const htmlPath = path.join(SLIDE_LIBRARY_SLIDES_DIR, htmlFilename);
    const standaloneHtml = buildStandaloneSlideHtml({
      title: name,
      css: stepCss,
      stepHtml,
    });
    fs.writeFileSync(htmlPath, standaloneHtml, 'utf8');

    const sceneType = sourceStep.plaidPhase === 'insight' ? 'slide' : 'demo';
    const createdAt = new Date().toISOString();
    const entry = {
      id: slideId,
      name,
      createdAt,
      sourceRunId: runId,
      sourceStepId: stepId,
      sceneType,
      tags,
      htmlPath: path.join('out', 'slide-library', 'slides', htmlFilename),
      sourceSnapshot: JSON.parse(JSON.stringify({
        label: sourceStep.label || name,
        narration: sourceStep.narration || '',
        durationMs: Number(sourceStep.durationMs || 12000),
        visualState: sourceStep.visualState || '',
        plaidPhase: sourceStep.plaidPhase == null ? null : sourceStep.plaidPhase,
        interaction: sourceStep.interaction || null,
        apiResponse: sourceStep.apiResponse || null,
      })),
    };
    index.slides = Array.isArray(index.slides) ? index.slides : [];
    index.slides.unshift(entry);
    writeSlideLibraryIndex(index);
    res.json({ ok: true, slide: entry });
  } catch (err) {
    const msg = err && err.message;
    if (msg && /invalid runid/i.test(msg)) return res.status(400).json({ error: msg });
    res.status(500).json({ error: msg || 'Unknown error' });
  }
});

// Allocate an empty run directory (no pipeline). Must be registered before /api/runs/:runId.
app.post('/api/runs/allocate', (req, res) => {
  try {
    const allocated = allocateDashboardRunDir();
    invalidateRunsCache();
    broadcastLog(`[Dashboard] Allocated new empty run: ${allocated.runDir}`);
    res.json({ runId: allocated.runId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Persisted orchestrator session log (dashboard). Must be before /api/runs/:runId.
app.get('/api/runs/:runId/pipeline-console-log', (req, res) => {
  try {
    const runId = req.params.runId;
    const dir = getRunDir(runId);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Run not found' });
    const maxLines = Math.min(8000, Math.max(1, parseInt(req.query.maxLines || '4000', 10)));
    const logPath = path.join(dir, PIPELINE_CONSOLE_LOG);
    if (!fs.existsSync(logPath)) return res.json({ lines: [] });
    const maxBytes = Math.min(4 * 1024 * 1024, Math.max(256 * 1024, maxLines * 320));
    const raw = readTextTailFromFile(logPath, maxBytes);
    const all = raw.split(/\r?\n/);
    const slice = all.length > maxLines ? all.slice(-maxLines) : all;
    const lines = slice.map((text) => parsePipelineConsoleLogLine(text));
    res.json({ lines });
  } catch (err) {
    const msg = err && err.message;
    if (msg && /invalid runid/i.test(msg)) return res.status(400).json({ error: msg });
    res.status(500).json({ error: msg || 'Unknown error' });
  }
});

app.get('/api/runs/:runId', (req, res) => {
  try {
    const runId = req.params.runId;
    const dir = getRunDir(runId);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Run not found' });

    const artifacts = getRunArtifacts(runId);
    const qa = getLatestQaReport(runId);
    const script = getRunScriptSummary(runId);
    const completedStages = getCompletedStages(runId);
    let { lastCompletedStage, resumeFromStage } = computePipelineResume(completedStages);

    // Slide template newer than built app → suggest re-running from build (matches orchestrator guidance)
    try {
      const slideTemplateDir = path.join(PROJECT_ROOT, 'templates/slide-template');
      const candidateFiles = ['base.html', 'slide.css', 'PIPELINE_SLIDE_SHELL_RULES.md', 'SLIDE_RULES.archive.md', 'components.html'];
      let maxTemplateMtimeMs = 0;
      for (const f of candidateFiles) {
        const fp = path.join(slideTemplateDir, f);
        if (!fs.existsSync(fp)) continue;
        const m = fs.statSync(fp).mtimeMs;
        if (m > maxTemplateMtimeMs) maxTemplateMtimeMs = m;
      }
      const builtApp = path.join(dir, 'scratch-app', 'index.html');
      if (fs.existsSync(builtApp) && maxTemplateMtimeMs > 0) {
        const builtMtimeMs = fs.statSync(builtApp).mtimeMs;
        if (maxTemplateMtimeMs > builtMtimeMs) {
          const buildIdx = PIPELINE_STAGES.indexOf('build');
          if (buildIdx > 0) {
            lastCompletedStage = PIPELINE_STAGES[buildIdx - 1];
            resumeFromStage = 'build';
          }
        }
      }
    } catch (_) {}

    const allFiles = safeReaddir(dir);
    const manifest = allFiles.map(name => {
      try {
        const stat = fs.statSync(path.join(dir, name));
        return stat.isFile() ? { name, size: stat.size } : null;
      } catch (_) { return null; }
    }).filter(Boolean);

    const displayName = resolveDemoDisplayName(runId, readDemoAppNames());
    const buildModeInfo = readRunBuildModeInfo(runId);
    res.json({
      runId, displayName, artifacts,
      qaScore: qa ? qa.overallScore : null, manifest,
      lastCompletedStage, resumeFromStage, completedStages, script,
      buildMode: buildModeInfo ? buildModeInfo.buildMode : null,
      buildModeLabel: buildModeInfo ? buildModeInfo.label : null,
      buildModeSource: buildModeInfo ? buildModeInfo.buildModeSource : null,
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
    const timelineSyncPath = path.join(dir, 'timeline-sync-status.json');
    const syncMap        = safeReadJson(syncMapPath);
    const manifest       = safeReadJson(manifestPath);
    const timelineSync   = safeReadJson(timelineSyncPath);

    const syncMapExists  = fs.existsSync(syncMapPath);
    const manifestExists = fs.existsSync(manifestPath);
    const syncMapMtime   = syncMapExists  ? fs.statSync(syncMapPath).mtimeMs  : null;
    const manifestMtime  = manifestExists ? fs.statSync(manifestPath).mtimeMs : null;

    const hasSegments    = syncMapExists && Array.isArray(syncMap?.segments) && syncMap.segments.length > 0;
    const resyncedAt     = manifest?.resyncedAt || null;
    const syncApplied    = manifest?.syncMapApplied === true;

    // Baseline stale = sync-map has real segments AND manifest either predates sync-map or wasn't resynced.
    let isStale = hasSegments && manifestExists &&
      (!syncApplied || (syncMapMtime != null && manifestMtime != null && syncMapMtime > manifestMtime));

    // If Timeline Editor has a newer explicit sync-health check, trust it as latest state.
    const timelineCheckedAtMs = timelineSync?.checkedAt ? Date.parse(timelineSync.checkedAt) : null;
    const timelineHasIssues = timelineSync?.hasSyncIssues === true;
    const timelineNoIssues = timelineSync?.hasSyncIssues === false;
    const timelineIsNewerThanSyncMap = timelineCheckedAtMs != null && syncMapMtime != null
      ? timelineCheckedAtMs >= syncMapMtime
      : timelineCheckedAtMs != null;
    if (timelineCheckedAtMs != null && timelineIsNewerThanSyncMap) {
      if (timelineNoIssues) isStale = false;
      if (timelineHasIssues) isStale = true;
    }

    res.json({
      syncMapExists,
      manifestExists,
      hasSegments,
      segmentCount: hasSegments ? syncMap.segments.length : 0,
      resyncedAt,
      syncApplied,
      isStale,
      timelineSync: timelineSync || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:runId/frames', async (req, res) => {
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

    const scriptPath = path.join(dir, 'demo-script.json');
    const script = safeReadJson(scriptPath);
    if (script && Array.isArray(script.steps)) {
      let generatedAny = false;
      const libraryIndex = readSlideLibraryIndex();
      for (const step of script.steps) {
        if (!step || !step.id || !step.slideLibraryRef) continue;
        const qaThumb = path.join(qaDir, `${step.id}-mid.png`);
        const buildThumb = path.join(buildDir, `${step.id}-mid.png`);
        if (fs.existsSync(qaThumb) || fs.existsSync(buildThumb)) continue;
        const slideId = String(step.slideLibraryRef.slideId || '').trim();
        const slide = (libraryIndex.slides || []).find(s => s && s.id === slideId);
        if (!slide) continue;
        try {
          await generateLibrarySlideThumbnail(dir, step.id, slide);
          generatedAny = true;
        } catch (thumbErr) {
          console.warn(`[Frames] Could not generate library thumbnail for ${step.id}: ${thumbErr.message}`);
        }
      }
      if (generatedAny) {
        qaFiles = safeReaddir(qaDir).filter(f => /\.png$/i.test(f)).sort();
      }
    }

    let files  = qaFiles;
    let source = 'qa-frames';
    if (files.length === 0) {
      files  = safeReaddir(buildDir).filter(f => /\.png$/i.test(f)).sort();
      source = 'build-frames';
    } else {
      // When QA frames are present, still include build-frame fallbacks for any newly
      // inserted storyboard steps that do not yet have a QA snapshot.
      const buildFiles = safeReaddir(buildDir).filter(f => /\.png$/i.test(f)).sort();
      files = Array.from(new Set([...files, ...buildFiles])).sort();
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
  staticApp.use((req, res, next) => {
    if (tryServePlaidLogoFallback(req, res, scratchDir)) return;
    next();
  });
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
  if (guardWriteOrStage(req, res, 'build-qa')) return;
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

app.get('/api/runs/:runId/download-app-package', async (req, res) => {
  try {
    const runId = req.params.runId;
    const zip = await buildRunAppPackage(runId);
    const buf = zip.toBuffer();
    const filename = `${runId}-app-package.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) {
    res.status(400).json({ error: err.message });
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

function injectNarrationStoreIntoHtml(html, steps) {
  if (typeof html !== 'string' || !Array.isArray(steps)) return html;
  const narrationMap = {};
  for (const s of steps) {
    if (!s || !s.id) continue;
    narrationMap[s.id] = String(s.narration || '');
  }
  const scriptTag = `<script id="storyboard-narration-store" type="application/json">${JSON.stringify(narrationMap).replace(/</g, '\\u003c')}</script>`;
  const runtimeTag = `<script id="storyboard-narration-runtime">(function(){try{var n=document.getElementById('storyboard-narration-store');window.__stepNarrationStore=n?JSON.parse(n.textContent||'{}'):{};window.getStepNarration=function(id){var key=String(id||'').replace(/^step-/,'');return window.__stepNarrationStore&&window.__stepNarrationStore[key]?window.__stepNarrationStore[key]:'';};}catch(_){window.__stepNarrationStore={};window.getStepNarration=function(){return '';};}})();</script>`;
  html = html.replace(/<script id="storyboard-narration-store"[\s\S]*?<\/script>\s*/i, '');
  html = html.replace(/<script id="storyboard-narration-runtime"[\s\S]*?<\/script>\s*/i, '');
  if (html.includes('</body>')) {
    return html.replace('</body>', `${scriptTag}\n${runtimeTag}\n</body>`);
  }
  return `${html}\n${scriptTag}\n${runtimeTag}\n`;
}

function syncNarrationStoreForRun(runDir, script) {
  const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
  if (!fs.existsSync(htmlPath)) return false;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const patched = injectNarrationStoreIntoHtml(html, script.steps || []);
  if (patched !== html) {
    fs.writeFileSync(htmlPath, patched, 'utf8');
  }
  return true;
}

function estimateNarrationMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  // 150 wpm baseline used throughout pipeline prompts.
  return Math.round((words / 150) * 60 * 1000);
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize voiceover clip coordinates across manifest versions:
 * - v2+ manifests provide compStartMs/compEndMs explicitly
 * - legacy manifests only provide startMs/endMs (composition-space in older runs)
 */
function resolveClipCompWindowMs(clip) {
  if (!clip || typeof clip !== 'object') return { startMs: null, endMs: null };
  const startMs = toFiniteNumber(clip.compStartMs) ?? toFiniteNumber(clip.startMs);
  let endMs = toFiniteNumber(clip.compEndMs) ?? toFiniteNumber(clip.endMs);
  if (endMs == null && startMs != null) {
    const audioDurMs = toFiniteNumber(clip.audioDurationMs) ?? toFiniteNumber(clip.durationMs);
    if (audioDurMs != null) endMs = startMs + audioDurMs;
  }
  return { startMs, endMs };
}

function readSyncMapFile(syncPath) {
  let raw = { segments: [] };
  if (fs.existsSync(syncPath)) {
    const parsed = safeReadJson(syncPath);
    if (Array.isArray(parsed)) raw = { segments: parsed };
    else if (parsed && Array.isArray(parsed.segments)) raw = parsed;
  }
  return raw;
}

function resolveStepProcessedWindow(runDir, stepId) {
  const processedTimingPath = path.join(runDir, 'processed-step-timing.json');
  const rawTimingPath = path.join(runDir, 'step-timing.json');
  const processed = safeReadJson(processedTimingPath);

  if (processed && Array.isArray(processed.plaidStepWindows)) {
    const plaid = processed.plaidStepWindows.find((w) => w && w.stepId === stepId);
    if (plaid && plaid.startMs != null && plaid.endMs != null) {
      return {
        startMs: Number(plaid.startMs),
        endMs: Number(plaid.endMs),
        source: 'processed-plaid-window',
      };
    }
  }

  const rawTiming = safeReadJson(rawTimingPath);
  const rawSteps = rawTiming && Array.isArray(rawTiming.steps) ? rawTiming.steps : [];
  const rawStep = rawSteps.find((s) => s && (s.id === stepId || s.step === stepId));
  if (!rawStep || rawStep.startMs == null || rawStep.endMs == null) return null;

  if (!(processed && Array.isArray(processed.keepRanges) && processed.keepRanges.length > 0)) {
    return {
      startMs: Number(rawStep.startMs),
      endMs: Number(rawStep.endMs),
      source: 'raw-step-window',
    };
  }

  const ranges = processed.keepRanges;
  function remapRawMs(rawMs) {
    const rawS = Number(rawMs) / 1000;
    for (const r of ranges) {
      if (rawS >= r.rawStart && rawS <= r.rawEnd) {
        return Math.round((r.processedStart + (rawS - r.rawStart)) * 1000);
      }
      if (rawS < r.rawStart) return Math.round(r.processedStart * 1000);
    }
    const last = ranges[ranges.length - 1];
    return last ? Math.round(last.processedEnd * 1000) : Number(rawMs);
  }

  return {
    startMs: remapRawMs(rawStep.startMs),
    endMs: remapRawMs(rawStep.endMs),
    source: 'processed-remapped',
  };
}

function ensureNarrationFitsStepTimeline(runDir, stepId, narrationText) {
  const syncPath = path.join(runDir, 'sync-map.json');
  const syncRaw = readSyncMapFile(syncPath);
  const existingSegments = syncRaw.segments || [];
  // Replace prior auto narration adjustments for this step.
  const baseSegments = existingSegments.filter((s) => !(s && s._autoNarration === true && s._step === stepId));

  const window = resolveStepProcessedWindow(runDir, stepId);
  if (!window) {
    // Still persist cleanup if prior autoNarration entries existed.
    if (baseSegments.length !== existingSegments.length) {
      const out = { ...(syncRaw._comment ? { _comment: syncRaw._comment } : {}), segments: baseSegments };
      const tmp = syncPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
      fs.renameSync(tmp, syncPath);
    }
    return { updated: false, reason: 'step-window-not-found' };
  }

  const narrationMs = estimateNarrationMs(narrationText);
  const compStartMs = processedToCompMs(window.startMs, baseSegments);
  const compEndMs = processedToCompMs(window.endMs, baseSegments);
  const compDurationMs = Math.max(0, compEndMs - compStartMs);
  const toleranceMs = 100;
  let updated = baseSegments.length !== existingSegments.length;

  if (narrationMs > 0 && compDurationMs + toleranceMs < narrationMs) {
    const extendMs = narrationMs - compDurationMs;
    baseSegments.push({
      compStart: Number((compEndMs / 1000).toFixed(4)),
      compEnd: Number(((compEndMs + extendMs) / 1000).toFixed(4)),
      videoStart: Number((window.endMs / 1000).toFixed(4)),
      mode: 'freeze',
      _autoNarration: true,
      _step: stepId,
      _reason: `storyboard narration auto-extend: narr ${(narrationMs / 1000).toFixed(2)}s > comp ${(compDurationMs / 1000).toFixed(2)}s`,
    });
    updated = true;
  }

  if (updated) {
    baseSegments.sort((a, b) => Number(a.compStart || 0) - Number(b.compStart || 0));
    const out = { ...(syncRaw._comment ? { _comment: syncRaw._comment } : {}), segments: baseSegments };
    const tmp = syncPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
    fs.renameSync(tmp, syncPath);
  }

  return {
    updated,
    narrationMs,
    compDurationMs,
    source: window.source,
    reason: updated ? 'sync-map-extended' : 'already-fits',
  };
}

app.post('/api/runs/:runId/script', (req, res) => {
  try {
    const { stepId, narration } = req.body;
    if (!stepId || typeof narration !== 'string') {
      return res.status(400).json({ error: 'stepId and narration are required' });
    }

    const wordCount = narration.trim().split(/\s+/).filter(Boolean).length;

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

    // Keep narration context accessible from the live app itself so storyboard
    // editing can stay step-linked during preview sessions.
    try { syncNarrationStoreForRun(dir, script); } catch (_) {}
    let syncAdjust = null;
    try {
      syncAdjust = ensureNarrationFitsStepTimeline(dir, stepId, narration);
    } catch (_) {
      syncAdjust = { updated: false, reason: 'sync-adjust-failed' };
    }

    res.json({ ok: true, wordCount, syncAdjust });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/runs/:runId/storyboard-live-preview', async (req, res) => {
  try {
    const runId = req.params.runId;
    const runDir = getRunDir(runId);
    const scriptPath = path.join(runDir, 'demo-script.json');
    const script = fs.existsSync(scriptPath) ? safeReadJson(scriptPath) : null;
    if (script && Array.isArray(script.steps)) {
      try { syncNarrationStoreForRun(runDir, script); } catch (_) {}
    }
    const url = `/demo-app-preview/${encodeURIComponent(runId)}?storyboard=1&t=${Date.now()}`;
    res.json({ ok: true, url });
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

/**
 * Dashboard write gating.
 *
 * As of the pipeline CLI migration, all run/kill/stdin actions default to the
 * CLI (`npm run pipe ...`). Setting DASHBOARD_WRITE=true re-enables the
 * legacy in-dashboard runner for environments that still need it. When
 * disabled we respond 410 Gone with a `cliCommand` hint the client can copy.
 */
const DASHBOARD_WRITE_ENABLED = String(process.env.DASHBOARD_WRITE || '').toLowerCase() === 'true';

function buildPipeCliCommand(body = {}) {
  const b = body || {};
  const parts = ['npm', 'run', 'pipe', '--'];
  if (b.resumeRunId) {
    parts.push('resume', String(b.resumeRunId));
    if (b.fromStage) parts.push(`--from=${b.fromStage}`);
    if (b.toStage)   parts.push(`--to=${b.toStage}`);
    if (b.overrideWithSlides && b.withSlides === true)  parts.push('--with-slides');
    if (b.overrideWithSlides && b.withSlides === false) parts.push('--app-only');
  } else if (b.createNewRun) {
    parts.push('new');
    if (b.withSlides === true)  parts.push('--with-slides');
    if (b.withSlides === false) parts.push('--app-only');
    if (b.toStage) parts.push(`--to=${b.toStage}`);
    if (b.researchMode) parts.push(`--research=${b.researchMode}`);
  } else {
    parts.push('status');
  }
  if (Number(b.qaThreshold) > 0) parts.push(`--qa-threshold=${Math.floor(Number(b.qaThreshold))}`);
  if (Number(b.maxRefinementIterations) > 0) parts.push(`--max-refinement-iterations=${Math.floor(Number(b.maxRefinementIterations))}`);
  if (b.buildFixMode) parts.push(`--build-fix-mode=${String(b.buildFixMode).toLowerCase()}`);
  if (b.noTouchup) parts.push('--no-touchup');
  return parts.join(' ');
}

function respondWithCliHint(req, res, verb, opts = {}) {
  const body = req.body || {};
  const runId = opts.runId || req.params?.runId || '';
  let cliCommand;
  if (verb === 'run') {
    cliCommand = buildPipeCliCommand(body);
  } else if (verb === 'kill') {
    cliCommand = 'npm run pipe -- stop';
  } else if (verb === 'continue') {
    cliCommand = `npm run pipe -- continue${runId ? ' ' + runId : ''}`;
  } else if (verb === 'stage' && opts.stage) {
    const idPart = runId ? ' ' + runId : '';
    cliCommand = `npm run pipe -- stage ${opts.stage}${idPart}`;
  } else if (verb === 'publish') {
    cliCommand = `npm run pipe -- publish${runId ? ' ' + runId : ' <RUN_ID>'}`;
  } else {
    cliCommand = 'npm run pipe';
  }
  res.status(410).json({
    error: 'Dashboard writes are disabled — run from the CLI.',
    cliCommand,
    docs: '.claude/skills/pipeline-cli/SKILL.md',
    hint: 'Set DASHBOARD_WRITE=true to re-enable legacy dashboard runs.',
  });
}

/**
 * Guard helper for dashboard endpoints that trigger LLM work or orchestrator
 * side-effects. When DASHBOARD_WRITE is off we return 410 + CLI hint; callers
 * return true so they can `return` early.
 */
function guardWriteOrStage(req, res, stage) {
  if (DASHBOARD_WRITE_ENABLED) return false;
  respondWithCliHint(req, res, 'stage', { stage, runId: req.params?.runId });
  return true;
}

/**
 * Shared helper invoked whenever a storyboard action inserts a step into
 * `demo-script.json`. Stamps `stepKind` on the new step and, when a slide is
 * inserted into an originally `app-only` run, flips the run manifest to
 * `app+slides` (source = `storyboard-insert`) so downstream post-slides QA
 * and the dashboard badge are aware.
 */
function stampInsertedStepKindAndMaybeUpgradeBuildMode(runDir, insertedStep) {
  try {
    if (!insertedStep || typeof insertedStep !== 'object') return;
    const kind = deriveStepKind(insertedStep);
    if (insertedStep.stepKind !== kind) insertedStep.stepKind = kind;
    if (kind !== 'slide') return;
    const manifest = readRunManifestSafe(runDir);
    if (!manifest) return;
    const current = String(manifest.buildMode || '').toLowerCase();
    if (current === 'app+slides') return;
    writeRunManifestSafe(runDir, {
      ...manifest,
      buildMode: 'app+slides',
      buildModeSource: 'storyboard-insert',
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`[storyboard] Could not stamp stepKind / upgrade buildMode: ${e.message}`);
  }
}

app.post('/api/pipeline/run', (req, res) => {
  if (!DASHBOARD_WRITE_ENABLED) return respondWithCliHint(req, res, 'run');
  try {
    // If activeProcess is set but has already exited, clear the stale reference
    if (activeProcess !== null && activeProcess.exitCode !== null) {
      activeProcess = null;
      activePipelineRunId = null;
    }

    const { force } = req.body || {};
    if (activeProcess !== null && !force) {
      return res.status(409).json({ error: 'Already running', pid: activeProcess.pid });
    }
    // force=true: kill the existing process and start fresh
    if (activeProcess !== null && force) {
      try { activeProcess.kill('SIGTERM'); } catch (_) {}
      activeProcess = null;
      activePipelineRunId = null;
    }

    const {
      fromStage,
      toStage,
      noTouchup,
      resumeRunId,
      createNewRun,
      researchMode,
      qaThreshold,
      maxRefinementIterations,
      buildFixMode,
      withSlides,
      overrideWithSlides,
    } = req.body || {};
    const args = ['scripts/scratch/orchestrator.js'];
    if (fromStage) args.push(`--from=${fromStage}`);
    if (toStage && typeof toStage === 'string' && toStage.trim()) {
      args.push(`--to=${toStage.trim().toLowerCase()}`);
    }
    if (Number.isFinite(Number(qaThreshold)) && Number(qaThreshold) > 0) {
      args.push(`--qa-threshold=${Math.floor(Number(qaThreshold))}`);
    }
    if (Number.isFinite(Number(maxRefinementIterations)) && Number(maxRefinementIterations) > 0) {
      args.push(`--max-refinement-iterations=${Math.floor(Number(maxRefinementIterations))}`);
    }
    if (typeof buildFixMode === 'string' && buildFixMode.trim()) {
      args.push(`--build-fix-mode=${buildFixMode.trim().toLowerCase()}`);
    }
    if (noTouchup) args.push('--no-touchup');

    // Build spawn env — all pipeline launches must be bound to an explicit run directory.
    const spawnEnv = { ...process.env };
    let targetRunId = null;
    let inheritedBuildMode = null;
    if (resumeRunId) {
      try {
        const resumeDir = getRunDir(resumeRunId);
        if (!fs.existsSync(resumeDir)) {
          return res.status(404).json({ error: `Run directory not found: ${resumeRunId}` });
        }
        spawnEnv.PIPELINE_RUN_DIR = resumeDir;
        targetRunId = resumeRunId;
        inheritedBuildMode = readRunBuildModeInfo(resumeRunId);
        broadcastLog(`[Dashboard] Resuming into run directory: ${resumeDir}`);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    } else if (createNewRun) {
      const allocated = allocateDashboardRunDir();
      spawnEnv.PIPELINE_RUN_DIR = allocated.runDir;
      targetRunId = allocated.runId;
      broadcastLog(`[Dashboard] Allocated new run directory: ${allocated.runDir}`);
    } else {
      return res.status(400).json({
        error: 'runId is required. Pass resumeRunId for restart or createNewRun=true for full runs.',
      });
    }

    if (researchMode && typeof researchMode === 'string' && researchMode.trim()) {
      spawnEnv.RESEARCH_MODE = researchMode.trim().toLowerCase();
      broadcastLog(`[Dashboard] RESEARCH_MODE=${spawnEnv.RESEARCH_MODE}`);
    }

    // Resolve withSlides for this spawn:
    //   1. If resuming and the target run has a recorded buildMode, inherit it
    //      unless the caller explicitly set overrideWithSlides=true.
    //   2. Otherwise, honor the request body `withSlides` (default false).
    let resolvedWithSlides;
    let resolvedSource;
    if (resumeRunId && inheritedBuildMode && overrideWithSlides !== true) {
      resolvedWithSlides = inheritedBuildMode.buildMode === 'app+slides';
      resolvedSource = 'inherited from run-manifest';
    } else if (typeof withSlides === 'boolean') {
      resolvedWithSlides = withSlides;
      resolvedSource = createNewRun ? 'dashboard modal' : 'dashboard quick-action';
    } else {
      resolvedWithSlides = false;
      resolvedSource = 'dashboard default (no payload)';
    }
    spawnEnv.PIPELINE_WITH_SLIDES = resolvedWithSlides ? 'true' : 'false';
    spawnEnv.PIPELINE_WITH_SLIDES_SOURCE = resolvedSource;
    broadcastLog(
      `[Dashboard] Mode: ${resolvedWithSlides ? 'App + Slides' : 'App-only'} (source: ${resolvedSource})`
    );

    logBuffer = [];
    pipelineOutRem = '';
    pipelineErrRem = '';
    closePipelineDiskLog();
    if (spawnEnv.PIPELINE_RUN_DIR) {
      openPipelineDiskLog(spawnEnv.PIPELINE_RUN_DIR, args);
    }

    activeProcess = spawn('node', args, {
      cwd: PROJECT_ROOT,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
    activePipelineRunId = targetRunId;

    activeProcess.stdout.on('data', (data) => {
      flushPipelineStreamChunk(data, false);
    });
    activeProcess.stderr.on('data', (data) => {
      flushPipelineStreamChunk(data, true);
    });
    activeProcess.on('close', (code) => {
      if (pipelineOutRem !== '') {
        broadcastLog(pipelineOutRem, { fromChild: true, stream: 'stdout' });
        pipelineOutRem = '';
      }
      if (pipelineErrRem !== '') {
        broadcastLog(pipelineErrRem, { fromChild: true, stream: 'stderr' });
        pipelineErrRem = '';
      }
      broadcastLog(`[Pipeline exited with code ${code}]`, { stream: 'dashboard' });
      activeProcess = null;
      activePipelineRunId = null;
      closePipelineDiskLog();
    });
    activeProcess.on('error', (err) => {
      broadcastLog(`[Pipeline error: ${err.message}]`, { stream: 'dashboard' });
      activeProcess = null;
      activePipelineRunId = null;
      closePipelineDiskLog();
    });

    res.json({ pid: activeProcess.pid, runId: targetRunId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline/kill', (req, res) => {
  if (!DASHBOARD_WRITE_ENABLED) return respondWithCliHint(req, res, 'kill');
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
    activePipelineRunId = null;
  }
  const running = isPipelineChildRunning();

  // Also surface CLI-spawned pipelines (started via `npm run pipe`) so the
  // dashboard header badge reflects activity outside the dashboard child.
  let cliActive = null;
  try {
    for (const name of safeReaddir(DEMOS_DIR)) {
      const runDir = path.join(DEMOS_DIR, name);
      try {
        if (!fs.statSync(runDir).isDirectory()) continue;
        const status = pipelineStageState.computeStatus(runDir);
        if (status.activePid) { cliActive = status; break; }
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }

  res.json({
    running: running || !!cliActive,
    source: running ? 'dashboard' : (cliActive ? 'cli' : null),
    pid: running && activeProcess ? activeProcess.pid : (cliActive ? cliActive.activePid : null),
    runId: running ? activePipelineRunId : (cliActive ? cliActive.runId : null),
    runningStage: cliActive ? cliActive.runningStage : null,
    awaitingContinue: cliActive ? cliActive.awaitingContinue : false,
    writesEnabled: DASHBOARD_WRITE_ENABLED,
  });
});

/**
 * Read-only, Claude-consumable stage state for a run.
 * Delegates to scripts/scratch/utils/stage-state.js (single source of truth
 * shared with `npm run pipe -- status --json`).
 */
app.get('/api/runs/:runId/stage-state', (req, res) => {
  try {
    const runDir = getRunDir(req.params.runId);
    if (!fs.existsSync(runDir)) return res.status(404).json({ error: 'Run not found' });
    const status = pipelineStageState.computeStatus(runDir);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline/stdin', (req, res) => {
  if (!DASHBOARD_WRITE_ENABLED) return respondWithCliHint(req, res, 'continue');
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

  const replay = req.query.replay !== '0';
  if (replay) {
    for (const entry of logBuffer) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
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

  watcher.on('add',    p => { invalidateRunsCache(); if (p.endsWith('index.html')) invalidateDemoAppsCache(); send('add', p); });
  watcher.on('change', p => { invalidateRunsCache(); send('change', p); });
  watcher.on('unlink', p => { invalidateRunsCache(); if (p.endsWith('index.html')) invalidateDemoAppsCache(); send('unlink', p); });

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
  if (guardWriteOrStage(req, res, 'script')) return;
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
  if (guardWriteOrStage(req, res, 'script')) return;
  try {
    const { sceneType, description, insertAfterId, useGleanResearch = false } = req.body;
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
    let gleanContext = '';
    if (isSlide && useGleanResearch) {
      try {
        const { gleanChat } = require('../scratch/utils/mcp-clients');
        const query =
          `You are helping generate sales messaging for a Plaid demo slide.\n` +
          `Product: ${product}\n` +
          `Slide request: ${description}\n\n` +
          `Return concise guidance only (no hallucinated stats). Include:\n` +
          `- 2-3 value proof points (phrases a presenter can say)\n` +
          `- any relevant Plaid terminology / endpoint context\n` +
          `- recommended wording for the slide title and narration\n` +
          `Keep it under ~250 words.`;
        gleanContext = await gleanChat(query);
        if (typeof gleanContext === 'string' && gleanContext.length > 0) {
          gleanContext = gleanContext.slice(0, 3000);
        } else {
          gleanContext = '';
        }
      } catch (e) {
        gleanContext = '';
      }
    }

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
${gleanContext ? `\nGLEAN CONTEXT (use as factual inspiration for messaging; do not invent new metrics):\n${gleanContext}` : ''}

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
app.post('/api/runs/:runId/insert-step', async (req, res) => {
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
    stampInsertedStepKindAndMaybeUpgradeBuildMode(dir, step);

    const tmp = scriptPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(script, null, 2), 'utf8');
    fs.renameSync(tmp, scriptPath);

    // For slide-kind steps, generate a build-preview thumbnail so the
    // storyboard card has something to show before the next pipeline run's
    // post-slides stage produces the real content. For library-backed steps
    // we render the imported slide HTML; for custom slides (no library ref)
    // we render a Plaid-styled "pending build" placeholder.
    //
    // Non-slide steps (host / link) are intentionally skipped — they don't
    // get a thumbnail until build-qa actually walks the page.
    let thumbnailResult = { written: [], skipped: true, reason: 'non-slide-step', mode: null };
    const insertedKind = deriveStepKind(step);
    if (insertedKind === 'slide') {
      // If the step references a library slide, look up the entry so the
      // helper can render the imported HTML directly. Otherwise the helper
      // falls through to its placeholder mode.
      let libSlide = null;
      const libRef = step.slideLibraryRef && step.slideLibraryRef.slideId;
      if (libRef) {
        try {
          const libIdx = readSlideLibraryIndex();
          libSlide = (libIdx.slides || []).find(s => s && s.id === libRef) || null;
        } catch (_) {}
      }
      try {
        thumbnailResult = await generateSlideStepThumbnail(dir, step.id, step, libSlide);
      } catch (thumbErr) {
        console.warn(`[InsertStep] Thumbnail generation failed for ${step.id}: ${thumbErr.message}`);
      }
    }

    // Notify any open browser tab for this run that demo-script.json
    // changed. The dashboard's storyboard re-fetches frames as part of
    // loadStoryboard() so the new thumbnail (if any) shows up on next
    // render.
    const runId = String(req.params.runId || '').trim();
    const notify = demoAppReload.notifyReload(runId, {
      reason: 'step-inserted',
      stepId: step.id,
      stepKind: step.stepKind,
    });
    if (notify.notified > 0) {
      console.log(`[InsertStep] Notified ${notify.notified} browser tab(s) to reload (seq=${notify.seq})`);
    }

    res.json({
      ok: true,
      stepId: step.id,
      insertedAt: insertIdx,
      totalSteps: steps.length,
      stepKind: step.stepKind,
      notifiedTabs: notify.notified,
      thumbnailGenerated: thumbnailResult.written.length > 0,
      thumbnailMode: thumbnailResult.mode || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/runs/:runId/insert-library-slide
// body: { slideId, insertAfterId?, narration?, durationMs? }
app.post('/api/runs/:runId/insert-library-slide', async (req, res) => {
  try {
    const runId = String(req.params.runId || '').trim();
    const slideId = String(req.body && req.body.slideId || '').trim();
    const insertAfterId = String(req.body && req.body.insertAfterId || '').trim() || undefined;
    const narrationRaw = req.body && typeof req.body.narration === 'string' ? req.body.narration.trim() : '';
    const durationRaw = Number(req.body && req.body.durationMs);

    if (!slideId) return res.status(400).json({ error: 'slideId required' });
    const index = readSlideLibraryIndex();
    const slide = (index.slides || []).find(s => s && s.id === slideId);
    if (!slide) return res.status(404).json({ error: `Slide "${slideId}" not found` });

    const dir = getRunDir(runId);
    const scriptPath = path.join(dir, 'demo-script.json');
    const script = safeReadJson(scriptPath);
    if (!script || !Array.isArray(script.steps)) return res.status(404).json({ error: 'demo-script.json not found' });
    const steps = script.steps;

    const snap = slide.sourceSnapshot && typeof slide.sourceSnapshot === 'object'
      ? slide.sourceSnapshot
      : {};
    const fallbackNarration = `TODO: Add narration for imported library slide "${slide.name}".`;
    const fallbackDuration = Number(snap.durationMs || 12000);
    const narration = narrationRaw || fallbackNarration;
    const durationMs = Number.isFinite(durationRaw) && durationRaw > 0
      ? Math.round(durationRaw)
      : fallbackDuration;
    const requiresEdit = !narrationRaw || !Number.isFinite(durationRaw) || durationRaw <= 0;

    const preferredId = `library-${slide.name || slide.id}`;
    const nextStepId = makeUniqueStepId(steps, preferredId);
    const label = String(snap.label || slide.name || 'Library Slide').trim().slice(0, 120) || 'Library Slide';
    const sceneType = slide.sceneType === 'demo' ? 'demo' : 'slide';

    const nextStep = {
      id: nextStepId,
      label,
      narration,
      durationMs,
      visualState: snap.visualState || `Imported from slide library: ${slide.name}`,
      plaidPhase: snap.plaidPhase === undefined ? null : snap.plaidPhase,
      sceneType,
      slideLibraryRef: {
        slideId: slide.id,
        name: slide.name,
        htmlPath: slide.htmlPath,
        sourceRunId: slide.sourceRunId,
        sourceStepId: slide.sourceStepId,
      },
      requiresEdit,
    };

    if (snap.interaction && typeof snap.interaction === 'object') {
      nextStep.interaction = snap.interaction;
    }
    if (snap.apiResponse && typeof snap.apiResponse === 'object') {
      nextStep.apiResponse = snap.apiResponse;
    }

    let insertIdx = steps.length;
    if (insertAfterId) {
      const idx = steps.findIndex(s => s && s.id === insertAfterId);
      if (idx >= 0) insertIdx = idx + 1;
    }
    steps.splice(insertIdx, 0, nextStep);
    script.steps = steps;
    stampInsertedStepKindAndMaybeUpgradeBuildMode(dir, nextStep);

    const tmp = scriptPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(script, null, 2), 'utf8');
    fs.renameSync(tmp, scriptPath);

    let thumbnailResult = { written: [] };
    try {
      thumbnailResult = await generateSlideStepThumbnail(dir, nextStepId, nextStep, slide);
    } catch (thumbErr) {
      console.warn(`[SlideLibrary] Thumbnail generation failed for ${runId}/${nextStepId}: ${thumbErr.message}`);
    }

    // Splice the slide's HTML into the running app's index.html so a hot
    // reload of the open browser tab actually SHOWS the new slide. Without
    // this, the slide existed only in demo-script.json until the next
    // pipeline run (post-slides stage). Any failure here is non-fatal —
    // the demo-script.json edit still succeeded.
    let spliceResult = { applied: false, skipped: true, skippedReason: 'not-attempted' };
    try {
      // Pass insertAfterId so the splice helper:
      //   (a) puts the slide div right after the previous step in DOM order
      //       — required for arrow-key + click-anywhere navigation to walk
      //       to the slide as "the next step";
      //   (b) rewires the previous step's primary CTA so clicking that
      //       button lands on the slide instead of skipping past it.
      spliceResult = spliceLibrarySlideIntoRunHtml(dir, nextStepId, slide, { insertAfterId });
      if (spliceResult.applied) {
        console.log(
          `[SlideLibrary] Spliced slide HTML into ${path.relative(PROJECT_ROOT, spliceResult.htmlPath)} ` +
          `(reason: ${spliceResult.reason}, styles: ${spliceResult.stylesInjected || 0}, ` +
          `cta: ${spliceResult.ctaRewired ? 'rewired' : (spliceResult.ctaRewireReason || 'skipped')})`
        );
      } else if (!spliceResult.skipped) {
        console.warn(
          `[SlideLibrary] Splice failed for ${runId}/${nextStepId}: ${spliceResult.reason}`
        );
      }
    } catch (spliceErr) {
      console.warn(`[SlideLibrary] Splice raised: ${spliceErr.message}`);
    }

    // Push a hot-reload event to any open browser tab for this run.
    // Ignored when no tab has subscribed (notified=0).
    const notify = demoAppReload.notifyReload(runId, {
      reason: 'slide-inserted',
      stepId: nextStepId,
      slideId: slide.id,
      slideName: slide.name,
      spliced: !!spliceResult.applied,
    });
    if (notify.notified > 0) {
      console.log(`[SlideLibrary] Notified ${notify.notified} browser tab(s) to reload (seq=${notify.seq})`);
    }

    res.json({
      ok: true,
      step: nextStep,
      insertedAt: insertIdx,
      totalSteps: steps.length,
      thumbnailsWritten: thumbnailResult.written || [],
      htmlSpliced: !!spliceResult.applied,
      htmlSpliceReason: spliceResult.applied ? spliceResult.reason : (spliceResult.skippedReason || spliceResult.reason || null),
      notifiedTabs: notify.notified,
    });
  } catch (err) {
    const msg = err && err.message;
    if (msg && /invalid runid/i.test(msg)) return res.status(400).json({ error: msg });
    res.status(500).json({ error: msg || 'Unknown error' });
  }
});

// POST /api/runs/:runId/remove-step
//
// Remove a slide step from a built demo. By design this endpoint is
// LIMITED to slide-kind steps — host / link / insight scenes are not
// removable through this surface (deleting them would break the demo's
// flow and Plaid Link contract). The "slide" gate uses the canonical
// `deriveStepKind` so it matches `sceneType: 'slide'`, `sceneType: 'insight'`,
// and steps with a `slideLibraryRef`.
//
// What it modifies (atomic-ish; each file is best-effort):
//   1. demo-script.json     — remove the step from steps[]
//   2. scratch-app/index.html (legacy + canonical when both exist)
//                             — strip the <div data-testid="step-<id>"> block
//   3. playwright-script.json — drop any rows whose stepId/id matches
//   4. fires demoAppReload.notifyReload() so any open browser tab refreshes
//
// Returns 400 when the step is non-slide; 404 when the step doesn't exist;
// 500 on filesystem failure mid-flight (with partial-write info in body).
app.post('/api/runs/:runId/remove-step', (req, res) => {
  try {
    const runId = String(req.params.runId || '').trim();
    if (!runId) return res.status(400).json({ error: 'runId required' });
    const stepId = String((req.body && req.body.stepId) || '').trim();
    if (!stepId) return res.status(400).json({ error: 'stepId required' });

    const dir = getRunDir(runId);
    const scriptPath = path.join(dir, 'demo-script.json');
    const script = safeReadJson(scriptPath);
    if (!script || !Array.isArray(script.steps)) {
      return res.status(404).json({ error: 'demo-script.json not found' });
    }

    const idx = script.steps.findIndex(s => s && s.id === stepId);
    if (idx < 0) {
      return res.status(404).json({ error: `Step "${stepId}" not found in demo-script.json` });
    }
    const step = script.steps[idx];
    const kind = deriveStepKind(step);

    // Hard guard: only slide-kind steps are removable here. Sales engineers
    // shouldn't accidentally delete a host or Plaid Link step from the
    // dashboard — those changes need a deliberate edit to demo-script.json
    // (or a fresh pipeline run with an updated prompt.txt).
    if (kind !== 'slide') {
      return res.status(400).json({
        error: `Only slide steps can be removed via this endpoint. ` +
               `Step "${stepId}" has stepKind="${kind}" (sceneType="${step.sceneType || 'host'}"). ` +
               `Edit demo-script.json or rerun the pipeline to change non-slide steps.`,
        stepKind: kind,
        sceneType: step.sceneType || 'host',
      });
    }

    // 1. Remove from demo-script.json (atomic write via tmp+rename).
    script.steps.splice(idx, 1);
    try {
      const tmp = scriptPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(script, null, 2), 'utf8');
      fs.renameSync(tmp, scriptPath);
    } catch (err) {
      return res.status(500).json({ error: `Could not write demo-script.json: ${err.message}` });
    }

    // 2. Strip the step's <div> from index.html (legacy + canonical).
    let htmlResult = { removedFrom: [], notFoundIn: [], skipped: false };
    try { htmlResult = removeStepBlockFromRunHtml(dir, stepId); }
    catch (err) { console.warn(`[RemoveStep] HTML strip failed for ${runId}/${stepId}: ${err.message}`); }

    // 3. Drop any matching rows from playwright-script.json (legacy +
    //    canonical artifact paths). Keep this best-effort — the absence of a
    //    playwright row for a removed step is benign on subsequent runs.
    const playwrightCandidates = [
      path.join(dir, 'scratch-app', 'playwright-script.json'),
      path.join(dir, 'artifacts', 'build', 'scratch-app', 'playwright-script.json'),
    ].filter(p => fs.existsSync(p));
    let playwrightRowsRemoved = 0;
    for (const p of playwrightCandidates) {
      try {
        const ps = safeReadJson(p);
        if (!ps || !Array.isArray(ps.steps)) continue;
        const before = ps.steps.length;
        ps.steps = ps.steps.filter(r => r && (r.stepId !== stepId && r.id !== stepId));
        if (ps.steps.length !== before) {
          playwrightRowsRemoved += (before - ps.steps.length);
          const tmp = p + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(ps, null, 2), 'utf8');
          fs.renameSync(tmp, p);
        }
      } catch (_) { /* per-file best-effort */ }
    }

    // 4. Hot-reload any open browser tab for this run.
    const notify = demoAppReload.notifyReload(runId, {
      reason: 'slide-removed',
      stepId,
      stepKind: kind,
    });
    if (notify.notified > 0) {
      console.log(`[RemoveStep] Notified ${notify.notified} browser tab(s) to reload (seq=${notify.seq})`);
    }

    // Invalidate the AI-edit cache so subsequent /ai-edit calls re-parse
    // the new HTML (and don't operate on stale step blobs).
    try { _appCache.delete(runId); } catch (_) {}

    res.json({
      ok: true,
      removed: { stepId, stepKind: kind, sceneType: step.sceneType || null },
      removedFromHtmlFiles: htmlResult.removedFrom.map(p => path.relative(PROJECT_ROOT, p)),
      htmlSkippedReason: htmlResult.skipped ? htmlResult.skippedReason : null,
      playwrightRowsRemoved,
      totalSteps: script.steps.length,
      notifiedTabs: notify.notified,
    });
  } catch (err) {
    const msg = err && err.message;
    if (msg && /invalid runid/i.test(msg)) return res.status(400).json({ error: msg });
    res.status(500).json({ error: msg || 'Unknown error' });
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
    let runFeedbackPath = null;
    if (runId && typeof runId === 'string' && runId.trim()) {
      try {
        const runDir = getRunDir(runId.trim());
        runFeedbackPath = path.join(runDir, 'build-feedback.md');
        const runTmp = runFeedbackPath + '.tmp';
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(runTmp, content, 'utf8');
        fs.renameSync(runTmp, runFeedbackPath);
      } catch (e) {
        console.warn(`[feedback/export] Could not write run-scoped feedback for ${runId}: ${e.message}`);
      }
    }

    res.json({ ok: true, path: FEEDBACK_FILE, runPath: runFeedbackPath, bytes: content.length });
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
        const compWin = resolveClipCompWindowMs(clip);
        const clipStartMs = compWin.startMs;
        const clipEndMs = compWin.endMs;
        // videoDurationMs = the window the step occupies in the composed timeline
        const videoDurationMs = (clipStartMs != null && clipEndMs != null)
          ? (clipEndMs - clipStartMs)
          : null;
        clipMap[clip.id] = {
          audioDurationMs: clip.audioFile ? clip.audioDurationMs : null,
          videoDurationMs,
          startMs: clipStartMs,
          endMs: clipEndMs,
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
  if (guardWriteOrStage(req, res, 'auto-gap')) return;
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
  if (guardWriteOrStage(req, res, 'ai-suggest-overlays')) return;
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
  if (guardWriteOrStage(req, res, 'ai-suggest-overlays')) return;
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

// Build a slug → [family names] map once per server process so product KB
// entries can advertise which product family actually loads them. Keeps the
// Product Knowledge tab honest about dead-weight files.
let _slugToFamiliesCache = null;
function getSlugToFamiliesMap() {
  if (_slugToFamiliesCache) return _slugToFamiliesCache;
  try {
    const { PRODUCT_FAMILIES } = require('../scratch/utils/product-profiles');
    const map = {};
    for (const [familyKey, profile] of Object.entries(PRODUCT_FAMILIES || {})) {
      for (const slug of (profile.kbSlugs || [])) {
        if (!map[slug]) map[slug] = [];
        if (!map[slug].includes(familyKey)) map[slug].push(familyKey);
      }
    }
    _slugToFamiliesCache = map;
    return map;
  } catch (_) {
    _slugToFamiliesCache = {};
    return _slugToFamiliesCache;
  }
}

function loadedByFamiliesForProductFile(filename) {
  // filename like "plaid-auth.md" → slug "auth". Underscore-prefixed
  // templates intentionally return an empty array.
  const base = String(filename || '').replace(/^products\//, '').replace(/\.md$/i, '');
  const m = base.match(/^plaid-(.+)$/);
  if (!m) return [];
  const slug = m[1].toLowerCase();
  return (getSlugToFamiliesMap()[slug] || []).slice();
}

// Files whose basename starts with `_` are treated as author templates /
// archive notes and are hidden from the dashboard listing. This keeps the
// Product Knowledge tab focused on files the pipeline actually consumes.
function isDashboardHiddenMarkdown(filename) {
  const base = String(filename || '').split('/').pop();
  return base.startsWith('_') || base.startsWith('.');
}

function enrichValuepropListEntry(name, group, fullPath, stat) {
  const content = fs.readFileSync(fullPath, 'utf8');
  const fm = parseFrontmatter(content);
  const { facts } = extractFactsFromMarkdown(content);
  const draftCount = countDraftFacts(facts);
  const { staleDays, staleByAge, staleThresholdDays } = computeStaleness(fm);
  const needsReview = fm.needs_review === 'true' ||
    (fm.last_ai_update && fm.last_human_review && fm.last_ai_update > fm.last_human_review);
  const loadedBy = group === 'products' ? loadedByFamiliesForProductFile(name) : [];
  return {
    name,
    size: stat.size,
    mtime: stat.mtimeMs,
    group,
    frontmatter: fm,
    needsReview,
    draftCount,
    factCount: facts.length,
    newSinceReviewCount: draftCount,
    staleDays,
    staleByAge,
    staleThresholdDays,
    loadedBy,
  };
}

function queuePriorityScore(entry) {
  let s = 0;
  if (entry.needsReview) s += 1000;
  if (entry.staleByAge) s += 200;
  s += Math.min(50, entry.draftCount || 0) * 10;
  s += Math.min(365, entry.staleDays || 0);
  return s;
}

app.get('/api/valueprop/review-queue', (req, res) => {
  try {
    const entries = [];
    for (const f of safeReaddir(INPUTS_DIR).filter(x => x.toLowerCase().endsWith('.md') && !isDashboardHiddenMarkdown(x))) {
      const full = path.join(INPUTS_DIR, f);
      entries.push(enrichValuepropListEntry(f, 'root', full, fs.statSync(full)));
    }
    for (const f of safeReaddir(PRODUCTS_DIR).filter(x => x.toLowerCase().endsWith('.md') && !isDashboardHiddenMarkdown(x))) {
      const full = path.join(PRODUCTS_DIR, f);
      entries.push(enrichValuepropListEntry(`products/${f}`, 'products', full, fs.statSync(full)));
    }
    entries.sort((a, b) => queuePriorityScore(b) - queuePriorityScore(a));
    res.json({ queue: entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/valueprop/list', (req, res) => {
  try {
    const rootFiles = safeReaddir(INPUTS_DIR)
      .filter(f => f.toLowerCase().endsWith('.md') && !isDashboardHiddenMarkdown(f))
      .sort()
      .map(f => {
        const full = path.join(INPUTS_DIR, f);
        return enrichValuepropListEntry(f, 'root', full, fs.statSync(full));
      });

    const productFiles = safeReaddir(PRODUCTS_DIR)
      .filter(f => f.toLowerCase().endsWith('.md') && !isDashboardHiddenMarkdown(f))
      .sort()
      .map(f => {
        const full = path.join(PRODUCTS_DIR, f);
        return enrichValuepropListEntry(`products/${f}`, 'products', full, fs.statSync(full));
      });

    res.json({ files: [...productFiles, ...rootFiles] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DEPRECATED APPROVAL ENDPOINTS ────────────────────────────────────────
// Fact-approval workflow (draft facts, "mark reviewed", bulk approve/reject)
// was removed in 2026-04. Product knowledge is now edit-and-save only;
// freshness is tracked via `last_vp_research` in the per-product MD frontmatter
// (see scripts/scratch/utils/product-vp-freshness.js). These endpoints return
// 410 Gone so any cached client code fails loudly rather than silently.
function respondApprovalDeprecated(res, endpoint) {
  return res.status(410).json({
    error: 'Approval workflow removed — product knowledge is edit-and-save only.',
    deprecatedEndpoint: endpoint,
    hint: 'Use GET/PUT /api/valueprop/:name to read and save markdown directly. Freshness is tracked via `last_vp_research` in the file\'s frontmatter.',
  });
}

app.post('/api/valueprop/review', (req, res) => {
  respondApprovalDeprecated(res, 'POST /api/valueprop/review');
});

app.get('/api/valueprop/:name/facts', (req, res) => {
  respondApprovalDeprecated(res, 'GET /api/valueprop/:name/facts');
});

app.patch('/api/valueprop/:name/facts/:factId', (req, res) => {
  respondApprovalDeprecated(res, 'PATCH /api/valueprop/:name/facts/:factId');
});

app.post('/api/valueprop/:name/facts/bulk', (req, res) => {
  respondApprovalDeprecated(res, 'POST /api/valueprop/:name/facts/bulk');
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
    const runId = String(req.query.runId || '').trim();
    if (!runId) return res.status(400).json({ error: 'runId is required' });
    getRunDir(runId);
    let mp4Ready = false;
    mp4Ready = fs.existsSync(path.join(DEMOS_DIR, runId, 'demo-scratch.mp4'));

    let running = false;
    try {
      const output = execSync('ps aux', { encoding: 'utf8', timeout: 3000 });
      running = output.includes('remotion');
    } catch (_) {
      running = false;
    }

    res.json({ running, mp4Ready, runId });
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
    const runId = String(req.query.runId || '').trim();
    if (!runId) return res.status(400).json({ error: 'runId is required' });
    getRunDir(runId);

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

// Hot-reload bookkeeping for the demo-app preview servers. When the dashboard
// modifies a running app's files (slide insert, AI edit, etc.), we call
// `demoAppReload.notifyReload(runId, …)` to push a `reload` event to every
// open browser tab for that run via the SSE endpoint registered in
// launchDemoAppServer.
const demoAppReload = require(path.join(__dirname, 'utils', 'demo-app-reload.js'));
const {
  spliceLibrarySlideIntoRunHtml,
  removeStepBlockFromRunHtml,
} = require(path.join(__dirname, 'utils', 'insert-slide-html.js'));
const {
  generateSlideStepThumbnail,
  generateLibrarySlideThumbnail,
} = require(path.join(__dirname, 'utils', 'slide-thumbnail.js'));

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

const PLAID_LOGO_FALLBACK_MAP = {
  'plaid-logo-horizontal-black-white-background.png': 'Plaid-Logo horizontal black with white background.png',
  'plaid-logo-horizontal-white-text-transparent-background.png': 'plaid logo horizontal white text transparent background.png',
  'plaid-logo-vertical-white-text-transparent-background.png': 'Plaid vertical logo white text transparent background.png',
  'plaid-logo-text-white-background.png': 'plaid logo text white background.png',
  'plaid-logo-no-text-white-background.png': 'plaid logo no text white background.png',
  'plaid-logo-no-text-black-background.png': 'plaid logo no text black background.png',
};

function resolvePlaidLogoPathForRequest(urlPath, scratchAppDir) {
  const base = path.basename(String(urlPath || ''));
  if (!base || !/^plaid-logo-.*\.(png|jpg|jpeg|svg)$/i.test(base)) return null;
  const assetsDir = path.join(PROJECT_ROOT, 'assets');
  const candidates = [
    path.join(scratchAppDir, base),
    path.join(assetsDir, base),
    path.join(assetsDir, PLAID_LOGO_FALLBACK_MAP[base] || ''),
  ].filter(Boolean);
  for (const fp of candidates) {
    try {
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return fp;
    } catch (_) {
      // best-effort candidate scan
    }
  }
  return null;
}

function tryServePlaidLogoFallback(req, res, scratchAppDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const rawPath = decodeURIComponent(String(req.path || req.url || '').split('?')[0]);
  const resolved = resolvePlaidLogoPathForRequest(rawPath, scratchAppDir);
  if (!resolved) return false;
  res.type(DEMO_MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream');
  res.sendFile(resolved);
  return true;
}

async function launchDemoAppServer(runId) {
  if (demoAppServers.has(runId)) return demoAppServers.get(runId);

  const runDir = path.join(DEMOS_DIR, runId);
  const scratchAppDir = path.join(DEMOS_DIR, runId, 'scratch-app');
  if (!fs.existsSync(path.join(scratchAppDir, 'index.html'))) {
    throw new Error(`No built app found for run: ${runId}`);
  }
  let runClientName = null;
  let runPlaidLinkMode = null;
  try {
    const scriptPath = path.join(runDir, 'demo-script.json');
    if (fs.existsSync(scriptPath)) {
      const parsed = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
      const personaCompany = parsed && parsed.persona && typeof parsed.persona.company === 'string'
        ? parsed.persona.company.trim()
        : '';
      if (personaCompany) runClientName = personaCompany;
      const parsedMode = parsed && typeof parsed.plaidLinkMode === 'string' ? parsed.plaidLinkMode.trim().toLowerCase() : '';
      if (parsedMode === 'embedded' || parsedMode === 'modal') runPlaidLinkMode = parsedMode;
      if (!runPlaidLinkMode) {
        const flowMode = String(parsed?.plaidSandboxConfig?.plaidLinkFlow || '').trim().toLowerCase();
        if (flowMode === 'embedded' || flowMode === 'modal') runPlaidLinkMode = flowMode;
      }
    }
  } catch (_) {}
  if (!runClientName) runClientName = resolveDemoDisplayName(runId, readDemoAppNames());

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

  // Hot-reload SSE endpoint. The injected ai-overlay.js opens an
  // EventSource against this and reloads the page when the dashboard pushes
  // a `reload` event (slide inserted, AI edit applied, etc.).
  // The route is unique per demo-app server (one per runId) and same-origin
  // from the browser's perspective — no CORS shenanigans.
  demoApp.get('/__hot-reload', (req, res) => {
    demoAppReload.addListener(runId, res);
    // addListener handles all writes + cleanup; nothing else to do here.
  });

  // Probe endpoint for clients that want to confirm hot-reload is wired up
  // before opening an EventSource (or for non-EventSource clients to poll).
  demoApp.get('/__hot-reload/seq', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const state = demoAppReload.getState(runId);
    res.end(JSON.stringify({ runId, ...state }));
  });

  // Plaid API proxy routes (only when live mode enabled)
  if (process.env.PLAID_LINK_LIVE === 'true') {
    let _plaid = null;
    const getPlaid = () => { if (!_plaid) _plaid = require('../scratch/utils/plaid-backend'); return _plaid; };
    demoApp.options('/api/*', (req, res) => res.status(204).end());
    demoApp.post('/api/create-link-token', async (req, res) => {
      try {
        const body = req.body || {};
        const products = body.products;
        const isCra = (
          (Array.isArray(products) && products.some((p) => /cra|consumer_report/i.test(String(p)))) ||
          /cra|consumer[_\s-]?report|income[_\s-]?insights|check/i.test(String(body.productFamily || body.product_family || '')) ||
          String(body.credentialScope || body.credential_scope || '').toLowerCase() === 'cra'
        );
        const baseOpts = {
          ...body,
          products:              body.products,
          clientName:            body.clientName || body.client_name || runClientName,
          userId:                body.userId || body.user_id,
          phoneNumber:           body.phoneNumber || body.phone_number || null,
          checkUserIdentity:     body.checkUserIdentity || body.check_user_identity || body.consumer_report_user_identity || null,
          linkCustomizationName: body.linkCustomizationName || body.link_customization_name,
          productFamily:         body.productFamily || body.product_family || null,
          credentialScope:       body.credentialScope || body.credential_scope || null,
          linkMode:              body.linkMode || body.link_mode || runPlaidLinkMode || null,
          runDir:                runDir,
        };
        if (body.plaid_user_id || body.plaidUserId) {
          baseOpts.plaidCheckUserId = body.plaid_user_id || body.plaidUserId;
        }
        if (body.plaid_user_token || body.plaidUserToken) {
          baseOpts.legacyUserToken = body.plaid_user_token || body.plaidUserToken;
        }
        const plaid = getPlaid();
        const result = isCra
          ? await plaid.createConsumerReportLinkToken(baseOpts)
          : await plaid.createLinkToken(baseOpts);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
    demoApp.post('/api/exchange-public-token', async (req, res) => {
      try { res.json(await getPlaid().exchangePublicToken(req.body.public_token, req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
    demoApp.post('/api/auth-get', async (req, res) => {
      try { res.json(await getPlaid().getAuth(req.body.access_token, req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
    demoApp.post('/api/identity-match', async (req, res) => {
      try { res.json(await getPlaid().getIdentityMatch(req.body.access_token, req.body.legal_name, req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
    demoApp.post('/api/signal-evaluate', async (req, res) => {
      try { res.json(await getPlaid().evaluateSignal(req.body.access_token, req.body.account_id, req.body.amount, req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
    demoApp.post('/api/plaid-request', async (req, res) => {
      try { res.json(await getPlaid().plaidRequest(req.body.endpoint, req.body.body || {}, req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
    demoApp.post('/api/create-session-token', async (req, res) => {
      try { res.json(await getPlaid().createSessionToken(req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
    demoApp.post('/api/user-account-session-get', async (req, res) => {
      try { res.json(await getPlaid().userAccountSessionGet(req.body.public_token)); } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }

  // Root — inject overlay globals + script tag
  demoApp.get('/', (req, res) => {
    try {
      let html = fs.readFileSync(path.join(scratchAppDir, 'index.html'), 'utf8');
      const inject = `<script>window.__DEMO_RUN_ID__=${JSON.stringify(runId)};window.__DASHBOARD_ORIGIN__='http://localhost:${PORT}';window.__AI_EDIT_CONFIG__=${JSON.stringify(getAiEditPublicConfig())};</script><script src="/__ai-overlay.js" defer></script>`;
      html = html.includes('</body>') ? html.replace('</body>', inject + '\n</body>') : html + inject;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    } catch (e) { res.status(500).end(`Error: ${e.message}`); }
  });

  // Static files
  demoApp.use((req, res, next) => {
    if (tryServePlaidLogoFallback(req, res, scratchAppDir)) return;
    next();
  });
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

// Cache the expensive directory scan (running status is always live)
let _demoAppsRunIds = null;
let _demoAppsScannedAt = 0;
const DEMO_APPS_CACHE_TTL = 5000; // ms — longer TTL since scratch-app dirs don't change often

function invalidateDemoAppsCache() { _demoAppsRunIds = null; }

app.get('/api/demo-apps', (req, res) => {
  try {
    const namesMap = readDemoAppNames();
    const now = Date.now();
    if (!_demoAppsRunIds || now - _demoAppsScannedAt > DEMO_APPS_CACHE_TTL) {
      _demoAppsRunIds = safeReaddir(DEMOS_DIR)
        .filter(d => {
          try {
            return fs.statSync(path.join(DEMOS_DIR, d)).isDirectory() &&
              fs.existsSync(path.join(DEMOS_DIR, d, 'scratch-app/index.html'));
          } catch (_) { return false; }
        })
        .sort().reverse();
      _demoAppsScannedAt = now;
    }
    // Always reflect live running state (no FS needed)
    const apps = _demoAppsRunIds.map(runId => {
      const qa = getLatestQaReport(runId);
      const buildModeInfo = readRunBuildModeInfo(runId);
      const plaidLinkMode = getRunPlaidLinkMode(runId);
      const owner = getRunOwnerFromManifest(runId);
      const script = getRunScriptSummary(runId);
      const dir = path.join(DEMOS_DIR, runId);
      const promptExists =
        fs.existsSync(path.join(dir, 'inputs', 'prompt.txt')) ||
        fs.existsSync(path.join(dir, 'prompt.txt'));
      return {
        runId,
        displayName: resolveDemoDisplayName(runId, namesMap),
        running: demoAppServers.has(runId),
        url: demoAppServers.get(runId)?.url || null,
        port: demoAppServers.get(runId)?.port || null,
        buildMode: buildModeInfo ? buildModeInfo.buildMode : null,
        buildModeLabel: buildModeInfo ? buildModeInfo.label : null,
        plaidLinkMode,
        qaScore: qa ? qa.overallScore : null,
        qaPassed: qa ? !!qa.passed : null,
        owner,
        source: 'local',
        promptPath: promptExists ? `/api/runs/${encodeURIComponent(runId)}/prompt` : null,
        promptViewerUrl: promptExists ? `/prompt?run=${encodeURIComponent(runId)}` : null,
        script,
      };
    });
    res.json({ apps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/demo-apps/:runId/rename', (req, res) => {
  try {
    const runId = String(req.params.runId || '').trim();
    if (!runId) return res.status(400).json({ error: 'runId required' });
    const runDir = getRunDir(runId);
    const hasApp = fs.existsSync(path.join(runDir, 'scratch-app', 'index.html'));
    if (!hasApp) return res.status(404).json({ error: 'Demo app not found for runId' });

    const input = req.body && typeof req.body.displayName === 'string' ? req.body.displayName : '';
    const next = input.trim().replace(/\s+/g, ' ');
    if (next.length > 120) return res.status(400).json({ error: 'displayName must be 120 chars or fewer' });

    const namesMap = readDemoAppNames();
    if (!next || next === runId) {
      delete namesMap[runId];
    } else {
      namesMap[runId] = next;
    }
    writeDemoAppNames(namesMap);
    invalidateRunsCache();
    invalidateDemoAppsCache();
    res.json({ ok: true, runId, displayName: resolveDemoDisplayName(runId, namesMap) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/demo-apps/:runId/clone', async (req, res) => {
  let allocated = null;
  try {
    const sourceRunId = String(req.params.runId || '').trim();
    if (!sourceRunId) return res.status(400).json({ error: 'runId required' });
    const sourceRunDir = getRunDir(sourceRunId);
    const sourceApp = path.join(sourceRunDir, 'scratch-app', 'index.html');
    if (!fs.existsSync(sourceApp)) return res.status(404).json({ error: 'Demo app not found for runId' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const companyName = normalizeCloneCompanyName(body.companyName);
    const website = normalizeCloneWebsite(body.website);
    if ((companyName || website) && !DASHBOARD_WRITE_ENABLED) {
      return respondWithCliHint(req, res, 'stage', { stage: 'build', runId: sourceRunId });
    }
    if (companyName.length > 120) {
      return res.status(400).json({ error: 'companyName must be 120 chars or fewer' });
    }
    if (website) {
      try {
        const parsed = new URL(website);
        if (!/^https?:$/i.test(parsed.protocol)) {
          return res.status(400).json({ error: 'website must be an http(s) URL' });
        }
      } catch (_) {
        return res.status(400).json({ error: 'website must be a valid URL' });
      }
    }

    allocated = allocateDashboardRunDir();
    fs.cpSync(sourceRunDir, allocated.runDir, { recursive: true, force: true });
    touchClonedRunIdentity(allocated.runDir, allocated.runId, sourceRunId);

    if (companyName || website) {
      const { runBrandClone } = require('../scratch/scratch/brand-clone');
      await runBrandClone({
        runDir: allocated.runDir,
        companyName: companyName || undefined,
        website: website || undefined,
        sourceRunId,
      });
    }

    const namesMap = readDemoAppNames();
    const sourceDisplayName = resolveDemoDisplayName(sourceRunId, namesMap);
    const cloneDisplayName = companyName || `${sourceDisplayName} (Clone)`;
    if (cloneDisplayName && cloneDisplayName !== allocated.runId) {
      namesMap[allocated.runId] = cloneDisplayName;
      writeDemoAppNames(namesMap);
    }

    invalidateRunsCache();
    invalidateDemoAppsCache();
    res.json({
      ok: true,
      runId: allocated.runId,
      displayName: resolveDemoDisplayName(allocated.runId, namesMap),
    });
  } catch (err) {
    if (allocated && allocated.runDir) {
      try {
        fs.rmSync(allocated.runDir, { recursive: true, force: true });
      } catch (_) {
        // best-effort cleanup on failed clone
      }
    }
    res.status(500).json({ error: err.message });
  }
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
    // Close any open hot-reload SSE listeners BEFORE we close the server,
    // otherwise their kept-alive sockets will fight server.close() and
    // delay the response.
    demoAppReload.clearListeners(runId);
    await new Promise((resolve, reject) => entry.server.close(e => e ? reject(e) : resolve()));
    demoAppServers.delete(runId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AI edit helpers ───────────────────────────────────────────────────────────

const CSS_KEYWORDS = /\b(font|color|background|border|radius|padding|margin|size|spacing|shadow|opacity|weight|button|icon|badge|card|text|heading|label|link|hover|gradient|gap|flex|align|justify|width|height|display|transition|animation|cursor|outline|ring|accent|teal|dark|light|bright|bold|italic|rounded|pill|style)\b/i;
const STRUCTURAL_KEYWORDS = /\b(add|remove|delete|insert|create|new step|new screen|move|reorder|rename|duplicate|hide|show step)\b/i;

function readEnvInt(name, fallback, opts = {}) {
  const raw = process.env[name];
  const n = Number.parseInt(String(raw || ''), 10);
  if (!Number.isFinite(n)) return fallback;
  let out = n;
  if (Number.isFinite(opts.min)) out = Math.max(opts.min, out);
  if (Number.isFinite(opts.max)) out = Math.min(opts.max, out);
  return out;
}

function readEnvBool(name, fallback) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

function readEnvString(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  return raw || fallback;
}

function getAiEditRuntimeConfig() {
  const fullMaxTokens = readEnvInt(
    'DASHBOARD_AI_EDIT_MAX_TOKENS_FULL',
    readEnvInt('DASHBOARD_AI_EDIT_FULL_MAX_TOKENS', 20000, { min: 512, max: 64000 }),
    { min: 512, max: 64000 }
  );
  return {
    models: {
      css: readEnvString('DASHBOARD_AI_EDIT_MODEL_CSS', 'claude-haiku-4-5-20251001'),
      elementCss: readEnvString('DASHBOARD_AI_EDIT_MODEL_ELEMENT_CSS', 'claude-haiku-4-5-20251001'),
      element: readEnvString('DASHBOARD_AI_EDIT_MODEL_ELEMENT', 'claude-haiku-4-5-20251001'),
      step: readEnvString('DASHBOARD_AI_EDIT_MODEL_STEP', 'claude-haiku-4-5-20251001'),
      full: readEnvString('DASHBOARD_AI_EDIT_MODEL_FULL', 'claude-opus-4-7'),
    },
    maxTokens: {
      css: readEnvInt('DASHBOARD_AI_EDIT_MAX_TOKENS_CSS', 4000, { min: 256, max: 64000 }),
      elementCss: readEnvInt('DASHBOARD_AI_EDIT_MAX_TOKENS_ELEMENT_CSS', 6000, { min: 256, max: 64000 }),
      element: readEnvInt('DASHBOARD_AI_EDIT_MAX_TOKENS_ELEMENT', 4000, { min: 256, max: 64000 }),
      step: readEnvInt('DASHBOARD_AI_EDIT_MAX_TOKENS_STEP', 8000, { min: 256, max: 64000 }),
      full: fullMaxTokens,
    },
    pickedHtmlMaxChars: readEnvInt('DASHBOARD_AI_EDIT_PICKED_HTML_MAX_CHARS', 2000, { min: 200, max: 30000 }),
    selectedHtmlMaxChars: readEnvInt('DASHBOARD_AI_EDIT_SELECTED_HTML_MAX_CHARS', 1200, { min: 200, max: 30000 }),
    conversation: {
      maxTurns: readEnvInt('DASHBOARD_AI_EDIT_CONVERSATION_MAX_TURNS', 12, { min: 1, max: 80 }),
      maxCharsPerTurn: readEnvInt('DASHBOARD_AI_EDIT_CONVERSATION_MAX_CHARS_PER_TURN', 2000, { min: 100, max: 20000 }),
      maxTotalChars: readEnvInt('DASHBOARD_AI_EDIT_CONVERSATION_MAX_TOTAL_CHARS', 12000, { min: 500, max: 200000 }),
    },
    multiPass: {
      enabled: readEnvBool('DASHBOARD_AI_EDIT_ENABLE_MULTI_PASS', false),
      model: readEnvString('DASHBOARD_AI_EDIT_MULTI_PASS_MODEL', 'claude-haiku-4-5-20251001'),
      maxTokens: readEnvInt('DASHBOARD_AI_EDIT_MULTI_PASS_MAX_TOKENS', 2000, { min: 256, max: 16000 }),
    },
  };
}

function getAiEditPublicConfig() {
  const cfg = getAiEditRuntimeConfig();
  return {
    pickedHtmlMaxChars: cfg.pickedHtmlMaxChars,
    selectedHtmlMaxChars: cfg.selectedHtmlMaxChars,
    conversationMaxTurns: cfg.conversation.maxTurns,
    conversationMaxCharsPerTurn: cfg.conversation.maxCharsPerTurn,
    conversationMaxTotalChars: cfg.conversation.maxTotalChars,
  };
}

function clampSnippet(value, maxChars) {
  if (value == null) return '';
  return String(value).slice(0, maxChars);
}

/**
 * Parse a subset of CSS selectors into an { attr, value, tag? } tuple the
 * deterministic replacer can anchor on. The frontend picker emits any of:
 *   #foo
 *   [data-testid="foo"]
 *   tag#foo                 (e.g. div#foo)
 *   tag[data-testid="foo"]  (e.g. button[data-testid="foo"])
 *   tag.class1.class2       (fallback when no id/testid — needs class anchor)
 * and we prefer the strongest attribute available. Returns null when nothing
 * distinctive can be extracted.
 */
function parseSimpleSelector(selector) {
  const s = String(selector || '').trim();
  if (!s) return null;

  // 1) Pure #id
  let m = s.match(/^([a-zA-Z][a-zA-Z0-9:-]*)?#([A-Za-z_][\w:-]*)$/);
  if (m) return { tag: m[1] || null, attr: 'id', value: m[2] };

  // 2) Pure [attr="value"] OR tag[attr="value"]
  m = s.match(/^([a-zA-Z][a-zA-Z0-9:-]*)?\[([A-Za-z_][\w:-]*)=["']([^"']+)["']\]$/);
  if (m) return { tag: m[1] || null, attr: m[2], value: m[3] };

  // 3) tag.class1.class2 — fall back to anchoring on the FIRST class. This is
  //    weaker than id/testid but gives the regex a distinctive hook when the
  //    picker couldn't find anything stronger.
  m = s.match(/^([a-zA-Z][a-zA-Z0-9:-]*)\.([A-Za-z_][\w-]*)(?:\.[A-Za-z_][\w-]*)*$/);
  if (m) return { tag: m[1], attr: 'class', value: m[2], matchMode: 'class-contains' };

  // 4) Bare .class (no tag) — same as above, weaker still.
  m = s.match(/^\.([A-Za-z_][\w-]*)(?:\.[A-Za-z_][\w-]*)*$/);
  if (m) return { tag: null, attr: 'class', value: m[1], matchMode: 'class-contains' };

  return null;
}

/** HTML5 void elements that have no closing tag. */
const VOID_HTML_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

function countExactOccurrences(haystack, needle) {
  if (!needle) return 0;
  let idx = 0;
  let count = 0;
  while (true) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += Math.max(1, needle.length);
  }
  return count;
}

function buildElementContextBlock(input, maxSnippet) {
  const out = [];
  if (input.selectedElementParentHtml) out.push(`Selected parent HTML:\n${clampSnippet(input.selectedElementParentHtml, maxSnippet)}`);
  if (input.selectedElementContainerHtml) out.push(`Selected container HTML:\n${clampSnippet(input.selectedElementContainerHtml, maxSnippet)}`);
  if (input.selectedElementAttributes && typeof input.selectedElementAttributes === 'object') {
    out.push(`Selected attributes JSON:\n${JSON.stringify(input.selectedElementAttributes, null, 2)}`);
  }
  if (typeof input.selectedElementTextPreview === 'string' && input.selectedElementTextPreview.trim()) {
    out.push(`Selected text preview:\n${clampSnippet(input.selectedElementTextPreview, Math.min(maxSnippet, 1200))}`);
  }
  if (typeof input.domPath === 'string' && input.domPath.trim()) {
    out.push(`DOM path:\n${clampSnippet(input.domPath, 1200)}`);
  }
  return out.join('\n\n');
}

function normalizeConversationHistory(history, cfg) {
  if (!Array.isArray(history)) return [];
  const out = [];
  let totalChars = 0;
  const maxTurns = cfg.conversation.maxTurns;
  const maxPerTurn = cfg.conversation.maxCharsPerTurn;
  const maxTotal = cfg.conversation.maxTotalChars;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
    const content = clampSnippet(turn.content || '', maxPerTurn).trim();
    if (!content) continue;
    if (totalChars + content.length > maxTotal) continue;
    out.unshift({ role: turn.role, content });
    totalChars += content.length;
    if (out.length >= maxTurns) break;
  }
  return out;
}

function applySelectorScopedReplacement(scopeHtml, selector, updatedOuterHtml) {
  const parsed = parseSimpleSelector(selector);
  if (!parsed) return { html: scopeHtml, replaced: false, reason: 'unsupported-selector' };

  const attrEsc  = parsed.attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const valueEsc = parsed.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagPattern = parsed.tag ? parsed.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[a-zA-Z][a-zA-Z0-9:-]*';

  // For class-based selectors the attribute value is a whitespace-separated
  // token list, so match "contains token" (boundary-aware) rather than equality.
  const attrValuePattern = parsed.matchMode === 'class-contains'
    ? `["'][^"']*\\b${valueEsc}\\b[^"']*["']`
    : `["']${valueEsc}["']`;

  // Match BOTH paired elements `<tag ...>...</tag>` AND void elements
  // `<tag ... />` or `<tag ...>`. When the tag is known and is a void element,
  // use the void-only regex; otherwise try paired first, then void as a
  // fallback for generic tag patterns.
  const resolvedTag = parsed.tag ? parsed.tag.toLowerCase() : null;
  const isVoid = resolvedTag && VOID_HTML_ELEMENTS.has(resolvedTag);

  const pairedRe = new RegExp(
    `<(${tagPattern})\\b([^>]*\\s${attrEsc}=${attrValuePattern}[^>]*)>[\\s\\S]*?<\\/\\1>`,
    'g'
  );
  const voidRe = new RegExp(
    `<(${tagPattern})\\b([^>]*\\s${attrEsc}=${attrValuePattern}[^>]*)\\/?>`,
    'g'
  );

  let matches = [];
  if (!isVoid) matches = Array.from(scopeHtml.matchAll(pairedRe));
  if (matches.length === 0) matches = Array.from(scopeHtml.matchAll(voidRe));

  if (matches.length !== 1) {
    return { html: scopeHtml, replaced: false, reason: `selector-matches-${matches.length}` };
  }
  const match = matches[0];
  const start = match.index;
  const end = start + match[0].length;
  return {
    html: scopeHtml.slice(0, start) + updatedOuterHtml + scopeHtml.slice(end),
    replaced: true,
  };
}

/**
 * Collapse HTML whitespace into a canonical form so the browser's
 * outerHTML (which normalises whitespace and attribute quoting) can be
 * matched against the source HTML from disk.
 */
function normalizeHtmlForMatch(html) {
  if (!html) return '';
  return String(html)
    .replace(/\r\n/g, '\n')
    // Collapse runs of whitespace INSIDE tags (attribute separators).
    .replace(/<([^>]+)>/g, (_m, inner) => '<' + inner.replace(/\s+/g, ' ').trim() + '>')
    // Collapse runs of whitespace BETWEEN tags.
    .replace(/>\s+</g, '><')
    // Collapse consecutive whitespace in text content.
    .replace(/[ \t\n\r\f\v]+/g, ' ')
    .trim();
}

/**
 * Find the single occurrence of `selectedElementHtml` in `scopeHtml` using
 * a whitespace/attribute-normalised comparison, and return the byte range in
 * the ORIGINAL scopeHtml so we can splice `updatedOuterHtml` in at that
 * position. Returns null if there isn't exactly one normalised match.
 */
function findNormalizedSingleMatch(scopeHtml, selectedElementHtml) {
  const needle = normalizeHtmlForMatch(selectedElementHtml);
  if (!needle || needle.length < 8) return null;

  // Walk every tag boundary in scopeHtml, normalise the candidate substring
  // that starts there, and compare byte-for-byte against the normalised needle.
  // This avoids having to re-parse the DOM on the server while still tolerating
  // cosmetic whitespace/attribute-ordering drift.
  const candidates = [];
  const tagStartRe = /<[a-zA-Z]/g;
  let m;
  while ((m = tagStartRe.exec(scopeHtml)) !== null) {
    // Bound the candidate length roughly at 2× the needle length so we don't
    // explode work on huge files. Normalised length ratio is close to 1.
    const approxLen = Math.min(scopeHtml.length - m.index, selectedElementHtml.length * 3 + 256);
    const candidate = scopeHtml.slice(m.index, m.index + approxLen);
    // Only keep candidates that start with the same tag name as the needle.
    // Cheap sanity check before the expensive normalisation.
    const needleTag = needle.match(/^<([a-zA-Z][a-zA-Z0-9:-]*)/);
    const candTag   = candidate.match(/^<([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!needleTag || !candTag || needleTag[1].toLowerCase() !== candTag[1].toLowerCase()) continue;

    // Try to grow the candidate until its normalised form equals the needle.
    // In practice one scan works — the candidate either matches or doesn't.
    const normalised = normalizeHtmlForMatch(candidate);
    if (normalised.startsWith(needle)) {
      // Confirm by expanding to the minimum window whose normalised form
      // equals the needle exactly.
      for (let end = Math.min(scopeHtml.length, m.index + Math.ceil(needle.length * 0.9)); end <= m.index + approxLen; end++) {
        const window = scopeHtml.slice(m.index, end);
        const norm = normalizeHtmlForMatch(window);
        if (norm === needle) {
          candidates.push({ start: m.index, end });
          break;
        }
        if (norm.length > needle.length + 8) break; // grew past the target
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function replaceSelectedElementDeterministically(fullHtml, input, updatedOuterHtml) {
  const selectedElementHtml = String(input.selectedElementHtml || '');
  const selectedElementSelector = String(input.selectedElementSelector || '');
  const currentStepId = String(input.currentStepId || '').trim();
  const selectedElementContainerHtml = String(input.selectedElementContainerHtml || '');

  let scopeStart = 0;
  let scopeEnd = fullHtml.length;
  let scopeHtml = fullHtml;

  if (currentStepId) {
    const stepHtml = extractStepHtml(fullHtml, currentStepId);
    if (stepHtml) {
      const idx = fullHtml.indexOf(stepHtml);
      if (idx !== -1) {
        scopeStart = idx;
        scopeEnd = idx + stepHtml.length;
        scopeHtml = stepHtml;
      }
    }
  } else if (selectedElementContainerHtml && fullHtml.includes(selectedElementContainerHtml)) {
    const idx = fullHtml.indexOf(selectedElementContainerHtml);
    scopeStart = idx;
    scopeEnd = idx + selectedElementContainerHtml.length;
    scopeHtml = selectedElementContainerHtml;
  }

  let replaced = false;
  let nextScopeHtml = scopeHtml;
  let reason = 'no-replacement-strategy';

  if (selectedElementSelector) {
    const selectorResult = applySelectorScopedReplacement(scopeHtml, selectedElementSelector, updatedOuterHtml);
    if (selectorResult.replaced) {
      replaced = true;
      nextScopeHtml = selectorResult.html;
    } else {
      reason = selectorResult.reason || reason;
    }
  }

  if (!replaced && selectedElementHtml) {
    const count = countExactOccurrences(scopeHtml, selectedElementHtml);
    if (count === 1) {
      nextScopeHtml = scopeHtml.replace(selectedElementHtml, updatedOuterHtml);
      replaced = true;
    } else {
      reason = `selected-html-matches-${count}`;
    }
  }

  // Final fallback: whitespace/attribute-order normalised match. The browser's
  // outerHTML is serialised from the DOM, which strips comments and normalises
  // attribute quoting + whitespace — so byte-exact matches against the source
  // HTML on disk often miss even when the element is clearly present. This
  // finds the single occurrence by comparing normalised forms.
  if (!replaced && selectedElementHtml) {
    const range = findNormalizedSingleMatch(scopeHtml, selectedElementHtml);
    if (range) {
      nextScopeHtml = scopeHtml.slice(0, range.start) + updatedOuterHtml + scopeHtml.slice(range.end);
      replaced = true;
      reason = 'matched-normalised';
    } else if (reason === 'no-replacement-strategy' || reason.startsWith('unsupported-selector')) {
      reason = 'normalised-match-missing';
    }
  }

  if (!replaced) return { html: fullHtml, valid: false, reason };
  if (scopeStart === 0 && scopeEnd === fullHtml.length) return { html: nextScopeHtml, valid: true };
  return {
    html: fullHtml.slice(0, scopeStart) + nextScopeHtml + fullHtml.slice(scopeEnd),
    valid: true,
  };
}

function validateAiEditHtml(nextHtml, prevHtml, mode, currentStepId) {
  if (typeof nextHtml !== 'string' || !nextHtml.trim()) {
    return { ok: false, reason: 'empty-html' };
  }
  const prevTestIds = (prevHtml.match(/data-testid="/g) || []).length;
  const nextTestIds = (nextHtml.match(/data-testid="/g) || []).length;
  if (nextTestIds === 0) return { ok: false, reason: 'missing-data-testid' };
  if (nextHtml.length < Math.min(1000, prevHtml.length * 0.4)) {
    return { ok: false, reason: 'html-too-small' };
  }
  if (/goToStep\s*=/.test(prevHtml) && !/goToStep\s*=/.test(nextHtml)) {
    return { ok: false, reason: 'missing-goToStep-definition' };
  }
  if (mode !== 'full' && nextTestIds < Math.max(1, Math.floor(prevTestIds * 0.5))) {
    return { ok: false, reason: 'excessive-testid-loss' };
  }
  if (currentStepId && !nextHtml.includes(`data-testid="step-${currentStepId}"`) && mode === 'step') {
    return { ok: false, reason: `missing-step-${currentStepId}` };
  }
  return { ok: true };
}

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

// ── App Index Cache ────────────────────────────────────────────────────────────
// Parsed per-run cache: avoids re-parsing the full HTML on every AI edit request.
// Invalidated when scratch-app/index.html is modified (mtime check).
const _appCache = new Map(); // runId → { mtime, steps, cssRules, allCss, styleBlocks }

function getAppIndex(runId) {
  const htmlPath = path.join(DEMOS_DIR, runId, 'scratch-app', 'index.html');
  if (!fs.existsSync(htmlPath)) return null;
  const mtime = fs.statSync(htmlPath).mtimeMs;
  const cached = _appCache.get(runId);
  if (cached && cached.mtime === mtime) return cached;

  const html = fs.readFileSync(htmlPath, 'utf8');
  const styleBlocks = extractStyleBlocks(html);
  const allCss = styleBlocks.map(b => b.inner).join('\n');

  // Parse CSS into individual rules for per-step filtering
  const cssRules = [];
  let buf = '', depth = 0;
  for (let i = 0; i < allCss.length; i++) {
    buf += allCss[i];
    if (allCss[i] === '{') depth++;
    else if (allCss[i] === '}') {
      depth--;
      if (depth === 0) { cssRules.push(buf.trim()); buf = ''; }
    }
  }

  // Index step divs by ID
  const steps = {};
  for (const m of html.matchAll(/data-testid="step-([^"]+)"/g)) {
    const stepDiv = extractStepHtml(html, m[1]);
    if (stepDiv) steps[m[1]] = stepDiv;
  }

  const index = { mtime, html, steps, cssRules, allCss, styleBlocks };
  _appCache.set(runId, index);
  return index;
}

/** Extract CSS rules relevant to the classes and IDs found in a step's HTML. */
function extractStepCss(cssRules, stepHtml) {
  // Collect all class names and IDs from the step HTML
  const classes = new Set();
  const ids = new Set();
  for (const m of stepHtml.matchAll(/class="([^"]+)"/g))
    m[1].split(/\s+/).forEach(c => c && classes.add(c));
  for (const m of stepHtml.matchAll(/id="([^"]+)"/g))
    ids.add(m[1]);

  // Keep rules whose selector mentions any of those classes or IDs,
  // plus always-relevant rules (*, body, :root, .step, keyframes, variables)
  const always = /^\s*(@keyframes|:root|body|html|\*|\.step[\s{,:])/;
  const relevant = cssRules.filter(rule => {
    const sel = rule.slice(0, rule.indexOf('{'));
    if (always.test(rule)) return true;
    for (const c of classes) if (sel.includes('.' + c) || sel.includes(c)) return true;
    for (const id of ids)   if (sel.includes('#' + id)) return true;
    return false;
  });
  return relevant.join('\n');
}

/** Extract a single step div from the full HTML by its step ID. */
function extractStepHtml(html, stepId) {
  const marker = `data-testid="step-${stepId}"`;
  const markerPos = html.indexOf(marker);
  if (markerPos === -1) return null;
  // Walk back from the marker to find the opening <div
  const divStart = html.lastIndexOf('<div', markerPos);
  if (divStart === -1) return null;
  // Walk forward counting div depth to find the matching </div>
  let depth = 0, i = divStart;
  while (i < html.length) {
    if (html[i] === '<') {
      if (html.slice(i, i + 4) === '<div') { depth++; i += 4; continue; }
      if (html.slice(i, i + 6) === '</div>') {
        depth--;
        if (depth === 0) return html.slice(divStart, i + 6);
        i += 6; continue;
      }
    }
    i++;
  }
  return null;
}

/** Replace a step div in the full HTML with updated HTML. */
function spliceStepHtml(fullHtml, stepId, newStepHtml) {
  const old = extractStepHtml(fullHtml, stepId);
  if (!old) return { html: fullHtml, valid: false };
  return { html: fullHtml.replace(old, newStepHtml), valid: true };
}

function loadStandaloneLibraryStepPayload(step) {
  const ref = step && step.slideLibraryRef && typeof step.slideLibraryRef === 'object'
    ? step.slideLibraryRef
    : null;
  if (!ref || !ref.htmlPath) return null;
  const htmlAbs = path.resolve(PROJECT_ROOT, ref.htmlPath);
  if (!htmlAbs.startsWith(SLIDE_LIBRARY_DIR + path.sep)) return null;
  if (!fs.existsSync(htmlAbs)) return null;
  const sourceHtml = fs.readFileSync(htmlAbs, 'utf8');
  const sourceStepId = String(ref.sourceStepId || '').trim() || extractFirstStepIdFromHtml(sourceHtml);
  if (!sourceStepId) return null;
  const extracted = extractStepHtml(sourceHtml, sourceStepId);
  if (!extracted) return null;
  let patched = extracted.replace(/data-testid=["']step-[^"']+["']/i, `data-testid="step-${step.id}"`);
  if (!/\bclass=["'][^"']*\bstep\b/i.test(patched)) {
    patched = patched.replace(/<div\b/i, '<div class="step"');
  }
  const styles = extractInlineStylesFromHtml(sourceHtml);
  return {
    stepHtml: patched,
    styles,
    slideId: String(ref.slideId || '').trim(),
  };
}

function injectMissingStoryboardLibrarySteps(runDir, html, script) {
  if (!html || !script || !Array.isArray(script.steps)) return html;
  const missingStepHtml = [];
  const styleBlocks = [];
  const seenSlides = new Set();
  for (const step of script.steps) {
    if (!step || !step.id) continue;
    if (!step.slideLibraryRef || typeof step.slideLibraryRef !== 'object') continue;
    const marker = `data-testid="step-${step.id}"`;
    if (html.includes(marker)) continue;
    const loaded = loadStandaloneLibraryStepPayload(step);
    if (loaded && loaded.stepHtml) {
      missingStepHtml.push(loaded.stepHtml);
      const slideKey = loaded.slideId || step.id;
      if (!seenSlides.has(slideKey) && Array.isArray(loaded.styles) && loaded.styles.length) {
        seenSlides.add(slideKey);
        styleBlocks.push(...loaded.styles);
      }
    }
  }
  if (!missingStepHtml.length && !styleBlocks.length) return html;
  if (styleBlocks.length) {
    const styleTag = `<style id="storyboard-library-inline-styles">${styleBlocks.join('\n\n')}</style>`;
    html = html.replace(/<style id="storyboard-library-inline-styles"[\s\S]*?<\/style>\s*/i, '');
    if (html.includes('</head>')) html = html.replace('</head>', `${styleTag}\n</head>`);
    else html = styleTag + '\n' + html;
  }
  if (!missingStepHtml.length) return html;
  const block = `\n<!-- storyboard-library-inserted-steps -->\n${missingStepHtml.join('\n')}\n`;
  if (html.includes('</body>')) return html.replace('</body>', `${block}</body>`);
  return html + block;
}

// generateLibraryStepThumbnailsForRun was moved to scripts/dashboard/utils/slide-thumbnail.js
// as generateLibrarySlideThumbnail (and generalized to generateSlideStepThumbnail
// which also handles custom-slide placeholders for steps inserted via
// /api/runs/:runId/insert-step). See that module for the canonical
// implementation.

app.post('/api/demo-apps/:runId/ai-edit', async (req, res) => {
  if (guardWriteOrStage(req, res, 'build')) return;
  try {
    const { runId } = req.params;
    const {
      message,
      selectedElementHtml,
      selectedElementSelector,
      selectedElementParentHtml,
      selectedElementContainerHtml,
      selectedElementAttributes,
      selectedElementTextPreview,
      domPath,
      conversationHistory,
      currentStepId,
    } = req.body || {};
    const appHtmlPath = path.join(DEMOS_DIR, runId, 'scratch-app/index.html');
    if (!fs.existsSync(appHtmlPath)) return res.status(404).json({ error: 'App HTML not found' });

    const appIndex = getAppIndex(runId);
    if (!appIndex) return res.status(404).json({ error: 'App HTML not found' });
    const currentHtml = appIndex.html;
    const { allCss, styleBlocks, cssRules } = appIndex;

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const mode = detectEditMode(message, selectedElementHtml);
    const cfg = getAiEditRuntimeConfig();
    const modeModel = {
      css: cfg.models.css,
      'element-css': cfg.models.elementCss,
      element: cfg.models.element,
      step: cfg.models.step,
      full: cfg.models.full,
    };
    const modeMaxTokens = {
      css: cfg.maxTokens.css,
      'element-css': cfg.maxTokens.elementCss,
      element: cfg.maxTokens.element,
      step: cfg.maxTokens.step,
      full: cfg.maxTokens.full,
    };
    const snippetCap = cfg.selectedHtmlMaxChars;
    const contextBlock = buildElementContextBlock(
      {
        selectedElementParentHtml,
        selectedElementContainerHtml,
        selectedElementAttributes,
        selectedElementTextPreview,
        domPath,
      },
      snippetCap
    );

    let systemPrompt, userContent, maxTokens, responseHandler;

    if (mode === 'css') {
      // Send only CSS — Claude returns only updated CSS
      systemPrompt = `You are editing the CSS of a Plaid demo app.
Design system: background #0d1117, accent #00A67E (teal), text #ffffff.
Respond with ONLY the raw updated CSS content — no <style> tags, no HTML, no explanation.`;
      userContent = `Request: ${message}\n\nCurrent CSS:\n${allCss}`;
      maxTokens = modeMaxTokens.css;
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
        `Selected element: ${clampSnippet(selectedElementHtml, snippetCap)}`,
        selectedElementSelector ? `Selector: ${selectedElementSelector}` : '',
        contextBlock || '',
        `Request: ${message}`,
        `\nRelevant CSS:\n${relevantCss}`,
        `\nFull CSS (for reference — return the full updated version):\n${allCss}`,
      ].filter(Boolean).join('\n\n');
      maxTokens = modeMaxTokens['element-css'];
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
        `Element to edit:\n${clampSnippet(selectedElementHtml, snippetCap)}`,
        selectedElementSelector ? `Selector: ${selectedElementSelector}` : '',
        contextBlock || '',
        `Request: ${message}`,
        `\nRelevant CSS for context:\n${relevantCss}`,
      ].filter(Boolean).join('\n\n');
      maxTokens = modeMaxTokens.element;
      responseHandler = (text) => {
        const updated = text.trim();
        const result = replaceSelectedElementDeterministically(currentHtml, {
          selectedElementHtml,
          selectedElementSelector,
          selectedElementContainerHtml,
          currentStepId,
        }, updated);
        return {
          newHtml: result.valid ? result.html : currentHtml,
          valid: !!result.valid,
          reason: result.reason || null,
        };
      };

    } else if (currentStepId) {
      // Step mode — send only the active step div + filtered CSS (rules used by this step only)
      const stepHtml = appIndex.steps[currentStepId] || extractStepHtml(currentHtml, currentStepId);
      if (!stepHtml) return res.status(400).json({ error: `Step "${currentStepId}" not found in app HTML` });
      const filteredCss = extractStepCss(cssRules, stepHtml);

      systemPrompt = `You are editing a single step screen in a Plaid demo web app.
The app shows one step at a time via goToStep(). You are given ONLY the HTML for the currently visible step and the CSS rules that apply to it.
Design system: background #0d1117, accent #00A67E (teal), text #ffffff.
Respond with ONLY the updated outer HTML of the step div — preserve its data-testid, class="step", and all data-testid attributes on child elements.
Do not include <html>, <body>, <style>, or <script> tags. No explanation.`;
      userContent = [
        selectedElementHtml ? `Selected element:\n${clampSnippet(selectedElementHtml, snippetCap)}` : '',
        selectedElementSelector ? `Selector: ${selectedElementSelector}` : '',
        contextBlock || '',
        `Request: ${message}`,
        `\nCurrent step HTML (step id="${currentStepId}"):\n${stepHtml}`,
        `\nCSS rules for this step:\n${filteredCss}`,
      ].filter(Boolean).join('\n\n');
      maxTokens = modeMaxTokens.step;
      responseHandler = (text) => {
        const updated = text.trim();
        const { html: newHtml, valid } = spliceStepHtml(currentHtml, currentStepId, updated);
        return { newHtml, valid };
      };

    } else {
      // Full mode — send entire HTML (fallback when no step context available)
      systemPrompt = `You are an expert frontend developer editing a Plaid demo web application.
The app is a single-file HTML demo showing a Plaid product flow.
Respond with ONLY the complete updated HTML — no explanation, no markdown fences.
Design system: background #0d1117, accent #00A67E (teal), text #ffffff.
Preserve all data-testid attributes, goToStep, getCurrentStep, and step navigation.`;
      userContent = [
        selectedElementHtml ? `Selected element:\n${clampSnippet(selectedElementHtml, snippetCap)}` : '',
        selectedElementSelector ? `Selector: ${selectedElementSelector}` : '',
        contextBlock || '',
        `Request: ${message}`,
        `\nCurrent HTML:\n${currentHtml}`,
      ].filter(Boolean).join('\n\n');
      maxTokens = modeMaxTokens.full;
      responseHandler = (text) => {
        const newHtml = text.trim();
        const valid = newHtml.includes('<html') || newHtml.includes('<!DOCTYPE') || newHtml.includes('<body');
        return { newHtml, valid };
      };
    }

    // Build message list (lightweight history only)
    const messages = normalizeConversationHistory(conversationHistory, cfg);

    let multiPassPlan = null;
    const shouldMultiPass = cfg.multiPass.enabled && (mode === 'element' || mode === 'step' || mode === 'full');
    if (shouldMultiPass) {
      const planner = await client.messages.create({
        model: cfg.multiPass.model,
        max_tokens: cfg.multiPass.maxTokens,
        system: 'You are planning an HTML/CSS edit. Return concise JSON with keys: changePlan (array of short steps), risks (array), preserve (array). Return JSON only.',
        messages: [
          {
            role: 'user',
            content: [
              `Mode: ${mode}`,
              `Request: ${message}`,
              selectedElementSelector ? `Selector: ${selectedElementSelector}` : '',
              currentStepId ? `Step: ${currentStepId}` : '',
            ].filter(Boolean).join('\n'),
          },
        ],
      });
      multiPassPlan = planner && planner.content && planner.content[0] && planner.content[0].text
        ? String(planner.content[0].text).trim()
        : null;
      if (multiPassPlan) {
        userContent = `${userContent}\n\nPre-plan (follow strictly):\n${multiPassPlan}`;
      }
    }
    messages.push({ role: 'user', content: userContent });

    const model = modeModel[mode] || cfg.models.full;
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

    const handled = responseHandler(response.content[0].text);
    const newHtml = handled.newHtml;
    const valid = !!handled.valid;

    if (!valid) {
      const reason = handled.reason || null;
      console.warn(`[AI Edit] Could not apply response cleanly: mode=${mode} reason=${reason} run=${runId}`);
      // Human-readable hint per known failure mode so the user can self-correct
      // instead of just seeing a generic error.
      const hints = {
        'unsupported-selector':       'The selected element has no stable anchor (id/data-testid/class). Pick a parent container with a data-testid, or switch to Step mode.',
        'selector-matches-0':         'The selector didn\'t match anything in the current HTML — the app may have been edited since you picked. Re-pick the element.',
        'normalised-match-missing':   'The picked element couldn\'t be located in the source HTML. Re-pick a parent container with a data-testid, or switch to Step mode.',
        'no-replacement-strategy':    'No element context was provided. Pick an element first (use the picker icon), or switch to Step mode.',
      };
      const hint = reason && /^selected-html-matches-\d+$/.test(reason)
        ? `${reason.endsWith('-0') ? 'The picked element isn\'t in the HTML source (whitespace mismatch handled as fallback, but still missed).' : 'The picked HTML appears multiple times — pick a more unique parent with a data-testid.'}`
        : (hints[reason] || null);
      return res.status(500).json({
        error: 'AI response could not be applied cleanly',
        mode,
        reason,
        hint,
        preview: response.content[0].text.slice(0, 300),
      });
    }

    const validation = validateAiEditHtml(newHtml, currentHtml, mode, currentStepId);
    if (!validation.ok) {
      return res.status(500).json({
        error: `AI edit validation failed: ${validation.reason}`,
        mode,
      });
    }

    // Backup before overwriting; invalidate cache so next request re-parses
    fs.writeFileSync(appHtmlPath + '.bak', currentHtml, 'utf8');
    fs.writeFileSync(appHtmlPath, newHtml, 'utf8');
    _appCache.delete(runId);

    // Push a hot-reload event to any open browser tab for this run.
    const notify = demoAppReload.notifyReload(runId, {
      reason: 'ai-edit',
      mode,
    });
    if (notify.notified > 0) {
      console.log(`[AI Edit] Notified ${notify.notified} browser tab(s) to reload (seq=${notify.seq})`);
    }

    res.json({
      ok: true,
      reply: `Done (${mode} mode) — changes written.`,
      assistantMessage: `Applied ${mode} edit${multiPassPlan ? ' with multi-pass planning' : ''}.`,
      notifiedTabs: notify.notified,
    });
  } catch (err) {
    console.error('[AI Edit]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Timeline editor page ──────────────────────────────────────────────────────

app.get('/timeline', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'timeline.html'));
});

app.get('/prompt', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'prompt-viewer.html'));
});

function resolveArtifactDirForDashboard() {
  return (process.env.PLAID_DEMO_APPS_DIR && process.env.PLAID_DEMO_APPS_DIR.trim())
    || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.plaid-demo-apps');
}

function readRemotePublishedApps() {
  const base = resolveArtifactDirForDashboard();
  const demosRoot = path.join(base, 'demos');
  const out = [];
  if (!fs.existsSync(demosRoot)) return out;
  let users;
  try { users = fs.readdirSync(demosRoot); } catch (_) { return out; }
  for (const userLogin of users) {
    const userDir = path.join(demosRoot, userLogin);
    let stat;
    try { stat = fs.statSync(userDir); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    let runs;
    try { runs = fs.readdirSync(userDir); } catch (_) { continue; }
    for (const runId of runs) {
      const runPath = path.join(userDir, runId);
      const manifestPath = path.join(runPath, 'PUBLISH_MANIFEST.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = safeReadJson(manifestPath);
      if (!manifest) continue;
      out.push({
        runId,
        displayName: manifest.runId || runId,
        source: 'remote',
        owner: manifest.owner || { login: userLogin, name: null },
        buildMode: manifest.buildMode || null,
        plaidLinkMode: manifest.plaidLinkMode || null,
        qaScore: manifest.qaScore != null ? manifest.qaScore : null,
        publishedAt: manifest.publishedAt || null,
        localPath: runPath,
      });
    }
  }
  return out;
}

app.post('/api/demo-apps/:runId/publish', async (req, res) => {
  if (guardWriteOrStage(req, res, 'publish')) return;
  try {
    const runId = String(req.params.runId || '').trim();
    if (!runId) return res.status(400).json({ error: 'runId required' });
    const runDir = getRunDir(runId);
    const identity = resolveDashIdentity({ refresh: false });
    if (!identity) return res.status(400).json({ error: 'Identity not resolved — run `pipe whoami`.' });
    const artifactDir = resolveArtifactDirForDashboard();
    if (!fs.existsSync(artifactDir)) {
      return res.status(400).json({ error: `Artifact clone not found at ${artifactDir}. Run \`pipe pull\` first.` });
    }
    const { publishPackage } = require('../scratch/utils/run-package');
    const destDir = path.join(artifactDir, 'demos', identity.login, runId);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = publishPackage({
      runDir,
      destDir,
      owner: { login: identity.login, name: identity.name || null },
      includePrompt: !!body.includePrompt,
      overwrite: true,
      notes: typeof body.notes === 'string' ? body.notes : null,
    });
    res.json({ ok: true, destDir: result.destDir, manifest: result.manifest, files: result.files.length });
  } catch (err) {
    if (err && err.code === 'PUBLISH_BLOCKED_SECRET') {
      return res.status(409).json({ error: err.message, findings: err.findings });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/remote-demo-apps', (req, res) => {
  try {
    res.json({ apps: readRemotePublishedApps(), artifactDir: resolveArtifactDirForDashboard() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/identity', (req, res) => {
  try {
    const id = resolveDashIdentity({ refresh: !!req.query.refresh });
    if (!id) {
      return res.json({
        resolved: false,
        hint: 'Run `gh auth login` or set PLAID_DEMO_USER to enable publishing.',
      });
    }
    res.json({ resolved: true, login: id.login, name: id.name || null, source: id.source });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:runId/prompt', (req, res) => {
  try {
    const runId = String(req.params.runId || '').trim();
    if (!runId) return res.status(400).json({ error: 'runId required' });
    const dir = getRunDir(runId);
    const candidates = [
      path.join(dir, 'inputs', 'prompt.txt'),
      path.join(dir, 'prompt.txt'),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) return res.status(404).json({ error: 'prompt.txt not found for run' });
    const text = fs.readFileSync(found, 'utf8');
    const displayName = resolveDemoDisplayName(runId, readDemoAppNames());
    res.json({
      runId,
      displayName,
      text,
      relativePath: path.relative(dir, found),
      bytes: Buffer.byteLength(text, 'utf8'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
          id:               t.step || t.id,
          recordingOffsetS: t.recordingOffsetS ?? (t.processedStartMs != null ? t.processedStartMs / 1000 : undefined),
          durationS:        t.durationS ?? (t.processedStartMs != null && t.processedEndMs != null ? (t.processedEndMs - t.processedStartMs) / 1000 : null),
        }));
      } else if (timingData.steps && Array.isArray(timingData.steps)) {
        timingSteps = timingData.steps.map(t => ({
          id:               t.id || t.step,
          recordingOffsetS: t.recordingOffsetS ?? (t.processedStartMs != null ? t.processedStartMs / 1000 : undefined),
          durationS:        t.durationS ?? (t.processedStartMs != null && t.processedEndMs != null ? (t.processedEndMs - t.processedStartMs) / 1000 : null),
        }));
      }
    }

    // processed-step-timing.json may only include keepRanges/plaidStepWindows (no steps[]).
    // Fall back to raw step-timing.json so timeline rows still get per-step video windows.
    if ((!timingSteps || timingSteps.length === 0) && fs.existsSync(rawTimingPath)) {
      const rawTiming = safeReadJson(rawTimingPath);
      if (rawTiming && Array.isArray(rawTiming.steps)) {
        timingSteps = rawTiming.steps.map(t => ({
          id:               t.id || t.step,
          recordingOffsetS: t.startMs != null ? t.startMs / 1000 : t.recordingOffsetS,
          durationS:        t.durationMs != null ? t.durationMs / 1000 : t.durationS,
        }));
        if (timingSource === 'processed') timingSource = 'processed+raw-fallback';
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
        if (!cur.id) continue;
        if (!timingMap[cur.id]) {
          timingMap[cur.id] = { videoStart, videoEnd };
        } else {
          // Some recordings contain duplicate timing rows for a step ID (e.g. multi-row
          // Playwright scripts). Timeline editor should use the full visible envelope.
          const prev = timingMap[cur.id];
          const nextStart = Number.isFinite(videoStart) ? videoStart : prev.videoStart;
          const mergedStart = Number.isFinite(prev.videoStart)
            ? Math.min(prev.videoStart, nextStart)
            : nextStart;
          let mergedEnd = prev.videoEnd;
          if (Number.isFinite(videoEnd)) {
            mergedEnd = Number.isFinite(prev.videoEnd)
              ? Math.max(prev.videoEnd, videoEnd)
              : videoEnd;
          }
          timingMap[cur.id] = { videoStart: mergedStart, videoEnd: mergedEnd };
        }
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
        const dur = clip.durationMs != null ? clip.durationMs / 1000
          : clip.audioDurationMs != null ? clip.audioDurationMs / 1000 : null;
        const compWin = resolveClipCompWindowMs(clip);
        if (id && dur != null) {
          narrationMap[id] = {
            durationS: dur,
            startMs: compWin.startMs,
            endMs: compWin.endMs,
          };
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

    // 4b. Optional persisted narration offsets from timeline editor
    const narrationOffsetsPath = path.join(dir, 'narration-offsets.json');
    const narrationOffsetsRaw = safeReadJson(narrationOffsetsPath);
    const narrationOffsetByStep = {};
    if (Array.isArray(narrationOffsetsRaw)) {
      for (const row of narrationOffsetsRaw) {
        if (!row || !row.stepId) continue;
        const v = Number(row.narrationOffset);
        if (!Number.isFinite(v)) continue;
        narrationOffsetByStep[row.stepId] = v;
      }
    }

    // 5. Timing contract (optional)
    const timingContract = loadTimingContract(dir);
    const contractMap = {};
    if (timingContract && Array.isArray(timingContract.steps)) {
      for (const row of timingContract.steps) {
        if (!row || !row.stepId) continue;
        contractMap[row.stepId] = row;
      }
    }

    // 6. Build output steps array
    const outSteps = script.steps.map(step => {
      const timing    = timingMap[step.id] || {};
      const narration = narrationMap[step.id] || {};
      // Single source-of-truth alignment:
      // - storyboard owns narration text in demo-script.json
      // - audio files may lag behind after text edits
      // Use max(manifestDuration, estimatedDurationFromText) so timeline/autosync
      // reflects latest narration intent even before voiceover regeneration.
      const estimatedNarrationS = estimateNarrationMs(step.narration || '') / 1000;
      const manifestNarrationS = narration.durationS != null ? Number(narration.durationS) : 0;
      const resolvedNarrationS = Math.max(manifestNarrationS, estimatedNarrationS);
      const contract  = contractMap[step.id] || null;

      const persistedNarrationOffset = Object.prototype.hasOwnProperty.call(narrationOffsetByStep, step.id)
        ? narrationOffsetByStep[step.id]
        : null;

      return {
        id:              step.id,
        label:           step.label || step.id,
        narration:       step.narration || '',
        videoStart:      timing.videoStart   ?? null,
        videoEnd:        timing.videoEnd     ?? null,
        narrationDur:    resolvedNarrationS || 0,
        // Absolute position of this audio clip in the composition timeline
        // When persisted timeline offsets exist, prefer relative offset mode.
        narrationCompStart: persistedNarrationOffset != null
          ? null
          : (narration.startMs != null ? narration.startMs / 1000 : null),
        narrationOffset: persistedNarrationOffset != null ? persistedNarrationOffset : 0,
        timingContract: contract ? {
          targetCompDurationMs: contract.targetCompDurationMs ?? null,
          actualCompDurationMs: contract.actualCompDurationMs ?? null,
          deltaMs: contract.deltaMs ?? null,
          status: contract.status || null,
          isPlaidLink: contract.isPlaidLink === true,
          plaidLinkPolicy: contract.plaidLinkPolicy || null,
        } : null,
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
      timingContractSummary: timingContract?.summary || null,
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
    const { segments, narrationOffsets, timelineSync } = req.body || {};
    if (!Array.isArray(segments)) {
      return res.status(400).json({ error: 'segments array is required' });
    }

    const dir       = getRunDir(req.params.runId);
    const syncPath  = path.join(dir, 'sync-map.json');
    const narrationOffsetsPath = path.join(dir, 'narration-offsets.json');
    const timelineSyncPath = path.join(dir, 'timeline-sync-status.json');

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

    // Keep _autoGap entries only when they don't overlap edited/manual segments.
    // If an edit overlaps an auto-gap segment, edited value should win.
    const overlaps = (a, b) =>
      Number(a.compStart) < Number(b.compEnd) && Number(a.compEnd) > Number(b.compStart);
    const autoGapSegs = (existing.segments || []).filter((s) => {
      if (s._autoGap !== true) return false;
      return !segments.some((m) => overlaps(s, m));
    });

    // Validate incoming segments (basic sanity)
    for (const seg of segments) {
      if (seg.compStart == null || seg.compEnd == null || seg.compEnd <= seg.compStart) {
        return res.status(400).json({
          error: `Invalid segment: compStart=${seg.compStart} compEnd=${seg.compEnd}`,
        });
      }
    }

    // Validate optional narration offsets payload
    if (narrationOffsets != null && !Array.isArray(narrationOffsets)) {
      return res.status(400).json({ error: 'narrationOffsets must be an array when provided' });
    }
    const cleanNarrationOffsets = [];
    for (const row of (narrationOffsets || [])) {
      if (!row || typeof row.stepId !== 'string' || !row.stepId.trim()) continue;
      const off = Number(row.narrationOffset);
      if (!Number.isFinite(off)) continue;
      cleanNarrationOffsets.push({
        stepId: row.stepId,
        narrationOffset: Math.round(off * 1000) / 1000,
      });
    }

    let cleanTimelineSync = null;
    if (timelineSync && typeof timelineSync === 'object') {
      const checkedAt = timelineSync.checkedAt || new Date().toISOString();
      const hasSyncIssues = timelineSync.hasSyncIssues === true;
      const mismatchedCount = Number.isFinite(Number(timelineSync.mismatchedCount))
        ? Math.max(0, Number(timelineSync.mismatchedCount))
        : 0;
      const maxDeltaS = Number.isFinite(Number(timelineSync.maxDeltaS))
        ? Math.max(0, Number(timelineSync.maxDeltaS))
        : 0;
      cleanTimelineSync = {
        checkedAt,
        hasSyncIssues,
        mismatchedCount,
        maxDeltaS: Number(maxDeltaS.toFixed(3)),
      };
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

    if (cleanNarrationOffsets.length > 0) {
      const tmpOffsets = narrationOffsetsPath + '.tmp';
      fs.writeFileSync(tmpOffsets, JSON.stringify(cleanNarrationOffsets, null, 2), 'utf8');
      fs.renameSync(tmpOffsets, narrationOffsetsPath);
    }

    if (cleanTimelineSync) {
      const tmpTimelineSync = timelineSyncPath + '.tmp';
      fs.writeFileSync(tmpTimelineSync, JSON.stringify(cleanTimelineSync, null, 2), 'utf8');
      fs.renameSync(tmpTimelineSync, timelineSyncPath);
    }

    res.json({
      ok: true,
      count: segments.length,
      narrationOffsetsCount: cleanNarrationOffsets.length,
      timelineSyncSaved: !!cleanTimelineSync,
    });
  } catch (err) {
    console.error('[sync-map-update]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Demo app preview with AI overlay injection ────────────────────────────────

app.get('/demo-app-preview/:runId', (req, res) => {
  let runDir;
  try {
    runDir = getRunDir(req.params.runId);
  } catch (e) {
    return res.status(400).send('Invalid runId');
  }
  const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return res.status(404).send('<html><body style="background:#0d1117;color:#fff;font-family:sans-serif;padding:40px"><h2>App not built for this run.</h2><p>Complete the <strong>build</strong> stage first.</p></body></html>');
  }
  let html = fs.readFileSync(htmlPath, 'utf8');
  const runId = req.params.runId;
  const scriptPath = path.join(runDir, 'demo-script.json');
  const script = fs.existsSync(scriptPath) ? safeReadJson(scriptPath) : null;
  if (script && Array.isArray(script.steps)) {
    html = injectMissingStoryboardLibrarySteps(runDir, html, script);
    html = injectNarrationStoreIntoHtml(html, script.steps);
  }
  // Inject the variables ai-overlay.js expects, then load the script
  html = html.replace('</body>',
    `<script>window.__DEMO_RUN_ID__ = ${JSON.stringify(runId)}; window.__DASHBOARD_ORIGIN__ = 'http://localhost:${PORT}'; window.__AI_EDIT_CONFIG__ = ${JSON.stringify(getAiEditPublicConfig())};</script>\n` +
    `<script src="/static/ai-overlay.js"></script>\n</body>`);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ── Start server ──────────────────────────────────────────────────────────────

app.listen(PORT, '::', () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
