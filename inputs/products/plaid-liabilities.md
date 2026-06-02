---
last_vp_research: "2026-05-21"
last_api_verified: "2026-05-31"
last_ai_update: "2026-05-31T00:00:00Z"
sources:
  - "AskBill plaid_docs MCP — https://plaid.com/docs/liabilities/"
  - "Glean: Plaid Liabilities One-Pager (Oct 2025), Financial Management Playbook (Mar 2026), Yodlee Battle Card, SoFi Account Plan Q1 2026, Liabilities FAQ Confluence (Aug 2024), customer-comms emails"
---

# Plaid Liabilities

> **Product family key:** `liabilities`
> **Status (May 2026):** **GA** in the US. Limited coverage in Canada. Subscription-billed (per-Item per-month).
> **Solution area:** Personal Finance Insights (alongside Transactions, Investments, Enrich) — NOT lending / underwriting.
> **Public marketing headline:** *"Credit card and mortgage data"* — student loans deliberately dropped from the headline (see Stop Act caveat below).

## Overview
Plaid Liabilities provides read-only, consumer-permissioned access to debt-account details: credit cards (including PayPal Credit), private student loans, and mortgages. Data is fetched via `POST /liabilities/get` using the `"liabilities"` Link product and is refreshed approximately once per day (not live). Federal student loans are NOT available since August 2024 (Stop Act). Non-FCRA — not for credit decisioning.

## Where It Fits
Feature Liabilities for PFM, debt-paydown, loan consolidation, and net-worth dashboard use cases. Best featured in the LIT bundle (Liabilities + Investments + Transactions) for a complete financial picture. Never position Liabilities for underwriting or credit decisions — that requires CRA Base Report. Avoid demoing federal student loan servicer data (Mohela, Nelnet, Aidvantage, EdFinancial, CRI) — not accessible since Aug 2024.

## What Plaid Liabilities is

Read-only access to debt-account details for consumer-permissioned use cases: **credit cards (incl. PayPal Credit), private student loans, and mortgages**. Common applications: debt-paydown apps, cash-flow management, loan consolidation calculators, balance-transfer eligibility, net-worth dashboards. Internal Solutions Engineering positioning (Oct 2025): *"For personal finance and money management use cases (non-lending), use Transactions, Investments, and Liabilities. CRA products are specifically for FCRA-regulated credit decisioning, not general-purpose financial wellness features."*

> **Hard rule (often missed):** *"Student loans and credit card details provided by Liabilities cannot be used for underwriting and decisioning."* The data is **non-FCRA**. CRA Base Report is the FCRA counterpart for lending workflows.

## ⚠ Stop Act federal-student-loan caveat (REQUIRED reading)

**Verified via Glean** (Liabilities FAQ updated 2024-08-27 + customer-comms email to Peanut Butter):

> *"Over the last couple weeks and culminating on Friday, August 23, 2024, we lost access to all Federal student loan servicers that Plaid maintains an integration with. This is the result of activities outside of Plaid's operations."*

- **Institutions NO LONGER accessible** via Plaid Link for Liabilities: **Mohela, Aidvantage, EdFinancial, Nelnet, Central Research Inc (CRI)**.
- Plaid **stopped billing customers** for impacted federal student loan items.
- Public docs (`plaid.com/products/liabilities`) silently dropped the student-loan claim from the headline marketing — only credit cards and mortgages remain in the "98% coverage" claim.
- **Demo rule:** NEVER show Mohela / Nelnet / FedLoan / Great Lakes / Aidvantage / EdFinancial data in a Liabilities demo. The demo will not work in production. Use **private student loan servicers** (Sallie Mae, Discover Student Loans, Wells Fargo Education, PHEAA, CornerStone/UHEAA) — or stick to credit cards + mortgages.

The pre-Stop-Act marketing claims (Navient/Nelnet/Great Lakes/FedLoan as core supported servicers) appear in many 2019-2023 blog posts and pitch decks. **Those claims are no longer true.**

## Documented public API surface

### `/link/token/create`

```json
{
  "client_name": "<BrandName>",
  "products": ["liabilities"],
  "user_id": "demo-user-001",
  "country_codes": ["US"],
  "language": "en"
}
```

- Literal product string: **`liabilities`**.
- No `/user/create` bootstrap.
- Standard Link flow.

### `/liabilities/get`

