# QA Fix Log — Pattern Analysis for Prompt & Skill Improvement

> Goal: Identify recurring QA failure categories across pipeline runs and define targeted
> prompt rules or skills that eliminate them before they reach QA.

---

## Run History Summary

| Run | Iter 1 Score | Iter 2 Score | Iter 3 Score | Final | Notes |
|-----|-------------|-------------|-------------|-------|-------|
| 2026-03-14-layer-v4 (Chime/Auth) | 78 | 80 ✓ | 9 (collapse) | Pass iter 2 | Iter 3 collapse = recording broke |
| 2026-03-17-layer-v1 (Chime/Layer) | — | — | — | — | QA not reached |
| 2026-03-21-layer-v1 (Chime/Auth) | 89 ✓ | — | — | Pass iter 1 | Best run — 1-shot |
| 2026-03-23-layer-v1 (Chime/Auth+Signal) | 75 | — | — | In progress | |
| 2026-03-23-layer-v2 (TD Bank) | 58 | In progress | — | — | Current run |

---

## Category 1 — Missing Right-Side JSON Panel

**Frequency: EVERY run with insight screens (5/5)**

### Symptoms
- QA reports "right-side api-response-panel completely absent"
- Actual layout is full-width single-column instead of left-content + right-JSON two-column
- Sometimes right ~50% of viewport is a blank gray area (panel div exists but has no content/style)
- Panel hidden by default CSS (`display:none`) never gets shown during insight steps

### Root cause
Build agent generates insight screens without wiring the `api-response-panel` to auto-expand on step entry.
The `window.goToStep` handler fires `window._stepApiResponses[id]` → `window.updateApiResponse()`, but
the panel's `display:none` CSS is never overridden for insight steps.

### Fix (prompt rule to add to CLAUDE.md or build agent system prompt)

```
INSIGHT SCREEN JSON PANEL — REQUIRED IN EVERY PLAID INSIGHT STEP:
- api-response-panel MUST be expanded (display:flex or display:block) by default FOR INSIGHT STEPS ONLY.
- Use goToStep handler to explicitly call: document.getElementById('api-response-panel').style.display = 'flex'
  for insight steps, and document.getElementById('api-response-panel').style.display = 'none' for consumer steps.
- Layout: CSS grid `grid-template-columns: 1fr 380px` — content left, JSON panel right.
- Panel must contain pretty-printed JSON in <pre> tag, monospace 13px, with a chevron toggle button.
- Default state for insight steps: EXPANDED (panel visible, chevron pointing right to collapse).
- Default state for consumer steps: HIDDEN (display:none).
- The panel toggle button must have data-testid="api-panel-toggle-{stepId}".
```

### Proposed skill
`plaid-insight-json-panel` — Injectable skill that defines the exact panel HTML, CSS grid layout,
and goToStep wiring pattern. Attach to build prompt whenever insight screens are in the storyboard.

---

## Category 2 — Navigation / goToStep Not Firing

**Frequency: HIGH — seen in 2026-03-23-layer-v2 (navigate-transfers 25/100, amount-entry 2/100)**

### Symptoms
- Step shows wrong screen (previous step's content) across all 3 QA frames
- Score is 2–25/100 — essentially 0 (wrong screen entirely)
- "All three frames show [previous step] instead of [this step]"
- Step appears frozen — no transition across start/mid/end frames

### Root cause patterns
1. **Button click navigates to wrong step ID**: onClick handler calls `goToStep('wrong-id')` instead
   of the next step in sequence.
2. **goToStep never called for this step**: The recording script's Playwright action (`click` on a
   CTA button) triggers the next step handler, but the handler was coded to call a different step.
3. **Insight-to-consumer transition**: After an insight step, the `Continue` button's goToStep target
   was hardcoded to wrong consumer step ID, or the button is in the wrong step div.
4. **Competing display:none**: A consumer step div has `style="display:block"` baked in (violating
   the DOM contract) making it always visible and blocking the correct step.

### Fix (existing CLAUDE.md rule — needs stronger enforcement)
Add to build agent prompt:

```
STEP SEQUENCING VERIFICATION — BUILD AGENT MUST CHECK:
Before finalizing the app, trace every goToStep call and verify:
  1. Each step div's primary CTA button calls goToStep(NEXT_STEP_ID) where NEXT_STEP_ID
     matches the immediately following step in demo-script.json.
  2. No step div has inline style="display:block" or style="display:flex" — only CSS classes control visibility.
  3. Every step ID in goToStep() calls exists as a data-testid="step-{id}" div.
  4. Insight steps: the "Continue" or "Next" button goToStep targets the consumer step that follows,
     NOT the same or previous insight step.

Emit a comment block at the end of the <script> tag listing every step transition as:
  // STEP FLOW: step-a → step-b → step-c → ...
This comment acts as a self-check — if any ID is missing or repeated, the build is wrong.
```

