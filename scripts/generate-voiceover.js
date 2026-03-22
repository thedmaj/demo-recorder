#!/usr/bin/env node
/**
 * generate-voiceover.js
 * Generates per-step voiceover audio using ElevenLabs TTS, then stitches
 * the clips into a single timed voiceover.mp3 using ffmpeg — perfectly
 * synchronized with the recorded video.
 *
 * Reads:  out/step-timing.json  (produced by record-idv.js)
 * Writes: public/voiceover.mp3  (final stitched audio)
 *         out/voiceover-manifest.json  (per-step audio metadata for Remotion)
 *
 * Usage: node scripts/generate-voiceover.js
 */

require('dotenv').config({ override: true });
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { processedToCompMs, loadSyncMap } = require('./sync-map-utils');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set in .env');
const VOICE_ID  = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb'; // George (default)
const MODEL_ID  = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
// Highest-quality output: 192kbps MP3 at 44.1kHz. ElevenLabs supports output_format
// as a query param on the TTS endpoint. Falls back gracefully if not supported.
const OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_192';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR      = process.env.PIPELINE_RUN_DIR || path.resolve(__dirname, '../out');
const TIMING_FILE           = path.join(OUT_DIR, 'step-timing.json');
const PROCESSED_TIMING_FILE = path.join(OUT_DIR, 'processed-step-timing.json');
const MANIFEST_FILE = path.join(OUT_DIR, 'voiceover-manifest.json');
const AUDIO_DIR    = path.join(OUT_DIR, 'audio');

fs.mkdirSync(OUT_DIR,    { recursive: true });
fs.mkdirSync(AUDIO_DIR,  { recursive: true });

// ── Voiceover sync pre-flight ─────────────────────────────────────────────────
// If recording-processed.webm exists (post-process ran), processed-step-timing.json
// MUST also exist and must be newer than step-timing.json. If the timing file is
// absent or stale, voiceover will be timed to the raw recording — every narration
// clip will be offset by the amount of content cut in post-process, desynchronizing
// audio from video in the final render.
{
  const processedRecording = path.join(OUT_DIR, 'recording-processed.webm');
  const processedTimingFile = PROCESSED_TIMING_FILE;

  if (fs.existsSync(processedRecording)) {
    if (!fs.existsSync(processedTimingFile)) {
      console.error(
        '[Voiceover] CRITICAL: recording-processed.webm exists but processed-step-timing.json is missing.\n' +
        '[Voiceover] Run post-process-recording.js first to regenerate it, or voiceover will be desynchronized.'
      );
      process.exit(1);
    }

    // Also check that processed-step-timing.json is newer than step-timing.json
    // (a stale processed timing file from a previous run would cause desync)
    const rawTimingFile = TIMING_FILE;
    if (fs.existsSync(rawTimingFile)) {
      const rawMtime       = fs.statSync(rawTimingFile).mtimeMs;
      const processedMtime = fs.statSync(processedTimingFile).mtimeMs;
      if (processedMtime < rawMtime) {
        console.error(
          'CRITICAL: processed-step-timing.json is older than step-timing.json.\n' +
          '[Voiceover] Re-run post-process-recording.js first, or voiceover timing will be desynchronized.'
        );
        process.exit(1);
      }
    }
  }
}

// ── Voiceover script source ────────────────────────────────────────────────────
// When --scratch flag is passed, narrations are loaded from out/demo-script.json
// (produced by the scratch pipeline). Otherwise falls back to the hardcoded IDV scripts.

const USE_SCRATCH = process.argv.includes('--scratch');
const DEMO_SCRIPT_PATH = path.join(OUT_DIR, 'demo-script.json');

function loadVoiceoverScripts() {
  if (USE_SCRATCH && fs.existsSync(DEMO_SCRIPT_PATH)) {
    const script = JSON.parse(fs.readFileSync(DEMO_SCRIPT_PATH, 'utf8'));
    const scripts = Object.fromEntries(
      (script.steps || [])
        .filter(s => s.narration)
        .map(s => [s.id, s.narration])
    );
    console.log(`Loaded ${Object.keys(scripts).length} voiceover scripts from demo-script.json\n`);
    return scripts;
  }
  return null; // use hardcoded scripts below
}

const _scratchScripts = loadVoiceoverScripts();

