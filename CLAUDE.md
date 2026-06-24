# Plaid Demo Pipeline — Claude Instructions

## Project Overview
This is an automated demo video production pipeline for Plaid products. Claude agents
in this pipeline handle: product research (AskBill + Glean), demo script generation,
local web app building, Playwright recording, QA review with refinement loops, ElevenLabs
voiceover, and Remotion video composition.

All pipeline commands run without human intervention by default (`SCRATCH_AUTO_APPROVE=true`).

**Author prompts for story and product intent** using [`inputs/prompt-template.txt`](inputs/prompt-template.txt). Research starts with **Solutions Master** context (solutions → components/APIs → playbook/play value props) when the prompt includes “Solutions supported”. Technical integration patterns load from [`skills/plaid-integration.skill`](skills/plaid-integration.skill) (a ZIP — edit via `npm run validate:plaid-skill`, not directly), with AskBill/Glean for gaps. `RESEARCH_MODE` / **Research depth** controls depth; default is **`gapfill`** (targeted AskBill, minimal Glean).

> **This file is a thin index.** Detailed rules live in skills (`.claude/skills/*`) and product
> knowledge files (`inputs/products/*.md`). The **Pointer index** below maps each concern to its
> owning file — load that file when you work in that area. Only the always-true contracts and the
> critical-gotchas cheat-sheet are kept inline here.

---

## REQUIRED — Pipeline heartbeat (binding obligation)

**Applies to Claude Code, Cursor Agent, and any assistant that starts or watches pipeline work.**
This is a binding obligation, not background documentation. Full CLI detail + `::PIPE::` event
reference: [`pipeline-cli`](.claude/skills/pipeline-cli/SKILL.md).

The orchestrator emits **`::PIPE:: event=heartbeat`** every **5 minutes** (override
`PIPELINE_HEARTBEAT_MS`) **while a stage is running**, and writes `pipeline-heartbeat.json` +
a `[HEARTBEAT]` section in `artifacts/logs/pipeline-build.log.md`.

1. **Observe heartbeats (preferred):** when supervising a long-running Shell call, configure
   `notify_on_output: { pattern: "::PIPE:: event=heartbeat", reason: "5min pipeline heartbeat", debounce_ms: 280000 }`.
   On each tick, post a one-line summary: `stage=<name>, elapsed=<s>s, lastLogActivity=<s>s ago, awaiting=<bool>`.
2. **Background orchestrator:** run `npm run pipe -- monitor [RUN_ID]` in parallel (same pattern).
3. **Fallback poll:** `npm run pipe -- status --json` exposes `lastHeartbeatAt`,
   `lastHeartbeatAgeSec`, `heartbeatStale`, `running`, `runningStage`, `awaitingContinue`,
   `firstFailed`, `nextRecoveryCommand`.
4. **Don't wait to be asked.** Proactive status on every heartbeat tick is the default.
5. **No silent waiting on stalls:** if `heartbeatStale: true` or no heartbeat for >2× interval
   while `running: true`, investigate (`activePid`, tail log). Suggest `pipe stop <RUN_ID>` only
   if the user wants to abort.
6. **Avoid stdin blocks:** prefer `npm run pipe … --non-interactive` (and/or
   `SCRATCH_AUTO_APPROVE=true`).

Mirrors: [`AGENTS.md`](AGENTS.md), [`.cursor/rules/pipeline-heartbeat.mdc`](.cursor/rules/pipeline-heartbeat.mdc).

---

## Critical gotchas — always-loaded cheat-sheet

These are the highest-blast-radius mistakes; the owning file has the full rules.

- **Approved product names (verbatim):** Plaid Identity Verification (IDV), Plaid Instant Auth,
  Plaid Layer, Plaid Monitor, Plaid Signal, Plaid Assets, Plaid Protect. → [`saas-demo-design-principles`](.claude/skills/saas-demo-design-principles/SKILL.md)
