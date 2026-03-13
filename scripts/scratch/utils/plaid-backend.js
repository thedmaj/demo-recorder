/**
 * plaid-backend.js
 *
 * Plaid REST API client for sandbox mode. Uses native fetch() — no npm
 * dependencies beyond Node 18+.
 *
 * All functions read credentials from process.env:
 *   PLAID_CLIENT_ID, PLAID_SANDBOX_SECRET, PLAID_ENV (default: "sandbox")
 *
 * Exports:
 *   isLivePlaidLink()
 *   createLinkToken(opts?)
 *   exchangePublicToken(publicToken)
 *   getAuth(accessToken)
 *   getIdentityMatch(accessToken, legalName?)
 *   evaluateSignal(accessToken, accountId, amount)
 */

'use strict';

// ── Base URL ──────────────────────────────────────────────────────────────────

function getBaseUrl() {
  const env = (process.env.PLAID_ENV || 'sandbox').toLowerCase();
  const hosts = {
    sandbox:     'https://sandbox.plaid.com',
    development: 'https://development.plaid.com',
    production:  'https://production.plaid.com',
  };
  return hosts[env] || hosts.sandbox;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function getCredentials() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret   = process.env.PLAID_SANDBOX_SECRET;
  if (!clientId || !secret) {
    throw new Error(
      '[plaid-backend] Missing PLAID_CLIENT_ID or PLAID_SANDBOX_SECRET in .env'
    );
  }
  return { clientId, secret };
}

/**
 * Make a POST request to the Plaid API.
 * @param {string} endpoint  e.g. "/link/token/create"
 * @param {object} body      Request body (client_id and secret are injected automatically)
 * @returns {Promise<object>} Parsed JSON response
 */
async function plaidPost(endpoint, body = {}) {
  const { clientId, secret } = getCredentials();
  const url = `${getBaseUrl()}${endpoint}`;

  const payload = {
    client_id: clientId,
    secret,
    ...body,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!res.ok) {
    const errMsg = data.error_message || data.display_message || JSON.stringify(data);
    throw new Error(`[plaid-backend] ${endpoint} failed (${res.status}): ${errMsg}`);
  }

  return data;
}

// ── Feature flag ──────────────────────────────────────────────────────────────

/**
 * Returns true if live Plaid Link mode is enabled AND the required
 * credentials are present.
 */
function isLivePlaidLink() {
  return (
    process.env.PLAID_LINK_LIVE === 'true' &&
    !!process.env.PLAID_CLIENT_ID &&
    !!process.env.PLAID_SANDBOX_SECRET
  );
}

// ── API wrappers ──────────────────────────────────────────────────────────────

/**
 * Create a Plaid Link token for initializing the Link SDK.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.products]             Plaid products (default: ['auth', 'identity'])
 * @param {string}   [opts.clientName]           App display name (default: 'Plaid Demo')
 * @param {string}   [opts.userId]               Unique user ID (default: 'demo-user-001')
 * @param {string}   [opts.linkCustomizationName] Named Link customization from Plaid Dashboard
 *                                               (e.g. 'ascend'). Falls back to
 *                                               PLAID_LINK_CUSTOMIZATION env var.
 * @returns {Promise<{ link_token: string, expiration: string, request_id: string }>}
 */
async function createLinkToken(opts = {}) {
  const {
    products             = ['auth', 'identity'],
    clientName           = 'Plaid Demo',
    userId               = 'demo-user-001',
    phoneNumber          = null,
    linkCustomizationName = process.env.PLAID_LINK_CUSTOMIZATION || null,
  } = opts;

  const user = { client_user_id: userId };
  // Passing phone_number helps Plaid identify returning Remember Me users on the backend.
  // NOTE: this does NOT pre-populate or skip the phone entry screen in the UI —
  // the user still must type the number and click Continue.
  if (phoneNumber) user.phone_number = phoneNumber;

  const body = {
    client_name:   clientName,
    language:      'en',
    country_codes: ['US'],
    user,
    products,
  };

  if (linkCustomizationName) {
    body.link_customization_name = linkCustomizationName;
    console.log(`[plaid-backend] Using Link customization: "${linkCustomizationName}"`);
  }

  const data = await plaidPost('/link/token/create', body);

  console.log(`[plaid-backend] Link token created: ${data.link_token?.substring(0, 30)}...`);
  return data;
}

/**
 * Exchange a public_token (from Link onSuccess) for an access_token.
 *
 * @param {string} publicToken
 * @returns {Promise<{ access_token: string, item_id: string, request_id: string }>}
 */
async function exchangePublicToken(publicToken) {
  const data = await plaidPost('/item/public_token/exchange', {
    public_token: publicToken,
  });

  console.log(`[plaid-backend] Token exchanged → access_token: ${data.access_token?.substring(0, 20)}...`);
  return data;
}

/**
 * Get account and routing numbers via Plaid Auth.
 *
 * @param {string} accessToken
 * @returns {Promise<object>} Full /auth/get response (accounts, numbers, item)
 */
async function getAuth(accessToken) {
  const data = await plaidPost('/auth/get', {
    access_token: accessToken,
  });

  console.log(`[plaid-backend] /auth/get → ${data.accounts?.length || 0} accounts`);
  return data;
}

/**
 * Run identity match verification.
 *
 * @param {string} accessToken
 * @param {string} [legalName]  Legal name to match (default: 'Sarah Mitchell')
 * @returns {Promise<object>} Full /identity/match response
 */
async function getIdentityMatch(accessToken, legalName = 'Sarah Mitchell') {
  const data = await plaidPost('/identity/match', {
    access_token: accessToken,
    user: {
      legal_name: legalName,
    },
  });

  console.log(`[plaid-backend] /identity/match → ${data.accounts?.length || 0} accounts scored`);
  return data;
}

/**
 * Evaluate ACH transfer risk with Plaid Signal.
 *
 * @param {string} accessToken
 * @param {string} accountId
 * @param {number} [amount]     Transfer amount in USD (default: 2500)
 * @returns {Promise<object>} Full /signal/evaluate response
 */
async function evaluateSignal(accessToken, accountId, amount = 2500.00) {
  const data = await plaidPost('/signal/evaluate', {
    access_token:   accessToken,
    account_id:     accountId,
    client_transaction_id: `demo-txn-${Date.now()}`,
    amount:         amount,
  });

  console.log(`[plaid-backend] /signal/evaluate → overall risk: ${data.scores?.customer_initiated_return_risk?.score ?? 'N/A'}`);
  return data;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  isLivePlaidLink,
  createLinkToken,
  exchangePublicToken,
  getAuth,
  getIdentityMatch,
  evaluateSignal,
};
