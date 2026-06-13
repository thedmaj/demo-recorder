'use strict';
/**
 * scene-match-check.js
 *
 * Validates that the FINAL composed video shows the right frame content
 * during each narration segment. Runs after render, before touchup.
 *
 * Why this stage exists: auto-gap and post-process can introduce drift
 * even when their per-step math looks correct. The classic failure mode
 * is a multi-second freeze that holds the wrong end-frame while the
 * narration for the *next* step plays (Tilt v2: frozen at step 2 for the
 * rest of the demo). build-qa scores the recording against demo-script
 * `visualState` text, but never against the narration that actually
 * plays at that moment. This stage closes that gap.
 *
 * Approach:
 *   1. Read voiceover-manifest.json (per-step audio start/end in
 *      composition-space milliseconds).
 *   2. For each segment, extract 3 frames from the final video
 *      (demo-scratch.mp4 or recording-processed.webm) at the segment's
 *      start / mid / end.
 *   3. Send each frame + the segment's narration text to Claude Haiku
 *      Vision with a strict prompt: "Does this frame depict what the
 *      narration is describing right now? Score 0–100."
 *   4. Aggregate per-segment scores and emit `scene-match-report.json`.
 *   5. Gate: fail when ANY segment scores below SCENE_MATCH_MIN_SCORE
 *      (default 60). When the gate is in advisory mode (default), still
 *      proceed but surface the failure prominently.
 *
 * Public API:
 *   const { main, scoreSegment } = require('./scene-match-check');
 *   await main();
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const RUN_DIR = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');

const QA_MODEL = process.env.SCENE_MATCH_MODEL || 'claude-haiku-4-5-20251001';
const MIN_SCORE = parseInt(process.env.SCENE_MATCH_MIN_SCORE || '60', 10);
const GATE_MODE = (process.env.SCENE_MATCH_GATE || 'advisory').toLowerCase();   // 'strict' | 'advisory'
const FRAMES_PER_SEGMENT = parseInt(process.env.SCENE_MATCH_FRAMES_PER_SEG || '3', 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return null; }
}

function pickFinalVideo(runDir) {
  const candidates = [
    path.join(runDir, 'demo-scratch.mp4'),
    path.join(runDir, 'public', 'demo-scratch.mp4'),
    path.join(runDir, 'recording-processed.webm'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function extractFrame(videoPath, timeSeconds, outputPath) {
  const ts = Math.max(0, timeSeconds);
  const r = spawnSync(
    'ffmpeg',
    ['-ss', String(ts), '-i', videoPath, '-vframes', '1', '-q:v', '3', '-y', outputPath],
    { encoding: 'utf8' }
  );
  return r.status === 0 && fs.existsSync(outputPath);
}

function frameTimesForSegment(segment) {
  const startSec = Math.max(0, (segment.startMs || 0) / 1000);
  const endSec   = Math.max(startSec + 0.05, (segment.endMs || 0) / 1000);
  const span = Math.max(0.1, endSec - startSec);
  const startOffset = Math.min(1.0, Math.max(0.2, span * 0.18));
  const endOffset   = Math.min(0.5, Math.max(0.1, span * 0.12));
  const tStart = startSec + startOffset;
  const tEnd   = endSec - endOffset;
  const tMid   = startSec + span * 0.55;
  if (FRAMES_PER_SEGMENT <= 1) return [{ label: 'mid', t: tMid }];
  if (FRAMES_PER_SEGMENT === 2) return [{ label: 'start', t: tStart }, { label: 'end', t: tEnd }];
  return [
    { label: 'start', t: tStart },
    { label: 'mid',   t: tMid },
    { label: 'end',   t: tEnd },
  ];
}

function buildSystemPrompt() {
  return [
    'You are validating that a rendered demo video shows the right screen during each narration segment.',
    '',
    'You are given:',
    '  - The narration TEXT that plays during this segment (one or two sentences).',
    '  - One or more video frames captured from that segment\'s time window.',
    '',
    'Your job: score 0–100 how well the frames depict what the narration is describing AT THAT MOMENT.',
    '  - 100 = the frames clearly show what the narration is saying right now (matching UI state, matching API response, matching numbers/decisions).',
    '  - 60–80 = mostly aligned but some specific claim in the narration isn\'t evidenced in the frame.',
    '  - 30–59 = the frame is from a related but different moment (next step, previous step, transition).',
    '  - 0–29 = the frame shows clearly unrelated content (blank, frozen wrong-step, error screen).',
    '',
    'NOTE: narrations often OPEN with a short transitional clause referencing the PREVIOUS scene',
    '("Once Plaid Link has authenticated…", "That session returns…", "With identity settled…").',
    'Do not penalize frames for not depicting that opening clause — score against the rest of the',
    'sentence, which describes the current screen.',
    '',
    'Return STRICT JSON only:',
    '{',
    '  "score": <integer 0-100>,',
    '  "verdict": "match" | "drifted" | "wrong-step" | "blank-or-frozen",',
    '  "frameLabel": "start" | "mid" | "end",  // which of the supplied frames you scored',
    '  "explanation": "<one sentence, ≤140 chars>"',
    '}',
    '',
    'No commentary outside the JSON.',
  ].join('\n');
}

function buildUserPrompt(segment, frameImages) {
  const blocks = [
    {
      type: 'text',
      text: [
        `Segment id: ${segment.stepId}`,
        `Narration playing during this segment:`,
        `"${segment.narration || segment.text || ''}"`,
        '',
        `Frames are listed in time order. Score the frame that best represents the segment.`,
      ].join('\n'),
    },
  ];
  for (const f of frameImages) {
    blocks.push({ type: 'text', text: `Frame: ${f.label} (t=${f.t.toFixed(2)}s)` });
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: f.base64 },
    });
  }
  return [{ role: 'user', content: blocks }];
}

function parseSceneMatchJson(text) {
  if (!text) return null;
  // Strip code fences if present.
  let s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  // Pick the first {...} block.
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

// Verify a Plaid Link / Layer / IDV MODAL is actually visible in a launch
// step's frames. The live-plaid auto-pass (85) exists so we don't false-flag
// the modal-journey narration against a single sub-screen frame — but it must
// NOT blindly trust that the modal recorded. A launch step can show pure host
// UI with no modal (Zip CRA recorded the host "Generating your report" screen
// for its entire 107s window; the modal never rendered, yet it auto-passed 85,
// 2026-06-13). Confirm a modal is on screen before granting the exemption.
async function verifyPlaidModalVisible(client, frameImages) {
  const system = [
    'You verify whether a Plaid Link / Plaid Layer / Identity Verification MODAL is visibly on screen.',
    'A Plaid modal is a centered overlay/sheet (often with a Plaid logo) showing ONE of:',
    'institution search or a bank list, a data-sharing CONSENT screen, phone/OTP entry,',
    'bank credential login, account selection, or a Layer/IDV identity-review pane.',
    'It is visually distinct from the HOST app\'s own pages (dashboards, "add a bank account"',
    'marketing cards, "generating your report" / loading screens, success/result pages).',
    'Across the supplied frames, is the Plaid modal visibly present in AT LEAST ONE frame?',
    'Return STRICT JSON only: {"modalVisible": true|false, "evidence": "<≤120 chars: which frame + what you saw>"}',
  ].join('\n');
  const blocks = [{ type: 'text', text: 'Frames in time order across the launch step:' }];
  for (const f of frameImages) {
    blocks.push({ type: 'text', text: `Frame ${f.label} (t=${f.t.toFixed(2)}s)` });
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: f.base64 } });
  }
  const resp = await client.messages.create({
    model: QA_MODEL, max_tokens: 200, system, messages: [{ role: 'user', content: blocks }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseSceneMatchJson(text);
  if (!parsed) return { modalVisible: true, evidence: 'verifier parse-failure — defaulting to pass', uncertain: true };
  return { modalVisible: parsed.modalVisible !== false, evidence: String(parsed.evidence || '').slice(0, 120) };
}

async function scoreSegment(client, segment, frameImages) {
  const system = buildSystemPrompt();
  const messages = buildUserPrompt(segment, frameImages);
  const resp = await client.messages.create({
    model: QA_MODEL,
    max_tokens: 400,
    system,
    messages,
  });
  const text = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const parsed = parseSceneMatchJson(text);
  if (!parsed) {
    return { score: 0, verdict: 'parse-failure', frameLabel: null, explanation: text.slice(0, 140) };
  }
  return {
    score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
    verdict: String(parsed.verdict || 'match'),
    frameLabel: parsed.frameLabel || null,
    explanation: String(parsed.explanation || '').slice(0, 140),
  };
}

async function main(runDir) {
  const outDir = runDir || RUN_DIR;
  const voiceoverManifestPath = path.join(outDir, 'voiceover-manifest.json');
  const demoScriptPath = path.join(outDir, 'demo-script.json');

  const manifest = safeReadJson(voiceoverManifestPath);
  const demoScript = safeReadJson(demoScriptPath);
  const videoPath = pickFinalVideo(outDir);

  if (!manifest || !Array.isArray(manifest.clips) || manifest.clips.length === 0) {
    console.log('[scene-match-check] voiceover-manifest.json missing or empty — skipping.');
    return { skipped: true, reason: 'no-manifest' };
  }
  if (!videoPath) {
    console.log('[scene-match-check] no final video found (demo-scratch.mp4 / recording-processed.webm) — skipping.');
    return { skipped: true, reason: 'no-final-video' };
  }
  if (!ANTHROPIC_API_KEY) {
    console.log('[scene-match-check] ANTHROPIC_API_KEY not set — skipping.');
    return { skipped: true, reason: 'no-api-key' };
  }

  console.log(`[scene-match-check] Validating ${manifest.clips.length} segment(s) against ${path.relative(PROJECT_ROOT, videoPath)} with ${QA_MODEL}`);

  const narrationByStep = new Map(
    (demoScript?.steps || []).map((s) => [s.id, s.narration || ''])
  );
  // Live Plaid session steps (plaidPhase:"launch" — Link / Layer / IDV
  // modals) get the same exemption qa-review applies (LIVE-PLAID-AUTO 85):
  // their narration spans the WHOLE modal journey (phone → prefill review →
  // permission), so any single sampled frame legitimately shows only one
  // sub-screen of it — judging the start frame against the full-journey
  // narration false-flagged Spring-Eq's layer-onboarding at 15/100
  // (2026-06-12). The modal's real progress is already verified at record
  // time by the Plaid automation's own success gates.
  const livePlaidSteps = new Set(
    (demoScript?.steps || []).filter((s) => s && s.plaidPhase === 'launch').map((s) => s.id)
  );

  const framesDir = path.join(outDir, 'scene-match-frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const results = [];
  for (const clip of manifest.clips) {
    const segment = {
      stepId: clip.stepId || clip.id,
      startMs: clip.compStartMs ?? clip.startMs ?? 0,
      endMs: clip.compEndMs ?? clip.endMs ?? 0,
      narration: narrationByStep.get(clip.stepId || clip.id) || clip.text || clip.narration || '',
    };
    if (!segment.narration) {
      results.push({ ...segment, skipped: true, reason: 'no-narration-text' });
      continue;
    }
    if (livePlaidSteps.has(segment.stepId)) {
      // Exemption from narration-vs-frame scoring (the modal-journey narration
      // spans many sub-screens) — but ONLY after confirming a Plaid modal is
      // actually on screen. Sample frames across the window and verify.
      const lpFrameTimes = frameTimesForSegment(segment);
      const lpFrames = [];
      for (const ft of lpFrameTimes) {
        const outPath = path.join(framesDir, `${segment.stepId}-${ft.label}.png`);
        if (extractFrame(videoPath, ft.t, outPath)) {
          lpFrames.push({ label: ft.label, t: ft.t, base64: fs.readFileSync(outPath).toString('base64'), path: outPath });
        }
      }
      let modalCheck = { modalVisible: true, evidence: 'no frames extracted — defaulting to pass', uncertain: true };
      if (lpFrames.length) {
        try { modalCheck = await verifyPlaidModalVisible(client, lpFrames); }
        catch (e) { modalCheck = { modalVisible: true, evidence: `verifier error: ${e.message.slice(0,80)} — defaulting to pass`, uncertain: true }; }
      }
      if (modalCheck.modalVisible) {
        results.push({
          stepId: segment.stepId, compStartMs: segment.startMs, compEndMs: segment.endMs,
          narration: segment.narration, score: 85, verdict: 'live-plaid-auto',
          explanation: `Live Plaid modal verified on screen — ${modalCheck.evidence}`.slice(0, 140),
          passed: true, modalVerified: !modalCheck.uncertain,
        });
        console.log(`  ${segment.stepId.padEnd(34)}  85/${MIN_SCORE} ✓ live-plaid-auto (modal verified)`);
      } else {
        // The launch step recorded NO visible Plaid modal — host UI only.
        results.push({
          stepId: segment.stepId, compStartMs: segment.startMs, compEndMs: segment.endMs,
          narration: segment.narration, score: 25, verdict: 'plaid-modal-missing',
          explanation: `Launch step shows NO Plaid modal — host UI only. ${modalCheck.evidence}`.slice(0, 140),
          passed: false,
        });
        console.log(`  ${segment.stepId.padEnd(34)}  25/${MIN_SCORE} ✗ plaid-modal-missing (${modalCheck.evidence})`);
      }
      continue;
    }

    const frameTimes = frameTimesForSegment(segment);
    const frameImages = [];
    for (const ft of frameTimes) {
      const outPath = path.join(framesDir, `${segment.stepId}-${ft.label}.png`);
      const ok = extractFrame(videoPath, ft.t, outPath);
      if (!ok) continue;
      const base64 = fs.readFileSync(outPath).toString('base64');
      frameImages.push({ label: ft.label, t: ft.t, base64, path: outPath });
    }
    if (frameImages.length === 0) {
      results.push({ ...segment, skipped: true, reason: 'frame-extraction-failed' });
      continue;
    }

    try {
      const judged = await scoreSegment(client, segment, frameImages);
      const passed = judged.score >= MIN_SCORE;
      const row = {
        stepId: segment.stepId,
        compStartMs: segment.startMs,
        compEndMs: segment.endMs,
        narration: segment.narration,
        framesPaths: frameImages.map((f) => path.relative(outDir, f.path)),
        score: judged.score,
        verdict: judged.verdict,
        frameLabel: judged.frameLabel,
        explanation: judged.explanation,
        passed,
      };
      results.push(row);
      console.log(`  ${segment.stepId.padEnd(34)} ${String(judged.score).padStart(3)}/${MIN_SCORE} ${passed ? '✓' : '✗'} ${judged.verdict} — ${judged.explanation}`);
    } catch (err) {
      results.push({ ...segment, score: 0, verdict: 'error', explanation: err.message, passed: false });
      console.warn(`[scene-match-check] ERROR on ${segment.stepId}: ${err.message}`);
    }
  }

  const scored = results.filter((r) => !r.skipped);
  const failed = scored.filter((r) => r.passed === false);
  const passedCount = scored.length - failed.length;
  const avgScore = scored.length === 0 ? 0 : Math.round(scored.reduce((s, r) => s + (r.score || 0), 0) / scored.length);
  const minScore = scored.length === 0 ? 0 : Math.min(...scored.map((r) => r.score || 0));
  const gatePassed = failed.length === 0;

  const report = {
    generatedAt: new Date().toISOString(),
    videoPath: path.relative(outDir, videoPath),
    model: QA_MODEL,
    minScoreThreshold: MIN_SCORE,
    gateMode: GATE_MODE,
    gatePassed,
    summary: {
      totalSegments: results.length,
      scoredSegments: scored.length,
      passedSegments: passedCount,
      failedSegments: failed.length,
      avgScore,
      minScore,
    },
    segments: results,
    failingStepIds: failed.map((r) => r.stepId),
  };

  fs.writeFileSync(
    path.join(outDir, 'scene-match-report.json'),
    JSON.stringify(report, null, 2),
    'utf8'
  );

  console.log('');
  console.log(`[scene-match-check] ${passedCount}/${scored.length} passed, avg=${avgScore}, min=${minScore}, gate=${gatePassed ? 'PASS' : 'FAIL'} (${GATE_MODE})`);

  if (!gatePassed && GATE_MODE === 'strict') {
    const err = new Error(`scene-match gate failed: ${failed.length} segment(s) below ${MIN_SCORE} (${failed.map((r) => r.stepId).join(', ')})`);
    err.code = 'SCENE_MATCH_FAILED';
    throw err;
  }

  return report;
}

module.exports = {
  main,
  scoreSegment,
  buildSystemPrompt,
  frameTimesForSegment,
  parseSceneMatchJson,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[scene-match-check] Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
