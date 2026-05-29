---
product: Plaid Layer
slug: layer
api_endpoints:
  - "/session/token/create"
  - "/user_account/session/get"
  - "/user/create"
  - "/item/public_token/exchange"
  - "/auth/get"
use_cases:
  - "streamlined-onboarding"
  - "returning-user-verification"
  - "kyc-auto-fill"
last_human_review: "2026-03-12"
last_ai_update: "2026-05-29T12:56:28.567Z"
needs_review: true
approved: true
version: 2
last_vp_research: "2026-05-25"
---

# Plaid Layer

## Overview
<!-- ⚠️ HUMAN-OWNED — 2–3 sentences: what this product is, what problem it solves. -->
Plaid Layer accelerates onboarding by presenting an eligibility-gated, phone-first flow that lets users review and share prefilled identity and account context. The exact shared fields are template-driven by use case, so high-friction fields (for example DOB and SSN) are only shown when required for compliance or verification needs.

## Where It Fits
<!-- ⚠️ HUMAN-OWNED — when should this product be featured? What persona/use case? -->
Feature Layer when the demo persona is a fintech, lender, or neobank facing high drop-off during KYC/onboarding. Best paired with a compelling "before vs after" narrative: long form fill → one-tap verified identity.

## Value Proposition Statements
<!-- ⚠️ HUMAN-OWNED — pre-approved messaging. AI may ADD candidates marked [DRAFT]
     but must NOT modify or remove approved statements.
     Humans promote [DRAFT] to approved by deleting the tag. -->

### Primary Pitch
> "One tap to a verified identity — Plaid Layer auto-fills KYC in seconds for users who've verified with Plaid before."

### Supporting Claims
- [DRAFT] Reduces onboarding form friction for returning Plaid users — Source: product docs, 2026-03-12

## Proof Points & ROI Metrics
<!-- ⚠️ HUMAN-OWNED — every claim requires a Source. AI adds [DRAFT] rows only. -->

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|

## Customer Use Cases
<!-- ⚠️ HUMAN-OWNED — scenario descriptions for demo builders. AI may add [DRAFT] scenarios. -->

### KYC Auto-Fill for Returning Users
**Persona:** Developer at a lending or investment platform
**Problem:** High drop-off during KYC form fill; users frustrated re-entering the same data
**Solution:** Layer detects returning Plaid users and pre-populates name, address, SSN, DOB
**Outcome:** Faster time-to-funded; reduced KYC abandonment

### [DRAFT] Account Verification / Pay-by-Bank
**Persona:** Product manager at a payments or billing platform
**Problem:** Users drop off when linking bank accounts due to form friction
**Solution:** Layer share screen prioritizes name, phone, address, email (if available), and bank account details; DOB/SSN omitted by default
**Outcome:** Faster bank-link completion with lower friction and cleaner UX

### [DRAFT] Identity Verification-Oriented Onboarding
**Persona:** Compliance lead at fintech/neobank
**Problem:** Need stronger identity assurance for onboarding
**Solution:** Layer share screen includes name, address, phone, DOB, and SSN (or SSN last4) when required by template
**Outcome:** Better identity completeness for KYC workflows

### [DRAFT] Branching Rule: Layer Eligibility vs Fallback
**Persona:** Product team designing mobile onboarding funnels
**Problem:** Teams accidentally collect extra PII for users who are already Layer-eligible, creating unnecessary friction
**Solution:** Enforce branch semantics:
- **Layer-eligible users:** complete Layer flow and proceed directly to an onboarding complete state (no additional PII collection)
- **Layer-ineligible users:** continue to PII collection fallback and then bank linking via standard Plaid Link experience
**Outcome:** Preserve low-friction conversion for eligible users while maintaining a compliant fallback for ineligible users

### [DRAFT] CRA / Consumer Report Flow
**Persona:** Credit product team using CRA data
**Problem:** Credit/report workflows require strict identity collection and consent context
**Solution:** Layer template requires identity fields (name, address, DOB, SSN) and routes ineligible users to fallback
**Outcome:** Higher confidence that CRA-required data is collected before report retrieval

## Narration Talk Tracks
<!-- ⚠️ HIGHEST PRIORITY for script generation — word-perfect, max 35 words each.
     The script generator uses these verbatim before any other source.
     HUMAN-OWNED — AI must not modify approved blocks. -->

<!-- Add narration talk tracks here once Layer demos are finalized -->

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names.
     Build agents and script generator must use these exactly. -->

