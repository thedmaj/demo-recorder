---
product: Plaid Auth
slug: auth
api_endpoints:
  - "/auth/get"
  - "/link/token/create"
  - "/identity/match"
use_cases:
  - "account-funding"
  - "instant-account-verification"
  - "external-account-verification"
last_human_review: "2026-03-12"
last_ai_update: "2026-06-08T14:03:07.492Z"
needs_review: true
approved: true
version: 1
last_vp_research: "2026-05-25"
---

# Plaid Auth

## Overview
Plaid Auth instantly retrieves verified account and routing numbers from a user's financial institution via Plaid Link — replacing multi-day micro-deposit flows with credential-based or database verification in seconds. Identity Match extends Auth by comparing your KYC data to bank-held identity records, returning per-attribute match scores to confirm account ownership before you move money.

## Where It Fits
Feature this product when the demo persona is a developer or fintech PM solving account onboarding friction: funding a wallet, investment account, or new bank account via ACH. Use Auth + Identity Match together when fraud prevention and account ownership confirmation are requirements alongside the account number retrieval.

## Value Proposition Statements
<!-- Auto-seeded / refreshed by research phase on 2026-05-25.
     A human should review and promote into Primary Pitch / Supporting Claims. -->

### Candidate Value Propositions (research-derived)
- Instant account verification that turns account funding into a growth engine — Link and fund in seconds, not days
- ~65% conversion uplift vs. micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts
- Marry KYC data with bank-held identity data at the funding source — Identity Match delivers 20–30% pass-rate improvement vs. legacy matching
- Signal evaluates ACH return risk pre-debit so BNPL lenders can time installment debits, reroute high-risk transactions to RTP, or hold/review — reducing NSF returns and the 60-day customer-initiated return tail
- One integrated flow for funding, fraud prevention, and repayment risk — Auth verifies, Identity Match confirms ownership, Signal scores the transaction

## Proof Points & ROI Metrics
<!-- ⚠️ HUMAN-OWNED — every claim requires a Source. AI adds [DRAFT] rows only. -->

| Metric | Value | Source | Confidence | Last Verified |
|--------|-------|--------|------------|---------------|
| Conversion uplift vs micro-deposits | ~65% | Plaid internal / Gong calls | high | 2026-03-12 |
| U.S. depository account coverage | 98%+ (10,000+ FIs) | Plaid docs | high | 2026-03-12 |
| Verification uplift vs aggregator/database mix | ~23% increase in successful verifications | Plaid internal | high | 2026-03-12 |
| More accounts funded at origination | 20%+ | Plaid internal | high | 2026-03-12 |
| Higher average funding amounts | 3–4x vs alternatives | Plaid internal | high | 2026-03-12 |
| Instant Auth methods share | 98% of bank account linking flows | Plaid docs | high | 2026-03-12 |
| Identity Match pass-rate improvement | 20–30% vs legacy matching | Plaid internal | high | 2026-03-12 |

## Customer Use Cases
<!-- ⚠️ HUMAN-OWNED — scenario descriptions for demo builders. AI may add [DRAFT] scenarios. -->

- Account Funding: replace multi-day micro-deposit verification with instant Auth → 65% conversion uplift, 20%+ more accounts funded at origination
- External Account Verification (EAV): retrieve account + routing numbers directly from the FI; Identity Match cross-checks ownership before ACH debit
- Instant Account Verification (IAV): Database Auth provides instant verification results within Plaid Link without user-visible delays

### Account Funding
**Persona:** Developer at neobank or investment platform
**Problem:** Multi-day micro-deposit onboarding loses users before they fund their first account
**Solution:** Plaid Link instant auth retrieves account + routing numbers in <3s; Identity Match confirms ownership before the ACH debit
**Outcome:** 65% uplift in conversion; 20%+ more accounts funded at origination

### External Account Verification (EAV)
**Persona:** Fintech PM adding pay-in / payout rails
**Problem:** Manual entry of account/routing numbers leads to mismatches and ACH returns
**Solution:** Auth grabs numbers directly from the FI; Identity Match cross-checks the account holder's identity
**Outcome:** Lower return rates, reduced call-center load, and faster onboarding