// ── Narration content QA ──────────────────────────────────────────────────────
// Validates that each step's narration is semantically consistent with the
// step's visualState and label. Catches mismatches like wrong product names,
// wrong persona, or narration describing a different screen.
// Runs as a text-only check — no LLM call, just keyword/phrase rules.
function runNarrationQA(scripts) {
  if (!USE_SCRATCH || !fs.existsSync(DEMO_SCRIPT_PATH)) return;
  const script = JSON.parse(fs.readFileSync(DEMO_SCRIPT_PATH, 'utf8'));
  const steps  = (script.steps || []).filter(s => s.narration);

  console.log('\n[Narration QA] Checking narration/visual alignment...');
  let issues = 0;

  for (const step of steps) {
    const narration   = step.narration || '';
    const visualState = step.visualState || '';
    const label       = step.label || step.id;
    const warnings    = [];

    // Rule: persona name must appear in narration (unless it's a product-only step)
    const personaName = script.persona?.name?.split(' ')[0]; // first name
    const personaInNarration = !personaName || narration.toLowerCase().includes(personaName.toLowerCase());
    const personaInVisual    = !personaName || visualState.toLowerCase().includes(personaName.toLowerCase());
    if (personaInVisual && !personaInNarration && step.id.startsWith('wf-')) {
      // WF app steps should mention the persona if the screen does
      warnings.push(`persona "${personaName}" visible on screen but not mentioned in narration`);
    }

    // Rule: word count 8–35
    const words = narration.trim().split(/\s+/).length;
    if (words < 8)  warnings.push(`narration too short: ${words} words (min 8)`);
    if (words > 35) warnings.push(`narration too long: ${words} words (max 35)`);

    // Rule: no prohibited phrases
    const prohibited = ['simply', 'just ', 'unfortunately', 'seamless', 'robust', 'Trust Index'];
    for (const phrase of prohibited) {
      if (narration.toLowerCase().includes(phrase.toLowerCase())) {
        warnings.push(`prohibited phrase: "${phrase}"`);
      }
    }

    // Rule: Signal steps must not say "Trust Index" (not a real Plaid term)
    if (step.id.includes('signal') && narration.toLowerCase().includes('trust index')) {
      warnings.push('Signal step uses "Trust Index" — use "ACH transaction risk score" instead');
    }

    if (warnings.length > 0) {
      issues++;
      console.warn(`  ⚠ [${step.id}] "${label}"`);
      warnings.forEach(w => console.warn(`      · ${w}`));
    } else {
      console.log(`  ✓ [${step.id}] "${label}" — ${words} words`);
    }
  }

  if (issues === 0) {
    console.log('[Narration QA] All clips passed.\n');
  } else {
    console.warn(`[Narration QA] ${issues} step(s) have narration warnings — review before final render.\n`);
  }
}

runNarrationQA(_scratchScripts);

// Load per-step voiceover start offsets from demo-script.json.
// A step with voiceoverStartOffsetMs: 2000 will have its audio clip start
// 2 seconds after the step begins in the processed video — useful for giving
// the viewer a moment to take in the screen before narration starts.
function loadVoiceoverOffsets() {
  if (USE_SCRATCH && fs.existsSync(DEMO_SCRIPT_PATH)) {
    const script = JSON.parse(fs.readFileSync(DEMO_SCRIPT_PATH, 'utf8'));
    return Object.fromEntries(
      (script.steps || [])
        .filter(s => s.voiceoverStartOffsetMs)
        .map(s => [s.id, s.voiceoverStartOffsetMs])
    );
  }
  return {};
}
const VOICEOVER_OFFSETS = loadVoiceoverOffsets();

// ── Voiceover scripts keyed by step ID ────────────────────────────────────────
// Written to match each step's screen content and duration.
// Sourced from Plaid IDV product research via AskBill + Glean.
// When --scratch is passed, VOICEOVER_SCRIPTS is replaced by demo-script.json narrations.

