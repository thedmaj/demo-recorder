#!/usr/bin/env node
'use strict';

/**
 * render-moviepy — final video composition via the MoviePy MCP server
 * (vidmagik), as the alternative engine to Remotion for the `render` stage.
 *
 * Why: Remotion re-renders every frame through Chromium as JPEG screenshots
 * (default quality) before encoding — a generation loss on top of the VP8
 * capture. This path decodes recording-processed.webm directly to frames and
 * encodes ONCE with explicit high-quality x264 settings (CRF 16, preset slow,
 * yuv420p, level 5.1) at the native 2880×1800@30.
 *
 * Scope (initial build, per user decision): NO visual effects — pure
 * composition: sync-map retime (speed / freeze / normal segments) +
 * continuous voiceover + encode. Pointer overlays (click ripple, trail,
 * spotlight) are deferred until effect-less pipeline builds are proven.
 *
 * Source of truth: `<runDir>/remotion-props.json` — the orchestrator writes
 * it for BOTH engines before rendering. Its `syncMap` already includes the
 * Plaid min-duration freeze injection and its `scratchDurationFrames` is the
 * final composition length, so this renderer needs no re-implementation of
 * that logic (single parity source: scripts/build-remotion-props.js).
 *
 * Segment walk is a faithful port of buildSyncSegments
 * (remotion/ScratchComposition.jsx:820-904): frame-domain rounding first,
 * gap-fill with normal speed-1 play, trailing gap to comp end, sub-frame
 * segments dropped.
 *
 * Server contract: vidmagik validate_path confines file I/O to the server
 * CWD or /tmp — all media staged in a /tmp workspace and copied back.
 *
 * Usage:
 *   node scripts/scratch/render-moviepy.js --run-id=<RUN_ID>      (CLI)
 *   require('./render-moviepy').main({ runDir, outFile })          (orchestrator)
 *
 * Env knobs: MOVIEPY_CRF (default 16), MOVIEPY_PRESET (default slow),
 *            MOVIEPY_THREADS (default 10).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { McpClient } = require('./mcp-client');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MCP_SERVER_DIR = path.join(os.homedir(), '.mcp-servers/mcp-moviepy');
const FPS = 30;

// ── helpers ─────────────────────────────────────────────────────────────────

function ffprobeJson(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ]).toString();
  return JSON.parse(out);
}

function videoDurationSec(file) {
  const j = ffprobeJson(file);
  const d = parseFloat(j.format && j.format.duration);
  if (!Number.isFinite(d)) throw new Error(`ffprobe could not read duration of ${file}`);
  return d;
}

function serverGitSha() {
  try {
    return execFileSync('git', ['-C', MCP_SERVER_DIR, 'rev-parse', '--short', 'HEAD']).toString().trim();
  } catch (_) { return null; }
}

/**
 * Faithful port of buildSyncSegments (ScratchComposition.jsx:820-904), frame
 * domain. Returns segments covering [0, totalFrames): {compStartF, compEndF,
 * videoStartF, mode, speed}.
 */
function buildSyncSegments(syncMap, totalFrames) {
  const entries = (syncMap || [])
    .map((e) => ({
      compStartF: Math.round(e.compStart * FPS),
      compEndF: Math.round(e.compEnd * FPS),
      videoStartF: Math.round(e.videoStart * FPS),
      mode: e.mode,
      speed: e.speed != null ? e.speed : 1,
    }))
    .sort((a, b) => a.compStartF - b.compStartF);

  const segments = [];
  let compHead = 0;
  let videoHead = 0;

  for (const entry of entries) {
    if (entry.compStartF > compHead) {
      segments.push({
        compStartF: compHead,
        compEndF: entry.compStartF,
        videoStartF: videoHead,
        mode: 'normal',
        speed: 1,
      });
      videoHead = videoHead + (entry.compStartF - compHead);
      compHead = entry.compStartF;
    }
    segments.push(entry);
    compHead = entry.compEndF;
    if (entry.mode === 'freeze') {
      videoHead = entry.videoStartF;
    } else {
      const compDur = entry.compEndF - entry.compStartF;
      videoHead = entry.videoStartF + Math.round(compDur * (entry.speed != null ? entry.speed : 1));
    }
  }

  if (compHead < totalFrames) {
    segments.push({
      compStartF: compHead,
      compEndF: totalFrames,
      videoStartF: videoHead,
      mode: 'normal',
      speed: 1,
    });
  }

  // Drop sub-frame segments (Remotion's frame rounding makes them invisible;
  // observed: a 5ms sync-map segment).
  return segments.filter((s) => s.compEndF - s.compStartF >= 1);
}

