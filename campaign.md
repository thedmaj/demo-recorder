# Demo-Build Campaign — Status & Resume Instructions

_Last updated: 2026-06-30. Purpose: verify recent pipeline changes (Brandfetch host-context, host-logo fix, slide-overflow fit-to-canvas) did not introduce regressions, by rebuilding the previous 6-scenario diverse campaign._

## Goal
Rebuild the "6 diverse demos" campaign (originally `out/record-campaign-2026-06-12.json`) to confirm recent changes are clean, then produce **full-fidelity** builds (app + slides + JSON panels → record → render).

## The 6 scenarios
Prompts live at `out/demos/<runId>/inputs/prompt.txt`.

| # | Scenario (source runId) | Products |
|---|---|---|
| 1 | `2026-06-10-Gringo-Coin-Auth-Identity-Signal-Transfer-v1` | Auth + Identity + Signal + Transfer (cross-border) |
| 2 | `2026-06-09-Spring-Eq-CRA-Identity-Signal-v1` | CRA + Identity + Signal |
| 3 | `2026-06-10-Cashrepublic-CRA-Auth-Identity-v1` | CRA + Auth + Identity |
| 4 | `2026-06-10-Ascend-Bank-CRA-Assets-Statements-v1` | CRA + Assets + Statements |
| 5 | `2026-06-10-Scrub-Io-CRA-Identity-Assets-v1` | CRA + Identity + Assets |
| 6 | `2026-06-10-Td-Bank-Auth-Identity-Signal-Transfer-v1` | Auth + Identity + Signal + Transfer |

## Status

### ✅ Done — verification goal met + latent build bugs fixed
- **Recent changes verified clean** (the original goal): smoke Td-Bank **97/100**, Spring-Eq **96/100**; full app+slides build-qa **96** (Gringo) / **95** (Ascend). The logo fix, brand-context, and slide-overflow changes did NOT regress.
- **Fixes committed + pushed to `ghe/main` + `origin` (HEAD `7ef5ddc`):**
  - `build: fix self-inflicted BUILD_STREAM_IDLE + place card interaction targets` (`7ef5ddc`) — **the "Anthropic outage" was OUR 120s idle watchdog** aborting Opus 4.8's healthy minutes-long adaptive-thinking phase. Fixed: `thinking.display:'summarized'` + idle 120s→300s. Also: DOM-contract auto-injection now places display-card interaction targets (card/block fallback). Both verified (23K-char build streams clean; `DOM contract: OK`).
  - `build: harden host-logo fix` (`d2c405c`), `slides: fit-to-canvas + QA-feedback` (`d4515da`), Brandfetch host-context (`57b2beb`), email-binary KB (`034b2eb`).
- **Record ENVIRONMENT confirmed working** — non-headless Chromium launches and records here (was the big unknown).

