'use strict';

/**
 * stage-remote-run.js
 *
 * Bridge between the shared artifact clone (`~/.plaid-demo-apps/demos/<owner>/<runId>/`)
 * and the dashboard's launcher, which only knows how to serve runs from
 * `<repo>/out/demos/<runId>/`. The dashboard lists remote-published demos
 * alongside local ones (see `readRemotePublishedApps` in server.js), but its
 * `launchDemoAppServer` hard-codes the local path. Instead of teaching the
 * launcher two code paths (and leaking remote mutations back into the shared
 * clone), on first Launch we copy the published bundle into `out/demos/` so
 * it behaves like any other user-owned run thereafter.
 *
 * Pure helpers:
 *   - resolveArtifactDir()        reads PLAID_DEMO_APPS_DIR or ~/.plaid-demo-apps
 *   - findRemoteRunOnDisk(runId)  scans owner subdirs; returns { runDir, owner } | null
 *   - stageRemoteRunLocally(...)  recursively copies remoteRunDir → destRunDir,
 *                                 leaving the source untouched. Idempotent.
 *
 * No express / dashboard imports here — kept zero-dep so unit tests can run
 * without spinning the server. Server.js passes its DEMOS_DIR into
 * `stageRemoteRunLocally` so the helper stays agnostic of the project root.
 */

const fs = require('fs');
const path = require('path');

function resolveArtifactDir() {
  const envDir = process.env.PLAID_DEMO_APPS_DIR && String(process.env.PLAID_DEMO_APPS_DIR).trim();
  if (envDir) return envDir;
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return path.join(home, '.plaid-demo-apps');
}

/**
 * Locate a published run inside the artifact clone.
 *
 * Matches `<artifactDir>/demos/<login>/<runId>/` where `scratch-app/index.html`
 * is present (so we never stage something that will immediately fail to launch).
 *
 * @param {string} runId
 * @param {{ artifactDir?: string }} [opts]
 * @returns {{ runDir: string, owner: string } | null}
 */
function findRemoteRunOnDisk(runId, opts = {}) {
  if (!runId || typeof runId !== 'string') return null;
  const base = opts.artifactDir || resolveArtifactDir();
  const demosRoot = path.join(base, 'demos');
  if (!fs.existsSync(demosRoot)) return null;
  let users;
  try { users = fs.readdirSync(demosRoot); } catch (_) { return null; }
  for (const userLogin of users) {
    const candidate = path.join(demosRoot, userLogin, runId);
    let st;
    try { st = fs.statSync(candidate); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    if (!fs.existsSync(path.join(candidate, 'scratch-app', 'index.html'))) continue;
    return { runDir: candidate, owner: userLogin };
  }
  return null;
}

/**
 * Copy a published run bundle into the local runs directory. Idempotent:
 * if `destDir/scratch-app/index.html` already exists, the copy is skipped
 * and the existing path is returned.
 *
 * Failure modes:
 *   - Throws if `remoteRunDir` does not exist.
 *   - If the recursive copy aborts partway (disk full, permission error),
 *     the partial `destDir` is removed before rethrowing so the next attempt
 *     starts clean.
 *
 * @param {{ runId: string, remoteRunDir: string, demosDir: string }} args
 * @returns {string} absolute path to the staged local run directory
 */
function stageRemoteRunLocally({ runId, remoteRunDir, demosDir }) {
  if (!runId) throw new Error('stageRemoteRunLocally: runId required');
  if (!demosDir) throw new Error('stageRemoteRunLocally: demosDir required');
  if (!remoteRunDir || !fs.existsSync(remoteRunDir)) {
    throw new Error(`stageRemoteRunLocally: remote runDir not found: ${remoteRunDir}`);
  }
  const destDir = path.join(demosDir, runId);
  const destIndex = path.join(destDir, 'scratch-app', 'index.html');
  if (fs.existsSync(destIndex)) return destDir;
  fs.mkdirSync(demosDir, { recursive: true });
  try {
    // Node 20+ has stable fs.cpSync with recursive copy. errorOnExist:false
    // lets an earlier partial stage merge cleanly on retry.
    fs.cpSync(remoteRunDir, destDir, { recursive: true, force: false });
  } catch (err) {
    try {
      if (fs.existsSync(destDir) && !fs.existsSync(destIndex)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
    } catch (_) { /* ignore cleanup errors */ }
    throw new Error(
      `stageRemoteRunLocally: copy failed (${remoteRunDir} → ${destDir}): ${err.message}`
    );
  }
  try {
    fs.writeFileSync(
      path.join(destDir, 'STAGED_FROM_ARTIFACT.json'),
      JSON.stringify({
        runId,
        stagedAt: new Date().toISOString(),
        sourceDir: remoteRunDir,
      }, null, 2),
      'utf8'
    );
  } catch (_) { /* sentinel is best-effort */ }
  return destDir;
}

module.exports = {
  resolveArtifactDir,
  findRemoteRunOnDisk,
  stageRemoteRunLocally,
};
