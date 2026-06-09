---
last_vp_research: "2026-06-08"
last_api_verified: "2026-06-08"
sources:
  - "AskBill plaid_docs MCP (2026-05-25) — confirms protect_linked_bank valid; /signal/evaluate does NOT return trust_index"
  - "AskBill ask_bill MCP (2026-06-08) — confirms TI score 1–100 higher=safer; protect_linked_bank confirmed in products[]; event taxonomy guidance"
  - "Glean: Plaid Protect (fka Verify) - 2025 Megadoc (doc/1f0hkGcjmiT93WEwgR7tGL2eZ2RkM8LViGD0V4Oy_nuk, accessed 2026-06-08)"
  - "Glean: Plaid Protect Testing and Integration Resources (doc/18AAjVw72AShXz2ndsxfbfxJ35Yml1BN4bTfXCJbG4XE, accessed 2026-06-08)"
  - "Glean: GTM Playbook: Plaid Protect (doc/1IXi9GK-GJ8ksJ5xvmxm2nqfJyjtXHhlBy_9_Y8I1xho, accessed 2026-06-08)"
  - "Glean: Plaid Protect Pitch Decks 2026 (slides/1yX1aWGywpDSPPvICfqrPQuZ1wmd5FUAxzcT4n1Z0vf0, accessed 2026-06-08)"
  - "Glean: Plaid Protect Deep Dive Session (slides/13y2CFmBb5x5SgK-fxYih8G_RJvW2hdbjZsKy8L0OYus, accessed 2026-06-08)"
  - "Glean: Protect Overview (Slite eng doc, accessed 2026-06-08)"
  - "Public: plaid.com/products/protect/ (marketing page, accessed 2026-06-08)"
  - "Ti2 launch blog (plaid.com/blog/plaid-protect-trust-index/)"
last_ai_update: "2026-06-08T00:00:00Z"
needs_review: true
last_auto_build_sections:
  - "Proof Points & ROI Metrics"
  - "Objections & Responses"
  - "Implementation Pitfalls"
  - "Where It Fits"
  - "Fraud Type Mapping"
  - "Onboarding Flow Placement"
  - "Accurate Terminology"
  - "Narration Talk Tracks"
---

# Plaid Protect

> **Product family key:** `plaid_protect`
> **Solution category:** Anti-fraud + identity risk-scoring umbrella
> **Status (June 2026):** **Limited Availability** for Trust Index / Ti2 (TI Full SKU only during LA); component products (Signal, IDV, Monitor) are GA on their own.
> **Sales engagement required** to enable Trust Index and Protect bundle pricing.

## What Plaid Protect is today

Plaid Protect is the **umbrella solution** that packages Signal, Identity Verification (IDV), Monitor, Trust Index (Ti / Ti2), and Dashboard rulesets. It is **NOT** a single API with a `protect` product string.

| Component | Role | GA status |
|---|---|---|
| **Plaid Trust Index (Ti / Ti2)** | ML fraud score at user/session events (device + identity + bank graph) | **Limited Availability** |
| **Plaid Signal** | Transaction-time ACH / funding risk (`/signal/evaluate`) | GA |
| **Plaid Identity Verification (IDV)** | KYC / document & biometric checks | GA |
| **Plaid Monitor** | Sanctions / watchlist / PEP | GA |
| **Rulesets** | Dashboard decisioning (`ACCEPT` / `REVIEW` / `REROUTE`) | GA (Signal path) |

**Confused with:**
- **Cash Advance Score** — EWA repayment risk via `/signal/evaluate` → family `cash_advance_score` ([`plaid-ewa-score.md`](plaid-ewa-score.md)). Not Trust Index.
- Plaid Verify (legacy internal name for Protect) — not a separate product.
- Plaid Beacon — consortium fraud network; Beacon is **one module inside Protect**, not the same thing.

---

## Fraud Type Mapping — first-party vs third-party

Understanding which fraud type Protect addresses is essential for building accurate demo narratives. **Protect's report types** (used in `/protect/report/create`) map directly to the fraud taxonomy: `first_party`, `stolen`, `synthetic`, `account_takeover`, `unknown`. Source: Glean Megadoc + Integration Resources, 2026-06-08.

### Third-party fraud (someone else impersonating the user)

The attacker is **not** the legitimate person — they are using stolen or fabricated identity to appear as a real user.

| Fraud type | Description | Protect signals that address it |
|---|---|---|
| **Stolen identity** | Real person's PII/credentials used without consent | Identity integrity + possession signals; IDV document + selfie + data-source match; Trust Index via identity subscores |
| **Synthetic identity** | Fabricated identity combining real + fake data | Cross-user PII mismatch across Plaid network; device velocity; bank account ownership mismatches; IDV anomaly signals |
| **Account takeover (ATO)** | Legitimate account hijacked after signup | Device fingerprint change; login pattern anomalies; Protect SDK session signals; Trust Index at re-auth events |
| **Bot / coordinated fraud** | Automated or scripted account creation | Device + IP signals pre-PII (via Protect SDK `app_visit`); velocity and network signals; device_and_connection subscore |

**Demo framing:** Third-party fraud is most visible at the **sign-up and identity verification** funnel stages — before the bank is linked. Trust Index at these stages uses device + identity subscores.

### First-party fraud (the real user is the fraud)

The applicant is the legitimate owner of the identity but is acting deceptively — lying, misrepresenting, or intending to default or exploit.

