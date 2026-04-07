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
const fs = require('fs');
const path = require('path');

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

function hasCraProducts(products) {
  return Array.isArray(products) && products.some(isCraLikeProduct);
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
  const hasDefault = !!process.env.PLAID_CLIENT_ID && !!process.env.PLAID_SANDBOX_SECRET;
  const hasCra = !!process.env.CRA_CLIENT_ID && !!process.env.CRA_SECRET;

  // CRA is strict by design: CRA-family flows must use CRA credentials only.
  // Do not silently fall back to default credentials because that violates
  // the required CRA token/session flow and can produce misleading runtime errors.
  if (scope === 'cra') {
    if (hasCra) {
      return {
        clientId: process.env.CRA_CLIENT_ID,
        secret: process.env.CRA_SECRET,
        scope: 'cra',
      };
    }
    throw new Error('[plaid-backend] CRA credential scope requested but CRA_CLIENT_ID/CRA_SECRET are missing in .env');
  }

  if (!hasDefault) {
    throw new Error('[plaid-backend] Missing PLAID_CLIENT_ID or PLAID_SANDBOX_SECRET in .env');
  }
  return {
    clientId: process.env.PLAID_CLIENT_ID,
    secret: process.env.PLAID_SANDBOX_SECRET,
    scope: 'default',
  };
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function toTitleCaseWords(value) {
  return String(value || '')
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function companyFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl).trim());
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    const disallowed = /(plaid\.com|cdn\.plaid\.com|docs\.plaid\.com|localhost|127\.0\.0\.1)/i;
    if (disallowed.test(host)) return null;
    const firstLabel = host.split('.')[0] || '';
    if (!firstLabel) return null;
    return toTitleCaseWords(firstLabel);
  } catch (_) {
    return null;
  }
}

function extractCompanyNameFromText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  const companyMatch = raw.match(/^\s*Company(?:\s+name)?\s*:\s*(.+)$/im);
  if (companyMatch && companyMatch[1]) {
    const line = companyMatch[1].trim().split(/\r?\n/)[0].trim();
    if (line) return line;
  }
  const urls = raw.match(/https?:\/\/[^\s)]+/gi) || [];
  for (const u of urls) {
    const inferred = companyFromUrl(u);
    if (inferred) return inferred;
  }
  return null;
}

function resolvePromptDerivedClientName() {
  const projectRoot = path.resolve(__dirname, '../../..');
  const runDir = process.env.PIPELINE_RUN_DIR || null;
  const candidates = [
    runDir ? path.join(runDir, 'ingested-inputs.json') : null,
    runDir ? path.join(runDir, 'pipeline-run-context.json') : null,
    path.join(projectRoot, 'inputs', 'prompt.txt'),
  ].filter(Boolean);

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (file.endsWith('ingested-inputs.json')) {
        const parsed = JSON.parse(raw);
        const promptText = (parsed.texts || [])
          .filter((t) => /prompt\.txt$/i.test(String(t.filename || '')))
          .map((t) => t.content || '')
          .join('\n');
        const name = extractCompanyNameFromText(promptText);
        if (name) return name;
      } else if (file.endsWith('pipeline-run-context.json')) {
        const parsed = JSON.parse(raw);
        const name = firstNonEmpty(
          parsed?.brand?.company,
          parsed?.persona?.company,
          parsed?.company,
          parsed?.run?.company
        );
        if (name) return name;
      } else {
        const name = extractCompanyNameFromText(raw);
        if (name) return name;
      }
    } catch (_) {}
  }
  return null;
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
 *                                               scope-specific env vars.
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
  'plaidCheckUserId',
  'plaid_check_user_id',
  'userToken',
  'user_token',
  'legacyUserToken',
  'legacy_user_token',
  'checkUserIdentity',
  'check_user_identity',
]);

