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

// Preserve explicitly provided shell env values before dotenv override.
const ORCHESTRATOR_PRESERVED_ENV_KEYS = ['RECORDING_FPS', 'RECORD_POSTPROCESS_TIMEOUT_MS'];
const orchestratorPreservedEnv = {};
for (const key of ORCHESTRATOR_PRESERVED_ENV_KEYS) {
  if (process.env[key] != null) orchestratorPreservedEnv[key] = process.env[key];
}
// Use the worktree-aware loader so Cursor / Claude Code git worktrees
// (which don't carry gitignored files like .env) still see the main repo's
// secrets. Falls back to a bare dotenv.config() if the helper is missing.
const __orchestratorPath = require('path');
const __orchestratorRoot = __orchestratorPath.resolve(__dirname, '../..');
try {
  const { loadRepoEnv } = require(__orchestratorPath.join(
    __orchestratorRoot, 'scripts', 'scratch', 'utils', 'dotenv-loader.js'
  ));
  const __envResult = loadRepoEnv(__orchestratorRoot, { override: true });
  if (__envResult.loaded) {
    console.log(`[Orchestrator] ${__envResult.message}`);
  } else {
    console.warn(`[Orchestrator] ${__envResult.message}`);
  }
} catch (_) {
  require('dotenv').config({ override: true });
}
for (const [key, value] of Object.entries(orchestratorPreservedEnv)) {
  process.env[key] = value;
}

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');
const readline      = require('readline');
const Anthropic     = require('@anthropic-ai/sdk');
const { validateNarrationSync, writeReport: writeNarrationSyncReport } = require('../validate-narration-sync');
const {
  requireRunDir,
  ensureRunManifest,
  readRunManifest,
  snapshotRunInputs,
  writeRunDirMarker,
} = require('./utils/run-io');
const { fingerprintPrompt } = require('./utils/prompt-fingerprint');
const {
  initPipelineBuildLog,
  appendPipelineLogSection,
  appendPipelineLogJson,
} = require('./utils/pipeline-logger');
const { shouldIncludeCraRunNameToken } = require('./utils/prompt-scope');
const { resolveSlideQaMaxIterations } = require('./utils/slide-qa-config');

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

// ── ::PIPE:: structured events (machine-parseable markers on stdout) ──────────
//
// Consumers (bin/pipe.js, Claude in Cursor) parse these to track stage progress
// without scraping the free-form human log. Keys are URL-like key=value pairs;
// quote values containing whitespace. All events include ts + runId.

function cliPipeEscape(value) {
  const s = String(value == null ? '' : value);
  if (!/[\s"=]/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function emitPipeEvent(event, fields = {}) {
  const parts = [`event=${cliPipeEscape(event)}`];
  parts.push(`ts=${cliIsoTime()}`);
  const runId = process.env.PIPELINE_RUN_ID || '';
  if (runId) parts.push(`runId=${cliPipeEscape(runId)}`);
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    parts.push(`${k}=${cliPipeEscape(v)}`);
  }
  // Use stdout (not stderr) so CLI log capture sees it alongside other output.
  console.log(`::PIPE:: ${parts.join('  ')}`);
}

// ── Pipeline PID file lifecycle ──────────────────────────────────────────────
//
// Written on boot to {runDir}/.pipeline.pid so `pipe stop` and `pipe status`
// can identify the active orchestrator without scanning `ps aux`. Removed on
// clean exit; signal handlers best-effort clean up on SIGTERM/SIGINT too.

let _pidFilePath = null;
let _pipelineHeartbeatHandle = null;

function startOrchestratorHeartbeat(runDir) {
  try {
    const { startPipelineHeartbeat } = require('./utils/pipeline-heartbeat');
    if (_pipelineHeartbeatHandle) _pipelineHeartbeatHandle.stop();
    _pipelineHeartbeatHandle = startPipelineHeartbeat({
      runDir,
      warn: (msg) => cliWarn(msg),
    });
  } catch (err) {
    cliWarn(`[Orchestrator] Could not start pipeline heartbeat: ${err.message}`);
  }
}

function stopOrchestratorHeartbeat() {
  if (_pipelineHeartbeatHandle) {
    try { _pipelineHeartbeatHandle.stop(); } catch (_) { /* ignore */ }
    _pipelineHeartbeatHandle = null;
  }
}

function writePipelinePidFile(runDir) {
  if (!runDir) return;
  try {
    fs.mkdirSync(runDir, { recursive: true });
    const pidFile = path.join(runDir, '.pipeline.pid');
    fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
    _pidFilePath = pidFile;
  } catch (err) {
    cliWarn(`[Orchestrator] Could not write .pipeline.pid: ${err.message}`);
  }
}

function cleanupPipelinePidFile() {
  if (!_pidFilePath) return;
  try {
    if (fs.existsSync(_pidFilePath)) fs.unlinkSync(_pidFilePath);
  } catch (_) { /* ignore */ }
  _pidFilePath = null;
}

function orchestratorCleanup() {
  stopOrchestratorHeartbeat();
  cleanupPipelinePidFile();
  const rd = process.env.PIPELINE_RUN_DIR;
  if (rd) {
    try {
      const { releasePipelineLock } = require('./utils/pipeline-lock');
      releasePipelineLock(rd);
    } catch (_) { /* ignore */ }
  }
}

process.on('exit', orchestratorCleanup);
process.on('SIGTERM', () => { orchestratorCleanup(); process.exit(143); });
process.on('SIGINT',  () => { orchestratorCleanup(); process.exit(130); });

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
  'prompt-fidelity-check',   // Story-fidelity gate: diffs prompt.txt entities vs demo-script.json
                             //   before script-critique. Critical drift in agent mode pauses the
                             //   orchestrator on a continue-gate so the agent fixes before build.
  'script-critique',
  'data-realism-check',      // Sample-data realism gate: catches generic placeholders, persona/
                             //   balance inconsistencies, fake-looking transaction feeds, masking
                             //   format mismatches BEFORE the build LLM bakes them into HTML.
  'embed-script-validate',   // narration/visual coherence (Vertex embeddings → Haiku fallback)
  // 'plaid-link-capture',  // DISABLED — using manual Playwright recording of real Plaid Link
  'build',
  'live-api-capture',        // Deterministic (zero-LLM): call the demo's featured /api/* routes
                             //   against the sandbox → artifacts/live-api-responses.json so panels
                             //   augment curated mocks with real responses (" — live"). Self-skips
                             //   when PLAID_LINK_LIVE!=true.
  'plaid-link-qa',
  'build-qa',
  'post-slides',             // Agent-driven per-slide insertion (runs only when slide-kind steps exist)
  'post-panels',             // Deterministic JSON side-panel normalizer (idempotent)
  'api-panel-audit',         // Validate apiResponse JSON vs Plaid contracts (live-capture +
                             //   AskBill + deterministic rules). Flag-only; agent fixes via
                             //   api-panel-audit-task.md. API_PANEL_AUDIT_STRICT=true hard-fails.
  'app-touchup',             // Tier-scoped app recovery lane — patches + post-panels +
                             //   app-scoped build-qa + agent qa-app-touchup-task.md. No build-app.
  'slide-fix',               // Tier-scoped slide recovery lane — patches + strip + post-slides
                             //   --steps=… + post-panels + slides-scoped build-qa + agent
                             //   qa-slide-fix-task.md. No build-app. App+slides only.
  'set-recording-dwells',    // Compute per-step dwell from narration word count and override
                             //   playwright-script.json waitMs BEFORE recording. Narration is
                             //   ground truth; recording dwells to match.
  'record',
  'qa',
  'figma-review',
  'post-process',
  'measure-sync-debt',       // Classify per-step drift (audio-too-long, audio-too-short,
                             //   video-too-short, etc.) — runs BEFORE voiceover so the
                             //   repace stage can rewrite narration to match real video.
  'repace-narration',        // Rewrite narration text to fit measured video duration when
                             //   the rewrite stays within budget. Triggers voiceover regen
                             //   via narration fingerprint invalidation.
  'voiceover',
  'story-echo-check',        // Whole-video story-fidelity gate: Sonnet grades whether the
                             //   voiceover end-to-end answers the user's prompt.txt pitch.
                             //   Critical drift in agent mode pauses on a continue-gate.
  'coverage-check',          // Narration coverage: % of scripted steps/words that made it into voiceover
  'auto-gap',                // Intelligent inter-scene timing: clips video to narration+gap, not raw recording
  'resync-audio',
  'embed-sync',              // Phase 1: audio-video sync alignment detection (skips when no GCP creds)
  'audio-qa',
  'ai-suggest-overlays',    // Gemini 2.0 Flash: per-step overlay suggestion patches (skips when no credentials)
  'render',
  'scene-match-check',       // Multimodal (Haiku Vision) gate: validate each rendered narration
                             //   segment's frame actually depicts what is being narrated. Advisory
                             //   by default; SCENE_MATCH_GATE=strict makes it block touchup.
  'ppt',
  'touchup',                 // POST-RENDER Remotion polish stage. Cosmetic only — edits Remotion
                             //   compositions + overlay-plan.json. Does NOT modify scratch-app HTML.
                             //   For build-time HTML fixes use `pipe qa-touchup` instead. Disable
                             //   with --no-touchup. (Distinct from --build-fix-mode=touchup, which
                             //   is the LLM-narrowed app regeneration path.)
];

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);

  const modeArg       = args.find(a => a.startsWith('--mode='));
  const fromArg       = args.find(a => a.startsWith('--from='));
  const toArg         = args.find(a => a.startsWith('--to='));
  const runIdArg      = args.find(a => a.startsWith('--run-id='));
  const recordModeArg = args.find(a => a.startsWith('--record-mode='));
  const qaThresholdArg = args.find(a => a.startsWith('--qa-threshold='));
  const maxRefineArg = args.find(a => a.startsWith('--max-refinement-iterations='));
  const buildFixModeArg = args.find(a => a.startsWith('--build-fix-mode='));
  const noTouchup     = args.includes('--no-touchup');
  const withSlidesFlag = args.includes('--with-slides');
  const appOnlyFlag    = args.includes('--app-only');
  const withPanelsFlag = args.includes('--with-panels');
  const noPanelsFlag   = args.includes('--no-panels');

  const mode       = modeArg       ? modeArg.replace('--mode=', '').toLowerCase()        : null;
  const fromStage  = fromArg       ? fromArg.replace('--from=', '').toLowerCase()         : null;
  const toStage    = toArg         ? toArg.replace('--to=', '').toLowerCase()             : null;
  const runId      = runIdArg      ? runIdArg.replace('--run-id=', '').trim()             : null;
  const recordMode = recordModeArg ? recordModeArg.replace('--record-mode=', '').toLowerCase()
                                   : (process.env.RECORD_MODE || '').toLowerCase() || null;
  const qaThreshold = qaThresholdArg ? parseInt(qaThresholdArg.replace('--qa-threshold=', '').trim(), 10) : null;
  const maxRefinementIterations = maxRefineArg
    ? parseInt(maxRefineArg.replace('--max-refinement-iterations=', '').trim(), 10)
    : null;
  const buildFixMode = buildFixModeArg ? buildFixModeArg.replace('--build-fix-mode=', '').trim().toLowerCase() : null;

  // --with-slides and --app-only are mutually exclusive; --app-only wins to keep
  // accidental enabling impossible when both are present.
  let withSlidesOverride = null;
  let withSlidesSource = null;
  if (appOnlyFlag) {
    withSlidesOverride = false;
    withSlidesSource = 'cli --app-only';
  } else if (withSlidesFlag) {
    withSlidesOverride = true;
    withSlidesSource = 'cli --with-slides';
  }

  if (withSlidesOverride != null) {
    process.env.PIPELINE_WITH_SLIDES = withSlidesOverride ? 'true' : 'false';
    process.env.PIPELINE_WITH_SLIDES_SOURCE = withSlidesSource;
  }

  // JSON/API panels are an INDEPENDENT axis from slides. --no-panels wins over
  // --with-panels if both are present. Default (no flag) leaves panels enabled
  // (resolveBuildModes treats unset PIPELINE_WITH_PANELS as 'true').
  let withPanelsOverride = null;
  let withPanelsSource = null;
  if (noPanelsFlag) {
    withPanelsOverride = false;
    withPanelsSource = 'cli --no-panels';
  } else if (withPanelsFlag) {
    withPanelsOverride = true;
    withPanelsSource = 'cli --with-panels';
  }
  if (withPanelsOverride != null) {
    process.env.PIPELINE_WITH_PANELS = withPanelsOverride ? 'true' : 'false';
    process.env.PIPELINE_WITH_PANELS_SOURCE = withPanelsSource;
  }

  return {
    mode,
    fromStage,
    toStage,
    runId,
    noTouchup,
    recordMode,
    qaThreshold,
    maxRefinementIterations,
    buildFixMode,
    withSlidesOverride,
    withSlidesSource,
    withPanelsOverride,
    withPanelsSource,
  };
}

// ── Prompt file loading ───────────────────────────────────────────────────────

function loadPrompt() {
  const promptFile = path.join(INPUTS_DIR, 'prompt.txt');
  if (fs.existsSync(promptFile)) {
    return fs.readFileSync(promptFile, 'utf8').trim();
  }
  return null;
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

  // Primary: the **Host:** line names the host app/company, e.g.
  // "**Host:** **Bright Money** — consumer fintech". Take the name before the
  // em-dash / dash separator so description words don't leak into the slug.
  const hostMatch = promptText.match(/\*{0,2}Host:\*{0,2}\s*([^\n]+)/i);
  if (hostMatch && hostMatch[1]) {
    const namePart = hostMatch[1].split(/\s+[—–-]\s+/)[0];
    const token = normalizeCompanyToken(namePart);
    if (token && token !== 'Demo') return token;
  }

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

  // Fallback to Brand URL domain host label. Tolerate markdown bold and an
  // "(optional)" qualifier, e.g. "**Brand URL:** https://…" or
  // "**Brand URL** (optional): https://…".
  const brandUrl = promptText.match(/Brand URL\b[^\n]*?(https?:\/\/[^\s)]+)/i)?.[1];
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
  const source = String(promptText || '');
  const lower = source.toLowerCase();
  const labels = [];
  const add = (x) => { if (!labels.includes(x)) labels.push(x); };

  // Explicit product declarations (preferred over broad keyword scans), e.g.
  // "Products: Auth, Identity, Signal" or "Key products used: CRA, Layer".
  const declared = [];
  const declRe = /(products?\s*(?:used)?|key\s+products?|apis?)\s*:\s*([^\n]+)/gi;
  let m;
  while ((m = declRe.exec(source))) {
    const tail = String(m[2] || '')
      .split(/[|,;/]/g)
      .map((s) => s.trim())
      .filter(Boolean);
    declared.push(...tail);
  }
  const declaredText = declared.join(' ').toLowerCase();

  // CRA / Check income insights — only when explicitly in scope or positively mentioned (not disclaimers).
  if (shouldIncludeCraRunNameToken(String(promptText || ''))) {
    add('CRA');
  }
  if (/\bauth\b|\binstant auth\b/.test(lower)) add('Auth');
  if (/\bidentity verification\b|\bidv\b|\bidentity\b/.test(lower)) add('Identity');
  if (/\bsignal\b/.test(lower)) add('Signal');
  if (/\bassets\b/.test(lower)) add('Assets');
  if (/\bmonitor\b/.test(lower)) add('Monitor');
  // Do NOT add Layer from broad prompt keyword scans (too noisy / often incidental).
  // Only include Layer when explicitly declared in the product/API list.
  if (/\blayer\b/.test(declaredText)) add('Layer');
  if (/\btransfer\b/.test(lower)) add('Transfer');
  if (/\bincome\b/.test(lower) && !labels.includes('CRA')) add('Income');
  if (/\bstatements\b/.test(lower)) add('Statements');
  if (/\bprotect\b/.test(lower)) add('Protect');

  return labels;
}