- **Signal score is 1–99, higher = HIGHER ACH return risk.** ACCEPT demos use 5–20; never 82–97.
  `ruleset.result` ∈ {ACCEPT, REVIEW, REROUTE} — **`REJECT` is NOT documented.** → [`inputs/products/plaid-signal.md`](inputs/products/plaid-signal.md)
- **Trust Index / Ti2 is Plaid Protect only** (Limited Availability). Retrieve via
  `POST /protect/event/send` or `POST /protect/user/insights/get` — **never** `/signal/evaluate`,
  and never label a Signal `scores.*` value "Trust Index". → [`inputs/products/plaid-protect.md`](inputs/products/plaid-protect.md)
- **`'protect'` must never appear in `products[]`** — Protect is an umbrella, not one API.
- **`products[]` is research-driven, never hardcoded** — use `linkTokenCreate.suggestedClientRequest` verbatim. → [`plaid-demo-app-build`](.claude/skills/plaid-demo-app-build/SKILL.md)
- **Layer + CRA = ONE Layer session, NO separate CRA Link launch.** Layer permissions
  accounts AND collects identity in a single launch; the Consumer Report is generated
  server-side (`/user/update` → `/cra/check_report/create` → `USER_CHECK_REPORT_READY` →
  `…/base_report/get`). CRA Layer demos use **`CRA_LAYER_TEMPLATE`**
  (= `template_3fvao27ap3bp`) + **`CRA_CLIENT_ID`/`CRA_SECRET`**; **non-CRA** Layer uses
  `PLAID_LAYER_TEMPLATE_ID`. → [`plaid-layer-cra-onboarding`](.claude/skills/plaid-layer-cra-onboarding/SKILL.md)
- **Main demo = happy path only.** No error / declined / edge-case flows. Active voice; avoid
  filler ("simply", "just", "unfortunately", "robust", "seamless"). → [`saas-demo-design-principles`](.claude/skills/saas-demo-design-principles/SKILL.md)
- **Realistic but idealized data** — no 100/100 scores, no sub-1s responses. Verify exact field
  names/types via AskBill; never fabricate fields or `reason_codes[]`.
- **IDV statuses:** `active`, `success`, `failed`, `pending_review`. Never show API errors in main flows.
- **Plaid Link narration boundary (updated 2026-06-24):** the Link step narration OPENS with a short
  bridge introducing the Plaid Link experience — naming the ACTUAL on-screen button + that it brings up
  Plaid Link — to cover the ~2-3s modal load, then describes what's inside. For phone+OTP (returning-user)
  flows, weave in the Plaid-network framing ("~1 in 2 U.S. adults have connected a bank with Plaid Link").
  Button name must match the rendered CTA. → [`saas-demo-design-principles`](.claude/skills/saas-demo-design-principles/SKILL.md)
- **Host app background:** default host/customer screens to white/light neutral; reserve
  Plaid-dark for Plaid-specific contexts. → [`saas-demo-design-principles`](.claude/skills/saas-demo-design-principles/SKILL.md)
- **Adding/removing a step after build ⇒ re-sync the recording nav script.** The recorder
  iterates **`scratch-app/playwright-script.json`** (NOT `demo-script.json`), and that nav script
  is generated **once at build**. Any step you add later (agent edit + `post-slides`, hand edit) is
  silently **skipped by `record`** unless the nav script is reconciled — a slide inserted at index 0
  records *last* or not at all. Reconcile is automatic in **`set-recording-dwells`** (runs before
  every `record`) and in the dashboard storyboard insert/remove endpoints, so **re-record from
  `--from=set-recording-dwells` (or earlier), NOT `--from=record`.** Direct `pipe stage record`:
  first run `pipe stage set-recording-dwells` or
  `node -e "require('./scripts/scratch/utils/sync-recording-script').reconcileRecordingScript('<runDir>')"`.
  → [`plaid-demo-app-build`](.claude/skills/plaid-demo-app-build/SKILL.md)
