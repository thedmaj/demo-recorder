---
product: Plaid Transfer
slug: transfer
claims_source: primary
api_endpoints:
  - "transfer/authorization/create"
  - "transfer/create"
  - "transfer/get"
  - "transfer/event/sync"
  - "transfer/intent/create"
  - "transfer/sweep/list"
use_cases:
  - "account-funding"
  - "instant-deposit"
  - "loan-disbursement"
  - "recurring-ach-debit"
  - "fund-and-protect-bundle"
last_human_review: ""
last_ai_update: "2026-05-31T00:00:00Z"
last_vp_research: "2026-05-26"
last_askbill_verification: "2026-05-26T20:30:00Z"
needs_review: true
approved: false
version: 1
---

# Plaid Transfer

## Overview
Plaid Transfer is an embedded A2A (account-to-account) payment solution that moves money between bank accounts on ACH rails (standard, same-day) and instant rails (RTP, FedNow — Limited Availability). Transfer reuses the access token from Plaid Link so the same session authenticates the account AND moves the money — no separate processor token, no micro-deposits, no re-auth. When paired with Plaid Signal, every `/transfer/authorization/create` call is risk-scored before the debit is initiated, which is the structural differentiator from commodity ACH processors.

## Where It Fits
Feature Transfer in demos where the persona is funding a fintech account, disbursing a loan, or moving money between linked accounts. Best paired with Auth (verified account/routing), Identity Match (owner confirmation), and Signal (pre-send ACH risk score) to tell the full "Fund & Protect" story. Primary ICPs: investment/brokerage platforms (Robinhood, Public), neobanks moving funds DDA↔investment, lending platforms disbursing proceeds, consumer fintech with recurring ACH debit. **Not a fit** for: card payments, international (US/USD only), wire transfers, B2B treasury >$25K.

## Value Proposition Statements
<!-- ⚠️ HUMAN-OWNED — pre-approved messaging. AI may ADD candidates marked [DRAFT]
     but must NOT modify or remove approved statements. -->

### Primary Pitch
> "Plaid Transfer gives you bank-verified account funding — no card rails, no intermediary TPSP, no returned ACH blind spots. You authenticate the account with Plaid Link, score it with Signal, then move money with Transfer — all in one SDK." [DRAFT — PMM-approved internal, source: Transfer Positioning Brief Q1 2026]

### Short-form (30s)
> "Transfer is how Plaid customers move money. Auth gets the account. Signal scores it. Transfer initiates the debit. One integration, zero blind spots." [DRAFT — source: Transfer Positioning Brief Q1 2026]

### Fund & Protect Play Narration (Solutions Master, 2026)
> "The account is connected. Signal scores it. Transfer moves the money. One SDK, one data network, no ACH blind spots." [DRAFT — source: Solutions Master 2026]

### Supporting Claims
- "Plaid Transfer with Signal pre-screening reduces ACH return rates by 3–5× vs baseline." (attribution: "based on Plaid internal data")
- "Guaranteed Transfer: for qualifying volume (>$500K/month), Plaid underwrites the return — originator is made whole; user never sees the clawback."
- "Same-day ACH is GA. RTP and FedNow via Transfer are Limited Availability — do not commit timelines without Transfer PM confirmation."
- "Transfer and Auth share the same session token — no separate verification step or processor token. This is structurally different from Stripe ACH or Dwolla."

## Proof Points & ROI Metrics
<!-- ⚠️ HUMAN-OWNED — every claim requires a Source. AI adds [DRAFT] rows only.
     External use: confirm with CS before naming customer logos in customer-facing decks. -->

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| Transfer volume processed in 2025 | >$18B | SKO 2026 deck (Drive) | high | 2026-05-26 |
| ACH network institutions on Transfer | 800+ | SKO 2026 deck (Drive) | high | 2026-05-26 |
| ACH return rate (Transfer + Signal customers) | 0.6–1.2% | Solutions Master 2026; SKO deck | high | 2026-05-26 |
| Industry average ACH return rate (baseline) | ~3.5% | SKO 2026 deck | medium | 2026-05-26 |
| Return rate reduction (Transfer + Signal vs baseline) | 3–5× | Transfer Proof Points 2026 (Drive) | high | 2026-05-26 |
| Robinhood: ACH return rate | ~4% → under 0.8% | Transfer Win Stories Q4 2025 (Drive) | high | 2026-05-26 |
| Robinhood: brokerage funding volume via Transfer | >$2B/quarter | Transfer Win Stories Q4 2025 | high | 2026-05-26 |
| Public.com: time-to-first-deposit | 4–5 days → under 3 minutes | Transfer Win Stories Q4 2025 | high | 2026-05-26 |
| Betterment: manual review reduction (internal-only) | 72% | Transfer Win Stories Q4 2025 | high | 2026-05-26 |
| Betterment: NSF-driven return reduction (90-day cohort, internal-only) | 68% | Transfer Proof Points 2026 | high | 2026-05-26 |
| Guaranteed Transfer per-transfer limit | $25,000 | Guaranteed Transfer SLA 2026 (Confluence) | high | 2026-05-26 |
| Guaranteed Transfer SLA window | 60 days post-settlement | Guaranteed Transfer SLA 2026 | high | 2026-05-26 |
| Guaranteed Transfer volume threshold | >$500K/month ACH | Deal Structure Guide 2026 | high | 2026-05-26 |
| Network signals in `network_risk_dynamic_scoring` | 5,400+ | Solutions Master 2026; Product Brief | high | 2026-05-26 |

