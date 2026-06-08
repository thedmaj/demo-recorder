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
last_ai_update: "2026-05-31T00:00:00Z"
approved: true
version: 1
last_vp_research: "2026-05-30"
---

# Plaid Check CRA LendScore (beta)

## Overview

LendScore is a **Plaid Check CRA add-on** (closed beta) that predicts **12-month non-mortgage default risk** on a **1–99 scale (higher = lower risk / safer to approve)**. It is retrieved **after** the standard CRA report-ready lifecycle — never as a standalone Link product string.

## Where It Fits

BNPL, personal lending, and near-prime **second-look** flows where the host already uses CRA Base Report. Pair LendScore with Base Report summary fields on the same screen and optionally **Network Insights** on a follow-on slide.

## Value Proposition Statements
<!-- Auto-seeded / refreshed by research phase on 2026-05-30.
     A human should review and promote into Primary Pitch / Supporting Claims. -->

### Candidate Value Propositions (research-derived)
- Approve more creditworthy near-prime shoppers with a cash-flow score that complements the bureau file
- Up to 25% lift in predictive performance vs traditional credit data alone (GTM — use at most once per demo)
- Up to 20% relative risk reduction for some subprime and near-prime segments (GTM — use at most once per demo)

## Customer Use Cases

- BNPL second-look underwriting: LendScore complements bureau file for near-prime applicants bureau would decline; use with Base Report summary chips on the same reveal step
- Personal lending near-prime expansion: 1–99 score predicts 12-month non-mortgage default risk; up to 25% lift in predictive performance vs traditional credit data alone
- Auto finance or lease-to-own decisioning: pair LendScore with Cash Flow Insights for ability-to-pay + default risk on one CRA consumer report

## Proof Points & ROI Metrics

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| Predictive performance lift | Up to 25% vs traditional credit data alone | GTM (use at most once per demo) | medium | 2026-05-21 |
| Risk reduction (subprime/near-prime) | Up to 20% relative risk reduction | GTM | medium | 2026-05-21 |
| Score range | 1–99 (higher = lower default risk = safer to approve) | Plaid docs / AskBill | high | 2026-05-31 |

## Competitive Differentiators

- CRA-compliant cash-flow credit score — FCRA-regulated, not just a behavior score
- Same consumer report session as Base Report — lenders get underwriting depth without a second Link session
- Reason codes (`report.lend_score.reason_codes[]`) support adverse-action transparency — up to 5 codes per report
- Network Insights available as a follow-on add-on for cross-network account behavior signals

## Objections & Responses

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| [DRAFT] "We already have a credit bureau score" | "LendScore is a cash-flow-trained complement to the bureau file, not a replacement. It picks up ability-to-pay signals — income stability, NSF history — that bureau tradelines miss, especially for near-prime segments." | Product positioning | [DRAFT] |
| [DRAFT] "It's still beta" | "LendScore is closed beta, which means controlled access with dedicated integration support. GTM proof points show up to 25% predictive lift — current customers are running it in parallel for validation." | GTM | [DRAFT] |

## Implementation Pitfalls
<!-- demo-UI guidance -->
- **Consumer/host screens stay realistic — no behind-the-scenes leakage.** Never show webhook/event names (e.g. `USER_CHECK_REPORT_READY`, `SESSION_FINISHED`), raw API endpoints/field names, raw report JSON, `report_id`/`user_id`, or the raw `EXTENSION_OF_CREDIT` enum on host screens. Normalize permissible purpose for humans (e.g. "Extension of credit"). Move technical detail / raw report data to Plaid **slides**, the JSON **`#api-response-panel`**, or a clearly labeled **"Underwriter Internal view"** step. (Full guidance: see the "Demo UI Guidance" section in `inputs/products/plaid-cra-base-report.md`.)

- **`cra_base_report` must be in `products[]`** alongside `cra_lend_score` — LendScore is an add-on, never standalone
- **`cra_options.cra_lend_score.version: "LS1"`** is required on the Link token (AskBill-confirmed 2026-05-31)
- **API panel must show `lend_score/get`** endpoint — do NOT show `base_report/get` when the step is the LendScore reveal
- **LendScore reason codes are in `report.lend_score.reason_codes[]`** — NOT the same shape as Signal `ruleset.result` or `core_attributes`
- **Beta callout required** — `report.lend_score.model_status` may be `BETA`; always note beta in UI and narration
- **Score direction is OPPOSITE to Signal** — LendScore 1–99 higher = SAFER (Signal 1–99 higher = riskier); never confuse the two

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

- LendScore reveal: "LendScore returns seventy-eight on the one-to-ninety-nine scale — low twelve-month default risk. Reason codes support the approve decision with adverse-action transparency."
- Demo opener: "LendScore is a Plaid Check add-on that predicts twelve-month non-mortgage default risk from consumer-permissioned bank data — a cash-flow complement to the bureau score."

### LendScore reveal (host)
> "LendScore returns seventy-eight on the one-to-ninety-nine scale — low twelve-month default risk. Reason codes support the approve decision with adverse-action transparency."

## Do Not

- Invent `reason_codes[]` at the Signal `/signal/evaluate` shape
- Label the API panel as Base Report when the step endpoint is `lend_score/get`
- Present LendScore as GA without beta callout
- Use federal student loan / Mohela liabilities tropes (wrong product family)
