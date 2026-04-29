'use strict';
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const vertexPath = path.join(__dirname, '../../scripts/scratch/utils/vertex-embed.js');

/** Keys this suite mutates — restored after each test. */
const KEYS = [
  'GOOGLE_API_KEY',
  'GCP_SERVICE_ACCOUNT_JSON_B64',
  'GCP_SERVICE_ACCOUNT_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS',
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

describe('vertex-embed credential helpers', () => {
  let saved;

  beforeEach(() => {
    saved = snapshotEnv();
    for (const k of KEYS) delete process.env[k];
    delete require.cache[require.resolve(vertexPath)];
  });

  afterEach(() => {
    restoreEnv(saved);
    delete require.cache[require.resolve(vertexPath)];
  });

  test('hasVertexServiceAccountEnv is false when nothing set', () => {
    const v = require(vertexPath);
    assert.equal(v.hasVertexServiceAccountEnv(), false);
  });

  test('hasVertexServiceAccountEnv is true when GCP_SERVICE_ACCOUNT_JSON_B64 set', () => {
    process.env.GCP_SERVICE_ACCOUNT_JSON_B64 = Buffer.from('{}').toString('base64');
    delete require.cache[require.resolve(vertexPath)];
    const v = require(vertexPath);
    assert.equal(v.hasVertexServiceAccountEnv(), true);
  });

  test('verifyVertexConnectivity skips when no API key and no SA env', async () => {
    const v = require(vertexPath);
    const r = await v.verifyVertexConnectivity();
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'skipped');
  });

  test('verifyVertexConnectivity succeeds with GOOGLE_API_KEY only', async () => {
    process.env.GOOGLE_API_KEY = 'test-api-key-placeholder';
    delete require.cache[require.resolve(vertexPath)];
    const v = require(vertexPath);
    const r = await v.verifyVertexConnectivity();
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'api_key');
  });

  test('createGoogleAuth throws on invalid base64 JSON', () => {
    process.env.GCP_SERVICE_ACCOUNT_JSON_B64 = Buffer.from('not-json').toString('base64');
    delete require.cache[require.resolve(vertexPath)];
    const v = require(vertexPath);
    assert.throws(() => v.createGoogleAuth(), /Unexpected token|JSON/u);
  });

  test('verifyVertexConnectivity fails oauth when B64 is not valid service account JSON', async () => {
    process.env.GCP_SERVICE_ACCOUNT_JSON_B64 = Buffer.from(JSON.stringify({ foo: 1 })).toString('base64');
    delete require.cache[require.resolve(vertexPath)];
    const v = require(vertexPath);
    const r = await v.verifyVertexConnectivity();
    assert.equal(r.ok, false);
    assert.equal(r.mode, 'oauth2');
    assert.match(r.message, /invalid|Failed|private_key|client_email|ENOENT|Could not load/u);
  });
});
