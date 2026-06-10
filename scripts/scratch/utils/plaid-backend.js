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
const { resolveMode, getLinkModeAdapter } = require('./link-mode');

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

const COMPANY_NAME_OVERRIDES = {
  usbank: 'US Bank',
  tmobile: 'T-Mobile',
  att: 'AT&T',
  ynab: 'YNAB',
};

function normalizeDomainCompanyName(rawLabel) {
  const label = String(rawLabel || '').trim().toLowerCase();
  if (!label) return null;
  if (COMPANY_NAME_OVERRIDES[label]) return COMPANY_NAME_OVERRIDES[label];

  // Heuristic for compact labels like "usbank" -> "US Bank"
  const compactBankMatch = label.match(/^([a-z]{2,3})(bank)$/i);
  if (compactBankMatch) {
    const [, prefix, suffix] = compactBankMatch;
    return `${prefix.toUpperCase()} ${toTitleCaseWords(suffix)}`;
  }

  return toTitleCaseWords(label);
}

function companyFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl).trim());
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    const disallowed = /(plaid\.com|cdn\.plaid\.com|docs\.plaid\.com|localhost|127\.0\.0\.1)/i;
    if (disallowed.test(host)) return null;
    const firstLabel = host.split('.')[0] || '';
    if (!firstLabel) return null;
    return normalizeDomainCompanyName(firstLabel);
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

function resolvePromptDerivedClientName(opts = {}) {
  const projectRoot = path.resolve(__dirname, '../../..');
  const runDir = firstNonEmpty(opts.runDir, process.env.PIPELINE_RUN_DIR) || null;
  const candidates = [
    runDir ? path.join(runDir, 'pipeline-run-context.json') : null,
    runDir ? path.join(runDir, 'ingested-inputs.json') : null,
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
  'runDir',
  'run_dir',
  'linkMode',
  'link_mode',
  'enableMultiItemLink',
  'enable_multi_item_link',
]);

function resolveLinkMode(opts = {}) {
  return resolveMode({ explicitMode: opts.linkMode || opts.link_mode, promptText: '' });
}

// Products that require a Plaid user_token (from /user/create) before
// /link/token/create. CRA / Plaid Check products have their own dedicated
// `createCraLinkToken` path; the products listed here are NON-CRA flows that
// still require user_token plumbing — most notably the modern Bank Income and
// Payroll Income paths (Income product family, FCRA-compliant flow).
//
// When createLinkToken sees one of these products in opts.products WITHOUT an
// existing user_token / user_id, it bootstraps a Plaid user inline and passes
// the resulting user_token through.
const PRODUCTS_REQUIRING_USER_TOKEN = new Set([
  'bank_income',
  'payroll_income',
  'document_income',
  'income_verification',
]);

function productListRequiresUserToken(products) {
  if (!Array.isArray(products)) return false;
  for (const p of products) {
    if (PRODUCTS_REQUIRING_USER_TOKEN.has(String(p).toLowerCase())) return true;
  }
  return false;
}

