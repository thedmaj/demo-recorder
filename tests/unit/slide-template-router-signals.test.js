'use strict';

/**
 * Unit tests for the content-aware signal detectors added to
 * slide-template-router.js — density, numerics, comparison, lifecycle.
 *
 * These are the "no extra LLM turn" routing improvements documented in the
 * routing-plan response (May 2026). The tests assert that:
 *   - Lifecycle narrations route to process-steps (not stat-highlight)
 *   - Numeric-dense narrations route to stat/kpi layouts
 *   - Comparison cues route to comparison layouts
 *   - Density (word count) biases toward appropriate layout sizes
 */

const path = require('node:path');
process.env.PIPELINE_RUN_DIR ||= path.join(__dirname, '../../out');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  routeSlideTemplate,
  NUMERIC_TOKEN_RE,
  COMPARISON_CUES_RE,
  LIFECYCLE_CUES_RE,
} = require('../../scripts/scratch/utils/slide-template-router');

test('numeric regex catches percentages, durations, multipliers, dollar amounts', () => {
  const text = 'Approved $1,200 in 14 seconds with +25% lift and 3x throughput across 7 days.';
  const matches = text.match(NUMERIC_TOKEN_RE) || [];
  assert.ok(matches.length >= 4, `expected 4+ numeric matches, got ${matches.length}: ${matches.join(',')}`);
});

test('comparison cues fire on "vs" / "instead of" / "rather than"', () => {
  assert.ok(COMPARISON_CUES_RE.test('Plaid Layer vs the traditional manual flow.'));
  assert.ok(COMPARISON_CUES_RE.test('Instead of stitching webhooks, push the report.'));
  assert.ok(COMPARISON_CUES_RE.test('rather than polling, deliver event-driven results.'));
  assert.ok(!COMPARISON_CUES_RE.test('We approve more shoppers safely.'));
});

test('lifecycle cues fire on arrows, ordinals, webhook lifecycles', () => {
  assert.ok(LIFECYCLE_CUES_RE.test('requested → generating → ready'));
  assert.ok(LIFECYCLE_CUES_RE.test('A CHECK_REPORT_READY webhook fires once the report is ready.'));
  assert.ok(LIFECYCLE_CUES_RE.test('Step 1 of the flow handles consent.'));
  assert.ok(!LIFECYCLE_CUES_RE.test('A clean approve box with verified bank data.'));
});

test('lifecycle narration routes to process-steps (was: stat-highlight in pre-signal router)', () => {
  const step = {
    id: 'report-ready-slide',
    narration:
      "A CHECK_REPORT_READY webhook fires the instant Jordan's consumer report is ready. " +
      "Zip's underwriting queue picks it up and pulls LendScore, Base Report, and Network Insights together.",
    visualState:
      'Plaid deck T3 statement slide. Three-pill lifecycle: requested → generating → ready (ready highlighted). ' +
      'Caption: CHECK_REPORT_READY · USER_CHECK_REPORT_READY webhooks.',
    apiResponse: { endpoint: 'POST /webhooks (Plaid → Zip)' },
    stepKind: 'slide',
  };
  const out = routeSlideTemplate(step, { stepIndex: 1, totalSlides: 4, recentLayouts: ['cover'] });
  assert.equal(out.workhorseLayout, 'process-steps',
    `expected process-steps for webhook lifecycle, got ${out.workhorseLayout} (${out.rationale})`);
  assert.ok(out.rationale.includes('lifecycle-cue'), `expected lifecycle-cue in rationale: ${out.rationale}`);
});

test('three numeric narration routes to a stat/kpi layout', () => {
  const step = {
    id: 'protect-metrics-slide',
    narration:
      'Trust Index returns a 78 score, Signal scores 12, and Identity Verification passes in 2.4 seconds — Tilt accepts the applicant.',
    visualState: 'Three stat callouts side by side with the decision label.',
    stepKind: 'slide',
  };
  const out = routeSlideTemplate(step, { stepIndex: 2, totalSlides: 4, recentLayouts: ['cover', 'bullets'] });
  assert.ok(
    ['kpi-grid', 'stat-highlight'].includes(out.workhorseLayout),
    `expected kpi-grid or stat-highlight for 3 numerics, got ${out.workhorseLayout} (${out.rationale})`
  );
});

