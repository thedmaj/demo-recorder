# Plaid Link & API Requirements — Pipeline contract

Verified on every Mode A demo build. Referenced from `CLAUDE.md` § Plaid Link & API Requirements.

---

## /link/token/create products[] — research-driven, never hardcoded (REQUIRED)

The `products[]` array passed to Plaid `/link/token/create` is **resolved by the research stage**, never invented by the build LLM:

1. **Source of truth:** `link-token-create-config.json` in the run directory, written by the `research` stage via `scripts/scratch/utils/link-token-create-config.js`. The resolver derives `products` from:
   - The free-text prompt (`inputs/prompt.txt`)
   - `requiredApiSignals` from the demo-script
   - AskBill (Plaid docs MCP)
   - Indexed product knowledge in `inputs/products/*.md`
2. **Product-mix sanitization** runs inside the resolver before `link-token-create-config.json` is written. Two rules:
   - **Layer 1 — CRA vs non-CRA Income mutual exclusion.** `cra_base_report` / `cra_income_insights` cannot share a Link token with `income_verification`. Tiebreaker: when `productFamily ∈ {cra_base_report, income_insights}` the CRA path wins; otherwise the non-CRA Income path wins.
   - **Layer 2 — `income_verification` compatibility.** Plaid only accepts `{income_verification, employment}` together. Anything else (`auth`, `identity`, `transactions`, etc.) is dropped whenever `income_verification` is in the list.
3. **Backend authority at request time.** `app-server.js`'s `/api/create-link-token` handler re-reads `link-token-create-config.json` from `PIPELINE_RUN_DIR` and uses its `products[]` over anything the HTML body sent. Drift is logged with a warning. This is belt-and-suspenders for legacy/patched scratch-apps and ad-hoc edits.
4. **Build prompt contract.** LLMs generating the host app HTML MUST use the `linkTokenCreate.suggestedClientRequest` body from research verbatim. They must NOT invent or "complete" a `products[]` list. This is documented in the `## LINK TOKEN CREATE (dynamic — research-driven)` block in `scripts/scratch/utils/prompt-templates.js`.
5. **Self-heal patch.** `scripts/scratch/utils/qa-patch-library.js` ships a `plaid-link-token-products-prune` patch for legacy `scratch-app/index.html` files that pre-date the resolver sanitizer. Modern builds never need it; it remains for retro-active fixes during `pipe resume`.

Pure helpers exported for tests: `sanitizeProductsForLinkTokenMix` in `link-token-create-config.js` and `resolveCreateLinkTokenProducts` / `loadResearchLinkTokenConfig` in `app-server.js`. See `tests/unit/link-token-create-config.test.js` and `tests/unit/app-server-link-token-resolution.test.js`.

---

## Per-product contracts (summaries)

Detailed product rules live in `inputs/products/*.md`. The following are pipeline-level reminders the build/QA agents need without loading the full KB.

### Plaid Liabilities — non-FCRA, daily-cached, federal student loans gone

Non-FCRA read-only debt data (credit cards, private student loans, mortgages). **Cannot be used for underwriting/decisioning** — use CRA Base Report for those flows. Full rules: [`inputs/products/plaid-liabilities.md`](../inputs/products/plaid-liabilities.md).

- **Link products:** `["liabilities"]` standalone, or **LIT bundle** `["liabilities", "transactions", "investments"]`. Never mix with `cra_*` products.
- **Endpoint:** `POST /liabilities/get` (daily-cached — do NOT promise real-time freshness). Webhook: `LIABILITIES:DEFAULT_UPDATE`.
- **Response shape:** `{ accounts, liabilities: { credit[], student[], mortgage[] }, item, request_id }` — never invent fields.
- **⚠ No federal student loans** since Aug 23, 2024 (Mohela/Aidvantage/EdFinancial/Nelnet/CRI gone). Use private servicers only (Sallie Mae, Discover, Wells Fargo Education, PHEAA, CornerStone/UHEAA) or credit cards + mortgages.

### Plaid Investments vs Plaid Investments Move — never confuse these

Two distinct products — misrouting causes the generated app to call the wrong endpoint. Full disambiguation: [`inputs/products/plaid-investments.md`](../inputs/products/plaid-investments.md).

| | **Plaid Investments** | **Plaid Investments Move** |
|---|---|---|
| Link product | `investments` | **`investments_auth`** |
| Endpoint | `/investments/holdings/get`, `/investments/transactions/get` | `/investments/auth/get` |
| Use case | PFM, portfolio analytics | ACATS/ATON brokerage transfer |
| Returns acct # / DTC | No | **Yes** (`numbers.acats[]`) |

