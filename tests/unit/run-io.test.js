'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  requireRunDir,
  getRunLayout,
  ensureRunManifest,
  snapshotRunInputs,
} = require('../../scripts/scratch/utils/run-io');

describe('run-io', () => {
  test('requireRunDir throws when PIPELINE_RUN_DIR is missing', () => {
    const prev = process.env.PIPELINE_RUN_DIR;
    delete process.env.PIPELINE_RUN_DIR;
    try {
      assert.throws(
        () => requireRunDir(path.resolve(__dirname, '../..'), 'unit-test'),
        /PIPELINE_RUN_DIR is required/
      );
    } finally {
      if (prev) process.env.PIPELINE_RUN_DIR = prev;
    }
  });

  test('ensureRunManifest creates immutable run identity file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-io-manifest-'));
    const projectRoot = path.join(root, 'proj');
    const runDir = path.join(projectRoot, 'out', 'demos', '2026-04-09-test-v1');
    fs.mkdirSync(runDir, { recursive: true });
    process.env.PIPELINE_RUN_DIR = runDir;

    const manifest = ensureRunManifest(runDir, {
      runId: '2026-04-09-test-v1',
      mode: 'scratch',
      runNameStem: 'Test-Auth',
      promptFingerprint: 'abc123',
    });
    const layout = getRunLayout(runDir);
    assert.equal(manifest.runId, '2026-04-09-test-v1');
    assert.ok(fs.existsSync(layout.manifestPath), 'run-manifest.json should exist');
    assert.ok(fs.existsSync(layout.inputsDir), 'inputs snapshot dir should exist');
    assert.ok(fs.existsSync(layout.buildDir), 'build artifact dir should exist');
  });

  test('run containers stay isolated across different runIds', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-io-isolation-'));
    const projectRoot = path.join(root, 'proj');
    const runA = path.join(projectRoot, 'out', 'demos', '2026-04-09-a-v1');
    const runB = path.join(projectRoot, 'out', 'demos', '2026-04-09-b-v1');
    fs.mkdirSync(runA, { recursive: true });
    fs.mkdirSync(runB, { recursive: true });

    ensureRunManifest(runA, { runId: '2026-04-09-a-v1', promptFingerprint: 'hash-a' });
    ensureRunManifest(runB, { runId: '2026-04-09-b-v1', promptFingerprint: 'hash-b' });
    snapshotRunInputs(runA, { promptText: 'Prompt A', sourcePromptFile: 'inputs/prompt.txt' });
    snapshotRunInputs(runB, { promptText: 'Prompt B', sourcePromptFile: 'inputs/prompt.txt' });

    const aLayout = getRunLayout(runA);
    const bLayout = getRunLayout(runB);
    const aPrompt = fs.readFileSync(path.join(aLayout.inputsDir, 'prompt.txt'), 'utf8');
    const bPrompt = fs.readFileSync(path.join(bLayout.inputsDir, 'prompt.txt'), 'utf8');

    assert.equal(aPrompt, 'Prompt A');
    assert.equal(bPrompt, 'Prompt B');
    assert.notEqual(aLayout.root, bLayout.root);
    assert.ok(path.join(aLayout.root, 'artifacts').startsWith(aLayout.root));
    assert.ok(!path.join(aLayout.root, 'artifacts').startsWith(bLayout.root));
  });
});
