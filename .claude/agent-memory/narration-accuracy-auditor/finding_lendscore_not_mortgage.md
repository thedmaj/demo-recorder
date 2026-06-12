---
name: finding-lendscore-not-mortgage
description: LendScore is a non-mortgage default score; recurring drift had it deciding HELOCs — KB guardrail strengthened
metadata:
  type: project
---

CRA LendScore must NEVER be the basis for a mortgage/HELOC pre-qualification or approval.

**Fact (primary source AskBill / Plaid Check docs, 2026-06-11):** LendScore predicts general consumer (NON-mortgage) 90+DPD default over 12 months — positioned for BNPL, personal lending, near-prime second-look. Mortgage/HELOC must underwrite on **Home Lending reports — VOA (Verification of Assets) + INCOME via `POST /cra/check_report/verification/get`** (VOA explicitly covers HELOCs / non-GSE), framed with Base Report + Income Insights. The mature mortgage use case is asset/income *verification*, not LendScore *underwriting*.

**Why:** Recurring drift across ≥3 Spring EQ runs (2026-06-09 → 2026-06-10: `2026-06-09-Spring-Eq-CRA-Identity-Signal-v1`, `2026-06-09-Demo-CRA-Identity-Signal-v1`, `-v2`) — narration pre-qualified a $75K HELOC "citing verified cash flow and his LendScore." Contrast: Ascend mortgage run correctly used Base Report + Income Insights + Assets (no LendScore) — that is the right pattern.

**How to apply:** Already folded into `inputs/products/plaid-cra-lend-score.md` (Implementation Pitfalls top callout + Do Not line + last_ai_update 2026-06-11). Do NOT re-propose this edit. If a future Spring-EQ-style HELOC run STILL cites LendScore as the decision, the KB fix didn't propagate — escalate to the script-gen prompt/template rather than re-editing the KB. See [[reference-ground-truth-map]].