| Fraud type | Description | Protect signals that address it |
|---|---|---|
| **Bust-out fraud** | User builds credit/limits then defaults intentionally | Bank account history; transaction graph behavior; cross-network account patterns |
| **Default-never-pay** | User has no intent to repay at application time | Bank account insights (account age, balance behavior, linked-account graph); TI Full at bank link |
| **Dispute abuse / friendly fraud** | Legitimate user disputes valid charges | Transaction history and network behavior signals; bank account insights subscore |
| **Misrepresentation at onboarding** | User provides false income, employment, or intent | TI Full attributes (10,000+ data points); identity possession signals confirm the person but Trust Index scores behavioral risk |
| **Fraud ring participation** | User is part of an organized abuse network, but using own identity | Cross-app and cross-account network graph signals; Plaid network subscore; velocity across linked accounts |

**Demo framing:** First-party fraud is hardest for traditional fraud tools to catch — the identity checks pass. Protect's differentiation is specifically strong here: approved stats show **40% of first-party fraud caught at 5% step-up** (public lender retro). Bank linking (TI Full) provides the most predictive signal for first-party fraud because it reveals *how* an account actually behaves across the network.

### Protect vs Signal for fraud types

| Fraud type | Protect Trust Index | Plaid Signal (`/signal/evaluate`) |
|---|---|---|
| First-party fraud at onboarding | **Yes — primary use case** | No (Signal is transaction-time only) |
| Third-party fraud / ATO / synthetic | **Yes** | No |
| ACH return risk (NSF, closed account) | No | **Yes — primary use case** |
| Transaction-time payment fraud | Limited | **Yes** |
| Ongoing account monitoring | Via Monitor component | No |

**Key rule for demos:** Do NOT use Signal to narrate first-party fraud stories. Do NOT use Trust Index to narrate ACH return risk. They are orthogonal.

---

## Onboarding Flow Placement

### The three-stage Protect funnel

Protect can fire at up to three points in a user's onboarding journey, with increasing signal depth at each stage. Source: Pitch Decks 2026 + GTM Playbook (Glean, 2026-06-08).

| Stage | Trigger | SKU | Attributes available | Fraud signals strongest for |
|---|---|---|---|---|
| **1. Sign-up page / pre-PII** | User lands on app / hits "Sign Up" | TI Score (Device) [beta] | ~3,000 | ATO, bot, coordinated fraud, fraud rings |
| **2. Identity verification** | User submits name/DOB/address/phone/email | TI Score (Identity) [beta] | ~7,000 | Synthetic identity, stolen identity, identity possession |
| **3. Bank linking** | Plaid Link completes (`LINK_SESSION_END`) | **TI Full [LA — current default]** | **10,000+** | First-party fraud, bust-out, all of the above |

> **Demo default:** During LA, only **TI Full** is commercially available. Standard Protect demos use bank-link as the primary Trust Index entry point. Device and Identity SKUs are beta / not yet part of standard demos unless the prompt explicitly calls for top-of-funnel scoring.

### Event-driven model for onboarding demos

Protect is **event-driven and passive** — the host app sends lifecycle events to Plaid; Plaid enriches them and returns Trust Index. There is no separate `plaidPhase: "launch"` modal for Protect itself. It rides alongside (or after) Plaid Link.

**Backend event sequence for a standard onboarding + bank-link flow:**

```
1. [Frontend] Load Protect SDK → protect.track({ type: 'app_visit' })
   → anonymous device fingerprint captured before PII
   → SDK generates protect_sdk_session_id

2. [Backend] POST /user/create
   → returns user_id (plaid-user-xxxx)
   → store alongside client_user_id for the rest of the journey

3. [Backend] POST /link/token/create
   → products: ['protect_linked_bank']  ← key product string
   → user: { client_user_id: '...' }

4. [Frontend] Plaid Link opens → user authenticates bank
   → plaidPhase: "launch" (single real SDK modal)
   → onSuccess returns { public_token, metadata: { link_session_id } }

5. [Backend] POST /item/public_token/exchange
   → returns access_token

6. [Backend] POST /protect/event/send  ← HERO API call for demo
   → event: { user_sign_up: { ... } }   ← or user_sign_in for returning users
   → user: { client_user_id, user_id }
   → protect_sdk_session_id  (ties frontend device session to this user)
   → request_trust_index: true           ← sync TI, ~1–5s wait

   Response → trust_index: { score: 87, model: 'ti-link-session-2.0', subscores: { ... } }

7. [Backend] POST /protect/user/insights/get  ← optional re-fetch / step-up check
   → user: { client_user_id, user_id }
   → returns latest_scored_event with same trust_index shape
```

**Alternative read path after Link:** `POST /link/token/get` → `link_sessions[].results.protect_results` also contains the Trust Index score and fraud_attributes if TI was computed at Link handoff. Source: Glean Integration Resources + Megadoc.

### `POST /protect/event/send` — request-side event objects

The `event` field in the request takes exactly **one** of these event objects (lowercase snake_case, not uppercase). Source: Glean Megadoc, Integration Resources.

| Event object | When to send | Notes |
|---|---|---|
| `app_visit` | User visits app or sign-up page (anonymous) | Pre-PII; ties device session. Use with Protect SDK `protect_sdk_session_id`. |
| `user_sign_up` | User completes account registration | **Required** to associate anonymous SDK session with the new user. |
| `user_sign_in` | Returning user logs in | **Required** to associate anonymous SDK session with existing user on re-auth. |
| `password_change_request_event` | Before granting permission to change password | Step-up risk check. |
| `password_change_event` | After password change completes | Record the event for audit + re-score. |