**Customer logo policy:** Robinhood, Public, SoFi, Acorns — referenceable for sales decks; confirm with CS for customer-facing public demos. Betterment — **internal sales decks only**, not external/public without separate approval.

## Customer Use Cases

- Brokerage account funding: Auth + Identity Match connect and verify the account → Signal scores return risk inside `/transfer/authorization/create` → Transfer initiates same-day ACH debit before market close
- Neobank DDA-to-investment transfer: one Plaid Link session authenticates the external DDA; Signal pre-screens; Transfer initiates with Plaid absorbing return risk for qualifying volume
- Lending disbursement (credit push): `type: "credit"` pushes loan proceeds to borrower's verified account on same-day ACH or RTP (LA); Auth + Identity Match confirm ownership at disbursement time

### Brokerage Account Funding (Investment Platform)
**Persona:** Head of Payments at investment platform (Robinhood/Public-class)
**Problem:** ACH returns erode trust and capital — by the time a return posts (3+ days later), the user has churned and the funds are gone
**Solution:** Plaid Link (Auth + Identity) connects the account in seconds → Identity Match confirms ownership → Signal scores the return risk → Transfer same-day ACH funds the brokerage account before market close, with Plaid underwriting the return risk
**Outcome:** Robinhood: ACH return rate from ~4% to <0.8%, >$2B/quarter funded via Transfer

### Neobank DDA-to-Investment Transfer
**Persona:** VP Engineering at neobank
**Problem:** Moving money from primary checking to a managed investment account requires re-auth and exposes the bank to ACH return liability
**Solution:** One Plaid Link session authenticates BOTH the external DDA and the investment account; Signal pre-screens each transfer; Transfer initiates same-day ACH with `guarantee_decision: GUARANTEED` for qualifying volume
**Outcome:** Zero re-auth friction, return risk absorbed by Plaid, manual review queue eliminated

### Lending Disbursement (Credit Push)
**Persona:** Lending platform operations lead
**Problem:** Same-day loan disbursement is operationally expensive and exposes the lender to risk if the destination account closes between underwriting and payout
**Solution:** Transfer `type: "credit"` pushes loan proceeds to the borrower's verified account on same-day ACH (or RTP if Limited Availability access is provisioned); Auth + Identity Match confirm the account ownership at disbursement time, not at application time
**Outcome:** Same-day disbursement at scale, no destination-account verification step

## Narration Talk Tracks
<!-- ⚠️ HIGHEST PRIORITY for script generation — word-perfect, max 35 words each.
     The script generator uses these verbatim before any other source.
     HUMAN-OWNED — AI must not modify approved blocks. -->

- Beat 1 (post-Link): "Jenna connects her checking account through Plaid Link — authenticated in seconds, no micro-deposits."
- Beat 3A (authorization — Pattern A default): "Plaid authorizes the debit — Signal clears the transfer, low return risk, approved."
- Beat 4 (transfer create): "Transfer initiates: same-day ACH, $100, pending. Jenna's funds are on their way."
- Closing (Fund & Protect): "Account verified. Identity confirmed. Signal-backed authorization. Money moved — ACH or RTP, one SDK, one data network, no ACH blind spots."

### Account funding (debit) — 5-beat demo (PMM-validated)

**Beat 1 — Account connection (post-Link step):**
> "Jenna connects her checking account through Plaid Link — authenticated in seconds, no micro-deposits." (15 words)

**Beat 2 — Identity confirmation (optional but recommended):**
> "Plaid confirms Jenna is the account owner — name, address, and phone all match." (14 words)

**Beat 3 — Authorization** *(pattern A, production-realistic default):*
> "Plaid authorizes the debit — Signal clears the transfer, low return risk, approved." (13 words)

**Beat 3 alternative — Explicit Signal score** *(pattern B, only when a separate /signal/evaluate panel is shown on its own step):*
> "Signal evaluates the transfer in real time — score of 12, low return risk — ACCEPT." (15 words)

> ⚠️ **API shape boundary (verified via AskBill, 2026-05-26):** `/transfer/authorization/create` does NOT expose raw Signal scores in its response. Pattern A panels show `authorization.decision` + `decision_rationale` only; the Signal verdict is reflected in those fields (rationale code becomes `PAYMENT_RISK` / `RISK_SCORE_EXCEEDED_THRESHOLD` on a Signal-driven decline). Pattern B is a *separate* `/signal/evaluate` panel on a *separate* demo step — never a nested `signal: {…}` block inside an authorization response. Demos that show numeric Signal scores require Pattern B.

