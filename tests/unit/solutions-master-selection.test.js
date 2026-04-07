'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { extractSolutionNamesFromPrompt } = require('../../scripts/scratch/utils/mcp-clients');

test('extractSolutionNamesFromPrompt reads one-line Solutions:', () => {
  const p = `
  Demo title
  Solutions: Account Opening, Funding, Consumer Report Underwriting
  `;
  const names = extractSolutionNamesFromPrompt(p);
  assert.deepStrictEqual(names, [
    'Account Opening',
    'Funding',
    'Consumer Report Underwriting',
  ]);
});

test('extractSolutionNamesFromPrompt reads multi-line section bullets', () => {
  const p = `
  Solutions supported
  - Account Opening
  - Identity Verification
  - Funding

  PRODUCTS & FAMILY
  `;
  const names = extractSolutionNamesFromPrompt(p);
  assert.deepStrictEqual(names, ['Account Opening', 'Identity Verification', 'Funding']);
});

