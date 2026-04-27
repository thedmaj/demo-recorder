'use strict';
/**
 * qa-touchup.js
 *
 * Builds an agent-ready prompt that lets Cursor / Claude Code make surgical,
 * single-step edits to a built demo's HTML + Playwright script in response to
 * QA findings, instead of regenerating the whole app via LLM (which is what
 * the existing `--build-fix-mode=touchup` path still does — see
 * `scripts/scratch/scratch/build-app.js` `generateApp` call).
 *
 * Pure I/O helpers (no LLM / network calls happen here — the agent reads
 * frame PNGs and edits files using its own Read / StrReplace tools, scoped
 * by the per-step blocks this helper extracts.)
 *
 * Exports:
 *   buildQaTouchupPrompt(runDir, opts) → { promptMarkdown, summary }
 *
 * Plus testable helpers for the unit tests:
 *   readQaReportForRun, extractFailingSteps, findStepFrames,
 *   extractStepHtmlBlock, extractPlaywrightRow, analyzeSystemicSignals.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

// Categories that the orchestrator treats as "shared chrome" — i.e. issues
// that span multiple steps and should escalate from a per-step touchup to a
// fullbuild. Mirrors `analyzeFixModeForQaIteration` in orchestrator.js.
const SHARED_CHROME_CATEGORIES = new Set([
  'missing-logo',
  'panel-visibility',
  'slide-template-misuse',
]);

const DEFAULT_FULLBUILD_STEP_THRESHOLD = 3;

// ─── tiny IO helpers (kept private to the module) ───────────────────────────

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeRead(file, max = 600000) {
  try {
    const buf = fs.readFileSync(file, 'utf8');
    return max && buf.length > max ? buf.slice(0, max) : buf;
  } catch (_) {
    return '';
  }
}

// ─── 1) QA report reader ────────────────────────────────────────────────────

/**
 * Locate the most-relevant QA report in a run dir. Prefers the build-QA
 * report (because that's what the touchup loop is responding to during the
 * build phase), falls back to the highest-numbered post-record `qa-report-N.json`.
 *
 * Returns { path, report } or null when nothing is found.
 */
function readQaReportForRun(runDir) {
  if (!runDir || !fs.existsSync(runDir)) return null;

  const buildReportPath = path.join(runDir, 'qa-report-build.json');
  if (fs.existsSync(buildReportPath)) {
    const report = safeReadJson(buildReportPath);
    if (report) return { path: buildReportPath, report };
  }

  // Find the highest-numbered post-record qa-report-N.json.
  let candidates = [];
  try {
    candidates = fs.readdirSync(runDir).filter((f) => /^qa-report-\d+\.json$/.test(f));
  } catch (_) {}
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const an = parseInt(a.match(/^qa-report-(\d+)\.json$/)[1], 10);
    const bn = parseInt(b.match(/^qa-report-(\d+)\.json$/)[1], 10);
    return bn - an;
  });
  const latest = path.join(runDir, candidates[0]);
  const report = safeReadJson(latest);
  return report ? { path: latest, report } : null;
}

// ─── 2) Failing-step extraction ─────────────────────────────────────────────

/**
 * Normalize the QA report's per-step issue list into the shape the prompt
 * builder uses. Prefers `stepsWithIssues` (already filtered to failing
 * steps by qa-review.js), falls back to `steps` and filters by score +
 * `critical`. Always returns plain JS objects safe for JSON serialization.
 */
