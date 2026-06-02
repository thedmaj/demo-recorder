---
last_vp_research: "2026-05-25"
last_api_verified: "2026-05-25"
sources:
  - "AskBill plaid_docs MCP (2026-05-25 — confirms /signal/evaluate does NOT return trust_index)"
  - "Glean: Plaid Protect Megadoc (2025, updated 2026-05-21), Plaid Protect Testing & Integration Resources, GTM Playbook: Plaid Protect (May 2026)"
  - "Glean: Protect Overview + Plaid Verify Service (Slite eng docs)"
  - "Ti2 launch blog (plaid.com/blog/plaid-protect-trust-index/ — Oct 14 2025)"
  - "Public: plaid.com/docs/api/products/protect/ (endpoint index; field-level Protect schemas are partner/Sales-gated)"
last_ai_update: "2026-05-31T00:00:00Z"
needs_review: true
last_auto_build_sections:
  - "Proof Points & ROI Metrics"
  - "Objections & Responses"
  - "Implementation Pitfalls"
  - "Where It Fits"
---

# Plaid Protect

> **Product family key:** `plaid_protect`
> **Solution category:** Anti-fraud + identity risk-scoring umbrella
> **Status (May 2026):** **Limited Availability** for Trust Index / Ti2; component products (Signal, IDV, Monitor) are GA on their own.
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
- Plaid Verify (legacy Auth naming) — not a rename of Protect.

---

## Trust Index — initialization & API (canonical for `plaid_protect` demos)

Trust Index is **not** retrieved via `/signal/evaluate`. AskBill and internal Protect docs agree: Signal returns `scores.*` + `ruleset`; **only Protect APIs return `trust_index`**.

### Initialization sequence (typical bank-link / Tilt-style funnel)

1. **`POST /user/create`** (when using Plaid User APIs) — establish `user_id` (`usr_…` / `plaid-user-…`) and pass `client_user_id` through the journey. Required for ongoing `/protect/user/insights/get` and event association (Glean: Protect Megadoc canonical journey).
2. **Optional early funnel:** Protect Web SDK (Pixel) → `POST /protect/client/session/start` + `track` → first `POST /protect/event/send` with SDK `session_id` for **TI Device**-class signals (pre-PII).
3. **`POST /link/token/create`** with **`products: ['protect_linked_bank']`** (US-only). Add `'identity_verification'` only when IDV is a featured beat. **Do not add `'signal'`** unless the demo explicitly shows **transaction-time Signal** as a separate API call (see § Signal component below).
4. **Plaid Link** — single `plaidPhase: "launch"`; real SDK modal.
5. **After Link `onSuccess`** — score Trust Index:
   - **Primary:** `POST /protect/event/send` with `event_type: "LINK_SESSION_END"` (Megadoc / Integration Resources; internal alias `LINK_EVENT_SESSION_FINISH` in some pipelines), `link_session_id` from Link metadata, `user_id`, `client_user_id`, and **`request_trust_index: true`** for synchronous scoring (or `false` + `PROTECT_USER_EVENT` / `VERIFY_USER_EVENT` webhook when async).
   - **Alternate read paths:** `POST /protect/user/insights/get` for latest user-level TI + attributes; `POST /link/token/get` → `link_sessions[].results.protect_results` when TI was computed at Link handoff.

### `POST /protect/event/send` — Trust Index score retrieval

**Purpose:** Ingest a lifecycle event and optionally compute/return Trust Index for that event.

**Request (happy-path bank link — documented pattern from Glean Protect Megadoc / Integration Resources):**

```json
{
  "client_user_id": "tilt-user-maya-chen-7421",
  "user_id": "plaid-user-6009db6e",
  "event_type": "LINK_SESSION_END",
  "link_session_id": "link-sandbox-session-id-from-metadata",
  "request_trust_index": true
}
```

| Field | Notes |
|-------|--------|
| `client_user_id` | Host's stable user id |
| `user_id` | From `/user/create` |
| `event_type` | `LINK_SESSION_END` at bank-link completion; other journey events (`SIGN_UP`, SDK session, etc.) per SKU |
| `link_session_id` | From Link `onSuccess` metadata |
| `request_trust_index` | **`true`** = sync wait for TI (~1–5s); **`false`** = async; score via webhook |

