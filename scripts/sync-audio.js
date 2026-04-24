'use strict';
/**
 * sync-audio.js
 * Diagnoses audio/video drift between voiceover.mp3 and recording.webm,
 * suggests SYNC_MAP_S fixes for ScratchComposition.jsx, and optionally
 * re-stitches the voiceover with corrected offsets.
 *
 * Reads:  {run-dir}/step-timing.json
 *         {run-dir}/voiceover-manifest.json
 *         remotion/ScratchComposition.jsx  (current SYNC_MAP_S)
 *
 * Writes: {run-dir}/sync-report.json
 *
 * Usage:
 *   node scripts/sync-audio.js                          # analyze latest run
 *   node scripts/sync-audio.js --run-dir out/demos/...  # specific run
 *   node scripts/sync-audio.js --no-vision              # skip Claude vision (faster)
 *   node scripts/sync-audio.js --apply                  # write SYNC_MAP_S to composition
 *   node scripts/sync-audio.js --restitch               # re-stitch voiceover.mp3
 */

require('dotenv').config({ override: true });
const Anthropic     = require('@anthropic-ai/sdk');
const fs            = require('fs');
const path          = require('path');
const { spawnSync, execSync } = require('child_process');

// ── Constants ─────────────────────────────────────────────────────────────────

const SYNC_MODEL        = 'claude-opus-4-7';
const SYNC_MAX_TOKENS   = 1024;
const DRIFT_FLAG_MS     = 500;   // flag if |drift| > 500ms
const DRIFT_VISION_MS   = 1000;  // run vision if |drift| > 1s
const DRIFT_SEVERE_MS   = 3000;  // flag "narration too short" if early > 3s

const PROJECT_ROOT      = path.resolve(__dirname, '..');
const COMPOSITION_FILE  = path.join(PROJECT_ROOT, 'remotion', 'ScratchComposition.jsx');

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);

  const runDirArg = args.find(a => a.startsWith('--run-dir='));
  const noVision  = args.includes('--no-vision');
  const apply     = args.includes('--apply');
  const restitch  = args.includes('--restitch');

  let runDir;
  if (runDirArg) {
    runDir = path.resolve(runDirArg.replace('--run-dir=', ''));
  } else {
    // Resolve from out/latest symlink
    const latestLink = path.join(PROJECT_ROOT, 'out', 'latest');
    if (fs.existsSync(latestLink)) {
      try {
        runDir = fs.realpathSync(latestLink);
      } catch (_) {
        runDir = path.join(PROJECT_ROOT, 'out');
      }
    } else {
      runDir = path.join(PROJECT_ROOT, 'out');
    }
  }

  return { runDir, noVision, apply, restitch };
}

// ── Frame extraction ──────────────────────────────────────────────────────────

function extractFrame(videoPath, timeSeconds, outputPath) {
  const ts = Math.max(0, timeSeconds);
  const result = spawnSync(
    'ffmpeg',
    [
      '-ss', String(ts),
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      '-y',
      outputPath,
    ],
    { encoding: 'utf8' }
  );

  if (result.status !== 0 || !fs.existsSync(outputPath)) {
    console.warn(`[Sync] Frame extraction failed at ${ts}s: ${(result.stderr || '').substring(0, 200)}`);
    return false;
  }
  return true;
}

// ── Parse current SYNC_MAP_S from ScratchComposition.jsx ─────────────────────

function parseSyncMapFromComposition() {
  if (!fs.existsSync(COMPOSITION_FILE)) {
    return [];
  }
  const src = fs.readFileSync(COMPOSITION_FILE, 'utf8');
  const match = src.match(/const SYNC_MAP_S\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return [];

  try {
    // Strip JS comments before parsing as JSON-like
    const stripped = match[1]
      .replace(/\/\/[^\n]*/g, '')   // remove line comments
      .replace(/,\s*]/g, ']')       // trailing commas
      .replace(/,\s*}/g, '}');
    // Use Function to evaluate the array (safe — internal file only)
    // eslint-disable-next-line no-new-func
    return new Function(`return ${stripped}`)();
  } catch (err) {
    console.warn(`[Sync] Could not parse SYNC_MAP_S from composition: ${err.message}`);
    return [];
  }
}

// ── Claude vision assessment ──────────────────────────────────────────────────

/**
 * Sends two frames to Claude Sonnet to check if narration matches the visual state.
 * Returns { match: bool, confidence: 'high'|'medium'|'low', note: string }
 */
