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
