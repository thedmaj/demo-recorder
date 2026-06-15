---
product: Plaid Check Income Insights
slug: "income-insights"
api_endpoints:
  - "/user/create"
  - "/link/token/create"
  - "/cra/check_report/income_insights/get"
use_cases:
  - "credit-underwriting"
  - "consumer-report-income-review"
  - "income-stability-assessment"
last_human_review: "2026-03-26"
last_ai_update: "2026-06-15T12:52:10.313Z"
needs_review: true
approved: true
version: 1
last_vp_research: "2026-05-25"
---

# Plaid Check Income Insights

## Overview
Plaid Check Income Insights is part of the Plaid Check / Consumer Report suite and should be framed as a report-based income-understanding product for underwriting and review workflows. It is not the same as traditional Plaid Income Bank Income, Payroll Income, or Document Income APIs.

## Where It Fits
Feature this product when the persona needs a consumer-report workflow that adds income-oriented insight to a credit or underwriting review. Good stories include lending and account review where the decision depends on report-derived income understanding rather than direct payroll or paystub collection.

## Value Proposition Statements
<!-- Auto-seeded / refreshed by research phase on 2026-05-25.
     A human should review and promote into Primary Pitch / Supporting Claims. -->

### Candidate Value Propositions (research-derived)
- Add report-based income insight to your underwriting workflow without switching out of the Plaid Check consumer-report experience.
- Keep income understanding inside the same consumer-report workflow as other Plaid Check insights.
- Use report-ready income insight as part of a broader underwriting review.
- Give reviewers a clearer picture of income-related signals in the context of the full report.
- Income Insights details over a dozen categorized income streams along with ready-made attributes to streamline rent-to-income and ability-to-pay assessments.
- Consumer Report is enhanced by two optional add-ons: Income Insights and Partner Insights.

## Proof Points & ROI Metrics
<!-- ⚠️ HUMAN-OWNED — every claim requires a Source. AI adds [DRAFT] rows only. -->

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| Link token products for CRA Income Insights | `cra_base_report`, `cra_income_insights` | AskBill / Plaid docs | high | 2026-03-26 |
| [DRAFT] Income categorization types | 13+ categorized income types (salary, gig, retirement, unemployment, etc.) | CRA Income Insights Model Fact Sheet v2.1 (2025-10-30) | high | 2026-03-27 |
| [DRAFT] Frequency detection — all streams | 57% fill rate | CRA Income Insights Model Fact Sheet (Nov 2025) | medium | 2026-03-27 |
| [DRAFT] Frequency detection — streams with 3+ txns | 83% fill rate | CRA Income Insights Model Fact Sheet (Nov 2025) | medium | 2026-03-27 |
| [DRAFT] Frequency detection — salary/retirement/LTD | 95-98% | CRA Income Insights Model Fact Sheet (Nov 2025) | medium | 2026-03-27 |
| [DRAFT] Employer name / income provider coverage | ~64% of income streams | CRA Income Insights Model Fact Sheet (Nov 2025) | medium | 2026-03-27 |
| [DRAFT] Salary categorization precision | ~0.90 precision, ~0.92 recall | CRA Income Insights Model Fact Sheet (Nov 2025) | medium | 2026-03-27 |
| [DRAFT] Next payment date forecast improvement (weekly/biweekly) | +7-10 ppt vs heuristics | CRA Income Insights Model Fact Sheet (Nov 2025) | medium | 2026-03-27 |
| [DRAFT] Historical avg monthly income evaluation | ~$90.9 mean error, ~97% user coverage | CRA Income Insights Model Fact Sheet (Nov 2025) | medium | 2026-03-27 |

## Customer Use Cases
<!-- ⚠️ HUMAN-OWNED — scenario descriptions for demo builders. AI may add [DRAFT] scenarios. -->

- Income context for underwriting: retrieve model-driven income attributes (historical avg monthly income, forecasted income, next payment date, employer name) after the CRA report-ready event
- Rent-to-income / tenant screening: 13+ categorized income types with ready-made attributes for rent-to-income calculations; FCRA-compliant
- Ability-to-pay assessment: frequency detection at 95–98% for salary/retirement/LTD streams; income data as part of the underwriting decision

