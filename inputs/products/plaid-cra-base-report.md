---
product: "Plaid Check Base Report"
slug: "cra-base-report"
api_endpoints:
  - "/user/create"
  - "/link/token/create"
  - "/cra/check_report/create"
  - "/cra/check_report/base_report/get"
use_cases:
  - credit-underwriting
  - cash-flow-underwriting
  - account-stability-review
last_human_review: "2026-03-26"
last_ai_update: "2026-04-13T05:01:48.560Z"
needs_review: true
approved: true
version: 1
---

# Plaid Check Base Report

## Overview
Plaid Check Base Report gives lenders and verifiers a consumer-permissioned view of bank account history, balances, ownership, inflows, outflows, and transaction behavior. It is best framed as a report-generation product for underwriting and cash-flow review, not as an instant-auth or ACH-funding flow.

## Where It Fits
Feature this product when the persona needs a reusable underwriting artifact backed by linked bank-account data. Typical stories include personal lending, BNPL, or account-review flows where account stability, ownership, and transaction behavior matter more than payment rails.

## Value Proposition Statements
<!-- ⚠️ HUMAN-OWNED — pre-approved messaging. AI may ADD candidates marked [DRAFT]
     but must NOT modify or remove approved statements.
     Humans promote [DRAFT] to approved by deleting the tag. -->

### Primary Pitch
> "Generate a consumer-permissioned cash-flow report that gives underwriters a fuller picture of account behavior and stability."

### Supporting Claims
- "Turn linked bank-account data into a reusable underwriting report."
- "Surface balances, inflows, outflows, transaction patterns, and ownership in one place."
- "Support credit review with a report workflow instead of one-off point checks."

## Proof Points & ROI Metrics
<!-- ⚠️ HUMAN-OWNED — every claim requires a Source. AI adds [DRAFT] rows only. -->

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| Historical transaction window | Up to 24 months | Plaid docs | high | 2026-03-26 |
| Report availability window | 24 hours after creation | Plaid docs | high | 2026-03-26 |
| [DRAFT] CRA Link flow drop-off (consent screens) | ~0.6% between panes 5-6 | Tilt <> Plaid CRA Sync (Gong call, 2026-03-16) | medium | 2026-03-26 |
| [DRAFT] 83% of lending professionals open to cash-flow data | 83% of 400 surveyed | Plaid blog / marketing (2026-03-26) | medium | 2026-03-26 |
| [DRAFT] Koalafi deal value (CRA Base + Income + Partner + Auth) | Over $600k total deal | SE Newsletter Q4 FY25 | medium | 2026-03-26 |
| [DRAFT] Mortgage: Fannie Mae Day 1 Certainty compatible | VOA report for rep & warrant relief | GTM Guide: Home Lending Report (2026-03-26) | high | 2026-03-26 |

## Customer Use Cases
<!-- ⚠️ HUMAN-OWNED — scenario descriptions for demo builders. AI may add [DRAFT] scenarios. -->

### Credit Underwriting
**Persona:** Product manager or underwriting lead at a lender
**Problem:** Traditional bureau-only review misses real cash-flow behavior and account stability
**Solution:** Generate a Base Report after Link and review balances, inflows, outflows, and ownership signals in one underwriting surface
**Outcome:** Faster underwriting review with more context from consumer-permissioned bank data

### [DRAFT] Adverse Actioning / Account Review (Varo)
**Persona:** Risk or compliance lead at a neobank
**Problem:** Need FCRA-compliant cash-flow data to support adverse action decisions
**Solution:** Varo contracted CRA Base Report + Cash Flow Updates in Dec 2025; deploying to power adverse actioning in April 2026, using CRA Base to retrieve verified identity, 24-month transaction data, inflow/outflow summaries, NSF/OD counts, and primary account indicators
**Outcome:** Consumer-permissioned adverse-action support with up to 24 months of bank data context
**Source:** [EXT] Varo // Plaid - Account Overview (2026-03-26)

