'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  inferProductFamilyFromText,
  inferProductFamily,
  getProductProfile,
} = require(path.join(__dirname, '../../scripts/scratch/utils/product-profiles'));

describe('product-profiles', () => {
  test('CRA wording resolves to cra_base_report', () => {
    assert.equal(inferProductFamilyFromText('Build a CRA Base Report underwriting demo'), 'cra_base_report');
  });

  test('income wording resolves to income_insights', () => {
    assert.equal(inferProductFamilyFromText('CRA Income Insights underwriting review'), 'income_insights');
  });

  test('funding wording resolves to funding', () => {
    assert.equal(inferProductFamilyFromText('Signal plus Auth account funding flow'), 'funding');
  });

  test('demoScript endpoint inference resolves to CRA', () => {
    const family = inferProductFamily({
      demoScript: {
        product: 'Plaid Check Base Report',
        steps: [{ id: 'base-report-insight', apiResponse: { endpoint: '/cra/check_report/base_report/get' } }],
      },
    });
    assert.equal(family, 'cra_base_report');
  });

  test('returns generic profile for unknown text', () => {
    assert.equal(inferProductFamilyFromText('Something unrelated'), 'generic');
    assert.equal(getProductProfile('unknown').key, 'generic');
  });
});