> **`LINK_SESSION_END` is the returned `event_type` string** (in `/protect/event/get`, `/protect/user/insights/get`, and webhook payloads) — it is **not** a request-side event object you send via `/protect/event/send`. The Link session event is ingested automatically by Plaid when the `protect_linked_bank` product is in the Link token.

### How Protect composes with IDV and Signal in onboarding

```
[Pre-PII]          Protect SDK app_visit → device fingerprint
[Identity Stage]   Optional: IDV (identity_verification in products[]) → KYC verification
                   Optional: /protect/event/send { user_sign_up } → TI Score (Identity) [beta]
[Bank Link]        Link with products: ['protect_linked_bank'] → TI Full at LINK_SESSION_END
                   /protect/event/send with request_trust_index: true → Trust Index score
[Post-Link]        Trust Index score → host decisioning:
                     ≥ 80 → approve / low-friction path
                     50–79 → step-up (SMS, doc, selfie, manual review)
                     < 50 → step-up or restrict
                   Optional: /signal/evaluate → ACH return risk (separate beat, separate panel)
[Ongoing]          Monitor component → sanctions/watchlist/PEP (ongoing)
                   /protect/report/create → submit confirmed fraud feedback
```

### Demo UI guidance for Protect in onboarding demos

**Protect is a background/backend signal — it never gets its own consumer-facing modal.** Trust Index and fraud attributes are for the **operator/underwriter view**, not the end-user screen.

| What to show | Where |
|---|---|
| Trust Index score (e.g. 87) + model name | API panel JSON response + "Underwriter Internal" slide |
| Subscore breakdown (device_and_connection, bank_account_insights) | API panel expanded view |
| Fraud attributes (e.g. `session.ip.is_vpn: true`) | API panel JSON, clearly labeled as internal |
| Host decisioning (Approved / Step-Up) | Host app UI — result of Trust Index threshold logic |
| `protect_sdk_session_id` tie-in | Narration / slide, not raw on consumer screen |

**Never show:** Trust Index score directly on the consumer onboarding screen as if it's user-facing. Never label Signal `ruleset.result: ACCEPT` as the Trust Index outcome. Never show `fraud_attributes` as something the end-user sees.

---

## Trust Index — initialization & API (canonical for `plaid_protect` demos)

Trust Index is **not** retrieved via `/signal/evaluate`. AskBill and internal Protect docs agree: Signal returns `scores.*` + `ruleset`; **only Protect APIs return `trust_index`**.

### Initialization sequence (typical bank-link / onboarding funnel)

1. **`POST /user/create`** (when using Plaid User APIs) — establish `user_id` (`usr_…` / `plaid-user-…`) and pass `client_user_id` through the journey. Required for ongoing `/protect/user/insights/get` and event association (Glean: Protect Megadoc canonical journey).
2. **Optional early funnel:** Protect Web SDK (Pixel) → `protect.track({ type: 'app_visit' })` → generates `protect_sdk_session_id` for **device-class signals** (pre-PII).
3. **`POST /link/token/create`** with **`products: ['protect_linked_bank']`** (US-only). Add `'identity_verification'` only when IDV is a featured beat. **Do not add `'signal'`** unless the demo explicitly shows **transaction-time Signal** as a separate API call (see Signal component section below).
4. **Plaid Link** — single `plaidPhase: "launch"`; real SDK modal.
5. **After Link `onSuccess`** — score Trust Index:
   - **Primary:** `POST /protect/event/send` with `event: { user_sign_up: { ... } }`, `user_id`, `client_user_id`, `protect_sdk_session_id`, and **`request_trust_index: true`** for synchronous scoring (or `false` + `PROTECT_USER_EVENT` webhook when async).
   - **Alternate read paths:** `POST /protect/user/insights/get` for latest user-level TI + attributes; `POST /link/token/get` → `link_sessions[].results.protect_results` when TI was computed at Link handoff.

### `POST /protect/event/send` — Trust Index score retrieval

**Purpose:** Ingest a lifecycle event and optionally compute/return Trust Index for that event.

**Request (happy-path bank link — documented pattern from Glean Protect Megadoc / Integration Resources):**

```json
{
  "client_id": "...",
  "secret": "...",
  "event": {
    "user_sign_up": {}
  },
  "timestamp": "2026-05-22T03:26:02Z",
  "protect_sdk_session_id": "ptsdk_123",
  "request_trust_index": true,
  "user": {
    "client_user_id": "tilt-user-maya-chen-7421",
    "user_id": "plaid-user-6009db6e"
  }
}
```

| Field | Notes |
|-------|--------|
| `event` | **Exactly one** event object: `app_visit`, `user_sign_up`, `user_sign_in`, `password_change_request_event`, `password_change_event` |
| `protect_sdk_session_id` | From Protect Web SDK — ties device fingerprint to this user. Optional but increases score quality. |
| `user.client_user_id` | Host's stable user id |
| `user.user_id` | From `/user/create` |
| `request_trust_index` | **`true`** = sync wait for TI (~1–5s); **`false`** = async; score via `PROTECT_USER_EVENT` webhook |

**Response (canonical event object — Megadoc + Integration Resources):**

```json
{
  "user_id": "plaid-user-6009db6e",
  "event_id": "protect-event-2be8498f",
  "event": {
    "event_id": "protect-event-2be8498f",
    "timestamp": "2026-05-22T03:26:02Z",
    "event_type": "LINK_SESSION_END",
    "trust_index": {
      "score": 87,
      "model": "ti-link-session-2.0",
      "subscores": {
        "device_and_connection": { "score": 92 },
        "bank_account_insights": { "score": 78 }
      }
    },
    "fraud_attributes": {
      "session.ip.is_vpn": false,
      "user.linked_bank_accounts.num_owner_full_names": 1,
      "idv_id_doc_passed": true
    }
  },
  "request_id": "saKrIBuEB9qJZng"
}
```

