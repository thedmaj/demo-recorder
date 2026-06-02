---
product: "Plaid Bank Income"
slug: "bank-income"
api_endpoints:
  - "/link/token/create"
  - "/credit/bank_income/get"
use_cases:
  - "income-from-bank-data"
  - "traditional-income-verification"
last_human_review: "2026-03-27"
last_ai_update: "2026-05-31T00:00:00Z"
needs_review: true
approved: false
version: 1
last_vp_research: "2026-04-24"
---

# Plaid Bank Income

## Overview
Plaid Bank Income (traditional `income_verification`) retrieves income signals directly from a consumer's linked bank account — surfacing income streams, amounts, and frequency without requiring a paystub or employer contact. It is the non-CRA income path: FCRA compliance is NOT provided. Use this product for income-awareness features in personal finance tools and non-underwriting flows. For FCRA-regulated credit decisioning, use CRA Income Insights instead.

## Where It Fits
Feature Bank Income when the persona needs income context for a product experience (budgeting, savings coaching, EWA eligibility pre-check) rather than a formal lending decision. Distinct from CRA Income Insights (which is FCRA-compliant and report-based) and from Payroll Income / Document Income (which pull directly from payroll providers or uploaded documents). GTM advises migrating US Bank Income users to CRA Income Insights for underwriting use cases.

## Value Proposition Statements
<!-- ⚠️ HUMAN-OWNED — pre-approved messaging. AI may ADD candidates marked [DRAFT]
     but must NOT modify or remove approved statements. -->

### Primary Pitch
> "Pull income signals directly from the consumer's bank — no employer contact, no paystubs, no delays."

### Supporting Claims
- [DRAFT] Consumer-permissioned income directly from the source — no document upload, no third-party payroll contact required.
- [DRAFT] Returns income streams, estimated monthly amounts, and transaction-level history for income-adjacent use cases.
- [DRAFT] For FCRA-regulated credit decisioning, the recommended upgrade path is CRA Income Insights (`/cra/check_report/income_insights/get`) — Bank Income remains the right path for non-regulated income awareness features.

## Proof Points & ROI Metrics
<!-- ⚠️ HUMAN-OWNED — every claim requires a Source. AI adds [DRAFT] rows only. -->

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|

## Customer Use Cases

- Income awareness in PFM / budgeting: retrieve income cadence directly from the linked bank; no employer contact or document upload required
- EWA pre-check (non-underwriting): surface evidence of regular income streams and frequency before allowing a cash advance request

### Income Awareness in PFM / Budgeting
**Persona:** Consumer using a personal finance or savings app
**Problem:** App needs to understand take-home income cadence without a payroll integration
**Solution:** Bank Income retrieves income streams directly from the linked bank account via Plaid Link
**Outcome:** Accurate budget recommendations based on actual income cadence and amounts

### [DRAFT] EWA Pre-check (non-underwriting)
**Persona:** EWA platform checking income presence before offering a cash advance
**Problem:** Need evidence of regular income before the app allows advance requests
**Solution:** Bank Income surfaces whether regular income streams exist and their estimated frequency
**Outcome:** Income-gated eligibility check before directing users to the full EWA flow

## Narration Talk Tracks
<!-- ⚠️ HIGHEST PRIORITY for script generation — word-perfect, max 35 words each.
     HUMAN-OWNED — AI must not modify approved blocks. -->

- Demo opener: Plaid Bank Income retrieves income signals directly from a linked bank account — no paystubs, no employer contact, no delay
- Income reveal: Bank Income detects regular income streams and returns estimated amounts and frequencies directly from transaction history — real income context in seconds

### Demo Opening
> "Today we'll show how Plaid Bank Income retrieves income signals directly from a linked bank account — no paystubs, no employer contact, no delay." (25 words)

### Income reveal step
> "Bank Income detects regular income streams and returns estimated amounts and frequencies directly from transaction history — giving your product real income context in seconds." (26 words)

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names.
     Build agents and script generator must use these exactly. -->

