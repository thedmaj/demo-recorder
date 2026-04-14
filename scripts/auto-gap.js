#!/usr/bin/env node
/**
 * auto-gap.js
 *
 * Intelligently synchronises video scene timing to the narration talk track.
 * For every step, the target screen time = narration duration + inter-scene gap.
 *
 *   video > narration + gap  →  CLIP  (speed-up sync-map entry)
 *   video < narration + gap  →  FREEZE (hold last frame until narration finishes)
 *   within ±300ms threshold  →  OK    (no entry needed)
 *
 * Gap classification (ms) — context-aware, not one-size-fits-all:
 *   Plaid Link sub-flow    →  500ms  (fluid, fast transitions)
 *   API insight/response   → 2000ms  (viewer reads JSON panel)
 *   Outcome/reveal         → 2500ms  (linger for impact)
 *   Intro/context          → 1500ms  (set the scene)
 *   Default navigation     → 1000ms  (standard click step)
 *
 * Overrides: if auto-gap-overrides.json exists in the run dir, per-step gapMs
 * values override the classifier. Managed by the dashboard storyboard UI.
 *
 * Reads:
 *   voiceover-manifest.json       (audioDurationMs per clip)
 *   processed-step-timing.json    (video boundaries per step)
 *   demo-script.json              (step type classification)
 *   sync-map.json                 (existing manual entries to preserve)
 *   auto-gap-overrides.json       (optional per-step gap overrides)
 *
 * Writes:
 *   sync-map.json                 (updated with speed/freeze entries)
 *   auto-gap-report.json          (per-step analysis)
 *
 * Usage:
 *   PIPELINE_RUN_DIR=out/demos/… node scripts/auto-gap.js
 *   npm run demo -- --from=auto-gap
 */

'use strict';
require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { processedToCompMs } = require('./sync-map-utils');
const { createTimingContract, writeTimingContract, DEFAULTS: TIMING_DEFAULTS } = require('./timing-contract');

const OUT_DIR          = process.env.PIPELINE_RUN_DIR || path.resolve(__dirname, '../out');
const MANIFEST_FILE    = path.join(OUT_DIR, 'voiceover-manifest.json');
const SCRIPT_FILE      = path.join(OUT_DIR, 'demo-script.json');
const PROC_FILE        = path.join(OUT_DIR, 'processed-step-timing.json');
const RAW_TIMING_FILE  = path.join(OUT_DIR, 'step-timing.json');
const SYNC_MAP_FILE    = path.join(OUT_DIR, 'sync-map.json');
const REPORT_FILE      = path.join(OUT_DIR, 'auto-gap-report.json');
const OVERRIDES_FILE   = path.join(OUT_DIR, 'auto-gap-overrides.json');

// Only generate an entry when timing difference exceeds this amount.
// Prevents noise from sub-300ms variations that are imperceptible.
const MIN_THRESHOLD_MS = 300;

// Hard ceiling on speedup ratio to avoid frantic video.
const MAX_SPEED = 2.5;
const PLAID_LINK_BASE_MAX_MS = parseInt(process.env.PLAID_LINK_BASE_MAX_MS || String(TIMING_DEFAULTS.PLAID_LINK_BASE_MAX_MS), 10);
const PLAID_LINK_OVER_15_BUFFER_MS = parseInt(process.env.PLAID_LINK_OVER_15_BUFFER_MS || String(TIMING_DEFAULTS.PLAID_LINK_OVER_15_BUFFER_MS), 10);
const NARRATION_SYNC_TOLERANCE_MS = parseInt(process.env.NARRATION_SYNC_TOLERANCE_MS || String(TIMING_DEFAULTS.NARRATION_SYNC_TOLERANCE_MS), 10);
const AUTO_GAP_PRESERVE_MANUAL = process.env.AUTO_GAP_PRESERVE_MANUAL === 'true';

// ── Gap classification ────────────────────────────────────────────────────────