- **`trust_index.score`:** **1–100, higher = SAFER** (higher = more trustworthy / lower fraud risk). This is the **opposite direction** from Signal (1–99, higher = higher ACH return risk).
- **`trust_index.model`:** e.g. `ti-link-session-2.0`, `ti-pro-1.0` — customer/event mapped.
- **`trust_index.subscores`:** Documented subscore objects include `device_and_connection` and `bank_account_insights` (from Megadoc + Pitch Deck examples). Full internal taxonomy also includes `session_behavior`, `identity_integrity`, `identity_possession`, `intent`, `plaid_network` — exact JSON keys for subscores in production responses should be verified against the live schema; do not fabricate additional subscore keys in demos.
- **`fraud_attributes`:** Namespaced key/value attributes. Namespaces include `event.*`, `session.*`, `device.*`, `user.*`, `bank_account.*`, `transaction.*`. Often sparse/empty on happy path (score 80+). Source: Protect Overview (Slite), 2026-06-08.

> **Subscore naming correction (2026-06-08):** The previous version of this KB used `device`, `identity`, `transaction_graph` as subscore keys. These are likely Ti1 model names. Ti2/current Megadoc and Pitch Deck examples use `device_and_connection` and `bank_account_insights`. Use only documented subscore keys in demos; do NOT fabricate keys like `transaction_graph` for Ti2 demos. **[NEEDS VERIFICATION: exact JSON key names in live production responses — verify against partner sandbox before hardcoding in demos.]**

### `POST /protect/user/insights/get` — re-fetch latest TI

Use after Link or on step-up / ops review. Returns `latest_scored_event` with the same `trust_index` + `fraud_attributes` shape (Megadoc).

```json
{
  "user_id": "plaid-user-6009db6e",
  "client_user_id": "tilt-user-maya-chen-7421"
}
```

**Response:** `{ "user_id": "...", "latest_scored_event": { same shape as /protect/event/get }, "request_id": "..." }`

### Host-app decisioning for Trust Index demos

- Map **`trust_index.score`** to host UI labels (e.g. "Trust Index — 87 — Low fraud risk").
- **Do NOT** map `ruleset.result: ACCEPT` from `/signal/evaluate` onto Trust Index — rulesets are Signal's decision surface unless the demo explicitly calls Signal.
- Suggested host thresholds (host logic, not a Plaid API value): score ≥ 80 → approve; 50–79 → step-up; < 50 → step-up or restrict.

### Protect webhooks (literal names — Megadoc)

| Event | When |
|-------|------|
| `PROTECT_USER_EVENT` | TI updated after async enrichment |
| `PROTECT_EVENT_RUN_FINISH` | Event processing complete |
| `LINK_EVENT_SESSION_FINISH` | Internal pipeline event when Link session scored |

**`PROTECT_USER_EVENT` webhook payload** includes `event_id`, `user_id`, `timestamp`, `event_type`. Call `/protect/event/get` with the `event_id` for full details.

---

## `/link/token/create` products

**`'protect'` is NOT valid.** Use component strings:

| Mode | `products[]` | When |
|------|-------------|------|
| **Trust Index at bank link (default)** | `['protect_linked_bank']` | Protect / Trust Index demos without IDV |
| **Protect + IDV** | `['protect_linked_bank', 'identity_verification']` | Prompt explicitly features IDV KYC |
| **Protect + transaction Signal** | add `'signal'` only if demo shows `/signal/evaluate` | Separate beat — not required for TI |
| **Protect Tx Monitor** | `['protect_linked_bank', 'protect_transactions']` | Post-link ACH fraud monitoring |

**Pipeline default:** `productFamily === 'plaid_protect'` → **`protect_linked_bank`**. Add `identity_verification` / `signal` / `monitor` only when the prompt explicitly requires those components.

**Wrong for Trust Index demos:**
- `['auth', 'signal']` or `['signal']` alone — **no Trust Index** on the wire.
- `['protect']` — hard error.
- Showing `/signal/evaluate` JSON while narrating Trust Index — **misleading**.

---

## Plaid Signal component (optional — NOT Trust Index)

Use **only** when the story includes transaction-time ACH/funding risk **in addition to** Trust Index, or when the demo is Signal-only (route to `plaid-signal.md` / family `funding`).

### `/signal/evaluate`

```json
{
  "access_token": "access-sandbox-...",
  "account_id": "account-...",
  "client_transaction_id": "unique-decision-id-123",
  "amount": 150.00,
  "client_user_id": "user-7421",
  "ruleset_key": "your_ruleset_key",
  "user": { "name": { "given_name": "Maya", "family_name": "Chen" }, "phone_number": "+14155551111", "email_address": "maya@example.com" },
  "device": { "ip_address": "192.0.2.1", "user_agent": "Mozilla/5.0 ..." }
}
```

Returns `scores.*` (1–99, higher = higher risk), `core_attributes`, `ruleset` — **no `trust_index` field**.

### `/signal/decision/report` — outcome feedback (Signal only)

```json
{ "client_transaction_id": "unique-decision-id-123", "initiated": true, "days_funds_on_hold": 0 }
```

### Signal webhooks

`SIGNAL_SCORE_READY`, `SIGNAL_RULE_TRIGGERED`, `PROTECT_TX_MONITOR_RULE_TRIGGERED` (tx monitor component).

### Signal explainability

