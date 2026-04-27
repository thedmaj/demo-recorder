#!/usr/bin/env node
/**
 * bin/pipe.js
 * Hybrid CLI driver for the Plaid Demo Pipeline.
 *
 * Humans get an arrow-key-free numeric menu; Claude (in Cursor) gets
 * flag-driven subcommands plus structured JSON/events.
 *
 * Sub-commands:
 *   pipe                              interactive menu
 *   pipe new        [--prompt=PATH] [--with-slides|--app-only]
 *                   [--research=gapfill|deep] [--to=STAGE] [--qa-threshold=N]
 *                   [--max-refinement-iterations=N] [--build-fix-mode=MODE]
 *                   [--no-touchup]
 *   pipe resume     [RUN_ID] [--from=STAGE] [--to=STAGE] [--override-with-slides]
 *   pipe stage      STAGE [RUN_ID]
 *   pipe status     [RUN_ID] [--json]
 *   pipe logs       [RUN_ID] [--follow] [--since=STAGE]
 *   pipe stop       [RUN_ID] [--force]
 *   pipe list       [--limit=N] [--json]
 *   pipe continue   [RUN_ID]
 *   pipe open       [RUN_ID]
 *   pipe help
 *
 * Global flags: --json  --non-interactive
 *
 * Exit codes:
 *   0 ok    2 pipeline error    3 user-cancelled
 *   4 already running           5 awaiting human continue (non-interactive)
 *   64 usage error
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const INPUTS_DIR = path.join(PROJECT_ROOT, 'inputs');
const OUT_DIR = path.join(PROJECT_ROOT, 'out');
const DEMOS_DIR = path.join(OUT_DIR, 'demos');
const LATEST_MARKER = path.join(OUT_DIR, 'latest', '.rundir');
const ORCHESTRATOR = path.join(PROJECT_ROOT, 'scripts', 'scratch', 'orchestrator.js');

const stageState = require(path.join(PROJECT_ROOT, 'scripts', 'scratch', 'utils', 'stage-state.js'));
const { STAGES, computeStatus } = stageState;

const VALID_RESEARCH = new Set(['gapfill', 'broad', 'deep']);

// Two vocabularies in play here:
//   - User-friendly (this CLI, README, dashboard): smart | rebuild | patch | agent-touchup
//   - Orchestrator native (scripts/scratch/orchestrator.js): auto | fullbuild | touchup | agent-touchup
// The orchestrator only validates the native names, so prior to this fix
// `npm run pipe -- new --build-fix-mode=smart` would actually fail the
// orchestrator's `VALID_BUILD_FIX_MODES` check at startup. Both sets are
// accepted here; `translateBuildFixMode` normalizes to native before
// forwarding the flag downstream.
//
// `agent-touchup` is the NEW DEFAULT when running under an AI agent (Claude
// Code / Cursor) — see `isAgentContext()` in orchestrator.js. In that mode
// the orchestrator pauses on a continue-gate after each failed build-qa and
// hands the agent a per-step task .md; the agent makes surgical StrReplace
// edits and resumes the orchestrator. NO LLM rebuilds happen on refinement
// passes. The orchestrator picks this automatically when BUILD_FIX_MODE=auto
// and an agent context is detected; users can opt out with
// `--build-fix-mode=touchup` (legacy LLM regen) or `--build-fix-mode=fullbuild`.
const BUILD_FIX_MODE_ALIASES = {
  smart:            'auto',
  rebuild:          'fullbuild',
  patch:            'touchup',
  auto:             'auto',
  fullbuild:        'fullbuild',
  touchup:          'touchup',
  'agent-touchup':  'agent-touchup',
  'agent':          'agent-touchup',
};
const VALID_BUILD_FIX_MODES = new Set(Object.keys(BUILD_FIX_MODE_ALIASES));

function translateBuildFixMode(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  const native = BUILD_FIX_MODE_ALIASES[v];
  if (!native) {
    console.warn(c.yellow(
      `[pipe] WARNING: --build-fix-mode="${value}" is not a recognized value. ` +
      `Forwarding as-is; the orchestrator may reject it. ` +
      `Valid values: ${[...VALID_BUILD_FIX_MODES].join(', ')}.`
    ));
    return v;
  }
  return native;
}

// ── Color helpers (no deps) ──────────────────────────────────────────────────
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  bold:  s => USE_COLOR ? `\x1b[1m${s}\x1b[0m` : s,
  dim:   s => USE_COLOR ? `\x1b[2m${s}\x1b[0m` : s,
  red:   s => USE_COLOR ? `\x1b[31m${s}\x1b[0m` : s,
  green: s => USE_COLOR ? `\x1b[32m${s}\x1b[0m` : s,
  yellow:s => USE_COLOR ? `\x1b[33m${s}\x1b[0m` : s,
  cyan:  s => USE_COLOR ? `\x1b[36m${s}\x1b[0m` : s,
};

// ── Arg parsing ──────────────────────────────────────────────────────────────
function parseArgv(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = true;
    } else {
      positional.push(a);
    }
  }
  const command = positional.shift() || null;
  return { command, positional, flags };
}

// ── Run-dir helpers ──────────────────────────────────────────────────────────
function readLatestRunDir() {
  // 1. out/latest/.rundir (written by orchestrator through the symlink)
  try {
    const raw = fs.readFileSync(LATEST_MARKER, 'utf8').trim();
    if (raw && fs.existsSync(raw)) return raw;
  } catch (_) { /* ignore */ }
  // 2. out/latest itself is a symlink to the run dir
  try {
    const linkTarget = fs.readlinkSync(path.join(OUT_DIR, 'latest'));
    const resolved = path.isAbsolute(linkTarget) ? linkTarget : path.resolve(OUT_DIR, linkTarget);
    if (fs.existsSync(resolved)) return resolved;
  } catch (_) { /* ignore */ }
  // 3. fall back to most-recently-modified dir under out/demos/
  const runs = listRunDirs();
  return runs.length ? runs[0].runDir : null;
}

function runDirFromId(runId) {
  const resolved = path.resolve(DEMOS_DIR, runId);
  if (!resolved.startsWith(DEMOS_DIR + path.sep)) {
    throw new Error(`Invalid runId "${runId}" — escapes demos directory`);
  }
  return resolved;
}

function resolveRunDir(runIdOrNull) {
  if (runIdOrNull) {
    const d = runDirFromId(runIdOrNull);
    if (!fs.existsSync(d)) throw new Error(`Run not found: ${runIdOrNull}`);
    return d;
  }
  const latest = readLatestRunDir();
  if (!latest) throw new Error('No latest run — pass a RUN_ID or start one with `pipe new`.');
  return latest;
}

function listRunDirs() {
  try {
    return fs.readdirSync(DEMOS_DIR)
      .map(name => ({ runId: name, runDir: path.join(DEMOS_DIR, name) }))
      .filter(e => {
        try { return fs.statSync(e.runDir).isDirectory(); } catch (_) { return false; }
      })
      .sort((a, b) => {
        const sa = fs.statSync(a.runDir).mtimeMs;
        const sb = fs.statSync(b.runDir).mtimeMs;
        return sb - sa;
      });
  } catch (_) {
    return [];
  }
}

function formatDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '';
  const s = Math.round(Number(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toString().padStart(2, '0')}s`;
}

// ── Active-orchestrator detection ────────────────────────────────────────────
function findActiveRun() {
  for (const entry of listRunDirs()) {
    try {
      const status = computeStatus(entry.runDir);
      if (status.activePid) return { ...entry, status };
    } catch (_) { /* ignore */ }
  }
  return null;
}

// ── Spawning the orchestrator ────────────────────────────────────────────────
/**
 * Spawn orchestrator and stream output. In JSON mode we parse ::PIPE:: lines
 * and re-emit them as newline-delimited JSON on stdout, while the underlying
 * human-readable log goes to stderr. In human mode we inherit stdio so the
 * user sees the orchestrator output unchanged.
 */
function spawnOrchestrator(orchestratorArgs, opts = {}) {
  const { env = {}, json = false } = opts;
  const fullEnv = { ...process.env, ...env };

  if (!json) {
    const child = spawn(process.execPath, [ORCHESTRATOR, ...orchestratorArgs], {
      cwd: PROJECT_ROOT,
      env: fullEnv,
      stdio: 'inherit',
    });
    return new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code: code == null ? (signal ? 143 : 1) : code }));
    });
  }

  // JSON mode: pipe stdout + stderr, emit event lines on stdout, mirror human log on stderr.
  const child = spawn(process.execPath, [ORCHESTRATOR, ...orchestratorArgs], {
    cwd: PROJECT_ROOT,
    env: fullEnv,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  const handleLine = (line) => {
    const evt = parsePipeEvent(line);
    if (evt) process.stdout.write(JSON.stringify(evt) + '\n');
    else process.stderr.write(line + '\n');
  };
  splitLines(child.stdout, handleLine);
  splitLines(child.stderr, (line) => process.stderr.write(line + '\n'));

  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code: code == null ? (signal ? 143 : 1) : code });
    });
  });
}

function splitLines(stream, onLine) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      onLine(line);
    }
  });
  stream.on('end', () => {
    if (buf.length) onLine(buf);
  });
}

function parsePipeEvent(line) {
  const marker = '::PIPE:: ';
  const i = line.indexOf(marker);
  if (i < 0) return null;
  const body = line.slice(i + marker.length);
  const out = { _raw: line.slice(i) };
  // Parse key=value pairs, supporting quoted values.
  const re = /(\w+)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const key = m[1];
    const val = m[2] != null ? m[2].replace(/\\(.)/g, '$1') : m[3];
    out[key] = val;
  }
  return out;
}

// ── Command: status ──────────────────────────────────────────────────────────
function cmdStatus({ positional, flags }) {
  const runDir = resolveRunDir(positional[0] || null);
  const status = computeStatus(runDir);
  if (flags.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    return 0;
  }
  const bar = '─'.repeat(60);
  console.log(bar);
  console.log(c.bold(`Run: ${status.runId}`));
  console.log(c.dim(`Dir: ${status.runDir}`));
  const modeLbl = status.buildMode || '(unset)';
  const pidLbl = status.activePid ? c.green(`PID ${status.activePid} active`) : c.dim('not running');
  console.log(`Mode: ${status.mode || '-'} · Build: ${modeLbl} · ${pidLbl}`);
  if (status.runningStage) console.log(`Running: ${c.cyan(status.runningStage)}`);
  if (status.awaitingContinue) {
    console.log(c.yellow(`⚑ Awaiting continue — run: npm run pipe -- continue ${status.runId}`));
    if (status.continueContext && status.continueContext.message) {
      console.log(c.dim(`  reason: ${status.continueContext.message}`));
    }
  }
  console.log(bar);
  const width = Math.max(...STAGES.map(s => s.length));
  for (const s of status.stages) {
    const name = s.name.padEnd(width);
    let icon, col;
    switch (s.status) {
      case 'completed': icon = '✓'; col = c.green; break;
      case 'running':   icon = '…'; col = c.cyan; break;
      case 'failed':    icon = '✗'; col = c.red; break;
      default:          icon = '·'; col = c.dim; break;
    }
    let line = `${col(icon)} ${name}  ${col(s.status)}`;
    if (s.durationSec != null) line += c.dim(`  (${formatDuration(s.durationSec)})`);
    if (s.lastError) line += c.red(`  — ${s.lastError}`);
    console.log(line);
  }
  console.log(bar);
  const { completed, total, failed, pending, running } = status.counts;
  console.log(`Stages: ${c.green(completed + '/' + total + ' done')}` +
    (running ? ` · ${c.cyan(running + ' running')}` : '') +
    (failed  ? ` · ${c.red(failed + ' failed')}` : '') +
    (pending ? ` · ${c.dim(pending + ' pending')}` : ''));
  if (status.nextRecoveryCommand) {
    console.log(c.dim('Next:'), status.nextRecoveryCommand);
  }
  return 0;
}

// ── Command: list ────────────────────────────────────────────────────────────
function cmdList({ flags }) {
  const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 10;
  const rows = listRunDirs().slice(0, limit).map(({ runId, runDir }) => {
    try {
      const status = computeStatus(runDir);
      return {
        runId,
        mode: status.mode,
        buildMode: status.buildMode,
        completed: status.counts.completed,
        total: status.counts.total,
        failed: status.counts.failed,
        running: !!status.activePid,
        awaitingContinue: status.awaitingContinue,
        lastStage: status.runningStage || status.firstFailed || status.firstPending,
        updatedAt: status.updatedAt,
      };
    } catch (_) {
      return { runId, error: true };
    }
  });
  if (flags.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  if (!rows.length) {
    console.log('No runs in out/demos/');
    return 0;
  }
  console.log(c.bold('Recent runs:'));
  for (const r of rows) {
    if (r.error) { console.log(c.dim(r.runId + ' (unreadable)')); continue; }
    const state = r.running
      ? c.cyan('●running')
      : r.failed
      ? c.red('✗' + r.failed)
      : r.completed === r.total
      ? c.green('✓done')
      : c.dim(`${r.completed}/${r.total}`);
    const cont = r.awaitingContinue ? c.yellow(' ⚑awaiting') : '';
    console.log(`  ${state}${cont}  ${r.runId}  ${c.dim(r.lastStage || '')}`);
  }
  return 0;
}

// ── Command: logs ────────────────────────────────────────────────────────────
function cmdLogs({ positional, flags }) {
  const runDir = resolveRunDir(positional[0] || null);
  const logFile = path.join(runDir, 'artifacts', 'logs', 'pipeline-build.log.md');
  if (!fs.existsSync(logFile)) {
    console.error(`No log file: ${logFile}`);
    return 2;
  }
  if (!flags.follow) {
    process.stdout.write(fs.readFileSync(logFile, 'utf8'));
    return 0;
  }
  // Tail -f semantics
  let offset = 0;
  try { offset = fs.statSync(logFile).size; } catch (_) { /* ignore */ }
  // Print last ~40 lines first
  const initial = fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n');
  process.stdout.write(initial + '\n');
  const watcher = fs.watch(logFile, { persistent: true }, () => {
    try {
      const size = fs.statSync(logFile).size;
      if (size < offset) offset = 0;
      if (size > offset) {
        const fd = fs.openSync(logFile, 'r');
        const len = size - offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        fs.closeSync(fd);
        process.stdout.write(buf.toString('utf8'));
        offset = size;
      }
    } catch (_) { /* ignore transient errors */ }
  });
  return new Promise(() => { /* block indefinitely until Ctrl-C */
    process.on('SIGINT', () => { watcher.close(); process.exit(0); });
  });
}

// ── Command: continue ────────────────────────────────────────────────────────
function cmdContinue({ positional }) {
  const runDir = resolveRunDir(positional[0] || null);
  const signal = path.join(runDir, 'continue.signal');
  fs.writeFileSync(signal, 'continue\n', 'utf8');
  console.log(c.green(`✓ Wrote continue signal → ${signal}`));
  return 0;
}

// ── Command: stop ────────────────────────────────────────────────────────────
function cmdStop({ positional, flags }) {
  const runDir = resolveRunDir(positional[0] || null);
  const status = computeStatus(runDir);
  if (!status.activePid) {
    console.log(c.dim('No active orchestrator for ' + status.runId));
    return 0;
  }
  const signal = flags.force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(status.activePid, signal);
    console.log(c.yellow(`Sent ${signal} to PID ${status.activePid} (${status.runId})`));
    return 0;
  } catch (err) {
    console.error(c.red(`Could not signal PID ${status.activePid}: ${err.message}`));
    return 2;
  }
}

// ── Command: new ─────────────────────────────────────────────────────────────
async function cmdNew({ flags }) {
  if (flags.prompt && typeof flags.prompt === 'string') {
    const src = path.resolve(flags.prompt);
    if (!fs.existsSync(src)) throw new Error(`--prompt not found: ${src}`);
    fs.mkdirSync(INPUTS_DIR, { recursive: true });
    const dest = path.join(INPUTS_DIR, 'prompt.txt');
    fs.copyFileSync(src, dest);
    console.log(c.dim(`Copied prompt → ${dest}`));
  }
  const promptFile = path.join(INPUTS_DIR, 'prompt.txt');
  if (!fs.existsSync(promptFile)) throw new Error('No inputs/prompt.txt — pass --prompt=PATH or create it first.');

  const args = [];
  if (flags['with-slides']) args.push('--with-slides');
  if (flags['app-only']) args.push('--app-only');
  if (flags.to)  args.push(`--to=${flags.to}`);
  if (flags['qa-threshold']) args.push(`--qa-threshold=${flags['qa-threshold']}`);
  if (flags['max-refinement-iterations']) args.push(`--max-refinement-iterations=${flags['max-refinement-iterations']}`);
  if (flags['build-fix-mode']) {
    const translated = translateBuildFixMode(flags['build-fix-mode']);
    args.push(`--build-fix-mode=${translated}`);
  }
  if (flags['no-touchup']) args.push('--no-touchup');
  if (flags.mode) args.push(`--mode=${flags.mode}`);

  const env = {};
  if (flags.research) {
    if (!VALID_RESEARCH.has(String(flags.research).toLowerCase())) {
      throw new Error(`--research must be one of: ${[...VALID_RESEARCH].join(', ')}`);
    }
    env.RESEARCH_MODE = String(flags.research).toLowerCase();
  }
  if (flags['non-interactive']) env.SCRATCH_AUTO_APPROVE = 'true';

  console.log(c.bold('[pipe] starting new pipeline'));
  console.log(c.dim('  prompt: ' + promptFile));
  console.log(c.dim('  args:   ' + (args.join(' ') || '(defaults)')));
  const { code } = await spawnOrchestrator(args, { env, json: !!flags.json });
  return code === 0 ? 0 : 2;
}

// ── Command: resume ──────────────────────────────────────────────────────────
async function cmdResume({ positional, flags }) {
  const runId = positional[0] || path.basename(readLatestRunDir() || '');
  if (!runId) throw new Error('No run to resume — pass RUN_ID.');
  runDirFromId(runId); // validate
  const args = [`--run-id=${runId}`];
  if (flags.from) args.push(`--from=${flags.from}`);
  if (flags.to)   args.push(`--to=${flags.to}`);
  if (flags['with-slides']) args.push('--with-slides');
  if (flags['app-only'])    args.push('--app-only');
  if (flags['qa-threshold']) args.push(`--qa-threshold=${flags['qa-threshold']}`);
  if (flags['max-refinement-iterations']) args.push(`--max-refinement-iterations=${flags['max-refinement-iterations']}`);
  if (flags['build-fix-mode']) {
    const translated = translateBuildFixMode(flags['build-fix-mode']);
    args.push(`--build-fix-mode=${translated}`);
  }
  if (flags['no-touchup']) args.push('--no-touchup');

  const env = { PIPELINE_RUN_DIR: runDirFromId(runId) };
  if (flags['non-interactive']) env.SCRATCH_AUTO_APPROVE = 'true';

  console.log(c.bold(`[pipe] resuming ${runId}`));
  console.log(c.dim('  args: ' + args.join(' ')));
  const { code } = await spawnOrchestrator(args, { env, json: !!flags.json });
  return code === 0 ? 0 : 2;
}

// ── Command: stage (single-stage retry) ──────────────────────────────────────
async function cmdStage({ positional, flags }) {
  const stage = positional[0];
  if (!stage || !STAGES.includes(stage)) {
    throw new Error(`Stage required. Valid: ${STAGES.join(', ')}`);
  }
  const runId = positional[1] || path.basename(readLatestRunDir() || '');
  if (!runId) throw new Error('No run to target — pass RUN_ID.');
  runDirFromId(runId);
  const args = [`--run-id=${runId}`, `--from=${stage}`, `--to=${stage}`];
  const env = { PIPELINE_RUN_DIR: runDirFromId(runId) };
  if (flags['non-interactive']) env.SCRATCH_AUTO_APPROVE = 'true';
  console.log(c.bold(`[pipe] re-running stage "${stage}" on ${runId}`));
  const { code } = await spawnOrchestrator(args, { env, json: !!flags.json });
  return code === 0 ? 0 : 2;
}

// ── Command: post-panels (deterministic panel normalizer) ────────────────────
async function cmdPostPanels({ positional, flags }) {
  const runId = positional[0] || path.basename(readLatestRunDir() || '');
  if (!runId) throw new Error('No run to target — pass RUN_ID.');
  const runDir = runDirFromId(runId);
  const script = path.join(PROJECT_ROOT, 'scripts', 'scratch', 'scratch', 'post-panels.js');
  const args = [script];
  if (flags.steps) args.push(`--steps=${flags.steps}`);
  if (flags['dry-run']) args.push('--dry-run');
  if (flags['llm-fallback']) args.push('--llm-fallback');
  console.log(c.bold(`[pipe] post-panels on ${runId}`));
  const child = spawn('node', args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PIPELINE_RUN_DIR: runDir },
    stdio: 'inherit',
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code === 0 ? 0 : 2));
  });
}

// ── Command: figma-convert (demo → Figma file via plugin-figma-figma MCP) ───
//
// The Figma MCP cannot be invoked from the CLI directly — `use_figma` is an
// agent-side tool that runs inside Cursor's plugin sandbox. So this command
// builds a self-contained, agent-ready prompt (with all the demo context
// embedded) and copies a paste-into-agent recipe to the user's clipboard.
// First-time MCP setup (Cursor plugin install + `mcp_auth` OAuth) is walked
// through inline in the prompt so the agent can drive the user through it.
async function cmdFigmaConvert({ positional, flags }) {
  const runId = positional[0] || path.basename(readLatestRunDir() || '');
  if (!runId) throw new Error('No run to convert — pass RUN_ID.');
  const runDir = runDirFromId(runId);
  const { buildFigmaConversionPrompt } = require(path.join(PROJECT_ROOT, 'scripts', 'scratch', 'utils', 'figma-conversion'));

  console.log(c.bold(`[pipe] figma-convert ${runId}`));
  let result;
  try {
    result = buildFigmaConversionPrompt(runDir, {
      figmaFileUrl: flags['figma-file'] || flags['figma-file-url'] || process.env.FIGMA_FILE_URL,
      figmaTeamId:  flags['figma-team']  || flags['figma-team-id']  || process.env.FIGMA_TEAM_ID,
    });
  } catch (e) {
    console.error(c.red(`  ${e.message}`));
    return 2;
  }
  const promptPath = path.join(runDir, 'figma-conversion-prompt.md');
  fs.writeFileSync(promptPath, result.promptMarkdown, 'utf8');
  console.log(c.green(`  ✓ Wrote ${path.relative(PROJECT_ROOT, promptPath)} (${result.summary.stepCount} step(s), ${result.summary.promptChars.toLocaleString()} chars)`));

  // Best-effort clipboard copy of a SHORT paste-into-agent recipe (not the
  // entire prompt — agent users prefer to open the file rather than paste
  // 30k chars). On macOS we use pbcopy; elsewhere we just print.
  const recipe =
    `Open this file in your AI agent (Cursor OR Claude Code, Agent mode) and run it:\n\n` +
    `  ${promptPath}\n\n` +
    `It builds a Figma file (one frame per demo-script step) using the official figma plugin ` +
    `(figma@claude-plugins-official → use_figma tool, hosted at https://mcp.figma.com/mcp). ` +
    `The first run will trigger a Figma OAuth flow — click Authorize.\n`;
  let clipboardOK = false;
  if (process.platform === 'darwin') {
    try {
      const cp = spawnSync('pbcopy', [], { input: recipe });
      clipboardOK = cp.status === 0;
    } catch (_) {}
  }

  console.log('');
  console.log(c.bold('Next:'));
  console.log(`  1. Open ${c.cyan(path.relative(PROJECT_ROOT, promptPath))} in Cursor ${c.dim('OR')} Claude Code.`);
  console.log(`  2. Switch to ${c.cyan('Agent mode')} (not Ask / read-only) so MCP tools are available.`);
  console.log(`  3. Type "Run this prompt." The agent loads skills + calls use_figma.`);
  console.log(`  4. First-time only: a Figma OAuth dialog opens → click ${c.cyan('Authorize')}.`);
  if (clipboardOK) console.log(c.dim('  (paste-into-agent recipe copied to clipboard)'));
  console.log('');
  console.log(c.bold('First-time Figma MCP setup (same plugin in both clients):'));
  console.log(`  ${c.cyan('Cursor:')}      type ${c.cyan('/add-plugin figma')} in chat`);
  console.log(`               ${c.dim('(or Settings → Plugins → search "Figma" → Install, then restart Cursor)')}`);
  console.log(`  ${c.cyan('Claude Code:')} run ${c.cyan('claude plugin install figma@claude-plugins-official')}`);
  console.log(`               ${c.dim('(or /plugin install figma@claude-plugins-official from inside the chat;')}`);
  console.log(`               ${c.dim(' verify with the /mcp command — "figma" should appear connected)')}`);
  console.log(`  ${c.cyan('Optional:')}    ${c.cyan('export FIGMA_FILE_URL="https://www.figma.com/file/<key>/<name>"')} to target an existing file`);
  if (!result.summary.figmaFileUrl) {
    console.log(c.yellow('  · No FIGMA_FILE_URL set — the agent will create a new file in your default team.'));
  }
  console.log('');
  console.log(c.bold('Pipeline summary:'));
  console.log(`  Run:        ${result.summary.runId}`);
  console.log(`  Brand:      ${result.summary.brand || '(unknown)'}`);
  console.log(`  Steps:      ${result.summary.appSteps} app + ${result.summary.slideSteps} slide = ${result.summary.stepCount} total`);
  console.log(`  Target:     ${result.summary.figmaFileUrl || '(new Figma file)'}`);
  console.log(`  Prompt:     ${path.relative(PROJECT_ROOT, promptPath)}`);
  return 0;
}

// ── Command: qa-touchup (agent-driven surgical fixes from QA findings) ──────
//
// Reads the run's most recent QA report, picks failing steps, extracts the
// `<div data-testid="step-<id>">…</div>` block + Playwright row + frame
// paths for each, and writes an agent-ready task .md the user opens in
// Cursor / Claude Code (Agent mode). The agent edits ONLY the failing
// steps with surgical StrReplace calls and reads the QA frames as images,
// instead of asking the LLM to regenerate the whole `index.html` (which
// is what `--build-fix-mode=touchup` still does today).
//
// On systemic issues (shared chrome, >=3 distinct failing steps, or a
// deterministic-blocker gate), the task .md tells the agent to STOP and
// recommend a fullbuild instead — mirrors `analyzeFixModeForQaIteration`
// in the orchestrator.
async function cmdQaTouchup({ positional, flags }) {
  const runId = positional[0] || path.basename(readLatestRunDir() || '');
  if (!runId) throw new Error('No run to touchup — pass RUN_ID.');
  const runDir = runDirFromId(runId);
  const { buildQaTouchupPrompt } = require(path.join(PROJECT_ROOT, 'scripts', 'scratch', 'utils', 'qa-touchup'));

  console.log(c.bold(`[pipe] qa-touchup ${runId}`));
  let result;
  try {
    result = buildQaTouchupPrompt(runDir, {
      passThreshold: flags['qa-threshold'] ? Number(flags['qa-threshold']) : undefined,
    });
  } catch (e) {
    console.error(c.red(`  ${e.message}`));
    return 2;
  }
  const promptPath = path.join(runDir, 'qa-touchup-task.md');
  fs.writeFileSync(promptPath, result.promptMarkdown, 'utf8');
  const scoreFmt = result.summary.overallScore != null
    ? `${result.summary.overallScore}/${result.summary.passThreshold}`
    : `?/${result.summary.passThreshold}`;
  console.log(c.green(
    `  ✓ Wrote ${path.relative(PROJECT_ROOT, promptPath)} ` +
    `(${result.summary.failingStepCount} failing step(s), score ${scoreFmt}, ${result.summary.promptChars.toLocaleString()} chars)`
  ));

  const recipe =
    `Open this file in your AI agent (Cursor OR Claude Code, Agent mode) and run it:\n\n` +
    `  ${promptPath}\n\n` +
    `It contains the QA findings + per-step HTML/Playwright snippets for ` +
    `${result.summary.failingStepCount} failing step(s). The agent edits surgically; ` +
    `you re-verify with: npm run pipe -- stage build-qa ${runId}\n`;
  let clipboardOK = false;
  if (process.platform === 'darwin') {
    try {
      const cp = spawnSync('pbcopy', [], { input: recipe });
      clipboardOK = cp.status === 0;
    } catch (_) {}
  }

  console.log('');
  if (result.summary.systemic) {
    console.log(c.yellow(c.bold('⚠ Systemic issue detected — the task .md tells the agent to STOP and escalate.')));
    console.log(c.yellow('  Reasons: ' + result.summary.systemicReasons.join(', ')));
    console.log(c.yellow(`  Recommended: npm run pipe -- stage build ${runId}`));
    console.log('');
  }
  console.log(c.bold('Next:'));
  console.log(`  1. Open ${c.cyan(path.relative(PROJECT_ROOT, promptPath))} in Cursor ${c.dim('OR')} Claude Code.`);
  console.log(`  2. Switch to ${c.cyan('Agent mode')} (not Ask / read-only) so Read + StrReplace are available.`);
  console.log(`  3. Type "Run this task." The agent edits only the failing steps.`);
  console.log(`  4. Re-verify: ${c.cyan(`npm run pipe -- stage build-qa ${runId}`)}`);
  if (clipboardOK) console.log(c.dim('  (paste-into-agent recipe copied to clipboard)'));
  console.log('');
  console.log(c.bold('QA summary:'));
  console.log(`  Run:           ${result.summary.runId}`);
  console.log(`  QA report:     ${path.relative(runDir, result.summary.qaReportPath)}`);
  console.log(`  Score:         ${scoreFmt}`);
  console.log(`  Failing steps: ${result.summary.failingStepCount} (${result.summary.distinctFailingSteps} distinct)`);
  console.log(`  Systemic:      ${result.summary.systemic ? c.yellow('yes') : c.green('no')}`);
  console.log(`  HTML:          ${path.relative(PROJECT_ROOT, result.summary.htmlPath)}`);
  console.log(`  Playwright:    ${path.relative(PROJECT_ROOT, result.summary.playwrightPath)}`);
  return 0;
}

// ── Commands: centralized demo-app distribution ─────────────────────────────

const IDENTITY = require(path.join(PROJECT_ROOT, 'scripts', 'scratch', 'utils', 'identity.js'));
const RUN_PACKAGE = require(path.join(PROJECT_ROOT, 'scripts', 'scratch', 'utils', 'run-package.js'));
const DEFAULT_ARTIFACT_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.plaid-demo-apps'
);

