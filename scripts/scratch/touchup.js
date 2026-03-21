#!/usr/bin/env node
/**
 * touchup.js
 * Post-render interactive touchup loop.
 * Opens Remotion Studio (hot-reload on file changes), listens for user requests,
 * has Claude make targeted edits to Remotion compositions and overlay-plan.json.
 *
 * Usage: node scripts/scratch/touchup.js [--composition=DemoScratch]
 *        (called automatically by orchestrator unless --no-touchup)
 */

'use strict';

require('dotenv').config({ override: true });

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { spawn, execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECT_ROOT    = path.resolve(__dirname, '../..');
const OUT_DIR         = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const REMOTION_DIR    = path.join(PROJECT_ROOT, 'remotion');
const OVERLAY_PLAN    = path.join(OUT_DIR, 'overlay-plan.json');

const COMPOSITION_FILES = {
  DemoScratch:  path.join(REMOTION_DIR, 'ScratchComposition.jsx'),
  DemoEnhance:  path.join(REMOTION_DIR, 'EnhanceComposition.jsx'),
  // Fallback to the existing DemoComposition if the mode-specific file doesn't exist
  Demo:         path.join(REMOTION_DIR, 'DemoComposition.jsx'),
};

// ── Model config ──────────────────────────────────────────────────────────────

const TOUCHUP_MODEL      = 'claude-opus-4-6';
const TOUCHUP_MAX_TOKENS = 8192;

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const compArg = process.argv.find(a => a.startsWith('--composition='));
  const composition = compArg ? compArg.replace('--composition=', '') : 'DemoScratch';
  return { composition };
}

// ── Composition file resolution ───────────────────────────────────────────────

/**
 * Returns the path to the Remotion composition file for the given composition name.
 * Falls back to DemoComposition.jsx if the specific file doesn't exist.
 */
function resolveCompositionFile(composition) {
  const specific = COMPOSITION_FILES[composition];
  if (specific && fs.existsSync(specific)) {
    return specific;
  }

  // Check if there's a generic name match in the remotion directory
  const genericPath = path.join(REMOTION_DIR, `${composition}.jsx`);
  if (fs.existsSync(genericPath)) {
    return genericPath;
  }

  // Fall back to DemoComposition.jsx
  const fallback = COMPOSITION_FILES['Demo'];
  if (fs.existsSync(fallback)) {
    console.warn(`[Touchup] Composition file for "${composition}" not found — using DemoComposition.jsx`);
    return fallback;
  }

  console.warn(`[Touchup] No composition file found for "${composition}" in ${REMOTION_DIR}`);
  return null;
}

// ── JSON extraction from Claude response ──────────────────────────────────────

/**
 * Extracts a JSON object from a Claude response that may include markdown fences.
 */
function extractJSON(text) {
  // Try fenced JSON block
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch (_) {}
  }

  // Try raw JSON object
  const raw = text.match(/(\{[\s\S]*\})/s);
  if (raw) {
    try { return JSON.parse(raw[1].trim()); } catch (_) {}
  }

  throw new Error('No valid JSON object found in Claude response');
}

// ── Apply Claude's touchup response ───────────────────────────────────────────

/**
 * Applies the change returned by Claude.
 * Claude returns one of two shapes:
 *   { "file": "...", "change": "...", "newContent": "..." }
 *   { "overlayPlanPatch": { ...partial fields to merge }, "change": "..." }
 */
