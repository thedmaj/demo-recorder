'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MOD = path.join(__dirname, '../../scripts/scratch/utils/qa-touchup');
const {
  buildQaTouchupPrompt,
  readQaReportForRun,
  extractFailingSteps,
  findStepFrames,
  extractStepHtmlBlock,
  extractPlaywrightRow,
  analyzeSystemicSignals,
  resolveBuildArtifacts,
  SHARED_CHROME_CATEGORIES,
} = require(MOD);

// ─── Tiny test-fixture helpers ──────────────────────────────────────────────

function mkTmpRun(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-touchup-'));
  const dir = path.join(base, name || 'run-1');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function seedRun(dir, overrides = {}) {
  fs.mkdirSync(path.join(dir, 'scratch-app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'artifacts', 'qa', 'frames'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'qa-frames'), { recursive: true });
  const demoScript = overrides.demoScript || {
    buildMode: 'app-only',
    plaidLinkMode: 'embedded',
    steps: [
      { id: 'home', label: 'Home', sceneType: 'host' },
      { id: 'launch', label: 'Launch', sceneType: 'link', plaidPhase: 'launch' },
      { id: 'success', label: 'Success', sceneType: 'host' },
    ],
  };
  fs.writeFileSync(path.join(dir, 'demo-script.json'), JSON.stringify(demoScript, null, 2));

  const html = overrides.html ?? (
`<!doctype html><html><body>
<div data-testid="step-home" class="step active">
  <h1>Hello</h1>
  <button data-testid="connect-cta">Connect bank</button>
</div>
<div data-testid="step-launch" class="step">
  <div class="plaid-link-embed"></div>
</div>
<div data-testid="step-success" class="step">
  <h2>Verified</h2>
</div>
<!-- SIDE PANELS -->
<div id="api-response-panel" style="display:none"></div>
</body></html>`);
  fs.writeFileSync(path.join(dir, 'scratch-app', 'index.html'), html);

  const playwright = overrides.playwright ?? {
    steps: [
      { stepId: 'home',    action: 'goToStep', target: 'home' },
      { stepId: 'launch',  action: 'click',    selector: 'button[data-testid="connect-cta"]' },
      { stepId: 'success', action: 'goToStep', target: 'success' },
    ],
  };
  fs.writeFileSync(path.join(dir, 'scratch-app', 'playwright-script.json'), JSON.stringify(playwright, null, 2));

  if (overrides.qaReport !== null) {
    const qaReport = overrides.qaReport ?? {
      iteration: 'build',
      overallScore: 72,
      passThreshold: 80,
      passed: false,
      visionThresholdPassed: false,
      deterministicGateEnabled: true,
      deterministicPassed: true,
      qaSource: 'build-walkthrough',
      steps: [
        { stepId: 'home',    score: 78, issues: [],                                  suggestions: [], categories: [],                       critical: false },
        { stepId: 'launch',  score: 60, issues: ['CTA copy mismatch with visualState'], suggestions: ['Rename button to "Connect account"'], categories: ['cta-mismatch'], critical: false },
        { stepId: 'success', score: 90, issues: [],                                  suggestions: [], categories: [],                       critical: false },
      ],
      stepsWithIssues: [
        { stepId: 'launch', score: 60, issues: ['CTA copy mismatch with visualState'], suggestions: ['Rename button to "Connect account"'], categories: ['cta-mismatch'], critical: false },
      ],
      allStepScores: { home: 78, launch: 60, success: 90 },
    };
    fs.writeFileSync(path.join(dir, 'qa-report-build.json'), JSON.stringify(qaReport, null, 2));
  }

  return { dir, html, playwright };
}

// ─── readQaReportForRun ─────────────────────────────────────────────────────

describe('readQaReportForRun', () => {
  test('prefers qa-report-build.json when present', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    fs.writeFileSync(path.join(dir, 'qa-report-2.json'), JSON.stringify({ iteration: 2, overallScore: 88 }));
    const out = readQaReportForRun(dir);
    assert.equal(out.path, path.join(dir, 'qa-report-build.json'));
    assert.equal(out.report.iteration, 'build');
  });

  test('falls back to highest-numbered qa-report-N.json', () => {
    const dir = mkTmpRun();
    seedRun(dir, { qaReport: null });
    fs.writeFileSync(path.join(dir, 'qa-report-1.json'), JSON.stringify({ iteration: 1, overallScore: 60 }));
    fs.writeFileSync(path.join(dir, 'qa-report-3.json'), JSON.stringify({ iteration: 3, overallScore: 84 }));
    fs.writeFileSync(path.join(dir, 'qa-report-2.json'), JSON.stringify({ iteration: 2, overallScore: 75 }));
    const out = readQaReportForRun(dir);
    assert.equal(path.basename(out.path), 'qa-report-3.json');
    assert.equal(out.report.iteration, 3);
  });

  test('returns null when no QA reports exist', () => {
    const dir = mkTmpRun();
    seedRun(dir, { qaReport: null });
    assert.equal(readQaReportForRun(dir), null);
  });

  test('returns null for missing run dir', () => {
    assert.equal(readQaReportForRun('/nonexistent/run'), null);
  });
});

// ─── extractFailingSteps ────────────────────────────────────────────────────

describe('extractFailingSteps', () => {
  test('uses stepsWithIssues when populated', () => {
    const out = extractFailingSteps({
      stepsWithIssues: [{ stepId: 'a', score: 50, issues: ['x'], suggestions: ['y'], categories: ['z'], critical: true }],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].stepId, 'a');
    assert.equal(out[0].score, 50);
    assert.deepEqual(out[0].issues, ['x']);
    assert.deepEqual(out[0].suggestions, ['y']);
    assert.deepEqual(out[0].categories, ['z']);
    assert.equal(out[0].critical, true);
  });

  test('falls back to steps[] filtered by score < threshold', () => {
    const out = extractFailingSteps({
      passThreshold: 80,
      steps: [
        { stepId: 'a', score: 90 },
        { stepId: 'b', score: 70 },
        { stepId: 'c', score: 100, critical: true },
      ],
    });
    const ids = out.map((s) => s.stepId).sort();
    assert.deepEqual(ids, ['b', 'c']);
  });

  test('coerces missing arrays to [] and missing scores to null', () => {
    const out = extractFailingSteps({
      stepsWithIssues: [{ stepId: 'a' }],
    });
    assert.equal(out[0].score, null);
    assert.deepEqual(out[0].issues, []);
    assert.deepEqual(out[0].suggestions, []);
    assert.deepEqual(out[0].categories, []);
    assert.equal(out[0].critical, false);
  });

  test('drops entries without stepId', () => {
    const out = extractFailingSteps({ stepsWithIssues: [{ score: 50 }, { stepId: 'b', score: 50 }] });
    assert.equal(out.length, 1);
    assert.equal(out[0].stepId, 'b');
  });

  test('returns [] for null / non-object input', () => {
    assert.deepEqual(extractFailingSteps(null), []);
    assert.deepEqual(extractFailingSteps(undefined), []);
    assert.deepEqual(extractFailingSteps('garbage'), []);
  });
});

// ─── findStepFrames (covers BOTH naming conventions) ────────────────────────

describe('findStepFrames', () => {
  test('finds post-record frames at qa-frames/<stepId>-<suffix>.png', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    fs.writeFileSync(path.join(dir, 'qa-frames', 'launch-start.png'), 'a');
    fs.writeFileSync(path.join(dir, 'qa-frames', 'launch-mid.png'),   'a');
    const frames = findStepFrames(dir, 'launch');
    assert.equal(frames.length, 2);
    assert.deepEqual(frames.map((f) => f.suffix), ['start', 'mid']);
    assert.ok(frames.every((f) => f.source === 'post-record'));
  });

  test('finds build-QA frames at artifacts/qa/frames/<stepId>-buildqa-<row>-<suffix>.png', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    fs.writeFileSync(path.join(dir, 'artifacts', 'qa', 'frames', 'launch-buildqa-1-start.png'), 'a');
    fs.writeFileSync(path.join(dir, 'artifacts', 'qa', 'frames', 'launch-buildqa-1-mid.png'),   'a');
    fs.writeFileSync(path.join(dir, 'artifacts', 'qa', 'frames', 'launch-buildqa-1-end.png'),   'a');
    const frames = findStepFrames(dir, 'launch');
    assert.equal(frames.length, 3);
    assert.deepEqual(frames.map((f) => f.suffix), ['start', 'mid', 'end']);
    assert.ok(frames.every((f) => f.source === 'build-qa'));
  });

  test('prefers latest rowIndex when multiple build-QA rows exist for the same step', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    const fdir = path.join(dir, 'artifacts', 'qa', 'frames');
    fs.writeFileSync(path.join(fdir, 'launch-buildqa-0-start.png'), 'old');
    fs.writeFileSync(path.join(fdir, 'launch-buildqa-2-start.png'), 'new');
    fs.writeFileSync(path.join(fdir, 'launch-buildqa-1-start.png'), 'mid');
    const frames = findStepFrames(dir, 'launch');
    assert.equal(frames.length, 1);
    assert.equal(path.basename(frames[0].path), 'launch-buildqa-2-start.png');
  });

  test('returns frames in stable [start, mid, end] order regardless of disk order', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    const fdir = path.join(dir, 'artifacts', 'qa', 'frames');
    fs.writeFileSync(path.join(fdir, 'launch-buildqa-0-end.png'),   'a');
    fs.writeFileSync(path.join(fdir, 'launch-buildqa-0-start.png'), 'a');
    fs.writeFileSync(path.join(fdir, 'launch-buildqa-0-mid.png'),   'a');
    const frames = findStepFrames(dir, 'launch');
    assert.deepEqual(frames.map((f) => f.suffix), ['start', 'mid', 'end']);
  });

  test('returns [] when no frames exist for the step', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    assert.deepEqual(findStepFrames(dir, 'nonexistent-step'), []);
  });

  test('escapes regex special characters in stepId', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    fs.writeFileSync(path.join(dir, 'qa-frames', 'step.with.dots-start.png'), 'a');
    const frames = findStepFrames(dir, 'step.with.dots');
    assert.equal(frames.length, 1);
  });
});

