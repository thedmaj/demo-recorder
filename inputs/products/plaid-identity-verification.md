---
product: "Plaid Identity Verification (IDV)"
slug: "identity-verification"
api_endpoints:
  - "/link/token/create"
  - "/identity_verification/create"
  - "/identity_verification/get"
  - "/identity_verification/list"
  - "/identity_verification/retry"
  - "/watchlist_screening/individual/get"
use_cases:
  - "kyc-onboarding"
  - "document-verification"
  - "selfie-liveness"
  - "data-source-verification"
last_human_review: ""
last_reviewed_by: ""
last_ai_update: "2026-05-29"
needs_review: true
approved: false
version: 1
---

# Plaid Identity Verification (IDV)

## Overview
<!-- ⚠️ HUMAN-OWNED — 2–3 sentences: what this product is, what problem it solves. -->
Plaid Identity Verification (IDV) runs a configurable KYC session inside Plaid Link, combining
Data Source (database) Verification, Document Verification, and a Selfie/liveness check to confirm
a real person matches the identity they claim. Verification methods are turned on per **template**
in the IDV Dashboard, not via API. IDV is the right tool when you need to *verify* identity — as
opposed to `/identity/get` (account-owner data) or `/identity/match` (bank-PII matching).

## Where It Fits
<!-- ⚠️ HUMAN-OWNED — when should this product be featured? What persona/use case? -->
Feature IDV for fintech/lender/neobank onboarding that must satisfy KYC: new-user signup, regulated
account opening, or any flow needing document + selfie + database checks. Pairs naturally **after
Plaid Layer** (prefill front-of-funnel → IDV verifies the prefilled data). For the joint Layer→IDV
build/sequencing playbook see the [`plaid-layer-idv-onboarding`](../../.claude/skills/plaid-layer-idv-onboarding/SKILL.md) skill.

## Value Proposition Statements
<!-- ⚠️ HUMAN-OWNED — pre-approved messaging. AI may ADD candidates marked [DRAFT]
     but must NOT modify or remove approved statements. -->

### Primary Pitch
> "Verify a new user's identity in a single Plaid Link session — document, selfie, and database checks — without building or maintaining your own KYC stack."

### Supporting Claims
- Configurable verification depth: turn on Data Source, Document, Selfie, and AML/Monitor per template, so you match rigor to the use case instead of a one-size-fits-all flow.
- Supports 16,000+ government-issued document types, with automatic desktop→mobile QR handoff for capture.
- Selfie + Document together adds face-match and an automatic age-consistency check against the provided DOB.
- Works with your existing onboarding: pre-fill known PII (e.g. from Plaid Layer) and IDV skips those steps in the UI, so the user only does what's actually needed.

## Proof Points & ROI Metrics
<!-- ⚠️ HUMAN-OWNED — every claim requires a Source. AI adds [DRAFT] rows only. -->

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|

## Customer Use Cases
<!-- ⚠️ HUMAN-OWNED — scenario descriptions for demo builders. AI may add [DRAFT] scenarios. -->

### [DRAFT] KYC at account opening (Layer-prefilled)
**Persona:** New customer at a neobank.
**Problem:** Manual KYC forms cause drop-off; manual review is slow.
**Solution:** Layer prefills identity from the Plaid Network; IDV verifies it (data source + document + selfie) in one Link session.
**Outcome:** Verified identity with an auditable `kyc_check` / `documentary_verification` / `selfie_check` result.

## Narration Talk Tracks
<!-- ⚠️ HIGHEST PRIORITY for script generation — word-perfect, max 35 words each.
     HUMAN-OWNED — AI must not modify approved blocks. -->

### Demo Opening
> "Onboarding stalls when new customers retype everything and wait on manual identity checks. Plaid verifies who they are inside one flow — so the right people get through faster." (33 words)

### Verification Reveal
> "Plaid confirms the document is genuine, matches the selfie to the photo, and checks the details against trusted data sources — a verified identity, returned in seconds." (27 words)

### Layer-prefill Onboarding
> "Recognized from her phone, her details are already filled in and editable. She confirms, and Plaid verifies her identity — name, address, and ID — without a single form." (30 words)

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names.
     Build agents and script generator must use these exactly. -->

- **Link products:** `["identity_verification"]` — **mutually exclusive** with all other Plaid
  products on the same `link_token` (no `auth`, `transactions`, `identity`, etc. alongside it).
