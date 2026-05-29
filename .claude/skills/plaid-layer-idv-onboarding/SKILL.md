---
name: plaid-layer-idv-onboarding
description: >-
  How to implement Plaid Layer as the front-of-funnel onboarding step and chain a full Plaid
  Identity Verification (IDV) session (Document + Data Source + Selfie/liveness) for KYC, joined by a
  shared client_user_id. Cross-product integration + sequencing playbook. Load when a task mentions
  Layer + IDV, /session/token/create, LAYER_READY/LAYER_NOT_AVAILABLE, identity_verification,
  document/selfie/liveness/KYC, or chaining network-prefill onboarding with interactive KYC. NOT for
  /identity/get or /identity/match (account-ownership matching) — those are a different flow.
---

# Implementing Plaid Layer with Plaid Identity Verification (IDV)

> **Architecture / source of truth.** This is a **cross-product skill** (a how-to playbook). The
> canonical *facts* for each product live in the product knowledge base and win on any conflict:
> [`inputs/products/plaid-layer.md`](../../../inputs/products/plaid-layer.md) and
> [`inputs/products/plaid-identity-verification.md`](../../../inputs/products/plaid-identity-verification.md).
> Update those KBs when an endpoint/field/status changes; update this skill when the *sequencing*
> changes. (Convention: product KB = indexed per-product facts; skill = how-to / cross-product flow.)
> For **standalone IDV** (Link session request/response shapes, webhook payloads, the
> `/identity_verification/get` response + status enums, and the four `/retry` strategies), see the
> "Identity Verification — API patterns" section of
> [`inputs/products/plaid-identity-verification.md`](../../../inputs/products/plaid-identity-verification.md).
>
> **In the demo-recording pipeline,** both Layer and IDV run through the **real Plaid Link SDK** as a
> single `plaidPhase: "launch"` step each — do **not** build simulated step divs. This skill's backend
> sequencing informs the post-link host beats and API panels; the on-screen build contract is in
> [`plaid-demo-app-build`](../plaid-demo-app-build/SKILL.md), sandbox creds/persona in
> [`inputs/plaid-link-sandbox.md`](../../../inputs/plaid-link-sandbox.md).
>
> **Onboarding entry = phone number only; path is automatic.** Collect ONLY a mobile phone number at
> onboarding; the Layer-vs-fallback branch is decided automatically by eligibility
> (`LAYER_READY` → Layer; `LAYER_NOT_AVAILABLE`/`LAYER_AUTOFILL_NOT_AVAILABLE` → fallback). Never show
> an "onboard with Plaid vs. continue manually" choice. Happy-path sandbox phone `+14155550011`
> returns identity **+ linked banks**.
>
> **The form phone drives eligibility (REQUIRED).** Read the onboarding phone input value (normalize
> to E.164) and pass it to `handler.submit({ phone_number })` after `handler.open()` — that submit is
> the eligibility check. Never submit a hardcoded number; re-read the field at submit time. Prefill the
> input with the eligible sandbox number so the happy path passes.
>
> **Activation check (pipeline-enforced):** every Layer build verifies activation via a successful
> `/session/token/create` (`plaid-backend.verifyLayerActivation()` in the `plaid-link-qa` Layer
> branch) — a failed token = Layer not provisioned / wrong `PLAID_LAYER_TEMPLATE_ID`, and halts the build.
>
> **Re-initialization across runs:** `/user/create` is one-time per `client_user_id` (re-calling →
> `400 a user already exists`). `plaid-backend.createSessionToken()` creates the user **once** (caches
> the `user_token` in `out/.layer-user-cache.json`), reuses it to mint a **new** `/session/token/create`
> each run, and falls back to a fresh unique `client_user_id` if the user exists but isn't cached — so
> repeat demo runs never hit the 500. Generated apps must call `/api/create-session-token`, never `/user/create`.
>
> **Visualize the behind-the-scenes eligibility + webhooks** in Layer build demos (API/JSON panel or a
> host "behind the scenes" callout): `/session/token/create` → `LAYER_READY` → `LAYER_AUTHENTICATION_PASSED`
> webhook → `SESSION_FINISHED` webhook (`public_tokens[]`) → `/user_account/session/get`.

## When to use this skill
Use this skill whenever a task involves implementing Plaid Layer as the front-of-funnel onboarding step and then chaining a full Plaid Identity Verification (IDV) session — meaning Document Verification, Data Source (database) Verification, and Selfie/liveness check — to satisfy KYC. This skill is NOT for `/identity/get`, `/identity/match`, or any account‑ownership matching against bank data. It is specifically for the IDV product (`products: ["identity_verification"]`), which runs through Link as its own session and is mutually exclusive with other Plaid products in the same Link token.

