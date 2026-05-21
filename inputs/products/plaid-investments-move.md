---
last_vp_research: "2026-05-21"
last_api_verified: "2026-05-21"
sources:
  - "AskBill plaid_docs MCP — https://plaid.com/docs/investments-move/"
  - "Glean: Plaid Investments Move GTM Playbook (Feb 27 2026), Salesforce opps, Slack #proj-investments-move, Gong customer calls"
---

# Plaid Investments Move

> **Product family key:** `investments_move`
> **Status (May 2026):** **Early Availability / Limited Access** — gated via LaunchDarkly flip by the customer's Plaid Account Manager. Public marketing page live since June 6, 2025.
> **Plaid Sales engagement required.** Not self-serve. Mandatory data-partner reciprocity clause (6-month build commitment) — confirm with AM before pitching.

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
