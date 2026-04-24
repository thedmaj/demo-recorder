'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  deriveStepKind,
  annotateScriptWithStepKinds,
  isSlideStep,
  getSlideStepIds,
  getAppStepIds,
} = require(path.join(__dirname, '../../scripts/scratch/utils/step-kind'));

describe('step-kind', () => {
  test('deriveStepKind classifies slide and insight as "slide" (Plaid interstitials)', () => {
    assert.equal(deriveStepKind({ id: 'x', sceneType: 'slide' }), 'slide');
    assert.equal(deriveStepKind({ id: 'x', sceneType: 'insight' }), 'slide');
    assert.equal(deriveStepKind({ id: 'x', sceneType: 'host' }), 'app');
    assert.equal(deriveStepKind({ id: 'x', sceneType: 'link' }), 'app');
  });

  test('deriveStepKind treats slideLibraryRef as slide', () => {
    assert.equal(
      deriveStepKind({ id: 'x', slideLibraryRef: { slideId: 'y' } }),
      'slide'
    );
  });

  test('deriveStepKind falls back to text heuristics', () => {
    assert.equal(deriveStepKind({ id: 'value-summary-slide' }), 'slide');
    assert.equal(
      deriveStepKind({ id: 'verify-signal', visualState: 'Shows Plaid insight card with JSON' }),
      'slide'
    );
    assert.equal(deriveStepKind({ id: 'amount-entry' }), 'app');
    assert.equal(
      deriveStepKind({ id: 'intro', visualState: 'Plaid slide with .slide-root surface' }),
      'slide'
    );
  });

  test('deriveStepKind preserves an already-set stepKind when valid', () => {
    assert.equal(deriveStepKind({ id: 'x', stepKind: 'slide', sceneType: 'host' }), 'slide');
    assert.equal(deriveStepKind({ id: 'x', stepKind: 'app', sceneType: 'slide' }), 'app');
  });

  test('annotateScriptWithStepKinds mutates steps and counts', () => {
    const script = {
      steps: [
        { id: 'a', sceneType: 'host' },
        { id: 'b', sceneType: 'slide' },
        { id: 'c', sceneType: 'insight' },
        { id: 'd', visualState: 'Bank account summary' },
      ],
    };
    const { counts, mutated } = annotateScriptWithStepKinds(script);
    assert.equal(mutated, 4);
    assert.equal(script.steps[0].stepKind, 'app');
    assert.equal(script.steps[1].stepKind, 'slide');
    assert.equal(script.steps[2].stepKind, 'slide');
    assert.equal(script.steps[3].stepKind, 'app');
    assert.equal(counts.slide, 2);
    assert.equal(counts.app, 2);
  });

  test('annotateScriptWithStepKinds is idempotent after first run', () => {
    const script = {
      steps: [
        { id: 'a', sceneType: 'slide' },
        { id: 'b', sceneType: 'host' },
      ],
    };
    annotateScriptWithStepKinds(script);
    const second = annotateScriptWithStepKinds(script);
    assert.equal(second.mutated, 0);
  });

  test('isSlideStep / getSlideStepIds / getAppStepIds are consistent', () => {
    const script = {
      steps: [
        { id: 'a', sceneType: 'slide' },
        { id: 'b', sceneType: 'host' },
        { id: 'c', stepKind: 'slide' },
      ],
    };
    assert.deepEqual(getSlideStepIds(script), ['a', 'c']);
    assert.deepEqual(getAppStepIds(script), ['b']);
    assert.equal(isSlideStep(script.steps[0]), true);
    assert.equal(isSlideStep(script.steps[1]), false);
  });
});
