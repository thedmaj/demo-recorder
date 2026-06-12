---
name: reference-ground-truth-map
description: Where each Plaid product's canonical facts live + the load-bearing score-direction/endpoint facts for narration audits
metadata:
  type: reference
---

Ground-truth file map + the facts that most often drift in narration. Verify against the file (it may have changed) before acting.

**KB files** (`inputs/products/`):
- `plaid-signal.md` — Signal score 1–99, **higher = HIGHER ACH return risk**; ACCEPT demos 5–20; `ruleset.result` ∈ {ACCEPT, REVIEW, REROUTE} (no REJECT). Approved phrasing pins "higher = higher risk" (not "lower is safer").
- `plaid-ewa-score.md` — Cash Advance Score: `scores.cash_advance.score` 1–99, **higher = higher risk** (lower=safer). `["auth","signal"]`. `ruleset.result` not `APPROVE`. No `reason_codes[]` (use `core_attributes`).
- `plaid-cra-lend-score.md` — LendScore 1–99, **higher = LOWER default risk (safer)** — OPPOSITE of Signal. NON-mortgage only (see [[finding-lendscore-not-mortgage]]). `report.lend_score.reason_codes[]`.
- `plaid-cra-base-report.md` / `plaid-cra-cashflow-insights.md` / `plaid-cra-income-insights.md` — CRA family; report-ready webhook `USER_CHECK_REPORT_READY`.
- `plaid-bank-income.md` — `/credit/bank_income/get` (≠ CRA Income Insights `/cra/check_report/income_insights/get`). `income_verification` bundles ONLY with `employment` — never auth/signal/assets/cra.
- `plaid-auth.md` — `/auth/get` `numbers.ach`; "98%+ US depository accounts / 10,000+ FIs" is APPROVED. **Also holds Identity Match facts** (no dedicated identity-match KB): `/identity/match` per-field scores **0–100** (legal_name, address, phone, email).
- `plaid-identity-verification.md` — IDV statuses: `active, success, failed, pending_review`. NOTE: "verified" is NOT a documented IDV status (seen once in Scrub-Io run — watch for recurrence).
- `plaid-transfer.md` — Signal runs INSIDE `/transfer/authorization/create`; numeric Signal scores + `ruleset.result` only on a separate `/signal/evaluate` step (Pattern B). Identity Match per-field 0–100 detailed here too.

**No dedicated KB for:** Identity Match (lives in plaid-auth.md + plaid-transfer.md), Network Insights, Plaid Assets, Plaid Statements.

**Primary-source tool:** AskBill (`mcp__askbill-plaid__ask_bill`) for API field/endpoint verification. Mortgage/HELOC = Home Lending VOA/INCOME via `/cra/check_report/verification/get`.

**Demo-script extraction:** runs in `out/demos/<date>-<slug>-vN/demo-script.json`, shape `{title, product, persona, steps:[{id, narration, visualState, ...}]}` (single `product` string, not `products[]`). Node JSON.parse to /tmp then Read is reliable; piping node stdout through head silently dropped output in this env.
