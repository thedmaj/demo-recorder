# Overview: jtk worktree sync branch (`wip/jtk-to-main` → `main`)

**Commit:** `3d767ce`  
**Base:** `f59c0a1` — *Add visual timeline editor for manual recording storyboard editing*  
**Scope:** ~58 files, +7,437 / −834 lines  

This document summarizes what landed when the **jtk** Cursor worktree was committed and fast-forward merged into **`main`** on the primary checkout (`demo-recorder`).

---

## 1. Plaid Check / CRA Link (sandbox recording & API)

**Goal:** Support CRA-scoped Link (consumer report products + permissible purpose) and document the correct sandbox personas separately from Bank Income.

| Area | Changes |
|------|--------|
| **Product knowledge** | New/updated markdown under `inputs/products/`: CRA Base Report, CRA Income Insights, **Bank Income** (`user_bank_income` / `{}` only for traditional Bank Income). CRA flows document **`user_credit_*`** + non-OAuth institution (`ins_109508`). |
| **Sandbox reference** | `inputs/plaid-link-sandbox.md`, `CLAUDE.md` — CRA vs Bank Income table alignment. |
| **`plaid-backend.js`** | `createLinkToken` merges extra Plaid fields (`consumer_report_permissible_purpose`, `cra_options`, etc.); CRA credential routing unchanged in spirit. |
| **App proxy** | `app-server.js`, `manual-record.js` — forward full JSON body into `createLinkToken` (`...body`) so CRA fields are not stripped. |
| **`record-local.js`** | `PLAID_LINK_RECORDING_PROFILE=cra` defaults sandbox login to `user_credit_profile_good` / `pass_good` when not set in `demo-script.json`. |
| **`plaid-browser-agent.js`** | CRA profile uses `user_credit_*`; new **`bankIncome`** profile for `user_bank_income`. |
| **Tests / scripts** | `test-plaid-cra-link-record.js` (CRA mode), **`test-plaid-cra-link-record-headless.js`** (headless + ~15s fast timing profile), **`verify-cra-link-token-matrix.js`** (API smoke for repeated CRA link tokens). |
| **`test-plaid-link-record.js`** | CRA + headless flags, timing env knobs (`FAST_TIMING`), `step-timing.json` / `result.json` **`recordingProfile`** metadata; optional `dotenv` load. |
| **`package.json`** | `test:record:cra`, `test:record:cra:headless`. |
| **Unit tests** | `tests/unit/plaid-backend-credentials.test.js`, `tests/unit/plaid-link-token-create.test.js`; related updates in `plaid-link-steps.test.js`, etc. |

---

## 2. Product knowledge & pipeline context

**Goal:** Curated, bounded context for script/build/QA and clearer product families.

| Area | Changes |
|------|--------|
| **Libraries** | `product-knowledge.js`, `product-profiles.js`, `markdown-knowledge.js`, `run-context.js` — load/slice product markdown, profiles, run context. |
| **Pipeline** | `orchestrator.js`, `build-app.js`, `generate-script.js`, `qa-review.js`, `research.js`, `prompt-templates.js` — integrate digests, context caps, build-QA path. |
| **Build QA** | New `build-qa.js`, `tests/unit/build-qa.test.js`. |
| **Inputs** | `inputs/prompt-template.txt`, `inputs/qa-fix-log.md`, prompt tuning files; expanded `inputs/prompt.txt`. |
| **Tests** | `product-knowledge.test.js`, `product-profiles.test.js`, `markdown-knowledge.test.js`, `run-context.test.js`, `demo-script-validation.test.js`, updates to `prompt-templates.test.js`, `frontmatter-parser.test.js`, `product-slug-detection.test.js`. |

Context sizing and staleness ideas are reflected in **`docs/context-engineering-metrics.md`** (env knobs like `CONTEXT_MAX_*`, `KNOWLEDGE_STALE_DAYS`).

---

## 3. Dashboard: human-in-the-loop & freshness

**Goal:** Faster review of product knowledge and governance signals.

| Area | Changes |
|------|--------|
| **Server** | `scripts/dashboard/server.js` — APIs for product/value-prop review, fact-oriented flows, staleness / queue-style behavior (as implemented in this revision). |
| **UI** | `dashboard.js`, `dashboard.css`, `index.html`, `timeline.html`, `ai-overlay.js` — Fact Inbox–style UX, counters, bulk actions where wired. |

*(Exact route names and payloads are defined in `server.js` and client `dashboard.js`.)*

---

## 4. Manual recording & misc

| Area | Changes |
|------|--------|
| **`manual-record.js`** | Align Plaid proxy with passthrough `create-link-token` body. |
| **`record-local.js`** | CRA defaults and Plaid timing/frames (see §1). |
| **Templates** | `templates/slide-template/*` — slide rules and starter HTML/CSS. |
| **`package-lock.json`** | Dependency lockfile updates aligned with `package.json`. |

---

## 5. How to validate

- **Unit tests:** `npm test` (ensure `dotenv` / deps installed per `package.json`).
- **CRA link token:** `node scripts/scratch/verify-cra-link-token-matrix.js` (needs `CRA_CLIENT_ID` / `CRA_SECRET`; skips if unset).
- **Headless CRA recording:** `npm run test:record:cra:headless` (CRA secrets + Playwright Chromium).
- **Dashboard:** run `npm run dashboard` and exercise value-prop / fact review flows.

---

## 6. Git notes

- Branch **`wip/jtk-to-main`** holds the same commit as **`main`** after fast-forward merge.
- Pre-merge **main** uncommitted work was stashed as **`stash@{0}: pre-merge-jtk-wip …`** — recover with `git stash list` / `git stash show` if needed.
- **`main`** may be **ahead of `origin/main`** until you **`git push origin main`**.

---

*Generated for operational clarity; adjust section detail as the codebase evolves.*
