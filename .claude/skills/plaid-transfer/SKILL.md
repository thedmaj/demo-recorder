---
name: plaid-transfer
description: >-
  Plaid Transfer integration patterns for pipeline demos — API sequencing with
  Auth, Identity Match, and Signal-via-Transfer. Load when authoring or
  critiquing demos that include account funding (ACH debit), account
  disbursement (ACH or RTP credit), the Plaid ledger model, or the
  "Fund & Protect" bundle. Enforces ground-truth Link product configuration,
  three-swimlane phasing, ledger semantics, and the rule that Signal runs
  INSIDE /transfer/authorization/create (not as a separate /signal/evaluate
  call in production).
---

# Plaid Transfer (pipeline)

Plaid Transfer is an embedded A2A payment product — bank-to-bank money movement on ACH (GA), Same-Day ACH (GA), RTP and FedNow (Limited Availability). In the canonical Transfer flow, **Signal runs as part of `/transfer/authorization/create` via Transfer Signal Rules** configured in the Plaid Dashboard. A standalone `/signal/evaluate` call is **NOT** part of the production Transfer sequence.

**Full product knowledge:** [`inputs/products/plaid-transfer.md`](../../../inputs/products/plaid-transfer.md). This skill is the build/script-agent-facing summary, organized as the operator implements it: linking, then debit funding, then credit disbursement.

## When to load this skill

- Prompt mentions Transfer, "account funding", "ACH debit", "ACH credit", "RTP payout", "instant deposit", "ledger withdraw", "treasury sweep", "Fund & Protect"
- `inputs/prompt.txt` includes Transfer in "Solutions supported"
- `link-token-create-config.json` resolves to `transfer` family or `products[]` contains `"transfer"`
- `demo-script.json` has any step with `apiResponse.endpoint` matching `transfer/(authorization|create|get|event|ledger|sweep|capabilities)`
- Critiquing a demo that surfaces an `authorization.decision` field

**Companion skills:**
- `plaid-integration.skill` — sandbox credentials, Link narration boundary, recording rules
- `inputs/products/plaid-signal.md` — Signal score semantics (5–20 = low risk; never `REJECT`)
- `inputs/products/plaid-auth.md` — Account verification semantics

---

## The three swimlanes (canonical Transfer flow)

Every Transfer demo is one or more of these three independent phases. Each swimlane is a separate implementation track; do not mix them in a single API panel sequence.

### Swimlane 1 — Initial Bank Account Linking

User connects a bank account. Output: `access_token` + `account_id`.

```
1. POST /link/token/create
       products: ["transfer", "signal"]
       required_if_supported_products: ["identity"]
       redirect_uri: <OAuth return URI> (for OAuth institutions)
       user: { client_user_id, ...optional PII for Identity Match later }
2. Initialize Plaid Link with link_token
3. User authenticates → onSuccess(public_token, metadata)
4. POST /item/public_token/exchange
       public_token  →  access_token, item_id
```

**Link products rule:** Use `["transfer", "signal"]` and add Identity only via `required_if_supported_products: ["identity"]` — that way Link is NOT blocked at institutions that don't support Identity. Institutions shown in Link must support **every** product in `products`; products in `required_if_supported_products` are requested when available without narrowing the institution list.

### Swimlane 2 — Account Funding (ACH debit + ledger withdraw)

User pulls funds from their bank account into the Plaid ledger; you then sweep settled balance to your commercial funding account.

