'use strict';
/**
 * ingest.js
 * Scans inputs/ subfolders, produces out/ingested-inputs.json.
 *
 * Reads:
 *   inputs/scripts/      — .txt, .md files → UTF-8 text
 *   inputs/screenshots/  — .png, .jpg, .jpeg, .webp → base64 + mimeType
 *   inputs/videos/       — .mp4, .webm, .mov → extract audio via ffmpeg,
 *                          transcribe with Whisper CLI
 *
 * Output: out/ingested-inputs.json
 *
 * Usage: node scripts/scratch/scratch/ingest.js
 */

require('dotenv').config({ override: true });
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const { spawnSync } = require('child_process');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT    = path.resolve(__dirname, '../../..');
const INPUTS_DIR      = path.join(PROJECT_ROOT, 'inputs');
const SCRIPTS_DIR     = path.join(INPUTS_DIR, 'scripts');
const SCREENSHOTS_DIR = path.join(INPUTS_DIR, 'screenshots');
const VIDEOS_DIR      = path.join(INPUTS_DIR, 'videos');
const OUT_DIR         = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const OUT_FILE        = path.join(OUT_DIR, 'ingested-inputs.json');

// ── MIME map for screenshots ───────────────────────────────────────────────────

const IMAGE_MIME = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

// ── Text ingestion ─────────────────────────────────────────────────────────────

function ingestTexts() {
  const results = [];
  if (!fs.existsSync(SCRIPTS_DIR)) {
    console.log('[Ingest] inputs/scripts/ not found — skipping texts');
    return results;
  }
  const files = fs.readdirSync(SCRIPTS_DIR).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return ext === '.txt' || ext === '.md';
  }).sort();

  for (const filename of files) {
    const filePath = path.join(SCRIPTS_DIR, filename);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      results.push({ filename, content });
    } catch (err) {
      console.warn(`[Ingest] Warning: could not read ${filename}: ${err.message}`);
    }
  }
  return results;
}

// ── Screenshot ingestion ──────────────────────────────────────────────────────

function ingestScreenshots() {
  const results = [];
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    console.log('[Ingest] inputs/screenshots/ not found — skipping screenshots');
    return results;
  }
  const files = fs.readdirSync(SCREENSHOTS_DIR).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return Object.prototype.hasOwnProperty.call(IMAGE_MIME, ext);
  }).sort();

  for (const filename of files) {
    const filePath = path.join(SCREENSHOTS_DIR, filename);
    const ext = path.extname(filename).toLowerCase();
    try {
      const data = fs.readFileSync(filePath);
      const base64 = data.toString('base64');
      const mimeType = IMAGE_MIME[ext];
      results.push({ filename, base64, mimeType });
    } catch (err) {
      console.warn(`[Ingest] Warning: could not read screenshot ${filename}: ${err.message}`);
    }
  }
  return results;
}

// ── Video / Whisper transcription ─────────────────────────────────────────────

/**
 * Extracts audio from a video file using ffmpeg, then transcribes with Whisper.
 * Returns { text, words: [{word, start, end}] } or null on failure.
 */