function classifyGapMs(stepId, demoStep) {
  const id = (stepId || '').toLowerCase();
  if (/link.?(consent|otp|account|select|success|launch|external)/.test(id)) return 500;
  if (demoStep?.apiResponse?.endpoint) return 2000;
  if (/insight|api[-_]reveal|auth[-_]result|signal[-_]result|identity[-_]match|monitor[-_]result/.test(id)) return 2000;
  if (/outcome|approv|verif(y|ied)|complet|reveal/.test(id)) return 2500;
  if (/^(intro|problem|overview|start|begin|context|setup)/.test(id)) return 1500;
  return 1000;
}

function gapReasonLabel(stepId, demoStep) {
  const id = (stepId || '').toLowerCase();
  if (/link.?(consent|otp|account|select|success|launch|external)/.test(id)) return 'plaid-link-flow';
  if (demoStep?.apiResponse?.endpoint) return 'api-insight';
  if (/insight|api[-_]reveal|auth[-_]result|signal[-_]result|identity[-_]match|monitor[-_]result/.test(id)) return 'api-insight';
  if (/outcome|approv|verif(y|ied)|complet|reveal/.test(id)) return 'outcome-reveal';
  if (/^(intro|problem|overview|start|begin|context|setup)/.test(id)) return 'intro-context';
  return 'default-nav';
}

function isPlaidLinkStep(stepId, demoStep) {
  if (demoStep && demoStep.plaidPhase === 'launch') return true;
  const id = String(stepId || '').toLowerCase();
  return /(^wf-link-launch$)|link.?(consent|otp|account|select|success|launch|external)|plaid/.test(id);
}

