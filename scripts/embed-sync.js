#!/usr/bin/env node
'use strict';
/**
 * embed-sync.js
 * Phase 1: Audio-video sync alignment detection via Vertex AI multimodal embeddings.
 *
 * For each voiceover clip in voiceover-manifest.json:
 *   1. Extracts the corresponding video segment from recording-processed.webm
 *   2. Wraps the audio clip in a black-video container (Vertex AI has no audio-only endpoint)
 *   3. Embeds both as video via multimodalembedding@001
 *   4. Computes cosine similarity
 *   5. If similarity < EMBED_SYNC_THRESHOLD: grid-searches offsets ±2s for best alignment
 *
 * Writes embed-sync-report.json. If EMBED_SYNC_AUTO_APPLY=true and confidence is
 * "high" (sim delta > 0.15), auto-patches sync-map.json and re-run signal is set.
 *
 * Usage:
 *   PIPELINE_RUN_DIR=... node scripts/embed-sync.js
 *   npm run demo -- --from=embed-sync
 *
 * Env vars:
 *   VERTEX_AI_PROJECT_ID   — required (graceful skip if absent)
 *   VERTEX_AI_REGION       — default: us-central1
 *   EMBED_SYNC_THRESHOLD   — default: 0.75
 *   EMBED_SYNC_AUTO_APPLY  — default: false
 */

require('dotenv').config();

const fs                = require('fs');
const path              = require('path');
const { spawnSync }     = require('child_process');
const { embedVideo, embedAudioAsVideo, cosineSimilarity } = require('./scratch/utils/vertex-embed');
const { loadSyncMap }   = require('./sync-map-utils');

const OUT_DIR      = process.env.PIPELINE_RUN_DIR || path.resolve(__dirname, '../out');
const THRESHOLD    = parseFloat(process.env.EMBED_SYNC_THRESHOLD  || '0.75');
const AUTO_APPLY   = process.env.EMBED_SYNC_AUTO_APPLY === 'true';
const OFFSETS_MS   = [-2000, -1000, -500, 0, 500, 1000, 2000];
const SCALE_DOWN   = 'scale=640:360';
const FPS_DOWN     = 4;
const TMPDIR       = path.join(OUT_DIR, '_embed_tmp');

// ── ffmpeg helpers ─────────────────────────────────────────────────────────────

/**
 * Extracts a scaled-down video clip segment.
 * Scale to 640×360 at 4fps to stay under Vertex AI 20MB inline payload limit.
 */
function extractVideoClip(sourceVideo, startS, durationS, outputPath) {
  const r = spawnSync('ffmpeg', [
    '-ss', String(Math.max(0, startS)),
    '-t',  String(Math.max(0.5, durationS)),
    '-i',  sourceVideo,
    '-vf', `${SCALE_DOWN},fps=${FPS_DOWN}`,
    '-an', '-y', outputPath,
  ], { encoding: 'utf8', timeout: 60000 });
  return r.status === 0 && fs.existsSync(outputPath);
}

/**
 * Wraps an audio file (MP3) in a black-video container.
 * The multimodalembedding@001 API has no standalone audio endpoint;
 * audio embedded as a silent-video track works correctly.
 */
function wrapAudioAsVideo(audioFile, outputPath) {
  const r = spawnSync('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=c=black:s=128x72:r=1',
    '-i', audioFile,
    '-shortest', '-y', outputPath,
  ], { encoding: 'utf8', timeout: 60000 });
  return r.status === 0 && fs.existsSync(outputPath);
}

/**
 * Merge new sync-map suggestions into existing segments (replace by overlap, otherwise append).
 */
