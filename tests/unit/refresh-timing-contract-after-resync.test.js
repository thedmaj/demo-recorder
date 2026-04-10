'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { refreshTimingContractAfterResync } = require(
  path.join(__dirname, '../../scripts/refresh-timing-contract-after-resync')
);

describe('refreshTimingContractAfterResync', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-refresh-'));
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test('skips when sync-map has no segments', () => {
    const contract = {
      generatedAt: '2020-01-01T00:00:00.000Z',
      source: 'auto-gap',
      defaults: { NARRATION_SYNC_TOLERANCE_MS: 250 },
      summary: {},
      steps: [
        {
          stepId: 'a',
          targetCompDurationMs: 5000,
          compStartMs: 0,
          compEndMs: 5000,
          actualCompDurationMs: 5000,
          deltaMs: 0,
          status: 'ok',
        },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'timing-contract.json'), JSON.stringify(contract), 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'sync-map.json'),
      JSON.stringify({ segments: [] }),
      'utf8'
    );
    const r = refreshTimingContractAfterResync(tmpDir);
    assert.equal(r.skipped, true);
    const unchanged = JSON.parse(fs.readFileSync(path.join(tmpDir, 'timing-contract.json'), 'utf8'));
    assert.equal(unchanged.generatedAt, '2020-01-01T00:00:00.000Z');
  });

  test('updates windows from _step segment bounds with monotonic cursor', () => {
    const contract = {
      generatedAt: '2020-01-01T00:00:00.000Z',
      source: 'auto-gap',
      defaults: { NARRATION_SYNC_TOLERANCE_MS: 250 },
      summary: {},
      steps: [
        {
          stepId: 'identity-match-insight',
          targetCompDurationMs: 3000,
          compStartMs: 0,
          compEndMs: 3000,
          isPlaidLink: false,
        },
        {
          stepId: 'auth-insight',
          targetCompDurationMs: 3000,
          compStartMs: 3000,
          compEndMs: 6000,
          isPlaidLink: false,
        },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'timing-contract.json'), JSON.stringify(contract), 'utf8');
    // Two segments for first step spanning 0–4s comp; second step no tags → packs 4s+ with preserved 3s dur
    fs.writeFileSync(
      path.join(tmpDir, 'sync-map.json'),
      JSON.stringify({
        segments: [
          {
            compStart: 0,
            compEnd: 2,
            videoStart: 0,
            mode: 'speed',
            speed: 1,
            _step: 'identity-match-insight',
          },
          {
            compStart: 2,
            compEnd: 4,
            videoStart: 2,
            mode: 'freeze',
            _step: 'identity-match-insight',
          },
        ],
      }),
      'utf8'
    );

    const r = refreshTimingContractAfterResync(tmpDir);
    assert.equal(r.ok, true);
    assert.equal(r.skipped, undefined);
    const out = JSON.parse(fs.readFileSync(path.join(tmpDir, 'timing-contract.json'), 'utf8'));
    const idRow = out.steps.find((s) => s.stepId === 'identity-match-insight');
    const authRow = out.steps.find((s) => s.stepId === 'auth-insight');
    assert.equal(idRow.compStartMs, 0);
    assert.equal(idRow.compEndMs, 4000);
    assert.equal(authRow.compStartMs, 4000);
    assert.equal(authRow.compEndMs, 7000);
    assert.match(out.source, /post-resync-window-refresh/);
  });
});