- **Move demos:** `products: ["investments_auth"]`, show `/investments/auth/get` with `numbers.acats[]` + `dtc_numbers` + `owners`. Never call `/investments/holdings/get`.
- **Data-access demos:** `products: ["investments"]`, show holdings/transactions endpoints. Never call `/investments/auth/get` or show account numbers/DTC.
- **Cost basis is aggregate only** — no per-lot data; disclose in tax-prep demos.

### Plaid Protect — anti-fraud umbrella, never a single 'protect' product string

Umbrella solution (Trust Index/Ti2 + Signal + IDV + Monitor + Rulesets). **NOT a single API** — `'protect'` must never appear in `products[]`. Full rules: [`inputs/products/plaid-protect.md`](../inputs/products/plaid-protect.md).

- **Trust Index:** Link `['protect_linked_bank']` → **`POST /protect/event/send`** (`LINK_SESSION_END`, `request_trust_index: true`) or **`POST /protect/user/insights/get`**. Panel shows `trust_index.*` (1–100, higher = SAFER). **Not** `/signal/evaluate`.
- **Signal (optional):** add `'signal'` + **`POST /signal/evaluate`** only when the prompt explicitly includes transaction-time Signal. `ruleset.result`: `ACCEPT`, `REROUTE`, `REVIEW`. No `reason_codes[]`.
- **Trust Index / Ti2:** Limited Availability. Do not label Signal `scores.*` as Trust Index.

### Plaid Cash Advance Score / EWA Score — Plaid Protect family, not standard Signal

Plaid Protect product using the same `/signal/evaluate` endpoint as Signal, but a **distinct product** with different score semantics and Sales-side enablement. Routes to family `cash_advance_score` — NEVER to `funding` / `plaid-signal.md`. Full API pattern: [`inputs/products/plaid-ewa-score.md`](../inputs/products/plaid-ewa-score.md).

- **Link products:** `["auth", "signal"]`
- **Score field:** `response.scores.cash_advance.score` (1–99, higher = higher risk). Fallback when not provisioned: `bank_initiated_return_risk.score`. No `reason_codes[]` array — never fabricate one.

### CRA / Consumer Report Link Requirements (Base Report + Income Insights)

Product details: [`inputs/products/plaid-cra-base-report.md`](../inputs/products/plaid-cra-base-report.md).

- CRA demos MUST use the real Plaid Link CRA/Check experience (single `"plaidPhase": "launch"` step with real SDK modal). The general "no simulated Link step divs" rule below still applies.
- CRA setup semantics before report retrieval: `/user/create` identity context + permissible purpose in token config. Include `cra_base_report` and (when used) `cra_income_insights` in `/link/token/create` products.
- Retrieval is asynchronous — show a report-ready lifecycle beat before insight retrieval.
- Plaid Passport is optional per account configuration; never omit the core CRA Link/consent experience.
- CRA "setup" / "data returned / report returned" explanatory scenes use Plaid-branded insight-style presentation, not customer-branded host chrome.

### Layer Mobile — Eligibility Helper + Mock Hard Contract

Applies to all Layer demos using mobile-simulated host + Layer flows. Full product rules: [`inputs/products/plaid-layer.md`](../inputs/products/plaid-layer.md). Full template contract: [`templates/mobile-layer-mock/LAYER_MOCK_TEMPLATE.md`](../templates/mobile-layer-mock/LAYER_MOCK_TEMPLATE.md) (**HARD CONTRACT**).

- Helper text below mobile frame: `415-555-1111` = eligible path; `415-555-0011` = ineligible (fallback PII + standard Link). Default to `415-555-1111`.
- **Canonical skeleton:** [`templates/mobile-layer-mock/layer-mobile-skeleton-from-2026-03-23-layer-v2.html`](../templates/mobile-layer-mock/layer-mobile-skeleton-from-2026-03-23-layer-v2.html) — match DOM patterns exactly.
- **Plaid logo in Layer modals:** `./plaid-logo-horizontal-black-white-background.png` only; no duplicate "PLAID" text label.

### API Response Accuracy

