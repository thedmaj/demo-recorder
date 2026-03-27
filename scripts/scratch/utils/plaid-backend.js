/**
 * plaid-backend.js
 *
 * Plaid REST API client for sandbox mode. Uses native fetch() — no npm
 * dependencies beyond Node 18+.
 *
 * All functions read credentials from process.env:
 *   PLAID_CLIENT_ID, PLAID_SANDBOX_SECRET, PLAID_ENV (default: "sandbox")
 *   CRA_CLIENT_ID, CRA_SECRET (for CRA / credit-family products)
 *
 * Exports:
 *   isLivePlaidLink()
 *   createLinkToken(opts?)
 *   plaidRequest(endpoint, body, opts?)
 *   createUser(body, opts?)
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

function isCraLikeProduct(input) {
  const value = String(input || '').toLowerCase();
  const normalized = value.replace(/[_-]+/g, ' ');
  return /\b(cra|consumer report|base report|income insights|cra income insights|cra base report|credit)\b/.test(normalized);
}

function resolveCredentialScope(opts = {}) {
  const explicit = (opts.credentialScope || opts.scope || '').toLowerCase();
  if (explicit === 'cra' || explicit === 'credit') return 'cra';
  if (explicit === 'default' || explicit === 'plaid') return 'default';

  if (isCraLikeProduct(opts.productFamily) || isCraLikeProduct(opts.endpoint)) {
    return 'cra';
  }
  if (Array.isArray(opts.products) && opts.products.some(isCraLikeProduct)) {
    return 'cra';
  }
  if (opts.body) {
    if (isCraLikeProduct(opts.body.productFamily) || isCraLikeProduct(opts.body.credentialScope)) {
      return 'cra';
    }
    if (Array.isArray(opts.body.products) && opts.body.products.some(isCraLikeProduct)) {
      return 'cra';
    }
  }
  return 'default';
}

function getCredentials(opts = {}) {
  const scope = resolveCredentialScope(opts);
  const clientId = scope === 'cra' ? process.env.CRA_CLIENT_ID : process.env.PLAID_CLIENT_ID;
  const secret   = scope === 'cra' ? process.env.CRA_SECRET : process.env.PLAID_SANDBOX_SECRET;
  if (!clientId || !secret) {
    throw new Error(
      scope === 'cra'
        ? '[plaid-backend] Missing CRA_CLIENT_ID or CRA_SECRET in .env'
        : '[plaid-backend] Missing PLAID_CLIENT_ID or PLAID_SANDBOX_SECRET in .env'
    );
  }
  return { clientId, secret, scope };
}

/**
 * Make a POST request to the Plaid API.
 * @param {string} endpoint  e.g. "/link/token/create"
 * @param {object} body      Request body (client_id and secret are injected automatically)
 * @returns {Promise<object>} Parsed JSON response
 */