function extractFailingSteps(qaReport, opts = {}) {
  if (!qaReport || typeof qaReport !== 'object') return [];
  const threshold = Number.isFinite(opts.passThreshold)
    ? opts.passThreshold
    : Number(qaReport.passThreshold) || 80;

  let raw;
  if (Array.isArray(qaReport.stepsWithIssues) && qaReport.stepsWithIssues.length > 0) {
    raw = qaReport.stepsWithIssues;
  } else if (Array.isArray(qaReport.steps)) {
    raw = qaReport.steps.filter((s) => {
      if (!s) return false;
      if (s.critical) return true;
      const score = Number(s.score);
      return Number.isFinite(score) && score < threshold;
    });
  } else {
    raw = [];
  }

  return raw
    .filter((s) => s && s.stepId)
    .map((s) => ({
      stepId: String(s.stepId),
      score: Number.isFinite(Number(s.score)) ? Number(s.score) : null,
      issues: Array.isArray(s.issues) ? s.issues.map(String) : [],
      suggestions: Array.isArray(s.suggestions) ? s.suggestions.map(String) : [],
      categories: Array.isArray(s.categories) ? s.categories.map(String) : [],
      critical: !!s.critical,
    }));
}

// ─── 3) Frame-path resolver (handles BOTH naming conventions) ───────────────

/**
 * Find the per-step QA frames on disk. There are two conventions in this
 * codebase today:
 *
 *   A. Post-record QA writes `qa-frames/<stepId>-{start,mid,end}.png`.
 *   B. Build-QA writes `artifacts/qa/frames/<stepId>-buildqa-<rowIndex>-{start,mid,end}.png`
 *      (also mirrored to legacy `qa-frames/<stepId>-buildqa-...`).
 *
 * The legacy LLM-touchup loader in build-app.js only knows about (A), so
 * after a build-QA failure it gets ZERO visual context — see the side-quest
 * fix in build-app.js. This helper handles both, preferring the latest row
 * for build-QA frames.
 *
 * Returns an array of { suffix: 'start'|'mid'|'end', path: string, source: 'build-qa'|'post-record' }.
 */
function findStepFrames(runDir, stepId) {
  if (!runDir || !stepId) return [];
  const frames = [];
  const seenSuffixes = new Set();

  // Try build-QA naming first (most likely to be relevant during touchup).
  const buildQaDirs = [
    path.join(runDir, 'artifacts', 'qa', 'frames'),
    path.join(runDir, 'qa-frames'),
  ];
  for (const dir of buildQaDirs) {
    if (!fs.existsSync(dir)) continue;
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    const safeId = String(stepId);
    const buildQaPattern = new RegExp(
      `^${safeId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}-buildqa-(\\d+)-(start|mid|end)\\.png$`,
    );
    // Group by suffix, keep the latest rowIndex per suffix.
    const bySuffix = new Map();
    for (const f of files) {
      const m = f.match(buildQaPattern);
      if (!m) continue;
      const rowIndex = parseInt(m[1], 10);
      const suffix = m[2];
      const cur = bySuffix.get(suffix);
      if (!cur || rowIndex > cur.rowIndex) {
        bySuffix.set(suffix, { rowIndex, file: f });
      }
    }
    for (const [suffix, { file }] of bySuffix.entries()) {
      if (seenSuffixes.has(suffix)) continue;
      frames.push({ suffix, path: path.join(dir, file), source: 'build-qa' });
      seenSuffixes.add(suffix);
    }
    if (frames.length > 0) break; // first dir with build-QA frames wins
  }

  // Fall back to post-record naming for any suffix not yet found.
  const postRecordDir = path.join(runDir, 'qa-frames');
  if (fs.existsSync(postRecordDir)) {
    for (const suffix of ['start', 'mid', 'end']) {
      if (seenSuffixes.has(suffix)) continue;
      const candidate = path.join(postRecordDir, `${stepId}-${suffix}.png`);
      if (fs.existsSync(candidate)) {
        frames.push({ suffix, path: candidate, source: 'post-record' });
        seenSuffixes.add(suffix);
      }
    }
  }

  // Stable order: start, mid, end.
  const order = { start: 0, mid: 1, end: 2 };
  frames.sort((a, b) => (order[a.suffix] ?? 9) - (order[b.suffix] ?? 9));
  return frames;
}

// ─── 4) Step-block + Playwright-row extractors ──────────────────────────────