```json
{
  "client_id": "...",
  "secret": "...",
  "access_token": "access-sandbox-...",
  "options": {
    "account_ids": ["..."]
  }
}
```

`options.account_ids` is optional — used to restrict the response to specific Liabilities-eligible accounts.

### Response structure

```json
{
  "accounts": [ /* every account on the Item */ ],
  "liabilities": {
    "credit":   [ /* credit cards, PayPal Credit */ ],
    "student":  [ /* private student loans */ ],
    "mortgage": [ /* mortgages */ ]
  },
  "item": { ... },
  "request_id": "..."
}
```

#### Credit-card fields (per entry in `liabilities.credit[]`)

| Field | Type | Notes |
|---|---|---|
| `account_id` | string | Links back to `/accounts/get` |
| `aprs` | array | Multiple APRs per card (purchase, balance transfer, cash, special). Each entry has `apr_percentage`, `apr_type`, `balance_subject_to_apr`, `interest_charge_amount` |
| `is_overdue` | boolean (nullable) | Payment overdue flag |
| `last_payment_amount` | number (nullable) | |
| `last_payment_date` | string (nullable) | ISO date |
| `last_statement_issue_date` | string (nullable) | |
| `last_statement_balance` | number (nullable) | |
| `minimum_payment_amount` | number (nullable) | Next-cycle minimum |
| `next_payment_due_date` | string (nullable) | |

#### Mortgage fields (per entry in `liabilities.mortgage[]`)

| Field | Type | Notes |
|---|---|---|
| `account_id` | string | |
| `account_number` | string (nullable) | |
| `current_late_fee` | number (nullable) | |
| `escrow_balance` | number (nullable) | |
| `has_pmi` | boolean (nullable) | PMI flag |
| `has_prepayment_penalty` | boolean (nullable) | |
| `interest_rate` | object (nullable) | `{ percentage: number, type: 'fixed' \| 'variable' }` |
| `last_payment_amount` | number (nullable) | |
| `last_payment_date` | string (nullable) | |
| `loan_term` | string (nullable) | e.g., `"30 year"` |
| `loan_type_description` | string (nullable) | e.g., `"conventional"` |
| `maturity_date` | string (nullable) | |
| `next_monthly_payment` | number (nullable) | |
| `next_payment_due_date` | string (nullable) | |
| `origination_date` | string (nullable) | |
| `origination_principal_amount` | number (nullable) | |
| `past_due_amount` | number (nullable) | |
| `property_address` | object (nullable) | `{ city, street, region, postal_code, country }` |
| `ytd_interest_paid` | number (nullable) | |
| `ytd_principal_paid` | number (nullable) | |

#### Student-loan fields (per entry in `liabilities.student[]`)

| Field | Type | Notes |
|---|---|---|
| `account_id` | string | |
| `account_number` | string (nullable) | |
| `disbursement_dates` | array (nullable) | Dates funds were/will be disbursed |
| `expected_payoff_date` | string (nullable) | |
| `guarantor` | string (nullable) | |
| `interest_rate_percentage` | number | |
| `is_overdue` | boolean (nullable) | |
| `last_payment_amount` | number (nullable) | |
| `last_payment_date` | string (nullable) | |
| `last_statement_balance` | number (nullable) | |
| `last_statement_issue_date` | string (nullable) | |
| `loan_name` | string (nullable) | e.g., `"Consolidation"` |
| `loan_status` | object (nullable) | `{ end_date, type }` where `type ∈ { repayment, deferment, in_school, ... }` |
| `minimum_payment_amount` | number (nullable) | See Great-Lakes shared-minimum quirk below |
| `next_payment_due_date` | string (nullable) | |
| `origination_date` | string (nullable) | |
| `origination_principal_amount` | number (nullable) | |
| `outstanding_interest_amount` | number (nullable) | See Sallie Mae quirk below |
| `payment_reference_number` | string (nullable) | |
| `pslf_status` | object (nullable) | `{ estimated_eligibility_date, payments_made, payments_remaining }` |
| `repayment_plan` | object (nullable) | `{ description, type }` where `type ∈ { standard, graduated, income-based repayment, ... }` |
| `sequence_number` | string (nullable) | |
| `servicer_address` | object (nullable) | `{ city, street, region, postal_code, country }` |
| `ytd_interest_paid` | number (nullable) | |
| `ytd_principal_paid` | number (nullable) | |

