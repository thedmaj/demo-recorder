# Plaid Demo Pipeline — Claude Instructions

## Project Overview
This is an automated demo video production pipeline for Plaid products. Claude agents
in this pipeline handle: product research (AskBill + Glean), demo script generation,
local web app building, Playwright recording, QA review with refinement loops, ElevenLabs
voiceover, and Remotion video composition.

All pipeline commands run without human intervention by default (`SCRATCH_AUTO_APPROVE=true`).

**Author prompts for story and product intent** using [`inputs/prompt-template.txt`](inputs/prompt-template.txt). Research now starts with **Solutions Master** context (solutions → components/APIs → playbook/play value props) when prompt includes “Solutions supported”. Then technical integration patterns are loaded from [`skills/plaid-integration.skill`](skills/plaid-integration.skill), with AskBill/Glean used for gaps. `RESEARCH_MODE` / **Research depth** controls depth; if neither is set, research defaults to **`gapfill`** (targeted AskBill, minimal Glean).

---

## REQUIRED — Pipeline heartbeat (supervising long-running builds)

**Applies to Claude Code, Cursor Agent, and any assistant that starts or watches pipeline work.** Treat this as a **binding obligation**, not background documentation.

**Triggers:** You kicked off or are responsible for monitoring any of: `npm run demo`, `npm run demo:full`, `npm run pipe -- new`, `npm run pipe -- resume`, `npm run pipe -- stage …`, orchestrator output, or tailing `pipeline-build.log.md` while a run is active.

**What “heartbeat” means**

The orchestrator emits **`::PIPE:: event=heartbeat`** every **5 minutes** (override: `PIPELINE_HEARTBEAT_MS`) **while a stage is running**, independent of stage completion. Each tick also writes `pipeline-heartbeat.json` and a `[HEARTBEAT]` section in `artifacts/logs/pipeline-build.log.md`.

1. **Observe heartbeats (preferred):** When supervising a long-running Shell call, configure:
   ```
   notify_on_output: {
     pattern: "::PIPE:: event=heartbeat",
     reason: "5min pipeline heartbeat",
     debounce_ms: 280000
   }
   ```
   On each notification, post a one-line chat summary: `stage=<name>, elapsed=<s>s, lastLogActivity=<s>s ago, awaiting=<bool>`.
2. **Background orchestrator:** Run `npm run pipe -- monitor [RUN_ID]` in parallel (same `notify_on_output` pattern) when the orchestrator itself is backgrounded.
3. **Fallback poll:** `npm run pipe -- status --json` exposes `lastHeartbeatAt`, `lastHeartbeatAgeSec`, `heartbeatStale`. Summarize `running`, `runningStage`, `awaitingContinue`, `firstFailed`, `nextRecoveryCommand`.
4. **Do not wait for the user to ask “how’s it going?”** Proactive status on every heartbeat tick is the default.
5. **No silent waiting on stalls:** If `heartbeatStale: true` or no heartbeat for **>2× interval** while `running: true`, investigate (`activePid`, tail log). Suggest `npm run pipe -- stop <RUN_ID>` only if the user wants to abort.
6. **Avoid stdin blocks:** Prefer `npm run pipe … --non-interactive` (and/or `SCRATCH_AUTO_APPROVE=true`) so orchestrator gates do not wait on **Enter** in the terminal.

**Optional human terminal:** `npm run pipe:status-loop` prints `pipe status` every **300s** — **redundant** for agents once orchestrator heartbeats are active; kept for human supervisors who want a separate terminal.

**Also read:** short mirror for tooling: [`AGENTS.md`](AGENTS.md); always-on Cursor rule: [`.cursor/rules/pipeline-heartbeat.mdc`](.cursor/rules/pipeline-heartbeat.mdc); agent-facing CLI reference: [`.claude/skills/pipeline-cli/SKILL.md`](.claude/skills/pipeline-cli/SKILL.md).

---

## Brand Voice & Demo Quality — summary (full rules in skill)

**Load the [`saas-demo-design-principles`](.claude/skills/saas-demo-design-principles/SKILL.md) skill** when authoring or critiquing script, narration, persona, slide copy, or any voiceover material. It owns narrative arc, pacing (8–14 steps, 20–35 words/step, 2–3 min), reveal-moment checklist, prohibited words, approved product names, Plaid Link narration boundary, and persona guidelines.

