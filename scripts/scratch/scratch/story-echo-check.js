#!/usr/bin/env node
'use strict';
/**
 * story-echo-check.js
 *
 * Stage entry point. Runs after `voiceover` (so the final TTS transcript
 * is settled) and before `coverage-check`. Asks Sonnet whether the
 * concatenated voiceover, end-to-end, actually answers the user's
 * `inputs/prompt.txt` pitch — catching whole-video drift that per-step
 * QA cannot see.
 *
 * Reads:
 *   <runDir>/inputs/prompt.txt    (preferred archived per-run copy)
 *   <runDir>/prompt.txt           (legacy fallback)
 *   inputs/prompt.txt             (last-resort fallback)
 *   <runDir>/demo-script.json
 *   <runDir>/voiceover-manifest.json
 *
 * Writes:
 *   <runDir>/story-echo-report.json
 *   <runDir>/story-echo-task.md   (only when score < threshold)
 *
 * Skipped automatically when:
 *   - ANTHROPIC_API_KEY is missing (no grader available)
 *   - voiceover-manifest.json doesn't exist (voiceover stage didn't run yet)
 *   - STORY_ECHO_CHECK=0
 */

require('dotenv').config({ override: true });

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
function resolveOutDir() {
  return process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
}

const {
  collateVoiceoverTranscript,
  gradeStoryEcho,
  buildStoryEchoFixTask,
  STORY_ECHO_THRESHOLD_DEFAULT,
} = require('../utils/story-echo');

function safeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function readPromptText(runDir) {
  const candidates = [
    path.join(runDir, 'inputs', 'prompt.txt'),
    path.join(runDir, 'prompt.txt'),
    path.join(PROJECT_ROOT, 'inputs', 'prompt.txt'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try { return { path: c, text: fs.readFileSync(c, 'utf8') }; }
      catch (_) {}
    }
  }
  return null;
}

function emitPipeEvent(event, payload) {
  console.log(`::PIPE::${JSON.stringify({ event, at: new Date().toISOString(), ...payload })}`);
}

function isAgentMode() {
  const explicit = String(process.env.PIPE_AGENT_MODE ?? '').trim().toLowerCase();
  if (explicit === '0' || explicit === 'false' || explicit === 'no' || explicit === 'off') return false;
  if (explicit === '1' || explicit === 'true' || explicit === 'yes' || explicit === 'on') return true;
  if (process.env.CLAUDECODE === '1') return true;
  if (process.env.CLAUDE_CODE_VERSION) return true;
  if (process.env.CURSOR_AGENT_MODE === '1') return true;
  if (process.env.CURSOR_TRACE_ID) return true;
  return false;
}

async function main() {
  const runDir = resolveOutDir();
  const enabled = String(process.env.STORY_ECHO_CHECK ?? '1').trim() !== '0';
  if (!enabled) {
    console.log('[story-echo-check] STORY_ECHO_CHECK=0 — skipping.');
    return { passed: true, skipped: true, reason: 'disabled' };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[story-echo-check] ANTHROPIC_API_KEY missing — skipping.');
    return { passed: true, skipped: true, reason: 'no-anthropic-key' };
  }

  const prompt = readPromptText(runDir);
  if (!prompt) {
    console.log('[story-echo-check] no prompt.txt found — skipping.');
    return { passed: true, skipped: true, reason: 'no-prompt-txt' };
  }
  const demoScript = safeReadJson(path.join(runDir, 'demo-script.json'));
  if (!demoScript) {
    console.log('[story-echo-check] no demo-script.json — skipping.');
    return { passed: true, skipped: true, reason: 'no-demo-script' };
  }
  const voiceoverManifest = safeReadJson(path.join(runDir, 'voiceover-manifest.json'));
  if (!voiceoverManifest) {
    console.log('[story-echo-check] no voiceover-manifest.json — voiceover stage may not have run yet; skipping.');
    return { passed: true, skipped: true, reason: 'no-voiceover-manifest' };
  }

  const transcript = collateVoiceoverTranscript(voiceoverManifest, demoScript);
  if (!transcript || transcript.length < 50) {
    console.log('[story-echo-check] voiceover transcript too short (likely empty manifest) — skipping.');
    return { passed: true, skipped: true, reason: 'transcript-too-short' };
  }

  const threshold = parseInt(process.env.STORY_ECHO_THRESHOLD || String(STORY_ECHO_THRESHOLD_DEFAULT), 10);
  console.log(`[story-echo-check] grading whole-video echo (threshold ${threshold}/100)…`);
  const grade = await gradeStoryEcho(prompt.text, transcript, demoScript, { threshold });
  if (grade.skipped) {
    console.log(`[story-echo-check] grader skipped: ${grade.reason}`);
    return { passed: true, skipped: true, reason: grade.reason };
  }

  const runId = path.basename(runDir);
  console.log(
    `[story-echo-check] score: ${grade.score}/${threshold} ` +
    `(${grade.criticalCount || 0} critical, ${grade.warningCount || 0} warning)`
  );
  if (grade.summary) console.log(`[story-echo-check]   summary: ${grade.summary}`);
  for (const d of grade.drifts || []) {
    const tag = d.severity === 'critical' ? '[CRITICAL]' : '[WARN    ]';
    console.warn(`  ${tag} ${d.kind} — ${d.evidence}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    promptPath: path.relative(runDir, prompt.path),
    transcriptChars: transcript.length,
    threshold,
    score: grade.score,
    summary: grade.summary,
    drifts: grade.drifts,
    criticalCount: grade.criticalCount,
    warningCount: grade.warningCount,
    passed: grade.passed,
    model: grade.model || null,
  };
  fs.writeFileSync(path.join(runDir, 'story-echo-report.json'), JSON.stringify(report, null, 2));

  let taskPath = null;
  if (!grade.passed) {
    const md = buildStoryEchoFixTask({
      runId,
      report,
      opts: { orchestratorDriven: isAgentMode() },
    });
    taskPath = path.join(runDir, 'story-echo-task.md');
    fs.writeFileSync(taskPath, md, 'utf8');
    console.log(`[story-echo-check] task md → story-echo-task.md`);
  }

  emitPipeEvent('story_echo_check_done', {
    runId,
    passed: grade.passed,
    score: grade.score,
    threshold,
    criticalCount: grade.criticalCount || 0,
    warningCount: grade.warningCount || 0,
    taskPath: taskPath ? path.relative(runDir, taskPath) : null,
  });

  return report;
}

if (require.main === module) {
  main().catch(err => {
    console.error('[story-echo-check] Fatal error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main };
