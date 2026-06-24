---
name: saas-demo-design-principles
description: Pacing rules, narrative structure, and quality standards for Plaid SaaS demo videos
---

# SaaS Demo Design Principles

## Narrative Arc (always follow this structure)

1. **Problem** — User/developer faces friction or compliance challenge (first 15 seconds)
2. **Solution entry** — Plaid product introduced as the answer
3. **Frictionless experience** — Walk through key flow steps
4. **Key reveal** — The "wow moment" as an OUTCOME/decision (approval, matched ownership, cleared-to-ACCEPT, instant result) — not the raw on-screen number
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
- **States the OUTCOME, never reads the screen.** Speak to what the result MEANS and its direction —
  the slide/API panel SHOWS the exact value; the voiceover stays natural and high-level.
- Follows the narrative arc: problem → solution → wow → outcome
- Uses active voice: "Plaid verifies in real time" not "is verified"

### Narration metrics rule (NARRATE OUTCOMES, DON'T READ THE SCREEN)
The voiceover must **not recite exact on-screen values** (dollar amounts, numeric scores, account
last-4 / masks). Those stay visible on the slide / API panel; narration speaks to the implication,
directionally. Decisions/results ARE fine to say aloud (ACCEPT / REVIEW / approved / verified / qualifies).

| Don't read the screen | Do narrate the outcome |
|---|---|
| "bi-weekly income of $2,236" | "her verified income easily clears the loan threshold" |
| "Signal score 12" | "a low-risk transaction — the lower the score, the safer the ACH — cleared to ACCEPT" |
| "account ending 4821" | "her checking account — Gold Savings — is connected" (account **names** are fine) |
| "NAME 88 / EMAIL 62" | "name and email confirmed as a strong ownership match" |

Directional high-vs-low framing is encouraged ("a higher score means more risk"); reading the raw
number is not. Apply to **all** metrics. Script-critique flags exact-value reading as `narration-reads-metric`.

## Plaid Narrative Structures by Product

### Signal (ACH risk)
Problem → developer needs ACH confidence → Signal score appears → ACCEPT/REVIEW/REROUTE
- Signal score 1–99: higher = HIGHER ACH return risk. Demo ACCEPT range: 5–20 (low risk)
- Never use scores 82–97 in ACCEPT scenarios (those are high-risk → REVIEW/REROUTE)
- `ruleset.result` values: `ACCEPT`, `REVIEW`, `REROUTE`. **`REJECT` is NOT documented** — use REROUTE or render a host-app decision outside the API panel.
- Don't call the Signal score "Trust Index". In a Signal demo it is the "Signal score" / "ACH transaction risk score". **Trust Index is a separate Plaid Protect product** (Limited Availability) — allowed ONLY in Plaid Protect demos via `/protect/event/send` or `/protect/user/insights/get`, never `/signal/evaluate`. See `inputs/products/plaid-protect.md`.

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
- Prohibited filler words: "simply", "just", "unfortunately", "robust", "seamless"
- "Trust Index" is **scoped, not prohibited**: allowed in Plaid Protect demos only; never use it to label a Signal `scores.*` value (see Signal note above)
- Host **Plaid Link launch** CTAs with a normal inline icon scale (the icon supports the label; it must not read as a hero graphic filling the button)
- **Webhook / event / enum names in the consumer UX** — never render developer tokens like `USER_CHECK_REPORT_READY`, `STATUS_UPDATED`, `HANDOFF`, `SESSION_FINISHED`, `EXTENSION_OF_CREDIT` as on-screen text, status badges, pills, chips, or tags (see "Host UX — No Developer Artifacts" below)

## Slide UX Guardrails

- API JSON rail on slides uses a **single edge toggle icon** (`data-testid="api-panel-toggle"`), not separate Show/Hide JSON buttons.
- Edge toggle should use a light-green affordance and flip chevron direction between collapsed and expanded states.
- On wider screens, keep slide content visually centered with a subtle bordered content frame.
- If a slide includes a table, constrain table width and cell padding so columns remain readable and do not stretch edge-to-edge.

## Plaid Brand Voice

