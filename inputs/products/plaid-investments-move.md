---
last_vp_research: "2026-05-21"
last_api_verified: "2026-05-31"
last_ai_update: "2026-05-31T00:00:00Z"
sources:
  - "AskBill plaid_docs MCP — https://plaid.com/docs/investments-move/"
  - "Glean: Plaid Investments Move GTM Playbook (Feb 27 2026), Salesforce opps, Slack #proj-investments-move, Gong customer calls"
---

# Plaid Investments Move

> **Product family key:** `investments_move`
> **Status (May 2026):** **Early Availability / Limited Access** — gated via LaunchDarkly flip by the customer's Plaid Account Manager. Public marketing page live since June 6, 2025.
> **Plaid Sales engagement required.** Not self-serve. Mandatory data-partner reciprocity clause (6-month build commitment) — confirm with AM before pitching.

## Overview
Plaid Investments Move automates brokerage account transfer initiation via the ACATS network (US). It exposes the data the receiving broker needs to populate an inbound transfer form — account numbers, holdings, owners, and DTC codes — sourced directly from the institution where possible. The `products[]` string is `"investments_auth"` and the retrieval endpoint is `/investments/auth/get`. Early Availability / Sales-gated.

## Where It Fits
Feature Investments Move when the demo persona is a new customer at a brokerage (Robinhood, Public, retirement/IRA, crypto exchange offering self-directed brokerage) who wants to initiate an inbound ACATS transfer from their existing broker. Best paired with a "transfer your existing brokerage" narrative. Not for read-only portfolio viewing — use Plaid Investments (`"investments"`) for that.

## What this product is (and is NOT)

Plaid Investments Move automates **brokerage account transfer initiation** via the ACATS network (US) and ATON network (Canada — *not* GA, see below). It exposes the data the receiving broker needs to populate an inbound transfer form: account numbers, holdings, owners, and DTC codes — sourced directly from the institution where possible, with a screen-scrape fallback path.

> **The canonical disambiguation (David Majetic / TD email, internal):**
> *"When we initially built aggregation for Investments, the use case was to do things like calculate net worth and understand finances etc. Account # was explicitly left out because it is deemed sensitive information. As the market matured we saw an increased desire to include Account # for the purpose of transferring assets. A separate API was then created which includes account numbers as well as identity data — leaving the original API as is and not overexposing Account #s if not needed for other use cases."*

| | **Investments Move** | **Plaid Investments** |
|---|---|---|
| Use case | Brokerage transfer initiation (ACATS / ATON) | Read-only portfolio holdings & transaction history |
| `products[]` string | **`investments_auth`** | `investments` |
| Main endpoint | `POST /investments/auth/get` | `POST /investments/holdings/get`, `POST /investments/transactions/get` |
| Returns `numbers` (account + DTC) | **Yes** | No |
| Returns 24-month transaction history | No | Yes |
| Status | Early Availability, Sales-gated | GA |
| Webhooks | Generic Item webhooks only | `HOLDINGS: DEFAULT_UPDATE`, `INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE` |
| Pricing | Per-call ($20 rack / $8–13 typical) | Per-Item subscription |

## Documented public API surface

### `/link/token/create`

**Literal `products[]` value: `["investments_auth"]`. Do NOT use `["investments"]` — that's the data-access product.**

```json
{
  "client_name": "<BrandName>",
  "products": ["investments_auth"],
  "user_id": "demo-user-001",
  "country_codes": ["US"],
  "language": "en"
}
```

No `/user/create` bootstrap. Standard Link flow.

### `/investments/auth/get` — retrieve transfer data

```json
{
  "client_id": "...",
  "secret": "...",
  "access_token": "access-sandbox-..."
}
```

Response shape (canonical fields):

```json
{
  "accounts": [ /* investment + sometimes deposit accounts */ ],
  "holdings": [ /* current positions per security */ ],
  "securities": [ /* metadata: ticker, CUSIP/ISIN, type */ ],
  "owners": [ /* names for ACATS matching */ ],
  "numbers": {
    "acats": [
      {
        "account": "TR5555",
        "account_id": "...",
        "dtc_numbers": ["1111", "2222"]
      }
    ]
  },
  "data_sources": {
    "numbers": "INSTITUTION",
    "owners": "INSTITUTION"
  }
}
```

The `data_sources` block tells the receiving broker whether each field came from the institution (high confidence) or a fallback (user input / scrape). `INSTITUTION` is the success state for ACATS automation.

### Webhooks

No Investments Move-specific webhooks. The flow reuses generic Item webhooks. Fallback / error handling reads `data_sources` and Item-error webhooks.

### Sandbox

- Institution: **`ins_115616` (Vanguard)** — primary sandbox for `/investments/auth/get`.
- Credentials: `user_good` / `pass_good`.
- See `inputs/plaid-link-sandbox.md` for the broader sandbox map.

