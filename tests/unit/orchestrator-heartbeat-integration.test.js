'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const RUNNER = path.join(__dirname, 'helpers', 'heartbeat-integration-runner.js');

describe('orchestrator heartbeat integration (child process)', () => {
  test('child emits >=3 ::PIPE:: event=heartbeat lines within 800ms at 200ms interval', async () => {
  const child = spawn(process.execPath, [RUNNER], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PIPELINE_HEARTBEAT_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('child timed out'));
    }, 5000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on('error', reject);
  });

  assert.equal(exitCode, 0);
  const matches = stdout.match(/::PIPE:: event=heartbeat/g) || [];
  assert.ok(matches.length >= 3, `expected >=3 heartbeat lines, got ${matches.length}\n${stdout}`);
  });
});