function collapseContiguousClips(clips) {
  const out = [];
  for (const clip of (clips || [])) {
    if (!clip || !clip.id) continue;
    const prev = out[out.length - 1];
    if (prev && prev.id === clip.id) {
      prev.startMs = Math.min(prev.startMs, clip.startMs);
      prev.endMs = Math.max(prev.endMs, clip.endMs);
      prev.audioDurationMs = Math.max(prev.audioDurationMs || 0, clip.audioDurationMs || 0);
      continue;
    }
    out.push({ ...clip });
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== auto-gap: intelligent inter-scene timing ===\n');

  if (!fs.existsSync(MANIFEST_FILE)) {
    console.error('[auto-gap] CRITICAL: voiceover-manifest.json not found — run voiceover stage first');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const clips    = manifest.clips || [];
  if (clips.length === 0) {
    console.log('[auto-gap] No clips in manifest — nothing to do.');
    return;
  }

  let demoScriptSteps = [];
  if (fs.existsSync(SCRIPT_FILE)) {
    try { demoScriptSteps = JSON.parse(fs.readFileSync(SCRIPT_FILE, 'utf8')).steps || []; } catch {}
  }

  let processedDurationMs = 0; // total duration of processed video (set below when PROC_FILE is read)

  // Build per-step processed-video timing by:
  //   1. Reading raw step timings from step-timing.json
  //   2. Remapping to processed-video coordinates via keepRanges in processed-step-timing.json
  //   3. Injecting Plaid Link sub-steps from plaidStepWindows (already in processed space)
  // This mirrors the exact same logic used in generate-voiceover.js so both stages
  // operate on consistent processed-video coordinates (not manifest comp-space times).
  let procSteps = [];
  if (fs.existsSync(PROC_FILE)) {
    try {
      const processedTiming = JSON.parse(fs.readFileSync(PROC_FILE, 'utf8'));
      const ranges = processedTiming.keepRanges || [];

      // Map a raw-recording timestamp (ms) to processed-video time (ms)
      function remapRawMs(rawMs) {
        const rawS = rawMs / 1000;
        for (const r of ranges) {
          if (rawS >= r.rawStart && rawS <= r.rawEnd) {
            return Math.round((r.processedStart + (rawS - r.rawStart)) * 1000);
          }
          if (rawS < r.rawStart) return Math.round(r.processedStart * 1000);
        }
        // Past all ranges — return total processed duration
        const last = ranges[ranges.length - 1];
        return last ? Math.round(last.processedEnd * 1000) : rawMs;
      }

      // Remap non-Plaid steps from raw timing file
      if (ranges.length > 0 && fs.existsSync(RAW_TIMING_FILE)) {
        const rawData = JSON.parse(fs.readFileSync(RAW_TIMING_FILE, 'utf8'));
        const rawSteps = rawData.steps || (Array.isArray(rawData) ? rawData : []);
        procSteps = rawSteps.map(s => ({
          id:      s.id,
          startMs: remapRawMs(s.startMs),
          endMs:   remapRawMs(s.endMs),
        }));
      }

      // Inject Plaid Link sub-steps (already in processed-video space).
      // Use Set-based dedup: if step-timing.json already has an entry with this stepId,
      // replace the first occurrence (the short video window) with the plaid window
      // so the correct processed times are used. Don't add duplicates.
      const plaidWindows = processedTiming.plaidStepWindows || [];
      for (const w of plaidWindows) {
        const existingIdx = procSteps.findIndex(s => s.id === w.stepId);
        if (existingIdx === -1) {
          procSteps.push({ id: w.stepId, startMs: w.startMs, endMs: w.endMs });
        } else {
          // Replace with authoritative plaid window
          procSteps[existingIdx] = { id: w.stepId, startMs: w.startMs, endMs: w.endMs };
        }
      }
      procSteps.sort((a, b) => a.startMs - b.startMs);

      // Store total processed duration for use as fallback for steps with no video
      processedDurationMs = processedTiming.totalProcessedMs || 0;

      if (procSteps.length > 0) {
        console.log(`[auto-gap] Loaded ${procSteps.length} step timings in processed-video coordinates (total: ${(processedDurationMs/1000).toFixed(1)}s).\n`);
      }
    } catch (e) {
      console.warn(`[auto-gap] Warning: could not load processed step timing: ${e.message}`);
    }
  }

  // Per-step gap overrides from the dashboard storyboard UI
  let overrides = {};
  if (fs.existsSync(OVERRIDES_FILE)) {
    try {
      overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
      const keys = Object.keys(overrides);
      if (keys.length > 0) console.log(`[auto-gap] Loaded ${keys.length} gap override(s) from auto-gap-overrides.json\n`);
    } catch {}
  }

  // Preserve manual sync-map entries only when explicitly requested.
  // Default behavior is full deterministic rebuild so each comp region is governed
  // by current narration/screen timing and cannot drift between screens.
  let existingSyncMap = { _comment: '', segments: [] };
  if (fs.existsSync(SYNC_MAP_FILE)) {
    try { existingSyncMap = JSON.parse(fs.readFileSync(SYNC_MAP_FILE, 'utf8')); } catch {}
  }
  const manualSegments = AUTO_GAP_PRESERVE_MANUAL
    ? (existingSyncMap.segments || []).filter(s => !s._autoGap)
    : [];
  const removedCount = (existingSyncMap.segments || []).length - manualSegments.length;
  if (removedCount > 0) console.log(`[auto-gap] Cleared ${removedCount} previous auto-gap entry(ies). Recomputing.\n`);

  // Build new sync-map entries SEQUENTIALLY — cumulative comp-time offsets accumulate
  const newSegments = [...manualSegments];
  const reportSteps = [];
  let clippedCount  = 0;
  let frozenCount   = 0;

  const sortedClipsRaw = [...clips].sort((a, b) => a.startMs - b.startMs);
  const sortedClips = collapseContiguousClips(sortedClipsRaw);
  if (sortedClips.length !== sortedClipsRaw.length) {
    console.log(`[auto-gap] Collapsed contiguous duplicate clip windows: ${sortedClipsRaw.length} → ${sortedClips.length}\n`);
  }

  // Cursor map so duplicate stepIds in step-timing.json (e.g. chime-link-entry ×2 for the
  // wf-link-launch block) are matched in order rather than always finding the first.
  const procStepCursors = {};
  // Track the monotonically advancing processed-video position so that overlapping
  // processed-video windows (e.g. Plaid Link sub-steps vs the wf-link-launch block)
  // don't create conflicting sync-map entries. Each step's video starts at/after prevVideoEndMs.
  let prevVideoEndMs = 0;
  // Track the monotonically advancing composition position so that freeze-extended steps
  // don't allow later steps with the same processed-video start to overlap in comp time.
  // When two steps have the same clamped videoStartMs (e.g. link-consent and link-otp both
  // clamped to 60285ms), processedToCompMs returns the same value for both. The compStartMs
  // cursor ensures each step starts at or after the previous step's compEnd.
  let prevCompEndMs = 0;

  for (const clip of sortedClips) {
    const demoStep = demoScriptSteps.find(s => s.id === clip.id) || null;

    // Cursor-based procStep selection (handles duplicate stepIds)
    const matchingProcSteps = procSteps.filter(s => s.id === clip.id);
    const cursorIdx = procStepCursors[clip.id] || 0;
    const procStep  = matchingProcSteps[cursorIdx] || null;
    procStepCursors[clip.id] = cursorIdx + 1;

    // Raw processed-video start/end from step-timing data.
    // Fallback: if step has no timing data, place it at the end of processed video (zero-duration).
    const rawVideoStartMs = procStep ? procStep.startMs : processedDurationMs;
    const rawVideoEndMs   = procStep ? procStep.endMs   : processedDurationMs;

    // Clamp to ensure video windows are non-overlapping and monotonically advancing.
    // When multiple steps claim the same processed-video range (Plaid sub-steps vs
    // the wf-link-launch block), later steps get their video start pushed forward.
    const videoStartMs    = Math.max(rawVideoStartMs, prevVideoEndMs);
    const videoEndMs      = Math.max(rawVideoEndMs, videoStartMs);
    const videoDurationMs = videoEndMs - videoStartMs;
    prevVideoEndMs = Math.max(prevVideoEndMs, videoEndMs);

    const narrationMs = clip.audioDurationMs || 0;

    // Use dashboard override if present, else classify
    const classifiedGapMs = classifyGapMs(clip.id, demoStep);
    const gapMs           = (overrides[clip.id]?.gapMs != null) ? overrides[clip.id].gapMs : classifiedGapMs;
    const isOverridden    = gapMs !== classifiedGapMs;

    let targetMs  = narrationMs + gapMs;
    const plaidLinkStep = isPlaidLinkStep(clip.id, demoStep);
    let plaidLinkPolicy = null;
    if (plaidLinkStep && narrationMs > 0) {
      if (narrationMs <= PLAID_LINK_BASE_MAX_MS) {
        // Hard cap Link timeline at 15s unless narration itself exceeds it.
        targetMs = Math.min(targetMs, PLAID_LINK_BASE_MAX_MS);
        plaidLinkPolicy = '15s-cap';
      } else {
        // If the Link talk track is longer than 15s, visuals must expand to match.
        targetMs = Math.max(targetMs, narrationMs + PLAID_LINK_OVER_15_BUFFER_MS);
        plaidLinkPolicy = 'expanded-to-talktrack';
      }
    }
    const overrunMs = videoDurationMs - targetMs; // positive = video too long; negative = narration too long

    // Current comp position — take the max of the video-derived position and the running comp cursor.
    // The cursor ensures steps with the same processed-video start (e.g. after clamping) don't overlap
    // in composition time: each step starts at or after the previous step's comp end.
    const rawCompStartMs    = processedToCompMs(videoStartMs, newSegments);
    const compStartMs       = Math.max(rawCompStartMs, prevCompEndMs);
    const compEndMsOriginal = compStartMs + (processedToCompMs(videoEndMs, newSegments) - rawCompStartMs);

    let action;
    let speed        = null;
    let freezeDurMs  = 0;
    let compEndMs    = compEndMsOriginal;

    if (narrationMs <= 0) {
      action = 'skip-no-narration';
    } else if (overrunMs > MIN_THRESHOLD_MS) {
      // ── CLIP: video is longer than narration + gap ───────────────────────────
      if (videoDurationMs <= 0) {
        action = 'skip-no-video';
      } else {
        const candidateSpeed = videoDurationMs / targetMs;
        if (candidateSpeed > MAX_SPEED) {
          action    = 'warn-too-fast';
          speed     = MAX_SPEED;
          compEndMs = compStartMs + Math.round(videoDurationMs / MAX_SPEED);
        } else {
          action    = 'clip';
          speed     = candidateSpeed;
          compEndMs = compStartMs + targetMs;
        }
        newSegments.push({
          compStart:  parseFloat((compStartMs / 1000).toFixed(4)),
          compEnd:    parseFloat((compEndMs   / 1000).toFixed(4)),
          videoStart: parseFloat((videoStartMs / 1000).toFixed(4)),
          mode:       'speed',
          speed:      Math.round(speed * 1000) / 1000,
          _step:      clip.id,
          _autoGap:   true,
          _reason:    `auto-gap clip: video ${(videoDurationMs/1000).toFixed(2)}s > narr ${(narrationMs/1000).toFixed(2)}s + gap ${(gapMs/1000).toFixed(2)}s`,
        });
        clippedCount++;
      }

    } else if (overrunMs < -MIN_THRESHOLD_MS && narrationMs > 0) {
      // ── FREEZE: narration is longer than the video — hold last frame ─────────
      // Hard governor: explicitly encode both the play portion and freeze extension
      // so this step is fully governed within its own composition window.
      freezeDurMs = Math.abs(overrunMs); // = targetMs - videoDurationMs
      const playCompStartMs   = compStartMs;
      const playCompEndMs     = compStartMs + videoDurationMs;
      const freezeCompStartMs = playCompEndMs;
      const freezeCompEndMs   = compStartMs + targetMs;
      compEndMs               = freezeCompEndMs;

      if (videoDurationMs > 0) {
        newSegments.push({
          compStart:  parseFloat((playCompStartMs / 1000).toFixed(4)),
          compEnd:    parseFloat((playCompEndMs   / 1000).toFixed(4)),
          videoStart: parseFloat((videoStartMs    / 1000).toFixed(4)),
          mode:       'speed',
          speed:      1,
          _step:      clip.id,
          _autoGap:   true,
          _reason:    'auto-gap governed base-play segment',
        });
      }
      newSegments.push({
        compStart:  parseFloat((freezeCompStartMs / 1000).toFixed(4)),
        compEnd:    parseFloat((freezeCompEndMs   / 1000).toFixed(4)),
        videoStart: parseFloat((videoEndMs        / 1000).toFixed(4)),
        mode:       'freeze',
        _step:      clip.id,
        _autoGap:   true,
        _reason:    `auto-gap freeze: narr ${(narrationMs/1000).toFixed(2)}s + gap ${(gapMs/1000).toFixed(2)}s > video ${(videoDurationMs/1000).toFixed(2)}s`,
      });
      action = 'freeze';
      frozenCount++;

    } else {
      // Within tolerance: still emit a governed segment so timing ownership is explicit.
      action = 'ok';
      const governedEndMs = compStartMs + targetMs;
      if (videoDurationMs <= 0) {
        newSegments.push({
          compStart:  parseFloat((compStartMs   / 1000).toFixed(4)),
          compEnd:    parseFloat((governedEndMs / 1000).toFixed(4)),
          videoStart: parseFloat((videoStartMs  / 1000).toFixed(4)),
          mode:       'freeze',
          _step:      clip.id,
          _autoGap:   true,
          _reason:    'auto-gap governed zero-video window',
        });
      } else {
        const nearOneSpeed = Math.max(0.01, videoDurationMs / Math.max(1, targetMs));
        newSegments.push({
          compStart:  parseFloat((compStartMs   / 1000).toFixed(4)),
          compEnd:    parseFloat((governedEndMs / 1000).toFixed(4)),
          videoStart: parseFloat((videoStartMs  / 1000).toFixed(4)),
          mode:       'speed',
          speed:      Math.round(nearOneSpeed * 1000) / 1000,
          _step:      clip.id,
          _autoGap:   true,
          _reason:    'auto-gap governed near-1x segment',
        });
      }
      compEndMs = governedEndMs;
    }

    // Advance the comp cursor so the next step starts at or after this step's end.
    prevCompEndMs = Math.max(prevCompEndMs, compEndMs);

    reportSteps.push({
      stepId:          clip.id,
      gapMs,
      gapReason:       gapReasonLabel(clip.id, demoStep),
      classifiedGapMs,
      isOverridden,
      narrationMs:     Math.round(narrationMs),
      videoDurationMs: Math.round(videoDurationMs),
      targetMs:        Math.round(targetMs),
      overrunMs:       Math.round(overrunMs),
      freezeDurMs:     Math.round(freezeDurMs),
      action,
      speed:           speed !== null ? Math.round(speed * 100) / 100 : null,
      isPlaidLink:     plaidLinkStep,
      plaidLinkPolicy,
      compStartMs:     Math.round(compStartMs),
      compEndMs:       Math.round(compEndMs),
    });

    const icon       = action === 'clip' ? '✂' : action === 'warn-too-fast' ? '⚠' : action === 'freeze' ? '⏸' : action === 'ok' ? '✓' : '~';
    const detailStr  = action === 'clip'  ? ` → ×${speed.toFixed(2)} speed`
                     : action === 'warn-too-fast' ? ` → ×${MAX_SPEED} (capped)`
                     : action === 'freeze' ? ` → freeze +${(freezeDurMs/1000).toFixed(2)}s`
                     : '';
    const overStr    = overrunMs > 0 ? ` [video+${(overrunMs/1000).toFixed(2)}s]` : overrunMs < -300 ? ` [narr+${(Math.abs(overrunMs)/1000).toFixed(2)}s]` : '';
    const ovrdStr    = isOverridden ? ` (override)` : '';
    console.log(
      `  ${icon} ${String(clip.id).padEnd(35)} narr=${(narrationMs/1000).toFixed(2)}s ` +
      `gap=${(gapMs/1000).toFixed(1)}s(${gapReasonLabel(clip.id, demoStep)}${ovrdStr})` +
      ` vid=${(videoDurationMs/1000).toFixed(2)}s${overStr}${detailStr}`
    );
  }

  const totalSavingsMs = reportSteps.reduce((a, s) => a + (s.action==='clip'||s.action==='warn-too-fast' ? Math.max(0,s.overrunMs) : 0), 0);
  const totalFreezeMs  = reportSteps.reduce((a, s) => a + s.freezeDurMs, 0);

  // Single sort after the main loop (replaces the O(n²logn) per-push sorts that were
  // previously inside each branch). buildInverseSegments already sorts its own copy,
  // so mid-loop processedToCompMs calls were unaffected; this sort is for downstream
  // consumers that assume newSegments is ordered (e.g. the coverage-fill pass below).
  newSegments.sort((a, b) => a.compStart - b.compStart);

  // Ensure explicit sync governance for the full composition range covered by steps.
  // This avoids "unowned" comp-time islands that can drift audio across screens.
  const coverageStartS = reportSteps.length > 0
    ? Math.min(...reportSteps.map((s) => Number(s.compStartMs || 0))) / 1000
    : 0;
  const coverageEndS = reportSteps.length > 0
    ? Math.max(...reportSteps.map((s) => Number(s.compEndMs || 0))) / 1000
    : 0;
  function segVideoAtCompEnd(seg) {
    if (!seg) return 0;
    const c0 = Number(seg.compStart || 0);
    const c1 = Number(seg.compEnd || c0);
    const v0 = Number(seg.videoStart || 0);
    if (seg.mode === 'speed') {
      const sp = Number(seg.speed || 1);
      return v0 + Math.max(0, c1 - c0) * Math.max(0.01, sp);
    }
    // freeze holds one frame/timepoint
    return v0;
  }
  const sortedForCoverage = [...newSegments].sort((a, b) => Number(a.compStart || 0) - Number(b.compStart || 0));
  const coverageFills = [];
  let cursorCompS = coverageStartS;
  let cursorVideoS = coverageStartS;
  for (const seg of sortedForCoverage) {
    const segStart = Number(seg.compStart || 0);
    const segEnd = Number(seg.compEnd || segStart);
    if (segEnd <= coverageStartS || segStart >= coverageEndS) continue;
    if (segStart > cursorCompS + 0.001) {
      coverageFills.push({
        compStart: parseFloat(cursorCompS.toFixed(4)),
        compEnd: parseFloat(Math.min(segStart, coverageEndS).toFixed(4)),
        videoStart: parseFloat(cursorVideoS.toFixed(4)),
        mode: 'speed',
        speed: 1,
        _autoGap: true,
        _reason: 'auto-gap coverage-fill: explicit governance for uncovered comp range',
      });
    }
    cursorCompS = Math.max(cursorCompS, segEnd);
    cursorVideoS = segVideoAtCompEnd(seg);
    if (cursorCompS >= coverageEndS) break;
  }
  if (cursorCompS < coverageEndS - 0.001) {
    coverageFills.push({
      compStart: parseFloat(cursorCompS.toFixed(4)),
      compEnd: parseFloat(coverageEndS.toFixed(4)),
      videoStart: parseFloat(cursorVideoS.toFixed(4)),
      mode: 'speed',
      speed: 1,
      _autoGap: true,
      _reason: 'auto-gap coverage-fill: explicit governance for uncovered comp tail',
    });
  }
  if (coverageFills.length > 0) {
    newSegments.push(...coverageFills);
    newSegments.sort((a, b) => Number(a.compStart || 0) - Number(b.compStart || 0));
    console.log(`[auto-gap] Added ${coverageFills.length} explicit coverage-fill segment(s).`);
  }

  console.log(
    `\n[auto-gap] ${clippedCount} clipped, ${frozenCount} frozen, ${reportSteps.filter(s=>s.action==='ok').length} ok.` +
    (totalSavingsMs > 0 ? ` Trimmed ${(totalSavingsMs/1000).toFixed(1)}s dead air.` : '') +
    (totalFreezeMs  > 0 ? ` Extended ${(totalFreezeMs/1000).toFixed(1)}s for narration.` : '') + '\n'
  );

  // Write sync-map.json
  const syncMapOut = {
    _comment:
      'Non-_autoGap segments are preserved across re-runs. ' +
      'Auto-gap entries are regenerated on every auto-gap stage run — edit auto-gap-overrides.json to adjust gaps. ' +
      `| auto-gap applied ${new Date().toISOString()}`,
    segments: newSegments,
  };
  fs.writeFileSync(SYNC_MAP_FILE, JSON.stringify(syncMapOut, null, 2));
  console.log(`[auto-gap] ✓ sync-map.json (${newSegments.length} segments: ${clippedCount} speed, ${frozenCount} freeze)`);

  // Write auto-gap-report.json
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalSteps:           sortedClips.length,
      clippedSteps:         clippedCount,
      frozenSteps:          frozenCount,
      okSteps:              reportSteps.filter(s => s.action === 'ok').length,
      skippedSteps:         reportSteps.filter(s => s.action.startsWith('skip')).length,
      warnSteps:            reportSteps.filter(s => s.action === 'warn-too-fast').length,
      overriddenSteps:      reportSteps.filter(s => s.isOverridden).length,
      estimatedClipMs:      Math.round(totalSavingsMs),
      estimatedFreezeMs:    Math.round(totalFreezeMs),
    },
    steps: reportSteps,
  };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`[auto-gap] ✓ auto-gap-report.json`);
  const timingContract = createTimingContract({
    runDir: OUT_DIR,
    source: 'auto-gap',
    generatedAt: report.generatedAt,
    steps: reportSteps,
    syncMapSegments: newSegments,
    policy: {
      PLAID_LINK_BASE_MAX_MS,
      PLAID_LINK_OVER_15_BUFFER_MS,
    },
    toleranceMs: NARRATION_SYNC_TOLERANCE_MS,
  });
  const contractPath = writeTimingContract(OUT_DIR, timingContract);
  console.log(`[auto-gap] ✓ ${path.basename(contractPath)}`);
  console.log('[auto-gap] Done. resync-audio will update audio positions next.');
}

module.exports = { main, classifyGapMs, gapReasonLabel };

if (require.main === module) {
  main().catch(err => { console.error('[auto-gap] Fatal:', err.message); process.exit(1); });
}
