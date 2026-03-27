'use strict';
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const BACKEND_PATH = path.join(__dirname, '../../scripts/scratch/utils/plaid-backend.js');

describe('createLinkToken Plaid body', () => {
  let origFetch;
  let lastInit;

  beforeEach(() => {
    process.env.PLAID_CLIENT_ID = 'default-client';
    process.env.PLAID_SANDBOX_SECRET = 'default-secret';
    process.env.CRA_CLIENT_ID = 'cra-client';
    process.env.CRA_SECRET = 'cra-secret';
    origFetch = global.fetch;
    global.fetch = async (_url, init) => {
      lastInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          link_token: 'link-sandbox-test-token',
          expiration: '2099-01-01T00:00:00Z',
          request_id: 'req-test',
        }),
      };
    };
  });

  afterEach(() => {
    global.fetch = origFetch;
    delete require.cache[require.resolve(BACKEND_PATH)];
  });

  test('forwards consumer_report_permissible_purpose for CRA products', async () => {
    const plaid = require(BACKEND_PATH);
    await plaid.createLinkToken({
      products: ['cra_base_report'],
      userId: 'u-cra-1',
      consumer_report_permissible_purpose: 'EXTENSION_OF_CREDIT',
    });
    const payload = JSON.parse(lastInit.body);
    assert.equal(payload.consumer_report_permissible_purpose, 'EXTENSION_OF_CREDIT');
    assert.deepEqual(payload.products, ['cra_base_report']);
    assert.equal(payload.client_id, 'cra-client');
  });

  test('merges cra_options when provided', async () => {
    const plaid = require(BACKEND_PATH);
    await plaid.createLinkToken({
      products: ['cra_base_report', 'cra_income_insights'],
      userId: 'u2',
      consumer_report_permissible_purpose: 'EXTENSION_OF_CREDIT',
      cra_options: { days_requested: 90 },
    });
    const payload = JSON.parse(lastInit.body);
    assert.deepEqual(payload.cra_options, { days_requested: 90 });
  });
});