function resolveArtifactDir() {
  return (process.env.PLAID_DEMO_APPS_DIR && process.env.PLAID_DEMO_APPS_DIR.trim())
    || DEFAULT_ARTIFACT_DIR;
}

function resolveArtifactRepoUrl() {
  return String(process.env.PLAID_DEMO_APPS_REPO || '').trim();
}

function runGit(args, cwd) {
  return spawnSync('git', args, { cwd, stdio: 'inherit', env: process.env });
}

function cmdWhoami({ flags = {} } = {}) {
  // Honor --refresh so `pipe whoami --refresh` re-queries gh and rewrites cache.
  const refresh = !!(flags && (flags.refresh || flags['re-resolve']));
  const gheHost = IDENTITY.detectGheHostname ? IDENTITY.detectGheHostname() : null;
  const identity = IDENTITY.resolveIdentity({ refresh, hostname: gheHost || undefined });
  const artifactDir = resolveArtifactDir();
  const artifactRepo = resolveArtifactRepoUrl();
  if (!identity) {
    console.log(c.yellow('No identity resolved.'));
    console.log(`  Tried: ~/.plaid-demo-recorder/identity.json → gh api user${gheHost ? ` (--hostname ${gheHost})` : ''} → $PLAID_DEMO_USER`);
    console.log(`  Next:  run ${c.cyan(`gh auth login${gheHost ? ` --hostname ${gheHost}` : ''}`)} or set ${c.cyan('PLAID_DEMO_USER')}.`);
    return 2;
  }
  console.log(c.bold('Identity'));
  console.log(`  Login:  ${c.cyan(identity.login)}`);
  if (identity.name) console.log(`  Name:   ${identity.name}`);
  if (identity.host) console.log(`  Host:   ${identity.host}`);
  else if (gheHost)  console.log(`  Host:   ${gheHost}  ${c.dim('(detected from remote; cache predates host tracking — run `pipe whoami --refresh`)')}`);
  console.log(`  Source: ${identity.source}`);
  console.log(`  Cache:  ${IDENTITY.CACHE_FILE}`);
  console.log('');
  console.log(c.bold('Artifact repository'));
  console.log(`  URL:   ${artifactRepo || c.yellow('(unset — export PLAID_DEMO_APPS_REPO)')}`);
  console.log(`  Clone: ${artifactDir}${fs.existsSync(artifactDir) ? '' : c.yellow(' (not cloned yet — run `pipe pull`)')}`);
  return 0;
}

