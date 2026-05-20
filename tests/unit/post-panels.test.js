'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  normalizePanelsInHtml,
  collectStepApiResponses,
  stepHasApiResponse,
  findSparsePayloadSteps,
  extractJsonFromLlmText,
} = require(path.join(__dirname, '../../scripts/scratch/scratch/post-panels'));

const BASELINE_HTML = `<!doctype html>
<html><head><title>Demo</title></head><body>
<div data-testid="step-intro" class="step active"><p>Intro</p></div>
<div data-testid="step-signal" class="step"><p>Signal</p></div>
<script>window.goToStep = function(id){};</script>
</body></html>`;

const DEMO_SCRIPT = {
  steps: [
    { id: 'intro', sceneType: 'host' },
    {
      id: 'signal',
      sceneType: 'insight',
      apiResponse: {
        endpoint: 'POST /signal/evaluate',
        response: { scores: { risk_score: 0.08 }, recommendation: 'ACCEPT' },
      },
    },
  ],
};

describe('post-panels', () => {
  test('stepHasApiResponse only accepts insight steps with a real response', () => {
    assert.equal(stepHasApiResponse(null), false);
    assert.equal(stepHasApiResponse({ id: 'x' }), false);
    assert.equal(stepHasApiResponse(DEMO_SCRIPT.steps[0]), false);
    assert.equal(stepHasApiResponse(DEMO_SCRIPT.steps[1]), true);
  });

  test('collectStepApiResponses returns only qualifying steps', () => {
    const { responses, endpoints } = collectStepApiResponses(DEMO_SCRIPT);
    assert.deepEqual(Object.keys(responses), ['signal']);
    assert.equal(endpoints.signal, 'POST /signal/evaluate');
  });

  test('normalizePanelsInHtml injects panels, toggle, renderjson, and patch', () => {
    const { html, changes } = normalizePanelsInHtml(BASELINE_HTML, DEMO_SCRIPT);
    assert.equal(changes.addedApiPanelShell, true);
    assert.equal(changes.addedLinkEventsShell, true);
    assert.equal(changes.addedRenderjson, true);
    assert.equal(changes.addedPatchScript, true);
    assert.equal(changes.stepsHydrated, 1);

    assert.match(html, /id="api-response-panel"/);
    assert.match(html, /id="link-events-panel"/);
    assert.match(html, /renderjson\.min\.js/);
    assert.match(html, /data-testid="api-panel-toggle"/);
    assert.match(html, /window\.__buildApiPanelPatchApplied/);
    assert.match(html, /window\._stepApiResponses/);
  });

  test('normalizePanelsInHtml is idempotent on a second pass', () => {
    const first = normalizePanelsInHtml(BASELINE_HTML, DEMO_SCRIPT);
    const second = normalizePanelsInHtml(first.html, DEMO_SCRIPT);
    assert.equal(first.html, second.html, 'HTML should be stable after second normalization');
    assert.equal(second.changes.addedApiPanelShell, false);
    assert.equal(second.changes.addedPatchScript, false);
    assert.equal(second.changes.alreadyNormalized, true);
  });

  test('normalizePanelsInHtml skips api panel injection when no API data is present', () => {
    const noApiScript = { steps: [{ id: 'intro', sceneType: 'host' }] };
    const { html, changes } = normalizePanelsInHtml(BASELINE_HTML, noApiScript);
    assert.equal(changes.addedApiPanelShell, false);
    assert.equal(changes.addedPatchScript, false);
    assert.ok(!/id="api-response-panel"/.test(html));
  });

  test('normalizePanelsInHtml is a full no-op in app-only mode', () => {
    const { html, changes } = normalizePanelsInHtml(BASELINE_HTML, DEMO_SCRIPT, {
      pipelineAppOnlyHostUi: true,
    });
    assert.equal(changes.appOnlySkipped, true);
    assert.equal(changes.addedApiPanelShell, false);
    assert.equal(changes.addedLinkEventsShell, false);
    assert.equal(changes.addedRenderjson, false);
    assert.equal(changes.addedPatchScript, false);
    assert.equal(html, BASELINE_HTML, 'HTML must be returned unchanged in app-only mode');
  });

  test('findSparsePayloadSteps flags low-key-count and placeholder payloads', () => {
    const script = {
      steps: [
        {
          id: 'full',
          apiResponse: {
            endpoint: 'POST /a/b',
            response: { a: 1, b: 2, c: 3, d: 4 },
          },
        },
        {
          id: 'sparse',
          apiResponse: {
            endpoint: 'POST /a/b',
            response: { only_key: 1 },
          },
        },
        {
          id: 'placeholder',
          apiResponse: {
            endpoint: 'POST /a/b',
            response: { a: 1, b: 2, c: 'TODO' },
          },
        },
      ],
    };
    const sparse = findSparsePayloadSteps(script);
    const ids = sparse.map((s) => s.stepId).sort();
    assert.deepEqual(ids, ['placeholder', 'sparse']);
  });

  test('extractJsonFromLlmText handles fenced and bare responses', () => {
    assert.deepEqual(
      extractJsonFromLlmText('```json\n{"a":1,"b":2}\n```'),
      { a: 1, b: 2 }
    );
    assert.deepEqual(
      extractJsonFromLlmText('Sure, here you go: {"a":1}'),
      { a: 1 }
    );
    assert.equal(extractJsonFromLlmText('no json here'), null);
  });
});

