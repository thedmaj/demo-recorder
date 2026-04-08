# Plaid Layer Value Proposition + Pitch Skill

## Purpose
Use this skill when creating scripts, demos, talk tracks, or sales-style explanations for Plaid Layer.
It translates product mechanics into concise business value while staying accurate to current docs.

## What Plaid Layer Is
Plaid Layer is an onboarding experience that helps users sign up faster by reusing permissioned identity and account context, starting from a phone number and a short verification flow.

Core flow:
1. Collect phone number.
2. Determine eligibility in real time.
3. Present instant signup path only for eligible users.
4. Authenticate user/device (SNA or OTP fallback).
5. Let user review/share data.
6. Continue onboarding with permissioned data and optional linked account context.

## Product Positioning (Use This Framing)
- **Primary job:** Increase onboarding conversion without weakening fraud controls.
- **Buyer pain:** Long forms and repeated identity/account entry cause drop-off.
- **User benefit:** Faster signup with less typing and fewer redundant steps.
- **Business benefit:** More completed onboardings, shorter time-to-first-action.
- **Risk benefit:** Device + phone verification and risk checks before completion.

## Canonical Value Pillars
1. **Conversion lift**
   - Removes manual data entry from the happy path.
   - Internal/field messaging often cites double-digit onboarding lift.
2. **Speed**
   - Eligibility checks and onboarding handoff are fast.
   - Session experience is built to complete in seconds, not minutes.
3. **Security**
   - Device and phone possession checks are integrated into flow.
   - Risk signals are evaluated before user proceeds.
4. **Control + compatibility**
   - Templates define required/optional fields.
   - Works with existing KYC/identity stacks and Plaid products.

## Platform Guidance (Critical Accuracy Rule)
- Layer is **mobile-first in real-world adoption**, but not mobile-only.
- Supported SDK paths include native mobile SDKs and web SDK implementations.
- Do not claim "Layer only works on mobile SDKs."
- Safe wording for demos:
  - "Layer is optimized for mobile onboarding moments."
  - "For this prototype, we are modeling Layer screens in a reusable cross-demo framework."

## Demo Pitch Structure (30-45 seconds)
Use this sequence:
1. **Problem:** "Onboarding drop-off spikes when users must re-enter identity and account details."
2. **Mechanism:** "Layer checks eligibility from phone number, authenticates the user, and presents a fast consent/review step."
3. **Outcome:** "Users finish onboarding faster, teams improve conversion, and risk controls stay in the loop."
4. **Business close:** "You get better top-of-funnel efficiency without rebuilding your full onboarding stack."

## One-Liner Options
- "Layer turns onboarding from a long form into a fast, authenticated share flow."
- "Layer helps you convert more good users by combining speed and risk checks in one signup experience."
- "Layer creates an instant-onboarding happy path while preserving your fallback for everyone else."

## Objection Handling
### "What if users are not eligible?"
Use:
"Ineligible users never hit a dead end. They continue through your existing onboarding path, so Layer adds upside without breaking current flows."

### "Do we have to replace our KYC stack?"
Use:
"No. Layer is designed to work with existing verification programs and downstream onboarding controls."

### "Does this increase fraud risk?"
Use:
"Layer includes device and phone authentication with risk checks before completion, so speed and security move together."

## Prototype and Mock Guidance
For reusable demo prototypes that mock Layer UI:
- Keep the host app realistic and customer-branded.
- Clearly indicate when a step represents Layer-managed UI.
- Preserve the real Layer mental model:
  - eligibility gate,
  - authentication checkpoint,
  - review/share confirmation,
  - fallback path for ineligible users.
- Never present mocks as product screenshots unless validated against latest docs.

## Data Sharing Field Matrix (Critical)
Use Layer confirmation/share fields based on use case. Do not show one universal field set.

### 1) Account Verification / Pay-by-Bank / Bank Linking
- Default share fields: `name`, `phone`, `address`, `email` (if available), `bank account`.
- Omit by default: `date_of_birth`, `ssn`.
- Include DOB/SSN only when explicitly required by compliance or story requirements.

### 2) Identity Verification-Oriented Onboarding
- Typical required fields: `name`, `address`, `phone`, `date_of_birth`, `ssn` (or `ssn_last_4`), plus `email` when used.
- Confirmation screen should visibly include DOB + SSN context when this is the story.
- Call out that field requirements come from template configuration and can be required/optional.

### 3) CRA / Consumer Report Contexts
- Treat as strict identity context by default.
- Typical required fields: `name`, `address`, `date_of_birth`, `ssn`/`ssn_last_4`, `phone`, and `email` (account-config dependent).
- Bank account fields may be included when the story combines CRA with account-based data, but are not the primary CRA identity requirement.
- Show strong consent framing and report-purpose language in narration/copy.

## Template Requirement Rules
- Layer templates determine which fields appear for review/sharing.
- Eligibility should reflect required fields for the flow.
- If a required field is missing for a user, route to fallback flow.
- In demos, collect only the minimum necessary fields for the selected use case narrative.

## Screen 1 Copy Guardrail (Phone Entry)
- The first host-owned screen should ask for phone to begin onboarding/signup/application flow.
- User-facing copy must NOT say "eligibility check" or "checking eligibility."
- Keep eligibility logic internal; present the step as a normal onboarding start.

## Language Guardrails
- Prefer: "instant onboarding", "faster signup", "conversion lift", "authenticated flow", "fallback path".
- Avoid: "guaranteed approval", "zero risk", "works for every user", "mobile-only".
- Keep claims directional unless sourced in-run:
  - Good: "double-digit conversion lift observed in customer messaging."
  - Better when sourced: include explicit metric and source date.

## Source Confidence Notes
When using this skill in docs or scripts:
- Treat Plaid Docs + Plaid blog as highest-authority product behavior references.
- Treat internal decks as messaging guidance; verify hard technical claims against docs.
- If sources conflict, prefer latest dated official docs.

