'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  computeTierSummary,
  resolveBuildMode,
  resolveRecommendedRecovery,
  buildStepKindMap,
  extractDashboardQaScores,
} = require(path.join(__dirname, '../../scripts/scratch/utils/qa-tier-summary'));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function appOnlyDemoScript() {
  return {
    buildMode: 'app-only',
    steps: [
      { id: 'wf-signal-decision', stepKind: 'app', sceneType: 'host' },
      { id: 'wf-host-success',    stepKind: 'app', sceneType: 'host' },
      { id: 'wf-link-launch',     stepKind: 'app', sceneType: 'link' },
    ],
  };
}

function appPlusSlidesDemoScript() {
  return {
    buildMode: 'app+slides',
    steps: [
      { id: 'wf-link-launch',          stepKind: 'app',   sceneType: 'link' },
      { id: 'wf-host-success',         stepKind: 'app',   sceneType: 'host' },
      { id: 'value-summary-slide',     stepKind: 'slide', sceneType: 'slide' },
      { id: 'network-insights-slide',  stepKind: 'slide', sceneType: 'slide' },
    ],
  };
}

function qaReport({ overallScore = 75, passThreshold = 80, steps = [], extra = {} } = {}) {
  return {
    iteration: 'build',
    overallScore,
    passThreshold,
    passed: overallScore >= passThreshold,
    deterministicGateEnabled: true,
    deterministicPassed: true,
    deterministicCriticalStepIds: [],
    steps,
    stepsWithIssues: steps.filter((s) => s.critical || (Number(s.score) < passThreshold)),
    qaSource: 'build-walkthrough',
    ...extra,
  };
}

// ── resolveBuildMode ─────────────────────────────────────────────────────────

describe('resolveBuildMode', () => {
  test('explicit override wins', () => {
    assert.equal(resolveBuildMode({ buildMode: 'app+slides', demoScript: appOnlyDemoScript() }), 'app+slides');
    assert.equal(resolveBuildMode({ buildMode: 'app-only',   demoScript: appPlusSlidesDemoScript() }), 'app-only');
  });

  test('falls back to demo-script.buildMode', () => {
    assert.equal(resolveBuildMode({ demoScript: appOnlyDemoScript() }), 'app-only');
    assert.equal(resolveBuildMode({ demoScript: appPlusSlidesDemoScript() }), 'app+slides');
  });

  test('falls back to step kinds when no explicit field', () => {
    const ds = { steps: [{ id: 'a', stepKind: 'app' }] };
    assert.equal(resolveBuildMode({ demoScript: ds }), 'app-only');
    const ds2 = { steps: [{ id: 'a', stepKind: 'app' }, { id: 'b', stepKind: 'slide' }] };
    assert.equal(resolveBuildMode({ demoScript: ds2 }), 'app+slides');
  });

  test('defaults to app-only when nothing is known', () => {
    assert.equal(resolveBuildMode({}), 'app-only');
  });
});

// ── buildStepKindMap ─────────────────────────────────────────────────────────

describe('buildStepKindMap', () => {
  test('maps every step id to its kind', () => {
    const map = buildStepKindMap(appPlusSlidesDemoScript());
    assert.equal(map['wf-link-launch'], 'app');
    assert.equal(map['wf-host-success'], 'app');
    assert.equal(map['value-summary-slide'], 'slide');
    assert.equal(map['network-insights-slide'], 'slide');
  });

  test('handles missing demo-script gracefully', () => {
    assert.equal(Object.keys(buildStepKindMap(null)).length, 0);
    assert.equal(Object.keys(buildStepKindMap({})).length, 0);
    assert.equal(Object.keys(buildStepKindMap({ steps: [] })).length, 0);
  });
});

// ── computeTierSummary: app-only happy path ─────────────────────────────────

