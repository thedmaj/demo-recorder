# Plaid Demo Pipeline — Claude Instructions

## Project Overview
This is an automated demo video production pipeline for Plaid products. Claude agents
in this pipeline handle: product research (AskBill + Glean), demo script generation,
local web app building, Playwright recording, QA review with refinement loops, ElevenLabs
voiceover, and Remotion video composition.

All pipeline commands run without human intervention by default (`SCRATCH_AUTO_APPROVE=true`).

**Author prompts for story and product intent** using [`inputs/prompt-template.txt`](inputs/prompt-template.txt). Technical integration patterns are loaded from [`skills/plaid-integration.skill`](skills/plaid-integration.skill) at research, script, and build stages; `RESEARCH_MODE` / **Research depth** in the prompt controls how much AskBill/Glean runs on top. If neither is set, research defaults to **`gapfill`** (targeted AskBill, minimal Glean).

---

## Brand Voice
- Confident, precise, outcome-focused. Never apologetic or jargon-heavy.
- Lead with customer value, not technical implementation details.
- Use active voice. "Plaid verifies the document in real time" not "the document is verified."
- Quantify value where possible: "Signal score 12 — ACCEPT", "verified in under 3 seconds."
- Never use: "simply", "just", "unfortunately", "robust", "seamless" (overused).
- Approved product names: "Plaid Identity Verification (IDV)", "Plaid Instant Auth",
  "Plaid Layer", "Plaid Monitor", "Plaid Signal", "Plaid Assets".

---

## Plaid Design System (use these in ALL generated HTML)
- Background: `#0d1117` (dark navy) or `linear-gradient(135deg, #0d1117, #0a2540)`
- Accent / CTA: `#00A67E` (Plaid teal)
- Text primary: `#ffffff`
- Text secondary: `rgba(255,255,255,0.65)`
- Text tertiary: `rgba(255,255,255,0.35)`
- Accent border: `rgba(0,166,126,0.45)`
- Accent bg tint: `rgba(0,166,126,0.12)`
- Error/risk: `#f87171`
- Font: `system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`
- Effects: `backdrop-filter: blur(8px)` for overlay panels
- Viewport: Always design for `1440×900` (Playwright recording resolution)

---

## Demo Quality Standards

### A great Plaid demo has:
- Clear problem statement in the first 15 seconds
- A named persona with a specific, relatable use case
- 8–14 steps, 2–3 minutes total duration
- Narration of 20–35 words per step (fits ~8–12s of speech at 150 wpm)
- A climactic "reveal" moment (Signal ACCEPT score, instant approval, matched identity, etc.)
- Quantified outcomes ("Signal score 12 — ACCEPT", "verified in 2.4 seconds")
- A clear CTA or outcome in the final screen

### Anti-patterns to avoid:
- Showing error states, edge cases, or declined flows
- More than 35 words of narration per step
- Generic placeholder data (use realistic persona details)
- Steps that show loading spinners without resolving
- Passive voice or apologetic tone
- Technical API jargon without context

### Narrative Arc (always follow this structure):
1. **Problem** — The user/developer faces a friction or compliance challenge
2. **Solution entry** — Plaid product is introduced as the answer
3. **Frictionless experience** — Walk through the key flow steps
4. **Key reveal** — The "wow moment" (score, approval, matched data)
5. **Outcome** — The result: faster, safer, more compliant

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
- The host app has a button that calls `window._plaidHandler.open()` — no simulated overlay divs
- The real Plaid SDK modal appears as an iframe over the host page during the entire flow
- `record-local.js` uses CDP frameLocator to automate the real iframe (phone → OTP → institution → account)
- When `onSuccess` fires, the host app advances to the first post-link step

