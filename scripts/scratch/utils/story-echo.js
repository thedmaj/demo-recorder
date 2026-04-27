'use strict';
/**
 * story-echo.js
 *
 * Whole-video story-fidelity helper. After the voiceover stage finishes
 * (so the final narration is set in stone), this asks Sonnet to grade
 * whether the demo's voiceover, end-to-end, actually tells the story the
 * user pitched in `inputs/prompt.txt`.
 *
 * The other quality gates run per-step (`prompt-fidelity-check` diffs
 * named entities; `embed-script-validate` checks narration vs visualState
 * step-by-step). Neither asks the holistic question: "does this 2-minute
 * video answer the user's prompt?" `story-echo-check` does.
 *
 * Pure I/O helpers here; the stage script in `scripts/scratch/scratch/
 * story-echo-check.js` calls them and writes the report + agent task md.
 *
 * Exports:
 *   buildStoryEchoMessages(promptText, voiceoverText, demoScript)
 *     → { system, userText }   — Sonnet message inputs
 *   parseStoryEchoResponse(rawText)
 *     → { score, drifts: [...], passed, summary }
 *   gradeStoryEcho(promptText, voiceoverText, demoScript, opts?)
 *     → Promise<{ score, drifts, passed, summary, model, raw }>
 *   buildStoryEchoFixTask({ runId, report, opts })
 *     → markdown agent handoff
 */

const STORY_ECHO_THRESHOLD_DEFAULT = 88; // mirrors the new QA_PASS_THRESHOLD default

// ─── Prompt construction ────────────────────────────────────────────────────

function buildStoryEchoMessages(promptText, voiceoverText, demoScript) {
  const stepLabels = (demoScript && Array.isArray(demoScript.steps))
    ? demoScript.steps.map((s, i) => `${i + 1}. ${s.label || s.id || '(unlabeled)'}`).join('\n')
    : '(no steps)';
  const persona = (demoScript && demoScript.persona) || {};

  const system =
    `You are reviewing whether a finished demo video tells the story the user asked for. ` +
    `You see three inputs: (1) the user's original pitch from inputs/prompt.txt, (2) the ` +
    `complete voiceover transcript that was recorded, and (3) a short outline of what the ` +
    `video shows (step labels in order). Your single job is to decide whether the voiceover, ` +
    `as a continuous narrative, answers the user's pitch end-to-end. ` +
    `Do NOT grade per-step quality; that's a different check. Do NOT invent criteria the user ` +
    `did not specify. Score strictly against the user's pitch.\n\n` +
    `Output JSON only — no prose, no markdown fences. Schema:\n` +
    `{\n` +
    `  "score":   <0-100>,\n` +
    `  "summary": "<one sentence describing whether the video tells the user's story>",\n` +
    `  "drifts":  [\n` +
    `    {\n` +
    `      "kind":       "<short-id, e.g. brand-not-mentioned, missing-reveal, persona-drift>",\n` +
    `      "severity":   "critical|warning",\n` +
    `      "evidence":   "<exact quote from the voiceover OR the prompt that proves the drift>",\n` +
    `      "suggestion": "<one-sentence fix>"\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `Scoring rules:\n` +
    `- 100 = voiceover answers the pitch end-to-end with named entities (brand, persona, products) consistent throughout.\n` +
    `- Deduct 10-20 per critical drift (brand never mentioned, climactic reveal absent, named persona swapped, products listed in prompt never appear).\n` +
    `- Deduct 5-10 per warning (entity mentioned only once when it should anchor the narrative; pacing skews to one product over others the prompt asked to feature).\n` +
    `- Floor at 0.`;

  const userText =
    `## USER'S ORIGINAL PITCH (inputs/prompt.txt)\n\n` +
    `\`\`\`\n${(promptText || '').slice(0, 6000)}\n\`\`\`\n\n` +
    `## VOICEOVER TRANSCRIPT (concatenated, in step order)\n\n` +
    `\`\`\`\n${(voiceoverText || '').slice(0, 8000)}\n\`\`\`\n\n` +
    `## VIDEO OUTLINE (demo-script step labels in order)\n\n` +
    stepLabels + `\n\n` +
    `## METADATA\n\n` +
    `- Persona: ${persona.name || '(unset)'}${persona.role ? `, ${persona.role}` : ''}\n` +
    `- Brand:   ${persona.company || persona.organization || '(unset)'}\n` +
    `- Plaid Link mode: ${demoScript && demoScript.plaidLinkMode || '(unset)'}\n\n` +
    `Score this demo. Return JSON only.`;

  return { system, userText };
}