**Response (canonical event object — Megadoc):**

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
        "device": 92,
        "identity": 88,
        "transaction_graph": 82
      }
    },
    "fraud_attributes": {}
  },
  "request_id": "saKrIBuEB9qJZng"
}
```

- **`trust_index.score`:** 1–100, **higher = SAFER** (opposite of Signal 1–99 risk scores).
- **`trust_index.model`:** e.g. `ti-link-session-2.0`, `ti-pro-2.0` — customer/event mapped.
- **`trust_index.subscores`:** Documented keys include `device`, `identity`, `transaction_graph` — do not invent others in demos.
- **`fraud_attributes`:** Key/value bag; often sparse/empty on happy path (score 80+).

### `POST /protect/user/insights/get` — re-fetch latest TI

Use after Link or on step-up / ops review. Returns `latest_scored_event` with the same `trust_index` + `fraud_attributes` shape (Megadoc).

```json
{
  "client_user_id": "tilt-user-maya-chen-7421",
  "user_id": "plaid-user-6009db6e"
}
```

### Host-app decisioning for Trust Index demos

- Map **`trust_index.score`** to host UI labels (e.g. "Trust Index — 87 — Low fraud risk").
- **Do NOT** map `ruleset.result: ACCEPT` from `/signal/evaluate` onto Trust Index — rulesets are Signal's decision surface unless the demo explicitly calls Signal.
- Optional host thresholds: score ≥ 80 → approve; 50–79 → review; &lt; 50 → step-up (host logic, not a Plaid `REJECT` API value).

### Protect webhooks (literal names — Megadoc)

| Event | When |
|-------|------|
| `PROTECT_USER_EVENT` / `VERIFY_USER_EVENT` | TI updated after async enrichment |
| `PROTECT_EVENT_RUN_FINISH` | Event processing complete |
| `LINK_EVENT_SESSION_FINISH` | Internal pipeline event when Link session scored |

Do **not** use `SIGNAL_SCORE_READY` as the Trust Index completion signal unless the demo also integrates Signal.

---

## `/link/token/create` products

**`'protect'` is NOT valid.** Use component strings:

| Mode | `products[]` | When |
|------|-------------|------|
| **Trust Index at bank link (default)** | `['protect_linked_bank']` | Protect / Trust Index demos without IDV |
| **Protect + IDV** | `['protect_linked_bank', 'identity_verification']` | Prompt explicitly features IDV |
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

| SKU | Funnel point | Price (indicative) |
|-----|--------------|-------------------|
| **TI Score (Device)** | Pre-PII | $0.10 |
| **TI Score (Identity)** | After PII collection | ~$0.50 |
| **TI Score (Full)** | After bank link | $2.50 |

During LA (March 2026+), **TI Full** is the primary commercially available SKU at bank-link; Device/Identity may remain beta per GTM playbook.

**Ti2 marketing stat (approved on blog):** ~30% more fraud caught vs Ti1; cash-advance example: step up 1 in 10 users → 43% more fraud detected.

---

## Demo guidance — Trust Index happy path (default)

**Persona:** Fintech onboarding / cash-advance fraud screen (e.g. Tilt Protect opp).

**Beats:**

1. Host — application / context.
2. Link — `products: ['protect_linked_bank']`; `plaidPhase: "launch"`.
3. Host loading — "Running fraud check…"
4. **Hero API panel:** `POST /protect/event/send` → `trust_index.score` 87, subscores, sparse `fraud_attributes`.
5. Host decision — approve / step-up from **Trust Index score**, not Signal ruleset.
6. Plaid slides — LA disclosure, peer benchmark, CTA.
7. **Optional separate beat:** `/signal/evaluate` only if prompt requires transaction scoring — second API panel, clearly labeled **Plaid Signal**, not Trust Index.

**Wire-format anti-patterns:**

- `trust_index` inside `/signal/evaluate` response.
- `ruleset.result: ACCEPT` presented as Trust Index outcome.
- `scores.bank_initiated_return_risk: 12` labeled "Trust Index".
- Fabricated subscore keys beyond `device` / `identity` / `transaction_graph`.

## GTM positioning (internal — Glean, 2026)

- Differentiator: network graph + bank-connected signals fraudsters cannot easily fake.
- References: Albert, Credit Genie, Cash App (POC); pipeline Gemini, Cherry, Revolut, Oportun, Kalshi.
- Native iOS/Android Protect SDKs (May 2026).
- Internal: GTM Playbook, Protect Megadoc, Ti2 Deep Dive deck.

## Approved talk track

- "After Maya links her bank, Tilt calls **POST /protect/event/send** and gets a Trust Index of **87** — high confidence she's not first-party or takeover fraud."
- "Device 92, identity 88, transaction graph 82 — subscores explain *why* the score is strong."
- *(Only if Signal beat exists)* "At disbursement, **POST /signal/evaluate** returns Account Score 12 — low ACH return risk."

## Value Proposition Statements

- One Link + Protect event stream → user-level Trust Index without bolting on a separate fraud vendor.
- TI Full at bank-link fits cash-advance / LOC underwriting (Tilt SFDC motion + Retro).
- Optional Signal layer for payment-time ACH risk — **orthogonal** to Trust Index, same Protect contract.

## Proof Points & ROI Metrics
- [DRAFT] Retro average: **Protect** improved fraud detection **40–59%** while stepping up just **5–10%** of users—strong headline metric for overview/demo openers.
- [DRAFT] Average modeled ROI: **46%** more first-party fraud detected and **52%** of fraud-dollar losses prevented, even layered onto existing fraud stacks.
- [DRAFT] **Public lender** beta result: stepping up only **5%** of users would have caught **40%** of first-party fraud.
- [DRAFT] **Major crypto firm** beta result: stepping up **1 in 10** users would have caught **47%** of fraud—great proof point for top-of-funnel device-led scoring.
- [DRAFT] **Cash advance app** beta result: stepping up **5%** of users would have prevented **50%** of losses; ideal for EWA/cash-advance ROI storytelling.
- [DRAFT] Internal customer reference: **Credit Genie** retro/POC showed **$160K–$260K/month** fraud and credit-risk mitigation potential across its portfolio.
- [DRAFT] Deployment proof point: easiest entry is at **bank linking**—**1 backend API call**, roughly **1–3 days** to integrate for TI Full demos.
- [DRAFT] Up-funnel demo story: **signup** and **identity** entry points expose roughly **3,000** and **7,000** attributes, enabling lower-friction routing before full bank-linking signals.

## Objections & Responses
- [DRAFT] **Signal overlap:** “We already have **Signal**.” Rebuttal: **Signal** handles ACH-return/transaction risk; **Protect** scores user-level fraud. Position them as complementary and strongest together.
- [DRAFT] **Vendor overlap:** “We already use **Socure/Sardine**.” Rebuttal: Protect adds authenticated open-banking network metadata competitors do not get, so it’s an orthogonal layer, not duplicate spend.
- [DRAFT] **KYC overlap:** “We already do **KYC**.” Rebuttal: KYC proves identity; Protect detects cross-network fraud behavior and should drive risk-based step-ups, not replace verification.
- [DRAFT] **Flow ambiguity:** “How would we actually use it?” Rebuttal: anchor demo to the customer’s fraud waterfall; typical actions are ACH block/reroute, limits/holds, MFA, relink, doc, or selfie.
- [DRAFT] **In-house models:** “We already have rules/models.” Rebuttal: Protect is not meant to run standalone; return **Trust Index + attributes**, then measure incremental lift inside existing models.
- [DRAFT] **Integration lift:** “This sounds heavy to integrate.” Rebuttal: easiest motion is add Protect at existing bank-linking; earlier-funnel PII/device options expand coverage later. Most work is decisioning, not plumbing.
- [DRAFT] **First-party fraud skepticism:** “Will it catch the fraud we miss today?” Rebuttal: lead on first-party fraud and cross-app abuse patterns current rules miss; approved proof points show 40–50%+ at 5–10% step-up.
- [DRAFT] **Beacon/data-sharing concern:** “Is this just **Beacon**, or are we sharing customer data?” Rebuttal: Beacon is one module inside Protect; retro data is single-purpose, and consortium returns fraud hits—not raw PII.

## Implementation Pitfalls
- [DRAFT] Pick the insertion point deliberately: **Link** is the recommended first path for existing Plaid customers—most decisioning data, least work; signup/device-only captures far less signal.
- [DRAFT] Don’t overpromise or skip capture: **Trust Index** is event-time only, can’t be recomputed later, and returned fraud attributes are dynamic subsets, not guaranteed fields.
- [DRAFT] Block flagged **malformed request fields** as the biggest engineering pain point; add strict payload validation and known-good sample payloads to demo scaffolding.
- [DRAFT] Provision access early in **both sandbox and prod**; Credit Genie got blocked because enablement was client-by-client and sandbox/prod permission checks differed.
- [DRAFT] **Protect-only Link sessions** can fail; launch Link with **Identity** alongside Protect when required, instead of assuming Protect alone is sufficient.
- [DRAFT] For existing Link customers, upgrade to **client lib v33.1.0+** and pass `protect_linked_bank`; it’s **US-only**, so non-US demos will hard-fail.
- [DRAFT] More **PII** materially improves scoring; **address** helps stabilize scores and match nicknames, so avoid demoing an intentionally thin identity payload unless that’s the point.
- [DRAFT] Thresholding stalls without labels: teams needed help defining **safe / step-up / block** bands, and live Protect customers are required to use **Reports API** for tuning.

## Where It Fits
- [DRAFT] **Protect** is a **real-time user-risk layer** that scores fraud as users progress through app flows, not just at transaction time; position it as flexible risk orchestration.
- [DRAFT] In a typical architecture, **Protect fits at three points**: **sign-up**, **identity verification**, and **bank linking / pre-transaction**—with increasing signal depth at each stage.
- [DRAFT] For easiest demo setup, start at **bank linking**: **TI Full** plugs in via **1 backend API call** and is often framed as “add another product to your product array.”
- [DRAFT] For top-of-funnel demos, show **SDK-based device screening** on the signup page: Protect assesses **device + IP/session risk** before PII collection to route users into low- or high-friction paths.
- [DRAFT] The strongest adjacent bundle is **Protect + IDV**: use Protect during identity collection to step up risky users while reducing friction for low-risk ones.
- [DRAFT] Another strong bundle is **Protect + Layer** for earlier onboarding coverage; internal positioning explicitly says Protect **pairs great with Layer** to bring risk insights **top-of-funnel**.
- [DRAFT] At account linking / money movement, pair **Protect + Link/Auth/Identity Match**, and often **Signal** for payment risk; this creates a layered story across linking, account validation, and transaction defense.
- [DRAFT] Funnel-wise, Protect serves both **mid-/bottom-funnel activation** today and **top-of-funnel demand gen**: current Limited Availability is **TI Full only**, while the public waitlist builds pipeline for GA.