/**
 * Pull one step's `<div data-testid="step-<id>" class="step …">…</div>` out of
 * the host app's HTML. Mirrors the regex pattern used by post-slides.js
 * (`stepBlockRegex`) so the agent's StrReplace boundary is identical to the
 * existing slide-splice path — no risk of writing inconsistent edits.
 *
 * Adds end-of-string `$` to the lookahead so the LAST step in a document
 * (no closing sentinel) still extracts. Truncates very large blocks at
 * `maxChars` so we stay inside agent prompt budgets.
 */
function extractStepHtmlBlock(html, stepId, maxChars = 8000) {
  if (!html || !stepId) return null;
  const safeId = String(stepId).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(
    `<div[^>]*\\bdata-testid="step-${safeId}"[^>]*>[\\s\\S]*?` +
    `(?=<div[^>]*\\bdata-testid="step-|<!--[\\s\\S]*?SIDE PANELS[\\s\\S]*?-->|` +
    `<div[^>]*\\bid="(?:link-events-panel|api-response-panel)"|<\\/body>|$)`,
    'i'
  );
  const m = String(html).match(re);
  if (!m) return null;
  const chunk = m[0].trim();
  if (!maxChars || chunk.length <= maxChars) return chunk;
  return chunk.slice(0, maxChars) + '\n<!-- truncated for prompt budget -->';
}

/**
 * Find the row in `playwright-script.json` that drives a given step. Rows
 * key off either `stepId` or `id` in this codebase (see
 * `dedupePlaywrightRowsByStepId` in build-app.js). Returns null if not found.
 */
function extractPlaywrightRow(playwrightJson, stepId) {
  if (!playwrightJson || !stepId) return null;
  const rows = Array.isArray(playwrightJson.steps) ? playwrightJson.steps : [];
  return rows.find((r) => r && (r.stepId === stepId || r.id === stepId)) || null;
}

// ─── 5) Systemic-issue heuristic (mirrors orchestrator.js) ──────────────────

/**
 * Replicates the routing logic in `analyzeFixModeForQaIteration` so the
 * task .md can stop the agent from doing surgical edits when the failure is
 * structural. Returns { systemic: bool, reasons: string[], distinctFailingSteps: number }.
 */
function analyzeSystemicSignals(qaReport, opts = {}) {
  const reasons = [];
  if (!qaReport || typeof qaReport !== 'object') {
    return { systemic: false, reasons, distinctFailingSteps: 0 };
  }
  const threshold = Number.isFinite(opts.fullbuildStepThreshold)
    ? opts.fullbuildStepThreshold
    : DEFAULT_FULLBUILD_STEP_THRESHOLD;

  const failing = extractFailingSteps(qaReport);
  const distinct = new Set(failing.map((s) => s.stepId));
  if (distinct.size >= threshold) reasons.push(`failing_steps_gte_${threshold}`);

  if (typeof qaReport.overrideReason === 'string' && qaReport.overrideReason.trim()) {
    reasons.push('build_qa_guardrail_override');
  }

  if (qaReport.deterministicGateEnabled && qaReport.deterministicPassed === false) {
    reasons.push('deterministic_blocker_gate');
  }

  const sharedChromeStepIds = new Set();
  for (const s of failing) {
    if (s.categories.some((c) => SHARED_CHROME_CATEGORIES.has(c))) {
      sharedChromeStepIds.add(s.stepId);
    }
  }
  if (sharedChromeStepIds.size >= 2) reasons.push('shared_chrome_multistep');

  return { systemic: reasons.length > 0, reasons, distinctFailingSteps: distinct.size };
}

// ─── 6) Prompt builder ──────────────────────────────────────────────────────

/**
 * Resolve the run's HTML + Playwright file paths, accommodating the two
 * layouts that build-app.js emits: the canonical `artifacts/build/scratch-app/`
 * and the legacy mirror at `<run>/scratch-app/`.
 */
