const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function runAutoGap(runDir) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const res = spawnSync('node', ['scripts/auto-gap.js'], {
    cwd: repoRoot,
    env: { ...process.env, PIPELINE_RUN_DIR: runDir },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`auto-gap failed (${res.status}): ${res.stderr || res.stdout}`);
  }
}

function setupRun({
  runDir,
  stepId = 'wf-link-launch',
  videoDurationMs,
  narrationMs,
}) {
  writeJson(path.join(runDir, 'demo-script.json'), {
    steps: [
      { id: stepId, label: 'Link Launch', plaidPhase: 'launch', narration: 'placeholder' },
    ],
  });

  writeJson(path.join(runDir, 'voiceover-manifest.json'), {
    clips: [
      {
        id: stepId,
        stepId,
        startMs: 0,
        endMs: videoDurationMs,
        audioDurationMs: narrationMs,
      },
    ],
  });

  writeJson(path.join(runDir, 'step-timing.json'), {
    steps: [
      { id: stepId, startMs: 0, endMs: videoDurationMs, durationMs: videoDurationMs },
    ],
  });

  writeJson(path.join(runDir, 'processed-step-timing.json'), {
    totalProcessedMs: videoDurationMs,
    keepRanges: [
      { rawStart: 0, rawEnd: videoDurationMs / 1000, processedStart: 0, processedEnd: videoDurationMs / 1000 },
    ],
    plaidStepWindows: [],
  });

  writeJson(path.join(runDir, 'sync-map.json'), { segments: [] });
}

test('auto-gap applies 15s-cap policy for Plaid Link narration <= 15s', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autogap-cap-'));
  setupRun({ runDir, videoDurationMs: 20000, narrationMs: 12000 });
  runAutoGap(runDir);

  const contract = JSON.parse(fs.readFileSync(path.join(runDir, 'timing-contract.json'), 'utf8'));
  const row = contract.steps.find((s) => s.stepId === 'wf-link-launch');
  assert.ok(row);
  assert.equal(row.plaidLinkPolicy, '15s-cap');
  assert.equal(row.targetCompDurationMs, 12500);
  assert.equal(row.actualCompDurationMs, 12500);
  assert.equal(row.status, 'ok');
});

test('auto-gap expands Plaid Link timeline when narration exceeds 15s', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autogap-expand-'));
  setupRun({ runDir, videoDurationMs: 12000, narrationMs: 17000 });
  runAutoGap(runDir);

  const contract = JSON.parse(fs.readFileSync(path.join(runDir, 'timing-contract.json'), 'utf8'));
  const row = contract.steps.find((s) => s.stepId === 'wf-link-launch');
  assert.ok(row);
  assert.equal(row.plaidLinkPolicy, 'expanded-to-talktrack');
  assert.equal(row.targetCompDurationMs, 17500);
  assert.equal(row.actualCompDurationMs, 17500);
  assert.equal(row.status, 'ok');

  const syncMap = JSON.parse(fs.readFileSync(path.join(runDir, 'sync-map.json'), 'utf8'));
  const linkFreeze = (syncMap.segments || []).find((s) => s._step === 'wf-link-launch' && s.mode === 'freeze');
  assert.ok(linkFreeze, 'expected freeze segment for expanded link talk track');
});