`core_attributes` + `ruleset.triggered_rule_details.internal_note` — **no `reason_codes[]` array**.

---

## Trust Index / Ti2 (Limited Availability) — commercial SKUs

| SKU | Funnel point | Attributes | Notes |
|-----|--------------|-----------|-------|
| **TI Score (Device)** | Pre-PII (sign-up page) | ~3,000 | Beta — not yet standard for demos |
| **TI Score (Identity)** | After PII collection | ~7,000 | Beta — not yet standard for demos |
| **TI Full** | After bank link | **10,000+** | **LA — current default for demos** |

Source: Pitch Decks 2026 + GTM Playbook (Glean, 2026-06-08).

**Ti2 marketing stat (approved on blog):** ~30% more fraud caught vs Ti1; cash-advance example: step up 1 in 10 users → 43% more fraud detected.

---

## Overview

Plaid Protect is a real-time fraud intelligence platform built on Plaid's network of 500M+ bank connections, 1B+ devices, IDV sessions, and billions of bank transactions. It generates a **Trust Index** score — a 1–100 signal where higher = more trustworthy — at key points in the user journey, from device fingerprint before signup through bank account verification. Protect addresses both third-party fraud (stolen identity, synthetic, ATO, bots) and first-party fraud (bust-out, default-never-pay, dispute abuse) in a single integration, enabling fintech operators to route high-trust users through low-friction paths while stepping up risk.

---

## Where It Fits

Feature Protect in demos where the persona is a fintech, lender, neobank, or EWA app that needs to screen users at onboarding — especially when first-party fraud is the primary concern (traditional fraud tools miss it) or when the persona wants to reduce friction for good users while catching bad actors.

**Recommended entry point for demo building:** bank linking (TI Full) via `products: ['protect_linked_bank']`. Protect fires passively in the background; the demo shows the host app calling `/protect/event/send` after `onSuccess` and displaying the Trust Index in an operator/underwriter panel — not on the consumer screen.

**Strongest adjacent products:**
- **Protect + IDV:** Protect scores the user's fraud risk; IDV verifies identity. Use Trust Index to drive step-up to IDV for risky users; low-trust users get document + selfie, high-trust users skip friction.
- **Protect + Layer:** Layer prefills identity top-of-funnel; Protect scores device and identity risk at the same stage. Brings Protect signal up-funnel before bank link.
- **Protect + Signal:** Protect at onboarding for user-level fraud; Signal at funding for ACH return risk. Two orthogonal scores, same Plaid contract — the "full-stack" story.

---

## Value Proposition Statements

### Primary Pitch
> "Protect scores user fraud risk at bank linking in real time — using 10,000+ signals from Plaid's network that fraudsters can't fake — so you route good users through in seconds and catch the ones traditional tools miss."

### Supporting Claims
- [DRAFT] Trust Index at bank link catches **both** third-party fraud (stolen identity, synthetic, ATO) and first-party fraud (bust-out, never-pay) — the fraud types existing KYC and AML tools are weakest against.
- [DRAFT] One integration at existing bank-linking adds Protect: add `protect_linked_bank` to `products[]`, call `/protect/event/send` after `onSuccess`, and get a TI score in ~1–5s.
- [DRAFT] 10,000+ fraud-specific attributes, customized to your unique fraud patterns — powered by 500M+ bank connections, 1B+ devices, and cross-app behavioral graph data that no other provider can access.
- [DRAFT] Plaid's open-banking network data is authenticated at source — competitors like Socure and Sardine do not receive this metadata.
- [DRAFT] Proof-point headline: catch 40% of first-party fraud by stepping up just 5% of users — approved stat from a publicly traded lender retro (GTM Playbook, 2026).

---

## Proof Points & ROI Metrics

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| First-party fraud caught at 5% step-up | 40% | GTM Playbook (publicly traded lender retro) | high | 2026-06-08 |
| Fraud-related losses prevented at 5% step-up | 50% | GTM Playbook (leading cash advance company) | high | 2026-06-08 |
| Fraud caught at 10% step-up | 47% | GTM Playbook (large crypto firm retro) | high | 2026-06-08 |
| Trust Index attributes (TI Full / bank link) | 10,000+ | Plaid product site + Pitch Decks 2026 | high | 2026-06-08 |
| Bank connections in Plaid network | 500M+ | Plaid product site | high | 2026-06-08 |
| Devices in Plaid network | 1B+ | Plaid product site | high | 2026-06-08 |
| Attributes at sign-up / device stage | ~3,000 | Pitch Decks 2026 (internal) | medium | 2026-06-08 |
| Attributes at identity verification stage | ~7,000 | Pitch Decks 2026 (internal) | medium | 2026-06-08 |
| Ti2 improvement vs Ti1 | ~30% more fraud caught | Ti2 launch blog | medium | 2026-05-25 |
| [DRAFT] Retro average: fraud detection improvement | 40–59% at 5–10% step-up | GTM Playbook retro average | medium | 2026-06-08 |
| [DRAFT] Credit Genie retro | $160K–$260K/month mitigation potential | Internal retro (Glean) | low | 2026-05-25 |

**Named customers approved for demos (GTM Playbook 2026):** Gemini, Credit Genie, Benny, Albert.
**Not approved as public proof points:** Tilt (internal opportunity, not a released customer reference), Cash App (strategic exception context only — not a standard proof point).

---

## Customer Use Cases