**Build agent instructions (no-capture mode):**
- Do NOT build step divs for link-consent, link-otp, link-account-select, link-success, or any Plaid screens
- The Plaid Link button (`data-testid="link-external-account-btn"`) MUST be inside the initiate-link step div
- Button onclick: `if (window._plaidHandler) window._plaidHandler.open();` — no goToStep call
- `window._plaidLinkComplete = true` is set ONLY in `onSuccess` — NEVER in a goToStep handler
- `onSuccess` stores institution/account metadata: `window._plaidInstitutionName`, `window._plaidAccountName`, `window._plaidAccountMask` — use these in post-link steps, never hardcode bank names
- Pre-populate all post-link API responses with sandbox data
- The initiate-link step in `demo-script.json` MUST have `"plaidPhase": "launch"`
- The playwright-script for this step: ONE entry with `action:"click"`, `target:"[data-testid=\"link-external-account-btn\"]"`, `waitMs: 120000`
  - NEVER split into a goToStep entry + click entry — this causes duplicate `markStep` calls

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

### CRA / Consumer Report Link Requirements (Base Report + Income Insights)

- CRA demos MUST use the real Plaid Link CRA/Check experience (single `"plaidPhase": "launch"` step with real SDK modal).
- Do not replace CRA Link with host-only pseudo flows, simulated forms, or custom wizard screens.
- CRA setup must include user setup semantics before report retrieval (`/user/create` identity context + permissible purpose in token config).
- For CRA stories, `"/link/token/create"` products should include `cra_base_report` and `cra_income_insights` when income insights are part of the flow.
- CRA retrieval remains asynchronous: show a report-ready lifecycle beat before insight retrieval.
- Plaid Passport may be present via enabled templates for stronger identity verification; treat Passport as optional per account configuration, but never omit the core CRA Link/consent experience.
- Any CRA "setup" or "data returned / report returned" explanatory scene should use a Plaid-branded slide step (`.slide-root`) instead of customer-branded host chrome.

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

## Recording & Audio Quality Standards

### Screen recording (record-local.js)
- `headless: false` — GPU compositor; captures real Plaid Link modal in recordVideo
- CSS viewport: `1440×900` — app designed for this layout
- `deviceScaleFactor: 2` — physical pixels 2880×1800
- `recordVideo.size: { width: 2880, height: 1800 }` — native 2× resolution output

### Post-process encoding (post-process-recording.js)
- VP8 codec, `-b:v 8000k` bitrate, `-crf 10` (near-lossless) — optimised for 2880×1800
- Do not lower bitrate or raise CRF without explicit instruction

### Voice / TTS quality (generate-voiceover.js)
- Model: `eleven_multilingual_v2` (or override via `ELEVENLABS_MODEL_ID`)
- Output format: `mp3_44100_192` — 192kbps 44.1kHz (highest MP3 quality ElevenLabs supports)
- Voice settings: `stability: 0.75`, `similarity_boost: 0.90`, `use_speaker_boost: true`
- Higher `stability` minimises stutter/freeze artefacts from the TTS model

### Audio QA (orchestrator.js audio-qa stage)
Per-clip stutter/freeze detection runs before render:
- Uses `ffmpeg silencedetect noise=-40dB:d=0.15` on each individual `vo_*.mp3` clip
- Any internal silence ≥ 0.15s (stutter) or ≥ 0.5s (freeze) → clip deleted and regenerated
- The stitched `voiceover.mp3` is also deleted and rebuilt after regeneration
- After per-clip pass: overall clipping / duration-desync checks run as before
- Report written to `audio-qa-report.json` in the run directory

## Remotion Overlay Conventions

Rules for `ScratchComposition.jsx` overlays. Follow these in touchup requests and future agents.

### ClickRipple
- Teal concentric ring (`rgba(0,166,126,0.8)`) at the click element's center
- Base size: 120px (in 2880×1800 render coords); visible for 45 frames
- Fires at `step.startFrame + atFrame` (default `atFrame: 15`)
- Auto-generated by `buildRemotionProps()` from `click-coords.json`

### Zoom
- Click steps: zoom origin = click position (`zoomPunch.originX/Y`), scale 1.08×, peak at 50% of step
- API insight steps (duration > 12s, no click coord): zoom origin center, scale 1.06×, peak at 30%
- **Never** zoom the `wf-link-launch` step — already speed-adjusted by `SYNC_MAP_S`
- `zoomPunch` supports both legacy `true` (1.08× center) and object form `{ scale, peakFrac, originX, originY }`

### Lower-thirds
- Auto-generated for every step that has `apiResponse.endpoint`
- Shows endpoint name as title + first 8 words of narration as subtext
- Teal accent bar on left; dark glassmorphism background; bottom-left position

