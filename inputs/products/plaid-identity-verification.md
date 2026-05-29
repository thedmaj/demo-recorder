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
version: 2
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

## Identity Verification — API patterns (Link session · webhooks · lifecycle)
<!-- Reference, AI-sourced from AskBill / Plaid docs (2026-05-29):
     plaid.com/docs/identity-verification/ , /link/ , /webhooks/ , /api/products/identity-verification/ ,
     github.com/plaid/idv-quickstart. Verify exact fields against current docs before relying on them. -->

### Link session creation (two patterns)

**A — Link token only** (Plaid prefills from the `user` object inside Link):
```jsonc
POST /link/token/create
{
  "client_name": "My App", "language": "en", "country_codes": ["US"],
  "products": ["identity_verification"],
  "user": { "client_user_id": "user-123", "email_address": "user@example.com",
            "phone_number": "+14155550123", "date_of_birth": "1990-05-29",
            "name": { "given_name": "Leslie", "family_name": "Knope" },
            "address": { "street": "123 Main St", "city": "Pawnee", "region": "IN",
                         "postal_code": "46001", "country": "US" },
            "id_number": { "value": "123456789", "type": "us_ssn" } },
  "identity_verification": { "template_id": "idvtmp_…", "gave_consent": true }
}
```
**B — Pre-create then Link** (for prefill control or a hosted/shareable session):
`POST /identity_verification/create` with `client_user_id`, `template_id`, `is_shareable`,
`gave_consent`, and a `user` object (same prefill fields as above) → returns `id`
(the `identity_verification_id`) and, when `is_shareable: true`, a hosted `shareable_url`
(no Link SDK needed). Then `POST /link/token/create` with the IDV template for the same
`client_user_id`.

Key rules:
- **`country_codes` is YOUR company's country, not the user's.**
- `products` must be exactly `["identity_verification"]` (mutually exclusive).
- `identity_verification.gave_consent: true` → the `accept_tos` step is skipped.
- **Pre-provided fields are skipped in the Link UI and cannot be edited by the user.** If both
  `/identity_verification/create` and `/link/token/create` carry `user` data for the same
  `client_user_id`, the create-call data wins.
- Frontend: `onSuccess(public_token, metadata)` — **`public_token` is `null`**; use
  `metadata.link_session_id` as the `identity_verification_id` (also surfaced on the
  `IDENTITY_VERIFICATION_CREATE_SESSION` `onEvent`). Or use the `id` from `/identity_verification/create`.

### Webhooks (`webhook_type: "IDENTITY_VERIFICATION"`)

Thin payload — only an ID; fetch state with `/identity_verification/get`:
```jsonc
{ "webhook_type": "IDENTITY_VERIFICATION",
  "webhook_code": "STATUS_UPDATED",      // | STEP_UPDATED | RETRIED
  "identity_verification_id": "idv_…",
  "environment": "sandbox" }             // sandbox | development | production
```
- `STATUS_UPDATED` — session status changed (e.g. `active` → `success`/`failed`/`pending_review`).
- `STEP_UPDATED` — an individual step changed.
- `RETRIED` — a retry was issued.
- **Delivery is not ordered.** On each webhook, call `/identity_verification/get` (or `/list` by
  `client_user_id` + `template_id`), dedupe on `identity_verification_id`, and only advance your
  state machine forward. Webhooks are configured at the **Dashboard** level — IDV ignores any
  `webhook` field on `/link/token/create`.

### `POST /identity_verification/get` response

Top-level: `id`, `client_user_id`, `created_at`, `completed_at`, `previous_attempt_id`,
`shareable_url`, `template` (`{id, version}`), `user`, `status`, `steps`, plus the per-check objects
`kyc_check`, `documentary_verification`, `selfie_check`, `risk_check`, `verify_sms`,
`watchlist_screening_id`, `request_id`.
- **`status`** ∈ `active`, `success`, `failed`, `expired`, `canceled`, `pending_review`.
- **`steps.<name>` status** ∈ `success`, `active`, `failed`, `waiting_for_prerequisite`,
  `not_applicable`, `skipped`, `expired`, `canceled`, `pending_review`, `manually_approved`,
  `manually_rejected`.
- Step objects (high level): `kyc_check` → per-field `summary` (`match`/`partial_match`/`no_match`/
  `no_data`/`no_input`) for name/dob/address/id_number/phone; `documentary_verification` →
  `documents[]` with `extracted_data` + `analysis` (authenticity, image_quality, AAMVA);
  `selfie_check` → `document_comparison` + `liveness_check`; `risk_check` → behavior/email/phone/
  devices/identity_abuse_signals (+ `trust_index_score`).

### Retry — `POST /identity_verification/retry` (use this, not `/create`, for retries)

`strategy` ∈:
- `reset` — restart from the beginning regardless of prior progress.
- `incomplete` — resume at the failed step, keeping passed steps (NOT allowed if the failing step is
  `screening` or `risk_check`).
- `infer` — if the latest attempt is `failed`/`expired` use `incomplete`, else `reset` (NOT allowed
  while status is still `active`).
- `custom` — supply a `steps: { verify_sms, kyc_check, documentary_verification, selfie_check }`
  boolean map.

Each retry mints a new attempt ID (linked via `previous_attempt_id`), uses the latest template
version, and clears PII for the reset steps. In **Sandbox**, `selfie_check` is silently disabled.

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
- 2026-05-29 — Added "Identity Verification — API patterns (Link session · webhooks · lifecycle)"
  reference [ai]. Sourced from AskBill / Plaid docs (identity-verification intro, /link/, /webhooks/,
  /api/products/identity-verification/, idv-quickstart) — covers the two Link-session patterns +
  prefill, the thin webhook payload + out-of-order handling, the /identity_verification/get response
  (status + step-status enums + step objects), and the four /retry strategies. Glean returned no
  usable internal results. Verify field names against current docs before relying on them.