```
1. POST /identity/get             access_token
                                  → owner names, emails, phone_numbers, addresses (raw attributes)
2. POST /identity/match           access_token + user { legal_name, phone_number, email_address, address }
                                  → per-account scores: legal_name.score, phone_number.score,
                                    email_address.score, address.score (each 0–100)
3. Collect + store NACHA proof of authorization for the debit
                                  (consumer ACH debits require POA retained 2+ years)
4. POST /transfer/authorization/create
       type: "debit"
       network: "ach"  (or "same-day-ach")
       ach_class: "web"  (or "ppd"/"tel"/"ccd" per SEC rules)
       amount: "100.00"
       user: { legal_name: "Jane Smith" }
       user_present: true
       idempotency_key: "<unique per authorization>"
       ruleset_key: "<Dashboard ruleset>"  (optional; omit for default)
                                  → authorization.id, authorization.decision,
                                    authorization.decision_rationale, proposed_transfer
5. POST /transfer/create
       authorization_id: <from step 4>
       access_token, account_id
       description: "<≤15 chars on bank statement>"
                                  → transfer.id, transfer.status: "pending", transfer.network,
                                    transfer.amount, ach_class, standard_return_window,
                                    expected_settlement_date
6. (later) Webhook TRANSFER_EVENTS_UPDATE  →  POST /transfer/event/sync (after_id, count)
                                  → events with event_type: posted, settled, funds_available, returned
7. POST /transfer/ledger/withdraw
       amount: "<settled balance to sweep>"
       network: "ach" | "same-day-ach" | "rtp" | "wire"
       idempotency_key: "<unique>"
       funding_account_id: "<commercial bank account>"
       ledger_id: "<optional, defaults to default ledger>"
       description: "<≤10 chars>"
                                  → sweep.id, sweep.amount (positive on withdraw),
                                    sweep.status: "pending"
8. POST /transfer/sweep/list      (optional, for reconciliation; match bank lines via
                                  the first 8 characters of sweep.id)
```

### Swimlane 3 — Account Disbursement (ledger deposit + ACH or RTP credit)

You prefund the Plaid ledger from your commercial account, confirm balance, then push credits to user accounts on RTP (if supported) or ACH.

```
1. POST /transfer/ledger/deposit
       amount: "<prefund amount>"
       network: "ach" | "same-day-ach"
       idempotency_key: "<unique>"
       funding_account_id: "<commercial bank>"
       description: "<≤10 chars>"
                                  → sweep.amount NEGATIVE (debit from commercial),
                                    sweep.status: "pending"
                                    (terminal success: "funds_available")
2. POST /transfer/ledger/get      (after deposit settles, confirm balance.available;
                                  also call immediately before each credit authorization)
                                  → ledger_id, balance.available, balance.pending
3. POST /transfer/capabilities/get   access_token, account_id
                                  → institution_supported_networks:
                                    rtp.credit, same_day_ach.{debit,credit},
                                    ach.{debit,credit}
                                  (call before requesting network: "rtp" on a credit)
4. POST /transfer/authorization/create
       type: "credit"
       network: "rtp" (if supported) | "ach" | "same-day-ach"
       ach_class: "ppd"  (consumer credits; required on ACH)
       amount: "50.00"
       user: { legal_name: "Jane Smith" }
       user_present: false
       idempotency_key: "<unique per authorization>"
       credit_funds_source: "ledger"   (sources from prefunded ledger;
                                        default "sweep" pulls from commercial)
                                  → authorization.id, decision: "approved", ...
5. POST /transfer/create          authorization_id
                                  → transfer.id, transfer.status: "pending"
6. (later) TRANSFER_EVENTS_UPDATE → POST /transfer/event/sync
                                  → credit events: posted, settled
```

---

## Signal-via-Transfer (critical — read this)

**Signal is NOT a separate API call in the production Transfer flow.** It runs inside `/transfer/authorization/create` using rulesets configured in the Plaid Dashboard (Signal → Rules).

### What this means for demo authoring

- The **authorization response does NOT carry the standalone Signal payload.** No `scores.consumer_initiated.score`, no `ruleset.result`, no `core_attributes`, no `reason_codes[]`, no `warnings[]`. The authorization surfaces only:
  - `authorization.id`
  - `authorization.decision` — `approved` | `declined` | `user_action_required`
  - `authorization.decision_rationale` — `null` on a clean approve; on a decline always populated with `{ code, description }`
  - `authorization.proposed_transfer` — echoes the transfer parameters
- **Rulesets apply to debit transfers.** Customizable Signal-backed rules gate debits. Credits go through mandatory risk + compliance checks but are not subject to customer-configured Signal rulesets.
- **`ruleset_key` selects which Dashboard ruleset evaluates this authorization.** Omit to use the default ruleset.
- **Balance checks** for debits run in real time when the active ruleset includes balance-based rules AND balance checks are enabled per-ruleset in the Dashboard.

### `decision_rationale.code` values