### ✅ RESOLVED — recording failures were a PORT COLLISION, not a code regression
Earlier in the session the campaign recordings scored **10–19/100**, which looked like a recorder regression. **Root cause: a stray dashboard on port 3737.** `app-server` (the recorder's local app host) defaults to **3737**; a dashboard had been launched on 3737 (for an in-session PMM demo). During recording the browser navigated to `http://localhost:3737` and recorded the **dashboard's app-list UI** instead of the demo app → `window.goToStep is not a function`, every nav `click` timed out (5s), the Plaid modal never opened (`_plaidHandler not ready`), and frames were blank.

**Proof:** with 3737 free, a re-record of the same Ascend build (`resume --from=set-recording-dwells`) went **0 click errors, modal opened (~100s in the CRA flow), all 10 steps captured → record QA 90/100 PASSED** (was 10). The record/post-process path is healthy.

**Operating rule:** **never leave a dashboard (or anything) on port 3737 while recording.** Run the dashboard on another port (e.g. `npm run dashboard` picks 4040), or stop it before a record/full-fidelity run. Check with `lsof -iTCP:3737 -sTCP:LISTEN`.

**Recommended hardening (not yet done):** make the recorder fail loudly on a wrong-app navigation — after `page.goto`, assert `typeof window.goToStep === 'function'` (and/or that a `[data-testid^="step-"]` exists) and abort with a clear error; and/or have `app-server` hard-error instead of silently yielding when 3737 is occupied by a non-app server. This prevents a stray process from ever silently corrupting a recording again.

### ⏳ Remaining — full-fidelity builds (now unblocked)
With 3737 clear and the streaming + DOM-card fixes in, full record→render should complete. Re-run the 4 scenarios (Gringo, Cashrepublic, Ascend, Scrub) via the runner. NOTE: Gringo/Td-Bank are multi-launch (Auth+IDV); the IDV second-launch modal opening still needs its own verification once recordings run on a clean port.

## How to run / resume

### Per-scenario command (fresh build, full fidelity)
```bash
SCRATCH_AUTO_APPROVE=true npm run pipe -- new \
  --prompt=out/demos/<runId>/inputs/prompt.txt \
  --with-slides --with-panels --to=render --research=gapfill --non-interactive
```
Gringo can instead resume its existing run: `npm run pipe -- resume <gringo-runId> --from=build --to=render --with-slides --with-panels --non-interactive`.

### If the Opus stall returns (BUILD_STREAM_IDLE)
Route the build model around the degraded Opus large-streaming path — **proven reliable in probes**:
```bash
BUILD_APP_MODEL=claude-sonnet-4-6 PIPELINE_OPUS_1M=false SCRATCH_AUTO_APPROVE=true npm run pipe -- new …
```
⚠ Must set BOTH: `BUILD_APP_MODEL=sonnet` alone still attaches the Opus `context-1m` beta header (latent bug in `opusMessagesStream`) → Sonnet returns 0 chars. `PIPELINE_OPUS_1M=false` drops the beta so the build uses plain streaming.

### Sequential runner (the background script used this session)
Was at `/tmp/campaign-runner.sh` (ephemeral — recreate if needed). Logic: for each scenario, run the build; retry ONLY on API-degradation signatures (`BUILD_STREAM_IDLE` / `0 chars` / `overloaded` / `529`) with a backoff; **halt** on a deterministic (non-API) failure so it doesn't loop for hours. Run sequentially — record drives a live browser, can't run two at once.

## Open risks / watch-items
1. **`record` stage unverified in this environment.** It runs Chromium **non-headless** to composite the real Plaid Link modal; needs a display/GPU. We never reached a successful record this session. First full build's record-stage entry is the make-or-break — if it errors on display, run on a machine with a screen (or a virtual display).
2. **Anthropic Opus large-streaming intermittent stall.** Use the Sonnet-plain fallback above to keep moving; it self-recovers eventually but can take 45+ min cycles.
3. **`idv-verdict`-class dense slides** flag at the 0.7 autofit floor (≤~80px clip) and record with a below-threshold warning — they need **content reduction** (split or trim the step's `visualState`), not more scaling. Surfaced by design; expected on CRA/IDV scenarios.

## Slide-overflow fix reference (committed `d4515da`)
- **Authorship feedback:** `slide-fix.js` writes `slide-regen-feedback.json` (per-slide score, QA issues, overflow px); `post-slides.js` reads it; `prompt-templates.js` prepends a "fix these exact issues / emit less content" block on regeneration.
- **Fit-to-canvas:** `post-slides.js` injects an autofit runtime (`data-slide-autofit="v2"`) that wraps the frame's flow content and CSS-zooms to fit (floor **0.7**), stamping `data-autofit-zoom`.
- **Autofit-aware gate:** `build-qa.js` `scanSlideCanvasSize` exempts autofit-zoomed slides from the ≥1080px min-canvas contract; the overflow detector still runs at the floor to flag genuinely over-stuffed slides.

## Uncommitted (intentionally held — do NOT bundle into campaign commits)
- `inputs/products/*.md` (cra-base-report, ewa-score, income-insights, investments-move, + auth's AI-research notes) — Group B KB batch, held for **David's sign-off** (AI-synthesized competitive claims / coverage stats).
- `inputs/api-contracts-cache.json`, `inputs/prompt.txt` — regenerable/ephemeral (overwritten each run).