async function cmdPull() {
  let code = 0;
  console.log(c.bold('[pipe] pull — code repo'));
  const codeResult = runGit(['pull', '--ff-only'], PROJECT_ROOT);
  if (codeResult.status !== 0) {
    console.warn(c.yellow('[pipe] code-repo pull failed (see git output above).'));
    code = 2;
  }
  const artifactDir = resolveArtifactDir();
  const artifactRepo = resolveArtifactRepoUrl();
  console.log(c.bold('[pipe] pull — artifact repo'));
  if (!artifactRepo) {
    console.warn(c.yellow('  PLAID_DEMO_APPS_REPO is unset. Skipping artifact repo sync.'));
    console.log(`  Hint: export PLAID_DEMO_APPS_REPO=git@ghe.plaid.com:plaid/plaid-demo-apps.git`);
    return code;
  }
  if (!fs.existsSync(artifactDir)) {
    console.log(`  Cloning ${artifactRepo} → ${artifactDir}`);
    const cloneResult = runGit(['clone', artifactRepo, artifactDir]);
    return cloneResult.status === 0 ? code : 2;
  }
  // Artifact repo is a passive read-only clone for end-users — they only
  // mutate it via `pipe publish` which works on feature branches. So if a
  // squash merge upstream caused local `main` to diverge, the safe move is
  // to reset hard to origin/main. We only do that when there are no
  // uncommitted local changes (paranoid) and only on `main`.
  const fetchResult = runGit(['fetch', 'origin', 'main'], artifactDir);
  if (fetchResult.status !== 0) {
    console.warn(c.yellow('[pipe] artifact-repo fetch failed (see git output above).'));
    return 2;
  }
  // Best-effort fast-forward first.
  const pullResult = runGit(['pull', '--ff-only'], artifactDir);
  if (pullResult.status === 0) return code;
  // Fast-forward refused (likely diverged after a squash merge upstream).
  // Confirm working tree is clean, then reset to origin/main.
  const statusOut = spawnSync('git', ['status', '--porcelain'], { cwd: artifactDir, encoding: 'utf8' });
  const dirty = String((statusOut && statusOut.stdout) || '').trim().length > 0;
  if (dirty) {
    console.error(c.red(
      '[pipe] artifact repo has local uncommitted changes — refusing to reset.\n' +
      `       cd ${artifactDir} && git status   # inspect, then resolve manually`
    ));
    return 2;
  }
  const branchOut = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: artifactDir, encoding: 'utf8' });
  const currentBranch = String((branchOut && branchOut.stdout) || '').trim();
  if (currentBranch !== 'main') {
    console.warn(c.yellow(`[pipe] artifact repo is on branch "${currentBranch}", not main — checking out main first.`));
    runGit(['checkout', 'main'], artifactDir);
  }
  console.log(c.dim('[pipe] local main diverged from origin/main (likely squash merge upstream) — resetting to origin/main.'));
  const resetResult = runGit(['reset', '--hard', 'origin/main'], artifactDir);
  return resetResult.status === 0 ? code : 2;
}

