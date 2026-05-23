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
  resolveInitialStepId,
  scanRenderjsonDisclosureStyling,
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

  test('resolveInitialStepId returns first demo-script step (slide-first CarMax pattern)', () => {
    assert.equal(
      resolveInitialStepId({
        steps: [
          { id: 'bureau-blind-spot-slide', stepKind: 'slide' },
          { id: 'carmax-application', stepKind: 'app' },
        ],
      }),
      'bureau-blind-spot-slide'
    );
    assert.equal(resolveInitialStepId({ steps: [] }), null);
    assert.equal(resolveInitialStepId(null), null);
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

  // ── scanRenderjsonDisclosureStyling ──────────────────────────────────────
  // Deterministic static-CSS check for the LLM bug that gave renderjson's
  // .disclosure toggles width/background-color, producing huge white blocks
  // in the JSON panel (regression: 2026-05-21-Uses-Current-For-Daily-CRA-
  // Auth-Identity-Signal-Protect-v1). The runtime override in post-panels.js
  // v8 masks the symptom — this check surfaces the source bug.

  test('scanRenderjsonDisclosureStyling: clean HTML produces no diagnostics', () => {
    const html = `<html><head><style>.disclosure { color: rgba(255,255,255,0.55); cursor: pointer; }</style></head><body></body></html>`;
    const d = scanRenderjsonDisclosureStyling(html);
    assert.equal(d.length, 0);
  });

  test('scanRenderjsonDisclosureStyling: HTML with no .disclosure rule produces no diagnostics', () => {
    const html = `<html><head><style>body { margin: 0; }</style></head><body></body></html>`;
    const d = scanRenderjsonDisclosureStyling(html);
    assert.equal(d.length, 0);
  });

  test('scanRenderjsonDisclosureStyling: flags .disclosure with width+background as deterministic blocker', () => {
    // The exact failure pattern from the regression run.
    const html = `<html><head><style>
      .disclosure { width: 24px; height: 24px; background-color: white; }
    </style></head><body></body></html>`;
    const d = scanRenderjsonDisclosureStyling(html);
    assert.equal(d.length, 1);
    assert.equal(d[0].category, 'json-panel-styling');
    assert.equal(d[0].severity, 'critical');
    assert.equal(d[0].deterministicBlocker, true);
    assert.match(d[0].issue, /large solid blocks/);
  });

  test('scanRenderjsonDisclosureStyling: flags .disclosure with background-image', () => {
    const html = `<html><head><style>
      a.disclosure { background-image: url('data:image/svg+xml,...'); }
    </style></head><body></body></html>`;
    const d = scanRenderjsonDisclosureStyling(html);
    assert.equal(d.length, 1);
    assert.equal(d[0].deterministicBlocker, true);
  });

  test('scanRenderjsonDisclosureStyling: ignores harmless values (transparent / none / auto / 0)', () => {
    const html = `<html><head><style>
      .disclosure { width: auto; height: auto; background: transparent; background-image: none; }
    </style></head><body></body></html>`;
    const d = scanRenderjsonDisclosureStyling(html);
    assert.equal(d.length, 0, 'auto/transparent/none must not trigger the check');
  });

  test('scanRenderjsonDisclosureStyling: ignores the post-panels override block (already the fix)', () => {
    // The runtime override in post-panels.js v8 legitimately sets
    // width:auto, height:auto, background:transparent on
    // #api-response-panel .disclosure. That is the fix, not the bug.
    const html = `<html><head><style>
      #api-response-panel .disclosure, #api-response-panel a.disclosure {
        width: auto !important; height: auto !important; background: transparent !important;
      }
    </style></head><body></body></html>`;
    const d = scanRenderjsonDisclosureStyling(html);
    assert.equal(d.length, 0);
  });

  test('scanRenderjsonDisclosureStyling: still flags problematic rule even when override is also present', () => {
    // Real-world post-panels-fixed HTML: the LLM bug is still present in the
    // host CSS, the override is also present. We want the diagnostic to
    // surface the LLM bug so future builds can be cleaned up.
    const html = `<html><head><style>
      .disclosure { width: 24px; background-color: white; }
      #api-response-panel .disclosure { width: auto !important; background: transparent !important; }
    </style></head><body></body></html>`;
    const d = scanRenderjsonDisclosureStyling(html);
    assert.equal(d.length, 1, 'must surface the LLM-emitted rule even when the override is present');
  });
});