**Beat 4 — Transfer initiation:**
> "Transfer initiates: same-day ACH, $100, pending. Jenna's funds are on their way." (13 words)

**Beat 5 — Settlement confirmation:**
> "Settled. Funds are available on the Plaid ledger, ready to sweep to treasury." (13 words)

### Account disbursement (credit) — 3-beat alternate closing

**Beat 1 — Prefund ledger (optional on-screen):**
> "Treasury prefunds the Plaid ledger from the commercial account — funds available for instant payout." (15 words)

**Beat 2 — RTP credit (when capabilities check supports RTP):**
> "Plaid checks RTP capability, authorizes the credit, and pays $50 to Jenna's account — instant." (15 words)

**Beat 3 — Settlement (RTP single beat covers both):**
> "Settled. Real-time payment delivered in seconds, ledger updated, ready for the next payout." (13 words)

### Demo closing (Fund & Protect summary, ≤35 words)
> "Account verified. Identity confirmed. Signal-backed authorization. Money moved — ACH or RTP, from your ledger or your treasury account. One SDK, one data network, no ACH blind spots." (28 words)

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names.
     Build agents and script generator must use these exactly. -->

### Endpoints (use exactly)

**Linking + identity:**
- `POST /link/token/create` — `products: ["transfer", "signal"]`, `required_if_supported_products: ["identity"]`
- `POST /item/public_token/exchange` — exchange `public_token` for `access_token`
- `POST /identity/get` — raw owner attributes (names guaranteed; emails/phones/addresses may be empty)
- `POST /identity/match` — per-field match scores (0–100 on legal_name, phone_number, email_address, address)

**Money movement:**
- `POST /transfer/authorization/create` — Signal-backed risk + permission check; runs Transfer Signal Rulesets internally
- `POST /transfer/create` — initiates money movement (requires `approved` `authorization_id`)
- `POST /transfer/get` — fetch single transfer state
- `POST /transfer/event/sync` — fetch new events after `TRANSFER_EVENTS_UPDATE` webhook
- `POST /transfer/capabilities/get` — check `institution_supported_networks` before RTP authorization
- `POST /transfer/intent/create` — hosted Transfer UI flow (alternative integration pattern)

**Ledger + reconciliation:**
- `POST /transfer/ledger/deposit` — commercial → ledger prefund (sweep.amount NEGATIVE)
- `POST /transfer/ledger/withdraw` — ledger → commercial sweep (sweep.amount POSITIVE)
- `POST /transfer/ledger/get` — read balance.available + balance.pending
- `POST /transfer/sweep/list` — reconciliation against bank statement

**NEVER use `/transfer/initiate`** — that is the deprecated endpoint name. Correct is `/transfer/create`.

### `/transfer/authorization/create` decision values
- `approved` — proceed to `/transfer/create`
- `declined` — do NOT call `/transfer/create`; see rationale codes below
- `user_action_required` — relaunch Plaid Link with `transfer.authorization_id` for re-auth

### `decision_rationale.code` (verified via AskBill, 2026-05-26)
| Code | Decision | Meaning |
|---|---|---|
| `MANUALLY_VERIFIED_ITEM` | approved | Account was manually verified; Signal could not run. Rationale is populated even though approved. |
| `ITEM_LOGIN_REQUIRED` | declined | Credentials expired — re-auth via Link before retry. |
| `MIGRATED_ACCOUNT_ITEM` | approved | Item was migrated; partial Signal coverage. |
| `PAYMENT_RISK` | declined | Risk evaluation declined the transfer. **This is the rationale code surfaced when Signal's internal evaluation flags the transfer.** |
| `NSF` | declined | Insufficient-funds signal. |
| `RISK_SCORE_EXCEEDED_THRESHOLD` | declined | Signal score exceeded the customer-configured risk threshold. |
| `TRANSFER_LIMIT_REACHED` | declined | Customer-configured transfer ceiling hit. |
| `ERROR` | mixed | Plaid couldn't run full risk check; add extra diligence client-side. |
| `null` | approved | Clean approval — no special rationale needed (default for the happy-path demo). |

### `/transfer/authorization/create` response — fields to surface
- `authorization.id` — always show
- `authorization.created` — ISO 8601 timestamp
- `authorization.decision` — `approved` (happy path) | `declined` | `user_action_required`
- `authorization.decision_rationale` — `null` on clean approve; on decline (or special approve cases) populated with `{ code, description }`
- `authorization.proposed_transfer` — echoes the request parameters (type, network, ach_class, amount, iso_currency_code, account_id, funding_account_id, user, user_present, origination_account_id)
- `request_id` — always present
- **NOT in the response:** the authorization endpoint does NOT carry a standalone Signal payload (`scores.*`, `ruleset.result`, `core_attributes`, `reason_codes[]`, `warnings[]`). Signal runs internally inside the authorization engine — its verdict is communicated via `decision` + `decision_rationale.code`. Numeric scores live only on a standalone `/signal/evaluate` response (pattern B), which is a separate API call and must be a separate demo step / separate API panel.

