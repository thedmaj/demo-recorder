/**
 * analyze-video.js
 *
 * Mode B/C pipeline — Stage 1: Analyze a rough user video recording.
 *
 * Voice transcription (in priority order):
 *   1. ElevenLabs Dubbing API  — POST /v1/dubbing, poll until "dubbed", write dubbed.mp3
 *   2. Whisper CLI fallback    — extract WAV with ffmpeg, run whisper with word timestamps
 *
 * Frame analysis:
 *   - Extract 1 frame/sec (jpg) with ffmpeg
 *   - Batch-analyze frames in groups of 10 with Claude claude-opus-4-7 vision
 *
 * Writes: out/video-analysis.json
 *
 * Usage:
 *   node scripts/scratch/enhance/analyze-video.js [videoPath]
 *   node scripts/scratch/enhance/analyze-video.js   # auto-detect from inputs/videos/
 */

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = process.env.PIPELINE_RUN_DIR || path.join(ROOT, 'out');
const AUDIO_DIR = path.join(OUT_DIR, 'audio');
const FRAMES_DIR = path.join(OUT_DIR, 'frames-enhance');
const OUT_FILE = path.join(OUT_DIR, 'video-analysis.json');
const INPUTS_VIDEOS_DIR = path.join(ROOT, 'inputs', 'videos');

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_MS = 120000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Extract JSON from a Claude response that may contain fenced or raw JSON.
 * @param {string} text
 * @returns {object}
 */
function extractJSON(text) {
  // Try fenced JSON first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    return JSON.parse(fenced[1].trim());
  }
  // Try raw JSON
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    return JSON.parse(text.slice(firstBrace));
  }
  throw new Error('No JSON found in response');
}

// ── 1. Resolve video path ─────────────────────────────────────────────────────

function resolveVideoPath(arg) {
  if (arg && fs.existsSync(arg)) {
    return path.resolve(arg);
  }

  if (!fs.existsSync(INPUTS_VIDEOS_DIR)) {
    throw new Error(`No video path supplied and inputs/videos/ directory not found at ${INPUTS_VIDEOS_DIR}`);
  }

  const files = fs.readdirSync(INPUTS_VIDEOS_DIR)
    .filter(f => /\.(mp4|webm|mov|mkv|avi)$/i.test(f))
    .map(f => ({
      name: f,
      mtime: fs.statSync(path.join(INPUTS_VIDEOS_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    throw new Error(`No video files found in ${INPUTS_VIDEOS_DIR}`);
  }

  const chosen = path.join(INPUTS_VIDEOS_DIR, files[0].name);
  console.log(`[analyze-video] Auto-detected video: ${chosen}`);
  return chosen;
}

// ── 2. Get video duration with ffprobe ───────────────────────────────────────

function getVideoDurationMs(videoPath) {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      { encoding: 'utf8' }
    );
    const secs = parseFloat(result.trim());
    if (!isNaN(secs)) return Math.round(secs * 1000);
  } catch (err) {
    console.warn(`[analyze-video] Warning: ffprobe failed (${err.message}). Duration will be estimated from frames.`);
  }
  return null; // will be filled in later from frame count
}

// ── 3. Extract video frames ──────────────────────────────────────────────────

function extractFrames(videoPath) {
  ensureDir(FRAMES_DIR);
  // Clear old frames
  fs.readdirSync(FRAMES_DIR)
    .filter(f => f.endsWith('.jpg'))
    .forEach(f => fs.unlinkSync(path.join(FRAMES_DIR, f)));

  console.log('[analyze-video] Extracting frames (1/sec)...');
  execSync(
    `ffmpeg -i "${videoPath}" -vf fps=1 "${FRAMES_DIR}/frame_%04d.jpg" -y`,
    { stdio: 'pipe' }
  );

  const frames = fs.readdirSync(FRAMES_DIR)
    .filter(f => f.endsWith('.jpg'))
    .sort();
  console.log(`[analyze-video] Extracted ${frames.length} frames`);
  return frames;
}

// ── 4. Analyze frames with Claude vision ────────────────────────────────────

async function analyzeFrameBatch(framePaths, startIndex) {
  const contentBlocks = [];

  for (let i = 0; i < framePaths.length; i++) {
    const frameNum = startIndex + i + 1;
    const imageData = fs.readFileSync(framePaths[i]).toString('base64');
    contentBlocks.push({ type: 'text', text: `Frame ${frameNum} (time: ${startIndex + i}s):` });
    contentBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: imageData },
    });
  }

  contentBlocks.push({
    type: 'text',
    text:
      `For each frame above, describe in 1–2 sentences: what UI step or screen is shown, ` +
      `what text is visible, and what interaction (if any) is highlighted. ` +
      `Output ONLY a JSON array of objects — no prose, no markdown fences:\n` +
      `[{ "frameIndex": <number>, "description": "<string>" }, ...]`,
  });

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    messages: [{ role: 'user', content: contentBlocks }],
  });

  const text = response.content[0].text.trim();
  try {
    const arr = JSON.parse(text.startsWith('[') ? text : text.slice(text.indexOf('[')));
    return arr;
  } catch (_) {
    // Fall back: generate placeholder entries
    return framePaths.map((_, i) => ({
      frameIndex: startIndex + i + 1,
      description: '(frame analysis unavailable)',
    }));
  }
}

