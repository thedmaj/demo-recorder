---
product: Plaid Layer
slug: layer
api_endpoints:
  - "/link/token/create"
use_cases:
  - "streamlined-onboarding"
  - "returning-user-verification"
  - "kyc-auto-fill"
last_human_review: "2026-03-12"
last_ai_update: "2026-04-19T07:00:11.392Z"
needs_review: true
approved: false
version: 1
last_vp_research: "2026-04-24"
---

# Plaid Layer

## Overview
<!-- ⚠️ HUMAN-OWNED — 2–3 sentences: what this product is, what problem it solves. -->
Plaid Layer accelerates onboarding by presenting an eligibility-gated, phone-first flow that lets users review and share prefilled identity and account context. The exact shared fields are template-driven by use case, so high-friction fields (for example DOB and SSN) are only shown when required for compliance or verification needs.

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

### [DRAFT] Account Verification / Pay-by-Bank
**Persona:** Product manager at a payments or billing platform
**Problem:** Users drop off when linking bank accounts due to form friction
**Solution:** Layer share screen prioritizes name, phone, address, email (if available), and bank account details; DOB/SSN omitted by default
**Outcome:** Faster bank-link completion with lower friction and cleaner UX

### [DRAFT] Identity Verification-Oriented Onboarding
**Persona:** Compliance lead at fintech/neobank
**Problem:** Need stronger identity assurance for onboarding
**Solution:** Layer share screen includes name, address, phone, DOB, and SSN (or SSN last4) when required by template
**Outcome:** Better identity completeness for KYC workflows

### [DRAFT] Branching Rule: Layer Eligibility vs Fallback
**Persona:** Product team designing mobile onboarding funnels
**Problem:** Teams accidentally collect extra PII for users who are already Layer-eligible, creating unnecessary friction
**Solution:** Enforce branch semantics:
- **Layer-eligible users:** complete Layer flow and proceed directly to an onboarding complete state (no additional PII collection)
- **Layer-ineligible users:** continue to PII collection fallback and then bank linking via standard Plaid Link experience
**Outcome:** Preserve low-friction conversion for eligible users while maintaining a compliant fallback for ineligible users

### [DRAFT] CRA / Consumer Report Flow
**Persona:** Credit product team using CRA data
**Problem:** Credit/report workflows require strict identity collection and consent context
**Solution:** Layer template requires identity fields (name, address, DOB, SSN) and routes ineligible users to fallback
**Outcome:** Higher confidence that CRA-required data is collected before report retrieval

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
- [DRAFT] Field visibility is template-driven (required vs optional), not globally fixed for all Layer stories
- [DRAFT] Account-verification stories should omit DOB/SSN unless explicitly required
- [DRAFT] Identity verification and CRA-oriented stories typically require DOB + SSN fields on share confirmation
- [DRAFT] Layout/copy fidelity for Layer prototype demos: preserve the canonical Layer template structure, CSS hierarchy, logo placement, and fixed screen copy; only variable fields (for example name/address/bank account values) should change.
- [DRAFT] Do not route Layer-eligible users into fallback PII collection; fallback PII + Plaid Link is for ineligible users only.
- [DRAFT] For mobile Layer demos, show subtle helper text directly below the mobile frame with both routing numbers: `415-555-1111` (eligible) and `415-555-0011` (ineligible fallback).
- [DRAFT] Default prefilled phone value in Layer host capture should be the eligible number first (`415-555-1111`).
- [DRAFT] In mobile demos, slide-like steps should auto-present in desktop mode (never inside the mobile simulator pane).

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

### 2026-04-19 — Run: 2026-04-19-Uses-Ynab-To-Manage-Identity-Monitor-Income-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] Pre-verified identity from bank-verified sources (not self-typed)
- [high] Network effect — 45M+ saved Plaid profiles improve coverage over time
- [high] No additional verification step for returning users
- [high] Template-driven field visibility — one integration covers pay-by-bank through strict KYC/CRA

### 2026-04-13 — Run: 2026-04-13-Uses-Ynab-To-Manage-Identity-Monitor-Layer-Income-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] Pre-verified identity from bank-verified sources
- [high] Network effect at scale
- [high] No additional verification step for returning users
- [high] Template-driven flexibility

### 2026-03-12 — Scaffold created [human]
Empty scaffold for Layer product. To be populated by pipeline research runs.

### 2026-04-08 — Layer field permutations by use case [ai]
- AskBill guidance: for account verification/pay-by-bank Layer flows, default share fields should be minimal (name/phone/address/email/bank account), with DOB and SSN omitted unless explicitly required.
- AskBill guidance: for identity-verification-oriented Layer flows, share fields commonly include name, address, phone, DOB, and SSN or SSN last4.
- AskBill guidance: CRA-oriented flows are typically strict identity contexts and should include required identity fields (name/address/DOB/SSN), with fallback paths for ineligible users.
- AskBill guidance: in CRA contexts, phone and email are commonly required identity fields, while bank account rows are included only when available and required by template/story.

### 2026-04-09 — Layer prototype fidelity + branch contract [ai]
- Canonical prototype contract for mobile Layer demos: maintain template structure and copy fidelity (layout, CSS hierarchy, logo treatment, and fixed instructional text) while only substituting variable values such as persona identity fields and bank account details.
- Branching contract: eligible users complete Layer and go to onboarding complete state without extra PII collection; only ineligible users proceed to fallback PII collection and then standard Plaid Link bank linking.
- Mobile helper-copy contract: include subtle helper text below the mobile frame with explicit eligible/ineligible phone numbers and keep the eligible number prefilled by default.
- Mobile slide-view contract: auto-switch to desktop mode for slide-like screens; no manual view toggle required.

## Change Log

- 2026-03-12: Scaffold created [human]
- 2026-04-09: Added prototype-fidelity and eligibility/fallback branching guidance [ai]
