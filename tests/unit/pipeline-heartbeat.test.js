'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const heartbeat = require(path.join(PROJECT_ROOT, 'scripts/scratch/utils/pipeline-heartbeat.js'));
const stageState = require(path.join(PROJECT_ROOT, 'scripts/scratch/utils/stage-state.js'));
const { getRunLayout } = require(path.join(PROJECT_ROOT, 'scripts/scratch/utils/run-io.js'));

function mkRunDir() {
  const dir = fs.mkdtempSync(path.join(PROJECT_ROOT, 'out', 'heartbeat-test-'));
  const layout = getRunLayout(dir);
  fs.mkdirSync(layout.logsDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-manifest.json'), JSON.stringify({
    runId: path.basename(dir),
    buildMode: 'app-only',
    mode: 'scratch',
    createdAt: new Date().toISOString(),
  }), 'utf8');
  fs.writeFileSync(path.join(dir, '.pipeline.pid'), `${process.pid}\n`, 'utf8');
  return dir;
}

describe('pipeline-heartbeat.emitHeartbeat', () => {
  let runDir;
  let stdoutLines;
  let origLog;

  beforeEach(() => {
    runDir = mkRunDir();
    stdoutLines = [];
    origLog = console.log;
    console.log = (...args) => {
      stdoutLines.push(args.join(' '));
    };
    process.env.PIPELINE_RUN_DIR = runDir;
  });

  afterEach(() => {
    console.log = origLog;
    delete process.env.PIPELINE_RUN_DIR;
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('writes sentinel JSON, log section, and stdout line', () => {
    const out = heartbeat.emitHeartbeat({
      runDir,
      tick: 3,
      intervalMs: 300000,
      pipelineElapsedSec: 120,
      runningStage: 'build-qa',
      stageElapsedSec: 45,
      lastLogActivitySec: 12,
      awaitingContinue: false,
      activePid: process.pid,
    });

    assert.ok(out && out.payload);
    assert.equal(out.payload.schemaVersion, 1);
    assert.equal(out.payload.tick, 3);
    assert.equal(out.payload.runningStage, 'build-qa');

    const sentinelPath = path.join(runDir, heartbeat.HEARTBEAT_SENTINEL);
    assert.ok(fs.existsSync(sentinelPath));
    const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    assert.equal(sentinel.tick, 3);
    assert.equal(sentinel.intervalMs, 300000);

    const logPath = path.join(runDir, 'artifacts', 'logs', 'pipeline-build.log.md');
    const logText = fs.readFileSync(logPath, 'utf8');
    assert.match(logText, /\[HEARTBEAT\] tick=3/);
    assert.match(logText, /stage=build-qa/);

    assert.equal(stdoutLines.length, 1);
    assert.match(stdoutLines[0], heartbeat.HEARTBEAT_STDOUT_RE);
    assert.match(stdoutLines[0], /tick=3/);
    assert.match(stdoutLines[0], /stage=build-qa/);
    assert.match(stdoutLines[0], /awaitingContinue=false/);
  });

  test('stdout line uses stage=none when runningStage is null', () => {
    heartbeat.emitHeartbeat({
      runDir,
      tick: 1,
      intervalMs: 300000,
      pipelineElapsedSec: 5,
      runningStage: null,
      stageElapsedSec: 0,
      awaitingContinue: false,
    });
    assert.match(stdoutLines[0], /stage=none/);
  });
});

describe('pipeline-heartbeat.computeHeartbeatFreshness', () => {
  test('heartbeatStale when running and age exceeds 2x interval', () => {
    const intervalMs = 300000;
    const staleAt = new Date(Date.now() - intervalMs * 2 - 5000).toISOString();
    const fresh = heartbeat.computeHeartbeatFreshness({
      lastHeartbeatAt: staleAt,
      intervalMs,
    }, true);
    assert.equal(fresh.heartbeatStale, true);
    assert.ok(fresh.lastHeartbeatAgeSec > intervalMs * 2 / 1000);
  });

  test('not stale when not running even if age is high', () => {
    const intervalMs = 300000;
    const staleAt = new Date(Date.now() - intervalMs * 3).toISOString();
    const fresh = heartbeat.computeHeartbeatFreshness({
      lastHeartbeatAt: staleAt,
      intervalMs,
    }, false);
    assert.equal(fresh.heartbeatStale, false);
  });

  test('computeStatus surfaces heartbeat fields from sentinel', () => {
    const runDir = mkRunDir();
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(runDir, heartbeat.HEARTBEAT_SENTINEL), JSON.stringify({
      schemaVersion: 1,
      lastHeartbeatAt: at,
      intervalMs: 300000,
      tick: 2,
      runningStage: 'build',
      stageElapsedSec: 10,
      pipelineElapsedSec: 100,
      awaitingContinue: false,
      lastLogActivitySec: 5,
      activePid: process.pid,
    }, null, 2), 'utf8');

    const status = stageState.computeStatus(runDir);
    assert.equal(status.lastHeartbeatAt, at);
    assert.ok(status.lastHeartbeatAgeSec != null);
    assert.equal(status.heartbeatIntervalMs, 300000);
    assert.equal(status.heartbeatStale, false);

    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (_) {}
  });
});

describe('pipeline-heartbeat.startPipelineHeartbeat', () => {
  test('emits multiple ticks mid-wait independent of stage completion', async () => {
    const runDir = mkRunDir();
    process.env.PIPELINE_RUN_DIR = runDir;
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };

    const handle = heartbeat.startPipelineHeartbeat({
      runDir,
      intervalMs: 200,
    });

    await new Promise((r) => setTimeout(r, 850));
    handle.stop();
    console.log = origLog;
    delete process.env.PIPELINE_RUN_DIR;

    const hbLines = lines.filter((l) => heartbeat.HEARTBEAT_STDOUT_RE.test(l));
    assert.ok(hbLines.length >= 3, `expected >=3 heartbeat lines, got ${hbLines.length}`);

    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('stop clears interval (no further ticks after stop)', async () => {
    const runDir = mkRunDir();
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };

    const handle = heartbeat.startPipelineHeartbeat({ runDir, intervalMs: 100 });
    await new Promise((r) => setTimeout(r, 250));
    handle.stop();
    const countAfterStop = lines.filter((l) => heartbeat.HEARTBEAT_STDOUT_RE.test(l)).length;
    await new Promise((r) => setTimeout(r, 350));
    const countLater = lines.filter((l) => heartbeat.HEARTBEAT_STDOUT_RE.test(l)).length;
    console.log = origLog;

    assert.equal(countAfterStop, countLater);

    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch (_) {}
  });
});
