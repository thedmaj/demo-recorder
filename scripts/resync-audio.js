#!/usr/bin/env node
/**
 * resync-audio.js
 *
 * Re-stitches voiceover.mp3 using existing TTS clips with timing corrected
 * for SYNC_MAP_S speed/freeze adjustments stored in sync-map.json.
 *
 * Run this any time the video is edited AFTER voiceover was generated:
 *   - After editing sync-map.json (changing speed or freeze windows)
 *   - After re-running post-process on a new recording
 *   - After any touchup that changes video speed or duration
 *
 * This is fast (<30s): it only runs ffmpeg re-stitching — NO ElevenLabs TTS calls.
 * Existing vo_*.mp3 clips are reused as-is.
 *
 * Usage:
 *   PIPELINE_RUN_DIR=out/demos/2026-03-13-layer-v1 node scripts/resync-audio.js
 *   npm run demo -- --from=resync-audio
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { processedToCompMs, loadSyncMap } = require('./sync-map-utils');
const { refreshTimingContractAfterResync } = require('./refresh-timing-contract-after-resync');
const { loadTimingContract } = require('./timing-contract');

const OUT_DIR          = process.env.PIPELINE_RUN_DIR || path.resolve(__dirname, '../out');
const MANIFEST_FILE    = path.join(OUT_DIR, 'voiceover-manifest.json');
const AUDIO_DIR        = path.join(OUT_DIR, 'audio');
const VOICEOVER_OUTPUT = path.join(AUDIO_DIR, 'voiceover.mp3');

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Stitch audio clips with silence gaps ──────────────────────────────────────

function stitchAudio(clips, outputPath) {
  console.log('\n[resync-audio] Re-stitching with ffmpeg...');
  const tmpList = path.join(AUDIO_DIR, '_resync_concat.txt');
  const lines   = [];
  let cursor    = 0;

  for (const clip of clips) {
    const gapMs = clip.startMs - cursor;
    if (gapMs > 50) {
      const silenceFile = path.join(AUDIO_DIR, `silence_${clip.id}.mp3`);
      execSync(
        `ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${(gapMs / 1000).toFixed(3)} ` +
        `-q:a 9 -acodec libmp3lame "${silenceFile}" -y`,
        { stdio: 'pipe' }
      );
      lines.push(`file '${silenceFile}'`);
    }
    lines.push(`file '${clip.audioFile}'`);
    cursor = clip.startMs + clip.audioDurationMs;
  }

  fs.writeFileSync(tmpList, lines.join('\n'));
  execSync(
    `ffmpeg -f concat -safe 0 -i "${tmpList}" -acodec libmp3lame -q:a 4 "${outputPath}" -y`,
    { stdio: 'inherit' }
  );
  console.log(`[resync-audio] ✓ ${outputPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  console.log('=== resync-audio: re-stitching voiceover with sync-map corrections ===\n');
  const minVisualLeadMs = Number(process.env.NARRATION_MIN_VISUAL_LEAD_MS || 250);
  const enforceMinVisualLead = process.env.NARRATION_ENFORCE_MIN_VISUAL_LEAD == null
    ? true
    : !(
      process.env.NARRATION_ENFORCE_MIN_VISUAL_LEAD === '0' ||
      process.env.NARRATION_ENFORCE_MIN_VISUAL_LEAD === 'false'
    );

  // Load sync map (identity if missing — no adjustments)
  const syncMap = loadSyncMap(OUT_DIR);
  if (syncMap.length === 0) {
    console.log('[resync-audio] No sync-map.json segments found — using identity mapping.');
    console.log('[resync-audio] Edit sync-map.json to define speed/freeze windows.\n');
  } else {
    console.log(`[resync-audio] sync-map.json loaded: ${syncMap.length} segment(s)`);
    for (const seg of syncMap) {
      if (seg.mode === 'speed') {
        console.log(`  speed ×${seg.speed}: comp [${seg.compStart}s → ${seg.compEnd}s], videoStart=${seg.videoStart}s`);
      } else if (seg.mode === 'freeze') {
        console.log(`  freeze: comp [${seg.compStart}s → ${seg.compEnd}s], hold video at ${seg.videoStart}s`);
      }
    }
    console.log();
  }

  // Load existing manifest
  if (!fs.existsSync(MANIFEST_FILE)) {
    console.error(`[resync-audio] CRITICAL: voiceover-manifest.json not found at ${MANIFEST_FILE}`);
    console.error('[resync-audio] Run the voiceover stage first: npm run demo -- --from=voiceover');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const rawClips = manifest.clips || [];
  if (rawClips.length === 0) {
    console.error('[resync-audio] No clips in voiceover-manifest.json — nothing to resync.');
    process.exit(1);
  }
  console.log(`[resync-audio] ${rawClips.length} clip(s) loaded from manifest.\n`);

  const timingContract = loadTimingContract(OUT_DIR);
  const timingByStepId = new Map();
  if (timingContract && Array.isArray(timingContract.steps)) {
    for (const row of timingContract.steps) {
      const sid = String(row?.stepId || '').trim();
      if (!sid) continue;
      const cs = toFiniteNumber(row?.compStartMs);
      const ce = toFiniteNumber(row?.compEndMs);
      if (cs == null || ce == null || ce < cs) continue;
      timingByStepId.set(sid, { compStartMs: cs, compEndMs: ce });
    }
  }

  // Verify clip audio files exist
  for (const clip of rawClips) {
    if (!fs.existsSync(clip.audioFile)) {
      console.error(`[resync-audio] CRITICAL: Missing audio file: ${clip.audioFile}`);
      console.error('[resync-audio] Re-run the voiceover stage to regenerate missing clips.');
      process.exit(1);
    }
  }

  // Remap each clip from processed video time → composition time.
  // IMPORTANT: Use explicit processed* coordinates when present so repeated
  // resync runs are idempotent and do not "double remap" comp-space values.
  const fps = 30;
  let anyChanged = false;
  const remappedClips = rawClips.map(clip => {
    const processedStartMs = toFiniteNumber(clip.processedStartMs)
      ?? toFiniteNumber(clip._processedStartMs)
      ?? toFiniteNumber(clip.startMs)
      ?? 0;
    const processedEndMs = toFiniteNumber(clip.processedEndMs)
      ?? toFiniteNumber(clip._processedEndMs)
      ?? toFiniteNumber(clip.endMs)
      ?? processedStartMs;

    const contractWindow = timingByStepId.get(String(clip.id || '').trim());
    const remappedStartMs = processedToCompMs(processedStartMs, syncMap);
    const remappedEndMs = processedToCompMs(processedEndMs, syncMap);
    let compStartMs = contractWindow ? contractWindow.compStartMs : remappedStartMs;
    const compEndMs = contractWindow ? contractWindow.compEndMs : remappedEndMs;
    if (contractWindow && enforceMinVisualLead) {
      const candidateStart = contractWindow.compStartMs + minVisualLeadMs;
      if (candidateStart < contractWindow.compEndMs) {
        compStartMs = candidateStart;
      }
    }
    const prevCompStartMs = toFiniteNumber(clip.compStartMs) ?? toFiniteNumber(clip.startMs) ?? compStartMs;
    const deltaS      = (compStartMs - prevCompStartMs) / 1000;
    if (Math.abs(deltaS) > 0.05) {
      anyChanged = true;
      const sign = deltaS >= 0 ? '+' : '';
      console.log(
        `  ${clip.id}: ${(prevCompStartMs / 1000).toFixed(2)}s → comp ${(compStartMs / 1000).toFixed(2)}s ` +
        `(${sign}${deltaS.toFixed(2)}s)`
      );
    }
    return {
      ...clip,
      timingSpaceVersion: 2,
      processedStartMs,
      processedEndMs,
      compStartMs,
      compEndMs,
      startMs:      compStartMs,
      endMs:        compEndMs,
      startFrame:   Math.round(compStartMs / 1000 * fps),
      endFrame:     Math.round(compEndMs   / 1000 * fps),
      audioEndFrame: Math.round((compStartMs + clip.audioDurationMs) / 1000 * fps),
    };
  });

  if (!anyChanged) {
    console.log('[resync-audio] All clips already at composition-space timing (no changes needed).\n');
  }

  // Ensure clips are in ascending comp-space order before stitching.
  // sync-map transforms are monotonic in practice, but a defensive sort prevents
  // silent audio corruption if a future manifest or sync-map produces out-of-order positions.
  remappedClips.sort((a, b) => a.startMs - b.startMs);

  // Re-stitch voiceover.mp3 with corrected clip positions
  stitchAudio(remappedClips, VOICEOVER_OUTPUT);

  const updatedClips = remappedClips.map((clip) => ({
    ...clip,
    // Legacy field retained for backwards compatibility with old dashboard/debug tooling.
    _processedStartMs: clip.processedStartMs,
  }));

  const updatedManifest = {
    ...manifest,
    timingSpaceVersion: 2,
    clips:      updatedClips,
    resyncedAt: new Date().toISOString(),
    syncMapApplied: syncMap.length > 0,
  };
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(updatedManifest, null, 2));
  console.log('[resync-audio] ✓ Updated voiceover-manifest.json\n');

  const tcRefresh = refreshTimingContractAfterResync(OUT_DIR);
  if (tcRefresh.ok && !tcRefresh.skipped) {
    console.log(
      `[resync-audio] Refreshed timing-contract.json comp windows for narration sync (${tcRefresh.updatedSteps || 0} step(s) adjusted).`
    );
  } else if (tcRefresh.skipped) {
    console.log(`[resync-audio] timing-contract refresh skipped (${tcRefresh.reason || 'n/a'}).`);
  } else {
    console.warn(`[resync-audio] timing-contract refresh: ${tcRefresh.reason || 'failed'} (validate-narration-sync may still compare to stale windows).`);
  }

  const lastClip = remappedClips[remappedClips.length - 1];
  const totalS   = ((lastClip.startMs + lastClip.audioDurationMs) / 1000).toFixed(1);
  console.log(`[resync-audio] Audio total: ~${totalS}s`);
  console.log('[resync-audio] Done. Next: npm run demo -- --from=render');
}

main();
