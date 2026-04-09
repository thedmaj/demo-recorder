'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTAINER_DIR_NAMES = [
  'research',
  'script',
  'brand',
  'build',
  'qa',
  'timing',
  'media',
  'feedback',
  'logs',
];

function requireRunDir(projectRoot, scriptName) {
  const raw = process.env.PIPELINE_RUN_DIR;
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    throw new Error(
      `[${scriptName}] PIPELINE_RUN_DIR is required. ` +
      'Run this script via orchestrator or pass an explicit run directory.'
    );
  }
  const runDir = path.resolve(raw.trim());
  const expectedRoot = path.join(path.resolve(projectRoot), 'out');
  if (!runDir.startsWith(expectedRoot + path.sep) && runDir !== expectedRoot) {
    throw new Error(
      `[${scriptName}] Invalid PIPELINE_RUN_DIR: ${runDir} is outside ${expectedRoot}`
    );
  }
  return runDir;
}

function getRunId(runDir) {
  return path.basename(path.resolve(runDir));
}

function getRunLayout(runDir) {
  const root = path.resolve(runDir);
  const inputsDir = path.join(root, 'inputs');
  const artifactsDir = path.join(root, 'artifacts');
  const dirs = {
    root,
    runId: getRunId(root),
    inputsDir,
    artifactsDir,
    manifestPath: path.join(root, 'run-manifest.json'),
    markerPath: path.join(root, '.rundir'),
  };
  for (const name of CONTAINER_DIR_NAMES) {
    dirs[`${name}Dir`] = path.join(artifactsDir, name);
  }
  return dirs;
}

function ensureRunLayout(runDir) {
  const layout = getRunLayout(runDir);
  fs.mkdirSync(layout.root, { recursive: true });
  fs.mkdirSync(layout.inputsDir, { recursive: true });
  fs.mkdirSync(layout.artifactsDir, { recursive: true });
  for (const name of CONTAINER_DIR_NAMES) {
    fs.mkdirSync(layout[`${name}Dir`], { recursive: true });
  }
  return layout;
}

function readRunManifest(runDir) {
  const layout = getRunLayout(runDir);
  if (!fs.existsSync(layout.manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(layout.manifestPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeRunManifest(runDir, manifest) {
  const layout = ensureRunLayout(runDir);
  const payload = {
    schemaVersion: 1,
    ...manifest,
  };
  fs.writeFileSync(layout.manifestPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function ensureRunManifest(runDir, seed = {}) {
  const layout = ensureRunLayout(runDir);
  const existing = readRunManifest(runDir) || {};
  const now = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    runId: existing.runId || seed.runId || layout.runId,
    runDir: layout.root,
    createdAt: existing.createdAt || seed.createdAt || now,
    updatedAt: now,
    mode: seed.mode || existing.mode || null,
    runNameStem: seed.runNameStem || existing.runNameStem || null,
    promptFingerprint: seed.promptFingerprint || existing.promptFingerprint || null,
    sourcePromptFile: seed.sourcePromptFile || existing.sourcePromptFile || null,
    sourcePromptHash: seed.sourcePromptHash || existing.sourcePromptHash || null,
    notes: seed.notes || existing.notes || null,
  };
  fs.writeFileSync(layout.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

function snapshotRunInputs(runDir, opts = {}) {
  const layout = ensureRunLayout(runDir);
  const promptText = String(opts.promptText || '');
  const promptHash = crypto.createHash('sha256').update(promptText).digest('hex');
  const runtimeConfig = {
    at: new Date().toISOString(),
    researchMode: opts.researchMode || null,
    sourcePromptFile: opts.sourcePromptFile || null,
    promptHash,
    cli: opts.cli || {},
  };
  fs.writeFileSync(path.join(layout.inputsDir, 'prompt.txt'), promptText, 'utf8');
  fs.writeFileSync(path.join(layout.inputsDir, 'runtime-config.json'), JSON.stringify(runtimeConfig, null, 2), 'utf8');
  return runtimeConfig;
}

function writeRunDirMarker(runDir) {
  const layout = ensureRunLayout(runDir);
  fs.writeFileSync(layout.markerPath, `${layout.root}\n`, 'utf8');
}

module.exports = {
  CONTAINER_DIR_NAMES,
  requireRunDir,
  getRunId,
  getRunLayout,
  ensureRunLayout,
  readRunManifest,
  writeRunManifest,
  ensureRunManifest,
  snapshotRunInputs,
  writeRunDirMarker,
};
