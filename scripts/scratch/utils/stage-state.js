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
  'api-panel-audit',
  'api-panel-complete',
  'app-touchup',
  'slide-fix',
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
  'api-panel-audit':        ['api-panel-audit.json'],
  'app-touchup':            ['app-touchup-report.json'],
  'slide-fix':              ['slide-fix-report.json'],
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

/**
 * Read the latest qa-report-build.json. Returns null if missing or unreadable.
 * Used by recovery-hint logic to surface tier-aware suggestions.
 */
function readBuildQaReport(runDir) {
  return safeReadJson(path.join(runDir, 'qa-report-build.json'));
}

/**
 * Tier-aware recovery-command resolver. Returns a `npm run pipe -- …`
 * command tailored to the QA report's `recommendedRecovery` field, or null
 * when no tier-scoped recovery applies. The caller should still apply the
 * generic stage-state fallbacks (failed / pending) when this returns null.
 */
function resolveTierRecoveryCommand(runDir, runId) {
  const report = readBuildQaReport(runDir);
  if (!report) return null;
  const rec = String(report.recommendedRecovery || '').toLowerCase();
  if (!rec || rec === 'fullbuild') return null;
  if (rec === 'app-touchup') {
    return `npm run pipe -- app-touchup ${runId} --non-interactive`;
  }
  if (rec === 'slide-fix') {
    return `npm run pipe -- slide-fix ${runId} --non-interactive`;
  }
  if (rec === 'app-touchup+slide-fix') {
    // App-tier failures gate slide-fix (see slide-fix.main requireAppPassed).
    // Recommend app-touchup first; slide-fix is the natural follow-up.
    return `npm run pipe -- app-touchup ${runId} --non-interactive`;
  }
  return null;
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
 * Stages that only run when build-qa indicates the matching tier failed.
 * When the QA report's tierSummary says the tier already passed (or is
 * skipped on app-only), the stage is treated as "skipped" rather than
 * "pending" so `firstPending` and `nextRecoveryCommand` ignore it.
 */
const CONDITIONAL_STAGES = {
  'app-touchup': (tierSummary) => tierSummary && tierSummary.app && tierSummary.app.passed,
  'slide-fix':   (tierSummary) => tierSummary && tierSummary.slide && (tierSummary.slide.passed || tierSummary.slide.skipped),
};

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
  const qaReport = readBuildQaReport(runDir);
  const tierSummary = qaReport && qaReport.tierSummary ? qaReport.tierSummary : null;
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

    // Tier-conditional stages: when the precondition (matching tier already
    // passed in the latest build-qa report) is met, treat as 'skipped'.
    // This stops `pipe status` from advertising app-touchup / slide-fix as
    // pending on green builds, which would falsely look like work to do.
    if (status === 'pending' && CONDITIONAL_STAGES[stage]) {
      const precondition = CONDITIONAL_STAGES[stage];
      if (precondition(tierSummary)) status = 'skipped';
    }

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
  //   awaiting cont.   → `pipe continue`                  (highest priority)
  //   tier failure     → `pipe app-touchup / slide-fix`   (tier-scoped, no build-app)
  //   failed stage     → `pipe stage <that>`
  //   has pending      → `pipe resume --from=<next>`
  //   all complete     → null
  let nextRecoveryCommand = null;
  if (continueReq && activePid) {
    nextRecoveryCommand = `npm run pipe -- continue ${runId}`;
  } else {
    // Prefer the tier-aware lane when the most recent build-qa report says so.
    // This keeps the recovery command surgical (no `build-app`) when the
    // failure is localized to one tier.
    const tierCmd = !activePid ? resolveTierRecoveryCommand(runDir, runId) : null;
    if (tierCmd) {
      nextRecoveryCommand = tierCmd;
    } else if (firstFailed) {
      nextRecoveryCommand = `npm run pipe -- stage ${firstFailed} ${runId}`;
    } else if (firstPending && !activePid) {
      nextRecoveryCommand = `npm run pipe -- resume ${runId} --from=${firstPending}`;
    }
  }

  // Surface tier summary so dashboards / agents can read it without parsing
  // the full QA report.
  const qaReport = readBuildQaReport(runDir);
  const tierSummary = qaReport && qaReport.tierSummary ? qaReport.tierSummary : null;
  const recommendedRecovery = qaReport ? qaReport.recommendedRecovery || null : null;

  let heartbeatFields = {
    lastHeartbeatAt: null,
    lastHeartbeatAgeSec: null,
    heartbeatStale: false,
    heartbeatIntervalMs: null,
  };
  try {
    const {
      readHeartbeatSentinel,
      computeHeartbeatFreshness,
    } = require('./pipeline-heartbeat');
    const sentinel = readHeartbeatSentinel(runDir);
    heartbeatFields = computeHeartbeatFreshness(sentinel, !!activePid);
  } catch (_) { /* ignore */ }

  return {
    runId,
    runDir: path.resolve(runDir),
    buildMode: (manifest ? manifest.buildMode : null) || (qaReport ? qaReport.buildMode || null : null),
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
      skipped: stages.filter(s => s.status === 'skipped').length,
    },
    firstPending,
    firstFailed,
    tierSummary,
    recommendedRecovery,
    nextRecoveryCommand,
    lastHeartbeatAt: heartbeatFields.lastHeartbeatAt,
    lastHeartbeatAgeSec: heartbeatFields.lastHeartbeatAgeSec,
    heartbeatStale: heartbeatFields.heartbeatStale,
    heartbeatIntervalMs: heartbeatFields.heartbeatIntervalMs,
  };
}

module.exports = {
  STAGES,
  STAGE_SENTINELS,
  computeStatus,
  computeStageList,
  readManifest,
  readPid,
  readBuildQaReport,
  resolveTierRecoveryCommand,
};
