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

1. **Post a short progress note in chat at least every 5 minutes** for as long as the run is active. Use `npm run pipe -- status` or `npm run pipe -- status --json`. Mention `running`, `runningStage`, `awaitingContinue`, `firstFailed`, and anything actionable from `nextRecoveryCommand`.
2. **Do not wait for the user to ask “how’s it going?”** Silence until prompted is incorrect behavior. Proactive status is the default.
3. **No silent waiting on stalls:** If there has been **no new stdout/stderr for ~5 minutes** while status still shows work in flight, treat as **possibly hung** — check `activePid`, tail `artifacts/logs/pipeline-build.log.md` under the run dir, report findings; only suggest `npm run pipe -- stop <RUN_ID>` if the user wants to kill the run.
4. **Avoid stdin blocks:** Prefer `npm run pipe … --non-interactive` (and/or `SCRATCH_AUTO_APPROVE=true`) so orchestrator gates do not wait on **Enter** in the terminal.

**Optional parallel terminal:** `npm run pipe:status-loop` prints `pipe status` every **300s** (`PIPE_STATUS_INTERVAL_SEC` overrides). Run it in another shell if you like — **it does not replace** chat heartbeat.

**Also read:** short mirror for tooling: [`AGENTS.md`](AGENTS.md); always-on Cursor rule: [`.cursor/rules/pipeline-heartbeat.mdc`](.cursor/rules/pipeline-heartbeat.mdc); agent-facing CLI reference: [`.claude/skills/pipeline-cli/SKILL.md`](.claude/skills/pipeline-cli/SKILL.md).

---

## Brand Voice & Demo Quality — summary (full rules in skill)

**Load the [`saas-demo-design-principles`](.claude/skills/saas-demo-design-principles/SKILL.md) skill** when authoring or critiquing script, narration, persona, slide copy, or any voiceover material. It owns narrative arc, pacing (8–14 steps, 20–35 words/step, 2–3 min), reveal-moment checklist, prohibited words, approved product names, Plaid Link narration boundary, and persona guidelines.

