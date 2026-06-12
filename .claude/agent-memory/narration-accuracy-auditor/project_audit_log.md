---
name: project-audit-log
description: Log of narration-accuracy audits — runs covered, date, outcome — to prioritize stale KBs next time
metadata:
  type: project
---

**2026-06-11 — Audit of 20 most-recent runs (2026-06-09 → 2026-06-11).**
Runs: Cox-BankIncome, CarMax-CashFlowInsights, Zip-LendScore, Current-EWA, CreditKarma-Signal, BrightMoney-Layer+CRA (v1–v4), KeyBank-Auth/IdMatch/Signal (v1–v2), Scrub-Io-IDV/BankIncome/Assets, TD-Bank-Auth/IdMatch/Signal, Gringo-IDV/Auth/Signal, Cashrepublic-CRA-BaseReport, Ascend-CRA-mortgage, Spring-EQ-Layer+CRA, Demo-CRA-* (Identity/Signal v1/v2).

**Outcome:** 1 high-signal finding → 1 KB edit (uncommitted): `inputs/products/plaid-cra-lend-score.md` — LendScore-not-mortgage guardrail (see [[finding-lendscore-not-mortgage]]).

**Verified ACCURATE (no action):** Signal scores+ACCEPT+ruleset.result (KeyBank/TD/Gringo/CK), Identity Match per-field 0–100, Auth 98% coverage, EWA cash_advance direction (lower=safer), Bank Income `/credit/bank_income/get`, CRA Income Insights vs Bank Income split, Layer "one session no second connection", LendScore 1–99 higher=safer direction.

**Flagged, below ≥2-run threshold (NOT acted on):**
- Scrub-Io: IDV narration "status verified" — "verified" is not a documented IDV status (docs: active/success/failed/pending_review). One run only. Watch for recurrence → then edit plaid-identity-verification.md.
- Scrub-Io: "Bank Income + Plaid Assets from one/same connection" — income_verification can't bundle with assets in one Link token; likely multi-launch build concern, single run. Not a KB fact gap.
- TD-Bank signal-slide: "one to ninety-nine, lower is safer" for standard Signal — true but inverse of KB-pinned "higher = higher risk." One run; EWA's "lower is safer" (Current) IS correct for cash_advance. Re-pin only if standard-Signal "lower is safer" recurs.

**Next time:** CRA cashflow-insights KB was last_ai_update 2026-06-11 (fresh). Auth KB AI-findings section is very long/duplicative (worth a human cleanup, not an audit edit).