### Income Context For Underwriting
**Persona:** Product or underwriting lead at a lender
**Problem:** The team needs report-based income context as part of a broader consumer-report review
**Solution:** Generate a Plaid Check report, wait for readiness, and retrieve Income Insights through the CRA report workflow
**Outcome:** Faster review with income-oriented insight in the same underwriting surface

### [DRAFT] Rent-to-Income / Tenant Screening
**Persona:** Property manager or landlord using cash-flow data for screening
**Problem:** Need to verify tenant income with an FCRA-compliant method that goes beyond self-reported numbers
**Solution:** Income Insights details over a dozen categorized income streams with ready-made attributes to streamline rent-to-income calculations
**Outcome:** More confident tenant screening using report-derived income attributes
**Source:** [External] Plaid Check Income Insights - Short Categorization Fact Sheet v2.1 (2025-10-30)

### [DRAFT] EWA / Cash Advance Income Assessment (Clair)
**Persona:** Product lead at an EWA or cash-advance provider
**Problem:** Need to assess time-and-attendance or earnings data for cash advance eligibility
**Solution:** Clair is evaluating CRA + Income Insights for time-and-attendance / EWA flows, comparing attributes vs existing vendor
**Outcome:** Potential regulatory-compliant path for income assessment in EWA
**Source:** Clair CRA + Income Insights Use Case Slack thread (2025-12-29)

### [DRAFT] Downstream Partner Data Sharing (Pagaya)
**Persona:** Capital markets or lending-as-a-service platform
**Problem:** Need structured cash-flow and income data to feed into their own risk models
**Solution:** Customers share Plaid CRA data downstream (Income/Cash-flow/Network Insights, LendScore, attributes) into Pagaya in a structured way
**Outcome:** Enriched risk models with Plaid-derived income and cash-flow context
**Source:** [External] Pagaya <> Plaid Shared Notes (2026-03-04)

## Narration Talk Tracks
<!-- ⚠️ HIGHEST PRIORITY for script generation — word-perfect, max 35 words each.
     The script generator uses these verbatim before any other source.
     HUMAN-OWNED — AI must not modify approved blocks. -->

- Demo opener: Plaid Check Income Insights adds income-focused context to a consumer-report workflow — report-ready earnings signals in the same experience as the rest of the Plaid Check report
- Income insight beat: Income Insights adds income-oriented context to the report so reviewers can assess earnings-related signals alongside the broader Plaid Check underwriting picture

### Demo Opening
> "Today we'll show how Plaid Check Income Insights adds income-focused context to a consumer-report workflow, helping underwriters review report-ready earnings signals in the same experience as the rest of the Plaid Check report." (33 words)

### Report-ready step
> "After the user completes Link, Plaid finishes generating the consumer report and notifies your system when the report is ready for retrieval and review." (25 words)

### Income insight step
> "Income Insights adds income-oriented context to the report so reviewers can assess earnings-related signals alongside the broader Plaid Check underwriting picture." (22 words)

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names.
     Build agents and script generator must use these exactly. -->

- API endpoint: `/user/create`
- Link token endpoint: `/link/token/create`
- CRA report retrieval endpoint: `/cra/check_report/income_insights/get`
- Required Link products for this family: `cra_base_report`, `cra_income_insights`
- Link requirement: real Plaid Link CRA/Check modal (single `plaidPhase: "launch"` step) — no simulated host-only Link flow
- Passport note: Plaid Passport may be enabled in template configuration for stronger verification, but it does not replace the core CRA Link/consent flow
- Important CRA configuration terms: `cra_options`, `consumer_report_permissible_purpose`, `days_requested`
- Important distinction: this product is **not** traditional `income_verification`, Bank Income, Payroll Income, or Document Income
- Async lifecycle: report requested -> report generating -> report ready

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

- "Keep income-oriented report context inside the same Plaid Check consumer-report workflow."
- "Avoid blending consumer-report review with separate traditional income-verification product flows."
- [DRAFT] "Model-driven income insights on ability-to-pay: historical average monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer name / income provider, and 13+ income type categories." (Source: CRA Income Insights Model Fact Sheet, Nov 2025)
- [DRAFT] "Built as FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights when using data for underwriting or income verification." (Source: Glean GTM research, Oct 2025)

## Sandbox Link (Plaid Check / CRA Income Insights)

Same rules as **CRA Base Report**: non-OAuth institution (**First Platypus Bank**, `ins_109508`) and **`user_credit_*`** sandbox usernames at the bank login step (password e.g. `pass_good`). Rotate personas to exercise different report shapes.

