/**
 * sync-map-utils.js
 * Shared utilities for SYNC_MAP_S inverse mapping:
 * processed video time (ms) → composition time (ms).
 *
 * SYNC_MAP_S entries describe comp→video mapping:
 *   { compStart, compEnd, videoStart, mode: 'speed'|'freeze', speed? }
 *
 * These utilities invert that mapping so voiceover audio clips can be
 * placed at the correct composition time, not just the processed video time.
 *
 * Usage:
 *   const { processedToCompMs, buildDefaultSyncMap } = require('./sync-map-utils');
 */

'use strict';

/**
 * Builds a flat list of inverse segments { videoStart, videoEnd, compStart, compEnd }
 * from a SYNC_MAP_S array (comp→video) so we can do video→comp lookups.
 *
 * Gaps between sync entries are filled with 1:1 (normal play) segments.
 * Speed entries: video range [videoStart, videoStart + compDur*speed] maps to comp range.
 * Freeze entries: video is held at videoStart for the entire comp window — represented
 *   as a zero-width video segment (isFreezePoint:true) so lookups snap correctly.
 */
function buildInverseSegments(syncMap) {
  const sorted = [...(syncMap || [])].sort((a, b) => a.compStart - b.compStart);
  const inverse = [];
  let compHead  = 0;
  let videoHead = 0;

  for (const seg of sorted) {
    // Fill any 1:1 gap before this sync entry
    if (seg.compStart > compHead) {
      const delta = seg.compStart - compHead;
      // For freeze entries the gap ends at the freeze's videoStart.
      // Using seg.videoStart directly avoids floating-point accumulation errors
      // that would make the gap-end slightly exceed the freeze point (e.g.
      // 6.0070000000000014 instead of 6.007), causing processedToCompMs to
      // match the gap segment instead of falling through to the post-freeze region.
      const gapVideoEnd = seg.mode === 'freeze' ? seg.videoStart : videoHead + delta;
      inverse.push({
        videoStart: videoHead,
        videoEnd:   gapVideoEnd,
        compStart:  compHead,
        compEnd:    seg.compStart,
      });
      videoHead = gapVideoEnd;
      compHead   = seg.compStart;
    }

    const compDur = seg.compEnd - seg.compStart;

    if (seg.mode === 'speed') {
      const speed    = seg.speed || 1;
      const videoDur = compDur * speed;
      // Note: seg.videoStart may jump past videoHead — the skipped range is never shown.
      inverse.push({
        videoStart: seg.videoStart,
        videoEnd:   seg.videoStart + videoDur,
        compStart:  seg.compStart,
        compEnd:    seg.compEnd,
      });
      videoHead = seg.videoStart + videoDur;

    } else if (seg.mode === 'freeze') {
      // Video does not advance — represent as zero-width freeze point
      inverse.push({
        videoStart:    seg.videoStart,
        videoEnd:      seg.videoStart,
        compStart:     seg.compStart,
        compEnd:       seg.compEnd,
        isFreezePoint: true,
      });
      videoHead = seg.videoStart;
    }

    compHead = seg.compEnd;
  }

  // Trailing 1:1 segment covers everything after the last sync entry
  inverse.push({
    videoStart: videoHead,
    videoEnd:   Infinity,
    compStart:  compHead,
    compEnd:    Infinity,
  });

  return inverse;
}

/**
 * Maps a processed video timestamp (ms) to the equivalent composition time (ms).
 *
 * When syncMap is empty or null, returns processedMs unchanged (identity mapping).
 *
 * If processedMs falls in a "never-shown" zone (skipped by a speed jump), it snaps
 * to the nearest valid segment boundary.
 *
 * @param {number}  processedMs - position in the processed (ffmpeg-cut) video, in ms
 * @param {Array}   syncMap     - SYNC_MAP_S entries from sync-map.json ({ compStart, compEnd, videoStart, mode, speed? })
 * @returns {number} composition time in ms
 */
// Module-level cache: avoid rebuilding inverse segments on every lookup when the
// same syncMap array reference and length are reused (e.g. resync-audio calls this
// 2× per clip with a stable, immutable array).
// Length is included in the cache key so that callers like auto-gap.js that push
// to the same array between calls correctly invalidate the cache.
let _cachedSyncMap = null;
let _cachedLen     = -1;
let _cachedSegs    = null;

function processedToCompMs(processedMs, syncMap) {
  if (!syncMap || !syncMap.length) return processedMs;

  const processedS = processedMs / 1000;
  if (syncMap !== _cachedSyncMap || syncMap.length !== _cachedLen) {
    _cachedSegs    = buildInverseSegments(syncMap);
    _cachedSyncMap = syncMap;
    _cachedLen     = syncMap.length;
  }
  const segs = _cachedSegs;

  for (const seg of segs) {
    if (seg.isFreezePoint) continue;

    // Trailing infinite segment
    if (seg.videoEnd === Infinity) {
      if (processedS >= seg.videoStart) {
        return Math.round((seg.compStart + (processedS - seg.videoStart)) * 1000);
      }
      continue;
    }

    // Use strict < for videoEnd so that a processedS exactly at the end of a 1:1 segment
    // (which is also the start of a freeze) falls through to the post-freeze segment.
    // This correctly maps "after the freeze starts" positions to post-freeze comp time.
    if (processedS >= seg.videoStart && processedS < seg.videoEnd) {
      const videoDur = seg.videoEnd - seg.videoStart;
      if (videoDur <= 0) return Math.round(seg.compStart * 1000);
      const t     = (processedS - seg.videoStart) / videoDur;
      const compS = seg.compStart + t * (seg.compEnd - seg.compStart);
      return Math.round(compS * 1000);
    }
  }

  // processedS is in a never-shown gap — snap to nearest segment boundary
  let bestDist  = Infinity;
  let bestCompMs = processedMs;
  for (const seg of segs) {
    if (seg.isFreezePoint) continue;
    const dStart = Math.abs(processedS - seg.videoStart);
    if (dStart < bestDist) { bestDist = dStart; bestCompMs = Math.round(seg.compStart * 1000); }
    if (seg.videoEnd < Infinity) {
      const dEnd = Math.abs(processedS - seg.videoEnd);
      if (dEnd < bestDist) { bestDist = dEnd; bestCompMs = Math.round(seg.compEnd * 1000); }
    }
  }
  return bestCompMs;
}

/**
 * Reads sync-map.json from the run directory. Returns the segments array,
 * or [] if the file is absent or has no speed/freeze entries.
 *
 * @param {string} runDir - absolute path to the pipeline run directory
 * @returns {Array} syncMap segments
 */
function loadSyncMap(runDir) {
  const fs   = require('fs');
  const path = require('path');
  const file = path.join(runDir, 'sync-map.json');
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.segments || [];
  } catch {
    return [];
  }
}

/**
 * Returns the default (identity) sync-map JSON — no speed or freeze adjustments.
 * Write this when a new processed recording is created; humans can edit afterwards.
 */
function buildDefaultSyncMap(note) {
  return {
    _comment: note || 'Edit segments to add speed/freeze adjustments. Run --from=resync-audio after changes.',
    segments: [],
  };
}

module.exports = { processedToCompMs, buildInverseSegments, loadSyncMap, buildDefaultSyncMap };
