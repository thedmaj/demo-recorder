---
product: Plaid Signal
slug: signal
api_endpoints:
  - "signal/evaluate"
  - "signal/decision/report"
use_cases:
  - "account-funding"
  - "ach-risk-assessment"
  - "instant-funding-decisioning"
last_human_review: "2026-03-12"
last_ai_update: "2026-03-12T00:00:00Z"
needs_review: false
approved: true
version: 1
last_vp_research: "2026-04-24"
---

# Plaid Signal

## Overview
Plaid Signal evaluates ACH return risk in real time across over 80 actionable risk insights — including balance, account tenure, NSF history, and Plaid network behavior. It returns a risk score (0–99, higher = higher return risk) and actionable risk attributes so you can offer instant funding for low-risk users and step up high-risk transactions before releasing funds.

## Where It Fits
Feature Signal in demos where the persona needs to make a funding or ACH transfer decision: neobanks, investment platforms, or any fintech releasing funds from an external bank account. Pair with Auth + Identity Match in a complete account-funding flow.

## Value Proposition Statements
<!-- ⚠️ HUMAN-OWNED — pre-approved messaging. AI may ADD candidates marked [DRAFT]
     but must NOT modify or remove approved statements.
     Humans promote [DRAFT] to approved by deleting the tag. -->

### Primary Pitch
> "Confidently offer near-instant funding for low-risk transactions, backed by deep financial insights and Plaid's account verification tools."

### Supporting Claims
- "Signal delivers a network-powered risk assessment by analyzing behavior of the consumer's linked account across Plaid's network—over 80 actionable risk insights."
- "Configure risk score thresholds and deploy ACCEPT/REVIEW/REJECT/REROUTE actions from a single dashboard."
- "Use Signal with Balance: Balance for funds at initiation, Signal to minimize ACH return loss across the settlement window."

## Proof Points & ROI Metrics
<!-- ⚠️ HUMAN-OWNED — every claim requires a Source. AI adds [DRAFT] rows only. -->

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| Actionable risk insights | 80+ | Plaid docs | high | 2026-04-18 |
| Risk attributes returned | 80+ | Plaid docs | high | 2026-04-18 |
| ACH return loss reduction | 40%+ | Gong calls | high | 2026-03-12 |
| Robinhood: additional deposits annually | $100M+ | Plaid case study | high | 2026-03-12 |
| Robinhood: instant funding increase | ~1.5% | Plaid case study | high | 2026-03-12 |
| API response time (median) | ~1s | Plaid docs | high | 2026-03-12 |
| API response time (p95) | <2s | Plaid docs | high | 2026-03-12 |

## Customer Use Cases
<!-- ⚠️ HUMAN-OWNED — scenario descriptions for demo builders. AI may add [DRAFT] scenarios. -->

### Account Funding Risk Gate
**Persona:** Risk engineer at investment platform
**Problem:** ACH returns — both NSF and unauthorized — erode margins and create compliance burden
**Solution:** Call `signal/evaluate` at funding initiation; route low-score transactions to instant funding and high-score to review or slower rails
**Outcome:** Robinhood: $100M+ more deposited annually, ~1.5% increase in instant funding while managing ACH risk

### Repeat Transfer Risk Assessment
**Persona:** Product manager at payments fintech
**Problem:** First-party fraud increases after initial account linking — users exploit instant funding then dispute
**Solution:** Signal evaluates risk for every transfer, not just the first; network signals catch behavioral shifts over time
**Outcome:** Ongoing risk management without requiring additional user friction

## Narration Talk Tracks
<!-- ⚠️ HIGHEST PRIORITY for script generation — word-perfect, max 35 words each.
     The script generator uses these verbatim before any other source.
     HUMAN-OWNED — AI must not modify approved blocks. -->

### Signal step
> "Signal evaluates ACH return risk in real time—bank-initiated returns like NSF and closed accounts, and customer-initiated returns like unauthorized disputes. It uses 80 actionable risk insights. You get ACCEPT, REVIEW, or REROUTE recommendations." (33 words)

### Demo Closing (combined Auth + Signal)
> "Auth gives you verified account numbers instantly, Identity Match confirms ownership for more good users, and Signal assesses return risk—all using the power of Plaid's network. Link and fund in seconds instead of days." (35 words)

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names.
     Build agents and script generator must use these exactly. -->

- API endpoint: `signal/evaluate`
- Report endpoint: `signal/decision/report`
- Score range: **0–99** (**higher score = HIGHER return risk**; matches CLAUDE.md)
- Realistic demo values for ACCEPT path: **5–20** (low risk → ACCEPT)
- Do NOT use scores 82–97 for ACCEPT — those are high-risk and should be REVIEW/REROUTE
- Do NOT use "Trust Index" — this is NOT a Plaid product name
- Do NOT use "1,000+ risk factors" — approved language is "80 actionable risk insights"
- Recommended verdicts: ACCEPT, REVIEW, REJECT, REROUTE
- Return types covered: NSF, closed account, unauthorized (R10), administrative

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

- Network-level signals: behavior across Plaid's 8,000+ FI connections, not just the user's account in isolation
- 80 actionable risk insights vs basic balance-check alternatives
- No-code threshold tuning via the Plaid Dashboard — risk team can adjust without engineering
- Covers both bank-initiated (NSF, closed account) and customer-initiated (unauthorized) return types

## Objections & Responses
<!-- 🔄 SHARED — AI adds [DRAFT] from Gong; human approves by removing [DRAFT] tag. -->

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| "We just do a balance check" | "Balance tells you funds exist at initiation. Signal tells you the probability of a return across the entire settlement window — NSF, closed account, and unauthorized disputes." | Gong | ✅ Approved |
| "We can build this in-house" | "Signal uses 80 actionable risk insights from Plaid's network of 8,000+ FIs. No in-house model can replicate that network data." | Gong | ✅ Approved |

## AI Research Notes
<!-- 🤖 AI-OWNED — auto-populated by research.js after each pipeline run.
     Human reviews but does not need to edit. Entries accumulate — do not remove.
     Only findings at or above the confidence threshold are appended (default: medium). -->

### 2026-03-12 — File created from inputs/plaid-value-props.md [human]
Initial content migrated from monolithic value-props file. All proof points and talk tracks pre-approved.

## Change Log

- 2026-03-12: File created from inputs/plaid-value-props.md [human]
- 2026-04-18: Corrected semantics to match CLAUDE.md (higher score = HIGHER return risk, ACCEPT demo values 5-20) and replaced unapproved "1,000+ risk factors" with approved "80 actionable risk insights" throughout [pipeline-audit]