- Use AskBill to verify exact field names and types before finalizing demo scripts
- Plaid Signal ACH transaction risk scores: 1–99 (higher = HIGHER return risk — higher score means more likely to result in ACH return/failure). Realistic demo values for ACCEPT scenarios: 5–20 (low risk). Do NOT use scores 82–97 — those represent high-risk transactions that should receive REVIEW or REROUTE, not ACCEPT. **`REJECT` is not a documented `ruleset.result` value** — use `REROUTE` or render the host-app decision outside the API panel.
- **Trust Index** is a real Plaid product (Limited Availability since March 2026; Ti2 shipped Oct 2025). Use the term ONLY in Plaid Protect demos. Retrieve it via documented Protect APIs in [`plaid-protect.md`](../inputs/products/plaid-protect.md) — not via `/signal/evaluate`.
- Identity verification statuses: `active`, `success`, `failed`, `pending_review`
- Never show API error responses in main demo flows
- Realistic but idealized data only (no 100/100 scores, no instant < 1s responses)

---

## Plaid Link Event Names (use these exactly — do NOT invent event names)

```
OPEN, LAYER_READY, LAYER_NOT_AVAILABLE, SELECT_INSTITUTION, SELECT_BRAND,
SELECT_DEGRADED_INSTITUTION, ERROR, EXIT, HANDOFF, TRANSITION_VIEW,
SEARCH_INSTITUTION, SUBMIT_CREDENTIALS, SUBMIT_MFA,
BANK_INCOME_INSIGHTS_COMPLETED,
IDENTITY_VERIFICATION_START_STEP, IDENTITY_VERIFICATION_PASS_SESSION,
IDENTITY_VERIFICATION_FAIL_SESSION, IDENTITY_VERIFICATION_PENDING_REVIEW_SESSION,
IDENTITY_VERIFICATION_CREATE_SESSION
```

## Plaid Link Callback Pattern (always include in demo apps)

```javascript
Plaid.create({
  token: '<link-token>',
  onSuccess: (public_token, metadata) => { /* token exchange */ },
  onExit: (err, metadata) => { /* handle close or error */ },
  onEvent: (eventName, metadata) => { /* all events incl. OPEN, HANDOFF */ }
});
```

---

## Plaid Link Recording Behavior

Recording uses `headless: false` which captures cross-origin iframes (OOPIFs) via the GPU compositor. The real Plaid Link modal (`cdn.plaid.com`) **IS visible** in the recorded video. **Do NOT build simulated Plaid Link step divs** — the real SDK modal is the video experience.

### Architecture: single real-SDK step

- The demo script has ONE Plaid Link step with `"plaidPhase": "launch"` — no sub-steps
- Modal mode uses a host button that calls `window._plaidHandler.open()`; embedded mode starts from the in-page container mount/activation
- The real Plaid SDK modal appears as an iframe over the host page during the entire flow
- `record-local.js` uses CDP frameLocator to automate the real iframe (phone → OTP → institution → account)
- When `onSuccess` fires, the host app advances to the first post-link step

### Build agent instructions (no-capture mode)

- Do NOT build step divs for link-consent, link-otp, link-account-select, link-success, or any Plaid screens
- Modal mode only: include Plaid Link button (`data-testid="link-external-account-btn"`) inside the initiate-link step div
- Embedded mode: do NOT add "Connect Bank Account" / "Link Bank Account" / similar launch CTA buttons; launch starts from embedded container activation
- Modal button onclick: `if (window._plaidHandler) window._plaidHandler.open();` — no goToStep call
- `window._plaidLinkComplete = true` is set ONLY in `onSuccess` — NEVER in a goToStep handler
- `onSuccess` stores institution/account metadata: `window._plaidInstitutionName`, `window._plaidAccountName`, `window._plaidAccountMask` — use these in post-link steps, never hardcode bank names
- Pre-populate all post-link API responses with sandbox data
- The initiate-link step in `demo-script.json` MUST have `"plaidPhase": "launch"`
- Modal playwright entry: ONE entry with `action:"click"`, `target:"[data-testid=\"link-external-account-btn\"]"`, `waitMs: 120000`
- Embedded playwright entry: ONE entry with `action:"goToStep"`, `target:"<launch-step-id>"`, `waitMs: 120000`
  - NEVER split into a goToStep entry + click entry for the same launch step — this causes duplicate `markStep` calls

### Plaid Link demo-script structure

- Single Plaid Link step (e.g. `"id": "wf-link-launch"`, `"plaidPhase": "launch"`)
- Narration covers entire flow in ≤35 words: consent → OTP → institution → account → success
- Duration 18–22 seconds (covers the visible Remember Me flow after post-processing cuts loading gaps)

