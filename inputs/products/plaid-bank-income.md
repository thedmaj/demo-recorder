---
product: "Plaid Income — Bank Income"
slug: "bank-income"
api_endpoints:
  - "/link/token/create"
  - "/credit/bank_income/get"
use_cases:
  - income-from-bank-data
  - traditional-income-verification
last_human_review: "2026-03-27"
last_ai_update: "2026-03-27T00:00:00Z"
needs_review: true
approved: false
version: 1
---

# Plaid Income — Bank Income (traditional)

## Overview

Sandbox **institution login** for **Bank Income** / income-from-bank-data flows that use the **traditional** Income product (not Plaid Check / Consumer Report / CRA Link).

## Sandbox credentials (Link bank step)

| Username | Password | Notes |
|----------|----------|--------|
| `user_bank_income` | `{}` (literal two-character password) | Wide income streams for **Bank Income** testing |
| `user_prism_1` … `user_prism_8` | any | Additional Bank Income / Partner Insights personas (see Plaid docs) |

Use a **non-OAuth** sandbox institution (e.g. **First Platypus Bank**, `ins_109508`) unless your test requires OAuth.

## Not the same as CRA Check Link

For **Plaid Check** / **CRA** demos (`cra_base_report`, `cra_income_insights`), use **`user_credit_*`** personas and `consumer_report_permissible_purpose` on `/link/token/create` — see [plaid-cra-base-report.md](plaid-cra-base-report.md) and [plaid-income-insights.md](plaid-income-insights.md). Do not treat `user_bank_income` as the primary CRA sandbox login in those flows.

Reference: [Plaid Sandbox test credentials](https://plaid.com/docs/sandbox/test-credentials/#credit-and-income-testing-credentials).
