---
product: "Plaid Cash Advance Score (EWA Score)"
slug: "ewa-score"
api_endpoints:
  - "/link/token/create"
  - "/signal/evaluate"
  - "/signal/decision/report"
use_cases:
  - "ewa-disbursement-decisioning"
  - "cash-advance-repayment-risk"
  - "instant-paycheck-advance"
last_vp_research: "2026-05-21"
last_api_verified: "2026-05-31"
last_ai_update: "2026-05-31T00:00:00Z"
needs_review: true
approved: false
version: 1
source: "AskBill plaid_docs MCP, verified 2026-05-31"
---

# Plaid Cash Advance Score (EWA Score)

> **Product family key:** `cash_advance_score`
> **Also known as:** EWA Score (Salesforce primary product name), Plaid Protect Cash Advance Score
> **Family:** **Plaid Protect** (delivered via Plaid Signal API). **NOT** a CRA / Consumer Report product.
> **NOT to be confused with:** Plaid Signal ACH return-risk (`bank_initiated_return_risk` / `customer_initiated_return_risk`), CRA LendScore, or Bank Income.

## Overview

Cash Advance Score predicts repayment likelihood for instant-disbursement / earned-wage-access / small-dollar advance products. It is a **Plaid Protect** score that rides the same `/signal/evaluate` endpoint as standard Plaid Signal, but is enabled separately on the Plaid account by Sales and surfaces as a distinct response field.

## Where It Fits
Feature Cash Advance Score when the demo persona is an EWA platform, neobank offering a paycheck-advance feature (Chime SpotMe-style), or cash-advance app that needs to score repayment likelihood at disbursement time — not at bank-link time. Distinct from standard Plaid Signal (which optimizes for ACH return risk, not EWA repayment) and from CRA LendScore (which is a 12-month default prediction, not a real-time disbursement gate).

## Customer Use Cases

- EWA / earned wage access disbursement: score repayment likelihood at request time; `scores.cash_advance.score` (1–99, lower = safer) gates instant disbursement vs review
- Cash-advance app repayment gating: network-derived cross-app features catch repeat borrowers that single-app transaction history misses

### EWA / Earned Wage Access Disbursement Decision
**Persona:** Product lead at an EWA app (Current, DailyPay, EarnIn-style)
**Problem:** Need to score repayment likelihood before releasing a $50–$200 cash advance at request time, without requiring additional friction or a credit pull
**Solution:** Link with `["auth", "signal"]`, then call `/signal/evaluate` with `ruleset_key: "ewa_default"` at disbursement time; `scores.cash_advance.score` (1–99, lower = safer) determines approve/review
**Outcome:** Instant advance disbursement for low-score (safe) members; stepped-up review or reduced amount for higher-risk requests

### Cash-Advance App Repayment Gating
**Persona:** Product team at a standalone cash-advance app (gig economy / payroll-adjacent)
**Problem:** First-party fraud and cross-app repeat borrowing inflate default rates; existing bank balance check is insufficient
**Solution:** Cash Advance Score adds network-derived features (cross-app churn, inflow stability) that single-app transaction history cannot replicate
**Outcome:** Lower default rates at same approval volume; `core_attributes` provide explainability for ops team

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names. -->

- **Product family:** Plaid Protect (NOT CRA, NOT standard Signal-only)
- **`products[]` in Link token:** `["auth", "signal"]` — never `cra_*`, `income_verification`, or `protect_linked_bank`
- **No `/user/create`** required — standard Link flow
- **Evaluation endpoint:** `POST /signal/evaluate` — same endpoint as standard Signal; Cash Advance Score is provisioned by Sales on the account
- **Primary score field:** `response.scores.cash_advance.score` — 1–99, **higher = higher risk** (same direction as standard Signal)
- **Fallback if not provisioned:** `response.scores.bank_initiated_return_risk.score` — disclose in narration if used
- **`ruleset.result` values:** `ACCEPT` / `REVIEW` / `REROUTE` — **NOT `APPROVE`** (AskBill-confirmed 2026-05-31: `APPROVE` is not a documented Signal `ruleset.result` value)
- **No `reason_codes[]` array** — explainability via `core_attributes` (80+ key/value behavioral signals) and `ruleset.triggered_rule_details.internal_note`
- **Feedback endpoint:** `POST /signal/decision/report` — same as standard Signal
- **Sales enablement required:** `cash_advance` key is absent from the response unless the Plaid account has EWA Score enabled by Sales

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

