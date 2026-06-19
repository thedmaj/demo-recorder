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
last_ai_update: "2026-05-31T00:00:00Z"
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
- [DRAFT] Template-driven field visibility — one integration covers pay-by-bank (name/address/bank account) through strict KYC/CRA (DOB + SSN) without building separate forms
- [DRAFT] Returned identity is consumer-permissioned and phone-verified; chain Plaid IDV to add full document + selfie verification for KYC compliance
- [DRAFT] Network effect: the more users verify with Plaid, the better Layer eligibility coverage becomes across all integrated apps

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
**Architecture (canonical):** see [`Layer × CRA / Consumer Report interaction`](#layer--cra--consumer-report-interaction-plaid-check) — Layer-eligible users feed CRA via `/user/update` → `/cra/check_report/create` (no second Link); ineligible users fall back to a standard CRA Consumer Report Link.

## Narration Talk Tracks
<!-- ⚠️ HIGHEST PRIORITY for script generation — word-perfect, max 35 words each.
     The script generator uses these verbatim before any other source.
     HUMAN-OWNED — AI must not modify approved blocks. -->

- [DRAFT] Phone entry beat: "She enters her phone number. Plaid checks her eligibility in the network — and recognizes her. Her identity is already on file, ready to review and share."
- [DRAFT] Prefill review beat: "Her name, address, and linked bank accounts are pre-filled from her Plaid profile. She reviews, confirms, and continues — no form to fill out."
- [DRAFT] Ineligible fallback beat: "Plaid doesn't recognize this number. She fills in her details manually and links her bank account through standard Plaid Link."

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names.
     Build agents and script generator must use these exactly. -->

- Product name: "Plaid Layer" (not "Layer Connect" or "Layer Auth")
- **Session token created via `/session/token/create`** — NOT `/link/token/create`. Layer uses a different endpoint requiring a `user_token` + `template_id`. **There is NO `products[]` field on `/session/token/create`** — product selection is determined by the Layer Dashboard template, not the API request (AskBill-confirmed 2026-05-31).
- Completion call: `POST /user_account/session/get` (not `/identity/get`). Returns identity + items[] in one response.
- Link events: `LAYER_READY`, `LAYER_NOT_AVAILABLE`, `LAYER_AUTOFILL_NOT_AVAILABLE`, `OPEN`, `HANDOFF`
- Field visibility is template-driven (required vs optional), not globally fixed for all Layer stories
- Account-verification stories should omit DOB/SSN unless explicitly required
- Identity verification and CRA-oriented stories typically require DOB + SSN fields on share confirmation
- Do not route Layer-eligible users into fallback PII collection; fallback PII + Plaid Link is for ineligible users only.
- **Modal screens are init/template-conditional — a plain Layer session shows ONLY: welcome → OTP (one entry) → prefilled identity review → bank permission/share → confirm.** Extra consent screens appear only when the corresponding product is in the Layer session init (set via the template). In particular the **Plaid Check "Share consumer report" consent screen appears ONLY when CRA is initialized** in the Layer session (`CRA_LAYER_TEMPLATE` / `cra_*` products) — and the "Generating your Consumer Report" beat is likewise CRA-only. Never expect or author a consumer-report consent screen for a non-CRA Layer demo. Full Layer+CRA screen list + QA invariants: [`plaid-layer-cra-onboarding`](../../.claude/skills/plaid-layer-cra-onboarding/SKILL.md).
- Sandbox eligibility numbers (real Layer Web SDK): **`+14155550011` is ELIGIBLE** (`LAYER_READY` — full identity + 2 linked banks; verified live 2026-05-29) and is the default prefilled value. `+14155550000` drives the INELIGIBLE path (`LAYER_NOT_AVAILABLE` → DOB retry → `LAYER_AUTOFILL_NOT_AVAILABLE`). **Do NOT use `415-555-1111`** — that is the legacy mobile-MOCK convention, not a valid real-Layer sandbox number.
- In mobile demos, slide-like steps should auto-present in desktop mode (never inside the mobile simulator pane).

## Technical Implementation (Canonical — source of truth 2026-05-25)

### Desktop Web SDK integration best practices (REQUIRED)

These are the coding/implementation rules for a desktop web Layer integration. They are
encoded in the build prompt (`prompt-templates.js`) and the [onboarding skill](../../.claude/skills/plaid-layer-idv-onboarding/SKILL.md).

**Core pattern (event-driven state machine):** create → `submit(phone)` → wait `LAYER_READY` →
`open()` → `onSuccess` → backend `/user_account/session/get`.

1. **Create the handler early** — instantiate `Plaid.create` as soon as you have the `link_token`, not on the final CTA. Reduces submit latency and gives a stable handler reference.
2. **Run eligibility on load** — call `submit({ phone_number })` as soon as the page loads so `LAYER_READY` resolves *before* the user clicks Continue; the Continue CTA then only calls `open()`.
3. **Gate `open()` behind `LAYER_READY` only** — never `open()` right after `create()` or `submit()` (errors "Please submit Phone Number before opening Link").
4. **Idempotent event handling** — guard `open()` with a `hasOpened` flag so duplicate `LAYER_READY`/rerenders don't open twice. In React use `useRef` for the guard.
5. **One active handler per attempt** — don't recreate handlers mid-flow (avoids duplicate listeners, stale closures, multiple `open()`).
6. **Register listeners once** — stable `onEvent`/`onSuccess` config; no duplicate attachment.
7. **Separate phone and DOB submits** — only `submit({ date_of_birth })` *after* `LAYER_NOT_AVAILABLE` (Extended Autofill); never combine into one optimistic submit.
8. **Normalize input before submit** — phone to E.164, DOB as `YYYY-MM-DD`, trim whitespace.
9. **Submit may be dropped before preload-ready** — Plaid exposes no pre-submit "ready" event; retry `submit(phone)` until `LAYER_READY`/ineligibility resolves (the guards keep it idempotent).
10. **Backend is the source of truth** — `onSuccess` is only the client handoff. Send `public_token` to your backend, which calls `/user_account/session/get` promptly and decides completion.
11. **`/user_account/session/get` returns `items[]` (many, not one)** — iterate all Items; never hardcode `items[0]`.
12. **Returned identity is SUBMITTED, not verified** — store provenance; distinguish `submitted_identity` from a downstream IDV `verified_identity`; don't overwrite higher-trust records.
13. **Persist `request_id`** (and `link_session_id` from metadata/webhooks when available) for debugging/supportability.

> **Local preview (REQUIRED to see the live modals):** the Layer and IDV modals fetch
> `/api/create-session-token`, `/api/create-idv-link-token`, and `/api/user-account-session-get`.
> Opening the built `index.html` without the backend fails with `net::ERR_CONNECTION_REFUSED` and the
> modal never loads. Preview with the live backend via **`npm run preview`** (serves `out/latest`) or
> `npm run preview -- out/demos/<run>` — it loads `.env` and forces `PLAID_LINK_LIVE=true`. The
> pipeline's `record` stage starts this same app-server automatically.

### End-to-end flow summary

1. Call `POST /user/create` to get a persistent `user_token` per end-user (reuse across sessions).
2. Call `POST /session/token/create` server-side with `user_token` + `template_id` → get `link_token`.
3. Frontend: `Plaid.create({ token: linkToken, onEvent, onSuccess, onExit })`, then call `handler.submit({ phone_number })` (snake_case — **not** `phoneNumber`). **Submit AFTER the handler's preload iframe initializes** (e.g. `setTimeout(…, ~1200ms)`); submitting synchronously right after `create()` drops the call and no eligibility event fires (verified 2026-05-29).
4. Handle events. **Order is critical: `submit()` first, `open()` ONLY after `LAYER_READY`** — calling `open()` before the eligibility result errors with "Please submit Phone Number before opening Link."
   - `LAYER_READY` → call `handler.open()`.
   - `LAYER_NOT_AVAILABLE` → optional Extended Autofill: `handler.submit({ date_of_birth })` (→ `LAYER_READY` or `LAYER_AUTOFILL_NOT_AVAILABLE`).
   - `LAYER_AUTOFILL_NOT_AVAILABLE` → fall back to the storyboard's manual onboarding step (no Layer identity available).
5. `onSuccess` fires with `public_token` → backend calls `POST /user_account/session/get` with `public_token`.
6. Response: `{ identity: { name: {first_name, last_name}, address, phone_number, date_of_birth, ssn, ssn_last_4 }, items: [{ item_id, access_token }], identity_edit_history, request_id }`. **Note:** `email_address` is currently NOT returned by `/user_account/session/get` per Plaid docs (AskBill-confirmed 2026-05-31). Do not show email in the API panel for Layer demos.
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

### Layer × CRA / Consumer Report interaction (Plaid Check)

When a build uses **both Layer and CRA** (`cra_base_report` / `cra_income_insights` /
`cra_partner_insights`), the two are NOT two independent Link launches for eligible users. Plaid's
documented pattern ([Using Plaid Layer with Plaid Check Consumer Report](https://plaid.com/docs/check/onboard-users-with-layer/),
AskBill + Glean confirmed 2026-06-08) ties both to **one Plaid user** (`/user/create`) and **branches
on Layer eligibility**. CRA always requires identity on the Plaid user record *before* report
creation, so the architecture is identity-first:

**Common setup (both branches):** `POST /user/create` → keep the returned `user_id` / `user_token`.

**Branch A — Layer-eligible (`LAYER_READY`): one Layer session, NO second CRA Link.**
1. `POST /session/token/create` with the same `user.user_id` **and a Layer template that has CRA
   products enabled** (CRA products come from the template, not a `products[]` field).
2. Run the Layer Link flow → `onSuccess`.
3. `POST /user_account/session/get` → retrieve user-permissioned identity (+ `items[]`).
4. `POST /user/update` to write the required identity onto the Plaid user
   (`name`, `date_of_birth`, `emails`, `phone_numbers`, `addresses`; `id_numbers`/SSN recommended).
5. `POST /cra/check_report/create` (with `user_id`).
6. Wait for the **`USER_CHECK_REPORT_READY`** webhook, then fetch
   `/cra/check_report/base_report/get` (+ `…/income_insights/get`, `…/partner_insights/get`).
   → The Layer-linked bank connection feeds the report; the user does **not** re-link inside a CRA
   Link flow.

**Branch B — Layer-ineligible (`LAYER_AUTOFILL_NOT_AVAILABLE`): standard CRA Link fallback.**
This is exactly the [`eligibility routing → fallback`](#eligibility-routing--use-case-specific-fallback-required)
contract with the fallback step being a **CRA Consumer Report Link** session:
1. Ensure identity on the user via `/user/create` / `/user/update`.
2. `POST /link/token/create` with `products` including `cra_base_report` (+ insights), the same
   `user.user_id`, `cra_options.days_requested`, `consumer_report_permissible_purpose` (normalized,
   e.g. `"EXTENSION_OF_CREDIT"` — display-normalize the underscore enum in any UI), and `webhook`.
3. Run CRA Link → wait `USER_CHECK_REPORT_READY` → fetch the report endpoints.

**Key facts & gotchas:**
- **Same `user_id` joins both** — there is no separate "attach Layer `access_token` to the CRA user"
  step. (Standard CRA Link *does* support adding Consumer Report to an existing Item via
  `options.access_token`, but reusing a *Layer*-linked Item that way is not a documented pattern —
  prefer the Branch-A `/cra/check_report/create` path for eligible users.)
- **Identity-before-report is mandatory** — `/cra/check_report/create` fails without the identity
  fields populated; Branch A's `/user/update` step exists to satisfy this from Layer's data.
- **Transactions + (CRA & Layer):** pass `transactions` in `additional_consented_products` on
  `/link/token/create`, and call `/transactions/sync` **only after** `USER_CHECK_REPORT_READY`
  (avoids a known Chase failure where early transaction extraction breaks report generation).
- **Demo / multilaunch mapping:** an eligible-user happy path is a **single `plaidPhase:"launch"`
  Layer step** (CRA report generation is behind-the-scenes server calls shown in slides / JSON panel /
  Underwriter Internal view — see [`plaid-cra-base-report`](plaid-cra-base-report.md) Demo UI Guidance).
  Only a storyboard that demonstrates the **ineligible fallback** has a second `plaidPhase:"launch"`
  (the CRA Link session) — consistent with the [`multi-launch contract`](../../.claude/skills/plaid-demo-app-build/SKILL.md).

CRA facts (endpoints, permissible purpose, async report-ready, day windows):
[`plaid-cra-base-report.md`](plaid-cra-base-report.md) and siblings.

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
  `handler.submit({ phone_number })` FIRST, then `handler.open()` ONLY on the `LAYER_READY` event —
  never `open()` before submit, and submit after the preload iframe initializes. See the End-to-end
  flow above.)
- **The form phone drives the eligibility check (REQUIRED).** The phone number entered in the
  onboarding form MUST be read from the input (normalized to E.164) and passed to
  `handler.submit({ phone_number })` — that submit is what triggers the Layer eligibility check
  (`LAYER_READY` / `LAYER_NOT_AVAILABLE`). **Never submit a hardcoded phone**; prefill the input with
  the eligible sandbox number so the happy path passes. Re-read the field at submit time so an edited
  value is honored.

### Eligibility routing → use-case-specific fallback (REQUIRED)

The entered phone number doesn't just gate Layer — it **routes the entire demo experience**. The
eligibility result selects between the Layer happy path and the storyboard's manual onboarding path:

| Eligibility event | Meaning | Demo route |
|---|---|---|
| `LAYER_READY` | Phone matched in the Plaid Network | Layer proceeds → prefill review (identity + linked banks) → continue |
| `LAYER_NOT_AVAILABLE` | Autofill not immediately available | Optional Extended-Autofill retry: `handler.submit({ date_of_birth })` |
| `LAYER_AUTOFILL_NOT_AVAILABLE` | Ineligible — no Layer identity | **Route to the storyboard's manual fallback step** |

- The **manual fallback is use-case specific** — it is whatever the storyboard outlines for the
  ineligible path: **linking a bank account through real Plaid Link**, **launching an Identity
  Verification session**, or **a generic (non-Plaid) PII entry screen**. The demo-script designates
  this fallback step; the generated app wires `window.goToStep('<manual-fallback-step-id>')` to it in
  the `LAYER_AUTOFILL_NOT_AVAILABLE` branch (after `handler.destroy()`). If the storyboard declares no
  explicit fallback, default to the first non-Layer manual host step.
- **Sandbox phone → outcome** (for testing both branches):
  - `+14155550011` → `LAYER_READY` → Layer happy path (full identity + 2 linked banks).
  - `+14155550000` → `LAYER_NOT_AVAILABLE` → (DOB retry) → `LAYER_AUTOFILL_NOT_AVAILABLE` → fallback.
  - `+1415555XXXX` partial-profile numbers exercise Extended-Autofill / partial paths — see the
    `plaid-layer-idv-onboarding` skill's sandbox phone table for the full matrix.
- This is the core Layer demo idea: **phone entry determines eligibility, eligibility determines the
  experience.** A happy-path-only storyboard still wires the eligible phone; storyboards that want to
  show the fallback declare the use-case-specific fallback step and prefill an ineligible phone.

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

## Implementation Pitfalls
<!-- ⚠️ HUMAN-OWNED — product-specific mistakes to avoid in prompts, scripts, and demos. -->

- **No `products[]` on `/session/token/create`** — Layer product configuration is done via the Dashboard template, not the API request field (AskBill-confirmed 2026-05-31)
- **`email_address` is NOT returned** by `/user_account/session/get` — do not show email in the API panel for Layer demos (AskBill-confirmed 2026-05-31)
- **Returned identity is unverified** (phone is verified; other fields are user-submitted/editable) — chain IDV to KYC if verification is required
- **`submit()` before `open()`** — call `handler.submit({ phone_number })` first; only call `handler.open()` after `LAYER_READY` fires. Calling `open()` before submit throws "Please submit Phone Number before opening Link"
- **Submit after preload** — submit may be dropped if called synchronously right after `Plaid.create()` before the preload iframe initializes; use ~1200ms delay or retry guard
- **`/user/create` is one-time** — calling it again for an existing `client_user_id` returns 400. Use `getOrCreateLayerUserToken()` cache pattern to reuse `user_token` across runs
- **Do NOT present Layer vs manual as a user choice** — eligibility is determined automatically by the phone number; the branch is invisible to the user

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

### 2026-05-29 — Run: 2026-05-29-Demo-Identity-v3 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] Pre-verified identity from bank-verified sources, not self-typed input
- [high] Network effect — 45M+ saved Plaid profiles improve Layer coverage over time
- [high] No additional verification step for returning users — identity already established with Plaid
- [high] Template-driven field visibility — one integration covers pay-by-bank through strict KYC/CRA

### 2026-05-29 — Run: 2026-05-29-Demo-Identity-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] Pre-verified identity from bank-verified sources (not self-typed)
- [high] Network effect at scale — 45M+ saved Plaid profiles improve Layer coverage over time
- [high] No additional verification step for returning users — identity already established with Plaid
- [high] Template-driven field visibility — one integration covers pay-by-bank through strict KYC/CRA

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

## Layer + CRA (Consumer Report) — canonical pairing

When Layer fronts a **CRA / Consumer Report** flow, the **single Layer session** both
permissions accounts and returns user-permissioned identity — there is **NO separate CRA
Plaid Link session**. Identity from Layer is written to the Plaid user record, then the
report is generated server-side:

`/user/create` → `/session/token/create` (CRA Layer template + `user.user_id`) → user
completes Layer → `/user_account/session/get` → `/user/update` (`name`, `date_of_birth`,
`emails`, `phone_numbers`, `addresses`; partial SSN recommended) → `/cra/check_report/create`
(Base Report eagerly generated) → `USER_CHECK_REPORT_READY` → `/cra/check_report/<report>/get`.

**Template selection (env):**
- **CRA** Layer demos use **`CRA_LAYER_TEMPLATE`** (Layer template with CRA products
  enabled) + CRA API credentials `CRA_CLIENT_ID` / `CRA_SECRET`.
- **Non-CRA** Layer use cases (payments, faster onboarding) use **`PLAID_LAYER_TEMPLATE_ID`**.

Full playbook: `.claude/skills/plaid-layer-cra-onboarding/SKILL.md`.
For KYC document/selfie verification chained after Layer, see
`.claude/skills/plaid-layer-idv-onboarding/SKILL.md`.
Docs: https://plaid.com/docs/check/onboard-users-with-layer/