---

## Category 3 — Late Step Transitions (Start Frame Shows Previous Step)

**Frequency: HIGH — seen in auth-insight, signal-insight, identity-match-insight across multiple runs**

### Symptoms
- QA: "Start frame shows previous step's screen instead of this step"
- Mid and End frames are correct, only start frame is wrong
- Score penalty: typically -15 to -25 points

### Root cause
The QA start frame is captured at `recordingOffset + 2s`. If a CSS transition takes >2s to complete,
or if the previous step's animation hasn't finished, the start frame catches the tail of the prior step.

The insight screens have `transition: opacity 0.4s, transform 0.4s` on the step container. When
goToStep fires late (e.g. after a 1.5s dwell), the start frame at +2s may still be mid-transition.

### Fix options

**Option A — Reduce transition duration on step containers (preferred)**
```css
/* In build-agent generated CSS: */
.step { transition: opacity 0.2s ease; }  /* was 0.4s */
```

**Option B — Increase QA start frame offset**
In `qa-review.js`, change the start frame capture offset from 2s to 3s for steps that follow
insight screens. Tag these in demo-script.json with `"qaStartOffset": 3`.

**Option C — Add to build prompt**
```
TRANSITION TIMING: Step CSS transitions must complete in ≤200ms (not 400ms).
Use: .step { transition: opacity 0.15s ease; }
Insight-screen fade-in: use requestAnimationFrame to apply .active class one frame after goToStep.
```

---

## Category 4 — Typography: Double Hyphens vs Em Dashes in Headers

**Frequency: MEDIUM — seen in 3 runs (TD v2, Chime v4, Chime layer-v1)**

### Symptoms
- QA: "Header reads 'PLAID API INSIGHT -- AUTH' instead of 'Plaid API Insight — Auth'"
- "Value line uses '--' instead of '—'"
- Also: ALL_CAPS headers instead of Title Case

### Root cause
Build agent uses `--` as separator (keyboard accessible) instead of the HTML entity `&mdash;` or
the Unicode em-dash `—`. Template strings in JavaScript tend to drop em-dashes if not explicitly
specified.

### Fix (add to CLAUDE.md or build prompt)
```
HEADER TYPOGRAPHY RULES:
- Plaid insight screen header: Title Case, NOT ALL_CAPS. Example: "Plaid API Insight — Identity Match"
- Use Unicode em-dash (—) or HTML entity &mdash; — never double hyphen (--)
- Value proposition line: sentence case, single sentence, ends with period.
- No exclamation marks in insight screen headers.
```

---

## Category 5 — Two-Layer Branding Bleed

**Frequency: MEDIUM — seen in 2026-03-23-layer-v2 add-external-account and amount-entry**

### Symptoms
- Consumer (TD-branded) step shows dark Plaid-style UI or Plaid copy
- "Plaid branding visible in consumer step — violates 'no Plaid branding' requirement"
- Mid/end frame of a consumer step shows a dark interstitial instead of light TD UI
- amount-entry step stuck showing auth-insight (Plaid dark) background

### Root cause
1. The `add-external-account` step's "Connect Your Bank" CTA was styled with Plaid dark theme
   (dark background, teal button) rather than TD light theme.
2. The `amount-entry` step div was missing entirely OR its `goToStep` was never called after
   the `auth-insight` Continue button — making auth-insight's final frame bleed into amount-entry's window.

### Fix (build prompt addition)
```
TWO-LAYER VISUAL SEPARATION — ENFORCED RULES:
Consumer steps (TD UI):
  - Background: white or brand light (#ffffff, #f8f9fa, or brand light neutral from brand.json)
  - No Plaid dark navy (#0d1117) backgrounds
  - No teal (#00A67E) as the dominant color
  - api-response-panel and link-events-panel: display:none
  - Header: TD brand header with logo and nav

Plaid insight steps:
  - Background: #0d1117 (dark navy) or gradient
  - Full-viewport: step div height 100vh, no TD header/nav visible
  - api-response-panel: expanded by default
  - Thin teal header bar (#00A67E), white text, Title Case title

NEVER mix these: a consumer step div must never inherit or share styles with an insight step div.
Generate separate CSS class prefixes: .td-step and .plaid-step — do not share background/color rules.
```

---