async function cmdPublish({ positional, flags }) {
  const runId = positional[0] || path.basename(readLatestRunDir() || '');
  if (!runId) throw new Error('No run to publish — pass RUN_ID.');
  const runDir = runDirFromId(runId);
  const identity = IDENTITY.resolveIdentity({ refresh: false });
  if (!identity) {
    console.error(c.red('No identity resolved — run `pipe whoami` for details.'));
    return 64;
  }
  const artifactDir = resolveArtifactDir();
  const artifactRepo = resolveArtifactRepoUrl();
  if (!fs.existsSync(artifactDir)) {
    console.error(c.red(`Artifact clone not found at ${artifactDir}.`));
    console.error('Run `npm run pipe -- pull` first to clone the artifact repo.');
    return 2;
  }
  const destDir = path.join(artifactDir, 'demos', identity.login, runId);
  console.log(c.bold(`[pipe] publish ${runId}`));
  console.log(c.dim(`  owner:  @${identity.login}`));
  console.log(c.dim(`  dest:   ${destDir}`));
  let result;
  try {
    result = RUN_PACKAGE.publishPackage({
      runDir,
      destDir,
      owner: { login: identity.login, name: identity.name || null },
      includePrompt: !!flags['include-prompt'],
      overwrite: true,
      notes: flags.notes || null,
    });
  } catch (e) {
    console.error(c.red(`[pipe] publish blocked: ${e.message}`));
    if (e.findings && e.findings.length) {
      for (const f of e.findings.slice(0, 5)) {
        console.error(c.red(`  ${f.path}:${f.line}  [${f.pattern}]`));
      }
    }
    return 2;
  }
  console.log(c.green(`[pipe] packaged ${result.files.length} file(s)`));

  if (!artifactRepo) {
    console.log(c.yellow('  PLAID_DEMO_APPS_REPO is unset — local publish only (no push).'));
    return 0;
  }
  const message = flags.message
    ? String(flags.message)
    : `publish: ${identity.login}/${runId}`;

  const addResult = runGit(['add', path.relative(artifactDir, destDir)], artifactDir);
  if (addResult.status !== 0) {
    console.error(c.red('[pipe] git add failed — aborting.'));
    return 2;
  }
  const commitResult = runGit(['commit', '-m', message], artifactDir);
  if (commitResult.status !== 0) {
    console.warn(c.yellow('  Nothing new to commit (already published at this version?).'));
  }
  if (flags['direct-push']) {
    const pushResult = runGit(['push', 'origin', 'HEAD:main'], artifactDir);
    return pushResult.status === 0 ? 0 : 2;
  }
  const branch = `publish/${identity.login}/${runId}`;
  runGit(['checkout', '-B', branch], artifactDir);
  runGit(['push', '-u', 'origin', branch], artifactDir);
  const gh = process.env.GH_BIN || 'gh';
  const ghEnv = { ...process.env };
  // gh respects --hostname OR a GH_HOST env var; we set the env var so any
  // sub-call (pr create, pr merge) targets the right GHE host even when we
  // don't pass --hostname explicitly.
  const gheHost = (IDENTITY.detectGheHostname && IDENTITY.detectGheHostname()) || identity.host || null;
  if (gheHost) ghEnv.GH_HOST = gheHost;
  const ghResult = spawnSync(
    gh,
    ['pr', 'create', '--fill', '--head', branch, '--base', 'main'],
    { cwd: artifactDir, stdio: 'inherit', env: ghEnv }
  );
  if (ghResult.status !== 0) {
    console.warn(c.yellow('  `gh pr create` failed. You can open the PR manually from the URL printed above.'));
    runGit(['checkout', 'main'], artifactDir);
    return 0;
  }
  // Default: try to enable auto-merge so when CODEOWNERS approves (and any
  // required checks pass) the PR merges itself, the branch is deleted, and
  // local main can be fast-forwarded on the next `pipe pull`. Skip with
  // --no-auto-merge for users who want to review the PR diff first.
  const wantAutoMerge = !flags['no-auto-merge'];
  if (wantAutoMerge) {
    console.log(c.dim('[pipe] enabling auto-merge for the PR (squash, delete branch on merge)…'));
    const merge1 = spawnSync(
      gh,
      ['pr', 'merge', branch, '--auto', '--squash', '--delete-branch'],
      { cwd: artifactDir, stdio: 'inherit', env: ghEnv }
    );
    if (merge1.status !== 0) {
      // --auto fails on repos that don't have auto-merge enabled, or when
      // there are no required checks AND the PR is mergeable already; the
      // safe second-try is an immediate squash merge. If that also fails
      // (e.g. CODEOWNERS hasn't approved), leave the PR open and tell the
      // user.
      console.log(c.dim('[pipe] auto-merge unavailable — attempting an immediate squash merge.'));
      const merge2 = spawnSync(
        gh,
        ['pr', 'merge', branch, '--squash', '--delete-branch'],
        { cwd: artifactDir, stdio: 'inherit', env: ghEnv }
      );
      if (merge2.status !== 0) {
        console.warn(c.yellow(
          '  Could not auto-merge the PR (CODEOWNERS approval pending, branch protection blocking, or auto-merge disabled in repo settings).\n' +
          '  The PR is open and waiting — merge it from the URL printed above. Run `npm run pipe -- pull` afterwards to sync your local clone.'
        ));
      } else {
        console.log(c.green('[pipe] PR merged via squash. Branch deleted on remote.'));
      }
    } else {
      console.log(c.green('[pipe] auto-merge enabled — PR will merge as soon as CODEOWNERS approves and any required checks pass.'));
    }
  } else {
    console.log(c.dim('[pipe] --no-auto-merge: PR left open for manual review. Merge it from the URL printed above.'));
  }
  // Sync local main with whatever just happened (no-op if the merge hasn't
  // fired yet; instant fast-forward if it did). Failures are non-fatal.
  runGit(['checkout', 'main'], artifactDir);
  spawnSync('git', ['pull', '--ff-only', 'origin', 'main'], {
    cwd: artifactDir,
    stdio: 'inherit',
    env: process.env,
  });
  return 0;
}

async function cmdUnpublish({ positional }) {
  const runId = positional[0];
  if (!runId) throw new Error('RUN_ID required for unpublish.');
  const identity = IDENTITY.resolveIdentity({ refresh: false });
  if (!identity) {
    console.error(c.red('No identity resolved.'));
    return 64;
  }
  const artifactDir = resolveArtifactDir();
  const relDir = path.join('demos', identity.login, runId);
  const absDir = path.join(artifactDir, relDir);
  if (!fs.existsSync(absDir)) {
    console.error(c.red(`Nothing to unpublish — not found at ${absDir}`));
    return 2;
  }
  fs.rmSync(absDir, { recursive: true, force: true });
  runGit(['add', '-A', relDir], artifactDir);
  runGit(['commit', '-m', `unpublish: ${identity.login}/${runId}`], artifactDir);
  if (resolveArtifactRepoUrl()) {
    const branch = `unpublish/${identity.login}/${runId}`;
    runGit(['checkout', '-B', branch], artifactDir);
    runGit(['push', '-u', 'origin', branch], artifactDir);
    runGit(['checkout', 'main'], artifactDir);
  }
  return 0;
}

// ── Command: post-slides (per-slide agent-driven insertion) ──────────────────
async function cmdPostSlides({ positional, flags }) {
  const runId = positional[0] || path.basename(readLatestRunDir() || '');
  if (!runId) throw new Error('No run to target — pass RUN_ID.');
  const runDir = runDirFromId(runId);
  const script = path.join(PROJECT_ROOT, 'scripts', 'scratch', 'scratch', 'post-slides.js');
  const args = [script];
  if (flags.steps) args.push(`--steps=${flags.steps}`);
  if (flags['max-iters']) args.push(`--max-iters=${flags['max-iters']}`);
  if (flags['dry-run']) args.push('--dry-run');
  console.log(c.bold(`[pipe] post-slides on ${runId}`));
  const child = spawn('node', args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PIPELINE_RUN_DIR: runDir },
    stdio: 'inherit',
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code === 0 ? 0 : 2));
  });
}

// ── Command: open (dashboard URL) ────────────────────────────────────────────
function cmdOpen({ positional }) {
  const runId = positional[0] || path.basename(readLatestRunDir() || '');
  const port = process.env.DASHBOARD_PORT || '4040';
  const base = `http://localhost:${port}/`;
  const url = runId ? `${base}?run=${encodeURIComponent(runId)}` : base;
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawnSync(opener, [url], { stdio: 'ignore', shell: process.platform === 'win32' });
    console.log(`Opened ${url}`);
    return 0;
  } catch (err) {
    console.log(`Visit: ${url}`);
    return 0;
  }
}

// ── Interactive menu ─────────────────────────────────────────────────────────
function ask(rl, question) {
  return new Promise(resolve => rl.question(question, ans => resolve(ans.trim())));
}