### Plaid Link narration boundary rule (REQUIRED)

The step immediately BEFORE the Plaid Link step must end its narration with the user action that triggers the modal (e.g., "...she taps Link Your Bank." or "...she clicks Add External Account."). The Plaid Link step narration must begin describing content VISIBLE INSIDE the modal — never the act of opening it. This ensures the voiceover is synced to what is on screen:

- ✅ Pre-Plaid-Link step: "...Chime explains the process and Berta taps Link Your Bank."
- ✅ Plaid Link step: "Recognized as a returning user, she confirms with a one-time code, selects her checking account, and connects in seconds."
- ❌ Plaid Link step: "Plaid Link opens. Berta taps..." — DO NOT narrate the trigger in the Plaid Link step
- ❌ Plaid Link step: "She clicks the button and Plaid Link opens..." — same violation

Reason: The Plaid Link SDK takes 0.5–1s to load after the button click. Narration that starts with "Plaid Link opens" or "she taps..." plays while the screen is still transitioning, creating a storyboard mismatch where audio precedes the visual it describes.

### Recording behavior

- Institution: Defaults to **First Platypus Bank** / Remember Me flow (non-OAuth)
- The "Save with Plaid" phone screen is auto-dismissed by the recording script
- **Remember Me saved-institution list:** wait 2 seconds before clicking — allows the viewer to read the list. Do NOT scroll. Enforced in `record-local.js` `plaidSelectSavedInstitution()` via `page.waitForTimeout(2000)` between `institution-list-shown` and click.

---

### Recording Automation Waterfall

When the `record` stage hits the `plaidPhase: "launch"` step, `executePlaidLinkPhase()` in [`record-local.js`](../scripts/scratch/scratch/record-local.js) picks **one** of three automation paths, in priority order. Whichever path runs, control returns to `plaidLinkWaitSuccess()` afterwards — the rest of the launch step (success-flag wait, save-screen dismissal, post-link `goToStep`) is identical across paths.

| # | Path | Condition | What drives the iframe | When to use |
|---|------|-----------|------------------------|-------------|
| 1 | **Recipe** | `inputs/plaid-recipes/{flow}.json` exists AND `PLAID_RECIPES_DISABLED !== 'true'` | Deterministic per-screen JSON: ranked selectors + per-screen dwells | Default for any flow you've authored or recorded a recipe for. Fastest, most predictable. |
| 2 | **SmartPlaidAgent** | `SMART_PLAID_AGENT=true` AND no recipe matched | Claude Sonnet vision agent picks the next action each turn | Exploratory or one-off flows where authoring a recipe is overkill. |
| 3 | **CDP waterfall** | Neither of the above | Hand-tuned selector waterfall in `record-local.js` lines ~1230–1530 | Safety net. The legacy path that all the confirmed-working selectors in [`inputs/plaid-link-nav-learnings.md`](../inputs/plaid-link-nav-learnings.md) came from. |

The waterfall short-circuits — once a path runs without throwing, the others are skipped. On a path throwing, the run does **not** automatically retry on the next tier; the launch step instead waits for `_plaidLinkComplete` with a 45 s ceiling and surfaces a `PLAID_LINK_TIMEOUT` error if nothing succeeds.

### Recipe system (path 1) — files + lifecycle

```
inputs/plaid-recipes/
  README.md                  schema + heading-by-heading explanation
  remember-me.json           shipped — Tartan Bank, +14155550011, OTP 123456
  _backups/                  rotated copies written before any recorder overwrite (gitignored)
```

Adding a new recipe is data, not code:

1. **Author by hand** if you have the selectors from prior runs (`plaid-link-nav-learnings.md` is the seed for `remember-me.json`), OR
2. **Author by recording** with the Layer 3 CLI:
   ```
   npm run record:plaid:manual -- --flow=standard
   # or:  --flow=oauth --institution=ins_127287
   # or:  --flow=cra --phone=+14155550000
   ```
   A headed Chromium opens a self-contained harness that calls `/link/token/create` (sandbox) and shows a floating overlay with event count + Save / Discard. Click through Plaid Link as a real user would; press **ESC** or hit **Save** when you reach success. The recorder writes `inputs/plaid-recipes/{flow}.json` (with the previous version rotated to `_backups/`).

