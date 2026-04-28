'use strict';
/**
 * demo-app-reload.js
 *
 * Per-run-id Server-Sent-Events bookkeeping for the demo-app preview
 * servers. When the dashboard's /api/runs/:runId/insert-library-slide,
 * /api/runs/:runId/insert-step, /api/demo-apps/:runId/ai-edit, etc. modify
 * a run's scratch-app on disk, we want the open browser tab(s) for that
 * run to refresh automatically — no "stop the dev server, restart, refresh"
 * shuffle.
 *
 * Architecture
 *   - Per-run app server registers its SSE listeners with us via
 *     `addListener(runId, res)`. We hold the response open and write
 *     periodic comments to keep the connection alive.
 *   - Mutating endpoints (slide insertion, AI edit, etc.) call
 *     `notifyReload(runId, payload)`. We broadcast to every listener
 *     for that run.
 *   - Each listener's `res` cleans itself up on `close` (browser tab
 *     navigated away or closed).
 *
 * Pure bookkeeping — no Express dependency, no filesystem, no logging
 * outside what callers wire in. Easy to unit-test.
 */

// ─── Internal state ─────────────────────────────────────────────────────────
//
// `runId -> { seq: number, listeners: Set<{ res, heartbeat }> }`
const _state = new Map();

function _getRecord(runId) {
  if (!runId) return null;
  let rec = _state.get(runId);
  if (!rec) {
    rec = { seq: 0, listeners: new Set() };
    _state.set(runId, rec);
  }
  return rec;
}

// Heartbeat cadence — SSE connections idle out behind some proxies after
// ~30s without traffic. Comments (lines starting with ":") are no-ops in
// the SSE spec but keep the socket warm. Configurable for tests.
const DEFAULT_HEARTBEAT_MS = 25000;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Register a Server-Sent-Events listener for a given runId.
 *
 *   - Sets the appropriate SSE response headers
 *   - Sends an initial `event: hello` frame with the current seq
 *   - Starts a heartbeat to keep the connection alive
 *   - Hooks res 'close' to remove the listener and stop the heartbeat
 *
 * Returns a `dispose()` function the caller can invoke explicitly (in
 * addition to the auto-cleanup on close).
 *
 * @param {string} runId
 * @param {import('http').ServerResponse} res
 * @param {object} [opts]
 * @param {number} [opts.heartbeatMs] override default heartbeat cadence
 * @returns {Function} dispose
 */
function addListener(runId, res, opts = {}) {
  if (!runId || !res) return () => {};
  const rec = _getRecord(runId);
  const heartbeatMs = Number.isFinite(Number(opts.heartbeatMs))
    ? Math.max(1000, Number(opts.heartbeatMs))
    : DEFAULT_HEARTBEAT_MS;

  // SSE headers. Wrap in try/catch — on rare race the response may already
  // be closed (client disconnected before we got here).
  try {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Allow same-origin EventSource from the demo app page (the app server
    // injects ai-overlay.js which opens this stream).
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  } catch (_) {
    return () => {};
  }

  // Initial frame: tells the client the current seq so it can detect a
  // missed reload (e.g. browser tab was backgrounded; on resume, if the
  // server's seq has advanced, the page should reload immediately).
  try {
    res.write(`event: hello\ndata: ${JSON.stringify({ seq: rec.seq, runId })}\n\n`);
  } catch (_) {
    return () => {};
  }

  let heartbeat = setInterval(() => {
    try { res.write(`: heartbeat ${Date.now()}\n\n`); }
    catch (_) { /* socket gone — onClose will fire */ }
  }, heartbeatMs);
  // Don't keep the Node event loop alive on this timer alone.
  if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();

  const entry = { res, heartbeat };
  rec.listeners.add(entry);

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; entry.heartbeat = null; }
    rec.listeners.delete(entry);
    try { res.end(); } catch (_) {}
  }

  // Hook res events. `close` fires when the client disconnects (browser
  // navigates away). `error` fires on TCP-level issues. Both should clean up.
  res.on('close', dispose);
  res.on('error', dispose);

  return dispose;
}

/**
 * Broadcast a reload notification to every listener for `runId`.
 *
 * Bumps the seq counter (so a reconnecting client can compare) and
 * sends a `reload` event with the optional payload (reason + actor +
 * timestamp).
 *
 *   reload payload shape (best-effort; pass whatever is useful):
 *     {
 *       seq:        <integer; always present>,
 *       reason:     'slide-inserted' | 'step-inserted' | 'ai-edit' | …,
 *       runId:      string,
 *       at:         ISO-8601 timestamp,
 *       ...extras
 *     }
 *
 * Returns the new seq + listener count (handy for logging).
 *
 * @param {string} runId
 * @param {object} [payload]
 * @returns {{ seq: number, notified: number }}
 */
function notifyReload(runId, payload = {}) {
  if (!runId) return { seq: 0, notified: 0 };
  const rec = _getRecord(runId);
  rec.seq += 1;
  const at = new Date().toISOString();
  const data = { ...payload, runId, seq: rec.seq, at };
  const frame = `event: reload\ndata: ${JSON.stringify(data)}\n\n`;
  let delivered = 0;
  for (const entry of rec.listeners) {
    try { entry.res.write(frame); delivered += 1; }
    catch (_) { /* socket gone; close handler will dispose */ }
  }
  return { seq: rec.seq, notified: delivered };
}

/**
 * Snapshot of bookkeeping state for tests / diagnostics. Returns
 * `{ seq, listenerCount }` for the runId.
 */
function getState(runId) {
  const rec = _state.get(runId);
  if (!rec) return { seq: 0, listenerCount: 0 };
  return { seq: rec.seq, listenerCount: rec.listeners.size };
}

/**
 * Tear down all listeners for a runId — used when the demo-app server itself
 * shuts down (`stopDemoAppServer`). Idempotent.
 */
function clearListeners(runId) {
  const rec = _state.get(runId);
  if (!rec) return 0;
  const count = rec.listeners.size;
  for (const entry of rec.listeners) {
    if (entry.heartbeat) clearInterval(entry.heartbeat);
    try { entry.res.end(); } catch (_) {}
  }
  rec.listeners.clear();
  return count;
}

/**
 * Reset all in-memory state — exclusively for tests. Production code should
 * never call this.
 */
function _resetForTests() {
  for (const [, rec] of _state) {
    for (const entry of rec.listeners) {
      if (entry.heartbeat) clearInterval(entry.heartbeat);
    }
  }
  _state.clear();
}

module.exports = {
  addListener,
  notifyReload,
  getState,
  clearListeners,
  _resetForTests,
  // Constants exposed for tests:
  DEFAULT_HEARTBEAT_MS,
};