Use this skill if any of the following are true:
- The task mentions "Layer", `/session/token/create`, `LAYER_READY`, `LAYER_NOT_AVAILABLE`, or `LAYER_AUTHENTICATION_PASSED`.
- The task mentions "Identity Verification", "IDV", "document verification", "selfie", "liveness", "data source check", or "KYC".
- The task involves chaining a network‑prefill onboarding step with an interactive KYC step.

Do NOT use this skill for:
- `/identity/get` (account‑owner data from a linked Item).
- `/identity/match` or Financial Account Matching (those compare bank PII to user‑supplied PII; different flow).
- Layer + Plaid Check / Consumer Report onboarding (see the separate Plaid Check + Layer guide).

---

## Key concepts you must internalize

### What Layer is and is not
- Layer is a **prefill + phone authentication** experience. Given a phone number, Plaid checks the Plaid Network for cached, consumer‑permissioned identity (name, address, DOB, email, SSN/SSN last‑4) and previously linked bank Items, authenticates the user via OTP or SNA, runs device/network risk, and returns that profile + access tokens for any linked Items.
- Layer is **US only** (country code `+1`). Any non‑`+1` phone number returns `LAYER_NOT_AVAILABLE`.
- Layer is **not KYC**. The data returned by `/user_account/session/get` is consumer‑permissioned and editable by the user during the Link flow — treat it as user‑submitted, not verified. To verify it, run IDV (this skill) or Identity Match.
- Layer is **not compatible with Hosted Link**.
- Layer is **not supported in mobile webview** integrations.

### What IDV (document + database + selfie) is
Plaid Identity Verification (IDV) is configured via a **template** in the IDV Dashboard, not via API. In the template, you turn on the verification methods you want:

- **Data Source Verification** (formerly Lightning Verification): verifies name, address, DOB, phone, and ID number (e.g. SSN) against trusted databases (voter, driver, property, credit bureau). Results are summarized in the `kyc_check` object returned by `/identity_verification/get`.
- **Document Verification**: prompts the user to upload a government‑issued ID. Plaid runs anti‑fraud checks (expiry, tampering) and verifies name + DOB on the document against the user‑provided data. Supports 16,000+ document types. If the user is on desktop, Plaid automatically displays a QR code to hand off to mobile for capture and then resumes the desktop flow.
- **Selfie Check** (liveness): user takes a selfie on mobile; Plaid confirms it is a real, live human and — if Document Verification is also enabled — matches the selfie face to the document portrait. With both Selfie + Document enabled, an automatic age‑consistency check also runs against the provided DOB.

IDV in Link is **mutually exclusive** with other Plaid products on the same `link_token` (i.e. you cannot put `identity_verification` in `products` alongside `auth`, `transactions`, `identity`, etc.). To combine Layer's prefill with IDV's KYC, you run them as **two sequential Link sessions** with two different tokens, joined by a shared `client_user_id`.

### How Layer and IDV are joined
Use the **same `client_user_id`** in both the Layer `/session/token/create` call and the IDV `/link/token/create` call. This is what links the two flows for downstream features like Financial Account Matching, retries, and dashboard search. The `client_user_id` must be a stable, non‑PII internal identifier (e.g., your DB user ID).

---

## Prerequisites checklist

Before writing any integration code, confirm these are in place. If you cannot confirm any of them, stop and tell the user.

