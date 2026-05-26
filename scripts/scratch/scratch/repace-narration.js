'use strict';
/**
 * repace-narration.js
 *
 * Reads sync-debt-report.json and rewrites narration text for steps the
 * classifier flagged as `audio-too-long` or `audio-too-short`. The new
 * narration targets the step's measured video duration (± a small tail)
 * so audio fits screen content without forcing auto-gap into multi-second
 * freezes or ×2.5 speed-ups.
 *
 * The rewritten narration is written back to demo-script.json. The
 * voiceover stage's fingerprint cache then auto-invalidates the affected
 * vo_*.mp3 clips on its next run — only the rewritten steps regenerate
 * via ElevenLabs.
 *
 * Guardrails:
 *   • If the recommended word target is more than ±60% of the current
 *     word count, the step is SKIPPED. A 8-word→135-word rewrite is not
 *     a "rewrite" — it's a new script. Those cases need re-record or
 *     video-trim, not narration repace.
 *   • Concrete claims (numbers, product names, decisions like ACCEPT)
 *     are preserved verbatim — the prompt enforces this.
 *
 * Reads:
 *   sync-debt-report.json
 *   demo-script.json
 *
 * Writes:
 *   demo-script.json                 (in-place rewrite of narration fields)
 *   narration-repace-report.json     (audit trail per step)
 *
 * Public API:
 *   const { main, isWithinRewriteBudget } = require('./repace-narration');
 *   await main();
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const RUN_DIR = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');

const MODEL_ID = process.env.NARRATION_REPACE_MODEL || 'claude-sonnet-4-6';
const MAX_REWRITE_DRIFT_PCT = parseFloat(process.env.NARRATION_REPACE_MAX_DRIFT_PCT || '0.6');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return null; }
}

function wordsOf(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

/**
 * True when the target word count is within ±MAX_REWRITE_DRIFT_PCT of the
 * current count. Outside this band the rewrite would change the demo's
 * substance, not its pacing — refuse and surface to the operator.
 */
function isWithinRewriteBudget(currentWords, targetWords) {
  if (!currentWords || !targetWords) return false;
  const ratio = targetWords / currentWords;
  return ratio >= (1 - MAX_REWRITE_DRIFT_PCT) && ratio <= (1 + MAX_REWRITE_DRIFT_PCT);
}

function buildRepaceSystemPrompt() {
  return [
    'You rewrite Plaid product demo narration to fit a target word count.',
    '',
    'Hard rules:',
    '- Hit the target word count within ±2 words. Count words in the response.',
    '- Preserve every numeric value, product name (Plaid Auth, Plaid Signal, Plaid Protect, Trust Index, etc.),',
    '  decision token (ACCEPT, REVIEW, REROUTE, APPROVED), endpoint name (/signal/evaluate, /protect/event/send), and any quoted UI label.',
    '- Preserve the speaker voice: active, declarative, no filler ("simply", "just", "seamlessly", "unfortunately").',
    '- One concept per sentence. Sentences 8–14 words each.',
    '- DO NOT add new facts or claims. If you need to shorten, drop modifiers, sentence connectors, and parentheticals first.',
    '- DO NOT add hedging ("might", "could", "potentially") that wasn\'t in the original.',
    '',
    'Return ONLY the rewritten narration as plain prose. No headings, no commentary, no quotation marks.',
  ].join('\n');
}

function buildRepaceUserPrompt(step) {
  return [
    `Step id: ${step.stepId}`,
    `Current narration (${step.currentWordCount} words, ${step.narrationMs}ms estimated):`,
    step.narrationText,
    '',
    `Target: ${step.wordTarget} words (so the audio fits the ${step.videoMs}ms recorded video).`,
    `Drift to correct: ${step.driftMs}ms (${step.classification}).`,
    '',
    'Rewrite the narration to exactly the target word count. Preserve concrete claims.',
  ].join('\n');
}

async function callClaude(systemPrompt, userPrompt) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot repace narration');
  }
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model: MODEL_ID,
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text;
}

async function repaceStep(step) {
  const systemPrompt = buildRepaceSystemPrompt();
  let userPrompt = buildRepaceUserPrompt(step);
  let attempt = 0;
  let lastText = '';
  while (attempt < 3) {
    attempt += 1;
    const text = await callClaude(systemPrompt, userPrompt);
    const words = wordsOf(text);
    lastText = text;
    // Accept within ±2 of target.
    if (Math.abs(words - step.wordTarget) <= 2) {
      return { ok: true, text, attempts: attempt, words };
    }
    // Otherwise retry with a corrective hint appended to the prompt.
    const drift = words - step.wordTarget;
    const correction = drift > 0
      ? `Your last attempt was ${drift} words too long. Shorten without dropping concrete claims.`
      : `Your last attempt was ${Math.abs(drift)} words too short. Add an explanatory clause without inventing new facts.`;
    userPrompt = `${userPrompt}\n\n${correction}\nPrevious attempt: ${text}`;
  }
  return { ok: false, text: lastText, attempts: attempt, words: wordsOf(lastText) };
}

/**
 * @param {string} [runDir]
 */
