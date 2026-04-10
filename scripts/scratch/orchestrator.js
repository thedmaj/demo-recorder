#!/usr/bin/env node
/**
 * orchestrator.js
 * Governing agent for the Plaid demo pipeline.
 * Reads inputs/prompt.txt → determines mode → drives all pipeline stages.
 *
 * Usage:
 *   node scripts/scratch/orchestrator.js              # auto-detect mode from prompt
 *   node scripts/scratch/orchestrator.js --mode=scratch
 *   node scripts/scratch/orchestrator.js --mode=enhance
 *   node scripts/scratch/orchestrator.js --mode=hybrid
 *   node scripts/scratch/orchestrator.js --from=build  # restart from a stage
 *   node scripts/scratch/orchestrator.js --to=build-qa # stop after build QA (no record)
 *   node scripts/scratch/orchestrator.js --no-touchup  # skip Remotion Studio touchup
 */

'use strict';

require('dotenv').config({ override: true });

const fs            = require('fs');
const path          = require('path');
const crypto        = require('crypto');
const { execSync }  = require('child_process');
const readline      = require('readline');
const Anthropic     = require('@anthropic-ai/sdk');
const { validateNarrationSync, writeReport: writeNarrationSyncReport } = require('../validate-narration-sync');
const {
  requireRunDir,
  ensureRunManifest,
  snapshotRunInputs,
  writeRunDirMarker,
} = require('./utils/run-io');
const {
  initPipelineBuildLog,
  appendPipelineLogSection,
  appendPipelineLogJson,
} = require('./utils/pipeline-logger');
const { shouldIncludeCraRunNameToken } = require('./utils/prompt-scope');

// ── CLI timestamps (orchestrator + stage boundaries; child scripts keep plain console) ──
function cliIsoTime() {
  return new Date().toISOString();
}

function cliLog(message) {
  console.log(`[${cliIsoTime()}] ${message}`);
}

function cliWarn(message) {
  console.warn(`[${cliIsoTime()}] ${message}`);
}

function cliError(message) {
  console.error(`[${cliIsoTime()}] ${message}`);
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const INPUTS_DIR   = path.join(PROJECT_ROOT, 'inputs');
const OUT_DIR      = path.join(PROJECT_ROOT, 'out');
const DEMOS_DIR    = path.join(OUT_DIR, 'demos');
const LATEST_LINK  = path.join(OUT_DIR, 'latest');
const PROMPT_REGISTRY_FILE = path.join(OUT_DIR, 'prompt-fingerprint-registry.json');

// ── Stage ordering ────────────────────────────────────────────────────────────

const STAGES = [
  'research',
  'ingest',
  'script',
  // brand-extract after script so demo-script.json persona.company exists for Brandfetch / slug
  'brand-extract',
  'script-critique',
  'embed-script-validate',   // Phase 3: narration/visual coherence check (skips when no GCP creds)
  // 'plaid-link-capture',  // DISABLED — using manual Playwright recording of real Plaid Link
  'build',
  'plaid-link-qa',
  'build-qa',
  'record',
  'qa',
  'figma-review',
  'post-process',
  'voiceover',
  'coverage-check',          // Narration coverage: % of scripted steps/words that made it into voiceover
  'auto-gap',                // Intelligent inter-scene timing: clips video to narration+gap, not raw recording
  'resync-audio',
  'embed-sync',              // Phase 1: audio-video sync alignment detection (skips when no GCP creds)
  'audio-qa',
  'ai-suggest-overlays',    // Gemini 2.0 Flash: per-step overlay suggestion patches (skips when no credentials)
  'render',
  'ppt',
  'touchup',
];

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);

  const modeArg       = args.find(a => a.startsWith('--mode='));
  const fromArg       = args.find(a => a.startsWith('--from='));
  const toArg         = args.find(a => a.startsWith('--to='));
  const runIdArg      = args.find(a => a.startsWith('--run-id='));
  const recordModeArg = args.find(a => a.startsWith('--record-mode='));
  const noTouchup     = args.includes('--no-touchup');

  const mode       = modeArg       ? modeArg.replace('--mode=', '').toLowerCase()        : null;
  const fromStage  = fromArg       ? fromArg.replace('--from=', '').toLowerCase()         : null;
  const toStage    = toArg         ? toArg.replace('--to=', '').toLowerCase()             : null;
  const runId      = runIdArg      ? runIdArg.replace('--run-id=', '').trim()             : null;
  const recordMode = recordModeArg ? recordModeArg.replace('--record-mode=', '').toLowerCase()
                                   : (process.env.RECORD_MODE || '').toLowerCase() || null;

  return { mode, fromStage, toStage, runId, noTouchup, recordMode };
}

// ── Prompt file loading ───────────────────────────────────────────────────────

function loadPrompt() {
  const promptFile = path.join(INPUTS_DIR, 'prompt.txt');
  if (fs.existsSync(promptFile)) {
    return fs.readFileSync(promptFile, 'utf8').trim();
  }
  return null;
}

function normalizePromptForFingerprint(promptText) {
  return String(promptText || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function fingerprintPrompt(promptText) {
  const normalized = normalizePromptForFingerprint(promptText);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function loadPromptRegistry() {
  try {
    if (!fs.existsSync(PROMPT_REGISTRY_FILE)) return { prompts: {} };
    const parsed = JSON.parse(fs.readFileSync(PROMPT_REGISTRY_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { prompts: {} };
  } catch (_) {
    return { prompts: {} };
  }
}

function savePromptRegistry(registry) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(PROMPT_REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8');
  } catch (err) {
    cliWarn(`[Orchestrator] Could not persist prompt fingerprint registry: ${err.message}`);
  }
}

function detectFirstUsePrompt(promptText) {
  const fingerprint = fingerprintPrompt(promptText);
  if (!fingerprint) return { fingerprint: null, firstUse: false, registry: loadPromptRegistry() };
  const registry = loadPromptRegistry();
  const seen = !!(registry.prompts && registry.prompts[fingerprint]);
  return { fingerprint, firstUse: !seen, registry };
}

function recordPromptUse({ registry, fingerprint, runDir }) {
  if (!registry || !fingerprint) return;
  registry.prompts = registry.prompts || {};
  const prev = registry.prompts[fingerprint] || {};
  const useCount = Number(prev.useCount || 0) + 1;
  registry.prompts[fingerprint] = {
    firstSeenAt: prev.firstSeenAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    useCount,
    lastRunDir: runDir || prev.lastRunDir || null,
  };
  savePromptRegistry(registry);
}

function applyFreshCleanup(runDir) {
  if (!runDir || !fs.existsSync(runDir)) return;
  const targets = [
    path.join(runDir, 'scratch-app'),
    path.join(runDir, 'qa-frames'),
    path.join(runDir, 'build-frames'),
    path.join(runDir, 'artifacts', 'build'),
    path.join(runDir, 'build-qa-diagnostics.json'),
    path.join(runDir, 'api-panel-qa.json'),
    path.join(runDir, 'build-layer-report.json'),
    path.join(runDir, 'build-app-raw-response.txt'),
  ];
  for (const t of targets) {
    try {
      if (!fs.existsSync(t)) continue;
      const st = fs.statSync(t);
      if (st.isDirectory()) fs.rmSync(t, { recursive: true, force: true });
      else fs.unlinkSync(t);
    } catch (err) {
      cliWarn(`[Orchestrator] Fresh cleanup skipped for ${path.basename(t)}: ${err.message}`);
    }
  }
}

// ── Mode classification ───────────────────────────────────────────────────────

/**
 * Uses Claude Haiku to classify the pipeline mode from the raw prompt text.
 * Returns 'scratch' | 'enhance' | 'hybrid'.
 *
 * scratch = no video mentioned OR only screenshots/scripts mentioned
 * enhance = a video file is mentioned as the entire demo ("polish it", "replace my voice")
 * hybrid  = some parts recorded, some Claude builds ("use intro.mp4 for the opening, then build...")
 */
async function classifyMode(promptText) {
  if (!promptText) {
    cliLog('[Orchestrator] No prompt.txt found — defaulting to scratch mode.');
    return 'scratch';
  }

  cliLog('[Orchestrator] Classifying pipeline mode with Claude Haiku...');

  const client = new Anthropic();

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content:
            `You are classifying a Plaid demo pipeline request into one of three modes.\n\n` +
            `Modes:\n` +
            `- scratch: No existing video mentioned, or only screenshots/scripts/images are provided. ` +
            `Claude will build the entire demo from scratch.\n` +
            `- enhance: One video file is mentioned as the complete source material for the demo ` +
            `(e.g. "polish it", "replace my voice", "clean up this recording"). ` +
            `Claude enhances that video.\n` +
            `- hybrid: Some segments are existing recordings and some need to be built by Claude ` +
            `(e.g. "use intro.mp4 for the opening, then build the IDV flow...").\n\n` +
            `Respond with ONLY one of these three words in lowercase: scratch, enhance, or hybrid.\n\n` +
            `User prompt:\n${promptText}`,
        },
      ],
    });

    const text = response.content.find(b => b.type === 'text')?.text?.trim().toLowerCase() || '';

    if (text === 'scratch' || text === 'enhance' || text === 'hybrid') {
      cliLog(`[Orchestrator] Detected mode: ${text}`);
      return text;
    }

    // Response may contain the word somewhere in a sentence
    if (text.includes('enhance')) return 'enhance';
    if (text.includes('hybrid'))  return 'hybrid';

    cliWarn(`[Orchestrator] Unexpected mode response "${text}" — defaulting to scratch.`);
    return 'scratch';
  } catch (err) {
    cliWarn(`[Orchestrator] Mode classification failed (${err.message}) — defaulting to scratch.`);
    return 'scratch';
  }
}

// ── Product slug extraction ───────────────────────────────────────────────────

/**
 * Extracts a product slug from the prompt text for use in versioned directory names.
 * Falls back to 'demo' if nothing recognisable is found.
 */
function extractProductSlug(promptText) {
  if (!promptText) return 'demo';

  const productMap = {
    'identity verification': 'idv',
    'idv':                   'idv',
    'instant auth':          'instant-auth',
    'layer':                 'layer',
    'monitor':               'monitor',
    'signal':                'signal',
    'assets':                'assets',
    'income':                'income',
    'transfer':              'transfer',
    'balance':               'balance',
  };

  const lower = promptText.toLowerCase();
  for (const [keyword, slug] of Object.entries(productMap)) {
    if (lower.includes(keyword)) return slug;
  }

  // Generic slug: take first 3 significant words, join with hyphens
  const words = lower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !['with', 'that', 'this', 'from', 'build', 'make', 'create', 'demo'].includes(w))
    .slice(0, 3);

  return words.length > 0 ? words.join('-') : 'demo';
}

