'use strict';

/**
 * pipeline-heartbeat.js
 * Orchestrator-driven periodic heartbeat (default 5 min) independent of stage completion.
 *
 * Emits on three channels per tick:
 *   1. Structured stdout  ::PIPE:: event=heartbeat …
 *   2. pipeline-build.log.md section [HEARTBEAT] tick=N
 *   3. runDir/pipeline-heartbeat.json sentinel (atomic rewrite)
 */

const fs = require('fs');
const path = require('path');
const { appendPipelineLogSection } = require('./pipeline-logger');
const { getRunLayout } = require('./run-io');

const DEFAULT_HEARTBEAT_MS = 300000;
const HEARTBEAT_SENTINEL = 'pipeline-heartbeat.json';
const HEARTBEAT_STDOUT_RE = /^::PIPE::\s+event=heartbeat\b/;

function parseHeartbeatIntervalMs(envValue) {
  const raw = envValue != null ? envValue : process.env.PIPELINE_HEARTBEAT_MS;
  const n = parseInt(String(raw == null ? DEFAULT_HEARTBEAT_MS : raw), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function cliPipeEscape(value) {
  const s = String(value == null ? '' : value);
  if (!/[\s"=]/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Canonical single-line stdout marker (regex anchor for notify_on_output).
 */
function formatHeartbeatStdoutLine(fields = {}) {
  const parts = ['event=heartbeat'];
  const ordered = [
    'tick',
    'runId',
    'stage',
    'stageElapsedSec',
    'pipelineElapsedSec',
    'awaitingContinue',
    'lastLogActivitySec',
    'at',
  ];
  for (const key of ordered) {
    if (fields[key] == null) continue;
    parts.push(`${key}=${cliPipeEscape(fields[key])}`);
  }
  return `::PIPE:: ${parts.join('  ')}`;
}

function readHeartbeatSentinel(runDir) {
  if (!runDir) return null;
  const file = path.join(runDir, HEARTBEAT_SENTINEL);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * @param {object|null} sentinel - pipeline-heartbeat.json payload
 * @param {boolean} running - orchestrator PID still alive
 * @param {number} [nowMs]
 */
function computeHeartbeatFreshness(sentinel, running, nowMs = Date.now()) {
  const intervalMs =
    sentinel && Number.isFinite(Number(sentinel.intervalMs))
      ? Number(sentinel.intervalMs)
      : parseHeartbeatIntervalMs();
  const lastAt = sentinel && sentinel.lastHeartbeatAt
    ? String(sentinel.lastHeartbeatAt)
    : null;
  let lastHeartbeatAgeSec = null;
  if (lastAt) {
    const t = Date.parse(lastAt);
    if (Number.isFinite(t)) {
      lastHeartbeatAgeSec = Math.max(0, Math.round((nowMs - t) / 1000));
    }
  }
  const staleThresholdSec = intervalMs > 0 ? Math.round((intervalMs * 2) / 1000) : null;
  const heartbeatStale = !!(
    running &&
    intervalMs > 0 &&
    lastHeartbeatAgeSec != null &&
    staleThresholdSec != null &&
    lastHeartbeatAgeSec > staleThresholdSec
  );
  return {
    lastHeartbeatAt: lastAt,
    lastHeartbeatAgeSec,
    heartbeatStale,
    heartbeatIntervalMs: intervalMs > 0 ? intervalMs : null,
  };
}

function resolveCurrentRunningStage(runDir) {
  const { computeStageList } = require('./stage-state');
  const { runningStage } = computeStageList(runDir);
  return runningStage || null;
}

function computeLastLogActivitySec(runDir) {
  if (!runDir) return null;
  const layout = getRunLayout(runDir);
  const logFile = path.join(layout.logsDir, 'pipeline-build.log.md');
  try {
    const st = fs.statSync(logFile);
    return Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000));
  } catch (_) {
    return null;
  }
}

function isAwaitingContinue(runDir) {
  const sig = path.join(runDir, 'continue.signal.request');
  try {
    return fs.existsSync(sig);
  } catch (_) {
    return false;
  }
}

function readActivePid(runDir) {
  const { readPid } = require('./stage-state');
  return readPid(runDir);
}

function writeHeartbeatSentinel(runDir, payload) {
  const file = path.join(runDir, HEARTBEAT_SENTINEL);
  const tmp = `${file}.tmp`;
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Emit one heartbeat tick (stdout + log section + sentinel).
 * @param {object} state
 * @param {string} state.runDir
 * @param {number} state.tick
 * @param {number} state.intervalMs
 * @param {number} state.pipelineElapsedSec
 * @param {string|null} state.runningStage
 * @param {number} state.stageElapsedSec
 * @param {number|null} state.lastLogActivitySec
 * @param {boolean} state.awaitingContinue
 * @param {number|null} [state.activePid]
 */
function emitHeartbeat(state = {}) {
  const runDir = String(state.runDir || process.env.PIPELINE_RUN_DIR || '').trim();
  if (!runDir) return null;

  const now = new Date();
  const atIso = now.toISOString();
  const runId = path.basename(path.resolve(runDir));
  const runningStage = state.runningStage != null ? state.runningStage : null;
  const stageLabel = runningStage || 'none';
  const activePid = state.activePid != null ? state.activePid : readActivePid(runDir);
  const lastLogSec = state.lastLogActivitySec != null
    ? state.lastLogActivitySec
    : computeLastLogActivitySec(runDir);

  const payload = {
    schemaVersion: 1,
    lastHeartbeatAt: atIso,
    intervalMs: state.intervalMs || parseHeartbeatIntervalMs(),
    tick: state.tick || 1,
    runningStage: runningStage || null,
    stageElapsedSec: state.stageElapsedSec != null ? state.stageElapsedSec : 0,
    pipelineElapsedSec: state.pipelineElapsedSec != null ? state.pipelineElapsedSec : 0,
    awaitingContinue: !!state.awaitingContinue,
    lastLogActivityAt: lastLogSec != null ? new Date(now.getTime() - lastLogSec * 1000).toISOString() : null,
    lastLogActivitySec: lastLogSec,
    activePid: activePid || null,
  };

  writeHeartbeatSentinel(runDir, payload);

  appendPipelineLogSection(`[HEARTBEAT] tick=${payload.tick}`, [
    `tick=${payload.tick}`,
    `runId=${runId}`,
    `stage=${stageLabel}`,
    `stageElapsedSec=${payload.stageElapsedSec}`,
    `pipelineElapsedSec=${payload.pipelineElapsedSec}`,
    `awaitingContinue=${payload.awaitingContinue}`,
    `lastLogActivitySec=${lastLogSec != null ? lastLogSec : 'unknown'}`,
    `activePid=${activePid || 'none'}`,
  ], { runDir });

  const stdoutLine = formatHeartbeatStdoutLine({
    tick: payload.tick,
    runId,
    stage: stageLabel,
    stageElapsedSec: payload.stageElapsedSec,
    pipelineElapsedSec: payload.pipelineElapsedSec,
    awaitingContinue: payload.awaitingContinue,
    lastLogActivitySec: lastLogSec != null ? lastLogSec : '',
    at: atIso,
  });
  console.log(stdoutLine);

  return { payload, stdoutLine };
}

/**
 * Start periodic heartbeat timer. Returns { stop, timer }.
 * @param {object} opts
 * @param {string} opts.runDir
 * @param {number} [opts.intervalMs]
 * @param {function} [opts.warn] - optional logger for tick failures
 */
function startPipelineHeartbeat(opts = {}) {
  const runDir = String(opts.runDir || process.env.PIPELINE_RUN_DIR || '').trim();
  const intervalMs = opts.intervalMs != null ? opts.intervalMs : parseHeartbeatIntervalMs();
  if (!runDir || intervalMs <= 0) {
    return { stop() {}, timer: null, intervalMs: 0 };
  }

  const startedAt = Date.now();
  let tickIndex = 0;
  let lastStage = null;
  let stageStartedAt = Date.now();

  function tick() {
    try {
      tickIndex += 1;
      const now = Date.now();
      const runningStage = resolveCurrentRunningStage(runDir);
      if (runningStage !== lastStage) {
        stageStartedAt = now;
        lastStage = runningStage;
      }
      const activePid = readActivePid(runDir);
      emitHeartbeat({
        runDir,
        tick: tickIndex,
        intervalMs,
        pipelineElapsedSec: Math.round((now - startedAt) / 1000),
        runningStage,
        stageElapsedSec: runningStage ? Math.round((now - stageStartedAt) / 1000) : 0,
        lastLogActivitySec: computeLastLogActivitySec(runDir),
        awaitingContinue: isAwaitingContinue(runDir) && !!activePid,
        activePid,
      });
    } catch (err) {
      const warn = opts.warn || (() => {});
      warn(`[Orchestrator] Heartbeat tick failed: ${err.message}`);
    }
  }

  // First tick soon after boot so agents see liveness without waiting 5 min.
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    timer,
    intervalMs,
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

module.exports = {
  DEFAULT_HEARTBEAT_MS,
  HEARTBEAT_SENTINEL,
  HEARTBEAT_STDOUT_RE,
  parseHeartbeatIntervalMs,
  formatHeartbeatStdoutLine,
  readHeartbeatSentinel,
  computeHeartbeatFreshness,
  resolveCurrentRunningStage,
  computeLastLogActivitySec,
  isAwaitingContinue,
  emitHeartbeat,
  startPipelineHeartbeat,
};
