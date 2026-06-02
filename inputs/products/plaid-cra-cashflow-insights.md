---
product: "Plaid Check CRA Cash Flow Insights"
slug: "cra-cashflow-insights"
api_endpoints:
  - "/user/create"
  - "/link/token/create"
  - "/cra/check_report/create"
  - "/cra/check_report/cashflow_insights/get"
use_cases:
  - "cash-flow-underwriting"
  - "near-prime-credit-expansion"
  - "ability-to-pay-assessment"
last_human_review: ""
last_ai_update: "2026-05-31T00:00:00Z"
needs_review: true
approved: false
version: 1
last_vp_research: "2026-05-21"
---

# Plaid Check CRA Cash Flow Insights (beta)

> **Product family key:** `cra_cashflow_insights`
> **Retrieve:** `POST /cra/check_report/cashflow_insights/get` after `USER_CHECK_REPORT_READY`

## Overview
Plaid Check Cash Flow Insights adds aggregated cash-flow **attributes** (key/value pairs) on top of the CRA Base Report foundation — surfacing income volatility, NSF patterns, savings stability, discretionary vs essential spend, and loan-payment burden. It is a **beta** FCRA-compliant consumer report add-on retrieved after the async report-ready lifecycle. It is NOT a standalone product: `cra_base_report` must also be in `products[]`.

## Where It Fits
Feature Cash Flow Insights when the persona is a lender or credit platform that needs to expand into near-prime or subprime segments by underwriting on cash-flow behavior, not just bureau tradelines. Strong use case: auto finance (CarMax, thin-file buyers), BNPL second-look, and any context where "ability to pay" signals from bank data supplement or replace bureau-only decisions.

## Value Proposition Statements
<!-- ⚠️ HUMAN-OWNED — pre-approved messaging. AI may ADD candidates marked [DRAFT]
     but must NOT modify or remove approved statements. -->

### Primary Pitch
> "Surface cash-flow ability-to-pay signals invisible to traditional bureaus — directly from the consumer's bank account, packaged as FCRA-compliant attributes for your underwriting models."

### Supporting Claims
- [DRAFT] Expand the credit funnel into near-prime and subprime segments without taking on undue risk — cash-flow underwriting surfaces ability-to-pay signals invisible to traditional bureaus.
- [DRAFT] Replace or augment thin/no-file bureau decisions with FCRA-compliant consumer-report data sourced directly from the applicant's bank.
- [DRAFT] Reduce ACH/payment default risk by underwriting on income stability, NSF history, and discretionary spend burden rather than backward-looking bureau tradelines.
- [DRAFT] Single integration delivers base report + cash flow attributes + optional LendScore — lenders avoid stitching together multiple data vendors.
- [DRAFT] Beta-stage attribute library is purpose-built for credit models — attributes are model-ready key/value pairs, not raw transaction dumps.

## Proof Points & ROI Metrics
<!-- ⚠️ HUMAN-OWNED — every claim requires a Source. AI adds [DRAFT] rows only. -->

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| [DRAFT] CarMax near-prime / subprime GTM: bureau-only today, expanding with cash-flow underwriting | Ability-to-pay expansion from bank data | CarMax ENT opp (Glean) | medium | 2026-05-21 |

## Customer Use Cases

- Near-prime / subprime credit expansion: cash-flow attributes (income stability, NSF patterns, spending burden) complement the bureau file for applicants traditional scoring misses
- Ability-to-pay auto finance: income volatility and discretionary spend rollups inform credit models for auto lenders (CarMax GTM use case)
- BNPL second-look: attributes surface whether a declined applicant has stable cash flows that predict repayment despite a thin bureau file

### Near-Prime / Subprime Credit Expansion
**Persona:** Product or underwriting lead at an auto lender or BNPL platform
**Problem:** Bureau-only decisions reject creditworthy near-prime applicants with thin or stale files
**Solution:** Cash Flow Insights adds income stability, NSF patterns, and discretionary spend attributes to the underwriting surface alongside the Base Report
**Outcome:** More confident approval decisions for near-prime segments without proportional increase in default risk

### [DRAFT] Ability-to-Pay Auto Finance (CarMax GTM)
**Persona:** Credit product team at auto finance desk (CarMax-style)
**Problem:** Bureau-only underwriting misses ability-to-pay context for near-prime and subprime shoppers
**Problem:** Need cash-flow data that is FCRA-compliant and model-ready
**Solution:** Cash Flow Insights attributes (income volatility, NSF count, essential/discretionary spend) inform credit model as part of the CRA consumer report
**Outcome:** Expanded funnel with data-backed confidence on ability-to-pay decisions
**Source:** CarMax ENT-LendScore & CRA Glean opp (internal)

## Narration Talk Tracks
<!-- ⚠️ HIGHEST PRIORITY for script generation — word-perfect, max 35 words each.
     HUMAN-OWNED — AI must not modify approved blocks. -->

- Demo opener: Plaid Check Cash Flow Insights adds ability-to-pay attributes — income stability, NSF history, spending burden — on top of the CRA Base Report, giving underwriters a fuller picture from bank data
- Attributes reveal: Cash Flow Insights returns key-value attributes — income volatility, overdraft frequency, essential-spend burden — model-ready signals lenders can plug directly into underwriting logic

### Demo Opening
> "Today we'll show how Plaid Check Cash Flow Insights adds ability-to-pay attributes — income stability, NSF history, spending burden — on top of the CRA Base Report, giving underwriters a fuller picture from bank data." (35 words)

### Report-ready step
> "After the user links their account, Plaid generates the consumer report and notifies your system. Cash Flow Insights attributes are ready to retrieve alongside the Base Report." (28 words)