- Confident, precise, outcome-focused
- Lead with customer value, not technical implementation
- Quantify value where possible
- Approved product names (verbatim): "Plaid Identity Verification (IDV)", "Plaid Instant Auth",
  "Plaid Layer", "Plaid Monitor", "Plaid Signal", "Plaid Assets", "Plaid Protect"
- IDV statuses (use exactly): `active`, `success`, `failed`, `pending_review`

## Host App Background (UX rule)

- For **host/customer-branded app screens** (non-Plaid modal content), default the primary
  page background to white or another light neutral when compatible with brand colors.
- Keep brand identity through accent colors, typography, nav treatment, and CTA styles while
  maintaining accessible contrast.
- Keep Plaid-dark surfaces for Plaid-specific contexts (e.g. dedicated Plaid insight scenes),
  not as the default host canvas. (Plaid-branded slides follow `plaid-slide-design` instead.)

## Host UX — No Developer Artifacts (webhook / event / enum names)

Host/customer-branded screens must read like a real product an end user uses — they must **never
surface webhook names, event names, raw enums, API field names, endpoints, or IDs**. This applies to
**all products**, not just CRA. A reliable tell: any `UPPER_SNAKE_CASE` token (e.g.
`USER_CHECK_REPORT_READY`, `STATUS_UPDATED`, `IDENTITY_VERIFICATION_PASS_SESSION`, `HANDOFF`,
`SESSION_FINISHED`, `ITEM_ADD_RESULT`, `EXTENSION_OF_CREDIT`) does not belong in the consumer UI.

- **Not as text, and not as chrome.** This explicitly includes **status badges / pills / chips /
  tags / labels**. Rendering the webhook name as a decorative status chip is the most common version
  of this mistake.
- **Canonical anti-pattern (do NOT do this):** a "Generating your Consumer Report…" loading screen
  with a green `USER_CHECK_REPORT_READY` pill above a "View Consumer Report" button. The async
  ready-state is conveyed by the **loading → done transition** and the CTA enabling itself — no event
  token on screen.
- **What the end user sees instead:** plain, human status copy — "Verifying your information…" →
  "Verification complete", "Generating your report…" → enabled "View report" CTA. Consent/permissible
  purpose is human-normalized ("to review your application for credit"), never the raw enum.
- **Where the developer artifact goes (if the story needs it):** the **JSON `#api-response-panel`**
  (raw `{"webhook_code":"USER_CHECK_REPORT_READY"}`, field names, enums — expected here), a **technical
  slide** (the "how it works" beat), or a clearly-labeled **Underwriter/Internal-view** step that is
  visually distinct from the consumer app. Per-product detail: the product KB's "Demo UI Guidance"
  section (e.g. [`plaid-cra-base-report.md`](../../../inputs/products/plaid-cra-base-report.md)).

## Plaid Link Narration Boundary Rule

The step BEFORE the Plaid Link step must end with the action that triggers the modal:
- ✅ "...she taps Link Your Bank."
- ✅ "...she clicks Add External Account."

The Plaid Link step narration must begin describing content VISIBLE INSIDE the modal:
- ✅ "Recognized as a returning user, she confirms with a one-time code..."
- ❌ "Plaid Link opens. She taps..." (never narrate the trigger in the Link step)
- ❌ "She clicks the button and Plaid Link opens..." (same violation)

## Narration Transitions — Connect Every Scene Change

Narration is one continuous voiceover. By default, **every step after the first opens with a
short connective clause** (3–8 words, inside the 20–35 word budget) that carries the previous
beat's outcome forward. The writer has creative freedom over phrasing — vary temporal
("Once…", "With identity settled…"), causal ("That session returns…"), spatial ("Back in
the app…"), and revelation ("Behind that single consent…") forms; never stamp one template.
Cold opens are reserved for the opening step and deliberate act breaks.

The prime transition site is the step AFTER a Plaid session, especially into a
behind-the-scenes/API insight beat:
- ✅ "Once Plaid Link has authenticated the bank account successfully, behind the scenes
  the /auth/get API returns verified routing and account numbers."
- ❌ "The report-ready webhook fires — the Consumer Report is ready." (cold start + dev jargon)

This composes with the boundary rule above: the transition INTO a Link step still never
narrates the button tap. Endpoint names belong only in insight-step transitions, never in
host-step narration. Script-critique flags cold starts as `narration-continuity` warnings.
