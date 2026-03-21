#!/usr/bin/env node
/**
 * build-remotion-props.js
 * Standalone script that rebuilds remotion-props.json for a given run directory.
 *
 * Usage:
 *   node scripts/build-remotion-props.js --runDir=/path/to/out/demos/2026-03-14-layer-v4
 *
 * Called by the dashboard /api/runs/:runId/rebuild-props endpoint after sync-map
 * edits so that Remotion Studio hot-reloads with the updated timing — without a
 * full pipeline render.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Resolve paths ─────────────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR   = path.join(PROJECT_ROOT, 'public');

// ── Parse --runDir arg ────────────────────────────────────────────────────────
const runDirArg = process.argv.find(a => a.startsWith('--runDir='));
if (!runDirArg) {
  console.error('[build-remotion-props] Missing --runDir argument');
  process.exit(1);
}
const runDir = runDirArg.split('=').slice(1).join('=');
if (!fs.existsSync(runDir)) {
  console.error(`[build-remotion-props] runDir not found: ${runDir}`);
  process.exit(1);
}

// ── buildRemotionProps ────────────────────────────────────────────────────────
function buildRemotionProps() {
  const props = {
    scratchDurationFrames: 4500,
    scratchSteps:          [],
    enhanceDurationFrames: 4500,
    enhanceOverlayPlan:    { zoomPunches: [], callouts: [], lowerThirds: [], highlights: [] },
    enhanceTotalMs:        150000,
  };

  // Load step-timing.json
  const timingFile          = path.join(runDir, 'step-timing.json');
  const processedTimingFile = path.join(runDir, 'processed-step-timing.json');

  if (fs.existsSync(timingFile)) {
    try {
      const timing = JSON.parse(fs.readFileSync(timingFile, 'utf8'));
      props.scratchDurationFrames = timing.totalFrames || props.scratchDurationFrames;
      props.enhanceDurationFrames = timing.totalFrames || props.enhanceDurationFrames;
      props.enhanceTotalMs        = timing.totalMs     || props.enhanceTotalMs;
      props.scratchSteps          = (timing.steps || []).map(s => ({ ...s, callouts: [] }));
    } catch (e) {
      console.warn('[build-remotion-props] Could not parse step-timing.json:', e.message);
    }
  }

  // Remap to processed-recording coordinates if available
  if (fs.existsSync(processedTimingFile)) {
    try {
      const pt  = JSON.parse(fs.readFileSync(processedTimingFile, 'utf8'));
      const fps = 30;

      function remapMs(rawMs) {
        const rawS = rawMs / 1000;
        for (let i = 0; i < pt.keepRanges.length; i++) {
          const r = pt.keepRanges[i];
          if (rawS >= r.rawStart && rawS <= r.rawEnd) {
            const offset = rawS - r.rawStart;
            return Math.round((r.processedStart + offset) * 1000);
          }
          if (i + 1 < pt.keepRanges.length && rawS > r.rawEnd && rawS < pt.keepRanges[i + 1].rawStart) {
            return Math.round(pt.keepRanges[i + 1].processedStart * 1000);
          }
        }
        if (rawS < (pt.keepRanges[0]?.rawStart ?? 0)) return 0;
        return pt.totalProcessedMs;
      }

      const totalProcessedMs = pt.totalProcessedMs;

      const { processedToCompMs: p2c, loadSyncMap: lsm } = require('./sync-map-utils');
      const syncMapSegs = lsm(runDir);
      props.syncMap = syncMapSegs;

      const compDurationMs = syncMapSegs.length > 0
        ? p2c(totalProcessedMs, syncMapSegs)
        : totalProcessedMs;
      props.scratchDurationFrames = Math.round(compDurationMs / 1000 * fps);
      props.enhanceDurationFrames = props.scratchDurationFrames;
      props.enhanceTotalMs        = compDurationMs;

      props.scratchSteps = props.scratchSteps.map(s => {
        const processedStartMs = remapMs(s.startMs);
        const processedEndMs   = remapMs(s.endMs);
        const startMs          = p2c(processedStartMs, syncMapSegs);
        const endMs            = p2c(processedEndMs,   syncMapSegs);
        const durationMs       = Math.max(0, endMs - startMs);
        const startFrame       = Math.round(startMs  / 1000 * fps);
        const endFrame         = Math.round(endMs    / 1000 * fps);
        return {
          ...s,
          startMs,
          endMs,
          durationMs,
          startFrame,
          endFrame,
          durationFrames: Math.max(0, endFrame - startFrame),
        };
      });

      // Inject Plaid min-duration freeze segments
      const plaidWindowsWithFreeze = (pt.plaidStepWindows || []).filter(w => w.freezeMs > 0);
      if (plaidWindowsWithFreeze.length > 0) {
        for (const w of plaidWindowsWithFreeze) {
          const freezeStartCompMs = p2c(w.endMs, syncMapSegs);
          const freezeEndCompMs   = freezeStartCompMs + w.freezeMs;
          const holdVideoMs       = Math.max(0, w.endMs - 33);
          syncMapSegs.push({
            compStart:         freezeStartCompMs / 1000,
            compEnd:           freezeEndCompMs   / 1000,
            videoStart:        holdVideoMs       / 1000,
            mode:              'freeze',
            _plaidMinDuration: w.stepId,
            _reason:           `Min 2s enforcement: ${w.stepId} was ${w.durationMs}ms, freeze +${w.freezeMs}ms`,
          });
        }
        syncMapSegs.sort((a, b) => a.compStart - b.compStart);
        props.syncMap = syncMapSegs;

        const newCompDurationMs = p2c(totalProcessedMs, syncMapSegs);
        props.scratchDurationFrames = Math.round(newCompDurationMs / 1000 * fps);
        props.enhanceDurationFrames = props.scratchDurationFrames;
        props.enhanceTotalMs        = newCompDurationMs;
      }

      console.log(
        `[build-remotion-props] Remapped to processed recording (${(totalProcessedMs / 1000).toFixed(1)}s)` +
        (syncMapSegs.length > 0 ? ` + sync-map (${syncMapSegs.length} segments)` : '')
      );
    } catch (err) {
      console.warn('[build-remotion-props] Could not remap processed step timing:', err.message);
    }
  }

  // Load overlay-plan.json
  const overlayFile = path.join(runDir, 'overlay-plan.json');
  if (fs.existsSync(overlayFile)) {
    try {
      props.enhanceOverlayPlan = JSON.parse(fs.readFileSync(overlayFile, 'utf8'));
    } catch {}
  }

  // Merge callouts + narration from demo-script.json
  const scriptFile = path.join(runDir, 'demo-script.json');
  if (fs.existsSync(scriptFile)) {
    try {
      const script      = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
      const scriptSteps = script.steps || [];
      props.scratchSteps = props.scratchSteps.map(s => {
        const ss = scriptSteps.find(x => x.id === s.id);
        return { ...s, callouts: ss?.callouts || [], narration: ss?.narration || '', apiResponse: ss?.apiResponse || null };
      });
    } catch {}
  }

  // Auto-overlay: click ripple + zoom from click-coords.json
  const coordsFile = path.join(runDir, 'click-coords.json');
  if (fs.existsSync(coordsFile)) {
    try {
      const coords = JSON.parse(fs.readFileSync(coordsFile, 'utf8'));
      props.scratchSteps = props.scratchSteps.map(s => {
        const coord = coords[s.id];
        if (!coord) return s;
        const update = {
          clickRipple: { xFrac: coord.xFrac, yFrac: coord.yFrac, atFrame: 15 },
        };
        if (s.id !== 'wf-link-launch') {
          update.zoomPunch = {
            scale:    1.08,
            peakFrac: 0.5,
            originX:  `${(coord.xFrac * 100).toFixed(1)}%`,
            originY:  `${(coord.yFrac * 100).toFixed(1)}%`,
          };
        }
        return { ...s, ...update };
      });
    } catch (err) {
      console.warn('[build-remotion-props] Could not load click-coords.json:', err.message);
    }
  }

  // Auto-overlay: lower-thirds + stat-counters
  const STAT_RE = /(\d+\.?\d*)\s*([\+%×xX]|percent|seconds?|ms\b)/gi;
  props.scratchSteps = props.scratchSteps.map(s => {
    const callouts  = [...(s.callouts || [])];
    let   zoomPunch = s.zoomPunch;
    const durationS = (s.durationMs || 0) / 1000;

    if (s.apiResponse?.endpoint) {
      const words = (s.narration || '').trim().split(/\s+/).slice(0, 8).join(' ');
      if (!callouts.some(c => c.type === 'lower-third' && c.title === s.apiResponse.endpoint)) {
        callouts.push({ type: 'lower-third', title: s.apiResponse.endpoint, subtext: words });
      }
      if (!zoomPunch && durationS > 12) {
        zoomPunch = { scale: 1.06, peakFrac: 0.3, originX: 'center', originY: 'center' };
      }
    }

    if (s.id === 'plaid-outcome') {
      const matches = [...(s.narration || '').matchAll(STAT_RE)];
      matches.slice(0, 3).forEach((m, i) => {
        const value  = parseFloat(m[1]);
        const suffix = m[2].startsWith('percent') ? '%' : m[2];
        if (!isNaN(value)) {
          callouts.push({ type: 'stat-counter', value, suffix, label: '', position: `stat-${i + 1}` });
        }
      });
    }

    return { ...s, callouts, zoomPunch: zoomPunch !== undefined ? zoomPunch : s.zoomPunch };
  });

  // Derive cut frames for CrossDissolve
  const processedTimingFile2 = path.join(runDir, 'processed-step-timing.json');
  props.cutFrames = [];
  if (fs.existsSync(processedTimingFile2)) {
    try {
      const pt2  = JSON.parse(fs.readFileSync(processedTimingFile2, 'utf8'));
      const fps2 = 30;
      for (let i = 0; i + 1 < (pt2.keepRanges || []).length; i++) {
        const r           = pt2.keepRanges[i];
        const processedEndS = r.processedStart + (r.rawEnd - r.rawStart);
        props.cutFrames.push(Math.round(processedEndS * fps2));
      }
    } catch {}
  }

  // Check for staged voiceover
  props.hasVoiceover = fs.existsSync(path.join(PUBLIC_DIR, 'voiceover.mp3'));

  return props;
}

// ── Run and write output ──────────────────────────────────────────────────────
try {
  const props    = buildRemotionProps();
  const outFile  = path.join(runDir, 'remotion-props.json');
  fs.writeFileSync(outFile, JSON.stringify(props, null, 2));
  console.log(`[build-remotion-props] Written → ${outFile}`);
  console.log(`[build-remotion-props] scratchDurationFrames=${props.scratchDurationFrames}  steps=${props.scratchSteps.length}  syncMap=${(props.syncMap || []).length}`);
  // Output JSON summary for the API caller to parse
  process.stdout.write('\n__RESULT__' + JSON.stringify({
    scratchDurationFrames: props.scratchDurationFrames,
    stepCount:             props.scratchSteps.length,
    syncMapCount:          (props.syncMap || []).length,
    hasVoiceover:          props.hasVoiceover,
  }) + '\n');
} catch (err) {
  console.error('[build-remotion-props] Fatal:', err.message);
  process.exit(1);
}
