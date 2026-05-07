'use strict';

/**
 * Prevents two orchestrator processes from running concurrently against the same run dir.
 * Stale locks (dead PID) are removed automatically. Override with PIPELINE_FORCE=1.
 */

const fs = require('fs');
const path = require('path');

function lockPathForRunDir(runDir) {
  return path.join(runDir, 'artifacts', 'pipeline.lock.json');
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * @param {string} runDir
 * @param {{ force?: boolean, log?: (s:string)=>void }} [opts]
 * @returns {{ acquired: boolean, reason?: string, previousPid?: number }}
 */
function acquirePipelineLock(runDir, opts = {}) {
  const log = opts.log || (() => {});
  const force = !!opts.force || String(process.env.PIPELINE_FORCE || '').trim() === '1';
  const lp = lockPathForRunDir(runDir);
  fs.mkdirSync(path.dirname(lp), { recursive: true });

  if (fs.existsSync(lp)) {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(lp, 'utf8'));
    } catch (_) {}
    const prevPid = data && Number(data.pid);
    if (prevPid && isPidAlive(prevPid)) {
      if (!force) {
        log(`[pipeline-lock] Another orchestrator holds the lock (pid=${prevPid}). Set PIPELINE_FORCE=1 only if that process is stale.`);
        return { acquired: false, reason: 'locked', previousPid: prevPid };
      }
      log(`[pipeline-lock] PIPELINE_FORCE=1 — overwriting lock despite pid ${prevPid}.`);
    }
    try {
      fs.unlinkSync(lp);
    } catch (_) {}
  }

  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: (() => {
      try {
        return require('os').hostname();
      } catch (_) {
        return null;
      }
    })(),
  };
  fs.writeFileSync(lp, JSON.stringify(payload, null, 2), 'utf8');
  log(`[pipeline-lock] Acquired ${path.relative(process.cwd(), lp)} (pid=${process.pid}).`);
  return { acquired: true };
}

function releasePipelineLock(runDir) {
  const lp = lockPathForRunDir(runDir);
  if (!fs.existsSync(lp)) return;
  try {
    const data = JSON.parse(fs.readFileSync(lp, 'utf8'));
    const pid = data && Number(data.pid);
    if (pid === process.pid) {
      fs.unlinkSync(lp);
    }
  } catch (_) {
    try {
      fs.unlinkSync(lp);
    } catch (_) {}
  }
}

module.exports = {
  acquirePipelineLock,
  releasePipelineLock,
  lockPathForRunDir,
};