async function analyzeAllFrames(frames) {
  const BATCH_SIZE = 10;
  const results = [];

  for (let i = 0; i < frames.length; i += BATCH_SIZE) {
    const batch = frames.slice(i, i + BATCH_SIZE);
    const batchPaths = batch.map(f => path.join(FRAMES_DIR, f));
    console.log(`[analyze-video] Analyzing frames ${i + 1}–${i + batch.length} of ${frames.length}...`);
    const batchResults = await analyzeFrameBatch(batchPaths, i);
    results.push(...batchResults);
  }

  return results;
}

// ── 5. ElevenLabs Dubbing API ────────────────────────────────────────────────

async function dubbingAPITranscribe(videoPath) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.log('[analyze-video] ELEVENLABS_API_KEY not set — skipping ElevenLabs Dubbing API');
    return null;
  }

  console.log('[analyze-video] Trying ElevenLabs Dubbing API...');
  ensureDir(AUDIO_DIR);

  // POST to /v1/dubbing with the video file as multipart
  let dubbingId;
  try {
    const fileBuffer = fs.readFileSync(videoPath);
    const fileName = path.basename(videoPath);
    const mimeType = videoPath.endsWith('.webm') ? 'video/webm'
      : videoPath.endsWith('.mov') ? 'video/quicktime'
      : 'video/mp4';

    // Build multipart form manually using FormData (Node 18+) or fallback
    const { FormData, Blob } = globalThis;
    if (!FormData) {
      console.warn('[analyze-video] FormData not available (Node < 18) — falling back to Whisper');
      return null;
    }

    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);
    form.append('target_lang', 'en');
    form.append('source_lang', 'en');
    form.append('num_speakers', '1');

    const postRes = await fetch(`${ELEVENLABS_API_BASE}/dubbing`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });

    if (!postRes.ok) {
      const errText = await postRes.text();
      console.warn(`[analyze-video] ElevenLabs Dubbing POST failed (HTTP ${postRes.status}): ${errText}`);
      return null;
    }

    const postData = await postRes.json();
    dubbingId = postData.dubbing_id;
    if (!dubbingId) {
      console.warn('[analyze-video] ElevenLabs Dubbing response missing dubbing_id');
      return null;
    }
    console.log(`[analyze-video] Dubbing job started: ${dubbingId}`);
  } catch (err) {
    console.warn(`[analyze-video] ElevenLabs Dubbing POST error: ${err.message}`);
    return null;
  }

  // Poll until status === "dubbed" or timeout
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const pollRes = await fetch(`${ELEVENLABS_API_BASE}/dubbing/${dubbingId}`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (!pollRes.ok) {
        console.warn(`[analyze-video] Dubbing poll HTTP ${pollRes.status}`);
        continue;
      }
      const pollData = await pollRes.json();
      console.log(`[analyze-video] Dubbing status: ${pollData.status}`);

      if (pollData.status === 'dubbed') {
        // Fetch the dubbed audio
        const audioRes = await fetch(`${ELEVENLABS_API_BASE}/dubbing/${dubbingId}/audio/en`, {
          headers: { 'xi-api-key': apiKey },
        });
        if (!audioRes.ok) {
          console.warn(`[analyze-video] Could not fetch dubbed audio (HTTP ${audioRes.status})`);
          return null;
        }
        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
        const dubbedPath = path.join(AUDIO_DIR, 'dubbed.mp3');
        fs.writeFileSync(dubbedPath, audioBuffer);
        console.log(`[analyze-video] Dubbed audio written to ${dubbedPath}`);

        // Return result: we have the audio but still need to transcribe it via Whisper
        // to get word-level timestamps. Return dubbingId so caller can record it.
        return { dubbingId, dubbedAudioPath: dubbedPath };
      }

      if (pollData.status === 'failed' || pollData.status === 'error') {
        console.warn(`[analyze-video] ElevenLabs Dubbing job failed: ${JSON.stringify(pollData)}`);
        return null;
      }
    } catch (err) {
      console.warn(`[analyze-video] Dubbing poll error: ${err.message}`);
    }
  }

  console.warn('[analyze-video] ElevenLabs Dubbing timed out after 120s — falling back to Whisper');
  return null;
}