- **Plaid Link integrity — modal RECORDED (hard gate), not CLIPPED / present in final (warn).** A
  `plaidPhase:"launch"` step can record host UI only (modal never composites), shipping a Plaid-less
  demo (Cox Automotive, 2026-06-18). Checks (`scripts/scratch/utils/plaid-link-integrity.js`, report
  `plaid-link-integrity.json`): **post-record** (QA category `plaid-modal-missing`) — **the ONLY
  hard halt** (strict by default); reads the post-record `qa-report-N.json`, NOT build-qa's
  token-only report, so it never fires on the typical build-qa pass. **post-process** (launch kept
  `< PLAID_LINK_MIN_KEEP_S`=4s → clipped) and **final-video** (vision-samples `demo-scratch.mp4`'s
  launch window) **WARN only** — recoverable/patchable, not halts. The modal-missing root cause is
  almost always patchable (a `/link/token/create` error or Plaid SDK init / `handler.open()`
  failure, or the app covering the modal): an agent/human patches the app + re-records
  (`--from=record`). Clipping → re-run `--from=post-process` (larger `--max-institution`). Override
  the halt only with `PLAID_LINK_STRICT=false` / `PLAID_LINK_BYPASS=true`. → [`plaid-demo-app-build`](.claude/skills/plaid-demo-app-build/SKILL.md)

---

## Plaid Link sandbox — quick reference

Full reference: [`inputs/plaid-link-sandbox.md`](inputs/plaid-link-sandbox.md). Runtime functions:
`scripts/scratch/utils/plaid-browser-agent.js`.

- Default institution: **First Platypus Bank** (`ins_109508`) — non-OAuth
- Default credentials: `user_good` / `pass_good` · MFA OTP: `1234` · Remember Me OTP: `123456`
- OAuth institution: **Platypus OAuth Bank** (`ins_127287`) — OAuth redirect → `agent.handleOAuthFlow()`
- CRA / Consumer Report Link: `user_credit_profile_*` + `pass_good` (non-OAuth only). NOT
  `user_bank_income` (that is **Bank Income** — see [`inputs/products/plaid-bank-income.md`](inputs/products/plaid-bank-income.md))
- IDV persona: Leslie Knope — see `inputs/plaid-link-sandbox.md § 5`
- Always skip the Remember Me phone screen via "Continue without phone number"
- **OTP entry (classic Link AND Layer/IDV modals):** wait **≤1.5s** ("receive the code" beat)
  before entry begins, then **human-type** the sandbox OTP (`123456`) at keystroke speed and
  submit **scroll-free** (Enter; in-iframe DOM `.click()` fallback — never a `frameLocator` click,
  which scroll-jitters the modal). Classic Link: `PLAID_OTP_BEFORE_MS` (default 1500). Layer/IDV
  modal: `PLAID_LAYER_OTP_BEFORE_MS` (default 1500, hard-capped at 1500) via
  `enterModalOtpIfPresent` in the Layer/IDV nav loop.
- **Human-like nav pacing is the DEFAULT** (`PLAID_NAV_STYLE=human`; `fast` = legacy machine
  speed). Per-experience screen graphs + pacing live in `inputs/plaid-nav-profiles/*.json`
  (classic-link, embedded-link, layer, cra-link, idv); calibrate with
  `node scripts/test-plaid-nav-calibrate.js --experience=<x> --app=out/demos/<run>`.
  Post-process cut preset: `PLAID_CUT_PRESET=tight|relaxed|natural` (default tight).

---

## Pointer index — where the rules live

**Convention (product KB vs skill):** `inputs/products/<slug>.md` = **product knowledge base** —
per-product *canonical facts + demo content*, structured to [`inputs/products/_template.md`](inputs/products/_template.md)
and machine-indexed by research / `product-knowledge-coverage.js` / the link-token resolver (one file
per product). `.claude/skills/<name>/SKILL.md` = **agent skill** — *how-to playbooks*, especially
cross-product flows and pipeline procedures, which reference the KBs for facts. When they overlap, the
product KB wins on facts; the skill wins on sequencing. (Legacy loose docs under `skills/*.md` are
referenced by path; new skills go in `.claude/skills/`.)

