'use strict';
/**
 * figma-review.js
 *
 * Figma review stage — pushes all demo step screenshots into a new Figma design
 * file via the remote Figma MCP server, then reads design feedback back from
 * Figma comments.
 *
 * Workflow:
 *   1. Exports one PNG per step (the "start" frame) to out/<run>/figma-export/
 *   2. Starts a local preview server at http://localhost:4848
 *      - GET /          → step grid overview
 *      - GET /step/:n   → individual step at 1440×900 (used for Figma capture)
 *      - GET /frame/:f  → raw PNG
 *   3. Calls the remote Figma MCP server (via Anthropic SDK) once per step:
 *      - Step 1 → generate_figma_design outputMode="newFile" → captures file key
 *      - Steps 2-N → generate_figma_design outputMode="existingFile"
 *      - Opens the new Figma file in the browser after step 1 loads
 *      - User can refresh Figma as each step appears
 *   4. Saves figmaFileKey to run-state.json for downstream stages
 *   5. If FIGMA_REVIEW_FILE_KEY (or run-state key) is set:
 *      - Polls Figma REST API for unresolved comments
 *      - Saves parsed feedback to out/<run>/figma-feedback.json
 *   6. Waits for Enter before advancing (unless SCRATCH_AUTO_APPROVE=true)
 *
 * Reads:  out/<run>/qa-frames/         (step screenshots from QA stage)
 *         out/<run>/demo-script.json   (step order and labels)
 * Writes: out/<run>/figma-export/      (labeled PNGs + manifest)
 *         out/<run>/run-state.json     (figmaFileKey, figmaFileUrl)
 *         out/<run>/figma-feedback.json
 *
 * Environment:
 *   FIGMA_REVIEW=true            — must be set to run this stage
 *   ANTHROPIC_API_KEY=sk-ant-... — used by the `claude` CLI subprocess
 *   SCRATCH_AUTO_APPROVE=true    — skip interactive pause (still pushes to Figma)
 */

require('dotenv').config({ override: true });

const fs        = require('fs');
const path      = require('path');
const http      = require('http');
const { execSync, spawnSync } = require('child_process');

const PROJECT_ROOT  = path.resolve(__dirname, '../../..');
const OUT_DIR       = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const QA_FRAMES_DIR = path.join(OUT_DIR, 'qa-frames');
const EXPORT_DIR    = path.join(OUT_DIR, 'figma-export');
const SCRIPT_FILE   = path.join(OUT_DIR, 'demo-script.json');
const FEEDBACK_FILE = path.join(OUT_DIR, 'figma-feedback.json');
const RUN_STATE_FILE = path.join(OUT_DIR, 'run-state.json');

const AUTO_APPROVE   = process.env.SCRATCH_AUTO_APPROVE === 'true';
const PREVIEW_PORT   = 4848;

// ── Run-state helpers ─────────────────────────────────────────────────────────