// ── 6. Whisper transcription ─────────────────────────────────────────────────

function extractAudioWav(videoPath) {
  ensureDir(AUDIO_DIR);
  const wavPath = path.join(AUDIO_DIR, 'audio.wav');
  console.log('[analyze-video] Extracting audio to WAV...');
  execSync(
    `ffmpeg -i "${videoPath}" -vn -acodec pcm_s16le "${wavPath}" -y`,
    { stdio: 'pipe' }
  );
  return wavPath;
}

function runWhisper(audioPath) {
  console.log('[analyze-video] Running Whisper CLI...');
  const result = spawnSync(
    'whisper',
    [audioPath, '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', AUDIO_DIR],
    { encoding: 'utf8' }
  );

  if (result.status !== 0) {
    console.warn('[analyze-video] Whisper failed or not installed. Install with: pip install openai-whisper');
    return null;
  }

  const baseName = path.basename(audioPath, path.extname(audioPath));
  const jsonPath = path.join(AUDIO_DIR, `${baseName}.json`);
  if (!fs.existsSync(jsonPath)) {
    console.warn('[analyze-video] Whisper output JSON not found');
    return null;
  }

  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const fullText = data.text || '';
  const words = [];
  for (const seg of data.segments || []) {
    for (const w of seg.words || []) {
      words.push({ word: w.word.trim(), start: w.start, end: w.end });
    }
  }
  console.log(`[analyze-video] Whisper transcribed ${words.length} words`);
  return { text: fullText, words };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const videoArg = process.argv[2] || null;
  const videoPath = resolveVideoPath(videoArg);

  ensureDir(OUT_DIR);

  // Get duration
  let durationMs = getVideoDurationMs(videoPath);

  // Extract frames
  const frames = extractFrames(videoPath);

  // Estimate duration from frames if ffprobe failed
  if (!durationMs) {
    durationMs = frames.length * 1000;
    console.log(`[analyze-video] Estimated duration from frames: ${durationMs}ms`);
  }

  // Analyze frames
  const frameAnalysis = await analyzeAllFrames(frames);
  const frameResults = frameAnalysis.map((r, i) => ({
    frame: i + 1,
    timeMs: i * 1000,
    description: r.description,
  }));

  // Voice transcription
  let voiceMode = 'none';
  let dubbingId = undefined;
  let transcript = { text: '', words: [] };

  // Try ElevenLabs first
  const dubbingResult = await dubbingAPITranscribe(videoPath);
  if (dubbingResult) {
    voiceMode = 'dubbed';
    dubbingId = dubbingResult.dubbingId;
    // Run Whisper on the dubbed audio for word timestamps
    const whisperResult = runWhisper(dubbingResult.dubbedAudioPath);
    if (whisperResult) {
      transcript = whisperResult;
    } else {
      transcript = { text: '', words: [] };
    }
  } else {
    // Fallback: extract WAV and run Whisper on original audio
    try {
      const wavPath = extractAudioWav(videoPath);
      const whisperResult = runWhisper(wavPath);
      if (whisperResult) {
        voiceMode = 'whisper';
        transcript = whisperResult;
      }
    } catch (err) {
      console.warn(`[analyze-video] Audio extraction failed: ${err.message}`);
    }
  }

  const output = {
    sourceVideo: videoPath,
    durationMs,
    voiceMode,
    ...(dubbingId !== undefined && { dubbingId }),
    transcript,
    frames: frameResults,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[analyze-video] Written: ${OUT_FILE}`);
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[analyze-video] Fatal error:', err.message);
    process.exit(1);
  });
}