### [DRAFT] Second-Look Underwriting (Progressive Leasing)
**Persona:** Product or underwriting lead at a lease-to-own provider
**Problem:** Manual second-look underwriting processes are slow and have low take-up rates
**Solution:** Progressive Leasing uses Auth + CRA Base Report (+ later Income Insights / Cash Flow Updates) for second-look underwriting via hosted link
**Outcome:** Strong take-up rates, conversion, and approval lift vs manual processes in POC
**Source:** SE Newsletter Q4 FY25 / Retro-POC assessment

### [DRAFT] Full CRA Suite Adoption (Nubank)
**Persona:** Head of credit or product at a digital bank expanding into US lending
**Problem:** Needed comprehensive cash-flow + risk data under one contract without integrating multiple vendors
**Solution:** Nubank chose Plaid CRA over going direct with Prism, Experian, or Nova Credit because: (1) existing US bank flow powered by Plaid = best UX, (2) raw txn data + cashflow insights + scores all under one contract, (3) pricing
**Outcome:** Contracted full CRA suite: Base Report, LendScore, Network Insights, and Partner Insights with A/B testing planned
**Source:** Nubank SFDC opp (2026-03-10) + Implementation Notes (2026-03-23)

## Narration Talk Tracks
<!-- ⚠️ HIGHEST PRIORITY for script generation — word-perfect, max 35 words each.
     The script generator uses these verbatim before any other source.
     HUMAN-OWNED — AI must not modify approved blocks. -->

### Demo Opening
> "Today we'll show how Plaid Check turns linked bank-account data into a reusable Base Report for underwriting, combining balances, transactions, and ownership details into one consumer-permissioned credit-review workflow." (31 words)

### Report creation step
> "After the user links their account, Plaid generates a consumer report for the permissible purpose you define, then notifies your system when the report is ready to review." (29 words)

### Base Report insight step
> "The Base Report surfaces balances, inflows, outflows, ownership details, and transaction patterns so underwriters can assess account stability with more context than a point-in-time check." (28 words)

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names.
     Build agents and script generator must use these exactly. -->

- API endpoint: `/user/create`
- Link token endpoint: `/link/token/create`
- Report creation endpoint: `/cra/check_report/create`
- Report retrieval endpoint: `/cra/check_report/base_report/get`
- Product term: `consumer_report`
- Link requirement: real Plaid Link CRA/Check modal (single `plaidPhase: "launch"` step) — no simulated host-only Link flow
- Passport note: Plaid Passport may be enabled via account template for stronger identity verification; treat as optional by configuration, not as a replacement for core CRA Link/consent
- Key configuration terms: `consumer_report_permissible_purpose`, `enable_multi_item_link`, `require_identity`
- Async lifecycle: report requested -> report generating -> report ready
- Readiness concepts: `CHECK_REPORT_READY`, `USER_CHECK_REPORT_READY`
- Important report fields: balances, inflows, outflows, ownership, transactions, days available, primary account prediction

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

- "A reusable consumer-report workflow built on consumer-permissioned bank-account data."
- "Balances, ownership, and cash-flow context in one report surface instead of fragmented checks."
- [DRAFT] "Most new customers should use Consumer Report by Plaid Check instead of Assets. Consumer Report is an FCRA-compliant product providing underwriting scores and insights." (Source: Plaid Assets docs, 2026-03-05)
- [DRAFT] "Under Plaid CRA, Plaid transforms the data into a consumer report with many derived calculations and insights, as well as helpful cashflow transaction categorizations." (Source: PNC CRA FAQ Slack thread, 2026-02-12)
- [DRAFT] Mortgage-specific: "Plaid CRA VOA enables lenders to qualify for reps and warrants relief, reducing risk and cost of loan origination. Less fallback. More automation." (Source: GTM Guide: Home Lending Report, 2026-03-26)

## Sandbox Link (Plaid Check / CRA)

Use a **non-OAuth** sandbox institution so username/password personas work (recommended: **First Platypus Bank**, `ins_109508`). OAuth flows may not behave with specialized sandbox users.

**CRA / Consumer Report institution login — use `user_credit_*` personas** (password is typically any non-empty string, e.g. `pass_good`):