async function createLinkToken(opts = {}) {
  const products = opts.products ?? ['auth', 'identity'];
  const promptClientName = resolvePromptDerivedClientName();
  const clientName = promptClientName || opts.clientName || opts.client_name || 'Plaid Demo';
  const userId = opts.userId || opts.user_id || 'demo-user-001';
  const phoneNumber = opts.phoneNumber ?? opts.phone_number ?? null;
  const linkCustomizationName = resolveLinkCustomizationName(opts);
  const productFamily = opts.productFamily ?? opts.product_family ?? null;
  const credentialScope = opts.credentialScope ?? opts.credential_scope ?? null;
  const plaidCheckUserId = opts.plaidCheckUserId ?? opts.plaid_check_user_id ?? null;
  const legacyUserToken = opts.userToken ?? opts.user_token ?? null;

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
  console.log(`[plaid-backend] Using client_name: "${clientName}"`);

  if (plaidCheckUserId) {
    body.user_id = plaidCheckUserId;
  } else if (legacyUserToken) {
    body.user_token = legacyUserToken;
  }

  if (linkCustomizationName) {
    body.link_customization_name = linkCustomizationName;
    console.log(`[plaid-backend] Using Link customization: "${linkCustomizationName}"`);
  }

  for (const [key, val] of Object.entries(opts)) {
    if (val === undefined || CREATE_LINK_TOKEN_WRAPPER_KEYS.has(key)) continue;
    body[key] = val;
  }

  let data;
  try {
    data = await plaidPost('/link/token/create', body, { productFamily, credentialScope });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (body.link_customization_name && /link_customization_name was not found/i.test(msg)) {
      const fallbackBody = { ...body };
      delete fallbackBody.link_customization_name;
      console.warn(`[plaid-backend] Link customization "${body.link_customization_name}" unavailable for this credential scope; retrying without customization.`);
      data = await plaidPost('/link/token/create', fallbackBody, { productFamily, credentialScope });
    } else {
      throw err;
    }
  }

  console.log(`[plaid-backend] Link token created: ${data.link_token?.substring(0, 30)}...`);
  return data;
}

/**
 * Resolve Link customization name by scope:
 * - explicit opts.linkCustomizationName wins
 * - CRA scope: PLAID_LINK_CRA_CUSTOMIZAATION (requested var; typo preserved for compatibility)
 *   with fallback PLAID_LINK_CRA_CUSTOMIZATION (correct spelling)
 * - non-CRA scope: PLAID_LINK_CUSTOMIZATION
 */
function resolveLinkCustomizationName(opts = {}) {
  const explicit = firstNonEmpty(opts.linkCustomizationName, opts.link_customization_name);
  if (explicit) return explicit;

  const scope = resolveCredentialScope({
    products: opts.products,
    productFamily: opts.productFamily ?? opts.product_family,
    credentialScope: opts.credentialScope ?? opts.credential_scope,
    endpoint: '/link/token/create',
  });
  if (scope === 'cra') {
    return firstNonEmpty(
      process.env.PLAID_LINK_CRA_CUSTOMIZAATION,
      process.env.PLAID_LINK_CRA_CUSTOMIZATION
    );
  }
  return firstNonEmpty(process.env.PLAID_LINK_CUSTOMIZATION);
}

/** Sandbox user profile for Plaid Check /user/create (Plaid Users API). */
function sandboxConsumerReportIdentity(clientUserId) {
  const safe = String(clientUserId).replace(/[^a-z0-9-]/gi, '');
  return {
    name: {
      given_name: 'Carmen',
      family_name: 'Testuser',
    },
    date_of_birth: '1987-01-31',
    emails: [{ data: `cra-link-${safe || 'user'}@example.com`, primary: true }],
    phone_numbers: [{ data: '+14155550011', primary: true }],
    addresses: [
      {
        street_1: '3200 W Armitage Ave',
        city: 'Chicago',
        region: 'IL',
        country: 'US',
        postal_code: '60657',
        primary: true,
      },
    ],
    id_numbers: [{ value: '1234', type: 'us_ssn_last_4' }],
  };
}