| When | Code | Meaning |
|---|---|---|
| `decision: "declined"` | `NSF` | Insufficient funds; do not call `/transfer/create` |
| `decision: "declined"` | `RISK` | Signal ruleset flagged high risk |
| `decision: "declined"` | `TRANSFER_LIMIT_REACHED` | Customer-configured limit exceeded |
| `decision: "approved"` + non-null rationale | `MANUALLY_VERIFIED_ITEM` | Plaid couldn't run full risk check — add diligence |
| same | `ITEM_LOGIN_REQUIRED` | Auth lapsed — relink may be required for next attempt |
| same | `MIGRATED_ACCOUNT_ITEM` | Account migrated; risk check skipped |
| same | `ERROR` | Risk pipeline error; apply your own policy |
| `decision: "user_action_required"` | (rationale present) | Relaunch Plaid Link with `transfer.authorization_id` for re-auth |

### Two demo patterns

**Pattern A — Production-realistic (recommended default).** Show:
1. `/identity/match` → match scores per field
2. `/transfer/authorization/create` → `decision: "approved"`, `decision_rationale: null`
3. `/transfer/create` → `transfer.status: "pending"`

The narration carries the Signal beat ("Signal cleared this debit — score is low, risk is acceptable") without surfacing a separate Signal API panel. The authorization is the moment Signal ran.

**Pattern B — Educational / explicit Signal score visualization.** Add a `/signal/evaluate` panel BEFORE the authorization to make the score visible in the API panel. Note this is **NOT** the recommended production sequence — `/transfer/authorization/create` runs Signal internally; the extra `/signal/evaluate` call is purely a demo affordance. If you ship pattern B in a demo, the narration should say something like "Here we surface the Signal score explicitly so you can see it; in production this evaluation happens inside the Transfer authorization."

Build agents: **default to pattern A**. Only use pattern B when the prompt explicitly asks for a Signal score beat or the persona is a risk engineer who would want the score surfaced.

---

## Approved demo values (Solutions Master canonical)

These values are PMM-validated. Use them verbatim — do not invent alternatives.

| Field | Demo value | Notes |
|---|---|---|
| Identity Match `legal_name.score` | **98** (or 100) | Threshold for "likely match" is 70 |
| Identity Match `phone_number.score` | 100 | Set to `null` when phone not on file |
| Identity Match `email_address.score` | 100 | Set to `null` when email not on file |
| Identity Match `address.score` | 100 | With `is_postal_code_match: true` |
| Authorization `decision` (happy path) | **`approved`** | |
| Authorization `decision_rationale` (happy path) | **`null`** | Non-null on approved means add diligence |
| Transfer `type` (Swimlane 2) | `debit` | |
| Transfer `type` (Swimlane 3) | `credit` | |
| Transfer `network` (default speed beat) | **`same-day-ach`** | GA; preferred when narration says "before market close" |
| Transfer `ach_class` (consumer debit) | **`web`** | Online consumer authorization |
| Transfer `ach_class` (consumer credit) | `ppd` | Required on ACH credits |
| Transfer `amount` (account funding) | `$100.00`–`$500.00` | |
| Transfer `status` (initiation step) | **`pending`** | |
| Transfer `status` (confirmation step) | **`settled`** | Never `returned` in happy path |
| `user_present` (debit) | `true` | User is in session |
| `user_present` (credit/payout) | `false` | Server-initiated payout |
| `credit_funds_source` (ledger payout) | **`"ledger"`** | Default `"sweep"` sources from commercial |
| Ledger sweep `amount` (deposit) | NEGATIVE | Debit from commercial → ledger |
| Ledger sweep `amount` (withdraw) | POSITIVE | Credit to commercial from ledger |
| Webhook | `webhook_type: "TRANSFER"`, `webhook_code: "TRANSFER_EVENTS_UPDATE"` | Fires on status change |

---

## Canonical narration (PMM-validated)

Use these verbatim. Each beat is ≤25 words to fit the per-step ceiling.

### Account funding (debit) — 5 beats

1. **Account connection** (post-Link step):
   > "Jenna connects her checking account through Plaid Link — authenticated in seconds, no micro-deposits."

2. **Identity confirmation** (optional but recommended):
   > "Plaid confirms Jenna is the account owner — name, address, and phone all match."

3. **Authorization** (Signal runs internally; pattern A):
   > "Plaid authorizes the debit — Signal clears the transfer, low return risk, approved."

   **Alternative for pattern B** (explicit `/signal/evaluate` panel):
   > "Signal evaluates the transfer in real time — score of 12, low return risk — ACCEPT."

4. **Transfer initiation**:
   > "Transfer initiates: same-day ACH, $100, pending. Jenna's funds are on their way."