| Username | Notes |
|----------|--------|
| `user_credit_profile_excellent` | Stronger cashflow / income mix |
| `user_credit_profile_good` | Neutral / gig-style |
| `user_credit_profile_poor` | Weaker / inconsistent income |
| `user_credit_bonus` | Bonus pay patterns |
| `user_credit_joint_account` | Joint / multi-identity patterns |

Do **not** document **`user_bank_income`** here — that sandbox login is for **traditional Bank Income** (`/credit/bank_income/...`), not as the primary CRA Check Link persona for this repo. See [plaid-bank-income.md](plaid-bank-income.md).

Official list: [Plaid Sandbox test credentials — Credit and income testing](https://plaid.com/docs/sandbox/test-credentials/#credit-and-income-testing-credentials).

## Implementation Pitfalls
<!-- ⚠️ HUMAN-OWNED — product-specific mistakes to avoid in prompts, scripts, and demos. -->

- Do not skip the user-creation / identity-setup beat when the flow depends on CRA user data.
- Do not present Base Report retrieval as the same thing as Auth, Signal, or payment-rails retrieval.
- If the prompt implies asynchronous report readiness, include a report-ready beat before reviewing the report contents.
- Highlight report fields like balances, ownership, inflows, outflows, and transaction behavior instead of ACH-specific metrics.
- Do not replace CRA Link with custom customer-hosted pseudo-link forms; use the real Plaid CRA Link experience.
- Setup and data-returned explanation beats should use Plaid-branded slide template screens (`.slide-root`) instead of customer-branded host UI.

## Framework QA Learnings
<!-- 🔄 SHARED — curated prompt/build lessons for this product family.
     Promote recurring issues from inputs/qa-fix-log.md into stable product guidance here. -->

- Reuse the single global `api-response-panel` for all report-insight steps; do not create inline JSON columns inside the step.
- Insight steps should have explicit, obvious IDs (for example `base-report-insight`) so recording and QA helpers can map JSON correctly.
- Keep report-ready and report-review steps visually distinct so start/mid/end frames do not blur the async lifecycle.
- CRA setup/data explanation beats are easier to validate when rendered as Plaid-branded slide steps (`.slide-root`) with customer host chrome reserved for user journey screens.

## Objections & Responses
<!-- 🔄 SHARED — AI adds [DRAFT] from Gong; human approves by removing [DRAFT] tag. -->

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| [DRAFT] "Why not just use Assets or Transactions?" | "Unlike raw Transactions, Base Report bundles together account balances, metadata, identity data, and transaction history — packaged for underwriting or leasing. It's FCRA-compliant and designed for credit decisions, which Transactions is not maintained for." | SE 1:1 Notes (2026-02-09) + Assets docs (2026-03-05) | [DRAFT] |
| [DRAFT] "We already work with another provider" | "Nubank chose Plaid CRA over Prism, Experian, or Nova Credit because: existing US bank flow powered by Plaid = best UX, comprehensive products under one contract, and competitive pricing." | Nubank SFDC (2026-03-10) | [DRAFT] |

## AI Research Notes
<!-- 🤖 AI-OWNED — auto-populated by research.js after each pipeline run.
     Human reviews but does not need to edit. Entries accumulate — do not remove.
     Only findings at or above the confidence threshold are appended (default: medium). -->

### 2026-04-13 — Run: 2026-04-13-Demo-CRA-Auth-Identity-Signal-Layer-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"A reusable consumer-report workflow built on consumer-permissioned bank-account data.","status":"approved"}
- [high] {"claim":"Balances, ownership, and cash-flow context in one report surface instead of fragmented checks.","status":"approved"}
- [high] {"claim":"Most new customers should use Consumer Report by Plaid Check instead of Assets. FCRA-compliant with underwriting scores and insights.","status":"DRAFT"}
- [high] {"claim":"Under Plaid CRA, Plaid transforms data into a consumer report with derived calculations, insights, and cashflow transaction categorizations.","status":"DRAFT"}
- [high] {"claim":"Mortgage-specific: Plaid CRA VOA enables lenders to qualify for reps and warrants relief via Fannie Mae Day 1 Certainty.","status":"DRAFT"}
- [high] {"claim":"Nubank chose Plaid CRA over Prism, Experian, and Nova Credit for best UX, comprehensive products under one contract, and competitive pricing.","status":"DRAFT"}

### 2026-04-09 — Run: 2026-04-09-dashboard-run-v3 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"A reusable consumer-report workflow built on consumer-permissioned bank-account data.","status":"approved"}
- [high] {"claim":"Balances, ownership, and cash-flow context in one report surface instead of fragmented checks.","status":"approved"}
- [high] {"claim":"Most new customers should use Consumer Report by Plaid Check instead of Assets. FCRA-compliant with underwriting scores and insights.","status":"DRAFT"}
- [high] {"claim":"Under Plaid CRA, Plaid transforms data into a consumer report with derived calculations, insights, and cashflow transaction categorizations.","status":"DRAFT"}
- [high] {"claim":"Mortgage-specific: Plaid CRA VOA enables lenders to qualify for reps and warrants relief via Fannie Mae Day 1 Certainty.","status":"DRAFT"}
- [high] {"claim":"Nubank chose Plaid CRA over Prism, Experian, and Nova Credit for best UX, comprehensive products under one contract, and competitive pricing.","status":"DRAFT"}

### 2026-04-08 — Run: 2026-04-08-Applying-For-Smartphone-Installment-CRA-Identity-Signal-Layer-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"A reusable consumer-report workflow built on consumer-permissioned bank-account data.","status":"approved"}
- [high] {"claim":"Balances, ownership, and cash-flow context in one report surface instead of fragmented checks.","status":"approved"}
- [high] {"claim":"Most new customers should use Consumer Report by Plaid Check instead of Assets. FCRA-compliant with underwriting scores and insights.","status":"DRAFT"}
- [high] {"claim":"Under Plaid CRA, Plaid transforms data into a consumer report with derived calculations, insights, and cashflow transaction categorizations.","status":"DRAFT"}
- [high] {"claim":"Mortgage-specific: Plaid CRA VOA enables lenders to qualify for reps and warrants relief via Fannie Mae Day 1 Certainty.","status":"DRAFT"}
- [high] {"claim":"Nubank chose Plaid CRA over Prism, Experian, and Nova Credit for best UX, comprehensive products under one contract, and competitive pricing.","status":"DRAFT"}

### 2026-04-08 — Run: 2026-04-08-Applying-For-Smartphone-Installment-CRA-Identity-Signal-Layer-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] Reusable consumer-report workflow vs. fragmented checks
- [high] FCRA-compliant by design
- [high] Replaces legacy Assets for most new customers
- [high] Comprehensive suite under one contract
- [high] Mortgage-ready: Fannie Mae Day 1 Certainty compatible

### 2026-03-26 — File created from AskBill + framework scaffolding [human]
Initial CRA Base Report knowledge scaffold created for prompt-driven demo generation.

### 2026-03-27 — Glean sales content enrichment [AI — needs_review]
Added [DRAFT] proof points, customer stories, competitive differentiators, and objection responses from Glean search across last-6-month CRA sales collateral. Key sources:
- [EXT] Varo // Plaid - Account Overview (2026-03-26)
- SE Newsletter Q4 FY25 (Koalafi $600k deal)
- Nubank SFDC opp (2026-03-10) + Implementation Notes (2026-03-23)
- GTM Guide: Home Lending Report (2026-03-26)
- Tilt <> Plaid CRA Sync Gong call (2026-03-16): 0.6% CRA Link drop-off
- Plaid blog: 83% of lending professionals open to cash-flow data
- Assets docs migration note: "Most new customers should use Consumer Report instead of Assets"
- PNC CRA FAQ Slack thread (2026-02-12): CRA data transformation value

## Change Log

- 2026-03-26: File created for CRA Base Report prompt scaffolding [human]
- 2026-03-27: Enriched with Glean sales content (value props, customer stories, proof points, objections) [AI]
