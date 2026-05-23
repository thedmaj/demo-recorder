---
product: Plaid Check CRA LendScore
slug: "cra-lend-score"
api_endpoints:
  - "/user/create"
  - "/link/token/create"
  - "/cra/check_report/create"
  - "/cra/check_report/lend_score/get"
use_cases:
  - "bnpl-underwriting"
  - "near-prime-second-look"
  - "credit-underwriting"
last_human_review: "2026-05-21"
approved: true
version: 1
---

# Plaid Check CRA LendScore (beta)

## Overview

LendScore is a **Plaid Check CRA add-on** (closed beta) that predicts **12-month non-mortgage default risk** on a **1–99 scale (higher = lower risk / safer to approve)**. It is retrieved **after** the standard CRA report-ready lifecycle — never as a standalone Link product string.

## Where It Fits

BNPL, personal lending, and near-prime **second-look** flows where the host already uses CRA Base Report. Pair LendScore with Base Report summary fields on the same screen and optionally **Network Insights** on a follow-on slide.

## Value Proposition Statements

### Primary Pitch
> "Approve more creditworthy near-prime shoppers with a cash-flow score that complements the bureau file."

### Supporting Claims
- "Up to 25% lift in predictive performance vs traditional credit data alone" (GTM — use at most once per demo)
- "Up to 20% relative risk reduction for some subprime and near-prime segments" (GTM — use at most once per demo)

## Accurate Terminology

| Concept | Use exactly |
|--------|-------------|
| Product name | **Plaid LendScore** or **LendScore — beta** |
| Retrieval | `POST /cra/check_report/lend_score/get` |
| Report readiness | `USER_CHECK_REPORT_READY` / `CHECK_REPORT_READY` webhook (async) |
| Score field | `report.lend_score.score` (1–99, higher = lower default risk) |
| Reason codes | `report.lend_score.reason_codes[]` (up to 5, e.g. `PCS0221`) — **not** a top-level `reason_codes[] on Signal |
| Beta | `report.lend_score.model_status` may be `BETA`; call out beta in UI microcopy |
| Base Report pairing | Same `report_id`; may show Base Report **summary** chips (inflow, `days_available`) beside LendScore — does **not** mean the API panel should show `/base_report/get` when the step declares `lend_score/get` |

## Demo Build Contract (host + API panel)

1. **Link:** CRA Check flow — `products` includes `cra_base_report` (+ `cra_income_insights` / `auth` / `signal` only when research resolves them). Single `plaidPhase: "launch"`.
2. **Hero host step** (e.g. `lendscore-reveal`): white/light Zip chrome; visible **LendScore score**, **APPROVE** (or review) outcome, **2–3 reason code chips**, **LendScore — beta** badge.
3. **API panel:** `apiResponse.endpoint` must be `POST /cra/check_report/lend_score/get` with `report.lend_score.score`, `reason_codes`, `score_range`, `request_id`.
4. **Layout:** Reserve **~520px** right margin for `#api-response-panel` on LendScore host steps — main column must not sit under the JSON rail; primary CTA `data-testid="approve-plan-cta"` fully visible.
5. **Slides:** Plaid deck only for explainer beats; raw LendScore JSON stays in the global panel on the host reveal step.

## Narration Talk Tracks

### LendScore reveal (host)
> "LendScore returns seventy-eight on the one-to-ninety-nine scale — low twelve-month default risk. Reason codes support the approve decision with adverse-action transparency."

## Do Not

- Invent `reason_codes[]` at the Signal `/signal/evaluate` shape
- Label the API panel as Base Report when the step endpoint is `lend_score/get`
- Present LendScore as GA without beta callout
- Use federal student loan / Mohela liabilities tropes (wrong product family)