| Concern | Owning file |
|---------|-------------|
| Onboarding: Plaid Layer prefill → Identity Verification (IDV) KYC, joined by shared `client_user_id` (cross-product flow) | [`plaid-layer-idv-onboarding`](.claude/skills/plaid-layer-idv-onboarding/SKILL.md) |
| Onboarding: Plaid Layer → CRA (Consumer Report) — ONE Layer session (no separate CRA Link), server-side report gen; `CRA_LAYER_TEMPLATE` + `CRA_CLIENT_ID`/`CRA_SECRET` | [`plaid-layer-cra-onboarding`](.claude/skills/plaid-layer-cra-onboarding/SKILL.md) |
| Build the host app: DOM contract, `goToStep`, `data-testid`, API panel / link-events contracts, manual nav, Plaid Link real-SDK recording, Link event names, `Plaid.create` callback, `products[]` resolution, onSuccess panel | [`plaid-demo-app-build`](.claude/skills/plaid-demo-app-build/SKILL.md) |
| Script / narration / persona / pacing / brand voice / prohibited words / reveal moments / host background | [`saas-demo-design-principles`](.claude/skills/saas-demo-design-principles/SKILL.md) |
| Slides (`.slide-root`): Deck Design System, canvas contract, chrome/logo, build-qa slide scanners, app-only invariant, drift checkpoint, slide-fix recovery | [`plaid-slide-design`](.claude/skills/plaid-slide-design/SKILL.md) + [`plaid-workhorse-slides`](.claude/skills/plaid-workhorse-slides/SKILL.md) |
| Pipeline CLI, heartbeat, tier-aware QA recovery (`app-touchup` / `slide-fix`), build mode (app-only vs slides), restartability, post-build preview, stages, dashboard | [`pipeline-cli`](.claude/skills/pipeline-cli/SKILL.md) |
| Voiceover / audio sync / SSML / sync-map | [`audio-sync-mastery`](.claude/skills/audio-sync-mastery/SKILL.md) |
| Remotion composition / overlays / captions / metadata | [`remotion-best-practices`](.claude/skills/remotion-best-practices/SKILL.md), [`remotion-studio`](.claude/skills/remotion-studio/SKILL.md) |
| Embedded Link UX / pre-link host UI | [`skills/plaid-link-embedded-link-skill.md`](skills/plaid-link-embedded-link-skill.md), [`skills/plaid-link-prelink-ui-skill.md`](skills/plaid-link-prelink-ui-skill.md) |
| Plaid Transfer (funding / disbursement / ledger / Fund & Protect) | [`plaid-transfer`](.claude/skills/plaid-transfer/SKILL.md) |
| Per-product API shapes, gotchas, Link products, endpoints | [`inputs/products/*.md`](inputs/products/) (one file per product) |
| Human-like Plaid nav pacing: per-experience screen graphs, pacing params, observed sandbox latencies (p50/p90), calibration + feedback loop | [`inputs/plaid-nav-profiles/*.json`](inputs/plaid-nav-profiles/) + `scripts/scratch/utils/human-pacing.js` / `plaid-nav-profile.js` / `plaid-nav-feedback.js` + `scripts/test-plaid-nav-calibrate.js` |

### Per-product quick map (`inputs/products/*.md`)

