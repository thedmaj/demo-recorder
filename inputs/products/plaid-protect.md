---
last_vp_research: "2026-05-21"
last_api_verified: "2026-05-21"
sources:
  - "AskBill plaid_docs MCP (canonical public docs, 2024-2025 snapshots)"
  - "Glean: GTM Playbook: Plaid Protect (2026), Plaid Protect Megadoc, Ti2 Deep Dive deck, internal Slack/Gong (2025-2026)"
---

# Plaid Protect

> **Product family key:** `plaid_protect`
> **Solution category:** Anti-fraud + identity risk-scoring umbrella
> **Status (May 2026):** **Limited Availability** for the new Trust Index / Ti2 product; GA TBD. Component products (Signal, Identity Verification, Monitor) are GA on their own. *Internal source: GTM Playbook: Plaid Protect (Glean).*
> **Sales engagement required** to enable Trust Index and Protect bundle pricing; component products may be self-serve in sandbox.

## What Plaid Protect is today

Plaid Protect is the **umbrella solution** that packages and orchestrates several anti-fraud and risk-scoring products under one Dashboard experience, customer contract, and decisioning surface (rulesets). It is **NOT a single API** with a `protect` product string — callers continue to use the component products' Link strings and endpoints.

**Components (verified via AskBill 2026-05-21 + Glean GTM Playbook 2026):**

| Component | Role | GA status |
|---|---|---|
| **Plaid Signal** | Transaction-risk scoring at decision time (ACH, account-funding, etc.) | GA |
| **Plaid Identity Verification (IDV)** | KYC / document & biometric checks at user onboarding | GA |
| **Plaid Monitor** | Sanctions / watchlist / PEP screening | GA |
| **Plaid Trust Index (Ti / Ti2)** | ML-derived identity-level trust score, with device + identity + transaction-graph sub-scores | **Limited Availability** (Ti2 shipped Oct 14, 2025; LA cohort opened March 2026) |
| **Rulesets** | Dashboard-configured decisioning that combines scores into ACCEPT / REVIEW / REROUTE outcomes | GA |

**Confused with:**
- Plaid Verify (old name for Auth-based account verification) — Protect is NOT a rename of Verify.
- Cash Advance Score (a *Signal* score for EWA — sits adjacent to Protect, often bundled commercially but technically a separate score family in `cash_advance_score`). See `inputs/products/plaid-ewa-score.md`.

## Documented public API surface (use these in demos)

### `/link/token/create` products

**`'protect'` is NOT a valid product string.** Sending it causes an error. Use the component strings instead:

| Use case | Required `products[]` |
|---|---|
| Signal scoring on a connected account | `['signal']` (plus `'auth'` only if you also need routing/account numbers) |
| Identity Verification at onboarding | `['identity_verification']` (separate token flow — see IDV docs) |
| Monitor screening | `['monitor']` |
| Bundled Protect on a single Item | Combine component strings as needed (`['signal', 'identity_verification']` is the documented pattern for a Protect-bundled flow) |

AskBill follow-up referenced `protect_linked_bank` and `protect_transactions` as additional Protect Transaction Monitoring strings, but the public Link token docs do **not** list these. Treat them as NDA / private-docs surfaces — do NOT put them in a demo unless the host account has explicit Plaid Sales enablement and confirmed contract scope.

### `/signal/evaluate` — score retrieval

Same endpoint as standalone Signal. Body:

```json
{
  "access_token": "access-sandbox-...",
  "account_id": "account-...",
  "client_transaction_id": "unique-decision-id-123",
  "amount": 150.00,
  "client_user_id": "user-7421",
  "ruleset_key": "your_ruleset_key",
  "user": {
    "name": { "given_name": "Maya", "family_name": "Chen" },
    "phone_number": "+14155551111",
    "email_address": "maya@example.com"
  },
  "device": {
    "ip_address": "192.0.2.1",
    "user_agent": "Mozilla/5.0 ..."
  }
}
```

Response (canonical, GA fields only):