### Region

- **US:** ACATS (GA in Early Availability).
- **Canada:** ATON — **not GA**, target June 2027 per the TD customer thread (Glean internal). Do NOT promise current ATON support to prospects.

## Pricing (internal — Glean GTM Playbook Feb 27 2026)

- **$20 per call (rack rate)**; typical negotiated `$8–13`.
- **Manual / fallback responses are NOT billed** (only successful API or scrape returns).
- Per-call billing event: `investments-auth-request`.
- Mandatory data-partner reciprocity clause: 6-month build commitment from the customer.

## Latency (internal — Glean)

- ~14s for institution-API responses.
- ~50s for screen-scrape fallback.
- 70–80% of production traffic resolves via API path (not scrape).

## Customer references

**Safe to cite publicly (Plaid blog / marketing):** Robinhood, Public, Frec, Stash.

**Internal Closed-Won (do NOT cite by name unless the prospect already knows them):**
- Robinhood — flagship reference (*"90% decrease in ACATS failures, 300% increase in successful transfers"* — Plaid internal stat, marketing-approved).
- Stash, Frec, StreetBeat, PensionBee, TD Canada, Apex, Sharely, Benefi, Overflow.

**Active pipeline (Glean Salesforce):** Kraken, OnePay, CashApp, Coinbase, Merrill.

## Customer Use Cases

- Brokerage inbound transfer (ACATS): one Link session returns account number, DTC codes, holdings list, and owner names — Robinhood: 90% drop in ACATS failures, 3× lift in successful transfers
- Wealth platform asset consolidation: automate batch ACATS initiation across multiple departing accounts with `numbers.acats[].account` + `dtc_numbers`

### Brokerage Inbound Transfer (ACATS)
**Persona:** New brokerage customer who wants to move their existing portfolio
**Problem:** ACATS transfer form requires precise account number, DTC code, and holdings data — users don't have this handy and manual entry causes delays or failures
**Solution:** Plaid Investments Move pulls account number, DTC code, holders, and holdings list directly from the departing institution via one Link session
**Outcome:** Robinhood saw 90% drop in ACATS failures and 3× lift in successful transfers; autofilled transfer form in seconds vs. multi-day manual process

### Wealth Platform Asset Consolidation
**Persona:** Investment platform consolidating assets from multiple legacy brokerages
**Problem:** Batch ACATS requests require exact DTC codes and account numbers for each departing account
**Solution:** `/investments/auth/get` returns `numbers.acats[].account`, `dtc_numbers`, and `owners` for each linked investment account
**Outcome:** Automated transfer initiation at scale; manual PDFs and form-fill eliminated

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names. -->