### First-Party Fraud Screen at Bank Linking (Default Demo)
**Persona:** Risk engineer at a cash-advance or EWA fintech (e.g. "Tilt" fictional persona).
**Problem:** Traditional fraud tools pass users who later bust out or dispute charges — first-party fraud is invisible to KYC and AML alone. Step-up friction on all users kills conversion.
**Solution:** Add `protect_linked_bank` to Link token; after `onSuccess` call `/protect/event/send` → Trust Index 87 returned synchronously. Users scoring ≥ 80 are approved instantly. Users 50–79 get SMS/doc step-up. Below 50, restrict or manual review.
**Outcome:** 40% of first-party fraud caught at only 5% step-up rate; low-risk users experience no added friction.

### [DRAFT] Full-Funnel Onboarding Fraud Defense (Device + Identity + Bank)
**Persona:** Head of fraud at a neobank or digital lender.
**Problem:** Fraud rings use coordinated device activity and synthetic identities at scale; by the time the bank is linked, damage is done.
**Solution:** Protect SDK captures device fingerprint at sign-up (`app_visit`); Trust Index at identity stage (~7,000 attributes) routes synthetic/stolen-identity suspects to IDV; TI Full at bank link (~10,000+ attributes) screens remaining first-party fraud risk.
**Outcome:** Layered risk gates stop fraud at each funnel stage with minimum friction for legitimate users.

### [DRAFT] Protect + IDV Step-Up (Operator-Driven KYC Gating)
**Persona:** Compliance team at a lender.
**Problem:** Running full KYC (IDV) on every new user is expensive and increases drop-off; but skipping it for risky users creates regulatory exposure.
**Solution:** Protect scores user at bank link. High-trust score (≥ 80) → skip IDV or use data-source-only check. Low-trust score (< 60) → trigger full IDV session with document + selfie via `identity_verification` product.
**Outcome:** IDV cost reduced by routing only flagged users; compliance maintained for risky users; conversion improved for the majority.

### [DRAFT] Protect + Signal Full-Stack Onboarding + Funding
**Persona:** Product manager at investment or pay-by-bank platform.
**Problem:** Fraud at two distinct stages: fake/stolen identity at onboarding, and ACH returns at funding.
**Solution:** Protect Trust Index at bank link for onboarding fraud risk; Signal at funding for ACH return risk. Two orthogonal scores, one Plaid contract. Step-up bad users at onboarding; reroute risky ACH transfers to slower rail.
**Outcome:** Stops identity fraud and ACH return fraud in a single integration; narration keeps the two scores clearly distinct.

---

## Narration Talk Tracks

### Demo Opening — onboarding fraud context
> "Fraud doesn't stop at the front door. Even after identity checks pass, first-party fraud — users who apply honestly but never intend to repay — costs fintechs millions. Plaid Protect screens risk in real time, using signals from across the financial network that no other provider can see." (35 words)

### Protect SDK — device signal at sign-up
> "When the user hits the sign-up page, Protect's SDK captures a device fingerprint before any PII is entered — connecting this session to known patterns across a billion devices and Plaid's network." (33 words)

### Link step — narration boundary (Protect rides Link)
> "Maya taps 'Link your bank' — and in the background, Protect begins ingesting network signals for her account." (18 words — pre-Link step closer)

### Hero API call — Trust Index reveal (bank-link path)
> "After Maya's bank links, Tilt calls POST /protect/event/send and gets a Trust Index of 87 out of 100 — high confidence she's not a first-party fraud risk. Protect scored 10,000-plus attributes in under two seconds." (35 words)

### Subscore reveal
> "Device and connection signals score 92. Bank account insights score 78 — her account history is strong but slightly newer. Together they tell a story no single data source could." (30 words)

### Host decision — approve path
> "Trust Index 87 clears the threshold. Maya's application is approved instantly — no extra friction, no wait." (16 words)

### Step-up path (optional beat for risk demo)
> "A Trust Index below 60 triggers a step-up — an ID document and selfie check via Plaid IDV. Good users sail through; Protect routes the risk, not the volume." (30 words)

### Signal beat (only if explicit in prompt)
> "At funding, Signal evaluates ACH return risk separately — score 12, low risk, ACCEPT. Protect caught onboarding fraud; Signal guards the payment rail." (23 words)

---

## Accurate Terminology

| Term | Correct usage |
|---|---|
| `trust_index.score` | 1–100, **higher = safer / more trustworthy** |
| Signal score | 1–99, **higher = higher ACH return risk** — opposite direction from TI |
| `protect_linked_bank` | The `products[]` string for Protect at bank link — never `'protect'` |
| `user_sign_up` | Request-side event object (lowercase snake_case) sent via `/protect/event/send` |
| `LINK_SESSION_END` | Returned `event_type` value in Protect event responses — NOT a request-side event object |
| `device_and_connection` | Documented TI subscore key (Ti2/current). Do NOT use `device` alone. |
| `bank_account_insights` | Documented TI subscore key (Ti2/current). Do NOT use `transaction_graph`. |
| Trust Index / Ti / Ti2 | Plaid Protect only — never apply to Signal `scores.*` values |
| `PROTECT_USER_EVENT` | Webhook code when TI is updated async — NOT `SIGNAL_SCORE_READY` |
| `fraud_attributes` | Namespaced attributes (e.g. `session.ip.is_vpn`, `user.linked_bank_accounts.num_owner_full_names`) — dynamic subset, not guaranteed fields |
| `protect_sdk_session_id` | The frontend device session ID from Protect SDK — pass to backend event send |
| First-party fraud | The real user is the fraud (bust-out, default-never-pay, dispute abuse) |
| Third-party fraud | Someone else using the user's identity (ATO, stolen identity, synthetic) |

---

## Demo guidance — Trust Index happy path (default)