// ─── v6: onSuccess synthesis for post-link host step ─────────────────────────

describe('onSuccess panel synthesis (v6)', () => {
  test('auto-injects onSuccess apiResponse on the step right after plaidPhase:"launch"', () => {
    const script = {
      plaidSandboxConfig: {
        institutionId: 'ins_109508',
        institutionName: 'First Platypus Bank',
      },
      steps: [
        { id: 'intro', sceneType: 'host' },
        { id: 'plaid-link-launch', sceneType: 'link', plaidPhase: 'launch' },
        // No apiResponse on this step — should be auto-injected.
        { id: 'link-success', sceneType: 'host', stepKind: 'app' },
      ],
    };
    const { responses, endpoints } = collectStepApiResponses(script);
    assert.ok(responses['link-success'], 'link-success should have a synthesized response');
    assert.equal(endpoints['link-success'], 'Plaid Link onSuccess (callback)');
    const resp = responses['link-success'];
    assert.ok(typeof resp.public_token === 'string' && resp.public_token.startsWith('public-sandbox-'));
    assert.equal(resp.metadata.institution.name, 'First Platypus Bank');
    assert.equal(resp.metadata.institution.institution_id, 'ins_109508');
    assert.ok(Array.isArray(resp.metadata.accounts) && resp.metadata.accounts.length === 1);
    assert.equal(resp.metadata.accounts[0].mask, '0211');
    assert.ok(typeof resp.metadata.link_session_id === 'string');
  });

  test('does NOT override an existing apiResponse on the post-link step', () => {
    const script = {
      steps: [
        { id: 'plaid-link-launch', sceneType: 'link', plaidPhase: 'launch' },
        {
          id: 'bank-income-review',
          sceneType: 'host',
          apiResponse: {
            endpoint: 'POST /credit/bank_income/get',
            response: { bank_income: [{ bank_income_id: 'abc' }] },
          },
        },
      ],
    };
    const { responses, endpoints } = collectStepApiResponses(script);
    // The existing Bank Income response wins; no onSuccess synthesis.
    assert.deepEqual(responses['bank-income-review'].bank_income, [{ bank_income_id: 'abc' }]);
    assert.equal(endpoints['bank-income-review'], 'POST /credit/bank_income/get');
  });

  test('skips synthesis when the post-link step is itself a link or slide', () => {
    const script = {
      steps: [
        { id: 'plaid-link-launch', sceneType: 'link', plaidPhase: 'launch' },
        { id: 'value-summary', sceneType: 'slide', stepKind: 'slide' },
      ],
    };
    const { responses } = collectStepApiResponses(script);
    assert.ok(!responses['value-summary'], 'slide step must not get synthesized response');
  });

  test('skips synthesis when no plaidPhase:"launch" step exists', () => {
    const script = {
      steps: [
        { id: 'intro', sceneType: 'host' },
        { id: 'outro', sceneType: 'host' },
      ],
    };
    const { responses } = collectStepApiResponses(script);
    assert.equal(Object.keys(responses).length, 0);
  });

  test('skips synthesis when the launch step is the last step', () => {
    const script = {
      steps: [
        { id: 'intro', sceneType: 'host' },
        { id: 'plaid-link-launch', sceneType: 'link', plaidPhase: 'launch' },
      ],
    };
    const { responses } = collectStepApiResponses(script);
    assert.equal(Object.keys(responses).length, 0);
  });

  test('uses sandbox account overrides from plaidSandboxConfig when provided', () => {
    const script = {
      plaidSandboxConfig: {
        institutionName: 'Tartan Bank',
        institutionId: 'ins_117650',
        accountName: 'Savings Account',
        accountMask: '4321',
        accountType: 'depository',
        accountSubtype: 'savings',
      },
      steps: [
        { id: 'plaid-link-launch', sceneType: 'link', plaidPhase: 'launch' },
        { id: 'connected', sceneType: 'host' },
      ],
    };
    const { responses } = collectStepApiResponses(script);
    const m = responses['connected'].metadata;
    assert.equal(m.institution.name, 'Tartan Bank');
    assert.equal(m.institution.institution_id, 'ins_117650');
    assert.equal(m.accounts[0].name, 'Savings Account');
    assert.equal(m.accounts[0].mask, '4321');
    assert.equal(m.accounts[0].subtype, 'savings');
  });
});