```json
{
  "scores": {
    "customer_initiated_return_risk": { "score": 8 },
    "bank_initiated_return_risk": { "score": 56 },
    "cash_advance": { "score": 27 }
  },
  "core_attributes": {
    "available_balance": 2200,
    "days_since_first_plaid_connection": 196,
    "plaid_connections_count_7d": 0
  },
  "ruleset": {
    "ruleset_key": "onboarding",
    "result": "ACCEPT",
    "triggered_rule_details": {
      "internal_note": "Stable inflows; low cross-network risk"
    }
  },
  "warnings": [],
  "request_id": "abcdef123456"
}
```

| Score (when provisioned) | Field | Range / direction |
|---|---|---|
| Account Score (bank-initiated return risk) | `scores.bank_initiated_return_risk.score` | 1–99, higher = higher risk |
| Customer-initiated return risk | `scores.customer_initiated_return_risk.score` | 1–99, higher = higher risk |
| Cash Advance Score (EWA) | `scores.cash_advance.score` | 1–99, higher = higher risk |
| Pre-Auth (Confidence) Score (beta in some tenants) | `scores.pre_auth_confidence` | 1–99, higher = more confidence (direction inverted vs other scores) |

### `/signal/decision/report` — outcome feedback

```json
{
  "client_transaction_id": "unique-decision-id-123",
  "initiated": true,
  "days_funds_on_hold": 0
}
```

This is the only documented feedback endpoint for Protect/Signal flows.

### Ruleset semantics

- `ruleset_key` selects a Dashboard-configured ruleset.
- `ruleset.result` values documented today: **`ACCEPT`**, **`REROUTE`**, **`REVIEW`**. `REJECT` is NOT a documented result value — use `REROUTE` or surface the score with a custom host-app block.
- `ruleset.triggered_rule_details.internal_note` is free-text from the rule definition.

### Webhooks (verified literal names — do NOT paraphrase)

| Event | Fires when |
|---|---|
| `SIGNAL_SCORE_READY` | Score is computed and available for retrieval |
| `SIGNAL_RULE_TRIGGERED` | A Dashboard-configured rule matched the transaction |
| `PROTECT_TX_MONITOR_RULE_TRIGGERED` | Protect Transaction Monitoring rule matched (when that Protect component is enabled) |

`webhook_type: "SIGNAL"` for the first two; verify the third with your Plaid contact if the demo uses it.

### Reason codes vs core_attributes — CRITICAL

There is **no documented `reason_codes[]` array** on Signal / Protect responses. Explainability is delivered through:

1. `core_attributes` — 80+ key/value behavioral signals (balance history, inflow stability, connection age, network counts, etc.).
2. `ruleset.triggered_rule_details.internal_note` — the matched rule's free-text note.
3. `ruleset.result` — the categorical decision.

**Demo rule:** Show 2–3 named `core_attributes` and/or the matched rule name. **Never** fabricate a top-level `reason_codes: ["...", "..."]` array — it violates the API panel contract.

## Trust Index / Ti2 (Limited Availability)

**Source mix:** AskBill says the Ti2 *response field structure* is NOT in public docs and requires Sales / NDA engagement to integrate against. Glean confirms Limited Availability (March 2026 cohort) with three SKUs (TI Score Device, TI Score Identity, TI Score Full — $2.50/call for Full). Glean also confirms Ti2 added graph-based and transaction-history features for ~30% more fraud caught vs Ti1.

**What we do know:**

- Score range **1–100, higher = safer** (opposite direction from Signal scores).
- Surfaces ML-derived sub-scores covering device, identity, and transaction-graph signals.
- Not enabled by any public Link product string. Requires Plaid Sales to provision per account.

**Demo rule for Trust Index:**

