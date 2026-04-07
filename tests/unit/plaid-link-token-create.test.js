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

describe('createConsumerReportLinkToken CRA legacy compatibility', () => {
  let origFetch;
  const calls = [];

  beforeEach(() => {
    process.env.PLAID_CLIENT_ID = 'default-client';
    process.env.PLAID_SANDBOX_SECRET = 'default-secret';
    process.env.CRA_CLIENT_ID = 'cra-client';
    process.env.CRA_SECRET = 'cra-secret';
    process.env.CRA_LAYER_TEMPLATE = 'template_legacy_cra';
    origFetch = global.fetch;
    calls.length = 0;
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      const endpoint = String(url).replace(/^https?:\/\/[^/]+/, '');
      if (endpoint === '/session/token/create') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            link: { link_token: 'link-session-cra', expiration: '2099-01-01T00:00:00Z' },
            request_id: 'req-session-cra',
          }),
        };
      }
      if (endpoint === '/link/token/create') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            link_token: 'link-fallback-cra',
            expiration: '2099-01-01T00:00:00Z',
            request_id: 'req-fallback-cra',
          }),
        };
      }
      throw new Error(`Unexpected endpoint in test: ${endpoint}`);
    };
  });

  afterEach(() => {
    global.fetch = origFetch;
    delete process.env.CRA_LAYER_TEMPLATE;
    delete require.cache[require.resolve(BACKEND_PATH)];
  });

  test('uses provided legacy token for /session/token/create user.user_id', async () => {
    const plaid = require(BACKEND_PATH);
    const res = await plaid.createConsumerReportLinkToken({
      userId: 'existing-cra-user',
      products: ['cra_base_report', 'cra_income_insights'],
      credentialScope: 'cra',
      legacyUserToken: 'legacy-cra-user-token',
    });
    assert.equal(res.link_token, 'link-session-cra');
    const sessionCall = calls.find((c) => String(c.url).includes('/session/token/create'));
    assert.ok(sessionCall, 'expected /session/token/create call');
    const payload = JSON.parse(sessionCall.init.body);
    assert.equal(payload.user.user_id, 'legacy-cra-user-token');
    assert.equal(payload.template_id, 'template_legacy_cra');
  });
});

