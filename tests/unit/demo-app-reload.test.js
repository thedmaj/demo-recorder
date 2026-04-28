'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const reload = require(path.join(__dirname, '../../scripts/dashboard/utils/demo-app-reload'));

// Fake "ServerResponse" that records writes + close-handler registration.
function makeFakeRes() {
  const writes = [];
  const closeHandlers = [];
  const errorHandlers = [];
  let ended = false;
  let closed = false;
  return {
    setHeader: () => {},
    flushHeaders: () => {},
    write: (chunk) => { writes.push(String(chunk)); return true; },
    end: () => { ended = true; },
    on: (event, fn) => {
      if (event === 'close') closeHandlers.push(fn);
      else if (event === 'error') errorHandlers.push(fn);
    },
    // Test-only helpers:
    _writes: writes,
    _ended: () => ended,
    _close: () => { if (!closed) { closed = true; closeHandlers.forEach(fn => fn()); } },
    _emitError: (err) => errorHandlers.forEach(fn => fn(err || new Error('test'))),
  };
}

beforeEach(() => reload._resetForTests());

// ─── addListener ────────────────────────────────────────────────────────────

describe('addListener', () => {
  test('writes a hello frame containing the current seq', () => {
    const res = makeFakeRes();
    reload.addListener('run-1', res, { heartbeatMs: 60_000 });
    const hello = res._writes.find(w => w.includes('event: hello'));
    assert.ok(hello, 'hello frame written');
    assert.match(hello, /"seq":0/);
    assert.match(hello, /"runId":"run-1"/);
  });

  test('tracks listener count in getState', () => {
    const r1 = makeFakeRes();
    const r2 = makeFakeRes();
    reload.addListener('run-1', r1, { heartbeatMs: 60_000 });
    reload.addListener('run-1', r2, { heartbeatMs: 60_000 });
    assert.equal(reload.getState('run-1').listenerCount, 2);
    assert.equal(reload.getState('run-2').listenerCount, 0);
  });

  test('removes listener and stops heartbeat on close event', () => {
    const res = makeFakeRes();
    reload.addListener('run-1', res, { heartbeatMs: 60_000 });
    assert.equal(reload.getState('run-1').listenerCount, 1);
    res._close();
    assert.equal(reload.getState('run-1').listenerCount, 0);
    assert.equal(res._ended(), true);
  });

  test('removes listener on error event too', () => {
    const res = makeFakeRes();
    reload.addListener('run-1', res, { heartbeatMs: 60_000 });
    res._emitError();
    assert.equal(reload.getState('run-1').listenerCount, 0);
  });

  test('returned dispose() is idempotent', () => {
    const res = makeFakeRes();
    const dispose = reload.addListener('run-1', res, { heartbeatMs: 60_000 });
    dispose();
    dispose(); // second call should be a no-op
    assert.equal(reload.getState('run-1').listenerCount, 0);
  });

  test('returns no-op dispose when runId or res is missing', () => {
    assert.equal(typeof reload.addListener('', makeFakeRes()), 'function');
    assert.equal(typeof reload.addListener('run-1', null), 'function');
    // No state was created:
    assert.equal(reload.getState('run-1').listenerCount, 0);
  });
});

// ─── notifyReload ───────────────────────────────────────────────────────────

describe('notifyReload', () => {
  test('bumps seq, broadcasts to all listeners, returns delivery count', () => {
    const r1 = makeFakeRes();
    const r2 = makeFakeRes();
    reload.addListener('run-1', r1, { heartbeatMs: 60_000 });
    reload.addListener('run-1', r2, { heartbeatMs: 60_000 });
    const out = reload.notifyReload('run-1', { reason: 'slide-inserted', stepId: 'foo' });
    assert.equal(out.seq, 1);
    assert.equal(out.notified, 2);
    // Both got the reload frame:
    for (const r of [r1, r2]) {
      const reloadFrame = r._writes.find(w => w.includes('event: reload'));
      assert.ok(reloadFrame, 'reload frame written');
      assert.match(reloadFrame, /"reason":"slide-inserted"/);
      assert.match(reloadFrame, /"stepId":"foo"/);
      assert.match(reloadFrame, /"seq":1/);
      assert.match(reloadFrame, /"runId":"run-1"/);
      // ISO timestamp:
      assert.match(reloadFrame, /"at":"\d{4}-\d{2}-\d{2}T/);
    }
  });

  test('seq increments on every notify', () => {
    const r1 = makeFakeRes();
    reload.addListener('run-1', r1, { heartbeatMs: 60_000 });
    assert.equal(reload.notifyReload('run-1', { reason: 'a' }).seq, 1);
    assert.equal(reload.notifyReload('run-1', { reason: 'b' }).seq, 2);
    assert.equal(reload.notifyReload('run-1', { reason: 'c' }).seq, 3);
  });

  test('broadcasts only to the matching runId', () => {
    const r1 = makeFakeRes();
    const r2 = makeFakeRes();
    reload.addListener('run-1', r1, { heartbeatMs: 60_000 });
    reload.addListener('run-2', r2, { heartbeatMs: 60_000 });
    const out = reload.notifyReload('run-1', { reason: 'x' });
    assert.equal(out.notified, 1);
    // r2 only saw the hello frame, no reload:
    const r2ReloadFrames = r2._writes.filter(w => w.includes('event: reload'));
    assert.equal(r2ReloadFrames.length, 0);
  });

  test('handles a stale listener whose write throws (does not break delivery to others)', () => {
    const r1 = makeFakeRes();
    const r2 = makeFakeRes();
    // Make r1 throw on write (simulate broken socket):
    const orig = r1.write;
    r1.write = () => { throw new Error('EPIPE'); };
    reload.addListener('run-1', r1, { heartbeatMs: 60_000 });
    // restore so addListener's hello frame doesn't crash setup:
    r1.write = orig;
    reload.addListener('run-1', r2, { heartbeatMs: 60_000 });
    // Now break it again before notify:
    r1.write = () => { throw new Error('EPIPE'); };
    const out = reload.notifyReload('run-1', { reason: 'x' });
    // Only r2 was successfully notified:
    assert.equal(out.notified, 1);
  });

  test('returns 0/0 for unknown runId or empty input', () => {
    assert.deepEqual(reload.notifyReload(''), { seq: 0, notified: 0 });
    assert.deepEqual(reload.notifyReload(null), { seq: 0, notified: 0 });
    assert.deepEqual(reload.notifyReload('never-seen').notified, 0);
  });
});

// ─── clearListeners ─────────────────────────────────────────────────────────

describe('clearListeners', () => {
  test('disposes all listeners for a runId and returns count', () => {
    const r1 = makeFakeRes();
    const r2 = makeFakeRes();
    reload.addListener('run-1', r1, { heartbeatMs: 60_000 });
    reload.addListener('run-1', r2, { heartbeatMs: 60_000 });
    const cleared = reload.clearListeners('run-1');
    assert.equal(cleared, 2);
    assert.equal(reload.getState('run-1').listenerCount, 0);
    assert.equal(r1._ended(), true);
    assert.equal(r2._ended(), true);
  });

  test('returns 0 for unknown runId', () => {
    assert.equal(reload.clearListeners('never-seen'), 0);
  });

  test('subsequent notifies after clear deliver to nobody', () => {
    const r1 = makeFakeRes();
    reload.addListener('run-1', r1, { heartbeatMs: 60_000 });
    reload.clearListeners('run-1');
    const out = reload.notifyReload('run-1', { reason: 'x' });
    assert.equal(out.notified, 0);
  });
});