function loadRunState() {
  try {
    if (fs.existsSync(RUN_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(RUN_STATE_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveRunState(patch) {
  const state = { ...loadRunState(), ...patch };
  fs.writeFileSync(RUN_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Returns the Figma file key for this run.
 * Priority: env var (manual override) → run-state.json
 */
function resolveFileKey() {
  return process.env.FIGMA_REVIEW_FILE_KEY || loadRunState().figmaFileKey || null;
}

// ── Step frame export ─────────────────────────────────────────────────────────

function exportStepFrames(steps) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  if (!fs.existsSync(QA_FRAMES_DIR)) {
    console.warn('[FigmaReview] qa-frames/ not found — no screenshots to export');
    return [];
  }

  const qaFiles = fs.readdirSync(QA_FRAMES_DIR);
  const exported = [];

  steps.forEach((step, idx) => {
    const num = String(idx + 1).padStart(2, '0');
    const suffixes = ['start', 'mid', 'end'];
    let srcFile = null;
    for (const suffix of suffixes) {
      const candidate = `${step.id}-${suffix}.png`;
      if (qaFiles.includes(candidate)) {
        srcFile = path.join(QA_FRAMES_DIR, candidate);
        break;
      }
    }

    if (!srcFile) {
      console.warn(`[FigmaReview] No frame found for step: ${step.id}`);
      return;
    }

    const destName = `${num}-${step.id}.png`;
    fs.copyFileSync(srcFile, path.join(EXPORT_DIR, destName));
    exported.push({ index: idx + 1, stepId: step.id, label: step.label, file: destName });
    console.log(`[FigmaReview] Exported: ${destName}`);
  });

  return exported;
}

// ── Local preview server ──────────────────────────────────────────────────────

/**
 * Serves:
 *   GET /           → step grid overview
 *   GET /step/:n    → single step at 1440×900 viewport (for Figma MCP capture)
 *   GET /frame/:f   → raw PNG
 */
function startPreviewServer(exported) {
  const gridItems = exported.map(e => `
    <div class="frame">
      <div class="label">${e.index}. ${e.label || e.stepId}</div>
      <a href="/step/${e.index}" target="_blank">
        <img src="/frame/${e.file}" alt="${e.label}" />
      </a>
    </div>`).join('');

  const gridHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Figma Review — Step Frames</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #fff; margin: 0; padding: 24px; }
    h1   { font-size: 18px; color: #00A67E; margin-bottom: 8px; }
    p    { font-size: 13px; color: rgba(255,255,255,0.5); margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 20px; }
    .frame { background: #1a1a1a; border-radius: 8px; padding: 12px; }
    .label { font-size: 12px; color: rgba(255,255,255,0.5); margin-bottom: 8px; }
    img  { width: 100%; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); }
    a    { display: block; text-decoration: none; }
  </style>
</head>
<body>
  <h1>Demo Review — ${exported.length} Steps</h1>
  <p>Screens are being pushed to Figma one by one. Refresh your Figma file to see progress.</p>
  <div class="grid">${gridItems}</div>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    // Grid overview
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(gridHtml);
      return;
    }

    // Per-step full-viewport page for Figma MCP capture (1440×900)
    const stepMatch = req.url.match(/^\/step\/(\d+)$/);
    if (stepMatch) {
      const stepIdx = parseInt(stepMatch[1], 10) - 1;
      const step = exported[stepIdx];
      if (step) {
        const filepath = path.join(EXPORT_DIR, step.file);
        if (fs.existsSync(filepath)) {
          const stepHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1440px; height: 900px; overflow: hidden; background: #0d1117; }
    img { display: block; width: 1440px; height: 900px; object-fit: contain; }
  </style>
</head>
<body>
  <img src="/frame/${encodeURIComponent(step.file)}" alt="${step.label || step.stepId}" />
</body>
</html>`;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(stepHtml);
          return;
        }
      }
      res.writeHead(404); res.end('Step not found');
      return;
    }

    // Raw PNG frames
    if (req.url.startsWith('/frame/')) {
      const filename = decodeURIComponent(req.url.replace('/frame/', ''));
      const filepath = path.join(EXPORT_DIR, path.basename(filename));
      if (fs.existsSync(filepath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(filepath).pipe(res);
      } else {
        res.writeHead(404); res.end();
      }
      return;
    }

    res.writeHead(404); res.end();
  });

  return new Promise((resolve) => {
    server.listen(PREVIEW_PORT, '127.0.0.1', () => {
      const url = `http://localhost:${PREVIEW_PORT}`;
      console.log(`[FigmaReview] Preview server: ${url}`);
      resolve({
        url,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

// ── Push steps to Figma via remote MCP ───────────────────────────────────────

/**
 * Pushes each step screenshot into Figma using the remote Figma MCP server.
 *
 * Invokes the `claude` CLI as a subprocess for each step. The CLI inherits the
 * OAuth MCP session established by running `/mcp` in Claude Code — no API keys
 * needed. Authenticate once before starting the pipeline:
 *
 *   /mcp   →  "Authentication successful. Connected to claude.ai Figma."
 *
 * Per-step behaviour:
 *   - Step 1: generate_figma_design outputMode="newFile"  → captures file key
 *   - Steps 2-N: generate_figma_design outputMode="existingFile"
 *
 * Each `claude -p` call handles all MCP tool use and captureId polling internally.
 *
 * @param {Array}  exported     Array of { index, stepId, label, file }
 * @param {string} previewUrl   Base URL of the local preview server
 * @returns {string|null}       The Figma file key, or null on failure
 */
async function pushStepsToFigma(exported, previewUrl) {
  const today    = new Date().toISOString().split('T')[0];
  const fileName = `Demo Review ${today}`;
  let figmaFileKey = resolveFileKey(); // reuse key if this run already pushed step 1

  console.log(`[FigmaReview] Pushing ${exported.length} step(s) to Figma via remote MCP (OAuth)...`);
  console.log(`[FigmaReview] Prerequisite: /mcp must have been run to authenticate.`);

  for (let i = 0; i < exported.length; i++) {
    const step    = exported[i];
    const stepUrl = `${previewUrl}/step/${step.index}`;
    const isFirst = i === 0 && !figmaFileKey;
    const label   = step.label || step.stepId;

    console.log(`[FigmaReview] [${i + 1}/${exported.length}] "${label}" → ${stepUrl}`);

    // Prompt for the claude CLI subprocess.
    // For the first step we ask for structured JSON output so we can parse the file key.
    // For subsequent steps we just need confirmation.
    const prompt = isFirst
      ? `Use the generate_figma_design MCP tool to capture the page at ${stepUrl} ` +
        `and create a new Figma file named "${fileName}". ` +
        `Use outputMode "newFile". Poll with the captureId every 5 seconds until ` +
        `status is "completed". ` +
        `Then output ONLY valid JSON in this exact format with no other text: ` +
        `{"fileKey":"<the-figma-file-key>"}`
      : `Use the generate_figma_design MCP tool to capture the page at ${stepUrl} ` +
        `into the existing Figma file with key "${figmaFileKey}". ` +
        `Use outputMode "existingFile". Poll with the captureId until status is "completed". ` +
        `Output: {"done":true}`;

    const result = spawnSync('claude', ['-p', prompt], {
      encoding: 'utf8',
      cwd:      PROJECT_ROOT,
      timeout:  180_000, // 3 min per step (capture + polling can be slow)
      env:      { ...process.env },
    });

    if (result.error) {
      console.error(`[FigmaReview] claude CLI error on step ${i + 1}: ${result.error.message}`);
      console.error('[FigmaReview] Ensure the `claude` binary is on PATH and /mcp auth is active.');
      continue;
    }

    if (result.status !== 0) {
      console.error(`[FigmaReview] claude CLI exited ${result.status} on step ${i + 1}`);
      if (result.stderr) console.error(result.stderr.substring(0, 400));
      continue;
    }

    const output = (result.stdout || '').trim();

    if (isFirst) {
      // Parse {"fileKey":"..."} from the response
      const jsonMatch = output.match(/\{[^}]*"fileKey"\s*:\s*"([^"]+)"[^}]*\}/);
      if (jsonMatch) {
        figmaFileKey = jsonMatch[1];
        const figmaFileUrl = `https://www.figma.com/file/${figmaFileKey}`;
        console.log(`[FigmaReview] New Figma file created: ${figmaFileUrl}`);
        saveRunState({ figmaFileKey, figmaFileUrl });
        // Open Figma in browser — user can refresh as subsequent steps arrive
        try { execSync(`open "${figmaFileUrl}"`, { stdio: 'ignore' }); } catch {}
      } else {
        console.warn(`[FigmaReview] Could not parse file key from response.`);
        console.warn(`[FigmaReview] Raw output: ${output.substring(0, 300)}`);
        // Fallback: try any long alphanumeric token that looks like a Figma key
        const fallback = output.match(/\b([A-Za-z0-9]{15,40})\b/);
        if (fallback) {
          figmaFileKey = fallback[1];
          console.warn(`[FigmaReview] Using fallback key: ${figmaFileKey}`);
          saveRunState({ figmaFileKey, figmaFileUrl: `https://www.figma.com/file/${figmaFileKey}` });
        }
      }
    } else {
      console.log(`[FigmaReview] Step ${i + 1} added to Figma file.`);
    }

    // Short pause between captures — gives Figma time to settle before next frame
    if (i < exported.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return figmaFileKey;
}

// ── Figma REST API — read comments ────────────────────────────────────────────

async function readFigmaComments(fileKey) {
  // Read comments via the claude CLI (inherits OAuth MCP session)
  // so no separate API key is required.
  console.log(`[FigmaReview] Reading comments from Figma file: ${fileKey}`);

  try {
    const prompt =
      `Use the Figma MCP get_metadata or equivalent tool to fetch all unresolved comments ` +
      `from Figma file key "${fileKey}". ` +
      `Output ONLY valid JSON: {"comments":[{"author":"<handle>","message":"<text>"}]}. ` +
      `If there are no comments output: {"comments":[]}`;

    const result = spawnSync('claude', ['-p', prompt], {
      encoding: 'utf8',
      cwd:      PROJECT_ROOT,
      timeout:  60_000,
      env:      { ...process.env },
    });

    if (result.error || result.status !== 0) {
      console.warn(`[FigmaReview] Could not read Figma comments via CLI: ${result.error?.message || result.stderr}`);
      return [];
    }

    const output = (result.stdout || '').trim();
    const jsonMatch = output.match(/\{[\s\S]*"comments"[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[FigmaReview] Could not parse comments response.');
      return [];
    }

    const data = JSON.parse(jsonMatch[0]);
    const comments = (data.comments || []).filter(c => c.message?.trim());
    console.log(`[FigmaReview] Found ${comments.length} comment(s)`);
    return comments;
  } catch (err) {
    console.warn(`[FigmaReview] Failed to read Figma comments: ${err.message}`);
    return [];
  }

}

// ── Interactive pause ─────────────────────────────────────────────────────────

function waitForEnter(prompt) {
  if (AUTO_APPROVE) {
    console.log(`[FigmaReview] SCRATCH_AUTO_APPROVE=true — skipping interactive pause`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const readline = require('readline').createInterface({
      input: process.stdin, output: process.stdout,
    });
    readline.question(`\n${prompt}\nPress Enter when done reviewing... `, () => {
      readline.close();
      resolve();
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Pre-flight: verify Figma MCP OAuth session is active.
 * Runs `claude -p` with a whoami prompt — if the MCP server isn't authenticated
 * it will fail with an opaque error. Catch it early with actionable instructions.
 *
 * @returns {boolean} true if authenticated, false if not
 */
function checkFigmaAuth() {
  console.log('[FigmaReview] Checking Figma MCP authentication...');
  try {
    const result = spawnSync('claude', ['-p',
      'Use the Figma MCP whoami tool. Return the result as plain text.',
    ], {
      encoding: 'utf8',
      cwd:      PROJECT_ROOT,
      timeout:  20_000,
      env:      { ...process.env },
    });

    if (result.status !== 0 || result.error) {
      console.error('[FigmaReview] Figma MCP auth check failed:');
      console.error('  The `claude` CLI could not reach the Figma MCP server.');
      console.error('  Run: /mcp  in your Claude Code session to authenticate with Figma.');
      console.error('  Then re-run the pipeline with --from=figma-review');
      return false;
    }

    const output = (result.stdout || '').trim();
    if (output.toLowerCase().includes('error') && !output.toLowerCase().includes('whoami')) {
      console.warn(`[FigmaReview] Figma MCP whoami returned: ${output.substring(0, 100)}`);
      console.warn('[FigmaReview] Proceeding — verify Figma access manually if issues arise.');
    } else {
      console.log(`[FigmaReview] Figma MCP authenticated: ${output.substring(0, 80)}`);
    }
    return true;
  } catch (err) {
    console.warn(`[FigmaReview] Could not verify Figma auth: ${err.message}. Proceeding anyway.`);
    return true; // non-blocking — don't halt if the check itself fails
  }
}

async function main() {
  if (process.env.FIGMA_REVIEW !== 'true') {
    console.log('[FigmaReview] FIGMA_REVIEW not enabled — skipping stage');
    return null;
  }

  // Pre-flight: check Figma MCP OAuth before doing expensive work
  const figmaAuthed = checkFigmaAuth();
  if (!figmaAuthed) {
    if (AUTO_APPROVE) {
      console.warn('[FigmaReview] SCRATCH_AUTO_APPROVE=true — skipping figma-review due to auth failure.');
      return null;
    }
    // In interactive mode, let the user decide
    await waitForEnter('Figma auth may not be active. Authenticate with /mcp and press Enter to retry, or Ctrl+C to skip.');
  }

  // Load step order from demo-script
  let steps = [];
  if (fs.existsSync(SCRIPT_FILE)) {
    try {
      const script = JSON.parse(fs.readFileSync(SCRIPT_FILE, 'utf8'));
      steps = (script.steps || []).map(s => ({
        id:    s.id,
        label: s.label || s.narration?.substring(0, 50),
      }));
    } catch (err) {
      console.warn(`[FigmaReview] Could not load demo-script.json: ${err.message}`);
    }
  }

  if (steps.length === 0) {
    console.warn('[FigmaReview] No steps found — nothing to export');
    return null;
  }

  // 1. Export step frames to figma-export/
  console.log(`[FigmaReview] Exporting ${steps.length} step frame(s)...`);
  const exported = exportStepFrames(steps);

  if (exported.length === 0) {
    console.warn('[FigmaReview] No frames exported — qa-frames/ may be empty. Run record+qa first.');
    return null;
  }

  // Write manifest
  fs.writeFileSync(path.join(EXPORT_DIR, 'manifest.json'), JSON.stringify({
    exportedAt: new Date().toISOString(),
    runDir:     OUT_DIR,
    steps:      exported,
  }, null, 2));

  // 2. Start preview server (required for MCP capture URLs)
  let previewServer;
  try {
    previewServer = await startPreviewServer(exported);
  } catch (err) {
    console.error(`[FigmaReview] Could not start preview server: ${err.message}`);
    return null;
  }

  // 3. Push all steps to Figma via remote MCP, one by one
  //    Figma file opens in browser after the first step is captured.
  //    User can refresh Figma to see additional steps appear.
  const figmaFileKey = await pushStepsToFigma(exported, previewServer.url);

  if (figmaFileKey) {
    const figmaFileUrl = `https://www.figma.com/file/${figmaFileKey}`;
    console.log(`\n[FigmaReview] All ${exported.length} step(s) pushed to Figma.`);
    console.log(`[FigmaReview] File: ${figmaFileUrl}`);
    console.log(`[FigmaReview] File key saved to run-state.json for downstream stages.`);
  } else {
    console.warn('[FigmaReview] Figma push did not produce a file key. Review preview at:', previewServer.url);
  }

  // 4. Wait for designer review
  const reviewUrl = figmaFileKey
    ? `https://www.figma.com/file/${figmaFileKey}`
    : previewServer.url;

  await waitForEnter(
    `Figma file open for review: ${reviewUrl}\nLeave comments in Figma, then press Enter to read them back into the pipeline.`
  );

  // Re-resolve file key after pause (in case it was just written to run-state)
  const finalFileKey = figmaFileKey || resolveFileKey();
  if (finalFileKey && finalFileKey !== figmaFileKey) {
    saveRunState({ figmaFileKey: finalFileKey, figmaFileUrl: `https://www.figma.com/file/${finalFileKey}` });
    console.log(`[FigmaReview] File key updated from run-state: ${finalFileKey}`);
  }

  // 5. Read Figma comments as build feedback
  let feedback = null;
  if (finalFileKey) {
    const comments = await readFigmaComments(finalFileKey);

    if (comments.length > 0) {
      feedback = {
        source:   'figma-comments',
        fileKey:  finalFileKey,
        readAt:   new Date().toISOString(),
        comments,
        summary:  comments.map((c, i) => `${i + 1}. [${c.author}]: ${c.message}`).join('\n'),
      };
      fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback, null, 2));
      console.log(`[FigmaReview] Feedback saved: figma-feedback.json (${comments.length} comment(s))`);
      comments.forEach((c, i) => console.log(`  ${i + 1}. ${c.author}: ${c.message}`));
    } else {
      console.log('[FigmaReview] No unresolved Figma comments — continuing without feedback');
    }
  }

  // 6. Shut down preview server
  if (previewServer) {
    await previewServer.close().catch(() => {});
  }

  return feedback;
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[FigmaReview] Fatal:', err.message);
    process.exit(1);
  });
}