- **Product string:** `income_verification` (in `/link/token/create` `products[]`)
- **`income_verification` Link token accepts only `{income_verification}` or `{income_verification, employment}`** — cannot bundle with `auth`, `identity`, `signal`, `transactions`, or `cra_*` products
- **Retrieval endpoint:** `POST /credit/bank_income/get` (requires `user_token` from `/user/create`)
- **NOT the same as:** CRA Income Insights (`/cra/check_report/income_insights/get`), Payroll Income, or Document Income
- **Not FCRA-compliant** — for credit decisioning use CRA Income Insights

### Sandbox credentials (Link bank step)

| Username | Password | Notes |
|----------|----------|--------|
| `user_bank_income` | `{}` (literal two-character password) | Wide income streams for Bank Income testing |
| `user_prism_1` … `user_prism_8` | any | Additional Bank Income / Partner Insights personas |

Use a **non-OAuth** sandbox institution (e.g. **First Platypus Bank**, `ins_109508`). OAuth flows may ignore special sandbox credentials.

### Not for CRA Check Link
For **Plaid Check / CRA** demos (`cra_base_report`, `cra_income_insights`), use **`user_credit_*`** personas — see [plaid-cra-base-report.md](plaid-cra-base-report.md) and [plaid-income-insights.md](plaid-income-insights.md). Do not use `user_bank_income` as the primary CRA sandbox login.

Reference: [Plaid Sandbox test credentials](https://plaid.com/docs/sandbox/test-credentials/#credit-and-income-testing-credentials).

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

- Bank transaction–sourced income signals without employer contact or document upload.
- [DRAFT] GTM positions CRA Income Insights as the FCRA-compliant successor for underwriting — Bank Income remains the right path for non-regulated income awareness use cases.

## Implementation Pitfalls
<!-- ⚠️ HUMAN-OWNED — product-specific mistakes to avoid in prompts, scripts, and demos. -->

- **Do NOT use `income_verification` for CRA / underwriting flows** — it is not FCRA-compliant; use `cra_income_insights` and the `/cra/check_report/income_insights/get` endpoint instead.
- **Do NOT bundle `income_verification` with `auth`, `signal`, `transactions`, or `cra_*` products** in the same Link token — only `{income_verification}` or `{income_verification, employment}` are valid combinations.
- **Do NOT retrieve via `/credit/bank_income/get` without a valid `user_token`** from `/user/create` — the endpoint requires it.
- **Sandbox login:** `user_bank_income` / `{}` (literal two-character string for the password).

## Framework QA Learnings
<!-- 🔄 SHARED — curated prompt/build lessons for this product family. -->

- Bank Income demos must include a Plaid Link step (real SDK, `plaidPhase: "launch"`) before calling `/credit/bank_income/get`.
- Distinguish clearly in narration that this is bank-transaction-sourced income (not payroll, not document), so viewers understand the data provenance.

## Objections & Responses
<!-- 🔄 SHARED — AI adds [DRAFT] from Gong; human approves by removing [DRAFT] tag. -->

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| [DRAFT] "How is this different from CRA Income Insights?" | "Bank Income is a non-FCRA income-awareness product for PFM and non-regulated use cases. CRA Income Insights is the FCRA-compliant version designed for credit decisioning, with model-driven attributes like forecasted income and predicted next payment date. GTM advises migrating underwriting use cases to CRA Income Insights." | Glean GTM + Migration docs | [DRAFT] |

## AI Research Notes
<!-- 🤖 AI-OWNED — auto-populated by research.js after each pipeline run. -->

### 2026-05-31 — AskBill verification [ai]
- Confirmed endpoint: `POST /credit/bank_income/get` (requires `user_token`)
- Confirmed sandbox credentials: `user_bank_income` / `{}` (literal two-character password)
- Confirmed `products: ["income_verification"]` for Link token; only valid co-product is `employment`
- Confirmed non-FCRA; CRA Income Insights is the regulated upgrade path
- Source: AskBill plaid_docs MCP, 2026-05-31

## Change Log

- 2026-03-27: Original sandbox-credential stub created [human]
- 2026-05-31: Expanded to full template structure with product overview, use cases, value props, accurate terminology, implementation pitfalls. AskBill-verified endpoint and Link product constraints [ai]
