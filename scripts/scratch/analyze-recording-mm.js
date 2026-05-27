#!/usr/bin/env node
'use strict';
/**
 * analyze-recording-mm.js
 *
 * Multi-modal QA pass on the rendered demo-scratch.mp4. Samples one frame
 * at the midpoint of every narration segment, pairs each frame with the
 * narration that plays during that window, and asks Claude Sonnet Vision
 * for a unified report — which segments match the audio, which drift, and
 * what timestamps the mismatches occur at.
 *
 * Different from `scene-match-check.js` (which scores each segment
 * independently with Haiku and emits per-segment booleans):
 *   • Uses a stronger model (Sonnet) for end-to-end narrative reasoning.
 *   • One conversation with all frames + the full narration timeline as
 *     context, so the analyzer can spot drift patterns the per-segment
 *     pass misses (e.g. "frames 4–6 are stuck on the same UI while
 *     narration moves forward").
 *   • Outputs a human-readable error log keyed to compositional timestamps
 *     (mm:ss), not just step ids.
 *
 * Usage:
 *   node scripts/scratch/analyze-recording-mm.js [--run=<run-id>]
 *   PIPELINE_RUN_DIR=… node scripts/scratch/analyze-recording-mm.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

function resolveRunDir(argv) {
  for (const a of argv) {
    if (a.startsWith('--run=')) return path.join(PROJECT_ROOT, 'out', 'demos', a.slice('--run='.length));
  }
  if (process.env.PIPELINE_RUN_DIR) return process.env.PIPELINE_RUN_DIR;
  // Fallback: most recent demo dir.
  const demosDir = path.join(PROJECT_ROOT, 'out', 'demos');
  const dirs = fs.readdirSync(demosDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, mtime: fs.statSync(path.join(demosDir, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (dirs.length === 0) throw new Error('No runs found under out/demos/');
  return path.join(demosDir, dirs[0].name);
}

function safeReadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function extractFrame(videoPath, timeSec, outPath) {
  const r = spawnSync('ffmpeg', [
    '-ss', String(Math.max(0, timeSec)),
    '-i', videoPath,
    '-vframes', '1',
    '-q:v', '3',
    '-y',
    outPath,
  ], { encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(outPath);
}

function pickFinalVideo(runDir) {
  for (const p of [
    path.join(runDir, 'demo-scratch.mp4'),
    path.join(runDir, 'public', 'demo-scratch.mp4'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function buildSystemPrompt() {
  return [
    'You are reviewing a rendered Plaid product demo video for QA defects.',
    '',
    'You will be given:',
    '  • The narration that plays for each segment, with its start and end timestamps in the final video.',
    '  • One frame from the midpoint of each segment.',
    '',
    'For each segment, decide whether the frame correctly depicts what the narration is describing AT THAT MOMENT.',
    '  • MATCH: the frame clearly shows the content the narration is talking about (UI, API response, decision, number).',
    '  • PARTIAL: the right step is on screen but a specific concrete claim (a number, a decision word, a product name) in the narration is not evidenced.',
    '  • WRONG-STEP: the frame shows a different step — previous, next, or a transition.',
    '  • FROZEN: the frame is identical to neighbours over multiple seconds while narration moves forward (stale freeze).',
    '',
    'Then return STRICT JSON with this shape:',
    '{',
    '  "overallVerdict": "good" | "partial" | "broken",',
    '  "highestImpactDefect": "<one sentence on the worst defect, or null>",',
    '  "segments": [',
    '    {',
    '      "stepId": "<id>",',
    '      "compStart": "mm:ss",',
    '      "compEnd": "mm:ss",',
    '      "verdict": "MATCH|PARTIAL|WRONG-STEP|FROZEN",',
    '      "frameDescribes": "<brief — 1 short sentence on what the frame actually shows>",',
    '      "narrationClaims": "<brief — 1 short sentence on what the narration says>",',
    '      "defect": "<one short sentence describing the mismatch, or null on MATCH>"',
    '    }',
    '  ],',
    '  "patternsAcrossSegments": ["<one-line patterns the per-segment view misses, ≤4 items>"]',
    '}',
    '',
    'Return ONLY the JSON. No commentary outside the JSON block.',
  ].join('\n');
}

function buildUserContent(segments, framesB64) {
  const content = [];
  content.push({
    type: 'text',
    text: [
      `Final video duration: ${fmtTime(segments[segments.length - 1].compEndMs)} (mm:ss).`,
      'Below are the narration segments in temporal order. Each is followed by a single mid-segment frame.',
      '',
    ].join('\n'),
  });
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    content.push({
      type: 'text',
      text:
        `Segment ${i + 1}/${segments.length}  ·  step: ${s.stepId}  ·  ${fmtTime(s.compStartMs)} → ${fmtTime(s.compEndMs)}\n` +
        `Narration playing here: "${(s.narration || '').replace(/\s+/g, ' ').trim()}"`,
    });
    if (framesB64[i]) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: framesB64[i] },
      });
    }
  }
  return [{ role: 'user', content }];
}

function parseJsonResponse(text) {
  if (!text) return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

async function main() {
  const runDir = resolveRunDir(process.argv.slice(2));
  const video = pickFinalVideo(runDir);
  if (!video) {
    console.error(`[mm-qa] No demo-scratch.mp4 found under ${runDir}`);
    process.exit(1);
  }
  const manifest = safeReadJson(path.join(runDir, 'voiceover-manifest.json'));
  const demoScript = safeReadJson(path.join(runDir, 'demo-script.json'));
  if (!manifest || !Array.isArray(manifest.clips) || manifest.clips.length === 0) {
    console.error('[mm-qa] voiceover-manifest.json missing or empty.');
    process.exit(1);
  }

  const narrationByStep = new Map(
    (demoScript?.steps || []).map((s) => [s.id, s.narration || ''])
  );

  // Build segment list from manifest, with mid-window frame timestamps.
  const segments = manifest.clips.map((c) => {
    const stepId = c.stepId || c.id;
    const compStartMs = Number(c.compStartMs ?? c.startMs ?? 0);
    const compEndMs = Number(c.compEndMs ?? c.endMs ?? 0);
    const midMs = compStartMs + (compEndMs - compStartMs) / 2;
    return {
      stepId,
      compStartMs,
      compEndMs,
      midMs,
      narration: narrationByStep.get(stepId) || c.text || '',
    };
  });

  console.log(`[mm-qa] Analyzing ${path.relative(PROJECT_ROOT, video)} — ${segments.length} segment(s).`);

  const framesDir = path.join(runDir, 'mm-qa-frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const framesB64 = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const out = path.join(framesDir, `${String(i + 1).padStart(2, '0')}-${s.stepId}.png`);
    const ok = extractFrame(video, s.midMs / 1000, out);
    if (!ok) {
      console.warn(`[mm-qa] Could not extract frame at ${fmtTime(s.midMs)} for ${s.stepId}`);
      framesB64.push(null);
      continue;
    }
    framesB64.push(fs.readFileSync(out).toString('base64'));
    console.log(`  ${String(i + 1).padStart(2)}. ${s.stepId.padEnd(34)} ${fmtTime(s.compStartMs)} → ${fmtTime(s.compEndMs)}  mid=${fmtTime(s.midMs)}`);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[mm-qa] ANTHROPIC_API_KEY not set.');
    process.exit(1);
  }
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const system = buildSystemPrompt();
  const messages = buildUserContent(segments, framesB64);
  const model = process.env.MM_QA_MODEL || 'claude-sonnet-4-6';

  console.log(`\n[mm-qa] Sending to ${model} (${segments.length} frames + narration timeline)...`);
  const resp = await client.messages.create({
    model,
    max_tokens: 4000,
    system,
    messages,
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJsonResponse(text);

  const reportPath = path.join(runDir, 'recording-mm-qa-report.json');
  const report = {
    generatedAt: new Date().toISOString(),
    video: path.relative(runDir, video),
    model,
    segmentCount: segments.length,
    raw: text,
    parsed,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n[mm-qa] Wrote ${path.relative(PROJECT_ROOT, reportPath)}\n`);

  if (parsed) {
    console.log(`Overall: ${parsed.overallVerdict?.toUpperCase() || '?'}`);
    if (parsed.highestImpactDefect) console.log(`Highest-impact defect: ${parsed.highestImpactDefect}\n`);
    if (Array.isArray(parsed.segments)) {
      console.log('Per-segment:');
      const verdictIcon = (v) => ({ MATCH: '✓', PARTIAL: '~', 'WRONG-STEP': '✗', FROZEN: '❄' }[String(v).toUpperCase()] || '?');
      for (const s of parsed.segments) {
        console.log(`  ${verdictIcon(s.verdict)} ${String(s.compStart).padEnd(5)} ${String(s.stepId || '?').padEnd(34)} ${String(s.verdict || '').padEnd(12)} — ${(s.defect || s.frameDescribes || '').slice(0, 90)}`);
      }
    }
    if (Array.isArray(parsed.patternsAcrossSegments) && parsed.patternsAcrossSegments.length) {
      console.log('\nPatterns across segments:');
      for (const p of parsed.patternsAcrossSegments) console.log(`  • ${p}`);
    }
  } else {
    console.log('Could not parse JSON response. Raw:\n');
    console.log(text);
  }
}

main().catch((err) => {
  console.error(`[mm-qa] Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