// ─── extractStepHtmlBlock ───────────────────────────────────────────────────

describe('extractStepHtmlBlock', () => {
  test('isolates one step, stops at next step container', () => {
    const html =
      `<div data-testid="step-a" class="step">A content</div>` +
      `<div data-testid="step-b" class="step">B content</div>` +
      `<!-- SIDE PANELS --><div id="api-response-panel"></div>`;
    const a = extractStepHtmlBlock(html, 'a');
    assert.match(a, /A content/);
    assert.doesNotMatch(a, /B content/);
  });

  test('handles last step with no closing sentinel', () => {
    const html = `<div data-testid="step-only" class="step">only step content</div>`;
    const out = extractStepHtmlBlock(html, 'only');
    assert.match(out, /only step content/);
  });

  test('truncates very large blocks with a clear marker', () => {
    const big = `<div data-testid="step-c" class="step">${'x'.repeat(20000)}</div>`;
    const out = extractStepHtmlBlock(big, 'c', 500);
    assert.ok(out.length <= 500 + 60);
    assert.match(out, /truncated for prompt budget/);
  });

  test('returns null when step container is not found', () => {
    assert.equal(extractStepHtmlBlock('<div>no steps here</div>', 'a'), null);
    assert.equal(extractStepHtmlBlock('', 'a'), null);
    assert.equal(extractStepHtmlBlock('<div data-testid="step-a">x</div>', null), null);
  });
});

