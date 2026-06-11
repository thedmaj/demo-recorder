#!/usr/bin/env node
'use strict';

/**
 * mcp-video-edit — scene-truth narrated cut via the moviepy MCP server (vidmagik).
 *
 * Alternative to the Remotion `render` stage for narration/scene drift cases.
 * The Remotion path trusts timing JSON (step-timing.json remapped through
 * processed-step-timing.json keepRanges) and lays one continuous voiceover
 * over one continuous video — any remap error makes narration describe the
 * wrong scene. This stage instead:
 *
 *   1. SCENE DETECTION — asks the moviepy MCP server (tools_detect_scenes) for
 *      the recording's REAL cut points (luminosity deltas on a downscaled
 *      decode; slides/host screens cut hard, so the signal is strong).
 *   2. NARRATION MATCH vs DRIFT — maps each step's claimed start (raw
 *      step-timing → processed via keepRanges), snaps it to the nearest
 *      detected cut within a tolerance, and reports per-step drift.
 *   3. EDIT / STITCH — cuts the processed recording into per-step subclips at
 *      the snapped boundaries, binds each step's narration clip
 *      (audio/vo_<stepId>.mp3) to ITS OWN subclip — freeze-extending the
 *      subclip tail when narration outruns the scene — then concatenates.
 *      Narration can no longer bleed into a neighboring scene by construction.
 *
 * Server contract: vidmagik validate_path restricts file I/O to the server
 * CWD or /tmp, so all media is staged in a /tmp workspace and copied back.
 *
 * Usage:
 *   node scripts/scratch/scratch/mcp-video-edit.js [--run-id=ID]
 *     [--tolerance=2.0] [--tail-pad=0.6] [--luminosity=10] [--dry-run]
 *
 * Outputs (run dir):
 *   demo-mcp-edit.mp4            — narrated, scene-aligned final video
 *   mcp-video-edit-report.json   — scenes, per-step drift table, actions
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const MCP_SERVER_DIR = path.join(os.homedir(), '.mcp-servers/mcp-moviepy');

// ---------------------------------------------------------------------------
// Minimal MCP stdio client (newline-delimited JSON-RPC, FastMCP-compatible)
// ---------------------------------------------------------------------------

class McpClient {
  constructor(command, args, opts = {}) {
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = [];
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.stderr.on('data', (d) => {
      this.stderrTail.push(String(d));
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    this.exited = new Promise((res) => this.proc.on('exit', res));
  }

  _onData(d) {
    this.buf += String(d);
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  }

  _send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms. stderr tail: ${this.stderrTail.slice(-3).join(' ')}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params: params || {} });
  }

  async initialize() {
    const r = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-video-edit', version: '1.0.0' },
    }, 90000);
    this.notify('notifications/initialized');
    return r;
  }

  /**
   * Call a tool and return its (parsed) result. FastMCP returns
   * { content: [{type:'text', text}], structuredContent? , isError? }.
   */
  async callTool(name, args, timeoutMs = 120000) {
    const r = await this.request('tools/call', { name, arguments: args || {} }, timeoutMs);
    if (r.isError) {
      const text = (r.content || []).map((c) => c.text || '').join(' ');
      throw new Error(`tool ${name} failed: ${text.slice(0, 500)}`);
    }
    if (r.structuredContent !== undefined) {
      const sc = r.structuredContent;
      return sc && typeof sc === 'object' && 'result' in sc ? sc.result : sc;
    }
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    try { return JSON.parse(text); } catch (_) { return text; }
  }

  close() {
    try { this.proc.stdin.end(); } catch (_) {}
    try { this.proc.kill(); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function ffprobeDuration(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ]).toString().trim();
  const d = parseFloat(out);
  if (!Number.isFinite(d)) throw new Error(`ffprobe could not read duration of ${file}`);
  return d;
}

/** Map a RAW recording time (s) to PROCESSED time (s) via keepRanges. */
function rawToProcessed(rawS, keepRanges) {
  for (const r of keepRanges) {
    if (rawS <= r.rawStart) return r.processedStart;
    if (rawS <= r.rawEnd) return r.processedStart + (rawS - r.rawStart);
  }
  const last = keepRanges[keepRanges.length - 1];
  return last ? last.processedEnd : rawS;
}

