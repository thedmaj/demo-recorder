---
last_vp_research: "2026-05-22"
last_api_verified: "2026-05-22"
sources:
  - "AskBill plaid_docs MCP (canonical public docs, refreshed 2026-05-22)"
  - "Glean: GTM Playbook: Plaid Protect (May 2026), Plaid Protect Megadoc (2025), Plaid Protect Testing & Integration Resources, Ti2 launch blog (plaid.com/blog/plaid-protect-trust-index/ — Oct 14 2025), Protect marketing page (plaid.com/products/protect/)"
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

### `/link/token/create` products — **`protect_linked_bank` is the default**

**`'protect'` is NOT a valid product string.** Sending it causes an error. Use one of the component / Protect strings below. **`protect_linked_bank` and `protect_transactions` are public, documented Link product strings** as of 2026-05-22 (AskBill verified, Glean GTM Playbook confirmed). The earlier KB note treating them as NDA was stale.

| Mode | Required `products[]` | When to use |
|------|----------------------|-------------|
| **Protect (default — RECOMMENDED for new Protect demos)** | **`['protect_linked_bank']`** (US-only; add `'signal'` for transaction-time scoring; add `'monitor'` for sanctions/PEP) | Use whenever the prompt mentions Plaid Protect / Trust Index and **does not** explicitly include `identity_verification` / IDV. The Protect SDK + `/protect/event/send` pattern (see § Protect SDK below) is the canonical Ti2 surface. |
| **Protect bundled with IDV** | `['protect_linked_bank', 'identity_verification', 'signal']` | Use only when the prompt explicitly mentions IDV / identity verification alongside Protect. Trust Index Ti2 scores also surface in `/identity_verification/get → link_sessions[].results.protect_results.trust_index`. |
| Signal-only (legacy / transaction-time scoring without Protect umbrella) | `['signal']` (plus `'auth'` only if you also need routing/account numbers) | Use when the prompt is explicitly about Signal scoring (not Protect / Trust Index). |
| Identity Verification standalone | `['identity_verification']` | Separate token flow — see IDV docs. |
| Monitor screening | `['monitor']` | Sanctions / watchlist / PEP. |
| `protect_transactions` (Protect Transaction Monitoring) | `['protect_linked_bank', 'protect_transactions']` | Post-Item ACH return / fraud monitoring. Fires `PROTECT_TX_MONITOR_RULE_TRIGGERED`. |

**Default rule for the build pipeline:** when `productFamily === 'plaid_protect'`, the link-token-create resolver **must include `'protect_linked_bank'`**. Add `'identity_verification'` only when the prompt explicitly references IDV / identity verification as a featured product. Add `'signal'` whenever transaction-time scoring is shown.

**Wrong patterns (do NOT emit):**
- `['protect']` — invalid product string, hard reject from `/link/token/create`.
- `['auth', 'signal']` for a Protect / Trust Index demo — narrates Trust Index but doesn't actually surface it; misleading to viewers and contract-violating per the demo's stated value proposition.
- `'ti2'`, `'trust_index'`, `'cash_advance'`, `'signal_monitor'` — not valid product strings.

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
2. `ruleset.triggered_rule_details.internal_note` — the matched rule's free-text note. **THIS IS THE ONLY documented free-text field** under `triggered_rule_details`.
3. `ruleset.triggered_rule_details.custom_action_key` — optional documented field (host can map to internal action keys).
4. `ruleset.result` — the categorical decision (`ACCEPT` / `REROUTE` / `REVIEW` — `REJECT` not documented).

**Demo rules:**

- Show 2–3 named `core_attributes` (always include `available_balance` and `current_balance` — they appear even in balance-only Signal models). Show **both** `bank_initiated_return_risk` AND `customer_initiated_return_risk` in `scores{}` — AskBill's canonical example always returns both.
- Include `"warnings": []` in the response (always present, often empty).
- **Never** fabricate a top-level `reason_codes: ["...", "..."]` array.
- **Never** add `rule_name` (or other invented keys) under `ruleset.triggered_rule_details`. Only `internal_note` and `custom_action_key` are documented. If a demo wants to surface a rule's name, put it in the `internal_note` text itself (e.g. `"internal_note": "stable_inflows_low_network_risk — Stable inflows; low cross-network risk"`).