async function askMulti(rl, question) {
  const ans = await ask(rl, question);
  if (!ans) return [];
  return ans.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

// ── Command: quickstart (app-only wizard) ────────────────────────────────────
//
// Walks the user through a structured set of menus, then writes:
//   1. inputs/prompt.txt        — draft prompt filled from the app-only template
//   2. inputs/quickstart-research-task.md — agent handoff for AskBill + Glean
// Any existing prompt.txt is backed up first.
//
// MCPs (AskBill, Glean) cannot be invoked from pure Node — they live in
// agent context. So the wizard pre-stages everything and the agent (Cursor
// or Claude Code) executes the research pass.
async function cmdQuickstart(parsed = {}) {
  const QS = require(path.join(PROJECT_ROOT, 'scripts', 'scratch', 'utils', 'quickstart'));
  const flags = (parsed && parsed.flags) || {};

  // Non-interactive path (for tests / scripted SE onboarding):
  if (flags['non-interactive'] || flags.json) {
    return await runQuickstartNonInteractive(flags, QS);
  }

  console.log('');
  console.log(c.bold('╔══════════════════════════════════════════════════════════════════╗'));
  console.log(c.bold('║  Plaid Demo Pipeline — Quickstart Wizard (APP-ONLY BUILD)       ║'));
  console.log(c.bold('╚══════════════════════════════════════════════════════════════════╝'));
  console.log('');
  console.log('This wizard generates a draft ' + c.cyan('inputs/prompt.txt') + ' from the app-only');
  console.log('template plus an agent task that runs ' + c.cyan('AskBill + Glean') + ' research.');
  console.log(c.dim('Press ENTER at any prompt to use the default shown in [brackets].'));
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answers = {};
  try {
    // 1) Brand
    answers.brand = await ask(rl, c.bold('1) Customer / brand name') + ' (e.g. Bank of America): ');
    if (!answers.brand) {
      console.log(c.red('  Brand name is required to proceed.'));
      return 64;
    }

    // 2) Brand domain (optional)
    answers.brandDomain = await ask(rl, c.bold('2) Brand domain') + ' (e.g. bankofamerica.com) ' + c.dim('[optional]') + ': ');
    answers.brandDomain = answers.brandDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    // 3) Industry
    console.log('');
    console.log(c.bold('3) Industry'));
    QS.INDUSTRIES.forEach((ind, i) => console.log(`   [${i + 1}] ${ind.label}`));
    let industryIdx = parseInt(await ask(rl, 'Choose [1]: '), 10);
    if (!Number.isFinite(industryIdx) || industryIdx < 1 || industryIdx > QS.INDUSTRIES.length) industryIdx = 1;
    const industry = QS.INDUSTRIES[industryIdx - 1];
    answers.industry = industry.id;
    answers.industryLabel = industry.label;
    if (industry.id === 'other') {
      const free = await ask(rl, '   Specify industry: ');
      if (free) answers.industryLabel = free;
    }

    // 4) Plaid Link mode
    console.log('');
    console.log(c.bold('4) Plaid Link mode'));
    QS.LINK_MODES.forEach((lm, i) => console.log(`   [${i + 1}] ${lm.label}`));
    let linkIdx = parseInt(await ask(rl, 'Choose [1]: '), 10);
    if (!Number.isFinite(linkIdx) || linkIdx < 1 || linkIdx > QS.LINK_MODES.length) linkIdx = 1;
    answers.linkMode = QS.LINK_MODES[linkIdx - 1].id;

    // 5) Plaid products (multi-select)
    console.log('');
    console.log(c.bold('5) Plaid products to feature') + c.dim(' (comma- or space-separated numbers)'));
    QS.KNOWN_PRODUCTS.forEach((p, i) => console.log(`   [${String(i + 1).padStart(2)}] ${p.label.padEnd(36)} ${c.dim(p.hint)}`));
    const picks = await askMulti(rl, 'Pick at least one (e.g. ' + c.cyan('1,2,3') + '): ');
    const products = [];
    for (const tok of picks) {
      const n = parseInt(tok, 10);
      if (Number.isFinite(n) && n >= 1 && n <= QS.KNOWN_PRODUCTS.length) products.push(QS.KNOWN_PRODUCTS[n - 1]);
    }
    if (!products.length) {
      console.log(c.red('  At least one product is required.'));
      rl.close();
      return 64;
    }
    answers.products = products;

    // 6) Persona
    console.log('');
    answers.persona = await ask(rl, c.bold('6) Persona') + ' (name + role, e.g. ' + c.dim('"Michael Carter, retail banking customer"') + '): ');

    // 7) Use case (one-sentence pitch)
    console.log('');
    console.log(c.bold('7) Use case — one-sentence pitch'));
    console.log(c.dim('   This is YOUR description of the demo. The agent will research around it.'));
    answers.useCase = await ask(rl, '> ');
    if (!answers.useCase) {
      console.log(c.red('  Use case is required so research has a target.'));
      rl.close();
      return 64;
    }

    // 8) Research depth
    console.log('');
    console.log(c.bold('8) Research depth'));
    QS.RESEARCH_DEPTHS.forEach((d, i) => console.log(`   [${i + 1}] ${d.label}`));
    let depthIdx = parseInt(await ask(rl, 'Choose [1]: '), 10);
    if (!Number.isFinite(depthIdx) || depthIdx < 1 || depthIdx > QS.RESEARCH_DEPTHS.length) depthIdx = 1;
    answers.researchDepth = QS.RESEARCH_DEPTHS[depthIdx - 1].id;

    // 9) Build after research?
    console.log('');
    const buildAns = await ask(rl, c.bold('9) Start the build automatically after research finishes?') + ' [Y/n]: ');
    answers.buildAfter = !/^n/i.test(buildAns);

    // ── Confirm + write ────────────────────────────────────────────────────
    console.log('');
    console.log(c.bold('Summary:'));
    console.log(`  Brand:           ${c.cyan(answers.brand)}${answers.brandDomain ? c.dim(' (' + answers.brandDomain + ')') : ''}`);
    console.log(`  Industry:        ${answers.industryLabel}`);
    console.log(`  Plaid Link mode: ${answers.linkMode}`);
    console.log(`  Products:        ${products.map(p => p.label).join(', ')}`);
    console.log(`  Persona:         ${answers.persona || c.dim('(unset — agent will research)')}`);
    console.log(`  Use case:        ${answers.useCase}`);
    console.log(`  Research depth:  ${answers.researchDepth}`);
    console.log(`  Build after:     ${answers.buildAfter ? 'yes' : 'no'}`);
    console.log(`  Suggested run:   ${c.dim(QS.suggestRunId(answers))}`);
    console.log('');
    const confirm = await ask(rl, 'Write inputs/prompt.txt + research task? [Y/n]: ');
    if (/^n/i.test(confirm)) {
      console.log(c.yellow('Cancelled — no files written.'));
      rl.close();
      return 3;
    }
    rl.close();
  } catch (err) {
    try { rl.close(); } catch (_) { /* ignore */ }
    throw err;
  }

  return writeQuickstartArtifacts(answers, QS);
}

async function runQuickstartNonInteractive(flags, QS) {
  const products = (flags.products ? String(flags.products).split(/[\s,]+/) : [])
    .map(s => QS.findProduct(s))
    .filter(Boolean);
  const industry = QS.findIndustry(flags.industry || 'other') || QS.INDUSTRIES[QS.INDUSTRIES.length - 1];
  const answers = {
    brand: flags.brand || '',
    brandDomain: (flags.domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
    industry: industry.id,
    industryLabel: industry.label,
    linkMode: flags['link-mode'] === 'embedded' ? 'embedded' : 'modal',
    products,
    persona: flags.persona || '',
    useCase: flags['use-case'] || flags.usecase || '',
    researchDepth: flags['research'] || 'gapfill',
    buildAfter: !!flags['build-after'],
  };
  if (!answers.brand || !answers.useCase || !answers.products.length) {
    console.error(c.red('quickstart: --brand, --use-case, and --products are required in non-interactive mode.'));
    return 64;
  }
  return writeQuickstartArtifacts(answers, QS);
}

function writeQuickstartArtifacts(answers, QS) {
  // Back up any existing prompt.txt so the user never loses prior content.
  const promptPath   = path.join(INPUTS_DIR, 'prompt.txt');
  const taskPath     = path.join(INPUTS_DIR, 'quickstart-research-task.md');
  if (fs.existsSync(promptPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bak = path.join(INPUTS_DIR, `prompt.${stamp}.bak.txt`);
    fs.copyFileSync(promptPath, bak);
    console.log(c.dim(`  · backed up existing prompt.txt → ${path.relative(PROJECT_ROOT, bak)}`));
  }

  const draftPrompt = QS.fillTemplateFromAnswers(answers);
  const taskMd      = QS.buildResearchTaskMarkdown(answers, { buildAfter: answers.buildAfter });
  fs.writeFileSync(promptPath, draftPrompt, 'utf8');
  fs.writeFileSync(taskPath,   taskMd, 'utf8');

  console.log('');
  console.log(c.green(`  ✓ Wrote ${path.relative(PROJECT_ROOT, promptPath)} (DRAFT — wizard header at top)`));
  console.log(c.green(`  ✓ Wrote ${path.relative(PROJECT_ROOT, taskPath)} (agent research handoff)`));

  // Clipboard recipe (best-effort, macOS only).
  const recipe =
    `Open this file in Cursor or Claude Code (Agent mode) and run it:\n\n` +
    `  ${taskPath}\n\n` +
    `It tells the agent to use AskBill + Glean to enrich inputs/prompt.txt, then ` +
    `${answers.buildAfter ? 'kick off ' : 'optionally start '}the app-only build.\n`;
  if (process.platform === 'darwin') {
    try { spawnSync('pbcopy', [], { input: recipe }); } catch (_) {}
  }

  console.log('');
  console.log(c.bold('Next:'));
  console.log(`  1. Open ${c.cyan(path.relative(PROJECT_ROOT, taskPath))} in Cursor ${c.dim('OR')} Claude Code.`);
  console.log(`  2. Switch to ${c.cyan('Agent mode')} so AskBill + Glean MCP tools are available.`);
  console.log(`  3. Type "Run this task." The agent will research with AskBill + Glean,`);
  console.log(`     refine ${c.cyan(path.relative(PROJECT_ROOT, promptPath))}, and ${answers.buildAfter ? c.cyan('start the build') : 'hand back to you'}.`);
  console.log('');
  console.log(c.dim('Tip: the wizard never invents numbers. Storyboard tables stay empty in the draft —'));
  console.log(c.dim('     the agent fills them with researched facts from AskBill + Glean.'));
  return 0;
}

async function pickFromList(rl, title, items, toLabel) {
  if (!items.length) { console.log(c.dim('(no runs)')); return null; }
  console.log(c.bold('\n' + title));
  items.forEach((it, i) => console.log(`  [${i + 1}] ${toLabel(it)}`));
  const ans = await ask(rl, '\nChoose number (ENTER to cancel): ');
  const n = parseInt(ans, 10);
  if (!Number.isFinite(n) || n < 1 || n > items.length) return null;
  return items[n - 1];
}

async function interactiveMenu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const latest = readLatestRunDir();
      const latestStatus = latest ? (() => { try { return computeStatus(latest); } catch (_) { return null; } })() : null;
      const active = findActiveRun();

      console.log('');
      console.log(c.bold('Plaid Demo Pipeline — CLI'));
      console.log('─'.repeat(60));
      if (latestStatus) {
        const summary = `${latestStatus.counts.completed}/${latestStatus.counts.total} stages` +
          (latestStatus.counts.failed ? c.red(', ' + latestStatus.counts.failed + ' failed') : '') +
          (latestStatus.runningStage ? c.cyan(', running ' + latestStatus.runningStage) : '');
        console.log(`Latest: ${c.cyan(latestStatus.runId)}  ${summary}`);
      } else {
        console.log(c.dim('No runs yet.'));
      }
      if (active) {
        console.log(c.green(`Active: PID ${active.status.activePid} on ${active.runId}` +
          (active.status.awaitingContinue ? c.yellow('  ⚑awaiting continue') : '')));
      }
      console.log('');
      console.log('  [1] Start a new build (inputs/prompt.txt)');
      console.log('  [2] Resume a run');
      console.log('  [3] Re-run one stage');
      console.log('  [4] Show status');
      console.log('  [5] Tail logs (follow)');
      console.log('  [6] Continue (resolve a pending prompt)');
      console.log('  [7] Stop active build');
      console.log('  [8] List recent runs');
      console.log('  [9] Open dashboard');
      console.log('  [Q] Quickstart wizard (app-only — guided prompt + research)');
      console.log('  [0] Quit');
      const ans = await ask(rl, '\nChoose: ');

      if (ans === '0' || ans === 'q' || ans === 'quit' || ans === '') { rl.close(); return 0; }

      if (ans === '1') {
        const withSlidesAns = await ask(rl, 'Include slides? [y/N]: ');
        const researchAns = await ask(rl, 'Research mode (gapfill/broad/deep) [broad]: ');
        const flags = {};
        if (/^y/i.test(withSlidesAns)) flags['with-slides'] = true;
        const r = (researchAns || 'broad').toLowerCase();
        if (VALID_RESEARCH.has(r)) flags.research = r;
        rl.close();
        return await cmdNew({ flags });
      }

      if (ans === '2') {
        const runs = listRunDirs().slice(0, 10);
        const picked = await pickFromList(rl, 'Pick a run to resume:', runs, (r) => {
          try {
            const st = computeStatus(r.runDir);
            return `${r.runId}  ${c.dim(st.counts.completed + '/' + st.counts.total)}` +
              (st.firstFailed ? c.red(' ✗' + st.firstFailed) : '');
          } catch (_) { return r.runId; }
        });
        if (!picked) continue;
        const fromAns = await ask(rl, 'Resume from stage (ENTER = auto-detect): ');
        const flags = {};
        if (fromAns) flags.from = fromAns.trim();
        rl.close();
        return await cmdResume({ positional: [picked.runId], flags });
      }

      if (ans === '3') {
        const runs = listRunDirs().slice(0, 10);
        const picked = await pickFromList(rl, 'Pick a run:', runs, r => r.runId);
        if (!picked) continue;
        const stage = await pickFromList(rl, 'Pick a stage:', STAGES.map(s => ({ name: s })), s => s.name);
        if (!stage) continue;
        rl.close();
        return await cmdStage({ positional: [stage.name, picked.runId], flags: {} });
      }

      if (ans === '4') {
        cmdStatus({ positional: [], flags: {} });
        await ask(rl, '\n(press ENTER) ');
        continue;
      }

      if (ans === '5') {
        rl.close();
        return await cmdLogs({ positional: [], flags: { follow: true } });
      }

      if (ans === '6') {
        cmdContinue({ positional: [] });
        await ask(rl, '\n(press ENTER) ');
        continue;
      }

      if (ans === '7') {
        const code = cmdStop({ positional: [], flags: {} });
        await ask(rl, '\n(press ENTER) ');
        if (code !== 0) continue; else continue;
      }

      if (ans === '8') {
        cmdList({ flags: {} });
        await ask(rl, '\n(press ENTER) ');
        continue;
      }

      if (ans === '9') {
        cmdOpen({ positional: [] });
        continue;
      }

      if (ans.toLowerCase() === 'q') {
        rl.close();
        return await cmdQuickstart({ flags: {} });
      }

      console.log(c.red('Unknown choice'));
    }
  } finally {
    try { rl.close(); } catch (_) { /* ignore */ }
  }
}

