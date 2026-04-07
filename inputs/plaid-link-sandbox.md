# Plaid Link Sandbox — Headless Browser Agent Instructions

Instructions for the AI-driven browser agent (Playwright + vision) to navigate
Plaid Link in Sandbox Mode. Used by `record-local.js`, `plaid-browser-agent.js`,
and any pipeline stage that drives Plaid Link automation.

Source: AskBill (Plaid internal docs) + plaid.com/docs/sandbox/

---

## Quick Reference

| Setting | Value |
|---------|-------|
| Environment | `sandbox` |
| OTP (Remember Me / Layer) | `123456` |
| MFA OTP (bank login) | `1234` |
| Default institution | First Platypus Bank (`ins_109508`) |
| Default credentials | `user_good` / `pass_good` |

---

## 1. Institutions

### Classic Link (non-OAuth) — credential-based

| Name | Institution ID | Use Case |
|------|---------------|---------|
| **First Platypus Bank** | `ins_109508` | **Primary** — use for all standard tests |
| First Platypus Balance Bank | `ins_130016` | Balance-focused testing |
| First Gingham Credit Union | `ins_109509` | General testing |
| Tattersall Federal Credit Union | `ins_109510` | General testing |
| Tartan Bank | `ins_109511` | General testing |
| **Houndstooth Bank** | `ins_109512` | **Micro-deposit auth** testing |
| Windowpane Bank | `ins_135858` | Instant micro-deposit testing |
| Tartan-Dominion Bank of Canada | `ins_43` | Canada testing |
| Unhealthy Platypus Bank - Degraded | `ins_132363` | Error: degraded |
| Unhealthy Platypus Bank - Down | `ins_132361` | Error: down |
| Unsupported Platypus Bank | `ins_133402` | Error: not supported |

### OAuth Flow — redirect to bank simulation

| Name | Institution ID | Use Case |
|------|---------------|---------|
| **Platypus OAuth Bank** | `ins_127287` | **Preferred** OAuth testing |
| First Platypus OAuth App2App Bank | `ins_132241` | App-to-App OAuth |
| Flexible Platypus Open Banking (UK) | `ins_116834` | UK/EU OAuth |
| Royal Bank of Plaid (UK) | `ins_117650` | UK/EU OAuth |
| Flexible Platypus Open Banking (QR) | `ins_117181` | UK/EU QR code OAuth |

**Agent rule:** If a redirect to a bank-hosted login page is detected (Plaid Link
iframe disappears, page URL changes to bank domain), execute the OAuth Flow steps
below. Prefer **Platypus OAuth Bank** (`ins_127287`) when the demo requires OAuth.

### OAuth Flow Steps

Execute when agent detects redirect away from Plaid Link to bank login page:

| Step | Location | Action |
|------|----------|--------|
| 1 | Plaid Link | Select institution → agree to data sharing → click "Continue to login" |
| 2 | Bank login page | Username: `user_good`, Password: `pass_good` → click "Sign in" |
| 3 | Bank MFA (if shown) | OTP field: `1234` → click "Submit code" |
| 4 | Plaid Link (account selection) | Select desired accounts → check both permission checkboxes → click "Continue" |
| 5 | Plaid Link (final confirmation) | Check "Plaid End User Privacy Policy" → click "Connect account information" |

---

## 2. Sandbox Credentials by Use Case

### 2.1 Standard (most products)

| Username | Password | Products |
|----------|----------|---------|
| `user_good` | `pass_good` | auth, balance, identity, transactions, assets, signal, investments |

### 2.2 Transactions

| Username | Password | Notes |
|----------|----------|-------|
| `user_transactions_dynamic` | *(any non-empty)* | Dynamic history, pending/posted, webhooks |
| `user_ewa_user` | *(any)* | Earned Wage Access persona |
| `user_yuppie` | *(any)* | High-spending persona |
| `user_small_business` | *(any)* | Business account |

### 2.3 Auth Micro-Deposits

| Username | Password | Institution |
|----------|----------|------------|
| `user_good` | `microdeposits_good` | Houndstooth Bank (`ins_109512`) |

### 2.4 MFA

| Username | Password | Code | MFA Type |
|----------|----------|------|---------|
| `user_good` | `mfa_device` | `1234` | Device OTP |
| `user_good` | `mfa_questions__` | `answer__` | Questions |
| `user_good` | `mfa_selections` | `Yes` | Selections |

Note: Bank of America (`ins_1`) and US Bank always trigger MFA in Sandbox.