## Trust Index / Ti2 (Limited Availability) — Protect SDK surface

**Status (verified 2026-05-22):** Ti2 shipped **Oct 14, 2025** (Plaid blog: "Introducing Ti2"). Limited Availability with three SKUs — see below. Public docs DO describe the integration pattern (Plaid Protect Megadoc + Testing & Integration Resources); only the **per-field response shapes** for `trust_index.subscores` and the full `fraud_attributes` catalog remain partly confidential (subset documented).

**The three TI SKUs (commercial — not API field names):**

| SKU | Signals used | Where in funnel | Price (per event) |
|-----|--------------|-----------------|-------------------|
| **TI Score (Device)** | Device-only | Pre-PII (very early funnel) | `$0.10` |
| **TI Score (Identity)** | Device + PII (name, dob, phone, email, addr) — can pair with IDV but doesn't require it | At identity collection | (between Device and Full) |
| **TI Score (Full)** | Device + Identity + bank-account signals | Final decisions (account opening, transaction approval) | `$2.50` rack |

**What's new in Ti2 (vs Ti1, May 2025):** transaction-history features + live user-graph analysis → catches **~30% more fraud** (Plaid marketing-approved stat from the Ti2 launch blog).

### Documented Protect API surface (use these in demos)

| Endpoint | Purpose | Returns `trust_index`? |
|----------|---------|-----------------------|
| **`POST /protect/event/send`** | Send a new event (Link session, transaction, login, PII collection) to enrich user data and **optionally get a Trust Index score back**. Used to score Protect SDK sessions and ad-hoc events. | Yes — `trust_index` block with `score`, `model`, `subscores`. |
| **`POST /protect/user/insights/get`** | Retrieve current Trust Index + fraud attributes for an existing Plaid User. Used for periodic re-scoring or webhook-driven check-ins. | Yes — same `trust_index` block. |
| **`POST /identity_verification/get`** (when bundled `['protect_linked_bank', 'identity_verification']`) | Returns `link_sessions[].results.protect_results.trust_index` + `fraud_attributes`. | Yes — same shape. |
| **`POST /signal/evaluate`** | Signal transaction scoring. **Does NOT return a `trust_index` field** (AskBill verified). | **No** — Signal scores only. |

### `trust_index` block shape (canonical — Plaid Protect Megadoc)

```json
{
  "event": {
    "event_id": "protect-event-2be8498f",
    "timestamp": "2026-05-22T03:26:02Z",
    "event_type": "LINK_EVENT_SESSION_FINISH",
    "trust_index": {
      "score": 87,
      "model": "ti-pro-2.0",
      "subscores": {
        "device": 92,
        "identity": 88,
        "transaction_graph": 82
      }
    },
    "fraud_attributes": {
      "idv_session.email.breach_count": 1,
      "user.linked_bank_accounts.num_owner_names": 3,
      "session.ip.is_proxy": false
    }
  }
}
```

- `trust_index.score`: **1–100, higher = SAFER user** (opposite direction from Signal scores).
- `trust_index.model`: model id string (e.g. `ti-pro-2.0`, `ti-link-session-2.0`). Specific model is mapped per-customer per-event-type.
- `trust_index.subscores`: object with sub-score keys; **the public catalog is partial** — don't enumerate fields beyond `device`, `identity`, `transaction_graph` in demos unless the prompt explicitly cites others.
- `fraud_attributes`: key/value bag of behavioral signals. **Only present when the user/event is suspected fraudulent** in many cases — Plaid surfaces fraud signals selectively. In a happy-path demo (score 80+), this block may be empty or omitted.

### Webhook events for Protect SDK

- `LINK_EVENT_SESSION_FINISH` — internal Plaid event when a Link session completes and TI is computed.
- `PROTECT_EVENT_RUN_FINISH` — internal event when `/protect/event/send` finishes TI computation.
- For customer-side webhooks, use the Signal webhooks (`SIGNAL_SCORE_READY`, `SIGNAL_RULE_TRIGGERED`) and Protect Tx Monitor (`PROTECT_TX_MONITOR_RULE_TRIGGERED`).

