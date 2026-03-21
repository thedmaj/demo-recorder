#!/usr/bin/env node
/**
 * scripts/start-eval-recorder.js
 *
 * Setup + launch script for the eval-recorder sub-package.
 *
 * What it does:
 *   1. Finds the latest pipeline run directory (via out/latest/.rundir)
 *   2. Reads demo-script.json + voiceover-manifest.json for step metadata
 *   3. Generates eval-recorder/adapter-config.json
 *   4. Generates eval-recorder/public/captions.json (word-level stubs from narration)
 *   5. Creates eval-recorder/public → symlink or copy of the run's assets
 *   6. Installs eval-recorder/node_modules if missing
 *   7. Starts eval-recorder/server.js
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

// ── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.join(__dirname, "..");
const EVAL_DIR = path.join(PROJECT_ROOT, "eval-recorder");
const EVAL_PUBLIC = path.join(EVAL_DIR, "public");
const ADAPTER_CONFIG_PATH = path.join(EVAL_DIR, "adapter-config.json");

// ── Find latest run ──────────────────────────────────────────────────────────

function findLatestRunDir() {
  const outDir = path.join(PROJECT_ROOT, "out");
  const latestSymlink = path.join(outDir, "latest");

  // Try following out/latest symlink (handles both absolute and relative targets)
  const symLinkOrDir = fs.existsSync(latestSymlink);
  if (symLinkOrDir) {
    try {
      // First try: standard realpath (works if target is absolute or rel to symlink dir)
      const real = fs.realpathSync(latestSymlink);
      if (fs.existsSync(real)) return real;
    } catch {}
    try {
      const target = fs.readlinkSync(latestSymlink);
      if (path.isAbsolute(target) && fs.existsSync(target)) return target;
      // Relative to symlink's directory
      const rel1 = path.resolve(outDir, target);
      if (fs.existsSync(rel1)) return rel1;
      // Relative to project root (some orchestrators write it this way)
      const rel2 = path.resolve(PROJECT_ROOT, target);
      if (fs.existsSync(rel2)) return rel2;
    } catch {}
  }

  // Try reading .rundir file
  const latestDotRundir = path.join(latestSymlink, ".rundir");
  if (fs.existsSync(latestDotRundir)) {
    const rundir = fs.readFileSync(latestDotRundir, "utf8").trim();
    if (fs.existsSync(rundir)) return rundir;
    const abs = path.join(PROJECT_ROOT, rundir);
    if (fs.existsSync(abs)) return abs;
  }

  // Fall back to most recent demos/ directory
  const demosDir = path.join(PROJECT_ROOT, "out", "demos");
  if (fs.existsSync(demosDir)) {
    const entries = fs
      .readdirSync(demosDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        mtime: fs.statSync(path.join(demosDir, e.name)).mtime,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    if (entries.length > 0) {
      return path.join(demosDir, entries[0].name);
    }
  }

  return null;
}

// ── Word-level caption generation ───────────────────────────────────────────

/**
 * Distributes words evenly across a time window to create stub word-level captions.
 * Not Whisper-precise but preserves text for editing.
 */
