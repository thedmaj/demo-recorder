#!/usr/bin/env node
'use strict';
/**
 * pipeline-watchdog.js
 *
 * 15-minute interval health check for the demo pipeline.
 *
 * On each tick:
 *   1. Check if a pipeline process (orchestrator.js) is running
 *   2. Detect stalled runs by checking if any output files changed in the last 15 min
 *   3. If stalled: kill the process, start a fresh pipeline run in a new versioned dir
 *   4. If no process running: check if there's an incomplete run, restart it
 *   5. Log status to watchdog.log in OUT_DIR
 *
 * Usage:
 *   node scripts/scratch/pipeline-watchdog.js          # run one check (for cron)
 *   node scripts/scratch/pipeline-watchdog.js --daemon # loop every 15 min
 */

require('dotenv').config({ override: true });

const fs           = require('fs');
const path         = require('path');
const { execSync, spawn } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT    = path.resolve(__dirname, '../..');
const OUT_DIR         = path.join(PROJECT_ROOT, 'out');
const DEMOS_DIR       = path.join(OUT_DIR, 'demos');
const WATCHDOG_LOG    = path.join(OUT_DIR, 'watchdog.log');
const STALL_THRESHOLD = 15 * 60 * 1000; // 15 minutes in ms
const DAEMON_INTERVAL = 15 * 60 * 1000; // 15 minutes

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.appendFileSync(WATCHDOG_LOG, line + '\n');
  } catch (_) {}
}

// ── Process detection ─────────────────────────────────────────────────────────

/**
 * Find running orchestrator.js processes.
 * Returns array of {pid, cmd} objects.
 */
function findOrchestratorProcesses() {
  try {
    const output = execSync(
      `ps aux | grep "orchestrator.js" | grep -v grep | grep -v watchdog`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!output) return [];

    return output.split('\n').map(line => {
      const parts = line.trim().split(/\s+/);
      const pid   = parseInt(parts[1], 10);
      const cmd   = parts.slice(10).join(' ');
      return { pid, cmd };
    }).filter(p => p.pid && !isNaN(p.pid));
  } catch {
    return [];
  }
}

// ── Stall detection ───────────────────────────────────────────────────────────

/**
 * Get the most recently modified file timestamp in a directory tree.
 */
function getLatestMtime(dir, maxDepth = 3) {
  if (!fs.existsSync(dir)) return 0;
  let latest = 0;

  function scan(d, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d); } catch { return; }

    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = path.join(d, entry);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }

      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
      if (stat.isDirectory()) scan(full, depth + 1);
    }
  }

  scan(dir, 0);
  return latest;
}

/**
 * Find the latest versioned demo run directory.
 */
function getLatestRunDir() {
  if (!fs.existsSync(DEMOS_DIR)) return null;

  const dirs = fs.readdirSync(DEMOS_DIR)
    .map(name => {
      const full = path.join(DEMOS_DIR, name);
      try {
        const stat = fs.statSync(full);
        return stat.isDirectory() ? { name, full, mtime: stat.mtimeMs } : null;
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  return dirs[0] || null;
}

/**
 * Determine if a pipeline run directory looks stalled.
 * Stalled = no file writes in the last STALL_THRESHOLD ms.
 */
function isRunStalled(runDir) {
  const latestMtime = getLatestMtime(runDir);
  if (!latestMtime) return true;
  const ageMs = Date.now() - latestMtime;
  return ageMs > STALL_THRESHOLD;
}

/**
 * Determine if a run looks incomplete (has demo-script.json but no final render).
 */
function isRunIncomplete(runDir) {
  if (!runDir) return false;
  const hasScript  = fs.existsSync(path.join(runDir, 'demo-script.json'));
  const hasRender  = fs.existsSync(path.join(runDir, 'demo.mp4')) ||
                     fs.existsSync(path.join(runDir, 'recording.webm'));
  return hasScript && !hasRender;
}

// ── Pipeline launcher ─────────────────────────────────────────────────────────

/**
 * Kill a process by PID.
 */
function killProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    log(`Killed PID ${pid} (SIGTERM)`);
    // Give it 3s to die gracefully, then SIGKILL
    setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }, 3000);
  } catch (err) {
    log(`Could not kill PID ${pid}: ${err.message}`);
  }
}

