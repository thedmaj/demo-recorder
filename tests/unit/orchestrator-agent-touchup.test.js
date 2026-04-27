'use strict';
const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Tests for the agent-driven refinement loop wiring in scripts/scratch/orchestrator.js:
//   - isAgentContext()        — env-var detection of Cursor / Claude Code
//   - analyzeFixModeForQaIteration — routing to `agent-touchup` mode
//
// Loading orchestrator.js triggers `require('dotenv').config()` which reads
// the user's local .env. To keep these tests deterministic we wipe the
// agent-mode env vars BEFORE each test and snapshot/restore around the suite.

const ORCHESTRATOR_PATH = path.join(__dirname, '../../scripts/scratch/orchestrator');
let orch;

const AGENT_ENVS = [
  'PIPE_AGENT_MODE',
  'CLAUDECODE',
  'CLAUDE_CODE_VERSION',
  'CURSOR_AGENT_MODE',
  'CURSOR_TRACE_ID',
];
const FIX_MODE_ENVS = [
  'BUILD_FIX_MODE',
  'BUILD_FIX_FULLBUILD_STEP_THRESHOLD',
  'TOUCHUP_ENABLED',
];
const ENV_SNAPSHOT = {};

function snapshotEnv(keys) {
  for (const k of keys) ENV_SNAPSHOT[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function wipeAgentEnvs() {
  for (const k of AGENT_ENVS) delete process.env[k];
}
function wipeFixModeEnvs() {
  for (const k of FIX_MODE_ENVS) delete process.env[k];
}

before(() => {
  // Snapshot before loading orchestrator (which calls dotenv at module load).
  snapshotEnv([...AGENT_ENVS, ...FIX_MODE_ENVS]);
  // Stub PIPELINE_RUN_DIR so requireRunDir doesn't fail if invoked transitively.
  process.env.PIPELINE_RUN_DIR ||= path.join(os.tmpdir(), 'orch-test-stub');
  orch = require(ORCHESTRATOR_PATH);
});

beforeEach(() => {
  // Each test sets its own envs; start clean to defeat dotenv leakage.
  wipeAgentEnvs();
  wipeFixModeEnvs();
});

// Tear-down — Node's test runner doesn't always run a global `after`, so we
// rely on the snapshot being restored at process exit if the test runner
// reuses it (best-effort).
process.on('exit', restoreEnv);

// ─── isAgentContext ─────────────────────────────────────────────────────────

describe('isAgentContext', () => {
  test('returns disabled when no env vars are set', () => {
    const out = orch.isAgentContext();
    assert.equal(out.enabled, false);
    assert.equal(out.source, null);
  });

  test('respects explicit PIPE_AGENT_MODE=1', () => {
    process.env.PIPE_AGENT_MODE = '1';
    const out = orch.isAgentContext();
    assert.equal(out.enabled, true);
    assert.equal(out.source, 'PIPE_AGENT_MODE');
  });

  test('respects truthy aliases (true / yes / on)', () => {
    for (const v of ['true', 'YES', 'on']) {
      process.env.PIPE_AGENT_MODE = v;
      assert.equal(orch.isAgentContext().enabled, true, `expected ${v} to be truthy`);
    }
  });

  test('explicit PIPE_AGENT_MODE=0 wins over auto-detect signals', () => {
    process.env.PIPE_AGENT_MODE = '0';
    process.env.CLAUDECODE = '1';
    process.env.CURSOR_TRACE_ID = 'abc';
    const out = orch.isAgentContext();
    assert.equal(out.enabled, false);
    assert.equal(out.source, 'PIPE_AGENT_MODE_off');
  });

  test('auto-detects Claude Code via CLAUDECODE=1', () => {
    process.env.CLAUDECODE = '1';
    const out = orch.isAgentContext();
    assert.equal(out.enabled, true);
    assert.equal(out.source, 'CLAUDECODE');
  });

  test('auto-detects Claude Code via CLAUDE_CODE_VERSION', () => {
    process.env.CLAUDE_CODE_VERSION = '0.42.0';
    assert.equal(orch.isAgentContext().enabled, true);
  });

  test('auto-detects Cursor via CURSOR_AGENT_MODE=1', () => {
    process.env.CURSOR_AGENT_MODE = '1';
    const out = orch.isAgentContext();
    assert.equal(out.enabled, true);
    assert.equal(out.source, 'CURSOR_AGENT');
  });

  test('auto-detects Cursor via CURSOR_TRACE_ID', () => {
    process.env.CURSOR_TRACE_ID = 'trace-xyz';
    assert.equal(orch.isAgentContext().enabled, true);
  });
});

// ─── analyzeFixModeForQaIteration — agent-mode routing ──────────────────────

function makeVersionedDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fixmode-'));
  fs.mkdirSync(path.join(base, 'scratch-app'), { recursive: true });
  // Minimum scaffold so the routing function doesn't bail on missing files:
  fs.writeFileSync(
    path.join(base, 'scratch-app', 'index.html'),
    '<div data-testid="step-a" class="step">x</div>'
  );
  // demo-script + playwright must align so detectPlaywrightAlignmentMismatch
  // returns false (otherwise auto routes to fullbuild as a structural fix).
  fs.writeFileSync(
    path.join(base, 'demo-script.json'),
    JSON.stringify({ steps: [{ id: 'a' }] })
  );
  fs.mkdirSync(path.join(base, 'scratch-app'), { recursive: true });
  fs.writeFileSync(
    path.join(base, 'scratch-app', 'playwright-script.json'),
    JSON.stringify({ steps: [{ stepId: 'a', action: 'goToStep', target: 'a' }] })
  );
  return base;
}

describe('analyzeFixModeForQaIteration — agent-touchup routing', () => {
  test('mode=auto + agent context → executedMode=agent-touchup with agent-source reason', () => {
    process.env.PIPE_AGENT_MODE = '1';
    const dir = makeVersionedDir();
    const decision = orch.analyzeFixModeForQaIteration({
      versionedDir: dir,
      qaResult: { stepsWithIssues: [{ stepId: 'a', score: 60, issues: ['x'] }] },
      qaThreshold: 80,
      iteration: 'app-1',
      requestedBuildFixMode: 'auto',
    });
    assert.equal(decision.executedMode, 'agent-touchup');
    assert.equal(decision.evaluatedMode, 'agent-touchup');
    assert.ok(decision.reasons.some((r) => r.startsWith('agent_context_')));
    assert.equal(decision.agentContext.enabled, true);
  });

  test('mode=auto + agent context + systemic signals → still agent-touchup (no rebuild)', () => {
    process.env.PIPE_AGENT_MODE = '1';
    const dir = makeVersionedDir();
    const decision = orch.analyzeFixModeForQaIteration({
      versionedDir: dir,
      qaResult: {
        stepsWithIssues: [
          { stepId: 'a', score: 40, categories: ['missing-logo'] },
          { stepId: 'b', score: 40, categories: ['missing-logo'] },
          { stepId: 'c', score: 40, categories: ['panel-visibility'] },
          { stepId: 'd', score: 40, categories: ['panel-visibility'] },
        ],
        deterministicPassed: false,
      },
      qaThreshold: 80,
      iteration: 'app-1',
      requestedBuildFixMode: 'auto',
    });
    // The crucial invariant: agent-touchup wins regardless of systemic signals.
    assert.equal(decision.executedMode, 'agent-touchup');
    // Systemic signals are surfaced as advisory reasons (so logs still show what fired):
    assert.ok(decision.reasons.some((r) => r.startsWith('advisory:')));
    assert.ok(decision.reasons.some((r) => /failing_steps_gte_/.test(r)));
  });

  test('mode=auto + NO agent context → falls back to legacy touchup/fullbuild routing', () => {
    // Wipe explicit PIPE_AGENT_MODE so isAgentContext returns disabled.
    delete process.env.PIPE_AGENT_MODE;
    delete process.env.CLAUDECODE;
    delete process.env.CURSOR_TRACE_ID;
    const dir = makeVersionedDir();
    const decision = orch.analyzeFixModeForQaIteration({
      versionedDir: dir,
      qaResult: { stepsWithIssues: [{ stepId: 'a', score: 60, issues: ['x'] }] },
      qaThreshold: 80,
      iteration: 'app-1',
      requestedBuildFixMode: 'auto',
    });
    // Localized issue, no systemic signal → should pick `touchup` (the legacy
    // LLM-narrowed regen path), not agent-touchup.
    assert.equal(decision.executedMode, 'touchup');
    assert.equal(decision.evaluatedMode, 'touchup');
    assert.ok(decision.reasons.includes('localized_issues_touchup_candidate'));
  });

  test('explicit --build-fix-mode=touchup overrides auto-detected agent context', () => {
    process.env.PIPE_AGENT_MODE = '1';
    const dir = makeVersionedDir();
    const decision = orch.analyzeFixModeForQaIteration({
      versionedDir: dir,
      qaResult: { stepsWithIssues: [{ stepId: 'a', score: 60, issues: ['x'] }] },
      qaThreshold: 80,
      iteration: 'app-1',
      requestedBuildFixMode: 'touchup',
    });
    assert.equal(decision.executedMode, 'touchup');
    assert.equal(decision.evaluatedMode, 'touchup');
    assert.ok(decision.reasons.includes('forced_touchup'));
  });

  test('explicit --build-fix-mode=agent-touchup is honored even without env detection', () => {
    delete process.env.PIPE_AGENT_MODE;
    const dir = makeVersionedDir();
    const decision = orch.analyzeFixModeForQaIteration({
      versionedDir: dir,
      qaResult: { stepsWithIssues: [{ stepId: 'a', score: 60, issues: ['x'] }] },
      qaThreshold: 80,
      iteration: 'app-1',
      requestedBuildFixMode: 'agent-touchup',
    });
    assert.equal(decision.executedMode, 'agent-touchup');
    assert.ok(decision.reasons.includes('forced_agent-touchup'));
  });

  test('agent-touchup mode does NOT escalate to fullbuild on touchupEnabled=false', () => {
    // The legacy `touchup → fullbuild` fallback only fires when the EVALUATED
    // mode is `touchup`. Make sure agent-touchup is unaffected by TOUCHUP_ENABLED.
    process.env.PIPE_AGENT_MODE = '1';
    process.env.TOUCHUP_ENABLED = 'false';
    const dir = makeVersionedDir();
    const decision = orch.analyzeFixModeForQaIteration({
      versionedDir: dir,
      qaResult: { stepsWithIssues: [{ stepId: 'a', score: 60, issues: ['x'] }] },
      qaThreshold: 80,
      iteration: 'app-1',
      requestedBuildFixMode: 'auto',
    });
    assert.equal(decision.executedMode, 'agent-touchup');
    assert.ok(!decision.reasons.includes('touchup_disabled_fallback_fullbuild'));
  });

  test('VALID_BUILD_FIX_MODES exposes the new agent-touchup vocabulary', () => {
    assert.ok(orch.VALID_BUILD_FIX_MODES.has('agent-touchup'));
    assert.ok(orch.VALID_BUILD_FIX_MODES.has('auto'));
    assert.ok(orch.VALID_BUILD_FIX_MODES.has('touchup'));
    assert.ok(orch.VALID_BUILD_FIX_MODES.has('fullbuild'));
  });

  test('returns agentContext object so callers can log the routing source', () => {
    process.env.PIPE_AGENT_MODE = '1';
    const dir = makeVersionedDir();
    const decision = orch.analyzeFixModeForQaIteration({
      versionedDir: dir,
      qaResult: { stepsWithIssues: [{ stepId: 'a', score: 60, issues: ['x'] }] },
      qaThreshold: 80,
      iteration: 'app-1',
      requestedBuildFixMode: 'auto',
    });
    assert.equal(typeof decision.agentContext, 'object');
    assert.equal(decision.agentContext.enabled, true);
    assert.equal(decision.agentContext.source, 'PIPE_AGENT_MODE');
  });
});
