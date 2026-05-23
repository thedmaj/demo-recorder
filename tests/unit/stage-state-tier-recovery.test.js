'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const stageState = require(path.join(__dirname, '../../scripts/scratch/utils/stage-state'));

function makeRun(recommendedRecovery, extraReport = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-state-tier-'));
  const scratch = path.join(dir, 'scratch-app');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'index.html'), '<html></html>', 'utf8');
  fs.writeFileSync(path.join(dir, 'run-manifest.json'), JSON.stringify({
    buildMode: 'app+slides',
    mode: 'scratch',
    createdAt: new Date().toISOString(),
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'qa-report-build.json'), JSON.stringify({
    iteration: 'build',
    overallScore: 70,
    passThreshold: 80,
    passed: false,
    buildMode: 'app+slides',
    recommendedRecovery,
    tierSummary: {
      app:   { passed: true,  skipped: false, failingStepIds: [] },
      slide: { passed: false, skipped: false, failingStepIds: ['value-summary-slide'] },
    },
    ...extraReport,
  }), 'utf8');
  return dir;
}

describe('stage-state.resolveTierRecoveryCommand', () => {
  test('app-touchup recommendation → app-touchup command', () => {
    const dir = makeRun('app-touchup');
    const runId = path.basename(dir);
    const cmd = stageState.resolveTierRecoveryCommand(dir, runId);
    assert.match(cmd || '', /npm run pipe -- app-touchup/);
  });

  test('slide-fix recommendation → slide-fix command', () => {
    const dir = makeRun('slide-fix');
    const runId = path.basename(dir);
    const cmd = stageState.resolveTierRecoveryCommand(dir, runId);
    assert.match(cmd || '', /npm run pipe -- slide-fix/);
  });

  test('app-touchup+slide-fix → app-touchup command (chained, app first)', () => {
    const dir = makeRun('app-touchup+slide-fix');
    const runId = path.basename(dir);
    const cmd = stageState.resolveTierRecoveryCommand(dir, runId);
    assert.match(cmd || '', /npm run pipe -- app-touchup/);
  });

  test('fullbuild recommendation → null (let generic recovery take over)', () => {
    const dir = makeRun('fullbuild');
    const runId = path.basename(dir);
    const cmd = stageState.resolveTierRecoveryCommand(dir, runId);
    assert.equal(cmd, null);
  });

  test('no recommendation → null', () => {
    const dir = makeRun(null);
    const runId = path.basename(dir);
    const cmd = stageState.resolveTierRecoveryCommand(dir, runId);
    assert.equal(cmd, null);
  });
});

describe('stage-state.computeStatus tier surfacing', () => {
  test('exposes tierSummary + recommendedRecovery + tier-aware nextRecoveryCommand', () => {
    const dir = makeRun('slide-fix');
    const status = stageState.computeStatus(dir);
    assert.ok(status.tierSummary);
    assert.equal(status.recommendedRecovery, 'slide-fix');
    // No active pid, no continueReq → tier command should win.
    assert.match(status.nextRecoveryCommand || '', /npm run pipe -- slide-fix/);
    assert.equal(status.buildMode, 'app+slides');
  });
});