const VOICEOVER_SCRIPTS = _scratchScripts || {
  // 14.4s screen — ~30 words target
  '01-welcome':
    'Welcome to Plaid Identity Verification — the trusted KYC platform used by thousands of businesses worldwide. Verify users in seconds, stop fraud before it starts, and stay compliant.',

  // 8.2s screen — ~15 words target
  '03-configure':
    'Fast flow: data source verification only. Every identity field checked instantly against authoritative sources. No documents. No waiting.',

  // 8.9s screen — ~15 words target
  '07a-signup':
    'Leslie Knope is signing up with Smith and Cedar. Plaid integrates into your existing onboarding — invisible to users, powerful behind the scenes.',

  // 10.5s screen — ~22 words target
  '07b-personal-info':
    'Plaid captures name, address, date of birth, phone, and Social Security Number. Pre-fill from existing data to reduce friction and boost conversion.',

  // 8.7s screen — ~17 words target
  '07c-sms':
    'Phone ownership confirmed via SMS. Plaid handles this natively — or your team controls the UI. Maximum flexibility.',

  // 13.5s screen — ~22 words target
  '07d-account-created':
    'Account created. Your backend calls Plaid\'s identity verification API with a single POST request — triggering the complete KYC pipeline instantly.',

  // 6.6s screen — ~13 words target
  '08-backend-data':
    'Results in milliseconds. Every field confirmed. Structured JSON, ready for automated decisioning.',

  // 5.1s screen — ~10 words target
  '09a-dashboard':
    'Trust Index 94 — low risk. All five identity fields confirmed.',

  // 4.3s screen — ~9 words target
  '09b-linked-accounts':
    'Phone and email linked to Google, Microsoft, and Facebook. Real identity verified.',

  // 5.1s screen — ~10 words target
  '09c-data-source':
    'All fields matched against Plaid\'s data sources. Reliable, compliant, auditable.',

  // 3.9s screen — ~8 words target
  '09d-watchlist':
    'Sanctions, AML, PEP — all clear. Leslie is clean.',

  // 9.5s screen — ~16 words target
  '09e-risk-check':
    'Device risk: zero. Phone risk: zero. Network risk: zero. Trust Index 94 — well above the approval threshold.',

  // 9.0s screen — ~20 words target
  '09f-behavior':
    'No fraud ring. No bot activity. Behavioral signals are clean — this is how real users behave. Verified and ready.',

  // 5.5s screen — ~11 words target
  '11-all-set':
    'Verification complete. Onboarded in under two minutes. Fast, frictionless, and fully KYC compliant.',

  '12-cta': [
    'Ready to bring Plaid Identity Verification to your product?',
    'Book a meeting with our team.',
    'Let\'s talk about how to reduce fraud, accelerate onboarding,',
    'and scale compliance — the smart way.',
  ].join(' '),
}; // end hardcoded IDV scripts

// ── Narration pre-processing for TTS ─────────────────────────────────────────
//
// Normalizes narration text before sending to ElevenLabs to improve pronunciation:
//  1. Expands acronyms (ACH, API, IDV, etc.) so TTS reads them letter-by-letter
//  2. Adds a brief SSML <break> pause before "reveal" phrases (score, ACCEPT, approval)
//     for dramatic pacing — eleven_multilingual_v2 supports SSML inline breaks.
//
// Stability is kept at 0.75 per CLAUDE.md — do NOT lower it (causes stutter artifacts).

const ACRONYM_MAP = {
  'ACH':  'A C H',
  'API':  'A P I',
  'IDV':  'I D V',
  'OTP':  'O T P',
  'KYC':  'K Y C',
  'MFA':  'M F A',
  'IAV':  'I A V',
  'EAV':  'E A V',
  'AML':  'A M L',
  'PEP':  'P E P',
  'SSN':  'S S N',
  'CTA':  'C T A',
  'TLS':  'T L S',
  'SDK':  'S D K',
  'CRA':  'C R A',
};

// Patterns that indicate a reveal moment deserving a brief dramatic pause
const REVEAL_PATTERNS = [
  /\bACCEPT\b/,
  /\bapproved?\b/i,
  /\bverified\b/i,
  /\bscore\s+\d/i,
  /\bin under\s+\d/i,
  /\binstant(ly)?\b/i,
  /\$\d[\d,]+/,
  /\bauthorized\b/i,
  /\bconfirmed\b/i,
];

// Phrases that get a preceding pause injected for dramatic effect
// Pattern: sentence break (". " or " — ") followed by a capitalized reveal word
const REVEAL_INJECT_RE = /(\.\s+|\s—\s+)(ACCEPT|approved?|verified|authorized|Authorized|Approved)/g;

/**
 * Normalizes a narration string for ElevenLabs TTS:
 *  - Expands acronyms to letter-by-letter (e.g. ACH → A C H)
 *  - Injects SSML <break time="0.4s"/> before reveal phrases in reveal steps
 *
 * @param {string} text      - Raw narration from demo-script.json
 * @param {string} [stepId]  - Optional step ID for logging
 * @returns {string}         - Normalized text, safe to pass to ElevenLabs
 */
