'use strict';

/**
 * stage-state.js
 * Canonical view of pipeline stage status derived from the run directory.
 *
 * Used by:
 *   - bin/pipe.js (CLI status + recovery recommendations)
 *   - scripts/dashboard/server.js (GET /api/runs/:runId/stage-state endpoint)
 *   - Claude-facing JSON output
 *
 * Source of truth order (highest → lowest priority):
 *   1. pipeline-progress.json (written by orchestrator.writePipelineProgress)
 *   2. pipeline-build.log.md MILESTONE entries (stage start/end/failed)
 *   3. Artifact sentinel presence on disk
 *
 * Keep STAGES in lockstep with scripts/scratch/orchestrator.js STAGES and
 * scripts/dashboard/server.js PIPELINE_STAGES. This module is read-only.
 */

const fs = require('fs');
const path = require('path');

// Canonical stage order — must match orchestrator.js STAGES.
const STAGES = [
  'research',
  'ingest',
  'script',
  'brand-extract',
  'script-critique',
  'embed-script-validate',
  'build',
  'plaid-link-qa',
  'build-qa',
  'post-slides',
  'post-panels',
  'record',
  'qa',
  'figma-review',
  'post-process',
  'voiceover',
  'coverage-check',
  'auto-gap',
  'resync-audio',
  'embed-sync',
  'audio-qa',
  'ai-suggest-overlays',
  'render',
  'ppt',
  'touchup',
];

// Artifact sentinel(s) per stage, relative to the run directory. First match wins.
const STAGE_SENTINELS = {
  'research':               ['product-research.json', 'research-notes.md'],
  'ingest':                 ['product-context.json'],
  'script':                 ['demo-script.json'],
  'brand-extract':          ['brand-extract.json'],
  'script-critique':        ['script-critique.json'],
  'embed-script-validate':  ['script-validate-report.json'],
  'build':                  ['scratch-app/index.html'],
  'plaid-link-qa':          ['plaid-link-qa.json'],
  'build-qa':               ['build-qa-diagnostics.json', 'qa-report-build.json'],
  'post-slides':            ['post-slides-report.json', 'artifacts/build/post-slides-report.json'],
  'post-panels':            ['post-panels-report.json', 'artifacts/build/post-panels-report.json'],
  'record':                 ['recording.webm', 'recording.mp4'],
  'qa':                     ['qa-report-1.json'],
  'figma-review':           ['figma-review.json'],
  'post-process':           ['recording-processed.webm', 'recording-processed.mp4'],
  'voiceover':              ['voiceover-manifest.json', 'voiceover.mp3'],
  'coverage-check':         ['coverage-report.json'],
  'auto-gap':               ['auto-gap-report.json'],
  'resync-audio':           ['sync-map.json'],
  'embed-sync':             ['embed-sync-report.json'],
  'audio-qa':               ['audio-qa-report.json'],
  'ai-suggest-overlays':    ['overlay-suggestions.json'],
  'render':                 ['demo-scratch.mp4', 'artifacts/media/final.mp4'],
  'ppt':                    ['demo-summary.pptx'],
  'touchup':                ['touchup-complete.json'],
};

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch (_) {
    return null;
  }
}

function sentinelHit(runDir, stage) {
  const candidates = STAGE_SENTINELS[stage] || [];
  for (const rel of candidates) {
    const full = path.join(runDir, rel);
    const st = safeStat(full);
    if (st && (st.isFile() ? st.size > 0 : true)) {
      return { file: rel, fullPath: full, size: st.isFile() ? st.size : null };
    }
  }
  return null;
}

/**
 * Parse stage milestones out of artifacts/logs/pipeline-build.log.md.
 * Returns { [stage]: { startedAt, endedAt, status, elapsedSeconds, error } }.
 */
