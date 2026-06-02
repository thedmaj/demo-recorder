---
name: critical-fact-corrections
description: Errors found and corrected in the 2026-05-31 full Plaid product KB review; each entry records what was wrong, what the correct fact is, and the AskBill/Glean source
metadata:
  type: project
---

# Critical Fact Corrections — 2026-05-31 Full KB Review

**Why:** Full review of all 15 product KB files in `inputs/products/`. Corrections verified via AskBill plaid_docs MCP.

## Corrections made

### plaid-signal.md
- **Wrong:** Overview and Accurate Terminology said score range "0–99"
- **Correct:** Score range is **1–99** (minimum is 1, not 0) — AskBill-confirmed
- **Wrong:** Accurate Terminology listed `REJECT` as a recommended verdict
- **Correct:** `ruleset.result` ∈ `{ACCEPT, REVIEW, REROUTE}` — REJECT is NOT documented; must never appear in demos
- **Source:** AskBill, 2026-05-31

### plaid-ewa-score.md
- **Wrong:** Sample JSON showed `"result": "APPROVE"` in the ruleset
- **Correct:** `"result": "ACCEPT"` — APPROVE is NOT a valid Signal `ruleset.result` value even with custom rulesets (AskBill-confirmed 2026-05-31)
- **Wrong:** Demo rules section said "APPROVE / REVIEW" as options
- **Correct:** Always `ACCEPT / REVIEW / REROUTE`
- **Source:** AskBill, 2026-05-31

### plaid-auth.md
- **Wrong:** `api_endpoints` frontmatter used `auth/get` and `identity/match` (missing leading slash)
- **Correct:** `/auth/get` and `/identity/match`
- **Wrong:** Accurate Terminology lacked the `/auth/get` response shape
- **Added:** `numbers.ach[]` with `account`, `routing`, `wire_routing` fields; noted "Instant Auth" is a flow name not the product name
- **Source:** AskBill, 2026-05-31

### plaid-transfer.md
- **Wrong:** Signal-via-Transfer section listed `RISK` as a `decision_rationale.code`
- **Correct:** Code is `PAYMENT_RISK` (not `RISK`)
- **Note:** The canonical codes table at the top of the file correctly used `PAYMENT_RISK`; only the lower table had the discrepancy — now unified
- **Source:** AskBill, 2026-05-31

### plaid-layer.md
- **Wrong:** `/user_account/session/get` response described as returning `user: { legal_name, email_address, phone_number, date_of_birth, address }`
- **Correct:** Response returns `identity: { name: {first_name, last_name}, address, phone_number, date_of_birth, ssn, ssn_last_4 }` — **email_address is currently NOT returned**
- **Added:** Explicit note that `/session/token/create` has NO `products[]` field — configuration is via `template_id` (AskBill-confirmed)
- **Source:** AskBill, 2026-05-31

### plaid-bank-income.md
- **Issue:** File was a minimal sandbox-credential stub with no product structure
- **Action:** Expanded to full `_template.md` structure: Overview, Where It Fits, Value Propositions, Use Cases, Accurate Terminology, Implementation Pitfalls, Objections
- **Key fact added:** `income_verification` Link token only accepts `{income_verification}` or `{income_verification, employment}` — cannot bundle with auth/signal/cra_*
- **Source:** AskBill, 2026-05-31

### plaid-cra-cashflow-insights.md
- **Issue:** File was a partial stub (no frontmatter product/slug/api_endpoints, no template structure)
- **Action:** Rewrote to full template structure with proper frontmatter, all canonical sections
- **Key fact confirmed:** `report.attributes` is a key/value MAP (not an array of `{name, value}` pairs)
- **Key fact confirmed:** `cra_options.cra_cashflow_insights.version: "CFI1"` required in Link token
- **Source:** AskBill + Glean, 2026-05-31

## Unresolved / needs-verification items
- CRA LendScore `report.lend_score.reason_codes[]` field: confirmed it exists per KB; not separately re-verified by AskBill in this session (accepted from existing KB)
- Protect Trust Index `trust_index.score` range (1–100): accepted from existing KB; not re-queried
- Bank Income `user_token` requirement on `/credit/bank_income/get`: AskBill showed it in the sample request — accepted