function normalizeCraUserProfile(input, clientUserId) {
  const fallback = sandboxConsumerReportIdentity(clientUserId);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fallback;

  const fallbackName = fallback.name || {};
  const name = input.name && typeof input.name === 'object' ? input.name : {};
  const givenName = input.given_name || name.given_name || fallbackName.given_name;
  const familyName = input.family_name || name.family_name || fallbackName.family_name;
  const dateOfBirth = input.date_of_birth || fallback.date_of_birth;

  const emailsRaw = Array.isArray(input.emails) ? input.emails : fallback.emails;
  const emails = emailsRaw
    .map((e) => {
      if (!e || typeof e !== 'object') return null;
      const data = e.data || e.email || e.address || null;
      if (!data) return null;
      return {
        data,
        primary: e.primary !== false,
      };
    })
    .filter(Boolean);

  const phonesRaw = Array.isArray(input.phone_numbers) ? input.phone_numbers : fallback.phone_numbers;
  const phoneNumbers = phonesRaw
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const data = p.data || p.number || null;
      if (!data) return null;
      return {
        data,
        primary: p.primary !== false,
      };
    })
    .filter(Boolean);

  const addressesRaw = Array.isArray(input.addresses) ? input.addresses : fallback.addresses;
  const addresses = addressesRaw
    .map((a) => {
      if (!a || typeof a !== 'object') return null;
      const street1 = a.street_1 || a.street || null;
      if (!street1) return null;
      return {
        street_1: street1,
        ...(a.street_2 ? { street_2: a.street_2 } : {}),
        city: a.city || '',
        region: a.region || '',
        postal_code: a.postal_code || '',
        country: a.country || 'US',
        primary: a.primary !== false,
      };
    })
    .filter(Boolean);

  const idNumbers = Array.isArray(input.id_numbers) && input.id_numbers.length
    ? input.id_numbers
    : fallback.id_numbers;

  return {
    name: {
      given_name: givenName,
      family_name: familyName,
    },
    date_of_birth: dateOfBirth,
    emails: emails.length ? emails : fallback.emails,
    phone_numbers: phoneNumbers.length ? phoneNumbers : fallback.phone_numbers,
    addresses: addresses.length ? addresses : fallback.addresses,
    id_numbers: idNumbers,
  };
}

function toLegacyConsumerReportIdentity(profile) {
  const pName = profile && profile.name && typeof profile.name === 'object' ? profile.name : {};
  const emails = Array.isArray(profile.emails)
    ? profile.emails
      .map((e) => {
        if (!e || typeof e !== 'object') return null;
        return e.address || e.email || e.data || null;
      })
      .filter(Boolean)
    : [];

  const phoneNumbers = Array.isArray(profile.phone_numbers)
    ? profile.phone_numbers
      .map((p) => {
        if (!p || typeof p !== 'object' || (!p.data && !p.number)) return null;
        return {
          data: p.data || p.number,
          primary: p.primary !== false,
        };
      })
      .filter(Boolean)
    : [];

  return {
    ...(pName.given_name ? { given_name: pName.given_name } : {}),
    ...(pName.family_name ? { family_name: pName.family_name } : {}),
    date_of_birth: profile.date_of_birth,
    ...(emails.length ? { emails } : {}),
    ...(phoneNumbers.length ? { phone_numbers: phoneNumbers } : {}),
  };
}

function toLegacyIdentity(profile) {
  const pName = profile && profile.name && typeof profile.name === 'object' ? profile.name : {};
  const emails = Array.isArray(profile.emails)
    ? profile.emails
      .map((e) => {
        if (!e || typeof e !== 'object') return null;
        const data = e.address || e.email || e.data || null;
        if (!data) return null;
        return {
          data,
          primary: e.primary !== false,
        };
      })
      .filter(Boolean)
    : [];

  const phoneNumbers = Array.isArray(profile.phone_numbers)
    ? profile.phone_numbers
      .map((p) => {
        if (!p || typeof p !== 'object' || (!p.data && !p.number)) return null;
        return {
          data: p.data || p.number,
          primary: p.primary !== false,
        };
      })
      .filter(Boolean)
    : [];

  return {
    ...(pName.given_name || pName.family_name
      ? { name: { given_name: pName.given_name, family_name: pName.family_name } }
      : {}),
    date_of_birth: profile.date_of_birth,
    ...(emails.length ? { emails } : {}),
    ...(phoneNumbers.length ? { phone_numbers: phoneNumbers } : {}),
  };
}

/**
 * Plaid Check: /user/create (with identity) then /link/token/create with root user_id.
 */