describe('createConsumerReportLinkToken CRA bootstrap payload', () => {
  let origFetch;
  const calls = [];

  beforeEach(() => {
    process.env.CRA_CLIENT_ID = 'cra-client';
    process.env.CRA_SECRET = 'cra-secret';
    delete process.env.CRA_LAYER_TEMPLATE;
    origFetch = global.fetch;
    calls.length = 0;
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      const endpoint = String(url).replace(/^https?:\/\/[^/]+/, '');
      if (endpoint === '/user/create') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user_id: 'usr_test_123',
            request_id: 'req-user-create',
          }),
        };
      }
      if (endpoint === '/link/token/create') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            link_token: 'link-cra-bootstrap',
            expiration: '2099-01-01T00:00:00Z',
            request_id: 'req-link-token',
          }),
        };
      }
      throw new Error(`Unexpected endpoint in test: ${endpoint}`);
    };
  });

  afterEach(() => {
    global.fetch = origFetch;
    delete require.cache[require.resolve(BACKEND_PATH)];
  });

  test('sends CRA user profile to /user/create and uses returned user_id', async () => {
    const plaid = require(BACKEND_PATH);
    await plaid.createConsumerReportLinkToken({
      userId: 'zip-cra-user-1',
      products: ['cra_base_report', 'cra_income_insights'],
      credentialScope: 'cra',
      consumer_report_permissible_purpose: 'EXTENSION_OF_CREDIT',
    });
    const userCreateCall = calls.find((c) => String(c.url).includes('/user/create'));
    assert.ok(userCreateCall, 'expected /user/create call');
    const userCreatePayload = JSON.parse(userCreateCall.init.body);
    assert.ok(userCreatePayload.identity, 'expected identity object in /user/create payload');
    assert.equal(userCreatePayload.client_user_id, 'zip-cra-user-1');
    assert.equal(userCreatePayload.user, undefined);
    assert.equal(userCreatePayload.identity.name.given_name, 'Carmen');

    const linkTokenCall = calls.find((c) => String(c.url).includes('/link/token/create'));
    assert.ok(linkTokenCall, 'expected /link/token/create call');
    const linkTokenPayload = JSON.parse(linkTokenCall.init.body);
    assert.equal(linkTokenPayload.user_id, 'usr_test_123');
  });

  test('retries /user/create with legacy consumer_report_user_identity when identity field is unsupported', async () => {
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      const endpoint = String(url).replace(/^https?:\/\/[^/]+/, '');
      const payload = JSON.parse(init.body);
      if (endpoint === '/user/create' && payload.identity) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error_message: 'the following fields are not recognized by this endpoint: identity',
          }),
        };
      }
      if (endpoint === '/user/create' && payload.consumer_report_user_identity) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user_id: 'usr_test_legacy_retry',
            request_id: 'req-user-create-retry',
          }),
        };
      }
      if (endpoint === '/link/token/create') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            link_token: 'link-cra-legacy-retry',
            expiration: '2099-01-01T00:00:00Z',
            request_id: 'req-link-token-retry',
          }),
        };
      }
      throw new Error(`Unexpected endpoint in test: ${endpoint}`);
    };

    const plaid = require(BACKEND_PATH);
    const res = await plaid.createConsumerReportLinkToken({
      userId: 'zip-cra-user-2',
      products: ['cra_base_report', 'cra_income_insights'],
      credentialScope: 'cra',
      consumer_report_permissible_purpose: 'EXTENSION_OF_CREDIT',
    });
    assert.equal(res.link_token, 'link-cra-legacy-retry');

    const legacyUserCreateCall = calls.find((c) => {
      if (!String(c.url).includes('/user/create')) return false;
      const p = JSON.parse(c.init.body);
      return !!p.consumer_report_user_identity;
    });
    assert.ok(legacyUserCreateCall, 'expected legacy consumer_report_user_identity retry');
  });

  test('falls back to identity payload when consumer_report_user_identity is rejected', async () => {
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      const endpoint = String(url).replace(/^https?:\/\/[^/]+/, '');
      const payload = JSON.parse(init.body);
      if (endpoint === '/user/create' && payload.identity && payload.identity.emails && payload.identity.emails[0] && payload.identity.emails[0].email) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error_message: 'the following fields are not recognized by this endpoint: identity',
          }),
        };
      }
      if (endpoint === '/user/create' && payload.consumer_report_user_identity) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error_message: 'consumer_report_user_identity is invalid',
          }),
        };
      }
      if (endpoint === '/user/create' && payload.identity && payload.identity.emails && payload.identity.emails[0] && payload.identity.emails[0].data) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user_id: 'usr_test_identity_retry',
            request_id: 'req-user-create-identity-retry',
          }),
        };
      }
      if (endpoint === '/link/token/create') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            link_token: 'link-cra-identity-retry',
            expiration: '2099-01-01T00:00:00Z',
            request_id: 'req-link-token-identity-retry',
          }),
        };
      }
      throw new Error(`Unexpected endpoint in test: ${endpoint}`);
    };

    const plaid = require(BACKEND_PATH);
    const res = await plaid.createConsumerReportLinkToken({
      userId: 'zip-cra-user-3',
      products: ['cra_base_report', 'cra_income_insights'],
      credentialScope: 'cra',
      consumer_report_permissible_purpose: 'EXTENSION_OF_CREDIT',
    });
    assert.equal(res.link_token, 'link-cra-identity-retry');

    const identityCall = calls.find((c) => {
      if (!String(c.url).includes('/user/create')) return false;
      const p = JSON.parse(c.init.body);
      return !!p.identity;
    });
    assert.ok(identityCall, 'expected identity retry payload');
  });
});
