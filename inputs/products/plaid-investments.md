---
last_vp_research: "2026-05-21"
last_api_verified: "2026-05-31"
last_ai_update: "2026-05-31T00:00:00Z"
sources:
  - "AskBill plaid_docs MCP — https://plaid.com/docs/investments/"
  - "Glean: Plaid Investments product one-pager (Tom Donovan, May 2026), Salesforce opps, internal coverage docs"
---

# Plaid Investments

> **Product family key:** `investments`
> **Status (May 2026):** **GA**. Per-Item subscription pricing; Holdings and Transactions can be subscribed separately.
> **Coverage:** 2,500+ US institutions; ~95% of US investment accounts covered. 10 of the top 30 brokerages on the API path; Vanguard + Schwab migrated to API in 2025. **Fidelity Investments is gated** (request access via Plaid Sales).

## Overview
Plaid Investments provides read-only access to investment account holdings (current positions, securities metadata, values) and up to 24 months of investment transactions (buys, sells, dividends, fees). It powers PFM dashboards, wealth-tracking apps, tax-prep workflows, and portfolio analytics. The `products[]` string is `"investments"` — distinct from `"investments_auth"` (Investments Move / brokerage transfer).

## Where It Fits
Feature Investments when the demo persona is a PFM, wealth tracker, or tax-prep user connecting their brokerage to see a consolidated portfolio view. Best paired with Transactions (spending) and Liabilities (debts) as the LIT bundle for net-worth dashboards. Also pairs with Investments Move for prospects that want both read-only data and transfer initiation on the same connection.

## What this product is (and is NOT)

Plaid Investments is **read-only data access** for investment accounts: current portfolio holdings (positions, securities metadata, values) and up to 24 months of investment transactions (buys, sells, dividends, fees). It powers PFM dashboards, wealth-tracking apps, tax-prep workflows, and portfolio analytics.

> **Not to be confused with:** **Plaid Investments Move** (`investments_move` family), which uses a different Link product string (`investments_auth`), a different endpoint (`/investments/auth/get`), and is for *brokerage transfer initiation* — not portfolio data access. See `inputs/products/plaid-investments-move.md`.

> **Canonical disambiguation (David Majetic / TD email, internal):**
> *"When we initially built aggregation for Investments, the use case was to do things like calculate net worth and understand finances etc. Account # was explicitly left out because it is deemed sensitive information. As the market matured we saw an increased desire to include Account # for the purpose of transferring assets. A separate API was then created which includes account numbers as well as identity data — leaving the original API as is and not overexposing Account #s if not needed for other use cases."*

| | **Plaid Investments** | **Investments Move** |
|---|---|---|
| Use case | Read-only portfolio data | Brokerage transfer initiation |
| `products[]` string | **`investments`** | `investments_auth` |
| Main endpoints | `POST /investments/holdings/get`, `POST /investments/transactions/get` | `POST /investments/auth/get` |
| Returns account numbers / DTC | No | Yes |
| Webhooks | `HOLDINGS: DEFAULT_UPDATE`, `INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE` | Generic Item webhooks only |
| Pricing | Per-Item subscription | Per-call ($20 rack / $8–13 typical) |
| Status | GA | Early Availability |

## Documented public API surface

### `/link/token/create`

```json
{
  "client_name": "<BrandName>",
  "products": ["investments"],
  "user_id": "demo-user-001",
  "country_codes": ["US"],
  "language": "en"
}
```

Standard Link flow. No `/user/create` bootstrap.

### `/investments/holdings/get` — current positions

```json
{
  "client_id": "...",
  "secret": "...",
  "access_token": "access-sandbox-..."
}
```

Optional: `options.account_ids` filter to a subset.

Response (key fields):

```json
{
  "accounts": [ /* investment accounts */ ],
  "holdings": [
    {
      "account_id": "...",
      "security_id": "...",
      "quantity": 100,
      "institution_value": 12450.00,
      "cost_basis": 8200.00,
      "iso_currency_code": "USD"
    }
  ],
  "securities": [
    {
      "security_id": "...",
      "ticker_symbol": "VTSAX",
      "cusip": "922908769",
      "type": "mutual fund"
    }
  ]
}
```

**Cost basis is aggregate only — there is no per-lot tax data** in the documented response. Tax-prep demos must disclose this gap. *(Internal: Tom Donovan one-pager, May 2026.)*

### `/investments/transactions/get` — buy / sell / dividend / fee history

```json
{
  "client_id": "...",
  "secret": "...",
  "access_token": "access-sandbox-...",
  "start_date": "2025-05-21",
  "end_date": "2026-05-21",
  "options": {
    "count": 100,
    "offset": 0
  }
}
```

Notes:
- **Maximum 24-month window**. Older history is not available.
- Date format `YYYY-MM-DD`; both `start_date` and `end_date` are required.
- Pagination via `options.count` + `options.offset`; response includes `total_investment_transactions` for total available.
- First post-Link call is synchronous and may take 1–2 minutes. For post-Link product addition use `async_update=true` and listen for the `HISTORICAL_UPDATE` webhook.
- Subtypes include `short-term capital gain` / `long-term capital gain` where the institution labels them.