- **Template-driven:** verification methods (Data Source, Document, Selfie, AML/Monitor, Financial
  Account Matching) are configured + **published** in the IDV Dashboard template, referenced as
  `identity_verification: { template_id }` on `/link/token/create`.
- **Endpoints:**
  - `POST /link/token/create` — create the IDV Link session token.
  - `POST /identity_verification/create` — optional pre-population before Link (pre-provided fields
    are *skipped* in the Link UI and cannot be overridden by the user).
  - `POST /identity_verification/get` — retrieve the verdict (use after `STATUS_UPDATED`).
  - `POST /identity_verification/list` — list sessions by `client_user_id` + `template_id` (use for
    out-of-order webhook handling).
  - `POST /identity_verification/retry` — issue another attempt for an existing `client_user_id`.
- **Statuses (`/identity_verification/get` → `status`):** `active`, `success`, `failed`, `expired`,
  `canceled`, `pending_review`.
- **Result steps:** `accept_tos`, `verify_sms`, `kyc_check` (per-field name/dob/address/phone/id_number
  matches), `documentary_verification`, `selfie_check`, `risk_check`, `watchlist_screening`
  (`watchlist_screening_id` when Monitor/AML enabled).
- **Link events (use exactly):** `IDENTITY_VERIFICATION_CREATE_SESSION`,
  `IDENTITY_VERIFICATION_START_STEP`, `IDENTITY_VERIFICATION_PASS_SESSION`,
  `IDENTITY_VERIFICATION_FAIL_SESSION`, `IDENTITY_VERIFICATION_PENDING_REVIEW_SESSION`.
- **Webhooks (`IDENTITY_VERIFICATION` type):** `STEP_UPDATED`, `STATUS_UPDATED`, `RETRIED`.
  Configured at the **Dashboard** level — IDV ignores any `webhook` passed to `/link/token/create`.
  Not guaranteed in order: re-query state via `/identity_verification/get` / `/list`.
- **`onSuccess` semantics:** for IDV, `public_token` is `null`; `onSuccess` means *submitted*, not
  *passed*. Capture `metadata.link_session_id` as the `identity_verification_id`.

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

## Implementation Pitfalls
<!-- ⚠️ HUMAN-OWNED — product-specific mistakes to avoid in prompts, scripts, and demos. -->
- Do NOT combine `identity_verification` with any other product in `products[]` — it is mutually
  exclusive. (The link-token resolver should drop conflicts; never hand-author a mixed list.)
- Do NOT confuse with `/identity/get` (account-owner data) or `/identity/match` (bank-PII matching).
- Do NOT rely on `onSuccess` for pass/fail — wait for `STATUS_UPDATED` then `/identity_verification/get`.
- Selfie checks **do not run in Sandbox**; only Data Source + Document can be exercised there.
- IDV ignores the `webhook` field on `/link/token/create`; configure webhooks in the Dashboard.

## Demo Guidance (pipeline)
<!-- Demo-build specifics for this product in the recording pipeline. -->
- IDV runs through the **real Plaid Link SDK** — build a single `plaidPhase: "launch"` step (no
  simulated KYC step divs), per the [`plaid-demo-app-build`](../../.claude/skills/plaid-demo-app-build/SKILL.md)
  contract. Post-link host beats show the `/identity_verification/get` result in the API panel.
- **Sandbox:** the canonical passing identity is **Leslie Knope** (see `inputs/plaid-link-sandbox.md § 5`).
  Document step treats any upload as genuine and matching Leslie Knope; the step passes only when the
  user-provided name + DOB match Leslie Knope (3 attempts before failure). Selfie does not run in Sandbox.
- **Statuses on screen:** use `success` / `pending_review` for happy-path demos; never show `failed`.

## Framework QA Learnings
<!-- 🔄 SHARED — promote recurring issues from inputs/qa-fix-log.md here. -->

## Change Log
- 2026-05-29 — Scaffold created [ai]. Facts sourced from Plaid IDV docs + the Layer×IDV onboarding
  skill. Value-prop pitch, supporting claims, and narration talk tracks filled per user request
  (grounded in product facts + Layer value-prop skill framing; no numeric proof points invented —
  Proof Points table left for sourced metrics). File still `approved: false` / `needs_review: true`
  pending human sign-off on messaging.