function resolveBuildArtifacts(runDir) {
  const candidates = [
    path.join(runDir, 'artifacts', 'build', 'scratch-app'),
    path.join(runDir, 'scratch-app'),
  ];
  for (const dir of candidates) {
    const html = path.join(dir, 'index.html');
    const pw = path.join(dir, 'playwright-script.json');
    if (fs.existsSync(html)) return { dir, htmlPath: html, playwrightPath: pw };
  }
  return null;
}

function buildQaTouchupPrompt(runDir, opts = {}) {
  if (!runDir || !fs.existsSync(runDir)) {
    throw new Error(`qa-touchup: runDir not found — ${runDir}`);
  }
  const runId = path.basename(runDir);

  const qa = readQaReportForRun(runDir);
  if (!qa) throw new Error('qa-touchup: no QA report found (qa-report-build.json or qa-report-N.json)');

  const failing = extractFailingSteps(qa.report);
  const systemic = analyzeSystemicSignals(qa.report);

  const artifacts = resolveBuildArtifacts(runDir);
  if (!artifacts) throw new Error('qa-touchup: no scratch-app build found — build the demo before running touchup');
  const html = safeRead(artifacts.htmlPath);
  const playwright = safeReadJson(artifacts.playwrightPath) || {};
  const demoScript = safeReadJson(path.join(runDir, 'demo-script.json')) || {};

  // Per-step blocks: html chunk + playwright row + frame paths.
  const stepBlocks = failing.map((s) => {
    const frames = findStepFrames(runDir, s.stepId);
    return {
      ...s,
      html: extractStepHtmlBlock(html, s.stepId, 6000) ||
        '<!-- step container not found in index.html — escalate to fullbuild -->',
      playwrightRow: extractPlaywrightRow(playwright, s.stepId) || null,
      frames,
    };
  });

  // ── Markdown assembly ────────────────────────────────────────────────────
  const passThreshold = Number(qa.report.passThreshold) || 80;
  const overallScore = Number(qa.report.overallScore);
  const buildMode = demoScript.buildMode || 'app-only';
  const plaidLinkMode = demoScript.plaidLinkMode || 'modal';

  const introHowToUse = opts.orchestratorDriven
    ? `> **How to use:** the orchestrator is paused on a continue-gate waiting for you. Stay in Agent ` +
      `mode, edit the failing steps below, then run \`npm run pipe -- continue ${runId}\` — the ` +
      `orchestrator wakes up and re-runs build-qa automatically. Loop runs at most ` +
      `MAX_REFINEMENT_ITERATIONS (default 3) or until QA passes.\n\n`
    : `> **How to use:** stay in Agent mode and say "Run this task." When done, hand back to the user; ` +
      `they re-verify with \`npm run pipe -- stage build-qa ${runId}\`.\n\n`;

  let promptMarkdown =
    `# QA touchup task — ${runId}\n\n` +
    `> **What this is:** an agent-ready prompt ${opts.orchestratorDriven ? 'emitted by the orchestrator\'s build-qa refinement loop' : 'produced by `npm run pipe -- qa-touchup ' + runId + '`'}. ` +
    `It lets you (the AI agent in Cursor or Claude Code, Agent mode) make surgical, single-step edits to ` +
    `\`scratch-app/index.html\` and \`scratch-app/playwright-script.json\` based on the most recent QA ` +
    `findings — without regenerating the whole app like the LLM-driven ` +
    `\`--build-fix-mode=touchup\` path does.\n\n` +
    introHowToUse +
    `---\n\n` +
    `## QA SUMMARY\n\n` +
    `- **Run id:** \`${runId}\`\n` +
    `- **Build mode:** \`${buildMode}\`  ·  **Plaid Link mode:** \`${plaidLinkMode}\`\n` +
    `- **QA report:** \`${path.relative(runDir, qa.path)}\`  (source: \`${qa.report.qaSource || 'unknown'}\`, iteration: \`${qa.report.iteration ?? 'n/a'}\`)\n` +
    `- **Overall score / threshold:** ${Number.isFinite(overallScore) ? overallScore : '?'} / ${passThreshold}\n` +
    `- **Vision passed:** ${qa.report.visionThresholdPassed ? 'yes' : 'no'}  ·  ` +
    `**Deterministic passed:** ${qa.report.deterministicPassed === false ? 'no' : 'yes'}\n` +
    `- **Failing steps:** ${failing.length} (${systemic.distinctFailingSteps} distinct)\n` +
    `- **Build artifacts:** \`${path.relative(runDir, artifacts.htmlPath)}\` + \`${path.relative(runDir, artifacts.playwrightPath)}\`\n\n`;

  // ── Systemic escalation gate ────────────────────────────────────────────
  // The standalone `pipe qa-touchup` command keeps this gate so manual users
  // get a clear escalation path. The orchestrator-driven loop suppresses it
  // (opts.suppressSystemicGate=true) because that loop's contract is "no
  // rebuilds — agent makes iterations only," set by the user. When the gate
  // is suppressed, we still surface the systemic signals as advisory context
  // so the agent picks the right edit strategy (e.g., shared-chrome edit
  // batches across all failing steps in one pass).
  if (systemic.systemic) {
    if (opts.suppressSystemicGate) {
      promptMarkdown +=
        `---\n\n` +
        `## SYSTEMIC SIGNALS — for context only (orchestrator policy: no rebuilds)\n\n` +
        `The orchestrator's routing heuristics flag this iteration as touching multiple steps or ` +
        `shared chrome. Reasons:\n\n` +
        systemic.reasons.map((r) => `- \`${r}\``).join('\n') + `\n\n` +
        `**Do NOT escalate to a rebuild** — this run is in the agent-driven refinement loop, which ` +
        `bounds output cost and prevents drift on unrelated steps. Instead, plan your edits accordingly:\n\n` +
        `- For **shared-chrome bugs** (missing logo on N steps, wrong nav across all steps), edit ` +
        `the shared CSS / template once rather than touching each step individually.\n` +
        `- For **panel visibility** issues, fix the toggle / data attribute in one place.\n` +
        `- For **deterministic-blocker gates**, the QA report's \`deterministicReasons\` field tells you ` +
        `exactly which contract was violated — fix that first.\n` +
        `- If the issue truly cannot be addressed without a full rebuild, hand back to the user with a ` +
        `clear explanation; the orchestrator will not auto-rebuild for you.\n\n`;
    } else {
      promptMarkdown +=
        `---\n\n` +
        `## STOP — SYSTEMIC ISSUE DETECTED, ESCALATE INSTEAD OF EDITING\n\n` +
        `The orchestrator's routing heuristics flag this run as a **fullbuild candidate**, not a touchup ` +
        `candidate. Reasons:\n\n` +
        systemic.reasons.map((r) => `- \`${r}\``).join('\n') + `\n\n` +
        `Per-step surgical edits cannot fix shared-chrome bugs (wrong nav, missing logo across many steps, ` +
        `panel visibility issues, deterministic-blocker gate). **Do NOT edit individual step blocks.** ` +
        `Instead, hand back to the user and recommend:\n\n` +
        '```bash\n' +
        `npm run pipe -- stage build ${runId}\n` +
        `# or, if the orchestrator should choose: npm run pipe -- resume ${runId} --build-fix-mode=fullbuild\n` +
        '```\n\n' +
        `If you have read this section and still believe a surgical fix is the right call (e.g. categories ` +
        `look mis-classified), explain your reasoning to the user before editing anything.\n\n`;
    }
  }

  // ── Required reading + contracts ────────────────────────────────────────
  promptMarkdown +=
    `---\n\n` +
    `## REQUIRED READING (do this before any edits)\n\n` +
    `1. **\`${path.relative(runDir, qa.path)}\`** — the QA report. Cross-check the per-step issues below ` +
    `against \`stepsWithIssues[]\` to make sure nothing is missed.\n` +
    `2. **\`${path.relative(runDir, artifacts.htmlPath)}\`** — the host app's HTML. Use \`Read\` (don't paste it inline).\n` +
    `3. **\`${path.relative(runDir, artifacts.playwrightPath)}\`** — the Playwright walkthrough. Rows key off \`stepId\` (with \`id\` as legacy alias).\n` +
    `4. The per-step screenshots listed below — use the \`Read\` tool against the file path; the agent client renders them as images.\n\n` +
    `---\n\n` +
    `## EDITING CONTRACT (read carefully — these are guard-rails)\n\n` +
    `- **One step at a time.** For each failing step in the next section, edit ONLY the \`<div data-testid="step-<id>">…</div>\` block ` +
    `for that step. Use \`StrReplace\` with enough surrounding context to be uniquely match within the file.\n` +
    `- **Do NOT touch \`demo-script.json\`** — it's the source of truth and is consumed by other stages. ` +
    `If a fix would require changing demo-script, escalate to fullbuild instead.\n` +
    `- **Playwright edits** go in \`playwright-script.json\` (\`steps[]\`); change only the row matching the failing \`stepId\`. ` +
    `Common edits: tweak \`waitForSelector\`, fix a \`fill\` value, add a \`click\` row that matches the new HTML.\n` +
    `- **Preserve goToStep / getCurrentStep flow.** Do not rename step ids, do not reorder rows.\n` +
    `- **Honor APP-ONLY HOST POLICY when buildMode is \`app-only\`:** no Plaid product names / score grids / ` +
    `"Powered by Plaid" attribution / raw API field values on host frames. Slide-kind frames are unaffected.\n` +
    `- **Frame budget:** if a step's HTML chunk shows \`<!-- truncated for prompt budget -->\`, open the file ` +
    `with \`Read\` to see the rest before editing.\n\n` +
    `---\n\n` +
    `## FAILING STEPS (in QA-report order — fix each before moving on)\n\n`;

  if (failing.length === 0) {
    promptMarkdown += `_(no failing steps — QA report has no \`stepsWithIssues\`. This is unusual; if QA still ` +
      `reports \`passed: false\` overall, the issue is at the run level (deterministic gate, override reason). ` +
      `Hand back to the user.)_\n\n`;
  } else {
    promptMarkdown += stepBlocks.map((b, idx) => formatStepBlock(b, idx + 1, runDir)).join('\n---\n\n');
    promptMarkdown += `\n\n`;
  }

  // ── Verification + final command ────────────────────────────────────────
  // When the orchestrator generated this prompt as part of the auto-refinement
  // loop (orchestratorDriven=true), the next step is `pipe continue` — the
  // orchestrator is paused on a continue-gate and will re-run build-qa itself.
  // For the standalone `pipe qa-touchup` command, the user has to invoke
  // build-qa explicitly.
  const finalCommand = opts.orchestratorDriven
    ? `npm run pipe -- continue ${runId}`
    : `npm run pipe -- stage build-qa ${runId}`;
  const finalContextLine = opts.orchestratorDriven
    ? `The orchestrator is **paused on a continue-gate** waiting for you. Run the command below to ` +
      `release it; the orchestrator will then re-run build-qa automatically and either pass the run or ` +
      `loop back here for another iteration (max 3 by default).`
    : `Run a re-QA so the score gets recomputed:`;

  promptMarkdown +=
    `---\n\n` +
    `## VERIFICATION CHECKLIST (run before reporting completion)\n\n` +
    `- [ ] Every failing step listed above has been edited (or explicitly skipped with a reason).\n` +
    `- [ ] No \`<div data-testid="step-...">\` block was modified other than the failing ones.\n` +
    `- [ ] \`playwright-script.json\` rows still cover every step in \`demo-script.json\` (count match).\n` +
    `- [ ] On \`buildMode=app-only\` runs: no Plaid product names / score grids / "Powered by Plaid" added or kept.\n` +
    `- [ ] If you also edited the legacy mirror (\`<run>/scratch-app/index.html\`), keep it in sync with \`artifacts/build/scratch-app/index.html\`.\n\n` +
    `---\n\n` +
    `## FINAL — hand back to the user\n\n` +
    finalContextLine + `\n\n` +
    '```bash\n' +
    finalCommand + `\n` +
    '```\n\n' +
    `Then summarize what you changed (1-2 sentences per step) and the new overall score.\n` +
    `\n_Generated at ${new Date().toISOString()} by \`npm run pipe -- qa-touchup\`._\n`;

  const summary = {
    runId,
    qaReportPath: qa.path,
    overallScore: Number.isFinite(overallScore) ? overallScore : null,
    passThreshold,
    failingStepCount: failing.length,
    distinctFailingSteps: systemic.distinctFailingSteps,
    systemic: systemic.systemic,
    systemicReasons: systemic.reasons,
    htmlPath: artifacts.htmlPath,
    playwrightPath: artifacts.playwrightPath,
    promptChars: promptMarkdown.length,
    orchestratorDriven: !!opts.orchestratorDriven,
    suppressedSystemicGate: !!opts.suppressSystemicGate,
  };

  return { promptMarkdown, summary };
}

