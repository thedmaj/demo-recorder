'use strict';
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const plaidBackend = require(path.join(__dirname, '../../scripts/scratch/utils/plaid-backend'));

const ORIGINAL_ENV = {
  PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID,
  PLAID_SANDBOX_SECRET: process.env.PLAID_SANDBOX_SECRET,
  CRA_CLIENT_ID: process.env.CRA_CLIENT_ID,
  CRA_SECRET: process.env.CRA_SECRET,
  PLAID_LINK_CUSTOMIZATION: process.env.PLAID_LINK_CUSTOMIZATION,
  PLAID_LINK_CRA_CUSTOMIZAATION: process.env.PLAID_LINK_CRA_CUSTOMIZAATION,
  PLAID_LINK_CRA_CUSTOMIZATION: process.env.PLAID_LINK_CRA_CUSTOMIZATION,
};

describe('plaid-backend credential routing', () => {
  beforeEach(() => {
    process.env.PLAID_CLIENT_ID = 'default-client';
    process.env.PLAID_SANDBOX_SECRET = 'default-secret';
    process.env.CRA_CLIENT_ID = 'cra-client';
    process.env.CRA_SECRET = 'cra-secret';
    process.env.PLAID_LINK_CUSTOMIZATION = 'default-theme';
    process.env.PLAID_LINK_CRA_CUSTOMIZAATION = 'cra-theme';
    delete process.env.PLAID_LINK_CRA_CUSTOMIZATION;
  });

  afterEach(() => {
    process.env.PLAID_CLIENT_ID = ORIGINAL_ENV.PLAID_CLIENT_ID;
    process.env.PLAID_SANDBOX_SECRET = ORIGINAL_ENV.PLAID_SANDBOX_SECRET;
    process.env.CRA_CLIENT_ID = ORIGINAL_ENV.CRA_CLIENT_ID;
    process.env.CRA_SECRET = ORIGINAL_ENV.CRA_SECRET;
    process.env.PLAID_LINK_CUSTOMIZATION = ORIGINAL_ENV.PLAID_LINK_CUSTOMIZATION;
    process.env.PLAID_LINK_CRA_CUSTOMIZAATION = ORIGINAL_ENV.PLAID_LINK_CRA_CUSTOMIZAATION;
    process.env.PLAID_LINK_CRA_CUSTOMIZATION = ORIGINAL_ENV.PLAID_LINK_CRA_CUSTOMIZATION;
  });

  test('defaults to standard Plaid credentials', () => {
    const creds = plaidBackend.getCredentials({});
    assert.equal(creds.clientId, 'default-client');
    assert.equal(creds.secret, 'default-secret');
    assert.equal(creds.scope, 'default');
  });

  test('uses CRA credentials when productFamily is CRA base report', () => {
    const creds = plaidBackend.getCredentials({ productFamily: 'cra_base_report' });
    assert.equal(creds.clientId, 'cra-client');
    assert.equal(creds.secret, 'cra-secret');
    assert.equal(creds.scope, 'cra');
  });

  test('throws when CRA scope requested but CRA creds missing', () => {
    delete process.env.CRA_CLIENT_ID;
    delete process.env.CRA_SECRET;
    assert.throws(
      () => plaidBackend.getCredentials({ productFamily: 'cra_base_report' }),
      /CRA_CLIENT_ID\/CRA_SECRET are missing/
    );
  });

  test('uses CRA credentials when products include consumer_report', () => {
    const scope = plaidBackend.resolveCredentialScope({ products: ['consumer_report'] });
    assert.equal(scope, 'cra');
  });

  test('does not use CRA credentials for traditional income_verification product', () => {
    const scope = plaidBackend.resolveCredentialScope({ products: ['income_verification'] });
    assert.equal(scope, 'default');
  });

  test('uses CRA credentials when products include cra_income_insights', () => {
    const scope = plaidBackend.resolveCredentialScope({ products: ['cra_base_report', 'cra_income_insights'] });
    assert.equal(scope, 'cra');
  });

  test('explicit default scope overrides CRA-like endpoint inference', () => {
    const scope = plaidBackend.resolveCredentialScope({
      endpoint: '/cra/check_report/base_report/get',
      credentialScope: 'default',
    });
    assert.equal(scope, 'default');
  });

  test('CRA customization env var is used for CRA scope', () => {
    const v = plaidBackend.resolveLinkCustomizationName({
      products: ['cra_base_report', 'cra_income_insights'],
      credentialScope: 'cra',
    });
    assert.equal(v, 'cra-theme');
  });

  test('default customization env var is used for non-CRA scope', () => {
    const v = plaidBackend.resolveLinkCustomizationName({
      products: ['auth'],
      credentialScope: 'default',
    });
    assert.equal(v, 'default-theme');
  });

  test('explicit linkCustomizationName overrides env vars', () => {
    const v = plaidBackend.resolveLinkCustomizationName({
      products: ['cra_base_report'],
      credentialScope: 'cra',
      linkCustomizationName: 'explicit-theme',
    });
    assert.equal(v, 'explicit-theme');
  });
});
