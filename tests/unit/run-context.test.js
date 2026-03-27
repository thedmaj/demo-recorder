'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildRunContextPayload, buildApprovedClaimsDigest } = require(
  path.join(__dirname, '../../scripts/scratch/utils/run-context')
);

describe('run-context', () => {
  test('buildApprovedClaimsDigest pulls research arrays', () => {
    const research = {
      synthesizedInsights: {
        valuePropositions: ['VP one', 'VP two'],
        keyFeatures: ['F1'],
      },
    };
    const d = buildApprovedClaimsDigest(research, 'generic');
    assert.ok(d.fromResearch.includes('VP one'));
  });

  test('buildRunContextPayload includes productProfile and digest shape', () => {
    const payload = buildRunContextPayload({
      phase: 'test',
      productFamily: 'funding',
      productResearch: { synthesizedInsights: { valuePropositions: ['x'] } },
      demoScript: { product: 'Plaid Signal', steps: [{ id: 'a' }] },
      promptText: 'demo',
    });
    assert.equal(payload.phase, 'test');
    assert.equal(payload.productFamily, 'funding');
    assert.ok(payload.productProfile && payload.productProfile.label);
    assert.ok(Array.isArray(payload.curatedDigest.knowledgeFiles));
    assert.ok(payload.demoScriptSummary.stepIds.includes('a'));
  });
});
