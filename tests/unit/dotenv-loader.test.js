'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadRepoEnv,
  findRepoEnvPath,
  readGitWorktreeMainRoot,
} = require('../../scripts/scratch/utils/dotenv-loader.js');

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function writeEnv(fp, entries) {
  const body = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, body, 'utf8');
}

const TOUCHED_ENV_KEYS = [
  'PLAID_DEMO_RECORDER_ENV',
  'DOTENV_LOADER_TEST_A',
  'DOTENV_LOADER_TEST_B',
  'DOTENV_LOADER_TEST_C',
];

describe('dotenv-loader', () => {
  let saved;

  beforeEach(() => {
    saved = {};
    for (const k of TOUCHED_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TOUCHED_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('returns not-loaded when nothing is set', () => {
    const projectRoot = mkTemp('dotenv-empty');
    try {
      const result = loadRepoEnv(projectRoot);
      assert.equal(result.loaded, false);
      assert.match(result.message, /No usable \.env found/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('loads from projectRoot/.env when it has keys', () => {
    const projectRoot = mkTemp('dotenv-proj');
    try {
      writeEnv(path.join(projectRoot, '.env'), { DOTENV_LOADER_TEST_A: 'from_project_root' });
      const result = loadRepoEnv(projectRoot);
      assert.equal(result.loaded, true);
      assert.equal(result.source, 'project_root');
      assert.equal(result.loadedCount, 1);
      assert.equal(process.env.DOTENV_LOADER_TEST_A, 'from_project_root');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('skips empty projectRoot/.env and falls back to worktree main', () => {
    // Layout:
    //   mainRoot/.git/                    (real git dir)
    //   mainRoot/.git/worktrees/branch/   (worktree metadata)
    //   mainRoot/.env                     (the real .env — has keys)
    //   worktreeRoot/.git                 (file: "gitdir: .../worktrees/branch")
    //   worktreeRoot/.env                 (empty — simulates gitignored file absent)
    const mainRoot = mkTemp('dotenv-main');
    const worktreeRoot = mkTemp('dotenv-wt');
    try {
      const mainGitDir = path.join(mainRoot, '.git');
      const wtGitDir = path.join(mainGitDir, 'worktrees', 'branch');
      fs.mkdirSync(wtGitDir, { recursive: true });
      // `commondir` file inside worktree metadata points at main .git (relative).
      fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..', 'utf8');

      writeEnv(path.join(mainRoot, '.env'), { DOTENV_LOADER_TEST_B: 'from_main_worktree' });
      // Worktree has an empty .env — common when someone `touch`ed it.
      fs.writeFileSync(path.join(worktreeRoot, '.env'), '# empty\n', 'utf8');
      fs.writeFileSync(path.join(worktreeRoot, '.git'), `gitdir: ${wtGitDir}\n`, 'utf8');

      const result = loadRepoEnv(worktreeRoot);
      assert.equal(result.loaded, true);
      assert.equal(result.source, 'worktree_main');
      assert.equal(result.loadedCount, 1);
      assert.equal(process.env.DOTENV_LOADER_TEST_B, 'from_main_worktree');
    } finally {
      fs.rmSync(mainRoot, { recursive: true, force: true });
      fs.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  test('PLAID_DEMO_RECORDER_ENV overrides other sources', () => {
    const projectRoot = mkTemp('dotenv-override');
    const explicit = path.join(mkTemp('dotenv-explicit'), 'custom.env');
    try {
      writeEnv(path.join(projectRoot, '.env'), { DOTENV_LOADER_TEST_C: 'from_project_root' });
      writeEnv(explicit, { DOTENV_LOADER_TEST_C: 'from_explicit_override' });
      process.env.PLAID_DEMO_RECORDER_ENV = explicit;

      const result = loadRepoEnv(projectRoot, { override: true });
      assert.equal(result.loaded, true);
      assert.equal(result.source, 'env_var');
      assert.equal(process.env.DOTENV_LOADER_TEST_C, 'from_explicit_override');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(path.dirname(explicit), { recursive: true, force: true });
    }
  });

  test('findRepoEnvPath returns null when .git is a regular directory and no .env exists', () => {
    const projectRoot = mkTemp('dotenv-regular-git');
    try {
      fs.mkdirSync(path.join(projectRoot, '.git'));
      assert.equal(findRepoEnvPath(projectRoot), null);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('readGitWorktreeMainRoot returns null for a non-worktree project', () => {
    const projectRoot = mkTemp('dotenv-nowtree');
    try {
      fs.mkdirSync(path.join(projectRoot, '.git'));
      assert.equal(readGitWorktreeMainRoot(projectRoot), null);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