### Instant Account Verification (IAV)
**Persona:** Developer replacing micro-deposit verification
**Problem:** Micro-deposit delays hurt conversion; users don't come back to verify
**Solution:** Database Auth within Plaid Link provides instant verification results without user-visible delays
**Outcome:** ~23% increase in successful verifications; seamless user experience

## Narration Talk Tracks
<!-- ⚠️ HIGHEST PRIORITY for script generation — word-perfect, max 35 words each.
     The script generator uses these verbatim before any other source.
     HUMAN-OWNED — AI must not modify approved blocks. -->

- Auth step: retrieve account + routing numbers from the bank via Plaid Link; 98%+ U.S. coverage, no typing, no micro-deposits
- Identity Match step: compare KYC data to bank-held identity; per-attribute scores (name, address, phone, email) — approve more good users with confidence

### Demo Opening
> "Today we'll walk through how Plaid powers account funding and instant account verification. We'll connect a bank account in seconds, verify that the person linking owns that account, and evaluate ACH return risk before releasing funds—all in one integrated flow." (45 words — use abbreviated version for step narration)

### Auth step
> "With Auth, we retrieve account and routing numbers directly from the bank. Users connect via Plaid Link using credentials or OAuth—no typing, no micro-deposits. That gives you 98%+ coverage of U.S. depository accounts." (35 words)

### Identity Match step
> "Before we move money, we verify ownership. Identity Match compares your KYC data—name, email, phone, address—to what's on file at the bank. We return scores per attribute, so you can approve, review, or block." (35 words)

### Demo Closing
> "Auth gives you verified account numbers instantly, Identity Match confirms ownership for more good users, and Signal assesses return risk—all using the power of Plaid's network. Link and fund in seconds instead of days." (35 words)

## Accurate Terminology
<!-- ⚠️ HUMAN-OWNED — canonical API names, field names, score ranges, Link event names.
     Build agents and script generator must use these exactly. -->

- API endpoint: `POST /auth/get` — response: `accounts[]`, `numbers.ach[]` (each has `account`, `routing`, `wire_routing`), `item`, `request_id`
- Identity API endpoint: `POST /identity/match` — per-field scores 0–100 (name, address, phone, email)
- Link token endpoint: `/link/token/create` — `products: ["auth"]`; add `"signal"` for ACH risk scoring; use `required_if_supported_products: ["identity"]` for Identity Match
- Verification modes: Instant Auth, Database Auth, Same-Day Micro-deposits, Automated Micro-deposits
- Link events: `OPEN`, `SELECT_INSTITUTION`, `SUBMIT_CREDENTIALS`, `SUBMIT_MFA`, `HANDOFF`, `TRANSITION_VIEW`
- Identity Match score range: 0–100 (70+ = Pass; 95+ includes nickname/common variations; 100 = exact)
- Per-field scores for: name, address, city, state/zip, phone, email — each independent
- Do NOT use "Trust Index" — not a Plaid product term

## Reference Data Scenario (Identity Match)
Use this as the canonical demo data scenario:

| Field | Bank data | KYC data on file | ID Match score |
|-------|-----------|-----------------|----------------|
| Name | Alberta Bobbeth Charleson | Berta Charleson | 80 |
| Address | 2992 Cameron Road | 2992 Cameron Rd. Unit B | 90 |
| City | Malakoff | Malakoff | 90 |
| State/Zip | NY 14236 | New York 14236 | 80 |
| Phone | 1112223333 | +1(111)222-3333 | 80 |
| Email | accountholder0@example.com | bcharleson@mailnator.com | 0 |

Key demo insight: despite the email mismatch (score 0), all other fields pass — Identity Match surfaces this nuance so you can make a confident approval decision rather than blocking the user.

## Competitive Differentiators
<!-- ⚠️ HUMAN-OWNED -->

- "No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source."
- Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal
- Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions

## Implementation Pitfalls
<!-- ⚠️ HUMAN-OWNED — product-specific mistakes to avoid in prompts, scripts, and demos. -->

