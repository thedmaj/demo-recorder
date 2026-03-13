(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let currentRunId = null;
  let currentTab = 'overview';
  let studioStatusInterval = null;
  let logSSE = null;
  let fsWatchSSE = null;
  let _logSSEConnectedAt = 0; // timestamp of last SSE connect — used to skip replayed history

  // Original narration values keyed by stepId (for Revert)
  let originalNarrations = {};

  // Stage list for progress bar
  const STAGES = [
    'research', 'ingest', 'brand-extract', 'script', 'script-critique',
    /* 'plaid-link-capture', */ 'build', 'record', 'qa', 'figma-review', 'post-process',
    'voiceover', 'resync-audio', 'audio-qa', 'render', 'ppt', 'touchup'
  ];

  // ── Utilities ──────────────────────────────────────────────────────────────

  /** Toast queue — multiple toasts display sequentially without overlapping */
  const _toastQueue = [];
  let _toastActive = false;

  function showToast(msg, type = 'success', duration = 3500) {
    _toastQueue.push({ msg, type, duration });
    if (!_toastActive) _processToastQueue();
  }

  function _processToastQueue() {
    if (_toastQueue.length === 0) { _toastActive = false; return; }
    _toastActive = true;
    const { msg, type, duration } = _toastQueue.shift();
    const toast = document.getElementById('toast');
    if (!toast) { _toastActive = false; return; }

    toast.innerHTML = `<span class="toast-msg">${esc(msg)}</span><div class="toast-progress-bar"></div>`;
    toast.className = 'toast-visible toast-' + type;

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
    // Sidebar tab clicks
    document.querySelectorAll('.nav-item[data-tab]').forEach(el => {
      el.addEventListener('click', () => switchTab(el.dataset.tab));
    });

    // Run selector change
    document.getElementById('run-selector').addEventListener('change', (e) => {
      currentRunId = e.target.value || null;
      if (currentRunId) loadCurrentRun();
    });

    // Load runs first, then side-effects
    await loadRuns();

    // Always load config and pipeline (not run-dependent)
    loadConfig();
    loadPipeline();
    loadValueProps();

    // FS watch and log SSE
    connectFSWatch();
    connectLogSSE();

    // Studio status polling
    updateStudioStatus();
    studioStatusInterval = setInterval(updateStudioStatus, 5000);

    // Lightbox
    initLightbox();
  });

  // ── Run List ───────────────────────────────────────────────────────────────

  async function loadRuns() {
    try {
      const raw = await api('/api/runs');
      // Server returns { runs: [...] } but handle plain array fallback
      const data = Array.isArray(raw) ? { runs: raw } : raw;
      const sel = document.getElementById('run-selector');
      if (!data.runs || data.runs.length === 0) {
        sel.innerHTML = '<option value="">No runs found</option>';
        return;
      }
      sel.innerHTML = data.runs
        .map(r => `<option value="${esc(r.runId)}">${esc(r.runId)} (QA: ${r.qaScore != null ? r.qaScore : '–'})</option>`)
        .join('');
      currentRunId = data.runs[0].runId;
      sel.value = currentRunId;
      loadCurrentRun();
    } catch (e) {
      showToast('Failed to load runs: ' + e.message, 'error');
    }
  }

  function loadCurrentRun() {
    loadOverview();
    updateStageDropdown();
    if (currentTab === 'files') loadFiles();
    if (currentTab === 'storyboard') loadStoryboard();
  }

  // ── Tab Switching ──────────────────────────────────────────────────────────

  function switchTab(tabName) {
    currentTab = tabName;
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach(el => {
      el.classList.toggle('active', el.id === 'tab-' + tabName);
    });
    // Lazy-load on first switch
    if (tabName === 'files' && currentRunId) loadFiles();
    if (tabName === 'storyboard' && currentRunId) loadStoryboard();
    if (tabName === 'config') loadConfig();
    if (tabName === 'pipeline') loadPipeline();
    if (tabName === 'valueprop') loadValueProps();
  }

  // ── Overview Tab ───────────────────────────────────────────────────────────

  async function loadOverview() {
    if (!currentRunId) return;
    const el = document.getElementById('overview-content');
    el.innerHTML = '<div class="empty-state">Loading…</div>';

    try {
      const [runData, qaData, audioSyncData] = await Promise.allSettled([
        api('/api/runs/' + currentRunId),
        api('/api/runs/' + currentRunId + '/qa'),
        api('/api/runs/' + currentRunId + '/audio-sync-status'),
      ]);

      const run = runData.status === 'fulfilled' ? runData.value : {};
      const qa = qaData.status === 'fulfilled' ? qaData.value : null;
      const audioSync = audioSyncData.status === 'fulfilled' ? audioSyncData.value : null;

      const artifacts = run.artifacts || {};
      const script = run.script || {};
      const product = script.product || extractProduct(currentRunId);
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
              Audio may be out of sync with the video.
              ${audioSync.resyncedAt ? `<span style="opacity:0.6">Last resynced: ${new Date(audioSync.resyncedAt).toLocaleString()}</span>` : ''}
            </p>
            <button type="button" class="btn btn-secondary btn-sm" id="overview-resync-btn">⟳ Resync Audio Now</button>
            <p class="save-hint">Re-stitches existing TTS clips at composition-space timings. No ElevenLabs API calls.</p>
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

      el.innerHTML = `
        <div class="card">
          <div class="run-title">${esc(currentRunId)}</div>
          <div class="run-meta">${esc(product)} · ${esc(persona)} · ${esc(formatDate(currentRunId))}</div>
        </div>
        ${audioSyncWarnHtml}
        ${resumeHtml}
        <div class="card">
          <div class="card-title">Artifacts</div>
          <div class="artifact-grid">${badgesHtml}</div>
          <div class="card-title" style="margin-top:16px;margin-bottom:8px">Pipeline Stages</div>
          ${checklistHtml}
        </div>
        ${qaHtml}`;

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
      const overviewResyncBtn = document.getElementById('overview-resync-btn');
      if (overviewResyncBtn) {
        overviewResyncBtn.addEventListener('click', async () => {
          overviewResyncBtn.disabled = true;
          overviewResyncBtn.textContent = 'Starting…';
          try {
            await apiPost('/api/pipeline/run', { fromStage: 'resync-audio', resumeRunId: currentRunId });
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
            await apiPost('/api/pipeline/run', {
              fromStage: nextStage,
              resumeRunId: currentRunId,
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
            <div class="card-title">Pipeline Behavior</div>
            ${renderCheckbox('SCRATCH_AUTO_APPROVE', cfg, 'Auto-approve all pipeline stages without human confirmation')}
            ${renderCheckbox('MANUAL_RECORD', cfg, 'Use manual Playwright recording instead of automated')}
            ${renderCheckbox('FIGMA_REVIEW', cfg, 'Enable Figma design review stage')}
            ${renderNumberField('MAX_REFINEMENT_ITERATIONS', cfg, 'Max QA refinement loops (1–5)', 1, 5)}
          </div>

          <div class="card">
            <div class="card-title">Recording Quality</div>
            ${renderSelect('RECORDING_FPS', cfg, 'Frames per second for screen recording', [
              { value: '30', label: '30 fps' },
              { value: '60', label: '60 fps' },
            ])}
            ${renderNumberField('QA_PASS_THRESHOLD', cfg, 'Minimum QA score to pass (0–100)', 0, 100)}
          </div>

          <div class="card">
            <div class="card-title">Plaid SDK</div>
            ${renderSelect('PLAID_ENV', cfg, 'Plaid API environment', [
              { value: 'sandbox', label: 'Sandbox' },
              { value: 'production', label: 'Production' },
            ])}
            ${renderCheckbox('PLAID_LINK_LIVE', cfg, 'Use real Plaid Link SDK (vs. simulated UI)')}
            ${renderTextField('PLAID_LINK_CUSTOMIZATION', cfg, 'Plaid Link customization name')}
            ${renderTextField('PLAID_LAYER_TEMPLATE_ID', cfg, 'Plaid Layer template ID')}
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

  function renderCheckbox(key, cfg, tooltip) {
    const checked = cfg[key] === true || cfg[key] === 'true' ? 'checked' : '';
    return `
      <label class="config-field" title="${esc(tooltip)}">
        <input type="checkbox" name="${key}" ${checked}>
        <span class="config-label">${key}</span>
        <span class="config-tooltip">?</span>
        <span class="config-desc">${esc(tooltip)}</span>
      </label>`;
  }

  function renderNumberField(key, cfg, tooltip, min, max) {
    const val = cfg[key] != null ? cfg[key] : '';
    return `
      <div class="config-field" title="${esc(tooltip)}">
        <label class="config-label">${key}</label>
        <input type="number" name="${key}" value="${esc(String(val))}" min="${min}" max="${max}" class="config-input">
        <span class="config-desc">${esc(tooltip)}</span>
      </div>`;
  }

  function renderTextField(key, cfg, tooltip) {
    const val = cfg[key] != null ? cfg[key] : '';
    return `
      <div class="config-field" title="${esc(tooltip)}">
        <label class="config-label">${key}</label>
        <input type="text" name="${key}" value="${esc(String(val))}" class="config-input">
        <span class="config-desc">${esc(tooltip)}</span>
      </div>`;
  }

  function renderSelect(key, cfg, tooltip, options) {
    const val = cfg[key] != null ? cfg[key] : '';
    const opts = options.map(o =>
      `<option value="${esc(o.value)}" ${val === o.value ? 'selected' : ''}>${esc(o.label)}</option>`
    ).join('');
    return `
      <div class="config-field" title="${esc(tooltip)}">
        <label class="config-label">${key}</label>
        <select name="${key}" class="config-input">${opts}</select>
        <span class="config-desc">${esc(tooltip)}</span>
      </div>`;
  }

  async function saveConfig() {
    const form = document.getElementById('config-form');
    if (!form) return;
    const data = {};
    form.querySelectorAll('input, select').forEach(el => {
      if (el.type === 'checkbox') data[el.name] = el.checked;
      else if (el.name) data[el.name] = el.value;
    });
    try {
      await apiPost('/api/config', data);
      showToast('Saved — restart pipeline to apply', 'success');
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
    }
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
    const el = document.getElementById('files-content');
    el.innerHTML = '<div class="empty-state">Loading files…</div>';

    try {
      const data = await api('/api/runs/' + currentRunId);
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
          <div class="files-list">${listHtml || '<div class="empty-state">No files found</div>'}</div>
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

  async function loadStoryboard() {
    if (!currentRunId) return;
    const el = document.getElementById('storyboard-content');
    el.innerHTML = '<div class="empty-state">Loading storyboard…</div>';
    originalNarrations = {};
    _stepVisualNotes = {};

    try {
      const [scriptData, qaData, framesData, timingData] = await Promise.allSettled([
        api('/api/runs/' + currentRunId + '/script'),
        api('/api/runs/' + currentRunId + '/qa'),
        api('/api/runs/' + currentRunId + '/frames'),
        api('/api/runs/' + currentRunId + '/timing'),
      ]);

      const script    = scriptData.status  === 'fulfilled' ? scriptData.value  : null;
      const qa        = qaData.status      === 'fulfilled' ? qaData.value      : null;
      const framesVal  = framesData.status === 'fulfilled' ? framesData.value : {};
      // Server returns { files, source } or legacy plain array
      const framesList  = Array.isArray(framesVal) ? framesVal : (framesVal.files || []);
      const framesSource = Array.isArray(framesVal) ? 'qa-frames' : (framesVal.source || 'qa-frames');
      const timingSteps = timingData.status === 'fulfilled' ? (timingData.value.steps || []) : [];

      if (!script || !script.steps) {
        el.innerHTML = '<div class="empty-state">No demo script found for this run.</div>';
        return;
      }

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

      const cardsHtml = script.steps.map(step => {
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
        const frameSourceLabel = midFrameUrl
          ? (framesSource === 'build-frames' ? 'Build preview' : 'QA frame')
          : null;

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

        // Timing bar: show audio vs video duration proportionally
        let timingBarHtml = '';
        if (timing.videoDurationMs && timing.audioDurationMs) {
          const vidS = (timing.videoDurationMs / 1000).toFixed(1);
          const audS = (timing.audioDurationMs  / 1000).toFixed(1);
          const audioPct = Math.min(100, (timing.audioDurationMs / timing.videoDurationMs) * 100).toFixed(1);
          timingBarHtml = `
            <div class="sb-timing-bar" title="Audio: ${audS}s / Video: ${vidS}s">
              <div class="sb-timing-audio" style="width:${audioPct}%"></div>
              <div class="sb-timing-labels">
                <span>🔊 ${audS}s</span><span>🎬 ${vidS}s</span>
              </div>
            </div>`;
        }

        const hasCallouts = callouts.length > 0;

        return `
          <div class="step-card ${hasIssues ? 'has-issues' : ''} ${hasCallouts ? 'has-callouts' : ''}" data-step-id="${esc(sid)}">
            <div class="step-thumb">
              ${midFrameUrl
                ? `<img src="${midFrameUrl}" alt="${esc(sid)}" onerror="this.style.display='none'">
                   <span class="frame-source-badge">${esc(frameSourceLabel)}</span>`
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
              </div>
              <ul class="qa-issue-list" data-step-id="${esc(sid)}">
                ${issues.map(i => `<li>${esc(i)}</li>`).join('')}
              </ul>
              <div class="step-interaction">
                Interaction: ${esc(step.interaction ? step.interaction.type : '–')} → ${esc(step.interaction ? step.interaction.target : '–')}
              </div>

              <div class="sb-visual-notes-wrap">
                <label class="sb-visual-notes-label">Visual notes for HTML build agent</label>
                <textarea class="visual-notes-area" data-step-id="${esc(sid)}"
                  placeholder="e.g. 'The teal button overlaps the footer', 'Add the bank logo to the confirmation card'"
                >${esc(_stepVisualNotes[sid] || '')}</textarea>
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
      }).join('');

      // ── Feedback header card ──
      const feedbackHeaderHtml = `
        <div class="card sb-feedback-header" id="sb-feedback-header">
          <div class="card-header">
            <div class="card-title">Review Feedback</div>
            <div class="sb-feedback-header-actions">
              <button type="button" class="btn btn-sm btn-secondary" id="sb-load-feedback-btn"
                title="Reload previously exported feedback from inputs/build-feedback.md into the visual notes fields">Load Saved</button>
              <button type="button" class="btn btn-sm btn-primary" id="sb-export-btn"
                title="Write all per-step visual notes and global HTML notes to inputs/build-feedback.md — the build agent reads this file during refinement">Export to build-feedback.md</button>
              <button type="button" class="btn btn-sm btn-secondary" id="sb-run-refinement-btn"
                title="Export feedback then re-run the pipeline from the build stage — the HTML build agent will receive your visual notes and regenerate the app">▶ Run Refinement</button>
            </div>
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label class="config-label">Global HTML notes <span class="config-desc">(applies to entire app — layout, colours, branding, global components)</span></label>
            <textarea id="sb-global-notes" class="narration-area" style="min-height:80px" placeholder="e.g. 'The header logo is too small', 'Use the Wells Fargo red (#D71E28) for the CTA button instead of teal', 'The font on the summary card is too small to read at 1440×900'">${esc(_globalHtmlNotes)}</textarea>
          </div>
          <div id="sb-export-status" style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:8px"></div>
        </div>`;

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
      const actionBarHtml = `
        <div class="sb-action-bar" id="sb-action-bar">
          <div class="sb-action-bar-left">
            <span class="sb-rec-status" id="sb-recording-status"></span>
          </div>
          <div class="sb-action-bar-right">
            <button id="sb-continue-btn" class="btn btn-sm sb-continue-btn" style="display:none"
              title="Pipeline is waiting — click to send ENTER and proceed to recording">▶ Continue</button>
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

      el.innerHTML = actionBarHtml + captureBannerHtml + feedbackHeaderHtml + `<div class="storyboard-grid">${cardsHtml}</div>`;

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

      // Storyboard action bar: Record
      document.getElementById('sb-record-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('sb-record-btn');
        setBtnLoading(btn, true, 'Starting…');
        try {
          await apiPost('/api/pipeline/run', { fromStage: 'record', resumeRunId: currentRunId });
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
          await apiPost('/api/pipeline/run', { fromStage: 'build', resumeRunId: currentRunId });
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

      // Toggle issues
      el.querySelectorAll('.toggle-issues-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const sid = btn.dataset.stepId;
          const list = el.querySelector(`.qa-issue-list[data-step-id="${sid}"]`);
          if (list) list.classList.toggle('open');
        });
      });

      // Visual notes — persist in memory as user types
      el.querySelectorAll('.visual-notes-area').forEach(ta => {
        ta.addEventListener('input', () => {
          _stepVisualNotes[ta.dataset.stepId] = ta.value;
        });
      });

      // Global notes — persist
      const globalNotesEl = document.getElementById('sb-global-notes');
      if (globalNotesEl) {
        globalNotesEl.addEventListener('input', () => { _globalHtmlNotes = globalNotesEl.value; });
      }

      // Export feedback
      document.getElementById('sb-export-btn')?.addEventListener('click', exportFeedback);

      // Load saved feedback
      document.getElementById('sb-load-feedback-btn')?.addEventListener('click', loadSavedFeedback);

      // Run Refinement — spawn pipeline from build stage
      document.getElementById('sb-run-refinement-btn')?.addEventListener('click', async () => {
        // First export any pending feedback
        const exported = await exportFeedback(true);
        if (!exported) return;
        try {
          await apiPost('/api/pipeline/run', { fromStage: 'build', resumeRunId: currentRunId });
          showToast('Refinement pipeline started from build stage', 'success');
          switchTab('pipeline');
        } catch (e) {
          showToast('Failed to start: ' + e.message, 'error');
        }
      });

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
      await apiPost('/api/runs/' + currentRunId + '/script', { stepId, narration: ta.value });
      originalNarrations[stepId] = ta.value;
      showToast('Narration saved for ' + stepId, 'success');
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
    }
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

    el.innerHTML = `
      <div class="card">
        <div class="card-title">Prompt</div>
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
          <label><input type="checkbox" id="no-touchup-check"> Skip touchup</label>
          <button id="run-btn" class="btn btn-primary">Run Pipeline</button>
          <button id="run-from-btn" class="btn btn-secondary">Run from Stage</button>
          <button id="run-refinement-pipeline-btn" class="btn btn-secondary" title="Export storyboard feedback then re-run from build stage">✦ Run Refinement</button>
          <button id="resync-audio-btn" class="btn btn-secondary" title="Re-stitch voiceover audio at composition-space timings (no TTS calls)">⟳ Resync Audio</button>
          <button id="kill-btn" class="btn btn-danger">Kill</button>
        </div>
        <div style="margin-top:12px">
          <button id="pipeline-continue-btn" class="btn btn-primary" style="display:none;background:#fbbf24;border-color:#fbbf24;color:#000">
            ▶ Continue — send ENTER to pipeline
          </button>
        </div>
        <div class="stage-progress" style="margin-top:16px" id="stage-progress-bar">${stagePills}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-top:4px" id="stage-label"></div>
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

    // Run pipeline (full)
    document.getElementById('run-btn').addEventListener('click', async () => {
      const btn = document.getElementById('run-btn');
      const noTouchup = document.getElementById('no-touchup-check').checked;
      setBtnLoading(btn, true, 'Starting…');
      try {
        await apiPost('/api/pipeline/run', { noTouchup });
        showToast('Pipeline started', 'success');
        setPipelineRunning(true);
      } catch (e) {
        showToast('Failed to start: ' + e.message, 'error');
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
        await apiPost('/api/pipeline/run', { fromStage, noTouchup, resumeRunId: currentRunId });
        showToast(`Pipeline started from ${fromStage}`, 'success');
        setPipelineRunning(true);
      } catch (e) {
        showToast('Failed to start: ' + e.message, 'error');
        setBtnLoading(btn, false);
      }
    });

    // Run Refinement (pipeline tab shortcut — exports feedback then runs from build)
    document.getElementById('run-refinement-pipeline-btn')?.addEventListener('click', async () => {
      const noTouchup = document.getElementById('no-touchup-check').checked;
      try {
        await apiPost('/api/pipeline/run', { fromStage: 'build', noTouchup, resumeRunId: currentRunId });
        showToast('Refinement started from build stage', 'success');
        setPipelineRunning(true);
      } catch (e) {
        showToast('Failed: ' + e.message, 'error');
      }
    });

    // Resync Audio — runs resync-audio stage only (re-stitches voiceover.mp3 at comp-space timings)
    document.getElementById('resync-audio-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('resync-audio-btn');
      setBtnLoading(btn, true, 'Resyncing…');
      try {
        await apiPost('/api/pipeline/run', { fromStage: 'resync-audio', resumeRunId: currentRunId });
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

    // Re-connect log SSE so new messages flow into the newly rendered #log-viewer
    connectLogSSE();
  }

  // ── Log SSE ────────────────────────────────────────────────────────────────

  function connectLogSSE() {
    if (logSSE) { logSSE.close(); logSSE = null; }
    _logSSEConnectedAt = Date.now();
    logSSE = new EventSource('/api/pipeline/logs');
    logSSE.onmessage = (e) => appendLog(e.data);
    logSSE.onerror = () => {
      // SSE may not be available; fail silently
    };
  }

  function appendLog(line) {
    const viewer = document.getElementById('log-viewer');
    if (!viewer) return;
    const div = document.createElement('div');
    const lower = line.toLowerCase();
    if (lower.includes('[stage:') || lower.includes('stage:')) div.className = 'log-stage';
    else if (lower.includes('error')) div.className = 'log-error';
    else if (lower.includes('warn')) div.className = 'log-warn';
    else div.className = 'log-default';
    div.textContent = line;
    viewer.appendChild(div);
    viewer.scrollTop = viewer.scrollHeight;
    updateStageProgress(line);

    // Detect when orchestrator is waiting for ENTER — show Continue button
    const needsEnter = lower.includes('press enter') || lower.includes('waiting for continue signal') ||
                       lower.includes('click "▶ continue"');
    const pipelineDone = lower.includes('pipeline exited') || lower.includes('[pipeline error');
    if (needsEnter) showContinueButton(true);
    if (pipelineDone) {
      showContinueButton(false);
      setPipelineRunning(false);
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
    const killBtn     = document.getElementById('kill-btn');
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
    try {
      const status = await api('/api/studio/status');
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
      const status = await api('/api/recording/status' + (runId ? '?runId=' + encodeURIComponent(runId) : ''));
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

  // ── Storyboard feedback state ───────────────────────────────────────────────
  let _stepVisualNotes = {};    // { stepId: string }
  let _globalHtmlNotes = '';

  let _vpCurrentFile = null;
  let _vpOriginalContent = '';
  let _vpCurrentFrontmatter = {};  // frontmatter of the file currently displayed

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
        const badge = f.needsReview
          ? `<span class="vp-needs-review-badge" title="AI has added findings since last human review">Needs Review</span>`
          : '';
        const displayName = f.name.startsWith('products/') ? f.name.replace('products/', '') : f.name;
        return `
          <div class="vp-file-item" data-name="${esc(f.name)}">
            <span class="vp-file-name">${esc(displayName)}</span>
            ${badge}
            <span class="vp-file-size">${formatBytes(f.size)}</span>
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

      // Auto-select first product file (or first file if no products)
      const firstItem = el.querySelector('.vp-file-item');
      if (firstItem) {
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
    const needsReview = fm.needs_review === 'true' ||
      (fm.last_ai_update && fm.last_human_review && fm.last_ai_update > fm.last_human_review);

    const metaBar = isProductFile ? `
      <div class="vp-meta-bar">
        <span class="vp-meta-item">Last reviewed: <strong>${esc(fm.last_human_review || '—')}</strong></span>
        <span class="vp-meta-sep">·</span>
        <span class="vp-meta-item">Last AI update: <strong>${esc((fm.last_ai_update || '—').split('T')[0])}</strong></span>
        ${needsReview && !editMode ? `
          <span class="vp-meta-sep">·</span>
          <button class="btn btn-sm vp-mark-reviewed-btn" id="vp-mark-reviewed-btn">✓ Mark as Reviewed</button>` : ''}
      </div>` : '';

    area.innerHTML = `
      <div class="vp-toolbar">
        <span class="vp-filename">
          ${esc(_vpCurrentFile || '')}
          ${needsReview ? '<span class="vp-needs-review-badge vp-needs-review-badge--inline">Needs Review</span>' : ''}
        </span>
        <div class="vp-toolbar-actions">
          <button class="btn btn-sm ${!editMode ? 'btn-primary' : 'btn-secondary'}" id="vp-preview-btn">Preview</button>
          <button class="btn btn-sm ${editMode ? 'btn-primary' : 'btn-secondary'}" id="vp-edit-btn">Edit</button>
          ${editMode ? `
            <button class="btn btn-sm btn-primary" id="vp-save-btn">Save</button>
            <button class="btn btn-sm btn-secondary" id="vp-discard-btn">Discard</button>` : ''}
        </div>
      </div>
      ${metaBar}
      <div id="vp-content-area">
        ${editMode
          ? `<textarea id="vp-textarea" class="vp-textarea">${esc(content)}</textarea>`
          : renderVpContent(content)}
      </div>`;

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
    document.getElementById('vp-mark-reviewed-btn')?.addEventListener('click', markVpFileReviewed);
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

  async function markVpFileReviewed() {
    if (!_vpCurrentFile) return;
    try {
      const r = await fetch('/api/valueprop/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: _vpCurrentFile }),
      });
      if (!r.ok) throw new Error((await r.json()).error || r.statusText);
      const today = new Date().toISOString().split('T')[0];
      _vpCurrentFrontmatter = { ..._vpCurrentFrontmatter, last_human_review: today, needs_review: 'false' };
      // Update _vpOriginalContent frontmatter in memory so the badge disappears immediately
      _vpOriginalContent = _vpOriginalContent
        .replace(/^last_human_review:.*$/m, `last_human_review: "${today}"`)
        .replace(/^needs_review:.*$/m, 'needs_review: false');
      showToast('Marked as reviewed', 'success');
      // Refresh sidebar badge + re-render editor
      await loadValueProps();
    } catch (e) {
      showToast('Review failed: ' + e.message, 'error');
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