test('comparison narration routes to a comparison layout', () => {
  const step = {
    id: 'before-after-slide',
    narration:
      'Old way: weeks of manual paper transfers. New way: one Link session and the assets move instantly.',
    visualState: 'Two-panel before/after split with arrows.',
    stepKind: 'slide',
  };
  const out = routeSlideTemplate(step, { stepIndex: 1, totalSlides: 4, recentLayouts: ['cover'] });
  assert.equal(out.workhorseLayout, 'comparison',
    `expected comparison layout, got ${out.workhorseLayout} (${out.rationale})`);
});

test('short hero narration routes to cover or quote (density bias)', () => {
  const step = {
    id: 'opener-slide',
    narration: 'Approve more near-prime shoppers, safely.',
    visualState: 'Hero opener with the partnership badge.',
    stepKind: 'slide',
  };
  const out = routeSlideTemplate(step, { stepIndex: 0, totalSlides: 4, recentLayouts: [] });
  assert.ok(
    ['cover', 'big-quote', 'section-divider'].includes(out.workhorseLayout),
    `expected cover/big-quote/section-divider for short opener, got ${out.workhorseLayout} (${out.rationale})`
  );
});

test('value summary narration still routes to cta (hard signal preserved)', () => {
  const step = {
    id: 'value-summary-slide',
    narration:
      "Zip's retro graduates from study to production decisioning — Plaid Check LendScore and Network Insights for BNPL underwriting.",
    visualState: 'T11 close slide with three value cards and a soft next-step line.',
    stepKind: 'slide',
  };
  const out = routeSlideTemplate(step, { stepIndex: 3, totalSlides: 4, recentLayouts: ['cover', 'kpi-grid'] });
  assert.equal(out.workhorseLayout, 'cta',
    `expected cta for value summary, got ${out.workhorseLayout} (${out.rationale})`);
});

test('CRA endpoint hint routes the score reveal to a stat layout', () => {
  const step = {
    id: 'lendscore-reveal',
    narration: 'LendScore returns 78 (beta) with the supporting attributes.',
    visualState: 'Score chip with two supporting bullets.',
    apiResponse: { endpoint: 'POST /cra/check_report/lend_score/get' },
    stepKind: 'slide',
  };
  const out = routeSlideTemplate(step, { stepIndex: 2, totalSlides: 4, recentLayouts: [] });
  assert.ok(
    ['stat-highlight', 'kpi-grid'].includes(out.workhorseLayout),
    `expected stat/kpi for CRA lend_score endpoint, got ${out.workhorseLayout} (${out.rationale})`
  );
});

test('peer benchmark still avoids data-table layout (regression guard)', () => {
  const step = {
    id: 'peer-benchmark-slide',
    narration:
      'Robinhood adopted Plaid Investments Move and saw 90% fewer ACATS failures with 3x more successful transfers.',
    visualState: 'Two large stat callouts side-by-side.',
    stepKind: 'slide',
  };
  const out = routeSlideTemplate(step, { stepIndex: 2, totalSlides: 4, recentLayouts: ['cover'] });
  assert.notEqual(out.workhorseLayout, 'table',
    `peer-benchmark must not route to table, got ${out.workhorseLayout} (${out.rationale})`);
});

test('hard override on step.workhorseLayout still wins', () => {
  const step = {
    id: 'forced-bullets',
    narration: '+25% lift, 95% coverage, ~14 second resolution.',
    workhorseLayout: 'bullets',
    stepKind: 'slide',
  };
  const out = routeSlideTemplate(step, { stepIndex: 1, totalSlides: 4, recentLayouts: [] });
  assert.equal(out.workhorseLayout, 'bullets',
    `author-supplied workhorseLayout must win, got ${out.workhorseLayout}`);
});