- **"Plaid Instant Auth" is a flow name, not the product name** — the product is "Plaid Auth"; "Instant Auth" refers to a verification method within Auth (also: Database Auth, Instant Match, Same-Day Micro-deposits, Automated Micro-deposits)
- **`products[]` string is `"auth"`** — not `"plaid_auth"` or `"instant_auth"`
- **`/auth/get` response has `numbers.ach[]`**, not `numbers.routing[]` — each ACH entry has `account`, `routing`, `wire_routing`
- **OAuth institutions** (Chase, Capital One) may not return all identity fields if the user skips a permission checkbox — `ACCESS_NOT_GRANTED` can result from this
- **Do NOT use "Trust Index" in Auth narration** — that is Plaid Protect only
- **Identity Match is optional** — it is NOT part of the `/auth/get` response; it requires a separate `POST /identity/match` call

## Objections & Responses
<!-- 🔄 SHARED — AI adds [DRAFT] from Gong; human approves by removing [DRAFT] tag. -->

| Objection | Response | Source | Status |
|-----------|----------|--------|--------|
| "We have micro-deposits" | "We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify." | Gong / Plaid internal | ✅ Approved |
| "We use another aggregator" | "We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs." | Gong | ✅ Approved |

## AI Research Notes
<!-- 🤖 AI-OWNED — auto-populated by research.js after each pipeline run.
     Human reviews but does not need to edit. Entries accumulate — do not remove.
     Only findings at or above the confidence threshold are appended (default: medium). -->

### 2026-06-08 — Run: 2026-06-08-Demo-Auth-Identity-v4 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank-held identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Single Plaid Link connection returns both Auth (account/routing) and real-time Balance, so platforms schedule debits against actual funds-on-hand at decision time","source":"Integration Skill + Balance docs"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}

### 2026-06-08 — Run: 2026-06-08-Demo-Auth-Identity-v3 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank-held identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Single Plaid Link connection returns both Auth (account/routing) and real-time Balance, so platforms schedule debits against actual funds-on-hand at decision time","source":"Integration Skill + Balance docs"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}

### 2026-06-08 — Run: 2026-06-08-Demo-Auth-Identity-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank-held identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Single Plaid Link connection returns both Auth (account/routing) and real-time Balance, so platforms schedule debits against actual funds-on-hand at decision time","source":"Integration Skill + Balance docs"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}

### 2026-06-08 — Run: 2026-06-08-Demo-Auth-Identity-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank-held identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Single Plaid Link connection returns both Auth (account/routing) and real-time Balance, so platforms schedule debits against actual funds-on-hand at decision time","source":"Integration Skill + Balance docs"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}

### 2026-06-06 — Run: 2026-06-06-Demo-Auth-Identity-v8 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Single Plaid Link connection returns both Auth (account/routing) and real-time Balance, so BNPL lenders underwrite/schedule debits against actual funds-on-hand at decision time","source":"Integration Skill + Balance docs"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"Plaid Identity Verification combines document + selfie/liveness + KYC/watchlist screening in one hosted flow, replacing slow manual BNPL review","source":"IDV docs"}

### 2026-06-06 — Run: 2026-06-06-Demo-Auth-Identity-v5 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Single Plaid Link connection returns both Auth (account/routing) and real-time Balance, so platforms schedule debits against actual funds-on-hand at decision time","source":"Integration Skill + Balance docs"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}

### 2026-06-06 — Run: 2026-06-06-Demo-Auth-Identity-v4 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Single Plaid Link connection returns both Auth (account/routing) and real-time Balance, so apps underwrite/fund against actual funds-on-hand at decision time","source":"Integration Skill + Balance docs"}
- [high] {"claim":"Plaid Layer network prefill recognizes returning Plaid-network users and collapses multi-field sign-up forms into a single tap","source":"Layer docs + Integration Skill"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}

### 2026-06-06 — Run: 2026-06-06-Demo-Auth-Identity-v3 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Single Plaid Link connection returns both Auth (account/routing) and real-time Balance, so BNPL lenders underwrite/schedule debits against actual funds-on-hand at decision time","source":"Integration Skill + Balance docs"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3-4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}

### 2026-06-06 — Run: 2026-06-06-Demo-Auth-Identity-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Single Plaid Link connection returns both Auth (account/routing) and real-time Balance, so BNPL lenders underwrite against actual funds-on-hand at decision time","source":"Integration Skill + Balance docs"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-06-06 — Run: 2026-06-06-Demo-Auth-Identity-Layer-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Single Plaid Link connection returns both Auth (account/routing) and real-time Balance, so platforms underwrite/schedule debits against actual funds-on-hand at decision time","source":"Integration Skill + Balance docs"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}