function parseMilestonesFromLog(runDir) {
  const logFile = path.join(runDir, 'artifacts', 'logs', 'pipeline-build.log.md');
  const text = safeRead(logFile);
  if (!text) return {};
  const map = {};
  // Sections look like:
  //   ## [MILESTONE] Stage build started
  //   - at: `2026-...`
  //   - stage=build
  //   - status=started
  const re = /## \[MILESTONE\] Stage ([a-z0-9-]+) (started|completed|failed)([\s\S]*?)(?=\n## |\n# |$)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const stage = m[1];
    const phase = m[2];
    const body = m[3] || '';
    const atMatch = body.match(/at[:=]\s*`?([^\n`]+)/);
    const elapsedMatch = body.match(/elapsedSeconds[:=]\s*`?([0-9.]+)/);
    const errorMatch = body.match(/error[:=]\s*`?([^\n`]+)/);
    if (!map[stage]) map[stage] = {};
    if (phase === 'started') {
      map[stage].startedAt = atMatch ? atMatch[1].trim() : null;
      map[stage].status = map[stage].status || 'running';
    } else if (phase === 'completed') {
      map[stage].endedAt = atMatch ? atMatch[1].trim() : null;
      map[stage].status = 'completed';
      if (elapsedMatch) map[stage].elapsedSeconds = Number(elapsedMatch[1]);
    } else if (phase === 'failed') {
      map[stage].endedAt = atMatch ? atMatch[1].trim() : null;
      map[stage].status = 'failed';
      if (elapsedMatch) map[stage].elapsedSeconds = Number(elapsedMatch[1]);
      if (errorMatch) map[stage].lastError = errorMatch[1].trim();
    }
  }
  return map;
}

function readProgressFile(runDir) {
  const progress = safeReadJson(path.join(runDir, 'pipeline-progress.json'));
  if (!progress || typeof progress !== 'object') return null;
  return progress;
}

function readManifest(runDir) {
  return safeReadJson(path.join(runDir, 'run-manifest.json'));
}

function readPid(runDir) {
  const raw = safeRead(path.join(runDir, '.pipeline.pid'));
  if (!raw) return null;
  const pid = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  // Verify process exists. process.kill(pid, 0) throws if not.
  try {
    process.kill(pid, 0);
    return pid;
  } catch (_) {
    return null;
  }
}

function readContinueSignal(runDir) {
  const sigFile = path.join(runDir, 'continue.signal.request');
  const text = safeRead(sigFile);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return { stage: 'unknown', reason: String(text).trim() };
  }
}

/**
 * Compute stage list with status, durations, and error hints.
 * Returns the canonical stage array (always length === STAGES.length).
 */
function computeStageList(runDir) {
  const progress = readProgressFile(runDir);
  const completedSet = new Set(
    progress && Array.isArray(progress.completedStages) ? progress.completedStages : []
  );
  const milestones = parseMilestonesFromLog(runDir);
  const out = [];
  let firstPending = null;
  let firstFailed = null;
  let runningStage = null;

  for (const stage of STAGES) {
    const m = milestones[stage] || {};
    const sentinel = sentinelHit(runDir, stage);
    let status;
    if (m.status === 'failed') status = 'failed';
    else if (m.status === 'completed' || completedSet.has(stage) || sentinel) status = 'completed';
    else if (m.status === 'running') status = 'running';
    else status = 'pending';

    if (status === 'running' && !runningStage) runningStage = stage;
    if (status === 'failed' && !firstFailed) firstFailed = stage;
    if (status === 'pending' && !firstPending) firstPending = stage;

    const entry = {
      name: stage,
      status,
    };
    if (m.startedAt) entry.startedAt = m.startedAt;
    if (m.endedAt) entry.endedAt = m.endedAt;
    if (m.elapsedSeconds != null) entry.durationSec = m.elapsedSeconds;
    if (m.lastError) entry.lastError = m.lastError;
    if (sentinel) {
      entry.sentinel = sentinel.file;
      if (sentinel.size != null) entry.sentinelSize = sentinel.size;
    }
    out.push(entry);
  }

  return { stages: out, firstPending, firstFailed, runningStage };
}

/**
 * Produce the full status object used by pipe status --json and the
 * dashboard header badge. Stable schema for Claude consumption.
 */
function computeStatus(runDir) {
  const runId = path.basename(path.resolve(runDir));
  const manifest = readManifest(runDir);
  const { stages, firstPending, firstFailed, runningStage } = computeStageList(runDir);
  const activePid = readPid(runDir);
  const continueReq = readContinueSignal(runDir);

  // Recovery hint logic:
  //   failed stage    → `pipe stage <that>` (single-stage retry first)
  //   awaiting cont.  → `pipe continue`
  //   has pending     → `pipe resume --from=<next>`
  //   all complete    → null
  let nextRecoveryCommand = null;
  if (continueReq && activePid) {
    nextRecoveryCommand = `npm run pipe -- continue ${runId}`;
  } else if (firstFailed) {
    nextRecoveryCommand = `npm run pipe -- stage ${firstFailed} ${runId}`;
  } else if (firstPending && !activePid) {
    nextRecoveryCommand = `npm run pipe -- resume ${runId} --from=${firstPending}`;
  }

  return {
    runId,
    runDir: path.resolve(runDir),
    buildMode: manifest ? manifest.buildMode || null : null,
    mode: manifest ? manifest.mode || null : null,
    createdAt: manifest ? manifest.createdAt || null : null,
    updatedAt: manifest ? manifest.updatedAt || null : null,
    activePid: activePid || null,
    running: !!activePid,
    runningStage: runningStage || null,
    awaitingContinue: !!(continueReq && activePid),
    continueContext: continueReq || null,
    stages,
    counts: {
      total: stages.length,
      completed: stages.filter(s => s.status === 'completed').length,
      failed: stages.filter(s => s.status === 'failed').length,
      pending: stages.filter(s => s.status === 'pending').length,
      running: stages.filter(s => s.status === 'running').length,
    },
    firstPending,
    firstFailed,
    nextRecoveryCommand,
  };
}

module.exports = {
  STAGES,
  STAGE_SENTINELS,
  computeStatus,
  computeStageList,
  readManifest,
  readPid,
};