- Product name: "Plaid Layer" (not "Layer Connect" or "Layer Auth")
- **Session token created via `/session/token/create`** — NOT `/link/token/create`. Layer uses a different endpoint requiring a `user_token` + `template_id`.
- Completion call: `POST /user_account/session/get` (not `/identity/get`). Returns identity + items[] in one response.
- Link events: `LAYER_READY`, `LAYER_NOT_AVAILABLE`, `LAYER_AUTOFILL_NOT_AVAILABLE`, `OPEN`, `HANDOFF`
- Field visibility is template-driven (required vs optional), not globally fixed for all Layer stories
- Account-verification stories should omit DOB/SSN unless explicitly required
- Identity verification and CRA-oriented stories typically require DOB + SSN fields on share confirmation
- Do not route Layer-eligible users into fallback PII collection; fallback PII + Plaid Link is for ineligible users only.
- For mobile Layer demos, show subtle helper text directly below the mobile frame with both routing numbers: `415-555-1111` (eligible) and `415-555-0011` (ineligible fallback).
- Default prefilled phone value in Layer host capture should be the eligible number first (`415-555-1111`).
- In mobile demos, slide-like steps should auto-present in desktop mode (never inside the mobile simulator pane).

## Technical Implementation (Canonical — source of truth 2026-05-25)

### End-to-end flow summary

1. Call `POST /user/create` to get a persistent `user_token` per end-user (reuse across sessions).
2. Call `POST /session/token/create` server-side with `user_token` + `template_id` → get `link_token`.
3. Frontend: `Plaid.create({ token: linkToken, onEvent, onSuccess, onExit })` then `handler.submit({ phoneNumber })`.
4. Handle events:
   - `LAYER_READY` → call `handler.open()` immediately.
   - `LAYER_NOT_AVAILABLE` → collect DOB, then call `handler.submit({ phoneNumber, dateOfBirth })`.
   - `LAYER_AUTOFILL_NOT_AVAILABLE` → fall back to standard signup form (no Layer identity available).
5. `onSuccess` fires with `public_token` → backend calls `POST /user_account/session/get` with `public_token`.
6. Response: `{ user: { legal_name, email_address, phone_number, date_of_birth, address }, items: [{ item_id, access_token, institution_id }] }`.
7. If `items[]` is present, use the `access_token` directly — **do not** also call `/item/public_token/exchange` (already done by Layer). Only call it explicitly if you need the exchange step visible in a demo API log.
8. Optionally call `POST /auth/get` with the Item `access_token` to retrieve ACH routing + account numbers.

### `/session/token/create` minimal request

```jsonc
{
  "client_id": "PLAID_CLIENT_ID",
  "secret":    "PLAID_SECRET",
  "user_token": "user-…",
  "template_id": "tmp_…",
  "client_name": "Halo Bank",
  "webhook": "https://…/webhook"
}
```

### Preload pattern (instant submit)

Preload `Plaid.create()` on page mount before the user types their phone — `submit()` synchronously on Continue. After `onExit`, re-arm via `setTimeout(preload, 0)`. See `artifacts/layer-onboarding/src/pages/onboarding.tsx` for the three-branch handleStart implementation.

### Sandbox phones

| Phone | Mode | OTP | Notes |
|---|---|---|---|
| `+14155550011` | Layer-eligible (`LAYER_READY`) | `123456` | Returns full identity + linked sandbox Item |
| `+14155550000` | Extended Autofill fallback | `123456` | Requires DOB `1975-01-18`. Returns identity, no Item |

### Common pitfalls

- **404 on `/user_account/session/get`** → wrong endpoint name (it is `user_account`, not `user`).
- **No `items[]` in response** → template doesn't enable bank linking, or user skipped it. Not an error.
- **`LAYER_NOT_AVAILABLE` fires then calling `open()` directly** → SDK throws. Must collect DOB and re-`submit()` first.
- **Plaid Link inside an iframe (e.g. Replit preview)** → won't initialize. Must open in a real browser tab.
- **Recreating handler on every render** → hold handler in a ref; only recreate after `onExit`.

### Reference implementation

- `artifacts/api-server/src/routes/layer.ts` — `/start`, `/complete`, `plaidCall` wrapper, `redact()`.
- `artifacts/layer-onboarding/src/pages/onboarding.tsx` — LayerStage state machine, preload pattern.

### Layer × Identity Verification (IDV) interaction

Layer prefills identity; it does **not verify** it. The data from `/user_account/session/get` is
consumer-permissioned and user-editable — treat it as user-submitted. To KYC it, chain a full IDV
session (Document + Data Source + Selfie/liveness). Key facts:

- **Two sequential Link sessions**, joined by the **same `client_user_id`**: Layer via
  `/session/token/create`, then IDV via `/link/token/create` with `products: ["identity_verification"]`.