function formatStepBlock(block, indexOneBased, runDir) {
  const framesList = block.frames.length === 0
    ? '_(no QA frames found on disk — visual context is text-only for this step)_'
    : block.frames.map((f) => `- \`${path.relative(runDir, f.path)}\` _(${f.suffix}, source: ${f.source})_`).join('\n');

  const issues = block.issues.length === 0
    ? '_(no per-step `issues` strings — see suggestions / categories below)_'
    : block.issues.map((i) => `- ${i}`).join('\n');
  const suggestions = block.suggestions.length === 0
    ? '_(no `suggestions` provided)_'
    : block.suggestions.map((s) => `- ${s}`).join('\n');
  const categories = block.categories.length === 0
    ? '_(no `categories`)_'
    : block.categories.map((c) => `\`${c}\``).join(', ');

  const playwrightBlock = block.playwrightRow
    ? '```json\n' + JSON.stringify(block.playwrightRow, null, 2) + '\n```'
    : '_(no row found in playwright-script.json — agent should add one matching this step\'s id)_';

  const criticalBadge = block.critical ? ' **(critical)**' : '';
  const scoreFmt = Number.isFinite(block.score) ? `${block.score}/100` : '?/100';

  return (
    `### ${indexOneBased}. \`${block.stepId}\` — ${scoreFmt}${criticalBadge}\n\n` +
    `**Categories:** ${categories}\n\n` +
    `**Issues (vision-QA findings):**\n\n${issues}\n\n` +
    `**Suggestions (vision-QA recommendations):**\n\n${suggestions}\n\n` +
    `**QA frames (read these with the \`Read\` tool):**\n\n${framesList}\n\n` +
    `**Current HTML block (truncated for prompt budget — \`Read\` the file for the full view):**\n\n` +
    '```html\n' + block.html + '\n```\n\n' +
    `**Current Playwright row:**\n\n${playwrightBlock}\n`
  );
}

module.exports = {
  buildQaTouchupPrompt,
  // Exposed for tests + callers that want pieces of the pipeline:
  readQaReportForRun,
  extractFailingSteps,
  findStepFrames,
  extractStepHtmlBlock,
  extractPlaywrightRow,
  analyzeSystemicSignals,
  resolveBuildArtifacts,
  // Constants for tests / reuse:
  SHARED_CHROME_CATEGORIES,
  DEFAULT_FULLBUILD_STEP_THRESHOLD,
};
