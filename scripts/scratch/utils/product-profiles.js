'use strict';

const {
  getEffectiveProductFamily,
  inferProductFamilyFromKeywordsOnly,
} = require('./prompt-scope');

const PRODUCT_FAMILIES = {
  generic: {
    key: 'generic',
    label: 'Generic Plaid demo',
    kbSlugs: [],
    accuracyRules: [
      'Use approved Plaid product names only.',
      'Do not invent endpoint names, field names, event names, or response shapes.',
      'If a step is an insight screen, its apiResponse must match the product flow and visible UI.',
      'No API error responses in the main happy path unless the prompt explicitly asks for them.',
    ],
    critiqueRules: [
      'Verify product terminology against the supplied product research and curated product knowledge.',
    ],
  },
  funding: {
    key: 'funding',
    label: 'Funding / Auth / Identity Match / Signal',
    kbSlugs: ['auth', 'signal'],
    accuracyRules: [
      'Signal scores 0–99: higher score = higher ACH return risk.',
      'ACCEPT scenarios should use low Signal scores (5–20), not 82–97.',
      'Auth coverage phrasing: "over 98% of U.S. depository accounts".',
      'Identity Match terminology: prefer "name matching algorithm" over vague matching claims.',
      'Funding flows should show ownership verification before money movement and avoid consumer-visible raw JSON.',
    ],
    critiqueRules: [
      'Funding flows should preserve the logical order: ownership or rail retrieval before risk or approval messaging.',
      'If Signal is present, the reveal should clearly connect low risk to instant approval.',
    ],
  },
  cra_base_report: {
    key: 'cra_base_report',
    label: 'Plaid Check Base Report CRA',
    kbSlugs: ['cra-base-report'],
    accuracyRules: [
      'CRA Base Report demos must reflect user creation plus identity-heavy setup before consumer report generation.',
      'CRA Base Report demos must use the real Plaid Link CRA/Check experience (single plaidPhase "launch" step), not simulated host-only Link steps.',
      'When CRA_LAYER_TEMPLATE is configured, CRA link initialization should use that template with CRA credentials for CRA/Check Link sessions.',
      'Use consumer-report terminology such as permissible purpose, report readiness, account insights, inflows, outflows, balances, and ownership.',
      'Do not present Base Report as an instant funding or Signal risk flow unless the prompt explicitly combines products.',
      'If report generation is asynchronous, show a readiness or report-available beat instead of pretending the report is instantly returned.',
      'Any setup or data-returned explanatory scene should be rendered as a Plaid-branded slide (.slide-root), not customer-branded host chrome.',
    ],
    critiqueRules: [
      'Base Report demos should emphasize report generation, readiness, and retrieved report contents rather than ACH rails or transaction risk.',
      'Consumer-report steps should surface realistic report fields like balances, transactions, account ownership, and trend indicators.',
    ],
  },
  income_insights: {
    key: 'income_insights',
    label: 'Plaid Check CRA Income Insights',
    kbSlugs: ['income-insights'],
    accuracyRules: [
      'CRA Income Insights demos should use Check / Consumer Report terminology, not traditional Income API terminology.',
      'CRA Income Insights demos must use the real Plaid Link CRA/Check experience (single plaidPhase "launch" step), not simulated host-only Link steps.',
      'When CRA_LAYER_TEMPLATE is configured, CRA link initialization should use that template with CRA credentials for CRA/Check Link sessions.',
      'Use CRA products such as "cra_base_report" and "cra_income_insights" for Link configuration in this family.',
      'Retrieve CRA Income Insights with /cra/check_report/income_insights/get, not /credit/bank_income/get or /credit/payroll_income/get.',
      'CRA Income Insights flows are asynchronous and should include a report-ready or report-available beat before reviewing the report.',
      'Any setup or data-returned explanatory scene should be rendered as a Plaid-branded slide (.slide-root), not customer-branded host chrome.',
    ],
    critiqueRules: [
      'CRA Income Insights demos should focus the reveal on report-derived income understanding, not traditional payroll or bank-income source selection.',
      'Do not blend CRA Income Insights with traditional Bank Income, Payroll Income, or Document Income unless the prompt explicitly requests separate flows.',
    ],
  },
  bank_income: {
    key: 'bank_income',
    label: 'Plaid Bank Income (non-CRA)',
    kbSlugs: ['bank-income'],
    accuracyRules: [
      'Use /credit/bank_income/get for Bank Income retrieval (NOT /cra/check_report/income_insights/get — that is CRA Income Insights, a different family).',
      'Bank Income requires /user/create + a user_token before /link/token/create; pass `user_token` (or set `user.client_user_id`) in /link/token/create and include `bank_income` (or `income_verification`) in products.',
      'Surface lender-grade structured fields from historical_summary: monthly_average_income, weeks_visible, pay_frequency, top employer name, income_confidence.',
      'Webhook BANK_INCOME_REFRESH_COMPLETE fires when a refresh is ready; do not pretend the response is instant when narrative implies a refresh.',
      'Bank Income is not FCRA-compliant; do not market it as a consumer-report. Use CRA Income Insights / Base Report for regulated underwriting in the US.',
      'Realistic monthly_average_income should align with persona income (e.g., $5K–$30K/mo for typical W-2 personas).',
    ],
    critiqueRules: [
      'Bank Income demos should emphasize lender-grade structured income (employer, cadence, stability) rather than raw transaction lists.',
      'Do not blend Bank Income with CRA Income Insights or Document Income unless the prompt explicitly combines them.',
    ],
  },
  assets: {
    key: 'assets',
    label: 'Plaid Assets (Asset Report — legacy VOA)',
    kbSlugs: ['assets'],
    accuracyRules: [
      'Asset Reports are async: call /asset_report/create, listen for PRODUCT_READY webhook, then /asset_report/get (or /asset_report/pdf/get).',
      'days_requested defaults to 90 and supports up to 2 years of history.',
      'Returned fields include items[].accounts[] with balances, owners, transactions, historical_balances; optional include_insights:true adds lender categories.',
      'For most new US mortgage VOA use cases, prefer Consumer Report (by Plaid Check) — it is FCRA-compliant and Day 1 Certainty-eligible. Assets remains valid for non-US, rental screening, and similar non-regulated flows.',
      'Use /asset_report/refresh to update an existing report; use /asset_report/audit_copy/create to share with auditors (e.g., Fannie Mae).',
      'Do not present asset_report_token as user-visible UI; keep it server-side.',
    ],
    critiqueRules: [
      'Asset Report demos should include a "report ready" beat after creation; do not skip the async webhook step.',
      'Insights (categorized cash flow, lending categories) only appear when include_insights:true — match the visualState to the actual request.',
    ],
  },
  cra_underwriting: {
    key: 'cra_underwriting',
    label: 'Plaid Check CRA — Underwriting family (Base Report + LendScore / Cash Flow / Network Insights)',
    kbSlugs: ['cra-base-report'],
    accuracyRules: [
      'CRA Underwriting demos build on the Base Report foundation; the Underwriting family adds LendScore, Network Insights, Cash Flow Insights as opt-in modules.',
      'All CRA endpoints require /user/create + user_token, /link/token/create with `cra_base_report` (and any add-on products), real Plaid Link Check experience, then USER_CHECK_REPORT_READY webhook, then per-module /get calls.',
      'Use FCRA-compliant consumer-report terminology: permissible purpose, report readiness, adverse action reasons, consumer rights.',
      'LendScore range is 1–99 (higher = lower default risk). Pair with up to 5 reason_codes per the response.',
      'Reports expire after 24 hours; call /cra/check_report/create again to refresh.',
      'Any setup or data-returned explanatory scene should be rendered as a Plaid-branded slide (.slide-root), not customer-branded host chrome.',
    ],
    critiqueRules: [
      'Underwriting demos should culminate in a credit decision narrative grounded in the chosen module(s); avoid implying CRA modules apply to home-lending or income-only use cases (those have separate families).',
      'Do not assert FCRA compliance phrasing in customer-app UI copy beyond required notices; narration carries the regulatory framing.',
    ],
  },
  cra_lend_score: {
    key: 'cra_lend_score',
    label: 'Plaid Check CRA LendScore (beta)',
    kbSlugs: ['cra-base-report'],
    accuracyRules: [
      'LendScore is in closed beta (as of 2026). Demos must explicitly call out beta status when surfacing eligibility messaging.',
      'Retrieve via /cra/check_report/lend_score/get after the standard CRA Check report-ready flow (USER_CHECK_REPORT_READY webhook).',
      'Score range: 1–99, higher = lower default risk. Response includes up to 5 reason_codes (e.g., "PCS0221") for adverse-action transparency.',
      'LendScore predicts 12-month default risk for non-mortgage lending; do not present as a generic credit score replacement.',
      'Pair with Base Report data on the same report to anchor the narrative.',
      'Use real Plaid Link CRA experience (single plaidPhase "launch"); do not simulate host-only Link.',
    ],
    critiqueRules: [
      'LendScore reveal should map the numeric score to a lender action (approve / review / decline) and surface at least one reason_code.',
      'Avoid claims like "replaces traditional credit bureau data" unless the prompt explicitly authorizes that positioning.',
    ],
  },
  cra_network_insights: {
    key: 'cra_network_insights',
    label: 'Plaid Check CRA Network Insights (beta)',
    kbSlugs: ['cra-base-report'],
    accuracyRules: [
      'Network Insights is in beta. Retrieve via /cra/check_report/network_insights/get after the CHECK_REPORT_READY webhook.',
      'Response includes network_attributes (key/value behavioral signals like plaid_conn_user_lifetime_lending_count, plaid_conn_user_lifetime_personal_lending_flag, plaid_conn_user_lifetime_cash_advance_primary_count) and items[] listing linked institutions.',
      'Network Insights leverages Plaid network behavior across BNPL, cash-advance, EWA, and other fintech connections — outputs are predictive signals, not bureau data.',
      'Demo should reveal one or two specific network_attributes tied to the underwriting decision narrative.',
      'Pair with Base Report or other CRA modules on the same report; the report expires after 24 hours.',
    ],
    critiqueRules: [
      'Network Insights demos should focus on the network signal advantage (visibility into non-bureau fintech behaviors), not on raw transaction or balance details — those belong in Base Report.',
    ],
  },
  cra_cashflow_insights: {
    key: 'cra_cashflow_insights',
    label: 'Plaid Check CRA Cash Flow Insights (beta)',
    kbSlugs: ['cra-base-report'],
    accuracyRules: [
      'Cash Flow Insights is in beta. Retrieve via /cra/check_report/cashflow_insights/get after the CHECK_REPORT_READY webhook.',
      'Response is keyed `attributes` (key/value pairs like cash_reliance_atm_withdrawal_amt_cv_90d, income volatility, NSF metrics, savings stability).',
      'Demos should surface 2–4 actionable attributes tied to the underwriting / cash-flow narrative; do not dump the full attribute list on screen.',
      'Use the standard CRA report flow (/user/create → CRA Link → /cra/check_report/create → webhook → /get).',
      'Pair with LendScore or Base Report when building underwriting narratives.',
    ],
    critiqueRules: [
      'Cash Flow Insights reveals should be specific (e.g., "income volatility low", "savings rate above peer median") rather than generic phrasing.',
    ],
  },
  cra_partner_insights: {
    key: 'cra_partner_insights',
    label: 'Plaid Check CRA Partner Insights (Prism-powered)',
    kbSlugs: ['cra-base-report'],
    accuracyRules: [
      'Partner Insights is a CRA add-on powered by Prism Data. Retrieve via /cra/check_report/partner_insights/get.',
      'Response includes Prism risk scores (CashScore, FirstDetect, Detect, Extend) each with score (1–999), reason codes, and metadata.',
      'Attribute partnership accurately: "Powered by Prism Data" in narration or explainer beats; do not present Prism scores as native Plaid scores.',
      'Use standard CRA flow (user_token, real Plaid Link CRA, async webhook).',
      'Common use case: supplement bureau data with Prism cash-flow risk for credit underwriting and BNPL.',
    ],
    critiqueRules: [
      'Partner Insights demos should anchor the score to a lender action (approve / decline / step-up) and surface reason codes for transparency.',
    ],
  },
  cra_cashflow_updates: {
    key: 'cra_cashflow_updates',
    label: 'Plaid Check CRA Cash Flow Updates / Monitoring (beta)',
    kbSlugs: ['cra-base-report'],
    accuracyRules: [
      'Cash Flow Updates delivers ongoing monitoring of cash flow, income, and loan exposure for a subscribed user (1–4 updates/day).',
      'Subscribe via /cra/monitoring_insights/subscribe; receive CASH_FLOW_INSIGHTS_UPDATED webhook; fetch via /cra/monitoring_insights/get; unsubscribe via /cra/monitoring_insights/unsubscribe.',
      'Use case is post-decision monitoring (servicing / early warning / income-refresh pre-close), not initial underwriting.',
      'Permissible-purpose framing must reflect monitoring (e.g., EXTENSION_OF_CREDIT) rather than original underwriting.',
      'Response includes aggregated/historical income, loan payment/disbursement metrics, account balances, inflows/outflows.',
    ],
    critiqueRules: [
      'Demos should emphasize the monitoring loop (subscribe → updates → action), not a one-time decision.',
    ],
  },
  cra_home_lending: {
    key: 'cra_home_lending',
    label: 'Plaid Check CRA Home Lending Report (early access)',
    kbSlugs: ['cra-base-report'],
    accuracyRules: [
      'Home Lending Report is in early-access / closed beta. Availability is limited; access requires Plaid Sales contact.',
      'Retrieve via /cra/check_report/verification/get with reports_requested (e.g., ["VOA", "EMPLOYMENT_REFRESH"]).',
      'Designed for mortgage VOA with Fannie Mae Day 1 Certainty and Freddie Mac LPA Asset and Income Modeler compatibility.',
      'Pairs Base Report (assets) with optional employment refresh and income modules.',
      'Use the standard CRA flow (/user/create → CRA Link → /cra/check_report/create with `cra_base_report` → webhook).',
    ],
    critiqueRules: [
      'Home Lending demos should explicitly tie the verification report back to GSE submission (e.g., D1C, LPA AIM) when that is the value prop.',
    ],
  },
  investments_move: {
    key: 'investments_move',
    label: 'Plaid Investments Move (ACATS / ATON brokerage transfers)',
    kbSlugs: [],
    accuracyRules: [
      'Investments Move uses /investments/auth/get to retrieve the data needed for ACATS (US) or ATON (Canada) brokerage transfers.',
      'Region: US and Canada only. Use case is brokerage-to-brokerage holdings transfer onboarding — NOT bank-to-bank money movement.',
      'Returned fields include account details, DTC numbers, current holdings, and owner information needed by the receiving broker.',
      'Enable via /link/token/create with `investments_auth` in products. Sandbox institution `ins_115616` (Vanguard) works for testing.',
      'Production access may require Plaid Sales contact; coverage is institution-dependent.',
    ],
    critiqueRules: [
      'Investments Move demos should emphasize transfer-form autofill and reduced onboarding abandonment, not generic portfolio viewing (that is the Investments product).',
    ],
  },
  investments: {
    key: 'investments',
    label: 'Plaid Investments (holdings + transactions data access)',
    kbSlugs: [],
    accuracyRules: [
      'Use /investments/holdings/get for current positions + security metadata, /investments/transactions/get for up to 24 months of buys/sells/dividends/fees.',
      'Investments is read-only data access — distinct from Investments Move (transfer initiation).',
      'Transactions endpoint requires start_date and end_date (YYYY-MM-DD) and supports count/offset pagination.',
      'Returned fields per holding include security (ticker, ISIN/CUSIP if enabled, type), quantity, cost_basis, value; per transaction includes amount, price, fees, type (buy/sell/dividend/transfer).',
      'Region: US and Canada. Enable via /link/token/create with `investments` in products.',
    ],
    critiqueRules: [
      'Investments demos should be PFM/wealth-tracking flavored (portfolio view, allocation, performance) — avoid implying transfer or trading execution capability.',
    ],
  },
  liabilities: {
    key: 'liabilities',
    label: 'Plaid Liabilities (credit card / student loan / mortgage debt data)',
    kbSlugs: [],
    accuracyRules: [
      'Use /liabilities/get with an access_token from a Link session that included `liabilities` in products.',
      'Response is organized into three arrays: credit[] (cards, PayPal credit), student[] (private student loans), mortgage[] (mortgages).',
      'Returned fields include APRs, last_payment_amount/date, last_statement_balance, minimum_payment_amount, next_payment_due_date, interest_rate_percentage, escrow_balance, has_pmi, property_address (mortgage), loan_status / repayment_plan (student), and account_id linking back to /accounts/get.',
      'Liabilities does NOT return granular credit card transaction history — pair with Plaid Transactions for that.',
      'Common use cases: debt consolidation, refinance, financial wellness, balance-transfer eligibility.',
    ],
    critiqueRules: [
      'Liabilities demos should surface specific fields (APR, minimum_payment, next_payment_due_date) rather than generic "we see your debts" claims.',
    ],
  },
  transactions: {
    key: 'transactions',
    label: 'Plaid Transactions (transaction sync + Personal Finance Categories)',
    kbSlugs: [],
    accuracyRules: [
      'Prefer /transactions/sync (cursor-based incremental) over /transactions/get (date-range, legacy) for new integrations.',
      '/transactions/sync returns added/modified/removed arrays + next_cursor + has_more. Loop on has_more until false; persist next_cursor server-side.',
      'Webhook SYNC_UPDATES_AVAILABLE fires when there are new transactions to sync.',
      'Returned per-transaction fields include amount (positive = outflow, negative = inflow), date, authorized_date, merchant_name, name (raw), payment_channel, personal_finance_category {primary, detailed}, location, logo_url, website, pending, counterparties[].',
      'Personal Finance Categories use the Plaid PFC taxonomy; map primary + detailed values for budgeting/dashboard surfaces.',
    ],
    critiqueRules: [
      'Transactions demos should show categorized data (PFC) and pending vs. posted state — that is the usability story; avoid dumping raw transaction lists.',
    ],
  },
  recurring_transactions: {
    key: 'recurring_transactions',
    label: 'Plaid Recurring Transactions (subscription & bill streams)',
    kbSlugs: [],
    accuracyRules: [
      'Use /transactions/recurring/get with an access_token; response includes inflow_streams[] (income/paychecks) and outflow_streams[] (bills/subscriptions).',
      'Each stream includes description, merchant_name, frequency (WEEKLY/MONTHLY/ANNUALLY/etc.), average_amount, last_amount, last_date, predicted_next_date, status (MATURE / EARLY_DETECTION / TOMBSTONED / UNKNOWN), is_active, personal_finance_category.',
      'Recurring is an add-on to Transactions and must be enabled via the Plaid Dashboard or sales contact.',
      'Region: US, CA, UK.',
      'Common UX: surface MATURE outflow streams as "subscriptions you can cancel", predicted_next_date as upcoming-bill alerts.',
    ],
    critiqueRules: [
      'Recurring demos should show specific streams (Netflix, rent, payroll) with cadence and predicted next date — generic "we found your subscriptions" copy is weak.',
    ],
  },
  enrich: {
    key: 'enrich',
    label: 'Plaid Enrich (categorize externally-held transactions)',
    kbSlugs: [],
    accuracyRules: [
      'Use /transactions/enrich for transaction data you already hold (your own banking app or non-Plaid sources). No Link or access_token required.',
      'Send up to 100 transactions per request with id, description, amount, direction (INFLOW/OUTFLOW), iso_currency_code.',
      'Response includes per-transaction enrichments {merchant_name, logo_url, website, location, personal_finance_category {primary, detailed}, payment_channel, counterparties[], entity_id, phone_number}.',
      'Categories use the Plaid PFC taxonomy (same as Transactions).',
      'Region: US and Canada. Available in all Plaid environments without onboarding Link.',
    ],
    critiqueRules: [
      'Enrich demos should illustrate the before/after value (raw "PURCHASE WM SUPERCENTER ..." vs. enriched "Walmart" + logo + category), not just abstract claims of enhancement.',
    ],
  },
  identity_verification: {
    key: 'identity_verification',
    label: 'Plaid Identity Verification (IDV — KYC, document + selfie)',
    kbSlugs: [],
    accuracyRules: [
      'Plaid Identity Verification (IDV) is the dedicated KYC product — distinct from /identity/get and /identity/match (those verify bank-account ownership).',
      'IDV endpoints live under /identity_verification/* (/create, /get, /list); flows are template-driven via templates configured in the Plaid Dashboard.',
      'Verification methods include phone/SMS, trusted-data-source KYC, government document upload (driver license / passport / national ID), selfie/liveness with document face match, watchlist (PEP + sanctions) screening, device/IP/email/phone risk.',
      'Two main workflow types: Lightning (data-source + phone) and Document (ID upload + selfie). Pick based on regulatory + UX tradeoff.',
      'Coverage spans ~190 countries; demo personas exist for sandbox testing (success / fail / pending_review).',
      'Statuses: active, success, failed, pending_review. Watchlist hits route to pending_review for human ops decision.',
    ],
    critiqueRules: [
      'IDV demos should surface specific verification artifacts (document type captured, match confidence, watchlist screening result) rather than a generic "verified" badge.',
      'Do not conflate IDV with Identity Match or Identity (those are bank-account-ownership products on a different family).',
    ],
  },
  transfer: {
    key: 'transfer',
    label: 'Plaid Transfer (multi-rail US payments: ACH, Same Day ACH, RTP, FedNow, wires)',
    kbSlugs: [],
    accuracyRules: [
      'Use /transfer/authorization/create first (returns approved / declined / user_action_required + authorization_id), then /transfer/create with the authorization_id to initiate.',
      'Supported rails: ACH, Same Day ACH, RTP (Real Time Payments), FedNow, wire. Choose via the network parameter or let Plaid route.',
      'Use /transfer/get and /transfer/list to read state; /transfer/event/sync for event-stream-style monitoring.',
      'Sandbox: simulate state changes via /sandbox/transfer/simulate and /sandbox/transfer/fire_webhook. Decisions are scaffold-driven (e.g., NSF for amount > balance).',
      'Region: US only. Transfer combines money movement with risk evaluation via Signal under the hood.',
      'For risk-free settlement on eligible debits, see the guaranteed_ach family (beta).',
    ],
    critiqueRules: [
      'Transfer demos should show the authorization → create → settled lifecycle and emphasize rail choice (instant via RTP/FedNow vs. standard ACH).',
    ],
  },
  guaranteed_ach: {
    key: 'guaranteed_ach',
    label: 'Plaid Guaranteed ACH (Transfer beta add-on)',
    kbSlugs: [],
    accuracyRules: [
      'Guaranteed ACH is a beta Plaid Transfer add-on that protects against fraud / clawback returns on eligible ACH debits.',
      'Eligibility is determined at /transfer/authorization/create time; the response indicates whether the transfer is covered by Plaid\'s guarantee.',
      'Use the same /transfer/* endpoint family as standard Transfer — there is no separate /guaranteed_ach/* path.',
      'Beta access is gated; demos should call out the beta status when value-propping the guarantee.',
      'Coverage applies only to eligible fraud and return types — review program terms before quoting absolute claims.',
    ],
    critiqueRules: [
      'Guaranteed ACH demos should anchor the value prop to the eligibility decision in /transfer/authorization/create — that is where the guarantee surfaces.',
    ],
  },
  monitor: {
    key: 'monitor',
    label: 'Plaid Monitor (KYC/AML watchlist screening)',
    kbSlugs: [],
    accuracyRules: [
      'Plaid Monitor screens individuals (and entities) against global sanctions and PEP watchlists for AML compliance.',
      'Create screenings via /watchlist_screening/individual/create (or /entity/create); retrieve via /individual/get; fetch hits via /individual/hit/list.',
      'Status values: `cleared` (no hits), `pending_review` (potential hit requires manual review), `rejected` (manually rejected).',
      'Re-screening can be automated by configuring a watchlist program in the Dashboard; webhooks fire when status changes or new hits surface.',
      'Pair Monitor with Identity Verification for full KYC onboarding (IDV verifies identity; Monitor screens against regulatory lists).',
    ],
    critiqueRules: [
      'Monitor demos should surface the actual lifecycle: onboarding → cleared / pending_review → ops decision → ongoing monitoring with periodic alerts.',
    ],
  },
  plaid_protect: {
    key: 'plaid_protect',
    label: 'Plaid Protect (fka Verify — anti-fraud + risk scoring umbrella)',
    kbSlugs: [],
    accuracyRules: [
      'Plaid Protect is the anti-fraud umbrella covering Account Score, Cash Advance Score, Pre-Auth Score, and Trust Index (and additional vertical-specific scores).',
      'Scores are delivered via /signal/evaluate (Plaid Signal API). Response keys vary by enabled scores; common ones: customer_initiated_return_risk, bank_initiated_return_risk, cash_advance_score, scores.* nested objects.',
      'Use /signal/decision/report to feed your decision + transaction outcome back to Plaid for score calibration.',
      'Ruleset evaluation (ACCEPT / REVIEW / REROUTE / REJECT) happens via Dashboard-configured rulesets, returned in `ruleset.result`.',
      'Trust Index is the term-of-art for Plaid\'s combined user-level fraud signal — do NOT use this term unless the prompt explicitly authorizes it (corresponds to a specific product configuration).',
      'Beta-status scores (e.g., specific vertical scores) require Plaid Sales / Account Manager enablement.',
    ],
    critiqueRules: [
      'Plaid Protect demos should anchor the score reveal to a concrete ruleset decision (ACCEPT / REVIEW / REROUTE / REJECT) and at least one reason or risk attribute, not just a numeric score.',
    ],
  },
  cash_advance_score: {
    key: 'cash_advance_score',
    label: 'Plaid Protect Cash Advance Score (instant disbursement / EWA risk)',
    kbSlugs: [],
    accuracyRules: [
      'Cash Advance Score is a Plaid Protect score predicting repayment likelihood for instant disbursement / earned-wage-access / small-dollar advance products.',
      'Surfaced as `cash_advance_score` (or similar score key) in /signal/evaluate responses; commonly paired with reason_codes explaining the score.',
      'Score range is documented as 1–99 (higher = better repayment likelihood). Confirm exact range with current Plaid docs — beta scores may vary.',
      'Demo personas: cash-advance lenders, neobanks offering earned-wage-access, gig-economy apps.',
      'Use /signal/decision/report after the disbursement decision to feed outcomes back for calibration.',
    ],
    critiqueRules: [
      'Cash Advance Score demos should show one score + 2–3 reason_codes tied to a disbursement decision; avoid generic "fraud check passed" framing.',
    ],
  },
};