// ─── extractPlaywrightRow ───────────────────────────────────────────────────

describe('extractPlaywrightRow', () => {
  test('matches stepId field', () => {
    const out = extractPlaywrightRow({ steps: [{ stepId: 'a', action: 'click' }] }, 'a');
    assert.equal(out.action, 'click');
  });

  test('matches legacy id field', () => {
    const out = extractPlaywrightRow({ steps: [{ id: 'b', action: 'fill' }] }, 'b');
    assert.equal(out.action, 'fill');
  });

  test('returns null when no match', () => {
    assert.equal(extractPlaywrightRow({ steps: [{ stepId: 'a' }] }, 'b'), null);
    assert.equal(extractPlaywrightRow(null, 'a'), null);
    assert.equal(extractPlaywrightRow({ steps: 'not-array' }, 'a'), null);
  });
});

// ─── analyzeSystemicSignals (mirrors orchestrator routing) ──────────────────

describe('analyzeSystemicSignals', () => {
  test('1 failing step → not systemic', () => {
    const out = analyzeSystemicSignals({
      stepsWithIssues: [{ stepId: 'a', score: 60, categories: ['cta-mismatch'] }],
    });
    assert.equal(out.systemic, false);
    assert.equal(out.distinctFailingSteps, 1);
  });

  test('>=3 distinct failing steps → systemic with failing_steps_gte_3 reason', () => {
    const out = analyzeSystemicSignals({
      stepsWithIssues: [
        { stepId: 'a', score: 60 },
        { stepId: 'b', score: 60 },
        { stepId: 'c', score: 60 },
      ],
    });
    assert.equal(out.systemic, true);
    assert.ok(out.reasons.includes('failing_steps_gte_3'));
  });

  test('overrideReason set → systemic with build_qa_guardrail_override reason', () => {
    const out = analyzeSystemicSignals({
      overrideReason: 'blank-final-slide',
      stepsWithIssues: [{ stepId: 'a', score: 60 }],
    });
    assert.equal(out.systemic, true);
    assert.ok(out.reasons.includes('build_qa_guardrail_override'));
  });

  test('deterministic blocker gate → systemic', () => {
    const out = analyzeSystemicSignals({
      deterministicGateEnabled: true,
      deterministicPassed: false,
      stepsWithIssues: [{ stepId: 'a', score: 60 }],
    });
    assert.ok(out.reasons.includes('deterministic_blocker_gate'));
    assert.equal(out.systemic, true);
  });

  test('shared-chrome categories on 2+ steps → systemic', () => {
    const out = analyzeSystemicSignals({
      stepsWithIssues: [
        { stepId: 'a', score: 60, categories: ['missing-logo'] },
        { stepId: 'b', score: 60, categories: ['missing-logo'] },
      ],
    });
    assert.ok(out.reasons.includes('shared_chrome_multistep'));
    assert.equal(out.systemic, true);
  });

  test('shared-chrome categories on 1 step → not systemic on that signal alone', () => {
    const out = analyzeSystemicSignals({
      stepsWithIssues: [{ stepId: 'a', score: 60, categories: ['missing-logo'] }],
    });
    assert.equal(out.systemic, false);
    assert.deepEqual(out.reasons, []);
  });

  test('honors a custom fullbuildStepThreshold', () => {
    const qa = {
      stepsWithIssues: [
        { stepId: 'a', score: 60 },
        { stepId: 'b', score: 60 },
      ],
    };
    assert.equal(analyzeSystemicSignals(qa).systemic, false);
    assert.equal(analyzeSystemicSignals(qa, { fullbuildStepThreshold: 2 }).systemic, true);
  });

  test('SHARED_CHROME_CATEGORIES export matches orchestrator categories', () => {
    // Sanity: must include the same categories analyzeFixModeForQaIteration
    // checks in scripts/scratch/orchestrator.js (~line 1118).
    for (const cat of ['missing-logo', 'panel-visibility', 'slide-template-misuse']) {
      assert.ok(SHARED_CHROME_CATEGORIES.has(cat), `expected ${cat} in SHARED_CHROME_CATEGORIES`);
    }
  });
});