async function createConsumerReportLinkToken(flat = {}) {
  const clientUserId = flat.userId || flat.user_id || `cra-link-${Date.now()}`;
  const scopeOpts = {
    productFamily:   flat.productFamily || flat.product_family || 'cra_base_report',
    credentialScope: flat.credentialScope || flat.credential_scope || 'cra',
  };
  const identityInput =
    flat.checkUserIdentity ||
    flat.check_user_identity ||
    flat.consumer_report_user_identity ||
    sandboxConsumerReportIdentity(clientUserId);
  const userProfile = normalizeCraUserProfile(identityInput, clientUserId);
  let plaidUserId = flat.plaidCheckUserId ?? flat.plaid_check_user_id ?? null;
  let legacyToken = flat.legacyUserToken ?? flat.legacy_user_token ?? flat.userToken ?? flat.user_token ?? null;

  // If neither user_id nor legacy token is supplied, bootstrap a user now.
  if (!plaidUserId && !legacyToken) {
    let userResult;
    try {
      userResult = await plaidPost('/user/create', {
        client_user_id: clientUserId,
        identity: userProfile,
      }, scopeOpts);
    } catch (firstErr) {
      const firstMsg = String(firstErr && firstErr.message ? firstErr.message : firstErr);
      if (/identity|fields are not recognized by this endpoint:\s*identity/i.test(firstMsg)) {
        try {
          userResult = await plaidPost('/user/create', {
            client_user_id: clientUserId,
            consumer_report_user_identity: toLegacyConsumerReportIdentity(userProfile),
          }, scopeOpts);
        } catch (secondErr) {
          const secondMsg = String(secondErr && secondErr.message ? secondErr.message : secondErr);
          if (/consumer_report_user_identity/i.test(secondMsg)) {
            userResult = await plaidPost('/user/create', {
              client_user_id: clientUserId,
              identity: toLegacyIdentity(userProfile),
            }, scopeOpts);
          } else {
            throw secondErr;
          }
        }
      } else {
        throw firstErr;
      }
    }
    plaidUserId = userResult.user_id || null;
    legacyToken = userResult.user_token || null;
    if (!plaidUserId && !legacyToken) {
      throw new Error(`[plaid-backend] /user/create failed: ${JSON.stringify(userResult)}`);
    }
    console.log(`[plaid-backend] Plaid Check user created (user_id=${plaidUserId || 'n/a'})`);
  } else {
    console.log(`[plaid-backend] Using provided CRA user identity (user_id=${plaidUserId || 'n/a'}, legacy_token=${legacyToken ? 'present' : 'absent'})`);
  }

  const craLayerTemplate =
    flat.craLayerTemplate ??
    flat.cra_layer_template ??
    process.env.CRA_LAYER_TEMPLATE ??
    null;
  const requestedProducts = Array.isArray(flat.products) ? flat.products : [];

  // When configured, prefer the CRA Layer session template for CRA/Check flows.
  if (craLayerTemplate && hasCraProducts(requestedProducts)) {
    // CRA + Layer compatibility: pass legacy user_token in user.user_id when available.
    if (legacyToken) {
      const sessionResult = await plaidPost('/session/token/create', {
        template_id: craLayerTemplate,
        user: {
          client_user_id: clientUserId,
          user_id: legacyToken,
        },
      }, scopeOpts);
      const linkToken = sessionResult.link?.link_token || sessionResult.link_token;
      if (!linkToken) {
        throw new Error(`[plaid-backend] /session/token/create failed: ${JSON.stringify(sessionResult)}`);
      }
      console.log(`[plaid-backend] CRA Layer session token created (template=${craLayerTemplate})`);
      return {
        link_token: linkToken,
        expiration: sessionResult.link?.expiration || sessionResult.expiration,
        request_id: sessionResult.request_id,
        user_id: plaidUserId || undefined,
      };
    }
    console.warn('[plaid-backend] CRA_LAYER_TEMPLATE set but /user/create returned no legacy user_token; falling back to /link/token/create with user_id.');
  }

  return createLinkToken({
    products: flat.products,
    clientName: flat.clientName || flat.client_name,
    userId: clientUserId,
    phoneNumber: flat.phoneNumber ?? flat.phone_number ?? null,
    linkCustomizationName: flat.linkCustomizationName ?? flat.link_customization_name ?? null,
    productFamily: flat.productFamily ?? flat.product_family ?? null,
    credentialScope: flat.credentialScope ?? flat.credential_scope ?? null,
    consumer_report_permissible_purpose: flat.consumer_report_permissible_purpose,
    cra_options: flat.cra_options,
    plaidCheckUserId: plaidUserId || undefined,
    userToken: plaidUserId ? undefined : legacyToken || undefined,
  });
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
  resolveLinkCustomizationName,
  plaidRequest,
  createUser,
  isLivePlaidLink,
  createLinkToken,
  createConsumerReportLinkToken,
  createSessionToken,
  exchangePublicToken,
  getAuth,
  getIdentityMatch,
  evaluateSignal,
  userAccountSessionGet,
};