### 2026-06-06 — Run: 2026-06-06-Demo-Auth-Identity-Layer-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match / IDV","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Plaid Layer network prefill recognizes returning Plaid-network users and collapses multi-field sign-up forms into a single tap","source":"Layer docs + Integration Skill","confidence":"high"}
- [high] {"claim":"Single Plaid Link connection returns both Auth (account/routing) and real-time Balance, so apps underwrite/fund against actual funds-on-hand at decision time","source":"Integration Skill + Balance docs","confidence":"high"}

### 2026-06-06 — Run: 2026-06-06-Demo-Auth-Identity-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match / IDV","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Single Plaid Link connection returns both Auth (account/routing) and real-time Balance, so BNPL lenders underwrite against actual funds-on-hand at decision time","source":"Integration Skill + Balance docs","confidence":"high"}

### 2026-05-29 — Run: 2026-05-29-Claim-Lm-48219-Approved-Choose-Auth-Identity-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"65% conversion uplift vs. micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs. alternatives","source":"Plaid internal / Gong calls","confidence":"high"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs. legacy matching; ~23% increase in successful verifications vs. aggregator/database mix","source":"Plaid internal","confidence":"high"}

### 2026-05-28 — Run: 2026-05-28-Demo-Auth-Identity-Signal-Transfer-Protect-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
- [medium] {"useCase":"Instant Account Verification","outcome":"~23% increase in successful verifications with seamless user experience replacing micro-deposit flows","source":"Plaid internal"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
- [medium] {"pain":"OAuth institutions may not share all identity fields, leading to ACCESS_NOT_GRANTED if user skips permission checkbox","source":"Integration Skill"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"65% conversion uplift vs. micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs. alternatives","source":"Plaid internal / Gong calls","confidence":"high"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs. legacy matching; ~23% increase in successful verifications vs. aggregator/database mix","source":"Plaid internal","confidence":"high"}

### 2026-05-27 — Run: 2026-05-27-Opening-A-New-Pi-Auth-Identity-Signal-Transfer-Protect-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3-4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"65% conversion uplift vs. micro-deposits; 20%+ more accounts funded at origination; 3-4x higher average funding amounts vs. alternatives","source":"Plaid internal / Gong calls","confidence":"high"}
- [high] {"claim":"Identity Match pass-rate improvement: 20-30% vs. legacy matching; ~23% increase in successful verifications vs. aggregator/database mix","source":"Plaid internal","confidence":"high"}

### 2026-05-26 — Run: 2026-05-26-Opening-A-New-Pi-Auth-Identity-Signal-Transfer-Protect-v5 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"65% conversion uplift vs. micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs. alternatives","source":"Plaid internal / Gong calls","confidence":"high"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs. legacy matching; ~23% increase in successful verifications vs. aggregator/database mix","source":"Plaid internal","confidence":"high"}

### 2026-05-26 — Run: 2026-05-26-Opening-A-New-Pi-Auth-Identity-Signal-Transfer-Protect-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"65% conversion uplift vs. micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs. alternatives","source":"Plaid internal / Gong calls","confidence":"high"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs. legacy matching; ~23% increase in successful verifications vs. aggregator/database mix","source":"Plaid internal","confidence":"high"}

### 2026-05-25 — Run: 2026-05-25-Personal-Banking-Linking-External-Auth-Identity-Signal-Transfer-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls","confidence":"high"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching; ~23% increase in successful verifications vs aggregator/database mix","source":"Plaid internal","confidence":"high"}

### 2026-05-25 — Run: 2026-05-25-Using-Zips-Buy-now-pay-later-Plan-Auth-Identity-Signal-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage (10,000+ FIs) including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Signal scored on Plaid's network — 1,000+ risk factors and 80+ predictive insights per transaction, covering both customer-initiated and bank-initiated ACH return codes","source":"Integration Skill — Signal reference","confidence":"high"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts; Identity Match 20–30% pass-rate improvement vs legacy matching","source":"Plaid internal / Gong calls","confidence":"high"}

### 2026-05-22 — Run: 2026-05-22-Personal-Banking-Linking-External-Auth-Identity-Signal-Transfer-Protect-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
- [medium] {"useCase":"Instant Account Verification","outcome":"~23% increase in successful verifications with seamless user experience replacing micro-deposit flows","source":"Plaid internal"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
- [medium] {"pain":"OAuth institutions may not share all identity fields, leading to ACCESS_NOT_GRANTED if user skips permission checkbox","source":"Integration Skill"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link, with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls","confidence":"high"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal","confidence":"high"}
- [high] {"claim":"~23% increase in successful verifications vs aggregator/database mix","source":"Plaid internal","confidence":"high"}

### 2026-05-21 — Run: 2026-05-21-Demo-Auth-Identity-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link, with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls","confidence":"high"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal","confidence":"high"}
- [high] {"claim":"~23% increase in successful verifications vs aggregator/database mix","source":"Plaid internal","confidence":"high"}

### 2026-05-21 — Run: 2026-05-21-Demo-Auth-Identity-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
- [medium] {"useCase":"Instant Account Verification","outcome":"~23% increase in successful verifications with seamless user experience replacing micro-deposit flows","source":"Plaid internal"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
- [medium] {"pain":"OAuth institutions may not share all identity fields, leading to ACCESS_NOT_GRANTED if user skips permission checkbox","source":"Integration Skill"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link, with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls","confidence":"high"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal","confidence":"high"}
- [high] {"claim":"~23% increase in successful verifications vs aggregator/database mix","source":"Plaid internal","confidence":"high"}

### 2026-05-21 — Run: 2026-05-21-Uses-Ck-For-Credit-Auth-Identity-Signal-Transfer-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank-held identity data at the funding source like Plaid does via Identity Match","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link, with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"98%+ U.S. depository account coverage across 10,000+ FIs including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved","confidence":"high"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls","confidence":"high"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal","confidence":"high"}
- [high] {"claim":"~23% increase in successful verifications vs aggregator/database mix","source":"Plaid internal","confidence":"high"}

### 2026-05-20 — Run: 2026-05-20-Buying-A-Lucid-Air-Auth-Identity-Income-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"Only Plaid marries KYC data with bank-held identity data at the funding source via Identity Match","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth delivers instant verification results embedded in Plaid Link with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"98%+ U.S. depository account coverage including long-tail fintechs — often 3–4x traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal"}

### 2026-05-20 — Run: 2026-05-20-Imports-Green-Coffee-From-Auth-Identity-Signal-Transfer-Protect-v3 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
- [medium] {"useCase":"Instant Account Verification","outcome":"~23% increase in successful verifications with seamless user experience replacing micro-deposit flows","source":"Plaid internal"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
- [medium] {"pain":"OAuth institutions may not share all identity fields, leading to ACCESS_NOT_GRANTED if user skips permission checkbox","source":"Integration Skill"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank identity data at the funding source like Plaid","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth delivers instant verification results embedded in Plaid Link with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"98%+ U.S. depository account coverage (10,000+ FIs) including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal"}

### 2026-05-20 — Run: 2026-05-20-Imports-Green-Coffee-From-Auth-Identity-Signal-Transfer-Protect-v2 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
- [medium] {"useCase":"Instant Account Verification","outcome":"~23% increase in successful verifications with seamless user experience replacing micro-deposit flows","source":"Plaid internal"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
- [medium] {"pain":"OAuth institutions may not share all identity fields, leading to ACCESS_NOT_GRANTED if user skips permission checkbox","source":"Integration Skill"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"98%+ U.S. depository account coverage (10,000+ FIs) including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal"}

### 2026-05-20 — Run: 2026-05-20-Imports-Green-Coffee-From-Auth-Identity-Signal-Transfer-Protect-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can marry KYC data with bank identity data at the funding source like Plaid","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth delivers instant verification results embedded directly in Plaid Link with enhanced risk attributes for Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"98%+ U.S. depository account coverage (10,000+ FIs) including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal"}

### 2026-05-07 — Run: 2026-05-07-Asgard-Academy-Via-Mykidsspending-Auth-Identity-Signal-Assets-Transfer-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"98%+ U.S. depository account coverage (10,000+ FIs) including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal"}
- [high] {"claim":"Signal analyzes 1,000+ risk factors and surfaces 80+ predictive insights per transaction, scored on Plaid's network","source":"Integration Skill — Signal reference"}

### 2026-04-27 — Run: 2026-04-27-Chase-Bank-Retail-Online-Auth-Identity-Signal-Transfer-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"98%+ U.S. depository account coverage (10,000+ FIs) including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal"}

### 2026-04-24 — Run: 2026-04-24-Bank-Of-America-Retail-Auth-Identity-Signal-Transfer-Statements-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"98%+ U.S. depository account coverage (10,000+ FIs) including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal"}

### 2026-04-19 — Run: 2026-04-19-Opening-A-New-U-Auth-Identity-Signal-Transfer-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"98%+ U.S. depository account coverage (10,000+ FIs) including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal"}

### 2026-04-19 — Run: 2026-04-19-Opening-A-Citi-Checking-Auth-Identity-Signal-Transfer-v2 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
- [medium] {"useCase":"Instant Account Verification","outcome":"~23% increase in successful verifications with seamless user experience replacing micro-deposit flows","source":"Plaid internal"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
- [medium] {"pain":"OAuth institutions may not share all identity fields, leading to ACCESS_NOT_GRANTED if user skips permission checkbox","source":"Integration Skill"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"98%+ U.S. depository account coverage (10,000+ FIs) including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal"}

### 2026-04-17 — Run: 2026-04-17-Banner-Health-Post-procedure-Follow-up-Auth-Identity-Signal-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"98%+ U.S. depository account coverage (10,000+ FIs) including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}
- [high] {"claim":"Identity Match pass-rate improvement: 20–30% vs legacy matching","source":"Plaid internal"}

### 2026-04-17 — Run: 2026-04-17-Shell-Co-branded-Credit-Card-Auth-Signal-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link with enhanced risk attributes feeding Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"98%+ U.S. depository account coverage including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}
- [high] {"claim":"Signal analyzes 1,000+ risk factors and surfaces 80+ predictive insights per transaction, scored on Plaid's network","source":"Integration Skill — Signal reference"}

### 2026-04-16 — Run: 2026-04-16-Opening-A-New-U-Auth-Identity-Signal-Transfer-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
- [medium] {"useCase":"Instant Account Verification","outcome":"~23% increase in successful verifications with seamless user experience replacing micro-deposit flows","source":"Plaid internal"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
- [medium] {"pain":"OAuth institutions may not share all identity fields, leading to ACCESS_NOT_GRANTED if user skips permission checkbox","source":"Integration Skill"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-14 — Run: 2026-04-14-Demo-Auth-Identity-Signal-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
- [medium] {"useCase":"Instant Account Verification","outcome":"~23% increase in successful verifications with seamless user experience replacing micro-deposit flows","source":"Plaid internal"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
- [medium] {"pain":"OAuth institutions may not share all identity fields, leading to ACCESS_NOT_GRANTED if user skips permission checkbox","source":"Integration Skill"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-13 — Run: 2026-04-13-Demo-Auth-Identity-Signal-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
- [medium] {"useCase":"Instant Account Verification","outcome":"~23% increase in successful verifications with seamless user experience replacing micro-deposit flows","source":"Plaid internal"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
- [medium] {"pain":"OAuth institutions may not share all identity fields, leading to ACCESS_NOT_GRANTED if user skips permission checkbox","source":"Integration Skill"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-13 — Run: 2026-04-13-Funding-A-Td-Checking-Auth-Identity-Signal-Transfer-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
- [medium] {"useCase":"Instant Account Verification","outcome":"~23% increase in successful verifications with seamless user experience replacing micro-deposit flows","source":"Plaid internal"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-13 — Run: 2026-04-13-Opening-A-Citi-Checking-Auth-Identity-Signal-Layer-Transfer-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-13 — Run: 2026-04-13-Demo-Auth-Identity-Layer-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-12 — Run: 2026-04-12-Cedars-sinai-Patient-Portal-Bill-pay-Auth-Identity-Signal-Transfer-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-11 — Run: 2026-04-11-Cedars-sinai-Patient-Portal-Bill-pay-Auth-Identity-Signal-Transfer-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-10 — Run: research-sufficiency-gapfill (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-10 — Run: research-sufficiency-messaging-v2 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-10 — Run: research-sufficiency-messaging (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-10 — Run: 2026-04-10-Cedars-sinai-Patient-Portal-Bill-pay-Auth-Identity-Signal-Transfer-v2 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-10 — Run: 2026-04-10-Cedars-sinai-Patient-Portal-Bill-pay-Auth-Identity-Signal-Transfer-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-10 — Run: 2026-04-10-dashboard-run-v4 (min_confidence: medium)
**Gong — Success Stories**
- [medium] {"useCase":"Account Funding","outcome":"65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification","source":"Plaid internal / Gong calls"}
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-09 — Run: 2026-04-09-Mobile-Signup-And-First-Auth-Identity-Signal-Layer-Protect-v2 (min_confidence: medium)
**Gong — Success Stories**
- [medium] Account Funding use case: Neobank/investment platform achieves 65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification.
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine | Link and fund in seconds, not days | Reduce reliance on micro-deposits while tightening fraud controls
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-09 — Run: 2026-04-09-Mobile-Signup-And-First-Auth-Identity-Signal-Layer-Protect-v1 (min_confidence: medium)
**Gong — Success Stories**
- [medium] Account Funding use case: Neobank/investment platform achieves 65% conversion uplift and 20%+ more accounts funded at origination by replacing micro-deposits with Plaid Auth instant verification.
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Sales Collateral**
- [medium] Plaid Auth + Identity Match — Account Funding Demo Talk Tracks (brief): Instant account verification that turns account funding into a growth engine. | Link and fund in seconds, not days. | Reduce reliance on micro-deposits while tightening fraud controls.
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-09 — Run: 2026-04-09-Banner-Health-Post-procedure-Follow-up-Auth-Identity-Signal-Layer-v1 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-09 — Run: 2026-04-09-Opening-A-New-U-Auth-Identity-Signal-Layer-Transfer-v5 (min_confidence: medium)
**Gong — Customer Pain Points**
- [medium] {"pain":"Multi-day micro-deposit onboarding loses users before they fund their first account","source":"Priority Messaging"}
- [medium] {"pain":"Manual entry of account/routing numbers leads to mismatches and ACH returns","source":"Priority Messaging"}
- [medium] {"pain":"Micro-deposit delays hurt conversion; users don't come back to verify","source":"Priority Messaging"}
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-09 — Run: 2026-04-09-Opening-A-New-U-Auth-Identity-Signal-Layer-Transfer-v3 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-09 — Run: 2026-04-09-Opening-A-New-U-Auth-Identity-Signal-Layer-Transfer-v2 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}
- [high] {"claim":"65% conversion uplift vs micro-deposits; 20%+ more accounts funded at origination; 3–4x higher average funding amounts vs alternatives","source":"Plaid internal / Gong calls"}

### 2026-04-09 — Run: 2026-04-09-Opening-A-New-U-Auth-Identity-Signal-Layer-Transfer-v1 (min_confidence: medium)
**Gong — Objections & Responses**
- [medium] Objection: We have micro-deposits → Response: We typically see around 65% uplift in conversion from micro-deposit verification. Plaid removes the 3–5 day delay and the drop-off when users don't return to verify.
- [medium] Objection: We use another aggregator → Response: We see north of 20% conversion improvement compared against other aggregators, plus 3–4x more U.S. account coverage including long-tail fintechs.
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}

### 2026-04-08 — Run: 2026-04-08-Pays-Monthly-Wireless-Fiber-Auth-Identity-Layer-v5 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}

### 2026-04-08 — Run: 2026-04-08-Pays-Monthly-Wireless-Fiber-Auth-Identity-Layer-v4 (min_confidence: medium)
**Competitive Differentiators (AI-synthesized)**
- [high] {"claim":"No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source.","source":"Priority Messaging — approved"}
- [high] {"claim":"Database Auth: instant verification results embedded in Plaid Link, with enhanced risk attributes supporting Identity Match and Signal","source":"Priority Messaging — approved"}
- [high] {"claim":"Coverage: 98%+ of U.S. depository accounts including long-tail fintechs — often 3–4x the coverage of traditional database solutions","source":"Priority Messaging — approved"}

### 2026-03-12 — File created from inputs/plaid-value-props.md [human]
Initial content migrated from monolithic value-props file. All proof points and talk tracks pre-approved.

## Change Log

- 2026-03-12: File created from inputs/plaid-value-props.md [human]