## Category 6 — Insight Screen Layout Collapse (Right Half Empty/Gray)

**Frequency: MEDIUM — seen in 2026-03-23-layer-v1 (both Auth and Signal insight)**

### Symptoms
- Right ~50% of viewport is blank gray area
- Panel div exists in DOM but contains no content, or has wrong display mode
- "Large gray area to the right" / "right half unexplained gray area"
- Layout looks like the grid column exists but the panel content is empty

### Root cause
Build agent creates the CSS grid layout (`grid-template-columns: 1fr 380px`) but the
`api-response-panel` div for that specific step has no content injected, or
`window._stepApiResponses[stepId]` is undefined so `updateApiResponse()` clears the panel.

### Fix
```
For every insight step, window._stepApiResponses must be populated with the full JSON response
BEFORE the app loads (not lazily). Initialize in a <script> block:

window._stepApiResponses = {
  'identity-match-insight': { endpoint: '/identity/match', response: { /* full JSON */ } },
  'auth-insight':           { endpoint: '/auth/get',       response: { /* full JSON */ } },
  'signal-insight':         { endpoint: '/signal/evaluate',response: { /* full JSON */ } },
};

The updateApiResponse() function must render the response as pretty-printed JSON in the panel
AND set the panel's display to 'block'/'flex' for insight steps.
```

---

## Category 7 — Closing Summary / Full-Viewport Layout Issues

**Frequency: LOW-MEDIUM — seen in 2 runs**

### Symptoms
- Closing screen only occupies ~50% of viewport; large gray area surrounds it
- Plaid logo is left-aligned instead of centered
- Layout not truly full-viewport

### Root cause
The closing-summary step div inherits the two-column grid layout from adjacent insight steps.
The step needs its own full-width single-column layout override.

### Fix
```css
[data-testid="step-closing-summary"] {
  display: flex !important;  /* ONLY on .active */
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 100vh;
  /* Override any inherited grid */
  grid-template-columns: unset;
}
/* Logo: centered bottom */
[data-testid="step-closing-summary"] .plaid-logo {
  position: absolute;
  bottom: 40px;
  left: 50%;
  transform: translateX(-50%);
}
```

---

## Proposed Skills / Prompt Improvements

### Priority 1 — Add to CLAUDE.md immediately

1. **JSON Panel wiring rule** (Category 1): `api-response-panel` must auto-expand on insight steps.
2. **Step flow comment block** (Category 2): Build agent must emit `// STEP FLOW:` comment verifying
   every transition.
3. **Transition timing** (Category 3): `.step { transition: opacity 0.15s ease; }` max.
4. **Typography** (Category 4): Em-dashes, Title Case, no ALL_CAPS in insight headers.

### Priority 2 — New build prompt sections

5. **Two-layer separation** (Category 5): `.td-step` vs `.plaid-step` prefixes.
6. **`_stepApiResponses` pre-population** (Category 6): Full JSON initialized in `<script>` block.
7. **Closing summary layout** (Category 7): Full-viewport override CSS pattern.

### Priority 3 — New skills to define

- **`plaid-insight-screen`**: Canonical template for a two-column Plaid insight screen with:
  - Teal header bar (Title Case, em-dash separator)
  - Left: summary cards (scores, fields, badges)
  - Right: pre-populated JSON panel, expanded by default, with chevron toggle
  - Full-viewport dark navy background
  - Consumer-step style isolation

- **`step-transition-debug`**: Post-build validation skill that:
  - Traces every `goToStep()` call in the generated HTML
  - Verifies every step ID exists as a `data-testid`
  - Flags any step with no inbound `goToStep()` call (orphan step = recording will never show it)
  - Checks for inline `display:` styles on step divs

---

## QA Score Trend by Category

| Category | Typical Score When Hit | Points Lost | Fix Complexity |
|----------|----------------------|-------------|----------------|
| Missing JSON panel | 52–62 | ~30 pts | Low — CSS + JS wiring |
| goToStep not firing | 2–25 | ~75 pts | Medium — logic trace |
| Late transition (start frame) | 55–72 | ~15 pts | Low — CSS timing |
| Typography (-- vs —) | 55–65 | ~10 pts | Trivial — prompt rule |
| Branding bleed | 15–52 | ~40 pts | Medium — CSS isolation |
| Gray half-panel | 52–62 | ~30 pts | Low — JS initialization |
| Closing layout | 62–72 | ~20 pts | Low — CSS override |

**If Categories 1, 2, and 5 are fixed by prompt rules alone, estimated iter-1 QA score improves
from ~58–75 → ~85–90, eliminating most rebuild cycles.**