### 2.5 Error Simulation

Use `user_good` with password = `error_<ERROR_CODE>`:

```
error_ITEM_LOCKED            error_INVALID_CREDENTIALS
error_INSTITUTION_DOWN       error_INVALID_MFA
error_NO_ACCOUNTS            error_USER_INPUT_TIMEOUT
error_COUNTRY_NOT_SUPPORTED  error_INSTITUTION_NOT_RESPONDING
error_INVALID_SEND_METHOD    error_ITEM_NOT_SUPPORTED
error_INTERNAL_SERVER_ERROR  error_USER_SETUP_REQUIRED
```

---

## 3. Credit, Income & CRA Credentials

**Important:** `user_good` / `pass_good` is **not** suitable for **CRA Check Link** institution login. Use non-OAuth institutions only (First Platypus Bank, Houndstooth Bank).

| Username | Password | Description |
|----------|----------|-------------|
| `user_credit_profile_excellent` | *(any)* | High salary, positive cash flow — **use for CRA / Plaid Check Link** |
| `user_credit_profile_good` | *(any)* | Neutral cash flow, gig economy |
| `user_credit_profile_poor` | *(any)* | Net loss, no consistent income |
| `user_credit_bonus` | *(any)* | Payroll with bonus/commission |
| `user_credit_joint_account` | *(any)* | Multiple salary streams |
| `user_bank_income` | `{}` | **Bank Income** (traditional income product) — **not** the primary CRA Check Link persona |

**Automation in this repo:** for `user_credit_*` institution login in Playwright, use password **`pass_good`** (matches §7 and `record-local.js` defaults), even though many sandbox rows accept any non-empty password.
| `user_prism_1` … `user_prism_8` | *(any)* | Bank Income / Partner Insights personas |

---

## 4. Remember Me — Phone Numbers (OTP: `123456` for all)

| Phone | Scenario |
|-------|---------|
| `415-555-0010` | New user (first-time flow) |
| `415-555-0011` | Verified returning user |
| `415-555-0012` | Returning + new account |
| `415-555-0013` | OAuth returning user |
| `415-555-0014` | New device (extra verification) |
| `415-555-0015` | Auto-select (single institution) |

**Agent rule:** Always skip the Remember Me phone screen in standard Link flows
via "Continue without phone number". Only use phone numbers above when the demo
specifically tests the Remember Me / returning user flow.

---

## 5. IDV Test Data — Leslie Knope (success)

| Field | Value |
|-------|-------|
| Mobile | `+12345678909` |
| First name | `Leslie` |
| Last name | `Knope` |
| Verification code | `11111` |
| Address | `123 Main St.` |
| City | `Pawnee` |
| State | `Indiana` |
| ZIP | `46001` |
| DOB | January 18, 1975 |
| SSN | `123-45-6789` |

**Token source:** `/link/token/create` with `products: ["identity_verification"]`,
or `/session/token/create` with `template_id` for Layer + CRA.

**Note:** Selfie checks and watchlist hits are not run in Sandbox.

---

## 6. Layer Flow

- Token from `/session/token/create` (not `/link/token/create`)
- Phone: `+14155550000`, OTP: `123456`
- For credential-flow demos: click "I'd rather log in manually"

---

## 7. Agent Decision Table

| Goal | Institution | Username | Password | Notes |
|------|-------------|----------|----------|-------|
| Basic success | First Platypus Bank | `user_good` | `pass_good` | Default |
| Transactions | First Platypus Bank | `user_transactions_dynamic` | *(any)* | |
| Micro-deposit auth | Houndstooth Bank | `user_good` | `microdeposits_good` | |
| OAuth flow | Platypus OAuth Bank | `user_good` | `pass_good` | Detect redirect → OAuth steps |
| Remember Me (new) | Any | — | — | Phone: `415-555-0010`, OTP: `123456` |
| Remember Me (returning) | Any | — | — | Phone: `415-555-0011`, OTP: `123456` |
| IDV | First Platypus Bank | — | — | Leslie Knope form data |
| CRA / Plaid Check Link | First Platypus Bank | `user_credit_profile_good` (or other `user_credit_*`) | `pass_good` | Non-OAuth only |
| Bank Income (traditional) | First Platypus Bank | `user_bank_income` | `{}` | Non-OAuth only; not CRA-primary |
| MFA | First Platypus Bank | `user_good` | `mfa_device` | OTP: `1234` |
| Error test | First Platypus Bank | `user_good` | `error_ITEM_LOCKED` | Any `error_*` value |
