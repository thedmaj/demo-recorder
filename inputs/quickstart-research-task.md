# Quickstart research task — American Express

> **What this is:** an agent-ready handoff produced by `npm run quickstart`. Open this file in Cursor or Claude Code in **Agent mode** and say "Run this task." The agent will use AskBill + Glean to enrich `inputs/prompt.txt`, then optionally start the build.

> **Why a handoff and not in-CLI?** AskBill + Glean are MCP servers and can only be invoked from inside an agent context (Cursor / Claude Code). The wizard cannot reach them from pure Node.js, so it pre-stages the inputs and lets the agent run the queries.

---

## CONTEXT

- **Brand:** American Express
- **Brand domain:** americanexpress.com
- **Industry:** Lending / consumer credit (`lending`)
- **Plaid Link mode:** embedded
- **Persona:** Jane Foreman
- **Use case (user pitch):** Jane wants to apply for a Credit Card, is a thin file applicant (credit bureau), is unable to get a credit card without verifying her Income with Plaid CRA. She links her account via Plaid and is able to get approved.
- **Research depth:** gapfill

**Products to feature:**

- **Plaid CRA Base Report** (`cra-base-report`) — consumer-report cash-flow underwriting
- **Plaid Income Insights** (`income-insights`) — pay-cycle + employer cashflow signal

---

## STEP 1 — Read the draft prompt the wizard wrote

`inputs/prompt.txt` already contains a `WIZARD-COLLECTED INPUT` header followed by the app-only template skeleton. Keep its structure; your job is to fill in the storyboard beats, persona details, and sample data with researched facts (not invented numbers).

---

## STEP 2 — AskBill: refresh per-product VPs (only when stale)

Use Plaid's per-product Markdown KB as the authority for baseline value props (`inputs/products/plaid-*.md`). Each file's frontmatter has a `last_vp_research` field with a 30-day freshness window. Only call AskBill for products whose VPs are missing or stale.

   - Product **Plaid CRA Base Report** (slug `cra-base-report`):
     - First check freshness via `scripts/scratch/utils/product-vp-freshness.js` → `isProductVpFresh('cra-base-report', 30)`. If fresh, skip AskBill for this product.
     - If stale or missing, call `mcp__user-askbill-plaid__ask_bill` with:
       `"What are the 3-5 strongest customer-facing value propositions for Plaid CRA Base Report, with proof points, for a Lending / consumer credit use case?"`
     - Then call `mcp__user-askbill-plaid__plaid_docs` with:
       `"Show the canonical request/response shape and key fields for Plaid CRA Base Report on the lending flow."`
     - Persist the VPs back via `upsertValuePropositionsSection('cra-base-report', vpMarkdown)` and `stampVpResearchDate('cra-base-report', new Date())` so future runs skip this work.
   - Product **Plaid Income Insights** (slug `income-insights`):
     - First check freshness via `scripts/scratch/utils/product-vp-freshness.js` → `isProductVpFresh('income-insights', 30)`. If fresh, skip AskBill for this product.
     - If stale or missing, call `mcp__user-askbill-plaid__ask_bill` with:
       `"What are the 3-5 strongest customer-facing value propositions for Plaid Income Insights, with proof points, for a Lending / consumer credit use case?"`
     - Then call `mcp__user-askbill-plaid__plaid_docs` with:
       `"Show the canonical request/response shape and key fields for Plaid Income Insights on the lending flow."`
     - Persist the VPs back via `upsertValuePropositionsSection('income-insights', vpMarkdown)` and `stampVpResearchDate('income-insights', new Date())` so future runs skip this work.

---

## STEP 3 — Glean: customer + industry context

Glean provides internal context (Gong calls, recent docs, competitive landing pages, objection-handling decks). Use it for what AskBill cannot answer: customer-specific deal mechanics, Gong color, recent objections, real numbers from past pilots.

   - Customer + industry context (Glean — `mcp__user-glean_local__chat`):
     - `"Summarize how American Express currently handles Jane wants to apply for a Credit Card, is a thin file applicant (credit bureau), is unable to get a credit card without verifying her Income with Plaid CRA. She links her account via Plaid and is able to get approved. and what their public messaging emphasizes."`
     - `"What recent Gong calls or sales conversations mention American Express, Lending / consumer credit, or the products Plaid CRA Base Report, Plaid Income Insights? Cite quotes."`
     - `"What are the most common objections from Lending / consumer credit customers against Plaid CRA Base Report, Plaid Income Insights, and how do reps overcome them?"`
   - (Optional) `mcp__user-glean_local__company_search` with `"American Express"` to confirm the canonical website + competitor set.

---

## STEP 4 — Rewrite `inputs/prompt.txt`

With the research in hand, refine the prompt:

1. Replace remaining `«placeholders»` in the template body with concrete values (real persona name + occupation, plausible amounts, branded sample data).
2. Fill the **STORYBOARD BEATS** table with one row per scene, ordered. Use only `host` / `link` / `insight` scene types — no slides, this is app-only.
3. Add a **Compliance / user data** line if any product has regulatory implications (CRA permissible purpose, Signal sandbox personas, IDV jurisdiction).
4. Confirm the `Products featured` line matches what was selected in the wizard and that the per-product KB paths under `Primary messaging file` are real.
5. Drop the `STATUS: DRAFT` line at the top once the body is complete.

---

## STEP 5 — Sanity gate

Before kicking off the build, confirm:

- [ ] No remaining `«...»` placeholders in `inputs/prompt.txt`.
- [ ] Every featured product has a non-stale VP section in `inputs/products/plaid-*.md`.
- [ ] Storyboard ends on a host/insight outcome (no slide scenes).
- [ ] At least one quoted Gong / customer detail from Glean is woven into the storyboard or persona.

---

## STEP 6 — Build (optional)

If the user wants to start the pipeline immediately:

```bash
npm run pipe -- new --app-only
```

Otherwise hand back to the user with a short summary of what changed in `inputs/prompt.txt`.

---

_Generated by `npm run quickstart` at 2026-04-29T20:30:05.848Z._