Response (key fields):

```json
{
  "accounts": [...],
  "investment_transactions": [
    {
      "investment_transaction_id": "...",
      "account_id": "...",
      "security_id": "...",
      "date": "2026-04-15",
      "name": "Buy VTSAX",
      "quantity": 25,
      "amount": -3112.50,
      "price": 124.50,
      "fees": 0,
      "type": "buy",
      "subtype": "buy"
    }
  ],
  "securities": [...],
  "total_investment_transactions": 87
}
```

### Webhooks (literal names — do NOT paraphrase)

| Event | Type | Code | Fires when |
|---|---|---|---|
| Holdings update | `HOLDINGS` | `DEFAULT_UPDATE` | New / changed positions detected (e.g., overnight market move, new buy) |
| Investment transactions update | `INVESTMENTS_TRANSACTIONS` | `DEFAULT_UPDATE` | New or canceled investment transactions detected |
| Historical fetch complete (post-Link async) | `INVESTMENTS_TRANSACTIONS` | `HISTORICAL_UPDATE` | First historical pull of investment transactions has finished |

### Region

US and Canada.

### Sales enablement

GA — enabled subscription is required (per-Item, separate billing for Holdings and Transactions). Fidelity Investments is request-gated; verify before pitching coverage to Fidelity-heavy prospects.

## Customer references

**Safe to cite publicly:** Empower (formerly Personal Capital).

**Internal flagship win (Glean Salesforce):** Empower replaced Yodlee with Plaid Investments for $1.999M ACV (closed Dec 2025) — the canonical Yodlee-replacement reference. Main competitor on this product line is **Yodlee FastLink**.

**Other typical buyers:** PFM apps, wealth dashboards, tax-prep workflows, robo-advisors.

## Customer Use Cases

- Portfolio tracking (PFM / wealth dashboard): pull holdings and up to 24 months of transactions from the linked brokerage; Empower replaced Yodlee with Plaid for $1.999M ACV
- Tax-prep transaction history: `/investments/transactions/get` returns buys, sells, dividends, fees with aggregate cost basis for Schedule D pre-fill
- Net-worth dashboard (LIT bundle): Investments + Liabilities + Transactions on one Link token → assets minus debts equals net worth in real time

### Portfolio Tracking (PFM / Wealth Dashboard)
**Persona:** Consumer linking a brokerage to a personal finance or wealth-tracking app
**Problem:** Fragmented investment accounts with no consolidated view
**Solution:** Plaid Investments pulls holdings and up to 24 months of transactions from the linked brokerage in one Link session
**Outcome:** Real-time net-worth and portfolio view; Empower replaced Yodlee with Plaid for $1.999M ACV

### Tax-Prep Transaction History
**Persona:** Tax-prep software user linking brokerage accounts for capital gains reporting
**Problem:** Manual export of transaction history is error-prone and incomplete
**Solution:** `/investments/transactions/get` returns up to 24 months of buys, sells, dividends, and fees with cost basis
**Outcome:** Automated pre-fill of Schedule D inputs; reduces manual data entry for the user

### Net-Worth Dashboard (LIT Bundle)
**Persona:** Consumer using a budgeting or savings app that needs a complete financial picture
**Problem:** Separate systems for spending, investments, and debts mean no unified net worth view
**Solution:** Plaid Investments (`/investments/holdings/get`) + Liabilities + Transactions on one Link token gives assets, debts, and spending in one session
**Outcome:** Real-time net-worth calculation; "assets minus debts" rendered immediately after link

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names. -->

