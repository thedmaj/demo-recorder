---
name: saas-demo-design-principles
description: Pacing rules, narrative structure, and quality standards for Plaid SaaS demo videos
---

# SaaS Demo Design Principles

## Narrative Arc (always follow this structure)

1. **Problem** — User/developer faces friction or compliance challenge (first 15 seconds)
2. **Solution entry** — Plaid product introduced as the answer
3. **Frictionless experience** — Walk through key flow steps
4. **Key reveal** — The "wow moment" (score, approval, matched data, instant result)
5. **Outcome** — Result: faster, safer, more compliant

## Pacing Rules

| Dimension | Rule |
|---|---|
| Hook | Problem statement in first 15 seconds |
| Steps | 8–14 steps total |
| Duration | 2–3 minutes total |
| Narration | 20–35 words per step (fits ~8–12s at 150 wpm) |
| Narration floor | Minimum 8 words (avoid one-liners) |
| Reveal moment | Must include a climactic "wow" moment |

## Reveal Moment Checklist

A great reveal:
- Uses quantified outcomes: "Signal score 12 — ACCEPT", "verified in 2.4 seconds"
- Follows the narrative arc: problem → solution → wow → outcome
- Names the key metric explicitly (score, time, confidence level)
- Uses active voice: "Plaid verifies in real time" not "is verified"

## Plaid Narrative Structures by Product

### Signal (ACH risk)
Problem → developer needs ACH confidence → Signal score appears → ACCEPT/REVIEW/REROUTE
- Signal score 0–99: lower = lower return risk. Demo ACCEPT range: 5–20
- Never use scores 82–97 in ACCEPT scenarios (those are high-risk)
- Never say "Trust Index" — say "ACH transaction risk score"

### Auth (account linking)
Problem → user connects bank → Plaid Link → account + routing confirmed → integration complete

### IDV (identity verification)
Problem → new user onboarding KYC → Leslie Knope persona → status: success → instant onboarding

### Layer
Problem → returning user friction → layer_ready event → pre-filled flow → HANDOFF in seconds

## Persona Guidelines

- Use a named persona with a specific, relatable use case
- First name + company + use case (e.g. "Berta Chen, Chime user, linking external account")
- Persona must appear in narration (at minimum on workflow steps)
- Use realistic but idealized data — no 100/100 scores, no sub-1s responses

## Anti-Patterns to Avoid

- Showing error states, edge cases, or declined flows in main demo
- More than 35 words of narration per step
- Generic placeholder data (use realistic persona details)
- Steps that show loading spinners without resolving
- Passive voice ("is verified", "is connected") — use active ("Plaid verifies", "connects")
- Technical API jargon without customer-value context
- Prohibited words: "simply", "just", "unfortunately", "robust", "seamless", "Trust Index"
- Host **Plaid Link launch** CTAs with a normal inline icon scale (the icon supports the label; it must not read as a hero graphic filling the button)

## Slide UX Guardrails

- API JSON rail on slides uses a **single edge toggle icon** (`data-testid="api-panel-toggle"`), not separate Show/Hide JSON buttons.
- Edge toggle should use a light-green affordance and flip chevron direction between collapsed and expanded states.
- On wider screens, keep slide content visually centered with a subtle bordered content frame.
- If a slide includes a table, constrain table width and cell padding so columns remain readable and do not stretch edge-to-edge.

## Plaid Brand Voice

- Confident, precise, outcome-focused
- Lead with customer value, not technical implementation
- Quantify value where possible
- Approved product names: "Plaid Identity Verification (IDV)", "Plaid Instant Auth",
  "Plaid Layer", "Plaid Monitor", "Plaid Signal", "Plaid Assets"

## Plaid Link Narration Boundary Rule

The step BEFORE the Plaid Link step must end with the action that triggers the modal:
- ✅ "...she taps Link Your Bank."
- ✅ "...she clicks Add External Account."

The Plaid Link step narration must begin describing content VISIBLE INSIDE the modal:
- ✅ "Recognized as a returning user, she confirms with a one-time code..."
- ❌ "Plaid Link opens. She taps..." (never narrate the trigger in the Link step)
- ❌ "She clicks the button and Plaid Link opens..." (same violation)
