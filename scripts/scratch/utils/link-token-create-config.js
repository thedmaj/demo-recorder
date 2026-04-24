'use strict';

/**
 * Dynamic /link/token/create (via POST /api/create-link-token) configuration.
 * - Default path: infer Link `products` from prompt + API hints, then merge AskBill (askPlaidDocs) JSON.
 * - **Investments Move + POST /investments/auth/get**: AskBill-only — no local product inference or merge;
 *   `suggestedClientRequest` is exactly what AskBill returns (sanitized to allowed keys).
 */

const { askPlaidDocs, tryExtractJsonBlock } = require('./mcp-clients');

/** Valid Plaid Link token product strings (lowercase) we allow onto the wire. */
const ALLOWED_LINK_PRODUCTS = new Set([
  'assets',
  'auth',
  'employment',
  'identity',
  'income_verification',
  'investments',
  'liabilities',
  'payment_initiation',
  'standing_orders',
  'transactions',
  'transfer',
  'cra_base_report',
  'cra_income_insights',
]);

/** Keys the scratch app may send in JSON to /api/create-link-token (server merges into Plaid body). */
const ALLOWED_CLIENT_REQUEST_KEYS = new Set([
  'client_name',
  'clientName',
  'products',
  'user_id',
  'userId',
  'phone_number',
  'phoneNumber',
  'link_customization_name',
  'linkCustomizationName',
  'productFamily',
  'product_family',
  'credentialScope',
  'credential_scope',
  'consumer_report_permissible_purpose',
  'cra_options',
  'country_codes',
  'language',
  'user',
]);

/** AskBill: sole source of truth for Link token fields when demo is Investments Move + /investments/auth/get. */
const ASKBILL_INVESTMENTS_MOVE_AUTH_GET_QUESTION =
  'You are AskBill answering from official Plaid documentation only.\n\n' +
  'Context: US sandbox demo using **Plaid Investments Move**. After Link completes, the application will call **POST /investments/auth/get**.\n\n' +
  'Task: Return **one JSON object only** (no markdown fences, no commentary). It must list **exactly** the fields a host app should POST to its own **`/api/create-link-token`** proxy so the server can forward them to Plaid **`POST /link/token/create`** for this flow.\n\n' +
  'Rules:\n' +
  '- Use **only** the documented `/link/token/create` fields that Plaid recommends or requires for **Investments Move** when **`/investments/auth/get`** will be used afterward.\n' +
  '- **`products`**: set to the **official Plaid-recommended `products` array** for this combination (do not add unrelated products unless docs explicitly require them for this flow).\n' +
  '- **`client_name`**: use the placeholder string `"<BrandName>"`.\n' +
  '- **User**: per docs, include either top-level `user_id` with value `"demo-user-001"` **or** a `user` object with `client_user_id` (choose whichever `/link/token/create` expects; do not send both shapes if docs forbid).\n' +
  '- Include other documented optional/recommended fields for this flow only (e.g. `country_codes`, `language`) if applicable.\n' +
  '- **Omit** `client_id`, `secret`, `access_token`, and any other secrets.\n\n' +
  'If documentation is ambiguous, prefer the **minimal** valid payload that still succeeds in sandbox for Investments Move → `/investments/auth/get`.';