### `/transfer/create` response — fields to surface in API panel
- `transfer.id` — always show
- `transfer.authorization_id` — links back to the authorization
- `transfer.status` — `pending` on initiation, `settled` on confirmation step (never `returned` in happy path)
- `transfer.network` — `ach` | `same-day-ach` | `rtp` | `fedNow`
- `transfer.amount`, `transfer.ach_class`, `transfer.description`
- `transfer.expected_settlement_date`, `transfer.standard_return_window`
- `transfer.guarantee_decision` — may be `null`; populated only when guaranteed-transfer tier applies (>$500K/month volume customers)

### Network (rail) values
- `ach` — standard ACH, 2–3 business days, GA
- `same-day-ach` — same business day if before cutoff, GA, no surcharge in most deal structures
- `rtp` — Real-Time Payments, **Limited Availability** (credit-only)
- `fedNow` — FedNow, **Limited Availability** (credit-only)
- `wire` — credit-only, early access

### `ach_class` values (per SEC code on authorization capture)
- `web` — consumer-authorized online transfer (default for consumer debits)
- `ppd` — prearranged payment/deposit (consumer credits; required on ACH credit)
- `ccd` — corporate credit/debit (B2B)
- `tel` — telephone-authorized

### Transfer status lifecycle
- `pending` → `posted` (ACH submitted) → `settled` (cleared) — happy path
- `pending` → `posted` → `returned` — failure (never show in main demo)
- `cancelled` — within cancellation window via `/transfer/cancel`
- `failed` — pre-network failure

### Webhook
- `webhook_type: "TRANSFER"`, `webhook_code: "TRANSFER_EVENTS_UPDATE"` — fires on any status change; consumer calls `/transfer/event/sync` (with `after_id`) to fetch new events

### Approved demo values (default = pattern A, production-realistic)

**Authorization response (always shown):**
| Field | Demo value |
|---|---|
| `authorization.decision` | **`approved`** |
| `authorization.decision_rationale` | **`null`** |
| `proposed_transfer.type` | `debit` (Swimlane 2) / `credit` (Swimlane 3) |
| `proposed_transfer.network` | `same-day-ach` (default), or `rtp` (when capabilities check supports RTP credit) |
| `proposed_transfer.ach_class` | `web` (debit) / `ppd` (credit) |
| `proposed_transfer.amount` | `"100.00"` (debit funding) / `"50.00"` (credit payout) |

**Transfer create response (always shown):**
| Field | Demo value |
|---|---|
| `transfer.status` | `pending` (initiation) → `settled` (confirmation) |
| `transfer.network` | matches `proposed_transfer.network` |
| `transfer.cancellable` | `true` (on `pending`) |
| `transfer.guarantee_decision` | `null` for most demos (populated only when guaranteed-transfer tier applies — see Implementation Pitfalls) |

**Identity Match response (when shown):**
| Field | Demo value |
|---|---|
| `accounts[].legal_name.score` | 98 (or 100) |
| `accounts[].phone_number.score` | 100 |
| `accounts[].email_address.score` | 100 |
| `accounts[].address.score` | 100 (with `is_postal_code_match: true`) |

**Standalone Signal response (pattern B only, when a /signal/evaluate panel is shown):**
| Field | Demo value |
|---|---|
| `scores.consumer_initiated.score` | 12 (ACCEPT range 5–20) |
| `ruleset.result` | `ACCEPT` (never `REJECT`) |
| `core_attributes` | populated per Signal docs (do NOT fabricate `reason_codes[]`) |

## Link Products & Token Configuration
<!-- ⚠️ HUMAN-OWNED — canonical /link/token/create products[] for Transfer demos -->

**Canonical Transfer Link token** (ground truth, May 2026):
```json
{
  "products": ["transfer", "signal"],
  "required_if_supported_products": ["identity"],
  "redirect_uri": "https://yourapp.com/oauth-return",
  "user": {
    "client_user_id": "user-...",
    "legal_name": "Jenna Doe",
    "email_address": "jenna@example.com",
    "phone_number": "+14155551212"
  }
}
```

**Key rules:**
- `products: ["transfer", "signal"]` — Transfer + Signal initialized on every Item. Auth coverage is implicit in the Transfer product; do **NOT** add `"auth"` explicitly (it narrows the institution list unnecessarily).
- `required_if_supported_products: ["identity"]` — Identity is requested when the institution supports it without blocking Link at institutions that don't. Required for downstream `/identity/match`.
- `redirect_uri` — required for OAuth institutions (Chase, Capital One). Must exactly match a URI configured in the Plaid Dashboard.
- **Hosted Transfer UI** is a separate pattern: use `products: ["transfer"]` + `transfer.intent_id` from a prior `/transfer/intent/create` call. Pipeline demos default to the programmatic flow above, not the hosted UI.