| Product | One-line gotcha |
|---------|-----------------|
| [Liabilities](inputs/products/plaid-liabilities.md) | Non-FCRA, daily-cached. `["liabilities"]` or LIT bundle; never with `cra_*`. **No federal student loans** since Aug 2024 (private servicers only). |
| [Investments](inputs/products/plaid-investments.md) vs [Investments Move](inputs/products/plaid-investments-move.md) | `investments` → holdings/transactions (no acct #). **`investments_auth`** → `/investments/auth/get` with `numbers.acats[]` + DTC. Never confuse. |
| [Protect](inputs/products/plaid-protect.md) | Umbrella (Trust Index + Signal + IDV + Monitor). Default demo: `['protect_linked_bank']` → `/protect/event/send`. Never `'protect'` in `products[]`. |
| [Signal](inputs/products/plaid-signal.md) | `/signal/evaluate`; add `'signal'` to Link only for transaction-time scoring. |
| [EWA / Cash Advance Score](inputs/products/plaid-ewa-score.md) | Protect family. Link `["auth","signal"]`; `scores.cash_advance.score` (1–99, higher=riskier). Never route to `funding`. |
| [CRA Base Report](inputs/products/plaid-cra-base-report.md) / [LendScore](inputs/products/plaid-cra-lend-score.md) / [Cashflow Insights](inputs/products/plaid-cra-cashflow-insights.md) | Real-SDK CRA Link (`plaidPhase:"launch"`); `/user/create` + permissible purpose; async report-ready beat. |
| [Bank Income](inputs/products/plaid-bank-income.md) / [Income Insights](inputs/products/plaid-income-insights.md) | `income_verification` only accepts `{income_verification, employment}` in a Link token. |
| [Layer](inputs/products/plaid-layer.md) | **Live Plaid Layer Web SDK** (`Plaid.create`+`submit`/`open`) — a real modal that loads, exactly like Plaid Link; **no mobile mockup**. Sandbox eligible phone **`+14155550011`** (`LAYER_READY`), ineligible `+14155550000`. Order: `submit(phone)` first → `open()` on `LAYER_READY`. Prefill only (unverified) → chain [IDV](inputs/products/plaid-identity-verification.md) to KYC. **With CRA: ONE Layer session (no separate CRA Link) — `CRA_LAYER_TEMPLATE` + `CRA_CLIENT_ID`/`CRA_SECRET`, report generated server-side.** → [`plaid-layer-cra-onboarding`](.claude/skills/plaid-layer-cra-onboarding/SKILL.md) |
| [Identity Verification (IDV)](inputs/products/plaid-identity-verification.md) | `products: ["identity_verification"]` — **mutually exclusive** with all other products. Template-driven (Document + Data Source + Selfie). `onSuccess` = submitted, not passed; verdict via `/identity_verification/get`. Sandbox persona: Leslie Knope. |
| [Auth](inputs/products/plaid-auth.md) / [Transfer](inputs/products/plaid-transfer.md) | See files. Transfer: Signal runs INSIDE `/transfer/authorization/create`. |

---

## Pipeline defaults (load-bearing — do not change casually)

Changing any of these requires a documented reason. Deep guidance in the owning skill.

- **Screen recording** (`record-local.js`): `headless: false` (captures the real Plaid Link
  modal), CSS viewport `1440×900`, `deviceScaleFactor: 2`, `recordVideo.size: 2880×1800`.
- **Post-process encoding** (`post-process-recording.js`): VP8, `-b:v 8000k`, `-crf 10`.
- **Voiceover** (`generate-voiceover.js`): `eleven_multilingual_v2`, `mp3_44100_192`,
  `stability: 0.75`, `similarity_boost: 0.90`, `use_speaker_boost: true`. Do **not** lower stability. → [`audio-sync-mastery`](.claude/skills/audio-sync-mastery/SKILL.md)
- **Audio QA:** per-clip `ffmpeg silencedetect noise=-40dB:d=0.15`; stutter (≥0.15s) / freeze
  (≥0.5s) → regenerate clip + rebuild `voiceover.mp3`.
- **Remotion overlays** (`ScratchComposition.jsx`): default `REMOTION_POINTER_ONLY=true` —
  only `ClickRipple` from `click-coords.json`. Cinematic overlays off by default; enable only via
  `REMOTION_POINTER_ONLY=false`, never masking the host flow. → [`remotion-best-practices`](.claude/skills/remotion-best-practices/SKILL.md)

---

## Pipeline commands + stages

`npm run demo` is the **agent-mode default**: app-only, stops at `build-qa` (fast build→QA→fix
loop). `npm run demo:full` runs through render. Full command/build-mode/recovery matrix:
[`pipeline-cli`](.claude/skills/pipeline-cli/SKILL.md).

```
npm run demo                      # app-only, stop at build-qa (default)
npm run demo:full                 # full pipeline through render
npm run demo:with-slides          # include slides phase
npm run demo -- --from=STAGE      # restart from a stage
npm run demo -- --to=STAGE        # stop earlier than build-qa
```

**Tier-aware QA recovery (REQUIRED):** `qa-report-build.json` carries `buildMode`, `tierSummary`,
`recommendedRecovery`. Use the surgical lanes — `pipe app-touchup` (app tier) and `pipe slide-fix`
(slide tier) — which **never** call `build-app`. Do **NOT** use `--build-fix-mode=touchup` (full
HTML regen) for tier-localized failures; it can regress passing tiers. Details in `pipeline-cli`.

**Default touchup budget + stop point (binding default — overridable by the prompt):** unless the
initial/prompt instructions say otherwise, after `build-qa` the agent runs **up to 2 `app-touchup`
iterations + up to 2 `slide-fix` iterations** (slide-fix only when the build has slides), checking
the overall `build-qa` score between iterations and **exiting early as soon as the score ≥ 85**.
Then **STOP at `build-qa` — do NOT `record` or render by default.** Touchup lanes no-op on a
tier that already passes, so this is a budget ceiling, not a mandate. The prompt may override the
counts, the exit threshold, or explicitly request recording/render (e.g. "render the video",
"5 touchups", "no touchups"). Procedure detail: [`pipeline-cli`](.claude/skills/pipeline-cli/SKILL.md).

Canonical stages: `research`, `ingest`, `script`, `brand-extract`, `script-critique`,
`embed-script-validate`, `build`, `build-qa`, `post-slides`, `post-panels`, `api-panel-audit`,
`app-touchup`, `slide-fix`, `record`, `qa`, `figma-review`, `post-process`, `voiceover`,
`coverage-check`, `auto-gap`, `resync-audio`, `embed-sync`, `audio-qa`, `ai-suggest-overlays`,
`render`, `ppt`, `touchup`.

**`api-panel-audit`** (after `post-panels`): validates each step's `apiResponse` JSON against
Plaid's real contracts — live-capture diff (`artifacts/live-api-responses.json`) + AskBill
`json_sample` (cached in `inputs/api-contracts-cache.json`) + deterministic rules. **Flag-only:**
writes `api-panel-audit.json` + an agent-ready `api-panel-audit-task.md` (corrected shapes); warns
and advances by default (pauses for the supervising agent in interactive agent mode).
`API_PANEL_AUDIT_STRICT=true` hard-fails on HIGH. Fix by editing `demo-script.json` `apiResponse`
(copied verbatim into the app) then `pipe stage post-panels`. → [`plaid-demo-app-build`](.claude/skills/plaid-demo-app-build/SKILL.md)

---

## Brand Extraction (brand-extract stage)

- **Always regenerate brand JSON on every run** — never reuse a previous `brand/<slug>.json`.
- Runs **after `script`** (so `demo-script.json` has `persona.company`); writes a fresh
  `brand/<slug>.json` via **Brandfetch**, then Playwright CSS + Haiku normalization as fallbacks.
  Also writes `brand-extract.json` as a completion sentinel.
- Brand URL: explicit `Brand URL: https://…` in the prompt, else the first plausible `https` URL
  (skips Plaid/docs/CDN hosts). `BRANDFETCH_API_KEY` / `BRANDFETCH_CLIENT_ID` are already in `.env`.

## Output Versioning
Every run writes to `out/demos/{YYYY-MM-DD}-{product-slug}-v{N}/`. `out/latest/` symlinks to the
most recent run.
