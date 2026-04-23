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
const VALID_BUILD_FIX_MODES = new Set(['smart', 'rebuild', 'patch']);

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
  if (flags['build-fix-mode']) args.push(`--build-fix-mode=${flags['build-fix-mode']}`);
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
  if (flags['build-fix-mode']) args.push(`--build-fix-mode=${flags['build-fix-mode']}`);
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
      console.log('  [0] Quit');
      const ans = await ask(rl, '\nChoose: ');

      if (ans === '0' || ans === 'q' || ans === 'quit' || ans === '') { rl.close(); return 0; }

      if (ans === '1') {
        const withSlidesAns = await ask(rl, 'Include slides? [y/N]: ');
        const researchAns = await ask(rl, 'Research mode (gapfill/broad/deep) [gapfill]: ');
        const flags = {};
        if (/^y/i.test(withSlidesAns)) flags['with-slides'] = true;
        const r = (researchAns || 'gapfill').toLowerCase();
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

      console.log(c.red('Unknown choice'));
    }
  } finally {
    try { rl.close(); } catch (_) { /* ignore */ }
  }
}

// ── Help ─────────────────────────────────────────────────────────────────────
function cmdHelp() {
  const help = `
${c.bold('Plaid Demo Pipeline CLI')}   ${c.dim('(hybrid — humans + Claude)')}

Usage:
  ${c.cyan('npm run pipe')}                              Interactive menu
  ${c.cyan('npm run pipe -- new')}      [--prompt=PATH] [--with-slides|--app-only]
                                 [--research=gapfill|broad|deep]
                                 [--to=STAGE] [--qa-threshold=N]
                                 [--max-refinement-iterations=N]
                                 [--build-fix-mode=smart|rebuild|patch]
                                 [--no-touchup] [--non-interactive] [--json]

  ${c.cyan('npm run pipe -- resume')}   [RUN_ID] [--from=STAGE] [--to=STAGE]
                                 [--with-slides|--app-only] [--non-interactive]

  ${c.cyan('npm run pipe -- stage')}    STAGE [RUN_ID]    Re-run one stage
  ${c.cyan('npm run pipe -- status')}   [RUN_ID] [--json]  Run + stage state
  ${c.cyan('npm run pipe -- logs')}     [RUN_ID] [--follow]
  ${c.cyan('npm run pipe -- stop')}     [RUN_ID] [--force]
  ${c.cyan('npm run pipe -- list')}     [--limit=N] [--json]
  ${c.cyan('npm run pipe -- continue')} [RUN_ID]          Resolve prompt gate
  ${c.cyan('npm run pipe -- open')}     [RUN_ID]          Open dashboard

Stages (in order): ${STAGES.join(', ')}

Claude integration:
  ${c.dim('- ::PIPE:: lines on stdout mark stage_start / stage_end / prompt / pipeline_*')}
  ${c.dim('- Exit codes: 0 ok, 2 pipeline err, 3 cancelled, 4 already running, 5 awaiting continue')}
  ${c.dim('- `pipe status --json` is the canonical state object for recovery logic')}
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
      case 'resume':   code = await cmdResume(parsed);  break;
      case 'stage':    code = await cmdStage(parsed);   break;
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