// ── Help ─────────────────────────────────────────────────────────────────────
function cmdHelp() {
  const H = (title) => '\n' + c.bold(title) + '\n' + '─'.repeat(72);
  const cmd = (syntax, desc) =>
    `  ${c.cyan(syntax)}\n     ${desc.split('\n').join('\n     ')}\n`;

  const help = `
${c.bold('Plaid Demo Pipeline CLI')}   ${c.dim('(hybrid — humans + AI agents)')}

Run as ${c.cyan('npm run pipe -- <command> [args] [--flags]')} or with no command for the
interactive menu. Aliases noted in parentheses. All commands accept ${c.cyan('--json')}
where applicable, and ${c.cyan('--non-interactive')} to suppress prompts (return code 5
instead of waiting for a continue gate).
${H('GETTING STARTED — guided wizards')}
${cmd('npm run pipe',
`Interactive numeric menu. Picks a sane default (start, resume, status, logs)
based on whether there is an active run. No flags. Exit codes follow the
"Claude integration" section below.`)}
${cmd('npm run quickstart   ' + c.dim('(alias: pipe quickstart, pipe qs)'),
`APP-ONLY build wizard for sales engineers who want a guided "give me a
prompt, do the research, build it" flow. Asks for brand, industry, persona,
products, Plaid Link mode, and a one-sentence pitch, then writes a draft
inputs/prompt.txt + an agent task that runs AskBill + Glean research in
your AI agent. Optionally kicks off the build once research finishes.
Backs up any existing inputs/prompt.txt → inputs/prompt.<timestamp>.bak.txt.`)}
${H('BUILDING — start, resume, re-run')}
${cmd('npm run pipe -- new   [--prompt=PATH] [--app-only|--with-slides]',
`Start a new build from inputs/prompt.txt. Defaults to app-only; pass
--with-slides to include the slide-generation phase. Other flags:
  --research=gapfill|broad|deep  research depth. NEW DEFAULT is "broad" (was
                                 "gapfill"). broad/deep map to research.js's
                                 "full" mode: wider Glean coverage, more Gong
                                 color, more grounded sample data. Set
                                 RESEARCH_MODE=gapfill in .env to opt back
                                 into the shallow legacy default.
  --to=STAGE                     stop the pipeline after STAGE
  --qa-threshold=N               vision-QA pass threshold (default 80)
  --max-refinement-iterations=N  cap LLM refinement loops (default 3)
  --build-fix-mode=smart|rebuild|patch|agent-touchup
                                 strategy when build-qa flags issues. Aliases
                                 (translated automatically before forwarding):
                                 smart=auto, rebuild=fullbuild, patch=touchup.
                                 DEFAULT under an AI agent (Claude Code or
                                 Cursor with PIPE_AGENT_MODE=1) is now
                                 \`agent-touchup\`: orchestrator pauses on a
                                 continue-gate after each failed build-qa,
                                 agent makes surgical edits, loop max 3
                                 iterations or until QA passes. No LLM
                                 rebuilds. Set PIPE_AGENT_MODE=0 (or pass
                                 \`--build-fix-mode=touchup\`) to fall back
                                 to the legacy LLM regen path.
  --no-touchup                   skip the final cosmetic-touchup pass
  --non-interactive              fail closed on prompt gates instead of waiting
  --json                         emit machine-readable progress events`)}