/**
 * Start a fresh pipeline run in a new versioned directory.
 * Spawns orchestrator.js as a detached background process.
 */
function startFreshPipeline() {
  log('Starting fresh pipeline run...');
  const logFile = path.join(OUT_DIR, `pipeline-${Date.now()}.log`);

  const child = spawn(
    process.execPath,
    ['scripts/scratch/orchestrator.js'],
    {
      cwd:      PROJECT_ROOT,
      detached: true,
      stdio:    ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
      env:      { ...process.env },
    }
  );
  child.unref();
  log(`Fresh pipeline started: PID ${child.pid}, log: ${logFile}`);
  return child.pid;
}

/**
 * Restart pipeline from build stage, reusing the latest run dir.
 */
function restartFromBuild() {
  log('Restarting pipeline from --from=build...');
  const logFile = path.join(OUT_DIR, `pipeline-restart-${Date.now()}.log`);

  const child = spawn(
    process.execPath,
    ['scripts/scratch/orchestrator.js', '--from=build'],
    {
      cwd:      PROJECT_ROOT,
      detached: true,
      stdio:    ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
      env:      { ...process.env },
    }
  );
  child.unref();
  log(`Pipeline restart started: PID ${child.pid}, log: ${logFile}`);
  return child.pid;
}

// ── Main watchdog check ───────────────────────────────────────────────────────

async function runCheck() {
  log('=== Watchdog check ===');

  const procs       = findOrchestratorProcesses();
  const latestRun   = getLatestRunDir();
  const runDir      = latestRun?.full || null;
  const runName     = latestRun?.name || '(none)';

  log(`Running orchestrators: ${procs.length > 0 ? procs.map(p => `PID ${p.pid}`).join(', ') : 'none'}`);
  log(`Latest run dir: ${runName}`);

  if (procs.length === 0) {
    // No pipeline running
    if (runDir && isRunIncomplete(runDir)) {
      const ageMin = Math.round((Date.now() - latestRun.mtime) / 60000);
      log(`No pipeline running. Latest run "${runName}" is incomplete (${ageMin}min old). Restarting from build...`);
      restartFromBuild();
    } else if (!runDir) {
      log('No pipeline running and no prior run found. Starting fresh...');
      startFreshPipeline();
    } else {
      log(`No pipeline running. Latest run "${runName}" appears complete. Nothing to do.`);
    }
    return;
  }

  // Pipeline is running — check for stall
  if (runDir) {
    const latestMtime = getLatestMtime(runDir);
    const ageMin      = Math.round((Date.now() - latestMtime) / 60000);
    log(`Latest file activity in "${runName}": ${ageMin} minutes ago`);

    if (isRunStalled(runDir)) {
      log(`STALL DETECTED: No file activity for ${ageMin} min (threshold: ${Math.round(STALL_THRESHOLD / 60000)} min)`);

      // Kill all running orchestrators
      for (const proc of procs) {
        log(`Killing stalled PID ${proc.pid}: ${proc.cmd}`);
        killProcess(proc.pid);
      }

      // Wait 4s for processes to die
      await new Promise(r => setTimeout(r, 4000));

      // Check if we have a complete demo-script.json to restart from build
      if (runDir && fs.existsSync(path.join(runDir, 'demo-script.json'))) {
        log('demo-script.json found — restarting from build stage');
        restartFromBuild();
      } else {
        log('No demo-script.json — starting full fresh pipeline');
        startFreshPipeline();
      }
    } else {
      log(`Pipeline is active. Last activity ${ageMin} min ago. OK.`);
    }
  } else {
    log('No run directory found yet — pipeline may be in early stages. OK.');
  }

  log('=== Check complete ===');
}

// ── Entry point ───────────────────────────────────────────────────────────────

const isDaemon = process.argv.includes('--daemon');

if (isDaemon) {
  log(`Watchdog daemon started (check interval: ${Math.round(DAEMON_INTERVAL / 60000)} min)`);
  runCheck().catch(err => log(`Check error: ${err.message}`));
  setInterval(() => {
    runCheck().catch(err => log(`Check error: ${err.message}`));
  }, DAEMON_INTERVAL);
} else {
  // Single check (for cron usage)
  runCheck()
    .then(() => process.exit(0))
    .catch(err => {
      log(`Fatal: ${err.message}`);
      process.exit(1);
    });
}
