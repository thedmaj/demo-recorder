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
      'When the demo includes POST /signal/evaluate, Link token products MUST include "signal" alongside auth/identity (e.g. ["auth", "identity", "signal"]). "signal" is a valid /link/token/create product string since Oct 2024 — not a post-Link-only flag.',
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
    kbSlugs: ['cra-lend-score', 'cra-base-report'],
    accuracyRules: [
      'LendScore is in closed beta (as of 2026). Demos must explicitly call out beta status when surfacing eligibility messaging.',
      'Retrieve via POST /cra/check_report/lend_score/get after the standard CRA Check report-ready flow (USER_CHECK_REPORT_READY webhook).',
      'Score range: 1–99, higher = lower default risk. Response field: report.lend_score.score with report.lend_score.reason_codes[] (up to 5 PCS-prefixed codes) — not Signal reason_codes shape.',
      'apiResponse.endpoint on the LendScore reveal host step MUST be POST /cra/check_report/lend_score/get (not /base_report/get) even when Base Report summary chips appear on screen.',
      'Host LendScore step layout: reserve ~520px right margin for #api-response-panel; data-testid="approve-plan-cta" fully visible; show LendScore — beta badge.',
      'LendScore predicts 12-month default risk for non-mortgage lending; do not present as a generic credit score replacement.',
      'Pair with Base Report summary on the same screen when narrated; optional Network Insights on a following slide.',
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
    kbSlugs: ['cra-base-report', 'cra-cashflow-insights'],
    accuracyRules: [
      'Cash Flow Insights is in beta. Retrieve via /cra/check_report/cashflow_insights/get after the CHECK_REPORT_READY webhook.',
      'Response `report.attributes` is an object/map of attribute keys to numbers or booleans (e.g. cash_reliance_atm_withdrawal_amt_cv_90d, income_volatility_low) — not an array of name/value pairs.',
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
    label: 'Plaid Investments Move (ACATS / ATON brokerage transfer initiation) — Early Availability',
    kbSlugs: ['plaid-investments-move'],
    // Verified via AskBill (Plaid docs MCP) + Glean (GTM Playbook Feb 27 2026)
    // on 2026-05-21. See inputs/products/plaid-investments-move.md.
    accuracyRules: [
      "Investments Move is the brokerage TRANSFER-INITIATION product (ACATS US / ATON Canada). It is NOT the same as standard Plaid Investments (holdings/transactions data access). The two products have DIFFERENT Link product strings, DIFFERENT endpoints, and DIFFERENT response shapes.",
      "Link products: ['investments_auth'] — exactly. Do NOT use 'investments' (that's the data-access product) and do NOT use 'investments_move' (not a Plaid Link product string).",
      "Canonical endpoint: POST /investments/auth/get. Request body: { access_token } (with optional account filter). Do NOT call /investments/holdings/get or /investments/transactions/get — those are the data-access endpoints.",
      "Response includes: accounts, holdings, securities, owners (for ACATS name matching), and numbers.acats[] with { account, account_id, dtc_numbers[] } for the receiving broker. Also includes data_sources indicating INSTITUTION (high confidence) vs scrape fallback.",
      "No /user/create bootstrap required. Standard Link flow.",
      "Webhooks: there are NO Investments Move-specific webhooks. The flow reuses generic Item webhooks. Do NOT fabricate INVESTMENTS_AUTH_READY or similar event names.",
      "Region: US (ACATS) is supported in Early Availability. Canada (ATON) is NOT GA — internal target is June 2027. Do not promise current ATON support to prospects.",
      "Status: Early Availability, gated via LaunchDarkly by the customer's Plaid Account Manager. Requires Plaid Sales engagement plus a mandatory 6-month data-partner reciprocity build commitment.",
      "Sandbox institution: ins_115616 (Vanguard) with user_good / pass_good credentials.",
      "Pricing (internal): per-call billing event 'investments-auth-request', $20 rack / $8–13 typical; manual / fallback responses are NOT billed.",
      "Latency (internal): ~14s API path / ~50s screen-scrape fallback; 70–80% of production traffic resolves via API.",
      "Customer references safe for public citation: Robinhood, Public, Frec, Stash. Robinhood case-study stats ('90% decrease in ACATS failures, 300% increase in successful transfers') are Plaid-marketing approved.",
    ],
    critiqueRules: [
      "Investments Move demos must show the TRANSFER-INITIATION outcome (account number + DTC + 2-3 holdings → transfer form autofilled), not portfolio viewing or allocation analytics (those are Investments demos).",
      "API panel must show /investments/auth/get with the documented response shape: numbers.acats[].dtc_numbers, owners, holdings. NEVER show /investments/holdings/get or /investments/transactions/get — wrong product.",
      "Narration must NEVER use 'investments_move' as a Plaid Link product string. The product family name in the prompt is 'investments_move', but the wire format is 'investments_auth'.",
      "Do not invent webhook event names — the flow reuses generic Item webhooks.",
      "Do not show ATON Canada as available today.",
    ],
  },
  investments: {
    key: 'investments',
    label: 'Plaid Investments (holdings + transactions data access) — GA',
    kbSlugs: ['plaid-investments'],
    // Verified via AskBill (Plaid docs MCP) + Glean (Tom Donovan one-pager
    // May 2026, Empower / Yodlee replacement case) on 2026-05-21. See
    // inputs/products/plaid-investments.md.
    accuracyRules: [
      "Plaid Investments is the READ-ONLY DATA ACCESS product (portfolio holdings + investment transaction history). It is NOT the same as Plaid Investments Move (brokerage transfer initiation). The two products have DIFFERENT Link product strings, DIFFERENT endpoints, and DIFFERENT use cases.",
      "Link products: ['investments'] — exactly. Do NOT use 'investments_auth' (that's the transfer-initiation product).",
      "Canonical endpoints:\n  - POST /investments/holdings/get → current positions + securities metadata (synchronous; 1–2 min on first post-Link call)\n  - POST /investments/transactions/get → up to 24 months of investment transactions (buys, sells, dividends, fees); start_date + end_date required (YYYY-MM-DD); pagination via options.count + options.offset.\n  Do NOT call /investments/auth/get — that's Investments Move.",
      "Holdings response includes per-holding: security_id, quantity, institution_value, cost_basis (AGGREGATE only — no per-lot tax data is documented; tax-prep demos must disclose this gap). Securities response includes ticker_symbol, cusip/isin, type.",
      "Transactions response includes per-transaction: amount, price, fees, type, subtype (subtypes like 'short-term capital gain' and 'long-term capital gain' appear where the institution labels them), date.",
      "Webhooks (LITERAL names — do NOT paraphrase): HOLDINGS:DEFAULT_UPDATE (new/changed positions detected), INVESTMENTS_TRANSACTIONS:DEFAULT_UPDATE (new/canceled transactions), INVESTMENTS_TRANSACTIONS:HISTORICAL_UPDATE (first historical pull complete when products are added post-Link with async_update=true).",
      "Region: US and Canada. Status: GA.",
      "Per-Item subscription pricing; Holdings and Transactions are separately subscribed.",
      "Coverage (internal): 2,500+ US institutions, ~95% of US investment accounts. 10 of the top 30 brokerages on the API path; Vanguard + Schwab migrated to API in 2025. Fidelity Investments is request-gated — confirm enablement before pitching Fidelity-heavy prospects.",
      "Customer reference (public): Empower (formerly Personal Capital). Internal flagship: Empower replaced Yodlee FastLink with Plaid Investments for $1.999M ACV (Closed Won Dec 2025). Main competitor on this product line is Yodlee.",
    ],
    critiqueRules: [
      "Investments demos should be PFM / wealth-tracking flavored (portfolio view, allocation, performance, net worth) — NOT transfer initiation (that's Investments Move).",
      "API panel must show /investments/holdings/get OR /investments/transactions/get — NEVER /investments/auth/get (wrong product).",
      "Do not show account numbers / DTC codes — those are Investments Move outputs, not in the standard Investments response.",
      "Do not show per-lot tax data — cost basis is aggregate only in the documented response.",
      "Webhook references must use the literal documented names (HOLDINGS:DEFAULT_UPDATE etc.), never paraphrased forms.",
    ],
  },
  liabilities: {
    key: 'liabilities',
    label: 'Plaid Liabilities (credit card / private student loan / mortgage debt data; non-FCRA)',
    kbSlugs: ['plaid-liabilities'],
    // Verified via AskBill (Plaid docs MCP) + Glean (Financial Management
    // Playbook Mar 2026, Liabilities One-Pager Oct 2025, Liabilities FAQ
    // Confluence Aug 2024) on 2026-05-21. See inputs/products/plaid-liabilities.md.
    accuracyRules: [
      "Plaid Liabilities is the READ-ONLY DEBT-DATA product (credit cards, private student loans, mortgages). It is NON-FCRA — Liabilities data CANNOT be used for underwriting / lending decisioning. For FCRA-compliant debt data in lending workflows, use Plaid Check / CRA Base Report instead. Internal Solutions Engineering rule: 'Use Transactions, Investments, and Liabilities for personal finance and money management use cases (non-lending); CRA products are for FCRA-regulated credit decisioning.'",
      "Link products: ['liabilities'] — exactly. No /user/create bootstrap. Standard Link flow.",
      "Endpoint: POST /liabilities/get. Body: { access_token, options?: { account_ids?: string[] } }. Response: { accounts, liabilities: { credit[], student[], mortgage[] }, item, request_id }.",
      "Refresh model: /liabilities/get returns a CACHED snapshot refreshed ~once per day in the background. NOT live. If the narrative requires real-time freshness (e.g. 'we just saw your payment'), pair with Transactions and source the freshness signal from /transactions/sync.",
      "Credit-card fields per liabilities.credit[] entry: account_id, aprs[] (each with apr_percentage, apr_type ∈ {purchase_apr, balance_transfer_apr, cash_apr, special}, balance_subject_to_apr, interest_charge_amount), is_overdue, last_payment_amount, last_payment_date, last_statement_issue_date, last_statement_balance, minimum_payment_amount, next_payment_due_date.",
      "Mortgage fields per liabilities.mortgage[] entry: account_id, account_number, current_late_fee, escrow_balance, has_pmi, has_prepayment_penalty, interest_rate { percentage, type ∈ {fixed,variable} }, last_payment_amount, last_payment_date, loan_term, loan_type_description, maturity_date, next_monthly_payment, next_payment_due_date, origination_date, origination_principal_amount, past_due_amount, property_address { city, street, region, postal_code, country }, ytd_interest_paid, ytd_principal_paid.",
      "Student-loan fields per liabilities.student[] entry: account_id, account_number, disbursement_dates[], expected_payoff_date, guarantor, interest_rate_percentage, is_overdue, last_payment_amount, last_payment_date, last_statement_balance, last_statement_issue_date, loan_name, loan_status { end_date, type ∈ {repayment,deferment,in_school,...} }, minimum_payment_amount, next_payment_due_date, origination_date, origination_principal_amount, outstanding_interest_amount, payment_reference_number, pslf_status { estimated_eligibility_date, payments_made, payments_remaining }, repayment_plan { description, type }, sequence_number, servicer_address, ytd_interest_paid, ytd_principal_paid.",
      "Webhook (literal name — do NOT paraphrase): LIABILITIES:DEFAULT_UPDATE. Payload includes account_ids_with_new_liabilities[] and account_ids_with_updated_liabilities (object mapping account_id → array of changed field names).",
      "CRITICAL — Stop Act federal-student-loan block (Aug 23, 2024, verified via Glean Liabilities FAQ + customer comms): Plaid LOST access to all federal student loan servicers — Mohela, Aidvantage, EdFinancial, Nelnet, Central Research Inc (CRI). Plaid stopped billing customers for those items. Demos must NEVER reference federal-servicer data; it will not work in production. Public marketing on plaid.com/products/liabilities dropped student loans from the headline as a result.",
      "Coverage by liability type (May 2026): ~98% credit cards (Amex, Chase, Citi, WF, BofA, Synchrony retail cards); ~60% mortgages (BofA, Chase, USB, WF, Rocket); private student loans only (Sallie Mae, Discover, Wells Fargo Education, PHEAA, CornerStone/UHEAA); NO federal student loans (see Stop Act); weak auto-loan coverage.",
      "Data quirks to disclose when present: Sallie Mae (ins_116944) balance.current includes principal + outstanding interest (not just principal); outstanding_interest_amount returns null. Great Lakes / Firstmark / Commonbond / Granite State / Oklahoma share a single minimum_payment_amount across all loans on the same account number (cannot sum per-loan minimums). persistent_account_id is returned for Chase, PNC, US Bank as of May 2025 — useful for de-duping accounts across Items.",
      "Region: US strong, Canada limited.",
      "Pricing (internal): subscription model, per-Item per-month; rack $0.20, ASP $0.07–$0.13, in-flight enterprise $0.18 (Wallit Apr 2026); SoFi negotiated 55–88% off rack at scale.",
      "Customer references safe for public citation: SoFi ($850k ARR — flagship), Copilot Money, LendingTree, OpenAI / ChatGPT Personal Finance (launched May 15, 2026). Internal-only roster: Monarch Money, YNAB, Rocket Money, Wealthfront, Betterment, DoorDash Crimson (active May 2026).",
      "Common LIT bundle pattern: products: ['liabilities', 'transactions', 'investments'] on one Link token. Each product retrieved via its own endpoint after Link. Canonical positioning: 'Net worth = Investments (assets) − Liabilities (debts).' Use /transactions/sync (cursor-based incremental) over /transactions/get (legacy date-range) in new integrations.",
    ],
    critiqueRules: [
      "Liabilities demos should surface SPECIFIC named fields (APR percentage + APR type, minimum_payment_amount, next_payment_due_date, interest_rate.percentage for mortgages, repayment_plan.type for student loans) rather than generic 'we see your debts' claims.",
      "Demos must NOT use Liabilities in lending / underwriting / approval-decision narratives — that is the CRA Base Report territory. Liabilities is non-FCRA. If the prompt is about underwriting, route to family cra_base_report.",
      "Demos must NOT reference federal-student-loan servicers (Mohela, Nelnet, Aidvantage, EdFinancial, Great Lakes, FedLoan, CRI) — access was lost in the Stop Act (Aug 2024). Use private servicers (Sallie Mae, Discover) or stick to credit cards + mortgages.",
      "Webhook references must use the literal LIABILITIES:DEFAULT_UPDATE (type + code); never paraphrased as LIABILITIES_UPDATE_AVAILABLE or similar.",
      "Do not promise real-time freshness — Liabilities is daily-refreshed cache. If the narrative needs 'just paid' freshness, pair with /transactions/sync.",
      "Sallie Mae balance quirk and Great Lakes minimum_payment-shared quirk must be acknowledged in narration if those institutions appear in the demo data.",
      "Do not invent a reason_codes[] or explanation[] array — the documented fields are the documented fields.",
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
    label: 'Plaid Protect (anti-fraud + identity risk-scoring umbrella; Trust Index in Limited Availability)',
    kbSlugs: ['plaid-protect'],
    // Verified via AskBill (Plaid docs MCP) + Glean (internal GTM Playbook
    // 2026, Ti2 Deep Dive) on 2026-05-21. See inputs/products/plaid-protect.md
    // for the canonical reference.
    accuracyRules: [
      "Plaid Protect is an UMBRELLA solution, not a single API. It packages Trust Index / Ti2, Plaid Signal, IDV, Monitor, and Dashboard rulesets under one contract.",
      "There is NO 'protect' product string for /link/token/create. Use component strings: 'protect_linked_bank' (US-only, default for Trust Index demos), 'identity_verification', 'signal', 'monitor', 'protect_transactions' as needed.",
      "Trust Index is NOT retrieved via POST /signal/evaluate. AskBill + Glean Protect Megadoc: canonical retrieval is POST /protect/event/send (after Link, event_type LINK_SESSION_END, request_trust_index true) or POST /protect/user/insights/get. Response carries trust_index.{score, model, subscores} and optional fraud_attributes. Score 1–100, higher = SAFER.",
      "Trust Index initialization: POST /user/create for user_id, Link with protect_linked_bank, then POST /protect/event/send with link_session_id from onSuccess metadata. Optional early-funnel Protect SDK + /protect/client/session/* for TI Device.",
      "Do NOT add 'signal' to Link products[] for Trust Index-only demos. Add 'signal' only when the prompt explicitly shows POST /signal/evaluate as a separate transaction-scoring beat.",
      "POST /signal/evaluate is the Plaid SIGNAL component only — returns scores.*, core_attributes, ruleset — never trust_index. Use only when the demo explicitly includes transaction-time Signal; see inputs/products/plaid-signal.md.",
      "Signal path: ruleset.result ACCEPT / REROUTE / REVIEW (REJECT not documented); explainability via core_attributes + ruleset.triggered_rule_details.internal_note — no reason_codes[] array. Feedback: POST /signal/decision/report.",
      "Signal webhooks (literal): SIGNAL_SCORE_READY, SIGNAL_RULE_TRIGGERED. Protect TI async completion: PROTECT_USER_EVENT or VERIFY_USER_EVENT (not SIGNAL_SCORE_READY unless Signal is also integrated).",
      "Trust Index / Ti2: LIMITED AVAILABILITY. Subscores documented for demos: device, identity, transaction_graph. Plaid Sales enablement required.",
      'Internal GTM (Glean): Albert, Credit Genie, Cash App (POC); pipeline Gemini, Cherry, Revolut, Oportun, Kalshi, Tilt Protect. Native mobile Protect SDKs May 2026.',
    ],
    critiqueRules: [
      "Trust Index hero steps must show POST /protect/event/send or /protect/user/insights/get JSON with trust_index.score — not /signal/evaluate with scores.bank_initiated_return_risk labeled as Trust Index.",
      "Do NOT conflate ruleset.result ACCEPT (Signal) with Trust Index approval. Host UI may say 'Trust Index — 87 — Approve' from trust_index.score thresholds.",
      "Do NOT show reason_codes[] on either API. Signal uses core_attributes + internal_note; Trust Index uses subscores + fraud_attributes.",
      "Do NOT mix Cash Advance Score (family cash_advance_score, /signal/evaluate scores.cash_advance) with Trust Index demos unless the prompt explicitly compares both products in separate API panels.",
      "If Signal is included as a secondary beat, label the API panel endpoint clearly — two panels or two beats, never one blended JSON.",
    ],
  },
  cash_advance_score: {
    key: 'cash_advance_score',
    label: 'Plaid Protect Cash Advance Score / EWA Score (instant disbursement risk)',
    kbSlugs: ['ewa-score'],
    // Verified via AskBill (Plaid docs MCP) 2026-05-21.
    accuracyRules: [
      'Cash Advance Score (EWA Score) is a Plaid Protect score delivered through the Plaid Signal API — NOT a CRA / Consumer Report product. Do not mix it with Plaid Check (cra_base_report, cra_income_insights) or with /user/create bootstrapping.',
      'Link token products MUST be ["auth", "signal"]. "signal" was added to /link/token/create products as of October 2024; it is a valid Link product string, not a Signal-internal flag.',
      'No /user/create bootstrap is required (unlike Bank Income). Standard /link/token/create + /item/public_token/exchange flow.',
      'Score retrieval endpoint is POST /signal/evaluate. There is NO /protect/* endpoint and NO /cra/cash_advance/get or /credit/cash_advance/get endpoint — those are not in public docs.',
      '/signal/evaluate request body: { access_token, account_id, client_transaction_id, amount, user?, device?, ruleset_key? }. Reuse the same /signal/decision/report endpoint as standard Signal for outcome calibration with { client_transaction_id, initiated }.',
      'Cash Advance Score is read at response.scores.cash_advance.score (when provisioned by Plaid Sales on the account). The shared Signal scores response also includes scores.customer_initiated_return_risk.score and scores.bank_initiated_return_risk.score. Score range is 1–99 where HIGHER = HIGHER RISK (same direction convention as standard Signal — do NOT invert).',
      'If Cash Advance Score is not provisioned, the cash_advance key is absent from /signal/evaluate. Fallback for EWA repayment-risk decisions is response.scores.bank_initiated_return_risk.score (lower = lower risk → approve advance).',
      'There is NO documented `reason_codes` array on /signal/evaluate responses. Explainability is available through `core_attributes` (key/value behavioral signals) and `ruleset.triggered_rule_details.internal_note` from your configured ruleset. Reason-code framing in narration must be presented as ruleset rule names or core_attributes — never invented as a top-level reason_codes array.',
      'ruleset_key controls scoring policy/actions, not enablement; the Cash Advance Score field appears under any ruleset once Sales has enabled it.',
      'Demo personas: cash-advance / EWA apps, neobanks offering early-wage access, gig-economy fintechs.',
    ],
    critiqueRules: [
      'EWA / Cash Advance Score demos must NOT use the standard Plaid Signal ACH return-risk narrative ("Signal score X — ACCEPT" with low score = accept). EWA framing should approve a SPECIFIC advance amount based on cash_advance score + a ruleset decision.',
      'On-screen score should be presented as repayment / cash-advance risk, not ACH return risk. If the score field is bank_initiated_return_risk fallback, narration must say so honestly (e.g. "Plaid Signal evaluation, bank-initiated return risk").',
      'Do NOT show a fabricated `reason_codes: [...]` array in the API panel — that field is not documented. Show 2–3 ruleset rule names or named core_attributes instead.',
      'Do NOT route EWA demos through Plaid Check / CRA setup (no /user/create, no consumer_report_permissible_purpose, no cra_options).',
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