// ─── resolveBuildArtifacts ──────────────────────────────────────────────────

describe('resolveBuildArtifacts', () => {
  test('prefers artifacts/build/scratch-app when present', () => {
    const dir = mkTmpRun();
    fs.mkdirSync(path.join(dir, 'artifacts', 'build', 'scratch-app'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scratch-app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'artifacts', 'build', 'scratch-app', 'index.html'), '<a/>');
    fs.writeFileSync(path.join(dir, 'scratch-app', 'index.html'), '<b/>');
    const out = resolveBuildArtifacts(dir);
    assert.match(out.htmlPath, /artifacts\/build\/scratch-app\/index\.html$/);
  });

  test('falls back to legacy <run>/scratch-app', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    const out = resolveBuildArtifacts(dir);
    assert.match(out.htmlPath, /scratch-app\/index\.html$/);
  });

  test('returns null when neither layout has a built index.html', () => {
    const dir = mkTmpRun();
    assert.equal(resolveBuildArtifacts(dir), null);
  });
});

// ─── buildQaTouchupPrompt (golden) ──────────────────────────────────────────

describe('buildQaTouchupPrompt', () => {
  test('throws when run dir missing', () => {
    assert.throws(() => buildQaTouchupPrompt('/nonexistent/run'), /runDir not found/);
  });

  test('throws when no QA report exists', () => {
    const dir = mkTmpRun();
    seedRun(dir, { qaReport: null });
    assert.throws(() => buildQaTouchupPrompt(dir), /no QA report found/);
  });

  test('throws when no scratch-app build is found', () => {
    const dir = mkTmpRun();
    fs.writeFileSync(
      path.join(dir, 'qa-report-build.json'),
      JSON.stringify({ stepsWithIssues: [{ stepId: 'a', score: 50, issues: ['x'] }] })
    );
    assert.throws(() => buildQaTouchupPrompt(dir), /no scratch-app build found/);
  });

  test('builds a self-contained prompt with per-step blocks + frame paths + Playwright row', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    // Add a build-QA frame for the failing step so the per-step block lists it:
    fs.writeFileSync(path.join(dir, 'artifacts', 'qa', 'frames', 'launch-buildqa-0-start.png'), 'a');
    const { promptMarkdown, summary } = buildQaTouchupPrompt(dir);

    // Top-level structure:
    assert.match(promptMarkdown, /^# QA touchup task — /);
    assert.match(promptMarkdown, /## QA SUMMARY/);
    assert.match(promptMarkdown, /## REQUIRED READING/);
    assert.match(promptMarkdown, /## EDITING CONTRACT/);
    assert.match(promptMarkdown, /## FAILING STEPS/);
    assert.match(promptMarkdown, /## VERIFICATION CHECKLIST/);
    assert.match(promptMarkdown, /## FINAL — hand back to the user/);

    // Failing step block + relative frame path:
    assert.match(promptMarkdown, /### 1\. `launch`/);
    assert.match(promptMarkdown, /CTA copy mismatch/);
    assert.match(promptMarkdown, /Rename button to "Connect account"/);
    assert.match(promptMarkdown, /artifacts\/qa\/frames\/launch-buildqa-0-start\.png/);

    // Playwright row embedded as JSON:
    assert.match(promptMarkdown, /"selector": "button\[data-testid=\\"connect-cta\\"\]"/);

    // HTML chunk for failing step is included; non-failing steps are NOT:
    assert.match(promptMarkdown, /<div data-testid="step-launch"/);
    assert.doesNotMatch(promptMarkdown, /<div data-testid="step-success"/);

    // Final command points back to build-qa:
    assert.match(promptMarkdown, /npm run pipe -- stage build-qa /);

    // Summary stats:
    assert.equal(summary.failingStepCount, 1);
    assert.equal(summary.distinctFailingSteps, 1);
    assert.equal(summary.systemic, false);
    assert.equal(summary.overallScore, 72);
    assert.equal(summary.passThreshold, 80);
  });

  test('renders systemic-escalation block when failure is structural', () => {
    const dir = mkTmpRun();
    seedRun(dir, {
      qaReport: {
        iteration: 'build',
        overallScore: 40,
        passThreshold: 80,
        passed: false,
        deterministicGateEnabled: true,
        deterministicPassed: false,
        stepsWithIssues: [
          { stepId: 'home',    score: 40, issues: ['missing nav logo'], categories: ['missing-logo'] },
          { stepId: 'launch',  score: 50, issues: ['missing nav logo'], categories: ['missing-logo'] },
          { stepId: 'success', score: 55, issues: ['panel hidden'],     categories: ['panel-visibility'] },
        ],
        steps: [
          { stepId: 'home',    score: 40, categories: ['missing-logo'] },
          { stepId: 'launch',  score: 50, categories: ['missing-logo'] },
          { stepId: 'success', score: 55, categories: ['panel-visibility'] },
        ],
      },
    });

    const { promptMarkdown, summary } = buildQaTouchupPrompt(dir);
    assert.match(promptMarkdown, /STOP — SYSTEMIC ISSUE DETECTED/);
    assert.match(promptMarkdown, /failing_steps_gte_3/);
    assert.match(promptMarkdown, /shared_chrome_multistep/);
    assert.match(promptMarkdown, /deterministic_blocker_gate/);
    assert.match(promptMarkdown, /npm run pipe -- stage build /);
    assert.equal(summary.systemic, true);
    assert.equal(summary.distinctFailingSteps, 3);
    assert.ok(summary.systemicReasons.includes('failing_steps_gte_3'));
  });

  test('handles empty stepsWithIssues with a friendly note (not a crash)', () => {
    const dir = mkTmpRun();
    seedRun(dir, {
      qaReport: {
        iteration: 'build',
        overallScore: 95,
        passThreshold: 80,
        passed: true,
        stepsWithIssues: [],
        steps: [],
      },
    });
    const { promptMarkdown, summary } = buildQaTouchupPrompt(dir);
    assert.equal(summary.failingStepCount, 0);
    assert.match(promptMarkdown, /no failing steps/);
  });

  test('summary includes correct relative paths for downstream tooling', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    const { summary } = buildQaTouchupPrompt(dir);
    assert.equal(path.basename(summary.qaReportPath), 'qa-report-build.json');
    assert.equal(path.basename(summary.htmlPath), 'index.html');
    assert.equal(path.basename(summary.playwrightPath), 'playwright-script.json');
  });

  test('suppressSystemicGate replaces STOP block with advisory-only context', () => {
    const dir = mkTmpRun();
    seedRun(dir, {
      qaReport: {
        iteration: 'build',
        overallScore: 40,
        passThreshold: 80,
        passed: false,
        deterministicGateEnabled: true,
        deterministicPassed: false,
        stepsWithIssues: [
          { stepId: 'home',    score: 40, issues: ['missing nav logo'], categories: ['missing-logo'] },
          { stepId: 'launch',  score: 50, issues: ['missing nav logo'], categories: ['missing-logo'] },
          { stepId: 'success', score: 55, issues: ['panel hidden'],     categories: ['panel-visibility'] },
        ],
      },
    });

    const { promptMarkdown, summary } = buildQaTouchupPrompt(dir, { suppressSystemicGate: true });
    // The STOP / rebuild language is suppressed:
    assert.doesNotMatch(promptMarkdown, /STOP — SYSTEMIC ISSUE DETECTED/);
    assert.doesNotMatch(promptMarkdown, /npm run pipe -- stage build /);
    // Advisory section IS present and lists the same systemic reasons:
    assert.match(promptMarkdown, /SYSTEMIC SIGNALS — for context only/);
    assert.match(promptMarkdown, /no rebuilds/);
    assert.match(promptMarkdown, /failing_steps_gte_3/);
    assert.match(promptMarkdown, /shared_chrome_multistep/);
    // Summary reflects the option:
    assert.equal(summary.suppressedSystemicGate, true);
    assert.equal(summary.systemic, true);
  });

  test('orchestratorDriven changes final CTA to `pipe continue` (not `pipe stage build-qa`)', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    const { promptMarkdown, summary } = buildQaTouchupPrompt(dir, { orchestratorDriven: true });
    assert.match(promptMarkdown, /paused on a continue-gate/);
    assert.match(promptMarkdown, /npm run pipe -- continue /);
    assert.doesNotMatch(promptMarkdown, /npm run pipe -- stage build-qa /);
    assert.equal(summary.orchestratorDriven, true);
  });

  test('orchestratorDriven=false (default) keeps the standalone `pipe stage build-qa` CTA', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    const { promptMarkdown, summary } = buildQaTouchupPrompt(dir);
    assert.match(promptMarkdown, /npm run pipe -- stage build-qa /);
    assert.doesNotMatch(promptMarkdown, /paused on a continue-gate/);
    assert.equal(summary.orchestratorDriven, false);
  });
});
