'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');

const modPath = path.join(__dirname, '../../scripts/scratch/utils/validate-pipeline-env.js');

const KEYS = [
  'ANTHROPIC_API_KEY',
  'PLAID_ENV',
  'PLAID_CLIENT_ID',
  'PLAID_SANDBOX_SECRET',
  'ELEVENLABS_API_KEY',
  'GCP_SERVICE_ACCOUNT_JSON_B64',
  'GCP_SERVICE_ACCOUNT_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_API_KEY',
  'VERTEX_AI_PROJECT_ID',
  'PIPELINE_SKIP_ENV_CHECK',
  'PIPELINE_SKIP_ENV_LIVE_CHECK',
];

function snapshotEnv() {
  const o = {};
  for (const k of KEYS) o[k] = process.env[k];
  return o;
}

function restoreEnv(prev) {
  for (const k of KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
}

describe('validate-pipeline-env', () => {
  let saved;

  beforeEach(() => {
    saved = snapshotEnv();
    for (const k of KEYS) delete process.env[k];
    delete require.cache[require.resolve(modPath)];
    delete require.cache[require.resolve(path.join(__dirname, '../../scripts/scratch/utils/vertex-embed.js'))];
  });

  afterEach(() => {
    restoreEnv(saved);
    delete require.cache[require.resolve(modPath)];
    delete require.cache[require.resolve(path.join(__dirname, '../../scripts/scratch/utils/vertex-embed.js'))];
  });

  test('respects PIPELINE_SKIP_ENV_CHECK', async () => {
    process.env.PIPELINE_SKIP_ENV_CHECK = '1';
    delete process.env.ANTHROPIC_API_KEY;
    const { validatePipelineEnv } = require(modPath);
    const r = await validatePipelineEnv({ projectRoot: os.tmpdir(), skipLiveCheck: true });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });

  test('fails when ANTHROPIC_API_KEY missing', async () => {
    process.env.PIPELINE_SKIP_ENV_LIVE_CHECK = '1';
    const { validatePipelineEnv } = require(modPath);
    const r = await validatePipelineEnv({ projectRoot: os.tmpdir(), skipLiveCheck: true });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('ANTHROPIC_API_KEY')));
  });

  test('errors on missing GOOGLE_APPLICATION_CREDENTIALS file', async () => {
    process.env.PIPELINE_SKIP_ENV_LIVE_CHECK = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(os.tmpdir(), 'nonexistent-gcp-json-' + Date.now());
    const { validatePipelineEnv } = require(modPath);
    const r = await validatePipelineEnv({ projectRoot: os.tmpdir(), skipLiveCheck: true });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('GOOGLE_APPLICATION_CREDENTIALS')));
  });

  test('invalid GCP_SERVICE_ACCOUNT_JSON_B64 adds error', async () => {
    process.env.PIPELINE_SKIP_ENV_LIVE_CHECK = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder';
    process.env.GCP_SERVICE_ACCOUNT_JSON_B64 = Buffer.from('not-json').toString('base64');
    const { validatePipelineEnv } = require(modPath);
    const r = await validatePipelineEnv({ projectRoot: os.tmpdir(), skipLiveCheck: true });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('GCP_SERVICE_ACCOUNT_JSON_B64')));
  });

  test('expandCredentialPath resolves tilde', () => {
    const { expandCredentialPath } = require(modPath);
    const p = expandCredentialPath('~/Library/foo.json', '/tmp/proj');
    assert.ok(p.includes('Library'));
    assert.ok(path.isAbsolute(p));
  });

  test('passes with Anthropic and skip-live when no Google env', async () => {
    process.env.PIPELINE_SKIP_ENV_LIVE_CHECK = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-test-placeholder';
    const { validatePipelineEnv } = require(modPath);
    const r = await validatePipelineEnv({ projectRoot: os.tmpdir(), skipLiveCheck: true });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some(w => w.includes('PLAID') || w.includes('ELEVENLABS')));
  });
});
