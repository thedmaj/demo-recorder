---
last_vp_research: "2026-05-21"
---

# Plaid Check CRA — Cash Flow Insights (beta)

> **Product family key:** `cra_cashflow_insights`  
> **Retrieve:** `POST /cra/check_report/cashflow_insights/get` after `USER_CHECK_REPORT_READY`

## Overview

Cash Flow Insights adds aggregated cash-flow **attributes** (key/value) on top of the CRA Base Report foundation — income volatility, NSF patterns, savings stability, discretionary vs essential spend, loan-payment burden, etc.

## Demo rules

- Standard CRA flow: `/user/create` → CRA Link (`plaidPhase: "launch"`) → report-ready beat → `POST /cra/check_report/cashflow_insights/get` after webhook `CHECK_REPORT` + `USER_CHECK_REPORT_READY`
- Response `report.attributes` is a **key/value object** (map), not an array of `{name, value}` pairs (per Plaid docs)
- Surface **2–4 named attributes** on screen (not the full attribute dump)
- Beta product — note beta in narration when discussing production rollout
- FCRA consumer-report framing; permissible purpose on token config
- Setup / data-returned explanatory beats = Plaid-branded slides, not CarMax host chrome

## CarMax GTM context (internal)

- Near-prime / subprime auto finance; bureau-only today; expanding funnel with cash-flow underwriting
- Opp: `ENT-CarMax- LendScore & CRA` — primary interest includes **Cash Flow Insights** + ability-to-pay from cash-flow data

## Sample attributes (demo-safe)

- `income_volatility_low` / income stability signals
- `cash_reliance_atm_withdrawal_amt_cv_90d`
- NSF / overdraft frequency attributes
- Discretionary vs essential spend rollups (30d / 90d windows)

## Value Proposition Statements
<!-- Auto-seeded / refreshed by research phase on 2026-05-21.
     A human should review and promote into Primary Pitch / Supporting Claims. -->

### Candidate Value Propositions (research-derived)
- Expand the credit funnel into near-prime and subprime segments without taking on undue risk — cash-flow underwriting surfaces ability-to-pay signals invisible to traditional bureaus
- Replace or augment thin/no-file bureau decisions with FCRA-compliant consumer-report data sourced directly from the applicant's bank
- Reduce ACH/payment default risk by underwriting on income stability, NSF history, and discretionary spend burden rather than backward-looking bureau tradelines
- Single integration delivers base report + cash flow attributes + optional LendScore — lenders avoid stitching together multiple data vendors
- Beta-stage attribute library is purpose-built for credit models — attributes are model-ready key/value pairs, not raw transaction dumps