async function main(runDir) {
  const outDir = runDir || RUN_DIR;
  const syncDebtPath = path.join(outDir, 'sync-debt-report.json');
  const demoScriptPath = path.join(outDir, 'demo-script.json');

  const syncDebt = safeReadJson(syncDebtPath);
  const demoScript = safeReadJson(demoScriptPath);

  if (!syncDebt) {
    console.log('[repace-narration] sync-debt-report.json missing — skipping (run measure-sync-debt first).');
    return { skipped: true, reason: 'no-sync-debt' };
  }
  if (!demoScript) {
    console.log('[repace-narration] demo-script.json missing — skipping.');
    return { skipped: true, reason: 'no-demo-script' };
  }
  if (!Array.isArray(syncDebt.steps) || syncDebt.steps.length === 0) {
    console.log('[repace-narration] no sync-debt steps — skipping.');
    return { skipped: true, reason: 'no-steps' };
  }

  const candidates = syncDebt.steps.filter((s) =>
    s.classification === 'audio-too-long' || s.classification === 'audio-too-short'
  );

  if (candidates.length === 0) {
    console.log('[repace-narration] no steps need narration repace — all within tolerance or routed to video adjustment.');
    fs.writeFileSync(
      path.join(outDir, 'narration-repace-report.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), repacedSteps: [], skippedSteps: [], skipped: false }, null, 2),
      'utf8'
    );
    return { skipped: false, repacedSteps: [], skippedSteps: [] };
  }

  const stepsById = new Map(
    (demoScript.steps || []).map((s) => [s.id, s])
  );

  const repacedSteps = [];
  const skippedSteps = [];

  for (const candidate of candidates) {
    const scriptStep = stepsById.get(candidate.stepId);
    if (!scriptStep) {
      skippedSteps.push({ stepId: candidate.stepId, reason: 'step-not-in-demo-script' });
      continue;
    }

    const currentWords = wordsOf(scriptStep.narration);
    if (!isWithinRewriteBudget(currentWords, candidate.wordTarget)) {
      skippedSteps.push({
        stepId: candidate.stepId,
        reason: 'outside-rewrite-budget',
        currentWords,
        wordTarget: candidate.wordTarget,
        driftRatio: candidate.wordTarget / currentWords,
        recommendation:
          candidate.classification === 'audio-too-short' && currentWords < candidate.wordTarget * 0.4
            ? 'video has excess dead air — trim post-process keep-ranges or re-record this step shorter'
            : 'rewrite would change demo substance — manual review needed',
      });
      console.log(`[repace-narration] SKIP ${candidate.stepId} (${currentWords}w → ${candidate.wordTarget}w outside ±${Math.round(MAX_REWRITE_DRIFT_PCT * 100)}% budget)`);
      continue;
    }

    console.log(`[repace-narration] Rewriting ${candidate.stepId} (${currentWords}w → ${candidate.wordTarget}w, drift ${candidate.driftMs}ms)`);
    try {
      const result = await repaceStep(candidate);
      const accepted = result.ok;
      const previousNarration = scriptStep.narration;

      if (accepted) {
        scriptStep.narration = result.text;
        scriptStep.narrationRepaced = {
          repacedAt: new Date().toISOString(),
          previousNarration,
          previousWordCount: currentWords,
          targetWordCount: candidate.wordTarget,
          finalWordCount: result.words,
          driftMs: candidate.driftMs,
          attempts: result.attempts,
          model: MODEL_ID,
        };
        repacedSteps.push({
          stepId: candidate.stepId,
          previousWords: currentWords,
          finalWords: result.words,
          targetWords: candidate.wordTarget,
          attempts: result.attempts,
        });
      } else {
        skippedSteps.push({
          stepId: candidate.stepId,
          reason: 'rewrite-failed-to-hit-target',
          attempts: result.attempts,
          lastWords: result.words,
          targetWords: candidate.wordTarget,
        });
        console.warn(`[repace-narration] WARN ${candidate.stepId} failed to hit target after ${result.attempts} attempts (last: ${result.words}w)`);
      }
    } catch (err) {
      skippedSteps.push({ stepId: candidate.stepId, reason: `error: ${err.message}` });
      console.warn(`[repace-narration] ERROR ${candidate.stepId}: ${err.message}`);
    }
  }

  if (repacedSteps.length > 0) {
    fs.writeFileSync(demoScriptPath, JSON.stringify(demoScript, null, 2), 'utf8');
    console.log(`[repace-narration] Updated demo-script.json (${repacedSteps.length} step(s) rewritten).`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    model: MODEL_ID,
    maxRewriteDriftPct: MAX_REWRITE_DRIFT_PCT,
    repacedSteps,
    skippedSteps,
  };
  fs.writeFileSync(
    path.join(outDir, 'narration-repace-report.json'),
    JSON.stringify(report, null, 2),
    'utf8'
  );

  console.log(`[repace-narration] Done. Repaced=${repacedSteps.length}, skipped=${skippedSteps.length}.`);
  return { skipped: false, ...report };
}

module.exports = {
  main,
  isWithinRewriteBudget,
  wordsOf,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[repace-narration] Fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