// ─── Response parser ────────────────────────────────────────────────────────

function parseStoryEchoResponse(rawText, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : STORY_ECHO_THRESHOLD_DEFAULT;
  if (!rawText || typeof rawText !== 'string') {
    return {
      score: 0,
      summary: 'No response from grader.',
      drifts: [],
      passed: false,
      threshold,
      parseError: 'empty-response',
    };
  }
  // Tolerate fenced-JSON output:
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  let json;
  try {
    json = JSON.parse(cleaned);
  } catch (err) {
    return {
      score: 0,
      summary: 'Grader returned unparseable JSON.',
      drifts: [],
      passed: false,
      threshold,
      parseError: err.message,
      raw: rawText.slice(0, 500),
    };
  }
  const score = Number.isFinite(Number(json.score)) ? Math.max(0, Math.min(100, Number(json.score))) : 0;
  const drifts = Array.isArray(json.drifts) ? json.drifts.filter(d => d && d.kind && d.severity).map(d => ({
    kind: String(d.kind),
    severity: d.severity === 'critical' ? 'critical' : 'warning',
    evidence: String(d.evidence || ''),
    suggestion: String(d.suggestion || ''),
  })) : [];
  const criticalCount = drifts.filter(d => d.severity === 'critical').length;
  const passed = score >= threshold && criticalCount === 0;
  return {
    score,
    summary: String(json.summary || ''),
    drifts,
    criticalCount,
    warningCount: drifts.length - criticalCount,
    passed,
    threshold,
  };
}

// ─── Top-level grader (Anthropic Sonnet) ────────────────────────────────────

async function gradeStoryEcho(promptText, voiceoverText, demoScript, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      score: 0,
      summary: 'ANTHROPIC_API_KEY not set — grader skipped.',
      drifts: [],
      passed: true,
      threshold: opts.threshold || STORY_ECHO_THRESHOLD_DEFAULT,
      skipped: true,
      reason: 'no-anthropic-key',
    };
  }
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const model = opts.model || 'claude-sonnet-4-5-20250929';
  const { system, userText } = buildStoryEchoMessages(promptText, voiceoverText, demoScript);

  let raw = '';
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: userText }],
    });
    raw = (resp.content || []).map(b => b.text || '').join('').trim();
  } catch (err) {
    return {
      score: 0,
      summary: `Grader call failed: ${err.message}`,
      drifts: [],
      passed: true, // don't block on infrastructure failure
      threshold: opts.threshold || STORY_ECHO_THRESHOLD_DEFAULT,
      skipped: true,
      reason: `grader-error: ${err.message}`,
    };
  }
  const parsed = parseStoryEchoResponse(raw, { threshold: opts.threshold });
  return { ...parsed, model, raw };
}

// ─── Voiceover transcript collation ─────────────────────────────────────────

/**
 * Voiceover output today is a `voiceover-manifest.json` with per-step entries.
 * For story-echo we want a single concatenated transcript (the user's actual
 * end-to-end audio). This walks the manifest in step order and joins the
 * transcript fields (or falls back to demo-script narration when the manifest
 * lacks transcripts — happens when TTS hasn't been re-transcribed).
 */
