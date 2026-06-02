---
name: api-verification-patterns
description: AskBill query patterns that yield authoritative API facts for Plaid product KB work; includes confirmed field names, endpoint paths, and enums per product
metadata:
  type: reference
---

# AskBill API Verification Patterns

**Source:** AskBill plaid_docs MCP — verified 2026-05-31 full KB review

## Query patterns that work well
- "What is the exact endpoint path and request/response shape for /X/Y?" — returns field-level detail
- "For [product]: what is the correct products[] string? What are the documented [enum] values?" — authoritative
- "Is [value] a documented value for [field]?" — AskBill will say yes/no definitively
- "Can [field] return custom values like [X], or is it always one of [A, B, C]?" — confirms enum constraints

## Confirmed API facts (per product)

### Auth
- Endpoint: `POST /auth/get`
- `products[]`: `"auth"`
- Response: `accounts[]`, `numbers.ach[]` (each has `account`, `routing`, `wire_routing`), `item`, `request_id`
- "Instant Auth" = a verification flow/method, NOT the product name; product name = "Plaid Auth"
- `item.auth_method` values: `INSTANT_AUTH`, `INSTANT_MATCH`, `AUTOMATED_MICRODEPOSITS`, `SAME_DAY_MICRODEPOSITS`, `INSTANT_MICRODEPOSITS`, `DATABASE_MATCH`, `DATABASE_INSIGHTS`

### Signal
- Score range: **1–99** (NOT 0–99 — minimum is 1, confirmed)
- `ruleset.result` documented values: `ACCEPT`, `REVIEW`, `REROUTE` — **REJECT is NOT documented**
- `APPROVE` is NOT a valid `ruleset.result` value (even with custom rulesets) — use custom actions via `triggered_rule_details.custom_action_key` instead
- `products[]` string: `"signal"`

### Bank Income (traditional)
- Endpoint: `POST /credit/bank_income/get` (requires `user_token` from `/user/create`)
- `products[]`: `["income_verification"]`; only valid co-product is `"employment"`
- Sandbox: `user_bank_income` / `{}` (literal two-character password)

### CRA Family
- Endpoints confirmed: `/cra/check_report/base_report/get`, `/cra/check_report/cashflow_insights/get`, `/cra/check_report/lend_score/get`, `/cra/check_report/income_insights/get`
- Products: `cra_base_report`, `cra_cashflow_insights`, `cra_lend_score`, `cra_income_insights`
- `/user/create` required before `/link/token/create`
- `cra_options` required; version strings: `cra_cashflow_insights.version: "CFI1"`, `cra_lend_score.version: "LS1"`, `cra_income_insights.version: "II2"`

### IDV
- `products: ["identity_verification"]` — mutually exclusive, confirmed
- Statuses: `active`, `success`, `failed`, `expired`, `canceled`, `pending_review`
- `onSuccess`: no meaningful `public_token`; IDV session ID from metadata

### Liabilities
- Endpoint: `POST /liabilities/get`
- `products[]`: `"liabilities"`
- Refresh: ~once per day (NOT live) — confirmed
- Federal student loans NOT available since Aug 2024 (Stop Act) — confirmed

### Transfer
- `POST /transfer/authorization/create` response does NOT contain Signal fields (`scores.*`, `ruleset.result`, `core_attributes`)
- `products[]`: `["transfer", "signal"]` — do NOT add `"auth"` (implicit)
- Signal runs internally inside authorization; decision surfaced via `authorization.decision` + `authorization.decision_rationale`
- `decision_rationale.code`: `PAYMENT_RISK` (not `RISK`) when Signal declines

### Layer
- `/session/token/create` has NO `products[]` field — product selection is via Dashboard template (`template_id`)
- `email_address` is currently NOT returned by `/user_account/session/get`
- Layer events: `LAYER_READY`, `LAYER_NOT_AVAILABLE`, `LAYER_AUTOFILL_NOT_AVAILABLE`
- Returned identity is consumer-submitted (phone is verified; other fields editable by user)

### Investments
- `products[]`: `"investments"` — NOT `"investments_auth"` (that's Investments Move)
- Endpoints: `POST /investments/holdings/get`, `POST /investments/transactions/get`
- Webhooks: `HOLDINGS: DEFAULT_UPDATE`, `INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE`, `INVESTMENTS_TRANSACTIONS: HISTORICAL_UPDATE`
- Max 24-month transaction history — confirmed

### Investments Move
- `products[]`: `"investments_auth"` — NOT `"investments"`
- Endpoint: `POST /investments/auth/get`
- Response: `numbers.acats[]{account, account_id, dtc_numbers[]}`, `owners`, `holdings`, `data_sources`
- Early Availability / Sales-gated — confirmed

## Queries that returned noise
- Asking about specific customer pricing details — AskBill defers to deal desk
- Asking about internal Glean documents — AskBill only has public docs