- DO mention Trust Index by name when the prompt's primary product family is `plaid_protect` and the demo's scope explicitly includes Trust Index (per Plaid's current public marketing, this is the lead product term).
- DO NOT fabricate a `/protect/event/send`, `/protect/user/insights/get`, or `trust_index.*` field structure in the demo's API panel. Real Ti2 response shapes are NDA / private docs.
- When Trust Index is part of the narrative but the demo is sandbox, present the score as a top-line concept ("Trust Index: 87 — verified user") **with a host-app rendering** of synthesized fields, and route any underlying API panel to the documented `/signal/evaluate` response (where Signal scores live) plus IDV's `/identity_verification/get` (where identity outcomes live).
- Do NOT use the Trust Index term in non-Protect demos — it can confuse with Signal score branding.

## Approved product-name guidance

- **Plaid Protect** (umbrella; use exactly).
- **Trust Index** / **Ti2** — allowed in Plaid Protect demos only; mark Limited Availability when the demo discloses GA status.
- Component product names continue to use their own verbatim forms: **Plaid Signal**, **Plaid Identity Verification (IDV)**, **Plaid Monitor**.

## Demo guidance — canonical happy path

**Persona / scenario:** A fintech (neobank, BNPL, marketplace, crypto exchange) needs a single risk decision at user onboarding or transaction time, combining identity confidence + transaction risk.

**Beats:**

1. Host app — onboarding or payment confirmation screen.
2. Plaid Link launches with `products: ['signal']` (or `['signal', 'identity_verification']` for the bundled flow). One real-SDK step; `plaidPhase: "launch"`.
3. Host app — risk-decision screen calls `/signal/evaluate` with `client_transaction_id`, `amount`, ruleset.
4. Insight reveal — API panel shows `scores.*` + 2–3 named `core_attributes` + `ruleset.result: ACCEPT` (or `REVIEW` / `REROUTE` for nuance demos).
5. Outcome — host app confirms the decision; optionally show a follow-up call to `/signal/decision/report`.
6. Value summary — single Plaid-branded slide tying Protect to consolidation (fewer vendors), explainability, and Trust Index as the differentiator.

**What NOT to show:**

- Fabricated `/protect/*` endpoints or Ti2 response shapes (NDA / private docs).
- Fabricated `reason_codes[]` arrays — use `core_attributes` or rule names.
- `REJECT` as a `ruleset.result` value (not documented; use `REROUTE`).
- ACH return-risk wording when the demo is about EWA repayment risk — route EWA demos to `cash_advance_score` family and the `plaid-ewa-score.md` knowledge file.
- Trust Index on non-Protect demos (Auth, Bank Income, CRA, etc.) — confusing branding.

## GTM positioning (internal — Glean, 2026)

- Protect is positioned as Plaid's standalone fraud-intelligence platform — competitive against Alloy, Socure, Trulioo.
- Differentiator: network signal across the Plaid graph + cash-flow attributes that point-solution vendors cannot replicate.
- Closed-Won customer references (per Glean Salesforce): **Albert**, **Credit Genie**, **Cash App** (POC).
- Active pipeline: **Gemini**, **Cherry**, **Revolut**, **Oportun**, **Kalshi**.
- Native iOS / Android Trust Index SDKs shipped May 14, 2026 (mobile-first Protect demos can reference SDK availability).
- **Internal links** (Glean-sourced; access-controlled):
  - GTM Playbook: Plaid Protect (`/document/d/1IXi9GK...`)
  - Plaid Protect Megadoc (`/document/d/1f0hkGc...`)
  - Ti2 Deep Dive deck (`/presentation/d/1Nf4lNd...`)

## Approved talk track (draft)

- "Plaid Protect consolidates identity verification, transaction risk, and watchlist screening into one decision surface — fewer vendors, one user-data layer, real-time outcomes."
- "Trust Index 87 — verified. Stable inflows, device match, three months of clean account history." *(LA caveat: only when the prompt scopes Trust Index in.)*
- "Ruleset: ACCEPT. Account Score 12 means low return risk on this $1,200 payment."
- "Outcome reported back via /signal/decision/report — Plaid uses your decisioning to calibrate the next score."

## Value Proposition Statements

### Candidate Value Propositions (research-derived)

- One Link session, multiple risk decisions: identity + transaction + watchlist screening on the same connected account.
- ML-derived Trust Index combines device, identity, and transaction-graph signals — catches fraud point solutions miss (30% lift per Plaid Ti2 internal data).
- `core_attributes` and ruleset rule names give product + ops explainability without inventing reason codes.
- Native iOS / Android SDKs (May 2026) enable mobile-first Protect deployments.
- Closed-Won proof points across neobanks (Albert, Credit Genie) and large fintechs (Cash App POC) signal market traction.
- Consolidation story: replace Alloy / Socure / Trulioo stack with a single Plaid contract while keeping per-component flexibility.