### Badge callouts
- Reserved for outcome/stat moments only (`plaid-outcome` step)
- Position: top-right by default

### Stat counters (`type: "stat-counter"`)
- Auto-generated for `plaid-outcome` step by parsing numbers from narration
- Numbers count up from 0 over the first 60% of step duration
- Positions `stat-1/2/3` → left/center/right at `bottom: 180px`
- Do not use for steps other than `plaid-outcome`

### Cross-dissolve
- 6-frame black fade at each hard-cut boundary (from `cutFrames` in `remotion-props.json`)
- Cut frames derived from `processed-step-timing.json` `keepRanges` boundaries

### Audio ducking
- Volume dips 15% for 20 frames centered on each click ripple frame
- Automatically computed in `ScratchComposition` from `clickRipple.atFrame` values

### Data flow
`record` stage → `click-coords.json` → `buildRemotionProps()` → `remotion-props.json` → Remotion render
No manual editing of `remotion-props.json` needed for standard overlays.

---

## Pipeline Restartability
Every stage reads its inputs from disk (JSON files in `out/`). To restart from any stage:
```
npm run demo -- --from=STAGE_NAME
```
To **stop early** after a stage (e.g. build the demo and run **build-only QA** without recording):
```
npm run demo:build-qa
# equivalent:
npm run demo -- --to=build-qa
```
`build-qa` walks `scratch-app` with Playwright, screenshots each script step, and runs the same Claude vision QA as post-record QA against `demo-script.json` `visualState` — output `qa-report-build.json` in the run dir. Optional: `BUILD_QA_STRICT=1` to exit non-zero if the score is below `QA_PASS_THRESHOLD`.

Stages: `research`, `ingest`, `script`, `brand-extract`, `script-critique`, `embed-script-validate`, `build`, `build-qa`, `record`, `qa`, `figma-review`, `post-process`, `voiceover`, `coverage-check`, `auto-gap`, `resync-audio`, `embed-sync`, `audio-qa`, `ai-suggest-overlays`, `render`, `ppt`, `touchup`

---
## Slide Template and Storyboard Slides

### Slide template (PowerPoint supplement)
Slides are generated from a reusable Plaid-only template so the styling stays consistent across pipeline runs and presentations. **Slides are only for behind-the-scenes API/data explanation** (optional `.slide-root` steps). The **host bank UI** uses Brandfetch-driven `brand/<slug>.json`, not slide chrome. Full-viewport **Plaid insight** steps use the insight + `#api-response-panel` contract unless they explicitly use `.slide-root`.

- Template folder: `templates/slide-template/`
  - `base.html` — slide surface structure contract
  - `slide.css` — Plaid-only tokens + typography + panel patterns
  - `SLIDE_RULES.md` — non-negotiable generation rules for the agent

### How the build uses the template
During the `build` stage, the app-generation prompt includes:
- `SLIDE_RULES.md`
- `slide.css`

This is wired via:
- `scripts/scratch/scratch/build-app.js` (loads template files from disk)
- `scripts/scratch/utils/prompt-templates.js` (injects the template content into the system prompt)

### Storyboard: adding “Slide” steps with optional Glean messaging
In the dashboard storyboard “Add New Step” modal:
- Choose `Scene type = Slide`
- Optionally enable `Research messaging (Glean)`

When enabled, the UI sends `useGleanResearch: true` to:
- `POST /api/runs/:runId/generate-step`

The server calls `gleanChat(...)` before Claude Haiku generates the slide step JSON, using the user’s slide description as the query context.

### Prompt convention for slide output
`inputs/prompt.txt` contains a dedicated block:
- `[[SLIDE_OUTPUT_BEGIN]] ... [[SLIDE_OUTPUT_END]]`

The script-generation prompt extracts this block and exposes it to Claude as `SLIDE OUTPUT REQUIREMENTS` so slide-generation intent stays explicit across runs.

## Output Versioning
Every pipeline run writes to `out/demos/{YYYY-MM-DD}-{product-slug}-v{N}/`.
`out/latest/` symlinks to the most recent run.
