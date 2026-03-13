---
product: "Plaid Layer"
slug: "layer"
api_endpoints:
  - "/link/token/create"
use_cases:
  - streamlined-onboarding
  - returning-user-verification
  - kyc-auto-fill
last_human_review: "2026-03-12"
last_ai_update: "2026-03-12T00:00:00Z"
needs_review: false
approved: false
version: 1
---

# Plaid Layer

## Overview
<!-- ⚠️ HUMAN-OWNED — 2–3 sentences: what this product is, what problem it solves. -->
Plaid Layer accelerates user onboarding by auto-filling KYC data (name, address, SSN, date of birth) from a user's existing Plaid-verified financial identity. Returning users who have previously verified with Plaid can complete sign-up in seconds, with no manual data entry.

## Where It Fits
<!-- ⚠️ HUMAN-OWNED — when should this product be featured? What persona/use case? -->
Feature Layer when the demo persona is a fintech, lender, or neobank facing high drop-off during KYC/onboarding. Best paired with a compelling "before vs after" narrative: long form fill → one-tap verified identity.

## Value Proposition Statements
<!-- ⚠️ HUMAN-OWNED — pre-approved messaging. AI may ADD candidates marked [DRAFT]
     but must NOT modify or remove approved statements.
     Humans promote [DRAFT] to approved by deleting the tag. -->

### Primary Pitch
> "One tap to a verified identity — Plaid Layer auto-fills KYC in seconds for users who've verified with Plaid before."

### Supporting Claims
- [DRAFT] Reduces onboarding form friction for returning Plaid users — Source: product docs, 2026-03-12

## Proof Points & ROI Metrics
<!-- ⚠️ HUMAN-OWNED — every claim requires a Source. AI adds [DRAFT] rows only. -->

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|

## Customer Use Cases
<!-- ⚠️ HUMAN-OWNED — scenario descriptions for demo builders. AI may add [DRAFT] scenarios. -->

### KYC Auto-Fill for Returning Users
**Persona:** Developer at a lending or investment platform
**Problem:** High drop-off during KYC form fill; users frustrated re-entering the same data
**Solution:** Layer detects returning Plaid users and pre-populates name, address, SSN, DOB
**Outcome:** Faster time-to-funded; reduced KYC abandonment

## Narration Talk Tracks
<!-- ⚠️ HIGHEST PRIORITY for script generation — word-perfect, max 35 words each.
     The script generator uses these verbatim before any other source.
     HUMAN-OWNED — AI must not modify approved blocks. -->

<!-- Add narration talk tracks here once Layer demos are finalized -->

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names.
     Build agents and script generator must use these exactly. -->

- Product name: "Plaid Layer" (not "Layer Connect" or "Layer Auth")
- Link token: created with Layer-specific template ID via `/link/token/create`
- Link events: `LAYER_READY`, `LAYER_NOT_AVAILABLE`, `OPEN`, `HANDOFF`
- Do NOT use "Trust Index" — not a Plaid product term

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

- Pre-verified identity: data comes from bank-verified sources, not user-typed input
- Network effect: the more users who verify with Plaid, the better Layer coverage gets
- No additional verification step for returning users — identity is already established

## Objections & Responses
<!-- 🔄 SHARED — AI adds [DRAFT] from Gong; human approves by removing [DRAFT] tag. -->

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|

## AI Research Notes
<!-- 🤖 AI-OWNED — auto-populated by research.js after each pipeline run.
     Human reviews but does not need to edit. Entries accumulate — do not remove.
     Only findings at or above the confidence threshold are appended (default: medium). -->

### 2026-03-12 — Scaffold created [human]
Empty scaffold for Layer product. To be populated by pipeline research runs.

## Change Log

- 2026-03-12: Scaffold created [human]