**Mutual exclusion:** Transfer demos are non-CRA. Do NOT mix `transfer` with `cra_base_report`, `cra_income_insights`, or `income_verification` in the same Link token.

## Canonical API Sequence (Three Swimlanes)
<!-- The pipeline build agent uses this verbatim. Each swimlane is an independent
     phase — do not chain them in a single uninterrupted narration. -->

The Transfer flow has three swimlanes, run in independent demo phases. Most demos use Swimlane 1 + Swimlane 2 (funding-only). Add Swimlane 3 only when the prompt explicitly includes payouts, disbursement, or credit push.

### Swimlane 1 — Initial Bank Account Linking
```
1. POST /link/token/create   products: ["transfer", "signal"]
                             required_if_supported_products: ["identity"]
2. Plaid Link flow           onSuccess(public_token, metadata)
3. POST /item/public_token/exchange   → access_token, item_id
```

### Swimlane 2 — Account Funding (ACH debit + ledger withdraw)
```
4.  POST /identity/get                   → owner.names[], emails[], phones[], addresses[]   (raw attributes)
5.  POST /identity/match                 → per-field scores (legal_name.score, phone_number.score, ...)
6.  Collect + store NACHA proof of authorization (consumer ACH debit; retain 2+ years)
7.  POST /transfer/authorization/create
        type: "debit", network: "ach" | "same-day-ach", ach_class: "web"
        amount, user.legal_name, user_present: true
        idempotency_key (unique per authorization)
        ruleset_key (optional Dashboard ruleset for Signal evaluation)
                                         → authorization.id, authorization.decision,
                                           authorization.decision_rationale, proposed_transfer
8.  POST /transfer/create                authorization_id, access_token, account_id, description
                                         → transfer.id, transfer.status: "pending"
9.  Webhook TRANSFER_EVENTS_UPDATE → POST /transfer/event/sync (after_id, count)
                                         → events: pending → posted → settled / funds_available
10. POST /transfer/ledger/withdraw       amount, network, idempotency_key,
                                         funding_account_id, ledger_id
                                         → sweep.id, sweep.amount (positive), sweep.status: "pending"
11. POST /transfer/sweep/list            (optional, for bank statement reconciliation)
```

### Swimlane 3 — Account Disbursement (ledger deposit + ACH or RTP credit)
```
1. POST /transfer/ledger/deposit         amount, network, idempotency_key,
                                         funding_account_id
                                         → sweep.amount NEGATIVE (debit from commercial),
                                           sweep.status: "pending" (terminal: "funds_available")
2. POST /transfer/ledger/get             → balance.available, balance.pending
                                         (call after deposit settles, AND immediately
                                         before each credit authorization)
3. POST /transfer/capabilities/get       access_token, account_id
                                         → institution_supported_networks: rtp.credit,
                                           same_day_ach.{debit,credit}, ach.{debit,credit}
                                         (run before requesting network: "rtp")
4. POST /transfer/authorization/create
        type: "credit"
        network: "rtp" (if supported) | "ach" | "same-day-ach"
        ach_class: "ppd"  (required on ACH credits)
        amount, user.legal_name, user_present: false
        idempotency_key
        credit_funds_source: "ledger"   (defaults to "sweep" which pulls from commercial)
                                         → authorization.decision: "approved"
5. POST /transfer/create                 authorization_id  → transfer.status: "pending"
6. Webhook TRANSFER_EVENTS_UPDATE → POST /transfer/event/sync  → credit events: posted → settled
```