function toTitleWord(word) {
  const s = String(word || '').trim();
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function normalizeCompanyToken(raw) {
  const cleaned = String(raw || '')
    .replace(/\*\*/g, '')
    .replace(/[«»"'`]/g, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Demo';
  const parts = cleaned.split(' ').filter(Boolean).slice(0, 4);
  const titled = parts.map(toTitleWord).join('-');
  return titled || 'Demo';
}

function extractCompanyToken(promptText) {
  if (!promptText) return 'Demo';
  const linePatterns = [
    /\*\*Company\s*\/\s*context:\*\*\s*([^\n]+)/i,
    /\bCompany\s*\/\s*context:\s*([^\n]+)/i,
    /\*\*Company:\*\*\s*([^\n]+)/i,
    /\bCompany:\s*([^\n]+)/i,
  ];
  for (const re of linePatterns) {
    const m = promptText.match(re);
    if (m && m[1]) {
      const token = normalizeCompanyToken(m[1]);
      if (token && token !== 'Demo') return token;
    }
  }

  // Fallback to Brand URL domain host label.
  const brandUrl = promptText.match(/\bBrand URL:\s*(https?:\/\/[^\s]+)/i)?.[1];
  if (brandUrl) {
    try {
      const host = new URL(brandUrl).hostname.replace(/^www\./i, '');
      const root = host.split('.')[0] || '';
      const token = normalizeCompanyToken(root);
      if (token && token !== 'Demo') return token;
    } catch (_) {}
  }
  return 'Demo';
}

function extractApiTokens(promptText) {
  const lower = String(promptText || '').toLowerCase();
  const labels = [];
  const add = (x) => { if (!labels.includes(x)) labels.push(x); };

  // CRA / Check income insights — only when explicitly in scope or positively mentioned (not disclaimers).
  if (shouldIncludeCraRunNameToken(String(promptText || ''))) {
    add('CRA');
  }
  if (/\bauth\b|\binstant auth\b/.test(lower)) add('Auth');
  if (/\bidentity verification\b|\bidv\b|\bidentity\b/.test(lower)) add('Identity');
  if (/\bsignal\b/.test(lower)) add('Signal');
  if (/\bassets\b/.test(lower)) add('Assets');
  if (/\bmonitor\b/.test(lower)) add('Monitor');
  if (/\blayer\b/.test(lower)) add('Layer');
  if (/\btransfer\b/.test(lower)) add('Transfer');
  if (/\bincome\b/.test(lower) && !labels.includes('CRA')) add('Income');
  if (/\bstatements\b/.test(lower)) add('Statements');
  if (/\bprotect\b/.test(lower)) add('Protect');

  return labels;
}

function promptIndicatesMobileVisual(promptText) {
  const text = String(promptText || '').toLowerCase();
  return /\bmobile\b|\bphone-first\b|\bphone first\b|\bmobile[-\s]?simulated\b|\b390\s*[x×]\s*844\b|\bmobile demo\b/.test(text);
}

function buildRunNameStem(promptText) {
  const company = extractCompanyToken(promptText);
  const apis = extractApiTokens(promptText);
  if (apis.length === 0) {
    const fallbackSlug = extractProductSlug(promptText);
    const fallbackLabel = fallbackSlug
      .split('-')
      .map(toTitleWord)
      .join('-') || 'Demo';
    return `${company}-${fallbackLabel}`;
  }
  return `${company}-${apis.join('-')}`;
}

// ── Versioned output directory ────────────────────────────────────────────────

/**
 * Determines the versioned output directory for this run.
 * Pattern: out/demos/{YYYY-MM-DD}-{Company}-{APIs}-v{N}/
 * Increments N if a same-day, same-stem directory already exists.
 */
function resolveVersionedDir(runNameStem) {
  fs.mkdirSync(DEMOS_DIR, { recursive: true });

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const safeStem = String(runNameStem || 'Demo-Demo')
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'Demo-Demo';
  const prefix = `${today}-${safeStem}-v`;

  const existing = fs.readdirSync(DEMOS_DIR)
    .filter(name => name.startsWith(prefix))
    .map(name => {
      const n = parseInt(name.replace(prefix, ''), 10);
      return isNaN(n) ? 0 : n;
    });

  const nextN  = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  const dirName = `${prefix}${nextN}`;
  const fullPath = path.join(DEMOS_DIR, dirName);

  fs.mkdirSync(fullPath, { recursive: true });

  setLatestLink(fullPath);

  return fullPath;
}

function setLatestLink(targetDir) {
  try { fs.existsSync(LATEST_LINK) && fs.unlinkSync(LATEST_LINK); } catch (_) {}
  try {
    fs.symlinkSync(targetDir, LATEST_LINK);
  } catch (err) {
    cliWarn(`[Orchestrator] Could not create symlink out/latest: ${err.message}`);
  }
}

// ── Elapsed time tracker ──────────────────────────────────────────────────────

function makeTimer() {
  const pipelineStart = Date.now();
  const stageStart    = {};

  function stageOrderLabel(stage) {
    const idx = STAGES.indexOf(stage);
    if (idx < 0) return 'auxiliary (not in STAGES list)';
    return `step ${idx + 1} of ${STAGES.length}`;
  }

  return {
    startStage(stage) {
      stageStart[stage] = Date.now();
      const ts = cliIsoTime();
      const pipelineSec = ((Date.now() - pipelineStart) / 1000).toFixed(1);
      const order = stageOrderLabel(stage);
      console.log('');
      console.log(`${'─'.repeat(60)}`);
      console.log(`[${ts}] MILESTONE: stage "${stage}" START`);
      console.log(`[${ts}]   ${order} | pipeline elapsed ${pipelineSec}s`);
      console.log(`${'─'.repeat(60)}`);
      appendPipelineLogSection(`[MILESTONE] Stage ${stage} started`, [
        `at=${ts}`,
        `stage=${stage}`,
        'status=started',
        `pipelineElapsedSeconds=${pipelineSec}`,
        `order=${order}`,
      ]);
    },
    endStage(stage) {
      const elapsed = ((Date.now() - (stageStart[stage] || Date.now())) / 1000).toFixed(1);
      const ts = cliIsoTime();
      const pipelineSec = ((Date.now() - pipelineStart) / 1000).toFixed(1);
      cliLog(`MILESTONE: stage "${stage}" DONE | stage ${elapsed}s | pipeline total ${pipelineSec}s`);
      appendPipelineLogSection(`[MILESTONE] Stage ${stage} completed`, [
        `at=${ts}`,
        `stage=${stage}`,
        `status=completed`,
        `elapsedSeconds=${elapsed}`,
        `pipelineTotalSeconds=${pipelineSec}`,
      ]);
    },
    totalElapsed() {
      return ((Date.now() - pipelineStart) / 1000).toFixed(1);
    },
  };
}

// ── User prompt for continue/abort ───────────────────────────────────────────

async function promptContinue(message) {
  // TTY path: interactive terminal — readline works normally
  if (process.stdin.isTTY) {
    return new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${message} Press ENTER to continue or Ctrl+C to abort. `, () => {
        rl.close();
        resolve();
      });
    });
  }

  // Non-TTY path (spawned by dashboard with piped stdin):
  // Accept ENTER via the pipe (dashboard POST /api/pipeline/stdin → '\n'),
  // OR wait for a signal file written by the dashboard at {runDir}/continue.signal.
  const runDir = requireRunDir(PROJECT_ROOT, 'orchestrator');
  const signalFile = path.join(runDir, 'continue.signal');
  // Remove stale signal file from a prior run
  try { fs.unlinkSync(signalFile); } catch (_) {}

  cliLog('[Orchestrator] Waiting for continue signal — click "Continue" in the dashboard or POST /api/pipeline/stdin');

  return new Promise(resolve => {
    // Option A: data arrives on piped stdin (dashboard sends '\n')
    const onData = () => { cleanup(); resolve(); };
    process.stdin.once('data', onData);

    // Option B: signal file is written by dashboard
    const poll = setInterval(() => {
      if (fs.existsSync(signalFile)) {
        try { fs.unlinkSync(signalFile); } catch (_) {}
        cleanup();
        resolve();
      }
    }, 500);

    function cleanup() {
      process.stdin.removeListener('data', onData);
      clearInterval(poll);
    }
  });
}

// ── Script critique (inline, no separate file) ────────────────────────────────

async function runScriptCritique() {
  const runDir = requireRunDir(PROJECT_ROOT, 'orchestrator');
  const scriptFile = path.join(runDir, 'demo-script.json');
  const critiqueSentinel = path.join(runDir, 'script-critique.json');
  const researchFile = path.join(runDir, 'product-research.json');
  const promptFile = path.join(INPUTS_DIR, 'prompt.txt');
  if (!fs.existsSync(scriptFile)) {
    console.log('[script-critique] No demo-script.json found — skipping.');
    return;
  }

  console.log('[script-critique] Checking script quality...');

  const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  let productResearch = { synthesizedInsights: '', accurateTerminology: {}, internalKnowledge: [], apiSpec: {} };
  if (fs.existsSync(researchFile)) {
    try {
      productResearch = JSON.parse(fs.readFileSync(researchFile, 'utf8'));
    } catch (err) {
      console.warn(`[script-critique] Could not parse product-research.json: ${err.message}`);
    }
  }
  const promptText = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';
  const { inferProductFamily } = require('./utils/product-profiles');
  const { buildCuratedProductKnowledge, buildCuratedDigest } = require('./utils/product-knowledge');
  const { readPipelineRunContext } = require('./utils/run-context');
  const { buildScriptCritiquePrompt } = require('./utils/prompt-templates');
  const productFamily = inferProductFamily({ promptText, demoScript: script, productResearch });
  const pipelineRunContext = readPipelineRunContext(runDir);
  const curatedKb = buildCuratedProductKnowledge(productFamily);
  productResearch = {
    ...productResearch,
    productFamily,
    curatedProductKnowledge: curatedKb,
    curatedDigest: buildCuratedDigest(curatedKb),
    ...(pipelineRunContext ? { pipelineRunContext } : {}),
  };
  const client = new Anthropic();
  const { system, userMessages } = buildScriptCritiquePrompt(script, productResearch);

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system,
    messages: userMessages,
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';

  try {
    const raw =
      text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ||
      text.match(/(\{[\s\S]*\})/)?.[1] ||
      '{"passed":true,"issues":[]}';

    const critique = JSON.parse(raw);

    try {
      fs.writeFileSync(
        critiqueSentinel,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            passed: !!critique.passed,
            issueCount: Array.isArray(critique.issues) ? critique.issues.length : 0,
          },
          null,
          2
        ),
        'utf8'
      );
    } catch (e) {
      console.warn(`[script-critique] Could not write script-critique.json: ${e.message}`);
    }

    if (!critique.passed) {
      console.warn('[script-critique] Issues found:');
      (critique.issues || []).forEach(i =>
        console.warn(`  [${i.severity}] Step ${i.stepId}: ${i.description || i.message || i.rule}`)
      );

      if (!process.env.SCRATCH_AUTO_APPROVE) {
        await promptContinue('[script-critique] Script has issues.');
      }
    } else {
      console.log('[script-critique] Script passed quality check.');
    }
  } catch {
    console.warn('[script-critique] Could not parse critique response.');
    try {
      fs.writeFileSync(
        critiqueSentinel,
        JSON.stringify({ at: new Date().toISOString(), passed: null, parseError: true }, null, 2),
        'utf8'
      );
    } catch (e) {
      console.warn(`[script-critique] Could not write script-critique.json: ${e.message}`);
    }
  }
}

// ── Pipeline plan for hybrid mode ────────────────────────────────────────────

/**
 * Uses Claude Haiku to parse prompt.txt and identify which segments are
 * existing recordings vs. segments Claude should build.
 */
async function buildPipelinePlan(promptText) {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content:
          `Parse this hybrid demo pipeline request. Identify which segments are existing ` +
          `video recordings and which segments Claude should build from scratch.\n\n` +
          `Output ONLY a JSON object — no prose, no markdown fences:\n\n` +
          `{\n` +
          `  "segments": [\n` +
          `    {\n` +
          `      "id": "<kebab-case segment id>",\n` +
          `      "type": "<recorded|build>",\n` +
          `      "file": "<video filename if recorded, null if build>",\n` +
          `      "description": "<what this segment covers>"\n` +
          `    }\n` +
          `  ]\n` +
          `}\n\n` +
          `Prompt:\n${promptText}`,
      },
    ],
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';
  const raw  =
    text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ||
    text.match(/(\{[\s\S]*\})/)?.[1] ||
    '{"segments":[]}';

  return JSON.parse(raw);
}

// ── Stage execution helpers ───────────────────────────────────────────────────

/**
 * Wraps a stage execution with error handling and optional auto-approve.
 *
 * Error classification:
 *   CRITICAL: Errors whose messages begin with "CRITICAL:" — always halt, even with
 *             SCRATCH_AUTO_APPROVE=true. These indicate missing artifacts or contract
 *             violations that make downstream stages meaningless.
 *   QUALITY_GATE: All other errors — prompt in interactive mode; auto-skip when
 *                 SCRATCH_AUTO_APPROVE=true.
 */
function writePipelineProgress(stageName) {
  const runDir = process.env.PIPELINE_RUN_DIR;
  if (!runDir) return;
  const progressFile = path.join(runDir, 'pipeline-progress.json');
  const tmpFile = progressFile + '.tmp';
  let progress = { runId: path.basename(runDir), completedStages: [] };
  try {
    if (fs.existsSync(progressFile)) progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  } catch (_) {}
  if (!progress.completedStages.includes(stageName)) progress.completedStages.push(stageName);
  progress.lastUpdated = new Date().toISOString();
  fs.writeFileSync(tmpFile, JSON.stringify(progress, null, 2), 'utf8');
  fs.renameSync(tmpFile, progressFile);
}

async function runStage(stageName, fn, timer) {
  timer.startStage(stageName);
  const t0 = Date.now();

  try {
    await fn();
    writePipelineProgress(stageName);
    timer.endStage(stageName);
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const ts = cliIsoTime();
    cliError(`[Stage: ${stageName}] ERROR after ${elapsed}s: ${err.message}`);
    appendPipelineLogSection(`[MILESTONE] Stage ${stageName} failed`, [
      `at=${ts}`,
      `stage=${stageName}`,
      'status=failed',
      `elapsedSeconds=${elapsed}`,
      `error=${err.message}`,
    ]);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));

    // Critical errors always halt — downstream stages would produce garbage output.
    const isCritical = /^CRITICAL:|PLAID_LINK_TIMEOUT|DOM contract|Missing.*PLAYWRIGHT|Missing.*demo-script/i.test(err.message);

    if (isCritical) {
      cliError(`[Stage: ${stageName}] CRITICAL failure — halting pipeline.`);
      process.exit(1);
    }

    if (process.env.SCRATCH_AUTO_APPROVE === 'true') {
      cliWarn(`[Stage: ${stageName}] SCRATCH_AUTO_APPROVE=true — continuing despite error.`);
    } else {
      await promptContinue(`[Stage: ${stageName}] Failed.`);
    }
  }
}

// ── Determines which stage index to start from ────────────────────────────────

function resolveStartIndex(fromStage) {
  if (!fromStage) return 0;
  const idx = STAGES.indexOf(fromStage);
  if (idx === -1) {
    cliWarn(`[Orchestrator] Unknown --from stage "${fromStage}" — starting from beginning.`);
    return 0;
  }
  cliLog(`[Orchestrator] Restarting from stage: ${fromStage} (index ${idx})`);
  return idx;
}

// ── Remotion props builder ────────────────────────────────────────────────────

function buildRemotionProps() {
  // Read from isolated run dir (PIPELINE_RUN_DIR) instead of shared out/
  const runDir = requireRunDir(PROJECT_ROOT, 'orchestrator');
  const pointerOnlyOverlays = process.env.REMOTION_POINTER_ONLY !== 'false';

  const props = {
    scratchDurationFrames: 4500,
    scratchSteps: [],
    enhanceDurationFrames: 4500,
    enhanceOverlayPlan: { zoomPunches: [], callouts: [], lowerThirds: [], highlights: [] },
    enhanceTotalMs: 150000,
  };

  // Load step-timing.json — then check for processed-step-timing.json to remap coordinates
  const timingFile          = path.join(runDir, 'step-timing.json');
  const processedTimingFile = path.join(runDir, 'processed-step-timing.json');

  if (fs.existsSync(timingFile)) {
    try {
      const timing = JSON.parse(fs.readFileSync(timingFile, 'utf8'));
      props.scratchDurationFrames = timing.totalFrames || props.scratchDurationFrames;
      props.enhanceDurationFrames = timing.totalFrames || props.enhanceDurationFrames;
      props.enhanceTotalMs        = timing.totalMs     || props.enhanceTotalMs;
      props.scratchSteps = (timing.steps || []).map(s => ({ ...s, callouts: [] }));
    } catch {}
  }

  // If a processed recording exists, remap step timings to processed-video coordinates.
  // post-process-recording.js writes processed-step-timing.json with keepRanges that map
  // raw recording timestamps to processed video timestamps. Remotion needs the processed
  // coordinates because the staged public/recording.webm is the cut version.
  if (fs.existsSync(processedTimingFile)) {
    try {
      const pt  = JSON.parse(fs.readFileSync(processedTimingFile, 'utf8'));
      const fps = 30;

      /**
       * Remap a raw timestamp (ms) to its position in the processed recording (ms).
       * - If inside a keep range: linear interpolation within that range.
       * - If in a cut (between ranges): map to the start of the next kept range.
       * - Before first range: 0. After last range: totalProcessedMs.
       */
      function remapMs(rawMs) {
        const rawS = rawMs / 1000;
        for (let i = 0; i < pt.keepRanges.length; i++) {
          const r = pt.keepRanges[i];
          if (rawS >= r.rawStart && rawS <= r.rawEnd) {
            // Inside this range — linear map
            const offset = rawS - r.rawStart;
            return Math.round((r.processedStart + offset) * 1000);
          }
          if (i + 1 < pt.keepRanges.length && rawS > r.rawEnd && rawS < pt.keepRanges[i + 1].rawStart) {
            // In a cut between this range and the next — map to start of next range
            return Math.round(pt.keepRanges[i + 1].processedStart * 1000);
          }
        }
        // After last range or before first range
        if (rawS < (pt.keepRanges[0]?.rawStart ?? 0)) return 0;
        return pt.totalProcessedMs;
      }

      const totalProcessedMs = pt.totalProcessedMs;

      // Also load sync-map.json to convert processed → composition times.
      // When SYNC_MAP_S contains speed/freeze windows, step startFrame/endFrame
      // must be in COMPOSITION space so Remotion overlays fire at the right moment.
      const { processedToCompMs: p2c, loadSyncMap: lsm } = require('../../scripts/sync-map-utils');
      const syncMapSegs = lsm(runDir);
      props.syncMap = syncMapSegs; // Passed to ScratchComposition for video playback

      // Composition duration = processedToCompMs(end of processed video) so that
      // freeze extensions (added by auto-gap) are included.  Using totalProcessedMs
      // directly would produce a duration that is far too short when freezes extend
      // the composition well beyond the raw processed video length.
      const compDurationMs = syncMapSegs.length > 0
        ? p2c(totalProcessedMs, syncMapSegs)
        : totalProcessedMs;
      props.scratchDurationFrames = Math.round(compDurationMs / 1000 * fps);
      props.enhanceDurationFrames = props.scratchDurationFrames;
      props.enhanceTotalMs        = compDurationMs;

      props.scratchSteps = props.scratchSteps.map(s => {
        const processedStartMs = remapMs(s.startMs);
        const processedEndMs   = remapMs(s.endMs);
        const startMs          = p2c(processedStartMs, syncMapSegs);
        const endMs            = p2c(processedEndMs,   syncMapSegs);
        const durationMs       = Math.max(0, endMs - startMs);
        const startFrame       = Math.round(startMs  / 1000 * fps);
        const endFrame         = Math.round(endMs    / 1000 * fps);
        return {
          ...s,
          startMs,
          endMs,
          durationMs,
          startFrame,
          endFrame,
          durationFrames: Math.max(0, endFrame - startFrame),
        };
      });

      // ── Inject Remotion freeze segments for short Plaid sub-step screens ──────
      // post-process-recording.js tags plaidStepWindows with freezeMs when the processed
      // screen duration is < MIN_PLAID_SCREEN_MS (2000ms). Inject those as sync-map freeze
      // segments here so Remotion holds the last frame of that screen for the deficit.
      // Tagged with _plaidMinDuration so auto-gap preserves them across re-runs.
      const plaidWindowsWithFreeze = (pt.plaidStepWindows || []).filter(w => w.freezeMs > 0);
      if (plaidWindowsWithFreeze.length > 0) {
        for (const w of plaidWindowsWithFreeze) {
          // w.endMs is the processed-video position where the freeze starts.
          // Convert to composition space (accounts for any speed segments already in syncMapSegs).
          const freezeStartCompMs = p2c(w.endMs, syncMapSegs);
          const freezeEndCompMs   = freezeStartCompMs + w.freezeMs;
          // Hold the frame at w.endMs - 1 frame (33ms) so the freeze shows the last
          // visible frame of this Plaid screen, not the first frame of the next cut.
          const holdVideoMs = Math.max(0, w.endMs - 33);
          syncMapSegs.push({
            compStart:          freezeStartCompMs / 1000,
            compEnd:            freezeEndCompMs   / 1000,
            videoStart:         holdVideoMs       / 1000,
            mode:               'freeze',
            _plaidMinDuration:  w.stepId,
            _reason:            `Min 2s enforcement: ${w.stepId} was ${w.durationMs}ms, freeze +${w.freezeMs}ms`,
          });
        }
        syncMapSegs.sort((a, b) => a.compStart - b.compStart);
        props.syncMap = syncMapSegs; // update props with injected segments

        // Recompute composition duration to include the newly added freeze time
        const totalFreezeMs = plaidWindowsWithFreeze.reduce((s, w) => s + w.freezeMs, 0);
        const newCompDurationMs = p2c(totalProcessedMs, syncMapSegs);
        props.scratchDurationFrames = Math.round(newCompDurationMs / 1000 * fps);
        props.enhanceDurationFrames = props.scratchDurationFrames;
        props.enhanceTotalMs        = newCompDurationMs;

        console.log(`[Render] Injected ${plaidWindowsWithFreeze.length} Plaid min-duration freeze(s) (+${totalFreezeMs}ms total)`);
      }

      console.log(
        `[Render] Remapped step timings to processed recording (${(totalProcessedMs / 1000).toFixed(1)}s)` +
        (syncMapSegs.length > 0 ? ` + sync-map (${syncMapSegs.length} segments)` : '')
      );
    } catch (err) {
      console.warn(`[Render] Could not remap processed step timing: ${err.message}`);
    }
  }

  // Load overlay-plan.json
  const overlayFile = path.join(runDir, 'overlay-plan.json');
  if (!pointerOnlyOverlays && fs.existsSync(overlayFile)) {
    try {
      props.enhanceOverlayPlan = JSON.parse(fs.readFileSync(overlayFile, 'utf8'));
    } catch {}
  }

  // Merge callouts from demo-script.json
  const scriptFile = path.join(runDir, 'demo-script.json');
  let demoScriptSteps = [];
  if (fs.existsSync(scriptFile)) {
    try {
      const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
      demoScriptSteps = script.steps || [];
      props.scratchSteps = props.scratchSteps.map(s => {
        const ss = demoScriptSteps.find(x => x.id === s.id);
        if (pointerOnlyOverlays) {
          return { ...s, callouts: [], zoomPunch: null, narration: ss?.narration || '', apiResponse: ss?.apiResponse || null };
        }
        return { ...s, callouts: ss?.callouts || [], narration: ss?.narration || '', apiResponse: ss?.apiResponse || null };
      });
    } catch {}
  }

  // ── Auto-overlay generation ────────────────────────────────────────────────
  // 1. Click ripple + targeted zoom from click-coords.json
  const coordsFile = path.join(runDir, 'click-coords.json');
  if (fs.existsSync(coordsFile)) {
    try {
      const coords = JSON.parse(fs.readFileSync(coordsFile, 'utf8'));
      props.scratchSteps = props.scratchSteps.map(s => {
        const coord = coords[s.id];
        if (!coord) return s;
        const update = {
          clickRipple: { xFrac: coord.xFrac, yFrac: coord.yFrac, atFrame: 15 },
        };
        // Targeted zoom — skip for wf-link-launch (already speed-adjusted by SYNC_MAP_S)
        if (!pointerOnlyOverlays && s.id !== 'wf-link-launch') {
          update.zoomPunch = {
            scale:   1.08,
            peakFrac: 0.5,
            originX: `${(coord.xFrac * 100).toFixed(1)}%`,
            originY: `${(coord.yFrac * 100).toFixed(1)}%`,
          };
        } else if (pointerOnlyOverlays) {
          update.zoomPunch = null;
        }
        return { ...s, ...update };
      });
    } catch (err) {
      console.warn(`[Render] Could not load click-coords.json: ${err.message}`);
    }
  }

  // 2. Lower-thirds for API insight steps + reveal zoom for long API steps
  // 3. Badge callouts for outcome step with stat-counter entries from narration
  if (!pointerOnlyOverlays) {
    const STAT_RE = /(\d+\.?\d*)\s*([\+%×xX]|percent|seconds?|ms\b)/gi;
    props.scratchSteps = props.scratchSteps.map(s => {
      const callouts   = [...(s.callouts || [])];
      let   zoomPunch  = s.zoomPunch;
      const durationS  = (s.durationMs || 0) / 1000;

      // Lower-third for steps with an API response endpoint
      if (s.apiResponse?.endpoint) {
        const words = (s.narration || '').trim().split(/\s+/).slice(0, 8).join(' ');
        // Only add if not already present
        if (!callouts.some(c => c.type === 'lower-third' && c.title === s.apiResponse.endpoint)) {
          callouts.push({ type: 'lower-third', title: s.apiResponse.endpoint, subtext: words });
        }
        // Gentle reveal zoom at 30% into step for long API steps (no click coord zoom)
        if (!zoomPunch && durationS > 12) {
          zoomPunch = { scale: 1.06, peakFrac: 0.3, originX: 'center', originY: 'center' };
        }
      }

      // Stat-counter callouts for the outcome step
      if (s.id === 'plaid-outcome') {
        const narration = s.narration || '';
        const matches   = [...narration.matchAll(STAT_RE)];
        matches.slice(0, 3).forEach((m, i) => {
          const value  = parseFloat(m[1]);
          const suffix = m[2].startsWith('percent') ? '%' : m[2];
          if (!isNaN(value)) {
            callouts.push({ type: 'stat-counter', value, suffix, label: '', position: `stat-${i + 1}` });
          }
        });
      }

      return { ...s, callouts, zoomPunch: zoomPunch !== undefined ? zoomPunch : s.zoomPunch };
    });
  } else {
    props.scratchSteps = props.scratchSteps.map((s) => ({ ...s, callouts: [], zoomPunch: null }));
  }

  // 4. Derive cut frame positions from processed-step-timing.json for CrossDissolve
  const processedTimingFile2 = path.join(runDir, 'processed-step-timing.json');
  props.cutFrames = [];
  if (!pointerOnlyOverlays && fs.existsSync(processedTimingFile2)) {
    try {
      const pt2  = JSON.parse(fs.readFileSync(processedTimingFile2, 'utf8'));
      const fps2 = 30;
      for (let i = 0; i + 1 < (pt2.keepRanges || []).length; i++) {
        const r = pt2.keepRanges[i];
        const processedEndS = r.processedStart + (r.rawEnd - r.rawStart);
        props.cutFrames.push(Math.round(processedEndS * fps2));
      }
    } catch {}
  }

  // Check whether voiceover.mp3 exists in public/ (where stageArtifactsForRemotion copies it)
  const publicDir = path.join(PROJECT_ROOT, 'public');
  props.hasVoiceover = fs.existsSync(path.join(publicDir, 'voiceover.mp3'));
  if (!props.hasVoiceover) {
    console.log('[Render] No voiceover.mp3 found — rendering video-only (no audio)');
  }
  props.overlayMode = pointerOnlyOverlays ? 'pointer-only' : 'enhanced';

  return props;
}

/**
 * Checks the stitched voiceover audio for quality issues:
 * - Detects silence gaps > 2s (choppy audio indicator)
 * - Checks for audio clipping (peak > -0.5dB)
 * - Validates total duration matches expected from step-timing
 *
 * @param {string} runDir  The versioned run directory
 * @returns {{ passed: boolean, issues: string[] }}
 */
function checkAudioQuality(runDir) {
  const voiceoverPath = path.join(runDir, 'audio', 'voiceover.mp3');
  const timingPath = path.join(runDir, 'step-timing.json');
  const issues = [];

  if (!fs.existsSync(voiceoverPath)) {
    console.warn('[Audio QA] No voiceover.mp3 found — skipping audio QA');
    return { passed: true, issues: ['No voiceover file to check'] };
  }

  try {
    // 1. Check for silence gaps using ffmpeg silencedetect filter
    const silenceResult = require('child_process').spawnSync(
      'ffmpeg',
      ['-i', voiceoverPath, '-af', 'silencedetect=noise=-30dB:d=2', '-f', 'null', '-'],
      { encoding: 'utf8', timeout: 60000 }
    );
    const silenceOutput = (silenceResult.stderr || '') + (silenceResult.stdout || '');
    const silenceMatches = silenceOutput.match(/silence_start:\s*([\d.]+)/g) || [];
    const silenceEndMatches = silenceOutput.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g) || [];

    if (silenceMatches.length > 0) {
      // Parse silence durations
      const silenceDurations = silenceEndMatches.map(m => {
        const durMatch = m.match(/silence_duration:\s*([\d.]+)/);
        return durMatch ? parseFloat(durMatch[1]) : 0;
      });
      const longSilences = silenceDurations.filter(d => d > 3.0);
      if (longSilences.length > 0) {
        issues.push(`${longSilences.length} silence gap(s) longer than 3s detected (max: ${Math.max(...longSilences).toFixed(1)}s) — may indicate choppy audio`);
      }
      if (silenceMatches.length > 5) {
        issues.push(`${silenceMatches.length} silence gaps > 2s detected — audio may sound choppy`);
      }
    }

    // 2. Check for audio clipping using ffmpeg astats filter
    const statsResult = require('child_process').spawnSync(
      'ffmpeg',
      ['-i', voiceoverPath, '-af', 'astats=metadata=1:reset=1', '-f', 'null', '-'],
      { encoding: 'utf8', timeout: 60000 }
    );
    const statsOutput = (statsResult.stderr || '') + (statsResult.stdout || '');
    const peakMatch = statsOutput.match(/Peak level dB:\s*(-?[\d.]+)/);
    if (peakMatch) {
      const peakDb = parseFloat(peakMatch[1]);
      if (peakDb > -0.5) {
        issues.push(`Audio clipping detected (peak: ${peakDb.toFixed(1)}dB) — audio may sound distorted`);
      }
    }

    // 3. Validate duration matches expected from step-timing
    const durationResult = require('child_process').spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', voiceoverPath],
      { encoding: 'utf8', timeout: 30000 }
    );
    const audioDurationSec = parseFloat(durationResult.stdout?.trim() || '0');

    if (fs.existsSync(timingPath)) {
      const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
      const expectedDurationSec = (timing.totalMs || 0) / 1000;
      if (expectedDurationSec > 0) {
        const ratio = audioDurationSec / expectedDurationSec;
        if (ratio < 0.5) {
          issues.push(`Audio duration (${audioDurationSec.toFixed(1)}s) is less than half the video duration (${expectedDurationSec.toFixed(1)}s) — audio may be truncated or missing segments`);
        } else if (ratio > 1.5) {
          issues.push(`Audio duration (${audioDurationSec.toFixed(1)}s) is 50% longer than the video (${expectedDurationSec.toFixed(1)}s) — timing mismatch`);
        }
      }
    }

    console.log(`[Audio QA] Duration: ${audioDurationSec.toFixed(1)}s, Issues: ${issues.length}`);

  } catch (err) {
    console.warn(`[Audio QA] Check failed: ${err.message}`);
    issues.push(`Audio QA check failed: ${err.message}`);
  }

  const passed = issues.filter(i => !i.includes('failed')).length === 0;
  return { passed, issues };
}

function assertNarrationSyncOrThrow(runDir, contextLabel = 'pre-render') {
  const report = validateNarrationSync(runDir);
  const reportPath = writeNarrationSyncReport(runDir, report);
  if (!report.ok) {
    const categoryCounts = {};
    const codeCounts = {};
    for (const v of report.violations || []) {
      const cat = String(v?.category || 'other');
      const code = String(v?.code || 'unknown');
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      codeCounts[code] = (codeCounts[code] || 0) + 1;
    }
    const failCategories = Object.entries(categoryCounts).map(([k, n]) => `${k}:${n}`).join(', ') || 'none';
    const failCodes = Object.entries(codeCounts).map(([k, n]) => `${k}:${n}`).join(', ') || 'none';
    const sample = report.violations.slice(0, 8).map((v) => `${v.code}: ${v.message}`).join('\n  - ');
    throw new Error(
      `CRITICAL: Narration/screen sync governor failed (${contextLabel}). ` +
      `${report.violations.length} violation(s).\n` +
      `Fail categories: ${failCategories}\n` +
      `Fail codes: ${failCodes}\n` +
      `Report: ${reportPath}\n  - ${sample}`
    );
  }
  if (report.warnings.length > 0) {
    console.warn(`[narration-sync] PASS with ${report.warnings.length} warning(s) (${contextLabel}).`);
    console.warn(`[narration-sync] Report: ${reportPath}`);
  } else {
    console.log(`[narration-sync] PASS (${contextLabel})`);
  }
}

/**
 * Stages run-dir artifacts into public/ so Remotion's staticFile() can find them.
 * Remotion's webpack context uses public/ as the static directory — we can't change that.
 */
function stageArtifactsForRemotion(runDir) {
  const publicDir = path.join(PROJECT_ROOT, 'public');

  // Clean old recording/voiceover from public/ to prevent contamination
  const staleFiles = ['recording.webm', 'recording.mp4', 'recording-studio.mp4', 'voiceover.mp3'];
  for (const f of staleFiles) {
    const p = path.join(publicDir, f);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }

  // Copy this run's recording — prefer the post-processed cut if it exists.
  const processedRecording = path.join(runDir, 'recording-processed.webm');
  const rawRecording       = path.join(runDir, 'recording.webm');
  const recording = fs.existsSync(processedRecording) ? processedRecording : rawRecording;
  if (fs.existsSync(recording)) {
    fs.copyFileSync(recording, path.join(publicDir, 'recording.webm'));
    const label = fs.existsSync(processedRecording) ? 'recording-processed.webm' : 'recording.webm';
    console.log(`[Render] Staged ${label} → public/recording.webm`);

    // Also convert to recording.mp4 — ScratchComposition uses this for final renders.
    // The old recording.mp4 must be replaced so it matches the current run's processed
    // recording and sync-map timestamps.
    const mp4Out = path.join(publicDir, 'recording.mp4');
    try { if (fs.existsSync(mp4Out)) fs.unlinkSync(mp4Out); } catch (_) {}
    console.log('[Render] Converting recording.webm → recording.mp4...');
    const conv = require('child_process').spawnSync('ffmpeg', [
      '-i', recording,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-y', mp4Out,
    ], { stdio: 'pipe', timeout: 300000 });
    if (conv.status === 0) {
      console.log('[Render] recording.mp4 written → public/');
    } else {
      const stderr = conv.stderr?.toString().slice(-300) || '';
      console.warn(`[Render] Warning: recording.mp4 conversion failed — ${stderr}`);
    }

    // Generate a fresh Studio proxy every run to prevent stale/choppy preview playback.
    // Key targets:
    // - 1440x900 preview size for interactive scrubbing performance
    // - 30fps to match DemoScratch composition fps
    // - high enough bitrate/quality to avoid "blocky/choppy" perceived motion
    const studioOut = path.join(publicDir, 'recording-studio.mp4');
    try { if (fs.existsSync(studioOut)) fs.unlinkSync(studioOut); } catch (_) {}
    console.log('[Render] Building recording-studio.mp4 (1440x900 @30fps)...');
    const studioConv = require('child_process').spawnSync('ffmpeg', [
      '-i', recording,
      '-vf', 'scale=1440:900:flags=lanczos,fps=30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-movflags', '+faststart',
      '-y', studioOut,
    ], { stdio: 'pipe', timeout: 300000 });
    if (studioConv.status === 0) {
      console.log('[Render] recording-studio.mp4 written → public/');
    } else {
      const stderr = studioConv.stderr?.toString().slice(-300) || '';
      console.warn(`[Render] Warning: recording-studio.mp4 conversion failed — ${stderr}`);
    }
  } else {
    console.warn('[Render] Warning: no recording.webm found in run dir');
  }

  // Copy this run's voiceover
  const voiceover = path.join(runDir, 'audio', 'voiceover.mp3');
  if (fs.existsSync(voiceover)) {
    fs.copyFileSync(voiceover, path.join(publicDir, 'voiceover.mp3'));
    console.log('[Render] Staged voiceover.mp3 → public/');
  }
}

// ── Mode A: Scratch pipeline ──────────────────────────────────────────────────

async function runScratchPipeline({ startIdx, endIdx, noTouchup, versionedDir, promptText, timer, recordMode }) {
  const shouldRun = (stageName) => {
    const idx = STAGES.indexOf(stageName);
    if (idx < 0) return false;
    if (idx < startIdx) return false;
    if (endIdx != null && idx > endIdx) return false;
    return true;
  };

  const stageRunner = async (name, fn) => {
    const idx = STAGES.indexOf(name);
    if (idx < startIdx) {
      cliLog(`[Orchestrator] Skipping stage: ${name} (--from)`);
      return;
    }
    if (endIdx != null && idx > endIdx) {
      cliLog(`[Orchestrator] Skipping stage: ${name} (--to ${STAGES[endIdx]})`);
      return;
    }
    await runStage(name, fn, timer);
  };

  // Stage 0: research
  await stageRunner('research', async () => {
    await require('./research').main();
  });

  // Stage 1: ingest
  await stageRunner('ingest', async () => {
    await require('./scratch/ingest').main();
  });

  // Stage 2: script (writes demo-script.json — needed for persona.company in brand-extract)
  await stageRunner('script', async () => {
    await require('./scratch/generate-script').main();
  });

  // Stage 3: brand-extract (Brandfetch → Playwright CSS fallback → Haiku normalisation)
  await stageRunner('brand-extract', async () => {
    await require('./scratch/brand-extract').main();
  });

  // Stage 4: script-critique
  await stageRunner('script-critique', async () => {
    await runScriptCritique();
  });

  // Stage 5: embed-script-validate (Phase 3 — graceful no-op if VERTEX_AI_PROJECT_ID unset)
  await stageRunner('embed-script-validate', async () => {
    await require('./scratch/embed-script-validate').main();
  });

  // Stage 4b: value-prop claim verification (inline — fast Haiku call)
  // Checks that narrated claims match approved proof points in plaid-value-props.md.
  // Flags unapproved numbers or misattributed claims before they reach the final video.
  if (shouldRun('script-critique')) {
    await runStage('claim-check', async () => {
      const runDir     = requireRunDir(PROJECT_ROOT, 'orchestrator');
      const scriptFile = path.join(runDir, 'demo-script.json');
      const promptFile = path.join(INPUTS_DIR, 'prompt.txt');

      if (!fs.existsSync(scriptFile)) {
        console.log('[claim-check] No demo-script.json found — skipping.');
        return;
      }

      const script     = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
      const promptText = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '';
      const { inferProductFamily } = require('./utils/product-profiles');
      const { loadProductKnowledgeForFamily } = require('./utils/product-knowledge');
      const { readPipelineRunContext } = require('./utils/run-context');
      const productFamily = inferProductFamily({ promptText, demoScript: script });
      const knowledgeFiles = loadProductKnowledgeForFamily(productFamily);
      const fallbackVpFile = path.join(INPUTS_DIR, 'plaid-value-props.md');
      let valuePropsMd = '';
      const pipelineCtx = readPipelineRunContext(runDir);
      if (pipelineCtx && pipelineCtx.approvedClaimsDigest) {
        const ac = pipelineCtx.approvedClaimsDigest;
        const claimLines = [];
        (ac.fromResearch || []).forEach((s) => claimLines.push(`- ${s}`));
        (ac.fromKnowledgeFiles || []).forEach((f) => {
          (f.bullets || []).forEach((b) => claimLines.push(`[${f.slug}] ${b}`));
        });
        if (claimLines.length > 0) {
          valuePropsMd =
            '## APPROVED CLAIMS (pipeline run context — use for numeric/stat verification)\n\n' +
            claimLines.join('\n');
          console.log(`[claim-check] Using approved-claims digest from pipeline-run-context.json (${claimLines.length} line(s)).`);
        }
      }
      if (!valuePropsMd && knowledgeFiles.length > 0) {
        valuePropsMd = knowledgeFiles.map(file => file.markdown).join('\n\n---\n\n');
        console.log(`[claim-check] Using curated product knowledge for family "${productFamily}" (${knowledgeFiles.length} file(s)).`);
      } else if (!valuePropsMd && fs.existsSync(fallbackVpFile)) {
        valuePropsMd = fs.readFileSync(fallbackVpFile, 'utf8');
        console.log('[claim-check] Using legacy plaid-value-props.md fallback.');
      }
      const claimsOverridePath = path.join(INPUTS_DIR, 'claims-override.json');
      if (fs.existsSync(claimsOverridePath)) {
        try {
          const ov = JSON.parse(fs.readFileSync(claimsOverridePath, 'utf8'));
          const bullets = ov.bullets || ov.claims;
          if (Array.isArray(bullets) && bullets.length > 0) {
            const block =
              '## CLAIMS OVERRIDE (inputs/claims-override.json)\n\n' +
              bullets.map((b) => `- ${String(b)}`).join('\n');
            valuePropsMd = valuePropsMd ? `${block}\n\n---\n\n${valuePropsMd}` : block;
            console.log(`[claim-check] Applied ${bullets.length} claim(s) from claims-override.json`);
          }
        } catch (e) {
          console.warn(`[claim-check] Could not read claims-override.json: ${e.message}`);
        }
      }

      if (!valuePropsMd) {
        console.log('[claim-check] No curated product knowledge, plaid-value-props.md, or claims-override.json — skipping claim verification.');
        return;
      }

      const client     = new Anthropic();

      const response = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role:    'user',
          content:
            `You are reviewing a Plaid demo script for value proposition accuracy.\n\n` +
            `Approved value propositions (use ONLY these numbers and claims):\n${valuePropsMd}\n\n` +
            `Demo script narrations:\n${JSON.stringify(script.steps?.map(s => ({ id: s.id, narration: s.narration })), null, 2)}\n\n` +
            `Check for:\n` +
            `1. Any quantified claim NOT found in the approved list (unapproved number or stat)\n` +
            `2. Any approved claim that is misquoted or misattributed to the wrong product\n` +
            `3. Use of "Trust Index" (not a Plaid product — use "ACH transaction risk score")\n\n` +
            `Return JSON only: {"flags": [{"stepId": "...", "claim": "...", "issue": "..."}], "passed": boolean}`,
        }],
      });

      const text = response.content.find(b => b.type === 'text')?.text || '';
      const raw =
        text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ||
        text.match(/(\{[\s\S]*\})/)?.[1] ||
        '{"passed":true,"flags":[]}';

      let claimResult;
      try {
        claimResult = JSON.parse(raw);
      } catch {
        console.warn('[claim-check] Could not parse claim check response.');
        return;
      }

      if (!claimResult.passed && claimResult.flags?.length > 0) {
        console.warn('[claim-check] Value proposition flags:');
        claimResult.flags.forEach(f =>
          console.warn(`  [Step ${f.stepId}] "${f.claim}" — ${f.issue}`)
        );
        // Write flags so the script review can surface them
        fs.writeFileSync(
          path.join(runDir, 'claim-check-flags.json'),
          JSON.stringify(claimResult, null, 2)
        );
        if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
          await promptContinue('[claim-check] Unapproved claims found in script.');
        } else {
          console.warn('[claim-check] SCRATCH_AUTO_APPROVE=true — advancing with flagged claims.');
        }
      } else {
        console.log('[claim-check] All claims match approved value propositions.');
      }
    }, timer);
  }

  // Stage 5: plaid-link-capture — DISABLED
  // Plaid Link screens are captured via the main Playwright recording (headless:false).
  // Re-enable this block and uncomment 'plaid-link-capture' in STAGES to restore
  // the pre-capture reference screenshot flow.
  /*
  if (STAGES.indexOf('plaid-link-capture') >= startIdx) {
    await runStage('plaid-link-capture', async () => {
      if (process.env.PLAID_LINK_LIVE !== 'true') {
        console.log('[plaid-link-capture] PLAID_LINK_LIVE != true — skipping.');
        return;
      }
      await require('../plaid-link-capture').main();
    }, timer);
  }
  */

  // When resuming past brand-extract (e.g. --from=build), re-run extraction if prompt URL/domain
  // no longer matches brand/<slug>._extractDomain (or profile predates that field).
  const brandExtractIdx = STAGES.indexOf('brand-extract');
  const buildIdx = STAGES.indexOf('build');
  const willRunBuild =
    buildIdx >= startIdx && (endIdx == null || endIdx >= buildIdx);
  const skippedBrandExtract = startIdx > brandExtractIdx;
  if (willRunBuild && skippedBrandExtract) {
    const beMod = require('./scratch/brand-extract');
    await beMod.maybeRefreshBrandIfPromptDomainChanged(async () => {
      await runStage('brand-extract', async () => {
        await beMod.main();
      }, timer);
    });
  }

  // Stage: build
  const layeredBuildEnabled = process.env.LAYERED_BUILD_ENABLED === 'true' || process.env.LAYERED_BUILD_ENABLED === '1';
  const mobileVisualEnabledFromEnv = process.env.MOBILE_VISUAL_ENABLED === 'true' || process.env.MOBILE_VISUAL_ENABLED === '1';
  const mobileVisualEnabledFromPrompt = promptIndicatesMobileVisual(promptText);
  const mobileVisualEnabled = mobileVisualEnabledFromEnv || mobileVisualEnabledFromPrompt;
  const mobileRuntimeEnabled = process.env.MOBILE_RUNTIME_ENABLED === 'true' || process.env.MOBILE_RUNTIME_ENABLED === '1';
  const buildViewMode = String(process.env.BUILD_VIEW_MODE || 'desktop').toLowerCase();
  if (layeredBuildEnabled || mobileVisualEnabled || mobileRuntimeEnabled) {
    cliLog(
      `[Orchestrator] Build lanes — layered=${layeredBuildEnabled}, mobile-visual=${mobileVisualEnabled}, ` +
      `mobile-runtime=${mobileRuntimeEnabled}, viewMode=${buildViewMode}`
    );
    if (!mobileVisualEnabledFromEnv && mobileVisualEnabledFromPrompt) {
      cliLog('[Orchestrator] mobile-visual enabled from prompt language (mobile intent detected).');
    }
  }
  await stageRunner('build', async () => {
    await require('./scratch/build-app').main({
      layeredBuildEnabled,
      mobileVisualEnabled,
      buildViewMode,
    });
  });

  // Stage: plaid-link-qa — lightweight pre-record smoke test that ensures
  // live Plaid Link actually launches and /api/create-link-token succeeds.
  await stageRunner('plaid-link-qa', async () => {
    delete require.cache[require.resolve('./scratch/plaid-link-qa')];
    await require('./scratch/plaid-link-qa').main();
  });

  // Stage: build-qa — Playwright walkthrough + vision QA vs demo-script (no recording)
  await stageRunner('build-qa', async () => {
    delete require.cache[require.resolve('./scratch/build-qa')];
    await require('./scratch/build-qa').main({
      mobileVisualEnabled,
      buildViewMode,
    });
  });

  // Post-build preview: launch a local server and open the app in the browser so a human
  // can step through it with arrow keys / clicks before recording begins.
  if (shouldRun('build') && shouldRun('record')) {
    const { startServer } = require('./utils/app-server');
    const scratchAppDir = path.join(versionedDir, 'scratch-app');
    if (fs.existsSync(path.join(scratchAppDir, 'index.html'))) {
      const previewServer = await startServer(3739, scratchAppDir).catch(() => null);
      if (previewServer) {
        cliLog(`[Build Preview] App served at: ${previewServer.url}`);
        cliLog('[Build Preview] Use ArrowRight/ArrowDown to advance, ArrowLeft/ArrowUp to go back.');
        cliLog('[Build Preview] Click any non-button area to advance. Click buttons normally.');
        try { execSync(`open "${previewServer.url}"`, { stdio: 'ignore' }); } catch (_) {}
        if (process.env.SCRATCH_AUTO_APPROVE === 'true') {
          cliLog('[Build Preview] SCRATCH_AUTO_APPROVE=true — skipping manual review, proceeding to record.');
        } else {
          await promptContinue('[Build Preview] Review the app in your browser, then press ENTER to start recording.');
        }
        previewServer.close();
      }
    }
  }

  // Stage: record + QA refinement loop
  if (shouldRun('record')) {
    timer.startStage('record+qa');

    const studioMode    = recordMode === 'studio';
    const manualRecord  = process.env.MANUAL_RECORD === 'true';
    let bestScore     = 0;
    let bestRecording = null;
    const maxIterations = (studioMode || manualRecord) ? 1 : parseInt(process.env.MAX_REFINEMENT_ITERATIONS || '3', 10);
    const qaThreshold   = parseInt(process.env.QA_PASS_THRESHOLD || '80', 10);

    // ── Studio mode: human-driven recording, single QA pass (informational only) ──
    if (studioMode) {
      cliLog('[Orchestrator] STUDIO mode: human-driven recording via our-recorder.');
      cliLog('[Orchestrator] QA will run once for quality feedback — no refinement loop.');

      try {
        delete require.cache[require.resolve('./manual-record')];
        await require('./manual-record').main({ iteration: 1 });
      } catch (err) {
        cliError(`[record] Studio recording failed: ${err.message}`);
        if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
          await promptContinue('[record] Studio recording failed. Fix and press ENTER to continue, or Ctrl-C to abort.');
        } else {
          throw err;
        }
      }

      // Informational QA — score shown, never blocks, never loops
      cliLog('[Orchestrator] Running QA (informational — studio mode, no re-record)...');
      try {
        delete require.cache[require.resolve('./scratch/qa-review')];
        const qaResult = await require('./scratch/qa-review').main({ iteration: 1 });
        const score    = qaResult?.overallScore ?? 0;
        cliLog(`[Studio QA] Score: ${score}/100${score >= qaThreshold ? ' — passed' : ` (below ${qaThreshold} threshold — continuing in studio mode)`}`);
        if (score < qaThreshold) {
          fs.writeFileSync(
            path.join(versionedDir, 'recording-qa-warning.json'),
            JSON.stringify({
              bestScore: score, threshold: qaThreshold,
              message:   `Studio mode: QA score ${score}/${qaThreshold} — informational only, no re-record`,
              advancedAt: new Date().toISOString(),
            }, null, 2)
          );
        }
      } catch (err) {
        cliWarn(`[qa] Studio QA check failed: ${err.message} — continuing`);
      }

      writePipelineProgress('record');
      writePipelineProgress('qa');
      timer.endStage('record+qa');

    } else {
    // ── Auto / manual Playwright recording (existing refinement loop) ──────────

    if (manualRecord) {
      cliLog('[Orchestrator] MANUAL_RECORD mode: one human-driven recording pass, no QA refinement loop.');
    }

    for (let iter = 1; iter <= maxIterations; iter++) {
      if (!manualRecord) {
        cliLog(`[Orchestrator] Record+QA iteration ${iter}/${maxIterations}`);
      }

      try {
        // Bust require cache so edits to record-local.js take effect without restarting
        delete require.cache[require.resolve('./scratch/record-local')];
        await require('./scratch/record-local').main({ iteration: iter });
      } catch (err) {
        cliError(`[record] iteration ${iter} failed: ${err.message}`);
        if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
          await promptContinue('[record] Recording failed.');
        }
      }

      // In manual mode, skip QA — the human's recording is the final recording.
      if (manualRecord) {
        cliLog('[Orchestrator] MANUAL_RECORD: skipping QA. Advancing to voiceover.');
        break;
      }

      let qaResult;
      try {
        qaResult = await require('./scratch/qa-review').main({ iteration: iter });
      } catch (err) {
        cliError(`[qa] iteration ${iter} failed: ${err.message}`);
        qaResult = { overallScore: 0, passed: false };
      }

      const score = qaResult?.overallScore ?? 0;
      cliLog(`[Orchestrator] QA score: ${score}/${qaThreshold} (threshold)`);

      if (score >= qaThreshold) {
        cliLog(`[Orchestrator] QA passed (${score}). Advancing to voiceover.`);
        bestScore = score;
        break;
      }

      if (score > bestScore) {
        bestScore     = score;
        bestRecording = path.join(versionedDir, `recording-iter${iter}.webm`);
        try {
          fs.copyFileSync(
            path.join(versionedDir, 'recording.webm'),
            bestRecording
          );
          // Also save the matching step-timing.json and plaid-link-timing.json for this iteration
          const timingSource = path.join(versionedDir, 'step-timing.json');
          const timingBackup = path.join(versionedDir, `step-timing-iter${iter}.json`);
          if (fs.existsSync(timingSource)) {
            fs.copyFileSync(timingSource, timingBackup);
          }
          const plaidTimingSource = path.join(versionedDir, 'plaid-link-timing.json');
          const plaidTimingBackup = path.join(versionedDir, `plaid-link-timing-iter${iter}.json`);
          if (fs.existsSync(plaidTimingSource)) {
            fs.copyFileSync(plaidTimingSource, plaidTimingBackup);
          }
        } catch (copyErr) {
          cliWarn(`[Orchestrator] Could not copy best recording: ${copyErr.message}`);
        }
      }

      if (iter < maxIterations) {
        cliLog(`[Orchestrator] Score ${score} below threshold. Patching app for iteration ${iter + 1}...`);
        try {
          // Bust require cache so edits to build-app.js take effect without restarting
          delete require.cache[require.resolve('./scratch/build-app')];
          await require('./scratch/build-app').main({
            refinementIteration: iter,
            qaReportFile: path.join(versionedDir, `qa-report-${iter}.json`),
          });
        } catch (err) {
          cliError(`[build] refinement iteration ${iter} failed: ${err.message}`);
          if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
            await promptContinue('[build] Refinement failed.');
          }
        }
      } else {
        cliLog(`[Orchestrator] Max iterations reached. Best score: ${bestScore}.`);
      }
    }

    // Restore the best recording + matching step-timing if we never hit the threshold
    if (bestRecording && fs.existsSync(bestRecording) && bestScore > 0) {
      fs.copyFileSync(bestRecording, path.join(versionedDir, 'recording.webm'));
      // Also restore the matching step-timing.json so timing matches the recording
      const iterMatch = bestRecording.match(/recording-iter(\d+)\.webm$/);
      if (iterMatch) {
        const timingBackup = path.join(versionedDir, `step-timing-iter${iterMatch[1]}.json`);
        if (fs.existsSync(timingBackup)) {
          fs.copyFileSync(timingBackup, path.join(versionedDir, 'step-timing.json'));
          cliLog(`[Orchestrator] Restored matching step-timing (iteration ${iterMatch[1]})`);
        }
        // Also restore the matching plaid-link-timing.json so post-process cuts align with the recording
        const plaidTimingBackup = path.join(versionedDir, `plaid-link-timing-iter${iterMatch[1]}.json`);
        if (fs.existsSync(plaidTimingBackup)) {
          fs.copyFileSync(plaidTimingBackup, path.join(versionedDir, 'plaid-link-timing.json'));
          cliLog(`[Orchestrator] Restored matching plaid-link-timing (iteration ${iterMatch[1]})`);
        }
      }
      cliLog(`[Orchestrator] Restored best recording (score: ${bestScore})`);
    }

    // ── Below-threshold warning ────────────────────────────────────────────
    // Surface prominently — silent advance is the most common cause of unusable output.
    if (bestScore < qaThreshold) {
      const warningMsg = `ADVANCING WITH BELOW-THRESHOLD RECORDING (best QA score: ${bestScore}/${qaThreshold})`;
      cliWarn('');
      cliWarn('!'.repeat(60));
      cliWarn(`[QA] WARNING: ${warningMsg}`);
      cliWarn('[QA] The final video may have visual quality issues.');
      cliWarn('!'.repeat(60));

      // Write a qa-warning file so post-run summaries can surface it
      fs.writeFileSync(
        path.join(versionedDir, 'recording-qa-warning.json'),
        JSON.stringify({
          bestScore,
          threshold: qaThreshold,
          message: warningMsg,
          advancedAt: new Date().toISOString(),
        }, null, 2)
      );

      if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
        await promptContinue(`[QA] Best score ${bestScore}/${qaThreshold} — below threshold.`);
      } else {
        // Auto-approve pipelines must not silently produce unusable demos.
        // All QA iterations are exhausted — halt so a human can investigate.
        throw new Error(
          `CRITICAL: QA_BELOW_THRESHOLD — best score ${bestScore}/${qaThreshold} after all ` +
          `recording iterations. Re-run from --from=build to fix the build before proceeding.`
        );
      }
    }

    writePipelineProgress('record');
    if (bestScore > 0) writePipelineProgress('qa');
    timer.endStage('record+qa');

    } // end else (non-studio Playwright path)
  }

  // Stage: figma-review (optional — only runs when FIGMA_REVIEW=true)
  if (shouldRun('figma-review')) {
    await runStage('figma-review', async () => {
      const figmaFeedback = await require('./scratch/figma-review').main();

      // Propagate Figma file key from run-state.json to process.env for downstream stages
      const runStateFile = path.join(versionedDir, 'run-state.json');
      if (fs.existsSync(runStateFile)) {
        try {
          const runState = JSON.parse(fs.readFileSync(runStateFile, 'utf8'));
          if (runState.figmaFileKey) {
            process.env.FIGMA_REVIEW_FILE_KEY = runState.figmaFileKey;
            cliLog(`[Orchestrator] Figma file key loaded from run-state: ${runState.figmaFileKey}`);
          }
        } catch (err) {
          cliWarn(`[Orchestrator] Could not read run-state.json: ${err.message}`);
        }
      }

      // If Figma feedback was captured, run one final build refinement pass
      if (figmaFeedback && figmaFeedback.comments && figmaFeedback.comments.length > 0) {
        cliLog(`[Orchestrator] Figma feedback received (${figmaFeedback.comments.length} comment(s)) — running final build refinement`);
        await require('./scratch/build-app').main({
          qaReportFile: path.join(versionedDir, 'figma-feedback.json'),
        });
        // Re-record with the refined app
        if (recordMode === 'studio') {
          cliLog('[figma-review] Studio mode — skipping automated re-record. Re-run with --record-mode=studio --from=record to capture manually.');
        } else {
          cliLog('[Orchestrator] Re-recording with Figma-refined app...');
          await require('./scratch/record-local').main({ iteration: 'figma' });
        }
      }
    }, timer);
  }

  // Stage: post-process — hard-cut still/waiting frames from the recording.
  // Runs BEFORE voiceover so narration timing is derived from the edited video length,
  // not the raw recording. Output: recording-processed.webm + post-process-summary.json.
  // Plaid Link keep ranges (phone, OTP, institution, success) are preserved exactly.
  if (shouldRun('post-process')) {
    await runStage('post-process', async () => {
      const recordingIn   = path.join(versionedDir, 'recording.webm');
      const recordingOut  = path.join(versionedDir, 'recording-processed.webm');
      const timingFile    = path.join(versionedDir, 'step-timing.json');

      if (!fs.existsSync(recordingIn)) {
        console.warn('[post-process] No recording.webm found — skipping post-process.');
        return;
      }
      if (!fs.existsSync(timingFile)) {
        console.warn('[post-process] No step-timing.json found — skipping post-process.');
        return;
      }

      // Read post-process tuning options from demo-script.json (e.g. otpKeep, maxInstitution)
      let postProcessArgs = '';
      const demoScriptPath = path.join(versionedDir, 'demo-script.json');
      if (fs.existsSync(demoScriptPath)) {
        try {
          const demoScr = JSON.parse(fs.readFileSync(demoScriptPath, 'utf8'));
          if (demoScr.postProcessOpts) {
            if (demoScr.postProcessOpts.otpKeep != null)
              postProcessArgs += ` --otp-keep ${demoScr.postProcessOpts.otpKeep}`;
            if (demoScr.postProcessOpts.maxInstitution != null)
              postProcessArgs += ` --max-institution ${demoScr.postProcessOpts.maxInstitution}`;
            if (demoScr.postProcessOpts.successKeep != null)
              postProcessArgs += ` --success-keep ${demoScr.postProcessOpts.successKeep}`;
          }
        } catch (_) {}
      }

      execSync(
        `node scripts/post-process-recording.js` +
          ` --input "${recordingIn}"` +
          ` --output "${recordingOut}"` +
          ` --timing "${timingFile}"` +
          postProcessArgs,
        { stdio: 'inherit', cwd: PROJECT_ROOT }
      );

      // Record that we have a post-processed recording so downstream stages can use it
      const summaryFile = path.join(versionedDir, 'post-process-summary.json');
      if (!fs.existsSync(summaryFile) && fs.existsSync(recordingOut)) {
        const { spawnSync: sp } = require('child_process');
        const probe = sp('ffprobe', [
          '-v', 'quiet', '-print_format', 'json', '-show_format', recordingOut,
        ], { encoding: 'utf8' });
        const processedDurationS = probe.status === 0
          ? parseFloat(JSON.parse(probe.stdout).format.duration)
          : null;
        fs.writeFileSync(summaryFile, JSON.stringify({
          processedRecording: recordingOut,
          processedDurationS,
          createdAt: new Date().toISOString(),
        }, null, 2));
        if (processedDurationS != null) {
          console.log(`[post-process] Processed recording: ${processedDurationS.toFixed(1)}s`);
        }
      }

      // ── Plaid sub-step minimum screen duration validation ──────────────────
      // Runs immediately after post-process writes processed-step-timing.json.
      // Each Plaid Link sub-step screen must be ≥ MIN_PLAID_SCREEN_MS (2000ms) in the
      // processed video, counting both the raw durationMs AND any freezeMs extension
      // that post-process-recording.js tagged onto the window.
      // Fail before voiceover so a bad recording doesn't waste ElevenLabs TTS calls.
      const MIN_PLAID_SCREEN_MS = 2000;
      const procTimingValidPath = path.join(versionedDir, 'processed-step-timing.json');
      if (fs.existsSync(procTimingValidPath)) {
        try {
          const pt = JSON.parse(fs.readFileSync(procTimingValidPath, 'utf8'));
          const shortScreens = (pt.plaidStepWindows || []).filter(w => {
            return (w.durationMs + (w.freezeMs || 0)) < MIN_PLAID_SCREEN_MS;
          });
          if (shortScreens.length > 0) {
            const details = shortScreens.map(w => {
              const eff = w.durationMs + (w.freezeMs || 0);
              return `  "${w.stepId}": ${eff}ms effective (raw ${w.durationMs}ms + ${w.freezeMs || 0}ms freeze)`;
            }).join('\n');
            throw new Error(
              `CRITICAL: Plaid screen(s) below ${MIN_PLAID_SCREEN_MS}ms minimum:\n${details}\n` +
              `Re-run from --from=post-process with a larger --max-institution value or re-record.`
            );
          }
          const windows = pt.plaidStepWindows || [];
          if (windows.length > 0) {
            console.log(`[post-process] Plaid screen duration validation: ${windows.length} screen(s) ≥ ${MIN_PLAID_SCREEN_MS}ms ✓`);
          }
        } catch (err) {
          if (err.message.startsWith('CRITICAL:')) throw err;
          console.warn(`[post-process] Could not validate Plaid screen durations: ${err.message}`);
        }
      }

      // Write a default sync-map.json if one doesn't already exist.
      // sync-map.json holds SYNC_MAP_S segments (speed/freeze) that tell both the
      // voiceover generator and Remotion how to align audio with the composed video.
      // After post-process, the default is identity (no adjustments). Humans or the
      // touchup stage can edit it; after any edit, run --from=resync-audio.
      const syncMapFile = path.join(versionedDir, 'sync-map.json');
      if (!fs.existsSync(syncMapFile)) {
        const { buildDefaultSyncMap } = require('../../scripts/sync-map-utils');
        fs.writeFileSync(syncMapFile, JSON.stringify(buildDefaultSyncMap(), null, 2));
        console.log('[post-process] Wrote default sync-map.json (identity — no speed/freeze adjustments)');
        console.log('[post-process] Edit sync-map.json to add speed/freeze windows, then run --from=resync-audio');
      } else {
        console.log('[post-process] Existing sync-map.json preserved (edit to change speed/freeze windows)');
      }
    }, timer);
  }

  // Stage: voiceover — runs after post-process so timing reflects the edited video.
  if (shouldRun('voiceover')) {
    await runStage('voiceover', async () => {
      // In scratch mode, skip initial stitching here to avoid duplicate work.
      // resync-audio is the authoritative stitch stage after auto-gap.
      execSync('node scripts/generate-voiceover.js --scratch --no-stitch', {
        stdio: 'inherit',
        cwd: PROJECT_ROOT,
      });
    }, timer);
  }

  // Coverage check — narration coverage: % of script steps/words that made it into voiceover manifest.
  if (shouldRun('coverage-check')) {
    await runStage('coverage-check', async () => {
      const { main } = require('./scratch/coverage-check.js');
      await main();
    }, timer);
  }

  // Stage: auto-gap — intelligent inter-scene timing.
  // Compares narration duration + recommended gap vs raw video scene duration per step.
  // Where video exceeds narration+gap, writes speed sync-map entries to compress the video.
  // Gap amounts are context-aware: 500ms (Plaid Link), 1000ms (default), 1500ms (intro),
  // 2000ms (API insight), 2500ms (outcome/reveal). resync-audio must run after this.
  if (shouldRun('auto-gap')) {
    await runStage('auto-gap', async () => {
      await require('../auto-gap').main();
    }, timer);
  }

  // Stage 6a: resync-audio — re-stitches voiceover.mp3 using sync-map.json inverse mapping.
  // Runs automatically after voiceover. Also the entry point when the user edits sync-map.json
  // or changes any speed/freeze window after voiceover was already generated.
  // Fast: only ffmpeg stitching, no ElevenLabs TTS calls.
  if (shouldRun('resync-audio')) {
    await runStage('resync-audio', async () => {
      // Warn if sync-map.json is newer than voiceover-manifest.json (stale audio)
      const syncMapFile    = path.join(versionedDir, 'sync-map.json');
      const manifestFile   = path.join(versionedDir, 'voiceover-manifest.json');
      if (fs.existsSync(syncMapFile) && fs.existsSync(manifestFile)) {
        const syncMapMtime  = fs.statSync(syncMapFile).mtimeMs;
        const manifestMtime = fs.statSync(manifestFile).mtimeMs;
        if (syncMapMtime > manifestMtime) {
          console.log('[resync-audio] sync-map.json is newer than voiceover-manifest.json — resync required');
        }
      }
      execSync('node scripts/resync-audio.js', {
        stdio: 'inherit',
        cwd:  PROJECT_ROOT,
        env:  { ...process.env, PIPELINE_RUN_DIR: versionedDir },
      });
      // Hard governor: after resync, narration must still map to the intended screen windows.
      assertNarrationSyncOrThrow(versionedDir, 'post-resync-audio');
    }, timer);
  }

  // Stage: embed-sync — audio-video alignment detection via multimodal embeddings (Phase 1).
  // Gracefully skips when VERTEX_AI_PROJECT_ID is absent — non-critical.
  if (shouldRun('embed-sync')) {
    await runStage('embed-sync', async () => {
      const embedSyncResult = await require('../embed-sync').main();
      // If corrections were auto-applied to sync-map.json, re-run resync-audio so the
      // stitched voiceover.mp3 reflects the updated segment timings before render.
      if (embedSyncResult?.autoApplied) {
        console.log('[embed-sync] Auto-applied sync corrections — re-running resync-audio...');
        execSync('node scripts/resync-audio.js', {
          stdio: 'inherit',
          cwd:   PROJECT_ROOT,
          env:   { ...process.env, PIPELINE_RUN_DIR: versionedDir },
        });
        assertNarrationSyncOrThrow(versionedDir, 'post-embed-sync-resync');
      }
    }, timer);
  }

  // Stage: audio QA — per-clip stutter/freeze detection + auto-regeneration, then
  // overall quality checks (clipping, duration desync).
  if (shouldRun('audio-qa')) {
    await runStage('audio-qa', async () => {
      const audioDir = path.join(versionedDir, 'audio');
      const manifestPath = path.join(versionedDir, 'voiceover-manifest.json');

      // ── Per-clip stutter/freeze detection ─────────────────────────────────
      // Stutter: short bursts of silence inside a clip (silencedetect noise=-40dB d=0.15)
      // Freeze:  a long flat-amplitude segment mid-clip (same filter, duration >= 0.5s)
      // Both are common ElevenLabs artefacts on long or punctuation-heavy narration strings.
      const stutteredClips = [];
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const { spawnSync: spawnSyncAudio } = require('child_process');

        for (const clip of (manifest.clips || [])) {
          if (!fs.existsSync(clip.audioFile)) continue;

          // Run silencedetect on individual clip file
          const r = spawnSyncAudio(
            'ffmpeg',
            ['-i', clip.audioFile, '-af', 'silencedetect=noise=-40dB:d=0.15', '-f', 'null', '-'],
            { encoding: 'utf8', timeout: 30000 }
          );
          const out = (r.stderr || '') + (r.stdout || '');
          const silenceEnds = [...out.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)];

          // A mid-clip silence (start > 0.05s from clip start) indicates stutter or freeze
          const clipDuration = clip.audioDurationMs / 1000;
          const internalSilences = silenceEnds.filter(m => {
            const end = parseFloat(m[1]);
            const dur = parseFloat(m[2]);
            const start = end - dur;
            // Ignore leading silence (first 0.1s) and trailing silence (last 0.3s)
            return start > 0.1 && end < (clipDuration - 0.3) && dur >= 0.15;
          });

          if (internalSilences.length > 0) {
            const maxDur = Math.max(...internalSilences.map(m => parseFloat(m[2])));
            const type = maxDur >= 0.5 ? 'freeze' : 'stutter';
            console.warn(`  [Audio QA] ${type} detected in ${clip.id}: ${internalSilences.length} internal silence(s), max ${maxDur.toFixed(2)}s`);
            stutteredClips.push({ clip, type, count: internalSilences.length, maxDur });
          }
        }

        if (stutteredClips.length > 0) {
          console.warn(`[Audio QA] ${stutteredClips.length} clip(s) have stutter/freeze — regenerating...`);
          for (const { clip } of stutteredClips) {
            // Delete the bad file so generate-voiceover.js regenerates it
            try { fs.unlinkSync(clip.audioFile); } catch (_) {}
            console.log(`  [Audio QA] Deleted ${path.basename(clip.audioFile)} for regeneration`);
          }
          // Also delete the stitched voiceover so it gets rebuilt
          const voiceoverPath = path.join(audioDir, 'voiceover.mp3');
          try { if (fs.existsSync(voiceoverPath)) fs.unlinkSync(voiceoverPath); } catch (_) {}

          // Re-run generate-voiceover.js to regenerate only the deleted clips.
          // Skip stitching here; resync-audio performs a single authoritative stitch.
          console.log('[Audio QA] Re-running voiceover generation for affected clips...');
          execSync('node scripts/generate-voiceover.js --scratch --no-stitch', {
            stdio: 'inherit',
            cwd: PROJECT_ROOT,
          });
          // Keep audio timeline and sync-governor state coherent after regeneration.
          execSync('node scripts/resync-audio.js', {
            stdio: 'inherit',
            cwd: PROJECT_ROOT,
            env:  { ...process.env, PIPELINE_RUN_DIR: versionedDir },
          });
          assertNarrationSyncOrThrow(versionedDir, 'post-audio-qa-regeneration');
          console.log('[Audio QA] Regeneration complete.');
        } else {
          console.log('[Audio QA] Per-clip stutter/freeze check: all clips clean.');
        }
      }

      // ── Overall voiceover quality checks ──────────────────────────────────
      const { passed, issues } = checkAudioQuality(versionedDir);

      const durationIssues = issues.filter(i =>
        i.includes('longer than the video') || i.includes('50% longer')
      );
      const clippingIssues = issues.filter(i => i.includes('clipping') || i.includes('truncated'));

      if (issues.length > 0) {
        console.warn('[Audio QA] Overall issues found:');
        for (const issue of issues) console.warn(`  ⚠ ${issue}`);
      }

      // Write audio QA report
      fs.writeFileSync(
        path.join(versionedDir, 'audio-qa-report.json'),
        JSON.stringify({
          passed,
          issues,
          stutteredClips: stutteredClips.map(s => ({ id: s.clip.id, type: s.type, count: s.count, maxDurS: s.maxDur })),
          checkedAt: new Date().toISOString(),
        }, null, 2)
      );

      if (durationIssues.length > 0 || clippingIssues.length > 0) {
        const severity = durationIssues.length > 0 ? 'audio-video desync' : 'audio clipping';
        console.warn(`[Audio QA] ${severity} detected — final audio may be cut off or distorted.`);
        if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
          await promptContinue(`[Audio QA] ${severity} detected. Review audio before rendering.`);
        } else {
          console.warn('[Audio QA] SCRATCH_AUTO_APPROVE=true — advancing with audio issues.');
        }
      } else if (!passed) {
        console.warn('[Audio QA] Audio quality issues detected. Proceeding with render but review the final output.');
      } else {
        console.log('[Audio QA] Audio quality check passed.');
      }
    }, timer);
  }

  // Stage: ai-suggest-overlays — Gemini overlay suggestion engine (graceful skip if no credentials)
  if (shouldRun('ai-suggest-overlays')) {
    await runStage('ai-suggest-overlays', async () => {
      const hasKey = process.env.GOOGLE_API_KEY || process.env.VERTEX_AI_PROJECT_ID;
      if (!hasKey) {
        console.log('[ai-suggest-overlays] No credentials (GOOGLE_API_KEY / VERTEX_AI_PROJECT_ID) — skipping.');
        return;
      }
      await require('./scratch/ai-suggest-overlays').main();
    }, timer);
  }

  // Stage: render
  if (shouldRun('render')) {
    await runStage('render', async () => {
      // Final hard-stop governor before render output is produced.
      assertNarrationSyncOrThrow(versionedDir, 'pre-render');

      // ── Pre-flight: verify required artifacts exist ───────────────────────
      // Missing artifacts produce silent failures (no audio, 0-frame video, desync).
      const preflight = [
        { file: 'recording-processed.webm', label: 'Processed recording', fallback: 'recording.webm' },
        { file: 'audio/voiceover.mp3',      label: 'Voiceover audio' },
        { file: 'voiceover-manifest.json',  label: 'Voiceover manifest' },
        { file: 'step-timing.json',         label: 'Step timing' },
      ];
      const preflightErrors = [];
      for (const c of preflight) {
        const primary  = path.join(versionedDir, c.file);
        const fallback = c.fallback ? path.join(versionedDir, c.fallback) : null;
        if (!fs.existsSync(primary) && !(fallback && fs.existsSync(fallback))) {
          preflightErrors.push(`Missing ${c.label} (${c.file})`);
        }
      }
      if (preflightErrors.length > 0) {
        throw new Error(`CRITICAL: Render pre-flight failed:\n  ${preflightErrors.join('\n  ')}`);
      }

      // Warn if sync-map.json is newer than voiceover-manifest.json — audio may be out of sync
      const syncMapFile2   = path.join(versionedDir, 'sync-map.json');
      const manifestFile2  = path.join(versionedDir, 'voiceover-manifest.json');
      if (fs.existsSync(syncMapFile2) && fs.existsSync(manifestFile2)) {
        const syncMapMtime2  = fs.statSync(syncMapFile2).mtimeMs;
        const manifestMtime2 = fs.statSync(manifestFile2).mtimeMs;
        if (syncMapMtime2 > manifestMtime2) {
          console.warn('[Render] ⚠ WARNING: sync-map.json is newer than voiceover-manifest.json.');
          console.warn('[Render] ⚠ Audio may be out of sync with video speed/freeze adjustments.');
          console.warn('[Render] ⚠ Run --from=resync-audio before re-rendering to fix this.');
        }
        // Also check resyncedAt in manifest to confirm resync-audio was run
        try {
          const mf = JSON.parse(fs.readFileSync(manifestFile2, 'utf8'));
          if (!mf.syncMapApplied && fs.existsSync(syncMapFile2)) {
            const sm = JSON.parse(fs.readFileSync(syncMapFile2, 'utf8'));
            if ((sm.segments || []).length > 0) {
              console.warn('[Render] ⚠ WARNING: voiceover-manifest.json was not generated with sync-map applied.');
              console.warn('[Render] ⚠ Run --from=resync-audio to apply sync-map and fix audio timing.');
            }
          }
        } catch {}
      }

      // Stage this run's recording + voiceover into public/ for Remotion
      stageArtifactsForRemotion(versionedDir);

      // Build Remotion input props from pipeline artifacts
      const remotionProps = buildRemotionProps();
      const propsFile = path.join(versionedDir, 'remotion-props.json');
      fs.writeFileSync(propsFile, JSON.stringify(remotionProps, null, 2));
      console.log('[Render] Generated remotion-props.json');

      const outFile = path.join(versionedDir, 'demo-scratch.mp4');
      execSync(
        `npx remotion render remotion/index.js DemoScratch "${outFile}" --props="${propsFile}" --timeout=120000 --log=warn`,
        { stdio: 'inherit', cwd: PROJECT_ROOT }
      );
    }, timer);
  }

  // Stage: ppt
  if (shouldRun('ppt')) {
    await runStage('ppt', async () => {
      await require('./generate-ppt').main({
        inputVideo: path.join(OUT_DIR, 'demo-scratch.mp4'),
        outputDir:  versionedDir,
      });
    }, timer);
  }

  // Stage: touchup
  if (shouldRun('touchup') && !noTouchup) {
    await runStage('touchup', async () => {
      await require('./touchup').main({ composition: 'DemoScratch' });
    }, timer);
  } else if (noTouchup) {
    cliLog('[Orchestrator] Skipping touchup (--no-touchup).');
  }
}

// ── Mode B: Enhance pipeline ──────────────────────────────────────────────────

async function runEnhancePipeline({ startIdx, noTouchup, versionedDir, timer }) {
  const stageRunner = async (name, idx, fn) => {
    if (idx < startIdx) {
      cliLog(`[Orchestrator] Skipping stage: ${name} (--from)`);
      return;
    }
    await runStage(name, fn, timer);
  };

  await stageRunner('research', 0, async () => {
    await require('./research').main();
  });

  await stageRunner('ingest', 1, async () => {
    await require('./enhance/analyze-video').main();
  });

  await stageRunner('script', 2, async () => {
    await require('./enhance/segment').main();
  });

  await stageRunner('script-critique', 3, async () => {
    await require('./enhance/enhance-script').main();
  });

  await stageRunner('build', 4, async () => {
    await require('./enhance/overlay-plan').main();
  });

  // voiceover — enhance mode uses ElevenLabs TTS only (no Playwright recording)
  if (STAGES.indexOf('voiceover') >= startIdx) {
    await runStage('voiceover', async () => {
      execSync('node scripts/generate-voiceover.js --scratch', {
        stdio: 'inherit',
        cwd: PROJECT_ROOT,
      });
    }, timer);
  }

  // Audio QA — check for choppy audio
  if (STAGES.indexOf('audio-qa') >= startIdx) {
    await runStage('audio-qa', async () => {
      const { passed, issues } = checkAudioQuality(versionedDir);
      if (issues.length > 0) {
        console.log('[Audio QA] Issues found:');
        for (const issue of issues) console.log(`  ⚠ ${issue}`);
      }
      fs.writeFileSync(
        path.join(versionedDir, 'audio-qa-report.json'),
        JSON.stringify({ passed, issues, checkedAt: new Date().toISOString() }, null, 2)
      );
      if (passed) console.log('[Audio QA] Audio quality check passed.');
      else console.warn('[Audio QA] Audio quality issues detected — review final output.');
    }, timer);
  }

  if (STAGES.indexOf('render') >= startIdx) {
    await runStage('render', async () => {
      stageArtifactsForRemotion(versionedDir);
      const remotionProps = buildRemotionProps();
      const propsFile = path.join(versionedDir, 'remotion-props.json');
      fs.writeFileSync(propsFile, JSON.stringify(remotionProps, null, 2));

      const outFile = path.join(versionedDir, 'demo-enhance.mp4');
      execSync(
        `npx remotion render remotion/index.js DemoEnhance "${outFile}" --props="${propsFile}" --timeout=120000 --log=warn`,
        { stdio: 'inherit', cwd: PROJECT_ROOT }
      );
    }, timer);
  }

  if (STAGES.indexOf('ppt') >= startIdx) {
    await runStage('ppt', async () => {
      await require('./generate-ppt').main({
        inputVideo: path.join(OUT_DIR, 'demo-enhance.mp4'),
        outputDir:  versionedDir,
      });
    }, timer);
  }

  if (STAGES.indexOf('touchup') >= startIdx && !noTouchup) {
    await runStage('touchup', async () => {
      await require('./touchup').main({ composition: 'DemoEnhance' });
    }, timer);
  } else if (noTouchup) {
    cliLog('[Orchestrator] Skipping touchup (--no-touchup).');
  }
}

// ── Mode C: Hybrid pipeline ───────────────────────────────────────────────────

async function runHybridPipeline({ startIdx, noTouchup, versionedDir, promptText, timer }) {
  const stageRunner = async (name, idx, fn) => {
    if (idx < startIdx) {
      cliLog(`[Orchestrator] Skipping stage: ${name} (--from)`);
      return;
    }
    await runStage(name, fn, timer);
  };

  // Research first
  await stageRunner('research', 0, async () => {
    await require('./research').main();
  });

  // Parse the pipeline plan if we haven't skipped past this point
  let plan = { segments: [] };
  if (STAGES.indexOf('ingest') >= startIdx) {
    await runStage('ingest (plan)', async () => {
      cliLog('[Orchestrator] Building hybrid pipeline plan...');
      plan = await buildPipelinePlan(promptText);
      const planFile = path.join(OUT_DIR, 'pipeline-plan.json');
      fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
      cliLog(`[Orchestrator] Pipeline plan written: ${planFile}`);
      cliLog(`[Orchestrator] Segments: ${plan.segments.length}`);
      plan.segments.forEach(s =>
        cliLog(`  [${s.type}] ${s.id}: ${s.description}`)
      );
    }, timer);
  } else {
    // Load existing plan if restarting from a later stage
    const planFile = path.join(OUT_DIR, 'pipeline-plan.json');
    if (fs.existsSync(planFile)) {
      plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      cliLog(`[Orchestrator] Loaded existing pipeline plan (${plan.segments.length} segments)`);
    }
  }

  // For recorded segments: run enhance sub-pipeline
  // For built segments: run scratch sub-pipeline
  const recordedSegments = plan.segments.filter(s => s.type === 'recorded');
  const builtSegments    = plan.segments.filter(s => s.type === 'build');

  if (STAGES.indexOf('build') >= startIdx) {
    await runStage('build (hybrid)', async () => {
      // Process each recorded segment through the enhance sub-pipeline
      for (const seg of recordedSegments) {
        cliLog(`[Orchestrator] Enhancing recorded segment: ${seg.id}`);
        await require('./enhance/analyze-video').main({ segmentId: seg.id, file: seg.file });
        await require('./enhance/segment').main({ segmentId: seg.id });
        await require('./enhance/enhance-script').main({ segmentId: seg.id });
        await require('./enhance/overlay-plan').main({ segmentId: seg.id });
      }

      // Process each built segment through the scratch sub-pipeline
      for (const seg of builtSegments) {
        cliLog(`[Orchestrator] Building scratch segment: ${seg.id}`);
        await require('./scratch/generate-script').main({ segmentId: seg.id });
        await runScriptCritique();
        await require('./scratch/build-app').main({ segmentId: seg.id });
        await require('./scratch/record-local').main({ segmentId: seg.id, iteration: 1 });
        const qaResult = await require('./scratch/qa-review').main({ segmentId: seg.id, iteration: 1 });
        if (!qaResult?.passed) {
          cliWarn(`[Orchestrator] Segment ${seg.id} QA did not pass (score: ${qaResult?.overallScore}). Continuing.`);
        }
      }
    }, timer);
  }

  // Combine all segments
  if (STAGES.indexOf('record') >= startIdx) {
    await runStage('combine', async () => {
      await require('./enhance/combine').main({ plan });
    }, timer);
  }

  // Shared finishing stages
  if (STAGES.indexOf('voiceover') >= startIdx) {
    await runStage('voiceover', async () => {
      execSync('node scripts/generate-voiceover.js --scratch', {
        stdio: 'inherit',
        cwd: PROJECT_ROOT,
      });
    }, timer);
  }

  // Audio QA — check for choppy audio
  if (STAGES.indexOf('audio-qa') >= startIdx) {
    await runStage('audio-qa', async () => {
      const { passed, issues } = checkAudioQuality(versionedDir);
      if (issues.length > 0) {
        console.log('[Audio QA] Issues found:');
        for (const issue of issues) console.log(`  ⚠ ${issue}`);
      }
      fs.writeFileSync(
        path.join(versionedDir, 'audio-qa-report.json'),
        JSON.stringify({ passed, issues, checkedAt: new Date().toISOString() }, null, 2)
      );
      if (passed) console.log('[Audio QA] Audio quality check passed.');
      else console.warn('[Audio QA] Audio quality issues detected — review final output.');
    }, timer);
  }

  if (STAGES.indexOf('render') >= startIdx) {
    await runStage('render', async () => {
      stageArtifactsForRemotion(versionedDir);
      const remotionProps = buildRemotionProps();
      const propsFile = path.join(versionedDir, 'remotion-props.json');
      fs.writeFileSync(propsFile, JSON.stringify(remotionProps, null, 2));

      const outFile = path.join(versionedDir, 'demo-hybrid.mp4');
      execSync(
        `npx remotion render remotion/index.js DemoEnhance "${outFile}" --props="${propsFile}"`,
        { stdio: 'inherit', cwd: PROJECT_ROOT }
      );
      fs.copyFileSync(outFile, path.join(OUT_DIR, 'demo-hybrid.mp4'));
    }, timer);
  }

  if (STAGES.indexOf('ppt') >= startIdx) {
    await runStage('ppt', async () => {
      await require('./generate-ppt').main({
        inputVideo: path.join(OUT_DIR, 'demo-hybrid.mp4'),
        outputDir:  versionedDir,
      });
    }, timer);
  }

  if (STAGES.indexOf('touchup') >= startIdx && !noTouchup) {
    await runStage('touchup', async () => {
      await require('./touchup').main({ composition: 'DemoEnhance' });
    }, timer);
  } else if (noTouchup) {
    cliLog('[Orchestrator] Skipping touchup (--no-touchup).');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { mode: cliMode, fromStage, toStage, runId: explicitRunId, noTouchup, recordMode } = parseArgs();
  let effectiveFromStage = fromStage;

  let endIdx = null;
  if (toStage) {
    endIdx = STAGES.indexOf(toStage);
    if (endIdx < 0) {
      cliError(`[Orchestrator] Unknown --to="${toStage}". Valid stages: ${STAGES.join(', ')}`);
      process.exit(1);
    }
    cliLog(`[Orchestrator] --to=${toStage} — pipeline stops after this stage`);
  }

  const bannerTs = cliIsoTime();
  console.log('');
  console.log(`[${bannerTs}] ${'='.repeat(54)}`);
  console.log(`[${bannerTs}] Plaid Demo Pipeline — Orchestrator`);
  console.log(`[${bannerTs}] ${'='.repeat(54)}`);
  console.log('');

  const timer = makeTimer();

  // Load prompt
  const promptText = loadPrompt();
  if (promptText) {
    cliLog(`[Orchestrator] Prompt: "${promptText.substring(0, 120).replace(/\n/g, ' ')}..."`);
  } else {
    cliLog('[Orchestrator] No prompt.txt found — using defaults.');
  }
  const { fingerprint: promptFingerprint, firstUse: promptFirstUse, registry: promptRegistry } = detectFirstUsePrompt(promptText);
  const forceFreshCleanup =
    process.env.PIPELINE_FRESH_CLEANUP === 'true' || process.env.PIPELINE_FRESH_CLEANUP === '1';
  const autoFresh = !!promptFirstUse || forceFreshCleanup;
  if (promptFirstUse) {
    cliLog('[Orchestrator] First use of this prompt.txt detected — enabling automatic fresh run behavior.');
    if (effectiveFromStage) {
      cliLog(`[Orchestrator] Ignoring --from=${effectiveFromStage} for first-use prompt; running from beginning to avoid stale artifacts.`);
      effectiveFromStage = null;
    }
  } else if (forceFreshCleanup) {
    cliLog('[Orchestrator] PIPELINE_FRESH_CLEANUP enabled — scrubbing prior build artifacts in run dir and running full pipeline from start.');
    if (effectiveFromStage) {
      cliLog(`[Orchestrator] Ignoring --from=${effectiveFromStage} because PIPELINE_FRESH_CLEANUP is set.`);
      effectiveFromStage = null;
    }
  }

  if (effectiveFromStage && !explicitRunId && !process.env.PIPELINE_RUN_DIR) {
    cliError(
      '[Orchestrator] --from requires explicit run identity. ' +
      'Pass --run-id=<runId> or set PIPELINE_RUN_DIR.'
    );
    process.exit(1);
  }

  // Determine mode
  let mode;
  if (cliMode) {
    if (!['scratch', 'enhance', 'hybrid'].includes(cliMode)) {
      cliError(`[Orchestrator] Invalid --mode="${cliMode}". Must be scratch, enhance, or hybrid.`);
      process.exit(1);
    }
    mode = cliMode;
    cliLog(`[Orchestrator] Mode: ${mode} (from CLI)`);
  } else {
    mode = await classifyMode(promptText);
  }

  // Determine versioned output directory — this becomes the isolated run dir
  const runNameStem = buildRunNameStem(promptText);
  cliLog(`[Orchestrator] Run naming stem: ${runNameStem}`);
  let versionedDir;

  if (process.env.PIPELINE_RUN_DIR && fs.existsSync(process.env.PIPELINE_RUN_DIR)) {
    // Dashboard (or other caller) already specified the exact run directory — use it directly.
    versionedDir = path.resolve(process.env.PIPELINE_RUN_DIR);
    cliLog(`[Orchestrator] Using caller-specified run dir: ${versionedDir}`);
    setLatestLink(versionedDir);
  } else if (explicitRunId) {
    // Explicit run target for restarts/resumes (no heuristic directory selection).
    const candidate = path.join(DEMOS_DIR, explicitRunId);
    if (!fs.existsSync(candidate)) {
      cliError(`[Orchestrator] --run-id not found: ${explicitRunId}`);
      process.exit(1);
    }
    versionedDir = candidate;
    cliLog(`[Orchestrator] Using explicit run id: ${explicitRunId}`);
    setLatestLink(versionedDir);
  } else if (effectiveFromStage) {
    cliError('[Orchestrator] --from restart requires explicit run identity (--run-id or PIPELINE_RUN_DIR).');
    process.exit(1);
  } else {
    versionedDir = resolveVersionedDir(runNameStem);
  }

  // ── PIPELINE_RUN_DIR: all scripts write artifacts here instead of shared out/ ──
  process.env.PIPELINE_RUN_DIR = versionedDir;
  writeRunDirMarker(versionedDir);
  const runManifest = ensureRunManifest(versionedDir, {
    runId: path.basename(versionedDir),
    mode,
    runNameStem,
    promptFingerprint,
    sourcePromptFile: path.join(INPUTS_DIR, 'prompt.txt'),
    sourcePromptHash: promptFingerprint || null,
  });
  snapshotRunInputs(versionedDir, {
    promptText: promptText || '',
    sourcePromptFile: path.join(INPUTS_DIR, 'prompt.txt'),
    researchMode: process.env.RESEARCH_MODE || null,
    cli: { cliMode, fromStage, toStage, explicitRunId, noTouchup, recordMode },
  });
  process.env.PIPELINE_RUN_ID = runManifest.runId;
  process.env.PIPELINE_RUN_MANIFEST = path.join(versionedDir, 'run-manifest.json');
  process.env.PIPELINE_BUILD_LOG_FILE = path.join(versionedDir, 'artifacts', 'logs', 'pipeline-build.log.md');
  initPipelineBuildLog({
    runDir: versionedDir,
    runId: runManifest.runId,
    mode,
    fromStage: effectiveFromStage || null,
    toStage: endIdx == null ? null : STAGES[endIdx],
    promptSnippet: promptText ? promptText.substring(0, 200).replace(/\n/g, ' ') : null,
  });
  appendPipelineLogJson('[RUN] Invocation context', {
    runId: runManifest.runId,
    runDir: versionedDir,
    mode,
    runNameStem,
    promptFingerprint: promptFingerprint || null,
    cli: { cliMode, fromStage, toStage, explicitRunId, noTouchup, recordMode },
  }, { runDir: versionedDir });
  if (autoFresh) {
    applyFreshCleanup(versionedDir);
    cliLog(
      `[Orchestrator] Applied fresh cleanup (${promptFirstUse ? 'first-use prompt' : 'PIPELINE_FRESH_CLEANUP'}).`
    );
    appendPipelineLogSection('[RUN] Fresh cleanup', ['autoFresh=true', 'status=applied'], { runDir: versionedDir });
  }
  recordPromptUse({ registry: promptRegistry, fingerprint: promptFingerprint, runDir: versionedDir });
  cliLog(`[Orchestrator] Run directory (isolated): ${versionedDir}`);
  cliLog(`[Orchestrator] Symlink: ${LATEST_LINK}`);

  // Determine start index (for --from)
  const startIdx = resolveStartIndex(effectiveFromStage);

  // Log Plaid Link mode
  const plaidLinkLive = process.env.PLAID_LINK_LIVE === 'true';
  if (plaidLinkLive) {
    cliLog('[Orchestrator] Plaid Link mode: LIVE (sandbox) — real SDK + iframe automation');
  } else {
    cliLog('[Orchestrator] Plaid Link mode: MOCK (self-contained HTML mockups)');
  }

  const stagePlan = endIdx == null
    ? STAGES.slice(startIdx)
    : STAGES.slice(startIdx, endIdx + 1);
  cliLog(`[Orchestrator] Mode: ${mode.toUpperCase()} | Stages: ${stagePlan.join(' → ')}`);
  appendPipelineLogSection('[RUN] Stage plan', [
    `mode=${mode}`,
    `fromIndex=${startIdx}`,
    `toIndex=${endIdx == null ? 'end' : endIdx}`,
    `stages=${stagePlan.join(' -> ')}`,
  ], { runDir: versionedDir });
  console.log('');

  // Ensure run directory exists
  fs.mkdirSync(versionedDir, { recursive: true });

  // Dispatch to the correct pipeline
  const pipelineArgs = { startIdx, endIdx, noTouchup, versionedDir, promptText, timer, recordMode };

  if (recordMode === 'studio') {
    cliLog('[Orchestrator] Record mode: STUDIO (human-driven via our-recorder)');
  }

  if (mode === 'scratch') {
    await runScratchPipeline(pipelineArgs);
  } else if (mode === 'enhance') {
    await runEnhancePipeline(pipelineArgs);
  } else if (mode === 'hybrid') {
    await runHybridPipeline(pipelineArgs);
  }

  const total = timer.totalElapsed();
  const doneTs = cliIsoTime();
  console.log('');
  console.log(`[${doneTs}] ${'='.repeat(54)}`);
  console.log(`[${doneTs}] MILESTONE: pipeline complete | ${total}s total`);
  console.log(`[${doneTs}] output: ${versionedDir}`);
  console.log(`[${doneTs}] ${'='.repeat(54)}`);
  console.log('');
  appendPipelineLogSection('[RUN] Pipeline complete', [
    `at=${doneTs}`,
    `totalSeconds=${total}`,
    `outputDir=${versionedDir}`,
  ], { runDir: versionedDir });
}

main().catch(err => {
  cliError(`[Orchestrator] Fatal error: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});

module.exports = { main };