5. **Settlement**:
   > "Settled. Funds are available on the Plaid ledger, ready to sweep to treasury."

### Account disbursement (credit payout) — alternate 3-beat closing

1. **Prefund ledger** (off-screen most demos, optional on-screen):
   > "Treasury prefunds the Plaid ledger from the commercial account — funds available for instant payout."

2. **RTP credit** (when capabilities check supports RTP):
   > "Plaid checks RTP capability, authorizes the credit, and pays $50 to Jenna's account — instant."

3. **Settlement** (RTP is real-time so single beat covers both):
   > "Settled. Real-time payment delivered in seconds, ledger updated, ready for the next payout."

### Closing (Fund & Protect summary, ≤35 words)

> "Account verified. Identity confirmed. Signal-backed authorization. Money moved — ACH or RTP, from your ledger or your treasury account. One SDK, one data network, no ACH blind spots."

---

## Hard rules — must not break

### Endpoint naming
- ✅ `POST /transfer/authorization/create`
- ✅ `POST /transfer/create`
- ✅ `POST /transfer/event/sync`
- ✅ `POST /transfer/ledger/deposit` | `withdraw` | `get`
- ✅ `POST /transfer/sweep/list`
- ✅ `POST /transfer/capabilities/get`
- ❌ `POST /transfer/initiate` — deprecated; never use

### Signal context inside Transfer demos
- ✅ Authorization response has `decision`, `decision_rationale`, `proposed_transfer`
- ❌ Authorization response does NOT carry `scores.*`, `ruleset.result`, `core_attributes`, `reason_codes[]`, `warnings[]` — those exist only on a standalone `/signal/evaluate` response (pattern B only)
- ✅ Pattern A is the default; pattern B is opt-in for explicit-score demos
- ❌ Never show `decision: "approved"` with a populated `decision_rationale` as a "happy path" without narrating that diligence is required
- ❌ Never show `ruleset.result: REJECT` — not a documented value in Signal

### Link products array
- ✅ `["transfer", "signal"]` + `required_if_supported_products: ["identity"]`
- ❌ NOT `["auth", "identity", "signal"]` — Auth is implicit in Transfer; explicit `auth` is not required and adding it narrows the institution list unnecessarily
- ❌ Never include `transfer` in the same Link token as `cra_base_report`, `cra_income_insights`, or `income_verification` (incompatible)

### Rail labeling (GA vs LA, May 2026)
- ✅ GA: `ach` (standard 2–3 day), `same-day-ach`. Default to `same-day-ach` for speed narratives.
- ⚠️ Limited Availability: `rtp`, `fedNow`. Demo MUST label the panel "Limited Availability" or "early access" if these rails appear.
- ✅ Always run `/transfer/capabilities/get` before authorizing on `rtp` — fall back to `ach`/`same-day-ach` if the institution doesn't support RTP credit
- ❌ Transfer is US-only, USD-only — do not show international or non-USD scenarios

### Idempotency & POA
- ✅ Every `/transfer/authorization/create` call requires a unique `idempotency_key` (per authorization attempt)
- ✅ Every ledger `deposit` / `withdraw` requires a unique `idempotency_key`
- ✅ Consumer ACH debits require NACHA-compliant proof of authorization, stored for ≥2 years
- ❌ Do not show two authorizations with the same `idempotency_key` in the API panel — that is a re-submission, not a new authorization

### Happy-path discipline
- ✅ End the flow with `transfer.status: settled`
- ❌ Show `transfer.status: returned` in the main demo
- ❌ Show `decision: declined` in the happy path
- ❌ Show ledger sweep `status: failed`

### Phrasing
- ✅ "Plaid Transfer on ACH rails"
- ❌ "Plaid's ACH network" — overstates ownership
- ✅ "Identity confirmed", "account owner verified"
- ❌ "She is identity-verified" — do not verb-form "identity verify"

---

## Decision rationale handling (must be in every Transfer demo's mental model)

The build agent and script generator must read `authorization.decision` AND `authorization.decision_rationale` together:

| `decision` | `decision_rationale` | What to show / what to narrate |
|---|---|---|
| `approved` | `null` | Happy path. Proceed to `/transfer/create`. Narration: "Approved." |
| `approved` | `{ code: "MANUALLY_VERIFIED_ITEM" \| "ITEM_LOGIN_REQUIRED" \| "MIGRATED_ACCOUNT_ITEM" \| "ERROR" }` | Plaid couldn't run full risk — narration should flag this as "approved with caveat — your policy applies" |
| `declined` | `{ code: "NSF" }` | Show "declined — insufficient funds". Do NOT call `/transfer/create` |
| `declined` | `{ code: "RISK" }` | Show "declined — risk threshold". Do NOT call `/transfer/create` |
| `declined` | `{ code: "TRANSFER_LIMIT_REACHED" }` | Show "declined — limit". Do NOT call `/transfer/create` |
| `user_action_required` | (set) | Relaunch Plaid Link with `transfer.authorization_id` to re-auth |

**Demo rule:** Default happy-path uses `approved` + `null` rationale. If a prompt asks for a "risk decline" beat, use `declined` + `RISK` rationale and show a separate host-app decision step ("transferred to manual review").

---

## Three-phase phasing for the script generator

When the prompt is a multi-step Transfer demo, split into independent phases. Do NOT chain swimlanes 1+2+3 in a single uninterrupted narration:

- **Phase A (3–4 beats):** Linking — Link consent → Plaid Link modal → account connected → access_token exchange. The Plaid Link modal step has its own `plaidPhase: "launch"` rules; see the recipe system.
- **Phase B (4–5 beats):** Funding — Identity Match → authorization (Signal internal) → transfer create → settlement → ledger withdraw to treasury.
- **Phase C (3–4 beats):** Disbursement — ledger deposit (optional on-screen) → ledger balance check → capabilities check → credit authorization + create → credit settled.

Most demos only need Phase A + Phase B (funding-only). Add Phase C only when the prompt explicitly mentions payouts, disbursement, or "credit push".

---

## Proof points for stat overlays

Approved with "based on Plaid internal data" attribution:

- **3–5×** ACH return rate reduction (Transfer + Signal vs baseline)
- **0.6–1.2%** average return rate for Transfer + Signal customers (vs ~3.5% industry)
- **>$18B** processed in 2025 across all Transfer customers
- **800+** institutions live on Transfer ACH network
- **5,400+** network signals in `network_risk_dynamic_scoring`

**Customer-specific (sales-deck approved; confirm with CS for customer-facing public demos):**
- Robinhood: ACH return rate ~4% → <0.8%, >$2B/quarter brokerage funding
- Public.com: time-to-first-deposit 4–5 days → <3 minutes
- Betterment: **internal use only** — 72% manual review reduction, 68% NSF return reduction (90-day cohort)

---

## Pipeline integration checklist (build-qa relevant)

When the demo script includes a Transfer step, build-QA expects:

- [ ] API panel shows `POST /transfer/authorization/create` and `POST /transfer/create` — NOT `/transfer/initiate`
- [ ] Authorization response shows `decision: "approved"` with `decision_rationale: null` in the happy path
- [ ] Authorization response does NOT contain `scores.*`, `ruleset.result`, `core_attributes`, `reason_codes[]`, or `warnings[]`
- [ ] If a standalone `/signal/evaluate` panel appears, narration explains pattern B explicitly ("we surface this here for demo clarity; in production Signal runs inside authorization")
- [ ] Link products array is `["transfer", "signal"]` + `required_if_supported_products: ["identity"]`
- [ ] `transfer.status` matches narration — `pending` on initiation, `settled` on confirmation
- [ ] `transfer.network` value matches the rail mentioned in narration; RTP/FedNow panels carry an LA label
- [ ] No `returned` status, no `declined` decision in the happy path
- [ ] If RTP is shown, a `/transfer/capabilities/get` panel precedes the authorization OR the narration acknowledges fallback to ACH
- [ ] If ledger credit payouts are shown, the credit authorization includes `credit_funds_source: "ledger"`
- [ ] If consumer debit is shown, narration or a NACHA-POA beat acknowledges authorization capture

---

## What this skill does NOT cover

- Card-present, card-not-present, or card payouts — Transfer is account-to-account only
- International or non-USD money movement — Transfer is US/USD only
- B2B treasury operations (>$25K wires, FX, multi-currency)
- KYC/identity verification onboarding flow — that's IDV (`identity_verification`), distinct from Identity Match
- Wire transfers as a primary product — Transfer supports wires (credit-only) but they are not the headline use case
- The hosted Transfer UI flow (`/transfer/intent/create` + `transfer.intent_id` in `link/token/create`) — a separate integration pattern; load this skill's PK file if needed