describe('computeTierSummary — app-only', () => {
  test('all app steps pass → slide skipped, recommendedRecovery null', () => {
    const ds = appOnlyDemoScript();
    const report = qaReport({
      overallScore: 90,
      passThreshold: 80,
      steps: [
        { stepId: 'wf-signal-decision', score: 92, categories: [], issues: [] },
        { stepId: 'wf-host-success',    score: 88, categories: [], issues: [] },
        { stepId: 'wf-link-launch',     score: 91, categories: [], issues: [] },
      ],
    });
    const out = computeTierSummary(report, ds);
    assert.equal(out.buildMode, 'app-only');
    assert.equal(out.tierSummary.app.passed, true);
    assert.equal(out.tierSummary.app.failingStepIds.length, 0);
    assert.equal(out.tierSummary.slide.skipped, true);
    assert.equal(out.tierSummary.slide.passed, true);
    assert.equal(out.tierSummary.slide.stepCount, 0);
    assert.equal(out.recommendedRecovery, null);
  });

  test('one app step fails → app-touchup (never slide-fix on app-only)', () => {
    const ds = appOnlyDemoScript();
    const report = qaReport({
      overallScore: 72,
      passThreshold: 80,
      steps: [
        { stepId: 'wf-signal-decision', score: 65, categories: ['panel-visibility'], issues: ['panel clipped'] },
        { stepId: 'wf-host-success',    score: 85, categories: [], issues: [] },
        { stepId: 'wf-link-launch',     score: 88, categories: [], issues: [] },
      ],
    });
    const out = computeTierSummary(report, ds);
    assert.equal(out.buildMode, 'app-only');
    assert.equal(out.tierSummary.app.passed, false);
    assert.deepEqual(out.tierSummary.app.failingStepIds, ['wf-signal-decision']);
    assert.equal(out.tierSummary.app.minScore, 65);
    assert.equal(out.tierSummary.slide.skipped, true);
    assert.equal(out.recommendedRecovery, 'app-touchup');
  });

  test('app-only is never routed to slide-fix even with explicit override', () => {
    const ds = { steps: [{ id: 'a', stepKind: 'app' }, { id: 'b', stepKind: 'app' }] };
    const report = qaReport({
      passThreshold: 80,
      steps: [
        { stepId: 'a', score: 50, categories: [], issues: [] },
        { stepId: 'b', score: 90, categories: [], issues: [] },
      ],
    });
    const out = computeTierSummary(report, ds, { buildMode: 'app-only' });
    assert.notEqual(out.recommendedRecovery, 'slide-fix');
    assert.notEqual(out.recommendedRecovery, 'app-touchup+slide-fix');
    assert.equal(out.recommendedRecovery, 'app-touchup');
  });
});

// ── computeTierSummary: app+slides tier matrix ──────────────────────────────