**Not for this product’s Link step:** **`user_bank_income`** — that maps to **traditional Bank Income**, not CRA Check Link. See [plaid-bank-income.md](plaid-bank-income.md).

Docs: [Plaid Sandbox test credentials](https://plaid.com/docs/sandbox/test-credentials/#credit-and-income-testing-credentials).

## Implementation Pitfalls
<!-- demo-UI guidance -->
- **Consumer/host screens stay realistic — no behind-the-scenes leakage.** Never show webhook/event names (e.g. `USER_CHECK_REPORT_READY`, `SESSION_FINISHED`), raw API endpoints/field names, raw report JSON, `report_id`/`user_id`, or the raw `EXTENSION_OF_CREDIT` enum on host screens. Normalize permissible purpose for humans (e.g. "Extension of credit"). Move technical detail / raw report data to Plaid **slides**, the JSON **`#api-response-panel`**, or a clearly labeled **"Underwriter Internal view"** step. (Full guidance: see the "Demo UI Guidance" section in `inputs/products/plaid-cra-base-report.md`.)

- Do not use `income_verification` as the Link product for CRA Income Insights demos.
- Do not retrieve CRA Income Insights with `/credit/bank_income/get` or `/credit/payroll_income/get`.
- Do not describe CRA Income Insights as a source-selection flow for payroll, bank income, or document upload.
- Include a report-ready beat because CRA Income Insights is part of an asynchronous consumer-report workflow.
- Do not replace CRA Link with custom customer-hosted pseudo-link forms; use the real Plaid CRA Link experience.
- Setup and data-returned explanation beats should use Plaid-branded slide template screens (`.slide-root`) instead of customer-branded host UI.

## Framework QA Learnings
<!-- 🔄 SHARED — curated prompt/build lessons for this product family.
     Promote recurring issues from inputs/qa-fix-log.md into stable product guidance here. -->

- Use the single global `api-response-panel` for CRA Income Insights report steps so the framework can reuse the same host-vs-insight contract as other demos.
- Keep report-ready and report-review steps visually distinct to avoid transition ambiguity in build-QA and record-QA.
- Do not mix traditional income UX assumptions with CRA report-review screens in the same prompt.
- CRA setup/data explanation beats are easier to validate when rendered as Plaid-branded slide steps (`.slide-root`) with customer host chrome reserved for user journey screens.

## Objections & Responses
<!-- 🔄 SHARED — AI adds [DRAFT] from Gong; human approves by removing [DRAFT] tag. -->

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| [DRAFT] "How is this different from Bank Income?" | "CRA Income Insights is an FCRA-compliant upgrade to Bank Income. It adds model-driven attributes like forecasted income, predicted next payment date, and employer name on top of the bank-data foundation. GTM advises migrating US Bank Income users to CRA Income Insights for underwriting." | Glean GTM research + Migration docs (Oct 2025) | [DRAFT] |
| [DRAFT] "What about employer coverage?" | "About 64% of income streams now return a normalized employer/income provider name after the new normalization step. For salary/retirement/LTD streams, frequency detection is 95-98%." | CRA Income Insights Model Fact Sheet (Nov 2025) | [DRAFT] |

## AI Research Notes
<!-- 🤖 AI-OWNED — auto-populated by research.js after each pipeline run.
     Human reviews but does not need to edit. Entries accumulate — do not remove.
     Only findings at or above the confidence threshold are appended (default: medium). -->

### 2026-06-15 — Run: 2026-06-15-Scrub-Io-CRA-Auth-Identity-Assets-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income insights on ability-to-pay: historical average monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer name / income provider, and 13+ income type categories.","status":"DRAFT","source":"CRA Income Insights Model Fact Sheet, Nov 2025"}
- [high] {"claim":"Built as an FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights when using data for underwriting or income verification.","status":"DRAFT","source":"Glean GTM research, Oct 2025"}
- [high] {"claim":"Plaid IDV runs as its own mutually-exclusive Link session (KYC: accept_tos + SMS + KYC check + optional documentary verification) and verifies identity without manual ID emailing.","status":"approved","source":"AskBill / Plaid IDV docs"}
- [high] {"claim":"One bank connection serves both income (CRA Income Insights) and balances/cash flow (CRA Base Report) — no separate Assets link product.","status":"approved","source":"Brief + AskBill / Plaid CRA docs"}

### 2026-06-12 — Run: 2026-06-12-Scrub-Io-CRA-Identity-Assets-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Traditional Bank Income verifies income directly from connected bank transaction data — no document upload, no manual review at the underwriting desk.","source":"AskBill / Plaid docs + per-product KB","status":"approved"}
- [high] {"claim":"This is traditional Plaid Bank Income (income_verification, POST /credit/bank_income/get) — distinct from Plaid Check / CRA Income Insights (cra_base_report, cra_income_insights). The income_verification Link token ONLY accepts {income_verification, employment}; do not bundle other products into it.","source":"AskBill / Plaid docs + brief CRITICAL note","status":"approved"}
- [high] {"claim":"Traditional Bank Income (income_source_types ['bank']) returns synchronously after Link onSuccess — no INCOME_VERIFICATION report-ready webhook gate, unlike Document/Payroll Income.","source":"AskBill / Plaid Bank Income + Income docs","status":"approved"}
- [high] {"claim":"Plaid IDV runs as its own mutually-exclusive Link session (document + data source + SMS/selfie) and verifies identity without manual ID emailing.","source":"AskBill / Plaid IDV docs","status":"approved"}
- [high] {"claim":"A single Item used for Bank Income can also serve an assets/balance snapshot via /accounts/balance/get — income + balances from one connection.","source":"AskBill / Plaid Balance docs","status":"approved"}

### 2026-06-11 — Run: 2026-06-11-Cox-Automotive-Auth-Identity-Signal-Income-Statements-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Traditional Bank Income verifies income directly from connected bank transaction data — no document upload, no manual review at the dealer finance desk.","source":"AskBill / Plaid docs + per-product KB","status":"approved"}
- [high] {"claim":"This is traditional Plaid Bank Income (income_verification, POST /credit/bank_income/get) — distinct from Plaid Check / CRA Income Insights (cra_base_report, cra_income_insights). The income_verification Link token ONLY accepts {income_verification, employment}; do not bundle other products into it.","source":"AskBill / Plaid docs + brief CRITICAL note","status":"approved"}
- [high] {"claim":"Traditional Bank Income (income_source_types ['bank']) returns synchronously after Link onSuccess — no INCOME_VERIFICATION report-ready webhook gate, unlike Document/Payroll Income.","source":"AskBill / Plaid Bank Income + Income docs","status":"approved"}

### 2026-06-10 — Run: 2026-06-10-Scrub-Io-CRA-Identity-Assets-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Traditional Bank Income verifies income directly from connected bank transaction data — no document upload, no manual review at the underwriting desk.","source":"AskBill / Plaid docs + per-product KB","status":"approved"}
- [high] {"claim":"This is traditional Plaid Bank Income (income_verification, POST /credit/bank_income/get) — distinct from Plaid Check / CRA Income Insights (cra_base_report, cra_income_insights). The income_verification Link token ONLY accepts {income_verification, employment}; do not bundle other products into it.","source":"AskBill / Plaid docs + brief CRITICAL note","status":"approved"}
- [high] {"claim":"Plaid IDV runs as its own flow (document + selfie + liveness) and verifies identity without manual ID emailing.","source":"AskBill / Plaid IDV docs","status":"approved"}
- [high] {"claim":"A single Item used for Bank Income can also serve an assets/balance snapshot via /accounts/balance/get — income + balances from one connection.","source":"AskBill / Plaid Balance docs","status":"approved"}

### 2026-06-06 — Run: 2026-06-06-Demo-CRA-Identity-v3 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Traditional Bank Income verifies income directly from connected bank transaction data — no document upload, no manual review at the onboarding desk.","status":"approved","source":"AskBill / Plaid docs + per-product KB"}
- [high] {"claim":"This is traditional Plaid Bank Income (income_verification, POST /credit/bank_income/get) — distinct from Plaid Check / CRA Income Insights (cra_base_report, cra_income_insights). The income_verification Link token ONLY accepts {income_verification, employment}; do not bundle other products into it.","status":"approved","source":"AskBill / Plaid docs + brief CRITICAL note"}
- [high] {"claim":"Plaid IDV runs as its own mutually-exclusive Link session (document + data source + selfie) and verifies identity without manual ID emailing.","status":"approved","source":"AskBill / Plaid IDV docs"}
- [high] {"claim":"A single Item used for Bank Income can also serve an assets/balance snapshot via /accounts/balance/get — income + balances from one connection.","status":"approved","source":"AskBill / Plaid Balance docs"}

### 2026-06-06 — Run: 2026-06-06-Demo-CRA-Identity-Assets-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"This is traditional Plaid Bank Income (income_verification, POST /credit/bank_income/get) — distinct from Plaid Check / CRA Income Insights (cra_base_report, cra_income_insights). The income_verification Link token ONLY accepts {income_verification, employment}; do not bundle other products into it.","status":"approved","source":"AskBill / Plaid docs + brief CRITICAL note"}
- [high] {"claim":"Traditional Bank Income verifies income directly from connected bank transaction data — no document upload, no manual review at the underwriting desk.","status":"approved","source":"AskBill / Plaid docs + per-product KB"}
- [high] {"claim":"Plaid IDV runs as its own flow (document + selfie) and verifies identity without manual ID emailing.","status":"approved","source":"AskBill / Plaid IDV docs"}
- [high] {"claim":"A single Item used for Bank Income can also serve an assets/balance snapshot via /accounts/balance/get — income + balances from one connection.","status":"approved","source":"AskBill / Plaid Balance docs"}

### 2026-06-06 — Run: 2026-06-06-Demo-CRA-Identity-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Traditional Bank Income verifies income directly from connected bank transaction data — no document upload, no manual review at the desk.","status":"approved","source":"AskBill / Plaid docs + per-product KB"}
- [high] {"claim":"This is traditional Plaid Bank Income (income_verification, POST /credit/bank_income/get) — distinct from Plaid Check / CRA Income Insights (cra_base_report, cra_income_insights). Do not bundle other products into the income_verification Link token.","status":"approved","source":"AskBill / Plaid docs + brief CRITICAL note"}
- [high] {"claim":"Plaid IDV runs as its own mutually-exclusive Link session (document + selfie) and verifies identity without manual ID emailing.","status":"approved","source":"AskBill / Plaid IDV docs"}

### 2026-06-06 — Run: 2026-06-06-Demo-CRA-Identity-Assets-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Traditional Bank Income verifies income directly from connected bank transaction data — no document upload, no manual review at the finance desk","status":"approved"}
- [high] {"claim":"This is traditional Plaid Bank Income (income_verification, POST /credit/bank_income/get) — distinct from Plaid Check / CRA Income Insights (cra_base_report, cra_income_insights). Do not bundle other products into the income_verification Link token.","status":"approved","source":"AskBill / Plaid docs + brief CRITICAL note"}
- [high] {"claim":"Plaid IDV runs as its own mutually-exclusive Link session (document + data source + selfie) and verifies identity without manual ID emailing.","status":"approved","source":"AskBill / Plaid IDV docs"}

### 2026-06-06 — Run: 2026-06-06-Demo-CRA-Identity-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Traditional Bank Income verifies income directly from connected bank transaction data — no document upload, no manual review at the finance desk","status":"approved"}
- [high] {"claim":"This is traditional Plaid Bank Income (income_verification, POST /credit/bank_income/get) — distinct from Plaid Check / CRA Income Insights (cra_base_report, cra_income_insights). Do not bundle other products into the income_verification Link token.","status":"approved","source":"AskBill / Plaid docs + brief CRITICAL note"}
- [high] {"claim":"Plaid IDV runs as its own mutually-exclusive Link session (document + data source + selfie) and verifies identity without manual ID emailing.","status":"approved","source":"AskBill / Plaid IDV docs"}

### 2026-05-31 — Run: 2026-05-31-Dealer-Finance-Desk-Verify-Auth-Identity-Signal-Income-Statements-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Traditional Bank Income verifies income directly from connected bank transaction data — no document upload, no manual review at the finance desk","status":"approved"}
- [high] {"claim":"This is traditional Plaid Bank Income (income_verification, POST /credit/bank_income/get) — distinct from Plaid Check / CRA Income Insights (cra_base_report, cra_income_insights). Do not bundle auth, identity, or signal into the income_verification Link token.","status":"approved","source":"AskBill / Plaid docs + brief CRITICAL note"}

### 2026-05-30 — Run: 2026-05-30-Dealer-Finance-Desk-Verify-Auth-Identity-Signal-Income-Statements-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income insights on ability-to-pay: historical average monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer name / income provider, and 13+ income type categories.","status":"DRAFT","source":"CRA Income Insights Model Fact Sheet, Nov 2025"}
- [high] {"claim":"Built as an FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights when using data for underwriting or income verification.","status":"DRAFT","source":"Glean GTM research, Oct 2025"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall).","status":"DRAFT","source":"CRA Income Insights Model Fact Sheet, Nov 2025"}
- [high] {"claim":"Employer/income provider normalization returns a name on ~64% of income streams.","status":"DRAFT","source":"CRA Income Insights Model Fact Sheet, Nov 2025"}
- [high] {"claim":"Frequency detection: 57% across all streams, 83% on streams with 3+ transactions, 95-98% on salary/retirement/LTD streams.","status":"DRAFT","source":"CRA Income Insights Model Fact Sheet, Nov 2025"}

### 2026-05-30 — Run: 2026-05-30-Dealer-Finance-Desk-Verify-Auth-Identity-Signal-Income-Statements-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income insights on ability-to-pay: historical average monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer name / income provider, and 13+ income type categories.","status":"DRAFT","source":"CRA Income Insights Model Fact Sheet, Nov 2025"}
- [high] {"claim":"Built as an FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights when using data for underwriting or income verification.","status":"DRAFT","source":"Glean GTM research, Oct 2025"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall).","status":"DRAFT","source":"CRA Income Insights Model Fact Sheet, Nov 2025"}
- [high] {"claim":"Employer/income provider normalization returns a name on ~64% of income streams.","status":"DRAFT","source":"CRA Income Insights Model Fact Sheet, Nov 2025"}
- [high] {"claim":"Frequency detection: 57% across all streams, 83% on streams with 3+ transactions, 95-98% on salary/retirement/LTD streams.","status":"DRAFT","source":"CRA Income Insights Model Fact Sheet, Nov 2025"}

### 2026-05-29 — Run: 2026-05-29-Application-Dashboard-With-An-CRA-Identity-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income insights on ability-to-pay: historical average monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer name / income provider, and 13+ income type categories.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Built as FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights when using data for underwriting or income verification.","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall).","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Employer/income provider normalization returns a name on ~64% of income streams.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Frequency detection: 57% all streams, 83% on streams with 3+ transactions, 95-98% on salary/retirement/LTD.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-05-25 — Run: 2026-05-25-Demo-CRA-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income attributes: historical avg monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer/income provider, 13+ income categories.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights for underwriting.","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall).","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Employer/income provider normalization returns a name on ~64% of income streams.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Frequency detection: 57% all streams, 83% on streams with 3+ transactions, 95–98% on salary/retirement/LTD.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-05-21 — Run: 2026-05-21-Uses-Current-For-Daily-CRA-Auth-Identity-Signal-Protect-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows","status":"approved"}
- [high] {"claim":"Model-driven income attributes: historical avg monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer/income provider, 13+ income categories","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights for underwriting","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall)","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Employer/income provider normalization returns a name on ~64% of income streams","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Frequency detection: 57% all streams, 83% on streams with 3+ transactions, 95–98% on salary/retirement/LTD","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-05-21 — Run: 2026-05-21-Demo-CRA-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income insights on ability-to-pay: historical average monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer name / income provider, and 13+ income type categories.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Built as FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights when using data for underwriting or income verification.","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall).","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Employer/income provider normalization returns a name on ~64% of income streams.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-05-21 — Run: 2026-05-21-Demo-CRA-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income attributes: historical avg monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer/income provider, 13+ income categories.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights for underwriting.","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall).","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Employer/income provider normalization returns a name on ~64% of income streams.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-05-20 — Run: 2026-05-20-Buying-A-Lucid-Air-CRA-Auth-Identity-v4 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income attributes: historical avg monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer/income provider, 13+ income categories.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights for underwriting.","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall).","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Employer/income provider normalization returns a name on ~64% of income streams.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-05-20 — Run: 2026-05-20-Buying-A-Lucid-Air-CRA-Auth-Identity-v3 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income attributes: historical avg monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer/income provider, 13+ income categories.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights for underwriting.","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall).","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Employer/income provider normalization returns a name on ~64% of income streams.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-05-20 — Run: 2026-05-20-Buying-A-Lucid-Air-CRA-Auth-Identity-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income attributes: historical avg monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer/income provider, 13+ income categories.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights for underwriting.","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall).","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Employer/income provider normalization returns a name on ~64% of income streams.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-05-20 — Run: 2026-05-20-Buying-A-Lucid-Air-CRA-Auth-Identity-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income attributes: historical avg monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer/income provider, 13+ income categories.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights for underwriting.","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall).","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Employer/income provider normalization returns a name on ~64% of income streams.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-04-29 — Run: 2026-04-29-Creative-Studio-Co-Full-time-CRA-Identity-Signal-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows","status":"approved"}
- [high] {"claim":"Model-driven income attributes: historical avg monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer/income provider, 13+ income categories","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights for underwriting","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall)","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-04-29 — Run: 2026-04-29-Creative-Studio-Co-Full-time-CRA-Identity-Signal-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows","status":"approved"}
- [high] {"claim":"Model-driven income attributes: historical avg monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer/income provider, 13+ income categories","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights for underwriting","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall)","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-04-19 — Run: 2026-04-19-Applying-For-Pay-over-time-At-CRA-Identity-Signal-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income attributes: historical avg monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer/income provider, 13+ income categories.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights for underwriting.","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall).","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-04-19 — Run: 2026-04-19-Applying-For-Smartphone-Installment-CRA-Identity-Signal-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income insights on ability-to-pay: historical average monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer name / income provider, and 13+ income type categories.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Built as FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights when using data for underwriting or income verification.","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall).","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-04-13 — Run: 2026-04-13-Applying-For-Pay-over-time-At-CRA-Identity-Signal-Layer-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income insights on ability-to-pay: historical average monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer name / income provider, and 13+ income type categories.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Built as FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights when using data for underwriting or income verification.","source":"Glean GTM research, Oct 2025","status":"DRAFT"}
- [high] {"claim":"High-precision salary categorization (~0.90 precision, ~0.92 recall) for confident income-type classification.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}

### 2026-04-13 — Run: 2026-04-13-Applying-For-Smartphone-Installment-CRA-Identity-Signal-Layer-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Keep income-oriented report context inside the same Plaid Check consumer-report workflow.","status":"approved"}
- [high] {"claim":"Avoid blending consumer-report review with separate traditional income-verification product flows.","status":"approved"}
- [high] {"claim":"Model-driven income insights on ability-to-pay: historical average monthly income (gross & net), forecasted income (next 3 months), predicted next payment date, employer name / income provider, and 13+ income type categories.","source":"CRA Income Insights Model Fact Sheet, Nov 2025","status":"DRAFT"}
- [high] {"claim":"Built as FCRA-compliant upgrade to Bank Income; GTM advises migrating US Bank Income users to CRA Income Insights when using data for underwriting or income verification.","source":"Glean GTM research, Oct 2025","status":"DRAFT"}

### 2026-04-13 — Run: 2026-04-13-Demo-CRA-Identity-Layer-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] Unified consumer-report workflow
- [high] Model-driven income attributes
- [high] FCRA-compliant upgrade from Bank Income
- [high] High-precision salary categorization

### 2026-03-26 — File created from AskBill + framework scaffolding [human]
Initial CRA Income Insights knowledge scaffold created for prompt-driven demo generation.

### 2026-03-27 — Glean sales content enrichment [AI — needs_review]
Added [DRAFT] proof points, customer stories, competitive differentiators, and objection responses from Glean search across last-6-month CRA sales collateral. Key sources:
- CRA Income Insights Model Fact Sheet v2.1 (2025-10-30) + Nov 2025 update (2026-03-12): frequency detection, employer coverage, salary categorization, forecasting improvements
- [External] Plaid Check Income Insights - Short Categorization Fact Sheet v2.1 (2025-10-30): 13+ income types, rent-to-income attributes
- Clair CRA + Income Insights Use Case Slack (2025-12-29): EWA exploration
- [External] Pagaya <> Plaid Shared Notes (2026-03-04): downstream partner data sharing
- Credit and Underwriting Plaid Docs (2026-03-26): "Consumer Report is enhanced by two optional add-ons: Income Insights and Partner Insights"
- Glean GTM research (Oct 2025): FCRA-compliant Bank Income migration guidance

## Change Log

- 2026-03-26: File created for CRA Income Insights prompt scaffolding [human]
- 2026-03-27: Enriched with Glean sales content (value props, model performance, customer stories, objections) [AI]
