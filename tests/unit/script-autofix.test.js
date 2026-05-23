'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  autoFixDemoScript,
  validateDemoScript,
} = require(path.join(__dirname, '../../scripts/scratch/scratch/generate-script'));

// ── Helpers ─────────────────────────────────────────────────────────────────

function linkStep() {
  return {
    id: 'plaid-link-launch',
    sceneType: 'link',
    plaidPhase: 'launch',
    label: 'Connect',
    visualState: 'Plaid Link modal',
    narration: 'Megan opens Plaid Link.',
  };
}

function hostStep(id, label) {
  return {
    id,
    sceneType: 'host',
    label,
    visualState: 'host UI',
    narration: 'Host narration.',
  };
}

function valueSummary() {
  return {
    id: 'value-summary-slide',
    sceneType: 'slide',
    label: 'Value summary',
    visualState: '.slide-root closing',
    narration: 'Recap.',
  };
}

// ── orphan-insight-to-slide ─────────────────────────────────────────────────

describe('autoFixDemoScript — orphan-insight-to-slide', () => {
  test('demotes insight without apiResponse to slide and strips stub', () => {
    const ds = {
      steps: [
        linkStep(),
        {
          id: 'investments-auth-get-slide',
          sceneType: 'insight',
          label: 'What /investments/auth/get returns',
          visualState: '.slide-root statement',
          narration: 'Frame the API.',
          // No apiResponse — this is the LLM's mistake that broke the Betterment run.
        },
        valueSummary(),
      ],
    };
    const out = autoFixDemoScript(ds);
    assert.equal(out.fixed, 1);
    assert.equal(out.fixes[0].rule, 'orphan-insight-to-slide');
    assert.equal(out.fixes[0].stepId, 'investments-auth-get-slide');
    assert.equal(ds.steps[1].sceneType, 'slide');
    // After the fix, validateDemoScript should now pass on this issue.
    const v = validateDemoScript(ds, { productFamily: 'generic', plaidLinkLive: true });
    assert.equal(
      v.errors.filter((e) => /missing apiResponse/.test(e)).length,
      0,
      'no more apiResponse-missing errors after demote'
    );
  });

  test('demotes insight with half-built apiResponse (endpoint only, no response)', () => {
    const ds = {
      steps: [
        linkStep(),
        {
          id: 'half-built',
          sceneType: 'insight',
          label: 'half',
          apiResponse: { endpoint: 'POST /investments/auth/get' /* no response */ },
        },
        valueSummary(),
      ],
    };
    const out = autoFixDemoScript(ds);
    assert.equal(out.fixed, 1);
    assert.equal(ds.steps[1].sceneType, 'slide');
    assert.equal(ds.steps[1].apiResponse, undefined);
  });

  test('does NOT demote a fully-formed insight step', () => {
    const ds = {
      steps: [
        linkStep(),
        {
          id: 'good-insight',
          sceneType: 'insight',
          label: 'Real insight',
          apiResponse: {
            endpoint: 'POST /investments/auth/get',
            response: { numbers: { acats: [{ account: 'TR5555', dtc_numbers: ['1111'] }] } },
          },
        },
        valueSummary(),
      ],
    };
    const out = autoFixDemoScript(ds);
    assert.equal(out.fixed, 0);
    assert.equal(ds.steps[1].sceneType, 'insight');
  });
});

// ── value-summary-strip-apiresponse ─────────────────────────────────────────

describe('autoFixDemoScript — value-summary-strip-apiresponse', () => {
  test('strips apiResponse from the value-summary slide', () => {
    const ds = {
      steps: [
        linkStep(),
        hostStep('host-1', 'host one'),
        {
          ...valueSummary(),
          apiResponse: { endpoint: 'fake', response: { x: 1 } },
        },
      ],
    };
    const out = autoFixDemoScript(ds);
    assert.equal(out.fixed, 1);
    assert.equal(out.fixes[0].rule, 'value-summary-strip-apiresponse');
    assert.equal(ds.steps[2].apiResponse, undefined);
  });
});

// ── infer-plaid-launch-phase ────────────────────────────────────────────────

describe('autoFixDemoScript — infer-plaid-launch-phase', () => {
  test('sets plaidPhase launch on sceneType link step missing it', () => {
    const ds = {
      steps: [
        hostStep('intro', 'Intro'),
        {
          id: 'wf-link-embedded',
          sceneType: 'link',
          label: 'Embedded Plaid Link',
          visualState: 'data-testid="plaid-embedded-link-container" active',
          narration: 'Jordan connects her checking account inside the embedded frame.',
        },
        hostStep('post-link', 'Success'),
      ],
    };
    const out = autoFixDemoScript(ds);
    assert.equal(out.fixed, 1);
    assert.equal(out.fixes[0].rule, 'infer-plaid-launch-phase');
    assert.equal(ds.steps[1].plaidPhase, 'launch');
    assert.equal(ds.steps[1].sceneType, 'link');
  });

  test('no-op when launch step already present', () => {
    const ds = { steps: [hostStep('intro', 'Intro'), linkStep(), hostStep('post', 'Post')] };
    const out = autoFixDemoScript(ds);
    assert.equal(out.fixed, 0);
  });

  test('strips launch from slides when LLM marks multiple steps as launch', () => {
    const ds = {
      steps: [
        {
          id: 'opening-partnership-slide',
          sceneType: 'slide',
          plaidPhase: 'launch',
          label: 'Partnership',
          visualState: '.slide-root',
          narration: 'Intro.',
        },
        {
          id: 'wf-link-embedded',
          sceneType: 'host',
          plaidPhase: 'launch',
          label: 'Link account',
          visualState: 'data-testid="plaid-embedded-link-container"',
          narration: 'Jordan connects her account.',
        },
        {
          id: 'signal-technical-slide',
          sceneType: 'slide',
          plaidPhase: 'launch',
          label: 'Signal',
          visualState: '.slide-root',
          narration: 'Signal API.',
        },
      ],
    };
    const out = autoFixDemoScript(ds);
    assert.ok(out.fixes.some((f) => f.rule === 'dedupe-plaid-launch-phase'));
    assert.equal(ds.steps[1].plaidPhase, 'launch');
    assert.equal(ds.steps[0].plaidPhase, undefined);
    assert.equal(ds.steps[2].plaidPhase, undefined);
  });
});

// ── No-op safety ────────────────────────────────────────────────────────────

describe('autoFixDemoScript — safe on already-clean scripts', () => {
  test('no fixes applied to a valid script', () => {
    const ds = {
      steps: [
        linkStep(),
        hostStep('host-1', 'host one'),
        hostStep('host-2', 'host two'),
        valueSummary(),
      ],
    };
    const out = autoFixDemoScript(ds);
    assert.equal(out.fixed, 0);
  });

  test('handles malformed/empty input', () => {
    assert.deepEqual(autoFixDemoScript(null), { fixed: 0, fixes: [] });
    assert.deepEqual(autoFixDemoScript({}), { fixed: 0, fixes: [] });
    assert.deepEqual(autoFixDemoScript({ steps: [] }), { fixed: 0, fixes: [] });
    assert.deepEqual(autoFixDemoScript({ steps: [null, undefined, 'not-a-step'] }), { fixed: 0, fixes: [] });
  });
});