- Purpose-trained on EWA/cash-advance repayment behavior — distinct from generic ACH return risk optimization
- Network-derived features catch cross-app repeat-borrower behavior that single-app transaction history cannot
- Same Plaid Link session and same `/signal/evaluate` endpoint as standard Signal — one integration, multiple risk decisions tied to use case
- Real-time score + ruleset decision at the point of disbursement enables instant approval and dynamic advance sizing
- `core_attributes` give product and ops teams explainability without inventing reason codes

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
    "result": "ACCEPT",
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
3. Named rule outcomes inside `ruleset.result` (`ACCEPT` / `REVIEW` / `REROUTE`; `APPROVE`/`REJECT` are NOT documented values).

**Demo rule:** Show 2–3 named `core_attributes` and/or named ruleset rule outcomes. Do NOT invent a top-level `reason_codes: [...]` array — that violates the API panel contract.

## Demo rules (build + script stage must follow)

- **Plaid Link products:** `["auth", "signal"]` — exactly. No `cra_*`, no `income_verification`, no `transactions`.
- **No `/user/create`** — Cash Advance Score path uses the standard Link flow.
- **Score range:** 1–99, higher = higher risk. Approve at low scores (typical EWA approve threshold: 30 or below).
- **Approve a specific dollar advance** (e.g. `$150`), not a generic "ACCEPT". The demo's value is the disbursement decision, not a credit-bureau-style fraud check.
- **Ruleset decision:** Anchor the on-screen reveal to the documented `ruleset.result` value (`ACCEPT` / `REVIEW` / `REROUTE`) plus 2–3 named `core_attributes`. **Do NOT use `APPROVE`** — that is not a documented Signal `ruleset.result` value. (AskBill confirmed 2026-05-31: `result` is always `ACCEPT`, `REVIEW`, or `REROUTE` — custom rulesets do not produce custom result strings.)
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
- "Score 27 — ACCEPT: stable inflows, low cross-EWA churn risk. Maya's $150 advance lands in Current immediately."
- (If using bank_initiated_return_risk fallback) "Plaid Signal bank-initiated return risk: 56 — REVIEW. Approve at the smaller tier."

## Narration Talk Tracks

- EWA score reveal: "Score twenty-seven — ACCEPT. Stable inflows, low cross-EWA churn risk. Maya's one hundred fifty dollar advance is approved and disbursed instantly."
- Score demo note: "The Cash Advance Score is 1–99, lower means safer to approve. This is distinct from standard Signal ACH return risk — purpose-trained for EWA repayment likelihood."

## Proof Points & ROI Metrics

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| Score range | 1–99, higher = higher repayment risk | Plaid docs / AskBill | high | 2026-05-31 |
| [DRAFT] Credit Genie retro: delinquency reduction proof | A/B proved delinquency reduction | Glean Salesforce (internal) | medium | 2026-05-21 |
| Network features | 80+ `core_attributes` per evaluation | Plaid docs | high | 2026-05-31 |

## Objections & Responses

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| [DRAFT] "We already use Signal" | "Standard Signal optimizes for ACH return risk (NSF, unauthorized disputes). Cash Advance Score is purpose-trained on EWA repayment behavior — a different prediction target for a different decision." | Product positioning | [DRAFT] |
| [DRAFT] "What if Cash Advance Score isn't provisioned?" | "Fall back to `bank_initiated_return_risk.score` — the score is still useful for gating. Disclose in narration that this is the standard bank-return-risk score, not the EWA-specific model." | AskBill / plaid-ewa-score.md | [DRAFT] |

## Implementation Pitfalls

- **`APPROVE` is NOT a valid `ruleset.result` value** — use `ACCEPT` (AskBill-confirmed 2026-05-31: Signal always returns `ACCEPT`, `REVIEW`, or `REROUTE`)
- **Cash Advance Score requires Sales provisioning** — `scores.cash_advance` key is absent if not enabled; fall back to `bank_initiated_return_risk.score` and disclose
- **Score direction: higher = HIGHER risk** — same direction as standard Signal; approve at LOW scores (e.g. score ≤ 30)
- **No `reason_codes[]` array** — explainability is via `core_attributes` and `ruleset.triggered_rule_details.internal_note`; never fabricate a `reason_codes` field
- **`products[]` is `["auth", "signal"]`** — NOT `cra_*`, NOT `income_verification`, NOT `protect_linked_bank`
- **No CRA framing** — no `consumer_report_permissible_purpose`, no `cra_options`, no LendScore vocabulary

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
