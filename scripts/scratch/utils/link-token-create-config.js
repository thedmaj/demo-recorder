'use strict';

/**
 * Dynamic /link/token/create (via POST /api/create-link-token) configuration.
 * - Default path: infer Link `products` from prompt + API hints, then merge AskBill (askPlaidDocs) JSON.
 * - **Investments Move + POST /investments/auth/get**: AskBill-only — no local product inference or merge;
 *   `suggestedClientRequest` is exactly what AskBill returns (sanitized to allowed keys).
 */

const { askPlaidDocs, tryExtractJsonBlock } = require('./mcp-clients');

/** Valid Plaid Link token product strings (lowercase) we allow onto the wire.
 *
 * Verified 2026-05-22 via AskBill (Plaid docs MCP) + Glean GTM Playbook 2026:
 *   - `protect_linked_bank` and `protect_transactions` ARE public Link product
 *     strings (US-only for protect_linked_bank). Previous KB note treating
 *     them as NDA was stale.
 *   - `identity_verification` is the standalone IDV product string (separate
 *     token flow but also valid as a Link products[] entry when bundled
 *     with Protect for the Trust Index Ti2 surface).
 *   - `monitor` is the Plaid Monitor (sanctions / watchlist / PEP) string.
 */
const ALLOWED_LINK_PRODUCTS = new Set([
  'assets',
  'auth',
  'employment',
  'identity',
  'identity_verification',
  'income_verification',
  'investments',
  'investments_auth',
  'liabilities',
  'monitor',
  'payment_initiation',
  'protect_linked_bank',
  'protect_transactions',
  'signal',
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
  'enable_multi_item_link',
  'enableMultiItemLink',
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

// Plaid /link/token/create product-mix constraints. The Plaid API rejects
// certain product combinations with HTTP 400. We enforce them here, in the
// research/resolver layer, so the config file written to disk is always a
// valid /link/token/create body. The same rules are duplicated in
// qa-patch-library.js's `plaid-link-token-products-prune` patch for healing
// already-built scratch-apps that pre-date this sanitizer.
//
// Layer 1: CRA + non-CRA Income are mutually exclusive. CRA mints a Plaid
//   Check user_id (usr_xxx); non-CRA Income wants a legacy user_token. A
//   single token cannot carry both.
//
// Layer 2: income_verification is exclusive of identity / auth / transactions
//   / liabilities / assets / investments. Plaid responds:
//   "only income_verification and employment may be configured." The Income
//   product family pre-dates the modular Link product mix.
const CRA_LINK_PRODUCTS = new Set(['cra_base_report', 'cra_income_insights']);
const NON_CRA_INCOME_LINK_PRODUCTS = new Set(['income_verification']);
const INCOME_VERIFICATION_COMPATIBLE_LINK_PRODUCTS = new Set([
  'income_verification',
  'employment',
]);

/**
 * Sanitize a products[] list so it satisfies Plaid /link/token/create's
 * product-mix rules. `intent` ('cra' | 'non-cra' | 'auto') controls which
 * side of a Layer-1 conflict wins. When `auto`, the demo-script signals are
 * the tiebreaker (favoring non-CRA Income when ambiguous).
 *
 * @param {string[]} products
 * @param {'cra'|'non-cra'|'auto'} [intent='auto']
 * @returns {{ products: string[], droppedCra: string[], droppedNonCraIncomeIncompatible: string[] }}
 */
function sanitizeProductsForLinkTokenMix(products, intent = 'auto') {
  const droppedCra = [];
  const droppedNonCraIncomeIncompatible = [];
  if (!Array.isArray(products) || products.length === 0) {
    return { products: products || [], droppedCra, droppedNonCraIncomeIncompatible };
  }
  let result = [...products];

  const hasCra = result.some((p) => CRA_LINK_PRODUCTS.has(p));
  const hasNonCraIncome = result.some((p) => NON_CRA_INCOME_LINK_PRODUCTS.has(p));

  // Layer 1: CRA vs non-CRA Income mutual exclusion.
  if (hasCra && hasNonCraIncome) {
    // 'auto' default — favor non-CRA Income, because mis-routing into the
    // CRA scope on a Bank Income demo causes harder-to-debug auth failures
    // (different credentials, different /user/create flow). Operators that
    // genuinely want CRA can pass intent='cra'.
    const keep = intent === 'cra' ? 'cra' : 'non-cra';
    result = result.filter((p) => {
      if (keep === 'non-cra' && CRA_LINK_PRODUCTS.has(p)) {
        droppedCra.push(p);
        return false;
      }
      if (keep === 'cra' && NON_CRA_INCOME_LINK_PRODUCTS.has(p)) {
        droppedNonCraIncomeIncompatible.push(p);
        return false;
      }
      return true;
    });
  }

  // Layer 2: when keeping non-CRA Income, also drop anything not in the
  // compatible set. Plaid only allows {income_verification, employment} in
  // the same link token.
  if (result.some((p) => NON_CRA_INCOME_LINK_PRODUCTS.has(p))) {
    const filtered = [];
    for (const p of result) {
      if (INCOME_VERIFICATION_COMPATIBLE_LINK_PRODUCTS.has(p)) {
        filtered.push(p);
      } else {
        droppedNonCraIncomeIncompatible.push(p);
      }
    }
    result = filtered;
  }

  // Layer 3: a CRA link token only accepts cra_* products. Plaid rejects
  // mixed tokens outright ("cannot configure assets along with cra_*
  // products" — observed 400, Scrub.io 2026-06-12, products
  // [cra_base_report, cra_income_insights, identity, transactions, assets]).
  // When cra_* products survive the layers above, drop every non-CRA
  // companion rather than shipping a token Plaid will refuse.
  if (result.some((p) => CRA_LINK_PRODUCTS.has(p))) {
    const filtered = [];
    for (const p of result) {
      if (CRA_LINK_PRODUCTS.has(p)) {
        filtered.push(p);
      } else {
        droppedNonCraIncomeIncompatible.push(p);
      }
    }
    result = filtered;
  }

  return { products: result, droppedCra, droppedNonCraIncomeIncompatible };
}

/**
 * Multi-item link (one Link session that adds Items at multiple institutions)
 * is OPT-IN: only enable it when the prompt explicitly asks for a multi-
 * institution / multi-account-across-banks session. Default is a standard
 * single-item link. signal (and other flows) are NOT supported in multi-item,
 * so callers must strip them when this is true.
 * @param {string} promptText
 * @returns {boolean}
 */
function detectMultiItemLinkIntent(promptText = '') {
  const t = String(promptText || '').toLowerCase();
  // Negation-aware: a prompt that says "standard link (NOT multi-item)" must NOT
  // trip this (mirrors the Protect-intent negation guard). Count a match only
  // when it sits in a clean (non-negated) ~40-char window. Without this, the
  // literal phrase "not multi-item link" enabled multi-item and 400'd
  // /link/token/create (observed on the KeyBank funding build).
  const collapsed = t.replace(/\s+/g, ' ');
  const NEG = /\bnot\b|\bnever\b|n['’]t\b|\bwithout\b|\bexclud\w*|\bavoid\b|\bno\b|\bstandard\b|\bsingle[-\s]?item\b/i;
  const affirmative = (re) => {
    const gre = new RegExp(re.source, 'gi');
    let m;
    while ((m = gre.exec(collapsed))) {
      const s = Math.max(0, m.index - 40);
      const e = Math.min(collapsed.length, m.index + m[0].length + 8);
      if (!NEG.test(collapsed.slice(s, e))) return true;
      if (gre.lastIndex === m.index) gre.lastIndex++;
    }
    return false;
  };
  if (affirmative(/\bmulti[-\s]?item\b/)) return true;
  // "multiple institutions / banks / accounts ... (in|one|single) ... session/link"
  if (affirmative(/\b(multiple|several|two or more|across)\b[^.]{0,60}\b(institution|bank|account|brokerage)s?\b[^.]{0,80}\b(one|single|same|a)\b[^.]{0,20}\b(session|link|connection)\b/)) return true;
  if (affirmative(/\b(connect|link|add)\b[^.]{0,40}\b(multiple|several|all (?:their|your)?)\b[^.]{0,30}\b(institution|bank|account|brokerage)s?\b[^.]{0,60}\b(one|single|same)\b[^.]{0,20}\b(session|link)\b/)) return true;
  return false;
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

  // Investments Move (ACATS / ATON brokerage transfer initiation) and
  // standard Plaid Investments (holdings + transactions data access) are
  // DIFFERENT products with different Plaid Link product strings:
  //   Investments Move    → products: ['investments_auth'], endpoint
  //                         POST /investments/auth/get
  //   Plaid Investments   → products: ['investments'],      endpoints
  //                         POST /investments/holdings/get and
  //                         POST /investments/transactions/get
  // Verified via AskBill + Glean (GTM Playbook Feb 2026) on 2026-05-21.
  //
  // Detect Move-specific signals FIRST so a prompt mentioning ACATS or
  // /investments/auth/get doesn't degrade to 'investments' and silently
  // call the wrong endpoint after Link completes.
  const isInvestmentsMove =
    /\binvestments\s+move\b/.test(text) ||
    /\bacats\b/.test(text) ||
    /\baton\b/.test(text) ||
    /\bbroker-?sourced\b/.test(text) ||
    /\bheld-?away\b/.test(text) ||
    /\bportfolio\s+transfer\b/.test(text) ||
    /\bbrokerage\b.*\btransfer\b/.test(text) ||
    /\binvestments_auth\b/.test(text) ||
    /\/investments\/auth\/get\b/.test(text);
  const isInvestmentsDataAccess =
    !isInvestmentsMove &&
    (
      /\binvestments\b/.test(text) ||
      /\binvestment\s+holdings\b/.test(text) ||
      /\/investments\/holdings\/get\b/.test(text) ||
      /\/investments\/transactions\/get\b/.test(text) ||
      /\bportfolio\s+(view|allocation|performance|holdings)\b/.test(text)
    );
  if (isInvestmentsMove) {
    add('investments_auth');
  } else if (isInvestmentsDataAccess) {
    add('investments');
  }
  if (/\bidentity\b/.test(text) && (/\bmatch\b/.test(text) || /\/identity\//.test(text))) add('identity');
  if (/\bauth\b/.test(text) && (/\bget\b/.test(text) || /\/auth\//.test(text) || /\brouting\b/.test(text))) add('auth');
  // Standalone Plaid Signal (funding / ACH return risk) — not only Plaid Protect umbrella.
  // Huntington-style Auth + Identity Match + Signal demos mention "Plaid Signal" and
  // /signal/evaluate but are NOT Protect demos; signal must still land in products[].
  if (
    /\bplaid\s+signal\b/.test(text) ||
    /\/signal\/evaluate\b/.test(text) ||
    (/\bsignal\b/.test(text) && (/\bach\b/.test(text) || /\breturn risk\b/.test(text) || /\bfunding\b/.test(text) || /\binstant availability\b/.test(text)))
  ) {
    add('signal');
  }
  if (/\btransactions\b/.test(text) || /\/transactions\//.test(text)) add('transactions');
  if (/\bliabilit/.test(text) || /\/liabilities\//.test(text)) add('liabilities');
  if (/\basset report\b/.test(text) || /\bassets\b.*\bplaid\b/.test(text)) add('assets');
  if (/\bincome verification\b/.test(text) || /\bpayroll\b/.test(text) || /\bpaystub\b/.test(text)) {
    add('income_verification');
  }
  if (/\bcra\b/.test(text) && /\bbase report\b/.test(text)) add('cra_base_report');
  if (/\bcra\b/.test(text) && /\bincome insights\b/.test(text)) add('cra_income_insights');

  // Plaid Protect Cash Advance Score / EWA Score is surfaced via
  // /signal/evaluate, so 'signal' is the correct Link product. We add it for
  // EWA / cash-advance prompts in addition to whatever the prompt already
  // implies (typically 'auth' for the account-level context). 'signal' was
  // added to Plaid's Link products list in Oct 2024 — verified via AskBill.
  if (
    /\bewa\b/.test(text) ||
    /\bearned[\s_-]?wage[\s_-]?access\b/.test(text) ||
    /\bcash[\s_-]?advance\s+score\b/.test(text) ||
    /\bplaid\s+protect\s+cash[\s_-]?advance\b/.test(text)
  ) {
    add('auth');
    add('signal');
  }

  // Plaid Protect (umbrella) — Trust Index Ti2 surface.
  // Verified 2026-05-22 via AskBill + Glean Protect Megadoc:
  //   - Canonical Protect demo path uses `protect_linked_bank` (US-only).
  //   - `/protect/event/send` returns the trust_index block.
  //   - Bundle with `identity_verification` ONLY when the prompt explicitly
  //     names IDV / identity verification as a featured product. Otherwise
  //     `protect_linked_bank` is sufficient and is the default.
  //   - Add `'signal'` whenever transaction-time scoring is implied.
  //   - Add `'monitor'` whenever sanctions / watchlist / PEP is mentioned.
  // EWA / Cash Advance Score is handled above and is a separate family
  // (it routes to `['auth', 'signal']` because Plaid Protect Cash Advance
  // doesn't use `protect_linked_bank` — verified via prompt-scope.js).
  const isPlaidProtectIntent =
    /\bplaid\s+protect\b/.test(text) ||
    /\btrust\s+index\b/.test(text) ||
    /\bti2\b/.test(text) ||
    /\bti\s*score\b/.test(text) ||
    /\bprotect\s+(retro|trust|score|umbrella|sdk)\b/.test(text) ||
    /\bprotect_linked_bank\b/.test(text) ||
    /\/protect\/event\/send\b/.test(text);
  const isEwaScopeOnly =
    /\bewa\b/.test(text) ||
    /\bearned[\s_-]?wage[\s_-]?access\b/.test(text) ||
    /\bcash[\s_-]?advance\s+score\b/.test(text);
  if (isPlaidProtectIntent && !isEwaScopeOnly) {
    add('protect_linked_bank');
    // Add IDV ONLY when prompt explicitly names identity verification as a featured product.
    if (/\bidentity\s+verification\b/.test(text) || /\bplaid\s+idv\b/.test(text) || /\/identity_verification\//.test(text)) {
      add('identity_verification');
    }
    // Add Signal only when transaction-time Signal is explicit — Trust Index uses
    // /protect/event/send, not /signal/evaluate. Do not infer signal from
    // generic "underwriting" / "decisioning" keywords on Protect prompts.
    if (
      /\/signal\/evaluate\b/.test(text) ||
      /\bplaid\s+signal\b/.test(text) ||
      (/\bsignal\b/.test(text) && (/\bach\b/.test(text) || /\breturn risk\b/.test(text) || /\btransaction[- ]?time\b/.test(text)))
    ) {
      add('signal');
    }
    // Add Monitor when the prompt mentions sanctions / PEP / watchlist.
    if (/\bmonitor\b/.test(text) || /\bsanctions?\b/.test(text) || /\bpep\b/.test(text) || /\bwatchlist\b/.test(text)) {
      add('monitor');
    }
    // Add `protect_transactions` only when explicitly mentioned.
    if (/\bprotect_transactions\b/.test(text) || /\bprotect\s+transaction\s+monitor/.test(text)) {
      add('protect_transactions');
    }
  }

  return [...found];
}

function inferProductsFromApiSignals(signals = []) {
  const out = [];
  for (const s of signals || []) {
    const c = String(s || '').toLowerCase();
    // Investments Move endpoint must take precedence over the generic
    // 'investments' substring match. Both endpoint paths contain
    // 'investments', but only /investments/auth/get is the Move flow and
    // requires the 'investments_auth' Link product.
    if (c.includes('investments/auth')) {
      out.push('investments_auth');
    } else if (c.includes('investments/holdings') || c.includes('investments/transactions')) {
      out.push('investments');
    } else if (c.includes('investments')) {
      // Ambiguous bare 'investments' signal — assume the data-access flow;
      // Move flows should be explicit (investments/auth in the signal).
      out.push('investments');
    }
    // Identity vs Identity Verification: `/identity/get` → 'identity', but
    // `/identity_verification/get` → 'identity_verification' (separate IDV
    // product). Order matters because 'identity_verification' contains
    // 'identity' as a substring.
    if (c.includes('identity_verification') || c.includes('identity-verification')) out.push('identity_verification');
    else if (c.includes('identity')) out.push('identity');
    // Plaid Protect SDK endpoints
    if (c.includes('protect/event/send') || c.includes('protect/user/insights') || c.includes('protect_linked_bank')) {
      out.push('protect_linked_bank');
    }
    if (c.includes('protect_transactions') || c.includes('protect/transactions')) {
      out.push('protect_transactions');
    }
    if (c.includes('/monitor/') || /\bsanctions\b/.test(c) || /\bwatchlist\b/.test(c)) {
      out.push('monitor');
    }
    // Plain 'auth' here means /auth/get (the Plaid Auth product for ACH
    // routing/account numbers), NOT the Investments Move /investments/auth/get
    // path which is handled above and routes to 'investments_auth'.
    if (/(^|\W)auth($|\W)/.test(c) && !c.includes('investments/auth')) out.push('auth');
    if (c.includes('signal/evaluate') || c.includes('/signal/')) out.push('signal');
    if (c.includes('transactions') && !c.includes('investments/transactions')) out.push('transactions');
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
  if (f === 'cra_cashflow_insights' || f === 'cra_lend_score' || f === 'cra_network_insights' || f === 'cra_partner_insights') {
    return ['cra_base_report'];
  }
  if (f === 'cra_base_report' || f === 'income_insights') {
    return ['cra_base_report', 'cra_income_insights'];
  }
  if (f === 'cash_advance_score') {
    return ['auth', 'signal'];
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

  const CRA_TOKEN_FAMILIES = new Set([
    'cra_base_report',
    'income_insights',
    'cra_underwriting',
    'cra_lend_score',
    'cra_network_insights',
    'cra_cashflow_insights',
    'cra_partner_insights',
    'cra_cashflow_updates',
    'cra_home_lending',
  ]);
  const isCraFamily =
    CRA_TOKEN_FAMILIES.has(productFamily) ||
    (Array.isArray(products) && products.some((p) => CRA_LINK_PRODUCTS.has(p)));
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

  // Guard: AskBill's suggestedClientRequest sometimes returns Plaid Protect
  // umbrella products (protect_linked_bank / protect_transactions / monitor)
  // for funding / Signal demos that are NOT Protect demos. protect_linked_bank
  // requires special account enablement and 400s /link/token/create on accounts
  // without it (e.g. "not enabled for protect_linked_bank"), halting the build.
  // Strip those umbrella products unless the prompt genuinely signals Plaid
  // Protect intent or the family is a Protect family — then ensure a base
  // account-linking product remains (signal/monitor are ride-alongs).
  const lcPrompt = promptText.toLowerCase();
  // Negation-aware: prompts often mention Protect terms only to EXCLUDE them
  // (e.g. the Signal reminder "Never use the term 'Trust Index'"). A naive
  // match treats that as Protect intent and wrongly keeps protect_linked_bank.
  // Count a Protect signal only when at least one mention sits in a clean
  // (non-negated) ~60-char window of the whitespace-collapsed prompt.
  const collapsedPrompt = lcPrompt.replace(/\s+/g, ' ');
  // \bno\b is load-bearing: prompts exclude Protect terms with "No 'Trust Index'
  // terminology" / "no Plaid Protect". Without \bno\b that reads as AFFIRMATIVE
  // Protect intent, keeping protect_linked_bank and 400'ing /link/token/create
  // (observed: Chase funding rebuild, 2026-06-13). The affirmative matcher scans
  // every occurrence, so a real Protect demo (multiple non-negated mentions)
  // still resolves true.
  const PROTECT_NEG = /\bnot\b|\bno\b|\bnever\b|n['’]t\b|\bwithout\b|\bexclud\w*|\bavoid\b|\bdon't\b|\bdo not\b/i;
  const protectIntentAffirmative = (re) => {
    const gre = new RegExp(re.source, 'gi');
    let mm;
    while ((mm = gre.exec(collapsedPrompt))) {
      const s = Math.max(0, mm.index - 60);
      const e = Math.min(collapsedPrompt.length, mm.index + mm[0].length + 20);
      if (!PROTECT_NEG.test(collapsedPrompt.slice(s, e))) return true;
      if (gre.lastIndex === mm.index) gre.lastIndex++;
    }
    return false;
  };
  const genuineProtectIntent =
    protectIntentAffirmative(/\bplaid\s+protect\b/) || protectIntentAffirmative(/\btrust\s+index\b/) ||
    protectIntentAffirmative(/\bti2\b/) || protectIntentAffirmative(/\bprotect_linked_bank\b/) ||
    /\/protect\/event\/send\b/.test(lcPrompt) || /\/protect\/user\/insights\b/.test(lcPrompt);
  // NOTE: do NOT trust a research-RESOLVED productFamily of "plaid_protect" as
  // a reason to KEEP protect_linked_bank. Research circularly resolves the
  // family TO plaid_protect *because* it spuriously added protect_linked_bank
  // to a funding/Signal demo — so an isProtectFamily escape hatch let an
  // un-enabled product through and 400'd /link/token/create (observed: Chase
  // funding rebuild, 2026-06-13, "not enabled for protect_linked_bank"). Gate
  // the strip on genuine PROMPT intent only; a real Protect demo always says
  // "Plaid Protect" / "Trust Index" / uses /protect/* endpoints affirmatively.
  const droppedProtect = [];
  if (!genuineProtectIntent && Array.isArray(merged.products)) {
    merged.products = merged.products.filter((p) => {
      const drop = /^(?:protect_linked_bank|protect_transactions|monitor)$/.test(String(p));
      if (drop) droppedProtect.push(p);
      return !drop;
    });
    // signal/monitor/protect_* are ride-along risk products that need a base
    // account-linking product — guarantee one is present.
    const BASE = /^(?:auth|transactions|identity|investments|investments_auth|liabilities|income_verification|cra_base_report)$/;
    if (!merged.products.some((p) => BASE.test(String(p)))) {
      merged.products = mergeProductLists(['auth'], merged.products);
    }
  }
  if (droppedProtect.length) {
    console.warn(
      `[link-token-create-config] stripped non-Protect umbrella product(s) [${droppedProtect.join(', ')}] for family=${productFamily} (no Plaid Protect intent in prompt) → [${merged.products.join(', ')}]`
    );
  }

  // CRA-family demos must NOT carry `signal` (ACH return-risk scoring at
  // transaction time) just because AskBill's suggestedClientRequest or a stray
  // keyword pulled it in — CRA is consumer-report underwriting, a different
  // surface (observed: Rain CRA + CarMax cashflow both got spurious signal).
  // Strip `signal` for CRA families unless the prompt GENUINELY features Plaid
  // Signal (affirmative "Plaid Signal" / "/signal/evaluate") or it's in the
  // declared product list. (protectIntentAffirmative is a generic negation-aware
  // affirmative-mention check; reused here.)
  const isCraResolved =
    /^cra_|income_insights/.test(String(productFamily).toLowerCase()) ||
    (Array.isArray(merged.products) && merged.products.some((p) => /^cra_|consumer_report/i.test(String(p))));
  // `declaredText` = products inferred/declared from the prompt (fromPrompt),
  // lowercased. It was referenced here but never defined → a ReferenceError that
  // threw the entire CRA-signal-strip block (caught as a non-fatal warning, so
  // the strip silently never ran on any build). Define it so an explicitly
  // declared `signal` still counts as genuine intent.
  const declaredText = (Array.isArray(fromPrompt) ? fromPrompt.join(' ') : '').toLowerCase();
  const genuineSignalIntent =
    protectIntentAffirmative(/\bplaid\s+signal\b/) ||
    /\/signal\/evaluate\b/.test(lcPrompt) ||
    /\bsignal\b/.test(declaredText);
  if (
    isCraResolved && !genuineSignalIntent &&
    Array.isArray(merged.products) && merged.products.some((p) => String(p).toLowerCase() === 'signal')
  ) {
    merged.products = merged.products.filter((p) => String(p).toLowerCase() !== 'signal');
    console.warn(
      `[link-token-create-config] stripped 'signal' from CRA-family products (no explicit Plaid Signal intent) for family=${productFamily} → [${merged.products.join(', ')}]`
    );
  }

  // Enforce Plaid product-mix rules before persisting. The merge pass above
  // can produce illegal combinations (e.g. cra_income_insights +
  // income_verification when prompt language mentions both). Intent is
  // derived from productFamily: CRA families win when explicit, otherwise
  // 'auto' favors the non-CRA Income path.
  const intentForMix = isCraFamily ? 'cra' : 'auto';
  const mix = sanitizeProductsForLinkTokenMix(merged.products, intentForMix);
  const sanitizedProducts = mix.products;
  const mixWarnings = [];
  if (mix.droppedCra.length) {
    mixWarnings.push(
      `dropped CRA products to keep non-CRA Income path: ${mix.droppedCra.join(', ')}`
    );
  }
  if (mix.droppedNonCraIncomeIncompatible.length) {
    mixWarnings.push(
      `dropped products incompatible with income_verification: ${mix.droppedNonCraIncomeIncompatible.join(', ')}`
    );
  }
  if (droppedProtect.length) {
    mixWarnings.push(
      `dropped Plaid Protect umbrella products (no Protect intent): ${droppedProtect.join(', ')}`
    );
  }
  if (mixWarnings.length) {
    console.warn(
      `[link-token-create-config] product-mix sanitization for family=${productFamily} → [${sanitizedProducts.join(', ')}] (${mixWarnings.join('; ')})`
    );
  }
  merged.products = sanitizedProducts;

  // Multi-item link is OPT-IN — standard single-item link is the default.
  // Enable only when the prompt explicitly asks for a multi-institution
  // session. signal (and other products) are NOT supported in multi-item, so
  // strip them here too (multi-item wins over a ride-along risk product).
  const multiItemRequested = detectMultiItemLinkIntent(promptText);
  if (multiItemRequested) {
    merged.enable_multi_item_link = true;
    const MULTI_ITEM_UNSUPPORTED = new Set(['signal']);
    if (Array.isArray(merged.products) && merged.products.some((p) => MULTI_ITEM_UNSUPPORTED.has(String(p)))) {
      const droppedMi = merged.products.filter((p) => MULTI_ITEM_UNSUPPORTED.has(String(p)));
      merged.products = merged.products.filter((p) => !MULTI_ITEM_UNSUPPORTED.has(String(p)));
      console.warn(
        `[link-token-create-config] multi-item link requested → stripped [${droppedMi.join(', ')}] (not supported in multi-item link flow) → [${merged.products.join(', ')}]`
      );
    }
    console.warn('[link-token-create-config] enable_multi_item_link=true (prompt explicitly requested a multi-institution session)');
  }

  return {
    products: merged.products,
    suggestedClientRequest: merged,
    inferredFromPrompt: fromPrompt,
    inferredFromApiSignals: fromApis,
    enableMultiItemLink: multiItemRequested,
    productFamily,
    linkMode: opts.linkMode || null,
    askBillOnlyInvestmentsMoveAuthGet: false,
    askBillAvailable: Boolean(askBillJson && typeof askBillJson === 'object'),
    askBillAnswerPreview: String(askBillAnswer || '').slice(0, 2000),
    productMixSanitization: mixWarnings.length
      ? {
          droppedCra: mix.droppedCra,
          droppedNonCraIncomeIncompatible: mix.droppedNonCraIncomeIncompatible,
          droppedProtectUmbrella: droppedProtect,
          intent: intentForMix,
        }
      : null,
    resolvedAt: new Date().toISOString(),
  };
}

module.exports = {
  inferPlaidLinkProductsFromPrompt,
  inferProductsFromApiSignals,
  resolveLinkTokenCreateConfig,
  detectInvestmentsMoveInvestmentsAuthGetAskBillOnly,
  sanitizeProductsForLinkTokenMix,
  ALLOWED_LINK_PRODUCTS,
  CRA_LINK_PRODUCTS,
  NON_CRA_INCOME_LINK_PRODUCTS,
  INCOME_VERIFICATION_COMPATIBLE_LINK_PRODUCTS,
};