**Persona:** Fintech onboarding / cash-advance fraud screen (e.g. fictional "Tilt" or "Benny"-type persona).

**Beats:**

1. Host — application / sign-up context. Narration: first-party fraud problem.
2. Optional: Protect SDK device fingerprint captured (slide or narration — not a modal).
3. Link — `products: ['protect_linked_bank']`; `plaidPhase: "launch"`.
4. Host loading — "Running fraud check…" (shows Protect is working in background).
5. **Hero API panel:** `POST /protect/event/send` → `trust_index.score` 87, subscores, sparse `fraud_attributes`.
6. Host decision — approve / step-up from **Trust Index score**, not Signal ruleset.
7. Plaid slides — LA disclosure, peer benchmark (40% first-party fraud at 5% step-up), CTA.
8. **Optional separate beat:** `/signal/evaluate` only if prompt requires transaction scoring — second API panel, clearly labeled **Plaid Signal**, not Trust Index.

**Wire-format anti-patterns:**

- `trust_index` inside `/signal/evaluate` response.
- `ruleset.result: ACCEPT` presented as Trust Index outcome.
- `scores.bank_initiated_return_risk: 12` labeled "Trust Index".
- Subscore keys `device`, `identity`, or `transaction_graph` on a Ti2 demo — use `device_and_connection` and `bank_account_insights` instead.
- Showing `trust_index` on the consumer-facing screen (it belongs in the operator/underwriter view).
- Using `LINK_SESSION_END` as a request-side event object in `/protect/event/send` — it is a returned `event_type` only.

---

## GTM positioning (internal — Glean, 2026)

**Core differentiator:** Plaid is integrated directly at source with financial institutions. Protect uses **authenticated open-banking network metadata** — device, bank, identity, behavioral, and graph signals — that competitors like Socure and Sardine do not receive. Source: GTM Playbook 2026.

**Approved named customers (for demo contexts):** Gemini, Credit Genie, Benny, Albert. Source: GTM Playbook 2026.

**Competitive positioning (Socure / Sardine):** "Neither Socure nor Sardine receive metadata or network insights from open banking. Protect adds a fundamentally different data layer — authenticated financial behavior at source." Source: GTM Playbook + Pitch Decks 2026.

**Competitive positioning (generic — for Alloy / Unit21 or in-house models):** "Protect is not meant to run standalone. Return Trust Index + attributes, then measure incremental lift inside your existing models. The differentiation is the open-banking network metadata no other provider can access." Source: GTM Playbook 2026.

**Native iOS/Android Protect SDKs:** Available May 2026.

**Internal resources:** GTM Playbook (pl/protect-gtm), Protect Megadoc, Ti2 Deep Dive deck, Protect Overview (Slite).

---

## Competitive Differentiators

| Dimension | Plaid Protect | Competitors (Sardine, Socure) |
|---|---|---|
| Data source | Authenticated open-banking network — bank accounts, transactions, linked devices, cross-app behavior | Static identity data, device checks, bureau data |
| First-party fraud | Strong — bank account insights and network graph are predictive | Weak — identity checks pass for real users acting fraudulently |
| Network effect | Stronger the more Plaid is used — signals compound across 7,000+ apps | Single-tenant signals only |
| Integration path | Existing Plaid bank-linking customers add one product string + one API call | Separate vendor, separate data contract |
| Onboarding friction | Passive — score generated in background; no added user friction | Often adds a separate friction step |

---

## Objections & Responses

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| "We already have Signal." | Signal handles ACH-return/transaction risk; Protect scores user-level fraud. They are complementary — Signal doesn't catch first-party fraud at onboarding. | GTM Playbook 2026 | [DRAFT] |
| "We already use Socure/Sardine." | Protect adds authenticated open-banking network metadata they don't receive — it's an orthogonal layer, not duplicate spend. | GTM Playbook + Pitch Decks 2026 | [DRAFT] |
| "We already do KYC." | KYC proves identity; Protect detects cross-network fraud behavior and drives risk-based step-ups — it doesn't replace verification, it makes it smarter. | GTM Playbook 2026 | [DRAFT] |
| "How would we actually use it?" | Anchor to the customer's fraud waterfall. Typical actions: ACH block/reroute, limits/holds, MFA, relink, doc, or selfie step-up. Demo shows Trust Index threshold driving each path. | GTM Playbook 2026 | [DRAFT] |
| "We already have internal models." | Protect isn't meant to run standalone. Return Trust Index + attributes, then measure incremental lift inside existing models. Approved stat: 40–50%+ more fraud caught at 5–10% step-up. | GTM Playbook 2026 | [DRAFT] |
| "This sounds heavy to integrate." | Add `protect_linked_bank` to existing bank-linking product array. Call `/protect/event/send` after `onSuccess`. Roughly 1–3 days of backend work. Most effort is decisioning logic, not plumbing. | GTM Playbook + Integration Resources 2026 | [DRAFT] |
| "Is this just Beacon / are we sharing customer data?" | Beacon is one consortium module inside Protect. Retro data is single-purpose; consortium returns fraud hits — not raw PII. | GTM Playbook 2026 | [DRAFT] |
| "Will it catch the fraud we miss today?" | Lead on first-party fraud and cross-app abuse patterns current rules miss. Approved proof points: 40–50%+ fraud caught at just 5–10% step-up. | GTM Playbook retro stats 2026 | [DRAFT] |

---

## Implementation Pitfalls

