'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.PIPELINE_RUN_DIR ||= path.join(__dirname, '../../out');

const {
  computeCaptureDelays,
  normalizeGoToStepExpression,
  isSlideLikeStep,
  buildPlaidLaunchCtaIconDiagnostics,
  waitForLoadingToClear,
} = require(path.join(__dirname, '../../scripts/scratch/scratch/build-qa'));

describe('build-qa helpers', () => {
  test('normalizeGoToStepExpression wraps plain step id', () => {
    assert.equal(normalizeGoToStepExpression('intro'), "window.goToStep('intro')");
  });

  test('normalizeGoToStepExpression preserves explicit window call', () => {
    assert.equal(normalizeGoToStepExpression("window.goToStep('intro')"), "window.goToStep('intro')");
  });

  test('computeCaptureDelays never exceeds total wait', () => {
    const delays = computeCaptureDelays(5000);
    const sum = delays.startWait + delays.midWait + delays.endWait;
    assert.ok(sum <= 5000);
    assert.ok(delays.midWait >= 250);
  });

  test('computeCaptureDelays handles zero wait', () => {
    assert.deepEqual(computeCaptureDelays(0), { startWait: 0, midWait: 0, endWait: 0 });
  });

  test('isSlideLikeStep detects slide semantics from id or visual state', () => {
    assert.equal(isSlideLikeStep({ id: 'auth-slide' }), true);
    assert.equal(isSlideLikeStep({ visualState: 'Technical slide showing API summary' }), true);
    assert.equal(isSlideLikeStep({ id: 'amount-entry', visualState: 'Bank amount entry form' }), false);
  });

  test('buildPlaidLaunchCtaIconDiagnostics skips non-launch steps', () => {
    const d = buildPlaidLaunchCtaIconDiagnostics(
      { id: 'intro', plaidPhase: undefined },
      { activeStepHasPlaidLinkLaunchBtn: true, plaidLaunchCtaMetrics: { buttonHeight: 48, iconMaxDim: 200, svgCount: 1 } }
    );
    assert.equal(d.length, 0);
  });

  test('buildPlaidLaunchCtaIconDiagnostics flags oversized icon', () => {
    const d = buildPlaidLaunchCtaIconDiagnostics(
      { id: 'link-launch', plaidPhase: 'launch' },
      {
        activeStepHasPlaidLinkLaunchBtn: true,
        plaidLaunchCtaMetrics: { buttonHeight: 48, buttonWidth: 400, iconMaxDim: 120, svgCount: 1 },
      }
    );
    assert.equal(d.length, 1);
    assert.equal(d[0].category, 'plaid-launch-cta-icon');
    assert.match(d[0].issue, /disproportionately large/i);
  });

  test('buildPlaidLaunchCtaIconDiagnostics passes modest icon', () => {
    const d = buildPlaidLaunchCtaIconDiagnostics(
      { id: 'link-launch', plaidPhase: 'launch' },
      {
        activeStepHasPlaidLinkLaunchBtn: true,
        plaidLaunchCtaMetrics: { buttonHeight: 56, buttonWidth: 280, iconMaxDim: 20, svgCount: 1 },
      }
    );
    assert.equal(d.length, 0);
  });

  test('buildPlaidLaunchCtaIconDiagnostics warns when svg missing', () => {
    const d = buildPlaidLaunchCtaIconDiagnostics(
      { id: 'link-launch', plaidPhase: 'launch' },
      {
        activeStepHasPlaidLinkLaunchBtn: true,
        plaidLaunchCtaMetrics: { buttonHeight: 48, iconMaxDim: 0, svgCount: 0 },
      }
    );
    assert.equal(d.length, 1);
    assert.match(d[0].issue, /no SVG icon/i);
  });

  test('waitForLoadingToClear short-circuits when no spinner ever appears', async () => {
    const evaluations = [];
    const fakePage = {
      evaluate: async () => {
        evaluations.push('call');
        return { spinner: false, text: null, signal: null };
      },
      waitForTimeout: async () => {},
    };
    const res = await waitForLoadingToClear(fakePage, { maxWaitMs: 500 });
    assert.equal(res.cleared, true);
    assert.ok(res.elapsedMs < 500, 'should return on the first poll');
    assert.equal(evaluations.length, 1);
  });

  test('waitForLoadingToClear polls until spinner/text clears', async () => {
    let polls = 0;
    const fakePage = {
      evaluate: async () => {
        polls += 1;
        if (polls < 3) return { spinner: true, text: null, signal: 'spinner:loader' };
        return { spinner: false, text: null, signal: null };
      },
      waitForTimeout: async () => {},
    };
    const res = await waitForLoadingToClear(fakePage, { maxWaitMs: 5000 });
    assert.equal(res.cleared, true);
    assert.equal(polls, 3);
  });

  test('waitForLoadingToClear times out when spinner never clears', async () => {
    const fakePage = {
      evaluate: async () => ({ spinner: false, text: 'Linking account', signal: 'text:linking account' }),
      waitForTimeout: async () => {},
    };
    const res = await waitForLoadingToClear(fakePage, { maxWaitMs: 200 });
    assert.equal(res.cleared, false);
    assert.equal(res.lastSignal, 'text:linking account');
  });

  test('waitForLoadingToClear is a no-op when maxWaitMs is 0', async () => {
    let called = false;
    const fakePage = {
      evaluate: async () => { called = true; return { spinner: true, text: null, signal: 'x' }; },
      waitForTimeout: async () => {},
    };
    const res = await waitForLoadingToClear(fakePage, { maxWaitMs: 0 });
    assert.equal(res.cleared, true);
    assert.equal(called, false, 'zero maxWaitMs must not invoke page.evaluate');
  });
});
