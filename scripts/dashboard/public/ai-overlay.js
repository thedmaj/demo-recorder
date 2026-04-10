/**
 * ai-overlay.js
 *
 * Injected into demo app tabs launched from the dashboard.
 * Provides an AI chat panel for editing the app's HTML.
 *
 * Requires globals set by the injecting server:
 *   window.__DEMO_RUN_ID__       — e.g. "2026-03-14-layer-v4"
 *   window.__DASHBOARD_ORIGIN__  — e.g. "http://localhost:4040"
 */
(function () {
  'use strict';

  const RUN_ID = window.__DEMO_RUN_ID__;
  const DASHBOARD = window.__DASHBOARD_ORIGIN__;

  // If globals aren't set, the overlay was loaded outside the dashboard preview — bail silently.
  if (!RUN_ID || !DASHBOARD) return;

  // Track whether the backend is reachable; updated by health-check below.
  let _backendOnline = null; // null = checking, true = online, false = offline

  // ── Restore step position after reload ───────────────────────────────────────
  const SESSION_KEY = '__ai_overlay_step_' + RUN_ID;
  function restoreStep() {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (!saved) return;
    sessionStorage.removeItem(SESSION_KEY);
    // Wait for app to finish initialising
    const check = setInterval(() => {
      if (typeof window.goToStep === 'function') {
        clearInterval(check);
        window.goToStep(saved);
      }
    }, 50);
    setTimeout(() => clearInterval(check), 3000);
  }
  restoreStep();

  // ── State ─────────────────────────────────────────────────────────────────────
  let isOpen = false;
  let isPickMode = false;
  let pickedElement = null;
  let pickedHtml = null;
  let pickedSelector = null;
  let hoveredEl = null;
  let conversationHistory = [];

  // ── Styles ────────────────────────────────────────────────────────────────────
  const CSS = `
    #__ai-fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: #00A67E;
      color: #fff;
      font-size: 20px;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,166,126,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.15s, box-shadow 0.15s, opacity 0.15s;
      font-family: system-ui, -apple-system, sans-serif;
      opacity: 0;
      pointer-events: none;
      transform: scale(0.92);
    }
    #__ai-fab.__visible {
      opacity: 1;
      pointer-events: auto;
      transform: scale(1);
    }
    #__ai-fab.__visible:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,166,126,0.6); }
    #__ai-panel {
      position: fixed;
      bottom: 84px;
      right: 24px;
      z-index: 2147483647;
      width: 340px;
      max-height: 520px;
      background: #0d1117;
      border: 1px solid rgba(0,166,126,0.4);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      display: flex;
      flex-direction: column;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      color: #fff;
      overflow: hidden;
      transition: opacity 0.15s, transform 0.15s;
    }
    #__ai-panel.hidden { display: none; }
    #__ai-panel-header {
      padding: 10px 14px;
      background: rgba(0,166,126,0.12);
      border-bottom: 1px solid rgba(0,166,126,0.25);
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 13px;
      flex-shrink: 0;
    }
    #__ai-panel-header .run-id {
      flex: 1;
      font-size: 11px;
      color: rgba(255,255,255,0.45);
      font-weight: 400;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #__ai-panel-close {
      background: none;
      border: none;
      color: rgba(255,255,255,0.5);
      cursor: pointer;
      font-size: 16px;
      padding: 0;
      line-height: 1;
    }
    #__ai-panel-close:hover { color: #fff; }
    #__ai-context-bar {
      padding: 6px 14px;
      background: rgba(0,166,126,0.06);
      border-bottom: 1px solid rgba(255,255,255,0.06);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
      min-height: 36px;
    }
    #__ai-context-bar.empty { display: none; }
    #__ai-context-label {
      flex: 1;
      font-size: 11px;
      color: rgba(255,255,255,0.55);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #__ai-context-clear {
      background: none;
      border: none;
      color: rgba(255,255,255,0.35);
      cursor: pointer;
      font-size: 14px;
      padding: 0;
    }
    #__ai-context-clear:hover { color: rgba(255,255,255,0.7); }
    #__ai-messages {
      flex: 1;
      overflow-y: auto;
      padding: 10px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 80px;
      max-height: 240px;
    }
    #__ai-messages:empty::before {
      content: 'Describe a change to make, or pick an element for context.';
      color: rgba(255,255,255,0.25);
      font-size: 12px;
      font-style: italic;
    }
    .__ai-msg {
      padding: 7px 10px;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.45;
      max-width: 90%;
      word-break: break-word;
    }
    .__ai-msg.user {
      background: rgba(0,166,126,0.2);
      border: 1px solid rgba(0,166,126,0.3);
      align-self: flex-end;
    }
    .__ai-msg.assistant {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      align-self: flex-start;
    }
    .__ai-msg.system {
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.4);
      font-style: italic;
      font-size: 11px;
      align-self: center;
      text-align: center;
      border: none;
      padding: 3px 6px;
    }
    #__ai-footer {
      border-top: 1px solid rgba(255,255,255,0.08);
      padding: 10px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }
    #__ai-input {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      color: #fff;
      font-size: 12px;
      font-family: inherit;
      padding: 8px 10px;
      resize: none;
      width: 100%;
      box-sizing: border-box;
      outline: none;
      min-height: 60px;
      max-height: 120px;
    }
    #__ai-input:focus { border-color: rgba(0,166,126,0.6); }
    #__ai-input::placeholder { color: rgba(255,255,255,0.25); }
    #__ai-btn-row {
      display: flex;
      gap: 6px;
    }
    #__ai-pick-btn {
      flex: 0 0 auto;
      padding: 6px 12px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 6px;
      color: rgba(255,255,255,0.7);
      font-size: 11px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      transition: background 0.15s;
      font-family: inherit;
    }
    #__ai-pick-btn.active {
      background: rgba(0,166,126,0.2);
      border-color: rgba(0,166,126,0.5);
      color: #00A67E;
    }
    #__ai-pick-btn:hover { background: rgba(255,255,255,0.1); }
    #__ai-pick-btn.active:hover { background: rgba(0,166,126,0.3); }
    #__ai-send-btn {
      flex: 1;
      padding: 6px 14px;
      background: #00A67E;
      border: none;
      border-radius: 6px;
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s;
    }
    #__ai-send-btn:hover { background: #00b88a; }
    #__ai-send-btn:disabled { background: rgba(0,166,126,0.3); cursor: not-allowed; }
    .__ai-pick-highlight {
      outline: 2px dashed #00A67E !important;
      outline-offset: 2px !important;
      cursor: crosshair !important;
    }
    .__ai-pick-selected {
      outline: 2px solid #00A67E !important;
      outline-offset: 2px !important;
      background: rgba(0,166,126,0.08) !important;
    }
    #__ai-reload-banner {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: #00A67E;
      color: #fff;
      padding: 10px 24px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 4px 20px rgba(0,166,126,0.5);
      font-family: system-ui, -apple-system, sans-serif;
    }
    #__ai-panel-header .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #00A67E;
      flex-shrink: 0;
    }
  `;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // ── FAB button ────────────────────────────────────────────────────────────────
  const fab = document.createElement('button');
  fab.id = '__ai-fab';
  fab.title = 'AI Edit (opens chat)';
  fab.innerHTML = '✦';
  document.body.appendChild(fab);
  const FAB_HOVER_ZONE = { width: 220, height: 180 };
  let _fabHoverVisible = false;

  function setFabVisible(visible) {
    const shouldShow = !!(visible || isOpen);
    fab.classList.toggle('__visible', shouldShow);
  }

  document.addEventListener('mousemove', (e) => {
    const inZone =
      e.clientX >= (window.innerWidth - FAB_HOVER_ZONE.width) &&
      e.clientY >= (window.innerHeight - FAB_HOVER_ZONE.height);
    if (inZone !== _fabHoverVisible) {
      _fabHoverVisible = inZone;
      setFabVisible(_fabHoverVisible);
    }
  }, { passive: true });

  document.addEventListener('mouseleave', () => {
    _fabHoverVisible = false;
    setFabVisible(false);
  });

  // ── Panel ─────────────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = '__ai-panel';
  panel.className = 'hidden';
  panel.innerHTML = `
    <div id="__ai-panel-header">
      <span class="dot"></span>
      <span>AI Edit</span>
      <span class="run-id">${RUN_ID}</span>
      <button id="__ai-panel-close" title="Close">✕</button>
    </div>
    <div id="__ai-context-bar" class="empty">
      <span id="__ai-context-label"></span>
      <button id="__ai-context-clear" title="Clear selection">✕</button>
    </div>
    <div id="__ai-messages"></div>
    <div id="__ai-footer">
      <textarea id="__ai-input" placeholder="Describe the change you want…" rows="3"></textarea>
      <div id="__ai-btn-row">
        <button id="__ai-pick-btn" title="Click an element to add as context">
          <span>⊹</span> Pick
        </button>
        <button id="__ai-send-btn">Send</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // ── Element refs ──────────────────────────────────────────────────────────────
  const messagesEl = document.getElementById('__ai-messages');
  const inputEl = document.getElementById('__ai-input');
  const sendBtn = document.getElementById('__ai-send-btn');
  const pickBtn = document.getElementById('__ai-pick-btn');

  // ── Backend health check ──────────────────────────────────────────────────────
  function setOfflineState(reason) {
    _backendOnline = false;
    fab.title = 'AI Edit — dashboard offline';
    fab.style.background = '#374151';
    fab.style.boxShadow = 'none';
    fab.style.cursor = 'default';
    inputEl.disabled = true;
    inputEl.placeholder = 'Dashboard offline — AI edit unavailable';
    sendBtn.disabled = true;
    sendBtn.title = reason || 'Dashboard server not reachable';
    pickBtn.disabled = true;
    // Show a banner inside the panel if already open
    const existing = document.getElementById('__ai-offline-banner');
    if (!existing) {
      const banner = document.createElement('div');
      banner.id = '__ai-offline-banner';
      banner.style.cssText = 'padding:12px 16px;background:#1f2937;border-bottom:1px solid #374151;font-size:12px;color:#f87171;display:flex;align-items:center;gap:8px;';
      banner.innerHTML = '<span>⚠</span><span>Dashboard server unreachable. Start it with <code style="background:#111;padding:2px 5px;border-radius:3px">npm run dashboard</code></span>';
      messagesEl.parentElement.insertBefore(banner, messagesEl);
    }
  }

  function setOnlineState() {
    _backendOnline = true;
    fab.title = 'AI Edit (opens chat)';
    fab.style.background = '';
    fab.style.boxShadow = '';
    fab.style.cursor = '';
    inputEl.disabled = false;
    inputEl.placeholder = 'Describe the change you want…';
    sendBtn.disabled = false;
    sendBtn.title = '';
    pickBtn.disabled = false;
    const banner = document.getElementById('__ai-offline-banner');
    if (banner) banner.remove();
  }

  async function checkBackend() {
    try {
      // Use /api/demo-apps — has CORS headers, works from any origin (incl. app-server.js port)
      const r = await fetch(`${DASHBOARD}/api/demo-apps`, { method: 'GET', signal: AbortSignal.timeout(4000) });
      if (r.ok) { setOnlineState(); } else { setOfflineState('Dashboard returned ' + r.status); }
    } catch (_) {
      setOfflineState('Cannot reach ' + DASHBOARD);
    }
  }

  // Run immediately + retry every 10s if offline
  checkBackend();
  setInterval(() => { if (!_backendOnline) checkBackend(); }, 10000);
  const contextBar = document.getElementById('__ai-context-bar');
  const contextLabel = document.getElementById('__ai-context-label');
  const contextClear = document.getElementById('__ai-context-clear');
  const closeBtn = document.getElementById('__ai-panel-close');

  // ── Toggle panel ──────────────────────────────────────────────────────────────
  fab.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('hidden', !isOpen);
    setFabVisible(_fabHoverVisible);
    if (isOpen) inputEl.focus();
  });
  closeBtn.addEventListener('click', () => {
    isOpen = false;
    panel.classList.add('hidden');
    setFabVisible(_fabHoverVisible);
    exitPickMode();
  });

  // ── Messages ──────────────────────────────────────────────────────────────────
  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = '__ai-msg ' + role;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  // ── Pick mode ─────────────────────────────────────────────────────────────────
  const EXCLUDED = ['#__ai-fab', '#__ai-panel', '#__ai-reload-banner'];

  function isOverlay(el) {
    return el && (el.closest('#__ai-panel') || el.closest('#__ai-fab') || el.closest('#__ai-reload-banner'));
  }

  function enterPickMode() {
    isPickMode = true;
    pickBtn.classList.add('active');
    pickBtn.innerHTML = '<span>✕</span> Cancel';
    document.body.style.cursor = 'crosshair';
  }

  function exitPickMode() {
    isPickMode = false;
    pickBtn.classList.remove('active');
    pickBtn.innerHTML = '<span>⊹</span> Pick';
    document.body.style.cursor = '';
    if (hoveredEl) {
      hoveredEl.classList.remove('__ai-pick-highlight');
      hoveredEl = null;
    }
  }

  pickBtn.addEventListener('click', () => {
    if (isPickMode) {
      exitPickMode();
    } else {
      enterPickMode();
    }
  });

  document.addEventListener('mouseover', (e) => {
    if (!isPickMode || isOverlay(e.target)) return;
    if (hoveredEl && hoveredEl !== e.target) {
      hoveredEl.classList.remove('__ai-pick-highlight');
    }
    hoveredEl = e.target;
    hoveredEl.classList.add('__ai-pick-highlight');
  });

  document.addEventListener('mouseout', (e) => {
    if (!isPickMode || isOverlay(e.target)) return;
    if (e.target === hoveredEl) {
      e.target.classList.remove('__ai-pick-highlight');
      hoveredEl = null;
    }
  });

  document.addEventListener('click', (e) => {
    if (!isPickMode || isOverlay(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    if (pickedElement) {
      pickedElement.classList.remove('__ai-pick-selected');
    }

    pickedElement = e.target;
    pickedHtml = e.target.outerHTML.slice(0, 2000); // cap at 2KB
    pickedSelector = buildSelector(e.target);

    pickedElement.classList.add('__ai-pick-selected');

    // Show in context bar
    const tagInfo = pickedElement.tagName.toLowerCase() +
      (pickedElement.id ? `#${pickedElement.id}` : '') +
      (pickedElement.className && typeof pickedElement.className === 'string'
        ? '.' + pickedElement.className.trim().replace(/\s+/g, '.').slice(0, 40)
        : '');
    contextLabel.textContent = `Selected: ${tagInfo}`;
    contextBar.classList.remove('empty');

    exitPickMode();
  }, true);

  contextClear.addEventListener('click', () => {
    if (pickedElement) {
      pickedElement.classList.remove('__ai-pick-selected');
      pickedElement = null;
    }
    pickedHtml = null;
    pickedSelector = null;
    contextBar.classList.add('empty');
    contextLabel.textContent = '';
  });

  function buildSelector(el) {
    if (el.id) return '#' + el.id;
    if (el.dataset && el.dataset.testid) return `[data-testid="${el.dataset.testid}"]`;
    const tag = el.tagName.toLowerCase();
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    return tag + cls;
  }

  // ── Send ──────────────────────────────────────────────────────────────────────
  async function send() {
    const message = inputEl.value.trim();
    if (!message) return;

    sendBtn.disabled = true;
    sendBtn.textContent = 'Thinking…';

    addMessage('user', message);
    inputEl.value = '';

    try {
      const body = {
        message,
        selectedElementHtml: pickedHtml || null,
        selectedElementSelector: pickedSelector || null,
        conversationHistory,
        // Send the active step ID so the server can scope edits to just this step's div
        currentStepId: typeof window.getCurrentStep === 'function'
          ? (window.getCurrentStep() || '').replace(/^step-/, '')
          : null,
      };

      const resp = await fetch(`${DASHBOARD}/api/demo-apps/${RUN_ID}/ai-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await resp.json();

      if (!resp.ok) {
        addMessage('system', `Error: ${data.error || resp.statusText}`);
        return;
      }

      // Track conversation history (use summary as assistant reply)
      conversationHistory.push({ role: 'user', content: message });
      if (data.assistantMessage) {
        // Don't add the full HTML to history — summarise
        conversationHistory.push({ role: 'assistant', content: data.reply || 'Changes applied.' });
      }

      addMessage('assistant', data.reply || 'Changes applied.');

      // Save step, then reload
      const currentStep = typeof window.getCurrentStep === 'function'
        ? window.getCurrentStep()
        : null;
      if (currentStep) {
        sessionStorage.setItem(SESSION_KEY, currentStep.replace(/^step-/, ''));
      }

      showReloadBanner();
    } catch (err) {
      addMessage('system', `Network error: ${err.message}`);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });

  // ── Reload banner ─────────────────────────────────────────────────────────────
  function showReloadBanner() {
    const banner = document.createElement('div');
    banner.id = '__ai-reload-banner';
    banner.textContent = 'Changes applied! Reloading in 3s…';
    document.body.appendChild(banner);

    let t = 3;
    const iv = setInterval(() => {
      t--;
      if (t <= 0) {
        clearInterval(iv);
        window.location.reload();
      } else {
        banner.textContent = `Changes applied! Reloading in ${t}s…`;
      }
    }, 1000);
  }

  // ── Storyboard live-preview bridge ───────────────────────────────────────────
  // Allows the dashboard storyboard tab (different origin/port) to drive the
  // live app preview to a selected step and keep narration in sync.
  function canAcceptMessage(evt) {
    try {
      if (!evt || !evt.origin) return false;
      return evt.origin === DASHBOARD;
    } catch (_) { return false; }
  }

  window.addEventListener('message', (evt) => {
    if (!canAcceptMessage(evt)) return;
    const msg = evt.data || {};
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'STORYBOARD_SET_STEP') {
      const sid = String(msg.stepId || '').replace(/^step-/, '');
      if (sid && typeof window.goToStep === 'function') {
        try { window.goToStep(sid); } catch (_) {}
      }
      return;
    }

    if (msg.type === 'STORYBOARD_SYNC_NARRATION') {
      const sid = String(msg.stepId || '').replace(/^step-/, '');
      const narration = String(msg.narration || '');
      if (!sid) return;
      if (!window.__stepNarrationStore || typeof window.__stepNarrationStore !== 'object') {
        window.__stepNarrationStore = {};
      }
      window.__stepNarrationStore[sid] = narration;
      const tag = document.getElementById('storyboard-narration-store');
      if (tag) {
        try {
          tag.textContent = JSON.stringify(window.__stepNarrationStore).replace(/</g, '\\u003c');
        } catch (_) {}
      }
    }
  });

  // Emit live step changes back to dashboard so storyboard UI can follow preview navigation.
  let __lastReportedStep = null;
  function readNarrationForStep(stepId) {
    const sid = String(stepId || '').replace(/^step-/, '');
    if (!sid) return '';
    if (typeof window.getStepNarration === 'function') {
      try { return String(window.getStepNarration(sid) || ''); } catch (_) {}
    }
    if (window.__stepNarrationStore && typeof window.__stepNarrationStore === 'object') {
      return String(window.__stepNarrationStore[sid] || '');
    }
    return '';
  }
  function emitStepChanged(stepId) {
    const sid = String(stepId || '').replace(/^step-/, '');
    if (!sid || sid === __lastReportedStep) return;
    __lastReportedStep = sid;
    if (!window.parent || window.parent === window) return;
    try {
      window.parent && window.parent.postMessage({
        type: 'STORYBOARD_STEP_CHANGED',
        runId: RUN_ID,
        stepId: sid,
        narration: readNarrationForStep(sid),
      }, DASHBOARD);
    } catch (_) {}
  }
  function currentStepId() {
    try {
      if (typeof window.getCurrentStep === 'function') {
        return String(window.getCurrentStep() || '').replace(/^step-/, '');
      }
    } catch (_) {}
    const active = document.querySelector('.step.active');
    return active && active.dataset && active.dataset.testid
      ? String(active.dataset.testid).replace(/^step-/, '')
      : '';
  }
  function installStepBridge() {
    if (typeof window.goToStep !== 'function') return false;
    if (window.goToStep && window.goToStep.__storyboardBridgeWrapped) return true;
    const original = window.goToStep;
    const wrapped = function(id) {
      const result = original.apply(this, arguments);
      emitStepChanged(id || currentStepId());
      return result;
    };
    wrapped.__storyboardBridgeWrapped = true;
    wrapped.__storyboardBridgeOriginal = original;
    window.goToStep = wrapped;
    emitStepChanged(currentStepId());
    return true;
  }
  const bridgeTimer = setInterval(() => {
    if (installStepBridge()) clearInterval(bridgeTimer);
  }, 120);
  setTimeout(() => clearInterval(bridgeTimer), 6000);
  setInterval(() => {
    const sid = currentStepId();
    if (sid) emitStepChanged(sid);
  }, 400);

  if (!window.parent || window.parent === window) return;
  try {
    window.parent && window.parent.postMessage({ type: 'STORYBOARD_PREVIEW_READY', runId: RUN_ID }, DASHBOARD);
  } catch (_) {}

})();