describe('computeTierSummary — app+slides', () => {
  test('app passes, slides fail → slide-fix', () => {
    const ds = appPlusSlidesDemoScript();
    const report = qaReport({
      overallScore: 70,
      passThreshold: 80,
      steps: [
        { stepId: 'wf-link-launch',         score: 90, categories: [], issues: [] },
        { stepId: 'wf-host-success',        score: 92, categories: [], issues: [] },
        { stepId: 'value-summary-slide',    score: 45, categories: ['slide-template-misuse'], issues: ['clipped'] },
        { stepId: 'network-insights-slide', score: 60, categories: ['slide-typography-floor'], issues: [] },
      ],
    });
    const out = computeTierSummary(report, ds);
    assert.equal(out.buildMode, 'app+slides');
    assert.equal(out.tierSummary.app.passed, true);
    assert.equal(out.tierSummary.slide.passed, false);
    assert.deepEqual(
      out.tierSummary.slide.failingStepIds.sort(),
      ['network-insights-slide', 'value-summary-slide']
    );
    assert.equal(out.tierSummary.slide.skipped, false);
    assert.equal(out.recommendedRecovery, 'slide-fix');
  });

  test('slides pass, app fails → app-touchup', () => {
    const ds = appPlusSlidesDemoScript();
    const report = qaReport({
      overallScore: 70,
      passThreshold: 80,
      steps: [
        { stepId: 'wf-link-launch',         score: 60, categories: ['panel-visibility'], issues: [] },
        { stepId: 'wf-host-success',        score: 92, categories: [], issues: [] },
        { stepId: 'value-summary-slide',    score: 92, categories: [], issues: [] },
        { stepId: 'network-insights-slide', score: 90, categories: [], issues: [] },
      ],
    });
    const out = computeTierSummary(report, ds);
    assert.equal(out.tierSummary.app.passed, false);
    assert.equal(out.tierSummary.slide.passed, true);
    assert.equal(out.recommendedRecovery, 'app-touchup');
  });

  test('both tiers fail localized → app-touchup+slide-fix', () => {
    const ds = appPlusSlidesDemoScript();
    const report = qaReport({
      passThreshold: 80,
      steps: [
        { stepId: 'wf-link-launch',         score: 60, categories: [], issues: [] },
        { stepId: 'wf-host-success',        score: 88, categories: [], issues: [] },
        { stepId: 'value-summary-slide',    score: 55, categories: [], issues: [] },
        { stepId: 'network-insights-slide', score: 91, categories: [], issues: [] },
      ],
    });
    const out = computeTierSummary(report, ds);
    assert.equal(out.tierSummary.app.passed, false);
    assert.equal(out.tierSummary.slide.passed, false);
    assert.equal(out.recommendedRecovery, 'app-touchup+slide-fix');
  });

  test('both tiers pass → null recommendation', () => {
    const ds = appPlusSlidesDemoScript();
    const report = qaReport({
      passThreshold: 80,
      steps: [
        { stepId: 'wf-link-launch',         score: 95, categories: [] },
        { stepId: 'wf-host-success',        score: 92, categories: [] },
        { stepId: 'value-summary-slide',    score: 88, categories: [] },
        { stepId: 'network-insights-slide', score: 90, categories: [] },
      ],
    });
    const out = computeTierSummary(report, ds);
    assert.equal(out.recommendedRecovery, null);
    assert.equal(out.tierSummary.app.passed, true);
    assert.equal(out.tierSummary.slide.passed, true);
  });
});

// ── Systemic escalation ─────────────────────────────────────────────────────

describe('computeTierSummary — systemic escalation', () => {
  test('deterministic blocker → fullbuild even if only one tier fails', () => {
    const ds = appPlusSlidesDemoScript();
    const report = qaReport({
      passThreshold: 80,
      steps: [
        { stepId: 'wf-link-launch', score: 92 },
        { stepId: 'wf-host-success', score: 92 },
        { stepId: 'value-summary-slide', score: 45 },
        { stepId: 'network-insights-slide', score: 60 },
      ],
      extra: {
        deterministicPassed: false,
        deterministicReasons: ['slide-template-misuse'],
      },
    });
    const out = computeTierSummary(report, ds);
    assert.equal(out.recommendedRecovery, 'fullbuild');
    assert.ok(out.systemicReasons.includes('deterministic_blocker_gate'));
  });

  test('runtime-js-error on ≥2 steps → fullbuild on app-only', () => {
    const ds = appOnlyDemoScript();
    const report = qaReport({
      passThreshold: 80,
      steps: [
        { stepId: 'wf-signal-decision', score: 30, categories: ['runtime-js-error'] },
        { stepId: 'wf-host-success',    score: 40, categories: ['runtime-js-error'] },
        { stepId: 'wf-link-launch',     score: 92, categories: [] },
      ],
    });
    const out = computeTierSummary(report, ds);
    assert.equal(out.recommendedRecovery, 'fullbuild');
    assert.ok(out.systemicReasons.includes('systemic_multistep_runtime_or_selector'));
  });

  test('build-qa guardrail override → fullbuild', () => {
    const ds = appOnlyDemoScript();
    const report = qaReport({
      passThreshold: 80,
      steps: [
        { stepId: 'wf-signal-decision', score: 50 },
        { stepId: 'wf-host-success',    score: 92 },
        { stepId: 'wf-link-launch',     score: 91 },
      ],
      extra: { overrideReason: 'Blank value-summary detected' },
    });
    const out = computeTierSummary(report, ds);
    assert.equal(out.recommendedRecovery, 'fullbuild');
    assert.ok(out.systemicReasons.includes('build_qa_guardrail_override'));
  });

  test('single-step runtime error is NOT systemic', () => {
    const ds = appPlusSlidesDemoScript();
    const report = qaReport({
      passThreshold: 80,
      steps: [
        { stepId: 'wf-link-launch',         score: 30, categories: ['runtime-js-error'] },
        { stepId: 'wf-host-success',        score: 92 },
        { stepId: 'value-summary-slide',    score: 92 },
        { stepId: 'network-insights-slide', score: 91 },
      ],
    });
    const out = computeTierSummary(report, ds);
    assert.equal(out.recommendedRecovery, 'app-touchup');
    assert.equal(out.systemicReasons.length, 0);
  });
});