async function createLinkToken(opts = {}) {
  const products = opts.products ?? ['auth', 'identity'];
  const promptClientName = resolvePromptDerivedClientName(opts);
  const clientName = promptClientName || opts.clientName || opts.client_name || 'Plaid Demo';
  const userId = opts.userId || opts.user_id || 'demo-user-001';
  const phoneNumber = opts.phoneNumber ?? opts.phone_number ?? null;
  const linkCustomizationName = resolveLinkCustomizationName(opts);
  const productFamily = opts.productFamily ?? opts.product_family ?? null;
  const credentialScope = opts.credentialScope ?? opts.credential_scope ?? null;
  const linkMode = resolveLinkMode(opts);
  const linkModeAdapter = getLinkModeAdapter(linkMode);
  let plaidCheckUserId = opts.plaidCheckUserId ?? opts.plaid_check_user_id ?? null;
  let legacyUserToken = opts.userToken ?? opts.user_token ?? null;

  // Auto-bootstrap a Plaid user when the requested products require user_token
  // (Bank Income / Payroll Income / Document Income / Income Verification) and
  // the caller did not supply one. Without this, /link/token/create returns
  // HTTP 400: "user_token is required for income_verification product." and
  // plaid-link-qa fails. CRA products run through `createCraLinkToken` instead,
  // which has its own (richer) user-create flow with consumer report identity.
  if (
    !plaidCheckUserId &&
    !legacyUserToken &&
    productListRequiresUserToken(products)
  ) {
    // Use a unique client_user_id per bootstrap so repeated link-token calls
    // (e.g., page reloads in the demo, or multiple build-qa probes in the
    // same Plaid sandbox) do not collide with Plaid's "a user already exists
    // for this client_user_id" rejection. The user-id in our internal
    // logging stays as the supplied value; only the Plaid /user/create
    // bootstrap call gets the suffix.
    const bootstrapClientUserId = `${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(
      `[plaid-backend] Attempting /user/create bootstrap (client_user_id=${bootstrapClientUserId}) ` +
      `for income-family products: ${products.filter((p) => PRODUCTS_REQUIRING_USER_TOKEN.has(String(p).toLowerCase())).join(', ')}`
    );
    try {
      const result = await plaidPost('/user/create', {
        client_user_id: bootstrapClientUserId,
      });
      plaidCheckUserId = result?.user_id || null;
      legacyUserToken = result?.user_token || null;
      console.log(
        `[plaid-backend] Bootstrapped Plaid user for income-family products ` +
        `(user_id=${plaidCheckUserId || 'n/a'}, user_token=${legacyUserToken ? 'present (' + String(legacyUserToken).slice(0, 24) + '…)' : 'absent'}, bootstrap_client_user_id=${bootstrapClientUserId}).`
      );
    } catch (e) {
      console.warn(
        `[plaid-backend] /user/create bootstrap for income-family products failed ` +
        `(attempted client_user_id=${bootstrapClientUserId}): ${e && e.message || e}. ` +
        `Falling back to legacy /link/token/create — Plaid will likely return a "user_token required" error.`
      );
    }
  }

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

  // user_id vs user_token: which field /link/token/create accepts depends on
  // which product path the token will exercise:
  //   - CRA products (cra_base_report, cra_income_insights) → new `user_id`
  //     (format `usr_xxx`), created via /user/create with a Plaid Check user.
  //   - Non-CRA Income products (bank_income, payroll_income, document_income,
  //     income_verification) → LEGACY `user_token` field. These products
  //     pre-date the new Plaid Users API and Plaid rejects the new user_id
  //     here with "user_id is not of the expected format".
  // /user/create returns BOTH fields when called without a consumer-report
  // identity payload, so we have to pick the right one based on the products
  // mix. When in doubt (e.g., a legitimate CRA+Bank-Income combo if/when
  // Plaid allows that), prefer user_token for the non-CRA income path because
  // CRA paths can typically accept either, while income_verification cannot
  // accept user_id.
  const needsLegacyUserTokenField = productListRequiresUserToken(products);
  if (needsLegacyUserTokenField && legacyUserToken) {
    body.user_token = legacyUserToken;
  } else if (plaidCheckUserId) {
    body.user_id = plaidCheckUserId;
  } else if (legacyUserToken) {
    body.user_token = legacyUserToken;
  }

  if (linkCustomizationName) {
    body.link_customization_name = linkCustomizationName;
    console.log(`[plaid-backend] Using Link customization: "${linkCustomizationName}"`);
  }

  if (hasCraProducts(products)) {
    if (!opts.consumer_report_permissible_purpose) {
      body.consumer_report_permissible_purpose = 'EXTENSION_OF_CREDIT';
    } else {
      body.consumer_report_permissible_purpose = opts.consumer_report_permissible_purpose;
    }
    if (opts.cra_options) body.cra_options = opts.cra_options;
    else if (!body.cra_options) body.cra_options = { days_requested: 180 };
  }

  // Multi-item link: one session can add Items at multiple institutions; Plaid
  // (and Plaid Check for CRA) combines them. Mapped explicitly to the snake_case
  // API field (the camelCase wrapper key is excluded from the generic copy).
  // NOTE: onSuccess fires EMPTY in multi-item — tokens arrive via SESSION_FINISHED
  // / ITEM_ADD_RESULT webhooks; not compatible with Embedded Institution Search,
  // Same-Day/Instant Micro-deposits, or Database Auth.
  if (opts.enableMultiItemLink ?? opts.enable_multi_item_link) {
    body.enable_multi_item_link = true;
    // Several products are NOT supported in the multi-item link flow — Plaid
    // 400s the whole token (e.g. "products not yet supported in the multi item
    // link flow: [signal]"). Strip them so multi-item never produces an invalid
    // token; multi-item is the structural choice here, so it wins over a
    // ride-along like signal.
    const MULTI_ITEM_UNSUPPORTED = new Set(['signal']);
    if (Array.isArray(body.products)) {
      const dropped = body.products.filter((p) => MULTI_ITEM_UNSUPPORTED.has(String(p)));
      if (dropped.length) {
        body.products = body.products.filter((p) => !MULTI_ITEM_UNSUPPORTED.has(String(p)));
        console.warn(`[plaid-backend] stripped [${dropped.join(', ')}] — not supported in multi-item link flow`);
      }
    }
    console.log('[plaid-backend] enable_multi_item_link=true (multi-institution session)');
  }

  const modeBody = linkModeAdapter.prepareCreateLinkTokenBody(body);
  const bodyForCreate = { ...modeBody };
  if (linkMode === 'embedded') console.log('[plaid-backend] Link mode: embedded (in-page widget)');
  else console.log('[plaid-backend] Link mode: modal');

  for (const [key, val] of Object.entries(opts)) {
    if (val === undefined || CREATE_LINK_TOKEN_WRAPPER_KEYS.has(key)) continue;
    bodyForCreate[key] = val;
  }

  // Defensive strip: helper fields are valid for our server wrapper, not Plaid APIs.
  delete bodyForCreate.linkMode;
  delete bodyForCreate.link_mode;

  // ── Token sanitization (build-agent link-token resolver guards) ──
  // The generated app's resolver occasionally emits product/field combinations
  // that Plaid 400s. Repair them at the single backend chokepoint so a stray
  // resolver choice doesn't fail plaid-link-qa for an otherwise-correct demo.
  if (Array.isArray(bodyForCreate.products)) {
    // 1) Identity Verification is mutually exclusive — Plaid: "identity_verification
    //    should be the only configured product". IDV is represented as its own
    //    session / host beat, so drop it from any multi-product token.
    if (bodyForCreate.products.includes('identity_verification') && bodyForCreate.products.length > 1) {
      const before = bodyForCreate.products.join(', ');
      bodyForCreate.products = bodyForCreate.products.filter((p) => p !== 'identity_verification');
      console.warn(`[plaid-backend] stripped [identity_verification] from multi-product token [${before}] — IDV must be the only configured product`);
    }
  }
  // 2) consumer_report_permissible_purpose / cra_options are only valid when a CRA
  //    product is in the array (Plaid: "consumer_report_permissible_purpose should
  //    only be set if a CRA Product is passed…"). If they leaked in via passthrough
  //    without a CRA product, drop them so the token is valid.
  if (
    (bodyForCreate.consumer_report_permissible_purpose || bodyForCreate.cra_options) &&
    !hasCraProducts(bodyForCreate.products)
  ) {
    delete bodyForCreate.consumer_report_permissible_purpose;
    delete bodyForCreate.cra_options;
    console.warn('[plaid-backend] dropped consumer_report_permissible_purpose / cra_options — no CRA product in token');
  }

  let data;
  try {
    data = await plaidPost('/link/token/create', bodyForCreate, { productFamily, credentialScope });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const unrecognizedModeField =
      /not recognized by this endpoint/i.test(msg) && /linkmode|link_mode/i.test(msg);
    if (unrecognizedModeField) {
      const retryBody = { ...bodyForCreate };
      delete retryBody.linkMode;
      delete retryBody.link_mode;
      console.warn('[plaid-backend] Retrying /link/token/create after removing unsupported mode fields.');
      data = await plaidPost('/link/token/create', retryBody, { productFamily, credentialScope });
      data.plaid_link_mode = linkMode;
      console.log(`[plaid-backend] Link token created: ${data.link_token?.substring(0, 30)}...`);
      return data;
    }
    if (bodyForCreate.link_customization_name && /link_customization_name was not found/i.test(msg)) {
      const fallbackBody = { ...bodyForCreate };
      delete fallbackBody.link_customization_name;
      console.warn(`[plaid-backend] Link customization "${bodyForCreate.link_customization_name}" unavailable for this credential scope; retrying without customization.`);
      data = await plaidPost('/link/token/create', fallbackBody, { productFamily, credentialScope });
    } else {
      throw err;
    }
  }

  console.log(`[plaid-backend] Link token created: ${data.link_token?.substring(0, 30)}...`);
  data.plaid_link_mode = linkMode;
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
    process.env.CRA_LAYER_TEMPLATE ??           // canonical CRA Layer template
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
    linkMode: flat.linkMode ?? flat.link_mode ?? null,
    consumer_report_permissible_purpose:
      flat.consumer_report_permissible_purpose ||
      (hasCraProducts(requestedProducts) ? 'EXTENSION_OF_CREDIT' : undefined),
    cra_options: flat.cra_options || (hasCraProducts(requestedProducts) ? { days_requested: 180 } : undefined),
    // Multi-item link (one session → multiple institutions → a single Plaid
    // Check Consumer Report) is OPT-IN: standard (single-item) link is the
    // default. Enable it only when the prompt explicitly asks for a multi-
    // institution session (the resolver sets enable_multi_item_link on the
    // request) or via CRA_MULTI_ITEM_LINK=true. Multi-item is NOT compatible
    // with `signal` (and a few other products/flows) — see createLinkToken's
    // strip + inputs/plaid-link-sandbox.md §9. (Multi-item onSuccess fires
    // empty — tokens arrive via SESSION_FINISHED / ITEM_ADD_RESULT.)
    enableMultiItemLink:
      flat.enableMultiItemLink ?? flat.enable_multi_item_link ??
      (String(process.env.CRA_MULTI_ITEM_LINK || 'false').trim().toLowerCase() === 'true'),
    plaidCheckUserId: plaidUserId || undefined,
    userToken: plaidUserId ? undefined : legacyToken || undefined,
    runDir: flat.runDir || undefined,
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
// ── Layer user-token cache ──────────────────────────────────────────────────
// Plaid `/user/create` is one-time per client_user_id — calling it again returns
// `400: a user already exists for this client user id`. Layer demos reuse a stable
// client_user_id, so a 2nd run would fail. We persist the user_token from the first
// create and reuse it on later runs (user created ONCE; a NEW /session/token/create
// runs each time). See plaid-layer.md "Layer re-initialization across runs".
const LAYER_USER_CACHE_PATH = path.resolve(__dirname, '../../../out/.layer-user-cache.json');

function readLayerUserCache() {
  try { return JSON.parse(fs.readFileSync(LAYER_USER_CACHE_PATH, 'utf8')); } catch (_) { return {}; }
}
function writeLayerUserCache(cache) {
  try {
    fs.mkdirSync(path.dirname(LAYER_USER_CACHE_PATH), { recursive: true });
    fs.writeFileSync(LAYER_USER_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch (_) { /* cache is best-effort */ }
}

/**
 * Resolve a Plaid user_token for `clientUserId`, creating the user only once.
 * - Cache hit            → reuse the stored user_token (no /user/create).
 * - Cache miss           → /user/create, then cache the user_token.
 * - "already exists" 400 → user exists but its token isn't cached; Plaid has no API
 *   to recover it, so mint a fresh unique client_user_id and create a new user for
 *   this session (keeps repeat demo runs from failing).
 *
 * @returns {Promise<{userToken:string, clientUserId:string, reused:boolean}>}
 */
async function getOrCreateLayerUserToken(clientUserId, opts = {}) {
  // CRA demos create the Plaid user under CRA credentials (the CRA Layer template
  // lives on the CRA account). Scope the cache key so a default-account user is
  // never reused for a CRA session (different Plaid account) or vice-versa.
  const credentialScope = opts.credentialScope || null;
  const scopeOpts = credentialScope ? { credentialScope } : {};
  const keyFor = (id) => (credentialScope ? `${credentialScope}:${id}` : id);
  const cache = readLayerUserCache();
  const cacheKey = keyFor(clientUserId);
  if (cache[cacheKey] && cache[cacheKey].user_token) {
    return { userToken: cache[cacheKey].user_token, clientUserId, reused: true };
  }
  // The session's user reference is the legacy user_token (non-CRA Layer accounts)
  // or the Plaid user_id (usr_… — returned by CRA /user/create, which has no
  // user_token). Either is valid in /session/token/create user.user_id.
  const userRef = (r) => r.user_token || r.user_id || null;
  try {
    const r = await plaidPost('/user/create', { client_user_id: clientUserId }, scopeOpts);
    const ref = userRef(r);
    if (!ref) throw new Error(`/user/create returned no user_token or user_id: ${JSON.stringify(r)}`);
    cache[cacheKey] = { user_token: ref, created_at: new Date().toISOString() };
    writeLayerUserCache(cache);
    return { userToken: ref, clientUserId, reused: false };
  } catch (e) {
    if (/already exists/i.test(String(e && e.message))) {
      const freshId = `${clientUserId}-${Date.now()}`;
      const r = await plaidPost('/user/create', { client_user_id: freshId }, scopeOpts);
      const ref = userRef(r);
      if (!ref) throw new Error(`/user/create (fresh id) returned no user_token or user_id: ${JSON.stringify(r)}`);
      cache[keyFor(freshId)] = { user_token: ref, created_at: new Date().toISOString(), alias_of: clientUserId };
      writeLayerUserCache(cache);
      console.log(`[plaid-backend] Layer user "${clientUserId}" already existed without a cached token — created fresh user "${freshId}" for this session.`);
      return { userToken: ref, clientUserId: freshId, reused: false };
    }
    throw e;
  }
}

// Detect whether the CURRENT run is a CRA / Consumer Report demo so the Layer
// session uses the CRA Layer template (CRA_LAYER_TEMPLATE — a Layer template with
// CRA products enabled) instead of the default PLAID_LAYER_TEMPLATE_ID. Reads the
// run's demo-script / run-context (or the prompt) once, then caches.
let _runCraDemoCache;
function runIsCraDemo() {
  if (_runCraDemoCache !== undefined) return _runCraDemoCache;
  _runCraDemoCache = false;
  try {
    const projectRoot = path.resolve(__dirname, '../../..');
    const runDir = process.env.PIPELINE_RUN_DIR || null;
    const files = [
      runDir ? path.join(runDir, 'demo-script.json') : null,
      runDir ? path.join(runDir, 'pipeline-run-context.json') : null,
      path.join(projectRoot, 'inputs', 'prompt.txt'),
    ].filter(Boolean);
    const craRe = /cra_base_report|cra_cashflow_insights|cra_income_insights|cra_partner_insights|\/cra\/check_report|lend_score|lendscore/i;
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      if (craRe.test(fs.readFileSync(f, 'utf8'))) { _runCraDemoCache = true; break; }
    }
  } catch (_) {}
  return _runCraDemoCache;
}

async function createSessionToken(opts = {}) {
  // Layer template selection:
  //   • CRA demos → CRA_LAYER_TEMPLATE under CRA credentials (the CRA Layer
  //     template lives on the CRA account).
  //   • everything else → PLAID_LAYER_TEMPLATE_ID under default credentials.
  //   • an explicit caller-supplied template_id always wins.
  // If the CRA Layer template can't mint a session for this account's users (e.g.
  // it's a legacy-only template that rejects the new usr_ user_id), fall back to
  // the default template so the demo still completes — and log why.
  const craTemplate = process.env.CRA_LAYER_TEMPLATE || null;
  const defaultTemplate = process.env.PLAID_LAYER_TEMPLATE_ID || 'template_n31w56t6o9a7';
  const isCra = opts.cra === true || hasCraProducts(opts.products) || runIsCraDemo();
  const explicitTemplate = opts.template_id || opts.templateId || null;
  const requestedClientUserId = opts.client_user_id || opts.clientUserId || `onboarding-${Date.now()}`;

  async function mint(templateId, scope) {
    const scopeOpts = scope ? { credentialScope: scope } : {};
    const { userToken, clientUserId, reused } = await getOrCreateLayerUserToken(requestedClientUserId, scopeOpts);
    // New User API shape: pass the Plaid user identifier (new usr_… id OR a legacy
    // user_token) in the ROOT-level user_id; only client_user_id goes under `user`.
    // CRA Layer templates reject a usr_ id placed in the legacy nested user.user_id
    // slot ("must be a Legacy CRA user token type"); root-level works for both the
    // CRA template (usr_) and the default template (legacy user_token).
    const sessionResult = await plaidPost('/session/token/create', {
      template_id: templateId,
      user_id: userToken,
      user: { client_user_id: clientUserId },
    }, scopeOpts);
    const linkToken = sessionResult.link?.link_token || sessionResult.link_token;
    if (!linkToken) throw new Error(`/session/token/create failed: ${JSON.stringify(sessionResult)}`);
    console.log(`[plaid-backend] Layer session token created (template=${templateId}, cra=${isCra}, scope=${scope || 'default'}, user=${reused ? 'reused' : 'created'})`);
    return { link_token: linkToken, user_token: userToken, template_id: templateId };
  }

  if (explicitTemplate) return mint(explicitTemplate, isCra ? 'cra' : null);

  if (isCra && craTemplate) {
    try {
      return await mint(craTemplate, 'cra');
    } catch (e) {
      console.warn(`[plaid-backend] CRA Layer template ${craTemplate} not usable for this account (${e && e.message ? e.message : e}); falling back to PLAID_LAYER_TEMPLATE_ID.`);
      return mint(defaultTemplate, null);
    }
  }
  return mint(defaultTemplate, null);
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

/**
 * Verify Plaid Layer is properly activated by creating a real Layer session token.
 *
 * A successful /session/token/create (returning a link_token) confirms the
 * PLAID_LAYER_TEMPLATE_ID and Layer product access are provisioned for this
 * client. Used by plaid-link-qa as a deterministic activation check that runs
 * whenever a demo uses Layer — independent of the generated app's fetch wiring.
 *
 * @param {object} [opts]
 * @param {string} [opts.templateId]    Layer template id (defaults to PLAID_LAYER_TEMPLATE_ID).
 * @param {string} [opts.clientUserId]  Stable non-PII id (defaults inside createSessionToken).
 * @returns {Promise<{ok:boolean, linkToken:(string|null), templateId:string, error:(string|null)}>}
 */
async function verifyLayerActivation(opts = {}) {
  // Verify the template the demo will ACTUALLY use: createSessionToken selects
  // CRA_LAYER_TEMPLATE for CRA demos, else PLAID_LAYER_TEMPLATE_ID. Only force a
  // template when the caller explicitly passes one — otherwise let the CRA-aware
  // selection decide so the activation check matches the recorded session.
  const explicitTemplate = opts.templateId || opts.template_id || null;
  try {
    const result = await createSessionToken({
      ...(explicitTemplate ? { template_id: explicitTemplate } : {}),
      client_user_id: opts.clientUserId || opts.client_user_id || null,
    });
    const linkToken = result && result.link_token ? result.link_token : null;
    const resolvedTemplate = (result && result.template_id) || explicitTemplate || '(resolved)';
    return {
      ok: !!(linkToken && String(linkToken).length > 0),
      linkToken,
      templateId: resolvedTemplate,
      error: linkToken ? null : 'no link_token in /session/token/create response',
    };
  } catch (e) {
    return {
      ok: false,
      linkToken: null,
      templateId: explicitTemplate || '(resolved)',
      error: (e && e.message) ? e.message : String(e),
    };
  }
}

/**
 * Create a Plaid Identity Verification (IDV) Link token (live IDV session).
 * Requires a published IDV template id. Resolution order:
 *   1. explicit opts.template_id / opts.templateId
 *   2. IDV_TEMPLATE_IDENTITY_BANK_OPTIONAL (identity verification, bank linking optional)
 *   3. PLAID_IDV_TEMPLATE_ID (legacy/default fallback)
 * A skill (forthcoming) will select which named IDV template env var to use per
 * use case; until then the bank-optional template is the default named template.
 * `gave_consent: true` skips the accept_tos step. See plaid-identity-verification.md.
 *
 * @param {object} [opts] - { templateId?, clientUserId?, clientName? }
 * @returns {Promise<{link_token:string}>}
 */
async function createIdvLinkToken(opts = {}) {
  const templateId =
    opts.template_id ||
    opts.templateId ||
    process.env.IDV_TEMPLATE_IDENTITY_BANK_OPTIONAL ||
    process.env.PLAID_IDV_TEMPLATE_ID ||
    null;
  if (!templateId) {
    throw new Error('[plaid-backend] createIdvLinkToken requires an IDV template id (set IDV_TEMPLATE_IDENTITY_BANK_OPTIONAL or PLAID_IDV_TEMPLATE_ID).');
  }
  const clientUserId = opts.client_user_id || opts.clientUserId || `idv-${Date.now()}`;
  const result = await plaidPost('/link/token/create', {
    client_name:   opts.client_name || opts.clientName || 'Demo',
    language:      'en',
    country_codes: ['US'],
    products:      ['identity_verification'],
    user:          { client_user_id: clientUserId },
    identity_verification: { template_id: templateId, gave_consent: true },
  });
  const linkToken = result.link?.link_token || result.link_token;
  if (!linkToken) throw new Error(`/link/token/create (IDV) failed: ${JSON.stringify(result)}`);
  console.log(`[plaid-backend] IDV link token created (template=${templateId})`);
  return { link_token: linkToken };
}

/**
 * Retrieve an IDV session result. Use after the Link onSuccess (which returns the
 * session id as metadata.link_session_id) or the STATUS_UPDATED webhook.
 *
 * @param {string} identityVerificationId
 * @returns {Promise<object>} the /identity_verification/get response
 */
async function getIdentityVerification(identityVerificationId) {
  const data = await plaidPost('/identity_verification/get', {
    identity_verification_id: identityVerificationId,
  });
  console.log(`[plaid-backend] /identity_verification/get → status=${data.status || '?'}`);
  return data;
}

// ── Update mode (connection repair) ─────────────────────────────────────────
//
// "Reconnect bank" relaunches Plaid Link in UPDATE MODE to repair an Item in
// ITEM_LOGIN_REQUIRED. Verified flow (AskBill 2026-06-01):
//   • Server mints an update-mode link_token via /link/token/create with the
//     existing access_token and NO products (login-repair). Tokens expire fast.
//   • Client launches the SAME way (Plaid.create({token,...}) + open()).
//   • onSuccess fires with a public_token but you DO NOT exchange it — the
//     existing access_token stays valid. Recovery confirmed by ITEM/LOGIN_REPAIRED.
// Sandbox testing: force the state with /sandbox/item/reset_login, then re-auth
// with user_good/pass_good.

/**
 * Sandbox: force an Item into ITEM_LOGIN_REQUIRED so update mode can be tested.
 * @param {{ accessToken: string }} opts
 */
async function resetLogin({ accessToken } = {}) {
  if (!accessToken) throw new Error('resetLogin: accessToken required');
  const data = await plaidPost('/sandbox/item/reset_login', { access_token: accessToken });
  console.log(`[plaid-backend] /sandbox/item/reset_login → reset_login=${data.reset_login}`);
  return data;
}

/**
 * Create a self-contained Sandbox Item (no Link) and return its access_token.
 * Used so a demo "reconnect" beat can repair a real Item without depending on
 * the primary Link session. Defaults to First Platypus Bank + transactions.
 * @param {{ institutionId?: string, initialProducts?: string[] }} [opts]
 * @returns {Promise<{ access_token: string, item_id: string }>}
 */
async function createSandboxItemAccessToken(opts = {}) {
  const institutionId = opts.institutionId || 'ins_109508'; // First Platypus Bank (non-OAuth)
  const initialProducts = Array.isArray(opts.initialProducts) && opts.initialProducts.length
    ? opts.initialProducts
    : ['transactions'];
  const pub = await plaidPost('/sandbox/public_token/create', {
    institution_id: institutionId,
    initial_products: initialProducts,
  });
  const exchanged = await plaidPost('/item/public_token/exchange', { public_token: pub.public_token });
  console.log(`[plaid-backend] sandbox item created (item_id=${exchanged.item_id?.slice(0, 12)}…) for update-mode repair`);
  return { access_token: exchanged.access_token, item_id: exchanged.item_id };
}

/**
 * Mint an UPDATE-MODE link_token for an existing Item (login repair). Pass the
 * existing access_token and OMIT products. Returns the link_token to launch in
 * Plaid Link exactly like a normal session.
 * @param {{ accessToken: string, clientUserId?: string, clientName?: string }} opts
 * @returns {Promise<{ link_token: string, expiration: string }>}
 */
async function createUpdateModeLinkToken(opts = {}) {
  const accessToken = opts.accessToken || opts.access_token;
  if (!accessToken) throw new Error('createUpdateModeLinkToken: accessToken required');
  const clientUserId = opts.clientUserId || opts.client_user_id || 'demo-user-001';
  const clientName = resolvePromptDerivedClientName(opts) || opts.clientName || opts.client_name || 'Plaid Demo';
  // Sandbox returning-user phone (Remember Me / +14155550011). Prefilling the
  // phone on the update-mode token surfaces the returning-user prompt during the
  // "reconnect" repair flow. Overridable via opts; defaults to the sandbox phone.
  const phoneNumber = opts.phoneNumber || opts.phone_number || '+14155550011';
  const user = { client_user_id: clientUserId };
  if (phoneNumber) user.phone_number = phoneNumber;
  // Update mode for login repair: access_token + user, NO products.
  const data = await plaidPost('/link/token/create', {
    client_name: clientName,
    language: 'en',
    country_codes: ['US'],
    user,
    access_token: accessToken,
  });
  console.log(`[plaid-backend] update-mode link token created (len=${(data.link_token || '').length}, exp=${data.expiration || '?'})`);
  return { link_token: data.link_token, expiration: data.expiration };
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
  createIdvLinkToken,
  getIdentityVerification,
  exchangePublicToken,
  getAuth,
  getIdentityMatch,
  evaluateSignal,
  userAccountSessionGet,
  verifyLayerActivation,
  resetLogin,
  createSandboxItemAccessToken,
  createUpdateModeLinkToken,
};