${cmd('npm run pipe -- resume   [RUN_ID] [--from=STAGE] [--to=STAGE]',
`Resume a previously-stopped or partially-completed run. RUN_ID defaults to
the most recent run. --from auto-detects the first incomplete stage if
omitted. Flags: --with-slides | --app-only override the original mode;
--non-interactive matches "new".`)}
${cmd('npm run pipe -- stage   STAGE [RUN_ID]',
`Re-run exactly one stage on an existing run. Useful after editing artifacts
by hand or fixing a stage-specific input. STAGE must be one of the names
listed under "Stages" below. Wipes downstream stage state so subsequent
"resume" calls pick up cleanly.`)}
${cmd('npm run pipe -- post-slides   [RUN_ID] [--steps=IDS] [--max-iters=N]',
`Run the agent-driven, per-slide insertion stage in isolation. Useful when
a build was app-only and you decide to add a slide at one or more steps,
or when slide quality is below threshold. --steps accepts a comma list of
step ids; --max-iters caps the LLM refinement loop per slide.`)}
${cmd('npm run pipe -- post-panels   [RUN_ID] [--steps=IDS] [--dry-run]',
`Deterministic side-panel normalizer for #api-response-panel and
#link-events-panel: enforces the expand/collapse contract and hydrates
JSON payloads. No LLM calls in the deterministic path; --dry-run prints
the proposed HTML diff without writing.`)}
${H('LIFECYCLE & INSPECTION — observe and steer a run')}
${cmd('npm run pipe -- status   [RUN_ID] [--json]',
`Print stage-by-stage state for a run (defaults to latest). --json emits
the canonical structured object that scripts and Claude / Cursor agents
use for recovery logic.`)}
${cmd('npm run pipe -- logs   [RUN_ID] [--follow] [--since=STAGE]',
`Tail the pipeline's stdout/stderr log for a run. --follow streams new
output (good for monitoring); --since=STAGE jumps to where a specific
stage began.`)}
${cmd('npm run pipe -- list   [--limit=N] [--json]',
`Show the most recent N runs (default 20) with their build-mode, latest
QA score, and active/idle status. --json is the structured form.`)}
${cmd('npm run pipe -- continue   [RUN_ID]',
`Resolve a "prompt gate" — i.e. a stage that paused waiting on a human
decision. Reads the gate's question file from the run dir and sends an
"approve" answer. Exits with 5 if no gate is open.`)}
${cmd('npm run pipe -- stop   [RUN_ID] [--force]',
`Gracefully stop the active orchestrator process for RUN_ID by sending
SIGINT. --force escalates to SIGKILL after the grace window. Subsequent
"resume" picks up from the last completed stage.`)}
${cmd('npm run pipe -- open   [RUN_ID]',
`Open the dashboard in your default browser, scoped to RUN_ID's detail
view if provided. Spawns the dashboard server if it isn't already up.`)}
${H('DISTRIBUTION — share demos across the SE team (GHE)')}
${cmd('npm run pipe -- whoami   [--refresh]',
`Print the resolved GitHub Enterprise login + GHE host that publish
operations will run as, plus the local + remote artifact paths. --refresh
ignores the cache and re-runs gh auth / git-remote detection.`)}
${cmd('npm run pipe -- pull',
`git pull --ff-only on this code repo, then sync the central artifact
repo (\`plaid-demo-apps\`) under ~/.plaid-demo-apps. Recovers from squash-
merge divergence on artifact's main branch automatically.`)}
${cmd('npm run pipe -- publish   [RUN_ID] [--message=...] [--include-prompt] [--no-auto-merge]',
`Package the run (redact secrets via check-publish-safety, strip logs +
intermediates), push to a per-user branch in plaid-demo-apps, open a PR,
and enable auto-merge (squash + delete branch) so the demo lands in main
without manual approval. --include-prompt embeds the original prompt.txt
in the bundle (off by default to keep proprietary phrasing private).
--direct-push force-pushes to main (maintainers only).
--no-auto-merge leaves the PR open for review.`)}
${cmd('npm run pipe -- unpublish   RUN_ID',
`Remove a previously-published demo from plaid-demo-apps via a deletion
PR. Same auto-merge behavior as publish.`)}
${H('AGENT INTEGRATIONS — handoffs to Cursor / Claude Code')}
${cmd('npm run pipe -- figma-convert   [RUN_ID] [--figma-file=URL]',
`Generate an agent-ready prompt that converts a built demo into a Figma
file (one frame per demo-script step) using the figma plugin
(figma@claude-plugins-official → use_figma tool, MCP at mcp.figma.com).
Writes <run>/figma-conversion-prompt.md and copies a paste-into-agent
recipe to the clipboard. Works in both Cursor and Claude Code.`)}
${cmd('npm run pipe -- qa-touchup   [RUN_ID] [--qa-threshold=N]   ' + c.dim('(alias: qt)'),
`Generate an agent-ready prompt that fixes failing QA findings via surgical,
single-step edits — instead of regenerating the whole index.html like the
LLM-driven --build-fix-mode=touchup path. Reads the run's qa-report-build.json
(or latest qa-report-N.json), extracts each failing step's HTML block +
Playwright row + frame paths, and writes <run>/qa-touchup-task.md. Open it
in Cursor or Claude Code (Agent mode) and the agent edits exactly the failing
steps using Read + StrReplace. On systemic issues (>=3 distinct failing
steps, shared-chrome categories, or deterministic-blocker gate), the task
tells the agent to STOP and recommend a fullbuild instead. Re-verify with
\`pipe stage build-qa <RUN_ID>\` once the agent reports done.

Token / wall-clock uplift vs LLM touchup on multi-step failures:
~5-10x fewer tokens, ~3-5x faster, regressions on unrelated steps bounded
by StrReplace scope rather than LLM prompt discipline.`)}
${H('META')}
${cmd('npm run pipe -- help   ' + c.dim('(aliases: -h, --help)'),
`Print this listing.`)}

${c.bold('Stages (in order, used by --to / --from / stage):')}
${c.dim('  ' + STAGES.join('\n  '))}

${c.bold('Claude / Cursor agent integration:')}
${c.dim(`  · ::PIPE:: lines on stdout mark stage_start / stage_end / prompt / pipeline_*
  · Exit codes: 0 ok, 2 pipeline err, 3 cancelled, 4 already running, 5 awaiting continue, 64 usage
  · "pipe status --json" is the canonical state object for recovery logic
  · "pipe quickstart", "pipe figma-convert", and "pipe qa-touchup" produce
    agent task .md files that the AI agent (Cursor / Claude Code) executes
    using MCP tools (AskBill / Glean / use_figma) and Read + StrReplace.`)}
`;
  console.log(help);
  return 0;
}

// ── Main dispatch ────────────────────────────────────────────────────────────
(async function main() {
  const parsed = parseArgv(process.argv);
  try {
    let code;
    switch (parsed.command) {
      case null:
      case undefined:
        code = await interactiveMenu();
        break;
      case 'new':      code = await cmdNew(parsed);     break;
      case 'quickstart':
      case 'qs':       code = await cmdQuickstart(parsed); break;
      case 'resume':   code = await cmdResume(parsed);  break;
      case 'stage':    code = await cmdStage(parsed);   break;
      case 'post-panels': code = await cmdPostPanels(parsed); break;
      case 'post-slides': code = await cmdPostSlides(parsed); break;
      case 'whoami':   code = cmdWhoami(parsed);         break;
      case 'pull':     code = await cmdPull();           break;
      case 'publish':  code = await cmdPublish(parsed);  break;
      case 'unpublish':code = await cmdUnpublish(parsed);break;
      case 'figma-convert':
      case 'figma':    code = await cmdFigmaConvert(parsed); break;
      case 'qa-touchup':
      case 'qt':       code = await cmdQaTouchup(parsed);    break;
      case 'status':   code = cmdStatus(parsed);        break;
      case 'logs':     code = await cmdLogs(parsed);    break;
      case 'list':     code = cmdList(parsed);          break;
      case 'stop':     code = cmdStop(parsed);          break;
      case 'continue': code = cmdContinue(parsed);      break;
      case 'open':     code = cmdOpen(parsed);          break;
      case 'help':
      case '--help':
      case '-h':       code = cmdHelp();                break;
      default:
        console.error(c.red(`Unknown command: ${parsed.command}`));
        cmdHelp();
        code = 64;
    }
    process.exit(code == null ? 0 : code);
  } catch (err) {
    console.error(c.red(`[pipe] ${err.message}`));
    if (process.env.PIPE_DEBUG && err.stack) console.error(err.stack);
    process.exit(2);
  }
})();