function distributeWords(narration, startS, endS) {
  const words = narration
    .replace(/[^\w\s''-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return [];

  const totalDuration = endS - startS;
  const wordDuration = totalDuration / words.length;

  return words.map((word, i) => ({
    word,
    start: parseFloat((startS + i * wordDuration).toFixed(3)),
    end: parseFloat((startS + (i + 1) * wordDuration).toFixed(3)),
  }));
}

// ── Resolve step timings from manifests ─────────────────────────────────────

function resolveStepTimings(runDir, steps) {
  // Prefer voiceover-manifest.json (accurate timing for the processed video)
  const manifestPath = path.join(runDir, "voiceover-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const clipMap = {};
    for (const clip of manifest.clips || []) {
      clipMap[clip.id] = clip;
    }

    return steps.map((step) => {
      const clip = clipMap[step.id];
      if (clip) {
        return {
          videoStartMs: clip.startMs,
          videoEndMs: clip.endMs,
          audioStartMs: clip.startMs,
          audioEndMs: clip.endMs,
        };
      }
      return null;
    });
  }

  // Fallback: use cumulative durationMs
  let cursor = 0;
  return steps.map((step) => {
    const start = cursor;
    cursor += step.durationMs;
    return {
      videoStartMs: start,
      videoEndMs: cursor,
      audioStartMs: start,
      audioEndMs: cursor,
    };
  });
}

// ── Main setup ───────────────────────────────────────────────────────────────

function setup() {
  console.log("[eval-recorder] Starting setup…\n");

  // 1. Find run directory
  const runDir = findLatestRunDir();
  if (!runDir) {
    console.error(
      "[eval-recorder] ERROR: No pipeline run found. Run `npm run demo` first."
    );
    process.exit(1);
  }
  console.log(`[eval-recorder] Using run: ${runDir}`);

  // 2. Read demo-script.json
  const scriptPath = path.join(runDir, "demo-script.json");
  if (!fs.existsSync(scriptPath)) {
    console.error(
      `[eval-recorder] ERROR: demo-script.json not found at ${scriptPath}`
    );
    process.exit(1);
  }
  const demoScript = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
  const steps = demoScript.steps || [];
  console.log(`[eval-recorder] Found ${steps.length} steps in demo-script.json`);

  // 3. Resolve step video/audio timing
  const timings = resolveStepTimings(runDir, steps);

  // 4. Generate adapter-config.json
  const runId = path.basename(runDir);
  const fps = 30; // Render FPS (matches ScratchComposition)

  const adapterSteps = steps.map((step, i) => {
    const timing = timings[i] || {
      videoStartMs: 0,
      videoEndMs: step.durationMs,
      audioStartMs: 0,
      audioEndMs: step.durationMs,
    };
    return {
      id: step.id,
      label: step.label || step.id,
      narration: step.narration || "",
      durationMs: timing.videoEndMs - timing.videoStartMs,
      videoStartMs: timing.videoStartMs,
      videoEndMs: timing.videoEndMs,
      audioStartMs: timing.audioStartMs,
      audioEndMs: timing.audioEndMs,
      startOffset: 0,
      endOffset: 0,
    };
  });

  const adapterConfig = {
    runId,
    recordingFile: "recording.mp4",
    voiceoverFile: "voiceover.mp3",
    captionsFile: "captions.json",
    fps,
    steps: adapterSteps,
  };

  fs.writeFileSync(ADAPTER_CONFIG_PATH, JSON.stringify(adapterConfig, null, 2));
  console.log(`[eval-recorder] Written adapter-config.json (${adapterSteps.length} steps)`);

  // 5. Set up public/ directory
  // Check if recording.mp4 is in the run dir or in the project public/
  const runRecording = path.join(runDir, "recording-processed.webm");
  const runMp4 = path.join(runDir, "demo-scratch.mp4");
  const projectPublicMp4 = path.join(PROJECT_ROOT, "public", "recording.mp4");

  // Determine which video file to use
  let sourceVideoPath = null;
  if (fs.existsSync(projectPublicMp4)) {
    sourceVideoPath = projectPublicMp4;
  } else if (fs.existsSync(runMp4)) {
    sourceVideoPath = runMp4;
  }

  // Determine voiceover
  const runVoiceover = path.join(runDir, "audio", "voiceover.mp3");
  const projectPublicVoiceover = path.join(PROJECT_ROOT, "public", "voiceover.mp3");
  let sourceVoiceoverPath = null;
  if (fs.existsSync(projectPublicVoiceover)) {
    sourceVoiceoverPath = projectPublicVoiceover;
  } else if (fs.existsSync(runVoiceover)) {
    sourceVoiceoverPath = runVoiceover;
  }

  // Create eval-recorder/public/
  fs.mkdirSync(EVAL_PUBLIC, { recursive: true });

  // Symlink or copy video
  if (sourceVideoPath) {
    const destVideo = path.join(EVAL_PUBLIC, "recording.mp4");
    if (!fs.existsSync(destVideo)) {
      try {
        fs.symlinkSync(sourceVideoPath, destVideo);
        console.log(`[eval-recorder] Symlinked recording.mp4 → ${sourceVideoPath}`);
      } catch (e) {
        // Symlink failed (e.g. Windows without privileges) — copy instead
        fs.copyFileSync(sourceVideoPath, destVideo);
        console.log(`[eval-recorder] Copied recording.mp4 from ${sourceVideoPath}`);
      }
    }
  } else {
    console.warn(
      "[eval-recorder] WARNING: No recording.mp4 found. Video will not play in Studio."
    );
  }

  // Symlink or copy voiceover
  if (sourceVoiceoverPath) {
    const destVoiceover = path.join(EVAL_PUBLIC, "voiceover.mp3");
    if (!fs.existsSync(destVoiceover)) {
      try {
        fs.symlinkSync(sourceVoiceoverPath, destVoiceover);
        console.log(`[eval-recorder] Symlinked voiceover.mp3 → ${sourceVoiceoverPath}`);
      } catch (e) {
        fs.copyFileSync(sourceVoiceoverPath, destVoiceover);
        console.log(`[eval-recorder] Copied voiceover.mp3 from ${sourceVoiceoverPath}`);
      }
    }
  }

  // 6. Generate stub captions.json
  const captionsPath = path.join(EVAL_PUBLIC, "captions.json");
  if (!fs.existsSync(captionsPath)) {
    console.log("[eval-recorder] Generating stub captions.json from narration…");
    const allWords = [];

    for (const step of adapterSteps) {
      if (!step.narration) continue;
      const startS = step.audioStartMs / 1000;
      const endS = step.audioEndMs / 1000;
      const words = distributeWords(step.narration, startS, endS);
      allWords.push(...words);
    }

    const captions = { words: allWords };
    fs.writeFileSync(captionsPath, JSON.stringify(captions, null, 2));
    console.log(`[eval-recorder] Written captions.json (${allWords.length} words)`);
  } else {
    console.log("[eval-recorder] captions.json already exists — skipping generation");
  }

  // 7. Install node_modules if missing
  const nmPath = path.join(EVAL_DIR, "node_modules");
  if (!fs.existsSync(nmPath)) {
    console.log("[eval-recorder] Installing dependencies (npm install)…");
    execSync("npm install", { cwd: EVAL_DIR, stdio: "inherit" });
    console.log("[eval-recorder] Dependencies installed.");
  }

  console.log("\n[eval-recorder] Setup complete.\n");
}

// ── Run ──────────────────────────────────────────────────────────────────────

setup();

// Launch server.js
const server = spawn("node", ["server.js"], {
  cwd: EVAL_DIR,
  stdio: "inherit",
  shell: process.platform === "win32",
});

server.on("error", (err) => {
  console.error("[eval-recorder] Failed to start server:", err.message);
  process.exit(1);
});

server.on("close", (code) => {
  process.exit(code || 0);
});

process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGTERM"));