- **`products[]` string:** `"investments"` — NOT `"investments_auth"` (that's Investments Move)
- **Holdings endpoint:** `POST /investments/holdings/get` — response: `accounts[]`, `holdings[]` (quantity, institution_value, cost_basis), `securities[]` (ticker_symbol, cusip, type)
- **Transactions endpoint:** `POST /investments/transactions/get` — requires `start_date` + `end_date` (YYYY-MM-DD); max 24-month window; paginated via `options.count` + `options.offset`
- **Webhooks:** `HOLDINGS: DEFAULT_UPDATE` (new/changed positions); `INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE` (new/canceled txns); `INVESTMENTS_TRANSACTIONS: HISTORICAL_UPDATE` (async first pull complete)
- **Cost basis:** aggregate only — no per-lot tax data in the documented response
- **Fidelity:** request-gated — confirm with Plaid Sales before pitching Fidelity coverage
- **No account numbers or DTC:** those are Investments Move outputs, not Investments

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

- 2,500+ US institutions, ~95% of US investment accounts covered — broader than legacy aggregators (Yodlee FastLink is main competitor)
- Top brokerages (Vanguard, Schwab) migrated to the modern API path in 2025 — fewer scrape fallbacks, faster refresh cycles
- Webhook-driven freshness eliminates full re-pulls; `HOLDINGS: DEFAULT_UPDATE` + `INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE`
- Empower replaced Yodlee with Plaid Investments at $1.999M ACV (Dec 2025) — the canonical Yodlee-replacement reference

## Implementation Pitfalls
<!-- ⚠️ HUMAN-OWNED — product-specific mistakes to avoid in prompts, scripts, and demos. -->

- Do NOT use `investments_auth` as the Link product — that is Investments Move (brokerage transfer). Use `"investments"` for read-only portfolio data.
- Do NOT call `/investments/auth/get` — that is Investments Move's endpoint. Holdings uses `/investments/holdings/get`; transactions uses `/investments/transactions/get`.
- Do NOT show per-lot tax data — cost basis is aggregate only in the documented API response.
- Do NOT show ACATS / DTC numbers — those are Investments Move outputs.
- Do NOT make Fidelity coverage claims without Sales confirmation — Fidelity is request-gated.
- First post-Link call to `/investments/transactions/get` may take 1–2 minutes; use `async_update=true` and listen for `HISTORICAL_UPDATE` webhook for large accounts.

## Demo guidance — canonical happy path

**Persona:** PFM / wealth-tracking app user linking a brokerage account to see consolidated portfolio + tax-relevant transaction history.

**Beats:**

1. Host app — "Connect your investment account" entry.
2. Plaid Link launches with `products: ["investments"]`; one real-SDK step (`plaidPhase: "launch"`); sandbox institution from `inputs/plaid-link-sandbox.md`.
3. After Link, host calls `/investments/holdings/get` → renders top-3 holdings with quantity, value, cost basis.
4. Optional second call to `/investments/transactions/get` (last 30 days) → renders 2–3 named transactions (a buy + a dividend, for example).
5. Outcome — portfolio screen tied to the host app's value prop (net worth, performance, allocation).

**What NOT to show:**

- The `investments_auth` Link product string — that's Investments Move (different flow).
- `/investments/auth/get` — wrong endpoint; Investments uses `holdings` and `transactions`.
- Per-lot tax data — not in the response. Disclose if asked.
- ACATS / DTC numbers — those are Investments Move outputs.
- Fidelity coverage claims without confirming Sales enablement.

## Narration Talk Tracks

- Portfolio reveal: "One Plaid Investments connection pulls real-time holdings and up to twenty-four months of investment transactions — the backbone of any PFM or wealth tracker."
- Holdings beat: "Vanguard Total Stock Market — one hundred shares, twelve thousand four hundred fifty dollars value, eight thousand two hundred cost basis. Refreshed via Plaid overnight."

## Proof Points & ROI Metrics

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| US institutions covered | 2,500+ | Plaid docs | high | 2026-05-31 |
| US investment account coverage | ~95% | Plaid docs | high | 2026-05-31 |
| Transaction history available | Up to 24 months | AskBill-confirmed | high | 2026-05-31 |
| Empower ACV (Yodlee replacement) | $1.999M ACV, closed Dec 2025 | Glean Salesforce | high | 2026-05-21 |

## Objections & Responses

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| [DRAFT] "We use Yodlee" | "Empower replaced Yodlee with Plaid Investments for $1.999M ACV (Dec 2025). Plaid has 2,500+ institutions and Vanguard + Schwab on the modern API path — fewer scrape fallbacks, faster refresh." | Glean Salesforce | [DRAFT] |
| [DRAFT] "Does this include Fidelity?" | "Fidelity is request-gated — contact your Plaid account manager before committing Fidelity coverage to a prospect." | Plaid docs | [DRAFT] |

## Approved talk track (draft)

- "One Plaid Investments connection pulls real-time holdings and up to 24 months of investment transactions — the backbone of any PFM or wealth tracker."
- "Vanguard Total Stock Market — 100 shares, $12,450 value, $8,200 cost basis. Refreshed via Plaid overnight."
- "Empower replaced Yodlee with Plaid Investments and consolidated their data layer." *(When Empower is an acceptable named reference.)*

## Value Proposition Statements

- 2,500+ US institutions, ~95% of US investment accounts covered — broader and fresher than legacy aggregators (Yodlee FastLink).
- Top brokerages (Vanguard, Schwab) on the modern API path — fewer scrape fallbacks, faster refresh.
- Aggregate cost basis included for portfolio valuation; up to 24 months of investment transactions with dividend / fee classification.
- Webhook-driven freshness (`HOLDINGS: DEFAULT_UPDATE`, `INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE`) — no full re-pulls needed.
- Pairs with Investments Move for prospects that want both portfolio data AND transfer initiation on the same connection.

## Internal references (Glean, access-controlled)

- Tom Donovan one-pager — Plaid Investments (May 2026)
- Empower opportunity record — $1.999M ACV closed Dec 2025
- Internal coverage matrix (Fidelity gating, top-30 API vs scrape distribution)
