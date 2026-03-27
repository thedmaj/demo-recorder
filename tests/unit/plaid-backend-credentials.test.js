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
};

describe('plaid-backend credential routing', () => {
  beforeEach(() => {
    process.env.PLAID_CLIENT_ID = 'default-client';
    process.env.PLAID_SANDBOX_SECRET = 'default-secret';
    process.env.CRA_CLIENT_ID = 'cra-client';
    process.env.CRA_SECRET = 'cra-secret';
  });

  afterEach(() => {
    process.env.PLAID_CLIENT_ID = ORIGINAL_ENV.PLAID_CLIENT_ID;
    process.env.PLAID_SANDBOX_SECRET = ORIGINAL_ENV.PLAID_SANDBOX_SECRET;
    process.env.CRA_CLIENT_ID = ORIGINAL_ENV.CRA_CLIENT_ID;
    process.env.CRA_SECRET = ORIGINAL_ENV.CRA_SECRET;
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
});