### Integration order rules
- `/identity/get` returns RAW attributes (names guaranteed; emails/phones/addresses may be empty). `/identity/match` returns SCORES (0–100 per field). Both endpoints accept `access_token`.
- `/identity/match` is OPTIONAL but recommended — it produces the "owner verified" narrative beat and gates onboarding before debit.
- `/transfer/authorization/create` runs Signal **internally** via Transfer Signal Rules configured in the Dashboard. A standalone `/signal/evaluate` call is **NOT** part of the production flow (see § Signal-via-Transfer below).
- `ruleset_key` on authorization selects a specific Dashboard ruleset; omit for default ruleset.
- `user_present: true` for debits (user is in session); `false` for credits / payouts.
- Every `/transfer/authorization/create` requires a unique `idempotency_key`. Ledger `deposit` and `withdraw` also require `idempotency_key`.
- For RTP credits: ALWAYS call `/transfer/capabilities/get` first; fall back to `ach` or `same-day-ach` if `rtp.credit` is not supported.
- `credit_funds_source: "ledger"` is required for ledger-funded payouts; without it, Plaid pulls from the commercial funding account via a sweep.
- Transfer initiation only after `authorization.decision === "approved"` AND `authorization.decision_rationale === null` (non-null rationale on approved means Plaid couldn't run full risk check; apply your own policy).

## Signal-via-Transfer (critical correction to prior Solutions Master narratives)
<!-- Ground truth, May 2026 — supersedes any internal narrative showing /signal/evaluate
     as a standalone step in the Transfer flow. -->

Signal in the Transfer flow runs **inside `/transfer/authorization/create`** via rulesets configured in the Plaid Dashboard (Signal → Rules). The authorization response surfaces:
- `authorization.decision` — `approved` | `declined` | `user_action_required`
- `authorization.decision_rationale` — `null` on clean approve; on decline always populated with `{ code, description }`
- `authorization.proposed_transfer` — echoes the transfer parameters

The authorization response does **NOT** carry the standalone Signal payload: no `scores.consumer_initiated.score`, no `ruleset.result`, no `core_attributes`, no `reason_codes[]`, no `warnings[]`. Those fields exist only on a standalone `/signal/evaluate` response.

### Two demo patterns

- **Pattern A — production-realistic (default):** API panel shows `/identity/match` → `/transfer/authorization/create` (`decision: approved`, `decision_rationale: null`) → `/transfer/create` (`status: pending`). Narration carries the Signal beat without a separate Signal API panel.
- **Pattern B — explicit Signal score visualization:** Add `/signal/evaluate` BEFORE the authorization to surface the raw score (e.g. `scores.consumer_initiated.score: 12`, `ruleset.result: ACCEPT`). This is a demo affordance, not production sequencing. Narration must acknowledge: "Here we surface the Signal score explicitly; in production this evaluation runs inside Transfer authorization."

Build agents default to pattern A. Use pattern B only when the prompt explicitly asks for a Signal score beat.

### `decision_rationale.code` values
| `decision` | rationale code | Meaning |
|---|---|---|
| `declined` | `NSF` | Insufficient funds |
| `declined` | `PAYMENT_RISK` | Signal ruleset flagged high risk — **use `PAYMENT_RISK`, not `RISK`** (AskBill-verified 2026-05-31) |
| `declined` | `RISK_SCORE_EXCEEDED_THRESHOLD` | Signal score exceeded the customer-configured risk threshold |
| `declined` | `TRANSFER_LIMIT_REACHED` | Customer-configured limit exceeded |
| `approved` (non-null rationale) | `MANUALLY_VERIFIED_ITEM` | Couldn't run full risk — apply own policy |
| `approved` (non-null rationale) | `ITEM_LOGIN_REQUIRED` | Auth lapsed; relink for next attempt |
| `approved` (non-null rationale) | `MIGRATED_ACCOUNT_ITEM` | Risk check skipped |
| `approved` (non-null rationale) | `ERROR` | Risk pipeline error |
| `user_action_required` | (rationale present) | Relaunch Link with `transfer.authorization_id` |

## Ledger Model (Transfer flow of funds)

Plaid Transfer maintains a per-customer **ledger** balance distinct from the commercial funding account:

| Movement | Endpoint | `sweep.amount` sign | Use |
|---|---|---|---|
| Commercial → Ledger (prefund) | `POST /transfer/ledger/deposit` | NEGATIVE | Prefund before credit payouts |
| Ledger → Commercial (sweep) | `POST /transfer/ledger/withdraw` | POSITIVE | Sweep settled inbound debits to treasury |
| Read balance | `POST /transfer/ledger/get` | n/a | `balance.available` + `balance.pending` |
| List sweeps | `POST /transfer/sweep/list` | n/a | Bank reconciliation (match via first 8 chars of `sweep.id`) |

Reconciliation rule: match bank statement line items against the first 8 characters of `sweep.id`. The `description` field on `ledger/deposit` and `ledger/withdraw` is capped at 10 characters and appears on the originating side of the ACH for reconciliation.

## NACHA Proof of Authorization

For consumer ACH debits the originator MUST collect and store proof of authorization (POA) for at least 2 years per NACHA rules. POA capture is upstream of `/transfer/authorization/create`. The `ach_class` value on the authorization signals the SEC code the authorization was collected under:
- `web` — internet authorization (default for consumer online)
- `ppd` — prearranged payment/deposit (consumer credit, recurring authorized)
- `tel` — telephone-authorized
- `ccd` — corporate (B2B)

## Competitive Differentiators

- **Account connectivity built-in.** Auth and Transfer share the same session token — no separate verification step or micro-deposits. Structurally different from Stripe ACH (requires its own verification) and Dwolla (separate identity step).
- **Pre-send risk scoring.** Signal evaluates risk before `/transfer/create` — Stripe's "optimized ACH" cannot replicate cross-network signals without the connectivity layer. 5,400+ network behavioral features.
- **Guaranteed Transfer SLA** — Plaid underwrites the return for qualifying volume (>$500K/month). Plaid absorbs the clawback; originator is made whole. No analogue at Stripe, Dwolla, or Modern Treasury.
- **Network coverage** — 95%+ of US DDA accounts via Plaid network; 800+ institutions live on Transfer ACH network (2025).
- **Same SDK across the funding stack** — one integration covers Link + Auth + Identity Match + Signal + Transfer. Vendors like Modern Treasury (treasury ops) and Dwolla (ACH-only) require additional stacks for account verification + risk.

## Implementation Pitfalls
<!-- ⚠️ Product-specific mistakes to avoid in prompts, scripts, and demos -->

### Endpoint + sequence
- **DO NOT** call the endpoint `/transfer/initiate` — that name is deprecated. Correct: `POST /transfer/create`.
- **DO NOT** call `/transfer/create` before `/transfer/authorization/create` returns `decision: "approved"`. Decisioning happens at authorization, not at create.
- **DO NOT** call `/transfer/create` when `decision: "approved"` carries a non-null `decision_rationale` without applying client-side diligence first — non-null on approved means Plaid couldn't run the full risk check.
- **DO NOT** reuse `idempotency_key` across distinct authorization attempts — every `/transfer/authorization/create` and every ledger `deposit`/`withdraw` requires a unique key.

### Signal-via-Transfer (read § Signal-via-Transfer above)
- **DO NOT** surface standalone Signal fields (`scores.*`, `ruleset.result`, `core_attributes`, `reason_codes[]`, `warnings[]`) inside an `/transfer/authorization/create` response panel — those exist only on a standalone `/signal/evaluate` response (pattern B). The authorization carries `decision`, `decision_rationale`, `proposed_transfer` only.
- **DO NOT** show `ruleset.result: REJECT` — not a documented Signal value. Use `REROUTE` or render the host-app decision outside the API panel.
- Signal scores for ACCEPT path: use **5–20**. Scores 80+ are high-risk territory — they should map to REROUTE, not ACCEPT.
- Signal "warm-up period" misconception: Signal scores on the FIRST call using network signals. No 30-day warming required. Address this objection proactively in deal calls.

### Link products
- **DO NOT** add `"auth"` to `products[]` — Auth coverage is implicit in the Transfer product. Adding `auth` narrows the institution list unnecessarily.
- Canonical: `products: ["transfer", "signal"]` + `required_if_supported_products: ["identity"]`.
- **DO NOT** include `cra_base_report` / `cra_income_insights` / `income_verification` in the same Link token as `transfer` — incompatible.
- For OAuth institutions (Chase, Capital One): `redirect_uri` must exactly match a URI configured in the Plaid Dashboard.

### Rails (GA vs LA)
- **DO NOT** label RTP or FedNow as GA — both are **Limited Availability** as of May 2026. Use `same-day-ach` for speed narratives. Mark "limited availability" or "coming soon" if RTP/FedNow must appear.
- **DO NOT** request `network: "rtp"` on a credit without first calling `/transfer/capabilities/get` — fall back to `ach` or `same-day-ach` when `rtp.credit` is not supported.

### Ledger model
- **DO NOT** call `/transfer/authorization/create` with `credit_funds_source: "ledger"` before confirming `/transfer/ledger/get` shows sufficient `balance.available` — insufficient ledger triggers a decline.
- **DO NOT** show `sweep.amount` POSITIVE on a `/transfer/ledger/deposit` — deposits are NEGATIVE (debit from commercial). Withdraws are POSITIVE.
- Ledger sweep `description` field is capped at **10 characters**.
- Match bank statement lines against the first **8 characters** of `sweep.id` for reconciliation.

### NACHA + authorization
- Consumer ACH debits require NACHA proof of authorization (POA) **retained 2+ years**. POA capture is upstream of `/transfer/authorization/create`.
- `ach_class` on the authorization must match the SEC code the POA was collected under: `web` (internet), `ppd` (recurring authorized), `tel` (telephone), `ccd` (B2B).
- `user_present: true` for debits (user in session); `false` for credits/payouts.

### Identity Match
- `legal_name.score`, `phone_number.score`, `email_address.score`, `address.score` are each **0–100** (higher = better). Threshold for "likely match" is 70+.
- Per-field scores can be `null` when the institution does not have that attribute on file. Names are guaranteed; emails/phones/addresses may be empty.
- Identity Match does NOT run inside `/transfer/authorization/create` — it is an explicit upstream call you make yourself.

### Demo discipline
- **DO NOT** show an ACH return in the main demo flow — happy path always ends in `transfer.status: settled`.
- **DO NOT** show `decision: declined` in the happy path. If a "risk decline" beat is requested, use `declined` + `RISK` rationale and show a host-app review step.
- **DO NOT** show Transfer for international or non-USD use cases. US-only, USD-only.
- **DO NOT** show wire transfers or B2B treasury (>$25K) — not what Transfer is for.
- **DO NOT** use "Plaid's ACH network" language — overstates ownership. Approved phrasing: "Plaid Transfer on ACH rails".

### `guarantee_decision` clarification
- `transfer.guarantee_decision` is `null` for most demos. It is populated only when the customer is on the **guaranteed-transfer tier** (>$500K/month volume). When populated, values are `GUARANTEED` | `NOT_GUARANTEED` | `RETURN_ESTIMATED`. Default Transfer demos should NOT show `guarantee_decision: GUARANTEED` unless the persona is explicitly on the volume tier.

## Objections & Responses
<!-- 🔄 SHARED — sourced from Gong analysis Q4 2025; approved for AE use 2026 -->

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| "We already use Stripe ACH" (41% of competitive calls) | "Stripe is a payment processor with ACH as a feature; Plaid is an account-level data network that happens to move money. Signal pre-screening is the moat — Stripe can't replicate network-level signals without the bank connectivity layer." | Gong Q4 2025 | ✅ Approved |
| "Our bank handles transfers" (28%) | "Banks see your own ACH history. Plaid Signal sees 5,400 cross-network signals across the entire Plaid network — your bank doesn't know if this user just had three ACH returns at another institution this week." | Gong Q4 2025 | ✅ Approved |
| "Same-day ACH cost is too high" (19%) | "One avoided ACH return pays for dozens of same-day transfers. With Signal pre-screening, return rates drop from ~3.5% to 0.6–1.2% — the math favors same-day at volume." | AE Objection Playbook 2026 | ✅ Approved |
| "We don't want another vendor" (16%) | "Transfer is additive to your existing ACH rails, not a replacement. Run a parallel pilot on a new user cohort and compare return rates side-by-side." | AE Objection Playbook 2026 | ✅ Approved |
| "What about same-day vs next-day cost?" | "Same-day adds certainty for market-exposure cases like investment funding. Surcharge is typically $0.10–$0.25 per transfer, absorbed within avoided-return economics at volume." | AE Objection Playbook 2026 | ✅ Approved |
| "FedNow isn't live yet" | "Correct — RTP and FedNow via Transfer are Limited Availability. ACH (standard and same-day) is fully GA today, and same-day is the typical hero rail in production." | AE Objection Playbook 2026 | ✅ Approved |
| "How does guaranteed transfer work?" | "For qualifying volume (>$500K/month), Plaid underwrites the return. If a transfer returns, Plaid credits the originator for the face value. It's an SLA, not insurance — you keep the funds, Plaid handles the clawback." | AE Objection Playbook 2026 | ✅ Approved |
| "Doesn't Signal need a warm-up period to work?" | "Signal scores on the first call using network signals — no 30-day warming. This is a common misconception flagged in Nov 2025 deal reviews as a deal blocker." | Gong Nov 2025 (Slack #transfer-deals) | ✅ Approved |
| "We use Modern Treasury already" | "MT is a treasury orchestration tool for finance teams. Transfer is a consumer funding tool for product teams. They're not competitive — they can coexist in the same stack." | Competitive Intel Doc 2026 | ✅ Approved |

## AI Research Notes
<!-- 🤖 AI-OWNED — auto-populated by research.js. Human reviews but does not need to edit.
     Entries accumulate — do not remove. -->

### 2026-05-26 — Initial PK file created from Glean + AskBill research [pipeline-research]
Cross-confirmed across:
- **Confluence:** GTM Playbook 2026; Solutions Master 2026 — Transfer; Transfer Pricing & Packaging Internal Reference; Transfer GA/LA Status Register May 2026; Fund & Protect Integration Architecture; Transfer + Signal Demo Builder Reference; Transfer Guaranteed Transfer SLA; Transfer Webhooks and Event Types; `network_risk_dynamic_scoring` Product Brief; Customer Logo Usage Policy.
- **Drive:** Transfer Product Positioning Brief Q1 2026; Transfer vs Competitors AE Quick Reference; Transfer Win Stories Q4 2025/Q1 2026; Transfer Proof Points for Sales Decks 2026; Stripe vs Plaid Transfer Battlecard Feb 2026; 2026 SKO Transfer Deck; Transfer Demo Script + Talk Track SE 2026; Transfer Customer Reference List Jan 2026; Transfer Objection Handling Gong Q4 2025; AE Objection Playbook 2026.
- **AskBill (Plaid docs MCP):** Transfer endpoints, network values, authorization decision flow, Signal-under-the-hood behavior of `/transfer/authorization/create`, Identity Match scoring response shape, canonical 5-beat narration, `/transfer/intent/create` hosted UI flow.

Confidence summary:
- GTM positioning, canonical API sequence, talk tracks: HIGH
- Customer proof points (Robinhood, Public, Betterment): HIGH internally; external use requires CS confirmation
- Pricing specifics (per-transfer rates): LOW — owned by deal desk
- RTP/FedNow LA status: HIGH (May 2026 register)
- `network_risk_dynamic_scoring` GA: HIGH (Q4 2025 confirmed)

## Change Log

- 2026-05-26: File created from Glean + AskBill research [pipeline-research]