function applyChange(claudeResponse) {
  if (claudeResponse.overlayPlanPatch) {
    // Merge patch into overlay-plan.json
    let overlayPlan = {};
    if (fs.existsSync(OVERLAY_PLAN)) {
      try {
        overlayPlan = JSON.parse(fs.readFileSync(OVERLAY_PLAN, 'utf8'));
      } catch (err) {
        console.warn(`[Touchup] Could not read overlay-plan.json: ${err.message}`);
      }
    }

    // Deep merge: for overlay arrays, replace by stepId if matched, otherwise append
    if (claudeResponse.overlayPlanPatch.overlays && Array.isArray(overlayPlan.overlays)) {
      const patchOverlays = claudeResponse.overlayPlanPatch.overlays;
      for (const patchOverlay of patchOverlays) {
        const existingIdx = overlayPlan.overlays.findIndex(
          o => o.stepId === patchOverlay.stepId && o.type === patchOverlay.type
        );
        if (existingIdx !== -1) {
          overlayPlan.overlays[existingIdx] = {
            ...overlayPlan.overlays[existingIdx],
            ...patchOverlay,
          };
        } else {
          overlayPlan.overlays.push(patchOverlay);
        }
      }
      // Remove the overlays key from the patch so the shallow merge below doesn't stomp it
      const { overlays: _ignored, ...restPatch } = claudeResponse.overlayPlanPatch;
      Object.assign(overlayPlan, restPatch);
    } else {
      Object.assign(overlayPlan, claudeResponse.overlayPlanPatch);
    }

    fs.writeFileSync(OVERLAY_PLAN, JSON.stringify(overlayPlan, null, 2), 'utf8');
    return `Updated overlay-plan.json: ${claudeResponse.change || 'patch applied'}`;
  }

  if (claudeResponse.file && claudeResponse.newContent !== undefined) {
    // Write the file (composition JSX or any other file Claude identifies)
    const targetFile = path.isAbsolute(claudeResponse.file)
      ? claudeResponse.file
      : path.join(PROJECT_ROOT, claudeResponse.file);

    // Safety check: only allow writes inside the project root
    if (!targetFile.startsWith(PROJECT_ROOT)) {
      throw new Error(`[Touchup] Refused to write outside project root: ${targetFile}`);
    }

    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, claudeResponse.newContent, 'utf8');
    return `Updated ${path.relative(PROJECT_ROOT, targetFile)}: ${claudeResponse.change || 'edit applied'}`;
  }

  throw new Error(
    'Claude response is missing required fields. Expected either ' +
    '{ file, newContent } or { overlayPlanPatch }.'
  );
}

// ── Claude touchup call ───────────────────────────────────────────────────────

/**
 * Sends the user's touchup request to Claude with full context, and returns
 * the parsed JSON edit instructions.
 */