1. **Production access (or Sandbox access) for both products.** Layer requires sales to grant access. IDV is not enabled by default in Sandbox — the team must either request Production access (auto‑grants Sandbox) or ask their AM/file a product‑access ticket.
2. **A Layer template** in the [Layer Dashboard](https://dashboard.plaid.com/layer) with eligibility requirements set to your real business needs (required vs. optional fields). Save the `template_id` — Layer template IDs typically look like `template_4uinBNe4B2x9`.
3. **An IDV template** in the [IDV Template Editor](https://dashboard.plaid.com/identity_verification/templates) with:
    - Data Source Verification enabled (and Identity Rules configured for match thresholds per field).
    - Document Verification enabled (with allowed countries and document types under Assign Countries → Physical Document Collection Options).
    - Selfie Check enabled (under the Workflow tab).
    - Optional: AML Screening (Monitor) and Financial Account Matching toggles.
    - The template **must be published**; verification settings are bound to the published version.
    - Save the `template_id`.
4. **Webhook receiver endpoints** configured in the [Dashboard Webhook page](https://dashboard.plaid.com/developers/webhooks). IDV webhook URLs are configured at the dashboard level — IDV ignores any `webhook` field passed to `/link/token/create`. Layer webhooks can be configured either in the Layer template or via the `webhook` param on `/session/token/create` (the API value wins if both are set).
5. **Mobile permissions** if the client is iOS/Android:
    - iOS: add `NSCameraUsageDescription` to Info.plist (iOS will crash the app during IDV if missing).
    - Android: add `CAMERA`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, and `WRITE_EXTERNAL_STORAGE` (max SDK 28 only) to `AndroidManifest.xml`. Missing these will crash the app during IDV.
6. **Minimum SDK versions for Layer** (June 2024 or later):
    - iOS ≥ 6.0.4, Android ≥ 4.5.0, React Native ≥ 11.11.0, React ≥ 3.5.2.
    - For Extended Autofill: iOS ≥ 6.3.1, Android ≥ 5.3.0, React Native ≥ 12.4.0, React ≥ 4.1.1.
    - Web JS SDK is auto‑updated by Plaid.

---

## End‑to‑end flow (the single source of truth diagram)

```
[1] User enters phone number in your app
        |
        v
[2] Backend: POST /session/token/create
    body: { user: { client_user_id }, template_id: LAYER_TEMPLATE_ID, redirect_uri or android_package_name }
        |
        v
[3] Client: Plaid.create({ token: link_token, onSuccess, onExit, onEvent })   <-- create handler EARLY
        |
        v
[4] Client: handler.submit({ phone_number: "+1NPANXXXXXX" })
        |
        v
[5] onEvent fires with one of:
    LAYER_READY                  -> handler.open()  (proceed to step 6)
    LAYER_NOT_AVAILABLE          -> (optional) handler.submit({ date_of_birth: "YYYY-MM-DD" })
                                    -> LAYER_READY (Extended Autofill) or LAYER_AUTOFILL_NOT_AVAILABLE
    LAYER_AUTOFILL_NOT_AVAILABLE -> discard handler; go to non-Layer branch (step 10)
        |
        v
[6] User completes Layer in Link: consent, verify phone (OTP/SNA), confirm/edit profile, pick bank account
        |
        v
[7] Backend receives LAYER_AUTHENTICATION_PASSED webhook (skip your own OTP)
    Client receives onSuccess with public_token
    Backend receives SESSION_FINISHED webhook with public_tokens[]
        |
        v
[8] Backend: POST /user_account/session/get
    body: { public_token }
    Returns: identity { name, address, phone_number, date_of_birth, ssn, ssn_last_4 },
             items[] (item_id + access_token), identity_edit_history
        |
        v
[9] Persist identity + access_tokens; KEEP THE SAME client_user_id for the IDV step
        |
        v---- (Layer ineligible branch joins here too -- skip step 9 prefill if no Layer data) ----
        |
[10] Backend: POST /link/token/create   (this is a NEW Link session, separate from Layer)
     body: {
       user: {
         client_user_id: SAME_AS_LAYER,
         email_address: <from Layer or your form>
       },
       products: ["identity_verification"],
       client_name, country_codes: ["US"], language: "en",
       identity_verification: { template_id: IDV_TEMPLATE_ID },
       (android_package_name OR redirect_uri),
       hosted_link or webhook fields are NOT used for IDV configuration
     }
     -- OR --
     Backend: POST /identity_verification/create FIRST with all known PII
     (name, address, phone_number, date_of_birth, id_number, email_address) and
     client_user_id, then call /link/token/create with the IDV template_id.
     Pre-populated fields will be SKIPPED in the IDV Link UI.
        |
        v
[11] Client: open a SECOND Plaid Link instance with the new link_token
     User completes:
       - Consent / Terms of Service
       - KYC (Data Source) step  -> kycCheck view
       - Document upload         -> documentaryVerification view (QR handoff to mobile if on desktop)
       - Selfie / liveness       -> selfie view
       - Risk + (optional) AML/Monitor screening
        |
        v
[12] Client onSuccess fires (this only means the user SUBMITTED; it does NOT mean PASS).
     No public_token is returned for IDV (it is null).
     Capture the metadata.link_session_id -> use as identity_verification_id.
        |
        v
[13] Backend receives STATUS_UPDATED webhook when the session reaches a terminal state.
     Backend: POST /identity_verification/get with identity_verification_id
     -> inspect status, steps.kyc_check, steps.documentary_verification, steps.selfie_check,
        steps.risk_check, and (if Monitor enabled) watchlist_screening_id.
```

---

## Step‑by‑step implementation

### Step 1 — Initialize the Plaid server SDK

Configure once at server boot. Example (Node):

```js
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const configuration = new Configuration({
  basePath: PlaidEnvironments.sandbox, // or .production
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const client = new PlaidApi(configuration);
```

### Step 2 — Create a Layer session token

Endpoint: `POST /session/token/create` (this is the **Layer‑specific** endpoint; do NOT use `/link/token/create` for Layer).

Required fields:
- `template_id` — the Layer template ID from the Dashboard.
- `user.client_user_id` — your internal user identifier (no PII). REQUIRED unless you pass a root‑level `user_id` from `/user/create` (only needed if combining with Plaid Check).

Optional but commonly used:
- `redirect_uri` — required for iOS/web OAuth; HTTPS in Production; must be added to Allowed redirect URIs in the developer dashboard. Leave blank on Android.
- `android_package_name` — required on Android instead of `redirect_uri`; must match `applicationId` and be allow‑listed in the developer dashboard.
- `webhook` — only set this if you need a different webhook URL than the one configured on the Layer template.

```js
// POST /api/create_layer_session_token
app.post('/api/create_layer_session_token', async (req, res) => {
  const clientUserId = req.user.id; // your internal ID, NOT PII

  const sessionTokenRequest = {
    user: { client_user_id: clientUserId },
    template_id: process.env.LAYER_TEMPLATE_ID,
    // android_package_name: 'com.yourcompany.app', // Android only
    // redirect_uri: 'https://yourapp.com/oauth-return', // iOS/web OAuth only
  };

  try {
    const r = await client.sessionTokenCreate(sessionTokenRequest);
    // r.data.link.link_token, r.data.link.expiration
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});
```

Response shape:
```json
{
  "link": {
    "link_token": "link-sandbox-af1a0311-da53-4636-b754-dd15cc058176",
    "expiration": "2026-05-29T16:00:00Z"
  },
  "request_id": "XQVgFigpGHXkb0b"
}
```

### Step 3 — Initialize the Link SDK and run the eligibility check

You must create the Link handler **as early as possible** so the SDK can preload in the background — this is what makes the "15‑second" Layer experience possible. For existing Android/React Native integrations created before June 2024, you must migrate from `OpenPlaidLink` / `PlaidLink` to `FastOpenPlaidLink` / the `create` + `open` pattern; otherwise Layer will not preload.

Web (vanilla JS) example showing the **Layer eligibility branching**:

```js
// As soon as the screen that will ask for the phone number renders:
const handler = Plaid.create({
  token: layerLinkToken,              // from POST /api/create_layer_session_token
  onSuccess: (publicToken, metadata) => {
    // Send publicToken to your backend; backend calls /user_account/session/get
    fetch('/api/layer/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_token: publicToken }),
    });
  },
  onExit: (err, metadata) => { /* handle exit / log */ },
  onEvent: (eventName, metadata) => {
    switch (eventName) {
      case 'LAYER_READY':
        // User is in the Plaid Network and meets template eligibility
        handler.open();
        break;
      case 'LAYER_NOT_AVAILABLE':
        // Phone alone did not match. Optionally try Extended Autofill with DOB.
        // (Only if your template tolerates Optional bank accounts.)
        promptForDateOfBirth().then(dob =>
          handler.submit({ date_of_birth: dob }) // e.g. "1975-01-18"
        );
        break;
      case 'LAYER_AUTOFILL_NOT_AVAILABLE':
        // Neither phone nor phone+DOB found a match.
        // Discard this handler and fall back to your non-Layer flow.
        fallbackToNonLayerFlow();
        break;
    }
  },
});

// When the user submits their phone number:
function onPhoneSubmit(phoneNumberE164) {
  // E.164 with +1; non-+1 will always return LAYER_NOT_AVAILABLE
  handler.submit({ phone_number: phoneNumberE164 });
}
```

Event semantics you must know:
- `LAYER_READY` — eligible; call `handler.open()` immediately to launch the Layer UI.
- `LAYER_NOT_AVAILABLE` — phone alone insufficient. If you implemented Extended Autofill, submit DOB as a second `handler.submit({ date_of_birth })` call (must be a separate call, after the phone_number call). Result: `LAYER_READY` (autofill works) or `LAYER_AUTOFILL_NOT_AVAILABLE`.
- `LAYER_AUTOFILL_NOT_AVAILABLE` — give up on Layer for this user; proceed to IDV directly.

Other Layer events to log for analytics: `OPEN`, `TRANSITION_VIEW: CONSENT`, `TRANSITION_VIEW: VERIFY_PHONE`, `TRANSITION_VIEW: PROFILE_DATA_REVIEW`, `SUBMIT_OTP`, `VERIFY_PHONE`, `HANDOFF`, `ERROR: INVALID_OTP`, `ERROR: PROFILE_AUTHENTICATION_FAILED`.

### Step 4 — Handle Layer webhooks server‑side

Two webhooks fire for Layer:

- `LAYER_AUTHENTICATION_PASSED` — phone ownership verified (via OTP or SNA). Receiving this means you may skip any of your own OTP verification, even if the user later abandons the flow. Always implement webhook signature verification before relying on it, to avoid spoofing.
- `SESSION_FINISHED` — the Link session reached a terminal state. Contains `status` (`SUCCESS` or `EXITED`), `link_session_id`, `link_token`, and `public_tokens[]` if successful. Note: `SESSION_FINISHED` for Layer is enabled by default; for non‑Layer Link sessions it is opt‑in.

```js
// Express handler — verify signature, then route by webhook_code
app.post('/webhooks/plaid', verifyPlaidWebhook, async (req, res) => {
  const { webhook_type, webhook_code } = req.body;
  if (webhook_type === 'LAYER' && webhook_code === 'LAYER_AUTHENTICATION_PASSED') {
    // mark the user's phone as verified
  }
  if (webhook_type === 'LINK' && webhook_code === 'SESSION_FINISHED') {
    // optional: cross-reference link_session_id with the user
  }
  res.sendStatus(200);
});
```

### Step 5 — Exchange the public_token for the user's Layer profile

Endpoint: `POST /user_account/session/get`. Required field: `public_token`. Unlike normal Link, you do NOT call `/item/public_token/exchange` — `/user_account/session/get` returns identity AND the access tokens for any linked Items in a single call.

```js
app.post('/api/layer/complete', async (req, res) => {
  const r = await client.userAccountSessionGet({ public_token: req.body.public_token });
  // r.data.identity.{ name:{first_name,last_name}, address, phone_number, email, date_of_birth, ssn, ssn_last_4 }
  // r.data.items[]  -> { item_id, access_token } per linked bank Item
  // r.data.identity_edit_history -> per-field edit counts
  await saveLayerProfile(req.user.id, r.data);
  res.json({ ok: true });
});
```

Important: treat every field in `identity` as **user‑submitted and unverified**. The end user can edit any prefilled value in the Layer UI before sharing it. Inspect `identity_edit_history` for high edit counts as a fraud signal. To verify the data, proceed to IDV (next step).

### Step 6 — Create the IDV Link token (the verification session)

This is a separate Link token from the Layer session. Required fields for `POST /link/token/create`:

- `client_name`
- `country_codes` (e.g. `["US"]`)
- `language` — note: IDV ignores this and auto‑detects from browser; pass it for API validity only.
- `user.client_user_id` — **must equal the Layer `client_user_id`** to chain the sessions.
- `user.email_address` — optional but strongly recommended; enables email risk analysis.
- `products: ["identity_verification"]` — IDV is mutually exclusive with all other Plaid products on this token.
- `identity_verification: { template_id: IDV_TEMPLATE_ID }`
- `android_package_name` (Android) or `redirect_uri` (iOS/web OAuth) — same rules as Layer.

You have two ways to prefill IDV with the data Layer just returned:

**Option A (recommended): prefill via `/identity_verification/create` before Link**

Call `POST /identity_verification/create` first, passing all the PII you already have (from Layer's `/user_account/session/get` response). Any pre‑provided fields will be skipped (not shown) in the Link UI, and the user cannot override them. Then create the Link token with the IDV template.

```js
// 1) Pre-populate
await client.identityVerificationCreate({
  client_user_id: clientUserId,                  // same as Layer
  template_id: process.env.IDV_TEMPLATE_ID,
  gave_consent: false,                            // gating on accept_tos step in Link
  is_shareable: false,
  user: {
    email_address: layer.identity.email || formEmail,
    phone_number:  layer.identity.phone_number,           // E.164
    date_of_birth: layer.identity.date_of_birth,          // YYYY-MM-DD
    name: {
      given_name:  layer.identity.name.first_name,
      family_name: layer.identity.name.last_name,
    },
    address: {
      street:       layer.identity.address.street,
      city:         layer.identity.address.city,
      region:       layer.identity.address.region,
      postal_code:  layer.identity.address.postal_code,
      country:      layer.identity.address.country,        // ISO 3166-1 alpha-2
    },
    id_number: layer.identity.ssn ? {
      type: 'us_ssn',
      value: layer.identity.ssn,
    } : (layer.identity.ssn_last_4 ? {
      type: 'us_ssn_last_4',
      value: layer.identity.ssn_last_4,
    } : undefined),
  },
});

// 2) Create the IDV link token
const ltc = await client.linkTokenCreate({
  client_name: 'YourApp',
  language: 'en',
  country_codes: ['US'],
  user: { client_user_id: clientUserId, email_address: emailForRisk },
  products: ['identity_verification'],
  identity_verification: { template_id: process.env.IDV_TEMPLATE_ID },
  // android_package_name: 'com.yourcompany.app',
  // redirect_uri: 'https://yourapp.com/oauth-return',
});
// ltc.data.link_token -> hand to client
```

**Option B: prefill directly via `/link/token/create`**

You can pass the same identity fields under the top‑level `user` object on `/link/token/create` (e.g. `user.phone_number`, `user.date_of_birth`, `user.legal_name`, `user.address`, `user.email_address`, `user.id_number`) instead of calling `/identity_verification/create` first. If you do BOTH, the data from `/identity_verification/create` wins and any `/link/token/create` user fields for the same `client_user_id` are ignored.

Note on duplicate detection: IDV deduplicates sessions by `client_user_id`. If the user has already completed an IDV session for this template (passed or failed), reopening Link returns them to that session unless you (a) call `/identity_verification/retry` with a strategy (e.g. `reset` or `incomplete`) or (b) approve a retry from the Dashboard.

### Step 7 — Launch the IDV Link session on the client

This is a normal `Plaid.create` / `open` flow with the new `link_token`:

```js
const idvHandler = Plaid.create({
  token: idvLinkToken,
  onSuccess: (publicToken, metadata) => {
    // For IDV, publicToken is null. The thing to capture is:
    //   metadata.link_session_id  -> use as identity_verification_id
    fetch('/api/idv/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity_verification_id: metadata.link_session_id }),
    });
  },
  onExit: (err, metadata) => { /* handle */ },
  onEvent: (eventName, metadata) => {
    // Stable events: IDENTITY_VERIFICATION_PASS_SESSION,
    //                IDENTITY_VERIFICATION_FAIL_SESSION,
    //                IDENTITY_VERIFICATION_OPEN_UI, etc.
    // Step views: kycCheck, documentaryVerification, selfie,
    //             riskCheck, watchlistScreening, smsVerification, acceptTOS
  },
});
idvHandler.open();
```

`onSuccess` for IDV means the user **submitted** the flow, not that they passed. Pass/fail is determined server‑side and must be retrieved via `/identity_verification/get` after the `STATUS_UPDATED` webhook.

### Step 8 — Handle IDV webhooks and retrieve the verdict

Configure these in the [Dashboard webhook page](https://dashboard.plaid.com/developers/webhooks) — IDV ignores any `webhook` field passed to `/link/token/create`.

The three IDV webhook codes:
- `STEP_UPDATED` — user moved between steps (kyc, documentary, selfie, risk, watchlist, etc.).
- `STATUS_UPDATED` — terminal state reached.
- `RETRIED` — a retry was issued.

Webhooks are NOT guaranteed to arrive in order. To handle out‑of‑order delivery, always look up the latest state via `/identity_verification/list` (by `client_user_id` + `template_id`) or `/identity_verification/get` (by `identity_verification_id`) instead of trusting the webhook order.

```js
app.post('/webhooks/plaid', verifyPlaidWebhook, async (req, res) => {
  if (req.body.webhook_type === 'IDENTITY_VERIFICATION' &&
      req.body.webhook_code === 'STATUS_UPDATED') {
    const idvId = req.body.identity_verification_id;
    const verdict = await client.identityVerificationGet({ identity_verification_id: idvId });
    // verdict.data.status -> active | success | failed | expired | canceled | pending_review
    // verdict.data.steps.{ accept_tos, verify_sms, kyc_check, documentary_verification,
    //                      selfie_check, risk_check, watchlist_screening }
    // verdict.data.kyc_check -> per-field match results (name, dob, address, phone, id_number)
    // verdict.data.documentary_verification -> document analysis + extracted fields
    // verdict.data.selfie_check -> liveness + face match results
    // verdict.data.watchlist_screening_id -> for Monitor lookup
    await persistIdvResult(verdict.data);
  }
  res.sendStatus(200);
});
```

---

## Eligibility check: Layer experience vs. non‑Layer fallback

This is the most commonly mis‑implemented part of the integration. The decision tree:

| Scenario | Event sequence | Action |
|---|---|---|
| US phone in Plaid Network, meets template eligibility | `LAYER_READY` after `handler.submit({ phone_number })` | Call `handler.open()`. Run full Layer flow. On `onSuccess`, call `/user_account/session/get`, then proceed (e.g. to IDV) with prefill. |
| US phone, partial profile match via Extended Autofill | `LAYER_NOT_AVAILABLE` → submit DOB → `LAYER_READY` | Call `handler.open()`. Same as above; expect a profile with no linked bank Items more often. |
| Non‑US phone, or phone not in Plaid Network at all | `LAYER_NOT_AVAILABLE` → submit DOB → `LAYER_AUTOFILL_NOT_AVAILABLE` (or single `LAYER_NOT_AVAILABLE` if you skip DOB) | Discard the Layer handler. Skip Layer. **Route to the storyboard's use-case-specific manual fallback.** |

**Non‑Layer (fallback) branch — the fallback is use-case specific:**

The phone entry decides eligibility, and eligibility decides the experience. When ineligible
(`LAYER_AUTOFILL_NOT_AVAILABLE`), route to whatever manual onboarding the storyboard outlines — it is
**not always IDV**. The three canonical fallbacks:

1. **Link a bank account through real Plaid Link** — create a regular (non-Layer) `/link/token/create`
   token and launch standard Link. Include the user's `phone_number` in the `user` object so Plaid
   fast-tracks OTP.
2. **Launch an Identity Verification session** — proceed to **Step 6** (create IDV Link token) with
   whatever PII you've collected; the IDV Link UI collects anything you didn't prefill.
3. **A generic (non-Plaid) PII entry screen** — a plain signup form with no Plaid call at all, when
   the use case's manual path doesn't involve Plaid.

In the generated app, the `LAYER_AUTOFILL_NOT_AVAILABLE` branch does
`handler.destroy()` then `window.goToStep('<manual-fallback-step-id>')` — the demo-script designates
which step that is. Common rules for the fallback branch:
- Do NOT call `/session/token/create` again, and do NOT call `/user_account/session/get` (there is no
  Layer public_token).
- Reuse the same `client_user_id` you would have used for Layer, so any downstream session (IDV, Link)
  is properly attributed.

**Critical eligibility caveats:**
- A `+44` (UK) or any non‑`+1` phone number will always return `LAYER_NOT_AVAILABLE`. Branch your UI accordingly.
- `LAYER_READY` only fires after a `handler.submit({ phone_number })` — it never fires automatically.
- Do **not** prompt the user for DOB upfront; only prompt after `LAYER_NOT_AVAILABLE` to keep the eligible‑user experience fast.
- Billing for Layer is only incurred on `onSuccess` (a converted Link session). Eligibility checks and abandoned sessions are not billed. IDV billing is per‑attempt with separate fees for Data Source, Document, and Selfie checks.

---

## Sandbox testing

> Pipeline note: sandbox creds + the IDV persona are mirrored in
> [`inputs/plaid-link-sandbox.md`](../../../inputs/plaid-link-sandbox.md); the Layer phone list also
> appears (shorter) in [`inputs/products/plaid-layer.md`](../../../inputs/products/plaid-layer.md). If
> they ever drift, the product KB + sandbox doc are canonical.

**Layer sandbox phone numbers** (OTP code is always `123456`):

| Phone | Profile |
|---|---|
| 415-555-0000 | No identity data, no bank |
| 415-555-0011 | Default; full PII + 2 banks |
| 415-555-0012 | Missing PII, 3 banks |
| 415-555-0015 | Full PII + 1 bank |
| 515-555-0013 | Missing email |
| 515-555-0015 | Missing DOB |
| 515-555-0016 | Missing SSN |
| 515-555-0017 | Missing address |
| 515-555-0018 | Missing name |
| 515-555-0019 | Standard profile, savings only |

Extended Autofill DOB to use: `1975-01-18`.

**Routing by phone (which branch the demo takes):** `415-555-0011` (default) is the **eligible**
happy path (`LAYER_READY` → Layer prefill). `415-555-0000` (no identity, no bank) drives the
**ineligible** path (`LAYER_NOT_AVAILABLE` → DOB retry → `LAYER_AUTOFILL_NOT_AVAILABLE`), which routes
to the storyboard's use-case-specific manual fallback (Plaid Link / IDV / generic PII entry). The
`515-555-00xx` partial-profile numbers exercise Extended-Autofill paths (missing email/DOB/SSN/etc.).
To demo the fallback, prefill an ineligible number; to demo the happy path, prefill `415-555-0011`.

**IDV sandbox behavior** (Leslie Knope is the canonical test user):
- The only base identity that passes Data Source by default is Leslie Knope (configurable additional sample identities via the Dashboard Sample Identities page).
- Document checks: every uploaded document is interpreted as genuine and as matching Leslie Knope. The document step passes only when the user‑provided name + DOB match Leslie Knope's. Users get 3 attempts before the step fails.
- Selfie checks **do not run in Sandbox** even if enabled in the template. Plan to test selfie behavior end‑to‑end in Production with internal users.
- To force outcomes, manipulate `Acceptable Risk Level` for `Network Risk` and `Device Risk` in the template editor (set Low to force fail; reset before going live).

To test the joint flow:
1. Create a Layer session with phone `415-555-0011`, OTP `123456`.
2. Confirm `/user_account/session/get` returns Leslie Knope.
3. Create an IDV Link token with the same `client_user_id`, prefilled with Leslie Knope's data.
4. Upload any image as the document; the data source + document checks should pass.
5. Verify `STATUS_UPDATED` arrives and `/identity_verification/get` returns `status: success`.

---

## Common pitfalls (read before generating code)

1. **Using `/link/token/create` for Layer.** Wrong. Use `/session/token/create` for Layer. `/link/token/create` is for IDV (and everything else).
2. **Putting other products alongside `identity_verification`.** IDV is mutually exclusive. Do not combine it with `auth`, `transactions`, `identity`, etc. on the same Link token.
3. **Setting `webhook` on `/link/token/create` for IDV.** IDV ignores it. Configure IDV webhooks in the Dashboard.
4. **Treating Layer's identity as verified.** It is consumer‑permissioned, editable, and unverified. Always run IDV (or Identity Match for bank ownership) to KYC.
5. **Using different `client_user_id` values for Layer and IDV.** This breaks Financial Account Matching, dashboard search, and IDV dedupe. Always reuse the same `client_user_id`.
6. **Using PII in `client_user_id`.** Disallowed. Use your internal opaque ID.
7. **Forgetting `android_package_name` on Android (or `redirect_uri` on iOS/web).** Token will work but Link will fail to launch on the missing platform.
8. **Missing camera permissions in the mobile manifests.** Crashes the app the moment IDV reaches the Document or Selfie step.
9. **Creating the Layer handler too late.** Layer relies on background preload for the 15‑second experience. Call `Plaid.create(...)` as soon as the screen renders, not after the user taps a button.
10. **Existing Android/RN integrations using `OpenPlaidLink` or `PlaidLink`.** Migrate to `FastOpenPlaidLink` (Android) or `create` + `open` (React Native). Old patterns won't preload Layer.
11. **Trying to use Layer with Hosted Link or mobile webviews.** Unsupported.
12. **Relying on `onSuccess` for IDV pass/fail.** `onSuccess` only means submitted. Always wait for `STATUS_UPDATED` and call `/identity_verification/get`.
13. **Trusting webhook ordering.** IDV webhooks can arrive out of order. Re‑query state via the API.
14. **Skipping webhook signature verification.** Layer's `LAYER_AUTHENTICATION_PASSED` is what lets you skip your own OTP — if spoofed, you bypass your own anti‑fraud.

---

## Reference: API endpoints used in this skill

| Purpose | Endpoint | Notes |
|---|---|---|
| Create Layer Link token | `POST /session/token/create` | Layer only. Requires `template_id` + `user.client_user_id`. |
| Exchange Layer public token for profile + Items | `POST /user_account/session/get` | Returns identity + items[] with access_tokens. No separate exchange call needed. |
| (Optional) Prefill IDV before Link | `POST /identity_verification/create` | Pre‑provided fields are skipped in the Link UI. |
| Create IDV Link token | `POST /link/token/create` | `products: ["identity_verification"]`, `identity_verification.template_id`. |
| Retrieve IDV result | `POST /identity_verification/get` | Use after `STATUS_UPDATED` webhook. Inspect `status`, `steps`, per‑check details. |
| List all IDV sessions for a user | `POST /identity_verification/list` | Useful for out‑of‑order webhook handling. |
| Issue an IDV retry | `POST /identity_verification/retry` | Required to give the same `client_user_id` another attempt after pass/fail. |
| (If Monitor enabled) AML watchlist result | `POST /watchlist_screening/individual/get` | Use `watchlist_screening_id` from the IDV result. |

## Reference: Webhooks used in this skill

| Type | Code | When it fires | Action |
|---|---|---|---|
| `LAYER` | `LAYER_AUTHENTICATION_PASSED` | Phone ownership verified | Skip your own OTP for this user. |
| `LINK` | `SESSION_FINISHED` | Layer Link session terminal | `status: SUCCESS` includes `public_tokens[]`. |
| `IDENTITY_VERIFICATION` | `STEP_UPDATED` | User moved between IDV steps | Optional analytics. |
| `IDENTITY_VERIFICATION` | `STATUS_UPDATED` | IDV session reached terminal state | Call `/identity_verification/get` and persist verdict. |
| `IDENTITY_VERIFICATION` | `RETRIED` | A retry was issued | Re‑poll status. |

## Reference: Source docs (Plaid)

- Layer overview: https://plaid.com/docs/layer/
- Add Layer to your app: https://plaid.com/docs/layer/add-to-app/
- Layer API: https://plaid.com/docs/api/products/layer/
- IDV overview: https://plaid.com/docs/identity-verification/
- IDV API: https://plaid.com/docs/api/products/identity-verification/
- IDV webhooks: https://plaid.com/docs/identity-verification/webhooks/
- IDV sandbox testing: https://plaid.com/docs/identity-verification/testing/
- Link iOS camera setup: https://plaid.com/docs/link/ios/#camera-support-identity-verification-only
- Link Android camera setup: https://plaid.com/docs/link/android/#enable-camera-support-identity-verification-only
- Layer Quickstart (sample app): https://github.com/plaid/layer-quickstart
- IDV Quickstart (sample app): https://github.com/plaid/idv-quickstart

## Related files
- Product KB (facts): [`inputs/products/plaid-layer.md`](../../../inputs/products/plaid-layer.md), [`inputs/products/plaid-identity-verification.md`](../../../inputs/products/plaid-identity-verification.md)
- Demo-app build contract (real-SDK launch step, panels): [`plaid-demo-app-build`](../plaid-demo-app-build/SKILL.md)
- Layer value-prop / pitch: [`skills/plaid-layer-value-prop-and-pitch-skill.md`](../../../skills/plaid-layer-value-prop-and-pitch-skill.md)
- Sandbox creds + IDV persona: [`inputs/plaid-link-sandbox.md`](../../../inputs/plaid-link-sandbox.md)