function transcribeVideo(videoPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-whisper-'));
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const tempWav = path.join(tempDir, `${baseName}.wav`);

  // ── 1. Extract audio with ffmpeg ──────────────────────────────────────────
  const ffmpegResult = spawnSync(
    'ffmpeg',
    ['-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', tempWav, '-y'],
    { encoding: 'utf8' }
  );

  if (ffmpegResult.status !== 0 || !fs.existsSync(tempWav)) {
    console.warn(`[Ingest] ffmpeg failed for ${path.basename(videoPath)}: ${ffmpegResult.stderr || 'unknown error'}`);
    cleanupDir(tempDir);
    return null;
  }

  // ── 2. Transcribe with Whisper CLI ────────────────────────────────────────
  const whisperResult = spawnSync(
    'whisper',
    [tempWav, '--output_format', 'json', '--word_timestamps', 'True',
     '--output_dir', tempDir, '--language', 'en'],
    { encoding: 'utf8' }
  );

  if (whisperResult.status !== 0) {
    console.warn(`[Ingest] Whisper not available or failed for ${path.basename(videoPath)}.`);
    console.warn('[Ingest]   Install with: pip install openai-whisper');
    cleanupDir(tempDir);
    return null;
  }

  // ── 3. Parse Whisper JSON output ──────────────────────────────────────────
  const whisperJsonPath = path.join(tempDir, `${baseName}.json`);
  if (!fs.existsSync(whisperJsonPath)) {
    console.warn(`[Ingest] Whisper JSON not found at ${whisperJsonPath}`);
    cleanupDir(tempDir);
    return null;
  }

  let whisperData;
  try {
    whisperData = JSON.parse(fs.readFileSync(whisperJsonPath, 'utf8'));
  } catch (err) {
    console.warn(`[Ingest] Could not parse Whisper output for ${path.basename(videoPath)}: ${err.message}`);
    cleanupDir(tempDir);
    return null;
  }

  // Flatten segments → word-level timestamps
  const words = [];
  for (const seg of (whisperData.segments || [])) {
    for (const w of (seg.words || [])) {
      words.push({
        word:  w.word.trim(),
        start: w.start,
        end:   w.end,
      });
    }
  }

  cleanupDir(tempDir);

  return {
    text:  (whisperData.text || '').trim(),
    words,
  };
}

function cleanupDir(dir) {
  try {
    fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f)));
    fs.rmdirSync(dir);
  } catch (_) {
    // Non-fatal cleanup failure
  }
}

function ingestVideos() {
  const results = [];
  if (!fs.existsSync(VIDEOS_DIR)) {
    console.log('[Ingest] inputs/videos/ not found — skipping videos');
    return { transcriptions: [], transcribed: 0 };
  }

  const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov']);
  const files = fs.readdirSync(VIDEOS_DIR).filter(f => {
    return VIDEO_EXTS.has(path.extname(f).toLowerCase());
  }).sort();

  let transcribed = 0;
  for (const filename of files) {
    const videoPath = path.join(VIDEOS_DIR, filename);
    process.stdout.write(`[Ingest] Transcribing ${filename}...`);
    const transcript = transcribeVideo(videoPath);
    if (transcript) {
      process.stdout.write(` ${transcript.words.length} words\n`);
      results.push({ filename, transcript });
      transcribed++;
    } else {
      process.stdout.write(' skipped (no transcription)\n');
      results.push({ filename, transcript: { text: '', words: [] } });
    }
  }

  return { transcriptions: results, transcribed };
}

// ── Prompt.txt ingestion (primary user input) ────────────────────────────────

function ingestPrompt() {
  const promptFile = path.join(INPUTS_DIR, 'prompt.txt');
  if (!fs.existsSync(promptFile)) {
    console.log('[Ingest] inputs/prompt.txt not found — skipping prompt');
    return null;
  }
  const content = fs.readFileSync(promptFile, 'utf8').trim();
  console.log(`[Ingest] Loaded prompt.txt (${content.length} chars)`);
  return { filename: 'prompt.txt', content };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('[Ingest] Scanning inputs/...');

  const texts = ingestTexts();
  const screenshots = ingestScreenshots();
  const { transcriptions, transcribed } = ingestVideos();

  // Always include prompt.txt as the first text input — it's the primary config
  const promptEntry = ingestPrompt();
  if (promptEntry) {
    texts.unshift(promptEntry);
  }

  console.log(
    `[Ingest] Found ${texts.length} texts, ${screenshots.length} screenshots, ` +
    `${transcriptions.length} videos (${transcribed} transcribed)`
  );

  const output = {
    ingestedAt:     new Date().toISOString(),
    texts,
    screenshots,
    transcriptions,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[Ingest] Written: out/ingested-inputs.json`);
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[Ingest] Fatal error:', err.message);
    process.exit(1);
  });
}