function normalizeNarration(text, stepId = '') {
  let normalized = text;

  // 1. Expand acronyms: word-boundary match to avoid partial replacements
  for (const [acronym, expansion] of Object.entries(ACRONYM_MAP)) {
    normalized = normalized.replace(
      new RegExp(`\\b${acronym}\\b`, 'g'),
      expansion
    );
  }

  // 2. Inject SSML break before reveal phrases (only when the step contains a reveal moment)
  const isRevealStep = REVEAL_PATTERNS.some(p => p.test(normalized));
  if (isRevealStep) {
    normalized = normalized.replace(REVEAL_INJECT_RE, '$1<break time="0.4s"/>$2');
  }

  if (normalized !== text) {
    console.log(`  [normalize] ${stepId || 'step'}: "${text.substring(0, 60)}" → "${normalized.substring(0, 60)}"`);
  }

  return normalized;
}

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────

async function generateAudio(text, outputPath) {
  console.log(`  Generating audio: ${path.basename(outputPath)}`);
  console.log(`  Text (${text.length} chars): "${text.substring(0, 60)}..."`);

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=${OUTPUT_FORMAT}`,
    {
      method:  'POST',
      headers: {
        'xi-api-key':    ELEVENLABS_API_KEY,
        'Content-Type':  'application/json',
        'Accept':        'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: {
          stability:         0.75,  // higher = more consistent, less variation/stutter
          similarity_boost:  0.90,  // high fidelity to reference voice
          style:             0.2,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text().catch(() => response.status);
    throw new Error(`ElevenLabs API error ${response.status}: ${err}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  console.log(`  ✓ Saved ${(buffer.length / 1024).toFixed(1)} KB`);
  return buffer.length;
}

// Get audio duration in seconds via ffprobe
function getAudioDuration(filePath) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf8' }
    ).trim();
    return parseFloat(out) || 0;
  } catch {
    return 0;
  }
}

// ── Remap raw step timings to processed-video positions ───────────────────────
//
// After post-process-recording.js cuts still frames, raw recording timestamps no
// longer correspond to positions in recording-processed.webm. This function maps
// every step's startMs/endMs from raw-recording coordinates into the processed
// video's timeline using the keep ranges written by post-process-recording.js.
//
// A raw timestamp that falls inside a keep range maps linearly within that range.
// A raw timestamp that falls in a CUT section snaps to the nearest keep range
// boundary — this handles steps like insight/api screens that start immediately
// after the Plaid Link success screen.

function remapStepTimingsToProcessed(stepTimings, processedTiming) {
  const ranges = processedTiming.keepRanges;

  function remapMs(rawMs) {
    const rawS = rawMs / 1000;

    // Check each keep range for containment
    for (const r of ranges) {
      if (rawS >= r.rawStart - 0.01 && rawS <= r.rawEnd + 0.01) {
        const offset = Math.max(0, rawS - r.rawStart);
        return Math.round((r.processedStart + offset) * 1000);
      }
    }

    // Raw timestamp falls in a cut section — snap to the nearest boundary
    let bestDist = Infinity;
    let bestMs   = 0;
    for (const r of ranges) {
      const dStart = Math.abs(rawS - r.rawStart);
      const dEnd   = Math.abs(rawS - r.rawEnd);
      if (dStart < bestDist) { bestDist = dStart; bestMs = Math.round(r.processedStart * 1000); }
      if (dEnd   < bestDist) { bestDist = dEnd;   bestMs = Math.round(r.processedEnd   * 1000); }
    }
    return bestMs;
  }

  return stepTimings.map(step => ({
    ...step,
    startMs: remapMs(step.startMs),
    endMs:   remapMs(step.endMs),
  }));
}

// ── Stitch audio clips with silence gaps ──────────────────────────────────────

