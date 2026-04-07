# Human Review Feedback
Generated: 2026-04-07  |  Run: 2026-04-07-Uses-Ynab-To-Manage-Identity-Monitor-Layer-Income-v1

> This file is read by the build stage when running a refinement pass.
> Keep guidance scoped to the current run to avoid cross-demo drift.

## CRITICAL: Host Welcome Must Be Light + Blue-Accented

For `ynab-welcome`, enforce a clean white/light host canvas and YNAB blue accents.
Do NOT render a dark navy page background on this step.
- Use white/light neutral background for the full host canvas
- Keep branding via YNAB blue accents (buttons, highlights, icon borders)
- Avoid neon/lime as the dominant accent on this step
- Ensure all SVG icons are visibly painted (no transparent/invisible fills/strokes)

## CRITICAL: Liabilities Insight Must Stay In Liabilities Context

For `liabilities-insight`, preserve `/liabilities/get` context end-to-end:
- Header/subheader should clearly include `POST /liabilities/get`
- Response panel must show liabilities-oriented fields (mortgage/debt/APR/balance/payment cues)
- Keep displayed mortgage balance precision at cents (e.g. `$397,845.12`)

## IMPORTANT: Transactions and JSON Visibility

For `transactions-insight` and other API insight steps:
- Show recognizable merchant icons/logos next to merchant names
- Keep JSON panel readable with visible scroll region
- Ensure key tail fields remain reachable/visible via scrolling (`cursor`, `has_more`, arrays)

## IMPORTANT: Value Summary Slide Copy Discipline

For `value-summary-slide`, keep the 4 value pillars concise and tightly aligned to expected copy.
Avoid adding extra explanatory clauses that drift from the stated pillar language.