### Demo rule for Trust Index (updated)

- **Default Protect demo path:** Link with `['protect_linked_bank']` (+ `'signal'` for tx scoring) → `/protect/event/send` after Link onSuccess → show `trust_index.{score, model, subscores}` in the API panel → optionally chain `/signal/evaluate` for transaction-time decisioning.
- **Trust Index narrative is allowed AND wire-format accurate** — present the `trust_index` block directly in `#api-response-panel`. Do NOT route Trust Index narrative through `/signal/evaluate` (which doesn't return the field).
- DO NOT enumerate `subscores` keys beyond the documented `device` / `identity` / `transaction_graph`. DO NOT enumerate `fraud_attributes` keys beyond the small list above without sourcing from the Megadoc.
- Do NOT use the Trust Index term in non-Protect demos — it conflicts with Signal score branding.
- Trust Index pricing ($0.10 / $2.50) belongs on slides only, never on host UI.

## Approved product-name guidance

- **Plaid Protect** (umbrella; use exactly).
- **Trust Index** / **Ti2** — allowed in Plaid Protect demos only; mark Limited Availability when the demo discloses GA status.
- Component product names continue to use their own verbatim forms: **Plaid Signal**, **Plaid Identity Verification (IDV)**, **Plaid Monitor**.

## Demo guidance — canonical happy path

**Default mode:** Plaid Protect demos use **`protect_linked_bank`** in the Link products[] array — this is the canonical Protect SDK pattern documented in the Plaid Protect Megadoc and surfaces Trust Index Ti2 scores via `/protect/event/send`. Use the IDV bundle (`['protect_linked_bank', 'identity_verification', 'signal']`) **only** when the prompt explicitly references IDV / identity verification as a featured product.

**Persona / scenario:** A fintech (neobank, BNPL, marketplace, crypto exchange) needs a single risk decision at user onboarding or transaction time, combining identity confidence + transaction risk.

**Beats:**

1. Host app — onboarding or payment confirmation screen.
2. Plaid Link launches with **`products: ['protect_linked_bank', 'signal']`** (add `'identity_verification'` only if the prompt mentions IDV). One real-SDK step; `plaidPhase: "launch"`. US-only — `protect_linked_bank` requires US country code.
3. After Link `onSuccess`, host calls **`POST /protect/event/send`** with `event_type: "LINK_EVENT_SESSION_FINISH"` to retrieve the Trust Index score.
4. Insight reveal — API panel on host step shows the `trust_index` block: `score` (1–100, higher = safer), `model`, `subscores: { device, identity, transaction_graph }`. Optionally show `fraud_attributes: {}` (empty for happy-path).
5. (Optional, transaction-time step) Call `/signal/evaluate` with `client_transaction_id`, `amount`, ruleset_key; API panel shows `scores.bank_initiated_return_risk` + `scores.customer_initiated_return_risk` + 2–3 `core_attributes` + `ruleset.result: ACCEPT`, `triggered_rule_details.internal_note` only (no `rule_name`), `warnings: []`.
6. Outcome — host app confirms the decision; optionally show a follow-up call to `/signal/decision/report`.
7. Value summary — single Plaid-branded slide tying Protect to consolidation (fewer vendors), explainability, and Trust Index as the differentiator (Ti2 catches 30% more fraud than Ti1 — Plaid marketing-approved stat from Oct 14 2025 launch blog).

**Wire-format anti-patterns (build-app must NOT emit these):**

- `products: ['auth', 'signal']` in a Plaid Protect demo — narrates Trust Index but the wire format only retrieves Signal scores. **Use `protect_linked_bank` instead** so the wire format actually carries the Trust Index payload.
- `ruleset.triggered_rule_details.rule_name: "..."` — fabricated field. Use `internal_note` only.
- A `trust_index` block on a `/signal/evaluate` response — Signal does not return that field. Put it under `/protect/event/send` or `/identity_verification/get` response instead.
- A `reason_codes: [...]` array — not documented anywhere. Use `core_attributes` + `internal_note`.

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