function stitchAudio(clips, outputPath) {
  console.log('\nStitching audio with ffmpeg...');

  // Build a concat filter that inserts silence padding between clips
  // Each clip starts at step.startMs; silence fills the gap to the next clip.
  const tmpList = path.join(AUDIO_DIR, '_concat.txt');
  const lines   = [];

  let cursor = 0; // current position in ms

  for (const clip of clips) {
    const gapMs = clip.startMs - cursor;

    if (gapMs > 50) {
      // Generate a silence file for the gap
      const silenceFile = path.join(AUDIO_DIR, `silence_${clip.id}.mp3`);
      execSync(
        `ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${(gapMs / 1000).toFixed(3)} -q:a 9 -acodec libmp3lame "${silenceFile}" -y`,
        { stdio: 'pipe' }
      );
      lines.push(`file '${path.resolve(silenceFile)}'`);
    }

    lines.push(`file '${path.resolve(clip.audioFile)}'`);
    cursor = clip.startMs + Math.round(clip.audioDurationMs);
  }

  fs.writeFileSync(tmpList, lines.join('\n'));

  execSync(
    `ffmpeg -f concat -safe 0 -i "${tmpList}" -acodec libmp3lame -q:a 4 "${outputPath}" -y`,
    { stdio: 'inherit' }
  );
  console.log(`✓ Voiceover stitched: ${outputPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load step timing (fall back to estimated timing if no recording yet)
  let stepTimings = null;
  if (fs.existsSync(TIMING_FILE)) {
    stepTimings = JSON.parse(fs.readFileSync(TIMING_FILE, 'utf8')).steps;
    console.log(`Loaded step timing from ${TIMING_FILE} (${stepTimings.length} steps)\n`);
  } else {
    console.warn('⚠ No step-timing.json found — using estimated timing');
    console.warn('  Run record-local.js first for frame-accurate sync.\n');
    // Estimated timing based on script (ms from recording start)
    stepTimings = [
      { id: '01-welcome',         label: 'Welcome',            startMs:     0, endMs:  8000 },
      { id: '03-configure',       label: 'Configure',          startMs:  8000, endMs: 18000 },
      { id: '07a-signup',         label: 'Sign Up',            startMs: 18000, endMs: 26000 },
      { id: '07b-personal-info',  label: 'Personal Info',      startMs: 26000, endMs: 38000 },
      { id: '07c-sms',            label: 'SMS Confirmation',   startMs: 38000, endMs: 46000 },
      { id: '07d-account-created',label: 'Account Created',    startMs: 46000, endMs: 56000 },
      { id: '08-backend-data',    label: 'Backend Data',       startMs: 56000, endMs: 68000 },
      { id: '09a-dashboard',      label: 'Dashboard',          startMs: 68000, endMs: 83000 },
      { id: '09b-linked-accounts',label: 'Linked Accounts',    startMs: 83000, endMs: 91000 },
      { id: '09c-data-source',    label: 'Data Source',        startMs: 91000, endMs: 103000 },
      { id: '09d-watchlist',      label: 'Watchlist',          startMs: 103000, endMs: 111000 },
      { id: '09e-risk-check',     label: 'Risk Check',         startMs: 111000, endMs: 123000 },
      { id: '09f-behavior',       label: 'Behavior',           startMs: 123000, endMs: 131000 },
      { id: '11-all-set',         label: 'All Set',            startMs: 131000, endMs: 141000 },
      { id: '12-cta',             label: 'CTA',                startMs: 141000, endMs: 153000 },
    ];
  }

  // Remap step timings to processed-video coordinates.
  // generate-voiceover runs AFTER post-process in the pipeline, so
  // processed-step-timing.json is always present in a full pipeline run.
  // Falls back to raw step-timing.json positions if the file is absent
  // (e.g. standalone voiceover regeneration without re-running post-process).
  if (fs.existsSync(PROCESSED_TIMING_FILE)) {
    const processedTiming = JSON.parse(fs.readFileSync(PROCESSED_TIMING_FILE, 'utf8'));
    stepTimings = remapStepTimingsToProcessed(stepTimings, processedTiming);
    const totalS = (processedTiming.totalProcessedMs / 1000).toFixed(1);
    console.log(`Remapped ${stepTimings.length} step timings to processed video (${totalS}s total)\n`);

    // Inject Plaid Link sub-step timing synthesized by post-process-recording.js.
    // These steps (link-consent, link-otp, link-account-select, link-success) are not
    // in step-timing.json because the recording treats the Plaid flow as one block.
    // post-process-recording.js computes their processed-space windows from plaid-link-timing.json.
    const plaidWindows = processedTiming.plaidStepWindows || [];
    if (plaidWindows.length > 0) {
      // Load label/narration for these steps from demo-script.json
      const scriptSteps = {};
      if (fs.existsSync(path.join(OUT_DIR, 'demo-script.json'))) {
        const ds = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'demo-script.json'), 'utf8'));
        for (const s of (ds.steps || [])) scriptSteps[s.id] = s;
      }
      const existingIds = new Set(stepTimings.map(s => s.id));
      for (const w of plaidWindows) {
        if (existingIds.has(w.stepId)) continue; // already present
        const ds = scriptSteps[w.stepId] || {};
        stepTimings.push({
          id:       w.stepId,
          label:    ds.label || w.stepId,
          startMs:  w.startMs,
          endMs:    w.endMs,
        });
      }
      // Re-sort by startMs so clips are stitched in timeline order
      stepTimings.sort((a, b) => a.startMs - b.startMs);
      console.log(`Injected ${plaidWindows.length} Plaid Link sub-step timing window(s) — total steps: ${stepTimings.length}\n`);
    }
  } else {
    console.warn('⚠ No processed-step-timing.json found — voiceover will sync to raw recording positions.');
    console.warn('  Run the post-process stage first: npm run post-process\n');
  }

  // Apply SYNC_MAP_S inverse to convert processed video times → composition times.
  // SYNC_MAP_S entries (speed-up or freeze windows) change when video frames appear
  // in the composition. Voiceover clips must be placed at composition time, not raw
  // processed-video time, or narration will play over the wrong screen.
  //
  // sync-map.json is written by the post-process stage (identity by default) and can
  // be edited to add speed/freeze windows. After editing, run --from=resync-audio.
  const syncMap = loadSyncMap(OUT_DIR);
  if (syncMap.length > 0) {
    stepTimings = stepTimings.map(step => ({
      ...step,
      startMs: processedToCompMs(step.startMs, syncMap),
      endMs:   processedToCompMs(step.endMs,   syncMap),
    }));
    console.log(`Applied sync-map (${syncMap.length} segment(s)) — audio placed at composition-space times\n`);
  } else {
    console.log('No sync-map segments — audio placed at processed video times (1:1 with composition)\n');
  }

  // Generate audio for each step that has a voiceover script
  const clips = [];
  console.log(`Generating ${Object.keys(VOICEOVER_SCRIPTS).length} voiceover clips with ElevenLabs...\n`);

  for (const step of stepTimings) {
    const script = VOICEOVER_SCRIPTS[step.id];
    if (!script) {
      console.log(`  [skip] No voiceover for step: ${step.id}`);
      continue;
    }

    const audioFile = path.join(AUDIO_DIR, `vo_${step.id}.mp3`);

    // Skip regeneration if already exists (speeds up re-runs)
    if (fs.existsSync(audioFile)) {
      console.log(`  [cached] ${path.basename(audioFile)}`);
    } else {
      // Normalize narration: expand acronyms, inject SSML breaks before reveals
      const normalizedScript = normalizeNarration(script, step.id);
      await generateAudio(normalizedScript, audioFile);
      // Small delay to respect ElevenLabs rate limits
      await new Promise(r => setTimeout(r, 300));
    }

    const audioDurationMs = Math.round(getAudioDuration(audioFile) * 1000);
    console.log(`  Audio duration: ${(audioDurationMs / 1000).toFixed(2)}s`);

    const voiceoverOffset = VOICEOVER_OFFSETS[step.id] || 0;
    const clipStartMs = step.startMs + voiceoverOffset;
    clips.push({
      id:             step.id,
      label:          step.label,
      startMs:        clipStartMs,
      endMs:          step.endMs,
      audioDurationMs,
      audioFile,
      startFrame:     Math.round(clipStartMs / 1000 * 30),
      endFrame:       Math.round(step.endMs  / 1000 * 30),
      audioEndFrame:  Math.round((clipStartMs + audioDurationMs) / 1000 * 30),
      script,
    });
    console.log();
  }

  // Stitch into single voiceover.mp3 in the run directory
  const voiceoverPath = path.join(AUDIO_DIR, 'voiceover.mp3');
  stitchAudio(clips, voiceoverPath);

  // Write manifest for Remotion
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify({ voiceoverFile: voiceoverPath, clips }, null, 2));
  console.log(`✓ Manifest: out/voiceover-manifest.json`);

  // Write timing.js for Remotion import
  const timingJsPath = path.resolve(__dirname, '../remotion/timing.js');
  const timingJs = `// Auto-generated by generate-voiceover.js — do not edit manually
// Re-run: node scripts/generate-voiceover.js

const STEP_TIMING = ${JSON.stringify(clips.map(c => ({
    id:             c.id,
    label:          c.label,
    startFrame:     c.startFrame,
    endFrame:       c.endFrame,
    audioEndFrame:  c.audioEndFrame,
  })), null, 2)};

module.exports = { STEP_TIMING };
`;
  fs.writeFileSync(timingJsPath, timingJs);
  console.log('✓ Remotion timing: remotion/timing.js');
  console.log('\nNext: npm run render\n');
}

main().catch(err => {
  console.error('Voiceover generation failed:', err.message);
  process.exit(1);
});
