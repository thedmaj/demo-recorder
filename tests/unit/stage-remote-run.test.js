'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveArtifactDir,
  findRemoteRunOnDisk,
  stageRemoteRunLocally,
} = require('../../scripts/dashboard/utils/stage-remote-run.js');

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function writeFile(fp, contents) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, contents, 'utf8');
}

function seedRemoteRun(artifactDir, owner, runId) {
  const runDir = path.join(artifactDir, 'demos', owner, runId);
  writeFile(path.join(runDir, 'scratch-app', 'index.html'), '<html>demo</html>');
  writeFile(path.join(runDir, 'demo-script.json'), JSON.stringify({ runId }));
  writeFile(path.join(runDir, 'PUBLISH_MANIFEST.json'), JSON.stringify({ runId, owner: { login: owner } }));
  return runDir;
}

describe('stage-remote-run helpers', () => {
  let artifactDir;
  let demosDir;
  let prevEnv;

  beforeEach(() => {
    artifactDir = mkTempDir('stage-remote-artifact');
    demosDir = mkTempDir('stage-remote-local');
    prevEnv = process.env.PLAID_DEMO_APPS_DIR;
    process.env.PLAID_DEMO_APPS_DIR = artifactDir;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PLAID_DEMO_APPS_DIR;
    else process.env.PLAID_DEMO_APPS_DIR = prevEnv;
    try { fs.rmSync(artifactDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(demosDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('resolveArtifactDir honors PLAID_DEMO_APPS_DIR', () => {
    assert.equal(resolveArtifactDir(), artifactDir);
  });

  test('findRemoteRunOnDisk finds runId under a user subdir', () => {
    seedRemoteRun(artifactDir, 'alice', 'demo-abc');
    const found = findRemoteRunOnDisk('demo-abc', { artifactDir });
    assert.ok(found, 'expected to locate demo-abc');
    assert.equal(found.owner, 'alice');
    assert.ok(found.runDir.endsWith(path.join('alice', 'demo-abc')));
  });

  test('findRemoteRunOnDisk returns null when scratch-app is missing', () => {
    const runDir = path.join(artifactDir, 'demos', 'alice', 'demo-xyz');
    fs.mkdirSync(runDir, { recursive: true });
    writeFile(path.join(runDir, 'PUBLISH_MANIFEST.json'), JSON.stringify({ runId: 'demo-xyz' }));
    const found = findRemoteRunOnDisk('demo-xyz', { artifactDir });
    assert.equal(found, null);
  });

  test('findRemoteRunOnDisk returns null for unknown runId', () => {
    seedRemoteRun(artifactDir, 'alice', 'demo-abc');
    assert.equal(findRemoteRunOnDisk('demo-missing', { artifactDir }), null);
  });

  test('stageRemoteRunLocally copies files and writes sentinel', () => {
    const runId = 'demo-abc';
    const remoteRunDir = seedRemoteRun(artifactDir, 'alice', runId);

    const dest = stageRemoteRunLocally({ runId, remoteRunDir, demosDir });

    assert.equal(dest, path.join(demosDir, runId));
    assert.ok(fs.existsSync(path.join(dest, 'scratch-app', 'index.html')));
    assert.ok(fs.existsSync(path.join(dest, 'demo-script.json')));
    const sentinel = JSON.parse(fs.readFileSync(path.join(dest, 'STAGED_FROM_ARTIFACT.json'), 'utf8'));
    assert.equal(sentinel.runId, runId);
    assert.equal(sentinel.sourceDir, remoteRunDir);
  });

  test('stageRemoteRunLocally is idempotent when scratch-app already staged', () => {
    const runId = 'demo-idem';
    const remoteRunDir = seedRemoteRun(artifactDir, 'alice', runId);
    stageRemoteRunLocally({ runId, remoteRunDir, demosDir });
    const beforeStat = fs.statSync(path.join(demosDir, runId, 'scratch-app', 'index.html')).mtimeMs;
    // Mutate the local copy so we can assert the second call does NOT clobber it.
    writeFile(path.join(demosDir, runId, 'scratch-app', 'index.html'), '<html>LOCAL EDIT</html>');
    const dest2 = stageRemoteRunLocally({ runId, remoteRunDir, demosDir });
    assert.equal(dest2, path.join(demosDir, runId));
    const after = fs.readFileSync(path.join(demosDir, runId, 'scratch-app', 'index.html'), 'utf8');
    assert.match(after, /LOCAL EDIT/);
    assert.ok(fs.statSync(path.join(demosDir, runId, 'scratch-app', 'index.html')).mtimeMs >= beforeStat);
  });

  test('stageRemoteRunLocally throws when source does not exist', () => {
    assert.throws(
      () => stageRemoteRunLocally({
        runId: 'demo-missing',
        remoteRunDir: path.join(artifactDir, 'demos', 'alice', 'demo-missing'),
        demosDir,
      }),
      /remote runDir not found/
    );
  });
});
