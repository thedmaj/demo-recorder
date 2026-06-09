---
name: plaid-layer-cra-onboarding
description: Canonical flow for onboarding users with Plaid Layer + Plaid Consumer Report (CRA). Layer permissions accounts AND collects identity in ONE session — there is NO separate CRA Plaid Link session. The CRA report is generated server-side from the updated user record. Load when a demo or integration pairs Plaid Layer with CRA Base Report / Cash Flow Insights / Income Insights / LendScore, or mentions CRA_EWA_LAYER_TEMPLATE_ID, /session/token/create with CRA products, /user/update from Layer identity, or /cra/check_report/create. NOT for Layer→IDV (see plaid-layer-idv-onboarding) or for non-CRA Layer onboarding (use PLAID_LAYER_TEMPLATE_ID).
---

# Plaid Layer + CRA (Consumer Report) onboarding — canonical flow

Source of truth: https://plaid.com/docs/check/onboard-users-with-layer/

## The one rule that changes everything

**With Layer, a CRA demo needs only ONE Plaid launch — the Layer session.**
Layer both (a) permissions the user's accounts and (b) returns user-permissioned
identity. You then write that identity to the Plaid user record and generate the
Consumer Report **server-side**. There is **NO second Plaid Link session** for CRA.

> ❌ Anti-pattern (do not author this): a Layer launch **plus** a separate
> `plaidPhase:"launch"` CRA Link step.
> ✅ Correct: a single Layer `plaidPhase:"launch"` step, then a server-side
> report-generation beat (a "Generating your Consumer Report…" host state).

## Required config (env)

| Concern | Variable | Value / note |
|---|---|---|
| CRA Layer template (Layer session with **CRA products enabled**) | **`CRA_EWA_LAYER_TEMPLATE_ID`** | `template_3fvao27ap3bp` (legacy alias: `CRA_LAYER_TEMPLATE`, same value) |
| CRA API credentials | **`CRA_CLIENT_ID`** / **`CRA_SECRET`** | All CRA / Check API calls initialize with these (separate from `PLAID_CLIENT_ID`/`PLAID_SECRET`). Already wired in `plaid-backend.js` (CRA-scoped client when set). |
| Non-CRA Layer (payments, faster onboarding) | **`PLAID_LAYER_TEMPLATE_ID`** | Use this template for any **non-CRA** Layer use case. Do NOT use the CRA template for non-CRA flows. |

Pipeline plumbing: `plaid-backend.js` resolves the CRA Layer template from
`CRA_EWA_LAYER_TEMPLATE_ID ?? CRA_LAYER_TEMPLATE`. When that template is set **and**
the request has CRA products, the backend creates a single `/session/token/create`
(passing the legacy user_token in `user.user_id`) instead of a separate CRA link token.

## Canonical sequence

```
1  /user/create                    → save user_id (identity optional at creation)
2  /session/token/create           → CRA Layer template + user.user_id (the Plaid user_id)
3  user completes Layer            → (the single launch the viewer sees)
4  /user_account/session/get       → retrieve user-permissioned identity
5  /user/update                    → write identity back to the Plaid user record
6  /cra/check_report/create        → base report is eagerly generated here
7  wait for USER_CHECK_REPORT_READY (or CHECK_REPORT_READY)
8  /cra/check_report/base_report/get (by user_id)
```

`/session/token/create` body shape:

```json
{
  "template_id": "template_3fvao27ap3bp",
  "user": { "client_user_id": "your-internal-user-123", "user_id": "usr_9nSp2KuZ2x4JDw" }
}
```

### Step 5 — identity required before report generation

For CRA Check, the user record must have identity populated **before** generating the
report. From the Layer identity, write back via `/user/update` with non-empty:

- `name`
- `date_of_birth`
- `emails`
- `phone_numbers`
- `addresses`

Mark at least one of each **primary** where applicable. Plaid recommends including at
least a **partial SSN** in `id_numbers` to improve matching accuracy.

### Step 6 — eager Base Report

As of the documented behavior update, the Base Report is **always eagerly generated**
when `/cra/check_report/create` is called. Nothing special is needed beyond creating
the consumer report.

### Step 8 — fetch the Base Report

```js
const response = await client.craCheckReportBaseReportGet({ user_id: 'usr_9nSp2KuZ2x4JDw' });
```

## What the CRA Base Report contains

Broad account + cash-flow data: account balances; historical balance metrics
(`available`, `current`, `average_balance`, `average_monthly_balances`,
`most_recent_thirty_day_average_balance`, `limit` where applicable); transactions
included in the report; account owner information; aggregated report attributes like
inflow/outflow totals; and `warnings` if generation succeeded with partial limitations.
**Identity data is now provided in the Base Report only.**

## Transactions + Layer + CRA caveat

If you use Transactions together with CRA and Layer:

- On `/link/token/create`, put `transactions` in **`additional_consented_products`**, NOT `products`.
- Call `/transactions/sync` **only after** the `USER_CHECK_REPORT_READY` webhook.

This avoids a known issue with some Chase Layer sessions where triggering Transactions
extraction too early can cause CRA report generation to fail.

## Authoring a Layer + CRA demo (pipeline)

- **One `plaidPhase:"launch"` step** = the Layer session. Do **not** add a separate
  CRA Link launch.
- Beats: host "Continue with Plaid" (CTA) → **Layer launch** (review + share prefilled
  identity) → host **"Generating your Consumer Report…"** (server-side: `/user/update`
  → `/cra/check_report/create` → `USER_CHECK_REPORT_READY`) → CRA insight reveal(s)
  (`base_report/get`, plus `cashflow_insights/get` / `lend_score/get` as applicable) →
  decision card.
- The Layer session uses `CRA_EWA_LAYER_TEMPLATE_ID`; CRA API calls use
  `CRA_CLIENT_ID`/`CRA_SECRET` (both already resolved by `plaid-backend.js`).
- Frame Layer identity as **user-permissioned** (it is permissioned, and for CRA it is
  written into the user record before report generation). KYC document/selfie is a
  separate concern — see [`plaid-layer-idv-onboarding`](../plaid-layer-idv-onboarding/SKILL.md).

Related: per-product facts in [`inputs/products/plaid-layer.md`](../../../inputs/products/plaid-layer.md),
[`plaid-cra-base-report.md`](../../../inputs/products/plaid-cra-base-report.md),
[`plaid-cra-cashflow-insights.md`](../../../inputs/products/plaid-cra-cashflow-insights.md),
[`plaid-cra-lend-score.md`](../../../inputs/products/plaid-cra-lend-score.md),
[`plaid-cra-income-insights.md`](../../../inputs/products/plaid-cra-income-insights.md).