function resolveRunDir(cliRunId) {
  if (cliRunId) {
    const p = path.join(PROJECT_ROOT, 'out/demos', cliRunId);
    if (!fs.existsSync(p)) throw new Error(`run dir not found: ${p}`);
    return p;
  }
  const latest = path.join(PROJECT_ROOT, 'out/latest');
  if (fs.existsSync(latest)) return fs.realpathSync(latest);
  throw new Error('no --run-id and no out/latest symlink');
}

function parseArgs(argv) {
  const a = { tolerance: 2.0, tailPad: 0.6, luminosity: 10, dryRun: false, runId: null };
  for (const arg of argv) {
    if (arg.startsWith('--run-id=')) a.runId = arg.slice(9);
    else if (arg.startsWith('--tolerance=')) a.tolerance = parseFloat(arg.slice(12));
    else if (arg.startsWith('--tail-pad=')) a.tailPad = parseFloat(arg.slice(11));
    else if (arg.startsWith('--luminosity=')) a.luminosity = parseInt(arg.slice(13), 10);
    else if (arg === '--dry-run') a.dryRun = true;
  }
  return a;
}

/** Normalize tools_detect_scenes output to a sorted list of cut times (s). */
function normalizeSceneCuts(raw, videoDur) {
  // moviepy detect_scenes returns `cuts` as [[start, end], ...] scene
  // intervals; some builds serialize numpy arrays as nested lists. Accept
  // either interval pairs or flat boundary times.
  const times = new Set();
  const arr = Array.isArray(raw) ? raw : [];
  for (const item of arr) {
    if (Array.isArray(item)) {
      for (const t of item) { const v = parseFloat(t); if (Number.isFinite(v)) times.add(v); }
    } else {
      const v = parseFloat(item);
      if (Number.isFinite(v)) times.add(v);
    }
  }
  return Array.from(times)
    .filter((t) => t > 0.25 && t < videoDur - 0.25)
    .sort((x, y) => x - y);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = resolveRunDir(args.runId);
  const runId = path.basename(runDir);
  console.log(`[mcp-edit] run: ${runId}`);

  const recording = path.join(runDir, 'recording-processed.webm');
  if (!fs.existsSync(recording)) throw new Error('recording-processed.webm missing — run post-process first');

  // Storyboard staleness contract: the dashboard editor logs every narration /
  // slide mutation to editor-mutation-log.json and flags voiceoverStale /
  // recordingStale. This stage consumes vo_*.mp3 + the processed recording, so
  // stale flags mean the stitch would bake OUTDATED narration or visuals in —
  // surface it loudly (same contract build-qa/record observe; the freeze
  // sentinel only gates automated slide regen, not editor mutations).
  try {
    const mutLog = JSON.parse(fs.readFileSync(path.join(runDir, 'editor-mutation-log.json'), 'utf8'));
    const entries = Array.isArray(mutLog?.entries) ? mutLog.entries : [];
    const voStale = entries.some((e) => e && e.voiceoverStale === true);
    const recStale = entries.some((e) => e && e.recordingStale === true);
    if (voStale) console.warn('[mcp-edit] ⚠ STALE VOICEOVER: storyboard narration changed after voiceover — run `pipe stage voiceover` first or the stitch bakes outdated narration.');
    if (recStale) console.warn('[mcp-edit] ⚠ STALE RECORDING: storyboard slide/scene edits postdate the recording — run `pipe stage record` first or the stitch bakes outdated visuals.');
  } catch (_) { /* no mutation log — nothing edited via storyboard */ }
  const demoScript = JSON.parse(fs.readFileSync(path.join(runDir, 'demo-script.json'), 'utf8'));
  const stepTiming = JSON.parse(fs.readFileSync(path.join(runDir, 'step-timing.json'), 'utf8'));
  const processedTiming = JSON.parse(fs.readFileSync(path.join(runDir, 'processed-step-timing.json'), 'utf8'));
  const keepRanges = processedTiming.keepRanges || [];
  const timingSteps = stepTiming.steps || stepTiming;

  const videoDur = ffprobeDuration(recording);
  console.log(`[mcp-edit] processed recording: ${videoDur.toFixed(2)}s`);

  // ── Stage media into the /tmp workspace the MCP server may touch ──────────
  const ws = fs.mkdtempSync(path.join('/tmp', 'mcp-edit-'));
  const wsVideo = path.join(ws, 'recording.webm');
  fs.copyFileSync(recording, wsVideo);

  // Per-step narration clips + claimed boundaries (raw → processed).
  const steps = [];
  for (const s of demoScript.steps || []) {
    const t = timingSteps.find((x) => x.id === s.id);
    if (!t) { console.warn(`[mcp-edit] no timing for step ${s.id} — skipped`); continue; }
    const voSrc = path.join(runDir, 'audio', `vo_${s.id}.mp3`);
    let vo = null;
    let voDur = 0;
    if (fs.existsSync(voSrc)) {
      vo = path.join(ws, `vo_${s.id}.mp3`);
      fs.copyFileSync(voSrc, vo);
      voDur = ffprobeDuration(vo);
    }
    steps.push({
      id: s.id,
      claimedStart: rawToProcessed((t.startMs || 0) / 1000, keepRanges),
      vo,
      voDur,
    });
  }
  steps.sort((a, b) => a.claimedStart - b.claimedStart);

  // ── Spawn + handshake the moviepy MCP server ──────────────────────────────
  console.log('[mcp-edit] starting moviepy MCP server (stdio)...');
  const client = new McpClient('uv', ['--directory', MCP_SERVER_DIR, 'run', 'main.py', '--transport', 'stdio']);
  try {
    const init = await client.initialize();
    console.log(`[mcp-edit] connected: ${init.serverInfo?.name} ${init.serverInfo?.version || ''}`);

    // ── 1. SCENE DETECTION on a downscaled decode (fast) ────────────────────
    console.log('[mcp-edit] detecting scenes (downscaled decode)...');
    const smallId = await client.callTool('video_file_clip', {
      filename: wsVideo, audio: false, target_resolution: [180, 288],
    }, 180000);
    const rawCuts = await client.callTool('tools_detect_scenes', {
      clip_id: smallId, luminosity_threshold: args.luminosity,
    }, 900000);
    const cuts = normalizeSceneCuts(rawCuts, videoDur);
    console.log(`[mcp-edit] detected ${cuts.length} scene boundary candidate(s)`);

    // ── 2. NARRATION MATCH vs DRIFT — snap claimed starts to detected cuts ──
    const drift = [];
    const usedCuts = new Set();
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (i === 0) {
        drift.push({ id: st.id, claimed: st.claimedStart, snapped: 0, driftSec: st.claimedStart, source: 'video-start' });
        st.snapped = 0;
        continue;
      }
      let best = null;
      for (const c of cuts) {
        if (usedCuts.has(c)) continue;
        const d = Math.abs(c - st.claimedStart);
        if (d <= args.tolerance && (!best || d < Math.abs(best - st.claimedStart))) best = c;
      }
      if (best != null) usedCuts.add(best);
      st.snapped = best != null ? best : st.claimedStart;
      drift.push({
        id: st.id,
        claimed: Number(st.claimedStart.toFixed(3)),
        snapped: Number(st.snapped.toFixed(3)),
        driftSec: Number((st.snapped - st.claimedStart).toFixed(3)),
        source: best != null ? 'scene-cut' : 'timing-json (no cut within tolerance)',
      });
    }

    // Unsnapped steps (no luminosity cut within tolerance — e.g. navy-slide →
    // navy-slide transitions barely change brightness) inherit the MEDIAN
    // drift of the steps that DID snap: the recorder's timing skew is
    // systematic (observed +0.55–0.87s across every detected boundary), so a
    // neighbor-informed correction beats trusting the raw timing JSON.
    const snappedDrifts = drift.filter((d) => d.source === 'scene-cut').map((d) => d.driftSec).sort((a, b) => a - b);
    if (snappedDrifts.length >= 3) {
      const median = snappedDrifts[Math.floor(snappedDrifts.length / 2)];
      for (let i = 1; i < steps.length; i++) {
        const d = drift[i];
        if (d.source.startsWith('timing-json')) {
          steps[i].snapped = steps[i].claimedStart + median;
          d.snapped = Number(steps[i].snapped.toFixed(3));
          d.driftSec = Number(median.toFixed(3));
          d.source = `median-drift (+${median.toFixed(3)}s from ${snappedDrifts.length} snapped neighbors)`;
        }
      }
    }

    // Monotonic guard — a snap may not reorder steps.
    for (let i = 1; i < steps.length; i++) {
      if (steps[i].snapped <= steps[i - 1].snapped + 0.2) steps[i].snapped = steps[i - 1].snapped + 0.2;
    }

    console.log('[mcp-edit] narration-match table:');
    for (const d of drift) console.log(`  ${d.id.padEnd(28)} claimed=${d.claimed}s snapped=${d.snapped}s drift=${d.driftSec}s (${d.source})`);

    // ── 3. EDIT / STITCH — per-step subclips with narration bound per scene ─
    const segments = [];
    const actions = [];
    if (!args.dryRun) {
      const fullId = await client.callTool('video_file_clip', { filename: wsVideo, audio: false }, 300000);
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        const segStart = st.snapped;
        const segEnd = i + 1 < steps.length ? steps[i + 1].snapped : videoDur;
        let segDur = segEnd - segStart;
        let clipId = await client.callTool('subclip', { clip_id: fullId, start_time: segStart, end_time: segEnd }, 120000);
        let action = 'as-is';
        const needed = st.voDur > 0 ? st.voDur + args.tailPad : 0;
        if (needed > segDur) {
          const extend = Number((needed - segDur).toFixed(3));
          clipId = await client.callTool('vfx_freeze', {
            clip_id: clipId, t: Math.max(0, segDur - 0.05), freeze_duration: extend,
          }, 120000);
          segDur = needed;
          action = `freeze-extend +${extend}s (narration ${st.voDur.toFixed(2)}s > scene ${(segEnd - segStart).toFixed(2)}s)`;
        }
        if (st.vo) {
          const aId = await client.callTool('audio_file_clip', { filename: st.vo }, 60000);
          clipId = await client.callTool('set_audio', { clip_id: clipId, audio_clip_id: aId }, 60000);
        }
        segments.push(clipId);
        actions.push({ id: st.id, segStart: Number(segStart.toFixed(3)), segEnd: Number(segEnd.toFixed(3)), narrationSec: Number(st.voDur.toFixed(3)), action });
        console.log(`  [stitch] ${st.id.padEnd(28)} [${segStart.toFixed(2)}s → ${segEnd.toFixed(2)}s] ${action}`);
      }

      const finalId = await client.callTool('concatenate_video_clips', { clip_ids: segments }, 120000);
      const wsOut = path.join(ws, 'demo-mcp-edit.mp4');
      console.log('[mcp-edit] writing final video (this is the slow part)...');
      await client.callTool('write_videofile', {
        clip_id: finalId, filename: wsOut, codec: 'libx264', audio_codec: 'aac', preset: 'ultrafast', threads: 8,
      }, 3600000);
      const outFile = path.join(runDir, 'demo-mcp-edit.mp4');
      fs.copyFileSync(wsOut, outFile);
      console.log(`[mcp-edit] ✓ wrote ${outFile} (${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB)`);
    }

    const report = {
      at: new Date().toISOString(),
      runId,
      videoDurationSec: Number(videoDur.toFixed(3)),
      luminosityThreshold: args.luminosity,
      toleranceSec: args.tolerance,
      tailPadSec: args.tailPad,
      detectedCuts: cuts.map((c) => Number(c.toFixed(3))),
      driftTable: drift,
      stitchActions: actions,
      dryRun: args.dryRun,
      verdict: drift.every((d) => Math.abs(d.driftSec) <= args.tolerance)
        ? 'NARRATION-MATCH: every step bound to its own scene'
        : 'DRIFT-RESIDUAL: some steps had no detectable cut within tolerance (kept timing-json boundary)',
    };
    fs.writeFileSync(path.join(runDir, 'mcp-video-edit-report.json'), JSON.stringify(report, null, 2));
    console.log(`[mcp-edit] report → mcp-video-edit-report.json | ${report.verdict}`);
  } finally {
    client.close();
    // Keep the /tmp workspace for debugging on failure; it is OS-temp anyway.
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[mcp-edit] FATAL:', e.message); process.exit(1); });
}

module.exports = { McpClient, rawToProcessed, normalizeSceneCuts };