function collateVoiceoverTranscript(voiceoverManifest, demoScript) {
  const steps = (demoScript && demoScript.steps) || [];
  const manifestById = new Map();
  if (voiceoverManifest && Array.isArray(voiceoverManifest.entries)) {
    for (const entry of voiceoverManifest.entries) {
      if (entry && entry.stepId) manifestById.set(entry.stepId, entry);
    }
  } else if (voiceoverManifest && typeof voiceoverManifest === 'object') {
    // Some manifest shapes are keyed by stepId at the root.
    for (const [stepId, entry] of Object.entries(voiceoverManifest)) {
      if (entry && typeof entry === 'object') manifestById.set(stepId, entry);
    }
  }
  const lines = [];
  for (const step of steps) {
    const entry = manifestById.get(step.id) || {};
    const text = entry.transcript || entry.text || step.narration || '';
    if (text.trim()) lines.push(text.trim());
  }
  return lines.join(' ');
}

// ─── Agent-task md builder ──────────────────────────────────────────────────

function buildStoryEchoFixTask({ runId, report, opts = {} }) {
  const orchestratorDriven = !!opts.orchestratorDriven;
  const finalCmd = orchestratorDriven
    ? `npm run pipe -- continue ${runId}`
    : `npm run pipe -- stage voiceover ${runId}`;
  const finalContext = orchestratorDriven
    ? `The orchestrator is **paused on a continue-gate** waiting for you. Once the drifts are ` +
      `addressed (in \`demo-script.json\` and/or \`voiceover-manifest.json\`), run the command ` +
      `below to release it.`
    : `Address each drift below, then re-run the voiceover stage:`;

  let md =
    `# Story-echo drift — ${runId}\n\n` +
    `> **What this is:** an agent-ready prompt produced by the \`story-echo-check\` stage. ` +
    `The grader looked at your original \`prompt.txt\` and the finished voiceover transcript ` +
    `and decided the demo doesn't tell your story end-to-end. Per-step QA can pass while ` +
    `the whole-video narrative drifts — this catches that.\n\n` +
    `---\n\n` +
    `## SUMMARY\n\n` +
    `- **Run id:** \`${runId}\`\n` +
    `- **Story-echo score:** ${report.score}/100  ` +
    `(threshold: ${report.threshold}, ${report.criticalCount || 0} critical, ${report.warningCount || 0} warning)\n` +
    `- **Grader summary:** ${report.summary || '(no summary)'}\n\n` +
    `---\n\n` +
    `## DRIFTS\n\n`;

  if (!report.drifts || report.drifts.length === 0) {
    md += `_(no per-drift entries — overall score is below threshold without specific findings.)_\n\n`;
  } else {
    report.drifts.forEach((d, i) => {
      md +=
        `### ${i + 1}. \`${d.kind}\` — ${d.severity.toUpperCase()}\n\n` +
        `- **Evidence:** ${d.evidence}\n` +
        `- **Suggestion:** ${d.suggestion}\n\n`;
    });
  }

  md +=
    `---\n\n` +
    `## EDITING CONTRACT\n\n` +
    `- For drifts that change WHAT the voiceover says: edit \`demo-script.json\` step ` +
    `narration, then re-run the \`voiceover\` stage so TTS regenerates.\n` +
    `- For drifts that are just sequencing or emphasis: editing \`demo-script.json\` is enough; ` +
    `voiceover will pick up the new narration on the next stage run.\n` +
    `- Do NOT touch \`prompt-templates.js\`, \`build-app.js\`, or any pipeline plumbing.\n\n` +
    `---\n\n` +
    `## FINAL\n\n` +
    finalContext + `\n\n` +
    '```bash\n' + finalCmd + '\n' + '```\n\n' +
    `\n_Generated at ${new Date().toISOString()} by \`story-echo-check\`._\n`;

  return md;
}

module.exports = {
  buildStoryEchoMessages,
  parseStoryEchoResponse,
  gradeStoryEcho,
  collateVoiceoverTranscript,
  buildStoryEchoFixTask,
  STORY_ECHO_THRESHOLD_DEFAULT,
};
