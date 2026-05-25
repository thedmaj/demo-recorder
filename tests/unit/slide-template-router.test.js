'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { routeSlideTemplate } = require('../../scripts/scratch/utils/slide-template-router');

const ROOT = path.join(__dirname, '../..');
const opts = { projectRoot: ROOT };

test('routes opening explainer to cover on first slide', () => {
  const r = routeSlideTemplate(
    { id: 'opener', narration: 'Welcome to the product overview and hero moment.' },
    { stepIndex: 0, totalSlides: 6 },
    opts
  );
  assert.equal(r.category, 'opening');
  assert.equal(r.workhorseLayout, 'cover');
  assert.equal(r.templateId, 't1-title-hero');
});

test('routes metrics narration to stat or kpi layout', () => {
  const r = routeSlideTemplate(
    { id: 'signal-insight', narration: 'Signal score 12 with 94% acceptance across three KPI metrics.' },
    { stepIndex: 2, totalSlides: 8 },
    opts
  );
  assert.equal(r.category, 'metrics');
  assert.ok(['stat-highlight', 'kpi-grid', 'table', 'chart-bar'].includes(r.workhorseLayout));
});

test('routes comparison flow narration to comparison or process layout', () => {
  const r = routeSlideTemplate(
    {
      id: 'before-after',
      narration: 'Before manual review the old way vs the new way — side-by-side transformation through the integration flow.',
    },
    { stepIndex: 3, totalSlides: 8 },
    opts
  );
  assert.equal(r.category, 'comparison_flow');
  assert.ok(['comparison', 'process-steps', 'flow-diagram', 'arch-diagram'].includes(r.workhorseLayout));
});

test('routes value-summary-slide to cta close template', () => {
  const r = routeSlideTemplate(
    { id: 'value-summary-slide', label: 'Value Summary', narration: 'Clear outcomes and next steps for product teams.' },
    { stepIndex: 7, totalSlides: 8 },
    opts
  );
  assert.equal(r.workhorseLayout, 'cta');
  assert.equal(r.templateId, 't11-action-cards');
});

test('routes peer-benchmark slide to stat-highlight not data-table', () => {
  const r = routeSlideTemplate(
    {
      id: 'peer-benchmark-slide',
      narration: 'Peer benchmark: 5–10% stepped up, ~50% fraud captured across the portfolio.',
      visualState: 'Two large stat callouts side by side — peer benchmark data.',
    },
    { stepIndex: 3, totalSlides: 8 },
    opts
  );
  assert.equal(r.workhorseLayout, 'stat-highlight');
  assert.notEqual(r.templateId, 'data-table');
});

test('honors script workhorseLayout override', () => {
  const r = routeSlideTemplate(
    { id: 'x', workhorseLayout: 'table', narration: 'Generic explainer copy.' },
    { stepIndex: 1, totalSlides: 4 },
    opts
  );
  assert.equal(r.workhorseLayout, 'table');
  assert.equal(r.templateId, 'data-table');
});