Pipeline-specific reminders kept here (because build/QA agents sometimes don't load the skill):

- Approved product names (use verbatim): **Plaid Identity Verification (IDV)**, **Plaid Instant Auth**, **Plaid Layer**, **Plaid Monitor**, **Plaid Signal**, **Plaid Assets**.
- Quantify outcomes where possible: *Signal score 12 — ACCEPT*, *verified in 2.4 seconds*. Never use the term **Trust Index**.
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
- Keep layout constraints to sizing only: minimum embedded container `350x300px` or `300x350px`.
- Do not impose extra iframe/frame-containment constraints beyond normal embedded sizing behavior.

### CRA / Consumer Report Link Requirements (Base Report + Income Insights)

Product details: [`inputs/products/plaid-cra-base-report.md`](inputs/products/plaid-cra-base-report.md).

- CRA demos MUST use the real Plaid Link CRA/Check experience (single `"plaidPhase": "launch"` step with real SDK modal). The general "no simulated Link step divs" rule above still applies.
- CRA setup semantics before report retrieval: `/user/create` identity context + permissible purpose in token config. Include `cra_base_report` and (when used) `cra_income_insights` in `/link/token/create` products.
- Retrieval is asynchronous — show a report-ready lifecycle beat before insight retrieval.
- Plaid Passport is optional per account configuration; never omit the core CRA Link/consent experience.
- CRA "setup" / "data returned / report returned" explanatory scenes use Plaid-branded insight-style presentation, not customer-branded host chrome.

### Layer Mobile Eligibility Helper Rule (Global)

- Applies to all Layer demos that use mobile-simulated host + Layer flows.
- Always render subtle helper text directly below the mobile app frame showing routing numbers:
  - `415-555-1111` = eligible path (continues through Layer to onboarding complete)
  - `415-555-0011` = ineligible path (fallback PII collection, then standard Plaid Link)
- Default the host phone input to the eligible value first: `415-555-1111`.
- Do not send eligible users to fallback PII collection.

### Layer Mobile Mock Hard Contract (Global)

When the build injects the Layer mobile mock template (`LAYER_MOCK_TEMPLATE.md` + mobile-visual mode), treat it as **mandatory**:

- **Canonical skeleton:** [`templates/mobile-layer-mock/layer-mobile-skeleton-from-2026-03-23-layer-v2.html`](templates/mobile-layer-mock/layer-mobile-skeleton-from-2026-03-23-layer-v2.html) — the build prompt embeds this file; match its DOM patterns, mobile-shell sizing/fill rules, global helper, host visual placeholder, and bottom-sheet Layer phases unless `demo-script.json` explicitly requires extra steps (without dropping routing or testid contracts).
- **Plaid logo in Layer modals:** `./plaid-logo-horizontal-black-white-background.png` only; **no** duplicate “PLAID” label next to the image.
- Full rule text: [`templates/mobile-layer-mock/LAYER_MOCK_TEMPLATE.md`](templates/mobile-layer-mock/LAYER_MOCK_TEMPLATE.md) (see **HARD CONTRACT**).

### API Response Accuracy
- Use AskBill to verify exact field names and types before finalizing demo scripts
- Plaid Signal ACH transaction risk scores: 0–99 (higher = HIGHER return risk — higher score means more likely to result in ACH return/failure). Realistic demo values for ACCEPT scenarios: 5–20 (low risk). Do NOT use scores 82–97 — those represent high-risk transactions that should receive REVIEW or REROUTE, not ACCEPT. Do NOT use the term "Trust Index" — it is not a Plaid product name.
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

<!-- Side panels (always include — HIDDEN by default, shown only when explicitly triggered) -->
<!-- IMPORTANT: link-events-panel MUST be hidden by default (display:none) — never visible in recordings -->
<!-- IMPORTANT: api-response-panel MUST be hidden by default (display:none) — on insight steps, show panel chrome with JSON body collapsed (class api-json-collapsed on #api-response-panel hides .side-panel-body until toggle) -->
<div id="link-events-panel" data-testid="link-events-panel" class="side-panel" style="display:none">...</div>
<div id="api-response-panel" data-testid="api-response-panel" class="side-panel" style="display:none">...</div>
```

All interactive elements must have `data-testid` attributes in kebab-case matching the
`interaction.target` field in `demo-script.json`.

### JSON Panel Expand/Collapse Toggle Contract (REQUIRED)

The `#api-response-panel` exposes a single, deterministic expand/collapse control. The
canonical implementation is the `post-panels` stage's `buildPanelPatchScript()` (see
[`scripts/scratch/scratch/post-panels.js`](scripts/scratch/scratch/post-panels.js)) and
the `api-panel-toggle-latest` patch in
[`scripts/scratch/utils/qa-patch-library.js`](scripts/scratch/utils/qa-patch-library.js).
**Do not hand-author a different toggle inside generated HTML** — it will be stripped
and replaced by the post-panels stage.

Visual + behavior contract (enforced by post-panels patch `v6+`):

- **Single toggle node**: `<button id="api-panel-toggle" data-testid="api-panel-toggle" class="api-panel-edge-toggle">` rendered exactly once inside `#api-response-panel`. No "Show JSON" / "Hide JSON" text label — icon-only.
- **Position**: vertically centered on the panel via `top:50%; transform:translateY(-50%)`, anchored to the panel's left outer edge at `left:-36px`. Width 36px, height 60px. `z-index:2001` on top of host content. `!important` selectors scoped to `#api-response-panel` so LLM-generated host CSS cannot override.
- **Icon**: a single CSS-only chevron (`.api-panel-toggle-icon` — two-border arrowhead). **Direction signals the next action**:
  - Panel open (`.is-open` class on the button) → arrow points **RIGHT** (clicking will collapse the panel rightward).
  - Panel collapsed → arrow points **LEFT** (clicking will expand the panel leftward).
- **Default state on step navigation (v6)**: the panel arrives **collapsed** on every step that has an `apiResponse` — chrome visible (48px strip + toggle arrow pointing LEFT), JSON body hidden. The JSON content is pre-rendered into the collapsed body so clicking the toggle expands instantly. Build-QA / vision-QA that must validate JSON content can opt in by setting `window.__API_PANEL_CONFIG.collapsedByDefault = false` before walking steps.
- **Behavior**: clicking calls `window.toggleApiPanel()`. `aria-expanded` / `aria-label` / `title` flip accordingly for screen readers ("Expand API JSON panel" ↔ "Collapse API JSON panel").
- **Single source of truth**: `build-app.js` delegates to `post-panels.buildPanelPatchScript()` at build time. Both stages emit the same versioned IIFE, identified by `data-post-panels-patch="vN"`. The patch IIFE writes `window.__buildApiPanelPatchVersion = 'vN'` and short-circuits only on the exact same version — never on the older boolean `__buildApiPanelPatchApplied`. Older patch IIFEs and the legacy build-app unmarked emission are stripped automatically when post-panels re-runs on an existing scratch-app, so re-running the `post-panels` stage on any old run upgrades the toggle in <1s without a full rebuild.
- **Hard contract enforcement**: a host app's panel toggle that violates this contract (text label visible, off-center vertically, missing arrow direction, hand-bound click listener, force-open on every nav) is patched by post-panels on the next run. The QA patch library entry `api-panel-toggle-latest` re-runs post-panels automatically when build-qa flags panel-visibility or panel-toggle issues.

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

**Build-QA scope by build mode** — In `app-only` builds, the vision QA judges app-tier steps (`stepKind: "app"`) strictly against each step's `visualState` description: it does **not** enforce that concrete narration values (scores, decisions, dollar amounts, percentages) appear on screen unless `visualState` explicitly describes them as visible. Those values are voiceover-only by design in app-only demos. In `app+slides` builds, and on `stepKind: "slide"` steps in any build mode, the legacy narration-strict gate ("concrete narration claims must be visibly evidenced in frames") still applies. All other QA checks (brand wordmark/nav fidelity, Plaid Link CTA icon ratio, asset authenticity, animation/state-progression when described in visualState, deterministic blockers, panel-visibility when `apiResponse` is declared) apply in both modes. Source: `scripts/scratch/utils/prompt-templates.js` `buildQAReviewPrompt()` + `scripts/scratch/scratch/qa-review.js` (gates `narrationStrict` on `runBuildMode === 'app+slides' || isSlideTier`).

Stages: `research`, `ingest`, `script`, `brand-extract`, `script-critique`, `embed-script-validate`, `build`, `build-qa`, `record`, `qa`, `figma-review`, `post-process`, `voiceover`, `coverage-check`, `auto-gap`, `resync-audio`, `embed-sync`, `audio-qa`, `ai-suggest-overlays`, `render`, `ppt`, `touchup`

### Claude Code / Cursor agents — long-running builds (heartbeat policy)

See **[REQUIRED — Pipeline heartbeat](#required--pipeline-heartbeat-supervising-long-running-builds)** at the top of this file. Same rules (5-minute chat updates, no silent waits, prefer `--non-interactive`, `npm run pipe:status-loop` does not replace chat). Cursor/Claude agents: [`AGENTS.md`](AGENTS.md) + [`.cursor/rules/pipeline-heartbeat.mdc`](.cursor/rules/pipeline-heartbeat.mdc).

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