function warnIfStoryboardStale(runDir) {
  try {
    const mutLog = JSON.parse(fs.readFileSync(path.join(runDir, 'editor-mutation-log.json'), 'utf8'));
    const entries = Array.isArray(mutLog && mutLog.entries) ? mutLog.entries : [];
    if (entries.some((e) => e && e.voiceoverStale === true)) {
      console.warn('[render-moviepy] ⚠ STALE VOICEOVER: storyboard narration changed after voiceover — run `pipe stage voiceover` first.');
    }
    if (entries.some((e) => e && e.recordingStale === true)) {
      console.warn('[render-moviepy] ⚠ STALE RECORDING: storyboard edits postdate the recording — run `pipe stage record` first.');
    }
  } catch (_) { /* no mutation log — nothing edited via storyboard */ }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(opts = {}) {
  const runDir = opts.runDir || resolveRunDirFromArgv();
  const outFile = opts.outFile || path.join(runDir, 'demo-scratch.mp4');
  const crf = String(process.env.MOVIEPY_CRF || '16');
  const preset = String(process.env.MOVIEPY_PRESET || 'slow');
  const threads = parseInt(process.env.MOVIEPY_THREADS || '10', 10) || 10;
  const t0 = Date.now();

  const recording = path.join(runDir, 'recording-processed.webm');
  const propsFile = path.join(runDir, 'remotion-props.json');
  // Canonical voiceover location is <runDir>/audio/voiceover.mp3 (same file
  // the render preflight checks); legacy runs kept it at the run root.
  const voiceover = [
    path.join(runDir, 'audio', 'voiceover.mp3'),
    path.join(runDir, 'voiceover.mp3'),
  ].find((p) => fs.existsSync(p)) || path.join(runDir, 'audio', 'voiceover.mp3');
  if (!fs.existsSync(recording)) throw new Error('recording-processed.webm missing — run post-process first');
  if (!fs.existsSync(propsFile)) throw new Error('remotion-props.json missing — the render stage must build props before invoking the engine');

  warnIfStoryboardStale(runDir);

  const props = JSON.parse(fs.readFileSync(propsFile, 'utf8'));
  const syncMap = Array.isArray(props.syncMap) ? props.syncMap : [];
  const totalFrames = Number(props.scratchDurationFrames);
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
    throw new Error(`remotion-props.json scratchDurationFrames invalid: ${props.scratchDurationFrames}`);
  }
  const compDurationSec = totalFrames / FPS;
  const srcDur = videoDurationSec(recording);
  const hasVoiceover = fs.existsSync(voiceover);

  const segments = buildSyncSegments(syncMap, totalFrames);
  console.log(`[render-moviepy] comp ${compDurationSec.toFixed(2)}s (${totalFrames}f) | source ${srcDur.toFixed(2)}s | ${segments.length} segments (${segments.filter(s => s.mode === 'freeze').length} freeze, ${segments.filter(s => s.mode === 'speed' || (s.mode !== 'freeze' && s.speed !== 1)).length} speed) | voiceover=${hasVoiceover}`);

  // Stage media into the /tmp workspace the server may touch.
  const ws = fs.mkdtempSync(path.join('/tmp', 'mcp-render-'));
  const wsVideo = path.join(ws, 'recording.webm');
  fs.copyFileSync(recording, wsVideo);
  let wsAudio = null;
  if (hasVoiceover) {
    wsAudio = path.join(ws, 'voiceover.mp3');
    fs.copyFileSync(voiceover, wsAudio);
  }

  console.log('[render-moviepy] starting moviepy MCP server (stdio)...');
  const client = new McpClient('uv', ['--directory', MCP_SERVER_DIR, 'run', 'main.py', '--transport', 'stdio']);
  const report = {
    at: new Date().toISOString(),
    runDir: path.basename(runDir),
    engine: 'moviepy',
    serverSha: serverGitSha(),
    encode: { codec: 'libx264', crf, preset, threads, fps: FPS },
    compDurationSec: Number(compDurationSec.toFixed(3)),
    sourceDurationSec: Number(srcDur.toFixed(3)),
    segments: [],
    assertions: {},
  };

  try {
    const init = await client.initialize();
    console.log(`[render-moviepy] connected: ${init.serverInfo && init.serverInfo.name} ${(init.serverInfo && init.serverInfo.version) || ''}`);

    const fullId = await client.callTool('video_file_clip', { filename: wsVideo, audio: false }, 300000);

    // Build per-segment clips.
    const EPS = 1 / FPS / 2;
    const segClipIds = [];
    for (const seg of segments) {
      const D = (seg.compEndF - seg.compStartF) / FPS; // comp seconds
      const vs = seg.videoStartF / FPS;
      let clipId;
      let op;
      if (seg.mode === 'freeze') {
        // 1-frame subclip at the held frame, frozen out to D — fully static.
        const fStart = Math.min(vs, Math.max(0, srcDur - 2 / FPS));
        clipId = await client.callTool('subclip', { clip_id: fullId, start_time: fStart, end_time: Math.min(fStart + 1 / FPS, srcDur) }, 60000);
        clipId = await client.callTool('vfx_freeze', { clip_id: clipId, t: 0, total_duration: D }, 60000);
        op = `freeze@${vs.toFixed(2)}s ×${D.toFixed(2)}s`;
      } else {
        const speed = seg.speed != null ? seg.speed : 1;
        let needed = D * speed; // source seconds consumed
        let vEnd = vs + needed;
        let tailShortfall = 0;
        if (vEnd > srcDur - EPS) {
          tailShortfall = vEnd - srcDur;
          vEnd = srcDur;
        }
        if (vs >= srcDur - EPS) {
          // Entirely past EOF — hold the last frame for D.
          const fStart = Math.max(0, srcDur - 2 / FPS);
          clipId = await client.callTool('subclip', { clip_id: fullId, start_time: fStart, end_time: srcDur }, 60000);
          clipId = await client.callTool('vfx_freeze', { clip_id: clipId, t: 0, total_duration: D }, 60000);
          op = `eof-hold ×${D.toFixed(2)}s`;
        } else {
          clipId = await client.callTool('subclip', { clip_id: fullId, start_time: vs, end_time: vEnd }, 60000);
          if (speed !== 1) {
            clipId = await client.callTool('vfx_multiply_speed', { clip_id: clipId, factor: speed }, 60000);
          }
          op = speed !== 1 ? `speed×${speed} [${vs.toFixed(2)}→${vEnd.toFixed(2)}]` : `normal [${vs.toFixed(2)}→${vEnd.toFixed(2)}]`;
          if (tailShortfall > 1 / FPS) {
            // Source ran out — freeze-extend the tail to keep comp duration exact.
            const extendBy = tailShortfall / speed;
            clipId = await client.callTool('vfx_freeze', {
              clip_id: clipId,
              t: Math.max(0, (vEnd - vs) / speed - 1 / FPS),
              freeze_duration: extendBy,
            }, 60000);
            op += ` +eof-freeze ${extendBy.toFixed(2)}s`;
          }
        }
      }
      segClipIds.push(clipId);
      report.segments.push({
        compStartF: seg.compStartF, compEndF: seg.compEndF, videoStartF: seg.videoStartF,
        mode: seg.mode, speed: seg.speed, op,
      });
    }

    console.log(`[render-moviepy] concatenating ${segClipIds.length} segment clips...`);
    let finalId = await client.callTool('concatenate_video_clips', { clip_ids: segClipIds }, 180000);

    if (hasVoiceover) {
      const aId = await client.callTool('audio_file_clip', { filename: wsAudio }, 60000);
      finalId = await client.callTool('set_audio', { clip_id: finalId, audio_clip_id: aId }, 60000);
    }

    const wsOut = path.join(ws, 'demo-scratch.mp4');
    console.log(`[render-moviepy] encoding (libx264 crf=${crf} preset=${preset} threads=${threads}) — this is the slow part...`);
    await client.callTool('write_videofile', {
      clip_id: finalId,
      filename: wsOut,
      fps: FPS,
      codec: 'libx264',
      audio_codec: 'aac',
      preset,
      threads,
      ffmpeg_params: ['-crf', crf, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-profile:v', 'high', '-level', '5.1'],
    }, 3600000);

    // ── Post-write assertions ────────────────────────────────────────────
    const probe = ffprobeJson(wsOut);
    const v = (probe.streams || []).find((s) => s.codec_type === 'video') || {};
    const a = (probe.streams || []).find((s) => s.codec_type === 'audio');
    const outDur = parseFloat(probe.format && probe.format.duration);
    const fpsStr = String(v.r_frame_rate || '');
    const assertions = {
      width: v.width,
      height: v.height,
      fps: fpsStr,
      durationSec: Number(outDur.toFixed(3)),
      audioPresent: !!a,
      widthOk: v.width === 2880,
      heightOk: v.height === 1800,
      fpsOk: fpsStr === '30/1',
      durationOk: Math.abs(outDur - compDurationSec) <= 0.3,
      audioOk: hasVoiceover ? !!a : true,
    };
    report.assertions = assertions;
    const failed = ['widthOk', 'heightOk', 'fpsOk', 'durationOk', 'audioOk'].filter((k) => !assertions[k]);
    if (failed.length) {
      throw new Error(`render assertions failed: ${failed.join(', ')} — ${JSON.stringify(assertions)}`);
    }

    fs.copyFileSync(wsOut, outFile);
    report.wallTimeSec = Number(((Date.now() - t0) / 1000).toFixed(1));
    report.outFile = outFile;
    report.outSizeMB = Number((fs.statSync(outFile).size / 1e6).toFixed(1));
    fs.writeFileSync(path.join(runDir, 'render-moviepy-report.json'), JSON.stringify(report, null, 2));
    console.log(`[render-moviepy] ✓ ${path.basename(outFile)} (${report.outSizeMB} MB, ${assertions.width}x${assertions.height}@30, ${assertions.durationSec}s) in ${report.wallTimeSec}s`);
    return report;
  } finally {
    client.close();
    // /tmp workspace left for OS cleanup; useful for debugging failures.
  }
}

function resolveRunDirFromArgv() {
  const arg = process.argv.find((a) => a.startsWith('--run-id='));
  if (arg) {
    const p = path.join(PROJECT_ROOT, 'out/demos', arg.slice(9));
    if (!fs.existsSync(p)) throw new Error(`run dir not found: ${p}`);
    return p;
  }
  const latest = path.join(PROJECT_ROOT, 'out/latest');
  if (fs.existsSync(latest)) return fs.realpathSync(latest);
  throw new Error('no --run-id and no out/latest symlink');
}

if (require.main === module) {
  main().catch((e) => { console.error('[render-moviepy] FATAL:', e.message); process.exit(1); });
}

module.exports = { main, buildSyncSegments };