// ── resolveRecommendedRecovery direct tests ─────────────────────────────────

describe('resolveRecommendedRecovery', () => {
  const baseTier = (overrides = {}) => ({
    threshold: 80,
    app:   { passed: true,  skipped: false, failingStepIds: [], ...overrides.app },
    slide: { passed: true,  skipped: false, failingStepIds: [], ...overrides.slide },
  });

  test('app-only never returns slide-fix', () => {
    const out = resolveRecommendedRecovery({
      buildMode: 'app-only',
      tierSummary: baseTier({ app: { passed: false, failingStepIds: ['x'] } }),
      systemicReasons: [],
    });
    assert.equal(out, 'app-touchup');
  });

  test('app+slides app-fail slide-pass → app-touchup', () => {
    const out = resolveRecommendedRecovery({
      buildMode: 'app+slides',
      tierSummary: baseTier({ app: { passed: false, failingStepIds: ['x'] } }),
      systemicReasons: [],
    });
    assert.equal(out, 'app-touchup');
  });

  test('app+slides app-pass slide-fail → slide-fix', () => {
    const out = resolveRecommendedRecovery({
      buildMode: 'app+slides',
      tierSummary: baseTier({ slide: { passed: false, failingStepIds: ['y'] } }),
      systemicReasons: [],
    });
    assert.equal(out, 'slide-fix');
  });

  test('any systemic reason → fullbuild', () => {
    const out = resolveRecommendedRecovery({
      buildMode: 'app+slides',
      tierSummary: baseTier({ slide: { passed: false, failingStepIds: ['y'] } }),
      systemicReasons: ['deterministic_blocker_gate'],
    });
    assert.equal(out, 'fullbuild');
  });

  test('both tiers pass → null', () => {
    const out = resolveRecommendedRecovery({
      buildMode: 'app+slides',
      tierSummary: baseTier(),
      systemicReasons: [],
    });
    assert.equal(out, null);
  });
});

describe('extractDashboardQaScores', () => {
  test('splits app and slide tier averages from tierSummary', () => {
    const scores = extractDashboardQaScores({
      overallScore: 87,
      tierSummary: {
        app: { passed: false, avgScore: 87.3, stepIds: ['a', 'b'] },
        slide: { passed: true, skipped: false, avgScore: 76, stepIds: ['s1'] },
      },
    });
    assert.equal(scores.qaScore, 87);
    assert.equal(scores.qaAppScore, 87.3);
    assert.equal(scores.qaSlideScore, 76);
    assert.equal(scores.qaAppPassed, false);
    assert.equal(scores.qaSlidePassed, true);
    assert.equal(scores.qaSlideSkipped, false);
  });

  test('app-only slide tier skipped', () => {
    const scores = extractDashboardQaScores({
      overallScore: 90,
      tierSummary: {
        app: { passed: true, avgScore: 90 },
        slide: { passed: true, skipped: true, avgScore: null },
      },
    });
    assert.equal(scores.qaSlideScore, null);
    assert.equal(scores.qaSlideSkipped, true);
  });
});