function promptIndicatesMobileVisual(promptText) {
  const text = String(promptText || '').toLowerCase();
  if (/\bdesktop[-\s]?only\b|\bno mobile\b|\bdo not use mobile\b|\bwithout mobile\b/.test(text)) {
    return false;
  }
  return (
    /\bmobile build\b|\bmobile demo build\b|\bmobile visual build\b/.test(text) ||
    /\bmobile[-\s]?simulated build\b|\buse (?:the )?mobile app framework\b/.test(text) ||
    /\bviewmode\s*:\s*mobile(?:-auto|-simulated)?\b/.test(text)
  );
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
      const idx = STAGES.indexOf(stage);
      // Stage banner — formatted to be impossible to miss in a streaming agent
      // log. Includes stage progress (N/total) + elapsed so anyone (human or
      // AI) reading the log can answer "where is the pipeline?" at a glance.
      const idxLabel = idx >= 0 ? `${idx + 1}/${STAGES.length}` : '?/?';
      console.log('');
      console.log('━'.repeat(72));
      console.log(`▶  STAGE ${idxLabel}: ${stage}   (pipeline elapsed ${pipelineSec}s)`);
      console.log(`   started ${ts}`);
      console.log('━'.repeat(72));
      emitPipeEvent('stage_start', {
        stage,
        index: idx >= 0 ? idx + 1 : null,
        total: STAGES.length,
        pipelineElapsedSec: pipelineSec,
      });
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
      const idx = STAGES.indexOf(stage);
      const idxLabel = idx >= 0 ? `${idx + 1}/${STAGES.length}` : '?/?';
      // Mirror the stage_start banner shape so agents can pattern-match
      // "which stage finished?" without re-reading prior context.
      console.log(`✓  STAGE ${idxLabel}: ${stage}   (stage ${elapsed}s, pipeline total ${pipelineSec}s)`);
      emitPipeEvent('stage_end', {
        stage,
        status: 'ok',
        durationSec: elapsed,
        pipelineTotalSec: pipelineSec,
      });
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

/**
 * Print a prominent multi-line "AGENT ACTION REQUIRED" banner to stdout. An AI
 * agent (Cursor / Claude Code) streaming the pipeline log cannot easily see a
 * single buried "Waiting for continue signal" line; this block is impossible to
 * miss and tells the agent exactly what to do next.
 *
 * Used by promptContinue. Keeps formatting plain ASCII so it renders correctly
 * in non-TTY pipes (dashboard, CI logs).
 */
function printAgentActionBanner({ message, taskPath, runId }) {
  const ts = cliIsoTime();
  const bar = '═'.repeat(72);
  console.log('');
  console.log(bar);
  console.log('║  ⏸  AGENT ACTION REQUIRED — pipeline paused on continue-gate');
  console.log(bar);
  if (message)  console.log(`║  ${String(message).slice(0, 160)}`);
  if (taskPath) console.log(`║  Task file:  ${taskPath}`);
  if (runId)    console.log(`║  Run id:     ${runId}`);
  console.log(`║  Time:       ${ts}`);
  console.log('║');
  console.log('║  TO RESUME:');
  if (taskPath) {
    console.log(`║    1. Open ${taskPath} in Cursor or Claude Code (Agent mode).`);
    console.log('║    2. Say "Run this task." The agent will make targeted edits.');
    if (runId) {
      console.log(`║    3. Run:  npm run pipe -- continue ${runId}`);
    } else {
      console.log('║    3. Run:  npm run pipe -- continue');
    }
  } else if (runId) {
    console.log(`║    Run:  npm run pipe -- continue ${runId}`);
  } else {
    console.log('║    Run:  npm run pipe -- continue');
  }
  console.log(bar);
  console.log('');
}

function printAgentReleaseBanner({ via, runId, waitedSec }) {
  const bar = '═'.repeat(72);
  console.log('');
  console.log(bar);
  console.log(`║  ▶  CONTINUE SIGNAL RECEIVED — resuming pipeline (via ${via}, waited ${waitedSec}s)`);
  if (runId) console.log(`║     ${runId}`);
  console.log(bar);
  console.log('');
}

/**
 * Heuristic: pull "task: <path>" out of a continue-gate message so the agent
 * banner can hyperlink to the right task .md without callers having to pass
 * it as a separate field. Optional — falls back to the message body alone.
 */
function extractTaskPathFromMessage(message) {
  const m = String(message || '').match(/(?:Open|task:?)\s+([^\s]+\.md)\b/i);
  return m ? m[1] : null;
}

async function promptContinue(message) {
  // Write a continue-signal request marker so `pipe status --json` can surface
  // awaitingContinue=true and the CLI can display context. Best-effort: the
  // orchestrator keeps running even if this write fails.
  const runDirForSignal = (() => {
    try { return requireRunDir(PROJECT_ROOT, 'orchestrator'); }
    catch (_) { return null; }
  })();
  const runId = runDirForSignal ? path.basename(runDirForSignal) : null;
  const taskPath = extractTaskPathFromMessage(message);
  const requestFile = runDirForSignal ? path.join(runDirForSignal, 'continue.signal.request') : null;
  if (requestFile) {
    try {
      fs.writeFileSync(requestFile, JSON.stringify({
        at: cliIsoTime(),
        pid: process.pid,
        message: String(message || ''),
        taskPath,
        runId,
      }, null, 2), 'utf8');
    } catch (_) { /* ignore */ }
  }
  emitPipeEvent('prompt', {
    kind: 'continue',
    message: String(message || ''),
    taskPath,
    runId,
    hint: runId ? `npm run pipe -- continue ${runId}` : 'npm run pipe -- continue',
  });
  const clearRequest = () => {
    if (requestFile) {
      try { if (fs.existsSync(requestFile)) fs.unlinkSync(requestFile); }
      catch (_) { /* ignore */ }
    }
  };

  // TTY path: interactive terminal — readline works normally. Print the banner
  // so a human at the keyboard sees the same context an agent would.
  if (process.stdin.isTTY) {
    printAgentActionBanner({ message, taskPath, runId });
    const startedAt = Date.now();
    return new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`Press ENTER to continue or Ctrl+C to abort. `, () => {
        rl.close();
        clearRequest();
        const waitedSec = Math.round((Date.now() - startedAt) / 1000);
        printAgentReleaseBanner({ via: 'tty', runId, waitedSec });
        emitPipeEvent('prompt_resolved', { kind: 'continue', via: 'tty', waitedSec });
        resolve();
      });
    });
  }

  // Non-TTY path (spawned by dashboard / Claude Code agent / CLI with piped
  // stdin). This is the path an AI agent sees when the orchestrator is run as
  // a background process and stdout streams to the agent's terminal. We need
  // to be LOUD here — a single buried line is invisible in a streaming log.
  const runDir = runDirForSignal || requireRunDir(PROJECT_ROOT, 'orchestrator');
  const signalFile = path.join(runDir, 'continue.signal');
  // Remove stale signal file from a prior run
  try { fs.unlinkSync(signalFile); } catch (_) {}

  printAgentActionBanner({ message, taskPath, runId });

  return new Promise(resolve => {
    const startedAt = Date.now();
    let heartbeatTimer = null;

    // Periodic heartbeat reminds the agent (and humans tailing the log) that
    // we're still waiting and nothing is hung. Cadence is intentionally
    // calibrated so it shows up at human-tolerable intervals: 15s, 30s, 60s,
    // then every minute. Configurable via PIPE_CONTINUE_GATE_HEARTBEAT_MS
    // (set to 0 to disable, e.g. for CI runs).
    const heartbeatEnv = parseInt(process.env.PIPE_CONTINUE_GATE_HEARTBEAT_MS || '30000', 10);
    const heartbeatBaseMs = Number.isFinite(heartbeatEnv) ? heartbeatEnv : 30000;

    function scheduleHeartbeat() {
      if (heartbeatBaseMs <= 0) return;
      heartbeatTimer = setTimeout(() => {
        const waitedSec = Math.round((Date.now() - startedAt) / 1000);
        const cmd = runId ? `npm run pipe -- continue ${runId}` : 'npm run pipe -- continue';
        cliLog(
          `[Orchestrator] ⏸  Still waiting on continue-gate (${waitedSec}s elapsed). ` +
          (taskPath ? `Edit ${taskPath} then run: ${cmd}` : `Run: ${cmd}`)
        );
        emitPipeEvent('prompt_heartbeat', { kind: 'continue', waitedSec, taskPath, runId });
        scheduleHeartbeat();
      }, heartbeatBaseMs);
    }
    scheduleHeartbeat();

    // Option A: data arrives on piped stdin (dashboard sends '\n')
    const onData = () => {
      cleanup();
      const waitedSec = Math.round((Date.now() - startedAt) / 1000);
      printAgentReleaseBanner({ via: 'stdin', runId, waitedSec });
      emitPipeEvent('prompt_resolved', { kind: 'continue', via: 'stdin', waitedSec });
      clearRequest();
      resolve();
    };
    process.stdin.once('data', onData);

    // Option B: signal file is written by dashboard / `pipe continue`
    const poll = setInterval(() => {
      if (fs.existsSync(signalFile)) {
        try { fs.unlinkSync(signalFile); } catch (_) {}
        cleanup();
        const waitedSec = Math.round((Date.now() - startedAt) / 1000);
        printAgentReleaseBanner({ via: 'signal_file', runId, waitedSec });
        emitPipeEvent('prompt_resolved', { kind: 'continue', via: 'signal_file', waitedSec });
        clearRequest();
        resolve();
      }
    }, 500);

    function cleanup() {
      process.stdin.removeListener('data', onData);
      clearInterval(poll);
      if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
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

  // Deterministic narration-metric scan: the voiceover must NOT read exact on-screen
  // values aloud (dollar amounts, numeric scores, account masks, exact timings) — it
  // should describe the outcome/direction. Exact values stay on the slide/API panel.
  // (User directive 2026-06-24.) Surfaced as `narration-reads-metric` warnings.
  const NARRATION_METRIC_PATTERNS = [
    { re: /\$\s?\d[\d,]*(?:\.\d+)?/, label: 'dollar amount' },
    { re: /\bscores?\s+(?:of\s+|is\s+|was\s+|:\s*)?\d+/i, label: 'numeric score' },
    { re: /\b\d{1,3}\s*\/\s*\d{2,3}\b/, label: 'NN/NN score' },
    { re: /\b(?:ending(?:\s+in)?|x|\*{2,}|•{2,})\s*\d{4}\b/i, label: 'account mask / last-4' },
    { re: /\bin\s+(?:under\s+|less\s+than\s+)?\d+(?:\.\d+)?\s*(?:seconds?|sec|ms|milliseconds?)\b/i, label: 'exact timing' },
  ];
  const narrationMetricWarnings = [];
  for (const step of (script.steps || [])) {
    const n = String(step.narration || '');
    for (const { re, label } of NARRATION_METRIC_PATTERNS) {
      const m = n.match(re);
      if (m) { narrationMetricWarnings.push({ stepId: step.id || '(no-id)', rule: 'narration-reads-metric', label, match: m[0] }); break; }
    }
  }
  if (narrationMetricWarnings.length) {
    console.warn(`[script-critique] narration-reads-metric: ${narrationMetricWarnings.length} step(s) read an exact on-screen value aloud (use outcome/directional language; the value stays on the slide):`);
    narrationMetricWarnings.forEach(w => console.warn(`  - ${w.stepId}: ${w.label} "${w.match}"`));
  }

  // Deterministic narration-grounding scan: a specific named entity in narration
  // (account/plan/card name) must MATCH what's on screen — narration may be
  // outcome-style, but a name it says aloud ("Gold Savings account") must actually
  // appear in the demo's rendered content (visualState / apiResponse / slide text).
  // Catches the LLM inventing a plausible name that's nowhere on screen.
  // (User directive 2026-06-24.) Surfaced as `narration-screen-mismatch` warnings.
  const screenHaystack = (script.steps || [])
    .map(st => [st.visualState, st.apiResponse ? JSON.stringify(st.apiResponse) : '', st.slideContent, st.label]
      .filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();
  const NAMED_ENTITY_RE = /\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,2})\s+(Checking|Savings?|Account|Card|Wallet|Plan)\b/g;
  const narrationGroundingWarnings = [];
  for (const step of (script.steps || [])) {
    const n = String(step.narration || '');
    let m;
    NAMED_ENTITY_RE.lastIndex = 0;
    while ((m = NAMED_ENTITY_RE.exec(n)) !== null) {
      const phrase = m[0].trim();
      // Generic phrases ("your checking account", "a savings account") are fine —
      // only flag a DISTINCT proper name (the qualifier isn't a generic word).
      const qualifier = m[1].toLowerCase();
      if (/^(your|the|a|an|her|his|their|this|that|external|linked|new|primary|business|personal)$/.test(qualifier)) continue;
      if (!screenHaystack.includes(phrase.toLowerCase())) {
        narrationGroundingWarnings.push({ stepId: step.id || '(no-id)', rule: 'narration-screen-mismatch', name: phrase });
      }
    }
  }
  if (narrationGroundingWarnings.length) {
    console.warn(`[script-critique] narration-screen-mismatch: ${narrationGroundingWarnings.length} named reference(s) in narration not found on screen (narration must match what's rendered):`);
    narrationGroundingWarnings.forEach(w => console.warn(`  - ${w.stepId}: "${w.name}" — not present in any visualState/apiResponse/slide. Use the name actually shown (e.g. the Plaid Link account label) or render this name in the demo.`));
  }

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
            narrationMetricWarnings,
            narrationGroundingWarnings,
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
    emitPipeEvent('stage_end', {
      stage: stageName,
      status: 'failed',
      durationSec: elapsed,
      message: err.message,
      recoveryHint: `--from=${stageName}`,
    });
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

// ── Build fix-mode routing (Phase 1) ─────────────────────────────────────────
//
// Modes (orchestrator-native vocabulary; bin/pipe.js translates user-facing
// aliases smart=auto, rebuild=fullbuild, patch=touchup before forwarding):
//
//   - auto          : routing heuristics decide between touchup / fullbuild /
//                     agent-touchup based on QA signals + agent context.
//   - touchup       : LLM regenerates the full app with a narrowed prompt
//                     focused on the lowest-scoring failing step. Legacy.
//   - fullbuild     : LLM regenerates the full app with no narrowing.
//   - agent-touchup : NEW default for runs initiated under an AI agent
//                     (Cursor / Claude Code). Orchestrator pauses on a
//                     continue-gate after each failed build-qa, hands the
//                     agent a per-step task .md, and the agent makes
//                     surgical StrReplace edits. NO LLM rebuilds happen on
//                     refinement passes — the agent owns iteration scope.
//                     Loop cap: MAX_REFINEMENT_ITERATIONS (default 3).
const VALID_BUILD_FIX_MODES = new Set(['auto', 'touchup', 'fullbuild', 'agent-touchup']);
const VALID_BUILD_PHASE_MODES = new Set(['app', 'slides']);

/**
 * Detect whether the orchestrator is running under an AI agent driver
 * (Claude Code, Cursor agent mode) versus a human terminal or CI.
 *
 *   - Explicit env var `PIPE_AGENT_MODE=1` wins (set by install.sh by
 *     default for SEs, and the user-facing toggle for opting in/out).
 *   - Auto-detect via well-known agent envs:
 *       Claude Code:  CLAUDECODE=1, CLAUDE_CODE_*
 *       Cursor:       CURSOR_AGENT_*, CURSOR_TRACE_ID
 *   - `PIPE_AGENT_MODE=0` (or =false) explicitly opts OUT, even if an
 *     auto-detect signal is present (useful for human verification runs
 *     inside Claude Code without auto-pausing on continue-gates).
 *
 * Returns `{ enabled: bool, source: string|null }` so the orchestrator
 * can log why the default was picked.
 */
function isAgentContext() {
  const explicit = String(process.env.PIPE_AGENT_MODE ?? '').trim().toLowerCase();
  if (explicit === '0' || explicit === 'false' || explicit === 'no' || explicit === 'off') {
    return { enabled: false, source: 'PIPE_AGENT_MODE_off' };
  }
  if (explicit === '1' || explicit === 'true' || explicit === 'yes' || explicit === 'on') {
    return { enabled: true, source: 'PIPE_AGENT_MODE' };
  }
  if (process.env.CLAUDECODE === '1' || (process.env.CLAUDE_CODE_VERSION && process.env.CLAUDE_CODE_VERSION.length > 0)) {
    return { enabled: true, source: 'CLAUDECODE' };
  }
  if (process.env.CURSOR_AGENT_MODE === '1' || (process.env.CURSOR_TRACE_ID && process.env.CURSOR_TRACE_ID.length > 0)) {
    return { enabled: true, source: 'CURSOR_AGENT' };
  }
  return { enabled: false, source: null };
}

function parseBoolEnv(value, defaultValue = false) {
  if (value == null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return defaultValue;
}

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Skip agentic research when artifacts exist and the prompt fingerprint
 * matches `product-research.json`. Delegates to
 * `utils/research-reuse.shouldReuseExistingResearch` so the rule is testable
 * and matched by a single source of truth. See that file for the full
 * decision tree.
 */
function shouldReuseExistingResearch(versionedDir, promptText, effectiveFromStage) {
  const { shouldReuseExistingResearch: shouldReuseImpl } = require('./utils/research-reuse');
  const result = shouldReuseImpl({
    runDir: versionedDir,
    promptText,
    effectiveFromStage,
    fingerprintPrompt,
  });
  if (!result.shouldReuse && result.reason && result.reason !== 'no_existing_research_artifact') {
    cliLog(`[Orchestrator] research-reuse: not reusing (reason=${result.reason})`);
  }
  return result.shouldReuse;
}

function parseColorLuminance(input) {
  const c = String(input || '').trim().toLowerCase();
  if (!c) return null;
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let raw = hex[1];
    if (raw.length === 3) raw = raw.split('').map((x) => x + x).join('');
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  const rgb = c.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(',').map((p) => parseFloat(p.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      const [r, g, b] = parts;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
  }
  return null;
}

function runBrandLogoContrastGate(versionedDir) {
  const strict = String(process.env.BRAND_LOGO_CONTRAST_STRICT || 'true').toLowerCase() !== 'false';
  const script = readJsonSafe(path.join(versionedDir, 'demo-script.json'));
  const company = String(script?.persona?.company || '').trim();
  if (!company) return;
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!slug || slug === 'plaid') return;

  const profilePath = path.join(versionedDir, 'artifacts', 'brand', `${slug}.json`);
  const profile = readJsonSafe(profilePath);
  if (!profile) return;

  const mode = String(profile?.mode || '').toLowerCase();
  const imageUrlRaw = String(profile?.logo?.imageUrl || '');
  const imageUrl = imageUrlRaw.toLowerCase();
  const shellBg = String(profile?.logo?.shellBg || '');
  const shellLum = parseColorLuminance(shellBg);
  const isLightThemeAsset = /\/theme\/light\//.test(imageUrl);
  const shellIsTooLight = shellLum == null || shellLum > 0.55;
  if (mode === 'light' && isLightThemeAsset && shellIsTooLight) {
    // Auto-recovery: Brandfetch publishes both `/theme/light/` and `/theme/dark/`
    // logo variants for most brands; the harvest is non-deterministic and may
    // pick whichever variant is unsuited for the host's mode. Try the alternate
    // path before failing the gate so a stochastic harvest result doesn't block
    // the run when a viable variant exists right alongside the bad one.
    const recovered = tryRecoverWithDarkLogoVariant(profile, profilePath);
    if (recovered) {
      cliLog(
        `[BrandExtract] Logo contrast auto-recovery: swapped light → dark theme variant ` +
        `(was ${imageUrlRaw}, now ${recovered.imageUrl}). Profile rewritten.`
      );
      return;
    }
    const msg =
      `[BrandExtract] Logo contrast gate failed: light-theme logo asset on light host mode ` +
      `(logo=${imageUrlRaw || 'n/a'}, shellBg=${shellBg || 'n/a'}).`;
    if (strict) {
      throw new Error(
        `${msg} Update brand profile to a dark logo variant or darken logo shell. ` +
        `Set BRAND_LOGO_CONTRAST_STRICT=false to warn-only.`
      );
    }
    cliWarn(msg);
  }
}

/**
 * Mutate the brand profile in place to swap the light-theme Brandfetch logo
 * URL for the dark-theme one and persist the result. Returns the new
 * `{ imageUrl, iconUrl }` on success or null if no swap was possible.
 *
 * Brandfetch URL pattern: `https://cdn.brandfetch.io/{id}/theme/{light|dark}/logo.svg?...`.
 * Other CDN patterns are ignored (we don't try to invent URLs).
 */
function tryRecoverWithDarkLogoVariant(profile, profilePath) {
  if (!profile || !profile.logo) return null;
  const original = String(profile.logo.imageUrl || '');
  if (!/\bcdn\.brandfetch\.io\/.+\/theme\/light\//.test(original)) return null;
  const swap = (url) => String(url || '').replace(/\/theme\/light\//g, '/theme/dark/');
  const candidate = swap(original);
  if (!candidate || candidate === original) return null;

  // We don't HEAD-check the URL — Brandfetch reliably serves both variants
  // when one exists, and a downstream 404 on the dark variant will surface
  // through the existing brand-asset checks. Cheap optimistic swap.
  const newProfile = {
    ...profile,
    logo: {
      ...profile.logo,
      imageUrl: candidate,
      iconUrl: profile.logo.iconUrl ? swap(profile.logo.iconUrl) : profile.logo.iconUrl,
    },
    _logoContrastRecovery: {
      at: new Date().toISOString(),
      reason: 'light-theme asset on light host mode — swapped to dark variant',
      previousImageUrl: original,
    },
  };
  try {
    fs.writeFileSync(profilePath, JSON.stringify(newProfile, null, 2), 'utf8');
  } catch (_) {
    return null;
  }
  return newProfile.logo;
}

function detectPlaywrightAlignmentMismatch(versionedDir) {
  const scriptFile = path.join(versionedDir, 'demo-script.json');
  const playwrightFile = path.join(versionedDir, 'scratch-app', 'playwright-script.json');
  const demoScript = readJsonSafe(scriptFile);
  const playwright = readJsonSafe(playwrightFile);
  if (!demoScript || !Array.isArray(demoScript.steps) || !playwright || !Array.isArray(playwright.steps)) {
    return true;
  }
  const scriptIds = demoScript.steps.map((s) => s?.id).filter(Boolean);
  const rowIdsAll = playwright.steps.map((s) => s?.id || s?.stepId).filter(Boolean);
  if (scriptIds.length === 0 || rowIdsAll.length === 0) return true;

  // Unknown step ids in playwright script usually indicate drift.
  const scriptIdSet = new Set(scriptIds);
  const unknownRows = rowIdsAll.filter((id) => !scriptIdSet.has(id));
  if (unknownRows.length > 0) return true;

  // Allow duplicate playwright rows per step, but require full coverage.
  for (const id of scriptIds) {
    if (!rowIdsAll.includes(id)) return true;
  }

  // Ensure first occurrence order of script steps is preserved.
  const firstIndex = new Map();
  rowIdsAll.forEach((id, idx) => {
    if (!firstIndex.has(id)) firstIndex.set(id, idx);
  });
  for (let i = 1; i < scriptIds.length; i++) {
    const prev = firstIndex.get(scriptIds[i - 1]);
    const curr = firstIndex.get(scriptIds[i]);
    if (prev == null || curr == null || curr < prev) return true;
  }

  return false;
}

function analyzeFixModeForQaIteration({ versionedDir, qaResult, qaThreshold, iteration, requestedBuildFixMode }) {
  let requestedMode = String(requestedBuildFixMode || process.env.BUILD_FIX_MODE || 'auto').toLowerCase().trim();
  if (!VALID_BUILD_FIX_MODES.has(requestedMode)) {
    cliWarn(`[Orchestrator] Unknown BUILD_FIX_MODE="${requestedMode}" — defaulting to auto.`);
    requestedMode = 'auto';
  }

  const fullbuildStepThreshold = Math.max(
    1,
    parseInt(process.env.BUILD_FIX_FULLBUILD_STEP_THRESHOLD || '3', 10) || 3
  );
  const touchupEnabled = parseBoolEnv(process.env.TOUCHUP_ENABLED, true);
  const agentCtx = isAgentContext();
  const reasons = [];

  // In `auto` mode, the FIRST routing decision is "are we under an AI agent?"
  // If yes, pick `agent-touchup` and short-circuit all the systemic-issue
  // heuristics — the user's contract for that mode is "no rebuilds, agent
  // makes iterations only." If no agent, fall through to the legacy
  // touchup/fullbuild dispatch.
  let evaluatedMode;
  if (requestedMode === 'auto' && agentCtx.enabled) {
    evaluatedMode = 'agent-touchup';
    reasons.push(`agent_context_${agentCtx.source}`);
  } else {
    evaluatedMode = requestedMode === 'auto' ? 'touchup' : requestedMode;
  }

  const qaReportPath = path.join(versionedDir, `qa-report-${iteration}.json`);
  const qaReport = readJsonSafe(qaReportPath);
  const stepsWithIssues = Array.isArray(qaResult?.stepsWithIssues)
    ? qaResult.stepsWithIssues
    : [];
  const deterministicPassed = qaResult?.deterministicPassed != null
    ? !!qaResult.deterministicPassed
    : qaReport?.deterministicPassed != null
      ? !!qaReport.deterministicPassed
      : true;
  // Honor BUILD_QA_DETERMINISTIC_GATE=false so the gate's iteration trigger
  // turns off everywhere, not just inside the QA report writer. Source of truth
  // is qaResult/qaReport.deterministicGateEnabled (set by build-qa from env).
  const deterministicGateEnabled = qaResult?.deterministicGateEnabled != null
    ? !!qaResult.deterministicGateEnabled
    : qaReport?.deterministicGateEnabled != null
      ? !!qaReport.deterministicGateEnabled
      : true;
  const deterministicBlockerEffective = !deterministicPassed && deterministicGateEnabled;
  const deterministicBlockerCount = Number(
    qaResult?.deterministicBlockerCount ??
    qaResult?.deterministicCriticalCount ??
    qaReport?.deterministicBlockerCount ??
    qaReport?.deterministicCriticalCount ??
    0
  );
  const deterministicReasons = Array.isArray(qaResult?.deterministicReasons)
    ? qaResult.deterministicReasons
    : Array.isArray(qaReport?.deterministicReasons)
      ? qaReport.deterministicReasons
      : [];

  if (requestedMode === 'auto' && evaluatedMode === 'agent-touchup') {
    // Agent-touchup wins regardless of the systemic-issue heuristics — the
    // mode's contract is "no rebuilds, agent makes iterations only." We
    // still surface the signals as advisory reasons so logs reveal what
    // was flagged (the agent reads these via the qa-touchup task .md too).
    if (!fs.existsSync(path.join(versionedDir, 'scratch-app', 'index.html'))) {
      reasons.push('advisory:no_index_html');
    }
    if (detectPlaywrightAlignmentMismatch(versionedDir)) {
      reasons.push('advisory:playwright_demo_script_mismatch');
    }
    if (qaReport && typeof qaReport.overrideReason === 'string' && qaReport.overrideReason.trim()) {
      reasons.push('advisory:build_qa_guardrail_override');
    }
    if (deterministicBlockerEffective) {
      reasons.push('advisory:deterministic_blocker_gate');
    } else if (!deterministicPassed && !deterministicGateEnabled) {
      reasons.push('advisory:deterministic_blockers_present_gate_disabled');
    }
    const failingDistinctSteps = new Set(
      stepsWithIssues.map((s) => s?.stepId).filter(Boolean)
    );
    if (failingDistinctSteps.size >= fullbuildStepThreshold) {
      reasons.push(`advisory:failing_steps_gte_${fullbuildStepThreshold}`);
    }
  } else if (requestedMode === 'auto') {
    if (!fs.existsSync(path.join(versionedDir, 'scratch-app', 'index.html'))) {
      evaluatedMode = 'fullbuild';
      reasons.push('no_index_html');
    }
    if (detectPlaywrightAlignmentMismatch(versionedDir)) {
      evaluatedMode = 'fullbuild';
      reasons.push('playwright_demo_script_mismatch');
    }
    if (qaReport && typeof qaReport.overrideReason === 'string' && qaReport.overrideReason.trim()) {
      evaluatedMode = 'fullbuild';
      reasons.push('build_qa_guardrail_override');
    }
    if (deterministicBlockerEffective) {
      evaluatedMode = 'fullbuild';
      reasons.push('deterministic_blocker_gate');
    } else if (!deterministicPassed && !deterministicGateEnabled) {
      // Deterministic blockers exist but the gate is explicitly disabled via
      // BUILD_QA_DETERMINISTIC_GATE=false. Do NOT promote to fullbuild on this
      // signal alone — log the bypass for audit and continue with the
      // requested fix mode (smart-patch can still address the issues).
      reasons.push('deterministic_blockers_present_gate_disabled');
    }
    const failingDistinctSteps = new Set(
      stepsWithIssues.map((s) => s?.stepId).filter(Boolean)
    );
    if (failingDistinctSteps.size >= fullbuildStepThreshold) {
      evaluatedMode = 'fullbuild';
      reasons.push(`failing_steps_gte_${fullbuildStepThreshold}`);
    }
    const sharedChromeCategories = new Set(['missing-logo', 'panel-visibility', 'slide-template-misuse']);
    const sharedChromeStepIds = new Set();
    for (const step of stepsWithIssues) {
      const cats = Array.isArray(step?.categories) ? step.categories : [];
      if (cats.some((c) => sharedChromeCategories.has(String(c)))) {
        if (step?.stepId) sharedChromeStepIds.add(step.stepId);
      }
    }
    if (sharedChromeStepIds.size >= 2) {
      evaluatedMode = 'fullbuild';
      reasons.push('shared_chrome_multistep');
    }
    if (reasons.length === 0) {
      reasons.push('localized_issues_touchup_candidate');
    }
  } else {
    reasons.push(`forced_${requestedMode}`);
  }

  let executedMode = evaluatedMode;
  if (evaluatedMode === 'touchup' && !touchupEnabled) {
    executedMode = 'fullbuild';
    reasons.push('touchup_disabled_fallback_fullbuild');
  }

  const touchupStep = stepsWithIssues
    .filter((s) => s && s.stepId)
    .sort((a, b) => Number(a.score || 100) - Number(b.score || 100))[0];
  const touchupStepId = executedMode === 'touchup' ? (touchupStep?.stepId || null) : null;

  return {
    requestedMode,
    evaluatedMode,
    executedMode,
    reasons,
    touchupStepId,
    qaScoreBefore: Number(qaResult?.overallScore || 0),
    qaThreshold: Number(qaThreshold || 0),
    qaReportPath,
    deterministicPassed,
    deterministicBlockerCount,
    deterministicReasons,
    agentContext: agentCtx,
  };
}

/**
 * Agent-touchup gate.
 *
 * When the build-qa refinement loop chose `executedMode=agent-touchup`, we
 * call this in place of `build-app.main()`. The function:
 *
 *   1. Builds the per-step QA touchup prompt (`scripts/scratch/utils/qa-touchup`)
 *      with `suppressSystemicGate=true` and `orchestratorDriven=true` so the
 *      agent gets the right CTA (`pipe continue`) and no "stop and rebuild"
 *      escalation block (the orchestrator's contract is no rebuilds).
 *   2. Writes `<runDir>/qa-touchup-task.md`.
 *   3. Emits a structured `::PIPE::qa_touchup_task_ready` event so dashboards
 *      and downstream tooling can react.
 *   4. Calls `await promptContinue(...)` — the existing continue-gate. The
 *      orchestrator stays alive (same process, same iter counter) and
 *      resumes when the agent calls `pipe continue <RUN_ID>`.
 *
 * If the helper throws (e.g. no QA report, no scratch-app), the function
 * logs the failure and returns `{ skipped: true }` so the caller can choose
 * to break the loop without crashing the whole pipeline.
 */
/**
 * Run the tier-scoped recovery lanes (app-touchup, slide-fix) instead of
 * dispatching another full `build-app` pass. These lanes:
 *   - apply deterministic patches scoped to the failing tier,
 *   - re-run post-panels / post-slides as needed,
 *   - re-run build-qa with the matching stepScope,
 *   - and on residual failures, emit a tier-scoped agent task .md when
 *     running under an agent context (Claude Code / Cursor with PIPE_AGENT_MODE).
 *
 * Returns `{ appPassed, slidePassed, agentGateRequested, taskFiles, failingTiers }`.
 *
 * The lanes never call `build-app` / `generateApp` — that is the orchestrator's
 * legacy LLM regen path, which the tier matrix is explicitly trying to avoid.
 */
const slideQaBudget = { used: 0, max: null };

function resetSlideQaBudget() {
  slideQaBudget.used = 0;
  slideQaBudget.max = resolveSlideQaMaxIterations();
}

function slideQaBudgetRemaining() {
  if (slideQaBudget.max == null) slideQaBudget.max = resolveSlideQaMaxIterations();
  return Math.max(0, slideQaBudget.max - slideQaBudget.used);
}

/**
 * Run slide-fix within the pipeline slide-QA budget (default max 3 iterations
 * or passing slide tier — whichever comes first). Shared by tier recovery and
 * the standalone slide-fix stage so multiple orchestrator paths cannot exceed
 * the cap in a single run.
 */
async function dispatchSlideFix(runDir, opts = {}) {
  const remaining = slideQaBudgetRemaining();
  if (remaining <= 0) {
    cliWarn(
      `[Orchestrator] Slide QA budget exhausted (${slideQaBudget.used}/${slideQaBudget.max} iterations) — skipping slide-fix`
    );
    return {
      skipped: true,
      reason: 'slide_qa_budget_exhausted',
      slidePassed: false,
      iterations: 0,
    };
  }
  delete require.cache[require.resolve('./scratch/slide-fix')];
  const lane = require('./scratch/slide-fix');
  const explicitCap = Number.isFinite(Number(opts.maxIterations)) ? Number(opts.maxIterations) : null;
  const cap = explicitCap != null ? Math.min(explicitCap, remaining) : remaining;
  cliLog(
    `[Orchestrator] slide-fix (slide QA iterations ${slideQaBudget.used + 1}–${slideQaBudget.used + cap} of max ${slideQaBudget.max})`
  );
  const out = await lane.main({
    runDir,
    maxIterations: cap,
    emitAgentTask: opts.emitAgentTask ?? isAgentContext(),
    requireAppPassed: opts.requireAppPassed,
    allowPostRecord: opts.allowPostRecord,
  });
  slideQaBudget.used += out.iterations || 0;
  return out;
}

async function runTierRecoveryLanes({ runDir, tierRecovery, tierSummary }) {
  const wantsApp = tierRecovery === 'app-touchup' || tierRecovery === 'app-touchup+slide-fix';
  const wantsSlide = tierRecovery === 'slide-fix' || tierRecovery === 'app-touchup+slide-fix';
  const taskFiles = [];
  const failingTiers = [];
  let appPassed = !wantsApp && tierSummary?.app?.passed !== false;
  let slidePassed = !wantsSlide && (tierSummary?.slide?.passed !== false || tierSummary?.slide?.skipped === true);

  // When both tiers need recovery on the same iteration, run app-touchup
  // first — slide-fix refuses to run when the app tier hasn't passed (see
  // requireAppPassed in slide-fix.main).
  if (wantsApp) {
    try {
      delete require.cache[require.resolve('./scratch/app-touchup')];
      const lane = require('./scratch/app-touchup');
      cliLog('[Orchestrator] Dispatching tier-recovery lane: app-touchup');
      const out = await lane.main({
        runDir,
        emitAgentTask: isAgentContext(),
      });
      appPassed = out.appPassed === true;
      if (!appPassed) failingTiers.push('app');
      if (out.agentTaskPath) taskFiles.push(path.relative(runDir, out.agentTaskPath));
    } catch (err) {
      cliWarn(`[Orchestrator] app-touchup lane failed: ${err.message}`);
    }
  }
  if (wantsSlide) {
    try {
      cliLog('[Orchestrator] Dispatching tier-recovery lane: slide-fix');
      const out = await dispatchSlideFix(runDir, {
        emitAgentTask: isAgentContext(),
      });
      slidePassed = out.slidePassed === true || out.skipped === true;
      if (!slidePassed) failingTiers.push('slide');
      if (out.agentTaskPath) taskFiles.push(path.relative(runDir, out.agentTaskPath));
    } catch (err) {
      cliWarn(`[Orchestrator] slide-fix lane failed: ${err.message}`);
    }
  }

  return {
    appPassed,
    slidePassed,
    agentGateRequested: taskFiles.length > 0 && isAgentContext(),
    taskFiles,
    failingTiers,
  };
}

async function runAgentTouchupGate({ runDir, iteration, fixModeDecision, phaseMode }) {
  const { buildQaTouchupPrompt } = require('./utils/qa-touchup');
  let result;
  try {
    result = buildQaTouchupPrompt(runDir, {
      suppressSystemicGate: true,
      orchestratorDriven: true,
    });
  } catch (err) {
    cliWarn(`[Orchestrator] agent-touchup helper failed (${err.message}) — skipping iteration.`);
    return { skipped: true, error: err.message };
  }

  const taskPath = path.join(runDir, 'qa-touchup-task.md');
  try {
    fs.writeFileSync(taskPath, result.promptMarkdown, 'utf8');
  } catch (err) {
    cliWarn(`[Orchestrator] could not write ${taskPath}: ${err.message}`);
    return { skipped: true, error: err.message };
  }

  const summary = result.summary;
  emitPipeEvent('qa_touchup_task_ready', {
    iteration,
    phase: phaseMode,
    runId: path.basename(runDir),
    taskPath,
    failingStepCount: summary.failingStepCount,
    distinctFailingSteps: summary.distinctFailingSteps,
    overallScore: summary.overallScore,
    passThreshold: summary.passThreshold,
    systemic: summary.systemic,
    systemicReasons: summary.systemicReasons,
    fixModeReasons: fixModeDecision.reasons,
  });

  const relTask = path.relative(PROJECT_ROOT, taskPath);
  cliLog(`[Orchestrator] agent-touchup gate (iter ${iteration}, phase=${phaseMode}): ${summary.failingStepCount} failing step(s), score ${summary.overallScore ?? '?'}/${summary.passThreshold}.`);
  cliLog(`[Orchestrator]   task: ${relTask}`);

  // Autonomous mode (SCRATCH_AUTO_APPROVE / PIPELINE_NONINTERACTIVE, no TTY):
  // there is no interactive agent at the keyboard to edit the task and run
  // `pipe continue`, so a blocking gate would orphan the orchestrator forever
  // (observed: idle orchestrators left after a failed build-qa). Skip the gate,
  // which breaks the refinement loop and lets the run complete cleanly at this
  // build-qa verdict. The touch-up task is still written for an operator/agent
  // to act on later (edit + re-run build-qa, or `pipe continue <runId>`).
  const autonomousGate =
    (process.env.SCRATCH_AUTO_APPROVE === 'true' || parseBoolEnv(process.env.PIPELINE_NONINTERACTIVE, false)) &&
    !process.stdin.isTTY;
  if (autonomousGate) {
    cliLog(`[Orchestrator]   autonomous mode — not blocking; run ends at this verdict. Touch-up task: ${relTask}`);
    emitPipeEvent('qa_touchup_gate_autoskip', {
      iteration, phase: phaseMode, runId: path.basename(runDir), taskPath,
      overallScore: summary.overallScore, passThreshold: summary.passThreshold,
    });
    return { skipped: true, autoSkipped: true, summary };
  }

  cliLog(`[Orchestrator]   open it in Cursor or Claude Code (Agent mode) and edit the failing steps,`);
  cliLog(`[Orchestrator]   then run: npm run pipe -- continue ${path.basename(runDir)}`);
  await promptContinue(
    `QA touchup ready (iter ${iteration}). Open ${relTask} in your AI agent, edit the ` +
    `failing steps, then continue.`
  );
  return { skipped: false, summary };
}

/**
 * Single source of truth for "does this run include slides?".
 *
 * Resolution order (first match wins):
 *   1. CLI flag injection (parseArgs sets PIPELINE_WITH_SLIDES_SOURCE='cli')
 *   2. Dashboard injection via PIPELINE_WITH_SLIDES_SOURCE='dashboard'
 *   3. PIPELINE_WITH_SLIDES env (explicit)
 *   4. Legacy envs (BUILD_PHASE_SEQUENCE / BUILD_PHASE_SLIDES_ENABLED) for back-compat
 *   5. Default: app-only (no slides)
 *
 * Side effect: expands the resolved decision into the four legacy envs so all
 * downstream stage code (generate-script.js, build-app.js, build-qa.js)
 * keeps reading the existing variables without modification.
 */
function resolveBuildMode() {
  const sourceTag = String(process.env.PIPELINE_WITH_SLIDES_SOURCE || '').trim().toLowerCase();
  const explicitRaw = process.env.PIPELINE_WITH_SLIDES;
  const hasExplicit = explicitRaw != null && String(explicitRaw).trim() !== '';

  let withSlides;
  let source;

  if (hasExplicit) {
    withSlides = parseBoolEnv(explicitRaw, false);
    source = sourceTag || 'env';
  } else if (process.env.BUILD_PHASE_SEQUENCE != null || process.env.BUILD_PHASE_SLIDES_ENABLED != null) {
    const seq = String(process.env.BUILD_PHASE_SEQUENCE || '').toLowerCase();
    const slidesFlag = parseBoolEnv(process.env.BUILD_PHASE_SLIDES_ENABLED, false);
    withSlides = slidesFlag && /\bslides\b/.test(seq);
    source = 'legacy-env';
  } else {
    withSlides = false;
    source = 'default';
  }

  const sequence = withSlides ? 'app,slides' : 'app';
  process.env.PIPELINE_WITH_SLIDES = withSlides ? 'true' : 'false';
  process.env.BUILD_PHASE_SEQUENCE = sequence;
  process.env.BUILD_PHASE_SLIDES_ENABLED = withSlides ? 'true' : 'false';
  process.env.DEMO_MARKETING_SLIDE = withSlides ? 'true' : 'false';
  process.env.SCRIPT_ZERO_SLIDE = withSlides ? 'false' : 'true';

  // JSON/API panels — INDEPENDENT axis. Default ON (unset env ⇒ true) to
  // preserve historical always-on panel behavior; opt out with --no-panels.
  const panelsRaw = process.env.PIPELINE_WITH_PANELS;
  const withPanels = (panelsRaw == null || String(panelsRaw).trim() === '')
    ? true
    : parseBoolEnv(panelsRaw, true);
  const panelsSource = (panelsRaw == null || String(panelsRaw).trim() === '')
    ? 'default'
    : (String(process.env.PIPELINE_WITH_PANELS_SOURCE || '').trim().toLowerCase() || 'env');
  process.env.PIPELINE_WITH_PANELS = withPanels ? 'true' : 'false';

  const label = `${withSlides ? 'App + Slides' : 'App-only'}${withPanels ? ' + Panels' : ' (no panels)'}`;
  return {
    withSlides,
    withPanels,
    source,
    panelsSource,
    label,
    sequence,
  };
}

// Resolve whether JSON/API panels are enabled for this run. Env wins; else the
// run-manifest's buildModes.withPanels; else default true (legacy always-on).
// Used to gate the post-panels stage + the touchup lanes' panel re-injection.
function isPanelsEnabled(versionedDir) {
  const env = String(process.env.PIPELINE_WITH_PANELS || '').trim().toLowerCase();
  if (env === 'true') return true;
  if (env === 'false') return false;
  try {
    const mfPath = path.join(versionedDir, 'run-manifest.json');
    if (fs.existsSync(mfPath)) {
      const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
      if (mf && mf.buildModes && typeof mf.buildModes.withPanels === 'boolean') {
        return mf.buildModes.withPanels;
      }
    }
  } catch (_) { /* ignore */ }
  return true; // default ON (back-compat with pre-panels-axis runs)
}

function resolveBuildPhaseSequence() {
  const raw = String(process.env.BUILD_PHASE_SEQUENCE || 'app')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const appEnabled = parseBoolEnv(process.env.BUILD_PHASE_APP_ENABLED, true);
  const slidesEnabled = parseBoolEnv(process.env.BUILD_PHASE_SLIDES_ENABLED, false);
  const enabledByFlag = new Set();
  if (appEnabled) enabledByFlag.add('app');
  if (slidesEnabled) enabledByFlag.add('slides');
  const deduped = [];
  for (const mode of raw) {
    if (!VALID_BUILD_PHASE_MODES.has(mode)) continue;
    if (!enabledByFlag.has(mode)) continue;
    if (!deduped.includes(mode)) deduped.push(mode);
  }
  if (deduped.length > 0) return deduped;
  if (appEnabled) return ['app'];
  if (slidesEnabled) return ['slides'];
  return ['app'];
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
    const strictSync = String(process.env.NARRATION_SYNC_STRICT || 'true').toLowerCase() !== 'false';
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
    if (!strictSync) {
      console.warn(
        `[narration-sync] STRICT CHECK DISABLED via NARRATION_SYNC_STRICT=false ` +
        `(${contextLabel}) with ${report.violations.length} violation(s).`
      );
      console.warn(`[narration-sync] Fail categories: ${failCategories}`);
      console.warn(`[narration-sync] Fail codes: ${failCodes}`);
      console.warn(`[narration-sync] Report: ${reportPath}`);
      return;
    }
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

async function runScratchPipeline({
  startIdx,
  endIdx,
  noTouchup,
  versionedDir,
  promptText,
  timer,
  recordMode,
  qaThresholdOverride,
  maxRefinementIterationsOverride,
  buildFixModeOverride,
  effectiveFromStage,
}) {
  resetSlideQaBudget();
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
    if (shouldReuseExistingResearch(versionedDir, promptText, effectiveFromStage)) {
      cliLog(
        '[Orchestrator] RESEARCH_REUSE — skipping research.main(); using existing product-research.json ' +
        '(inputPromptFingerprint matches current prompt).'
      );
      appendPipelineLogSection('[RESEARCH] Skipped', [
        'reason=reuse',
        `runDir=${versionedDir}`,
      ], { runDir: versionedDir });
      return;
    }
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

  // Stage 3b: prompt-fidelity-check
  // Diffs entities in inputs/prompt.txt vs demo-script.json BEFORE the build LLM
  // commits to a wrong demo. Brand / persona / products / Plaid Link mode
  // mismatches are critical; dollar-amount drift is a warning. Under
  // PIPE_AGENT_MODE=1, critical drift pauses the orchestrator on a continue-gate
  // so the agent fixes the script before downstream stages run.
  await stageRunner('prompt-fidelity-check', async () => {
    delete require.cache[require.resolve('./scratch/prompt-fidelity-check')];
    const fidelityReport = await require('./scratch/prompt-fidelity-check').main();
    const ctx = isAgentContext();
    if (
      fidelityReport &&
      fidelityReport.comparison &&
      fidelityReport.comparison.criticalCount > 0 &&
      ctx.enabled &&
      !parseBoolEnv(process.env.SCRATCH_AUTO_APPROVE, false)
    ) {
      const runDir = requireRunDir(PROJECT_ROOT, 'orchestrator');
      const taskRel = path.relative(PROJECT_ROOT, path.join(runDir, 'prompt-fidelity-task.md'));
      cliWarn(
        `[Orchestrator] prompt-fidelity-check found ${fidelityReport.comparison.criticalCount} ` +
        `critical drift(s) (score ${fidelityReport.comparison.score}/100). ` +
        `Pausing for agent fix.`
      );
      cliLog(`[Orchestrator]   task: ${taskRel}`);
      cliLog(`[Orchestrator]   open it in Cursor or Claude Code (Agent mode), edit demo-script.json,`);
      cliLog(`[Orchestrator]   then run: npm run pipe -- continue ${path.basename(runDir)}`);
      await promptContinue(
        `Prompt-fidelity drift detected (${fidelityReport.comparison.criticalCount} critical). ` +
        `Open ${taskRel} in your AI agent, fix the drifts, then continue.`
      );
    }
  });

  // Stage 4: script-critique
  await stageRunner('script-critique', async () => {
    await runScriptCritique();
  });

  // Stage 4b: data-realism-check
  // Catches generic placeholder data, persona/balance inconsistencies, fake-
  // looking transaction descriptions, and masking style drift in the LLM-
  // generated demo-script.json. Backed by deterministic regex checks plus an
  // optional Haiku grader (skipped via DATA_REALISM_HAIKU=0). Critical issues
  // pause on a continue-gate under PIPE_AGENT_MODE=1.
  await stageRunner('data-realism-check', async () => {
    delete require.cache[require.resolve('./scratch/data-realism-check')];
    const realismReport = await require('./scratch/data-realism-check').main();
    const ctx = isAgentContext();
    if (
      realismReport &&
      realismReport.criticalCount > 0 &&
      !realismReport.skipped &&
      ctx.enabled &&
      !parseBoolEnv(process.env.SCRATCH_AUTO_APPROVE, false)
    ) {
      const runDir = requireRunDir(PROJECT_ROOT, 'orchestrator');
      const taskRel = path.relative(PROJECT_ROOT, path.join(runDir, 'data-realism-task.md'));
      cliWarn(
        `[Orchestrator] data-realism-check found ${realismReport.criticalCount} ` +
        `critical issue(s) in sample data. Pausing for agent fix.`
      );
      cliLog(`[Orchestrator]   task: ${taskRel}`);
      cliLog(`[Orchestrator]   then run: npm run pipe -- continue ${path.basename(runDir)}`);
      await promptContinue(
        `Data-realism issues (${realismReport.criticalCount} critical). ` +
        `Open ${taskRel} in your AI agent, fix demo-script.json, then continue.`
      );
    }
  });

  // Stage 5: embed-script-validate
  // Backends: Vertex/Google embeddings (preferred) → Anthropic Haiku fallback.
  // Always runs when ANTHROPIC_API_KEY is present (was a silent no-op for SE
  // setups without GCP creds prior to the hyper-realism upgrade). Under
  // PIPE_AGENT_MODE=1, ≥1 flag pauses on a continue-gate so the agent can
  // align narration with visualState before build commits.
  await stageRunner('embed-script-validate', async () => {
    delete require.cache[require.resolve('./scratch/embed-script-validate')];
    const validateReport = await require('./scratch/embed-script-validate').main();
    const ctx = isAgentContext();
    if (
      validateReport &&
      Array.isArray(validateReport.flags) &&
      validateReport.flags.length > 0 &&
      !validateReport.skipped &&
      ctx.enabled &&
      !parseBoolEnv(process.env.SCRATCH_AUTO_APPROVE, false)
    ) {
      const runDir = requireRunDir(PROJECT_ROOT, 'orchestrator');
      const runId = path.basename(runDir);
      // Write a small task .md so the agent has a concrete editing checklist.
      const taskPath = path.join(runDir, 'script-coherence-task.md');
      const lines = [
        `# Script-coherence flags — ${runId}\n`,
        `> The narration and \`visualState\` for the steps below disagree on what the user sees vs what the voiceover claims. ` +
          `Open \`demo-script.json\` and align them before continuing.\n`,
        `> Backend: \`${validateReport.backend || 'embeddings'}\`  ·  threshold: \`${validateReport.threshold}\`\n`,
        `## Flagged steps\n`,
      ];
      for (const f of validateReport.flags) {
        lines.push(`### \`${f.stepId}\` — ${f.message}\n`);
        lines.push(`- **Narration:** ${f.narration}`);
        lines.push(`- **Visual state:** ${f.visualState}`);
        if (f.reason) lines.push(`- **Why flagged:** ${f.reason}`);
        lines.push(``);
      }
      lines.push(
        `## Editing contract\n`,
        `- Edit \`demo-script.json\` directly. Use \`Read\` + \`StrReplace\`. Preserve schema.`,
        `- Either rewrite the narration to match the visual state, OR rewrite the visualState to match what the narration claims — whichever reflects the user's prompt better.`,
        `- Do NOT touch \`build-app.js\` or \`prompt-templates.js\`.\n`,
        `## Final\n`,
        `Run \`npm run pipe -- continue ${runId}\` once you're done.\n`,
      );
      try { fs.writeFileSync(taskPath, lines.join('\n'), 'utf8'); } catch (_) {}
      cliWarn(
        `[Orchestrator] embed-script-validate flagged ${validateReport.flags.length} narration/visual ` +
        `mismatch(es). Pausing for agent fix.`
      );
      cliLog(`[Orchestrator]   task: ${path.relative(PROJECT_ROOT, taskPath)}`);
      cliLog(`[Orchestrator]   then run: npm run pipe -- continue ${runId}`);
      await promptContinue(
        `Script coherence flags (${validateReport.flags.length}). ` +
        `Open ${path.relative(PROJECT_ROOT, taskPath)} in your AI agent and fix before continuing.`
      );
    }
  });

  // Stage 4b: value-prop claim verification (inline — fast Haiku call)
  // Checks narrated claims against the approved claims digest from the run
  // context and the curated per-product knowledge files in inputs/products/.
  // Flags unapproved numbers or misattributed claims before they reach the
  // final video.
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
        console.log('[claim-check] No curated product knowledge, approved-claims digest, or claims-override.json — skipping claim verification.');
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
        // CLAIM_CHECK_STRICT=true hard-fails the pipeline when an unapproved
        // claim slips through. Default is non-strict (warn and continue) for
        // backwards compat, but auto-approve runs should opt in via env so
        // bad claims don't ship silently.
        const claimCheckStrict = parseBoolEnv(process.env.CLAIM_CHECK_STRICT, false);
        if (claimCheckStrict) {
          console.error('[claim-check] CLAIM_CHECK_STRICT=true — failing the pipeline due to flagged claims.');
          throw new Error(`claim-check failed: ${claimResult.flags.length} flagged claim(s). See claim-check-flags.json.`);
        }
        if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
          await promptContinue('[claim-check] Unapproved claims found in script.');
        } else {
          console.warn('[claim-check] SCRATCH_AUTO_APPROVE=true — advancing with flagged claims. Set CLAIM_CHECK_STRICT=true to hard-fail instead.');
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
  runBrandLogoContrastGate(versionedDir);

  // Stage: build + build-qa (phased: app then slides by default)
  const layeredBuildEnabled = process.env.LAYERED_BUILD_ENABLED === 'true' || process.env.LAYERED_BUILD_ENABLED === '1';
  const mobileVisualEnabledFromEnv = process.env.MOBILE_VISUAL_ENABLED === 'true' || process.env.MOBILE_VISUAL_ENABLED === '1';
  const mobileVisualEnabledFromPrompt = promptIndicatesMobileVisual(promptText);
  const mobileVisualForce = process.env.MOBILE_VISUAL_FORCE === 'true' || process.env.MOBILE_VISUAL_FORCE === '1';
  const mobileVisualEnabled =
    mobileVisualEnabledFromPrompt || (mobileVisualEnabledFromEnv && mobileVisualForce);
  const mobileRuntimeEnabled = process.env.MOBILE_RUNTIME_ENABLED === 'true' || process.env.MOBILE_RUNTIME_ENABLED === '1';
  const configuredBuildViewMode = String(process.env.BUILD_VIEW_MODE || 'desktop').toLowerCase();
  const buildViewMode = mobileVisualEnabled ? configuredBuildViewMode : 'desktop';
  if (mobileVisualEnabledFromEnv && !mobileVisualEnabledFromPrompt && !mobileVisualForce) {
    cliWarn(
      '[Orchestrator] Ignoring MOBILE_VISUAL_ENABLED because prompt has no explicit mobile-build request. ' +
      'Set MOBILE_VISUAL_FORCE=true to override.'
    );
  }
  if (layeredBuildEnabled || mobileVisualEnabled || mobileRuntimeEnabled) {
    cliLog(
      `[Orchestrator] Build lanes — layered=${layeredBuildEnabled}, mobile-visual=${mobileVisualEnabled}, ` +
      `mobile-runtime=${mobileRuntimeEnabled}, viewMode=${buildViewMode}`
    );
    if (!mobileVisualEnabledFromEnv && mobileVisualEnabledFromPrompt) {
      cliLog('[Orchestrator] mobile-visual enabled from prompt language (mobile intent detected).');
    }
  }
  // Phase 3 hyper-realism upgrade: raise both the QA pass bar and the
  // refinement-loop ceiling. Tokens are not a constraint; we want polished,
  // not "fine enough." Defaults are documented in .env.example and are
  // overridable per-run via `--qa-threshold=` / `--max-refinement-iterations=`.
  const resolvedBuildIterations = Number.isInteger(maxRefinementIterationsOverride) && maxRefinementIterationsOverride > 0
    ? maxRefinementIterationsOverride
    : parseInt(process.env.MAX_REFINEMENT_ITERATIONS || '5', 10);
  const resolvedBuildQaThreshold = Number.isInteger(qaThresholdOverride) && qaThresholdOverride > 0
    ? qaThresholdOverride
    : parseInt(process.env.QA_PASS_THRESHOLD || '88', 10);
  const requestedBuildFixMode = String(buildFixModeOverride || process.env.BUILD_FIX_MODE || 'auto').toLowerCase();
  const plaidLinkQaMode = String(process.env.PLAID_LINK_QA_MODE || 'auto').trim().toLowerCase();
  const buildQaPlaidMode = String(process.env.BUILD_QA_PLAID_MODE || 'auto').trim().toLowerCase();
  // When BUILD_SLIDES_STRATEGY=post-agent (default) the dedicated `post-slides`
  // stage handles per-slide insertion, so we drop the inline `slides` build
  // phase to free up the LLM context budget for the app phase. Users who need
  // the legacy behavior can opt in with BUILD_SLIDES_STRATEGY=inline.
  const slidesStrategyPre = String(process.env.BUILD_SLIDES_STRATEGY || 'post-agent').toLowerCase();
  let buildPhaseSequence = resolveBuildPhaseSequence();
  if (slidesStrategyPre !== 'inline' && buildPhaseSequence.includes('slides')) {
    buildPhaseSequence = buildPhaseSequence.filter((p) => p !== 'slides');
    cliLog('[Orchestrator] BUILD_SLIDES_STRATEGY=post-agent — dropping inline "slides" build phase in favor of post-slides stage.');
  }
  cliLog(
    `[Orchestrator] Build phase sequence: ${buildPhaseSequence.join(' -> ')} | ` +
    `qaThreshold=${resolvedBuildQaThreshold}, maxRefinementIterations=${resolvedBuildIterations}`
  );

  const runBuildPhase = async (phaseMode, phaseIndex) => {
    const remainingPhases = buildPhaseSequence.slice(phaseIndex + 1);
    // Tier wiring: when BUILD_SLIDES_STRATEGY=post-agent (default) the inline
    // 'slides' phase has been REMOVED from buildPhaseSequence above. So the
    // legacy `remainingPhases.includes('slides')` always returns false even
    // when post-slides WILL run as a separate stage. Derive willRunSlidesPhase
    // from the actual signals (PIPELINE_WITH_SLIDES + BUILD_SLIDES_STRATEGY)
    // so the app build prompt drops ~25-30k tokens of slide template context
    // when post-slides will handle slide insertion.
    const withSlidesEnv = String(process.env.PIPELINE_WITH_SLIDES || '').trim().toLowerCase() === 'true';
    const inlineSlideStrategy = String(process.env.BUILD_SLIDES_STRATEGY || 'post-agent').toLowerCase() === 'inline';
    const willRunInlineSlidesPhase = remainingPhases.includes('slides');
    const willRunSlidesPhase = withSlidesEnv && (willRunInlineSlidesPhase || !inlineSlideStrategy);
    const slidePromptTier = phaseMode === 'slides'
      ? 'full'
      : (willRunSlidesPhase ? 'minimal' : 'full');
    cliLog(
      `[Orchestrator] Build phase "${phaseMode}" prompt tier: ${slidePromptTier}` +
      (phaseMode === 'app' ? ` (slides-followup=${willRunSlidesPhase}, inlineStrategy=${inlineSlideStrategy})` : '')
    );
    const phaseQaThreshold = phaseMode === 'app'
      ? Math.max(80, Number(resolvedBuildQaThreshold || 0))
      : Number(resolvedBuildQaThreshold || 0);
    const qaStepScope = phaseMode === 'slides' ? 'slides' : 'all';
    const phaseIterationCap = shouldRun('build-qa') ? resolvedBuildIterations : 1;
    let phaseQaResult = null;
    let phaseQaReportPath = null;
    for (let iter = 1; iter <= phaseIterationCap; iter++) {
      let fixModeDecision;
      if (iter === 1) {
        fixModeDecision = {
          requestedMode: requestedBuildFixMode,
          evaluatedMode: 'fullbuild',
          executedMode: 'fullbuild',
          reasons: [`initial_${phaseMode}_phase_build`],
          touchupStepId: null,
          deterministicPassed: true,
          deterministicBlockerCount: 0,
          deterministicReasons: [],
          qaScoreBefore: Number(phaseQaResult?.overallScore || 0),
          qaThreshold: phaseQaThreshold,
        };
      } else {
        fixModeDecision = analyzeFixModeForQaIteration({
          versionedDir,
          qaResult: phaseQaResult || {},
          qaThreshold: phaseQaThreshold,
          iteration: `${phaseMode}-${iter - 1}`,
          requestedBuildFixMode: buildFixModeOverride,
        });
      }

      // ── Refinement step: either the LLM regenerates (touchup / fullbuild),
      // or — when running under an AI agent — we skip the build stage and
      // hand control to the agent via a continue-gate. The agent makes
      // surgical StrReplace edits to the existing scratch-app and resumes
      // the orchestrator with `pipe continue <RUN_ID>`.
      const isAgentTouchupIter = fixModeDecision.executedMode === 'agent-touchup' && iter > 1;
      // When the QA patch library applied deterministic patches on the prior
      // iteration, skip the LLM build — the patches mutated the existing
      // scratch-app, so we just want to re-walk build-qa to see if findings
      // cleared. This avoids a costly fullbuild when a tiny code-level fix
      // would do.
      const skipBuildForPatch =
        iter > 1 && process.env.__ORCH_SKIP_NEXT_BUILD === 'true';
      if (skipBuildForPatch) {
        cliLog(
          `[Orchestrator] Iteration ${iter}: skipping build stage — ` +
          `deterministic patches applied on prior iteration. Re-running build-qa on patched HTML.`
        );
        delete process.env.__ORCH_SKIP_NEXT_BUILD;
      }
      if (isAgentTouchupIter) {
        const gateResult = await runAgentTouchupGate({
          runDir: versionedDir,
          iteration: iter,
          fixModeDecision,
          phaseMode,
        });
        if (gateResult.skipped) {
          cliWarn(`[Orchestrator] agent-touchup gate skipped on iter ${iter} — breaking refinement loop.`);
          break;
        }
        // After the gate releases (agent edited + ran `pipe continue`),
        // fall through to the build-qa step below to re-score the run.
      } else if (!skipBuildForPatch && shouldRun('build')) {
        let buildError = null;
        await runStage('build', async () => {
          try {
            await require('./scratch/build-app').main({
              layeredBuildEnabled,
              mobileVisualEnabled,
              buildViewMode,
              buildMode: phaseMode,
              slidePromptTier,
              willRunSlidesPhase,
              qaReportFile: phaseQaReportPath,
              fixMode: fixModeDecision.executedMode,
              touchupStepId: fixModeDecision.touchupStepId,
              fixModeReasonCodes: fixModeDecision.reasons,
            });
          } catch (err) {
            buildError = err;
            throw err;
          }
        }, timer);
        if (buildError) break;
      }

      // Stage: live-api-capture — deterministic, zero-LLM. Calls the demo's
      // featured /api/* routes against the sandbox and writes
      // artifacts/live-api-responses.json so the inline post-panels pass below
      // bakes real responses into the panel (augment + " — live"). Self-skips
      // when PLAID_LINK_LIVE!=true. App phase, first iteration only; not
      // shouldRun-gated (same as the inline post-panels) so it runs in
      // resume --from=build --to=build-qa flows before post-panels.
      if (phaseMode === 'app' && iter === 1) {
        await runStage('live-api-capture', async () => {
          try {
            delete require.cache[require.resolve('./scratch/live-api-capture')];
            await require('./scratch/live-api-capture').main();
          } catch (e) {
            cliWarn(`[Orchestrator] live-api-capture failed (non-fatal): ${e.message}`);
          }
        }, timer);
      }

      // Stage: plaid-link-qa — run once for app phase only.
      if (phaseMode === 'app' && iter === 1 && shouldRun('plaid-link-qa')) {
        await stageRunner('plaid-link-qa', async () => {
          delete require.cache[require.resolve('./scratch/plaid-link-qa')];
          await require('./scratch/plaid-link-qa').main({ mode: plaidLinkQaMode });
        });
      }

      // Inline pre-build-qa pass: post-slides + post-panels must run BEFORE
      // build-qa so the QA walker sees hydrated slide content and the v12
      // API panel. The canonical post-slides/post-panels stages run again
      // later (after the build-phase loop) and are idempotent, so this
      // inline pass is purely additive.
      //
      // NOTE 2026-05-27: these MUST NOT be gated by `shouldRun()` or
      // `stageRunner()` — both filter on the --from/--to range. The
      // canonical post-slides/post-panels stages sit AFTER build-qa in
      // STAGES, so `resume --from=build --to=build-qa` would exclude them.
      // Without this inline pre-buildqa pass, build-qa runs on
      // panel-less, placeholder-only HTML and emits `missing-panel` +
      // `blank-slide` CRITICALs across every step.
      // We call runStage(name, fn, timer) directly to bypass the range
      // filter while still emitting stage telemetry.
      if (phaseMode === 'app') {
        const isAppPlusSlides = (() => {
          const env = String(process.env.PIPELINE_WITH_SLIDES || '').trim().toLowerCase();
          if (env === 'true') return true;
          try {
            const fs = require('fs');
            const path = require('path');
            const mfPath = path.join(versionedDir, 'run-manifest.json');
            if (fs.existsSync(mfPath)) {
              const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
              return mf && mf.buildMode === 'app+slides';
            }
          } catch (_) { /* ignore */ }
          return false;
        })();
        if (isAppPlusSlides) {
          const inlineSlidesStrategy = String(process.env.BUILD_SLIDES_STRATEGY || 'post-agent').toLowerCase();
          if (inlineSlidesStrategy !== 'inline') {
            await runStage('post-slides', async () => {
              try {
                delete require.cache[require.resolve('./scratch/post-slides')];
                const mod = require('./scratch/post-slides');
                if (typeof mod.main === 'function') await mod.main();
              } catch (e) {
                cliWarn(`[Orchestrator] post-slides (inline-pre-buildqa) failed: ${e.message}`);
              }
            }, timer);
          }
        }
        // post-panels is the host-app API panel contract. Gated on the panels
        // axis: a --no-panels build skips JSON-rail injection entirely.
        if (isPanelsEnabled(versionedDir)) {
          await runStage('post-panels', async () => {
            try {
              delete require.cache[require.resolve('./scratch/post-panels')];
              const mod = require('./scratch/post-panels');
              if (typeof mod.main === 'function') await mod.main();
            } catch (e) {
              cliWarn(`[Orchestrator] post-panels (inline-pre-buildqa) failed: ${e.message}`);
            }
          }, timer);
        } else {
          cliLog('[Orchestrator] post-panels (inline-pre-buildqa) skipped — panels disabled (--no-panels).');
        }
      }

      if (!shouldRun('build-qa')) break;

      let qaError = null;
      let currentQaResult = null;
      await runStage('build-qa', async () => {
        try {
          delete require.cache[require.resolve('./scratch/build-qa')];
          currentQaResult = await require('./scratch/build-qa').main({
            mobileVisualEnabled,
            buildViewMode,
            plaidMode: buildQaPlaidMode,
            stepScope: qaStepScope,
          });
        } catch (err) {
          qaError = err;
          throw err;
        }
      }, timer);
      if (qaError) break;

      phaseQaResult = currentQaResult || {};
      try {
        const phaseReportFile = path.join(versionedDir, `qa-report-${phaseMode}-${iter}.json`);
        const canonicalReportFile = path.join(versionedDir, 'qa-report-build.json');
        if (fs.existsSync(canonicalReportFile)) {
          fs.copyFileSync(canonicalReportFile, phaseReportFile);
          phaseQaReportPath = phaseReportFile;
        }
      } catch (_) {}
      const qaScore = Number(phaseQaResult?.overallScore || 0);
      // Honor BUILD_QA_DETERMINISTIC_GATE=false: when the gate is explicitly
      // disabled, do not require deterministicPassed for the iteration to be
      // considered passed. The QA report's `passed` field already reflects the
      // gate state, but we intentionally re-check `deterministicPassed` here as
      // a defense-in-depth signal — and that secondary check must also honor
      // the gate flag, otherwise BUILD_QA_DETERMINISTIC_GATE=false has no
      // effect on the orchestrator's iteration loop.
      const phaseDeterministicGateEnabled = phaseQaResult?.deterministicGateEnabled !== false;
      const phaseDeterministicOk =
        !phaseDeterministicGateEnabled || phaseQaResult?.deterministicPassed !== false;
      const phasePassed =
        phaseQaResult?.passed === true &&
        phaseDeterministicOk &&
        qaScore >= phaseQaThreshold;
      if (phasePassed) {
        cliLog(
          `[Orchestrator] Build phase "${phaseMode}" passed on iteration ${iter} ` +
          `(${qaScore}/${phaseQaThreshold}).`
        );
        break;
      }

      // ── Tier-aware recovery routing ─────────────────────────────────────
      // When the QA report carries a tierSummary (added by build-qa), prefer
      // a surgical tier-scoped recovery lane over another full build-app /
      // generateApp pass. This handles the common cases where:
      //   - app-only build with a single failing host step → app-touchup
      //   - app+slides build where app passed but slides regressed → slide-fix
      //   - app+slides build where app failed but slides passed → app-touchup
      // The lanes themselves NEVER call build-app. Systemic failures
      // (recommendedRecovery: 'fullbuild') fall through to the LLM refinement
      // path below.
      const tierRecovery = phaseQaResult?.recommendedRecovery || null;
      const tierSummary = phaseQaResult?.tierSummary || null;
      const tierRecoveryUsable =
        phaseMode === 'app' &&
        tierSummary &&
        (tierRecovery === 'app-touchup' ||
          tierRecovery === 'slide-fix' ||
          tierRecovery === 'app-touchup+slide-fix');
      if (tierRecoveryUsable) {
        const ranLanes = await runTierRecoveryLanes({
          runDir: versionedDir,
          tierRecovery,
          tierSummary,
        });
        if (ranLanes.appPassed && ranLanes.slidePassed) {
          cliLog(
            `[Orchestrator] Tier-aware recovery cleared all failures on iteration ${iter} ` +
            `(app=passed, slide=${tierSummary.slide.skipped ? 'skipped' : 'passed'}).`
          );
          break;
        }
        if (ranLanes.agentGateRequested) {
          // The lane wrote a qa-{app-touchup,slide-fix}-task.md and we are
          // running under an agent context — hand control to the agent.
          // Autonomous mode has no interactive agent to edit + `pipe continue`,
          // so blocking here would orphan the orchestrator. Break the loop and
          // let the run complete at this verdict (task files remain for later).
          const autonomousGate =
            (process.env.SCRATCH_AUTO_APPROVE === 'true' || parseBoolEnv(process.env.PIPELINE_NONINTERACTIVE, false)) &&
            !process.stdin.isTTY;
          if (autonomousGate) {
            cliLog(
              `[Orchestrator] Tier-aware recovery (iter ${iter}): autonomous mode — not blocking; ` +
              `ending at this verdict. Task(s): ${ranLanes.taskFiles.join(' / ')}.`
            );
            emitPipeEvent('qa_recovery_gate_autoskip', {
              iteration: iter, runId: path.basename(versionedDir),
              failingTiers: ranLanes.failingTiers, taskFiles: ranLanes.taskFiles,
            });
            break;
          }
          // Skip the LLM build for the next iteration: the agent edits
          // existing HTML and `pipe continue` re-runs build-qa.
          process.env.__ORCH_SKIP_NEXT_BUILD = 'true';
          await promptContinue(
            `[Orchestrator] Tier-aware recovery (iter ${iter}): residual failures on ` +
            `${ranLanes.failingTiers.join(' + ')} tier. Open ${ranLanes.taskFiles.join(' / ')} in your AI agent, ` +
            `edit the failing step(s), then continue.`
          );
        }
      }

      if (iter < phaseIterationCap) {
        const deterministicNote = phaseDeterministicGateEnabled
          ? `deterministicPassed=${phaseQaResult?.deterministicPassed !== false}`
          : `deterministicPassed=${phaseQaResult?.deterministicPassed !== false} (gate disabled)`;
        cliWarn(
          `[Orchestrator] Build phase "${phaseMode}" iteration ${iter} did not pass ` +
          `(score=${qaScore}, ${deterministicNote}).`
        );

        // ── Deterministic QA patch library ──────────────────────────────
        // Before the LLM iterates, see if any known deterministic patches
        // (e.g., api-panel-toggle-v2, plaid-launch-cta-icon-ratio) can fix
        // the QA findings without a rebuild. Patches are tiny, idempotent,
        // and tracked in qa-patch-history.json for audit. If at least one
        // patch is applied, the next iteration's `build` stage is skipped
        // for non-fullbuild fix-modes — we just re-run build-qa on the
        // patched HTML to see if it cleared the findings.
        try {
          const patchLib = require('./utils/qa-patch-library');
          const matches = patchLib.findApplicablePatches(phaseQaResult);
          if (matches.length > 0) {
            cliLog(
              `[Orchestrator] QA patch library: ${matches.length} candidate(s) ` +
              `(${matches.map((m) => m.patch.name).join(', ')})`
            );
            const patchOut = await patchLib.applyPatches({
              runDir: versionedDir,
              matches,
              iteration: `${phaseMode}-${iter}`,
            });
            if (patchOut.applied > 0) {
              cliLog(
                `[Orchestrator] Applied ${patchOut.applied} deterministic patch(es): ` +
                patchOut.results.filter((r) => r.applied).map((r) => r.name).join(', ')
              );
              // Mark that the next iteration's build stage should be skipped.
              process.env.__ORCH_SKIP_NEXT_BUILD = 'true';
            } else {
              cliLog(
                `[Orchestrator] QA patch library: no patches applied this iteration ` +
                `(${patchOut.results.map((r) => `${r.name}=${r.applied ? 'ok' : 'noop'}`).join(', ')})`
              );
            }
          }
        } catch (patchErr) {
          cliWarn(`[Orchestrator] QA patch library failed: ${patchErr && patchErr.message || patchErr}`);
        }
      }
    }
  };

  for (let phaseIndex = 0; phaseIndex < buildPhaseSequence.length; phaseIndex++) {
    const phaseMode = buildPhaseSequence[phaseIndex];
    await runBuildPhase(phaseMode, phaseIndex);
  }

  // Plaid QA mode logging
  cliLog(`[Orchestrator] Plaid QA modes — plaid-link-qa=${plaidLinkQaMode}, build-qa=${buildQaPlaidMode}`);

  // ── Agent-driven per-slide insertion (post-slides) ──────────────────────
  // Runs only when:
  //   - BUILD_SLIDES_STRATEGY=post-agent (default), AND
  //   - The demo-script has any step with stepKind === 'slide' that is not yet
  //     rendered as .slide-root in scratch-app/index.html.
  // Skipped entirely when BUILD_SLIDES_STRATEGY=inline (legacy safety net).
  const slidesStrategy = String(process.env.BUILD_SLIDES_STRATEGY || 'post-agent').toLowerCase();
  if (shouldRun('post-slides') && slidesStrategy !== 'inline') {
    await runStage('post-slides', async () => {
      try {
        delete require.cache[require.resolve('./scratch/post-slides')];
        const mod = require('./scratch/post-slides');
        if (typeof mod.main === 'function') await mod.main();
      } catch (e) {
        cliWarn(`[Orchestrator] post-slides stage failed: ${e.message}`);
      }
    }, timer).catch(() => {});
  } else if (slidesStrategy === 'inline') {
    cliLog('[Orchestrator] BUILD_SLIDES_STRATEGY=inline — skipping post-slides (legacy in-build slide pass).');
  }

  // ── Deterministic JSON side-panel normalizer (post-panels) ──────────────
  // Runs unconditionally (idempotent); guarantees #api-response-panel contract.
  if (shouldRun('post-panels') && isPanelsEnabled(versionedDir)) {
    await runStage('post-panels', async () => {
      try {
        delete require.cache[require.resolve('./scratch/post-panels')];
        const mod = require('./scratch/post-panels');
        if (typeof mod.main === 'function') await mod.main();
      } catch (e) {
        cliWarn(`[Orchestrator] post-panels stage failed: ${e.message}`);
      }
    }, timer).catch(() => {});
  } else if (shouldRun('post-panels')) {
    cliLog('[Orchestrator] post-panels stage skipped — panels disabled (--no-panels).');
  }

  // ── API panel accuracy audit (api-panel-audit) ──────────────────────────
  // Validates demo-script.json apiResponse blocks against Plaid's real
  // contracts (live-capture diff + AskBill cache + deterministic rules).
  // Flag-only: never rewrites curated values. Warn + agent-task by default;
  // API_PANEL_AUDIT_STRICT=true hard-fails on HIGH-severity inaccuracies.
  if (shouldRun('api-panel-audit') && isPanelsEnabled(versionedDir)) {
    await runStage('api-panel-audit', async () => {
      delete require.cache[require.resolve('./scratch/api-panel-audit')];
      const auditReport = await require('./scratch/api-panel-audit').main();
      if (!auditReport || auditReport.skipped || auditReport.passed) return;
      const runDir = requireRunDir(PROJECT_ROOT, 'orchestrator');
      const runId = path.basename(runDir);
      const s = auditReport.summary || {};
      const taskRel = auditReport.taskPath ? path.relative(PROJECT_ROOT, auditReport.taskPath) : 'api-panel-audit-task.md';
      const msg = `[api-panel-audit] ${s.high || 0} HIGH + ${s.med || 0} MED API-panel inaccuracy(ies) ` +
        `across ${s.major || 0} MAJOR / ${s.minor || 0} MINOR block(s).`;
      if (parseBoolEnv(process.env.API_PANEL_AUDIT_STRICT, false)) {
        cliError(`${msg} API_PANEL_AUDIT_STRICT=true — failing. See ${taskRel}.`);
        throw new Error(`CRITICAL: api-panel-audit found ${s.high || 0} HIGH API-panel inaccuracies. See ${taskRel}.`);
      }
      const ctx = isAgentContext();
      if (ctx.enabled && !parseBoolEnv(process.env.SCRATCH_AUTO_APPROVE, false)) {
        cliWarn(`${msg} Pausing for agent fix.`);
        cliLog(`[Orchestrator]   task: ${taskRel}`);
        cliLog(`[Orchestrator]   apply the fixes in demo-script.json, then: npm run pipe -- stage post-panels ${runId}`);
        cliLog(`[Orchestrator]   then run: npm run pipe -- continue ${runId}`);
        await promptContinue(`[api-panel-audit] API-panel inaccuracies found — fix per ${taskRel}.`);
      } else {
        cliWarn(`${msg} Advancing (SCRATCH_AUTO_APPROVE). Fix checklist: ${taskRel}.`);
      }
    }, timer).catch(() => {});
  }

  // ── Tier-scoped recovery lanes (app-touchup, slide-fix) ─────────────────
  // These stages are only invoked when explicitly targeted via --from / --to
  // / stage, because the inline tier-aware routing inside `runBuildPhase`
  // already runs them between build-qa iterations. Outside of that loop they
  // are useful for hand-driven recovery (e.g. after `npm run pipe -- stage
  // build-qa <RUN_ID>` reveals a residual app or slide failure).
  if (shouldRun('app-touchup')) {
    await runStage('app-touchup', async () => {
      try {
        delete require.cache[require.resolve('./scratch/app-touchup')];
        const mod = require('./scratch/app-touchup');
        if (typeof mod.main === 'function') {
          await mod.main({ runDir: versionedDir, emitAgentTask: isAgentContext() });
        }
      } catch (e) {
        cliWarn(`[Orchestrator] app-touchup stage failed: ${e.message}`);
      }
    }, timer).catch(() => {});
  }

  if (shouldRun('slide-fix')) {
    await runStage('slide-fix', async () => {
      try {
        await dispatchSlideFix(versionedDir, { emitAgentTask: isAgentContext() });
      } catch (e) {
        cliWarn(`[Orchestrator] slide-fix stage failed: ${e.message}`);
      }
    }, timer).catch(() => {});
  }

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

  // Stage: set-recording-dwells — sizes each step's waitMs from its narration
  // word count BEFORE the recorder runs, so the camera dwells on the screen
  // long enough to cover the spoken audio without auto-gap having to clip or
  // freeze. Narration is ground truth; the recording must adapt.
  if (shouldRun('set-recording-dwells')) {
    await runStage('set-recording-dwells', async () => {
      delete require.cache[require.resolve('./scratch/set-recording-dwells.js')];
      const { main: runDwell } = require('./scratch/set-recording-dwells.js');
      await runDwell(versionedDir);
    }, timer);
  }

  // Stage: record + QA refinement loop
  if (shouldRun('record')) {
    timer.startStage('record+qa');

    const studioMode    = recordMode === 'studio';
    const manualRecord  = process.env.MANUAL_RECORD === 'true';
    let bestScore     = 0;
    let bestRecording = null;
    const resolvedMaxIterations = Number.isInteger(maxRefinementIterationsOverride) && maxRefinementIterationsOverride > 0
      ? maxRefinementIterationsOverride
      : parseInt(process.env.MAX_REFINEMENT_ITERATIONS || '5', 10);
    const resolvedQaThreshold = Number.isInteger(qaThresholdOverride) && qaThresholdOverride > 0
      ? qaThresholdOverride
      : parseInt(process.env.QA_PASS_THRESHOLD || '88', 10);
    const maxIterations = (studioMode || manualRecord) ? 1 : resolvedMaxIterations;
    const qaThreshold = resolvedQaThreshold;
    const effectiveBuildFixMode = String(buildFixModeOverride || process.env.BUILD_FIX_MODE || 'auto').toLowerCase();
    cliLog(
      `[Orchestrator] QA refinement config: qaThreshold=${qaThreshold}, ` +
      `maxRefinementIterations=${maxIterations}, buildFixMode=${effectiveBuildFixMode}` +
      (Number.isInteger(qaThresholdOverride) || Number.isInteger(maxRefinementIterationsOverride) || !!buildFixModeOverride
        ? ' [CLI override applied]'
        : '')
    );
    appendPipelineLogJson('[RUN] QA refinement config', {
      qaThreshold,
      maxRefinementIterations: maxIterations,
      buildFixMode: effectiveBuildFixMode,
      overrides: {
        qaThreshold: Number.isInteger(qaThresholdOverride) ? qaThresholdOverride : null,
        maxRefinementIterations: Number.isInteger(maxRefinementIterationsOverride)
          ? maxRefinementIterationsOverride
          : null,
        buildFixMode: buildFixModeOverride || null,
      },
    }, { runDir: versionedDir });

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
        const qaResult = await require('./scratch/qa-review').main({
          iteration: 1,
          qaPassThreshold: qaThreshold,
        });
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
        // Bust require cache so edits to record-local.js (and the modules it
        // pulls in for live Plaid automation — backend token/brand resolution,
        // app server, browser agent, pacing) take effect without restarting the
        // orchestrator. record-local alone was insufficient: a mid-run edit to
        // plaid-backend (client_name host-brand resolution, 2026-06-13) did NOT
        // apply because record-local re-loaded but plaid-backend stayed cached.
        for (const mod of [
          './scratch/record-local',
          './utils/plaid-backend',
          './utils/app-server',
          './utils/plaid-browser-agent',
          './utils/human-pacing',
          './utils/plaid-nav-profile',
        ]) {
          try { delete require.cache[require.resolve(mod)]; } catch (_) {}
        }
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
        qaResult = await require('./scratch/qa-review').main({
          iteration: iter,
          qaPassThreshold: qaThreshold,
        });
      } catch (err) {
        cliError(`[qa] iteration ${iter} failed: ${err.message}`);
        qaResult = { overallScore: 0, passed: false };
      }

      const score = qaResult?.overallScore ?? 0;
      const deterministicPassed = qaResult?.deterministicPassed;
      const deterministicBlockerCount = Number(
        qaResult?.deterministicBlockerCount ??
        qaResult?.deterministicCriticalCount ??
        0
      );
      cliLog(
        `[Orchestrator] QA score: ${score}/${qaThreshold} (threshold)` +
        (deterministicPassed == null
          ? ''
          : ` | deterministicPassed=${deterministicPassed} blockers=${deterministicBlockerCount}`)
      );

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
        const fixModeDecision = analyzeFixModeForQaIteration({
          versionedDir,
          qaResult,
          qaThreshold,
          iteration: iter,
          requestedBuildFixMode: buildFixModeOverride,
        });
        cliLog(
          `[Orchestrator] Score ${score} below threshold. Fix mode: ` +
          `${fixModeDecision.executedMode} ` +
          `(requested=${fixModeDecision.requestedMode}, evaluated=${fixModeDecision.evaluatedMode}, ` +
          `reason=${fixModeDecision.reasons.join(',')}, deterministicPassed=${fixModeDecision.deterministicPassed}, ` +
          `deterministicBlockers=${fixModeDecision.deterministicBlockerCount})`
        );
        appendPipelineLogJson('[FIX-MODE] QA refinement decision', {
          iteration: iter,
          requestedMode: fixModeDecision.requestedMode,
          evaluatedMode: fixModeDecision.evaluatedMode,
          executedMode: fixModeDecision.executedMode,
          reasons: fixModeDecision.reasons,
          touchupStepId: fixModeDecision.touchupStepId,
          qaScoreBefore: fixModeDecision.qaScoreBefore,
          qaThreshold: fixModeDecision.qaThreshold,
          qaReportPath: fixModeDecision.qaReportPath,
          deterministicPassed: fixModeDecision.deterministicPassed,
          deterministicBlockerCount: fixModeDecision.deterministicBlockerCount,
          deterministicReasons: fixModeDecision.deterministicReasons,
        }, { runDir: versionedDir });
        try {
          // Bust require cache so edits to build-app.js take effect without restarting
          delete require.cache[require.resolve('./scratch/build-app')];
          await require('./scratch/build-app').main({
            refinementIteration: iter,
            qaReportFile: path.join(versionedDir, `qa-report-${iter}.json`),
            fixMode: fixModeDecision.executedMode,
            touchupStepId: fixModeDecision.touchupStepId,
            fixModeReasonCodes: fixModeDecision.reasons,
          });
          // CRITICAL (2026-06-12): a refinement rebuild regenerates
          // playwright-script.json with the build-time PLACEHOLDER waits
          // (0.8–3s) — the narration dwells that set-recording-dwells applied
          // before recording are wiped, so every refinement re-record rushed
          // its steps and frames lagged a full screen behind (Gringo iter-2:
          // host steps marked 2s apart, QA 79 with previous-step frames).
          // Re-apply narration dwells before the loop re-records.
          try {
            delete require.cache[require.resolve('./scratch/set-recording-dwells.js')];
            const { main: reDwell } = require('./scratch/set-recording-dwells.js');
            await reDwell(versionedDir);
            cliLog('[Orchestrator] Re-applied narration dwells after refinement rebuild.');
          } catch (dwellErr) {
            cliWarn(`[Orchestrator] Could not re-apply recording dwells after rebuild: ${dwellErr.message}`);
          }
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
      } else if (parseBoolEnv(process.env.QA_BELOW_THRESHOLD_BYPASS, false)) {
        // Batch / bulk pipelines (e.g., running many prompts unattended) can
        // opt in with QA_BELOW_THRESHOLD_BYPASS=true to advance with the best
        // available recording rather than aborting. The warning and the
        // recording-qa-warning.json file above make the sub-threshold result
        // visible in post-run audits.
        cliWarn(
          `[QA] QA_BELOW_THRESHOLD_BYPASS=true — advancing to render despite ` +
          `best score ${bestScore}/${qaThreshold}. See recording-qa-warning.json.`
        );
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

  // ── HARD GATE (the ONLY Plaid-Link halt): modal missing in the RECORD step ─
  // A live plaidPhase:"launch" step that captured host UI only (no visible
  // modal) must NOT be post-processed/rendered into a Plaid-less demo. Detected
  // by the post-record QA (category `plaid-modal-missing`); reads the
  // post-record qa-report-N.json only (NOT build-qa's token-only report), so it
  // never fires during the typical build-qa pass. Cox Automotive shipped a
  // Plaid-less video on 2026-06-18 because this finding was non-critical.
  // The root cause is almost always PATCHABLE (a /link/token/create failure or
  // Plaid SDK init/`handler.open()` problem, or the app covering the modal with
  // a host loading/result screen) — the gate halts so an agent/human can patch
  // it and re-record. Strict by default; PLAID_LINK_STRICT=false /
  // PLAID_LINK_BYPASS=true to override.
  if (shouldRun('qa')) {
    try {
      const { checkPlaidLinkIntegrity, isStrict } = require('./utils/plaid-link-integrity');
      const integ = await checkPlaidLinkIntegrity(versionedDir, { phase: 'post-record' });
      const rec = (integ.violations || []).filter(v => v.kind === 'modal-missing');
      if (rec.length) {
        const stepList = rec.map(v => v.stepId).join(', ');
        const msg = `[plaid-link] ${rec.length} launch step(s) recorded NO visible Plaid modal: ${stepList}. The Plaid modal did not render on screen.`;
        const fixHint = 'Likely cause (patchable): a /link/token/create error or Plaid SDK init / handler.open() failure, ' +
          'or the host app covered the modal with a loading/result screen. Patch the app (link-token request / SDK launch), then re-record (--from=record).';
        const bypass = parseBoolEnv(process.env.PLAID_LINK_BYPASS, false);
        if (isStrict() && !bypass) {
          if (isAgentContext().enabled && !parseBoolEnv(process.env.SCRATCH_AUTO_APPROVE, false)) {
            cliWarn(`${msg} Pausing for fix.`);
            cliLog(`[Orchestrator]   ${fixHint}`);
            cliLog('[Orchestrator]   See plaid-link-integrity.json. Override: PLAID_LINK_BYPASS=true.');
            await promptContinue('[plaid-link] Plaid modal missing in recording — patch link-token/SDK launch + re-record.');
          } else {
            throw new Error(`CRITICAL: PLAID_LINK_MODAL_MISSING — ${msg} ${fixHint} Override with PLAID_LINK_BYPASS=true. See plaid-link-integrity.json.`);
          }
        } else {
          cliWarn(`${msg} Advancing (PLAID_LINK_STRICT=false / PLAID_LINK_BYPASS=true). See plaid-link-integrity.json.`);
        }
      }
      // Unsuccessful link gate: the recorder force-completed without the app's
      // onSuccess (e.g. a rejected sandbox OTP — YNAB 2026-06-24). The demo would
      // ship a Link flow that never connected. Same strict/bypass handling as
      // modal-missing; the OTP is now length-corrected at record time so this
      // should be rare, but the gate prevents a silently-broken demo.
      const bad = (integ.violations || []).filter(v => v.kind === 'link-unsuccessful');
      if (bad.length) {
        const msg = `[plaid-link] Plaid Link was NOT successful on ${bad.map(v => v.stepId).join(', ')} (${bad[0].outcome}): ${bad[0].detail}`;
        const bypass = parseBoolEnv(process.env.PLAID_LINK_BYPASS, false);
        if (isStrict() && !bypass) {
          if (isAgentContext().enabled && !parseBoolEnv(process.env.SCRATCH_AUTO_APPROVE, false)) {
            cliWarn(`${msg} Pausing for fix.`);
            await promptContinue('[plaid-link] Link not successful (likely wrong OTP / credentials) — fix + re-record.');
          } else {
            throw new Error(`CRITICAL: PLAID_LINK_UNSUCCESSFUL — ${msg} Override with PLAID_LINK_BYPASS=true. See plaid-link-integrity.json.`);
          }
        } else {
          cliWarn(`${msg} Advancing (PLAID_LINK_STRICT=false / PLAID_LINK_BYPASS=true).`);
        }
      }
    } catch (e) {
      if (/^CRITICAL:/.test(e.message)) throw e;
      cliWarn(`[plaid-link] post-record integrity check error (non-fatal): ${e.message}`);
    }
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

  // ── CHECK (non-halting): Plaid Link clipped by the post-process cut ────────
  // After the cut, each plaidPhase:"launch" step should retain >= PLAID_LINK_MIN_KEEP_S
  // of footage. Clipping is RECOVERABLE (re-run --from=post-process / tune
  // --max-institution), so this WARNS + records it for an agent/human to patch
  // — it does NOT halt (only a modal missing in the record step halts).
  if (shouldRun('post-process')) {
    try {
      const { checkPlaidLinkIntegrity } = require('./utils/plaid-link-integrity');
      const integ = await checkPlaidLinkIntegrity(versionedDir, { phase: 'post-process' });
      const clipped = (integ.violations || []).filter(v => v.kind === 'clipped');
      if (clipped.length) {
        cliWarn(`[plaid-link] ${clipped.length} launch step(s) clipped below the ${process.env.PLAID_LINK_MIN_KEEP_S || 4}s keep floor by post-process: ` +
          clipped.map(v => `${v.stepId} (${v.keptS}s)`).join(', ') + '.');
        cliLog('[plaid-link]   Patchable: re-run `--from=post-process` (e.g. larger `--max-institution`) or re-record. See plaid-link-integrity.json.');
      }
    } catch (e) {
      cliWarn(`[plaid-link] post-process integrity check error (non-fatal): ${e.message}`);
    }
  }

  // Stage: measure-sync-debt — classify per-step drift between recorded video and
  // narration text. Writes sync-debt-report.json. Runs BEFORE voiceover so the
  // downstream repace stage can rewrite narration to fit measured video durations.
  if (shouldRun('measure-sync-debt')) {
    await runStage('measure-sync-debt', async () => {
      delete require.cache[require.resolve('./scratch/measure-sync-debt.js')];
      const { main: runMeasure } = require('./scratch/measure-sync-debt.js');
      await runMeasure(versionedDir);
    }, timer);
  }

  // Stage: repace-narration — rewrite narration text to fit the measured video
  // duration when the drift is within the rewrite budget. Mutates demo-script.json
  // in place; the voiceover stage's fingerprint cache picks up the change and
  // regenerates only affected ElevenLabs clips. Steps that need a video trim or
  // re-record are skipped here and surface in narration-repace-report.json.
  if (shouldRun('repace-narration')) {
    await runStage('repace-narration', async () => {
      delete require.cache[require.resolve('./scratch/repace-narration.js')];
      const { main: runRepace } = require('./scratch/repace-narration.js');
      await runRepace(versionedDir);
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

  // Stage: story-echo-check — whole-video fidelity gate.
  // Asks Sonnet whether the voiceover end-to-end answers the user's pitch.
  // Skipped automatically when ANTHROPIC_API_KEY is missing or
  // STORY_ECHO_CHECK=0. Critical drift in agent mode pauses on a continue-gate
  // so the agent can fix demo-script narration + re-run voiceover.
  if (shouldRun('story-echo-check')) {
    await runStage('story-echo-check', async () => {
      delete require.cache[require.resolve('./scratch/story-echo-check')];
      const echoReport = await require('./scratch/story-echo-check').main();
      const ctx = isAgentContext();
      if (
        echoReport &&
        echoReport.passed === false &&
        !echoReport.skipped &&
        ctx.enabled &&
        !parseBoolEnv(process.env.SCRATCH_AUTO_APPROVE, false)
      ) {
        const runDir = requireRunDir(PROJECT_ROOT, 'orchestrator');
        const taskRel = path.relative(PROJECT_ROOT, path.join(runDir, 'story-echo-task.md'));
        cliWarn(
          `[Orchestrator] story-echo-check failed (score ${echoReport.score}/${echoReport.threshold}). ` +
          `Pausing for agent fix.`
        );
        cliLog(`[Orchestrator]   task: ${taskRel}`);
        cliLog(`[Orchestrator]   then run: npm run pipe -- continue ${path.basename(runDir)}`);
        await promptContinue(
          `Story-echo drift (${echoReport.score}/${echoReport.threshold}). ` +
          `Open ${taskRel} in your AI agent, fix demo-script narration / re-run voiceover, then continue.`
        );
      }
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

      // ── Per-clip stutter/freeze detection with retry cap ──────────────────
      //
      // Detection thresholds (env-configurable for tuning without code changes):
      //
      //   AUDIO_QA_NOISE_DB         default: -45   (dB below which audio counts as silence)
      //   AUDIO_QA_MIN_SILENCE_S    default: 0.25  (minimum silence duration to consider)
      //   AUDIO_QA_FREEZE_S         default: 0.50  (silence >= this → FREEZE, else STUTTER)
      //   AUDIO_QA_STUTTER_MIN_COUNT default: 2    (# of silences required to flag as stutter)
      //
      // Calibration rationale (ElevenLabs multilingual_v2, stability=0.75):
      //   • Natural sentence/clause pauses: -35 to -43 dB, 150–350 ms — NOT artifacts
      //   • ElevenLabs freeze artifacts: < -50 dB (near-complete silence), 400 ms+
      //   • The original -40 dB / 0.15 s thresholds caught sentence-boundary pauses as
      //     "stutters", causing false regeneration of acceptable clips. Tighter thresholds
      //     here require deeper silence AND longer duration before flagging.
      //   • STUTTER_MIN_COUNT ≥ 2 avoids flagging a single long sentence pause; a true
      //     stutter pattern repeats across the clip.
      //
      // MAX_AUDIO_REGEN_ATTEMPTS caps the retry loop so a persistently bad TTS response
      // can't cause an infinite pipeline loop.

      // Calibration notes (May 2026, revisited after Tilt v2 stutter-storm):
      //   • ElevenLabs multilingual_v2 at stability=0.75 routinely emits
      //     0.30–0.55 s silences at sentence/em-dash boundaries. The previous
      //     MIN_SILENCE_S=0.25 + FREEZE_S=0.50 + STUTTER_MIN_COUNT=2 fired on
      //     every clip with two commas + a period — 7/9 Tilt v2 clips flagged
      //     in attempt 1, with 5/9 still flagged after exhausting all 3
      //     regeneration retries.
      //   • Real freeze artifacts (TTS endpoint dropouts) leave 1.0–2.0 s of
      //     near-complete silence — well clear of the relaxed thresholds.
      //   • Genuine stutter (clipped re-render) repeats 3+ short silences in
      //     the same clip; 2 hits is rarely diagnostic on its own.
      const NOISE_DB          = process.env.AUDIO_QA_NOISE_DB          || '-45dB';
      const MIN_SILENCE_S     = parseFloat(process.env.AUDIO_QA_MIN_SILENCE_S    || '0.32');
      const FREEZE_S          = parseFloat(process.env.AUDIO_QA_FREEZE_S         || '0.70');
      const STUTTER_MIN_COUNT = parseInt(process.env.AUDIO_QA_STUTTER_MIN_COUNT  || '3', 10);
      const MAX_AUDIO_REGEN_ATTEMPTS = 3;
      const regenAttemptCounts = {}; // { [clipId]: number }

      // Leading / trailing exclusion windows scale with MIN_SILENCE_S so they stay meaningful.
      const LEAD_EXCL_S  = Math.max(0.1,  MIN_SILENCE_S * 0.5); // ignore within 0.5× of clip start
      const TRAIL_EXCL_S = Math.max(0.3,  MIN_SILENCE_S);       // ignore within 1× of clip end

      function detectStutteredClips(clips) {
        const { spawnSync: spawnSyncAudio } = require('child_process');
        const found = [];
        for (const clip of clips) {
          if (!fs.existsSync(clip.audioFile)) continue;
          const r = spawnSyncAudio(
            'ffmpeg',
            ['-i', clip.audioFile, '-af', `silencedetect=noise=${NOISE_DB}:d=${MIN_SILENCE_S}`, '-f', 'null', '-'],
            { encoding: 'utf8', timeout: 30000 }
          );
          const out = (r.stderr || '') + (r.stdout || '');
          const silenceEnds = [...out.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)];
          const clipDuration = clip.audioDurationMs / 1000;
          const internalSilences = silenceEnds.filter(m => {
            const end = parseFloat(m[1]);
            const dur = parseFloat(m[2]);
            const start = end - dur;
            return start > LEAD_EXCL_S && end < (clipDuration - TRAIL_EXCL_S) && dur >= MIN_SILENCE_S;
          });
          if (internalSilences.length === 0) continue;

          const maxDur = Math.max(...internalSilences.map(m => parseFloat(m[2])));
          const isFreeze   = maxDur >= FREEZE_S;
          const isStutter  = !isFreeze && internalSilences.length >= STUTTER_MIN_COUNT;

          if (isFreeze || isStutter) {
            const type = isFreeze ? 'freeze' : 'stutter';
            console.warn(`  [Audio QA] ${type} detected in ${clip.id}: ${internalSilences.length} internal silence(s), max ${maxDur.toFixed(2)}s`);
            found.push({ clip, type, count: internalSilences.length, maxDur });
          } else {
            // Single silence below freeze boundary: log only, do not regenerate.
            console.log(`  [Audio QA] note: ${clip.id} has ${internalSilences.length} internal silence(s), max ${maxDur.toFixed(2)}s (below regen threshold — likely natural pause)`);
          }
        }
        return found;
      }

      let stutteredClips = [];
      let overallResult = { passed: false, issues: [] };

      try {
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          stutteredClips = detectStutteredClips(manifest.clips || []);

          if (stutteredClips.length > 0) {
            // ── Backup clips before any deletion so we can restore on failure ──
            const backupDir = path.join(audioDir, `backup-${Date.now()}`);
            fs.mkdirSync(backupDir, { recursive: true });
            for (const { clip } of stutteredClips) {
              if (fs.existsSync(clip.audioFile)) {
                fs.copyFileSync(clip.audioFile, path.join(backupDir, path.basename(clip.audioFile)));
              }
            }

            // Retry loop: delete bad clips and regenerate, up to MAX_AUDIO_REGEN_ATTEMPTS per clip.
            let toRegen = stutteredClips;
            let regenOk = false;
            try {
              while (toRegen.length > 0) {
                const stillBad = toRegen.filter(({ clip }) => {
                  regenAttemptCounts[clip.id] = (regenAttemptCounts[clip.id] || 0) + 1;
                  if (regenAttemptCounts[clip.id] > MAX_AUDIO_REGEN_ATTEMPTS) {
                    console.warn(`  [Audio QA] WARN: ${clip.id} failed ${MAX_AUDIO_REGEN_ATTEMPTS} regeneration attempt(s) — keeping last available clip`);
                    return false;
                  }
                  return true;
                });
                if (stillBad.length === 0) break;

                const attemptNum = Math.max(...stillBad.map(s => regenAttemptCounts[s.clip.id]));
                console.warn(`[Audio QA] ${stillBad.length} clip(s) have stutter/freeze (attempt ${attemptNum}/${MAX_AUDIO_REGEN_ATTEMPTS}) — regenerating...`);
                for (const { clip } of stillBad) {
                  try { fs.unlinkSync(clip.audioFile); } catch (_) {}
                  console.log(`  [Audio QA] Deleted ${path.basename(clip.audioFile)} for regeneration`);
                }
                const voiceoverPath = path.join(audioDir, 'voiceover.mp3');
                try { if (fs.existsSync(voiceoverPath)) fs.unlinkSync(voiceoverPath); } catch (_) {}

                console.log('[Audio QA] Re-running voiceover generation for affected clips...');
                execSync('node scripts/generate-voiceover.js --scratch --no-stitch', {
                  stdio: 'inherit',
                  cwd: PROJECT_ROOT,
                });
                execSync('node scripts/resync-audio.js', {
                  stdio: 'inherit',
                  cwd: PROJECT_ROOT,
                  env:  { ...process.env, PIPELINE_RUN_DIR: versionedDir },
                });

                const freshManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const regenIds = new Set(stillBad.map(s => s.clip.id));
                const regenClips = (freshManifest.clips || []).filter(c => regenIds.has(c.id));
                toRegen = detectStutteredClips(regenClips);
              }
              regenOk = true;
            } catch (regenErr) {
              // Regeneration failed — restore original clips from backup so the run
              // stays in a usable state rather than losing all flagged clips.
              console.warn(`[Audio QA] Regeneration failed: ${regenErr.message}`);
              console.warn('[Audio QA] Restoring original clips from backup...');
              for (const f of fs.readdirSync(backupDir)) {
                try {
                  fs.copyFileSync(path.join(backupDir, f), path.join(audioDir, f));
                  console.log(`  [Audio QA] Restored ${f}`);
                } catch (_) {}
              }
              // Re-stitch voiceover with restored clips so downstream stages work.
              try {
                execSync('node scripts/resync-audio.js', {
                  stdio: 'inherit',
                  cwd: PROJECT_ROOT,
                  env:  { ...process.env, PIPELINE_RUN_DIR: versionedDir },
                });
              } catch (_) {}
            }

            // Clean up backup dir (keep on failure to aid manual inspection)
            if (regenOk) {
              try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (_) {}
            } else {
              console.warn(`[Audio QA] Backup retained at ${backupDir} for manual inspection.`);
            }

            assertNarrationSyncOrThrow(versionedDir, 'post-audio-qa-regeneration');
            console.log('[Audio QA] Regeneration complete.');
          } else {
            console.log('[Audio QA] Per-clip stutter/freeze check: all clips clean.');
          }
        }

        // ── Overall voiceover quality checks ──────────────────────────────────
        overallResult = checkAudioQuality(versionedDir);
      } finally {
        // Always write the report — even when regeneration throws — so the pipeline
        // leaves an audit trail of what was detected.
        const { passed, issues } = overallResult;
        try {
          fs.writeFileSync(
            path.join(versionedDir, 'audio-qa-report.json'),
            JSON.stringify({
              passed,
              issues: issues || [],
              stutteredClips: stutteredClips.map(s => ({ id: s.clip.id, type: s.type, count: s.count, maxDurS: s.maxDur })),
              thresholds: { noiseDb: NOISE_DB, minSilenceS: MIN_SILENCE_S, freezeS: FREEZE_S, stutterMinCount: STUTTER_MIN_COUNT },
              checkedAt: new Date().toISOString(),
            }, null, 2)
          );
        } catch (_) {}
      }

      const { passed, issues } = overallResult;
      const durationIssues = (issues || []).filter(i =>
        i.includes('longer than the video') || i.includes('50% longer')
      );
      const clippingIssues = (issues || []).filter(i => i.includes('clipping') || i.includes('truncated'));

      if ((issues || []).length > 0) {
        console.warn('[Audio QA] Overall issues found:');
        for (const issue of issues) console.warn(`  ⚠ ${issue}`);
      }

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

      // Build Remotion input props from pipeline artifacts. Written for BOTH
      // engines: it is the single source of truth for syncMap (incl. Plaid
      // min-duration freeze injection) + scratchDurationFrames, consumed by
      // render-moviepy AND by the dashboard/Studio rebuild-props endpoint.
      const remotionProps = buildRemotionProps();
      const propsFile = path.join(versionedDir, 'remotion-props.json');
      fs.writeFileSync(propsFile, JSON.stringify(remotionProps, null, 2));
      console.log('[Render] Generated remotion-props.json');

      const outFile = path.join(versionedDir, 'demo-scratch.mp4');

      // ── Engine dispatch (2026-06-11) ─────────────────────────────────────
      // 'moviepy' decodes recording-processed.webm directly and encodes once
      // with explicit x264 quality (CRF 16 / preset slow / 2880x1800@30) —
      // no Remotion JPEG-screenshot re-render generation. Initial build is
      // effect-less (sync-map retime + voiceover only; pointer overlays
      // deferred per user decision). Resolution: env > run-manifest > default.
      const renderEngineExplicit = (process.env.RENDER_ENGINE || '').trim().toLowerCase();
      const manifestEngine = (() => {
        try { return String((readRunManifest(versionedDir) || {}).renderEngine || '').trim().toLowerCase(); }
        catch (_) { return ''; }
      })();
      // Default flipped to moviepy 2026-06-11 after A/B validation on KeyBank
      // v2: SSIM vs source ≥ Remotion on 5/5 sampled windows (0.998+ vs
      // 0.887–0.998 — Remotion's JPEG-screenshot re-render measurably degrades
      // speed-1 footage), identical 2880×1800@30 output, 4.3× faster
      // (94.5s vs 409s). Remotion remains the automatic fallback on engine
      // failure and selectable via RENDER_ENGINE=remotion.
      const renderEngine = renderEngineExplicit || manifestEngine || 'moviepy';
      const renderViaRemotion = () => {
        execSync(
          `npx remotion render remotion/index.js DemoScratch "${outFile}" --props="${propsFile}" --timeout=120000 --log=warn`,
          { stdio: 'inherit', cwd: PROJECT_ROOT }
        );
      };
      if (renderEngine === 'moviepy') {
        console.log('[Render] Engine: moviepy (vidmagik MCP) — effect-less composition, x264 CRF16');
        try {
          // Fresh require so engine fixes don't need an orchestrator restart.
          delete require.cache[require.resolve('./render-moviepy')];
          const { main: renderMoviepy } = require('./render-moviepy');
          await renderMoviepy({ runDir: versionedDir, outFile });
        } catch (err) {
          if (renderEngineExplicit) throw err; // explicitly requested — surface the failure
          console.error(`[Render] ⚠ moviepy engine failed (${err.message}) — falling back to Remotion.`);
          renderViaRemotion();
        }
      } else {
        console.log('[Render] Engine: remotion');
        renderViaRemotion();
      }
    }, timer);

    // ── POST-EDIT DETECTION (non-halting): Plaid Link present in FINAL video ──
    // Last-line confirmation that the modal survived recording + cut + render.
    // Vision-samples the launch window of demo-scratch.mp4. WARNS + records for
    // an agent/human to patch (re-render / re-cut) — does NOT halt (the
    // record-step modal-missing gate is the only hard halt).
    try {
      const { checkPlaidLinkIntegrity } = require('./utils/plaid-link-integrity');
      const integ = await checkPlaidLinkIntegrity(versionedDir, { phase: 'final-video' });
      const v = (integ.violations || []).filter(x => x.kind === 'final-video-no-modal');
      if (v.length) {
        cliWarn(`[plaid-link] Final video is MISSING the Plaid modal in launch window(s): ${v.map(x => x.stepId).join(', ')}.`);
        cliLog('[plaid-link]   Patchable: investigate the recording/cut, then re-render (or re-record). See plaid-link-integrity.json.');
      } else if (!integ.skipped) {
        cliLog('[plaid-link] Final-video check: Plaid modal present in launch window(s). ✓');
      }
    } catch (e) {
      cliWarn(`[plaid-link] final-video integrity check error (non-fatal): ${e.message}`);
    }
  }

  // Stage: scene-match-check — multimodal validator. Extracts frames from the
  // freshly-rendered demo-scratch.mp4 at each narration segment's window and
  // asks Claude Haiku 4.5 Vision whether the frame depicts what the narration
  // says at that moment. Writes scene-match-report.json. Default mode is
  // advisory (proceed past failures). SCENE_MATCH_GATE=strict makes it block
  // the downstream stages so a repair loop can re-record / repace.
  if (shouldRun('scene-match-check')) {
    await runStage('scene-match-check', async () => {
      delete require.cache[require.resolve('./scratch/scene-match-check.js')];
      const { main: runSceneMatch } = require('./scratch/scene-match-check.js');
      try {
        await runSceneMatch(versionedDir);
      } catch (err) {
        if (err && err.code === 'SCENE_MATCH_FAILED' && (process.env.SCENE_MATCH_GATE || '').toLowerCase() === 'strict') {
          throw err;
        }
        console.warn(`[scene-match-check] non-fatal: ${err.message}`);
      }
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
  const {
    mode: cliMode,
    fromStage,
    toStage,
    runId: explicitRunId,
    noTouchup,
    recordMode,
    qaThreshold: qaThresholdOverride,
    maxRefinementIterations: maxRefinementIterationsOverride,
    buildFixMode: buildFixModeOverride,
  } = parseArgs();
  let effectiveFromStage = fromStage;

  // Repo freshness: on a brand-new build (no --from / --run-id) auto-pull a stale
  // clone before doing any work, so `npm run demo` builds on the latest templates
  // and fixes. Safe fast-forward only; asks (interactive TTY) or warns (agent /
  // non-interactive) when a pull is risky; never blocks the build. Skipped when
  // `pipe new` already ran it (PIPE_FRESHNESS_CHECKED) or PIPE_SKIP_FRESHNESS=true.
  if (!fromStage && !explicitRunId) {
    try {
      await require('./utils/repo-freshness').ensureRepoFreshForBuild({});
    } catch (_) { /* never block a build on the freshness check */ }
  }

  if (qaThresholdOverride != null && (!Number.isInteger(qaThresholdOverride) || qaThresholdOverride <= 0)) {
    cliError(`[Orchestrator] Invalid --qa-threshold="${qaThresholdOverride}". Must be a positive integer.`);
    process.exit(1);
  }
  if (
    maxRefinementIterationsOverride != null &&
    (!Number.isInteger(maxRefinementIterationsOverride) || maxRefinementIterationsOverride <= 0)
  ) {
    cliError(
      `[Orchestrator] Invalid --max-refinement-iterations="${maxRefinementIterationsOverride}". Must be a positive integer.`
    );
    process.exit(1);
  }
  if (buildFixModeOverride && !VALID_BUILD_FIX_MODES.has(buildFixModeOverride)) {
    cliError(
      `[Orchestrator] Invalid --build-fix-mode="${buildFixModeOverride}". Must be one of: ${Array.from(VALID_BUILD_FIX_MODES).join(', ')}.`
    );
    process.exit(1);
  }

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

  const skipEnvCheck =
    process.env.PIPELINE_SKIP_ENV_CHECK === 'true' ||
    process.env.PIPELINE_SKIP_ENV_CHECK === '1';
  if (!skipEnvCheck) {
    const { validatePipelineEnv, printValidationReport } = require('./utils/validate-pipeline-env');
    const skipLivePing =
      process.env.PIPELINE_SKIP_ENV_LIVE_CHECK === 'true' ||
      process.env.PIPELINE_SKIP_ENV_LIVE_CHECK === '1';
    const envResult = await validatePipelineEnv({
      projectRoot: PROJECT_ROOT,
      skipLiveCheck: skipLivePing,
    });
    printValidationReport(envResult, {
      log: msg => cliLog(msg),
      warn: msg => cliWarn(msg),
      error: msg => cliError(msg),
    });
    if (!envResult.ok) {
      cliError(
        '[Orchestrator] Environment validation failed — fix the issues above, request `.env` keys from the repository owner if needed, or set PIPELINE_SKIP_ENV_CHECK=1 to bypass (not recommended).'
      );
      process.exit(64);
    }
  }

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
  writePipelinePidFile(versionedDir);

  // Resolve the unified build mode (app-only vs app+slides) once at run start
  // so every downstream stage and the run manifest agree on a single value.
  // For restarts (--from), if the existing run-manifest already has buildMode
  // and no explicit override was supplied, inherit it so refinement iterations
  // never silently flip mode mid-run.
  const existingManifestForMode = (() => {
    try {
      const f = path.join(versionedDir, 'run-manifest.json');
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (_) {}
    return null;
  })();
  // "Explicit" means the operator on THIS invocation either passed --with-slides
  // / --app-only on the CLI or the dashboard injected a runtime override. A
  // PIPELINE_WITH_SLIDES value loaded from .env or the shell environment is NOT
  // explicit enough to overwrite a prior run's manifest — that scenario produces
  // silent mode flips on every resume, which has burned us before.
  const _modeSourceTag = String(process.env.PIPELINE_WITH_SLIDES_SOURCE || '').trim().toLowerCase();
  const _modeFromAuthoritativeOverride =
    _modeSourceTag.startsWith('cli') || _modeSourceTag === 'dashboard';
  const explicitWithSlidesProvided =
    process.env.PIPELINE_WITH_SLIDES != null &&
    String(process.env.PIPELINE_WITH_SLIDES).trim() !== '' &&
    _modeFromAuthoritativeOverride;
  if (
    existingManifestForMode &&
    typeof existingManifestForMode.buildMode === 'string' &&
    !explicitWithSlidesProvided
  ) {
    const inheritedWithSlides = existingManifestForMode.buildMode === 'app+slides';
    const previousValue = String(process.env.PIPELINE_WITH_SLIDES || '').trim().toLowerCase();
    const previousMatches = previousValue === (inheritedWithSlides ? 'true' : 'false');
    process.env.PIPELINE_WITH_SLIDES = inheritedWithSlides ? 'true' : 'false';
    process.env.PIPELINE_WITH_SLIDES_SOURCE = 'inherited from run-manifest';
    if (!previousMatches && previousValue) {
      cliLog(
        `[Orchestrator] Inherited buildMode=${existingManifestForMode.buildMode} from run-manifest ` +
        `(overrode .env/shell PIPELINE_WITH_SLIDES=${previousValue}). ` +
        `Pass --with-slides or --app-only on the CLI to override.`
      );
    }
  }
  // Panels axis restart-inheritance (mirrors slides above): on resume without
  // an explicit --with-panels/--no-panels (or dashboard) override, inherit the
  // prior run's buildModes.withPanels so a `pipe continue` never silently flips
  // panels back on.
  const _panelsSourceTag = String(process.env.PIPELINE_WITH_PANELS_SOURCE || '').trim().toLowerCase();
  const _panelsFromAuthoritativeOverride =
    _panelsSourceTag.startsWith('cli') || _panelsSourceTag === 'dashboard';
  const explicitWithPanelsProvided =
    process.env.PIPELINE_WITH_PANELS != null &&
    String(process.env.PIPELINE_WITH_PANELS).trim() !== '' &&
    _panelsFromAuthoritativeOverride;
  if (
    existingManifestForMode &&
    existingManifestForMode.buildModes &&
    typeof existingManifestForMode.buildModes.withPanels === 'boolean' &&
    !explicitWithPanelsProvided
  ) {
    process.env.PIPELINE_WITH_PANELS = existingManifestForMode.buildModes.withPanels ? 'true' : 'false';
    process.env.PIPELINE_WITH_PANELS_SOURCE = 'inherited from run-manifest';
  }

  const buildModeInfo = resolveBuildMode();
  cliLog(`[Orchestrator] Mode: ${buildModeInfo.label}  (source: ${buildModeInfo.source}, panels: ${buildModeInfo.panelsSource})`);

  const runManifest = ensureRunManifest(versionedDir, {
    runId: path.basename(versionedDir),
    mode,
    runNameStem,
    promptFingerprint,
    sourcePromptFile: path.join(INPUTS_DIR, 'prompt.txt'),
    sourcePromptHash: promptFingerprint || null,
    buildMode: buildModeInfo.withSlides ? 'app+slides' : 'app-only',
    buildModeSource: buildModeInfo.source,
    buildModes: { withSlides: buildModeInfo.withSlides, withPanels: buildModeInfo.withPanels },
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

  // ── Auto-detect first-incomplete stage on resume ────────────────────────
  // When the operator invokes a resume against an existing run-id but does
  // NOT pass --from, fall back to the first incomplete canonical stage
  // (computed from stage-state). This avoids the common foot-gun of
  // re-running long stages like `research` (200+ seconds, $$$) on a run
  // that already has them completed.
  //
  // Only applies when:
  //   - effectiveFromStage is not set (no --from)
  //   - We targeted an explicit run-id or PIPELINE_RUN_DIR
  //   - The run dir already has at least one completed stage sentinel
  //   - We're NOT in fresh-cleanup mode (autoFresh / first-use prompt)
  if (!effectiveFromStage && (explicitRunId || process.env.PIPELINE_RUN_DIR) && !autoFresh) {
    try {
      const { computeStageList } = require('./utils/stage-state');
      const { stages, firstPending } = computeStageList(versionedDir);
      const anyCompleted = stages.some((s) => s.status === 'completed');
      if (anyCompleted && firstPending) {
        cliLog(
          `[Orchestrator] Resuming known run with no --from; auto-starting at first pending stage: ${firstPending}.`
        );
        cliLog(
          `[Orchestrator]   Pass --from=research (or any earlier stage) to override; ` +
          `set PIPELINE_FRESH_CLEANUP=1 to wipe artifacts and run from start.`
        );
        effectiveFromStage = firstPending;
      }
    } catch (err) {
      cliWarn(`[Orchestrator] First-pending auto-detect failed: ${err && err.message || err}`);
    }
  }

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
  emitPipeEvent('pipeline_start', {
    mode,
    buildMode: buildModeInfo.withSlides ? 'app+slides' : 'app-only',
    stages: stagePlan.join(','),
    fromStage: effectiveFromStage || stagePlan[0] || null,
    toStage: endIdx == null ? null : STAGES[endIdx],
  });
  appendPipelineLogSection('[RUN] Stage plan', [
    `mode=${mode}`,
    `fromIndex=${startIdx}`,
    `toIndex=${endIdx == null ? 'end' : endIdx}`,
    `stages=${stagePlan.join(' -> ')}`,
  ], { runDir: versionedDir });
  console.log('');

  // Ensure run directory exists
  fs.mkdirSync(versionedDir, { recursive: true });

  const { acquirePipelineLock } = require('./utils/pipeline-lock');
  const lockResult = acquirePipelineLock(versionedDir, {
    force: parseBoolEnv(process.env.PIPELINE_FORCE, false),
    log: cliLog,
  });
  if (!lockResult.acquired) {
    cliError(
      `[Orchestrator] Run directory is locked by another orchestrator (pid=${lockResult.previousPid ?? '?'}). ` +
      'Wait for it to finish, use `npm run pipe -- stop <RUN_ID>`, or set PIPELINE_FORCE=1 if the process is gone.'
    );
    process.exit(4);
  }

  // Periodic mid-stage heartbeat (default 5 min). Independent of stage completion.
  startOrchestratorHeartbeat(versionedDir);

  // Dispatch to the correct pipeline
  const pipelineArgs = {
    startIdx,
    endIdx,
    noTouchup,
    versionedDir,
    promptText,
    timer,
    recordMode,
    qaThresholdOverride,
    maxRefinementIterationsOverride,
    buildFixModeOverride,
    effectiveFromStage,
  };

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
  emitPipeEvent('pipeline_end', {
    status: 'ok',
    totalSec: total,
    outputDir: versionedDir,
  });
  appendPipelineLogSection('[RUN] Pipeline complete', [
    `at=${doneTs}`,
    `totalSeconds=${total}`,
    `outputDir=${versionedDir}`,
  ], { runDir: versionedDir });
}

// Only auto-run when invoked as a script (not when required by unit tests).
// `require.main === module` is the canonical Node idiom for this; previously
// every `require('orchestrator')` (including from tests) would kick off the
// whole pipeline.
if (require.main === module) {
  main().then(() => {
    // Force a clean exit after a successful run. On success main() resolves but
    // Node only exits when the event loop drains — a lingering handle (the
    // heartbeat interval, an app-server socket from build-qa, etc.) otherwise
    // keeps the orchestrator alive as an idle zombie (observed running ~5h and
    // causing `resume` to target the wrong run). Cleanup stops the heartbeat +
    // releases the lock; exit(0) guarantees termination at the --to stage.
    orchestratorCleanup();
    process.exit(0);
  }).catch(err => {
    cliError(`[Orchestrator] Fatal error: ${err.message}`);
    emitPipeEvent('pipeline_end', { status: 'failed', message: err.message });
    if (err.stack) console.error(err.stack);
    orchestratorCleanup();
    process.exit(1);
  });
}

module.exports = {
  main,
  // Exposed for unit tests of the agent-driven refinement loop:
  isAgentContext,
  analyzeFixModeForQaIteration,
  VALID_BUILD_FIX_MODES,
};