/**
 * Full author prompt: explicit Primary product family + negation-safe keywords.
 * Short fragments (e.g. demoScript.product): keyword-only heuristic.
 */
function inferProductFamilyFromText(text = '') {
  const raw = String(text || '');
  if (
    /\*\*Primary product family\*\*/i.test(raw) ||
    /\*\*Compliance \/ user data/i.test(raw) ||
    raw.length > 400
  ) {
    return getEffectiveProductFamily(raw);
  }
  return inferProductFamilyFromKeywordsOnly(raw);
}

function inferProductFamily({ promptText = '', demoScript = null, productResearch = null } = {}) {
  if (promptText) {
    const fromPrompt = getEffectiveProductFamily(promptText);
    if (fromPrompt !== 'generic') return fromPrompt;
  }
  const sources = [];
  if (productResearch?.product) sources.push(productResearch.product);
  if (productResearch?.synthesizedInsights) sources.push(productResearch.synthesizedInsights);
  if (demoScript?.product) sources.push(demoScript.product);
  if (Array.isArray(demoScript?.steps)) {
    for (const step of demoScript.steps) {
      if (step?.apiResponse?.endpoint) sources.push(step.apiResponse.endpoint);
      if (step?.label) sources.push(step.label);
      if (step?.visualState) sources.push(step.visualState);
    }
  }
  for (const source of sources) {
    const family = inferProductFamilyFromKeywordsOnly(source);
    if (family !== 'generic') return family;
  }
  return 'generic';
}

function getProductProfile(family) {
  return PRODUCT_FAMILIES[family] || PRODUCT_FAMILIES.generic;
}

module.exports = {
  PRODUCT_FAMILIES,
  inferProductFamilyFromText,
  inferProductFamily,
  getProductProfile,
};
