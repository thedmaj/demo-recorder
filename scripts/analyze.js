/**
 * analyze.js
 * Extracts 1 frame/sec from recording.webm, sends each to Claude vision,
 * builds a timestamped index of what's on screen, writes out/index.json.
 *
 * Usage: node scripts/analyze.js
 * Optional: node scripts/analyze.js --voiceover public/voiceover.mp3
 *   (requires `whisper` CLI installed: pip install openai-whisper)
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const RECORDING  = path.join(__dirname, '../public/recording.webm');
const FRAMES_DIR = path.join(__dirname, '../out/frames');
const OUT_FILE   = path.join(__dirname, '../out/index.json');
const FPS        = 1; // 1 screenshot per second

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── 1. Extract frames ────────────────────────────────────────────────────────
function extractFrames() {
  if (!fs.existsSync(RECORDING)) {
    console.error(`Recording not found at ${RECORDING}`);
    process.exit(1);
  }
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  // Clear old frames
  fs.readdirSync(FRAMES_DIR).forEach(f => fs.unlinkSync(path.join(FRAMES_DIR, f)));

  console.log('Extracting frames from recording...');
  execSync(
    `ffmpeg -i "${RECORDING}" -vf fps=${FPS} "${FRAMES_DIR}/frame_%04d.png" -y`,
    { stdio: 'inherit' }
  );

  const frames = fs.readdirSync(FRAMES_DIR).filter(f => f.endsWith('.png')).sort();
  console.log(`Extracted ${frames.length} frames (1/sec)\n`);
  return frames;
}

// ── 2. Analyze each frame with Claude vision ─────────────────────────────────
async function analyzeFrame(framePath, second) {
  const imageData = fs.readFileSync(framePath).toString('base64');
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: imageData },
        },
        {
          type: 'text',
          text: 'Describe what UI is visible on screen in 1-2 sentences. Focus on: what screen/step of the demo is showing, any highlighted elements, buttons, badges, or labels visible. Be concise.',
        },
      ],
    }],
  });
  return response.content[0].text.trim();
}

// ── 3. Run Whisper on voiceover (optional) ───────────────────────────────────
function transcribeVoiceover(audioPath) {
  console.log('\nTranscribing voiceover with Whisper...');
  const outDir = path.join(__dirname, '../out');
  const result = spawnSync(
    'whisper', [audioPath, '--output_format', 'json', '--word_timestamps', 'True', '--output_dir', outDir],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    console.warn('Whisper failed or not installed. Skipping audio transcription.');
    console.warn('Install with: pip install openai-whisper');
    return null;
  }
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const jsonPath = path.join(outDir, `${baseName}.json`);
  if (!fs.existsSync(jsonPath)) return null;
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  // Flatten segments to word-level timestamps
  const words = [];
  for (const seg of data.segments || []) {
    for (const w of seg.words || []) {
      words.push({ word: w.word.trim(), start: w.start, end: w.end, frame: Math.round(w.start * 30) });
    }
  }
  console.log(`Transcribed ${words.length} words from voiceover.\n`);
  return words;
}

// ── 4. Detect sync mismatches ────────────────────────────────────────────────
function detectMismatches(videoIndex, words) {
  if (!words) return [];
  const mismatches = [];

  // Key phrases to check — extend this list as needed
  const keyPhrases = [
    { phrase: 'recommended', label: 'RECOMMENDED badge callout' },
    { phrase: 'instant auth', label: 'Instant Auth mention' },
    { phrase: 'connect', label: 'Connect with Plaid' },
  ];

  for (const { phrase, label } of keyPhrases) {
    // Find when narrator says the phrase
    const match = words.find(w => w.word.toLowerCase().includes(phrase.toLowerCase()));
    if (!match) continue;

    const audioFrame = match.frame;
    const audioSecond = match.start;

    // Find when that thing appears on screen (first frame containing the phrase in description)
    const screenEntry = videoIndex.find(e =>
      e.description.toLowerCase().includes(phrase.toLowerCase())
    );
    if (!screenEntry) continue;

    const videoFrame = screenEntry.frame;
    const diff = audioFrame - videoFrame;

    mismatches.push({
      label,
      phrase: match.word,
      audioSecond: audioSecond.toFixed(2),
      audioFrame,
      videoFrame,
      diffFrames: diff,
      diffSeconds: (diff / 30).toFixed(2),
      verdict: Math.abs(diff) <= 15
        ? '✅ In sync (within 0.5s)'
        : diff > 0
          ? `⚠️  Narrator is ${(diff/30).toFixed(1)}s LATE — increase audio delay or reduce CALLOUT_START`
          : `⚠️  Narrator is ${Math.abs(diff/30).toFixed(1)}s EARLY — decrease audio delay or increase CALLOUT_START`,
    });
  }
  return mismatches;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const voiceoverArg = process.argv.indexOf('--voiceover');
  const voiceoverPath = voiceoverArg !== -1 ? process.argv[voiceoverArg + 1] : null;

  const frames = extractFrames();
  const videoIndex = [];

  console.log('Analyzing frames with Claude vision...');
  for (let i = 0; i < frames.length; i++) {
    const second = i; // 1 frame per second
    const frame30 = second * 30;
    const framePath = path.join(FRAMES_DIR, frames[i]);
    process.stdout.write(`  [${String(second).padStart(3)}s / frame ${String(frame30).padStart(4)}] `);
    const description = await analyzeFrame(framePath, second);
    console.log(description);
    videoIndex.push({ second, frame: frame30, description });
  }

  // Transcribe voiceover if provided
  const words = voiceoverPath ? transcribeVoiceover(voiceoverPath) : null;
  const mismatches = detectMismatches(videoIndex, words);

  const output = {
    generatedAt: new Date().toISOString(),
    totalSeconds: frames.length,
    videoIndex,
    ...(words && { voiceover: words }),
    ...(mismatches.length && { syncReport: mismatches }),
  };

  fs.mkdirSync(path.join(__dirname, '../out'), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\n✅ Index written to ${OUT_FILE}`);

  if (mismatches.length) {
    console.log('\n── Sync Report ──────────────────────────────────────────');
    for (const m of mismatches) {
      console.log(`\n${m.label}`);
      console.log(`  Audio: "${m.phrase}" at ${m.audioSecond}s (frame ${m.audioFrame})`);
      console.log(`  Video: appears at frame ${m.videoFrame}`);
      console.log(`  ${m.verdict}`);
    }
  } else if (words) {
    console.log('\n✅ No sync issues detected.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