3. **Fill in narration hints + sanity-check selectors.** The recorder leaves `narrationHint: ''` per screen — fill these in so future diffs are reviewable. Selector ranking is `data-testid > #id > [aria-label] > [role] > input[inputmode|type|placeholder] > button:has-text > tag:first-of-type`; the rank-0 selector becomes `primarySelectors[target]`, ranks 1–3 land in `fallbackTargets[]`.

4. **Replay** on the next `npm run demo:full` — the Layer 2 executor picks the recipe up automatically.

### Executor behavior (path 1, runtime)

For each screen the executor:

1. Polls `arrivalSignals[]` for up to `arrivalTimeoutMs` (12 s default; 3.5 s for `optional: true` screens). Supported signal types: `frameLocator`, `pageLocator`, `successFlag`, `plaidEvent` (counts `window._plaidEventCounts[name]`).
2. Tests `skipIf[]` — used by `save-with-plaid` so it self-exits when `_plaidLinkComplete` already fired.
3. Runs `actions[]` in order, honoring per-action `dwellBeforeMs` / `dwellAfterMs`:
   - For `type: "click"` and `type: "fill"`, tries `primarySelectors[target]` first, then `primarySelectors[fallbackTargets[i]]` in order.
   - On total miss for a `click`, delegates to the BrowserAgent vision hook (`agent.visionClick`). If vision wins, the winning hint is recorded as a new entry in `recipe.candidateSelectors[]` (with `hitCount`, `pendingPromotion: true`, `firstSeenAt` / `lastSeenAt`) so an operator can promote it to a primary selector after the run.
   - For `type: "fill"`, `value` is template-resolved against the recipe — `${credentials.phone}` → `recipe.credentials.phone`, `${institution.name}` → `recipe.institution.name`, etc.
4. Emits `markPlaidStep()` at known milestones (`phone-submitted`, `otp-screen`, `otp-filled`, `otp-submitted`, `institution-list-shown`, `confirm-clicked`, `link-complete`) so `plaid-link-timing.json` stays compatible with the post-process trimmer.
5. Polls `transitionSignals[]` up to `transitionTimeoutMs` (8 s default) before advancing to the next screen.

After the recipe finishes the executor writes two artifacts into the run directory:

| File | Contents |
|------|----------|
| `plaid-recipe-telemetry.json` | Per-screen status (`completed` / `arrival-timeout` / `skipped-skipif` / `skipped-not-arrived` / `completed-with-misses`), per-action `winner` + `winnerKind` (`primary` \| `fallback` \| `vision` \| `wait` \| `eval`), vision-fallback count, total elapsed wall-clock. |
| Recipe file (in-place update) | If vision wins on any screen, the new candidate selectors are persisted back to `inputs/plaid-recipes/{flow}.json`. Operator reviews after the run and promotes the candidates to `primarySelectors` via a normal code edit. |

### Env knobs (overrides without code edits)

| Var | Effect |
|-----|--------|
| `PLAID_RECIPES_DISABLED=true` | Force the legacy path. Skips recipe lookup entirely. Use when debugging the waterfall or when a recipe is regressing. |
| `SMART_PLAID_AGENT=true` | When no recipe matched, use the Claude Sonnet vision agent instead of the CDP waterfall. Slower but resilient to UI shifts. |
| `PLAID_SCREEN_DWELL_MS=4000` | Legacy waterfall's universal per-screen dwell. Has **no effect** on the recipe path — recipes own their own dwells per action. |
| `PLAID_LINK_LIVE=true` | Already required for any live-Plaid recording. Independent of which path runs. |
| `PIPELINE_RUN_DIR=…` | Where `plaid-recipe-telemetry.json` is written. Inherited from the orchestrator; only set manually for standalone executor runs. |

### Per-screen dwell semantics (path 1 only)

`dwellBeforeMs` and `dwellAfterMs` are the recipe system's answer to the legacy `PLAID_SCREEN_DWELL_MS=4000` universal knob. The viewer sees each screen for the duration the recording operator (or recipe author) decided it deserves, not 4 seconds across the board:

- **OTP screen** in `remember-me.json`: `dwellAfterMs: 1000` (just long enough to read the filled digits before Plaid auto-advances).
- **Saved-institution list**: `dwellBeforeMs: 500` (load-bearing — 2 s would produce a 1.5 s overhang in the post-processed video).
- **Account select**: `dwellBeforeMs: 800` (gives the viewer time to read the row before the click).