### Attributes reveal step
> "Cash Flow Insights returns key-value attributes — income volatility, overdraft frequency, essential-spend burden — model-ready signals lenders can plug directly into their underwriting logic." (25 words)

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names.
     Build agents and script generator must use these exactly. -->

- **`products[]` string:** `cra_cashflow_insights` (always paired with `cra_base_report`)
- **Link token:** `/link/token/create` with `products: ["cra_base_report", "cra_cashflow_insights"]` + `consumer_report_permissible_purpose` + `cra_options: { cra_cashflow_insights: { version: "CFI1" } }`
- **Requires:** `/user/create` first (returns `user_id` passed into Link token)
- **Report creation:** `POST /cra/check_report/create` (triggers async report generation)
- **Retrieval endpoint:** `POST /cra/check_report/cashflow_insights/get` (after `USER_CHECK_REPORT_READY` webhook)
- **Response:** `report.attributes` is a **key/value object (map)**, NOT an array of `{name, value}` pairs
- **Beta:** `cra_options.cra_cashflow_insights.version` = `"CFI1"` — call out beta status in narration
- **Async lifecycle:** report requested → report generating → `USER_CHECK_REPORT_READY` webhook → retrieve
- **Link requirement:** real Plaid Link CRA/Check modal (`plaidPhase: "launch"`) — no simulated host-only Link flow
- **Sandbox:** `user_credit_*` personas (e.g. `user_credit_profile_excellent`), non-OAuth institution (`ins_109508`)

### Sample demo-safe attributes

- `income_volatility_low` / income stability signals
- `cash_reliance_atm_withdrawal_amt_cv_90d`
- NSF / overdraft frequency attributes
- Discretionary vs essential spend rollups (30d / 90d windows)

**Demo rule:** Surface **2–4 named attributes** on screen — do NOT dump the full attribute object.

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

- [DRAFT] FCRA-compliant cash-flow attributes purpose-built for credit models — not raw transaction dumps.
- [DRAFT] Single integration delivers Base Report + Cash Flow Insights + optional LendScore under one consumer report contract.

## Implementation Pitfalls
<!-- ⚠️ HUMAN-OWNED — product-specific mistakes to avoid in prompts, scripts, and demos. -->

- **Always pair `cra_cashflow_insights` with `cra_base_report`** in `products[]` — Cash Flow Insights is an add-on, not standalone.
- **`report.attributes` is a key/value map** — do not treat it as an array of `{name, value}` objects.
- **Async lifecycle is required** — include a report-ready beat before the attribute reveal; do not skip straight from Link to the attributes display.
- **Beta product** — note beta status in narration when discussing production rollout.
- **FCRA framing** — always include `consumer_report_permissible_purpose` on the Link token.
- **Setup / data-returned beats** should use Plaid-branded slides (`.slide-root`), not customer host chrome.
- **Sandbox:** use `user_credit_*` personas, NOT `user_bank_income` (wrong product family).

## Framework QA Learnings
<!-- 🔄 SHARED — curated prompt/build lessons for this product family. -->

- Reuse the single global `api-response-panel` for all report-insight steps.
- Keep report-ready and attributes-reveal steps visually distinct so QA start/mid/end frames don't blur the async lifecycle.
- CRA setup/data explanation beats are easiest to validate when rendered as Plaid-branded slide steps.

## Objections & Responses
<!-- 🔄 SHARED — AI adds [DRAFT] from Gong; human approves by removing [DRAFT] tag. -->

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| [DRAFT] "Why not just use Transactions?" | "Transactions gives you raw data; Cash Flow Insights gives you model-ready FCRA-compliant attributes derived from that data — income volatility, NSF counts, spending burden — designed to plug directly into underwriting models." | Product positioning | [DRAFT] |

## AI Research Notes
<!-- 🤖 AI-OWNED — auto-populated by research.js after each pipeline run. -->

### 2026-05-31 — AskBill + Glean research [ai]
- Confirmed endpoint: `POST /cra/check_report/cashflow_insights/get`
- Confirmed `products[]` string: `cra_cashflow_insights` (must pair with `cra_base_report`)
- Confirmed `cra_options.cra_cashflow_insights.version: "CFI1"` required
- Confirmed `report.attributes` is a key/value map (not array)
- Confirmed async lifecycle: `USER_CHECK_REPORT_READY` webhook before retrieval
- CarMax GTM context sourced from Glean internal opp data
- Sources: AskBill plaid_docs MCP, Glean GTM/opp research, 2026-05-31

### 2026-05-21 — Run: prior pipeline run (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Expand the credit funnel into near-prime and subprime segments without taking on undue risk — cash-flow underwriting surfaces ability-to-pay signals invisible to traditional bureaus","status":"DRAFT"}
- [high] {"claim":"Replace or augment thin/no-file bureau decisions with FCRA-compliant consumer-report data sourced directly from the applicant's bank","status":"DRAFT"}
- [high] {"claim":"Reduce ACH/payment default risk by underwriting on income stability, NSF history, and discretionary spend burden rather than backward-looking bureau tradelines","status":"DRAFT"}
- [high] {"claim":"Single integration delivers base report + cash flow attributes + optional LendScore — lenders avoid stitching together multiple data vendors","status":"DRAFT"}
- [high] {"claim":"Beta-stage attribute library is purpose-built for credit models — attributes are model-ready key/value pairs, not raw transaction dumps","status":"DRAFT"}

## Change Log

- 2026-05-21: Original stub created (partial — missing full template structure) [ai]
- 2026-05-31: Expanded to full template structure with product overview, use cases, value props, accurate terminology, implementation pitfalls. AskBill-verified endpoints and API shape [ai]