async function callClaudeTouchup(userRequest, compositionFile) {
  const client = new Anthropic();

  // Gather context
  const contextBlocks = [];

  // 1. Overlay plan (if it exists)
  if (fs.existsSync(OVERLAY_PLAN)) {
    try {
      const overlayContent = fs.readFileSync(OVERLAY_PLAN, 'utf8');
      contextBlocks.push({
        type: 'text',
        text: `## Current overlay-plan.json\n\`\`\`json\n${overlayContent}\n\`\`\``,
      });
    } catch (err) {
      console.warn(`[Touchup] Could not read overlay-plan.json: ${err.message}`);
    }
  }

  // 2. Composition file (if it exists)
  if (compositionFile && fs.existsSync(compositionFile)) {
    try {
      const compContent = fs.readFileSync(compositionFile, 'utf8');
      contextBlocks.push({
        type: 'text',
        text:
          `## Current ${path.basename(compositionFile)}\n` +
          `\`\`\`jsx\n${compContent}\n\`\`\``,
      });
    } catch (err) {
      console.warn(`[Touchup] Could not read composition file: ${err.message}`);
    }
  }

  // 3. The user's request
  contextBlocks.push({
    type: 'text',
    text:
      `## Touchup Request\n\n${userRequest}\n\n` +
      `## Instructions\n\n` +
      `Make the targeted change described in the request above. ` +
      `Prefer the smallest possible edit — only change what is necessary.\n\n` +
      `Return ONLY a JSON object in one of these two formats:\n\n` +
      `Format A — edit a file:\n` +
      `{\n` +
      `  "file": "<relative path from project root, e.g. remotion/ScratchComposition.jsx>",\n` +
      `  "change": "<one-sentence description of what changed>",\n` +
      `  "newContent": "<complete new file contents as a string>"\n` +
      `}\n\n` +
      `Format B — patch overlay-plan.json:\n` +
      `{\n` +
      `  "overlayPlanPatch": { "<partial overlay-plan.json fields to merge>" },\n` +
      `  "change": "<one-sentence description of what changed>"\n` +
      `}\n\n` +
      `No prose. No markdown fences around the outer JSON object.`,
  });

  const response = await client.messages.create({
    model:      TOUCHUP_MODEL,
    max_tokens: TOUCHUP_MAX_TOKENS,
    system:
      `You are an expert Remotion composition editor and overlay planner for Plaid demo videos. ` +
      `You make precise, targeted edits to Remotion JSX composition files and overlay-plan.json. ` +
      `You never rewrite files wholesale when a surgical change is sufficient. ` +
      `You understand the Plaid design system: dark navy background (#0d1117), teal accent (#00A67E), ` +
      `1440×900 viewport, and the overlay types: zoom_punch, callout_badge, lower_third, ` +
      `highlight_box, annotation_text.`,
    messages: [{ role: 'user', content: contextBlocks }],
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';

  return extractJSON(text);
}

// ── Final render ──────────────────────────────────────────────────────────────

function runFinalRender(composition) {
  const outputFile = path.join(OUT_DIR, 'demo-final.mp4');
  console.log(`[Touchup] Rendering final video: ${outputFile}`);

  execSync(
    `npx remotion render remotion/index.js ${composition} "${outputFile}"`,
    { stdio: 'inherit', cwd: PROJECT_ROOT }
  );

  console.log(`[Touchup] Final video: ${path.relative(PROJECT_ROOT, outputFile)}`);
  return outputFile;
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * @param {{ composition?: string }} options
 */
async function main({ composition = 'DemoScratch' } = {}) {
  const compositionFile = resolveCompositionFile(composition);

  // Launch Remotion Studio — pass --props so Studio opens with the real demo loaded,
  // not blank defaults. Human can immediately scrub to any frame without waiting.
  const propsFile     = path.join(OUT_DIR, 'remotion-props.json');
  const studioArgs    = ['remotion', 'studio', 'remotion/index.js'];
  if (fs.existsSync(propsFile)) {
    studioArgs.push(`--props=${propsFile}`);
    console.log('[Touchup] Launching Remotion Studio with demo props...');
  } else {
    console.log('[Touchup] Launching Remotion Studio (no remotion-props.json found — using defaults)...');
  }

  const studioProcess = spawn(
    'npx',
    studioArgs,
    {
      stdio:    ['ignore', 'inherit', 'inherit'],
      detached: false,
      cwd:      PROJECT_ROOT,
    }
  );

  studioProcess.on('error', err => {
    console.warn(`[Touchup] Remotion Studio process error: ${err.message}`);
  });

  console.log('[Touchup] Remotion Studio launching at http://localhost:3000');

  // Wait for Studio to start
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Print instructions
  console.log('');
  console.log('[Touchup] Review your demo in Remotion Studio.');
  console.log('[Touchup] Type touchup requests (e.g., "reduce zoom on step 8", "move badge higher").');
  console.log('[Touchup] Type \'render\' to export the final video.');
  console.log('[Touchup] Type \'skip\' or press Ctrl+C to exit without re-rendering.');
  console.log('');

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
  });

  // Graceful cleanup helper
  let exited = false;
  const cleanup = () => {
    if (exited) return;
    exited = true;
    rl.close();
    try {
      studioProcess.kill('SIGTERM');
    } catch (_) {}
  };

  process.on('SIGINT',  cleanup);
  process.on('SIGTERM', cleanup);

  // Readline loop
  await new Promise(resolve => {
    rl.on('line', async rawLine => {
      const line = rawLine.trim();

      if (!line) return;

      // Exit commands
      if (line === 'skip' || line === 'exit' || line === 'quit') {
        console.log('[Touchup] Exiting without re-render.');
        cleanup();
        resolve();
        return;
      }

      // Render command
      if (line === 'render') {
        console.log('[Touchup] Finalizing...');
        cleanup();
        try {
          runFinalRender(composition);
        } catch (err) {
          console.error(`[Touchup] Render failed: ${err.message}`);
        }
        resolve();
        return;
      }

      // Touchup request — send to Claude
      console.log('[Touchup] Sending request to Claude...');

      try {
        const claudeResponse = await callClaudeTouchup(line, compositionFile);
        const changeDescription = applyChange(claudeResponse);
        console.log(`[Touchup] Applied: ${changeDescription}. Remotion will hot-reload in ~2s.`);
      } catch (err) {
        console.error(`[Touchup] Error applying change: ${err.message}`);
        if (process.env.SCRATCH_AUTO_APPROVE !== 'true') {
          console.log('[Touchup] You can try rephrasing the request, or type \'render\' / \'skip\'.');
        }
      }
    });

    rl.on('close', () => {
      if (!exited) {
        console.log('[Touchup] Input stream closed.');
        cleanup();
      }
      resolve();
    });
  });
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const { composition } = parseArgs();
  main({ composition }).catch(err => {
    console.error('[Touchup] Fatal error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main };