async function plaidPost(endpoint, body = {}, opts = {}) {
  const { clientId, secret, scope } = getCredentials({
    endpoint,
    body,
    products: body.products,
    productFamily: opts.productFamily || body.productFamily,
    credentialScope: opts.credentialScope || body.credentialScope,
  });
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
    throw new Error(`[plaid-backend] ${endpoint} failed (${res.status}, scope=${scope}): ${errMsg}`);
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
    ((!!process.env.PLAID_CLIENT_ID && !!process.env.PLAID_SANDBOX_SECRET) ||
      (!!process.env.CRA_CLIENT_ID && !!process.env.CRA_SECRET))
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
/** Keys used only to build /link/token/create; everything else on `opts` is merged into the Plaid body. */
const CREATE_LINK_TOKEN_WRAPPER_KEYS = new Set([
  'clientName',
  'client_name',
  'userId',
  'user_id',
  'phoneNumber',
  'phone_number',
  'linkCustomizationName',
  'link_customization_name',
  'productFamily',
  'product_family',
  'credentialScope',
  'credential_scope',
  'user',
  'products',
]);

async function createLinkToken(opts = {}) {
  const products = opts.products ?? ['auth', 'identity'];
  const clientName = opts.clientName || opts.client_name || 'Plaid Demo';
  const userId = opts.userId || opts.user_id || 'demo-user-001';
  const phoneNumber = opts.phoneNumber ?? opts.phone_number ?? null;
  const linkCustomizationName =
    opts.linkCustomizationName ?? opts.link_customization_name ?? process.env.PLAID_LINK_CUSTOMIZATION ?? null;
  const productFamily = opts.productFamily ?? opts.product_family ?? null;
  const credentialScope = opts.credentialScope ?? opts.credential_scope ?? null;

  let user = { client_user_id: userId };
  if (phoneNumber) user.phone_number = phoneNumber;
  if (opts.user && typeof opts.user === 'object' && !Array.isArray(opts.user)) {
    user = { ...opts.user, ...user };
  }

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

  for (const [key, val] of Object.entries(opts)) {
    if (val === undefined || CREATE_LINK_TOKEN_WRAPPER_KEYS.has(key)) continue;
    body[key] = val;
  }

  const data = await plaidPost('/link/token/create', body, { productFamily, credentialScope });

  console.log(`[plaid-backend] Link token created: ${data.link_token?.substring(0, 30)}...`);
  return data;
}

async function plaidRequest(endpoint, body = {}, opts = {}) {
  return plaidPost(endpoint, body, opts);
}

async function createUser(body = {}, opts = {}) {
  return plaidPost('/user/create', body, opts);
}

/**
 * Exchange a public_token (from Link onSuccess) for an access_token.
 *
 * @param {string} publicToken
 * @returns {Promise<{ access_token: string, item_id: string, request_id: string }>}
 */
async function exchangePublicToken(publicToken, opts = {}) {
  const data = await plaidPost('/item/public_token/exchange', {
    public_token: publicToken,
  }, opts);

  console.log(`[plaid-backend] Token exchanged → access_token: ${data.access_token?.substring(0, 20)}...`);
  return data;
}

/**
 * Get account and routing numbers via Plaid Auth.
 *
 * @param {string} accessToken
 * @returns {Promise<object>} Full /auth/get response (accounts, numbers, item)
 */
async function getAuth(accessToken, opts = {}) {
  const data = await plaidPost('/auth/get', {
    access_token: accessToken,
  }, opts);

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
async function getIdentityMatch(accessToken, legalName = 'Sarah Mitchell', opts = {}) {
  const data = await plaidPost('/identity/match', {
    access_token: accessToken,
    user: {
      legal_name: legalName,
    },
  }, opts);

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
async function evaluateSignal(accessToken, accountId, amount = 2500.00, opts = {}) {
  const data = await plaidPost('/signal/evaluate', {
    access_token:   accessToken,
    account_id:     accountId,
    client_transaction_id: `demo-txn-${Date.now()}`,
    amount:         amount,
  }, opts);

  console.log(`[plaid-backend] /signal/evaluate → overall risk: ${data.scores?.customer_initiated_return_risk?.score ?? 'N/A'}`);
  return data;
}

/**
 * Create a Plaid Layer session token (for onboarding flow).
 * Uses /user/create then /session/token/create with template_id.
 *
 * @param {object} [opts]
 * @param {string} [opts.clientUserId]  Unique user ID (default: 'onboarding-' + timestamp)
 * @param {string} [opts.templateId]    Layer template ID (default: PLAID_LAYER_TEMPLATE_ID env)
 * @returns {Promise<{ link_token: string, user_token: string }>}
 */
async function createSessionToken(opts = {}) {
  const templateId = opts.template_id || opts.templateId || process.env.PLAID_LAYER_TEMPLATE_ID || 'template_n31w56t6o9a7';
  const clientUserId = opts.client_user_id || opts.clientUserId || `onboarding-${Date.now()}`;

  const userResult = await plaidPost('/user/create', {
    client_user_id: clientUserId,
  });
  const userToken = userResult.user_token;
  if (!userToken) throw new Error(`/user/create failed: ${JSON.stringify(userResult)}`);

  const sessionResult = await plaidPost('/session/token/create', {
    template_id: templateId,
    user: {
      client_user_id: clientUserId,
      user_id: userToken,
    },
  });
  const linkToken = sessionResult.link?.link_token || sessionResult.link_token;
  if (!linkToken) throw new Error(`/session/token/create failed: ${JSON.stringify(sessionResult)}`);

  console.log(`[plaid-backend] Layer session token created (template=${templateId})`);
  return { link_token: linkToken, user_token: userToken };
}

/**
 * Get user identity and account data after Plaid Layer onSuccess.
 *
 * @param {string} publicToken  From Layer onSuccess callback
 * @returns {Promise<object>}   identity, items, request_id
 */
async function userAccountSessionGet(publicToken) {
  const data = await plaidPost('/user_account/session/get', {
    public_token: publicToken,
  });
  console.log(`[plaid-backend] /user_account/session/get → identity + ${data.items?.length ?? 0} items`);
  return data;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  resolveCredentialScope,
  getCredentials,
  plaidRequest,
  createUser,
  isLivePlaidLink,
  createLinkToken,
  createSessionToken,
  exchangePublicToken,
  getAuth,
  getIdentityMatch,
  evaluateSignal,
  userAccountSessionGet,
};