- **IDV is mutually exclusive** with all other products on its Link token — never combine
  `identity_verification` with `auth`/`identity`/`transactions`/etc.
- **Prefill IDV** with Layer's returned PII via `/identity_verification/create` (pre-provided fields
  are skipped in the IDV UI) before creating the IDV Link token.
- If Layer is ineligible (`LAYER_AUTOFILL_NOT_AVAILABLE` / non-`+1` phone), skip Layer and go
  straight to IDV with the same `client_user_id`.

IDV facts (endpoints, statuses, webhooks, sandbox persona): [`inputs/products/plaid-identity-verification.md`](plaid-identity-verification.md).
Full sequencing playbook: [`plaid-layer-idv-onboarding`](../../.claude/skills/plaid-layer-idv-onboarding/SKILL.md) skill.

### Onboarding entry contract (REQUIRED)

- The onboarding entry collects **only a mobile phone number** (prefilled with the sandbox value for
  demos), plus a single **Continue** trigger. Submitting the phone runs Layer eligibility.
- The Layer-vs-fallback path is decided **automatically by eligibility** — `LAYER_READY` → Layer
  proceeds; `LAYER_NOT_AVAILABLE` (optionally retry with DOB) / `LAYER_AUTOFILL_NOT_AVAILABLE` →
  fallback. **Never present "onboard with Plaid vs. continue manually" as a user choice**, and do not
  render a separate "Prefill with Plaid" / "Continue manually" button pair. The branch is invisible
  to the user.
- Happy-path sandbox phone **`+14155550011`** (LAYER_READY) returns full identity **+ linked bank
  accounts** — use it to demonstrate identity and bank data together. (Web SDK ordering:
  `handler.open()` then `handler.submit({ phone_number })`.)

### Layer activation check (REQUIRED — pipeline-enforced)

Every Layer build must verify Layer is actually activated by obtaining a **successful
`/session/token/create`** (a non-empty `link_token`). A failed token means Layer is not provisioned
for the client or `PLAID_LAYER_TEMPLATE_ID` is wrong. The pipeline enforces this in
[`plaid-link-qa`](../../scripts/scratch/scratch/plaid-link-qa.js) (Layer branch) via
`plaid-backend.verifyLayerActivation()`, which halts the build before build-qa/record on failure.
This runs whenever a demo uses Layer (`PLAID_LINK_LIVE=true` + a `plaidPhase:"launch"` step).

### Layer re-initialization across runs (REQUIRED)

`POST /user/create` is **one-time per `client_user_id`** — calling it again returns
`400: a user already exists for this client user id`. Because Layer demos reuse a stable
`client_user_id`, a naive second run fails to create the session token (the 500 seen at
`/api/create-session-token`). Contract: **create the Plaid user once, then mint a NEW Layer
session each run.**

`plaid-backend.createSessionToken()` implements this via `getOrCreateLayerUserToken()`:

- **Cache hit** (user created on a prior run) → reuse the stored `user_token`, skip `/user/create`,
  and call `/session/token/create` for a fresh Layer session. (user created once; new session each run)
- **Cache miss** → `/user/create`, cache the `user_token` (`out/.layer-user-cache.json`, gitignored).
- **`already exists` 400 without a cached token** → Plaid has no API to recover an existing
  `user_token` by `client_user_id`, so mint a fresh unique `client_user_id`
  (`<id>-<timestamp>`) and create a new user for that session. Repeat runs never error.

Do NOT call `/user/create` directly in generated apps; always go through
`/api/create-session-token` (which uses `createSessionToken`).

### Behind-the-scenes eligibility + webhooks (demo simulation — REQUIRED for Layer builds)

Layer demos should **visualize the eligibility check and webhooks** at the appropriate steps so
viewers see what happens behind the scenes (these are not user-visible in the real flow). Surface
them in the API/JSON panel (and/or a host "behind the scenes" callout) in this order:

1. **Launch / phone submit** — `POST /session/token/create` (Layer session created), then the
   eligibility result as a Link event: **`LAYER_READY`** (happy path) — "Plaid matched this phone
   number in the Plaid Network." (Ineligible would be `LAYER_NOT_AVAILABLE` → `LAYER_AUTOFILL_NOT_AVAILABLE`.)
2. **Device auth** — webhook **`LAYER_AUTHENTICATION_PASSED`** (`webhook_type: "LAYER"`) — phone
   ownership verified (OTP/SNA), so the host may skip its own OTP.
3. **Session finish** — webhook **`SESSION_FINISHED`** (`webhook_type: "LINK"`, `status: "SUCCESS"`,
   `public_tokens: […]`) — Layer session reached a terminal state.