- **`products[]` string:** `"investments_auth"` — NOT `"investments"` (that's read-only data access)
- **Retrieval endpoint:** `POST /investments/auth/get` — response: `accounts[]`, `holdings[]`, `securities[]`, `owners[]`, `numbers.acats[]{account, account_id, dtc_numbers[]}`, `data_sources`
- **`dtc_numbers`:** ordered by relevance; if empty, fall back to `/institutions/get_by_id` using `item.institution_id`
- **`data_sources`:** tells the receiving broker whether each field came from `INSTITUTION` (high confidence) or fallback — `INSTITUTION` is the success state for ACATS automation
- **No read-only portfolio data:** `/investments/holdings/get` and `/investments/transactions/get` are NOT used here; those are Plaid Investments endpoints
- **Status:** Early Availability (Sales-gated) — not self-serve; mandatory data-partner reciprocity clause (6-month build commitment)
- **Sandbox institution:** `ins_115616` (Vanguard); credentials `user_good` / `pass_good`
- **Canada ATON:** NOT GA — do not promise ATON support

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

- One Link session returns complete ACATS-ready dataset (account number, DTC, holdings list, owners) — replaces brittle manual entry or PDF-fax workflows
- API-first path resolves in ~14s vs. ~50s scrape fallback; 70–80% of production traffic on the API path
- Manual/fallback responses are not billed — risk-free integration economics
- Customer outcome: Robinhood 90% drop in ACATS failures, 3× lift in successful transfers (Plaid internal, marketing-approved)
- Pairs with standard Plaid Investments for prospects that want both transfer initiation AND ongoing portfolio read access

## Implementation Pitfalls
<!-- ⚠️ HUMAN-OWNED — product-specific mistakes to avoid in prompts, scripts, and demos. -->

- Do NOT use `"investments"` as the Link product — that returns read-only holdings/transactions. Use `"investments_auth"` for ACATS transfer data.
- Do NOT call `/investments/holdings/get` or `/investments/transactions/get` — those are Investments (data access). Use `/investments/auth/get` for Investments Move.
- Do NOT invent webhook names — the flow reuses generic Item webhooks; `INVESTMENTS_AUTH_READY` does not exist.
- Do NOT promise Canada ATON support — not GA as of May 2026.
- If `dtc_numbers[]` is empty, do NOT default to a hardcoded DTC — fall back to `/institutions/get_by_id` for the institution's DTC.
- Sales engagement required before pitching — not self-serve; confirm AM before demo.

## Demo guidance — canonical happy path

**Persona:** New customer of a brokerage (Robinhood-style, Public-style, retirement / IRA, crypto exchange offering self-directed brokerage) initiating an inbound transfer from their existing broker.

**Beats:**

1. Host app — onboarding step "Transfer your existing brokerage."
2. Plaid Link launches with `products: ["investments_auth"]`; one real-SDK step (`plaidPhase: "launch"`); sandbox institution Vanguard (`ins_115616`).
3. After Link succeeds, host calls `/investments/auth/get`.
4. Insight reveal — API panel shows `numbers.acats[0].account` + `dtc_numbers`, `owners`, and 2–3 named holdings.
5. Host autofills the transfer form (DTC, account number, holdings ticker list).
6. Outcome — "Transfer initiated. We'll notify you when it completes." Optional close: tie to internal metric ("ACATS failures cut by 90%, completion rate 3x").

**What NOT to show:**

- The `'investments'` Link product string — that's the *data-access* product, wrong wire format.
- `/investments/holdings/get` or `/investments/transactions/get` — those are the data-access endpoints; Move uses `/investments/auth/get` only.
- Made-up webhook names — the flow reuses generic Item webhooks; do not invent `INVESTMENTS_AUTH_READY` etc.
- Production ATON Canada — not GA yet.
- The full `dtc_numbers[]` array as a list dump — show one or two, narrated.

## Narration Talk Tracks

- Transfer initiation beat: "When a new customer wants to bring their existing brokerage, Plaid Investments Move pulls account numbers, holdings, and DTC codes straight from their old broker — no PDFs, no manual entry."
- ACATS data reveal: "DTC code eleven eleven, account TR five five five five, three holdings — the receiving broker has everything ACATS needs to initiate the transfer."

## Proof Points & ROI Metrics

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| Robinhood: ACATS failure reduction | 90% drop | Plaid internal (marketing-approved) | high | 2026-05-21 |
| Robinhood: successful transfer lift | 3× | Plaid internal (marketing-approved) | high | 2026-05-21 |
| API-path latency | ~14s | Glean GTM Playbook Feb 2026 | high | 2026-05-21 |
| Scrape-fallback latency | ~50s | Glean GTM Playbook Feb 2026 | high | 2026-05-21 |
| API-path traffic share | 70–80% | Glean GTM Playbook Feb 2026 | high | 2026-05-21 |

## Objections & Responses

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| [DRAFT] "We handle ACATS manually" | "Manual ACATS forms have high error rates — wrong DTC codes or account numbers cause failures and delays. Plaid Investments Move pulls these directly from the institution with 90% fewer failures (Robinhood reference)." | Glean GTM | [DRAFT] |
| [DRAFT] "Is this GA?" | "Investments Move is Early Availability — Sales-gated, not self-serve. Contact your Plaid account manager to confirm eligibility and the 6-month data-partner reciprocity commitment." | Glean GTM Playbook | [DRAFT] |

## Approved talk track (draft)

- "When a new customer wants to bring their existing brokerage to your platform, Plaid Investments Move pulls account numbers, holdings, and DTC codes straight from their old broker — no PDFs, no manual entry."
- "DTC code `1111`, account `TR5555`, three holdings — the receiving broker has everything ACATS needs."
- (When the customer hits the fallback path) "If the institution can't return structured data, we screen-scrape — same shape, same form fill, but slower."

## Value Proposition Statements

- One Link session → complete ACATS-ready dataset (account #, DTC, holdings, owners) — replaces brittle manual entry that breaks the funnel.
- Customer outcome data: Robinhood saw 90% drop in ACATS failures and 3× lift in successful transfers (Plaid internal; marketing-approved).
- API-first path resolves in ~14s vs. ~50s scrape fallback; 70–80% of traffic on API.
- Manual fallback responses are not billed — risk-free integration economics for the customer.
- Bundles with standard Plaid Investments for prospects that want both transfer initiation AND ongoing portfolio data.

## Internal references (Glean, access-controlled)

- GTM Playbook: Plaid Investments Move (Feb 27, 2026) — PM: Liam Plambeck
- `#proj-investments-move` (Slack)
- TD Canada thread — ATON commitment dates
- Coinbase ACATS-data-out scoping doc — outbound transfer variant (pipeline)
