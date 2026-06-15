---
product: "Plaid Qualify"
slug: "qualify"
# claims_source: supplement
api_endpoints:
  - "/user/create"
  - "/cra/check_report/qualified_borrowers/get"
use_cases:
  - "top-of-funnel-prequalification"
  - "no-bank-link-lendscore"
  - "waterfall-eligibility-gate"
last_human_review: ""
last_reviewed_by: ""
last_ai_update: "2026-06-15"
needs_review: true
approved: false
version: 1
---

> ⚠️ **AI DRAFT — NOT HUMAN-APPROVED.** Authored 2026-06-15 from internal beta docs
> (Plaid Check "Qualified Borrowers" PM Spec, CRA V2 PRD, plaid-openapi, CRA Platform
> Confluence, #cra-eng / #plaid-check-gtm Slack) + AskBill. **Qualify is private beta**
> (referenced go-live ~Q3 2026) and is NOT in public Plaid docs. Several fields are TBD.
> Confirm with the CRA/Plaid Check team + the Upgrade account team before using on screen.
> Keep this file uncommitted until human review.

# Plaid Qualify

## Overview
<!-- ⚠️ HUMAN-OWNED -->
**Qualify** (customer-facing name) — API/product name **"Qualified Borrowers"** — is a
**top-of-funnel prequalification** capability in the Plaid Check / Consumer Report (CRA)
family. It returns a **pre-bank LendScore + an eligibility signal using consumer PII only
(name, DOB, SSN, address) — NO bank account linking required**. The lender calls
`/user/create` with full PII, then `POST /cra/check_report/qualified_borrowers/get`, and
gets back a LendScore and an `eligibility` verdict. An optional bureau credit report (soft or
hard pull) can be layered on, but **the bureau integration is NOT yet live** (`bureau_report`
returns `null`). It sits **before** Plaid Link / Layer and before `/cra/check_report/create`
in the CRA lifecycle.

## Where It Fits
<!-- ⚠️ HUMAN-OWNED -->
**Stage 1 of an up-funnel lending waterfall.** Use Qualify as a friction-free gate /
personalization step at the top of an application before any bank linking: identify eligible
applicants and get an early LendScore with zero applicant effort. Applicants who don't match
Qualify but are Layer-eligible fall through to a **bank-only Layer + Consumer Report** step
([[plaid-layer]] + [[cra-base-report]]); those ineligible for both continue the standard flow
(CRA Base Report + [[plaid-auth]] at income verification / VOI). Pre-bank LendScore is lower
accuracy than the post-bank LendScore from a full Consumer Report — Qualify is a gate, not the
final underwriting decision.

## Value Proposition Statements
<!-- ⚠️ HUMAN-OWNED — [DRAFT] candidates only; promote after review. -->

### Candidate Value Propositions (research-derived — [DRAFT])
- "[DRAFT] Score more applicants at the top of the funnel — get a LendScore from verified
  identity alone, before asking anyone to link a bank."
- "[DRAFT] Move bank linking up-funnel without adding friction: prequalify instantly, then
  enhance the offer with bank-verified cash flow only for the applicants who match."
- "[DRAFT] Expand the scored population and personalize offers earlier, with a soft-pull-
  friendly check that doesn't impact the consumer's credit."

## Proof Points & ROI Metrics
<!-- ⚠️ HUMAN-OWNED — every claim needs a Source. POC stats are HELD pending sign-off. -->

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| _(none approved)_ | — | — | — | — |

> **HELD — needs human sign-off (do NOT put on screen / in narration):** the Upgrade POC
> proposal cites customer-specific targets (an offer-take-rate lift, an offer-rate lift, and a
> monthly loan-sale dollar target to a named buyer). These are **GTM/POC-sourced** and must be
> signed off by a human before any use. **Qualitative framing only** is allowed in the demo:
> "move bank linking up-funnel to enable incremental offers and better pricing without
> degrading approvals or take-up, and expand the LendScore-scored loan population."

## Customer Use Cases
<!-- ⚠️ HUMAN-OWNED -->

### Up-funnel prequalification waterfall (Upgrade Personal Loans POC — [DRAFT])
**Persona:** Personal-loan applicant at a near-prime lender.
**Problem:** Bureau-only decisioning at the top of the funnel misses creditworthy applicants and
prices offers conservatively; bank linking traditionally sits late and adds friction.
**Solution:** Stage 1 — **Qualify** (PII-only) returns a pre-bank LendScore + eligibility, no
bank link. Stage 2 — non-matched but Layer-eligible applicants get **bank-only Layer** (Auth +
CRA Base Report template) → Consumer Report (Base Report, LendScore, Network Insights, Cash Flow
Insights) + Auth → enhanced offer. Stage 3 — ineligible applicants continue standard flow; CRA
Base Report + Auth at VOI post-offer.
**Outcome:** Larger scored population and earlier/better offers without degrading approvals
(quantified targets HELD for sign-off).

## Narration Talk Tracks
<!-- ⚠️ HIGHEST PRIORITY — max 35 words each. [DRAFT] until human-approved. -->

### Demo Opening ([DRAFT])
> "[DRAFT] Before Jordan links any account, Upgrade runs a friction-free Qualify check —
> verified identity in, an early LendScore and eligibility out. No bank connection required."
> (~28 words)

### Qualify result reveal ([DRAFT])
> "[DRAFT] In seconds, Qualify returns a LendScore and an eligibility signal from identity
> alone — enough to extend an early offer and decide who to invite into a deeper bank-verified
> review." (~33 words)

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical names/fields. Confirm flagged items before on-screen use. -->

- **Customer-facing name:** "Qualify". **API / internal name:** "Qualified Borrowers".
  Use "Qualify" in narration; use `qualified_borrowers` in code / API panels.
- **Endpoint:** `POST /cra/check_report/qualified_borrowers/get` (SDK: `craCheckReportQualifiedBorrowersGet`)
- **Prerequisite:** `POST /user/create` with full PII (`identity`: name, date_of_birth, emails,
  phone_numbers, addresses; SSN via `id_numbers`) → returns `user_id`.
- **Pull type:** `options.bureau.pull_type` ∈ `none` (default) | `soft` | `hard`. **Upgrade POC
  uses `none`** (LendScore only, no bureau inquiry; `bureau_report` is `null`).
- **Eligibility enum:** `qualified_borrowers.lend_score.eligibility` ∈ `eligible` |
  `not_eligible` | `unknown`.
- **⚠️ LendScore scale — UNRESOLVED CONFLICT (confirm before on-screen use):** the **approved**
  [[cra-lend-score]] KB states LendScore is **1–99 (higher = safer)**; the Qualified Borrowers
  internal spec/eng Slack referenced **1–850 (higher = better)** for the pre-bank QB score. These
  conflict — the pre-bank QB score may use a different/bureau-aligned scale, or one source is
  stale. **Do not assert a specific LendScore range on screen for Qualify until confirmed.**
  Note also: LendScore direction is the **opposite of [[plaid-signal]]** (1–99, higher = MORE risk).
- `score_factors[]` (reason codes) for the QB LendScore: **schema TBD** — do not fabricate codes.

### Sandbox personas (for `/user/create` → `qualified_borrowers/get`)
| Persona | `eligibility` | `score` |
|---------|---------------|---------|
| `user_credit_profile_good` | `eligible` | non-null (scoreable) |
| `user_credit_profile_fair` | `eligible` | non-null (mid-range) |
| `user_credit_profile_thin` | `not_eligible` / null | null |
| `user_credit_profile_no_data` | `not_eligible` | null |
Credentials: `pass_good`. `bureau_report` returns `null` in sandbox regardless of `pull_type`.

### API contract (developer panel reference)
Request:
```json
{ "client_id": "…", "secret": "…", "user_id": "usr_…",
  "options": { "bureau": { "pull_type": "none" } } }
```
Response (POC shape; bureau path null):
```json
{ "request_id": "…",
  "qualified_borrowers": {
    "lend_score": { "score": 0, "score_factors": [], "eligibility": "eligible" },
    "bureau_report": null } }
```
(`score_factors` schema TBD; `score` range pending confirmation per the conflict above;
`bureau_report` object shape TBD and not live.)

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->
- PII-only LendScore at the top of the funnel (no bank link) + a seamless fall-through to
  bank-verified Layer + Consumer Report for richer underwriting on the same user model.

## Implementation Pitfalls
<!-- ⚠️ HUMAN-OWNED -->
- **No bank linking at the Qualify step** — do NOT render a Plaid Link / Layer modal in the
  Qualify beat. Bank linking happens only at the Stage-2 Layer step.
- **`bureau_report` is `null` today** — do not show bureau credit-report data in a Qualify demo;
  the bureau integration is not live.
- **Network Insights is NOT available pre-bank** — it requires a completed Consumer Report
  (bank link). It cannot appear in the Qualify step; show it only after the Layer/CRA step.
- **Don't overstate accuracy** — pre-bank LendScore is lower accuracy than the post-bank
  Consumer Report LendScore. Frame Qualify as a top-of-funnel gate, not the final decision.
- **Private beta** — confirm availability + exact contract with the account team before a
  customer-facing build; treat the LendScore scale as unconfirmed.

## Framework QA Learnings
<!-- 🔄 SHARED -->
- "Qualify" (UI) vs `qualified_borrowers` (API) — keep narration on "Qualify", panels on the API path.
- Related modules retrieved from a full (post-bank) Consumer Report, not from Qualify:
  [[cra-base-report]], [[cra-lend-score]], [[cra-cashflow-insights]], Network Insights
  (`/cra/check_report/network_insights/get` — rent + BNPL signals; rent = Transfer-based,
  BNPL = network partners; cash-advance/EWA are OUT of Network Insights V0 — POC mention of
  EWA/cash-advance under Network Insights needs account-team clarification).

## Open Items / Needs Confirmation (AI draft — flag for human)
- LendScore scale for pre-bank Qualify (1–99 vs 1–850) — **conflict, must resolve**.
- `score_factors` / reason-code schema for QB LendScore — TBD.
- `bureau_report` response schema + multi-bureau support — TBD / not live.
- Network Insights V1 scope (does it ever include cash-advance/EWA?) — POC vs spec disagree.
- Qualify GA date vs Upgrade POC timeline (Jun–Nov 2026).