4. **Prefill review** — `POST /user_account/session/get` returns `identity` + `items[]` (identity
   and linked bank accounts) in one call (no separate `/item/public_token/exchange`).

Keep payloads realistic and idealized; never invent fields. The build prompt
(`prompt-templates.js` real-Layer block) instructs this; see also
[`plaid-layer-idv-onboarding`](../../.claude/skills/plaid-layer-idv-onboarding/SKILL.md).

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

- Pre-verified identity: data comes from bank-verified sources, not user-typed input
- Network effect: the more users who verify with Plaid, the better Layer coverage gets
- No additional verification step for returning users — identity is already established

## Objections & Responses
<!-- 🔄 SHARED — AI adds [DRAFT] from Gong; human approves by removing [DRAFT] tag. -->

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|

## AI Research Notes
<!-- 🤖 AI-OWNED — auto-populated by research.js after each pipeline run.
     Human reviews but does not need to edit. Entries accumulate — do not remove.
     Only findings at or above the confidence threshold are appended (default: medium). -->

### 2026-05-29 — Run: 2026-05-29-New-to-bank-Applicant-From-Synovuss-Identity-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] Pre-verified identity from bank-verified sources
- [high] Network effect at scale
- [high] No additional verification step for returning users
- [high] Template-driven field visibility

### 2026-05-29 — Run: 2026-05-29-New-to-bank-Applicant-From-Synovuss-Identity-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] Pre-verified identity from bank-verified sources, not user-typed input
- [high] Network effect — 45M+ saved Plaid profiles improve Layer coverage over time
- [high] No additional verification step for returning users — identity already established with Plaid
- [high] Template-driven field visibility — one integration covers pay-by-bank through strict KYC/CRA

### 2026-05-29 — Run: 2026-05-29-New-to-bank-Applicant-Arriving-From-Identity-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] Pre-verified identity from bank-verified sources (not self-typed)
- [high] Network effect at scale — 45M+ saved Plaid profiles improve Layer coverage over time
- [high] No additional verification step for returning users — identity already established with Plaid
- [high] Template-driven field visibility — one integration covers pay-by-bank through strict KYC/CRA

### 2026-05-21 — Run: 2026-05-21-Demo-Identity-Layer-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] Pre-verified identity from bank-verified sources
- [high] Network effect at scale
- [high] No additional verification step for returning users
- [high] Template-driven field visibility

### 2026-04-19 — Run: 2026-04-19-Uses-Ynab-To-Manage-Identity-Monitor-Income-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] Pre-verified identity from bank-verified sources (not self-typed)
- [high] Network effect — 45M+ saved Plaid profiles improve coverage over time
- [high] No additional verification step for returning users
- [high] Template-driven field visibility — one integration covers pay-by-bank through strict KYC/CRA

### 2026-04-13 — Run: 2026-04-13-Uses-Ynab-To-Manage-Identity-Monitor-Layer-Income-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] Pre-verified identity from bank-verified sources
- [high] Network effect at scale
- [high] No additional verification step for returning users
- [high] Template-driven flexibility

### 2026-03-12 — Scaffold created [human]
Empty scaffold for Layer product. To be populated by pipeline research runs.

### 2026-04-08 — Layer field permutations by use case [ai]
- AskBill guidance: for account verification/pay-by-bank Layer flows, default share fields should be minimal (name/phone/address/email/bank account), with DOB and SSN omitted unless explicitly required.
- AskBill guidance: for identity-verification-oriented Layer flows, share fields commonly include name, address, phone, DOB, and SSN or SSN last4.
- AskBill guidance: CRA-oriented flows are typically strict identity contexts and should include required identity fields (name/address/DOB/SSN), with fallback paths for ineligible users.
- AskBill guidance: in CRA contexts, phone and email are commonly required identity fields, while bank account rows are included only when available and required by template/story.

### 2026-04-09 — Layer prototype fidelity + branch contract [ai]
- Canonical prototype contract for mobile Layer demos: maintain template structure and copy fidelity (layout, CSS hierarchy, logo treatment, and fixed instructional text) while only substituting variable values such as persona identity fields and bank account details.
- Branching contract: eligible users complete Layer and go to onboarding complete state without extra PII collection; only ineligible users proceed to fallback PII collection and then standard Plaid Link bank linking.
- Mobile helper-copy contract: include subtle helper text below the mobile frame with explicit eligible/ineligible phone numbers and keep the eligible number prefilled by default.
- Mobile slide-view contract: auto-switch to desktop mode for slide-like screens; no manual view toggle required.

## Change Log

- 2026-03-12: Scaffold created [human]
- 2026-04-09: Added prototype-fidelity and eligibility/fallback branching guidance [ai]
