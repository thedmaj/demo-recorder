(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let currentRunId = null;
  let currentTab = 'overview';
  /** Open this valueprop file on next loadValueProps (from ?vp= or Overview deep link). */
  let _vpPendingOpenName = null;
  /** If set, switchTab runs once after loadRuns (from ?tab=). */
  let _urlInitialTab = null;
  // Note: the legacy 'files' tab was removed (it duplicated the Product
  // Knowledge tab's contents without adding utility). The loadFiles() function
  // is kept so any external bookmark / programmatic call doesn't throw, but
  // the tab is no longer in the sidebar.
  const VALID_DASHBOARD_TABS = new Set(['overview', 'config', 'storyboard', 'pipeline', 'valueprop', 'demo-apps']);
  let studioStatusInterval = null;
  let logSSE = null;
  let fsWatchSSE = null;
  let _logSSEConnectedAt = 0; // timestamp of last SSE connect — used to skip replayed history

  let buildPanelRefreshTimer = null;
  let stageBannerTimer = null;
  let stageBannerStart = null;

  // Original narration values keyed by stepId (for Revert)
  let originalNarrations = {};
  let storyboardLivePreviewUrl = null;
  let storyboardSelectedStepId = null;
  let storyboardMessageBridgeBound = false;
  let storyboardPreviewSyncing = false;
  let _overviewLoadToken = 0;
  let _filesLoadToken = 0;
  let _storyboardLoadToken = 0;

  // Stage list for progress bar — must match orchestrator + scripts/dashboard/server.js PIPELINE_STAGES
  const STAGES = [
    'research', 'ingest', 'script', 'brand-extract', 'script-critique',
    'embed-script-validate',
    /* 'plaid-link-capture', */ 'build', 'plaid-link-qa', 'build-qa', 'record', 'qa', 'figma-review', 'post-process',
    'voiceover', 'coverage-check', 'auto-gap', 'resync-audio', 'embed-sync', 'audio-qa', 'ai-suggest-overlays', 'render', 'ppt', 'touchup'
  ];

  const STAGE_META = {
    research:              { desc: 'Research: Solutions Master foundation + skill + AskBill/Glean (RESEARCH_MODE)', reads: ['inputs/prompt.txt', 'skills/plaid-integration.skill'], writes: ['product-research.json', 'plaid-skill-manifest.json', 'plaid-skill-gaps.json'] },
    ingest:                { desc: 'Parse prompt, screenshots, transcriptions', reads: ['inputs/'], writes: ['ingested-inputs.json'] },
    'brand-extract':       { desc: 'Brandfetch + Haiku → brand/<slug>.json (after script)', reads: ['demo-script.json', 'ingested-inputs.json'], writes: ['brand/<slug>.json', 'brand-extract.json'] },
    script:                { desc: 'Claude Opus generates demo storyboard (8–14 steps)', reads: ['ingested-inputs.json', 'product-research.json'], writes: ['demo-script.json'] },
    'script-critique':     { desc: 'Claude Haiku reviews narration word counts and value props', reads: ['demo-script.json'], writes: ['script-critique.json', 'claim-check-flags.json'] },
    'embed-script-validate': { desc: 'Multimodal embedding coherence check (optional, requires GCP)', reads: ['demo-script.json'], writes: ['script-validate-report.json'] },
    build:                 { desc: 'Claude Haiku generates demo web app (HTML/CSS/JS)', reads: ['demo-script.json', 'brand/<slug>.json'], writes: ['scratch-app/index.html'] },
    'plaid-link-qa':       { desc: 'Pre-record smoke: Plaid Link selectors + launch CTA (Playwright)', reads: ['scratch-app/'], writes: ['plaid-link-qa.json'] },
    'build-qa':            { desc: 'Playwright walk + vision QA vs demo-script (no recording)', reads: ['scratch-app/'], writes: ['build-qa-diagnostics.json', 'qa-report-build.json'] },
    record:                { desc: 'Playwright automates + records the demo app', reads: ['scratch-app/'], writes: ['recording.webm', 'step-timing.json'] },
    qa:                    { desc: 'Vision QA: screenshot eval per step (up to 3 iterations)', reads: ['recording.webm'], writes: ['qa-report-N.json', 'qa-frames/'] },
    'figma-review':        { desc: 'Optional Figma design feedback loop (FIGMA_REVIEW=true)', reads: ['scratch-app/'], writes: ['figma-review.json'] },
    'post-process':        { desc: 'Hard-cut loading pauses; preserve Plaid Link screens', reads: ['recording.webm', 'step-timing.json'], writes: ['recording-processed.webm', 'sync-map.json'] },
    voiceover:             { desc: 'ElevenLabs TTS: generate per-step narration MP3s', reads: ['processed-step-timing.json', 'demo-script.json'], writes: ['audio/vo_*.mp3', 'audio/voiceover.mp3'] },
    'coverage-check':      { desc: 'Verify all narration steps have audio clips', reads: ['voiceover-manifest.json'], writes: ['coverage-report.json'] },
    'auto-gap':            { desc: 'Compute speed/freeze sync-map segments from audio timings', reads: ['voiceover-manifest.json'], writes: ['sync-map.json'] },
    'resync-audio':        { desc: 'Re-stitch audio with sync-map speed/freeze applied; refreshes timing-contract for sync governor', reads: ['sync-map.json', 'voiceover-manifest.json'], writes: ['audio/voiceover.mp3', 'timing-contract.json'] },
    'embed-sync':          { desc: 'Gemini audio-video sync detection (optional)', reads: ['recording-processed.webm', 'voiceover.mp3'], writes: ['embed-sync-report.json'] },
    'audio-qa':            { desc: 'Per-clip stutter/freeze detection; auto-regenerate bad clips', reads: ['audio/vo_*.mp3'], writes: ['audio-qa-report.json'] },
    'ai-suggest-overlays': { desc: 'Gemini suggests click ripple + zoom overlay enhancements', reads: ['recording-processed.webm'], writes: ['overlay-suggestions.json'] },
    render:                { desc: 'Remotion composes final MP4 (2880×1800 H.264)', reads: ['recording-processed.webm', 'voiceover.mp3', 'remotion-props.json'], writes: ['demo-scratch.mp4'] },
    ppt:                   { desc: 'Generate PowerPoint summary with storyboard frames', reads: ['demo-scratch.mp4'], writes: ['demo-summary.pptx'] },
    touchup:               { desc: 'Optional Remotion Studio final adjustments', reads: [], writes: ['touchup-complete.json'] },
  };

  // ── Utilities ──────────────────────────────────────────────────────────────

  /** Toast queue — multiple toasts display sequentially without overlapping */
  const _toastQueue = [];
  let _toastActive = false;

  function showToast(msg, type = 'success', opts = {}) {
    // opts can be a number (legacy duration) or { duration, action, onClick }
    const options = typeof opts === 'number' ? { duration: opts } : opts;
    const duration = options.duration || 3500;
    _toastQueue.push({ msg, type, duration, action: options.action, onClick: options.onClick });
    if (!_toastActive) _processToastQueue();
  }

  function _processToastQueue() {
    if (_toastQueue.length === 0) { _toastActive = false; return; }
    _toastActive = true;
    const { msg, type, duration, action, onClick } = _toastQueue.shift();
    const toast = document.getElementById('toast');
    if (!toast) { _toastActive = false; return; }

    const actionHtml = action
      ? `<button class="toast-action-btn" style="margin-left:12px;padding:2px 10px;font-size:12px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:4px;cursor:pointer;color:inherit">${esc(action)}</button>`
      : '';
    toast.innerHTML = `<span class="toast-msg">${esc(msg)}</span>${actionHtml}<div class="toast-progress-bar"></div>`;
    toast.className = 'toast-visible toast-' + type;

    if (action && onClick) {
      toast.querySelector('.toast-action-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearTimeout(toast._timer);
        toast.className = '';
        setTimeout(_processToastQueue, 220);
        onClick();
      });
    }

    // Animate progress bar
    const bar = toast.querySelector('.toast-progress-bar');
    if (bar) {
      bar.style.transition = 'none';
      bar.style.width = '100%';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        bar.style.transition = `width ${duration}ms linear`;
        bar.style.width = '0%';
      }));
    }

    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.className = '';
      setTimeout(_processToastQueue, 220);
    }, duration);

    // Click to dismiss
    toast.onclick = () => {
      clearTimeout(toast._timer);
      toast.className = '';
      setTimeout(_processToastQueue, 220);
    };
  }

  /** Set button into loading state. Restore with setBtnLoading(btn, false). */
  function setBtnLoading(btn, loading, loadingText) {
    if (!btn) return;
    if (loading) {
      btn._savedHtml = btn.innerHTML;
      btn._savedDisabled = btn.disabled;
      btn.disabled = true;
      btn.classList.add('btn-loading');
      if (loadingText) btn.textContent = loadingText;
    } else {
      btn.disabled = btn._savedDisabled || false;
      btn.classList.remove('btn-loading');
      if (btn._savedHtml !== undefined) btn.innerHTML = btn._savedHtml;
    }
  }

  /** GET /path → parsed JSON. Throws on non-ok response. */
  async function api(path) {
    const res = await fetch(path);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(text || res.statusText);
    }
    return res.json();
  }

  /** POST /path with JSON body → parsed JSON. */
  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 410) {
      // Dashboard writes are disabled — this endpoint now lives in the CLI.
      // Auto-copy the suggested command and surface a toast.
      let payload = null;
      try { payload = await res.json(); } catch (_) { /* ignore */ }
      const cmd = (payload && payload.cliCommand) || 'npm run pipe';
      copyCliCommand(cmd, { title: 'Dashboard is read-only' });
      const err = new Error(`Run from the CLI: ${cmd}`);
      err.cliGated = true;
      err.cliCommand = cmd;
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(text || res.statusText);
    }
    return res.json();
  }

  // ── CLI command helpers (dashboard writes gated → CLI) ───────────────────────
  //
  // The server defaults DASHBOARD_WRITE=false. All pipeline run / resume /
  // kill / continue actions now live in `npm run pipe`. Instead of firing the
  // action from the browser, we copy the exact CLI invocation to the user's
  // clipboard so they can paste it into their Cursor / iTerm session.

  async function copyCliCommand(cmd, opts = {}) {
    const title = opts.title || 'Copied CLI command';
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(cmd);
        copied = true;
      }
    } catch (_) { /* fall through to manual */ }
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = cmd;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select(); document.execCommand('copy');
        document.body.removeChild(ta);
        copied = true;
      } catch (_) { /* ignore */ }
    }
    const prefix = copied ? '✓ ' : '';
    showToast(
      `${prefix}${title}: ${cmd}`,
      'info',
      {
        duration: 7000,
        action: 'Open terminal',
        onClick: () => {
          try { window.open('vscode://' + encodeURI('workbench.action.terminal.focus'), '_blank'); }
          catch (_) { /* no-op */ }
        },
      },
    );
  }

  /** Build a `npm run pipe -- …` command from a legacy runPipeline() payload. */
  function buildPipeCliCommand(payload = {}) {
    const b = payload || {};
    const parts = ['npm', 'run', 'pipe', '--'];
    if (b.resumeRunId) {
      parts.push('resume', String(b.resumeRunId));
      if (b.fromStage) parts.push(`--from=${b.fromStage}`);
      if (b.toStage)   parts.push(`--to=${b.toStage}`);
      if (b.overrideWithSlides && b.withSlides === true)  parts.push('--with-slides');
      if (b.overrideWithSlides && b.withSlides === false) parts.push('--app-only');
    } else if (b.createNewRun) {
      parts.push('new');
      if (b.withSlides === true)  parts.push('--with-slides');
      if (b.withSlides === false) parts.push('--app-only');
      if (b.toStage) parts.push(`--to=${b.toStage}`);
      if (b.researchMode) parts.push(`--research=${b.researchMode}`);
    } else {
      parts.push('status');
    }
    if (Number(b.qaThreshold) > 0) parts.push(`--qa-threshold=${Math.floor(Number(b.qaThreshold))}`);
    if (Number(b.maxRefinementIterations) > 0) parts.push(`--max-refinement-iterations=${Math.floor(Number(b.maxRefinementIterations))}`);
    if (b.buildFixMode) parts.push(`--build-fix-mode=${String(b.buildFixMode).toLowerCase()}`);
    if (b.noTouchup) parts.push('--no-touchup');
    return parts.join(' ');
  }

  // Cached writesEnabled + one-shot probe. Header badge refreshes this.
  let __writesEnabled = null;
  async function probeWritesEnabled() {
    try {
      const res = await fetch('/api/pipeline/status');
      const json = await res.json();
      __writesEnabled = !!json.writesEnabled;
      return json;
    } catch (_) {
      __writesEnabled = null;
      return null;
    }
  }
  function dashboardWritesEnabled() { return __writesEnabled === true; }
  window.__dashboardWrites = {
    isEnabled: dashboardWritesEnabled,
    refresh: probeWritesEnabled,
  };

  // ── Header CLI status badge ──────────────────────────────────────────────────
  //
  // Reflects the currently active (CLI-spawned) orchestrator via polling
  // /api/pipeline/status + /api/runs/:runId/stage-state. Also shows the
  // read-only indicator when DASHBOARD_WRITE is disabled.

  function initCliStatusBadge() {
    const header = document.getElementById('header');
    if (!header || document.getElementById('cli-status-badge')) return;
    const badge = document.createElement('div');
    badge.id = 'cli-status-badge';
    badge.style.cssText = [
      'display:none',
      'align-items:center',
      'gap:6px',
      'padding:3px 10px',
      'margin-right:8px',
      'font-size:12px',
      'font-weight:500',
      'border-radius:999px',
      'background:rgba(0,0,0,0.08)',
      'border:1px solid rgba(0,0,0,0.12)',
      'color:#333',
      'cursor:pointer',
      'user-select:none',
    ].join(';');
    badge.title = 'Pipeline is CLI-driven — click to copy command';
    const spacer = header.querySelector('.header-spacer');
    if (spacer) header.insertBefore(badge, spacer);
    else header.appendChild(badge);

    badge.addEventListener('click', () => {
      const cmd = badge.dataset.cliCommand || 'npm run pipe';
      copyCliCommand(cmd, { title: 'CLI command' });
    });

    async function tick() {
      try {
        const status = await probeWritesEnabled();
        if (!status) { badge.style.display = 'none'; return; }
        const writesOff = status.writesEnabled === false;
        if (status.source === 'cli' && status.runId) {
          let stageSummary = '';
          try {
            const res = await fetch(`/api/runs/${encodeURIComponent(status.runId)}/stage-state`);
            if (res.ok) {
              const s = await res.json();
              const { completed, total, failed } = s.counts || {};
              stageSummary = `${completed ?? 0}/${total ?? 0}` +
                (failed ? ` · ${failed} failed` : '') +
                (s.runningStage ? ` · ${s.runningStage}` : '');
            }
          } catch (_) { /* ignore */ }
          const cont = status.awaitingContinue ? ' ⚑' : '';
          badge.innerHTML = `<span style="color:#0a8">●</span> CLI · ${esc(status.runId)} ${esc(stageSummary)}${cont}`;
          badge.dataset.cliCommand = status.awaitingContinue
            ? `npm run pipe -- continue ${status.runId}`
            : `npm run pipe -- status ${status.runId}`;
          badge.style.display = 'inline-flex';
        } else if (writesOff) {
          badge.innerHTML = `<span style="color:#999">◌</span> CLI mode · <span style="opacity:.7">npm run pipe</span>`;
          badge.dataset.cliCommand = 'npm run pipe';
          badge.style.display = 'inline-flex';
        } else {
          badge.style.display = 'none';
        }
        // Re-label Pipeline tab action buttons in read-only mode so the user
        // sees that clicks now copy a CLI command rather than start a process.
        if (writesOff) applyReadOnlyButtonLabels();
      } catch (_) { /* ignore */ }
    }
    tick();
    setInterval(tick, 3000);
  }

  function applyReadOnlyButtonLabels() {
    const mappings = [
      ['run-btn',                    '▶ Copy Run CLI'],
      ['run-from-btn',               '▶ Copy Resume CLI'],
      ['run-refinement-pipeline-btn','✦ Copy Refinement CLI'],
      ['resync-audio-btn',           '⟳ Copy Resync CLI'],
      ['kill-btn',                   '■ Copy Stop CLI'],
      ['pipeline-continue-btn',      '▶ Copy Continue CLI'],
    ];
    for (const [id, label] of mappings) {
      const btn = document.getElementById(id);
      if (!btn || btn.dataset.roLabeled === '1') continue;
      if (!btn._originalLabel) btn._originalLabel = btn.textContent;
      btn.textContent = label;
      btn.title = (btn.title ? btn.title + '\n' : '') + 'Dashboard is read-only — click to copy the CLI command';
      btn.dataset.roLabeled = '1';
    }
  }

  /**
   * Start a pipeline run, handling the "already running" 409 gracefully.
   * On 409: shows a confirm dialog offering force-restart (kills current process).
   * Returns the server response, or throws if user declines or another error occurs.
   */
  /** If Pipeline tab prompt editor is mounted, persist to inputs/prompt.txt before orchestrator runs. */
  async function ensurePipelinePromptSaved() {
    const ta = document.getElementById('pipeline-prompt-editor');
    if (!ta) return;
    await apiPost('/api/config/prompt', { content: ta.value });
    const configTa = document.getElementById('prompt-editor');
    if (configTa) configTa.value = ta.value;
  }

  // ── Build mode (App-only vs App + Slides) ────────────────────────────────────
  // Single source of truth for the dashboard-wide default. Persisted in
  // localStorage so each user/browser has their own preference; quick actions
  // and the Run Pipeline modal both read from this.
  const WITH_SLIDES_DEFAULT_KEY = 'dashboard.withSlidesDefault';
  function getDashboardWithSlidesDefault() {
    try {
      const raw = window.localStorage.getItem(WITH_SLIDES_DEFAULT_KEY);
      if (raw == null) return false;
      return raw === 'true' || raw === '1';
    } catch (_) {
      return false;
    }
  }
  function setDashboardWithSlidesDefault(value) {
    try {
      window.localStorage.setItem(WITH_SLIDES_DEFAULT_KEY, value ? 'true' : 'false');
    } catch (_) {}
  }
  // Expose for use elsewhere in this file (modal, badges, debug console).
  window.__dashboardBuildMode = {
    get: getDashboardWithSlidesDefault,
    set: setDashboardWithSlidesDefault,
    storageKey: WITH_SLIDES_DEFAULT_KEY,
  };

  async function runPipeline(opts = {}) {
    const applyUiToStage = !!opts.applyUiToStage;
    const payload = { ...opts };
    delete payload.applyUiToStage;

    if (applyUiToStage) {
      const toSel = document.getElementById('pipeline-to-stage-select');
      if (toSel && toSel.value) payload.toStage = toSel.value;
    }

    // Inject withSlides if the caller did not specify one explicitly.
    // Resume actions (those passing resumeRunId) let the server inherit from
    // the run-manifest unless the caller also sets overrideWithSlides=true,
    // so we only need to provide a default for new runs.
    if (typeof payload.withSlides !== 'boolean') {
      payload.withSlides = getDashboardWithSlidesDefault();
    }

    const rm = document.getElementById('research-mode-select')?.value;
    if (rm) payload.researchMode = rm;

    // CLI-first path: when the server has writes disabled, skip the fetch
    // round-trip and hand the user a ready-to-paste command. Still persist
    // the prompt editor content so the CLI picks up the latest text.
    // We resolve (do not throw) so pre-existing `.catch(showToast.error)`
    // call sites don't double-toast — the info toast copy is enough.
    if (__writesEnabled === false) {
      await ensurePipelinePromptSaved().catch(() => { /* non-fatal */ });
      const cmd = buildPipeCliCommand(payload);
      await copyCliCommand(cmd, { title: 'Run from CLI' });
      return { cliGated: true, cliCommand: cmd };
    }

    await ensurePipelinePromptSaved().catch(err => {
      throw new Error(err.message || String(err));
    });
    const res = await fetch('/api/pipeline/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 409) {
      const confirmed = window.confirm(
        'A pipeline run is already in progress.\n\nForce-stop it and start this run instead?'
      );
      if (!confirmed) throw new Error('Cancelled — pipeline already running');
      // Retry with force flag (preserve the same withSlides decision)
      const payload2 = { ...payload, force: true };
      const rm2 = document.getElementById('research-mode-select')?.value;
      if (rm2) payload2.researchMode = rm2;
      if (typeof payload2.withSlides !== 'boolean') {
        payload2.withSlides = getDashboardWithSlidesDefault();
      }
      const res2 = await fetch('/api/pipeline/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload2),
      });
      if (!res2.ok) {
        const text = await res2.text().catch(() => res2.statusText);
        throw new Error(text || res2.statusText);
      }
      return res2.json();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(text || res.statusText);
    }
    return res.json();
  }

  /** Format bytes → "1.4 MB" */
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  /** Count words in a string */
  function wordCount(text) {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  /**
   * Mirror of `deriveStepKind` from scripts/scratch/utils/step-kind.js — kept
   * deliberately small so the storyboard render can decide which steps show a
   * "Remove slide" button without an API round-trip. Server's POST
   * /api/runs/:runId/remove-step uses the canonical helper as the source of
   * truth; this is just the UI's render gate.
   *
   * Returns 'slide' for steps that the slide-removal flow targets (sceneType
   * 'slide' / 'insight', or any step with a slideLibraryRef), 'app' otherwise.
   */
  function isSlideStepClient(step) {
    if (!step || typeof step !== 'object') return false;
    if (step.stepKind === 'slide') return true;
    const sceneType = String(step.sceneType || '').toLowerCase();
    if (sceneType === 'slide' || sceneType === 'insight') return true;
    if (step.slideLibraryRef && step.slideLibraryRef.slideId) return true;
    // Don't fall back to label-text heuristics here — those produce false
    // positives. The server-side helper is more thorough; this is just for
    // showing/hiding a button.
    return false;
  }

  /**
   * Syntax-highlight a JSON string → HTML with span classes:
   * .json-key, .json-string, .json-number, .json-bool, .json-null
   */
  function syntaxHighlightJSON(str) {
    if (typeof str !== 'string') str = JSON.stringify(str, null, 2);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(
        /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        function (match) {
          let cls = 'json-number';
          if (/^"/.test(match)) {
            cls = /:$/.test(match) ? 'json-key' : 'json-string';
          } else if (/true|false/.test(match)) {
            cls = 'json-bool';
          } else if (/null/.test(match)) {
            cls = 'json-null';
          }
          return '<span class="' + cls + '">' + match + '</span>';
        }
      );
  }

  /**
   * Parse a date from a runId like "2026-03-11-layer-v6" and return "Mar 11, 2026".
   * Falls back to isoString parsing if runId doesn't start with a date.
   */
  function formatDate(runId) {
    if (!runId) return '';
    const m = runId.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    const d = new Date(runId);
    if (!isNaN(d)) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return runId;
  }

  // ── Initialization ─────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    const _params = new URLSearchParams(window.location.search);
    const _tab = _params.get('tab');
    const _vp = _params.get('vp');
    if (_vp) _vpPendingOpenName = _vp;
    if (_tab && VALID_DASHBOARD_TABS.has(_tab)) _urlInitialTab = _tab;

    // Sidebar tab clicks
    document.querySelectorAll('.nav-item[data-tab]').forEach(el => {
      el.addEventListener('click', () => switchTab(el.dataset.tab));
    });

    // Build panel controls
    document.getElementById('build-selector-btn')?.addEventListener('click', toggleBuildPanel);
    document.getElementById('build-panel-close')?.addEventListener('click', toggleBuildPanel);
    document.getElementById('build-panel-overlay')?.addEventListener('click', toggleBuildPanel);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeBuildPanel(); });

    // Stage banner view-logs button
    document.getElementById('stage-banner-view-btn')?.addEventListener('click', () => switchTab('pipeline'));

    // Load runs (non-blocking — page chrome is already visible)
    loadRuns();

    // Pipeline CLI status badge (reflects CLI-spawned builds + read-only mode)
    initCliStatusBadge();

    // Identity for "All / Mine" demo-app filter.
    try {
      const resp = await fetch('/api/identity', { cache: 'no-store' });
      if (resp.ok) {
        const id = await resp.json();
        if (id && id.resolved && id.login) {
          window.__currentUserLogin = id.login;
          window.__currentUserName = id.name || id.login;
        }
      }
    } catch (_) {}

    // FS watch and log SSE (don't depend on currentRunId)
    connectFSWatch();
    connectLogSSE();

    // Studio status polling
    updateStudioStatus();
    studioStatusInterval = setInterval(updateStudioStatus, 5000);

    // Lightbox
    initLightbox();

    // Smart tooltips
    initTooltips();
  });

  // ── Run List ───────────────────────────────────────────────────────────────

  async function loadRuns() {
    try {
      const raw = await api('/api/runs');
      // Server returns { runs: [...] } but handle plain array fallback
      const data = Array.isArray(raw) ? { runs: raw } : raw;
      if (!data.runs || data.runs.length === 0) {
        const label = document.getElementById('build-selector-label');
        if (label) label.textContent = 'No builds yet';
        currentRunId = null;
        storyboardLivePreviewUrl = null;
        storyboardSelectedStepId = null;
        localStorage.removeItem('lastRunId');
        renderBuildPanel([]);
        if (_urlInitialTab) {
          switchTab(_urlInitialTab);
          _urlInitialTab = null;
        }
        return;
      }
      // Restore last selected run from localStorage, or default to first
      const savedRunId = localStorage.getItem('lastRunId');
      const savedExists = savedRunId && data.runs.some(r => r.runId === savedRunId);
      currentRunId = savedExists ? savedRunId : data.runs[0].runId;
      storyboardLivePreviewUrl = null;
      storyboardSelectedStepId = null;
      // Update button label
      const currentRun = data.runs.find(r => r.runId === currentRunId) || {};
      const label = document.getElementById('build-selector-label');
      if (label) label.textContent = currentRun.displayName || currentRunId;
      // Render panel content
      renderBuildPanel(data.runs);
      // Set up 10s panel refresh timer
      if (buildPanelRefreshTimer) clearInterval(buildPanelRefreshTimer);
      buildPanelRefreshTimer = setInterval(() => {
        const panel = document.getElementById('build-panel');
        if (panel && panel.classList.contains('open')) refreshBuildPanel();
      }, 10000);
      loadCurrentRun();
      if (_urlInitialTab) {
        switchTab(_urlInitialTab);
        _urlInitialTab = null;
      }
    } catch (e) {
      showToast('Failed to load runs: ' + e.message, 'error');
    }
  }

  async function refreshBuildPanel() {
    try {
      const raw = await api('/api/runs');
      const data = Array.isArray(raw) ? { runs: raw } : raw;
      renderBuildPanel(Array.isArray(data.runs) ? data.runs : []);
    } catch (_) {}
  }

  /** Stop pipeline if running (ignore errors). */
  async function killPipelineSilently() {
    try {
      await apiPost('/api/pipeline/kill', {});
    } catch (_) {
      /* 404 = nothing running */
    }
  }

  /**
   * Allocate a new empty run, select it, refresh the list, and open Pipeline to edit prompt.
   * Optionally stops an in-flight pipeline so the dashboard matches the new run.
   */
  async function createNewBuildAbandonCurrent() {
    const msg =
      'Create a new empty build and switch to it?\n\n' +
      'If a pipeline is running, it will be stopped. Previous builds stay in Recent Builds.';
    if (!window.confirm(msg)) return;
    try {
      await killPipelineSilently();
      setPipelineRunning(false);
      hideStageBanner();
      const data = await apiPost('/api/runs/allocate', {});
      const runId = data && data.runId;
      if (!runId) throw new Error('No runId returned');
      currentRunId = runId;
      localStorage.setItem('lastRunId', runId);
      storyboardLivePreviewUrl = null;
      storyboardSelectedStepId = null;
      const label = document.getElementById('build-selector-label');
      if (label) label.textContent = runId;
      await loadRuns();
      closeBuildPanel();
      switchTab('pipeline');
      showToast('New build created — edit the prompt in Pipeline, then Run Pipeline.', 'success');
    } catch (e) {
      showToast('Could not create build: ' + (e.message || String(e)), 'error');
    }
  }

  function renderBuildPanel(runs) {
    const content = document.getElementById('build-panel-content');
    if (!content) return;
    const list = Array.isArray(runs) ? runs : [];

    // Find currently running run (has a currentStage or isRunning)
    const liveRuns = list.filter(r => r.isRunning || r.currentStage);

    let html =
      '<div class="build-panel-new-wrap">' +
      '<button type="button" id="build-panel-new-btn" class="build-panel-new-btn">+ Create new build</button>' +
      '<p class="build-panel-new-hint">Stops a running pipeline if needed. Opens Pipeline to edit <code>inputs/prompt.txt</code>.</p>' +
      '</div>';

    if (liveRuns.length > 0) {
      html += `<div class="build-panel-section-title">Current Build</div>`;
      liveRuns.forEach(r => { html += buildCardHtml(r, true); });
    }

    html += `<div class="build-panel-section-title">Recent Builds</div>`;
    if (list.length === 0) {
      html +=
        '<div class="build-panel-empty-msg">No builds yet. Use the button above to create one.</div>';
    } else {
      list.forEach(r => { html += buildCardHtml(r, false); });
    }

    content.innerHTML = html;

    document.getElementById('build-panel-new-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      createNewBuildAbandonCurrent();
    });

    // Wire up Load buttons
    content.querySelectorAll('.build-card-load-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const runId = btn.dataset.runId;
        currentRunId = runId;
        storyboardLivePreviewUrl = null;
        storyboardSelectedStepId = null;
        localStorage.setItem('lastRunId', runId);
        const label = document.getElementById('build-selector-label');
        if (label) label.textContent = btn.dataset.displayName || runId;
        loadCurrentRun();
        closeBuildPanel();
      });
    });

    // Wire up card clicks (load run)
    content.querySelectorAll('.build-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.build-card-load-btn')) return;
        const runId = card.dataset.runId;
        if (!runId) return;
        currentRunId = runId;
        storyboardLivePreviewUrl = null;
        storyboardSelectedStepId = null;
        localStorage.setItem('lastRunId', runId);
        const label = document.getElementById('build-selector-label');
        if (label) label.textContent = card.dataset.displayName || runId;
        loadCurrentRun();
        closeBuildPanel();
      });
    });

    // Mark active card
    content.querySelectorAll('.build-card').forEach(card => {
      if (card.dataset.runId === currentRunId) card.classList.add('active');
    });
  }

  function buildCardHtml(r, isLiveSection) {
    const runId = r.runId;
    const displayName = r.displayName || runId;
    const isActive = runId === currentRunId;
    const isLive = !!(r.isRunning || r.currentStage);
    const completedCount = (r.completedStages || []).length;
    const totalStages = STAGES.length;
    const isComplete = !!(r.artifacts && (r.artifacts.mp4 || r.artifacts.pptx));
    const badgeClass = isLive ? 'live' : isComplete ? 'complete' : 'partial';
    const badgeText = isLive ? 'Live' : isComplete ? 'Complete' : 'Partial';

    // Build mode badge — shows whether this run was produced as app-only or
    // app+slides. Sourced from run-manifest.buildMode (legacy runs without the
    // field render no badge to avoid showing misleading info).
    let buildModeBadgeHtml = '';
    if (r.buildMode === 'app-only' || r.buildMode === 'app+slides') {
      const modeClass = r.buildMode === 'app+slides' ? 'with-slides' : 'app-only';
      const modeText = r.buildMode === 'app+slides' ? 'App + Slides' : 'App-only';
      const titleText = r.buildModeSource ? `Build mode: ${modeText} (source: ${r.buildModeSource})` : `Build mode: ${modeText}`;
      buildModeBadgeHtml = `<span class="build-card-badge build-mode ${modeClass}" title="${esc(titleText)}">${esc(modeText)}</span>`;
    }

    // Progress bar (one pip per pipeline stage)
    const completedSet = new Set(r.completedStages || []);
    const pipsHtml = STAGES.map(s => {
      const isDone = completedSet.has(s);
      const isActivePip = r.currentStage === s;
      return `<div class="build-progress-pip ${isDone ? 'done' : isActivePip ? 'active' : ''}"></div>`;
    }).join('');

    const product = r.script ? r.script.product : extractProduct(runId);
    const company = r.script ? r.script.company : '';
    const persona = r.script ? r.script.persona : '';
    const metaText = [company, product, persona].filter(Boolean).join(' · ');

    const qaText = r.qaScore != null ? `QA: ${r.qaScore}` : '';
    const stageText = isLive && r.currentStage ? `Stage: ${r.currentStage}` : '';
    const loadBtn = !isActive
      ? `<button class="build-card-load-btn" data-run-id="${esc(runId)}" data-display-name="${esc(displayName)}">Load</button>`
      : `<span style="font-size:11px;color:#00A67E">Current</span>`;

    return `
      <div class="build-card ${isActive ? 'active' : ''} ${isLive ? 'live' : ''}" data-run-id="${esc(runId)}" data-display-name="${esc(displayName)}">
        <div class="build-card-header">
          <span class="build-card-id">${esc(displayName)}</span>
          <span class="build-card-badges">
            ${buildModeBadgeHtml}
            <span class="build-card-badge ${badgeClass}">${badgeText}</span>
          </span>
        </div>
        ${displayName !== runId ? `<div class="build-card-meta" style="margin-top:-2px;margin-bottom:4px">Run ID: ${esc(runId)}</div>` : ''}
        ${metaText ? `<div class="build-card-meta">${esc(metaText)}</div>` : ''}
        <div class="build-progress-bar">${pipsHtml}</div>
        <div class="build-card-footer">
          <span>${[qaText, stageText].filter(Boolean).join(' · ')}</span>
          ${loadBtn}
        </div>
      </div>`;
  }

  function toggleBuildPanel() {
    const panel = document.getElementById('build-panel');
    const overlay = document.getElementById('build-panel-overlay');
    if (!panel) return;
    const isOpen = panel.classList.contains('open');
    if (isOpen) {
      closeBuildPanel();
    } else {
      panel.classList.add('open');
      if (overlay) overlay.style.display = 'block';
      // Refresh panel when opened
      refreshBuildPanel();
    }
  }

  function closeBuildPanel() {
    const panel = document.getElementById('build-panel');
    const overlay = document.getElementById('build-panel-overlay');
    if (panel) panel.classList.remove('open');
    if (overlay) overlay.style.display = 'none';
  }

  function loadCurrentRun() {
    loadOverview();
    updateStageDropdown();
    if (currentTab === 'storyboard') loadStoryboard();
  }

  // ── Tab Switching ──────────────────────────────────────────────────────────

  // Expose globally for use in inline onclick handlers
  window.switchTab = function(tabName) { switchTab(tabName); };

  function switchTab(tabName) {
    currentTab = tabName;
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach(el => {
      el.classList.toggle('active', el.id === 'tab-' + tabName);
    });
    // Lazy-load on first switch (files tab was removed; loadFiles() retained
    // as harmless dead code).
    if (tabName === 'storyboard' && currentRunId) loadStoryboard();
    if (tabName === 'config') loadConfig();
    if (tabName === 'pipeline') loadPipeline();
    if (tabName === 'valueprop') loadValueProps();
    // Always refetch demo-apps when entering the tab; otherwise a prior #demo-apps-list
    // causes loadDemoApps() to no-op and renamed display names appear to "revert".
    if (tabName === 'demo-apps') loadDemoApps(true);
  }

  // ── Overview Tab ───────────────────────────────────────────────────────────

  async function loadOverview() {
    if (!currentRunId) return;
    const runIdAtStart = currentRunId;
    const loadToken = ++_overviewLoadToken;
    const el = document.getElementById('overview-content');
    el.innerHTML = '<div class="empty-state">Loading…</div>';

    try {
      const [runData, qaData, audioSyncData, reviewQueueData] = await Promise.allSettled([
        api('/api/runs/' + runIdAtStart),
        api('/api/runs/' + runIdAtStart + '/qa'),
        api('/api/runs/' + runIdAtStart + '/audio-sync-status'),
        api('/api/valueprop/review-queue'),
      ]);
      if (loadToken !== _overviewLoadToken || runIdAtStart !== currentRunId) return;

      const run = runData.status === 'fulfilled' ? runData.value : {};
      const qa = qaData.status === 'fulfilled' ? qaData.value : null;
      const audioSync = audioSyncData.status === 'fulfilled' ? audioSyncData.value : null;

      const artifacts = run.artifacts || {};
      const script = run.script || {};
      const product = script.product || extractProduct(currentRunId);
      const company = script.company || '';
      const persona = script.persona || '–';

      // SVG icons for each artifact type (20×20 stroke Heroicons style)
      const BADGE_ICONS = {
        script:    `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5A1.5 1.5 0 0 1 6.5 2h5.086A1.5 1.5 0 0 1 12.647 2.44L15.56 5.354A1.5 1.5 0 0 1 16 6.414V16.5A1.5 1.5 0 0 1 14.5 18h-8A1.5 1.5 0 0 1 5 16.5v-13Z"/><path d="M8 10h4M8 13h2.5"/></svg>`,
        recording: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5.5" width="11" height="9" rx="1.5"/><path d="m13 8.5 5-3v9l-5-3V8.5Z"/></svg>`,
        processed: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="5.5" r="2"/><circle cx="5.5" cy="14.5" r="2"/><path d="M7.5 5.5h6l-6 9h6"/></svg>`,
        qa:        `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2 4 4.5v5c0 4 2.7 7 6 8 3.3-1 6-4 6-8v-5L10 2Z"/><path d="m7.5 10 2 2 3-3"/></svg>`,
        voiceover: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 4 4 7H2v6h2l3.5 3V4Z"/><path d="M13 7.5a4 4 0 0 1 0 5"/><path d="M15.5 5a7 7 0 0 1 0 10"/></svg>`,
        mp4:       `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="16" height="12" rx="1.5"/><path d="M6 4v12M14 4v12M2 8h4M2 12h4M14 8h4M14 12h4"/></svg>`,
        pptx:      `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="16" height="11" rx="1.5"/><path d="M10 14v4M7 18h6"/><path d="M8 7h2.5a1.5 1.5 0 0 1 0 3H8V7Z"/></svg>`,
        remotion:  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M8 7.5 14 10l-6 2.5V7.5Z"/></svg>`,
      };

      // Status dot SVG: checkmark, warning !, X, or empty circle
      const CHECK_SVG   = `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,5.5 4,7.5 8,3"/></svg>`;
      const WARN_SVG    = `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="2.5" x2="5" y2="6"/><circle cx="5" cy="8" r="0.75" fill="currentColor"/></svg>`;
      const X_SVG       = `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2.5" y1="2.5" x2="7.5" y2="7.5"/><line x1="7.5" y1="2.5" x2="2.5" y2="7.5"/></svg>`;
      const DASH_SVG    = `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="5" x2="8" y2="5"/></svg>`;

      function artifactBadge(key, label, sizeBytes, qaScoreVal) {
        const iconSvg = BADGE_ICONS[key] || BADGE_ICONS.script;
        let state, statusSvg, valueText;

        if (key === 'qa') {
          const score = qaScoreVal;
          if (score == null) { state = 'missing'; statusSvg = DASH_SVG; valueText = '–'; }
          else if (score >= 80)  { state = 'qa-pass'; statusSvg = CHECK_SVG; valueText = String(score) + ' / 100'; }
          else if (score >= 60)  { state = 'qa-warn'; statusSvg = WARN_SVG;  valueText = String(score) + ' / 100'; }
          else                   { state = 'qa-fail'; statusSvg = X_SVG;     valueText = String(score) + ' / 100'; }
        } else if (sizeBytes) {
          state = 'present'; statusSvg = CHECK_SVG;
          valueText = formatBytes(sizeBytes);
        } else {
          state = 'missing'; statusSvg = DASH_SVG; valueText = 'not found';
        }

        return `
          <div class="artifact-badge ${state}">
            <div class="badge-status">${statusSvg}</div>
            <div class="badge-icon">${iconSvg}</div>
            <span class="badge-label">${esc(label)}</span>
            <span class="badge-value">${esc(valueText)}</span>
          </div>`;
      }

      const badgesHtml = [
        artifactBadge('script',    'Script',     artifacts.script,    null),
        artifactBadge('recording', 'Recording',  artifacts.recording, null),
        artifactBadge('processed', 'Processed',  artifacts.processed, null),
        artifactBadge('qa',        'QA Score',   null,                run.qaScore),
        artifactBadge('voiceover', 'Voiceover',  artifacts.voiceover, null),
        artifactBadge('mp4',       'MP4',         artifacts.mp4,       null),
        artifactBadge('pptx',      'Slideshow',   artifacts.pptx,      null),
        artifactBadge('remotion',  'Remotion',    artifacts.remotion,  null),
      ].join('');

      // Pipeline timeline
      const completedSet = new Set(run.completedStages || []);
      // Backward compat: if no completedStages, infer from lastCompletedStage
      if (completedSet.size === 0 && run.lastCompletedStage) {
        const lastIdx = STAGES.indexOf(run.lastCompletedStage);
        if (lastIdx >= 0) STAGES.slice(0, lastIdx + 1).forEach(s => completedSet.add(s));
      }
      const nextStageForChecklist = run.resumeFromStage;
      const ICON_DONE = `<svg class="pill-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="2.5,6 5,8.5 9.5,3.5"/></svg>`;
      const ICON_NEXT = `<svg class="pill-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="3,2 10,6 3,10"/></svg>`;
      const ICON_LOCK = `<svg class="pill-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2.5" y="5" width="7" height="5.5" rx="1"/><path d="M4 5V3.5a2 2 0 0 1 4 0V5"/></svg>`;
      const timelinePills = STAGES.map((s, i) => {
        let state, icon;
        if (completedSet.has(s))              { state = 'stage-done'; icon = ICON_DONE; }
        else if (s === nextStageForChecklist)  { state = 'stage-next'; icon = ICON_NEXT; }
        else                                  { state = 'stage-locked'; icon = ICON_LOCK; }
        const clickable = state !== 'stage-locked';
        // Connector color: teal if next stage is done, gradient at transition, grey otherwise
        let connClass = 'connector-locked';
        if (i < STAGES.length - 1) {
          if (completedSet.has(s) && completedSet.has(STAGES[i + 1])) connClass = 'connector-done';
          else if (completedSet.has(s) && STAGES[i + 1] === nextStageForChecklist) connClass = 'connector-next';
          else if (completedSet.has(s)) connClass = 'connector-next';
        }
        const connector = i < STAGES.length - 1
          ? `<div class="timeline-connector ${connClass}"></div>` : '';
        return `<div class="timeline-item ${state}" data-stage="${esc(s)}" ${clickable ? 'role="button" tabindex="0" title="Click to open Pipeline tab at this stage"' : 'title="Complete previous stages first"'}><div class="timeline-dot">${icon}</div><span class="timeline-label">${esc(s)}</span></div>${connector}`;
      }).join('');
      const checklistHtml = `<div class="pipeline-timeline">${timelinePills}</div>`;

      // QA summary
      let qaHtml = '';
      if (qa) {
        const score = qa.overallScore ?? qa.score ?? '–';
        const passed = qa.passed ?? (score >= (qa.passThreshold || 80));
        const iter = qa.iteration ?? '–';
        const threshold = qa.passThreshold ?? 80;
        const issues = qa.stepsWithIssues || [];
        const issueItems = issues.map(s => `
          <li class="qa-issue-item">
            <span class="qa-issue-step">${esc(s.stepId || s.step || '')}</span>
            <span class="chip ${scoreChipClass(s.score)}">${s.score ?? '–'}</span>
            <span class="qa-issue-text">${esc((s.issues || []).join('; '))}</span>
          </li>`).join('');

        qaHtml = `
          <div class="card" id="qa-summary">
            <div class="card-title">QA Report</div>
            <div class="qa-score ${passed ? 'pass' : 'fail'}">${score}</div>
            <div class="qa-meta">Iteration ${esc(String(iter))} · ${passed ? 'PASSED' : 'FAILED'} (threshold ${threshold})</div>
            ${issues.length > 0 ? `<ul class="qa-issue-list open">${issueItems}</ul>` : '<p class="qa-clean">No step issues.</p>'}
          </div>`;
      }

      // Audio sync warning — shown when sync-map has segments but voiceover hasn't been resynced
      let audioSyncWarnHtml = '';
      if (audioSync && audioSync.isStale) {
        audioSyncWarnHtml = `
          <div class="card" id="audio-sync-warn-card" style="border-color:rgba(251,191,36,0.5);background:rgba(251,191,36,0.07)">
            <div class="card-title" style="color:#fbbf24">⚠ Audio Sync Stale</div>
            <p class="run-meta" style="margin-bottom:12px">
              The sync-map has <strong>${audioSync.segmentCount}</strong> speed/freeze segment(s) but the voiceover
              ${audioSync.syncApplied ? 'was resynced before the sync-map changed' : 'has not been resynced yet'}.
              Audio may be out of sync with the video. Open Timeline Editor to correct timing visually.
              ${audioSync.resyncedAt ? `<span style="opacity:0.6">Last resynced: ${new Date(audioSync.resyncedAt).toLocaleString()}</span>` : ''}
            </p>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <button type="button" class="btn btn-primary btn-sm" id="overview-open-timeline-btn">◫ Open Timeline Editor</button>
              <button type="button" class="btn btn-secondary btn-sm" id="overview-resync-btn">⟳ Resync Audio</button>
            </div>
            <p class="save-hint">Use Timeline Editor for visual correction first; use Resync Audio to restitch clips against the updated sync-map.</p>
          </div>`;
      }

      // Resume card — shown for partial runs that didn't complete
      const lastStage = run.lastCompletedStage || null;
      const nextStage = nextStageForChecklist || null;
      const isComplete = !!(artifacts.pptx || artifacts.mp4);
      let resumeHtml = '';
      if (!isComplete && lastStage) {
        resumeHtml = `
          <div class="card" id="resume-card">
            <div class="card-title">Incomplete Run</div>
            <p class="run-meta" style="margin-bottom:12px">
              Last completed stage: <strong>${esc(lastStage)}</strong>
              ${nextStage ? ` · Next: <strong>${esc(nextStage)}</strong>` : ' · All stages complete'}
            </p>
            ${nextStage ? `
            <button type="button" class="btn btn-primary" id="resume-run-btn">
              Resume from <strong style="margin-left:4px">${esc(nextStage)}</strong>
            </button>
            <p class="save-hint">Stages before <em>${esc(nextStage)}</em> will be skipped; artifacts from this run are reused.</p>
            ` : '<p class="run-meta">All stages appear complete.</p>'}
          </div>`;
      } else if (!lastStage) {
        resumeHtml = `
          <div class="card" id="resume-card">
            <div class="card-title">Empty Run</div>
            <p class="run-meta">No stage artifacts detected — this run may have failed before any stage completed, or artifacts are in a non-standard location.</p>
          </div>`;
      }

      // Section B: Available Actions
      const canEditStoryboard = !!(artifacts.script);
      const canLaunchApp = !!(run.artifacts && run.artifacts.script); // proxy check
      const canRecord = !!(artifacts.script);
      const canResync = !!(audioSync && audioSync.isStale);
      const canRender = !!(artifacts.voiceover && artifacts.processed);

      let kbCardHtml = '';
      const rqPayload = reviewQueueData.status === 'fulfilled' ? reviewQueueData.value : null;
      const kbQueue = (rqPayload && rqPayload.queue) ? rqPayload.queue : [];
      const productQ = kbQueue.filter(e => e.group === 'products');
      const now = Date.now();
      const staleVpFiles = productQ.filter(e => {
        const last = e && e.frontmatter && e.frontmatter.last_vp_research;
        if (!last) return true;
        const ageDays = Math.floor((now - new Date(String(last)).getTime()) / 86400000);
        return !Number.isFinite(ageDays) || ageDays > 30 || ageDays < 0;
      }).length;
      const kbTop = productQ.slice(0, 5);
      if (productQ.length > 0) {
        const summaryBits = [];
        summaryBits.push(`<strong>${productQ.length}</strong> product file(s) under <code>inputs/products/</code>`);
        if (staleVpFiles > 0) {
          summaryBits.push(`<strong style="color:#fbbf24">${staleVpFiles}</strong> with stale / missing <code>last_vp_research</code> (research will refresh)`);
        } else {
          summaryBits.push('<span style="color:#00A67E">All VP files fresh (≤30d)</span>');
        }
        kbCardHtml = `
          <div class="card overview-product-kb-card">
            <div class="card-title">Product knowledge</div>
            <p class="run-meta" style="margin-bottom:10px">
              Per-product markdown under <code style="font-size:12px">inputs/products/</code> is curated into the demo pipeline. Files are edit-and-save; research automatically refreshes baseline value propositions when <code>last_vp_research</code> is older than 30 days.
            </p>
            <p class="run-meta" style="margin-bottom:12px">${summaryBits.join(' · ')}</p>
            <p style="margin-bottom:10px">
              <button type="button" class="btn btn-sm btn-primary" id="overview-kb-open-tab">Open Product knowledge tab</button>
            </p>
            ${kbTop.length ? `
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:rgba(255,255,255,0.35);margin-bottom:6px">Recent product files</div>
            <ul class="overview-kb-queue">
              ${kbTop.map(e => {
                const short = e.name.replace(/^products\//, '');
                const loaded = Array.isArray(e.loadedBy) && e.loadedBy.length > 0;
                const last = e && e.frontmatter && e.frontmatter.last_vp_research;
                const ageDays = last ? Math.floor((now - new Date(String(last)).getTime()) / 86400000) : null;
                const stale = ageDays == null || !Number.isFinite(ageDays) || ageDays > 30 || ageDays < 0;
                const badges = [
                  loaded ? `<span class="overview-kb-badge" style="background:rgba(0,166,126,0.15);color:#00A67E">${esc(e.loadedBy.join(','))}</span>` : '<span class="overview-kb-badge overview-kb-badge--warn">not wired</span>',
                  stale ? '<span class="overview-kb-badge overview-kb-badge--warn">VPs stale</span>' : `<span class="overview-kb-badge">${ageDays}d</span>`,
                ].join(' ');
                return `<li><button type="button" class="overview-kb-file-btn" data-vp-name="${esc(e.name)}"><span class="overview-kb-file-label">${esc(short)}</span><span class="overview-kb-file-badges">${badges}</span></button></li>`;
              }).join('')}
            </ul>` : ''}
          </div>`;
      } else {
        kbCardHtml = `
          <div class="card overview-product-kb-card">
            <div class="card-title">Product knowledge</div>
            <p class="run-meta" style="margin-bottom:10px">No <code>*.md</code> files found in <code>inputs/products/</code>. Add product docs or let research seed them automatically when new products appear in demo builds.</p>
            <button type="button" class="btn btn-sm btn-secondary" id="overview-kb-open-tab">Open Product knowledge tab</button>
          </div>`;
      }

      const actionsHtml = `
        <div class="card">
          <div class="card-title">What You Can Do</div>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${canEditStoryboard
              ? `<div style="display:flex;align-items:center;gap:8px;font-size:13px"><span style="color:#00A67E">✓</span> <a href="#" onclick="event.preventDefault();window.switchTab&&window.switchTab('storyboard')" style="color:#00A67E">Edit Storyboard</a></div>`
              : `<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,0.3)"><span>○</span> Edit Storyboard — run script stage first</div>`}
            <div style="display:flex;align-items:center;gap:8px;font-size:13px">
              <span style="color:#00A67E">✓</span>
              <a href="#" onclick="event.preventDefault();window.switchTab&&window.switchTab('valueprop')" style="color:#00A67E">Product knowledge</a>
              <span style="color:rgba(255,255,255,0.35);font-size:11px">edit-and-save · inputs/products</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;font-size:13px">
              <span style="color:#00A67E">↗</span>
              <a href="/demo-app-preview/${esc(currentRunId)}" target="_blank" style="color:#00A67E">Launch &amp; Edit App</a>
            </div>
            ${canResync
              ? `<div style="display:flex;align-items:center;gap:8px;font-size:13px"><span style="color:#fbbf24">⚠</span> <a href="/timeline?run=${encodeURIComponent(currentRunId)}" target="_blank" style="color:#fbbf24">Audio sync is stale — open Timeline Editor to fix</a></div>`
              : ''}
            ${canRender
              ? `<div style="display:flex;align-items:center;gap:8px;font-size:13px"><span style="color:#00A67E">✓</span> <span style="color:rgba(255,255,255,0.7)">Ready to render — voiceover + processed recording available</span></div>`
              : ''}
          </div>
        </div>`;

      // Section C: Previous Builds — fetch all runs
      let prevBuildsHtml = '';
      try {
        const allRunsRaw = await api('/api/runs');
        const allRunsData = Array.isArray(allRunsRaw) ? { runs: allRunsRaw } : allRunsRaw;
        const allRuns = allRunsData.runs || [];
        if (allRuns.length > 1) {
          const rowsHtml = allRuns.map(r => {
            const rScript = r.script || {};
            const rCompany = rScript.company || '';
            const rProduct = rScript.product || extractProduct(r.runId);
            const rQa = r.qaScore != null ? `<span class="chip ${scoreChipClass(r.qaScore)}">${r.qaScore}</span>` : '<span style="color:rgba(255,255,255,0.3)">–</span>';
            const rStages = (r.completedStages || []).length + '/' + STAGES.length;
            const rArtifacts = r.artifacts || {};
            const videoBtn = rArtifacts.mp4
              ? `<a href="/api/files/${esc(r.runId)}/demo-scratch.mp4" target="_blank" class="btn btn-sm btn-secondary" style="text-decoration:none;font-size:11px">▶ Video</a>`
              : '';
            const loadBtn = r.runId !== currentRunId
              ? `<button class="btn btn-sm btn-secondary overview-load-run-btn" data-run-id="${esc(r.runId)}" style="font-size:11px">Load</button>`
              : `<span style="font-size:11px;color:#00A67E">Current</span>`;
            return `<tr>
              <td style="font-size:12px;color:rgba(255,255,255,0.6);white-space:nowrap">${esc(formatDate(r.runId))}</td>
              <td style="font-size:12px">${esc(rCompany || '–')}</td>
              <td style="font-size:12px">${esc(rProduct)}</td>
              <td>${rQa}</td>
              <td style="font-size:12px;color:rgba(255,255,255,0.5)">${rStages}</td>
              <td style="display:flex;gap:6px;align-items:center">${videoBtn} ${loadBtn}</td>
            </tr>`;
          }).join('');
          prevBuildsHtml = `
            <div class="card">
              <div class="card-title">Previous Builds</div>
              <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:13px">
                  <thead><tr style="color:rgba(255,255,255,0.35);font-size:10px;text-transform:uppercase;letter-spacing:0.06em">
                    <th style="text-align:left;padding:4px 8px 8px 0">Date</th>
                    <th style="text-align:left;padding:4px 8px 8px 0">Company</th>
                    <th style="text-align:left;padding:4px 8px 8px 0">Product</th>
                    <th style="text-align:left;padding:4px 8px 8px 0">QA</th>
                    <th style="text-align:left;padding:4px 8px 8px 0">Stages</th>
                    <th style="text-align:left;padding:4px 8px 8px 0">Actions</th>
                  </tr></thead>
                  <tbody>${rowsHtml}</tbody>
                </table>
              </div>
            </div>`;
        }
      } catch (_) {}

      el.innerHTML = `
        <div class="card">
          <div class="run-title">${esc(currentRunId)}</div>
          <div class="run-meta">${esc([company, product, persona, formatDate(currentRunId)].filter(Boolean).join(' · '))}</div>
        </div>
        ${audioSyncWarnHtml}
        ${resumeHtml}
        <div class="card">
          <div class="card-title">Artifacts</div>
          <div class="artifact-grid">${badgesHtml}</div>
          <div class="card-title" style="margin-top:16px;margin-bottom:8px">Pipeline Stages</div>
          ${checklistHtml}
        </div>
        ${qaHtml}
        ${actionsHtml}
        ${kbCardHtml}
        ${prevBuildsHtml}`;

      el.querySelector('#overview-kb-open-tab')?.addEventListener('click', () => switchTab('valueprop'));
      el.querySelectorAll('.overview-kb-file-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.getAttribute('data-vp-name');
          if (name) _vpPendingOpenName = name;
          switchTab('valueprop');
        });
      });

      // Wire Previous Builds "Load" buttons
      el.querySelectorAll('.overview-load-run-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const runId = btn.dataset.runId;
          if (!runId) return;
          currentRunId = runId;
          storyboardLivePreviewUrl = null;
          storyboardSelectedStepId = null;
          localStorage.setItem('lastRunId', runId);
          const selectorLabel = document.getElementById('build-selector-label');
          if (selectorLabel) selectorLabel.textContent = runId;
          loadCurrentRun();
        });
      });

      // Wire pipeline timeline pill clicks → jump to Pipeline tab with stage pre-selected
      const timeline = el.querySelector('.pipeline-timeline');
      if (timeline) {
        timeline.addEventListener('click', (e) => {
          const pill = e.target.closest('.timeline-item[role="button"]');
          if (!pill) return;
          const stageName = pill.dataset.stage;
          switchTab('pipeline');
          setTimeout(() => {
            const sel = document.getElementById('stage-select');
            if (sel) {
              const opt = sel.querySelector(`option[value="${CSS.escape(stageName)}"]:not([disabled])`);
              if (opt) sel.value = stageName;
            }
          }, 150);
        });
      }

      // Wire up audio resync button (overview warning card)
      const overviewOpenTimelineBtn = document.getElementById('overview-open-timeline-btn');
      if (overviewOpenTimelineBtn) {
        overviewOpenTimelineBtn.addEventListener('click', () => {
          window.open(`/timeline?run=${encodeURIComponent(currentRunId)}`, '_blank', 'noopener,noreferrer');
        });
      }

      // Wire up audio resync button (overview warning card)
      const overviewResyncBtn = document.getElementById('overview-resync-btn');
      if (overviewResyncBtn) {
        overviewResyncBtn.addEventListener('click', async () => {
          overviewResyncBtn.disabled = true;
          overviewResyncBtn.textContent = 'Starting…';
          try {
            await runPipeline( { fromStage: 'resync-audio', resumeRunId: currentRunId });
            showToast('Resync audio started', 'success');
            switchTab('pipeline');
            setPipelineRunning(true);
          } catch (e) {
            showToast('Failed: ' + e.message, 'error');
            overviewResyncBtn.disabled = false;
            overviewResyncBtn.textContent = '⟳ Resync Audio Now';
          }
        });
      }

      // Wire up resume button
      const resumeBtn = document.getElementById('resume-run-btn');
      if (resumeBtn && nextStage) {
        resumeBtn.addEventListener('click', async () => {
          resumeBtn.disabled = true;
          resumeBtn.textContent = 'Starting…';
          try {
            await runPipeline({
              fromStage: nextStage,
              resumeRunId: currentRunId,
              applyUiToStage: true,
            });
            showToast(`Pipeline resumed from ${nextStage}`, 'success');
            switchTab('pipeline');
          } catch (e) {
            showToast('Resume failed: ' + e.message, 'error');
            resumeBtn.disabled = false;
            resumeBtn.innerHTML = `Resume from <strong style="margin-left:4px">${esc(nextStage)}</strong>`;
          }
        });
      }
    } catch (e) {
      el.innerHTML = `<div class="empty-state error">Failed to load overview: ${esc(e.message)}</div>`;
    }
  }

  function extractProduct(runId) {
    // "2026-03-11-layer-v6" → "layer"
    const m = (runId || '').match(/^\d{4}-\d{2}-\d{2}-(.+?)-v\d+$/);
    return m ? m[1] : runId || '–';
  }

  function scoreChipClass(score) {
    if (score == null) return '';
    if (score >= 80) return 'chip-green';
    if (score >= 60) return 'chip-amber';
    return 'chip-red';
  }

  // ── Config Tab ─────────────────────────────────────────────────────────────

  async function loadConfig() {
    const el = document.getElementById('config-content');
    el.innerHTML = '<div class="empty-state">Loading config…</div>';

    try {
      const [configData, promptData] = await Promise.allSettled([
        api('/api/config'),
        api('/api/config/prompt'),
      ]);

      const cfg = configData.status === 'fulfilled' ? (configData.value.config || configData.value || {}) : {};
      const promptText = promptData.status === 'fulfilled' ? (promptData.value.content || '') : '';

      el.innerHTML = `
        <form id="config-form">
          <div class="card">
            <div class="card-title">Build Strategy</div>
            ${renderCheckbox('PIPELINE_WITH_SLIDES', cfg, 'MASTER SWITCH. When OFF (default), the pipeline runs in app-only mode — host product UI only, no Plaid-branded insight/slide interstitials. When ON, the pipeline also produces slide scenes (insights, final value-summary slide). Pairs with the --with-slides / --app-only CLI flags.')}
            ${renderSelect('BUILD_SLIDES_STRATEGY', cfg, 'How slide scenes are produced when PIPELINE_WITH_SLIDES is on. post-agent (default) runs a dedicated per-slide insertion stage AFTER build-qa, so each slide gets focused LLM context (higher quality). inline is the legacy one-shot build where slides share the prompt with the app (cheaper, lower quality).', [
              { value: 'post-agent', label: 'post-agent (default — per-slide insertion after app build)' },
              { value: 'inline', label: 'inline (legacy — slides built in the same prompt as the app)' },
            ])}
            ${renderSelect('RESEARCH_MODE', cfg, 'Budget for the research stage. gapfill (default) only fills targeted API/messaging gaps using the per-product KB as baseline. full does broad Glean + Gong + collateral + docs research (slowest). messaging focuses on Gong color & objections. skip disables research entirely and uses only existing per-product KB files.', [
              { value: 'gapfill', label: 'gapfill (default — targeted API / messaging gap-fill)' },
              { value: 'full', label: 'full (broad Gong + collateral + docs research)' },
              { value: 'messaging', label: 'messaging (Gong / objections / customer stories only)' },
              { value: 'skip', label: 'skip (no research — rely entirely on per-product KB)' },
            ])}
            ${renderCheckbox('LAYERED_BUILD_ENABLED', cfg, 'Run the optional framework → data → polish layered build contract. Splits the build into three explicit LLM passes with stricter per-pass contracts. Produces higher fidelity HTML on complex demos at roughly 2x LLM cost. Off by default.')}
          </div>

          <div class="card">
            <div class="card-title">Pipeline Behavior</div>
            ${renderCheckbox('SCRATCH_AUTO_APPROVE', cfg, 'Skip all human-confirmation "press ENTER to continue" gates between pipeline stages. Required for CLI non-interactive runs and for the dashboard. Turn off only if you want to approve each stage manually.')}
            ${renderCheckbox('MANUAL_RECORD', cfg, 'Use the manual-operator Playwright recording path (human drives the UI) instead of the automated step-by-step recorder. Primarily useful for demos where the automation hits a wall on a specific institution or flow.')}
            ${renderCheckbox('FIGMA_REVIEW', cfg, 'Enable the Figma design-review stage, which posts QA screenshots to a configured Figma file for design-team comment. Requires FIGMA credentials in .env (not editable here).')}
            ${renderCheckbox('TOUCHUP_ENABLED', cfg, 'Controls the LLM build-fix-mode fallback during the build-qa refinement loop: when ON and the orchestrator picks "touchup" mode, the LLM does a narrowed regen of the lowest-scoring step. When OFF, that path falls through to "fullbuild" (full app regen). Note: this does NOT control the post-render Remotion polish stage — that is gated by the --no-touchup CLI flag. Three different "touchup" things share a name; this toggle is the LLM build-fix one.')}
            ${renderNumberField('MAX_REFINEMENT_ITERATIONS', cfg, 'Max QA refinement loops after the initial build (1–10). Each iteration re-runs build-qa and either does an LLM regen or hands an agent a per-step task .md (in agent mode). Default 5; was 3 prior to the hyper-realism upgrade.', 1, 10)}
            ${renderCheckbox('SKIP_BRAND_SITE_SCREENSHOT', cfg, 'Skip the brand-extract viewport screenshot of the customer brand URL (Brandfetch still runs for logo + colors). Saves ~15s per run; turn on when you trust the brand JSON and do not need fresh site inspiration for the build prompt.')}
            ${renderCheckbox('MOBILE_VISUAL_ENABLED', cfg, 'Render the host app inside a simulated mobile device shell (phone chrome). Used for Layer demos and other mobile-first flows. Only affects non-slide scenes.')}
            ${renderCheckbox('VERBOSE', cfg, 'Emit verbose pipeline logs. Useful when debugging a stuck stage or unexpected behavior; noisy for routine runs.')}
            ${renderSelect('BUILD_FIX_MODE', cfg, 'How refinement iterations route QA failures. "auto" (recommended) picks between agent-touchup, touchup, and fullbuild based on signals + agent context. "agent-touchup" pauses on a continue-gate so an AI agent (Cursor / Claude Code) makes surgical edits — DEFAULT under PIPE_AGENT_MODE=1. "touchup" is the legacy LLM-narrowed regen of the lowest-scoring step. "fullbuild" regenerates the whole HTML.', [
              { value: 'auto', label: 'auto (recommended)' },
              { value: 'agent-touchup', label: 'agent-touchup (default in agent mode)' },
              { value: 'touchup', label: 'touchup (legacy LLM regen, narrowed)' },
              { value: 'fullbuild', label: 'fullbuild (full LLM regen)' },
            ])}
          </div>

          <div class="card">
            <div class="card-title">QA & Guardrails</div>
            ${renderSelect('PLAID_LINK_QA_MODE', cfg, 'Depth of the plaid-link-qa stage that verifies /link/token/create works before the full pipeline proceeds. auto picks token-only for most runs. full does an end-to-end Playwright walkthrough of the Link modal. token-only just probes the token endpoint. skip disables the stage entirely (useful for embedded Link where the launch happens inside the iframe).', [
              { value: 'auto', label: 'auto (default — token-only for most runs)' },
              { value: 'full', label: 'full (end-to-end Playwright walkthrough)' },
              { value: 'token-only', label: 'token-only (probe /link/token/create only)' },
              { value: 'skip', label: 'skip (disable the stage entirely)' },
            ])}
            ${renderSelect('BUILD_QA_PLAID_MODE', cfg, 'How build-qa exercises the Plaid Link iframe during the full walkthrough of all steps. Same modes as PLAID_LINK_QA_MODE. token-only is fastest and matches most dashboard workflows; full slows the run significantly.', [
              { value: 'auto', label: 'auto' },
              { value: 'full', label: 'full' },
              { value: 'token-only', label: 'token-only' },
              { value: 'skip', label: 'skip' },
            ])}
            ${renderCheckbox('BUILD_QA_DETERMINISTIC_GATE', cfg, 'Enable the deterministic hard-gate in build-qa. When on, the pipeline refuses to proceed to record if any required DOM contract is missing (e.g. missing step div, broken goToStep). Strongly recommended — disable only for diagnostic runs.')}
            ${renderCheckbox('CLAIM_CHECK_STRICT', cfg, 'Hard-fail the pipeline if narration contains numeric or factual claims that are not backed by the approved-claims digest. Default is warn-and-continue. Strict mode is useful for final production runs; disruptive for iterative builds.')}
            ${renderSelect('PRODUCT_KB_MIN_CONFIDENCE', cfg, 'Confidence threshold for AI research findings to be appended into inputs/products/*.md. medium is the default and captures most useful findings. high is stricter and only accepts findings the model labeled high-confidence.', [
              { value: 'medium', label: 'medium (default)' },
              { value: 'high', label: 'high (stricter)' },
            ])}
          </div>

          <div class="card">
            <div class="card-title">Recording Quality</div>
            ${renderSelect('RECORDING_FPS', cfg, 'Frame rate used by Playwright during the record stage. 30 fps is standard and matches most viewing platforms. 60 fps produces smoother motion but doubles disk usage and makes post-processing slower.', [
              { value: '30', label: '30 fps' },
              { value: '60', label: '60 fps' },
            ])}
            ${renderNumberField('QA_PASS_THRESHOLD', cfg, 'Minimum QA score (0–100) the build-qa vision review must hit for the pipeline to advance to record without another refinement loop. 80 is a good balance; drop to 70 for faster iteration, raise to 90 for production-grade polish.', 0, 100)}
            ${renderCheckbox('RECORD_TRANSITION_SAFE_TIMING', cfg, 'Align step-boundary timing marks with when goToStep() finishes settling in the DOM (instead of when it is called). Prevents the next step from appearing briefly on the previous step\'s video frames. On by default unless you are debugging recorder timing.')}
            ${renderNumberField('STEP_TRANSITION_SETTLE_MS', cfg, 'How long (ms) the recorder waits after goToStep() before marking the next step boundary. 400–600ms is typical. Raise when you see brief flashes of the previous step in frames; lower to speed up recordings for tight demos.', 100, 2000)}
            ${renderNumberField('POST_LINK_STEP_BOUNDARY_GUARD_MS', cfg, 'Extra delay (ms) added before the first step boundary AFTER the Plaid Link modal closes. Gives the host app time to mount the post-Link confirmation screen. Raise if the first frame after Link looks empty; lower for snappier demos. 0–3000ms.', 0, 3000)}
          </div>

          <div class="card">
            <div class="card-title">Audio / Sync Automation</div>
            ${renderCheckbox('AUTO_GAP_PRESERVE_MANUAL', cfg, 'When the auto-gap stage recomputes inter-scene gaps, preserve any timeline edits you made in the Storyboard timeline editor. Off = auto-gap overwrites manual adjustments with its computed values. On = manual edits win; only auto-derived gaps get recomputed.')}
            ${renderCheckbox('EMBED_SYNC_AUTO_APPLY', cfg, 'When the embed-sync stage detects audio/video drift above threshold, automatically apply the correction. Off = drift is reported in the storyboard and you apply it manually with the Timeline Editor. On = corrections apply silently (fewer approvals, less control).')}
            ${renderCheckbox('AI_SUGGEST_AUTO_APPLY', cfg, 'When the ai-suggest-overlays stage recommends overlays (callouts, zoom-punches) above the confidence threshold, apply them automatically. Off = suggestions show up as pending actions in the Storyboard tab for human review.')}
          </div>

          <div class="card">
            <div class="card-title">Plaid SDK</div>
            ${renderSelect('PLAID_ENV', cfg, 'Plaid API environment. sandbox is the default and only safe setting for demo recordings — uses test credentials and has no real money movement. production is used only if you have a specific sanctioned live demo; do not change without coordinating with the Plaid sandbox owner.', [
              { value: 'sandbox', label: 'Sandbox' },
              { value: 'production', label: 'Production' },
            ])}
            ${renderCheckbox('PLAID_LINK_LIVE', cfg, 'Use the real Plaid Link SDK in the generated demo app (iframe + /link/token/create + OAuth flows). Off = simulated Link UI (faster, no Plaid sandbox calls, but not visually identical to the real modal). On is required for recording genuine Plaid Link demos.')}
            ${renderTextField('PLAID_LINK_CUSTOMIZATION', cfg, 'Name of the Plaid Link customization profile to apply (brand colors, logo, etc. configured in the Plaid Dashboard). E.g. "ascend". Leave blank for the default Plaid Link look.')}
            ${renderTextField('PLAID_LAYER_TEMPLATE_ID', cfg, 'Plaid Layer template ID (e.g. template_xxxxxxxxx) for Layer-based demos. Leave blank for non-Layer demos. Only used when the demo script includes a Layer scene.')}
          </div>

          <div class="card">
            <div class="card-title">Dashboard (meta)</div>
            ${renderCheckbox('DASHBOARD_WRITE', cfg, 'Re-enables the legacy in-dashboard pipeline runner buttons (Run / Kill / Continue). Default off — the dashboard is read-only and pipeline runs happen via `npm run pipe` CLI. Change takes effect after a dashboard server restart (it is read at boot time, not per request).')}
          </div>

          <div class="card">
            <div class="card-title">Voice / Audio</div>
            <div class="form-group">
              <label class="config-label">ELEVENLABS_VOICE_ID</label>
              <div id="voice-picker-wrap">
                <div class="voice-picker-controls">
                  <input type="text" id="voice-search" placeholder="Search by name or description…" class="config-input" style="margin-bottom:8px">
                  <div class="voice-filters">
                    <select id="vf-gender" class="config-input voice-filter-sel"><option value="">Any gender</option><option>male</option><option>female</option></select>
                    <select id="vf-accent" class="config-input voice-filter-sel"><option value="">Any accent</option><option>american</option><option>british</option><option>australian</option><option>irish</option><option>african</option><option>swedish</option></select>
                    <select id="vf-age" class="config-input voice-filter-sel"><option value="">Any age</option><option>young</option><option>middle_aged</option><option>old</option></select>
                    <select id="vf-usecase" class="config-input voice-filter-sel"><option value="">Any use case</option><option>conversational</option><option>news</option><option>narrative_story</option><option>characters_animation</option><option>social_media</option></select>
                    <select id="vf-descriptive" class="config-input voice-filter-sel"><option value="">Any tone</option><option>casual</option><option>professional</option><option>intense</option><option>calm</option><option>classy</option><option>well-rounded</option></select>
                  </div>
                </div>
                <div id="voice-picker-status" class="config-desc" style="margin:6px 0">Loading voices…</div>
                <div id="voice-cards" class="voice-cards"></div>
              </div>
              <!-- Hidden input carries the actual value for saveConfig() -->
              <input type="hidden" name="ELEVENLABS_VOICE_ID" id="voice-id-hidden" value="${esc(cfg['ELEVENLABS_VOICE_ID'] || '')}">
              <div class="config-desc" style="margin-top:4px">
                Selected: <strong id="voice-selected-name">${esc(cfg['ELEVENLABS_VOICE_ID'] || '(none)')}</strong>
              </div>
            </div>
            ${renderSelect('ELEVENLABS_OUTPUT_FORMAT', cfg, 'ElevenLabs output audio format', [
              { value: 'mp3_44100_128', label: 'MP3 44.1kHz 128kbps' },
              { value: 'mp3_44100_192', label: 'MP3 44.1kHz 192kbps (recommended)' },
              { value: 'pcm_24000', label: 'PCM 24kHz' },
            ])}
          </div>

          <div class="card" style="text-align:right">
            <button type="button" id="save-config-btn" class="btn btn-primary">Save Config</button>
            <p class="save-hint">Saved settings apply on the next pipeline run.</p>
          </div>
        </form>

        <div class="card">
          <div class="card-title">inputs/prompt.txt</div>
          <textarea id="prompt-editor" style="width:100%;min-height:200px;box-sizing:border-box">${esc(promptText)}</textarea>
          <button type="button" id="save-prompt-btn" class="btn btn-secondary btn-sm" style="margin-top:8px">Save Prompt</button>
        </div>`;

      document.getElementById('save-config-btn').addEventListener('click', saveConfig);
      document.getElementById('save-prompt-btn').addEventListener('click', savePrompt);

      // Kick off voice picker (async, non-blocking)
      loadVoicePicker(cfg['ELEVENLABS_VOICE_ID'] || '');

    } catch (e) {
      el.innerHTML = `<div class="empty-state error">Failed to load config: ${esc(e.message)}</div>`;
    }
  }

  // Helper: render a small "?" icon that reveals the tooltip on hover. CSS
  // does the heavy lifting — see .config-hint-tip in dashboard.css. Both
  // the icon and the label carry the same tooltip text so hovering either
  // one shows the same description.
  function renderHintIcon(tooltip) {
    return `<span class="config-hint" data-tip="${esc(tooltip)}" tabindex="0" aria-label="More info">?</span>`;
  }

  function renderCheckbox(key, cfg, tooltip) {
    const checked = cfg[key] === true || cfg[key] === 'true' ? 'checked' : '';
    return `
      <label class="config-field config-field--checkbox">
        <input type="checkbox" name="${key}" ${checked}>
        <span class="config-label">${key}</span>
        ${renderHintIcon(tooltip)}
      </label>`;
  }

  function renderNumberField(key, cfg, tooltip, min, max) {
    const val = cfg[key] != null ? cfg[key] : '';
    return `
      <div class="config-field">
        <label class="config-label">${key}${renderHintIcon(tooltip)}</label>
        <input type="number" name="${key}" value="${esc(String(val))}" min="${min}" max="${max}" class="config-input">
      </div>`;
  }

  function renderTextField(key, cfg, tooltip) {
    const val = cfg[key] != null ? cfg[key] : '';
    return `
      <div class="config-field">
        <label class="config-label">${key}${renderHintIcon(tooltip)}</label>
        <input type="text" name="${key}" value="${esc(String(val))}" class="config-input">
      </div>`;
  }

  function renderSelect(key, cfg, tooltip, options) {
    const val = cfg[key] != null ? cfg[key] : '';
    const opts = options.map(o =>
      `<option value="${esc(o.value)}" ${val === o.value ? 'selected' : ''}>${esc(o.label)}</option>`
    ).join('');
    return `
      <div class="config-field">
        <label class="config-label">${key}${renderHintIcon(tooltip)}</label>
        <select name="${key}" class="config-input">${opts}</select>
      </div>`;
  }

  async function saveConfig() {
    const form = document.getElementById('config-form');
    if (!form) return;
    const data = {};
    form.querySelectorAll('input, select').forEach(el => {
      if (!el.name) return;
      if (el.type === 'checkbox') data[el.name] = el.checked;
      else data[el.name] = el.value;
    });
    const saveBtn = document.getElementById('save-config-btn');
    const originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
      await apiPost('/api/config', data);
      // Round-trip verify: re-read from the server so the form reflects what
      // was actually persisted to `.env`. Prevents "I saved but the form looks
      // unchanged, did it stick?" confusion.
      const fresh = await api('/api/config');
      const freshCfg = (fresh && typeof fresh === 'object') ? (fresh.config || fresh) : {};
      syncFormFromConfig(form, freshCfg);
      const ts = new Date().toLocaleTimeString();
      showToast(`Saved to .env at ${ts} — restart the pipeline to apply`, 'success');
      const hint = document.querySelector('.save-hint');
      if (hint) hint.textContent = `Last saved ${ts}. Restart the pipeline to apply.`;
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = originalLabel || 'Save Config'; }
    }
  }

  // Rewrite form inputs to reflect the authoritative server-side config.
  // Called after save so the user sees the same values that were persisted.
  function syncFormFromConfig(form, cfg) {
    if (!form || !cfg || typeof cfg !== 'object') return;
    form.querySelectorAll('input[name], select[name]').forEach((el) => {
      const k = el.name;
      if (!(k in cfg)) {
        // Key not present in .env → leave checkbox unchecked, other inputs
        // render with their default (first option / empty string).
        if (el.type === 'checkbox') el.checked = false;
        return;
      }
      const v = cfg[k];
      if (el.type === 'checkbox') {
        el.checked = v === true || v === 'true';
      } else {
        el.value = (v == null) ? '' : String(v);
      }
    });
  }

  async function savePrompt() {
    const ta = document.getElementById('prompt-editor');
    if (!ta) return;
    try {
      await apiPost('/api/config/prompt', { content: ta.value });
      showToast('Prompt saved', 'success');
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
    }
  }

  // ── Files Tab ──────────────────────────────────────────────────────────────

  async function loadFiles() {
    if (!currentRunId) return;
    const runIdAtStart = currentRunId;
    const loadToken = ++_filesLoadToken;
    const el = document.getElementById('files-content');
    el.innerHTML = '<div class="empty-state">Loading files…</div>';

    try {
      const data = await api('/api/runs/' + runIdAtStart);
      if (loadToken !== _filesLoadToken || runIdAtStart !== currentRunId) return;
      const files = data.files || [];

      // Group files
      const groups = {
        Videos: files.filter(f => /\.(webm|mp4)$/.test(f.name)),
        Audio: files.filter(f => /^audio\/.*\.mp3$/.test(f.name) || /\.mp3$/.test(f.name)),
        Reports: files.filter(f => /\.json$/.test(f.name)),
        Slides: files.filter(f => /\.pptx$/.test(f.name)),
        App: files.filter(f => /^scratch-app\//.test(f.name)),
      };

      const listHtml = Object.entries(groups).map(([group, items]) => {
        if (items.length === 0) return '';
        const itemsHtml = items.map(f => `
          <div class="file-item ${f.missing ? 'file-missing' : ''}" data-name="${esc(f.name)}" data-size="${f.size || 0}">
            <span class="file-name">${esc(f.name)}</span>
            <span class="file-size">${f.missing ? '(missing)' : formatBytes(f.size || 0)}</span>
          </div>`).join('');
        return `<div class="file-group"><div class="file-group-title">${esc(group)}</div>${itemsHtml}</div>`;
      }).join('');

      el.innerHTML = `
        <div class="files-layout">
          <div class="files-list">
            <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
              <a class="btn btn-sm btn-primary" href="/api/runs/${encodeURIComponent(runIdAtStart)}/download-app-package">
                Download
              </a>
            </div>
            ${listHtml || '<div class="empty-state">No files found</div>'}
          </div>
          <div class="files-preview" id="files-preview"><div class="empty-state">Select a file to preview</div></div>
        </div>`;

      el.querySelectorAll('.file-item:not(.file-missing)').forEach(item => {
        item.addEventListener('click', () => previewFile(item.dataset.name, el));
      });

    } catch (e) {
      el.innerHTML = `<div class="empty-state error">Failed to load files: ${esc(e.message)}</div>`;
    }
  }

  async function previewFile(filename, parentEl) {
    const preview = parentEl.querySelector('#files-preview');
    if (!preview) return;
    preview.innerHTML = '<div class="empty-state">Loading…</div>';

    const url = '/api/files/' + currentRunId + '/' + encodeURIComponent(filename);
    const ext = filename.split('.').pop().toLowerCase();

    if (ext === 'mp4' || ext === 'webm') {
      preview.innerHTML = `<video controls src="${url}" style="width:100%;max-height:400px;display:block"></video>`;
    } else if (ext === 'mp3') {
      preview.innerHTML = `<audio controls src="${url}" style="width:100%;display:block"></audio>`;
    } else if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif') {
      preview.innerHTML = `<img src="${url}" style="max-width:100%;display:block" alt="${esc(filename)}">`;
    } else if (ext === 'pptx') {
      preview.innerHTML = `<div class="empty-state"><a href="${url}" download="${esc(filename)}" class="btn btn-secondary">Download ${esc(filename)}</a></div>`;
    } else if (ext === 'json') {
      try {
        const res = await fetch(url);
        const text = await res.text();
        let pretty = text;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
        preview.innerHTML = `<pre class="json-preview">${syntaxHighlightJSON(pretty)}</pre>`;
      } catch (e) {
        preview.innerHTML = `<div class="empty-state error">Could not load file: ${esc(e.message)}</div>`;
      }
    } else {
      preview.innerHTML = `<div class="empty-state"><a href="${url}" download="${esc(filename)}" class="btn btn-secondary">Download ${esc(filename)}</a></div>`;
    }
  }

  // ── Storyboard Tab ─────────────────────────────────────────────────────────

  async function ensureStoryboardLivePreview(runId) {
    if (!runId) return null;
    if (storyboardLivePreviewUrl) return storyboardLivePreviewUrl;
    try {
      const res = await apiPost('/api/runs/' + runId + '/storyboard-live-preview', {});
      storyboardLivePreviewUrl = res && res.url ? String(res.url) : null;
      return storyboardLivePreviewUrl;
    } catch (_) {
      storyboardLivePreviewUrl = null;
      return null;
    }
  }

  function postStoryboardPreviewMessage(msg) {
    const iframe = document.getElementById('sb-live-iframe');
    if (!iframe || !iframe.contentWindow || !storyboardLivePreviewUrl) return;
    let origin = '*';
    try { origin = new URL(storyboardLivePreviewUrl).origin; } catch (_) {}
    iframe.contentWindow.postMessage(msg, origin);
  }

  function setStoryboardSelectedStep(stepId, rootEl, opts = {}) {
    if (!stepId || !rootEl) return;
    const suppressPost = !!opts.suppressPost;
    storyboardSelectedStepId = String(stepId).replace(/^step-/, '');
    rootEl.querySelectorAll('.step-card').forEach((card) => {
      card.classList.toggle('storyboard-step-selected', card.dataset.stepId === storyboardSelectedStepId);
    });
    const sel = document.getElementById('sb-live-step-select');
    if (sel && sel.value !== storyboardSelectedStepId) sel.value = storyboardSelectedStepId;
    const liveTa = document.getElementById('sb-live-narration');
    const stepTa = rootEl.querySelector(`.narration-area[data-step-id="${storyboardSelectedStepId}"]`);
    if (liveTa && stepTa && liveTa.value !== stepTa.value) liveTa.value = stepTa.value;
    const title = document.getElementById('sb-live-selected-step');
    if (title) title.textContent = storyboardSelectedStepId;
    if (!suppressPost) {
      postStoryboardPreviewMessage({ type: 'STORYBOARD_SET_STEP', stepId: storyboardSelectedStepId });
    }
  }

  function bindStoryboardPreviewMessageBridge() {
    if (storyboardMessageBridgeBound) return;
    storyboardMessageBridgeBound = true;
    window.addEventListener('message', (evt) => {
      const msg = evt && evt.data ? evt.data : null;
      if (!msg || typeof msg !== 'object') return;
      if (!/^(STORYBOARD_PREVIEW_READY|STORYBOARD_STEP_CHANGED)$/i.test(String(msg.type || ''))) return;
      if (!currentRunId || msg.runId !== currentRunId) return;
      if (currentTab !== 'storyboard') return;
      if (!storyboardLivePreviewUrl) return;
      let expectedOrigin = null;
      try { expectedOrigin = new URL(storyboardLivePreviewUrl).origin; } catch (_) {}
      if (expectedOrigin && evt.origin !== expectedOrigin) return;

      const rootEl = document.getElementById('storyboard-content');
      if (!rootEl) return;

      if (msg.type === 'STORYBOARD_PREVIEW_READY') {
        if (storyboardSelectedStepId) {
          postStoryboardPreviewMessage({ type: 'STORYBOARD_SET_STEP', stepId: storyboardSelectedStepId });
        }
        return;
      }
      if (msg.type === 'STORYBOARD_STEP_CHANGED') {
        const sid = String(msg.stepId || '').replace(/^step-/, '');
        if (!sid) return;
        storyboardPreviewSyncing = true;
        setStoryboardSelectedStep(sid, rootEl, { suppressPost: true });
        const narration = typeof msg.narration === 'string' ? msg.narration : null;
        if (narration != null) {
          const liveTa = document.getElementById('sb-live-narration');
          if (liveTa) liveTa.value = narration;
          const ta = rootEl.querySelector(`.narration-area[data-step-id="${sid}"]`);
          if (ta && ta.value !== narration) {
            ta.value = narration;
            ta.dispatchEvent(new Event('input'));
          }
        }
        storyboardPreviewSyncing = false;
      }
    });
  }

  function renderStoryboardLiveWorkspace(script, liveUrl) {
    const steps = (script && script.steps) || [];
    if (!storyboardSelectedStepId || !steps.some(s => s.id === storyboardSelectedStepId)) {
      storyboardSelectedStepId = steps[0] ? steps[0].id : null;
    }
    const options = steps.map((s) => `<option value="${esc(s.id)}"${s.id === storyboardSelectedStepId ? ' selected' : ''}>${esc(s.id)} — ${esc(s.label || '')}</option>`).join('');
    const selectedStep = steps.find((s) => s.id === storyboardSelectedStepId);
    const selectedNarration = selectedStep ? String(selectedStep.narration || '') : '';
    const iframeHtml = liveUrl
      ? `<iframe id="sb-live-iframe" class="sb-live-iframe" src="${esc(liveUrl)}" title="Live demo app preview"></iframe>`
      : `<div class="sb-live-empty">Build app preview not available yet. Run build stage, then reload Storyboard.</div>`;
    return `
      <div class="card storyboard-live-workspace">
        <div class="storyboard-live-header">
          <div class="card-title" style="margin:0">Live Storyboard Workspace</div>
          <span class="chip">Step: <span id="sb-live-selected-step">${esc(storyboardSelectedStepId || 'none')}</span></span>
        </div>
        <div class="storyboard-live-grid">
          <div class="storyboard-live-preview">${iframeHtml}</div>
          <div class="storyboard-live-editor">
            <label>Selected step</label>
            <select id="sb-live-step-select" class="config-input">${options}</select>
            <label style="margin-top:10px">Narration (stored in demo script and app screen metadata)</label>
            <textarea id="sb-live-narration" class="narration-area" style="min-height:180px">${esc(selectedNarration)}</textarea>
            <div class="step-actions">
              <button class="btn btn-sm btn-primary" id="sb-live-save-btn">Save narration</button>
              <button class="btn btn-sm btn-secondary" id="sb-live-revert-btn">Revert</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  async function loadStoryboard() {
    if (!currentRunId) return;
    const runIdAtStart = currentRunId;
    const loadToken = ++_storyboardLoadToken;
    bindStoryboardPreviewMessageBridge();
    const el = document.getElementById('storyboard-content');
    el.innerHTML = '<div class="empty-state">Loading storyboard…</div>';
    originalNarrations = {};
    // _stepVisualNotes is now a const stub (Review Feedback was removed);
    // no per-load reset needed.

    try {
      const [scriptData, qaData, framesData, timingData, autoGapData, syncMapData] = await Promise.allSettled([
        api('/api/runs/' + runIdAtStart + '/script'),
        api('/api/runs/' + runIdAtStart + '/qa'),
        api('/api/runs/' + runIdAtStart + '/frames'),
        api('/api/runs/' + runIdAtStart + '/timing'),
        api('/api/runs/' + runIdAtStart + '/auto-gap'),
        api('/api/runs/' + runIdAtStart + '/sync-map'),
      ]);
      if (loadToken !== _storyboardLoadToken || runIdAtStart !== currentRunId) return;

      const script    = scriptData.status  === 'fulfilled' ? scriptData.value  : null;
      const qa        = qaData.status      === 'fulfilled' ? qaData.value      : null;
      const syncMapSegs = syncMapData.status === 'fulfilled' ? (syncMapData.value.segments || []) : [];
      const framesVal  = framesData.status === 'fulfilled' ? framesData.value : {};
      // Server returns { files, source } or legacy plain array
      const framesList  = Array.isArray(framesVal) ? framesVal : (framesVal.files || []);
      const framesSource = Array.isArray(framesVal) ? 'qa-frames' : (framesVal.source || 'qa-frames');
      const timingSteps = timingData.status === 'fulfilled' ? (timingData.value.steps || []) : [];
      const autoGapReport = autoGapData.status === 'fulfilled' ? autoGapData.value : null;

      if (!script || !script.steps) {
        el.innerHTML = '<div class="empty-state">No demo script found for this run.</div>';
        return;
      }

      const livePreviewUrl = await ensureStoryboardLivePreview(runIdAtStart);
      if (loadToken !== _storyboardLoadToken || runIdAtStart !== currentRunId) return;
      const liveWorkspaceHtml = renderStoryboardLiveWorkspace(script, livePreviewUrl);

      // Build stepId → frame filenames map
      const frameMap = {};
      framesList.forEach(fname => {
        const m = fname.match(/^(.+?)-(start|mid|end)\.png$/);
        if (m) {
          const sid = m[1];
          if (!frameMap[sid]) frameMap[sid] = {};
          frameMap[sid][m[2]] = fname;
        }
      });

      // Build stepId → qa info map
      const qaMap = {};
      if (qa) {
        // allStepScores may be an object {stepId: score} or array [{stepId, score}]
        const scores = qa.allStepScores;
        if (scores && !Array.isArray(scores)) {
          Object.entries(scores).forEach(([id, score]) => { qaMap[id] = { score }; });
        } else if (Array.isArray(scores)) {
          scores.forEach(s => { qaMap[s.stepId || s.step] = { score: s.score }; });
        }
        (qa.stepsWithIssues || []).forEach(s => {
          const id = s.stepId || s.step;
          if (!qaMap[id]) qaMap[id] = {};
          qaMap[id].issues = s.issues || [];
          if (s.score != null) qaMap[id].score = s.score;
        });
      }

      // Build stepId → timing flags map
      const timingMap = {};
      timingSteps.forEach(t => { timingMap[t.id] = t; });

      // Build stepId → auto-gap info map (narrationMs, videoDurationMs, gapMs, speed, compStartMs, compEndMs)
      const gapMap = {};
      if (autoGapReport && autoGapReport.steps) {
        autoGapReport.steps.forEach(s => { gapMap[s.stepId] = s; });
      }

      function _toFiniteNumber(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }
      function _resolveCompStartSeconds(obj) {
        if (!obj || typeof obj !== 'object') return null;
        const secDirect = _toFiniteNumber(obj.compStart);
        if (secDirect != null) return secDirect;
        const secAlt = _toFiniteNumber(obj.compStartS);
        if (secAlt != null) return secAlt;
        const ms = _toFiniteNumber(obj.compStartMs);
        if (ms != null) return ms / 1000;
        return null;
      }
      function _resolveCompStartMs(obj) {
        if (!obj || typeof obj !== 'object') return null;
        const ms = _toFiniteNumber(obj.compStartMs);
        if (ms != null) return ms;
        const sec = _resolveCompStartSeconds(obj);
        if (sec != null) return sec * 1000;
        return null;
      }

      // Build compStart (rounded to 2dp) → sync-map segment map for speed lookups
      const syncSegByCompStart = {};
      syncMapSegs.forEach((s) => {
        const compStartS = _resolveCompStartSeconds(s);
        if (compStartS == null) return;
        syncSegByCompStart[compStartS.toFixed(2)] = s;
      });

      // Compute topic-bleed flags: does step[N]'s narration contain keywords from step[N+1]?
      const STOPWORDS = new Set([
        'about','after','again','along','already','also','among','another','before',
        'below','between','could','during','every','first','from','here','into','just',
        'like','more','most','much','near','never','next','other','over','should',
        'since','some','still','such','than','that','their','them','then','there',
        'these','they','this','those','through','under','until','upon','using','very',
        'well','what','when','where','which','while','with','within','would','your',
        'plaid','berta','wells','fargo','the','and','for','are','was','has','have',
        'will','can','its','her','his','from','into','onto',
      ]);
      function extractKeywords(text) {
        return (text || '').toLowerCase()
          .replace(/[^a-z\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length >= 5 && !STOPWORDS.has(w));
      }
      const topicBleedSet = new Set();
      if (script && script.steps) {
        script.steps.forEach((step, i) => {
          if (i === 0) return;
          const prevStep = script.steps[i - 1];
          // Keywords that belong to THIS step's label/narration opening
          const thisKeywords = new Set(extractKeywords(step.label + ' ' + step.narration.slice(0, 80)));
          // How many appear in the PREVIOUS step's narration?
          const prevWords = extractKeywords(prevStep.narration);
          const overlap = prevWords.filter(w => thisKeywords.has(w));
          const uniqueOverlap = [...new Set(overlap)];
          if (uniqueOverlap.length >= 2) {
            topicBleedSet.add(prevStep.id); // flag the previous step
          }
        });
      }

      const cardBlocks = script.steps.map(step => {
        const sid = step.id;
        originalNarrations[sid] = step.narration || '';
        const frames  = frameMap[sid]  || {};
        const qaInfo  = qaMap[sid]     || {};
        const timing  = timingMap[sid] || {};
        const issues  = qaInfo.issues  || [];
        const score   = qaInfo.score;
        const wc = wordCount(step.narration);
        const wcClass = wc > 35 ? 'over' : wc > 30 ? 'warn' : '';
        const hasIssues = issues.length > 0;
        const scoreChip = score != null
          ? `<span class="chip ${scoreChipClass(score)}">${score}</span>`
          : '';
        const durationS = step.durationMs ? (step.durationMs / 1000).toFixed(1) : '–';
        const midFrameUrl = frames.mid
          ? '/api/runs/' + currentRunId + '/frames/' + encodeURIComponent(frames.mid)
          : null;
        const libraryThumbUrl = step.slideLibraryRef && step.slideLibraryRef.slideId
          ? ('/api/slide-library/slides/' + encodeURIComponent(step.slideLibraryRef.slideId) + '/html')
          : null;
        const frameSourceLabel = midFrameUrl
          ? (framesSource === 'build-frames' ? 'Build preview' : 'QA frame')
          : null;

        // Detect Plaid Link steps — these run the real SDK modal (cross-origin iframe)
        // so no host-page QA frame is available. Show a branded placeholder instead.
        const isPlaidLinkStep = step.plaidPhase === 'launch' || /link.?launch/i.test(sid);

        // ── Timing callouts ──
        const callouts = [];
        const SILENCE_THRESHOLD_MS = 3000;
        if (timing.silenceMs != null && timing.silenceMs > SILENCE_THRESHOLD_MS) {
          const secs = (timing.silenceMs / 1000).toFixed(1);
          callouts.push({
            type: 'silence',
            icon: '⏸',
            label: secs + 's silence',
            detail: `Narration ends ${secs}s before the screen advances — consider trimming step duration or extending the narration.`,
          });
        }
        if (timing.overflowMs != null && timing.overflowMs > 0) {
          const secs = (timing.overflowMs / 1000).toFixed(1);
          callouts.push({
            type: 'overflow',
            icon: '⚡',
            label: '+' + secs + 's overflow',
            detail: `Narration runs ${secs}s past the step's video window — voice will continue while the next screen is already showing.`,
          });
        }
        if (topicBleedSet.has(sid)) {
          callouts.push({
            type: 'topicbleed',
            icon: '↩',
            label: 'topic bleed',
            detail: 'This narration contains keywords that belong to the next screen\'s topic — the script may be describing a scene before it appears.',
          });
        }

        const calloutsHtml = callouts.map(c => `
          <span class="sb-callout sb-callout-${esc(c.type)}" title="${esc(c.detail)}">
            ${c.icon} ${esc(c.label)}
          </span>`).join('');

        // ── Narration-to-video alignment timeline ──────────────────────────────
        let timingBarHtml = '';
        const gapInfo = gapMap[sid];
        if (gapInfo) {
          const compDurMs = gapInfo.compEndMs - gapInfo.compStartMs;
          const narrPct   = compDurMs > 0 ? Math.min(100, (gapInfo.narrationMs / compDurMs) * 100).toFixed(1) : 0;
          const gapPct    = compDurMs > 0 ? Math.min(100 - parseFloat(narrPct), (gapInfo.gapMs / compDurMs) * 100).toFixed(1) : 0;
          const narrS     = (gapInfo.narrationMs / 1000).toFixed(1);
          const vidS      = (gapInfo.videoDurationMs / 1000).toFixed(1);
          const compS     = (compDurMs / 1000).toFixed(1);
          const gapS      = (gapInfo.gapMs / 1000).toFixed(1);
          // Speed: prefer sync-map entry (may be a manual override) over auto-gap calculated speed
          const gapCompStartMs = _resolveCompStartMs(gapInfo);
          const compStartKey = gapCompStartMs != null ? (gapCompStartMs / 1000).toFixed(2) : null;
          const syncSeg   = syncSegByCompStart[compStartKey];
          const dispSpeedRaw = syncSeg ? syncSeg.speed : gapInfo.speed;
          const dispSpeed = _toFiniteNumber(dispSpeedRaw);
          const speedLabel = dispSpeed != null ? dispSpeed.toFixed(2) + '×' : '1.00×';
          const isTooFast  = gapInfo.action === 'warn-too-fast';
          timingBarHtml = `
            <div class="sb-align-timeline" title="Narration ${narrS}s + ${gapS}s gap = ${compS}s comp | Video: ${vidS}s at ${speedLabel}">
              <div class="sb-align-narr" style="width:${narrPct}%"></div>
              <div class="sb-align-gap"  style="width:${gapPct}%"></div>
            </div>
            <div class="sb-align-meta">
              <span class="sb-align-stat">🎙 ${narrS}s</span>
              <span class="sb-align-stat sb-align-gap-stat">+${gapS}s gap</span>
              <span class="sb-align-stat sb-align-vid-stat">🎬 ${vidS}s</span>
              <span class="sb-align-stat sb-align-speed-stat ${isTooFast ? 'sb-align-speed-warn' : ''}">${speedLabel}</span>
            </div>`;
        } else if (timing.videoDurationMs && timing.audioDurationMs) {
          // Fallback: legacy audio/video bar
          const vidS = (timing.videoDurationMs / 1000).toFixed(1);
          const audS = (timing.audioDurationMs  / 1000).toFixed(1);
          const audioPct = Math.min(100, (timing.audioDurationMs / timing.videoDurationMs) * 100).toFixed(1);
          timingBarHtml = `
            <div class="sb-timing-bar" title="Audio: ${audS}s / Video: ${vidS}s">
              <div class="sb-timing-audio" style="width:${audioPct}%"></div>
              <div class="sb-timing-labels"><span>🔊 ${audS}s</span><span>🎬 ${vidS}s</span></div>
            </div>`;
        }

        // ── Per-step speed control ───────────────────────────────────────────
        let speedControlHtml = '';
        if (gapInfo) {
          const gapCompStartMs = _resolveCompStartMs(gapInfo);
          const compStartKey = gapCompStartMs != null ? (gapCompStartMs / 1000).toFixed(2) : null;
          const syncSeg      = syncSegByCompStart[compStartKey];
          const syncSegSpeed = syncSeg && syncSeg.mode === 'speed' ? _toFiniteNumber(syncSeg.speed) : null;
          const gapInfoSpeed = _toFiniteNumber(gapInfo.speed);
          const curSpeed     = syncSegSpeed != null ? syncSegSpeed : (gapInfoSpeed != null ? gapInfoSpeed : 1.0);
          const syncVideoStart = _toFiniteNumber(syncSeg && syncSeg.videoStart);
          const videoStart   = syncVideoStart != null ? syncVideoStart : (gapCompStartMs != null ? (gapCompStartMs / 1000) : 0);
          const vidDurS      = (_toFiniteNumber(gapInfo.videoDurationMs) || 0) / 1000;
          const previewS     = (curSpeed > 0 ? (vidDurS / curSpeed) : vidDurS).toFixed(1);
          speedControlHtml = `
            <div class="sb-speed-control">
              <span class="sb-speed-label">Speed</span>
              <input type="number" class="sb-speed-input config-input"
                value="${curSpeed.toFixed(3)}" min="0.1" max="5.0" step="0.05"
                data-step-id="${esc(sid)}"
                data-comp-start="${(gapCompStartMs != null ? (gapCompStartMs / 1000) : 0).toFixed(3)}"
                data-video-start="${videoStart}"
                data-video-dur="${vidDurS}">
              <span class="sb-speed-preview" id="sb-speed-preview-${esc(sid)}">→ ${previewS}s</span>
              <button class="btn btn-sm btn-secondary sb-speed-apply-btn" data-step-id="${esc(sid)}">Apply</button>
              <button class="btn btn-sm btn-secondary sb-rerender-btn" data-step-id="${esc(sid)}" title="Re-render video with updated speed">↻ Re-render</button>
            </div>`;
        }

        const hasCallouts = callouts.length > 0;

        return `
          <div class="step-card ${hasIssues ? 'has-issues' : ''} ${hasCallouts ? 'has-callouts' : ''}" data-step-id="${esc(sid)}" draggable="true">
            <div class="step-drag-handle" title="Drag to reorder">⠿</div>
            <div class="step-thumb ${isPlaidLinkStep && !midFrameUrl ? 'plaid-link-thumb' : ''}">
              ${midFrameUrl
                ? `<img src="${midFrameUrl}" alt="${esc(sid)}" onerror="this.style.display='none'">
                   <span class="frame-source-badge">${esc(frameSourceLabel)}</span>`
                : libraryThumbUrl
                  ? `<iframe class="thumb-library-frame" src="${libraryThumbUrl}" title="Library slide preview" loading="lazy"></iframe>
                     <span class="frame-source-badge">Library</span>`
                : isPlaidLinkStep
                  ? `<div class="thumb-placeholder thumb-plaid-link">
                       <div class="plaid-link-icon">
                         <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                           <rect width="28" height="28" rx="6" fill="rgba(0,166,126,0.15)"/>
                           <rect x="6" y="6" width="6" height="6" rx="1" fill="#00A67E"/>
                           <rect x="16" y="6" width="6" height="6" rx="1" fill="#00A67E" opacity="0.7"/>
                           <rect x="6" y="16" width="6" height="6" rx="1" fill="#00A67E" opacity="0.7"/>
                           <rect x="16" y="16" width="6" height="6" rx="1" fill="#00A67E" opacity="0.4"/>
                         </svg>
                       </div>
                       <span class="plaid-link-label">Plaid Link</span>
                       <span class="plaid-link-sublabel">Real SDK modal</span>
                     </div>`
                  : '<div class="thumb-placeholder">No frame</div>'}
            </div>
            <div class="step-info">
              <div class="step-header">
                <span class="step-id">${esc(sid)}</span>
                <span class="step-label">${esc(step.label || '')}</span>
                <span class="chip">${esc(durationS)}s</span>
                ${scoreChip}
              </div>
              ${calloutsHtml ? `<div class="sb-callouts">${calloutsHtml}</div>` : ''}
              ${timingBarHtml}
              ${speedControlHtml}
              <textarea class="narration-area" data-step-id="${esc(sid)}">${esc(step.narration || '')}</textarea>
              <div class="word-count ${wcClass}">${wc} / 35 words</div>
              <div class="step-actions">
                <button class="btn btn-sm btn-primary save-narration-btn" data-step-id="${esc(sid)}"
                  title="Save this narration to demo-script.json — the pipeline voiceover stage will use the updated text">Save</button>
                <button class="btn btn-sm btn-secondary revert-narration-btn" data-step-id="${esc(sid)}"
                  title="Discard edits and restore the last saved narration for this step">Revert</button>
                ${hasIssues
                  ? `<button class="btn btn-sm btn-secondary toggle-issues-btn" data-step-id="${esc(sid)}">▼ ${issues.length} issue${issues.length !== 1 ? 's' : ''}</button>`
                  : ''}
                ${isSlideStepClient(step)
                  ? `<button class="btn btn-sm btn-danger sb-remove-slide-btn" data-step-id="${esc(sid)}"
                       title="Remove this slide from the storyboard. Updates demo-script.json + index.html + playwright-script.json. Only slide-kind steps are removable through this button.">✕ Remove slide</button>`
                  : ''}
              </div>
              <ul class="qa-issue-list" data-step-id="${esc(sid)}">
                ${issues.map(i => `<li>${esc(i)}</li>`).join('')}
              </ul>
              <div class="step-interaction">
                Interaction: ${esc(step.interaction ? step.interaction.type : '–')} → ${esc(step.interaction ? step.interaction.target : '–')}
              </div>

              <div class="sb-rewrite-wrap" id="sb-rewrite-wrap-${esc(sid)}">
                <div class="sb-rewrite-trigger">
                  <button type="button" class="btn btn-sm btn-secondary ai-rewrite-btn" data-step-id="${esc(sid)}">✦ AI Rewrite Narration</button>
                </div>
                <div class="sb-rewrite-panel" id="sb-rewrite-panel-${esc(sid)}" style="display:none">
                  <input type="text" class="config-input sb-rewrite-direction" data-step-id="${esc(sid)}"
                    placeholder="Direction, e.g. 'shorten by 10 words', 'lead with fraud protection angle'">
                  <div class="sb-rewrite-actions">
                    <button type="button" class="btn btn-sm btn-primary sb-rewrite-submit-btn" data-step-id="${esc(sid)}">Rewrite</button>
                    <button type="button" class="btn btn-sm btn-secondary sb-rewrite-cancel-btn" data-step-id="${esc(sid)}">Cancel</button>
                  </div>
                  <div class="sb-rewrite-result" id="sb-rewrite-result-${esc(sid)}" style="display:none">
                    <div class="sb-rewrite-proposed-label">Proposed:</div>
                    <div class="sb-rewrite-proposed-text" id="sb-rewrite-proposed-${esc(sid)}"></div>
                    <div class="sb-rewrite-accept-actions">
                      <button type="button" class="btn btn-sm btn-primary sb-rewrite-accept-btn" data-step-id="${esc(sid)}">Accept</button>
                      <button type="button" class="btn btn-sm btn-secondary sb-rewrite-reject-btn" data-step-id="${esc(sid)}">Keep Original</button>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </div>`;
      });
      const cardsHtml = cardBlocks.map((cardHtml, idx) => {
        const currentStep = script.steps[idx];
        const nextStep = script.steps[idx + 1];
        if (!currentStep) return cardHtml;
        const insertAfterId = esc(currentStep.id || '');
        const betweenLabel = nextStep
          ? `Insert between ${esc(currentStep.id)} and ${esc(nextStep.id)}`
          : `Insert after ${esc(currentStep.id)}`;
        const gapHtml = `
          <div class="sb-insert-gap" data-insert-after-id="${insertAfterId}">
            <button type="button" class="sb-insert-library-btn" data-insert-after-id="${insertAfterId}" title="${betweenLabel}">
              <span aria-hidden="true">+</span>
            </button>
          </div>`;
        return cardHtml + gapHtml;
      }).join('');

      // ── Review Feedback card removed ──
      // The dashboard's old "Review Feedback" UI (global HTML notes textarea
      // + Load Saved / Export / Run Refinement buttons) wrote to
      // inputs/build-feedback.md and re-ran the pipeline from build.
      // All feedback is now handled via Agent Mode in Claude Code, so the
      // section was dropped from the storyboard render. Per-step "Visual
      // notes" textareas were also removed for the same reason. The
      // /api/feedback + /api/feedback/export server endpoints remain so any
      // external bookmark / scripted call doesn't 404, but no UI surface
      // calls them anymore.

      // Capture screenshots banner — shown when script exists but no frames yet
      const noFrames = framesList.length === 0;
      const hasScratchApp = !!(await api('/api/runs/' + currentRunId).then(r => r.artifacts && r.artifacts.script).catch(() => false));
      const captureBannerHtml = noFrames ? `
        <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:16px">
          <div>
            <strong>No screenshots available</strong>
            <p class="config-desc" style="margin:2px 0 0">Capture a screenshot of each step from the built app to preview the storyboard before recording.</p>
          </div>
          <button type="button" id="capture-screenshots-btn" class="btn btn-primary btn-sm" style="flex-shrink:0">
            📷 Capture Build Screenshots
          </button>
        </div>` : (framesSource === 'build-frames' ? `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0">
          <span style="font-size:11px;color:rgba(255,255,255,0.4)">Showing build preview screenshots — QA frames will replace these after the QA stage runs.</span>
          <button type="button" id="capture-screenshots-btn" class="btn btn-secondary btn-sm">↺ Refresh Screenshots</button>
        </div>` : '');

      // ── Storyboard action bar ──
      // Show launch button always (script is loaded if we got this far); server will 404 if app not built
      const launchAppBtn = `<a id="sb-launch-app-btn" class="btn btn-sm btn-secondary" href="/demo-app-preview/${esc(currentRunId)}" target="_blank" data-tooltip="Launch App" data-tooltip-title="↗ Launch &amp; Edit App" data-tooltip-desc="Opens scratch-app in a new tab with the AI edit panel." style="text-decoration:none">↗ Launch &amp; Edit App</a>`;
      const actionBarHtml = `
        <div class="sb-action-bar" id="sb-action-bar">
          <div class="sb-action-bar-left">
            <span class="sb-rec-status" id="sb-recording-status"></span>
            <button id="sb-add-step-btn" class="btn btn-sm btn-secondary"
              title="Generate a new step with AI — demo scene or insight slide">
              ✦ Add Step
            </button>
            ${launchAppBtn}
          </div>
          <div class="sb-action-bar-right">
            <button id="sb-continue-btn" class="btn btn-sm sb-continue-btn" style="display:none"
              title="Pipeline is waiting — click to send ENTER and proceed to recording">▶ Continue</button>
            <a id="sb-timeline-btn" class="btn btn-sm btn-secondary" href="/timeline?run=${encodeURIComponent(currentRunId)}" target="_blank"
              title="Open the visual drag-and-resize timeline editor for this run" style="text-decoration:none">
              ◫ Timeline Editor
            </a>
            <button id="sb-record-btn" class="btn btn-sm btn-secondary"
              title="Start Playwright recording using the current built app (skips rebuild)">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="6" cy="6" r="4"/></svg>
              Record
            </button>
            <button id="sb-rebuild-record-btn" class="btn btn-sm btn-primary"
              title="Apply your feedback notes, rebuild the app, then record">
              ⟳ Rebuild + Record
            </button>
          </div>
        </div>`;

      // ── Scene Timing (auto-gap) section ──
      let sceneTiming = null;
      if (autoGapReport && autoGapReport.steps && autoGapReport.steps.length > 0) {
        const ACTION_ICONS = { clip: '&#9986;', freeze: '&#9208;', ok: '&#10003;', 'warn-too-fast': '&#9888;' };
        const rowsHtml = autoGapReport.steps.map(s => {
          const actionIcon = ACTION_ICONS[s.action] || '';
          const narS  = s.narrationMs != null    ? (s.narrationMs    / 1000).toFixed(1) : '–';
          const vidS  = s.videoDurationMs != null ? (s.videoDurationMs / 1000).toFixed(1) : '–';
          const gapS  = s.gapMs != null           ? (s.gapMs           / 1000).toFixed(1) : '0.0';
          return `<tr data-gap-step="${esc(s.stepId)}">
            <td class="gap-cell-step">${esc(s.stepId)}</td>
            <td class="gap-cell-num">${esc(narS)}s</td>
            <td class="gap-cell-num">${esc(vidS)}s</td>
            <td class="gap-cell-input">
              <input type="number" class="config-input gap-override-input" min="0" max="30" step="0.1"
                data-step-id="${esc(s.stepId)}" value="${esc(gapS)}"
                style="width:70px;padding:3px 6px;font-size:12px${s.isOverridden ? ';background:rgba(251,191,36,0.18);border-color:rgba(251,191,36,0.6)' : ''}">
            </td>
            <td class="gap-cell-action" title="${esc(s.action || '')}">${actionIcon} ${esc(s.action || '–')}</td>
          </tr>`;
        }).join('');
        sceneTiming = `
          <div class="card" id="scene-timing-card">
            <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" id="scene-timing-toggle">
              <div class="card-title" style="margin:0">Scene Timing</div>
              <span id="scene-timing-chevron" style="font-size:11px;color:rgba(255,255,255,0.45)">&#9660; collapse</span>
            </div>
            <div id="scene-timing-body">
              <p class="config-desc" style="margin:8px 0 10px">Gap = time between narration end and next scene. Override to fine-tune freezes or clips. Apply restarts from <code>auto-gap</code>.</p>
              <div style="overflow-x:auto">
                <table class="gap-table">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Narration</th>
                      <th>Video</th>
                      <th>Gap (s)</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>${rowsHtml}</tbody>
                </table>
              </div>
              <div style="margin-top:10px;display:flex;align-items:center;gap:12px">
                <button type="button" class="btn btn-primary btn-sm" id="apply-gap-btn">Apply Timing</button>
                <span id="gap-apply-status" style="font-size:11px;color:rgba(255,255,255,0.4)"></span>
              </div>
            </div>
          </div>`;
      }

      const reorderBannerHtml = `
        <div id="sb-reorder-banner" style="display:none;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;margin-bottom:10px;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.4);border-radius:8px">
          <span style="font-size:13px;color:#fbbf24">⇅ Scene order changed — save and rebuild to apply.</span>
          <div style="display:flex;gap:8px">
            <button type="button" class="btn btn-sm btn-secondary" id="sb-reorder-discard-btn">Discard</button>
            <button type="button" class="btn btn-sm btn-primary" id="sb-reorder-save-btn">Save Order &amp; Rebuild</button>
          </div>
        </div>`;

      // ── Video timeline editor ────────────────────────────────────────────────
      const totalCompS = script.steps.reduce((sum, s) => sum + (s.durationMs || 0), 0) / 1000;
      const timelineHtml = totalCompS > 0 ? (() => {
        const stepBars = script.steps.map((s, i) => {
          const pct = ((s.durationMs || 0) / (totalCompS * 1000) * 100).toFixed(2);
          const colors = ['#00A67E','#00875F','#006B4C','#00A67E','#34d399'];
          const bg = colors[i % colors.length];
          return `<div class="tl-step" style="width:${pct}%;background:${bg};opacity:0.85"
            title="${esc(s.id)} — ${((s.durationMs||0)/1000).toFixed(1)}s">
            <span class="tl-step-label">${esc(s.id)}</span>
          </div>`;
        }).join('');

        const segmentMarkers = syncMapSegs.map(seg => {
          const leftPct = (seg.compStart / totalCompS * 100).toFixed(2);
          const widthPct = ((seg.compEnd - seg.compStart) / totalCompS * 100).toFixed(2);
          const isFreeze = seg.mode === 'freeze';
          const isSpeed  = seg.mode === 'speed';
          const bg = isFreeze ? 'rgba(251,191,36,0.35)' : isSpeed ? 'rgba(0,166,126,0.3)' : 'transparent';
          const border = isFreeze ? '2px solid rgba(251,191,36,0.7)' : isSpeed ? '2px solid rgba(0,166,126,0.7)' : 'none';
          const label = isFreeze ? '⏸' : isSpeed ? `${seg.speed}×` : '';
          return `<div class="tl-segment" style="left:${leftPct}%;width:${widthPct}%;background:${bg};border:${border}" title="${esc(seg._reason || seg.mode)}">
            <span class="tl-seg-label">${label}</span>
          </div>`;
        }).join('');

        return `
          <div class="card" id="tl-editor-card">
            <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
              <div class="card-title" style="margin:0">Video Timeline</div>
              <span style="font-size:11px;color:rgba(255,255,255,0.35)">${totalCompS.toFixed(1)}s total · ${syncMapSegs.length} segment${syncMapSegs.length !== 1 ? 's' : ''}</span>
            </div>
            <div style="margin-bottom:6px;font-size:11px;color:rgba(255,255,255,0.35)">Steps (proportional) — yellow = freeze · teal = speed adjustment</div>
            <div class="tl-track" id="tl-track">
              <div class="tl-steps-row">${stepBars}</div>
              <div class="tl-segments-row">${segmentMarkers}</div>
              <div class="tl-playhead" id="tl-playhead" style="left:0%"></div>
            </div>
            <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
              <button type="button" class="btn btn-sm btn-secondary" id="tl-add-split-btn" title="Click a position on the timeline above, then click here to add a freeze segment at that point">+ Add Freeze Segment</button>
              <a class="btn btn-sm btn-secondary" href="/timeline?run=${encodeURIComponent(currentRunId)}" target="_blank" style="text-decoration:none" title="Open the full drag-and-resize timeline editor">◫ Timeline Editor</a>
              <button type="button" class="btn btn-sm btn-secondary" id="tl-open-studio-btn">▶ Open in Remotion Studio</button>
              <span id="tl-cursor-time" style="font-size:11px;color:rgba(255,255,255,0.4);margin-left:4px"></span>
            </div>
            <div id="tl-split-form" style="display:none;margin-top:10px;padding:10px;background:rgba(255,255,255,0.04);border-radius:6px">
              <div style="font-size:12px;margin-bottom:8px;color:rgba(255,255,255,0.6)">New freeze segment:</div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <label style="font-size:12px">From <input type="number" id="tl-split-from" class="config-input" style="width:70px" step="0.1" min="0"> s</label>
                <label style="font-size:12px">To <input type="number" id="tl-split-to" class="config-input" style="width:70px" step="0.1" min="0"> s</label>
                <button type="button" class="btn btn-sm btn-primary" id="tl-split-save-btn">Save to sync-map.json</button>
                <button type="button" class="btn btn-sm btn-secondary" id="tl-split-cancel-btn">Cancel</button>
              </div>
            </div>
          </div>`;
      })() : '';

      el.innerHTML = actionBarHtml + captureBannerHtml + liveWorkspaceHtml + reorderBannerHtml + timelineHtml + (sceneTiming || '') + `<div class="storyboard-grid" id="storyboard-grid">${cardsHtml}</div>` + '<div id="ai-suggestions-panel" class="suggestion-panel"></div>';

      // Load AI overlay suggestions (async, non-blocking)
      loadOverlaySuggestions();

      // ── Live storyboard workspace wiring ─────────────────────────────────────
      const liveStepSelect = document.getElementById('sb-live-step-select');
      const liveNarration = document.getElementById('sb-live-narration');
      const liveSaveBtn = document.getElementById('sb-live-save-btn');
      const liveRevertBtn = document.getElementById('sb-live-revert-btn');
      const liveIframe = document.getElementById('sb-live-iframe');

      if (liveIframe) {
        liveIframe.addEventListener('load', () => {
          if (storyboardSelectedStepId) {
            postStoryboardPreviewMessage({ type: 'STORYBOARD_SET_STEP', stepId: storyboardSelectedStepId });
          }
        });
      }
      if (liveStepSelect) {
        liveStepSelect.addEventListener('change', () => {
          setStoryboardSelectedStep(liveStepSelect.value, el);
        });
      }
      if (liveNarration) {
        liveNarration.addEventListener('input', () => {
          if (storyboardPreviewSyncing) return;
          const sid = storyboardSelectedStepId;
          if (!sid) return;
          const ta = el.querySelector(`.narration-area[data-step-id="${sid}"]`);
          if (ta && ta.value !== liveNarration.value) {
            ta.value = liveNarration.value;
            ta.dispatchEvent(new Event('input'));
          }
          postStoryboardPreviewMessage({ type: 'STORYBOARD_SYNC_NARRATION', stepId: sid, narration: liveNarration.value });
        });
      }
      if (liveSaveBtn) {
        liveSaveBtn.addEventListener('click', async () => {
          const sid = storyboardSelectedStepId;
          if (!sid) return;
          await saveNarration(sid, el);
          showToast('Narration saved (live workspace)', 'success');
        });
      }
      if (liveRevertBtn) {
        liveRevertBtn.addEventListener('click', () => {
          const sid = storyboardSelectedStepId;
          if (!sid) return;
          const value = originalNarrations[sid] || '';
          const ta = el.querySelector(`.narration-area[data-step-id="${sid}"]`);
          if (ta) {
            ta.value = value;
            ta.dispatchEvent(new Event('input'));
          }
          if (liveNarration) liveNarration.value = value;
          postStoryboardPreviewMessage({ type: 'STORYBOARD_SYNC_NARRATION', stepId: sid, narration: value });
        });
      }

      // Capture screenshots button
      const captureBtn = document.getElementById('capture-screenshots-btn');
      if (captureBtn) {
        captureBtn.addEventListener('click', async () => {
          captureBtn.disabled = true;
          captureBtn.textContent = 'Capturing…';
          try {
            const result = await apiPost('/api/runs/' + currentRunId + '/capture-build-screenshots', {});
            showToast(`Captured ${result.captured} screenshots`, 'success');
            loadStoryboard(); // reload to show new frames
          } catch (e) {
            showToast('Capture failed: ' + e.message, 'error');
            captureBtn.disabled = false;
            captureBtn.textContent = '📷 Capture Build Screenshots';
          }
        });
      }

      // ── Drag-and-drop step reordering ──────────────────────────────────────────
      (function initDragReorder() {
        const grid = document.getElementById('storyboard-grid');
        const banner = document.getElementById('sb-reorder-banner');
        if (!grid || !banner) return;

        let dragSrc = null;

        grid.addEventListener('dragstart', e => {
          const card = e.target.closest('.step-card');
          if (!card) return;
          dragSrc = card;
          card.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', card.dataset.stepId);
        });

        grid.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const card = e.target.closest('.step-card');
          if (card && card !== dragSrc) {
            grid.querySelectorAll('.step-card').forEach(c => c.classList.remove('drag-over'));
            card.classList.add('drag-over');
          }
        });

        grid.addEventListener('dragleave', e => {
          const card = e.target.closest('.step-card');
          if (card) card.classList.remove('drag-over');
        });

        grid.addEventListener('drop', e => {
          e.preventDefault();
          const target = e.target.closest('.step-card');
          if (!target || target === dragSrc || !dragSrc) return;
          target.classList.remove('drag-over');

          // Reorder in DOM
          const cards = [...grid.querySelectorAll('.step-card')];
          const srcIdx = cards.indexOf(dragSrc);
          const tgtIdx = cards.indexOf(target);
          if (srcIdx < tgtIdx) {
            target.after(dragSrc);
          } else {
            target.before(dragSrc);
          }
          banner.style.display = 'flex';
        });

        grid.addEventListener('dragend', e => {
          grid.querySelectorAll('.step-card').forEach(c => {
            c.classList.remove('dragging');
            c.classList.remove('drag-over');
          });
          dragSrc = null;
        });

        // Discard: reload storyboard to restore original order
        document.getElementById('sb-reorder-discard-btn')?.addEventListener('click', () => {
          banner.style.display = 'none';
          loadStoryboard();
        });

        // Save & Rebuild: persist new order to demo-script.json then trigger rebuild
        document.getElementById('sb-reorder-save-btn')?.addEventListener('click', async () => {
          const saveBtn = document.getElementById('sb-reorder-save-btn');
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving…';
          try {
            const stepIds = [...grid.querySelectorAll('.step-card')].map(c => c.dataset.stepId);
            await apiPost('/api/runs/' + currentRunId + '/reorder-steps', { stepIds });
            showToast('Step order saved to demo-script.json', 'success');
            banner.style.display = 'none';
            // Trigger rebuild+record with updated script
            const rebuildBtn = document.getElementById('sb-rebuild-record-btn');
            if (rebuildBtn) rebuildBtn.click();
          } catch (err) {
            showToast('Reorder failed: ' + err.message, 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Order & Rebuild';
          }
        });
      })();

      // Click step thumb/header to sync live preview + narration editor
      el.addEventListener('click', (evt) => {
        const target = evt.target;
        if (!(target instanceof Element)) return;
        const hit = target.closest('.step-thumb, .step-header, .step-id, .step-label');
        if (!hit) return;
        const card = target.closest('.step-card');
        if (!card || !card.dataset.stepId) return;
        setStoryboardSelectedStep(card.dataset.stepId, el);
      });

      // Select first/previous step in live workspace
      if (storyboardSelectedStepId) {
        setStoryboardSelectedStep(storyboardSelectedStepId, el);
      }

      // ── Timeline editor interactivity ──────────────────────────────────────────
      (function initTimeline() {
        const track = document.getElementById('tl-track');
        const cursorLabel = document.getElementById('tl-cursor-time');
        const splitForm = document.getElementById('tl-split-form');
        if (!track) return;

        // Show cursor time on hover
        track.addEventListener('mousemove', e => {
          const rect = track.getBoundingClientRect();
          const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const secs = (pct * totalCompS).toFixed(2);
          if (cursorLabel) cursorLabel.textContent = secs + 's';
          const ph = document.getElementById('tl-playhead');
          if (ph) ph.style.left = (pct * 100).toFixed(2) + '%';
        });
        track.addEventListener('mouseleave', () => {
          if (cursorLabel) cursorLabel.textContent = '';
        });

        // Click timeline to pre-fill split form
        track.addEventListener('click', e => {
          const rect = track.getBoundingClientRect();
          const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const secs = parseFloat((pct * totalCompS).toFixed(2));
          const fromInput = document.getElementById('tl-split-from');
          const toInput   = document.getElementById('tl-split-to');
          if (fromInput) fromInput.value = secs;
          if (toInput)   toInput.value   = Math.min(totalCompS, parseFloat((secs + 2).toFixed(2)));
          if (splitForm) splitForm.style.display = '';
        });

        document.getElementById('tl-add-split-btn')?.addEventListener('click', () => {
          if (splitForm) splitForm.style.display = splitForm.style.display === 'none' ? '' : 'none';
        });
        document.getElementById('tl-split-cancel-btn')?.addEventListener('click', () => {
          if (splitForm) splitForm.style.display = 'none';
        });

        document.getElementById('tl-split-save-btn')?.addEventListener('click', async () => {
          const fromS = parseFloat(document.getElementById('tl-split-from')?.value || '0');
          const toS   = parseFloat(document.getElementById('tl-split-to')?.value || '0');
          if (isNaN(fromS) || isNaN(toS) || toS <= fromS) {
            showToast('Invalid range: "To" must be greater than "From"', 'error'); return;
          }
          try {
            await apiPost('/api/runs/' + currentRunId + '/sync-map-segment', {
              compStart: fromS, compEnd: toS, mode: 'freeze',
              videoStart: fromS,
              _reason: `Manual freeze added via timeline editor`,
            });
            showToast(`Freeze segment added ${fromS}s → ${toS}s — re-run from resync-audio to apply`, 'success');
            if (splitForm) splitForm.style.display = 'none';
            loadStoryboard();
          } catch (err) {
            showToast('Failed to save segment: ' + err.message, 'error');
          }
        });

        // Open in Studio
        document.getElementById('tl-open-studio-btn')?.addEventListener('click', async () => {
          try {
            await apiPost('/api/runs/' + currentRunId + '/open-studio', {});
            showToast('Remotion Studio opening…', 'success');
          } catch (err) { showToast(err.message, 'error'); }
        });
      })();

      // Scene Timing — collapsible toggle
      document.getElementById('scene-timing-toggle')?.addEventListener('click', () => {
        const body = document.getElementById('scene-timing-body');
        const chevron = document.getElementById('scene-timing-chevron');
        if (!body) return;
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? '' : 'none';
        if (chevron) chevron.innerHTML = hidden ? '&#9660; collapse' : '&#9658; expand';
      });

      // Scene Timing — Apply Timing button
      document.getElementById('apply-gap-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('apply-gap-btn');
        const statusEl = document.getElementById('gap-apply-status');
        setBtnLoading(btn, true, 'Saving…');
        if (statusEl) statusEl.textContent = '';

        const overrides = {};
        el.querySelectorAll('.gap-override-input[data-step-id]').forEach(input => {
          const sid = input.dataset.stepId;
          const val = parseFloat(input.value);
          if (sid && !isNaN(val) && val >= 0) {
            overrides[sid] = { gapMs: Math.round(val * 1000) };
          }
        });

        try {
          await apiPost('/api/runs/' + currentRunId + '/auto-gap-overrides', { overrides });
          if (statusEl) statusEl.textContent = '✓ Saved — restarting auto-gap…';
          await runPipeline( { fromStage: 'auto-gap', resumeRunId: currentRunId });
          showToast('Gap overrides saved — pipeline restarting from auto-gap', 'success');
          setPipelineRunning(true);
          switchTab('pipeline');
        } catch (e) {
          showToast('Failed: ' + e.message, 'error');
          if (statusEl) statusEl.textContent = 'Error: ' + e.message;
          setBtnLoading(btn, false);
        }
      });

      // Storyboard action bar: Record
      document.getElementById('sb-record-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('sb-record-btn');
        setBtnLoading(btn, true, 'Starting…');
        try {
          await runPipeline( { fromStage: 'record', resumeRunId: currentRunId });
          showToast('Recording started', 'success');
          setPipelineRunning(true);
          switchTab('pipeline');
        } catch (e) {
          showToast('Failed to start recording: ' + e.message, 'error');
          setBtnLoading(btn, false);
        }
      });

      // Storyboard action bar: Rebuild + Record
      document.getElementById('sb-rebuild-record-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('sb-rebuild-record-btn');
        setBtnLoading(btn, true, 'Exporting feedback…');
        const exported = await exportFeedback(true);
        setBtnLoading(btn, true, 'Starting build…');
        try {
          await runPipeline( { fromStage: 'build', resumeRunId: currentRunId });
          showToast('Rebuild + record pipeline started', 'success');
          setPipelineRunning(true);
          switchTab('pipeline');
        } catch (e) {
          showToast('Failed to start: ' + e.message, 'error');
          setBtnLoading(btn, false);
        }
      });

      // Storyboard action bar: Continue (sends ENTER to blocked pipeline)
      document.getElementById('sb-continue-btn')?.addEventListener('click', async () => {
        try {
          await apiPost('/api/pipeline/stdin', { input: '\n' });
          showContinueButton(false);
          showToast('Continue signal sent to pipeline', 'success');
        } catch (e) {
          showToast('Failed: ' + e.message, 'error');
        }
      });

      // Reflect current pipeline/recording state into the action bar
      api('/api/pipeline/status').then(s => {
        if (s.running) {
          setPipelineRunning(true);
          startRecordingStatusPolling();
        }
      }).catch(() => {});

      // Auto-resize helper — collapses height to fit content
      function autoResizeTextarea(ta) {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      }

      // Wire up live word-count + auto-resize
      el.querySelectorAll('.narration-area').forEach(ta => {
        // Initial resize to fit pre-filled content
        autoResizeTextarea(ta);
        ta.addEventListener('input', () => {
          autoResizeTextarea(ta);
          const wc = wordCount(ta.value);
          const wcEl = ta.parentElement.querySelector('.word-count');
          if (wcEl) {
            wcEl.textContent = wc + ' / 35 words';
            wcEl.className = 'word-count ' + (wc > 35 ? 'over' : wc > 30 ? 'warn' : '');
          }
          const sid = ta.dataset.stepId;
          if (sid && sid === storyboardSelectedStepId) {
            const liveTa = document.getElementById('sb-live-narration');
            if (liveTa && liveTa.value !== ta.value) liveTa.value = ta.value;
            if (!storyboardPreviewSyncing) {
              postStoryboardPreviewMessage({ type: 'STORYBOARD_SYNC_NARRATION', stepId: sid, narration: ta.value });
            }
          }
        });
      });

      // Save narration
      el.querySelectorAll('.save-narration-btn').forEach(btn => {
        btn.addEventListener('click', () => saveNarration(btn.dataset.stepId, el));
      });

      // Revert narration
      el.querySelectorAll('.revert-narration-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.dataset.stepId;
          const ta = el.querySelector(`.narration-area[data-step-id="${sid}"]`);
          if (ta) {
            ta.value = originalNarrations[sid] || '';
            ta.dispatchEvent(new Event('input'));
          }
        });
      });

      // Speed control — live preview
      el.querySelectorAll('.sb-speed-input').forEach(input => {
        input.addEventListener('input', () => {
          const speed = parseFloat(input.value);
          const vidDur = parseFloat(input.dataset.videoDur) || 0;
          const preview = document.getElementById('sb-speed-preview-' + input.dataset.stepId);
          if (preview) {
            if (speed > 0 && vidDur > 0) {
              preview.textContent = '→ ' + (vidDur / speed).toFixed(1) + 's';
              preview.classList.toggle('sb-speed-preview-warn', speed > 2.5);
            } else {
              preview.textContent = '→ –';
            }
          }
        });
      });

      // Speed control — apply to sync-map
      el.querySelectorAll('.sb-speed-apply-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const sid = btn.dataset.stepId;
          const input = el.querySelector(`.sb-speed-input[data-step-id="${sid}"]`);
          if (!input) return;
          const speed     = parseFloat(input.value);
          const compStart = parseFloat(input.dataset.compStart);
          const videoStart = parseFloat(input.dataset.videoStart);
          const vidDur    = parseFloat(input.dataset.videoDur);
          if (!speed || speed <= 0 || isNaN(compStart) || isNaN(vidDur)) {
            return showToast('Invalid speed value', 'error');
          }
          const newCompEnd = parseFloat((compStart + vidDur / speed).toFixed(3));
          setBtnLoading(btn, true, 'Saving…');
          try {
            await apiPost('/api/runs/' + currentRunId + '/sync-map-segment', {
              compStart,
              compEnd: newCompEnd,
              videoStart,
              mode: 'speed',
              speed,
              _reason: `manual: ${speed.toFixed(3)}× speed override set from dashboard`,
            });
            // Update the speed badge in the alignment timeline
            const card = btn.closest('.step-card');
            if (card) {
              card.querySelectorAll('.sb-align-speed-stat').forEach(el => {
                el.textContent = speed.toFixed(2) + '×';
                el.classList.toggle('sb-align-speed-warn', speed > 2.5);
              });
            }
            // Rebuild remotion-props.json so Remotion Studio hot-reloads instantly
            try {
              await apiPost('/api/runs/' + currentRunId + '/rebuild-props', {});
              showToast(
                `${sid}: speed → ${speed.toFixed(2)}×. Props rebuilt — Studio updated. Click ↻ Re-render when ready.`,
                'success',
                { duration: 5000 }
              );
            } catch (_e) {
              showToast(`${sid}: speed → ${speed.toFixed(2)}×. Sync-map saved (props rebuild failed).`, 'success');
            }
            await loadStoryboard();
          } catch (e) {
            showToast('Failed to save: ' + e.message, 'error');
          } finally {
            setBtnLoading(btn, false);
          }
        });
      });

      // Re-render button — triggers render stage from current sync-map
      el.querySelectorAll('.sb-rerender-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          showToast('Re-render started — this takes 2–3 min. Check the Pipeline log for progress.', 'success', { duration: 5000 });
          await runPipeline({ fromStage: 'render', resumeRunId: currentRunId });
        });
      });

      // Toggle issues
      el.querySelectorAll('.toggle-issues-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.dataset.stepId;
          const list = el.querySelector(`.qa-issue-list[data-step-id="${sid}"]`);
          if (list) list.classList.toggle('open');
        });
      });

      // Remove slide. Confirms first; on success, removes the card from the
      // DOM (the running demo-app preview tab also auto-reloads via the
      // /__hot-reload SSE channel — server's notifyReload fires there).
      el.querySelectorAll('.sb-remove-slide-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const sid = btn.dataset.stepId;
          if (!sid) return;
          const card = el.querySelector(`.step-card[data-step-id="${sid}"]`);
          const labelEl = card && card.querySelector('.step-label');
          const labelText = labelEl ? labelEl.textContent.trim() : sid;
          const confirmed = window.confirm(
            `Remove slide "${labelText}" (id: ${sid})?\n\n` +
            `This will delete the step from demo-script.json, strip its HTML ` +
            `from the running app, and drop matching Playwright rows. The action ` +
            `is reversible only by re-running the pipeline or re-inserting from ` +
            `the slide library.`
          );
          if (!confirmed) return;
          // Visual feedback while the request is in flight:
          btn.disabled = true;
          const origLabel = btn.textContent;
          btn.textContent = '… removing';
          try {
            const result = await apiPost('/api/runs/' + currentRunId + '/remove-step', { stepId: sid });
            if (!result || !result.ok) {
              throw new Error((result && result.error) || 'Removal failed');
            }
            if (card) {
              // Also drop the inserter-gap that follows this card so we don't leave a dangling +.
              const next = card.nextElementSibling;
              if (next && next.classList && next.classList.contains('sb-insert-gap')) {
                next.parentNode.removeChild(next);
              }
              card.parentNode.removeChild(card);
            }
            const tabsMsg = result.notifiedTabs > 0
              ? ` (reloaded ${result.notifiedTabs} open browser tab${result.notifiedTabs === 1 ? '' : 's'})`
              : '';
            showToast(`Removed slide "${sid}"${tabsMsg}`, 'success');
          } catch (err) {
            btn.disabled = false;
            btn.textContent = origLabel;
            showToast(`Could not remove slide "${sid}": ${err.message}`, 'error');
          }
        });
      });

      // The Review Feedback card was removed — feedback now flows through
      // Agent Mode in Claude Code, not a textarea-and-export-file dance.
      // The legacy `visual-notes-area`, `sb-global-notes`, `sb-export-btn`,
      // `sb-load-feedback-btn`, and `sb-run-refinement-btn` event listeners
      // are gone. The exportFeedback() / loadSavedFeedback() functions and
      // /api/feedback server endpoints remain as harmless dead code.

      // AI Rewrite — show/hide panel
      el.querySelectorAll('.ai-rewrite-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.dataset.stepId;
          const panel = document.getElementById('sb-rewrite-panel-' + sid);
          if (panel) {
            const isOpen = panel.style.display !== 'none';
            panel.style.display = isOpen ? 'none' : 'block';
            if (!isOpen) panel.querySelector('.sb-rewrite-direction')?.focus();
          }
        });
      });

      el.querySelectorAll('.sb-rewrite-cancel-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const panel = document.getElementById('sb-rewrite-panel-' + btn.dataset.stepId);
          if (panel) panel.style.display = 'none';
        });
      });

      el.querySelectorAll('.sb-rewrite-submit-btn').forEach(btn => {
        btn.addEventListener('click', () => submitNarrationRewrite(btn.dataset.stepId, el));
      });

      el.querySelectorAll('.sb-rewrite-direction').forEach(input => {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submitNarrationRewrite(input.dataset.stepId, el);
        });
      });

      el.querySelectorAll('.sb-rewrite-accept-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.dataset.stepId;
          const proposed = document.getElementById('sb-rewrite-proposed-' + sid)?.textContent || '';
          const ta = el.querySelector(`.narration-area[data-step-id="${sid}"]`);
          if (ta && proposed) {
            ta.value = proposed;
            ta.dispatchEvent(new Event('input')); // update word count
          }
          const panel = document.getElementById('sb-rewrite-panel-' + sid);
          if (panel) panel.style.display = 'none';
          showToast('Narration updated — click Save to persist', 'success');
        });
      });

      el.querySelectorAll('.sb-rewrite-reject-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.dataset.stepId;
          const result = document.getElementById('sb-rewrite-result-' + sid);
          if (result) result.style.display = 'none';
        });
      });

      // ── Add Step modal ────────────────────────────────────────────────────────
      // Remove any existing modal, then build a fresh one with current step list
      document.getElementById('add-step-modal')?.remove();
      const stepOptions = script.steps.map(s =>
        `<option value="${esc(s.id)}">${esc(s.id)} — ${esc((s.label || '').slice(0, 40))}</option>`
      ).join('') + '<option value="">End of sequence</option>';

      const addStepModal = document.createElement('div');
      addStepModal.id = 'add-step-modal';
      addStepModal.className = 'add-step-modal';
      addStepModal.style.display = 'none';
      addStepModal.innerHTML = `
        <div class="add-step-backdrop"></div>
        <div class="add-step-panel">
          <div class="add-step-header">
            <span class="add-step-title">✦ Add New Step</span>
            <button id="add-step-close-btn" class="btn btn-sm" style="background:transparent;border:none;color:rgba(255,255,255,0.5);font-size:16px;cursor:pointer;padding:0 4px">✕</button>
          </div>

          <div class="add-step-form" id="add-step-form">
            <div class="add-step-field">
              <label class="config-label">Insert after</label>
              <select id="add-step-after" class="config-input" style="width:100%">${stepOptions}</select>
            </div>
            <div class="add-step-field">
              <label class="config-label">Scene type</label>
              <div class="scene-type-toggle">
                <button type="button" class="scene-type-btn active" data-type="demo">Demo Scene</button>
                <button type="button" class="scene-type-btn" data-type="slide">Slide</button>
              </div>
              <p class="add-step-scene-desc" id="add-step-desc-demo">App screen — product UI navigates to this step. Persona takes an action or sees a result.</p>
              <p class="add-step-scene-desc" id="add-step-desc-slide" style="display:none">Insight overlay — styled to match this demo's brand design system. Matches existing insight screens (header bar, data table, glassmorphism panels).</p>

              <div id="add-step-glean-row" style="display:none;margin-top:10px;">
                <label style="display:flex;gap:10px;align-items:center;font-size:13px;color:rgba(255,255,255,0.75);">
                  <input type="checkbox" id="add-step-glean-checkbox" style="transform: translateY(1px);" />
                  Research messaging (Glean)
                </label>
              </div>
            </div>
            <div class="add-step-field">
              <label class="config-label">What should this step show?</label>
              <textarea id="add-step-description" class="narration-area" rows="3"
                placeholder="e.g. 'Show the funded account balance after the transfer completes' or 'Slide explaining how Plaid Layer reduces drop-off by 30%'"></textarea>
            </div>
            <div class="add-step-actions">
              <button id="add-step-generate-btn" class="btn btn-primary">✦ Generate</button>
              <button id="add-step-cancel-btn" class="btn btn-secondary">Cancel</button>
            </div>
          </div>

          <div id="add-step-preview" style="display:none">
            <div class="add-step-preview-label">Generated step — review and edit before inserting:</div>
            <div class="add-step-preview-grid">
              <span class="add-step-preview-key">ID</span>       <input class="config-input" id="preview-step-id" style="width:100%">
              <span class="add-step-preview-key">Label</span>    <input class="config-input" id="preview-step-label" style="width:100%">
              <span class="add-step-preview-key">Duration</span> <input class="config-input" id="preview-step-dur" type="number" min="5000" max="30000" step="500" style="width:100px">
            </div>
            <label class="config-label" style="margin-top:10px">Narration</label>
            <textarea id="preview-step-narration" class="narration-area" rows="3"></textarea>
            <div id="preview-word-count" class="word-count" style="margin-bottom:8px"></div>
            <label class="config-label">Visual state / slide description</label>
            <textarea id="preview-step-visual" class="narration-area" rows="3"></textarea>
            <div class="add-step-preview-actions">
              <button id="add-step-accept-btn" class="btn btn-primary">✓ Insert into Script</button>
              <button id="add-step-regenerate-btn" class="btn btn-secondary">↺ Regenerate</button>
              <button id="add-step-back-btn" class="btn btn-secondary">← Back</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(addStepModal);

      // Modal state
      let _addStepSceneType = 'demo';
      let _generatedStep = null;
      let _lastBrand = null; // brand profile returned by last generate-step call

      async function openAddStepModal() {
        addStepModal.style.display = 'flex';
        document.getElementById('add-step-description')?.focus();
        // Eagerly fetch brand to pre-populate slide description
        try {
          const brand = await api('/api/runs/' + currentRunId + '/brand');
          if (brand && brand.slug !== 'default') {
            _lastBrand = brand;
            const slideDesc = document.getElementById('add-step-desc-slide');
            if (slideDesc) {
              slideDesc.textContent = `Insight slide — ${brand.slug} design system (${brand.mode} mode, bg ${brand.bgPrimary}, accent ${brand.accentCta}). Matches existing insight screens.`;
            }
          }
        } catch (_e) { /* best-effort */ }
      }
      function closeAddStepModal() {
        addStepModal.style.display = 'none';
        document.getElementById('add-step-form').style.display = '';
        const previewEl = document.getElementById('add-step-preview');
        previewEl.style.display = 'none';
        previewEl.style.background = '';
        previewEl.style.borderLeft = '';
        previewEl.style.color = '';
        document.getElementById('add-step-description').value = '';
        _lastBrand = null;
      }

      document.getElementById('sb-add-step-btn')?.addEventListener('click', openAddStepModal);
      document.getElementById('add-step-close-btn').addEventListener('click', closeAddStepModal);
      document.getElementById('add-step-cancel-btn').addEventListener('click', closeAddStepModal);
      document.getElementById('add-step-back-btn').addEventListener('click', () => {
        document.getElementById('add-step-form').style.display = '';
        document.getElementById('add-step-preview').style.display = 'none';
      });
      addStepModal.querySelector('.add-step-backdrop').addEventListener('click', closeAddStepModal);

      // Scene type toggle
      addStepModal.querySelectorAll('.scene-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          addStepModal.querySelectorAll('.scene-type-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          _addStepSceneType = btn.dataset.type;
          document.getElementById('add-step-desc-demo').style.display = _addStepSceneType === 'demo' ? '' : 'none';
          document.getElementById('add-step-desc-slide').style.display = _addStepSceneType === 'slide' ? '' : 'none';
          const gleanRow = document.getElementById('add-step-glean-row');
          if (gleanRow) gleanRow.style.display = _addStepSceneType === 'slide' ? 'block' : 'none';
          // Reset slide description to default when switching away
          if (_addStepSceneType !== 'slide') {
            const slideDesc = document.getElementById('add-step-desc-slide');
            if (slideDesc) slideDesc.textContent = 'Insight overlay — styled to match this demo\'s brand design system. Matches existing insight screens (header bar, data table, glassmorphism panels).';
          }
        });
      });

      // Narration word count in preview
      document.getElementById('preview-step-narration').addEventListener('input', function () {
        const wc = this.value.trim().split(/\s+/).filter(Boolean).length;
        const el = document.getElementById('preview-word-count');
        if (el) {
          el.textContent = wc + ' / 35 words';
          el.className = 'word-count ' + (wc > 35 ? 'over' : wc > 30 ? 'warn' : '');
        }
      });

      // Generate
      async function runGenerate() {
        const description = document.getElementById('add-step-description').value.trim();
        if (!description) return showToast('Enter a description first', 'error');
        const insertAfterId = document.getElementById('add-step-after').value || undefined;
        const useGleanResearch = _addStepSceneType === 'slide' && (document.getElementById('add-step-glean-checkbox')?.checked === true);
        const btn = document.getElementById('add-step-generate-btn');
        setBtnLoading(btn, true, 'Generating…');
        try {
          const result = await apiPost('/api/runs/' + currentRunId + '/generate-step', {
            sceneType: _addStepSceneType,
            description,
            insertAfterId,
            useGleanResearch,
          });
          _generatedStep = result.step;
          _lastBrand = result.brand || null;

          // Populate preview
          document.getElementById('preview-step-id').value        = _generatedStep.id || '';
          document.getElementById('preview-step-label').value     = _generatedStep.label || '';
          document.getElementById('preview-step-dur').value       = _generatedStep.durationMs || 12000;
          document.getElementById('preview-step-narration').value = _generatedStep.narration || '';
          document.getElementById('preview-step-visual').value    = _generatedStep.visualState || '';
          document.getElementById('preview-step-narration').dispatchEvent(new Event('input'));

          // Apply brand styling to slide preview
          const previewEl = document.getElementById('add-step-preview');
          if (_addStepSceneType === 'slide' && _lastBrand) {
            previewEl.style.background = _lastBrand.bgPrimary || '';
            previewEl.style.borderLeft = `3px solid ${_lastBrand.accentCta || '#00A67E'}`;
            previewEl.style.color = _lastBrand.mode === 'light' ? '#111' : '#fff';
            // Update slide description with actual brand colors
            const slideDesc = document.getElementById('add-step-desc-slide');
            if (slideDesc) {
              slideDesc.textContent = `Insight slide — ${_lastBrand.slug || 'brand'} design system (${_lastBrand.mode} mode, bg ${_lastBrand.bgPrimary}, accent ${_lastBrand.accentCta}). Matches existing insight screens.`;
            }
          } else {
            previewEl.style.background = '';
            previewEl.style.borderLeft = '';
            previewEl.style.color = '';
          }

          document.getElementById('add-step-form').style.display = 'none';
          previewEl.style.display = '';
        } catch (e) {
          showToast('Generation failed: ' + e.message, 'error');
        } finally {
          setBtnLoading(btn, false);
        }
      }

      document.getElementById('add-step-generate-btn').addEventListener('click', runGenerate);
      document.getElementById('add-step-description').addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runGenerate();
      });
      document.getElementById('add-step-regenerate-btn').addEventListener('click', () => {
        document.getElementById('add-step-form').style.display = '';
        document.getElementById('add-step-preview').style.display = 'none';
        runGenerate();
      });

      // Accept — insert into script
      document.getElementById('add-step-accept-btn').addEventListener('click', async () => {
        if (!_generatedStep) return;
        // Apply any edits from preview fields
        _generatedStep.id          = document.getElementById('preview-step-id').value.trim() || _generatedStep.id;
        _generatedStep.label       = document.getElementById('preview-step-label').value.trim() || _generatedStep.label;
        _generatedStep.narration   = document.getElementById('preview-step-narration').value.trim() || _generatedStep.narration;
        _generatedStep.visualState = document.getElementById('preview-step-visual').value.trim() || _generatedStep.visualState;
        _generatedStep.durationMs  = parseInt(document.getElementById('preview-step-dur').value) || _generatedStep.durationMs;
        const insertAfterId = document.getElementById('add-step-after').value || undefined;
        const btn = document.getElementById('add-step-accept-btn');
        setBtnLoading(btn, true, 'Inserting…');
        try {
          const result = await apiPost('/api/runs/' + currentRunId + '/insert-step', {
            step: _generatedStep,
            insertAfterId,
          });
          showToast(
            `Step "${_generatedStep.id}" inserted (#${result.insertedAt + 1} of ${result.totalSteps}). Re-run Build → Record → Render to add it to the video.`,
            'success',
            { duration: 6000, action: 'Re-run Build', onClick: () => runPipeline({ fromStage: 'build', resumeRunId: currentRunId }) }
          );
          closeAddStepModal();
          loadStoryboard(); // refresh
        } catch (e) {
          showToast('Insert failed: ' + e.message, 'error');
        } finally {
          setBtnLoading(btn, false);
        }
      });

      // ── Slide library modal (insert existing reusable slide) ────────────────
      document.getElementById('slide-library-modal')?.remove();
      const slideLibraryModal = document.createElement('div');
      slideLibraryModal.id = 'slide-library-modal';
      slideLibraryModal.className = 'add-step-modal';
      slideLibraryModal.style.display = 'none';
      slideLibraryModal.innerHTML = `
        <div class="add-step-backdrop"></div>
        <div class="add-step-panel slide-library-panel">
          <div class="add-step-header">
            <span class="add-step-title">Insert from Slide Library</span>
            <button id="slide-library-close-btn" class="btn btn-sm" style="background:transparent;border:none;color:rgba(255,255,255,0.5);font-size:16px;cursor:pointer;padding:0 4px">✕</button>
          </div>
          <div class="add-step-field">
            <label class="config-label">Insert after</label>
            <div id="slide-library-insert-target" class="slide-library-target"></div>
          </div>
          <div class="add-step-field">
            <label class="config-label">Quick search</label>
            <input id="slide-library-search" class="config-input" style="width:100%" placeholder="Search by name, source run, step, or tag">
          </div>
          <div id="slide-library-list" class="slide-library-list"></div>
          <div class="add-step-actions">
            <button id="slide-library-insert-btn" class="btn btn-primary" disabled>Insert selected slide</button>
            <button id="slide-library-cancel-btn" class="btn btn-secondary">Cancel</button>
          </div>
        </div>`;
      document.body.appendChild(slideLibraryModal);

      let _slideLibraryInsertAfterId = '';
      let _slideLibrarySelectedId = '';
      let _slideLibrarySearchTimer = null;
      let _slideLibraryEntries = [];

      function renderSlideLibraryList(entries) {
        const listEl = document.getElementById('slide-library-list');
        if (!listEl) return;
        if (!entries.length) {
          listEl.innerHTML = '<div class="slide-library-empty">No slides found. Submit one from the running demo app AI chat first.</div>';
          return;
        }
        listEl.innerHTML = entries.map((entry) => {
          const selected = _slideLibrarySelectedId === entry.id;
          const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : 'Unknown date';
          const tags = Array.isArray(entry.tags) && entry.tags.length
            ? `<div class="slide-library-item-tags">${entry.tags.slice(0, 4).map(t => `<span class="slide-library-tag">${esc(t)}</span>`).join('')}</div>`
            : '';
          return `
            <button type="button" class="slide-library-item ${selected ? 'is-selected' : ''}" data-slide-id="${esc(entry.id)}">
              <div class="slide-library-item-title">${esc(entry.name || entry.id)}</div>
              <div class="slide-library-item-meta">${esc(entry.sceneType || 'slide')} · ${esc(entry.sourceRunId || 'unknown run')} · ${esc(entry.sourceStepId || 'unknown step')}</div>
              <div class="slide-library-item-meta">${esc(when)}</div>
              ${tags}
            </button>`;
        }).join('');
      }

      function syncSlideLibrarySelection() {
        const insertBtn = document.getElementById('slide-library-insert-btn');
        if (insertBtn) insertBtn.disabled = !_slideLibrarySelectedId;
        const targetEl = document.getElementById('slide-library-insert-target');
        if (targetEl) targetEl.textContent = _slideLibraryInsertAfterId
          ? _slideLibraryInsertAfterId
          : 'End of sequence';
      }

      async function loadSlideLibraryList(query) {
        const q = String(query || '').trim();
        const suffix = q ? ('?q=' + encodeURIComponent(q)) : '';
        const result = await api('/api/slide-library' + suffix);
        _slideLibraryEntries = Array.isArray(result.slides) ? result.slides : [];
        if (!_slideLibraryEntries.some(entry => entry.id === _slideLibrarySelectedId)) {
          _slideLibrarySelectedId = '';
        }
        renderSlideLibraryList(_slideLibraryEntries);
        syncSlideLibrarySelection();
      }

      async function openSlideLibraryModal(insertAfterId) {
        _slideLibraryInsertAfterId = String(insertAfterId || '').trim();
        _slideLibrarySelectedId = '';
        const searchEl = document.getElementById('slide-library-search');
        if (searchEl) searchEl.value = '';
        slideLibraryModal.style.display = 'flex';
        syncSlideLibrarySelection();
        try {
          await loadSlideLibraryList('');
          searchEl?.focus();
        } catch (e) {
          showToast('Failed to load slide library: ' + e.message, 'error');
        }
      }

      function closeSlideLibraryModal() {
        slideLibraryModal.style.display = 'none';
      }

      document.getElementById('slide-library-close-btn')?.addEventListener('click', closeSlideLibraryModal);
      document.getElementById('slide-library-cancel-btn')?.addEventListener('click', closeSlideLibraryModal);
      slideLibraryModal.querySelector('.add-step-backdrop')?.addEventListener('click', closeSlideLibraryModal);

      document.getElementById('slide-library-search')?.addEventListener('input', (evt) => {
        const value = evt.target && evt.target.value ? evt.target.value : '';
        clearTimeout(_slideLibrarySearchTimer);
        _slideLibrarySearchTimer = setTimeout(() => {
          loadSlideLibraryList(value).catch((e) => {
            showToast('Search failed: ' + e.message, 'error');
          });
        }, 180);
      });

      document.getElementById('slide-library-list')?.addEventListener('click', (evt) => {
        const target = evt.target;
        if (!(target instanceof Element)) return;
        const btn = target.closest('.slide-library-item[data-slide-id]');
        if (!btn) return;
        _slideLibrarySelectedId = btn.dataset.slideId || '';
        renderSlideLibraryList(_slideLibraryEntries);
        syncSlideLibrarySelection();
      });

      document.getElementById('slide-library-insert-btn')?.addEventListener('click', async () => {
        if (!_slideLibrarySelectedId) return;
        const btn = document.getElementById('slide-library-insert-btn');
        setBtnLoading(btn, true, 'Inserting…');
        try {
          const result = await apiPost('/api/runs/' + currentRunId + '/insert-library-slide', {
            slideId: _slideLibrarySelectedId,
            insertAfterId: _slideLibraryInsertAfterId || undefined,
          });
          showToast(`Inserted library slide "${result.step?.id || _slideLibrarySelectedId}"`, 'success');
          closeSlideLibraryModal();
          loadStoryboard();
        } catch (e) {
          showToast('Insert failed: ' + e.message, 'error');
        } finally {
          setBtnLoading(btn, false);
        }
      });

      el.addEventListener('click', (evt) => {
        const target = evt.target;
        if (!(target instanceof Element)) return;
        const btn = target.closest('.sb-insert-library-btn[data-insert-after-id]');
        if (!btn) return;
        openSlideLibraryModal(btn.dataset.insertAfterId);
      });

    } catch (e) {
      el.innerHTML = `<div class="empty-state error">Failed to load storyboard: ${esc(e.message)}</div>`;
    }
  }

  async function submitNarrationRewrite(stepId, parentEl) {
    if (!currentRunId || !stepId) return;
    const directionInput = parentEl.querySelector(`.sb-rewrite-direction[data-step-id="${stepId}"]`);
    const direction = directionInput?.value?.trim();
    if (!direction) { showToast('Enter a direction first', 'warn'); directionInput?.focus(); return; }

    const ta = parentEl.querySelector(`.narration-area[data-step-id="${stepId}"]`);
    const narration = ta?.value || '';
    const stepCard = parentEl.querySelector(`.step-card[data-step-id="${stepId}"]`);
    const label = stepCard?.querySelector('.step-label')?.textContent || stepId;

    const submitBtn = parentEl.querySelector(`.sb-rewrite-submit-btn[data-step-id="${stepId}"]`);
    if (submitBtn) { submitBtn.textContent = 'Rewriting…'; submitBtn.disabled = true; }

    try {
      const result = await apiPost(`/api/runs/${currentRunId}/narration-rewrite`, {
        stepId, narration, direction, label,
      });

      const resultEl = document.getElementById('sb-rewrite-result-' + stepId);
      const proposedEl = document.getElementById('sb-rewrite-proposed-' + stepId);
      if (resultEl && proposedEl) {
        proposedEl.textContent = result.rewritten;
        const wc = result.wordCount;
        const wcColor = wc > 35 ? '#f87171' : wc > 30 ? '#fbbf24' : '#00A67E';
        proposedEl.style.color = '#fff';
        proposedEl.title = `${wc} words`;
        resultEl.style.display = 'block';
        // Append word count hint
        const existing = resultEl.querySelector('.sb-rewrite-wc');
        if (existing) existing.remove();
        const wcEl = document.createElement('div');
        wcEl.className = 'sb-rewrite-wc';
        wcEl.style.cssText = `font-size:11px;color:${wcColor};margin-bottom:6px`;
        wcEl.textContent = `${wc} words`;
        resultEl.insertBefore(wcEl, resultEl.querySelector('.sb-rewrite-accept-actions'));
      }
    } catch (e) {
      showToast('Rewrite failed: ' + e.message, 'error');
    } finally {
      if (submitBtn) { submitBtn.textContent = 'Rewrite'; submitBtn.disabled = false; }
    }
  }

  async function exportFeedback(silent = false) {
    // Collect current global notes from DOM if loaded
    const globalNotesEl = document.getElementById('sb-global-notes');
    const globalNotes = globalNotesEl ? globalNotesEl.value : _globalHtmlNotes;

    // Collect visual notes from DOM
    const noteEls = document.querySelectorAll('.visual-notes-area[data-step-id]');
    const stepNotes = { ..._stepVisualNotes };
    noteEls.forEach(ta => {
      if (ta.value.trim()) stepNotes[ta.dataset.stepId] = ta.value;
    });

    const hasContent = globalNotes.trim() || Object.values(stepNotes).some(v => v && v.trim());
    if (!hasContent) {
      if (!silent) showToast('No feedback to export — add notes first', 'warn');
      return false;
    }

    try {
      const result = await apiPost('/api/feedback/export', {
        globalNotes,
        stepNotes,
        runId: currentRunId,
      });
      const statusEl = document.getElementById('sb-export-status');
      if (statusEl) statusEl.textContent = `✓ Exported to inputs/build-feedback.md (${result.bytes} bytes) — ${new Date().toLocaleTimeString()}`;
      if (!silent) showToast('Exported to inputs/build-feedback.md', 'success');
      return true;
    } catch (e) {
      showToast('Export failed: ' + e.message, 'error');
      return false;
    }
  }

  async function loadSavedFeedback() {
    try {
      const data = await api('/api/feedback');
      if (!data.exists || !data.content) { showToast('No saved feedback found', 'warn'); return; }

      // Parse global notes from the file
      const globalMatch = data.content.match(/## Global HTML Notes\n\n([\s\S]*?)(?=\n## |$)/);
      if (globalMatch) {
        _globalHtmlNotes = globalMatch[1].trim();
        const el = document.getElementById('sb-global-notes');
        if (el) el.value = _globalHtmlNotes;
      }

      // Parse per-step notes
      const stepMatches = [...data.content.matchAll(/### ([\w-]+)\n\n([\s\S]*?)(?=\n### |\n## |$)/g)];
      stepMatches.forEach(m => {
        const sid = m[1];
        const note = m[2].trim();
        _stepVisualNotes[sid] = note;
        const ta = document.querySelector(`.visual-notes-area[data-step-id="${sid}"]`);
        if (ta) ta.value = note;
      });

      showToast('Feedback loaded from inputs/build-feedback.md', 'success');
    } catch (e) {
      showToast('Load failed: ' + e.message, 'error');
    }
  }

  async function saveNarration(stepId, parentEl) {
    if (!currentRunId || !stepId) return;
    const ta = parentEl.querySelector(`.narration-area[data-step-id="${stepId}"]`);
    if (!ta) return;
    try {
      const result = await apiPost('/api/runs/' + currentRunId + '/script', { stepId, narration: ta.value });
      originalNarrations[stepId] = ta.value;
      postStoryboardPreviewMessage({ type: 'STORYBOARD_SYNC_NARRATION', stepId, narration: ta.value });
      const syncAdjust = result && result.syncAdjust ? result.syncAdjust : null;
      if (syncAdjust && syncAdjust.updated) {
        showToast(
          `Narration saved for ${stepId} (timeline extended by ${Math.max(0, Math.round((Number(syncAdjust.narrationMs || 0) - Number(syncAdjust.compDurationMs || 0)) / 1000))}s). Refreshing storyboard timing…`,
          'success',
          { duration: 4000 }
        );
        // Timing windows/sync-map changed on save; reload storyboard cards + timing bars so
        // live preview and narration editor stay aligned with the latest timeline contract.
        await loadStoryboard();
      } else {
        showToast('Narration saved for ' + stepId, 'success');
      }
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
    }
  }

  // ── AI Overlay Suggestions ─────────────────────────────────────────────────

  async function loadOverlaySuggestions() {
    const panel = document.getElementById('ai-suggestions-panel');
    if (!panel || !currentRunId) return;

    panel.innerHTML = '<div class="suggestion-loading">Loading AI suggestions…</div>';

    let data;
    try {
      data = await api('/api/runs/' + currentRunId + '/overlay-suggestions');
    } catch (err) {
      if (err.message && err.message.includes('404')) {
        // Stage not run yet
        panel.innerHTML = renderSuggestionsNotRun();
      } else {
        panel.innerHTML = '';
      }
      bindSuggestionPanelEvents(panel);
      return;
    }

    if (data.skipped) {
      panel.innerHTML = renderSuggestionsNotRun('No credentials configured (GOOGLE_API_KEY / VERTEX_AI_PROJECT_ID)');
      bindSuggestionPanelEvents(panel);
      return;
    }

    if (data.warning) {
      panel.innerHTML = renderSuggestionsNotRun(data.warning);
      bindSuggestionPanelEvents(panel);
      return;
    }

    const totalSuggestions = data.totalSuggestions || 0;
    if (totalSuggestions === 0) {
      panel.innerHTML = `
        <div class="suggestion-panel-header">
          <span class="suggestion-panel-title">AI Overlay Suggestions</span>
          <span class="suggestion-count-badge" style="background:rgba(34,197,94,0.2);color:#22c55e">No changes suggested ✓</span>
        </div>`;
      return;
    }

    // Build suggestion cards
    const steps = data.steps || {};
    let cardsHtml = '';
    for (const [stepId, entry] of Object.entries(steps)) {
      if (!entry?.suggestions?.length) continue;
      entry.suggestions.forEach((s, idx) => {
        const confClass = s.confidence >= 0.85 ? 'high' : s.confidence >= 0.70 ? 'med' : 'low';
        const confPct   = Math.round(s.confidence * 100);
        const midFrame  = `/api/runs/${currentRunId}/frames/${stepId}-mid.png`;
        const patchPreview = buildPatchPreview(s.patch);
        cardsHtml += `
          <div class="suggestion-card" data-step-id="${escHtml(stepId)}" data-suggestion-index="${idx}" id="scard-${escHtml(stepId)}-${idx}">
            <img class="suggestion-frame" src="${midFrame}" alt="${escHtml(stepId)}" onerror="this.style.display='none'">
            <div class="suggestion-body">
              <div class="suggestion-meta">
                <span class="suggestion-step-label">${escHtml(stepId)}</span>
                <span class="suggestion-type-badge">${escHtml(s.type)} · ${escHtml(s.action)}</span>
                <span class="suggestion-confidence ${confClass}">${confPct}%</span>
              </div>
              <div class="suggestion-reasoning">${escHtml(s.reasoning || '')}</div>
              <div class="suggestion-patch-preview">${escHtml(patchPreview)}</div>
              <div class="suggestion-actions">
                <button class="btn btn-sm btn-primary suggestion-apply-btn" data-step-id="${escHtml(stepId)}" data-idx="${idx}">Apply</button>
                <button class="btn btn-sm suggestion-dismiss-btn" data-card-id="scard-${escHtml(stepId)}-${idx}">Dismiss</button>
              </div>
            </div>
          </div>`;
      });
    }

    const highConfCount = countHighConfSuggestions(steps, 0.85);
    panel.innerHTML = `
      <div class="suggestion-panel-header">
        <span class="suggestion-panel-title">AI Overlay Suggestions</span>
        <span class="suggestion-count-badge">${totalSuggestions} suggestion${totalSuggestions !== 1 ? 's' : ''}</span>
        ${highConfCount > 0 ? `<button class="btn btn-sm btn-primary" id="apply-all-suggestions-btn">Apply All (≥85%)</button>` : ''}
        <button class="btn btn-sm" id="run-suggestions-btn">Re-run</button>
      </div>
      <div class="suggestion-cards">${cardsHtml}</div>`;

    bindSuggestionPanelEvents(panel);
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function buildPatchPreview(patch) {
    if (!patch) return '';
    const keys = Object.keys(patch).slice(0, 3);
    return keys.map(k => {
      const v = patch[k];
      if (typeof v === 'object') return `${k}: {…}`;
      return `${k}: ${v}`;
    }).join(', ');
  }

  function countHighConfSuggestions(steps, threshold) {
    let count = 0;
    for (const entry of Object.values(steps)) {
      for (const s of (entry?.suggestions || [])) {
        if (s.confidence >= threshold) count++;
      }
    }
    return count;
  }

  function renderSuggestionsNotRun(reason) {
    const msg = reason || 'Stage not run yet';
    return `
      <div class="suggestion-panel-header">
        <span class="suggestion-panel-title">AI Overlay Suggestions</span>
        <span class="suggestion-count-badge" style="background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.45)">${escHtml(msg)}</span>
        <button class="btn btn-sm btn-primary" id="run-suggestions-btn">Run Now</button>
      </div>`;
  }

  function bindSuggestionPanelEvents(panel) {
    // Run / Re-run button
    const runBtn = panel.querySelector('#run-suggestions-btn');
    if (runBtn) {
      runBtn.addEventListener('click', async () => {
        runBtn.disabled = true;
        runBtn.textContent = 'Running…';
        try {
          await runPipeline( { fromStage: 'ai-suggest-overlays', resumeRunId: currentRunId });
          showToast('Suggestion stage started — check Pipeline tab for progress', 'success');
          switchTab('pipeline');
          setPipelineRunning(true);
        } catch (e) {
          showToast('Failed to start: ' + e.message, 'error');
          runBtn.disabled = false;
          runBtn.textContent = 'Run Now';
        }
      });
    }

    // Apply All button
    const applyAllBtn = panel.querySelector('#apply-all-suggestions-btn');
    if (applyAllBtn) {
      applyAllBtn.addEventListener('click', async () => {
        applyAllBtn.disabled = true;
        applyAllBtn.textContent = 'Applying…';
        try {
          const result = await apiPost('/api/runs/' + currentRunId + '/apply-all-suggestions', { minConfidence: 0.85 });
          showToast(`Applied ${result.applied} suggestion(s) — click Re-render to see changes`, 'success');
          // Mark applied cards
          panel.querySelectorAll('.suggestion-card').forEach(card => {
            const stepId = card.dataset.stepId;
            if (result.stepIds && result.stepIds.includes(stepId)) {
              card.classList.add('applied');
            }
          });
          applyAllBtn.textContent = `Applied ${result.applied}`;
        } catch (e) {
          showToast('Apply all failed: ' + e.message, 'error');
          applyAllBtn.disabled = false;
          applyAllBtn.textContent = 'Apply All (≥85%)';
        }
      });
    }

    // Individual Apply buttons
    panel.querySelectorAll('.suggestion-apply-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const stepId = btn.dataset.stepId;
        const idx    = parseInt(btn.dataset.idx, 10);
        btn.disabled = true;
        btn.textContent = 'Applying…';
        try {
          await apiPost('/api/runs/' + currentRunId + '/apply-suggestion', { stepId, suggestionIndex: idx });
          showToast('Applied — click Re-render to see changes', 'success');
          const card = document.getElementById(`scard-${stepId}-${idx}`);
          if (card) card.classList.add('applied');
          btn.textContent = 'Applied ✓';
        } catch (e) {
          showToast('Apply failed: ' + e.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Apply';
        }
      });
    });

    // Dismiss buttons
    panel.querySelectorAll('.suggestion-dismiss-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = document.getElementById(btn.dataset.cardId);
        if (card) card.classList.add('dismissed');
      });
    });
  }

  // ── Wizard Stage Tracker ────────────────────────────────────────────────────

  let _wizardSelectedStage = null;
  // Store log lines per stage for wizard log panel
  const _wizardStageLogs = {};

  function renderWizard(completedStages, activeStage) {
    const completedSet = new Set(completedStages || []);

    // Left: stage list
    const listItems = STAGES.map(s => {
      let stateClass = 'pending';
      let icon = '○';
      if (completedSet.has(s)) { stateClass = 'done'; icon = '✓'; }
      else if (s === activeStage) { stateClass = 'active'; icon = '◎'; }
      return `
        <div class="wizard-stage-item ${stateClass} ${_wizardSelectedStage === s ? 'selected' : ''}" data-stage="${esc(s)}">
          <span class="ws-icon">${icon}</span>
          <span class="ws-label">${esc(s)}</span>
        </div>`;
    }).join('');

    // Right: detail panel for selected stage
    const sel = _wizardSelectedStage || activeStage || STAGES[0];
    const meta = STAGE_META[sel] || {};
    let stateLabel = 'Pending';
    let stateColor = 'rgba(255,255,255,0.35)';
    if (completedSet.has(sel)) { stateLabel = 'Complete'; stateColor = '#00A67E'; }
    else if (sel === activeStage) { stateLabel = 'Running…'; stateColor = '#fbbf24'; }

    const readsHtml = (meta.reads || []).map(f => `<div class="wizard-io-item">${esc(f)}</div>`).join('');
    const writesHtml = (meta.writes || []).map(f => `<div class="wizard-io-item">${esc(f)}</div>`).join('');
    const logLines = (_wizardStageLogs[sel] || []).slice(-30).join('\n');

    const detailHtml = `
      <div class="wizard-detail">
        <div class="wizard-detail-name">${esc(sel)}</div>
        <div class="wizard-detail-status" style="color:${stateColor}">${stateLabel}</div>
        ${meta.desc ? `<div class="wizard-detail-desc">${esc(meta.desc)}</div>` : ''}
        <div class="wizard-io-row">
          <div class="wizard-io-col">
            <div class="wizard-io-label">Reads</div>
            ${readsHtml || '<div class="wizard-io-item" style="color:rgba(255,255,255,0.25)">—</div>'}
          </div>
          <div class="wizard-io-col">
            <div class="wizard-io-label">Writes</div>
            ${writesHtml || '<div class="wizard-io-item" style="color:rgba(255,255,255,0.25)">—</div>'}
          </div>
        </div>
        <div class="wizard-actions">
          <button class="btn btn-sm btn-secondary wizard-run-from-btn" data-stage="${esc(sel)}"
            title="Run pipeline from this stage">▶ Run from here</button>
        </div>
        ${logLines ? `<div class="wizard-log">${esc(logLines)}</div>` : ''}
      </div>`;

    const html = `
      <div class="wizard-layout" id="wizard-layout">
        <div class="wizard-stage-list">${listItems}</div>
        ${detailHtml}
      </div>`;

    return html;
  }

  // ── Pipeline Tab ───────────────────────────────────────────────────────────

  async function loadPipeline() {
    const el = document.getElementById('pipeline-content');

    // Load stages and prompt in parallel
    const [stagesData, promptData] = await Promise.allSettled([
      api('/api/pipeline/stages'),
      api('/api/config/prompt'),
    ]);

    const stages = stagesData.status === 'fulfilled' ? (stagesData.value.stages || STAGES) : STAGES;
    const promptText = promptData.status === 'fulfilled' ? (promptData.value.content || '') : '';

    const stageOptions = stages.map((s, i) =>
      `<option value="${esc(s)}">${i + 1}. ${esc(s)}</option>`
    ).join('');

    const stagePills = stages.map(s =>
      `<div class="stage-pill" id="stage-pill-${esc(s)}" data-stage="${esc(s)}">${esc(s)}</div>`
    ).join('');

    // Wizard section (injected before main controls)
    let wizardHtml = '';
    if (currentRunId) {
      try {
        const runInfo = await api('/api/runs/' + currentRunId);
        const completedStages = runInfo.completedStages || [];
        wizardHtml = renderWizard(completedStages, null);
      } catch (_) {
        wizardHtml = renderWizard([], null);
      }
    }

    el.innerHTML = wizardHtml + `
      <div class="card">
        <div class="card-title">Prompt</div>
        <p class="config-desc" style="margin:0 0 8px">Written to <code>inputs/prompt.txt</code>. Starting a run from this tab saves the editor first.</p>
        <textarea id="pipeline-prompt-editor" style="width:100%;min-height:150px;box-sizing:border-box">${esc(promptText)}</textarea>
        <button type="button" id="pipeline-save-prompt-btn" class="btn btn-secondary btn-sm" style="margin-top:8px">Save Prompt</button>
      </div>

      <div class="card">
        <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>Run Pipeline</span>
          <span id="pipeline-status-badge" class="pipeline-status-badge idle">○ Idle</span>
        </div>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <label>From stage: <select id="stage-select">${stageOptions}</select></label>
          <label title="Stop after this stage (orchestrator --to). Leave default to run through touchup.">To stage: <select id="pipeline-to-stage-select">
            <option value="">Through end</option>
            ${stageOptions}
          </select></label>
          <label title="Passed as RESEARCH_MODE for the research stage (empty = use prompt line or default)">Research: <select id="research-mode-select">
            <option value="">Default (gapfill) / prompt</option>
            <option value="full">full</option>
            <option value="gapfill">gapfill</option>
            <option value="messaging">messaging</option>
            <option value="skip">skip</option>
          </select></label>
          <label><input type="checkbox" id="no-touchup-check"> Skip touchup</label>
          <label title="Off (default) = app-only build, no slide steps. On = include the slides build phase and final value-summary slide. Toggling here also updates your dashboard default."><input type="checkbox" id="with-slides-check"> Include slides phase</label>
          <button id="run-btn" class="btn btn-primary">Run Pipeline</button>
          <button id="run-from-btn" class="btn btn-secondary">Run from Stage</button>
          <button id="run-refinement-pipeline-btn" class="btn btn-secondary" title="Export storyboard feedback then re-run from build stage">✦ Run Refinement</button>
          <button id="resync-audio-btn" class="btn btn-secondary" title="Re-stitch voiceover audio at composition-space timings (no TTS calls)">⟳ Resync Audio</button>
          <button id="open-studio-btn" class="btn btn-secondary" title="Open Remotion Studio pre-loaded with this run's props (requires render stage to have completed)">▶ Open in Studio</button>
          <button id="kill-btn" class="btn btn-danger">Kill</button>
        </div>
        <div style="margin-top:12px">
          <button id="pipeline-continue-btn" class="btn btn-primary" style="display:none;background:#fbbf24;border-color:#fbbf24;color:#000">
            ▶ Continue — send ENTER to pipeline
          </button>
        </div>
        <div class="stage-progress" style="margin-top:16px" id="stage-progress-bar">${stagePills}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-top:4px" id="stage-label"></div>
        <div id="studio-status-panel" style="display:none;margin-top:12px;padding:10px 14px;background:rgba(0,166,126,0.10);border:1px solid rgba(0,166,126,0.35);border-radius:6px;font-size:13px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="width:8px;height:8px;border-radius:50%;background:#00A67E;display:inline-block;animation:pulse 1.4s infinite"></span>
            <strong style="color:#00A67E">Studio Recording</strong>
            <span id="studio-phase-badge" style="font-size:11px;color:rgba(255,255,255,0.5)"></span>
          </div>
          <div id="studio-status-message" style="color:rgba(255,255,255,0.8);margin-bottom:4px"></div>
          <div id="studio-step-counter" style="color:rgba(255,255,255,0.5);font-size:11px"></div>
        </div>
      </div>

      <div class="card" id="stdin-card">
        <div class="card-title">Pipeline Input</div>
        <p class="config-desc" style="margin-bottom:10px">
          Send text to the running pipeline (touchup requests, <code>render</code>, <code>skip</code>, or ENTER to continue a paused stage).
        </p>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" id="stdin-input" class="config-input" placeholder='e.g. "reduce zoom on step 8" or render or skip' style="flex:1">
          <button type="button" id="stdin-send-btn" class="btn btn-primary btn-sm">Send</button>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-sm btn-secondary stdin-shortcut" data-value="render">render</button>
          <button type="button" class="btn btn-sm btn-secondary stdin-shortcut" data-value="skip">skip</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
          <span>Live Logs</span>
          <button class="btn btn-sm btn-secondary" id="clear-logs-btn">Clear</button>
        </div>
        <div id="log-viewer"></div>
      </div>`;

    // Check initial running state and update button states
    api('/api/pipeline/status').then(s => setPipelineRunning(s.running)).catch(() => {});

    // Populate stage dropdown based on current run's completed stages
    updateStageDropdown();

    // Initialize the "Include slides phase" checkbox from the dashboard-wide
    // localStorage default. Toggling it also persists the new default — that
    // way users can flip per run, but their preference sticks for next time.
    const withSlidesCheck = document.getElementById('with-slides-check');
    if (withSlidesCheck) {
      withSlidesCheck.checked = getDashboardWithSlidesDefault();
      withSlidesCheck.addEventListener('change', () => {
        setDashboardWithSlidesDefault(!!withSlidesCheck.checked);
      });
    }

    // Wizard stage item clicks
    el.addEventListener('click', (e) => {
      const item = e.target.closest('.wizard-stage-item');
      if (item) {
        _wizardSelectedStage = item.dataset.stage;
        // Re-render wizard section only
        const wizardLayout = document.getElementById('wizard-layout');
        if (wizardLayout && currentRunId) {
          api('/api/runs/' + currentRunId).then(runInfo => {
            const wizardEl = document.createElement('div');
            wizardEl.innerHTML = renderWizard(runInfo.completedStages || [], null);
            const newLayout = wizardEl.querySelector('#wizard-layout');
            if (newLayout) wizardLayout.replaceWith(newLayout);
            // Re-wire wizard clicks
          }).catch(() => {});
        }
      }
      const runFromBtn = e.target.closest('.wizard-run-from-btn');
      if (runFromBtn) {
        const stage = runFromBtn.dataset.stage;
        const stageSelect = document.getElementById('stage-select');
        if (stageSelect) {
          const opt = stageSelect.querySelector(`option[value="${CSS.escape(stage)}"]:not([disabled])`);
          if (opt) stageSelect.value = stage;
        }
        showToast(`Stage set to ${stage} — click Run from Stage`, 'success');
      }
    });

    // Continue button — sends '\n' to the blocked pipeline stdin
    document.getElementById('pipeline-continue-btn').addEventListener('click', async () => {
      try {
        await apiPost('/api/pipeline/stdin', { input: '\n' });
        showContinueButton(false);
        showToast('Continue signal sent', 'success');
      } catch (e) {
        showToast('Failed: ' + e.message, 'error');
      }
    });

    // Save prompt
    document.getElementById('pipeline-save-prompt-btn').addEventListener('click', async () => {
      const ta = document.getElementById('pipeline-prompt-editor');
      if (!ta) return;
      try {
        await apiPost('/api/config/prompt', { content: ta.value });
        showToast('Prompt saved', 'success');
        // Sync to config tab editor if present
        const configTa = document.getElementById('prompt-editor');
        if (configTa) configTa.value = ta.value;
      } catch (e) {
        showToast('Save failed: ' + e.message, 'error');
      }
    });

    // Run pipeline (full): new directory if current run already has a script; otherwise resume
    // into the selected run (e.g. empty run from Builds → Create new build).
    document.getElementById('run-btn').addEventListener('click', async () => {
      const btn = document.getElementById('run-btn');
      const noTouchup = document.getElementById('no-touchup-check').checked;
      const withSlidesEl = document.getElementById('with-slides-check');
      const withSlidesChoice = !!(withSlidesEl && withSlidesEl.checked);
      setBtnLoading(btn, true, 'Starting…');
      try {
        // The checkbox is the per-run override; send overrideWithSlides=true
        // so the server uses this value even for resumes that have a recorded
        // build mode in their run-manifest.
        const payload = {
          noTouchup,
          applyUiToStage: true,
          withSlides: withSlidesChoice,
          overrideWithSlides: true,
        };
        if (currentRunId) {
          try {
            const meta = await api('/api/runs/' + currentRunId);
            if (meta.artifacts && meta.artifacts.script) {
              payload.createNewRun = true;
            } else {
              payload.resumeRunId = currentRunId;
            }
          } catch (_) {
            payload.createNewRun = true;
          }
        } else {
          payload.createNewRun = true;
        }
        const started = await runPipeline(payload);
        if (started && started.runId) {
          currentRunId = started.runId;
          localStorage.setItem('lastRunId', currentRunId);
          await loadRuns();
        }
        showToast('Pipeline started', 'success');
        setPipelineRunning(true);
      } catch (e) {
        showToast('Failed to start: ' + e.message, 'error');
      } finally {
        setBtnLoading(btn, false);
      }
    });

    // Run from stage
    document.getElementById('run-from-btn').addEventListener('click', async () => {
      const btn = document.getElementById('run-from-btn');
      const fromStage = document.getElementById('stage-select').value;
      const noTouchup = document.getElementById('no-touchup-check').checked;
      setBtnLoading(btn, true, 'Starting…');
      try {
        await runPipeline({ fromStage, noTouchup, resumeRunId: currentRunId, applyUiToStage: true });
        showToast(`Pipeline started from ${fromStage}`, 'success');
        setPipelineRunning(true);
      } catch (e) {
        showToast('Failed to start: ' + e.message, 'error');
      } finally {
        setBtnLoading(btn, false);
      }
    });

    // Run Refinement (pipeline tab shortcut — exports feedback then runs from build)
    document.getElementById('run-refinement-pipeline-btn')?.addEventListener('click', async () => {
      const noTouchup = document.getElementById('no-touchup-check').checked;
      try {
        await runPipeline({ fromStage: 'build', noTouchup, resumeRunId: currentRunId, applyUiToStage: true });
        showToast('Refinement started from build stage', 'success');
        setPipelineRunning(true);
      } catch (e) {
        showToast('Failed: ' + e.message, 'error');
      }
    });

    // Open in Studio — launches Remotion Studio pre-loaded with this run's remotion-props.json (B4)
    document.getElementById('open-studio-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('open-studio-btn');
      if (!currentRunId) { showToast('No run selected', 'error'); return; }
      setBtnLoading(btn, true, 'Opening…');
      try {
        const result = await apiPost(`/api/runs/${currentRunId}/open-studio`, {});
        showToast('Remotion Studio launching at http://localhost:3000', 'success');
        // Open the Studio URL in a new tab after a short delay for it to start
        setTimeout(() => window.open('http://localhost:3000', '_blank'), 2500);
      } catch (e) {
        showToast('Failed: ' + e.message, 'error');
      } finally {
        setBtnLoading(btn, false);
      }
    });

    // Resync Audio — runs resync-audio stage only (re-stitches voiceover.mp3 at comp-space timings)
    document.getElementById('resync-audio-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('resync-audio-btn');
      setBtnLoading(btn, true, 'Resyncing…');
      try {
        await runPipeline( { fromStage: 'resync-audio', resumeRunId: currentRunId });
        showToast('Resync audio started', 'success');
        setPipelineRunning(true);
      } catch (e) {
        showToast('Failed: ' + e.message, 'error');
        setBtnLoading(btn, false);
      }
    });

    // Kill
    document.getElementById('kill-btn').addEventListener('click', async () => {
      try {
        await apiPost('/api/pipeline/kill', {});
        showToast('Kill signal sent', 'warn');
      } catch (e) {
        showToast('Kill failed: ' + e.message, 'error');
      }
    });

    // Pipeline stdin input (touchup requests / render / skip / continue)
    async function sendStdin(value) {
      const text = (value || '').trim();
      try {
        await apiPost('/api/pipeline/stdin', { input: text + '\n' });
        showContinueButton(false);
        if (text) showToast('Sent: ' + text, 'success');
      } catch (e) {
        showToast('Failed: ' + e.message, 'error');
      }
    }

    document.getElementById('stdin-send-btn').addEventListener('click', () => {
      const inp = document.getElementById('stdin-input');
      sendStdin(inp.value);
      inp.value = '';
    });

    document.getElementById('stdin-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const inp = document.getElementById('stdin-input');
        sendStdin(inp.value);
        inp.value = '';
      }
    });

    document.querySelectorAll('.stdin-shortcut').forEach(btn => {
      btn.addEventListener('click', () => sendStdin(btn.dataset.value));
    });

    // Clear logs
    document.getElementById('clear-logs-btn').addEventListener('click', () => {
      const viewer = document.getElementById('log-viewer');
      if (viewer) viewer.innerHTML = '';
    });

    // Restore persisted orchestrator log when pipeline is idle (parity with CLI + resume).
    const viewerPre = document.getElementById('log-viewer');
    let skipLogReplay = false;
    if (viewerPre) {
      viewerPre.innerHTML = '';
      try {
        const st = await api('/api/pipeline/status');
        if (!st.running && currentRunId) {
          const hist = await api(
            '/api/runs/' + encodeURIComponent(currentRunId) + '/pipeline-console-log?maxLines=4000'
          );
          if (hist && Array.isArray(hist.lines) && hist.lines.length > 0) {
            hist.lines.forEach((row) => {
              const entry =
                typeof row === 'object' && row !== null && typeof row.text === 'string'
                  ? row
                  : { text: String(row), stream: 'stdout' };
              appendLogEntry(entry);
            });
            skipLogReplay = true;
          }
        }
      } catch (_) {
        /* no file yet */
      }
    }

    // Re-connect log SSE so new messages flow into the newly rendered #log-viewer
    connectLogSSE({ skipReplay: skipLogReplay });
  }

  // ── Stage Banner ────────────────────────────────────────────────────────────

  function updateStageBanner(stageName, stageIndex) {
    const banner = document.getElementById('stage-banner');
    if (!banner) return;
    const total = STAGES.length;
    const labelEl = document.getElementById('stage-banner-label');
    if (labelEl) labelEl.textContent = `Stage ${stageIndex + 1}/${total} · ${stageName}`;
    banner.style.display = 'flex';
    if (!stageBannerStart) stageBannerStart = Date.now();
    if (stageBannerTimer) clearInterval(stageBannerTimer);
    stageBannerTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - stageBannerStart) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      const el = document.getElementById('stage-banner-elapsed');
      if (el) el.textContent = `${m}m ${s < 10 ? '0' : ''}${s}s`;
    }, 1000);
  }

  function hideStageBanner() {
    const banner = document.getElementById('stage-banner');
    if (banner) banner.style.display = 'none';
    if (stageBannerTimer) { clearInterval(stageBannerTimer); stageBannerTimer = null; }
    stageBannerStart = null;
  }

  // ── Log SSE ────────────────────────────────────────────────────────────────

  /**
   * @param {{ skipReplay?: boolean }} [opts] skipReplay: true when log body was loaded from pipeline-console.log (avoid duplicating in-memory replay).
   */
  function connectLogSSE(opts = {}) {
    if (logSSE) { logSSE.close(); logSSE = null; }
    _logSSEConnectedAt = Date.now();
    const q = opts.skipReplay ? '?replay=0' : '';
    logSSE = new EventSource('/api/pipeline/logs' + q);
    logSSE.onmessage = (e) => {
      let entry;
      try {
        entry = JSON.parse(e.data);
        if (!entry || typeof entry.text !== 'string') throw new Error('bad entry');
      } catch (_) {
        entry = { text: e.data, stream: 'dashboard' };
      }
      appendLogEntry(entry);
    };
    logSSE.onerror = () => {
      // SSE may not be available; fail silently
    };
  }

  /** Local time + ms for live log prefix (entry.at is ISO from server when present). */
  function formatLogTimestamp(iso) {
    if (!iso || typeof iso !== 'string') return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const t = d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const ms = String(d.getMilliseconds()).padStart(3, '0');
      return `${t}.${ms}`;
    } catch (_) {
      return iso;
    }
  }

  /** One console line from orchestrator (stdout/stderr) or dashboard wrapper. */
  function appendLogEntry(entry) {
    const line = entry?.text != null ? String(entry.text) : '';
    const stream = typeof entry?.stream === 'string' && entry.stream ? entry.stream : 'stdout';
    const at = typeof entry?.at === 'string' && entry.at ? entry.at : '';
    const viewer = document.getElementById('log-viewer');
    if (!viewer) return;
    const div = document.createElement('div');
    const lower = line.toLowerCase();
    let cls = 'log-default';
    if (lower.includes('[stage:') || lower.includes('stage:')) cls = 'log-stage';
    else if (lower.includes('error')) cls = 'log-error';
    else if (lower.includes('warn')) cls = 'log-warn';
    else if (stream === 'stderr') cls = 'log-stderr';
    else if (stream === 'dashboard') cls = 'log-dashboard';
    div.className = 'log-line' + (line === '' ? ' log-line-empty' : '');

    const ts = formatLogTimestamp(at);
    if (ts) {
      const tsSpan = document.createElement('span');
      tsSpan.className = 'log-timestamp';
      tsSpan.textContent = '[' + ts + '] ';
      div.appendChild(tsSpan);
    }
    const msg = document.createElement('span');
    msg.className = 'log-message ' + cls;
    if (line === '') msg.innerHTML = '&nbsp;';
    else msg.textContent = line;
    div.appendChild(msg);

    viewer.appendChild(div);
    viewer.scrollTop = viewer.scrollHeight;
    updateStageProgress(line);

    // Detect when orchestrator is waiting for ENTER — show Continue button
    const needsEnter = lower.includes('press enter') || lower.includes('waiting for continue signal') ||
                       lower.includes('click "▶ continue"') ||
                       lower.includes('[studio: awaiting-input]');
    const pipelineDone = lower.includes('pipeline exited') || lower.includes('[pipeline error');
    if (needsEnter) showContinueButton(true);
    if (pipelineDone) {
      showContinueButton(false);
      setPipelineRunning(false);
      hideStageBanner();
      stopStudioStatusPolling();
      // Refresh overview timeline after a brief delay so pipeline-progress.json is written
      setTimeout(() => { if (currentTab === 'overview') loadOverview(); }, 1500);
    }

    // When auto-capture completes, switch to storyboard tab automatically.
    // Guard: skip replayed SSE history (replay arrives within ~200ms of connection).
    if (lower.includes('auto-captured') && lower.includes('build screenshots')) {
      if (Date.now() - _logSSEConnectedAt > 2000) {
        loadRuns().then(() => {
          if (currentTab === 'pipeline') switchTab('storyboard');
        });
      }
    }
  }

  function showContinueButton(show) {
    const btn   = document.getElementById('pipeline-continue-btn');
    const sbBtn = document.getElementById('sb-continue-btn');
    if (btn)   btn.style.display   = show ? 'inline-flex' : 'none';
    if (sbBtn) sbBtn.style.display = show ? 'inline-flex' : 'none';
  }

  async function updateStageDropdown() {
    const sel = document.getElementById('stage-select');
    if (!sel) return;

    let completedStages = [], nextStage = null;

    if (currentRunId) {
      try {
        const run = await api('/api/runs/' + currentRunId);
        completedStages = run.completedStages || [];
        nextStage = run.resumeFromStage || null;
        // Backward compat: if no completedStages but has lastCompletedStage, infer
        if (completedStages.length === 0 && run.lastCompletedStage) {
          const lastIdx = STAGES.indexOf(run.lastCompletedStage);
          if (lastIdx >= 0) completedStages = STAGES.slice(0, lastIdx + 1);
        }
      } catch (_) {
        // Run data unavailable — show all stages as selectable
      }
    }

    const completedSet = new Set(completedStages);
    const nextIdx = nextStage ? STAGES.indexOf(nextStage) : -1;
    const currentVal = sel.value;

    sel.innerHTML = STAGES.map((s, i) => {
      const isDone   = completedSet.has(s);
      const isNext   = s === nextStage;
      // Locked = hasn't run AND isn't the next stage AND there IS a known next stage
      const isLocked = !isDone && !isNext && nextIdx !== -1 && i > nextIdx;
      let label;
      if (isDone)        label = `[✓] ${i + 1}. ${s}`;
      else if (isNext)   label = `[▶] ${i + 1}. ${s} ← next`;
      else if (isLocked) label = `[🔒] ${i + 1}. ${s}`;
      else               label = `${i + 1}. ${s}`;
      return `<option value="${esc(s)}" ${isLocked ? 'disabled' : ''}>${esc(label)}</option>`;
    }).join('');

    // Re-select previous value if still available (not disabled)
    const prevOpt = currentVal && sel.querySelector(`option[value="${CSS.escape(currentVal)}"]:not([disabled])`);
    if (prevOpt) {
      sel.value = currentVal;
    } else if (nextStage) {
      const nOpt = sel.querySelector(`option[value="${CSS.escape(nextStage)}"]:not([disabled])`);
      if (nOpt) sel.value = nextStage;
    }
  }

  function setPipelineRunning(running) {
    const runBtn      = document.getElementById('run-btn');
    const runFromBtn  = document.getElementById('run-from-btn');
    const refineBtn   = document.getElementById('run-refinement-pipeline-btn');
    const resyncBtn   = document.getElementById('resync-audio-btn');
    const studioBtn   = document.getElementById('open-studio-btn');
    const killBtn     = document.getElementById('kill-btn');
    if (studioBtn) studioBtn.disabled = running;
    const statusBadge = document.getElementById('pipeline-status-badge');
    if (runBtn)     runBtn.disabled     = running;
    if (runFromBtn) runFromBtn.disabled = running;
    if (refineBtn)  refineBtn.disabled  = running;
    if (resyncBtn)  resyncBtn.disabled  = running;
    if (killBtn)    killBtn.disabled    = !running;
    if (statusBadge) {
      statusBadge.textContent  = running ? '● Running' : '○ Idle';
      statusBadge.className    = 'pipeline-status-badge ' + (running ? 'running' : 'idle');
    }
    // Start recording status polling while pipeline runs; stop when done
    if (running) startRecordingStatusPolling();
    else stopRecordingStatusPolling();

    // Disable/enable storyboard action buttons
    const sbRecordBtn = document.getElementById('sb-record-btn');
    const sbRebuildBtn = document.getElementById('sb-rebuild-record-btn');
    if (sbRecordBtn)  sbRecordBtn.disabled  = running;
    if (sbRebuildBtn) sbRebuildBtn.disabled = running;
  }

  // Parse "[Stage: build]" patterns to update the stage progress pills
  let _activeStageIndex = -1;
  function updateStageProgress(line) {
    const m = line.match(/\[stage:\s*([a-z-]+)\]/i) || line.match(/stage:\s*([a-z-]+)/i);
    if (!m) return;
    const stageName = m[1].toLowerCase();
    const idx = STAGES.indexOf(stageName);
    if (idx === -1) return;

    // Mark all previous as done, current as active
    STAGES.forEach((s, i) => {
      const pill = document.getElementById('stage-pill-' + s);
      if (!pill) return;
      if (i < idx) { pill.className = 'stage-pill done'; }
      else if (i === idx) { pill.className = 'stage-pill active'; }
      else { pill.className = 'stage-pill'; }
    });

    const label = document.getElementById('stage-label');
    if (label) label.textContent = 'Running: ' + stageName;
    _activeStageIndex = idx;

    // Update stage banner
    updateStageBanner(stageName, idx);

    // Show studio status panel when record+qa stage becomes active
    const isRecordStage = stageName === 'record+qa' || stageName === 'record';
    if (isRecordStage && currentRunId) {
      startStudioStatusPolling();
    } else {
      stopStudioStatusPolling();
    }
  }

  // ── Studio recording status panel ──────────────────────────────────────────

  let _studioStatusInterval = null;

  const STUDIO_PHASE_LABELS = {
    idle:        '—',
    setup:       'Phase 1 of 3: Setup',
    recording:   'Phase 2 of 3: Navigate',
    'file-ready': 'Phase 2 of 3: File Detected',
    saving:      'Phase 3 of 3: Save',
    processing:  'Processing…',
    done:        'Complete ✓',
    error:       'Error',
  };

  function updateStudioStatusPanel(status) {
    const panel   = document.getElementById('studio-status-panel');
    const badge   = document.getElementById('studio-phase-badge');
    const msg     = document.getElementById('studio-status-message');
    const counter = document.getElementById('studio-step-counter');
    if (!panel) return;

    if (!status || status.phase === 'done' || status.phase === 'idle') {
      panel.style.display = 'none';
      // Remove file-ready confirm button if present
      const existing = document.getElementById('studio-file-ready-confirm');
      if (existing) existing.remove();
      return;
    }

    panel.style.display = 'block';
    if (badge)   badge.textContent   = STUDIO_PHASE_LABELS[status.phase] || status.phase;
    if (msg)     msg.textContent     = status.message || '';
    if (counter) {
      const s = status.stepCount || 0, t = status.totalSteps || 0;
      counter.textContent = (t > 0 && s > 0) ? `Steps captured: ${s} / ${t}` : '';
    }

    // Show "Confirm & Continue" button when file auto-detected
    let confirmRow = document.getElementById('studio-file-ready-confirm');
    if (status.phase === 'file-ready') {
      if (!confirmRow) {
        confirmRow = document.createElement('div');
        confirmRow.id = 'studio-file-ready-confirm';
        confirmRow.style.cssText = 'margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap';
        confirmRow.innerHTML = `
          <span id="studio-detected-file" style="font-size:12px;color:rgba(255,255,255,0.65);font-family:monospace;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
          <button id="studio-advance-btn" style="background:#00A67E;color:#fff;border:none;border-radius:5px;padding:6px 16px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">
            ✓ Confirm &amp; Continue
          </button>`;
        panel.appendChild(confirmRow);
        document.getElementById('studio-advance-btn')?.addEventListener('click', async () => {
          const btn = document.getElementById('studio-advance-btn');
          if (btn) { btn.disabled = true; btn.textContent = 'Advancing…'; }
          try {
            await apiPost('/api/studio/advance', {});
            showToast('Pipeline advancing…', 'success');
          } catch (e) {
            showToast('Advance failed: ' + e.message, 'error');
            if (btn) { btn.disabled = false; btn.textContent = '✓ Confirm & Continue'; }
          }
        });
      }
      const fileEl = document.getElementById('studio-detected-file');
      if (fileEl && status.detectedFile) fileEl.textContent = '📁 ' + status.detectedFile.split('/').pop();
    } else {
      if (confirmRow) confirmRow.remove();
    }
  }

  function startStudioStatusPolling() {
    if (_studioStatusInterval) return;
    _studioStatusInterval = setInterval(async () => {
      if (!currentRunId) return;
      try {
        const status = await api('/api/runs/' + currentRunId + '/studio-status');
        updateStudioStatusPanel(status);
        if (status && status.phase === 'done') stopStudioStatusPolling();
      } catch (_) {}
    }, 2000);
  }

  function stopStudioStatusPolling() {
    if (_studioStatusInterval) {
      clearInterval(_studioStatusInterval);
      _studioStatusInterval = null;
    }
    const panel = document.getElementById('studio-status-panel');
    if (panel) panel.style.display = 'none';
  }

  // ── FS Watch SSE ───────────────────────────────────────────────────────────

  function connectFSWatch() {
    if (fsWatchSSE) { fsWatchSSE.close(); fsWatchSSE = null; }
    fsWatchSSE = new EventSource('/api/fs/watch');
    fsWatchSSE.onmessage = (e) => {
      let event;
      try { event = JSON.parse(e.data); } catch (_) { return; }
      const p = event.path || '';

      if (event.type === 'addDir') loadRuns();
      if (p.endsWith('demo-scratch.mp4')) updateStudioStatus();

      // Auto-reload storyboard when build-frames screenshots land for current run
      if (event.type === 'add' && p.includes('build-frames') && p.endsWith('.png')) {
        const runId = p.split('/')[0] || p.split('\\')[0];
        if (runId === currentRunId && currentTab === 'storyboard') {
          // Debounce: reload once after the burst of add events settles
          clearTimeout(fsWatchSSE._storyboardReloadTimer);
          fsWatchSSE._storyboardReloadTimer = setTimeout(() => loadStoryboard(), 1200);
        }
      }
    };
    fsWatchSSE.onerror = () => {
      // FS watch may not be implemented; fail silently
    };
  }

  // ── Studio Status ──────────────────────────────────────────────────────────

  async function updateStudioStatus() {
    const btn = document.getElementById('studio-btn');
    if (!btn) return;
    if (!currentRunId) {
      btn.className = 'disabled';
      btn.textContent = 'Open Remotion Studio';
      btn.onclick = null;
      return;
    }
    try {
      const status = await api('/api/studio/status?runId=' + encodeURIComponent(currentRunId));
      if (!status.mp4Ready) {
        btn.className = 'disabled';
        btn.textContent = 'Open Remotion Studio';
        btn.onclick = null;
      } else if (!status.running) {
        btn.className = 'amber';
        btn.textContent = 'Start Remotion Studio';
        btn.onclick = async () => {
          try {
            await apiPost('/api/studio/start', {});
            showToast('Remotion Studio starting…', 'success');
            setTimeout(updateStudioStatus, 3000);
          } catch (e) {
            showToast('Could not start studio: ' + e.message, 'error');
          }
        };
      } else {
        btn.className = 'green';
        btn.textContent = 'Open Remotion Studio →';
        btn.onclick = () => window.open('http://localhost:3000', '_blank');
      }
    } catch (_) {
      btn.className = 'disabled';
    }
  }

  // ── Recording Status ────────────────────────────────────────────────────────

  let _recordingPollInterval = null;
  let _lastRecordingState = 'idle';

  function startRecordingStatusPolling() {
    if (_recordingPollInterval) return;
    _recordingPollInterval = setInterval(_pollRecordingStatus, 2000);
    _pollRecordingStatus();
  }

  function stopRecordingStatusPolling() {
    clearInterval(_recordingPollInterval);
    _recordingPollInterval = null;
    _renderRecordingBadge('idle');
  }

  async function _pollRecordingStatus() {
    try {
      const runId = currentRunId || '';
      if (!runId) return;
      const status = await api('/api/recording/status?runId=' + encodeURIComponent(runId));
      if (status.state !== _lastRecordingState) {
        _lastRecordingState = status.state;
        _renderRecordingBadge(status.state);
        // Toast on state transitions
        if (status.state === 'recording') showToast('Recording started', 'info');
        if (status.state === 'processing') showToast('Recording complete — post-processing…', 'info');
        if (status.state === 'complete' && _lastRecordingState !== 'idle') {
          showToast('Recording ready', 'success');
          stopRecordingStatusPolling();
        }
      }
    } catch (_) {}
  }

  function _renderRecordingBadge(state) {
    const badge = document.getElementById('recording-status-badge');
    if (!badge) return;
    const MAP = {
      idle:       { label: '',                      cls: '',                      show: false },
      recording:  { label: '● REC',                cls: 'recording-badge--rec',  show: true  },
      processing: { label: '◌ Processing',         cls: 'recording-badge--proc', show: true  },
      complete:   { label: '✓ Recording Ready',    cls: 'recording-badge--done', show: true  },
    };
    const conf = MAP[state] || MAP.idle;
    badge.textContent = conf.label;
    badge.className   = 'recording-badge ' + conf.cls;
    badge.style.display = conf.show ? 'inline-flex' : 'none';

    // Also update storyboard status display if open
    const sbStatus = document.getElementById('sb-recording-status');
    if (sbStatus) {
      sbStatus.textContent = conf.label;
      sbStatus.className = 'sb-rec-status ' + conf.cls;
    }
  }

  // ── Voice Picker ────────────────────────────────────────────────────────────

  let _allVoices = [];
  let _currentPreviewAudio = null;

  async function loadVoicePicker(selectedId) {
    const statusEl = document.getElementById('voice-picker-status');
    const cardsEl  = document.getElementById('voice-cards');
    if (!statusEl || !cardsEl) return;

    try {
      const data = await api('/api/elevenlabs/voices');
      _allVoices = data.voices || [];
      statusEl.textContent = `${_allVoices.length} voices loaded`;
      renderVoiceCards(selectedId);

      // Wire up filter controls
      ['voice-search','vf-gender','vf-accent','vf-age','vf-usecase','vf-descriptive'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', () => renderVoiceCards(document.getElementById('voice-id-hidden')?.value || ''));
      });
    } catch (e) {
      if (e.message.includes('ELEVENLABS_API_KEY not set')) {
        statusEl.textContent = 'ELEVENLABS_API_KEY not configured — enter voice ID manually';
        cardsEl.innerHTML = '';
        // Fall back: show manual text input
        const hidden = document.getElementById('voice-id-hidden');
        if (hidden) {
          const manual = document.createElement('input');
          manual.type = 'text';
          manual.className = 'config-input';
          manual.value = hidden.value;
          manual.placeholder = 'Paste voice ID';
          manual.addEventListener('input', () => {
            hidden.value = manual.value;
            const nameEl = document.getElementById('voice-selected-name');
            if (nameEl) nameEl.textContent = manual.value || '(none)';
          });
          cardsEl.appendChild(manual);
        }
      } else {
        statusEl.textContent = 'Could not load voices: ' + e.message;
      }
    }
  }

  function renderVoiceCards(selectedId) {
    const cardsEl = document.getElementById('voice-cards');
    if (!cardsEl) return;

    const query    = (document.getElementById('voice-search')?.value || '').toLowerCase();
    const gender   = document.getElementById('vf-gender')?.value || '';
    const accent   = document.getElementById('vf-accent')?.value || '';
    const age      = document.getElementById('vf-age')?.value || '';
    const usecase  = document.getElementById('vf-usecase')?.value || '';
    const tone     = document.getElementById('vf-descriptive')?.value || '';

    const filtered = _allVoices.filter(v => {
      const lbl = v.labels || {};
      if (gender  && lbl.gender      !== gender)  return false;
      if (accent  && lbl.accent      !== accent)  return false;
      if (age     && lbl.age         !== age)     return false;
      if (usecase && lbl.use_case    !== usecase) return false;
      if (tone    && lbl.descriptive !== tone)    return false;
      if (query) {
        const haystack = (v.name + ' ' + v.description + ' ' + JSON.stringify(lbl)).toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    const statusEl = document.getElementById('voice-picker-status');
    if (statusEl) statusEl.textContent = `${filtered.length} of ${_allVoices.length} voices`;

    cardsEl.innerHTML = filtered.slice(0, 60).map(v => {
      const lbl = v.labels || {};
      const isSelected = v.voice_id === selectedId;
      const labelChips = [
        lbl.gender      ? `<span class="voice-chip">${esc(lbl.gender)}</span>` : '',
        lbl.accent      ? `<span class="voice-chip">${esc(lbl.accent)}</span>` : '',
        lbl.age         ? `<span class="voice-chip">${esc(lbl.age)}</span>` : '',
        lbl.use_case    ? `<span class="voice-chip voice-chip-blue">${esc(lbl.use_case)}</span>` : '',
        lbl.descriptive ? `<span class="voice-chip voice-chip-teal">${esc(lbl.descriptive)}</span>` : '',
      ].join('');
      return `
        <div class="voice-card ${isSelected ? 'selected' : ''}" data-id="${esc(v.voice_id)}" data-name="${esc(v.name)}" data-preview="${esc(v.preview_url || '')}">
          <div class="voice-card-header">
            <span class="voice-name">${esc(v.name)}</span>
            <span class="voice-category">${esc(v.category)}</span>
          </div>
          <div class="voice-chips">${labelChips}</div>
          ${v.description ? `<div class="voice-desc">${esc(v.description)}</div>` : ''}
          <div class="voice-actions">
            <button type="button" class="btn btn-sm ${isSelected ? 'btn-primary' : 'btn-secondary'} voice-select-btn">
              ${isSelected ? '✓ Selected' : 'Select'}
            </button>
            ${v.preview_url ? `<button type="button" class="btn btn-sm btn-secondary voice-preview-btn">▶ Preview</button>` : ''}
          </div>
        </div>`;
    }).join('');

    if (filtered.length > 60) {
      cardsEl.innerHTML += `<div class="voice-card-more">…and ${filtered.length - 60} more — refine filters to narrow results</div>`;
    }

    // Bind card events
    cardsEl.querySelectorAll('.voice-select-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const card = btn.closest('.voice-card');
        const id   = card.dataset.id;
        const name = card.dataset.name;
        const hidden = document.getElementById('voice-id-hidden');
        if (hidden) hidden.value = id;
        const nameEl = document.getElementById('voice-selected-name');
        if (nameEl) nameEl.textContent = name + ' (' + id + ')';
        renderVoiceCards(id);
      });
    });

    cardsEl.querySelectorAll('.voice-preview-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const card = btn.closest('.voice-card');
        const previewUrl = card.dataset.preview;
        if (!previewUrl) return;
        if (_currentPreviewAudio) {
          _currentPreviewAudio.pause();
          _currentPreviewAudio = null;
          // If same card toggled off, stop
          if (btn.dataset.playing === '1') { btn.dataset.playing = ''; btn.textContent = '▶ Preview'; return; }
        }
        // Reset all preview buttons
        cardsEl.querySelectorAll('.voice-preview-btn').forEach(b => { b.dataset.playing = ''; b.textContent = '▶ Preview'; });
        btn.textContent = '⏹ Stop';
        btn.dataset.playing = '1';
        _currentPreviewAudio = new Audio(previewUrl);
        _currentPreviewAudio.play().catch(() => {});
        _currentPreviewAudio.addEventListener('ended', () => { btn.textContent = '▶ Preview'; btn.dataset.playing = ''; _currentPreviewAudio = null; });
      });
    });
  }

  // ── Value Props Markdown Tab ─────────────────────────────────────────────────

  // ── Storyboard feedback state — REMOVED ─────────────────────────────────────
  // _stepVisualNotes and _globalHtmlNotes used to capture per-step and global
  // visual notes that were exported to inputs/build-feedback.md. Feedback is
  // now handled via Agent Mode in Claude Code, so the storyboard UI no longer
  // collects these. The exportFeedback / loadSavedFeedback function bodies
  // still reference them via these stub bindings so they don't ReferenceError
  // if any external code path calls them.
  const _stepVisualNotes = {};
  let _globalHtmlNotes = '';

  let _vpCurrentFile = null;
  let _vpOriginalContent = '';
  let _vpCurrentFrontmatter = {};  // frontmatter of the file currently displayed
  let _vpPreserveSelection = null; // after fact PATCH, re-open same file after list refresh

  async function loadValueProps() {
    const el = document.getElementById('valueprop-content');
    if (!el) return;
    el.innerHTML = '<div class="empty-state">Loading…</div>';

    try {
      const data = await api('/api/valueprop/list');
      const files = data.files || [];

      if (files.length === 0) {
        el.innerHTML = '<div class="empty-state">No markdown files found in inputs/</div>';
        return;
      }

      const productFiles = files.filter(f => f.group === 'products');
      const rootFiles    = files.filter(f => f.group !== 'products');

      function renderFileItem(f) {
        const loadedBy = Array.isArray(f.loadedBy) ? f.loadedBy : [];
        const loadedBadge = f.group === 'products'
          ? (loadedBy.length > 0
              ? `<span class="vp-loaded-badge vp-loaded-badge--active" title="This file is curated into prompts when the pipeline resolves product family: ${esc(loadedBy.join(', '))}">loaded: ${esc(loadedBy.join(', '))}</span>`
              : `<span class="vp-loaded-badge vp-loaded-badge--idle" title="No product family in product-profiles.js references this slug — the file is present but not consumed by the pipeline">not wired</span>`)
          : '';
        const vpResearchDate = f.frontmatter && (f.frontmatter.last_vp_research || f.frontmatter.last_ai_update);
        const vpResearchBadge = vpResearchDate
          ? `<span class="vp-research-date" title="Last value-prop research run"><code>${esc(String(vpResearchDate).slice(0, 10))}</code></span>`
          : '';
        const staleB = f.staleByAge
          ? `<span class="vp-stale-badge" title="Last curated update older than ${esc(String(f.staleThresholdDays || 90))} days">Stale ${f.staleDays != null ? esc(String(f.staleDays)) + 'd' : ''}</span>`
          : '';
        const displayName = f.name.startsWith('products/') ? f.name.replace('products/', '') : f.name;
        return `
          <div class="vp-file-item" data-name="${esc(f.name)}">
            <span class="vp-file-name">${esc(displayName)}</span>
            ${loadedBadge}
            <span class="vp-file-size">${formatBytes(f.size)}</span>
            <div class="vp-file-badges">${vpResearchBadge}${staleB}</div>
          </div>`;
      }

      const productSection = productFiles.length > 0 ? `
        <div class="file-group-title">inputs/products/ — Per-Product KB</div>
        ${productFiles.map(renderFileItem).join('')}` : '';

      const rootSection = rootFiles.length > 0 ? `
        <div class="file-group-title" style="margin-top:${productFiles.length > 0 ? '12px' : '0'}">inputs/ — Markdown</div>
        ${rootFiles.map(renderFileItem).join('')}` : '';

      el.innerHTML = `
        <div class="vp-layout">
          <div class="vp-sidebar">
            ${productSection}
            ${rootSection}
          </div>
          <div class="vp-editor-area" id="vp-editor-area">
            <div class="empty-state">Select a file to view or edit</div>
          </div>
        </div>`;

      el.querySelectorAll('.vp-file-item').forEach(item => {
        item.addEventListener('click', () => {
          el.querySelectorAll('.vp-file-item').forEach(x => x.classList.remove('active'));
          item.classList.add('active');
          // Retrieve frontmatter from the files list
          const fileInfo = files.find(f => f.name === item.dataset.name);
          _vpCurrentFrontmatter = fileInfo ? (fileInfo.frontmatter || {}) : {};
          loadVpFile(item.dataset.name);
        });
      });

      const want = _vpPendingOpenName || _vpPreserveSelection;
      _vpPendingOpenName = null;
      _vpPreserveSelection = null;
      const pick = want
        ? [...el.querySelectorAll('.vp-file-item')].find(i => i.dataset.name === want)
        : null;
      const firstItem = pick || el.querySelector('.vp-file-item');
      if (firstItem) {
        el.querySelectorAll('.vp-file-item').forEach(x => x.classList.remove('active'));
        firstItem.classList.add('active');
        const fileInfo = files.find(f => f.name === firstItem.dataset.name);
        _vpCurrentFrontmatter = fileInfo ? (fileInfo.frontmatter || {}) : {};
        loadVpFile(firstItem.dataset.name);
      }

    } catch (e) {
      el.innerHTML = `<div class="empty-state error">Failed to load value props: ${esc(e.message)}</div>`;
    }
  }

  async function loadVpFile(name) {
    _vpCurrentFile = name;
    const area = document.getElementById('vp-editor-area');
    if (!area) return;
    area.innerHTML = '<div class="empty-state">Loading…</div>';

    try {
      const data = await api('/api/valueprop/' + encodeURIComponent(name));
      _vpOriginalContent = data.content || '';
      renderVpEditor(_vpOriginalContent, false);
    } catch (e) {
      area.innerHTML = `<div class="empty-state error">Failed to load ${esc(name)}: ${esc(e.message)}</div>`;
    }
  }

  /**
   * Render markdown with "## AI Research Notes" collapsed by default.
   * All content under that heading (until the next ## heading or end of doc)
   * is wrapped in a <details> block.
   */
  function renderVpContent(content) {
    const NOTES_HEADING = '## AI Research Notes';
    const idx = content.indexOf(NOTES_HEADING);
    if (idx === -1) return `<div class="vp-rendered">${renderMarkdown(content)}</div>`;

    const before = content.slice(0, idx);
    const rest = content.slice(idx + NOTES_HEADING.length);

    // Find where the next ## heading is (if any)
    const nextH2 = rest.search(/(?:^|\n)## /);
    const notesBody = nextH2 === -1 ? rest : rest.slice(0, nextH2);
    const afterNotes = nextH2 === -1 ? '' : rest.slice(nextH2);

    return `
      <div class="vp-rendered">
        ${renderMarkdown(before)}
        <details class="vp-ai-notes-toggle">
          <summary class="vp-ai-notes-summary">
            <span class="vp-ai-notes-icon">🤖</span>
            AI Research Notes
            <span class="vp-ai-notes-hint">(click to expand)</span>
          </summary>
          <div class="vp-ai-notes-body">${renderMarkdown(notesBody)}</div>
        </details>
        ${renderMarkdown(afterNotes)}
      </div>`;
  }

  function renderVpEditor(content, editMode) {
    const area = document.getElementById('vp-editor-area');
    if (!area) return;

    const fm = _vpCurrentFrontmatter || {};
    const isProductFile = (_vpCurrentFile || '').startsWith('products/');
    const vpResearchDate = fm.last_vp_research || null;
    const vpFreshnessBadge = vpResearchDate
      ? (() => {
          try {
            const age = Math.floor((Date.now() - new Date(String(vpResearchDate)).getTime()) / 86400000);
            const fresh = Number.isFinite(age) && age >= 0 && age <= 30;
            const colorBg = fresh ? 'rgba(0,166,126,0.15)' : 'rgba(248,113,113,0.18)';
            const colorFg = fresh ? '#00A67E' : '#f87171';
            const label = fresh ? `VPs fresh · ${age}d` : `VPs stale · ${age}d`;
            return `<span class="vp-meta-item" style="background:${colorBg};color:${colorFg};padding:2px 8px;border-radius:999px;font-weight:600;font-size:11px">${label}</span>`;
          } catch (_) { return ''; }
        })()
      : '';

    const metaBar = isProductFile ? `
      <div class="vp-meta-bar">
        <span class="vp-meta-item">last_vp_research: <strong>${esc(vpResearchDate || '—')}</strong></span>
        <span class="vp-meta-sep">·</span>
        ${vpFreshnessBadge}
        <span class="vp-meta-sep">·</span>
        <span class="vp-meta-item">Edit and Save. Research will refresh VPs automatically when <code>last_vp_research</code> is older than 30 days.</span>
      </div>` : '';

    const previewBody = renderVpContent(content);
    const splitWrap = editMode
      ? `<div id="vp-content-area"><textarea id="vp-textarea" class="vp-textarea">${esc(content)}</textarea></div>`
      : `<div id="vp-content-area">${previewBody}</div>`;

    area.innerHTML = `
      <div class="vp-toolbar">
        <span class="vp-filename">${esc(_vpCurrentFile || '')}</span>
        <div class="vp-toolbar-actions">
          <button class="btn btn-sm ${!editMode ? 'btn-primary' : 'btn-secondary'}" id="vp-preview-btn">Preview</button>
          <button class="btn btn-sm ${editMode ? 'btn-primary' : 'btn-secondary'}" id="vp-edit-btn">Edit</button>
          ${editMode ? `
            <button class="btn btn-sm btn-primary" id="vp-save-btn">Save</button>
            <button class="btn btn-sm btn-secondary" id="vp-discard-btn">Discard</button>` : ''}
        </div>
      </div>
      ${metaBar}
      ${splitWrap}`;

    document.getElementById('vp-preview-btn')?.addEventListener('click', () => {
      const current = editMode ? (document.getElementById('vp-textarea')?.value || content) : content;
      _vpOriginalContent = editMode ? _vpOriginalContent : current;
      renderVpEditor(current, false);
    });
    document.getElementById('vp-edit-btn')?.addEventListener('click', () => {
      const current = editMode ? (document.getElementById('vp-textarea')?.value || content) : _vpOriginalContent;
      renderVpEditor(current, true);
    });
    document.getElementById('vp-save-btn')?.addEventListener('click', saveVpFile);
    document.getElementById('vp-discard-btn')?.addEventListener('click', () => {
      renderVpEditor(_vpOriginalContent, false);
    });
  }

  async function saveVpFile() {
    const ta = document.getElementById('vp-textarea');
    if (!ta || !_vpCurrentFile) return;
    const content = ta.value;
    try {
      await fetch('/api/valueprop/' + encodeURIComponent(_vpCurrentFile), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
      _vpOriginalContent = content;
      showToast('Saved ' + _vpCurrentFile, 'success');
      renderVpEditor(content, false);
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
    }
  }

  // ── Lightweight Markdown Renderer ────────────────────────────────────────────

  function renderMarkdown(md) {
    if (!md) return '';
    let html = md;

    // Escape HTML first (we'll selectively allow our own tags)
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Fenced code blocks  ```lang\n...\n```
    html = html.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) =>
      `<pre class="md-code-block"><code>${code}</code></pre>`);

    // Tables: lines of |...|
    html = html.replace(/((?:^[ \t]*\|[^\n]*\n)+)/gm, (block) => {
      const rows = block.trim().split('\n');
      let out = '<table class="md-table">';
      rows.forEach((row, i) => {
        if (/^[\s|:-]+$/.test(row)) return; // separator row
        const cells = row.split('|').slice(1, -1).map(c => c.trim());
        const tag = i === 0 ? 'th' : 'td';
        out += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      });
      return out + '</table>';
    });

    // Headings
    html = html.replace(/^#### (.+)$/gm, '<h4 class="md-h4">$1</h4>');
    html = html.replace(/^### (.+)$/gm,  '<h3 class="md-h3">$1</h3>');
    html = html.replace(/^## (.+)$/gm,   '<h2 class="md-h2">$1</h2>');
    html = html.replace(/^# (.+)$/gm,    '<h1 class="md-h1">$1</h1>');

    // Horizontal rule
    html = html.replace(/^---+$/gm, '<hr class="md-hr">');

    // Blockquote
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote class="md-blockquote">$1</blockquote>');

    // Unordered lists (consolidate consecutive items)
    html = html.replace(/((?:^[ \t]*[-*] .+\n?)+)/gm, (block) => {
      const items = block.trim().split('\n').map(l => l.replace(/^[ \t]*[-*] /, '').trim());
      return '<ul class="md-ul">' + items.map(i => `<li>${i}</li>`).join('') + '</ul>';
    });

    // Bold + italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g,          '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener" class="md-link">$1</a>');

    // Paragraphs: double newlines → <p>
    html = html.replace(/\n{2,}/g, '</p><p class="md-p">');
    html = '<p class="md-p">' + html + '</p>';

    // Single newlines within paragraphs → <br>
    html = html.replace(/(?<!<\/p>|<\/h[1-4]>|<\/ul>|<\/table>|<\/pre>|<\/blockquote>|<hr[^>]*>)\n(?!<p |<h[1-4]|<ul|<table|<pre|<blockquote|<hr)/g, '<br>');

    // Clean up empty paragraphs
    html = html.replace(/<p class="md-p"><\/p>/g, '');
    html = html.replace(/<p class="md-p">\s*(<(?:h[1-4]|ul|table|pre|hr|blockquote)[^>]*>)/g, '$1');
    html = html.replace(/(<\/(?:h[1-4]|ul|table|pre|hr|blockquote)>)\s*<\/p>/g, '$1');

    return html;
  }

  // ── HTML escape helper ─────────────────────────────────────────────────────

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Demo Apps ────────────────────────────────────────────────────────────────

  async function loadDemoApps(forceRefresh = false) {
    const el = document.getElementById('demo-apps-content');
    if (!el) return;
    if (!forceRefresh && el.querySelector('#demo-apps-list')) return;
    el.innerHTML = '<div class="empty-state">Loading…</div>';
    try {
      const [local, remote] = await Promise.all([
        api('/api/demo-apps').catch(() => ({ apps: [] })),
        api('/api/remote-demo-apps').catch(() => ({ apps: [] })),
      ]);
      const localIds = new Set((local.apps || []).map((a) => a.runId));
      const remoteOnly = (remote.apps || []).filter((a) => !localIds.has(a.runId));
      const merged = [...(local.apps || []), ...remoteOnly];
      renderDemoApps(merged);
    } catch (err) {
      el.innerHTML = `<div class="empty-state">Error: ${esc(err.message)}</div>`;
    }
  }

  function ensureDemoCloneModal() {
    let modal = document.getElementById('demo-app-clone-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'demo-app-clone-modal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:5000;align-items:center;justify-content:center';
    modal.innerHTML = `
      <div data-clone-modal-backdrop style="position:absolute;inset:0;background:rgba(0,0,0,.55)"></div>
      <div style="position:relative;width:min(560px,92vw);background:#111827;border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:18px 18px 16px;box-shadow:0 24px 64px rgba(0,0,0,.45)">
        <h3 style="margin:0 0 8px;font-size:16px;color:#fff">Clone Demo App</h3>
        <p style="margin:0 0 14px;font-size:12px;color:rgba(255,255,255,.65)">Optionally rebrand the clone. Leave fields empty to clone as-is.</p>
        <label style="display:block;font-size:12px;color:rgba(255,255,255,.8);margin-bottom:6px">New company name (optional)</label>
        <input data-clone-company type="text" maxlength="120" placeholder="e.g. US Bank" style="width:100%;padding:9px 10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:6px;color:#fff;font-size:13px;outline:none;margin-bottom:12px">
        <label style="display:block;font-size:12px;color:rgba(255,255,255,.8);margin-bottom:6px">Website URL (optional)</label>
        <input data-clone-website type="text" placeholder="e.g. https://www.usbank.com" style="width:100%;padding:9px 10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:6px;color:#fff;font-size:13px;outline:none">
        <p style="margin:10px 0 0;font-size:11px;color:rgba(255,255,255,.45)">If provided, Dashboard will run a one-off brand-clone update (logo/colors + Link client_name).</p>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
          <button data-clone-cancel type="button" style="padding:7px 11px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);border-radius:6px;color:rgba(255,255,255,.8);font-size:12px;cursor:pointer">Cancel</button>
          <button data-clone-asis type="button" style="padding:7px 11px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);border-radius:6px;color:rgba(255,255,255,.9);font-size:12px;cursor:pointer">Clone As-Is</button>
          <button data-clone-rebrand type="button" style="padding:7px 11px;background:#00A67E;border:none;border-radius:6px;color:#fff;font-size:12px;cursor:pointer">Clone + Rebrand</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  }

  function openDemoCloneModal(defaultCompanyName = '') {
    const modal = ensureDemoCloneModal();
    const companyInput = modal.querySelector('[data-clone-company]');
    const websiteInput = modal.querySelector('[data-clone-website]');
    const cancelBtn = modal.querySelector('[data-clone-cancel]');
    const asIsBtn = modal.querySelector('[data-clone-asis]');
    const rebrandBtn = modal.querySelector('[data-clone-rebrand]');
    const backdrop = modal.querySelector('[data-clone-modal-backdrop]');
    if (!companyInput || !websiteInput || !cancelBtn || !asIsBtn || !rebrandBtn || !backdrop) {
      return Promise.resolve(null);
    }

    companyInput.value = defaultCompanyName || '';
    websiteInput.value = '';
    modal.style.display = 'flex';

    return new Promise((resolve) => {
      const close = (result) => {
        modal.style.display = 'none';
        cancelBtn.removeEventListener('click', onCancel);
        asIsBtn.removeEventListener('click', onAsIs);
        rebrandBtn.removeEventListener('click', onRebrand);
        backdrop.removeEventListener('click', onCancel);
        companyInput.removeEventListener('keydown', onKeyDown);
        websiteInput.removeEventListener('keydown', onKeyDown);
        resolve(result);
      };

      const payload = () => ({
        companyName: companyInput.value.trim(),
        website: websiteInput.value.trim(),
      });
      const onCancel = () => close(null);
      const onAsIs = () => close({ mode: 'asis', ...payload() });
      const onRebrand = () => close({ mode: 'rebrand', ...payload() });
      const onKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          onRebrand();
        }
      };

      cancelBtn.addEventListener('click', onCancel);
      asIsBtn.addEventListener('click', onAsIs);
      rebrandBtn.addEventListener('click', onRebrand);
      backdrop.addEventListener('click', onCancel);
      companyInput.addEventListener('keydown', onKeyDown);
      websiteInput.addEventListener('keydown', onKeyDown);
      setTimeout(() => companyInput.focus(), 0);
    });
  }

  // Persistent client-side filter state so search / toggle survive list refreshes.
  const _demoAppsFilter = { search: '', scope: 'all' };
  let _demoAppsLastPayload = [];

  function _qaBadgeForScore(score) {
    if (score == null || !Number.isFinite(Number(score))) return '';
    const n = Math.round(Number(score));
    const band = n >= 90 ? '#00A67E' : n >= 70 ? '#f59e0b' : '#f87171';
    return `<span title="Latest QA score" style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:999px;background:${band}22;color:${band};border:1px solid ${band}44;flex-shrink:0">QA ${n}</span>`;
  }

  function _buildModeBadge(app) {
    const m = app && app.buildMode;
    if (m !== 'app-only' && m !== 'app+slides') return '';
    const label = m === 'app+slides' ? 'App + Slides' : 'App-only';
    const cls = m === 'app+slides' ? '#60a5fa' : 'rgba(255,255,255,0.55)';
    return `<span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:999px;background:${cls}15;color:${cls};border:1px solid ${cls}33;flex-shrink:0">${label}</span>`;
  }

  function _displayNameWithSuffix(app) {
    const base = app.displayName || app.runId;
    if (app.plaidLinkMode === 'embedded') return `${base} (embed)`;
    return base;
  }

  function _matchesSearch(app, needle) {
    if (!needle) return true;
    const hay = [
      app.displayName,
      app.runId,
      app.plaidLinkMode,
      app.script && app.script.product,
      app.script && app.script.company,
      app.script && app.script.persona,
      app.owner && app.owner.login,
      app.owner && app.owner.name,
    ]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
      .join(' ');
    return hay.includes(needle);
  }

  function _currentUserLogin() {
    try {
      return String(window.__currentUserLogin || '').toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function _matchesScope(app, scope) {
    if (scope !== 'mine') return true;
    const me = _currentUserLogin();
    if (!me) return app.source === 'local';
    if (app.source === 'local') return true;
    return app.owner && String(app.owner.login || '').toLowerCase() === me;
  }

  function filterDemoApps(apps) {
    const needle = _demoAppsFilter.search.trim().toLowerCase();
    return apps.filter((app) => _matchesSearch(app, needle) && _matchesScope(app, _demoAppsFilter.scope));
  }

  function renderDemoApps(apps) {
    const el = document.getElementById('demo-apps-content');
    if (!el) return;
    _demoAppsLastPayload = Array.isArray(apps) ? apps : [];

    const wrapperExists = !!document.getElementById('demo-apps-list');
    if (!wrapperExists) {
      el.innerHTML = `
        <div style="padding:24px">
          <h2 style="margin:0 0 6px;font-size:18px">Built Demo Apps</h2>
          <p style="margin:0 0 16px;color:rgba(255,255,255,0.5);font-size:13px">
            Launch an app to preview it with live Plaid Link and the AI edit overlay.
          </p>
          <div id="demo-apps-toolbar" style="display:flex;gap:10px;align-items:center;margin:0 0 14px;flex-wrap:wrap">
            <input id="demo-apps-search" type="search" placeholder="Search demos (name, company, product)…"
                   style="flex:1;min-width:260px;padding:7px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.16);border-radius:6px;color:#fff;font-size:13px">
            <div id="demo-apps-scope" role="tablist" style="display:inline-flex;border:1px solid rgba(255,255,255,0.15);border-radius:6px;overflow:hidden">
              <button data-scope="all"  type="button" class="demo-apps-scope-btn" style="padding:6px 12px;background:rgba(255,255,255,0.08);border:none;color:#fff;font-size:12px;cursor:pointer">All</button>
              <button data-scope="mine" type="button" class="demo-apps-scope-btn" style="padding:6px 12px;background:transparent;border:none;color:rgba(255,255,255,0.65);font-size:12px;cursor:pointer">Mine</button>
            </div>
            <button id="demo-apps-pull-btn" type="button" style="padding:6px 12px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:rgba(255,255,255,0.85);font-size:12px;cursor:pointer">Pull</button>
            <span id="demo-apps-count" style="font-size:11px;color:rgba(255,255,255,0.45)"></span>
          </div>
          <div id="demo-apps-list" style="display:flex;flex-direction:column;gap:10px"></div>
        </div>
      `;
      const searchEl = document.getElementById('demo-apps-search');
      if (searchEl) {
        searchEl.value = _demoAppsFilter.search;
        let t = null;
        searchEl.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(() => {
            _demoAppsFilter.search = searchEl.value || '';
            renderDemoApps(_demoAppsLastPayload);
          }, 150);
        });
      }
      document.querySelectorAll('.demo-apps-scope-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          _demoAppsFilter.scope = btn.dataset.scope || 'all';
          document.querySelectorAll('.demo-apps-scope-btn').forEach((b) => {
            const active = b.dataset.scope === _demoAppsFilter.scope;
            b.style.background = active ? 'rgba(255,255,255,0.08)' : 'transparent';
            b.style.color = active ? '#fff' : 'rgba(255,255,255,0.65)';
          });
          renderDemoApps(_demoAppsLastPayload);
        });
      });
      const pullBtn = document.getElementById('demo-apps-pull-btn');
      if (pullBtn) {
        pullBtn.addEventListener('click', () => {
          if (typeof copyCliCommand === 'function') {
            copyCliCommand('npm run pipe -- pull', 'Pull command copied to clipboard — run it in your terminal.');
          } else {
            showToast && showToast('Run `npm run pipe -- pull` in your terminal.', 'info');
          }
        });
      }
    }

    const filtered = filterDemoApps(apps);
    const countEl = document.getElementById('demo-apps-count');
    if (countEl) {
      countEl.textContent = apps.length === filtered.length
        ? `${apps.length} apps`
        : `${filtered.length} / ${apps.length} apps`;
    }

    const list = document.getElementById('demo-apps-list');
    if (!list) return;
    list.innerHTML = '';

    if (!filtered.length) {
      list.innerHTML = '<div class="empty-state" style="padding:24px 4px;color:rgba(255,255,255,0.5);font-size:13px">No demo apps match the current filter.</div>';
      return;
    }

    filtered.forEach(app => {
      const card = document.createElement('div');
      card.dataset.runId = app.runId;
      card.dataset.displayName = app.displayName || app.runId;
      card.style.cssText = 'background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:14px 16px;display:flex;align-items:center;gap:12px';

      const statusDot = app.running
        ? '<span style="width:8px;height:8px;border-radius:50%;background:#00A67E;flex-shrink:0;display:inline-block;box-shadow:0 0 6px #00A67E"></span>'
        : '<span style="width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,0.2);flex-shrink:0;display:inline-block"></span>';

      const portBadge = app.running && app.port
        ? `<span style="font-size:11px;color:rgba(255,255,255,0.35);margin-left:6px">:${app.port}</span>`
        : '';

      const qaBadge = _qaBadgeForScore(app.qaScore);
      const buildBadge = _buildModeBadge(app);
      const ownerBadge = app.owner && app.owner.login
        ? `<span title="Owner" style="font-size:10px;color:rgba(255,255,255,0.45);padding:2px 6px;background:rgba(255,255,255,0.05);border-radius:999px;border:1px solid rgba(255,255,255,0.1);flex-shrink:0">@${esc(app.owner.login)}</span>`
        : '';
      const promptBtn = app.promptViewerUrl
        ? `<a class="demo-app-prompt-btn" href="${esc(app.promptViewerUrl)}" target="_blank" rel="noopener" style="padding:5px 10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:5px;color:rgba(255,255,255,0.75);font-size:12px;cursor:pointer;text-decoration:none">Prompt</a>`
        : '';
      const publishBtn = app.source === 'remote'
        ? `<span style="font-size:10px;color:rgba(255,255,255,0.45);padding:4px 8px;background:rgba(96,165,250,0.10);border:1px solid rgba(96,165,250,0.3);border-radius:5px;flex-shrink:0">Remote</span>`
        : `<button class="demo-app-publish-btn" data-run="${esc(app.runId)}" type="button" style="padding:5px 10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:5px;color:rgba(255,255,255,0.75);font-size:12px;cursor:pointer">Publish</button>`;

      card.innerHTML = `
        ${statusDot}
        <div style="flex:1;min-width:0">
          <div class="demo-app-name-row" style="display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap">
            <div class="demo-app-display-name" style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(_displayNameWithSuffix(app))}</div>
            ${qaBadge}
            ${buildBadge}
            ${ownerBadge}
            <button class="demo-app-rename-edit-btn" data-run="${esc(app.runId)}" type="button" style="padding:2px 8px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:rgba(255,255,255,0.75);font-size:11px;cursor:pointer;flex-shrink:0">Rename</button>
            <button class="demo-app-clone-btn" data-run="${esc(app.runId)}" type="button" style="padding:2px 8px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:rgba(255,255,255,0.75);font-size:11px;cursor:pointer;flex-shrink:0">Clone</button>
          </div>
          <div class="demo-app-rename-row" style="display:none;align-items:center;gap:6px;margin-top:6px">
            <input class="demo-app-rename-input" type="text" maxlength="120" value="${esc(app.displayName || app.runId)}" style="flex:1;min-width:0;padding:5px 8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.16);border-radius:5px;color:#fff;font-size:12px">
            <button class="demo-app-rename-save-btn" data-run="${esc(app.runId)}" type="button" style="padding:4px 8px;background:#00A67E;border:none;border-radius:5px;color:#fff;font-size:11px;cursor:pointer">Save</button>
            <button class="demo-app-rename-cancel-btn" type="button" style="padding:4px 8px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:5px;color:rgba(255,255,255,0.75);font-size:11px;cursor:pointer">Cancel</button>
          </div>
          ${app.displayName && app.displayName !== app.runId
            ? `<div style="font-size:11px;color:rgba(255,255,255,0.3)">Run ID: ${esc(app.runId)}</div>`
            : ''
          }
          ${app.running && app.url
            ? `<a href="${esc(app.url)}" target="_blank" style="font-size:11px;color:#00A67E;text-decoration:none">${esc(app.url)}</a>`
            : `<span style="font-size:11px;color:rgba(255,255,255,0.3)">Not running</span>`
          }
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          ${promptBtn}
          ${publishBtn}
          <a class="btn btn-sm btn-secondary"
             href="/api/runs/${encodeURIComponent(app.runId)}/download-app-package"
             style="text-decoration:none;padding:5px 10px">
             Download
          </a>
          ${app.running
            ? `<button class="demo-app-open-btn" data-url="${esc(app.url)}" style="padding:5px 12px;background:#00A67E;border:none;border-radius:5px;color:#fff;font-size:12px;cursor:pointer">Open ↗</button>
               <button class="demo-app-stop-btn" data-run="${esc(app.runId)}" style="padding:5px 12px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:5px;color:rgba(255,255,255,0.6);font-size:12px;cursor:pointer">Stop</button>`
            : `<button class="demo-app-launch-btn" data-run="${esc(app.runId)}" style="padding:5px 14px;background:#00A67E;border:none;border-radius:5px;color:#fff;font-size:12px;font-weight:600;cursor:pointer">Launch</button>`
          }
        </div>
      `;
      list.appendChild(card);
    });

    // Launch buttons
    list.querySelectorAll('.demo-app-launch-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const runId = btn.dataset.run;
        setBtnLoading(btn, true, 'Starting…');
        try {
          const result = await apiPost('/api/demo-apps/launch', { runId });
          window.open(result.url, '_blank');
          showToast(`App launched at ${result.url}`, 'success');
          setTimeout(() => loadDemoApps(true), 400);
        } catch (err) {
          showToast(`Failed to launch: ${err.message}`, 'error');
          setBtnLoading(btn, false, 'Launch');
        }
      });
    });

    // Stop buttons
    list.querySelectorAll('.demo-app-stop-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const runId = btn.dataset.run;
        setBtnLoading(btn, true, 'Stopping…');
        try {
          await apiPost(`/api/demo-apps/${runId}/stop`, {});
          showToast('Server stopped', 'success');
          setTimeout(() => loadDemoApps(true), 300);
        } catch (err) {
          showToast(`Failed to stop: ${err.message}`, 'error');
          setBtnLoading(btn, false, 'Stop');
        }
      });
    });

    // Open buttons
    list.querySelectorAll('.demo-app-open-btn').forEach(btn => {
      btn.addEventListener('click', () => window.open(btn.dataset.url, '_blank'));
    });

    // Inline rename controls
    list.querySelectorAll('.demo-app-rename-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('[data-run-id]');
        if (!card) return;
        const row = card.querySelector('.demo-app-rename-row');
        const input = card.querySelector('.demo-app-rename-input');
        if (!row || !input) return;
        row.style.display = 'flex';
        btn.style.display = 'none';
        input.focus();
        input.select();
      });
    });
    list.querySelectorAll('.demo-app-rename-cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('[data-run-id]');
        if (!card) return;
        const row = card.querySelector('.demo-app-rename-row');
        const editBtn = card.querySelector('.demo-app-rename-edit-btn');
        const input = card.querySelector('.demo-app-rename-input');
        const label = card.querySelector('.demo-app-display-name');
        if (input && label) input.value = label.textContent || card.dataset.runId || '';
        if (row) row.style.display = 'none';
        if (editBtn) editBtn.style.display = '';
      });
    });
    list.querySelectorAll('.demo-app-rename-save-btn').forEach(btn => {
      const runId = btn.dataset.run;
      const save = async () => {
        const card = btn.closest('[data-run-id]');
        if (!card) return;
        const row = card.querySelector('.demo-app-rename-row');
        const editBtn = card.querySelector('.demo-app-rename-edit-btn');
        const input = card.querySelector('.demo-app-rename-input');
        if (!input || !runId) return;
        const nextName = input.value.trim();
        setBtnLoading(btn, true, 'Saving…');
        try {
          const result = await apiPost(`/api/demo-apps/${encodeURIComponent(runId)}/rename`, { displayName: nextName });
          const displayName = result.displayName || runId;
          const labelEl = card.querySelector('.demo-app-display-name');
          if (labelEl) labelEl.textContent = displayName;
          if (row) row.style.display = 'none';
          if (editBtn) editBtn.style.display = '';
          if (currentRunId === runId) {
            const runLabel = document.getElementById('build-selector-label');
            if (runLabel) runLabel.textContent = displayName;
          }
          showToast('Demo app renamed', 'success');
          refreshBuildPanel();
          setTimeout(() => loadDemoApps(true), 150);
        } catch (err) {
          showToast(`Rename failed: ${err.message}`, 'error');
          setBtnLoading(btn, false, 'Save');
        }
      };
      btn.addEventListener('click', save);
      const card = btn.closest('[data-run-id]');
      const input = card ? card.querySelector('.demo-app-rename-input') : null;
      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') {
            const cancelBtn = card.querySelector('.demo-app-rename-cancel-btn');
            if (cancelBtn) cancelBtn.click();
          }
        });
      }
    });

    // Publish controls
    list.querySelectorAll('.demo-app-publish-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const runId = btn.dataset.run;
        if (!runId) return;
        setBtnLoading(btn, true, 'Publishing…');
        try {
          const result = await apiPost(`/api/demo-apps/${encodeURIComponent(runId)}/publish`, {});
          if (result && result.ok) {
            showToast(`Published ${runId}`, 'success');
            setTimeout(() => loadDemoApps(true), 200);
          } else {
            showToast(`Publish returned no result`, 'error');
            setBtnLoading(btn, false, 'Publish');
          }
        } catch (err) {
          showToast(`Publish failed: ${err.message}`, 'error');
          setBtnLoading(btn, false, 'Publish');
        }
      });
    });

    // Clone controls
    list.querySelectorAll('.demo-app-clone-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const runId = btn.dataset.run;
        const card = btn.closest('[data-run-id]');
        const currentName = card
          ? (card.querySelector('.demo-app-display-name')?.textContent || runId || '')
          : (runId || '');
        if (!runId) return;

        const modalResult = await openDemoCloneModal(currentName);
        if (!modalResult) return;

        const payload = {};
        if (modalResult.mode === 'rebrand') {
          if (modalResult.companyName) payload.companyName = modalResult.companyName;
          if (modalResult.website) payload.website = modalResult.website;
        }
        setBtnLoading(btn, true, 'Cloning…');
        try {
          const result = await apiPost(`/api/demo-apps/${encodeURIComponent(runId)}/clone`, payload);
          showToast(`Cloned to ${result.displayName || result.runId}`, 'success');
          setTimeout(() => loadDemoApps(true), 120);
        } catch (err) {
          showToast(`Clone failed: ${err.message}`, 'error');
          setBtnLoading(btn, false);
        }
      });
    });
  }

  // ── Smart Tooltip System ────────────────────────────────────────────────────

  let _tooltipEl = null;

  function initTooltips() {
    _tooltipEl = document.createElement('div');
    _tooltipEl.className = 'smart-tooltip';
    _tooltipEl.style.display = 'none';
    document.body.appendChild(_tooltipEl);

    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-tooltip]');
      if (!target) { _tooltipEl.style.display = 'none'; return; }
      const text = target.dataset.tooltip;
      const depsRaw = target.dataset.tooltipDeps;
      let deps = [];
      try { deps = depsRaw ? JSON.parse(depsRaw) : []; } catch (_) {}

      let html = `<div class="tooltip-title">${esc(target.dataset.tooltipTitle || text)}</div>`;
      if (target.dataset.tooltipDesc) html += `<div class="tooltip-desc">${esc(target.dataset.tooltipDesc)}</div>`;
      if (deps.length > 0) {
        html += '<div class="tooltip-deps">' + deps.map(d =>
          `<div class="dep-row ${d.met ? 'met' : 'unmet'}">${d.met ? '✓' : '✗'} ${esc(d.label)}</div>`
        ).join('') + '</div>';
      }
      _tooltipEl.innerHTML = html;
      _tooltipEl.style.display = 'block';
      _positionTooltip(e);
    });

    document.addEventListener('mousemove', (e) => {
      if (_tooltipEl.style.display === 'none') return;
      _positionTooltip(e);
    });

    document.addEventListener('mouseout', (e) => {
      if (!e.target.closest('[data-tooltip]')) return;
      if (!e.relatedTarget?.closest('[data-tooltip]')) _tooltipEl.style.display = 'none';
    });
  }

  function _positionTooltip(e) {
    const tw = 240, th = _tooltipEl.offsetHeight;
    let x = e.clientX + 12, y = e.clientY + 12;
    if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 8;
    if (y + th > window.innerHeight - 8) y = e.clientY - th - 12;
    _tooltipEl.style.left = x + 'px';
    _tooltipEl.style.top = y + 'px';
  }

  function guardedAction(depsList, action, helpTab) {
    helpTab = helpTab || 'pipeline';
    const unmet = depsList.filter(d => !d.met);
    if (unmet.length === 0) { action(); return; }
    showToast(
      'Cannot proceed: ' + unmet[0].label,
      'warning',
      { action: 'View ' + helpTab, onClick: () => switchTab(helpTab) }
    );
  }

  // ── Lightbox ────────────────────────────────────────────────────────────────

  function initLightbox() {
    const box      = document.getElementById('lightbox');
    const img      = document.getElementById('lightbox-img');
    const caption  = document.getElementById('lightbox-caption');
    const closeBtn = document.getElementById('lightbox-close');
    const prevBtn  = document.getElementById('lightbox-prev');
    const nextBtn  = document.getElementById('lightbox-next');

    let _images = []; // [{src, label}] collected from current storyboard
    let _idx    = 0;

    function open(src, label, images) {
      _images = images || [{ src, label }];
      _idx    = _images.findIndex(i => i.src === src);
      if (_idx === -1) _idx = 0;
      show();
    }

    function show() {
      const item = _images[_idx];
      img.src            = item.src;
      caption.textContent = item.label + (_images.length > 1 ? `  (${_idx + 1} / ${_images.length})` : '');
      prevBtn.style.visibility = _images.length > 1 ? 'visible' : 'hidden';
      nextBtn.style.visibility = _images.length > 1 ? 'visible' : 'hidden';
      box.classList.add('open');
    }

    function close() { box.classList.remove('open'); }

    function navigate(delta) {
      _idx = (_idx + delta + _images.length) % _images.length;
      show();
    }

    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    prevBtn.addEventListener('click',  (e) => { e.stopPropagation(); navigate(-1); });
    nextBtn.addEventListener('click',  (e) => { e.stopPropagation(); navigate(1); });

    // Click backdrop to close
    box.addEventListener('click', (e) => { if (e.target === box) close(); });

    // Keyboard: Escape to close, arrows to navigate
    document.addEventListener('keydown', (e) => {
      if (!box.classList.contains('open')) return;
      if (e.key === 'Escape')      close();
      if (e.key === 'ArrowLeft')   navigate(-1);
      if (e.key === 'ArrowRight')  navigate(1);
    });

    // Delegate click on any .step-thumb img anywhere in the document
    document.addEventListener('click', (e) => {
      const thumbImg = e.target.closest('.step-thumb img');
      if (!thumbImg) return;

      // Collect all visible storyboard images for navigation
      const allThumbs = Array.from(document.querySelectorAll('.step-thumb img'))
        .filter(el => el.src && !el.style.display);
      const images = allThumbs.map(el => {
        const card    = el.closest('.step-card');
        const stepId  = card ? card.dataset.stepId : '';
        const label   = card ? (card.querySelector('.step-label')?.textContent || stepId) : stepId;
        return { src: el.src, label: stepId + (label ? ' — ' + label : '') };
      });

      open(thumbImg.src, images.find(i => i.src === thumbImg.src)?.label || '', images);
    });
  }

})();