function uniqLowerProducts(arr) {
  const out = [];
  const seen = new Set();
  for (const p of arr || []) {
    const s = String(p || '').trim().toLowerCase();
    if (!s || !ALLOWED_LINK_PRODUCTS.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function normalizePathSlashes(text) {
  return String(text || '').replace(/\\/g, '/').toLowerCase();
}

/**
 * True when the run should use **AskBill-only** link/token/create config for
 * Investments Move with POST /investments/auth/get (no local product inference).
 */
function detectInvestmentsMoveInvestmentsAuthGetAskBillOnly(promptText = '', requiredApiSignals = []) {
  const pathNorm = normalizePathSlashes(promptText);
  const hasInvAuthGetInPrompt =
    pathNorm.includes('/investments/auth/get') || pathNorm.includes('investments/auth/get');
  const signals = (requiredApiSignals || []).map((s) => normalizePathSlashes(s));
  const hasInvAuthGetSignal = signals.some((s) => s.includes('investments/auth/get'));
  const hasInvAuthGet = hasInvAuthGetInPrompt || hasInvAuthGetSignal;

  const lower = String(promptText || '').toLowerCase();
  const hasMove =
    /\binvestments\s+move\b/.test(lower) ||
    lower.includes('plaid investments move');

  return Boolean(hasInvAuthGet && hasMove);
}

/**
 * Infer Link `products` from free-text prompt (inputs/prompt.txt, etc.).
 * @param {string} promptText
 * @returns {string[]}
 */
function inferPlaidLinkProductsFromPrompt(promptText = '') {
  const text = String(promptText || '').toLowerCase();
  const found = new Set();

  const add = (p) => {
    if (ALLOWED_LINK_PRODUCTS.has(p)) found.add(p);
  };

  if (
    /\binvestments move\b/.test(text) ||
    /\binvestments\b/.test(text) ||
    /\bacats\b/.test(text) ||
    /\bbroker-?sourced\b/.test(text) ||
    /\bheld-?away\b/.test(text) ||
    /\bportfolio transfer\b/.test(text) ||
    /\bbrokerage\b.*\btransfer\b/.test(text) ||
    /\binvestment holdings\b/.test(text) ||
    /\/investments\//.test(text)
  ) {
    add('investments');
  }
  if (/\bidentity\b/.test(text) && (/\bmatch\b/.test(text) || /\/identity\//.test(text))) add('identity');
  if (/\bauth\b/.test(text) && (/\bget\b/.test(text) || /\/auth\//.test(text) || /\brouting\b/.test(text))) add('auth');
  if (/\btransactions\b/.test(text) || /\/transactions\//.test(text)) add('transactions');
  if (/\bliabilit/.test(text) || /\/liabilities\//.test(text)) add('liabilities');
  if (/\basset report\b/.test(text) || /\bassets\b.*\bplaid\b/.test(text)) add('assets');
  if (/\bincome verification\b/.test(text) || /\bpayroll\b/.test(text) || /\bpaystub\b/.test(text)) {
    add('income_verification');
  }
  if (/\bcra\b/.test(text) && /\bbase report\b/.test(text)) add('cra_base_report');
  if (/\bcra\b/.test(text) && /\bincome insights\b/.test(text)) add('cra_income_insights');

  return [...found];
}

function inferProductsFromApiSignals(signals = []) {
  const out = [];
  for (const s of signals || []) {
    const c = String(s || '').toLowerCase();
    if (c.includes('investments')) out.push('investments');
    if (c.includes('identity')) out.push('identity');
    if (c.includes('auth')) out.push('auth');
    if (c.includes('transactions')) out.push('transactions');
    if (c.includes('liabilities')) out.push('liabilities');
    if (c.includes('cra/check_report/base')) out.push('cra_base_report');
    if (c.includes('cra/check_report/income')) out.push('cra_income_insights');
  }
  return uniqLowerProducts(out);
}

function mergeProductLists(...lists) {
  return uniqLowerProducts(lists.flat());
}

function sanitizeClientRequest(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!ALLOWED_CLIENT_REQUEST_KEYS.has(k)) continue;
    if (k === 'products' && Array.isArray(v)) {
      const cleaned = uniqLowerProducts(v);
      if (cleaned.length) out.products = cleaned;
      continue;
    }
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

function defaultProductsForFamily(productFamily) {
  const f = String(productFamily || '').toLowerCase();
  if (f === 'cra_base_report' || f === 'income_insights') {
    return ['cra_base_report', 'cra_income_insights'];
  }
  return ['auth', 'identity'];
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/**
 * @param {{
 *   promptText: string,
 *   requiredApiSignals?: string[],
 *   productFamily?: string,
 *   linkMode?: string|null,
 * }} opts
 */
async function resolveLinkTokenCreateConfig(opts = {}) {
  const promptText = String(opts.promptText || '');
  const productFamily = opts.productFamily || 'generic';
  const requiredApiSignals = opts.requiredApiSignals || [];
  const askBillOnlyIm = detectInvestmentsMoveInvestmentsAuthGetAskBillOnly(promptText, requiredApiSignals);

  if (askBillOnlyIm) {
    let askBillAnswer = '';
    let askBillJson = null;
    try {
      askBillAnswer = await askPlaidDocs(ASKBILL_INVESTMENTS_MOVE_AUTH_GET_QUESTION, { answerFormat: 'json_sample' });
      askBillJson = tryExtractJsonBlock(askBillAnswer) || safeJsonParse(askBillAnswer);
    } catch (e) {
      askBillAnswer = `[AskBill error] ${e.message}`;
    }

    const sanitized = askBillJson && typeof askBillJson === 'object' && !Array.isArray(askBillJson)
      ? sanitizeClientRequest(askBillJson)
      : {};

    let merged = { ...sanitized };
    if (!merged.client_name) merged.client_name = '<BrandName>';
    const hasNestedUser = merged.user && typeof merged.user === 'object' && merged.user.client_user_id;
    if (!merged.user_id && !hasNestedUser) merged.user_id = 'demo-user-001';

    merged = sanitizeClientRequest(merged);
    const productsOk = Array.isArray(merged.products) && merged.products.length > 0;

    return {
      products: productsOk ? merged.products : [],
      suggestedClientRequest: merged,
      inferredFromPrompt: [],
      inferredFromApiSignals: [],
      productFamily,
      linkMode: opts.linkMode || null,
      askBillOnlyInvestmentsMoveAuthGet: true,
      askBillAvailable: productsOk,
      askBillAnswerPreview: String(askBillAnswer || '').slice(0, 2000),
      resolvedAt: new Date().toISOString(),
      ...(productsOk ? {} : { askBillInvestmentsMoveAuthGetError: 'AskBill returned no usable products[] for Investments Move + /investments/auth/get' }),
    };
  }

  const fromPrompt = inferPlaidLinkProductsFromPrompt(promptText);
  const fromApis = inferProductsFromApiSignals(requiredApiSignals);
  let products = mergeProductLists(fromPrompt, fromApis);

  if (!products.length) {
    products = defaultProductsForFamily(productFamily);
  }

  const isCraFamily = productFamily === 'cra_base_report' || productFamily === 'income_insights';
  let askBillAnswer = '';
  let askBillJson = null;

  const question = isCraFamily
    ? `For Plaid /link/token/create in the US sandbox with consumer report products cra_base_report and cra_income_insights, return ONE JSON object only (no markdown) with the minimal documented request fields needed for a Check/CRA Link session: products (array), client_name (use placeholder string "<BrandName>"), user (object with client_user_id placeholder "demo-user-001"), consumer_report_permissible_purpose, cra_options (object with days_requested number). Omit secrets.`
    : `For Plaid /link/token/create in the US sandbox with Link products ${JSON.stringify(products)}, return ONE JSON object only (no markdown) with the minimal fields the host app should POST to its own /api/create-link-token proxy so the server can call Plaid: include products (array, same or corrected if any name was invalid), client_name (placeholder "<BrandName>"), and user_id "demo-user-001" if applicable. Include only keys that belong on link/token/create or that this repo's Node proxy accepts (client_name, products, user_id, phone_number, link_customization_name, optional country_codes/language). Omit secrets.`;

  try {
    askBillAnswer = await askPlaidDocs(question, { answerFormat: 'json_sample' });
    askBillJson = tryExtractJsonBlock(askBillAnswer) || safeJsonParse(askBillAnswer);
  } catch (e) {
    askBillAnswer = `[AskBill error] ${e.message}`;
  }

  let merged = {
    client_name: '<BrandName>',
    products,
    user_id: 'demo-user-001',
  };

  if (askBillJson && typeof askBillJson === 'object' && !Array.isArray(askBillJson)) {
    const sanitized = sanitizeClientRequest(askBillJson);
    if (Array.isArray(sanitized.products) && sanitized.products.length) {
      products = mergeProductLists(products, sanitized.products);
    }
    merged = { ...merged, ...sanitized, products };
  }

  if (isCraFamily) {
    merged = {
      ...merged,
      products: mergeProductLists(['cra_base_report', 'cra_income_insights'], merged.products),
      consumer_report_permissible_purpose:
        merged.consumer_report_permissible_purpose || 'EXTENSION_OF_CREDIT',
      cra_options: merged.cra_options && typeof merged.cra_options === 'object'
        ? merged.cra_options
        : { days_requested: 365 },
      productFamily: merged.productFamily || productFamily,
      credentialScope: merged.credentialScope || 'cra',
    };
  }

  merged = sanitizeClientRequest(merged);
  if (!merged.products || !merged.products.length) merged.products = defaultProductsForFamily(productFamily);

  return {
    products: merged.products,
    suggestedClientRequest: merged,
    inferredFromPrompt: fromPrompt,
    inferredFromApiSignals: fromApis,
    productFamily,
    linkMode: opts.linkMode || null,
    askBillOnlyInvestmentsMoveAuthGet: false,
    askBillAvailable: Boolean(askBillJson && typeof askBillJson === 'object'),
    askBillAnswerPreview: String(askBillAnswer || '').slice(0, 2000),
    resolvedAt: new Date().toISOString(),
  };
}

module.exports = {
  inferPlaidLinkProductsFromPrompt,
  inferProductsFromApiSignals,
  resolveLinkTokenCreateConfig,
  detectInvestmentsMoveInvestmentsAuthGetAskBillOnly,
  ALLOWED_LINK_PRODUCTS,
};
