---
last_vp_research: "2026-05-21"
last_api_verified: "2026-05-21"
source: "AskBill plaid_docs MCP, March 2025 docs snapshot"
---

# Plaid Cash Advance Score (EWA Score)

> **Product family key:** `cash_advance_score`
> **Also known as:** EWA Score (Salesforce primary product name), Plaid Protect Cash Advance Score
> **Family:** **Plaid Protect** (delivered via Plaid Signal API). **NOT** a CRA / Consumer Report product.
> **NOT to be confused with:** Plaid Signal ACH return-risk (`bank_initiated_return_risk` / `customer_initiated_return_risk`), CRA LendScore, or Bank Income.

## Overview

Cash Advance Score predicts repayment likelihood for instant-disbursement / earned-wage-access / small-dollar advance products. It is a **Plaid Protect** score that rides the same `/signal/evaluate` endpoint as standard Plaid Signal, but is enabled separately on the Plaid account by Sales and surfaces as a distinct response field.

## API pattern (end-to-end)

**Verified against Plaid docs via AskBill on 2026-05-21.**

| # | Step | Endpoint | Notes |
|---|------|----------|-------|
| 1 | Create Link token | `POST /link/token/create` | `products: ["auth", "signal"]`. `'signal'` is a valid Link product string as of October 2024. No `/user/create` bootstrap required (unlike Bank Income / CRA). |
| 2 | User completes Plaid Link | (browser) | Standard Link modal. Receive `public_token` in `onSuccess`. |
| 3 | Exchange for access token | `POST /item/public_token/exchange` | Returns `access_token`. |
| 4 | Evaluate at disbursement decision | `POST /signal/evaluate` | Body below. Returns `scores` object. |
| 5 | Report outcome (optional, recommended) | `POST /signal/decision/report` | Same endpoint as standard Signal: `{ client_transaction_id, initiated }`. |

### `/signal/evaluate` request body (canonical shape)

```json
{
  "access_token": "access-sandbox-...",
  "account_id": "account-id-...",
  "client_transaction_id": "ewa-advance-2026-05-21-001",
  "amount": 150.00,
  "client_user_id": "current-user-7421",
  "ruleset_key": "ewa_default",
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

### `/signal/evaluate` response (when Cash Advance Score is provisioned)

```json
{
  "scores": {
    "customer_initiated_return_risk": { "score": 8 },
    "bank_initiated_return_risk": { "score": 56 },
    "cash_advance": { "score": 27 }
  },
  "core_attributes": {
    "available_balance": 2200,
    "current_balance": 2000
  },
  "ruleset": {
    "ruleset_key": "ewa_default",
    "result": "APPROVE",
    "triggered_rule_details": {
      "internal_note": "Stable inflows, low cross-EWA churn"
    }
  },
  "warnings": [],
  "request_id": "abcdef123456"
}
```

### Field to read

- **Primary:** `response.scores.cash_advance.score` (1–99, **higher = higher risk**).
- **Fallback** (if Cash Advance Score is not provisioned by Sales on your Plaid account, the `cash_advance` key is absent): `response.scores.bank_initiated_return_risk.score`. Narration must say so honestly — do not pretend it is the EWA-specific score.

> **Score direction is the same as standard Signal:** higher number = higher risk. Approve when the score is LOW.
> Previously this file said "higher = better repayment likelihood" — that was WRONG. Corrected 2026-05-21 against AskBill.

### Reason-code framing

There is **no documented `reason_codes[]` array** on the `/signal/evaluate` response. Explainability comes from:

1. `core_attributes` — 80+ documented key/value behavioral signals (balance history, inflow stability, etc.).
2. `ruleset.triggered_rule_details.internal_note` — a free-text note from the matching ruleset rule.
3. Named rule outcomes inside `ruleset.result` (`APPROVE` / `REVIEW` / `REROUTE` / `REJECT`).

**Demo rule:** Show 2–3 named `core_attributes` and/or named ruleset rule outcomes. Do NOT invent a top-level `reason_codes: [...]` array — that violates the API panel contract.

## Demo rules (build + script stage must follow)

- **Plaid Link products:** `["auth", "signal"]` — exactly. No `cra_*`, no `income_verification`, no `transactions`.
- **No `/user/create`** — Cash Advance Score path uses the standard Link flow.
- **Score range:** 1–99, higher = higher risk. Approve at low scores (typical EWA approve threshold: 30 or below).
- **Approve a specific dollar advance** (e.g. `$150`), not a generic "ACCEPT". The demo's value is the disbursement decision, not a credit-bureau-style fraud check.
- **Ruleset decision:** Anchor the on-screen reveal to a named ruleset result (`APPROVE` / `REVIEW`) plus 2–3 attributes or rule names.
- **No CRA framing:** No "consumer report", no `consumer_report_permissible_purpose`, no `cra_options`, no LendScore vocabulary.
- **No standard-Signal ACH return-risk framing:** Avoid "Signal score 12 — ACCEPT" or "ACH return risk" wording. Use repayment / EWA disbursement language.

## Sales enablement

- Cash Advance Score requires **Plaid Sales enablement** on the account. Demo accounts may need to use the `bank_initiated_return_risk.score` fallback in sandbox; mark this honestly in the demo script.
- `ruleset_key` controls policy / actions (which rules fire, what `ruleset.result` is returned). It does NOT control whether the score appears — enablement does.

## Personas / GTM

- Neobanks offering early-wage / paycheck-advance features (e.g. Current, Chime SpotMe-style products).
- Standalone cash-advance apps (DailyPay, EarnIn-style, etc.).
- Gig-economy and payroll-adjacent fintechs deciding small-dollar advances at request time.

## Approved talk track (draft)

- "Plaid's Cash Advance Score combines cash-flow and network intelligence so you approve more qualified members and right-size their advance amount."
- "Score 27 — APPROVE: stable inflows, low cross-EWA churn risk. Maya's $150 advance lands in Current immediately."
- (If using bank_initiated_return_risk fallback) "Plaid Signal bank-initiated return risk: 56 — REVIEW. Approve at the smaller tier."

## Value Proposition Statements

### Candidate Value Propositions (research-derived)

- Cash Advance Score is purpose-trained on repayment behavior for earned-wage and cash-advance use cases — distinct from generic ACH return-risk, which optimizes for a different decision.
- Same Plaid Link session and same `/signal/evaluate` endpoint as standard Signal — one integration, multiple risk decisions tied to the use case.
- `core_attributes` give product and ops teams explainability for individual decisions without inventing reason codes.
- Network-derived features catch cross-app repeat-borrower behavior that single-app transaction history cannot.
- Real-time score + ruleset decision at the point of disbursement enables instant approval and dynamic advance sizing.

## Salesforce / GTM snippets (internal)

- **Current — EWA Score** (`006UV00000ZdL3dYAF` Discovery): expanding EWA product line; evaluating dedicated score.
- **Kikoff | CAi** (Qualify): uses standard Signal today; pain = no EWA-specific score.
- **Credit Genie — EWA Score** (Closed Won): A/B proved delinquency reduction — reference only.