The Layer 3 CLI derives these automatically from wall-clock gaps between operator clicks during a manual record session, clamped to `MAX_NATURAL_DWELL_MS = 4000` so an accidental bathroom break doesn't end up in the production recipe.

### Selecting the flow type

The recipe key (`flowType`) is matched against `_sandboxConfig.plaidLinkFlow`, which is sourced — in priority order — from:

1. `demo-script.json` → `plaidSandboxConfig.plaidLinkFlow`
2. The persona / institution combination resolved during research
3. Hard default: `'standard'`

Set it explicitly in `demo-script.json` for any non-default flow:

```jsonc
{
  "plaidSandboxConfig": {
    "plaidLinkFlow": "remember-me",
    "phone": "+14155550011",
    "otp": "123456",
    "institution": "ins_109511"
  }
}
```

### Decision guide

| Situation | Recommended path |
|-----------|------------------|
| Recurring flow (Remember Me, standard, OAuth, CRA) | Author or record a recipe → path 1. |
| One-off institution or novel UI you don't plan to re-record | `SMART_PLAID_AGENT=true` → path 2. |
| Selector regression mid-run, recipe broken | `PLAID_RECIPES_DISABLED=true npm run demo:from:record` → forces path 3 (legacy waterfall) while you fix the recipe. |
| Plaid sandbox UI changed and your recipe is stale | Re-record: `npm run record:plaid:manual -- --flow=<name>`. Backup of the previous recipe lands in `inputs/plaid-recipes/_backups/`. |
| Recipe replayed but vision had to fill in 1–2 missing selectors | Open the updated recipe, review `candidateSelectors[]`, promote the ones marked `pendingPromotion: true` into `primarySelectors` + their `fallbackTargets`, then clear the candidate. |

### What's NOT covered by recipes

The recipe system owns Plaid Link iframe automation only. It does NOT cover:

- Clicking the host app's "Connect a Bank" button that opens Plaid Link in the first place — that runs before the recipe (vision-click + CSS-selector fallback).
- The host-page success screen rendered AFTER `onSuccess` — that's a normal `step` div the build agent generated, navigated via `goToStep()`.
- Cross-iframe OAuth redirects to bank-branded pages — `plaidLinkHandleOAuth()` in `record-local.js` owns those.

---

## Embedded Link UX guidance (REQUIRED)

When `plaidLinkMode` is `embedded`, follow Embedded Institution Search behavior:

- Create Link token with `/link/token/create` as normal; no embedded-specific token params are required.
- If showing "Connect Manually", configure `auth.auth_type_select_enabled` in token config.
- Web SDK: use `Plaid.createEmbedded(...)` and mount into `data-testid="plaid-embedded-link-container"`.
- **Pre-link page = live embed:** the launch step (`plaidPhase: "launch"`) must show trust copy (headline, encryption bullets, consent) **and** the live embedded institution search on the **same** step — parity with modal Link. Do **not** duplicate the SDK's "Recommended · Instant verification" tile in the host column; the embed owns that. Manual verification = subtle "Connect manually" link only (`auth.auth_type_select_enabled`). Never defer the SDK to a later step or use placeholder copy like "Institution search preview – opens on the next step."
- Keep layout constraints to sizing only: minimum embedded container `350x300px` or `300x350px`.
- Do not impose extra iframe/frame-containment constraints beyond normal embedded sizing behavior.
- Full rules: [`skills/plaid-link-embedded-link-skill.md`](../skills/plaid-link-embedded-link-skill.md).

---

## Sandbox Navigation Quick Reference

Full reference: [`inputs/plaid-link-sandbox.md`](../inputs/plaid-link-sandbox.md). Runtime data + functions: `scripts/scratch/utils/plaid-browser-agent.js`.

- Default institution: **First Platypus Bank** (`ins_109508`) — non-OAuth
- Default credentials: `user_good` / `pass_good`
- MFA OTP: `1234` | Remember Me OTP: `123456`
- OAuth institution: **Platypus OAuth Bank** (`ins_127287`)
- CRA (Check / Consumer Report) Link: `user_credit_profile_*` + `pass_good` (or any sandbox password) — non-OAuth institutions only; not `user_bank_income` (that is **Bank Income** — see `inputs/products/plaid-bank-income.md`)
- IDV persona: Leslie Knope — see `inputs/plaid-link-sandbox.md § 5`
- OAuth redirect detected → call `agent.handleOAuthFlow()` (5-step process)
- Always skip Remember Me phone screen via "Continue without phone number"
