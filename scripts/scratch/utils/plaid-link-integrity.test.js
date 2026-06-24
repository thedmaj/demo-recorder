'use strict';
/**
 * Unit tests for plaid-link-integrity.js deterministic checks.
 * Run: node scripts/scratch/utils/plaid-link-integrity.test.js  (exits non-zero on failure)
 */
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { checkRecordingAndClip, launchStepIds } = require('./plaid-link-integrity');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { fail++; console.error(`  FAIL ${name}\n       ${e.message}`); } }

function mkRun(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pli-'));
  for (const [name, obj] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
  return dir;
}

t('launchStepIds finds plaidPhase:launch and *-launch ids', () => {
  const ids = launchStepIds({ steps: [{ id: 'a' }, { id: 'b', plaidPhase: 'launch' }, { id: 'layer-launch' }, { id: 'idv-launch' }] });
  assert.deepStrictEqual(ids, ['b', 'layer-launch', 'idv-launch']);
});

t('modal-missing QA category → CRITICAL violation', () => {
  const dir = mkRun({
    'demo-script.json': { steps: [{ id: 'plaid-link-launch', plaidPhase: 'launch' }] },
    'qa-report-1.json': { steps: [{ stepId: 'plaid-link-launch', score: 35, categories: ['plaid-modal-missing'], issues: ['no modal'] }] },
  });
  const r = checkRecordingAndClip(dir);
  assert.strictEqual(r.ok, false);
  assert.ok(r.violations.some(v => v.kind === 'modal-missing' && v.severity === 'CRITICAL'));
  fs.rmSync(dir, { recursive: true, force: true });
});

t('clipped below keep floor → CRITICAL violation', () => {
  const dir = mkRun({
    'demo-script.json': { steps: [{ id: 'plaid-link-launch', plaidPhase: 'launch' }] },
    'qa-report-1.json': { steps: [{ stepId: 'plaid-link-launch', score: 85, categories: [] }] },
    'step-timing.json': { steps: [{ id: 'plaid-link-launch', startMs: 13000, endMs: 125000 }] },
    // keepRanges overlap the launch window for only 1.0s total (< 4s floor)
    'processed-step-timing.json': { keepRanges: [{ rawStart: 0, rawEnd: 13.5 }, { rawStart: 124.0, rawEnd: 125.0 }] },
  });
  const r = checkRecordingAndClip(dir);
  assert.strictEqual(r.ok, false);
  const c = r.violations.find(v => v.kind === 'clipped');
  assert.ok(c, 'expected clipped violation');
  assert.ok(c.keptS < 4, `kept ${c.keptS}s should be < 4`);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('healthy launch (modal present + enough kept) → ok', () => {
  const dir = mkRun({
    'demo-script.json': { steps: [{ id: 'plaid-link-launch', plaidPhase: 'launch' }] },
    'qa-report-1.json': { steps: [{ stepId: 'plaid-link-launch', score: 85, categories: [] }] },
    'step-timing.json': { steps: [{ id: 'plaid-link-launch', startMs: 13000, endMs: 60000 }] },
    'processed-step-timing.json': { keepRanges: [{ rawStart: 12, rawEnd: 30 }] }, // 17s kept
  });
  const r = checkRecordingAndClip(dir);
  assert.strictEqual(r.ok, true, JSON.stringify(r.violations));
  fs.rmSync(dir, { recursive: true, force: true });
});

t('no launch steps → skipped (ok)', () => {
  const dir = mkRun({ 'demo-script.json': { steps: [{ id: 'a' }, { id: 'b' }] } });
  const r = checkRecordingAndClip(dir);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('forced-no-success outcome → link-unsuccessful CRITICAL violation', () => {
  const dir = mkRun({
    'demo-script.json': { steps: [{ id: 'plaid-link-launch', plaidPhase: 'launch' }] },
    'qa-report-1.json': { steps: [{ stepId: 'plaid-link-launch', score: 85, categories: [] }] },
    'plaid-link-outcome.json': { outcome: 'forced-no-success', current: 'plaid-link-launch' },
  });
  const r = checkRecordingAndClip(dir);
  assert.strictEqual(r.ok, false);
  assert.ok(r.violations.some(v => v.kind === 'link-unsuccessful' && v.severity === 'CRITICAL'));
  fs.rmSync(dir, { recursive: true, force: true });
});

t('success outcome → no link-unsuccessful violation', () => {
  const dir = mkRun({
    'demo-script.json': { steps: [{ id: 'plaid-link-launch', plaidPhase: 'launch' }] },
    'qa-report-1.json': { steps: [{ stepId: 'plaid-link-launch', score: 85, categories: [] }] },
    'plaid-link-outcome.json': { outcome: 'success', via: 'onSuccess' },
  });
  const r = checkRecordingAndClip(dir);
  assert.ok(!r.violations.some(v => v.kind === 'link-unsuccessful'));
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\nplaid-link-integrity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