async function assessSyncWithVision(client, stepId, narration, audioEndFramePath, videoEndFramePath) {
  const frames = [audioEndFramePath, videoEndFramePath].filter(p => p && fs.existsSync(p));
  if (frames.length === 0) {
    return { match: true, confidence: 'low', note: 'No frames available for assessment' };
  }

  const imageContent = frames.map((framePath, i) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: fs.readFileSync(framePath).toString('base64'),
    },
  }));

  const labels = ['Frame at audio end', 'Frame at video step end'];

  const response = await client.messages.create({
    model:      SYNC_MODEL,
    max_tokens: SYNC_MAX_TOKENS,
    system:     'You are a sync QA engineer reviewing demo video production. Determine if the narration text matches the visual state shown in the provided frames. Respond with JSON only: { "match": boolean, "confidence": "high"|"medium"|"low", "note": "brief explanation" }',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Step: ${stepId}\nNarration: "${narration}"\n\nFrame 1 (${labels[0]}) and Frame 2 (${labels[1] || labels[0]}) are provided below. Does the narration match the screen content? If the frames show different things, does that indicate a sync problem?`,
          },
          ...imageContent,
        ],
      },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) return { match: true, confidence: 'low', note: 'No text in response' };

  const raw = textBlock.text;

  // Extract JSON
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { match: true, confidence: 'low', note: raw.substring(0, 100) };

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (_) {
    return { match: true, confidence: 'low', note: raw.substring(0, 100) };
  }
}

// ── Main analysis ─────────────────────────────────────────────────────────────

async function main() {
  const { runDir, noVision, apply, restitch } = parseArgs();

  // ── Validate inputs ────────────────────────────────────────────────────────

  const timingFile   = path.join(runDir, 'step-timing.json');
  const manifestFile = path.join(runDir, 'voiceover-manifest.json');
  const recordingFile = path.join(runDir, 'recording.webm');

  if (!fs.existsSync(timingFile)) {
    console.error(`[Sync] Missing: ${timingFile}\n  Run record-local.js first, or specify --run-dir`);
    process.exit(1);
  }
  if (!fs.existsSync(manifestFile)) {
    console.error(`[Sync] Missing: ${manifestFile}\n  Run generate-voiceover.js first`);
    process.exit(1);
  }

  const timing   = JSON.parse(fs.readFileSync(timingFile,   'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  // Build lookups
  const timingByStep   = {};
  for (const s of (timing.steps || [])) timingByStep[s.id] = s;

  const clipByStep = {};
  for (const c of (manifest.clips || [])) clipByStep[c.id] = c;

  // Run name for display
  const runName = path.basename(runDir);
  console.log(`\n🎙 Audio Sync Report — ${runName}`);
  console.log('━'.repeat(50));

  const hasRecording = fs.existsSync(recordingFile);
  if (!hasRecording && !noVision) {
    console.warn('[Sync] No recording.webm found — vision assessment disabled');
  }

  // ── Phase 2: Per-step drift calculation ───────────────────────────────────

  const allStepIds = [...new Set([
    ...Object.keys(timingByStep),
    ...Object.keys(clipByStep),
  ])];

  const stepResults = [];
  const framesDir   = path.join(runDir, 'sync-frames');
  if (!noVision && hasRecording) {
    fs.mkdirSync(framesDir, { recursive: true });
  }

  const client = (!noVision && process.env.ANTHROPIC_API_KEY)
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;

  for (const id of allStepIds) {
    const timing_step = timingByStep[id];
    const clip        = clipByStep[id];

    if (!timing_step || !clip) {
      console.log(`  [skip] ${id} — missing timing or clip data`);
      continue;
    }

    const videoEndMs = timing_step.endMs;
    const audioEndMs = clip.startMs + clip.audioDurationMs;
    const driftMs    = audioEndMs - videoEndMs;
    const absDrift   = Math.abs(driftMs);

    const driftType = driftMs > 0 ? 'late' : driftMs < 0 ? 'early' : 'ok';
    const flagged   = absDrift > DRIFT_FLAG_MS;
    const severe    = driftMs < -DRIFT_SEVERE_MS;

    // Build status emoji and label
    let statusIcon, statusLabel;
    if (!flagged) {
      statusIcon  = '✅';
      statusLabel = 'OK';
    } else if (driftType === 'late') {
      statusIcon  = absDrift > 1500 ? '❌' : '⚠️ ';
      statusLabel = `LATE   (+${(driftMs / 1000).toFixed(1)}s — audio overlaps)`;
    } else {
      statusIcon  = severe ? '⚠️ ' : '✅';
      statusLabel = severe
        ? `EARLY  (${(driftMs / 1000).toFixed(1)}s — narration may be too short)`
        : `OK     (${(driftMs / 1000).toFixed(1)}s early)`;
    }

    const label = timing_step.label || id;
    const padId = `${statusIcon} ${id}`.padEnd(48, ' ');
    console.log(`${padId} ${statusLabel}`);

    // ── Phase 3: Vision assessment for significantly flagged steps ───────────

    let visionAssessment = null;
    const needsVision = !noVision && hasRecording && client && absDrift > DRIFT_VISION_MS;

    if (needsVision) {
      // Extract 2 frames: one at audio end, one at video step end
      const audioEndS = audioEndMs / 1000;
      const videoEndS = videoEndMs / 1000;

      const audioFramePath = path.join(framesDir, `${id}-audio-end.png`);
      const videoFramePath = path.join(framesDir, `${id}-video-end.png`);

      const audioOk = extractFrame(recordingFile, audioEndS, audioFramePath);
      const videoOk = extractFrame(recordingFile, videoEndS, videoFramePath);

      if (audioOk || videoOk) {
        try {
          visionAssessment = await assessSyncWithVision(
            client,
            id,
            clip.script || '',
            audioOk ? audioFramePath : null,
            videoOk ? videoFramePath : null
          );

          if (!visionAssessment.match && visionAssessment.confidence === 'high') {
            console.log(`       ❌ Vision: MISMATCH — ${visionAssessment.note}`);
          } else if (!visionAssessment.match) {
            console.log(`       ⚠️  Vision: possible mismatch — ${visionAssessment.note}`);
          }
        } catch (err) {
          console.warn(`       [vision] Failed for ${id}: ${err.message}`);
        }
      }
    }

    // ── Phase 4: Suggest SYNC_MAP_S entry ───────────────────────────────────

    let suggestedSyncMapEntry = null;
    let suggestion = null;

    if (driftType === 'late' && absDrift > DRIFT_FLAG_MS) {
      const stepEndS = videoEndMs / 1000;
      const freezeEndS = (videoEndMs + driftMs) / 1000;
      suggestedSyncMapEntry = {
        compStart:  Math.round(stepEndS * 10) / 10,
        compEnd:    Math.round(freezeEndS * 10) / 10,
        videoStart: Math.round(stepEndS * 10) / 10,
        mode:       'freeze',
      };
      suggestion = `freeze for ${(driftMs / 1000).toFixed(1)}s at step boundary`;
    } else if (severe) {
      suggestion = 'narration may be too short for this step — consider expanding script';
    }

    const isCritical = (visionAssessment && !visionAssessment.match && visionAssessment.confidence === 'high');

    stepResults.push({
      id,
      label,
      videoEndMs,
      audioEndMs,
      driftMs,
      driftType,
      flagged,
      critical: isCritical,
      visionAssessment,
      suggestion,
      suggestedSyncMapEntry,
    });
  }

  // ── Build merged SYNC_MAP_S ────────────────────────────────────────────────

  const existingEntries = parseSyncMapFromComposition();

  // Collect new entries from flagged steps, avoiding duplicates
  const newEntries = stepResults
    .filter(s => s.suggestedSyncMapEntry)
    .map(s => s.suggestedSyncMapEntry);

  // Merge: keep existing entries that don't overlap with new suggestions,
  // then add new entries, sort by compStart
  const merged = [...existingEntries];
  for (const entry of newEntries) {
    const hasOverlap = merged.some(e =>
      e.compStart < entry.compEnd && e.compEnd > entry.compStart
    );
    if (!hasOverlap) {
      merged.push(entry);
    }
  }
  merged.sort((a, b) => a.compStart - b.compStart);

  // Format as JS
  const suggestedSyncMapJs = merged.length > 0
    ? `const SYNC_MAP_S = [\n${merged.map(e => {
        const base = `  { compStart: ${e.compStart}, compEnd: ${e.compEnd}, videoStart: ${e.videoStart}, mode: '${e.mode}'`;
        const speed = e.speed != null ? `, speed: ${e.speed}` : '';
        return base + speed + ' },';
      }).join('\n')}\n];`
    : 'const SYNC_MAP_S = [];';

  // ── Console summary ────────────────────────────────────────────────────────

  const flaggedSteps = stepResults.filter(s => s.flagged);
  const criticalSteps = stepResults.filter(s => s.critical);
  const overallStatus = flaggedSteps.length > 0 ? 'needs-adjustment' : 'ok';

  console.log('\n' + '━'.repeat(50));

  if (newEntries.length > 0) {
    console.log('\nSuggested SYNC_MAP_S additions (paste into ScratchComposition.jsx):');
    for (const entry of newEntries) {
      const base = `  { compStart: ${entry.compStart}, compEnd: ${entry.compEnd}, videoStart: ${entry.videoStart}, mode: '${entry.mode}'`;
      const speed = entry.speed != null ? `, speed: ${entry.speed}` : '';
      console.log(base + speed + ' },');
    }
  } else if (flaggedSteps.length === 0) {
    console.log('\n✅ All steps within sync tolerance. No adjustments needed.');
  } else {
    console.log('\n⚠️  Drift detected but no freeze entries generated (check early-drift steps).');
  }

  if (flaggedSteps.length > 0 && !apply && !restitch) {
    console.log('\nRun with --apply to write SYNC_MAP_S automatically.');
    console.log('Run with --restitch to re-stitch voiceover.mp3 with updated timing.');
  }

  // ── Phase 5: Write sync-report.json ───────────────────────────────────────

  const report = {
    checkedAt:         new Date().toISOString(),
    runDir,
    overallStatus,
    flaggedCount:      flaggedSteps.length,
    criticalCount:     criticalSteps.length,
    steps:             stepResults,
    suggestedSyncMap:  merged,
    suggestedSyncMapJs,
  };

  const reportPath = path.join(runDir, 'sync-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n[Sync] Written: ${reportPath}`);

  // ── --apply mode ──────────────────────────────────────────────────────────

  if (apply) {
    if (merged.length === 0) {
      console.log('[Sync] Nothing to apply — SYNC_MAP_S is empty.');
    } else if (!fs.existsSync(COMPOSITION_FILE)) {
      console.error(`[Sync] --apply: composition file not found: ${COMPOSITION_FILE}`);
      process.exit(1);
    } else {
      const src = fs.readFileSync(COMPOSITION_FILE, 'utf8');
      const mapRegex = /const SYNC_MAP_S\s*=\s*\[[\s\S]*?\];/;
      if (!mapRegex.test(src)) {
        console.error('[Sync] --apply: could not find SYNC_MAP_S in ScratchComposition.jsx');
        process.exit(1);
      }
      const updated = src.replace(mapRegex, suggestedSyncMapJs);
      fs.writeFileSync(COMPOSITION_FILE, updated, 'utf8');
      console.log('[Sync] Updated ScratchComposition.jsx — restart Remotion Studio to see changes.');
    }
  }

  // ── --restitch mode ───────────────────────────────────────────────────────

  if (restitch) {
    console.log('\n[Sync] Re-stitching voiceover.mp3...');

    const voiceoverScript = path.join(PROJECT_ROOT, 'scripts', 'generate-voiceover.js');
    if (!fs.existsSync(voiceoverScript)) {
      console.error(`[Sync] --restitch: generate-voiceover.js not found at ${voiceoverScript}`);
      process.exit(1);
    }

    const result = spawnSync(
      process.execPath,
      [voiceoverScript, '--scratch'],
      {
        cwd:     PROJECT_ROOT,
        env:     { ...process.env, PIPELINE_RUN_DIR: runDir },
        stdio:   'inherit',
        encoding: 'utf8',
      }
    );

    if (result.status !== 0) {
      console.error('[Sync] --restitch: generate-voiceover.js failed');
      process.exit(1);
    }

    // Stage artifacts for Remotion
    console.log('[Sync] Staging updated voiceover.mp3 → public/');
    const publicDir  = path.join(PROJECT_ROOT, 'public');
    const voiceoverSrc = path.join(runDir, 'audio', 'voiceover.mp3');
    if (fs.existsSync(voiceoverSrc)) {
      fs.mkdirSync(publicDir, { recursive: true });
      fs.copyFileSync(voiceoverSrc, path.join(publicDir, 'voiceover.mp3'));
      console.log('[Sync] ✓ voiceover.mp3 staged — refresh Remotion Studio preview to hear changes.');
    } else {
      console.warn(`[Sync] voiceover.mp3 not found at ${voiceoverSrc}`);
    }
  }

  return report;
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('[Sync] Fatal error:', err.message);
  process.exit(1);
});