#### Webhook

| Type | Code | Fires when |
|---|---|---|
| `LIABILITIES` | `DEFAULT_UPDATE` | New or updated liabilities detected. Payload includes `account_ids_with_new_liabilities[]` and `account_ids_with_updated_liabilities` (an object mapping account_id → array of changed field names). |

`user_id` was added to the webhook payload in 2025-2026 alongside other webhook user_id additions.

#### Refresh model

- **NOT live.** `/liabilities/get` returns a **cached snapshot**.
- Background refresh runs **about once per day** at the institution level.
- Demo timing: do not promise real-time freshness; pair with Transactions if the narrative requires "we saw your payment land."

## Data quirks (disclose in narration when present)

| Institution(s) | Quirk |
|---|---|
| **Sallie Mae** (`ins_116944`) | `balance.current` includes principal + outstanding interest (not just principal as for other servicers); `outstanding_interest_amount` returns `null` |
| **Great Lakes / Firstmark / Commonbond / Granite State / Oklahoma** | Single `minimum_payment_amount` shared across ALL loans on the same account number — cannot sum per-loan minimums |
| **Chase / PNC / US Bank** | Return `persistent_account_id` (added May 2025) — useful for de-duping accounts across Items |

## Sandbox

- Liabilities is available in Sandbox with realistic mock data for credit, mortgage, and student loans.
- Use [github.com/plaid/sandbox-custom-users](https://github.com/plaid/sandbox-custom-users/) for specific scenarios (e.g., a custom student-loan structure).
- Default sandbox credentials (`user_good` / `pass_good`) work — see `inputs/plaid-link-sandbox.md`.

## Coverage (May 2026)

| Liability type | Coverage | Notes |
|---|---|---|
| **Credit cards** | ~98% of major US institutions | Amex, Chase, Citi, Wells Fargo, BofA, **Synchrony retail cards (Walmart, Amazon, Sam's Club)** — strong |
| **Mortgages** | ~60% of US mortgage accounts (internal estimate; public site bundles into 98%) | BofA, Chase, U.S. Bank, Wells Fargo, **Rocket Mortgage** — partial coverage |
| **Private student loans** | Sallie Mae, Discover Student Loans, Wells Fargo Education, PHEAA, CornerStone/UHEAA | Sallie Mae has had multi-month outages (early 2026 — see SoFi $850k ARR risk note) |
| **Federal student loans** | ❌ **NOT AVAILABLE** since Aug 23, 2024 (Stop Act) | See caveat above |
| **Auto loans** | Poor | *"Coverage for auto loans is not as good because they are often sold to servicers that do not make their loans available to open banking providers."* — Tom Donovan, May 2026 |
| **Region** | US strong; Canada limited | |

## Customer Use Cases

- Net-worth dashboard (LIT bundle): `products: ["liabilities", "transactions", "investments"]` on one Link token; assets − debts = net worth in real time
- Debt-paydown coaching: APR, minimum payment, and due date from `/liabilities/get`; Avalanche/snowball recommendation based on actual APRs
- Balance transfer eligibility: credit card balances, APRs, and utilization in a consumer-permissioned flow (non-FCRA, non-underwriting)

### Net-Worth Dashboard (LIT Bundle)
**Persona:** Consumer using a PFM or wealth app wanting a complete financial picture
**Problem:** Assets, debts, and spending tracked in separate tools with no unified net-worth view
**Solution:** LIT bundle — `products: ["liabilities", "transactions", "investments"]` on one Link token; three endpoints for debts, spending, and holdings
**Outcome:** Real-time net-worth = investments (assets) − liabilities (debts); SoFi, Monarch Money, YNAB, ChatGPT Personal Finance use this pattern

### Debt-Paydown Coaching
**Persona:** Consumer using a debt-paydown or loan consolidation app
**Problem:** Users need APR, minimum payments, and due dates for all debts in one place to make payoff decisions
**Solution:** `/liabilities/get` returns per-account APR, minimum payment, next due date, and last statement balance for credit cards and mortgages
**Outcome:** Avalanche or snowball payoff recommendation based on actual APRs; "Pay off your Synchrony card first to save $632 in interest"

### Balance Transfer Eligibility
**Persona:** Consumer evaluating a balance transfer offer
**Problem:** Lender needs to see existing credit card balances, APRs, and utilization without a formal underwriting step
**Solution:** Liabilities returns credit card balances, APRs, and payment history in a consumer-permissioned flow (non-FCRA)
**Outcome:** Pre-qualify users for a balance transfer offer based on actual debt data

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names. -->

- **`products[]` string:** `"liabilities"` — non-FCRA; do NOT mix with `cra_*` products
- **Retrieval endpoint:** `POST /liabilities/get` — response: `accounts[]`, `liabilities.credit[]`, `liabilities.student[]`, `liabilities.mortgage[]`
- **Credit card key fields:** `aprs[]` (apr_percentage, apr_type), `minimum_payment_amount`, `next_payment_due_date`, `last_statement_balance`, `is_overdue`
- **Mortgage key fields:** `interest_rate.percentage`, `loan_term`, `escrow_balance`, `has_pmi`, `next_monthly_payment`, `property_address`
- **Student loan key fields:** `interest_rate_percentage`, `loan_status.type`, `pslf_status`, `repayment_plan.type`, `outstanding_interest_amount`
- **Webhook:** `LIABILITIES: DEFAULT_UPDATE` — payload includes `account_ids_with_new_liabilities[]` and `account_ids_with_updated_liabilities` (map of account_id → changed fields)
- **Refresh model:** cached snapshot, refreshed ~once per day — NOT live; do not promise real-time freshness
- **Federal student loans:** NOT available since Aug 23, 2024 (Stop Act) — Mohela, Nelnet, Aidvantage, EdFinancial, CRI are gone
- **Private student loans OK:** Sallie Mae, Discover Student Loans, Wells Fargo Education, PHEAA, CornerStone/UHEAA

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

- Direct-from-servicer fields (APR, escrow, PMI, repayment plan, PSLF status) — richer than bureau-data aggregators (MethodFi, Spinwheel) and richer than user-entered
- LIT bundle (Liabilities + Investments + Transactions) on one Link token covers the full consumer financial picture — single session, single access_token
- SoFi ($850k ARR), ChatGPT Personal Finance (May 2026 launch), Copilot, Monarch Money, YNAB — proof points across PFM and wealth-app market

## Implementation Pitfalls
<!-- ⚠️ HUMAN-OWNED — product-specific mistakes to avoid in prompts, scripts, and demos. -->

- **NEVER show federal student loan data** — Mohela, Nelnet, Aidvantage, EdFinancial, Great Lakes, FedLoan, CRI have been gone since Aug 2024. Private servicers only.
- **Non-FCRA** — do NOT use Liabilities for underwriting or credit decisions. Use CRA Base Report for those flows.
- **Refresh is daily** — do not claim real-time freshness. If the narrative needs "just paid" detection, source it from Transactions.
- **Auto loans** — poor coverage; do not feature as a primary.
- **CRA products cannot mix with `liabilities`** in the same Link token.
- **Sallie Mae quirk:** `balance.current` includes principal + outstanding interest; `outstanding_interest_amount` returns null.

## Common bundle patterns

Liabilities is most commonly sold and demo'd as part of the **"LIT" bundle** (Liabilities + Investments + Transactions). Plaid's canonical positioning, repeated verbatim across the Financial Management Playbook, Oct 2025 Solution Positioning, and the PFM Pitch Deck:

> *"Net worth = Investments (assets) − Liabilities (debts)"*

> *"Millennials and Gen Z will be 43% of banking revenue by 2035 — they expect Transactions for spending, Investments for wealth tracking, Liabilities for debt management."*

### LIT bundle on one Link token

```json
{
  "client_name": "<BrandName>",
  "products": ["liabilities", "transactions", "investments"],
  "user_id": "demo-user-001",
  "country_codes": ["US"],
  "language": "en"
}
```

- All three products on a single Item / single `access_token`.
- Each product is retrieved by its own endpoint:
  - Liabilities → `/liabilities/get`
  - Investments → `/investments/holdings/get` and `/investments/transactions/get` (see `inputs/products/plaid-investments.md`)
  - Transactions → **`/transactions/sync`** (preferred over `/transactions/get` for new integrations; cursor-based incremental, webhook-driven via `SYNC_UPDATES_AVAILABLE`)
- Add `'identity'` if the host needs name/email/phone on the linked account.
- Add `'assets'` if the use case is FCRA-flavored verification-of-assets — **but not in the same Link token as `cra_*` products** (CRA is mutually exclusive with non-CRA Income / verification flows per `link-token-create-config.js` sanitizer rules).

### Liabilities + Transactions (without Investments)

Debt-payoff / debt-consolidation flows that don't need portfolio data:

```json
{ "products": ["liabilities", "transactions"] }
```

- Use `/transactions/sync` for incremental payment history → detect "user just paid their mortgage."
- Use `/liabilities/get` for balance + APR + minimum-payment snapshot.
- Pair narration: APR + minimum from Liabilities, recent payment date from Transactions.

### Liabilities + Investments (without Transactions)

Net-worth dashboards that don't need spend categorization:

```json
{ "products": ["liabilities", "investments"] }
```

- Use `/investments/holdings/get` for assets side.
- Use `/liabilities/get` for debts side.
- Net worth = sum(holdings.institution_value) − sum(liabilities.*.last_statement_balance or current balance).

### Liabilities alone

Single-purpose debt-data demos (rare in 2026 — most prospects want at least Transactions paired):

```json
{ "products": ["liabilities"] }
```

## Pricing (internal — Glean)

- **Subscription model**, per-Item per-month. No per-call billing.
- **Rack rate: $0.20 / Item / month.** ASP at L4 enterprise: $0.07–$0.13. Confirmed in-flight (Wallit Apr 2026): **$0.18 / connected account / month**.
- Enterprise discount benchmark: **SoFi gets 55–88% off rack** ($0.024–$0.09 effective). SoFi spend on Liabilities is ~$850k ARR — flagship single-product customer.

## Customer references

**Safe to cite publicly** (Plaid blog / marketing): **SoFi**, **Copilot Money**, **LendingTree**, **OpenAI / ChatGPT Personal Finance** (launched May 15, 2026 — uses Liabilities for debt-payoff guidance + net-worth insights).

**Internal customer roster (LIT / PFM use cases):** Monarch Money, YNAB, Rocket Money, Wealthfront, Betterment, Upgrade (in evaluation), DoorDash Crimson (active deal — debt paydown for Dashers).

**Featured talk-track customer (Niki Taylor one-pager, Oct 2025) — Co-Founder, ChangEd:**
> *"The quality of the data we can send to users is much better with Plaid, because Plaid lets us pull that information directly from the servicer."*

## Competitive context

- **MethodFi and Spinwheel** are the main competitive threats — credless, bureau / Visa+MA-wrapped, claim 15,000+ institutions. Plaid evaluated MethodFi for partnership 2024-2025 and walked away (MethodFi also can't return loan account numbers due to the same Stop Act constraint). Acquisition is under consideration for 2026.
- Plaid's pitch must explain that **bank-data Liabilities and bureau-data debt APIs are different products**: Plaid pulls directly from the servicer (richer fields, lower error rate, account numbers), credless aggregators pull from bureaus / card networks (broader but shallower).
- **Yodlee Account Aggregation** is the legacy LIT-equivalent — Empower replaced Yodlee with Plaid (Investments side, $1.999M ACV, Dec 2025) but Yodlee still has incumbency in some long-tail wealth platforms.

## Demo guidance — canonical happy paths

### LIT bundle demo (default)

**Persona:** Net-worth dashboard / wealth-tracking app user linking checking + brokerage + credit cards + mortgage to see one consolidated view.

**Beats:**

1. Host app — "Connect all your accounts."
2. Plaid Link launches with `products: ["liabilities", "transactions", "investments"]`; one real-SDK step (`plaidPhase: "launch"`).
3. After Link, host calls `/investments/holdings/get` + `/liabilities/get` + `/transactions/sync` in parallel.
4. Insight reveal — net-worth tile (`assets - debts = net worth`), with side panels for each product:
   - Liabilities — top-3 debts with APR + minimum + due date
   - Investments — top-3 holdings with value
   - Transactions — last 3 categorized PFC transactions
5. Outcome — actionable card ("Pay off your $4,200 Synchrony card to save $632 in interest").

### Debt-paydown demo

**Persona:** Consumer using a debt-paydown app linking credit cards + mortgage.

**Beats:**

1. Host — "Add your debts."
2. Link with `products: ["liabilities", "transactions"]`.
3. `/liabilities/get` returns three credit cards + one mortgage; render APRs, statement balances, minimum payments, next due dates.
4. Avalanche / snowball recommendation tied to the actual APRs.
5. Optional: `/transactions/sync` to surface "Your $250 minimum mortgage payment cleared yesterday."

### What NOT to show

- **Federal student-loan servicer data** (Mohela, Nelnet, Aidvantage, EdFinancial, Great Lakes, FedLoan, CRI) — gone since Aug 2024.
- **CRA Base Report fields** alongside Liabilities — they're FCRA-vs-non-FCRA, different products. Never combine in `products[]` on the same Link token (`cra_*` products are separately sold and generally cannot mix with non-CRA flows).
- **Underwriting / lending decisioning narratives** — Liabilities is non-FCRA. Use CRA Base Report (`inputs/products/plaid-cra-base-report.md`) for those flows.
- **Auto loans as a primary** — coverage is weak.
- **Real-time freshness claims** — Liabilities refreshes ~daily, not live. If the narrative needs "just paid" freshness, source it from Transactions.
- **Made-up explainability fields** — there are no `reason_codes`; the documented fields are the documented fields.

## Narration Talk Tracks

- Debt reveal: "One Plaid Link, and we see your credit cards' APRs and minimums, your mortgage's interest rate and escrow, and your private student loans' payoff dates — directly from the servicer."
- Daily refresh disclosure: "Your Chase Sapphire has a twenty-two point four nine percent purchase APR, two hundred seventy-eight dollar minimum, due May twenty-eighth — Plaid refreshed that overnight."
- LIT bundle closing: "Add Transactions to that connection and you also see the payment land Tuesday. Add Investments and we calculate your net worth in real time."

## Proof Points & ROI Metrics

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| Credit card coverage | ~98% of major US institutions | Plaid docs | high | 2026-05-31 |
| SoFi ARR on Liabilities | ~$850k ARR | Glean SoFi Account Plan Q1 2026 | high | 2026-05-21 |
| Refresh cadence | ~once per day (not live) | AskBill-confirmed | high | 2026-05-31 |
| Federal student loans | Not available since Aug 23, 2024 | Liabilities FAQ / Glean | high | 2026-05-21 |

## Objections & Responses

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| [DRAFT] "MethodFi has 15,000+ institutions" | "MethodFi and Spinwheel pull from bureaus / card networks — broader but shallower. Plaid pulls directly from the servicer (richer fields: APR by type, PSLF status, PMI, escrow). Different products for different use cases." | Competitive Intel | [DRAFT] |
| [DRAFT] "Can we use this for underwriting?" | "Liabilities data is non-FCRA — it should not be used for credit decisioning. For FCRA-regulated lending workflows, use CRA Base Report instead." | SE positioning | [DRAFT] |

## Approved talk track (draft)

- "One Plaid Link, and we see your credit cards' APRs and minimums, your mortgage's interest rate and escrow, and your private student loans' payoff dates — directly from the servicer."
- "Your Chase Sapphire has a 22.49% purchase APR, $278 minimum, due May 28th — Plaid refreshed that overnight." *(Daily refresh disclosed in narration.)*
- "Add Transactions to that connection and you also see the $278 payment land Tuesday. Add Investments and we calculate your net worth in real time." *(LIT bundle.)*

## Value Proposition Statements

- Direct-from-servicer fields (APR, escrow, PMI, repayment plan, PSLF status) — richer than bureau-data aggregators and richer than user-entered.
- LIT bundle (Liabilities + Investments + Transactions) is the canonical net-worth / PFM kit — one Link session, three endpoints, one access_token.
- Subscription pricing ($0.20 rack, $0.18 typical) scales predictably with user base; no per-call surprise spikes.
- SoFi ($850k ARR), ChatGPT (May 2026 launch), Copilot, Monarch, YNAB, Rocket Money — proof points across the PFM and wealth-app market.
- For lending workflows that need FCRA-compliant debt data, point the customer at **CRA Base Report**, not Liabilities — this is the canonical Plaid SE positioning rule.

## Internal references (Glean, access-controlled)

- One-Pager: Liabilities (Oct 2025, Niki Taylor)
- Financial Management Playbook (Mar 2026, Niki Taylor)
- Yodlee Battle Card (privileged, pricing)
- Liabilities FAQ Confluence (Aug 2024 update — Stop Act source of truth)
- SoFi Account Plan Q1 2026 (Jillian Quinn)
- Customer comms email — Peanut Butter (Stop Act customer impact)