Pipeline-specific reminders kept here (because build/QA agents sometimes don't load the skill):

- Approved product names (use verbatim): **Plaid Identity Verification (IDV)**, **Plaid Instant Auth**, **Plaid Layer**, **Plaid Monitor**, **Plaid Signal**, **Plaid Assets**, **Plaid Protect**.
- Quantify outcomes where possible: *Signal score 12 — ACCEPT*, *verified in 2.4 seconds*.
- **Trust Index / Ti2** is **scoped**: allowed in **Plaid Protect demos only** (verified via GTM Playbook 2026 + Ti2 blog Oct 2025). Forbidden in non-Protect demos because it confuses with Signal score branding. Retrieve TI via **`POST /protect/event/send`** or **`POST /protect/user/insights/get`** — **not** `/signal/evaluate`. Mark **Limited Availability** when disclosing GA status. Wire format: `inputs/products/plaid-protect.md`.
- Active voice. No apologetic / filler words (*simply*, *just*, *unfortunately*, *robust*, *seamless*).
- Main demo = happy path only: no error / declined / edge-case flows.

### Host app background interpretation (UX rule)
- For **host/customer-branded app screens** (non-Plaid modal content), default the primary page background to white or another light neutral when compatible with brand colors.
- Keep brand identity through accent colors, typography, nav treatment, and CTA styles while maintaining accessible contrast.
- Keep Plaid-dark surfaces for Plaid-specific contexts (for example dedicated Plaid insight scenes), not as the default host canvas.

---

## Plaid Link Sandbox Navigation

Full reference: `inputs/plaid-link-sandbox.md`
Runtime data + functions: `scripts/scratch/utils/plaid-browser-agent.js`

Quick reference for all pipeline agents:
- Default institution: **First Platypus Bank** (`ins_109508`) — non-OAuth
- Default credentials: `user_good` / `pass_good`
- MFA OTP: `1234` | Remember Me OTP: `123456`
- OAuth institution: **Platypus OAuth Bank** (`ins_127287`)
- CRA (Check / Consumer Report) Link: `user_credit_profile_*` + `pass_good` (or any sandbox password) — non-OAuth institutions only; not `user_bank_income` (that is **Bank Income** — see `inputs/products/plaid-bank-income.md`)
- IDV persona: Leslie Knope — see `inputs/plaid-link-sandbox.md § 5`
- OAuth redirect detected → call `agent.handleOAuthFlow()` (5-step process)
- Always skip Remember Me phone screen via "Continue without phone number"

---

## Plaid Link & API Requirements (verify on every Mode A demo build)

### /link/token/create products[] — research-driven, never hardcoded (REQUIRED)

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

### Plaid Liabilities — non-FCRA, daily-cached, federal student loans gone (REQUIRED)

Non-FCRA read-only debt data (credit cards, private student loans, mortgages). **Cannot be used for underwriting/decisioning** — use CRA Base Report for those flows. Full rules: [`inputs/products/plaid-liabilities.md`](inputs/products/plaid-liabilities.md).

- **Link products:** `["liabilities"]` standalone, or **LIT bundle** `["liabilities", "transactions", "investments"]`. Never mix with `cra_*` products.
- **Endpoint:** `POST /liabilities/get` (daily-cached — do NOT promise real-time freshness). Webhook: `LIABILITIES:DEFAULT_UPDATE`.
- **Response shape:** `{ accounts, liabilities: { credit[], student[], mortgage[] }, item, request_id }` — never invent fields.
- **⚠ No federal student loans** since Aug 23, 2024 (Mohela/Aidvantage/EdFinancial/Nelnet/CRI gone). Use private servicers only (Sallie Mae, Discover, Wells Fargo Education, PHEAA, CornerStone/UHEAA) or credit cards + mortgages.

### Plaid Investments vs Plaid Investments Move — never confuse these (REQUIRED)

Two distinct products — misrouting causes the generated app to call the wrong endpoint. Full disambiguation: [`inputs/products/plaid-investments.md`](inputs/products/plaid-investments.md).

| | **Plaid Investments** | **Plaid Investments Move** |
|---|---|---|
| Link product | `investments` | **`investments_auth`** |
| Endpoint | `/investments/holdings/get`, `/investments/transactions/get` | `/investments/auth/get` |
| Use case | PFM, portfolio analytics | ACATS/ATON brokerage transfer |
| Returns acct # / DTC | No | **Yes** (`numbers.acats[]`) |

- **Move demos:** `products: ["investments_auth"]`, show `/investments/auth/get` with `numbers.acats[]` + `dtc_numbers` + `owners`. Never call `/investments/holdings/get`.
- **Data-access demos:** `products: ["investments"]`, show holdings/transactions endpoints. Never call `/investments/auth/get` or show account numbers/DTC.
- **Cost basis is aggregate only** — no per-lot data; disclose in tax-prep demos.

### Plaid Protect — anti-fraud umbrella, never a single 'protect' product string (REQUIRED)

Umbrella solution (Trust Index/Ti2 + Signal + IDV + Monitor + Rulesets). **NOT a single API** — `'protect'` must never appear in `products[]`. Full rules: [`inputs/products/plaid-protect.md`](inputs/products/plaid-protect.md).

- **Trust Index (default Protect demo):** Link `['protect_linked_bank']` → after Link `onSuccess`, **`POST /protect/event/send`** (`event_type: LINK_SESSION_END`, `request_trust_index: true`) or **`POST /protect/user/insights/get`**. API panel shows `trust_index.{score, model, subscores}` (1–100, higher = SAFER). **`/signal/evaluate` does NOT return Trust Index** — do not use it for TI hero beats.
- **Plaid Signal (optional component):** add `'signal'` to Link and call **`POST /signal/evaluate`** only when the prompt explicitly includes transaction-time Signal scoring. `ruleset.result`: `ACCEPT`, `REROUTE`, `REVIEW` — `REJECT` is NOT documented. Explainability: `core_attributes` + `ruleset.triggered_rule_details.internal_note` — never fabricate `reason_codes[]`.
- **Trust Index / Ti2:** Limited Availability (March 2026). Use documented Protect response shapes from the product KB — do not label Signal `scores.*` as Trust Index.

### Plaid Cash Advance Score / EWA Score — Plaid Protect family, not standard Signal (REQUIRED)

Plaid Protect product using the same `/signal/evaluate` endpoint as Signal, but a **distinct product** with different score semantics and Sales-side enablement. Routes to family `cash_advance_score` — NEVER to `funding` / `plaid-signal.md`. Full API pattern: [`inputs/products/plaid-ewa-score.md`](inputs/products/plaid-ewa-score.md).

- **Link products:** `["auth", "signal"]`
- **Score field:** `response.scores.cash_advance.score` (1–99, higher = higher risk). Fallback when not provisioned: `bank_initiated_return_risk.score`. No `reason_codes[]` array — never fabricate one.

### Plaid Link Event Names (use these exactly — do NOT invent event names)
```
OPEN, LAYER_READY, LAYER_NOT_AVAILABLE, SELECT_INSTITUTION, SELECT_BRAND,
SELECT_DEGRADED_INSTITUTION, ERROR, EXIT, HANDOFF, TRANSITION_VIEW,
SEARCH_INSTITUTION, SUBMIT_CREDENTIALS, SUBMIT_MFA,
BANK_INCOME_INSIGHTS_COMPLETED,
IDENTITY_VERIFICATION_START_STEP, IDENTITY_VERIFICATION_PASS_SESSION,
IDENTITY_VERIFICATION_FAIL_SESSION, IDENTITY_VERIFICATION_PENDING_REVIEW_SESSION,
IDENTITY_VERIFICATION_CREATE_SESSION
```

### Plaid Link Callback Pattern (always include in demo apps)
```javascript
Plaid.create({
  token: '<link-token>',
  onSuccess: (public_token, metadata) => { /* token exchange */ },
  onExit: (err, metadata) => { /* handle close or error */ },
  onEvent: (eventName, metadata) => { /* all events incl. OPEN, HANDOFF */ }
});
```

### Plaid Link Recording Behavior

Recording uses `headless: false` which captures cross-origin iframes (OOPIFs) via the GPU compositor.
The real Plaid Link modal (`cdn.plaid.com`) **IS visible** in the recorded video.
**Do NOT build simulated Plaid Link step divs** — the real SDK modal is the video experience.

**Architecture: Single real-SDK step**
- The demo script has ONE Plaid Link step with `"plaidPhase": "launch"` — no sub-steps
- Modal mode uses a host button that calls `window._plaidHandler.open()`; embedded mode starts from the in-page container mount/activation
- The real Plaid SDK modal appears as an iframe over the host page during the entire flow
- `record-local.js` uses CDP frameLocator to automate the real iframe (phone → OTP → institution → account)
- When `onSuccess` fires, the host app advances to the first post-link step

**Build agent instructions (no-capture mode):**
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

**Plaid Link demo-script structure:**
- Single Plaid Link step (e.g. `"id": "wf-link-launch"`, `"plaidPhase": "launch"`)
- Narration covers entire flow in ≤35 words: consent → OTP → institution → account → success
- Duration 18–22 seconds (covers the visible Remember Me flow after post-processing cuts loading gaps)

**Plaid Link narration boundary rule (REQUIRED):**
The step immediately BEFORE the Plaid Link step must end its narration with the user action
that triggers the modal (e.g., "...she taps Link Your Bank." or "...she clicks Add External Account.").
The Plaid Link step narration must begin describing content VISIBLE INSIDE the modal — never
the act of opening it. This ensures the voiceover is synced to what is on screen:

- ✅ Pre-Plaid-Link step: "...Chime explains the process and Berta taps Link Your Bank."
- ✅ Plaid Link step: "Recognized as a returning user, she confirms with a one-time code, selects her checking account, and connects in seconds."
- ❌ Plaid Link step: "Plaid Link opens. Berta taps..." — DO NOT narrate the trigger in the Plaid Link step
- ❌ Plaid Link step: "She clicks the button and Plaid Link opens..." — same violation

Reason: The Plaid Link SDK takes 0.5–1s to load after the button click. Narration that starts
with "Plaid Link opens" or "she taps..." plays while the screen is still transitioning, creating
a storyboard mismatch where audio precedes the visual it describes.

**Recording behavior:**
- Institution: Defaults to **First Platypus Bank** / Remember Me flow (non-OAuth)
- The "Save with Plaid" phone screen is auto-dismissed by the recording script

### Embedded Link UX guidance (REQUIRED)

When `plaidLinkMode` is `embedded`, follow Embedded Institution Search behavior:

- Create Link token with `/link/token/create` as normal; no embedded-specific token params are required.
- If showing "Connect Manually", configure `auth.auth_type_select_enabled` in token config.
- Web SDK: use `Plaid.createEmbedded(...)` and mount into `data-testid="plaid-embedded-link-container"`.
- **Pre-link page = live embed:** the launch step (`plaidPhase: "launch"`) must show trust copy (headline, encryption bullets, consent) **and** the live embedded institution search on the **same** step — parity with modal Link. Do **not** duplicate the SDK’s “Recommended · Instant verification” tile in the host column; the embed owns that. Manual verification = subtle “Connect manually” link only (`auth.auth_type_select_enabled`). Never defer the SDK to a later step or use placeholder copy like “Institution search preview – opens on the next step.”
- Keep layout constraints to sizing only: minimum embedded container `350x300px` or `300x350px`.
- Do not impose extra iframe/frame-containment constraints beyond normal embedded sizing behavior.
- Full rules: [`skills/plaid-link-embedded-link-skill.md`](skills/plaid-link-embedded-link-skill.md).

### CRA / Consumer Report Link Requirements (Base Report + Income Insights)

Product details: [`inputs/products/plaid-cra-base-report.md`](inputs/products/plaid-cra-base-report.md).

- CRA demos MUST use the real Plaid Link CRA/Check experience (single `"plaidPhase": "launch"` step with real SDK modal). The general "no simulated Link step divs" rule above still applies.
- CRA setup semantics before report retrieval: `/user/create` identity context + permissible purpose in token config. Include `cra_base_report` and (when used) `cra_income_insights` in `/link/token/create` products.
- Retrieval is asynchronous — show a report-ready lifecycle beat before insight retrieval.
- Plaid Passport is optional per account configuration; never omit the core CRA Link/consent experience.
- CRA "setup" / "data returned / report returned" explanatory scenes use Plaid-branded insight-style presentation, not customer-branded host chrome.

### Layer Mobile — Eligibility Helper + Mock Hard Contract

Applies to all Layer demos using mobile-simulated host + Layer flows. Full product rules: [`inputs/products/plaid-layer.md`](inputs/products/plaid-layer.md). Full template contract: [`templates/mobile-layer-mock/LAYER_MOCK_TEMPLATE.md`](templates/mobile-layer-mock/LAYER_MOCK_TEMPLATE.md) (**HARD CONTRACT**).

- Helper text below mobile frame: `415-555-1111` = eligible path; `415-555-0011` = ineligible (fallback PII + standard Link). Default to `415-555-1111`.
- **Canonical skeleton:** [`templates/mobile-layer-mock/layer-mobile-skeleton-from-2026-03-23-layer-v2.html`](templates/mobile-layer-mock/layer-mobile-skeleton-from-2026-03-23-layer-v2.html) — match DOM patterns exactly.
- **Plaid logo in Layer modals:** `./plaid-logo-horizontal-black-white-background.png` only; no duplicate “PLAID” text label.

### API Response Accuracy
- Use AskBill to verify exact field names and types before finalizing demo scripts
- Plaid Signal ACH transaction risk scores: 1–99 (higher = HIGHER return risk — higher score means more likely to result in ACH return/failure). Realistic demo values for ACCEPT scenarios: 5–20 (low risk). Do NOT use scores 82–97 — those represent high-risk transactions that should receive REVIEW or REROUTE, not ACCEPT. **`REJECT` is not a documented `ruleset.result` value** — use `REROUTE` or render the host-app decision outside the API panel.
- **Trust Index** is a real Plaid product (Limited Availability since March 2026; Ti2 shipped Oct 2025). Use ONLY in Plaid Protect demos via documented Protect APIs (`/protect/event/send`, `/protect/user/insights/get`) — never conflate with Signal `scores.*` from `/signal/evaluate`.
- Identity verification statuses: `active`, `success`, `failed`, `pending_review`
- Never show API error responses in main demo flows
- Realistic but idealized data only (no 100/100 scores, no instant < 1s responses)

---

## Demo App DOM Contract (Mode A — every generated app MUST follow this)

```html
<!-- Each step is a full-viewport div -->
<div data-testid="step-{id}" class="step">...</div>

<!-- Global navigation (Playwright calls this) -->
<script>
  window.goToStep = function(id) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.querySelector(`[data-testid="step-${id}"]`).classList.add('active');
    // Fire link events for this step
    if (window._stepLinkEvents && window._stepLinkEvents[id]) {
      window._stepLinkEvents[id].forEach(e => window.addLinkEvent(e.eventName, e.metadata));
    }
    // Update API response panel
    if (window._stepApiResponses && window._stepApiResponses[id]) {
      window.updateApiResponse(window._stepApiResponses[id]);
    }
  };
  window.getCurrentStep = function() {
    return document.querySelector('.step.active')?.dataset.testid;
  };
</script>

<!-- Side panels — DO NOT hand-author. The post-panels stage emits the
     canonical Claude Design v12 API panel (section.panel + .panel-head +
     two-tab Request/Response + .code-wrap + renderjson pretty-printer shim)
     and the developer-only link-events-panel. Build-app should leave this
     placeholder before </body>; post-panels fills it in post-build: -->
<!-- API_PANEL_AND_LINK_EVENTS — injected by post-panels post-build -->
```

The post-panels-emitted shell uses the v12 stable IDs / classes — those are what your code should reference if you need to query the panel from JS:

```html
<section class="panel" id="api-response-panel" data-testid="api-response-panel" aria-label="Plaid API reference" style="display:none">
  <button class="toggle" id="api-panel-toggle" data-testid="api-panel-toggle">…SVG chevron…</button>
  <header class="panel-head">
    <span class="eyebrow">Plaid API</span>
    <span class="method" id="api-panel-method">POST</span>
    <span class="path" id="api-panel-path">/auth/get</span>
    <div class="tabs"><button id="tab-req" data-tab="req">Request</button><button id="tab-res" data-tab="res">Response</button></div>
  </header>
  <div class="panel-toolbar">…</div>
  <div class="code-wrap">
    <pre class="code is-active" id="api-pane-request"  data-pane="req"></pre>
    <pre class="code"            id="api-pane-response" data-pane="res" hidden></pre>
  </div>
</section>
<div id="link-events-panel" data-testid="link-events-panel" style="display:none"></div>
```

Default state is `.panel.is-collapsed` (panel slides off-screen right; chevron remains as a peek handle at the viewport edge). Build-qa's `prepareGlobalJsonRailForBuildQa` strips the collapsed class for screenshots. The legacy `.side-panel` / `.side-panel-header` / `.side-panel-body` / `.api-panel-edge-toggle` / `#api-response-content` / `#api-panel-endpoint` markup is removed — do not emit it.

All interactive elements must have `data-testid` attributes in kebab-case matching the
`interaction.target` field in `demo-script.json`.

### JSON Panel Toggle & Overlay Contract (REQUIRED)

`post-panels` owns the API panel toggle — **do not hand-author a different toggle in generated HTML**; it will be stripped and replaced. `build-app.js` delegates to `post-panels.buildPanelPatchScript()` which injects the versioned IIFE on every build. Violations are auto-patched by the `api-panel-toggle-latest` patch on next run.

Rules for generated HTML:
- **Do not style `.disclosure`** (renderjson sub-tree toggles) beyond `color` and `cursor` — any `width`/`height`/`background` on `.disclosure` is a critical deterministic blocker (`scanRenderjsonDisclosureStyling`). post-panels v8 overrides it at runtime, but build-QA will still flag it.
- **Panel is a fixed overlay** (z-index 2100) — never add `padding-right: 520px`, `max-width: calc(100% - 520px)`, or `body.api-panel-open` shrink rules on host steps or `.slide-root` (`scanPanelOverlayContract` blocker).
- Panel arrives **collapsed by default** on every step nav; 48px edge toggle is the only visible chrome until user clicks.

### Plaid Link onSuccess Callback Panel Contract (v6+)

When the demo-script contains a step with `plaidPhase: "launch"`, the host step immediately
after it is the **Link success page** — the screen the user lands on once the Plaid SDK
modal closes successfully. The `post-panels` stage auto-injects an "Plaid Link onSuccess
(callback)" API response panel on this step when, and only when, the script does not
already declare its own `apiResponse` there. The synthesized payload mirrors what the
Plaid Web SDK delivers to the `onSuccess(public_token, metadata)` callback:

```json
{
  "endpoint": "Plaid Link onSuccess (callback)",
  "response": {
    "public_token": "public-sandbox-<link_session_id>",
    "metadata": {
      "institution": { "name": "First Platypus Bank", "institution_id": "ins_109508" },
      "accounts": [
        { "id": "...", "name": "Plaid Checking", "mask": "0211", "type": "depository",
          "subtype": "checking", "verification_status": null, "class_type": null }
      ],
      "link_session_id": "...",
      "transfer_status": null
    }
  }
}
```

Values are parameterized from `demoScript.plaidSandboxConfig` when present (institutionId,
institutionName, accountId, accountName, accountMask, accountType, accountSubtype).

**Rules**:

- If the post-link step **already** has an `apiResponse` (e.g. a server-side product
  call like `POST /credit/bank_income/get` or `POST /identity/match` immediately after
  the SDK callback), the script-author's choice wins and the synthesis is skipped.
  For demos that want BOTH an explicit Link callback beat and a server call, insert a
  dedicated host step between `plaidPhase: "launch"` and the server-call step.
- If the post-link step is a slide (`stepKind: "slide"`) or another `link` step, no
  panel is injected — those are not host pages.
- Synthesis is implemented in `post-panels.synthesizeLinkOnSuccessResponse(demoScript)`;
  re-running the stage on an old scratch-app injects the panel without a full rebuild.

### Manual Navigation (REQUIRED in every generated app)

Every demo app must include keyboard and click-to-advance navigation so a human can drive
the demo manually (e.g. for manual Playwright recording or presenter review). Add this script
block immediately after the `goToStep` / `getCurrentStep` definitions:

```javascript
// ── Manual navigation (arrow keys + click-to-advance) ───────────────────────
// Required for human-driven recording sessions and presenter review.
(function() {
  function _stepIds() {
    return Array.from(document.querySelectorAll('.step[data-testid]'))
      .map(s => s.dataset.testid.replace(/^step-/, ''));
  }
  function _navigate(delta) {
    var ids = _stepIds();
    var current = (window.getCurrentStep() || '').replace(/^step-/, '');
    var idx = ids.indexOf(current);
    var next = ids[Math.max(0, Math.min(ids.length - 1, idx + delta))];
    if (next && next !== current) window.goToStep(next);
  }
  // ArrowRight / ArrowDown = next step; ArrowLeft / ArrowUp = previous step
  document.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') _navigate(1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') _navigate(-1);
  });
  // Click on any non-interactive area of the active step to advance to the next step.
  // Clicks on buttons, inputs, links, and role="button" elements pass through normally.
  document.addEventListener('click', function(e) {
    if (e.target.closest('button, input, select, textarea, a, [role="button"], [role="link"]')) return;
    _navigate(1);
  });
})();
```

**Rules for click-to-advance:**
- The entire step background / card body / text areas should be clickable to advance
- Actual interactive controls (buttons, inputs, links) must NOT trigger advance — they do their own thing
- This must not conflict with the Playwright automation flow — the script is passive and event-driven

**CRITICAL: Never add `display` to step inline styles** — Steps use `.step { display: none }` /
`.step.active { display: block }` for visibility. Never add `style="display:flex"` or
`style="display:block"` to a `.step` div — this permanently overrides the hidden state and
makes that step visible on ALL other steps.

**CRITICAL: data-testid uniqueness** — every `data-testid` attribute must be unique within the
entire document. When the same interactive element (e.g., expand button) appears in multiple
steps, make the testid unique per step: `api-sidebar-expand-btn-auth`, `api-sidebar-expand-btn-identity`,
`api-sidebar-expand-btn-signal`. The Playwright recorder uses strict mode and will error if
multiple elements match a single `data-testid` selector.

---

## Pipeline — Post-Build App Preview

After the `build` stage completes, the orchestrator automatically:
1. Starts a local HTTP server serving `scratch-app/` on port 3739
2. Opens `http://localhost:3739` in the default browser
3. Pauses for human review (arrow keys / clicks to step through) — press **ENTER** to start recording

This preview step only runs when both `build` and `record` stages are in the pipeline
(i.e. it is skipped on `--from=record` or later restarts). It is always interactive — the
human must confirm before recording begins.

---

## Recording — Remember Me Institution List (Plaid Link)

When the Remember Me saved-institution list appears:
- **Wait 2 seconds** before clicking — allows the viewer to read the list
- **Do NOT scroll** — Tartan Bank is always at the top of the sandbox list; click it directly
- After clicking, the selection and confirmation play out at normal speed

This is enforced in `record-local.js` `plaidSelectSavedInstitution()`: a `page.waitForTimeout(2000)`
dwell is inserted between `institution-list-shown` and the click. Do not remove or shorten it.

---

## Brand Extraction (brand-extract stage)
- **Always regenerate brand JSONs on every pipeline run** — never reuse a previously written `brand/<slug>.json`.
- The `brand-extract` stage runs **after `script`** so `demo-script.json` exists with `persona.company`. It writes a fresh `brand/<slug>.json` via **Brandfetch** (`api.brandfetch.io/v2/brands/{domain}`), then Playwright CSS extraction and Haiku normalization as fallbacks.
- Brand URL resolution: explicit `Brand URL: https://…` in ingested prompt, else the first plausible `https` URL in the prompt head (skips Plaid/docs/CDN hosts). Company name still drives slug; domain drives Brandfetch.
- The stage also writes `brand-extract.json` in the run directory as a completion sentinel.
- Build agents must read the brand JSON written by the **current run's** brand-extract stage. Never commit brand JSON files as library assets to rely on later.
- `BRANDFETCH_API_KEY` and `BRANDFETCH_CLIENT_ID` are already in `.env` — no additional env variables should be added for branding.

## Recording, Audio & Remotion — defaults (full rules in skills)

Pipeline defaults below are **load-bearing** — changing them requires a documented reason. Deep guidance lives in the dedicated skills; load them when editing the relevant stage:

- **Voiceover / audio sync / SSML / sync-map:** [`audio-sync-mastery`](.claude/skills/audio-sync-mastery/SKILL.md).
- **Remotion composition, overlays, captions, audio playback, metadata:** [`remotion-best-practices`](.claude/skills/remotion-best-practices/SKILL.md) (and [`remotion-studio`](.claude/skills/remotion-studio/SKILL.md) when editing in Studio).

### Pipeline defaults (do not change casually)

- **Screen recording** (`record-local.js`): `headless: false` (captures real Plaid Link modal), CSS viewport `1440×900`, `deviceScaleFactor: 2`, `recordVideo.size: { width: 2880, height: 1800 }`.
- **Post-process encoding** (`post-process-recording.js`): VP8, `-b:v 8000k`, `-crf 10` (near-lossless). Do **not** lower bitrate / raise CRF without instruction.
- **Voiceover defaults** (`generate-voiceover.js`): model `eleven_multilingual_v2` (or `ELEVENLABS_MODEL_ID`), output `mp3_44100_192`, voice settings **`stability: 0.75`**, **`similarity_boost: 0.90`**, **`use_speaker_boost: true`**. Do **not** lower `stability`.
- **Audio QA** (`orchestrator.js` audio-qa stage): per-clip `ffmpeg silencedetect noise=-40dB:d=0.15`; stutter (≥0.15s) or freeze (≥0.5s) inside a clip → delete and regenerate that clip + rebuild stitched `voiceover.mp3`; report at `audio-qa-report.json`.
- **Remotion overlays** (`ScratchComposition.jsx`): default `REMOTION_POINTER_ONLY=true` — only `ClickRipple` (teal ring, 120px @ 2880×1800, 45 frames) auto-generated from `click-coords.json` via `buildRemotionProps()` → `remotion-props.json`. Cinematic overlays (zoom, lower-thirds, stat counters, cross-dissolve, spotlights) are **off by default** and only allowed when explicitly requested with `REMOTION_POINTER_ONLY=false`, and must not mask or alter the host app flow.

---

## Pipeline Restartability + the agent-mode default

`npm run demo` is the **agent-mode default** and stops at `build-qa` so
the loop produces a QA-graded host app + slides without spending time
on recording / rendering. This matches how Claude Code / Cursor agents
typically iterate — build, QA, fix, build, QA — and keeps round-trips
fast. To run the full pipeline (record + voiceover + render + ppt),
use `npm run demo:full`.

To restart from any stage:
```
npm run demo -- --from=STAGE_NAME
```

To stop at a different stage (or override the build-qa default):
```
npm run demo -- --to=STAGE_NAME       # stop earlier than build-qa
npm run demo:full -- --from=record    # full pipeline starting at record
```

`build-qa` walks `scratch-app` with Playwright, screenshots each script step, and runs the same Claude vision QA as post-record QA against `demo-script.json` `visualState` — output `qa-report-build.json` in the run dir. Optional: `BUILD_QA_STRICT=1` to exit non-zero if the score is below `QA_PASS_THRESHOLD`.

**Build-QA scope by build mode:**
- **app-only:** judges `stepKind: "app"` steps against `visualState` only — does **not** require concrete narration values (scores, amounts, decisions) on screen unless `visualState` explicitly describes them as visible (voiceover-only by design).
- **app+slides / slide steps:** narration-strict gate applies — concrete narration claims must be visibly evidenced in frames.
- **Both modes:** brand wordmark/nav fidelity, Plaid Link CTA icon ratio, asset authenticity, animation/state-progression (when in `visualState`), deterministic blockers, panel-visibility when `apiResponse` is declared.

### Tier-aware QA recovery (REQUIRED — do not rebuild the whole app for one bad step)

Every `qa-report-build.json` now carries `buildMode`, `tierSummary`, and `recommendedRecovery`. The orchestrator and `pipe status` consult these to route a **surgical** recovery lane instead of regenerating the entire `scratch-app/index.html` via `build-app` touchup / fullbuild.

```
buildMode  | app.passed | slide.passed       | recommendedRecovery       | Lane (no build-app)
-----------|------------|--------------------|---------------------------|-----------------------------
app-only   | true       | (skipped)          | null                      | stop
app-only   | false      | (skipped)          | app-touchup               | npm run pipe -- app-touchup
app+slides | true       | true               | null                      | stop
app+slides | true       | false              | slide-fix                 | npm run pipe -- slide-fix
app+slides | false      | true               | app-touchup               | npm run pipe -- app-touchup
app+slides | false      | false              | app-touchup+slide-fix     | app-touchup first, then slide-fix
either     | systemic*  |                    | fullbuild                 | (legacy LLM regen path)
```

\* Systemic = deterministic blocker, build-QA guardrail override, or runtime/selector errors on ≥2 steps. See `scripts/scratch/utils/qa-tier-summary.js`.

**Lane contracts (load-bearing):**

- **`pipe app-touchup`** ([`scripts/scratch/scratch/app-touchup.js`](scripts/scratch/scratch/app-touchup.js)) — app patches (`api-panel-toggle-latest`, `host-nav-logo-contrast`, `plaid-launch-cta-icon-ratio`, `plaid-link-token-products-prune`, `zip-cra-host-contract`) → `post-panels` → build-qa `stepScope=app` (or `all` on app-only). On residual failures under an AI agent, writes `qa-touchup-task.md` (app-only) or `qa-app-touchup-task.md` (app+slides). **Never** edits `.slide-root` blocks. Never calls `build-app`.
- **`pipe slide-fix`** ([`scripts/scratch/scratch/slide-fix.js`](scripts/scratch/scratch/slide-fix.js)) — slide patches (typography ceiling/floor, layout, chrome-logo) → `strip-slide-roots --steps=…` → `post-slides --steps=…` → `post-panels` → build-qa `stepScope=slides`. Refuses to run on app-only and when the app tier hasn't passed. On residual failures, writes `qa-slide-fix-task.md`. **Never** edits non-slide step blocks. Never calls `build-app`.
- **`pipe status`** surfaces `tierSummary` + `recommendedRecovery` and the `nextRecoveryCommand` field is tier-aware.

**Do NOT** use `--build-fix-mode=touchup` (LLM full HTML regen) for tier-localized failures — that path rewrites the entire `index.html` and can regress passing tiers (see e.g. the Zip CRA LendScore slide regression `2026-05-21`). Use the tier lanes instead.

Stages: `research`, `ingest`, `script`, `brand-extract`, `script-critique`, `embed-script-validate`, `build`, `build-qa`, `post-slides`, `post-panels`, `app-touchup`, `slide-fix`, `record`, `qa`, `figma-review`, `post-process`, `voiceover`, `coverage-check`, `auto-gap`, `resync-audio`, `embed-sync`, `audio-qa`, `ai-suggest-overlays`, `render`, `ppt`, `touchup`

## Plaid Slide Design System (REQUIRED for new runs with slides)

**App-only invariant (HARD):** Runs with `run-manifest.json.buildMode === 'app-only'` MUST produce zero slide artifacts. Slide steps are not generated, the canonical placeholder is not emitted, `post-slides` skips with `{ skipped: true, reason: 'app-only' }`, slide-tier QA scanners are gated off, and `scanAppOnlyNoSlides` fires `app-only-slide-leak` (critical deterministic blocker) on any leak. The only path from app-only to app+slides is the storyboard editor's `insert-library-slide` which flips the manifest via `stampInsertedStepKindAndMaybeUpgradeBuildMode`. See `tests/unit/app-only-zero-slides.test.js`.

**Source of truth:** `templates/slide-template/brand-design-briefs/` (`DECK_DESIGN_SYSTEM.md`, `DECK_TEMPLATES.md`, `DECK_COMPOSITION.md`) + `colors_and_type.css` + `slide.css` + `pipeline-slide-contract.css` + `pipeline-slide-shell.html`. Agent skill: [`.claude/skills/plaid-slide-design/SKILL.md`](.claude/skills/plaid-slide-design/SKILL.md) (slide vs host isolation, palette enforcement).

**Slide-fix as canonical residual recovery (REQUIRED):** When `build-qa.tierSummary.slide.passed === false`, the orchestrator dispatches the **slide-fix lane** ([`scripts/scratch/scratch/slide-fix.js`](scripts/scratch/scratch/slide-fix.js)): deterministic patches → `strip-slide-roots --steps=<failing>` → `post-slides --steps=<failing>` → scoped re-QA → optional `qa-slide-fix-task.md` for Agent Mode StrReplace edits. **Slides NEVER trigger `build-app` regeneration.** This locks in the app-first / slides-after architecture — host steps that already passed QA are not re-rolled when a slide fails. See `scripts/scratch/utils/strip-slide-roots-for-post-slides.js` (canonical placeholder shape lives here as `buildCanonicalSlidePlaceholder`).

**Public API contract:** `scripts/scratch/scratch/post-slides.js` exports `spliceSlideFragmentIntoHtml` as a public function. Consumed by `scripts/dashboard/utils/insert-slide-html.js` (the storyboard editor's `/insert-library-slide` endpoint), `scripts/scratch/utils/qa-touchup.js`, and the canonical splice path. Do not break this export when refactoring post-slides.

**Frozen runs:** Existing `out/demos/*` runs are **not** retrofitted. Only new pipeline runs (and `post-slides` insertions) adopt T1–T11 templates.

### Shell + templates

- Every slide step: `data-testid="step-{id}"` → `.slide-root` with `data-slide-template="T1"|…|"T11"`.
- Canonical chrome: `.frame`, `.chrome-logo`, `.eyebrow-tag`, `.h-title` (one `<em>` Bowery italic accent). Pipeline slides omit `.chrome-foot` (T1 may omit eyebrow).
- Background classes on `.slide-root`: default navy (`--plaid-ink-900`), or `.light` / `.cream` / `.holo`.
- Assets copied per build: `scratch-app/fonts/`, `scratch-app/assets/logos/` (paths like `assets/logos/plaid-horizontal-white.png`).
- `post-slides-report.json` records `templatesUsed[]` per inserted slide.

### Canonical slide canvas (HARD CONTRACT, May 2026 — rebuilt 2026-05-22)

Every active slide MUST render at a **Google-Slides-class size** that dominates the viewport. There is **no per-slide variability** — one contract, all slides, enforced by a deterministic blocker.

| Property | Contract | Why |
|----------|----------|-----|
| **Width** | `max-width: min(1280px, calc(100vw - 80px))` → **≥ 75% viewport** | Slides are the deliverable on slide-tier steps; small slides are unreadable on screen capture. |
| **Aspect ratio** | `16/10` (allowed: `[1.40, 1.85]` — covers 16:9 = 1.78 and 16:10 = 1.60) | Matches Google Slides default + Plaid Deck Design System. |
| **Height** | Auto from aspect-ratio → **≥ 67% viewport** | On a 1440×900 viewport the slide is 1280×800. |
| **API panel reservation** | **None** — panel is a fixed overlay (z-index 2100) | Collapsed default is 48px edge toggle; expand-on-click overlays content without shrinking slides |

**Source of truth (rebuilt 2026-05-22):** [`templates/slide-template/pipeline-slide-contract.css`](templates/slide-template/pipeline-slide-contract.css), injected ONCE by `post-slides.ensureSlideDesignStylesInHead` inside the `<style data-pipeline-slide-contract="v1">` block. **Zero `!important` declarations** in the contract — cascade order is authoritative (the contract block is emitted AFTER `slide.css` in `<head>`). This replaces four prior competing patches:

| Replaced layer | Status |
|----------------|--------|
| `build-app.js` `slide-root-responsive-override` | DELETED |
| `normalize-slide-typography.js` `slide-typography-ceilings-v1` (`max-width` clause) | DELETED (font ceilings kept) |
| `qa-patch-library.js` `slide-canvas-fullbleed` | RETIRED (stub kept for historical references) |
| Per-step inline-style escapes (added during surgical slide-fix iterations) | DELETED |

**Enforced by:**

- **`scanSlideCanvasSize`** in `build-qa.js` (deterministic blocker, category `slide-canvas-size`, severity `critical`). Measures rendered `.slide-root.getBoundingClientRect()` per slide step during the Playwright walk and fires if width < 75%, height < 67%, or aspect outside `[1.40, 1.85]`. Gated on `buildMode === 'app+slides'`.
- **`scanPanelOverlayContract`** in `build-qa.js` (deterministic blocker, category `panel-overlay-contract`, severity `critical`). Forbids `body.api-panel-open` slide-shrink rules and 520px reserve CSS on host/slide steps.
- **`scanSlideNarrationConcreteValues`** in `build-qa.js` (deterministic blocker, category `slide-narration-drift`, severity `critical`). Catches LLM hallucinations where the slide's rendered text doesn't match concrete claims in the step's narration (numeric tokens, ACCEPT/REVIEW/REROUTE decisions, product names like "Trust Index"). Voiceover sync depends on the rendered content matching the narrator's claims.

**Hand-edits MUST NOT** add `min-height`, `aspect-ratio`, or width overrides on `.slide-root` (inline or in stylesheet) that would shrink the slide below the contract. The `scanSlideCanvasSize` blocker will fail the build. If you need to override the contract, edit `pipeline-slide-contract.css` directly — do not shadow it with a higher-priority `!important` block.

### First-step bootstrap (REQUIRED — fixes blank-first-slide regression)

`build-app.js` always injects an idempotent `<script id="pipeline-first-step-bootstrap-v1">` block before `</body>` that activates the first `.step[data-testid]` on `DOMContentLoaded` if no step is already `.active`. This fixes the regression where the LLM emitted `class="step"` (without `active`) on the first step → blank page on first paint. Idempotent with the storyboard editor's `STORYBOARD_SET_STEP` postMessage bridge: if the editor has already called `window.goToStep(sid)`, the `.active` flag is set and this bootstrap becomes a no-op.

### Drift checkpoint (slide-content-hash.json + post-record-freeze.sentinel)

After `build-qa` passes, [`scripts/scratch/utils/slide-content-hash.js`](scripts/scratch/utils/slide-content-hash.js) writes a SHA-256 of every `<div data-testid="step-{id}">` block to `slide-content-hash.json` with `source: 'build-qa'`. This locks the HTML at the QA-blessed state. On app-only runs the slide-tier section is **omitted** (no slides exist to hash).

When `record` completes, it writes `post-record-freeze.sentinel`. While the sentinel exists:
- Automated `post-slides` / `slide-fix` re-runs SKIP with `reason: 'post_record_freeze'` (and a recovery hint to re-run `pipe stage record`).
- Storyboard editor mutations (`/script`, `/insert-library-slide`, `/remove-step`, `/reorder-steps`) are allowed but call `recordEditorMutation` to:
  1. Recompute slide-content-hash with `source: 'storyboard-edit'`, `userModifiedSinceQa: true` for affected step ids
  2. Append to `editor-mutation-log.json` with `voiceoverStale` / `recordingStale` flags

`GET /api/runs/:runId/staleness` returns the dashboard-banner-ready summary with `recommendedRecovery` priority: `recordingStale > voiceoverStale > qaStale`. The dashboard surfaces this as yellow ("QA not re-run since edit") and red ("Recording stale") banners.

### Record stage guard

`record-local.js` refuses to start if `scratch-app/index.html` contains any `data-slide-pending="true"` placeholder (post-slides failed to fill it). Halts with a clear recovery hint pointing at `pipe stage post-slides` or `pipe slide-fix`.

### Composition rules

- Sentence-case headlines ending with a period; **one mint moment** per slide (`--plaid-teal-500` / `#42F0CD`).
- Body text **≥ 24px**; flex/grid + `gap` only — **no `display: inline-block`** inside `.slide-root`.
- Background rhythm: **≤ 4 consecutive navy** slides before a `.light` / `.cream` / `.holo` interlude.
- Approved palette only; soft tints via `rgba()` on brand tokens.

### PPTX export font swap (documented)

Manrope (sans), Playfair Display (display), JetBrains Mono (mono) — export tooling is separate.

### Build-QA — deterministic blockers + design warnings

**Slide canvas size (hard contract — see § Canonical slide canvas above):** `scanSlideCanvasSize` in `build-qa.js`. Category `slide-canvas-size`, severity `critical`. Auto-fixed by the `slide-canvas-fullbleed` patch.

**Logo (hard contract):** `scanSlidePlaidLogoAuthenticity` in `build-qa.js` is a **deterministic blocker** (`severity: 'critical'`). Slides must use bundled horizontal wordmarks only — `<img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png">` (navy), `plaid-horizontal-dark.png` (light/cream/holo), or `plaid-horizontal-holograph.png` — **or omit** `.chrome-logo` entirely. Never invent SVG/icon-grid logos or render "PLAID" as text/CSS.

**CRA LendScore host (blockers when family is `cra_lend_score`):** `scanCraHostUnderwritingContracts` enforces Zip-style **NMLS ID 1963958** footer (via `inputs/brand-references/zip.md`), visible `approve-plan-cta`, and `evaluateApiStoryAlignment` recognizes `POST /cra/check_report/lend_score/get` (not Base Report mis-label). Product KB: `inputs/products/plaid-cra-lend-score.md`.

**Plaid × Workhorse hybrid blockers (when slides borrow Workhorse layouts):** Three new scanners in `build-qa.js` (May 2026 — gated on `buildMode === 'app+slides'`):
- **`scanSlideWorkhorseThemeLeak`** — category `slide-workhorse-theme-leak`, severity `critical`. Blocks `<link>` to `assets/themes/*.css` from html-ppt or CDN webfont imports (Inter / Playfair / Noto / JetBrains Mono / IBM Plex Mono) inside `.slide-root`.
- **`scanSlideWorkhorseRuntimeLeak`** — category `slide-workhorse-runtime-leak`, severity `critical`. Blocks `<script>` references to `runtime.js`, `fx-runtime.js`, `chart.js`, or `highlight.js` inside `.slide-root`. Pipeline slides are static and SVG-only.
- **`scanSlideMotionAttributes`** — category `slide-motion-attributes`, severity `warning`. Flags `data-anim`, `data-fx`, and `anim-*` classes inside `.slide-root`. Motion is allowed only on standalone exports.

**Text overlap (May 2026):** `scanSlideTextOverlap` is a deterministic blocker (category `slide-text-overlap`, severity `critical`). During the Playwright walk, every visible text-bearing element inside `.slide-root` is measured; pairs whose rendered bounding boxes intersect by more than 8×8 px are reported with element tags, fonts, rects, and a recommended target font-size (75% of the larger, floored at the 24 px Plaid body minimum). Parent-child relationships are excluded. The `slide-text-overlap-autofix` patch in [`scripts/scratch/utils/qa-patch-library.js`](scripts/scratch/utils/qa-patch-library.js) reads `build-qa-diagnostics.json` and emits scoped per-step `font-size` and `.slide-stack { gap }` overrides; when both overlapping elements are already at the 24 px floor the patch defers to `slide-fix` LLM remediation (widen container padding/gap).

Hybrid rules: [`.claude/skills/plaid-workhorse-slides/SKILL.md`](.claude/skills/plaid-workhorse-slides/SKILL.md). Standalone export: [`scripts/export-plaid-deck.sh`](scripts/export-plaid-deck.sh).

**Warning scanners** (not blockers): tokens, shell chrome, italic accent, mint overuse, inline-block, background rhythm, invented colors — all `severity: 'warning'`, `deterministicBlocker: false`. (The legacy `slide-typography-floor` 24px-minimum scanner was removed 2026-05-27; templates now own font sizing and the LLM may reduce inline `font-size` to fit content. See § Typography Source of Truth below.)

### Opt-in patches (manual invoke)

[`scripts/scratch/utils/qa-patch-library.js`](scripts/scratch/utils/qa-patch-library.js): `slide-design-tokens-inject`, `slide-shell-chrome-inject`, `slide-chrome-logo-canonical`, `slide-typography-floor` — use `buildManualPatchMatch(name)` + `applyPatches()`; they do **not** auto-fire from QA.

## Build mode (App-only vs App + Slides)

The pipeline now defaults to **App-only** mode end-to-end. No slide steps are
generated, no slide build phase runs, and no slide-scope `build-qa` pass runs.
Slides are strictly opt-in:

- **CLI**:
  - `npm run demo` — App-only (default), stops at `build-qa` (agent-mode default).
  - `npm run demo:full` — same defaults but runs the full pipeline through render.
  - `npm run demo:with-slides` (alias for `--with-slides`) — include slides phase + final value-summary slide.
  - `npm run demo:app-only` — explicit app-only override (useful when env vars elsewhere might enable slides).
- **Dashboard**: the **Run Pipeline** card has an "Include slides phase" checkbox. It is pre-filled from your dashboard-wide default (persisted in browser localStorage at key `dashboard.withSlidesDefault`). Toggling it both runs this build with the chosen mode and updates your default for next time.
- **Resume / restart actions** (Re-run Build, restart from stage, dashboard quick actions) **inherit the original run's mode** from `run-manifest.json` (`buildMode: "app-only" | "app+slides"`). Use the modal checkbox + `overrideWithSlides:true` to change mode on a resumed run.
- **Single switch** (advanced): `PIPELINE_WITH_SLIDES=true|false` is the canonical env knob. The orchestrator's `resolveBuildMode()` expands it into the legacy envs (`BUILD_PHASE_SEQUENCE`, `BUILD_PHASE_SLIDES_ENABLED`, `DEMO_MARKETING_SLIDE`, `SCRIPT_ZERO_SLIDE`) so existing scripts/CI continue to work.
- **Run banner**: every run prints `[Orchestrator] Mode: App-only  (source: …)` (or `App + Slides`) at start so the chosen mode is visible in CLI logs and the dashboard log viewer.

## Output Versioning
Every pipeline run writes to `out/demos/{YYYY-MM-DD}-{product-slug}-v{N}/`.
`out/latest/` symlinks to the most recent run.