function mergeSyncSegments(existing, suggestions) {
  const merged = [...(existing || [])];
  for (const s of suggestions) {
    const idx = merged.findIndex(
      e => Math.abs(e.compStart - s.compStart) < 1.0 && e.mode === s.mode
    );
    if (idx >= 0) merged[idx] = { ...merged[idx], ...s };
    else merged.push(s);
  }
  return merged;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== embed-sync: audio-video alignment detection ===\n');

  if (!process.env.VERTEX_AI_PROJECT_ID) {
    console.warn('[embed-sync] VERTEX_AI_PROJECT_ID not set — skipping stage.');
    console.warn('[embed-sync] Add VERTEX_AI_PROJECT_ID to .env to enable multimodal sync detection.');
    return null;
  }

  const manifestFile        = path.join(OUT_DIR, 'voiceover-manifest.json');
  const processedTimingFile = path.join(OUT_DIR, 'processed-step-timing.json');
  const syncMapFile         = path.join(OUT_DIR, 'sync-map.json');
  const recordingProcessed  = path.join(OUT_DIR, 'recording-processed.webm');
  const recordingRaw        = path.join(OUT_DIR, 'recording.webm');
  const sourceVideo         = fs.existsSync(recordingProcessed) ? recordingProcessed : recordingRaw;

  if (!fs.existsSync(manifestFile)) {
    console.warn('[embed-sync] No voiceover-manifest.json found — skipping.');
    return null;
  }
  if (!fs.existsSync(sourceVideo)) {
    console.warn('[embed-sync] No recording found — skipping.');
    return null;
  }

  const manifest      = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const clips         = manifest.clips || [];
  const syncMap       = loadSyncMap(OUT_DIR);

  // Optional: load processed step timing for more accurate video coordinate lookup
  let processedTiming = null;
  if (fs.existsSync(processedTimingFile)) {
    try { processedTiming = JSON.parse(fs.readFileSync(processedTimingFile, 'utf8')); } catch (_) {}
  }

  fs.mkdirSync(TMPDIR, { recursive: true });

  const stepResults          = [];
  const stepsNeedingCorrection = [];
  const syncMapSuggestions   = [];
  let   simSum               = 0;
  let   validCount           = 0;

  console.log(`[embed-sync] Processing ${clips.length} clip(s) from voiceover manifest...\n`);

  for (const clip of clips) {
    if (!clip.audioFile || !fs.existsSync(clip.audioFile)) {
      console.warn(`[embed-sync] Skipping ${clip.id} — audio file missing: ${clip.audioFile}`);
      stepResults.push({ stepId: clip.id, similarity: null, status: 'audio-missing' });
      continue;
    }

    // Determine the video segment start/duration.
    // Prefer processed-step-timing.json for raw video coordinates;
    // fall back to manifest comp-space startMs.
    let videoStartS = clip.startMs / 1000;
    let videoDurS   = clip.audioDurationMs / 1000;

    if (processedTiming) {
      const ptStep = (processedTiming.steps || []).find(s => s.id === clip.id);
      if (ptStep) {
        videoStartS = ptStep.startMs / 1000;
        videoDurS   = Math.max(0.5, ptStep.durationMs / 1000);
      }
    }

    // Extract scaled-down video clip
    const videoClipPath = path.join(TMPDIR, `vid_${clip.id}.webm`);
    const audioVidPath  = path.join(TMPDIR, `aud_${clip.id}.webm`);

    const videoOk = extractVideoClip(sourceVideo, videoStartS, videoDurS, videoClipPath);
    const audioOk = wrapAudioAsVideo(clip.audioFile, audioVidPath);

    if (!videoOk || !audioOk) {
      console.warn(`[embed-sync] Extraction failed for step "${clip.id}" — skipping`);
      stepResults.push({ stepId: clip.id, similarity: null, status: 'extraction-failed' });
      continue;
    }

    // Embed both
    let videoVec, audioVec;
    try {
      videoVec = await embedVideo(fs.readFileSync(videoClipPath));
      audioVec = await embedAudioAsVideo(fs.readFileSync(audioVidPath));
    } catch (err) {
      console.warn(`[embed-sync] Embedding failed for step "${clip.id}": ${err.message}`);
      stepResults.push({ stepId: clip.id, similarity: null, status: 'embed-failed', error: err.message });
      try { fs.unlinkSync(videoClipPath); } catch (_) {}
      try { fs.unlinkSync(audioVidPath); } catch (_) {}
      continue;
    }

    try { fs.unlinkSync(videoClipPath); } catch (_) {}
    try { fs.unlinkSync(audioVidPath); } catch (_) {}

    const similarity = cosineSimilarity(videoVec, audioVec);
    const sim3       = Math.round(similarity * 1000) / 1000;
    console.log(`[embed-sync] ${clip.id}: similarity=${sim3}`);

    if (similarity >= THRESHOLD) {
      stepResults.push({ stepId: clip.id, similarity: sim3, status: 'aligned' });
      simSum += similarity;
      validCount++;
      continue;
    }

    // Low similarity — grid search for best temporal offset
    stepsNeedingCorrection.push(clip.id);
    console.log(`[embed-sync] ${clip.id}: below threshold (${THRESHOLD}) — running grid search...`);

    let bestOffset = 0;
    let bestSim    = similarity;

    for (const offsetMs of OFFSETS_MS) {
      if (offsetMs === 0) continue;
      const adjStartS = videoStartS + offsetMs / 1000;
      if (adjStartS < 0) continue;

      const trialPath = path.join(TMPDIR, `trial_${clip.id}_${offsetMs}.webm`);
      const ok = extractVideoClip(sourceVideo, adjStartS, videoDurS, trialPath);
      if (!ok) continue;

      try {
        const trialVec = await embedVideo(fs.readFileSync(trialPath));
        const trialSim = cosineSimilarity(trialVec, audioVec);
        if (trialSim > bestSim) { bestSim = trialSim; bestOffset = offsetMs; }
      } catch (_) {}
      try { fs.unlinkSync(trialPath); } catch (_) {}
    }

    const simDelta   = bestSim - similarity;
    const confidence = simDelta > 0.15 ? 'high' : simDelta > 0.05 ? 'medium' : 'low';
    console.log(`[embed-sync] ${clip.id}: best offset=${bestOffset}ms (sim=${Math.round(bestSim*1000)/1000}), confidence=${confidence}`);

    if (bestOffset !== 0 && simDelta > 0.05) {
      syncMapSuggestions.push({
        compStart:  clip.startMs / 1000,
        compEnd:    (clip.startMs + clip.audioDurationMs) / 1000,
        videoStart: videoStartS + bestOffset / 1000,
        mode:       'normal',
        speed:      1.0,
        _reason:    `embed-sync offset ${bestOffset}ms improved similarity ${sim3} → ${Math.round(bestSim*1000)/1000}`,
        _confidence: confidence,
      });
    }

    stepResults.push({
      stepId:            clip.id,
      similarity:        sim3,
      status:            'misaligned',
      suggestedOffsetMs: bestOffset,
      confidence,
    });

    simSum += bestSim;
    validCount++;
  }

  const overallAlignment = validCount > 0 ? Math.round((simSum / validCount) * 1000) / 1000 : 0;

  // Build report
  const report = {
    generatedAt:           new Date().toISOString(),
    model:                 'multimodalembedding@001',
    threshold:             THRESHOLD,
    overallAlignment,
    stepsNeedingCorrection,
    autoApplied:           false,
    steps:                 stepResults,
    syncMapSuggestions,
  };

  // Auto-apply high-confidence suggestions
  if (AUTO_APPLY && syncMapSuggestions.length > 0) {
    const highConfSuggestions = syncMapSuggestions.filter(s => s._confidence === 'high');
    if (highConfSuggestions.length > 0) {
      let existing = [];
      if (fs.existsSync(syncMapFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(syncMapFile, 'utf8'));
          existing = parsed.segments || parsed || [];
        } catch (_) {}
      }
      const merged = mergeSyncSegments(existing, highConfSuggestions);
      fs.writeFileSync(syncMapFile, JSON.stringify(merged, null, 2));
      report.autoApplied = true;
      console.log(`[embed-sync] Auto-applied ${highConfSuggestions.length} high-confidence correction(s) to sync-map.json`);
    }
  }

  const reportPath = path.join(OUT_DIR, 'embed-sync-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n[embed-sync] Overall alignment: ${(overallAlignment * 100).toFixed(1)}%`);
  if (stepsNeedingCorrection.length > 0) {
    console.log(`[embed-sync] Steps needing correction: ${stepsNeedingCorrection.join(', ')}`);
    if (!AUTO_APPLY && syncMapSuggestions.length > 0) {
      console.log('[embed-sync] Set EMBED_SYNC_AUTO_APPLY=true to auto-patch sync-map.json with high-confidence corrections.');
    }
  } else {
    console.log('[embed-sync] All steps are well-aligned.');
  }
  console.log(`[embed-sync] Report: ${reportPath}`);

  // Cleanup temp dir
  try {
    const files = fs.readdirSync(TMPDIR);
    for (const f of files) { try { fs.unlinkSync(path.join(TMPDIR, f)); } catch (_) {} }
    fs.rmdirSync(TMPDIR);
  } catch (_) {}

  return report;
}

if (require.main === module) {
  main().catch(err => {
    console.error('[embed-sync] Fatal error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main };