- Pick the insertion point deliberately: **Link (TI Full)** is the recommended first path for existing Plaid customers — most decisioning data, least work. Signup/device-only captures far fewer signals and those SKUs are in beta.
- **Trust Index is event-time only** — it cannot be recomputed retroactively. Store `event_id` and the full response for audit; do not assume the score persists unchanged.
- `fraud_attributes` are a **dynamic subset**, not guaranteed fields — write defensive parsing; don't hardcode specific attribute keys as always-present.
- `protect_linked_bank` is **US-only** — non-US demos will hard-fail. Non-US Protect demos are not supported in the current LA period.
- For existing Link customers, upgrade to **client lib v33.1.0+** and pass `protect_linked_bank` — do not use the old `protect` string (hard error).
- **More PII materially improves scoring** — address helps stabilize scores; avoid demo payloads with intentionally thin identity data unless demoing the device-only SKU.
- Thresholding requires calibration — teams need help defining safe/step-up/block bands. Live Protect customers use the Reports API for continuous tuning; demo thresholds should be realistic (not 0/50/80 clean round numbers).
- Sandbox and prod permissions are provisioned separately — provision both early; Credit Genie was blocked by sandbox/prod mismatch during onboarding.
- [DRAFT] Block on malformed request fields — strict payload validation and known-good sample payloads reduce the #1 engineering integration issue.

---

## Framework QA Learnings

- Protect demo apps should always show Trust Index score in an **operator/underwriter panel**, not on the consumer onboarding screen. If the consumer sees a number at all, it should be labeled as the decisioning outcome ("Approved" / "Step-up required"), not the raw score.
- The `products[]` resolver should map `plaid_protect` family → `['protect_linked_bank']`. Do not inject `'protect'`, `'signal'`, or `'identity_verification'` unless the prompt explicitly requires those beats.
- When narrating Trust Index subscores, use `device_and_connection` and `bank_account_insights` as the two demo-visible subscores. Do not generate `device: 92, identity: 88, transaction_graph: 82` narration for Ti2 demos — those are Ti1 field names.
- The Signal beat and the Protect Trust Index beat should have **separate API panels**, clearly labeled. Signal JSON showing `scores.*` and Protect JSON showing `trust_index` must never appear in the same panel as if they are the same API.

---

## AI Research Notes

**2026-06-08 — Full Protect KB enhancement (Plaid Product KB Enhancer agent)**

Sources used: AskBill (ask_bill + plaid_docs MCP), Glean (Megadoc, Integration Resources, GTM Playbook, Pitch Decks 2026, Deep Dive Session, Protect Overview Slite, plaid.com/products/protect/).

Key verified facts:
- `trust_index.score` range confirmed: 1–100, higher = safer. AskBill + Megadoc agree.
- `protect_linked_bank` confirmed valid in `products[]` by AskBill.
- Request-side event objects for `/protect/event/send`: `app_visit`, `user_sign_up`, `user_sign_in`, `password_change_request_event`, `password_change_event` (lowercase snake_case). Source: Megadoc.
- `LINK_SESSION_END` is a returned `event_type`, not a request-side object. Important distinction for demo payloads.
- Subscore names in Ti2/current docs: `device_and_connection`, `bank_account_insights` (Megadoc + Pitch Deck). Not `device`/`identity`/`transaction_graph` (those were Ti1).
- Three-stage onboarding funnel with attribute counts (~3k/~7k/10k+) sourced from Pitch Decks 2026 (internal).
- Fraud type taxonomy (`first_party`, `stolen`, `synthetic`, `account_takeover`, `unknown`) confirmed via `/protect/report/create` schema in Integration Resources.
- Approved ROI proof points: 40% FPF at 5% step-up (public lender), 50% losses at 5% step-up (cash advance), 47% at 10% step-up (crypto) — all from GTM Playbook, high confidence.
- Approved named customers: Gemini, Credit Genie, Benny, Albert. Removed Tilt (not approved) and Cash App (strategic exception, not standard proof point) from GTM references.
- Competitive differentiator vs Socure/Sardine: authenticated open-banking network metadata. Approved phrasing from GTM Playbook.

**Unresolved / needs verification:**
- Exact JSON key names for all `trust_index.subscores` in live production responses — Megadoc shows `device_and_connection` and `bank_account_insights` in examples, but full subscore taxonomy keys need partner sandbox verification before hardcoding all subscore names in demo JSON.
- Whether `password_change_request_event` and `password_change_event` are available in Protect sandbox (Megadoc lists them; sandbox availability unconfirmed).
- Exact TI Score (Device) and TI Score (Identity) SKU GA timeline — marked as beta/not standard for demos.

---

## Change Log

- 2026-06-08: Full KB enhancement [AI — Plaid Product KB Enhancer]. Added: Fraud Type Mapping section (first-party vs third-party, with component mapping), Onboarding Flow Placement section (three-stage funnel, event-driven model, `/protect/event/send` event objects, demo UI guidance, IDV/Signal composition diagram), corrected subscore names (Ti1 `device/identity/transaction_graph` → Ti2 `device_and_connection`/`bank_account_insights`), corrected event object casing (`user_sign_up` vs `LINK_SESSION_END`), upgraded Proof Points table to template format with sources/confidence, added Customer Use Cases with onboarding-fraud personas, added Accurate Terminology section, added Narration Talk Tracks for onboarding-fraud story, fixed GTM references (removed Tilt/Cash App as approved customers; Gemini/Credit Genie/Benny/Albert approved), added Competitive Differentiators table, added Framework QA Learnings.
- 2026-05-31: Proof Points & ROI Metrics, Objections & Responses, Implementation Pitfalls, Where It Fits auto-built [AI]
- 2026-05-25: Initial KB built from AskBill + Glean Megadoc [AI]
