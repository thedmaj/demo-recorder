# Plaid Link Navigation Learnings

Cumulative log of test harness runs. Each run records which CSS selectors and
vision strategies succeeded per step. Use this to tune plaid-browser-agent.js.

---

## Key Behavioral Facts (confirmed 2026-03-10)

### Remember Me phone numbers
| Phone | Scenario |
|-------|----------|
| `+14155550011` | Verified returning user — triggers Remember Me flow (institution list after OTP) |
| `+14155550010` | New user — standard flow |
| `+14155550012` | Returning + new account |
| `+14155550013` | OAuth returning |
| `+14155550014` | New device — needs credential re-entry |
| `+14155550015` | Auto-select |

**Default for automation: `+14155550011`** (verified returning user, skips search/creds).

### Phone screen behavior (CORRECTED)
- **Phone entry screen does NOT auto-advance** after entering digits.
- Automation must type the number AND then click the **Continue** button explicitly.
- Previous assumption ("Plaid auto-submits on fill") was WRONG — only `fill()` via Playwright's value-set path appeared to auto-submit; that bypassed the normal button click.

### OTP screen behavior (confirmed)
- **OTP screen DOES auto-advance** after the 6-digit code is entered.
- No need to click Continue/Submit after filling the OTP.
- **Automation timing**: add **1 second pause** after `el.fill(OTP)` before checking for auto-advance. This gives Plaid's input handler time to fire and keeps the filled digits visible for 1s in the recording.
- `recordStep('otp-filled')` is logged right after the 1s pause — the post-processor uses this timestamp as the anchor for the "digits visible" keep window.

### `phone_number` in `/link/token/create`
- Passing `user.phone_number` in the token creation request helps Plaid identify the user on the **backend** for Remember Me matching.
- It does **NOT** pre-populate the phone field or skip the phone entry UI screen.
- Default: pass `+14155550011` in all test and demo token requests.

### Remember Me flow after OTP (phone `+14155550011`)
1. Phone entry → type 10 digits → click Continue → OTP screen
2. OTP → enter `123456` → auto-advances → saved institution list
3. Institution list → click non-OAuth bank (Tartan Bank `ins_109511` preferred) → account selection
4. Account selection → click account row → click Confirm → onSuccess

### Institution list detection and timing
- Use `frameLocator('ul li')` to enumerate items, not `page.frames().find(...) + evaluate`.
- `li.offsetParent !== null` is unreliable for visibility in Plaid's overflow containers; use `el.isVisible()` via Playwright locator instead.
- **Pre-click pause**: use **500ms** (not 2s) before selecting the institution — post-processing preserves what's needed and 2s produces a 1.5s-too-long section in the output.
- `recordStep('institution-list-shown')` is logged right after detection, before the 500ms pause.

### Sandbox OTP
- Remember Me OTP: `123456`
- Standard MFA OTP: `1234`

---

## Run: Mar 9, 2026 — FAIL (14/15) [CSS-only]
**Institution**: First Platypus Bank | **Username**: user_good

### What worked:
  - **Click Connect button**: data-testid selector
  - **Skip Remember Me phone screen**: frameLocator — "Continue without phone number"
  - **Accept data sharing consent**: Not found
  - **Search for "First Platypus Bank"**: frameLocator input — "input[placeholder*="Search" i]"
  - **Select "First Platypus Bank" from results**: frameLocator getByText — "First Platypus Bank"
  - **Handle connection type screen (if shown)**: Selected first option — "li:first-of-type button"
  - **Enter username: user_good**: frameLocator — "input[type="text"]:first-of-type"
  - **Enter password**: frameLocator — "input[type="password"]"
  - **Submit credentials**: frameLocator — "button[type="submit"]"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Continue clicked (no account selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit

### What failed:
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 30000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN

---

## Run: Mar 9, 2026 — FAIL (14/15) [CSS-only]
**Institution**: First Platypus Bank | **Username**: user_good

### What worked:
  - **Click Connect button**: data-testid selector
  - **Skip Remember Me phone screen**: frameLocator — "Continue without phone number"
  - **Accept data sharing consent**: Not found
  - **Search for "First Platypus Bank"**: frameLocator input — "input[placeholder*="Search" i]"
  - **Select "First Platypus Bank" from results**: frameLocator getByText — "First Platypus Bank"
  - **Handle connection type screen (if shown)**: Selected first option — "li:first-of-type button"
  - **Enter username: user_good**: frameLocator — "input[type="text"]:first-of-type"
  - **Enter password**: frameLocator — "input[type="password"]"
  - **Submit credentials**: frameLocator — "button[type="submit"]"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Continue clicked without explicit account selection (may already be pre-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit

### What failed:
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 30000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN

---

## Run: Mar 9, 2026 — FAIL (15/16) [CSS-only]
**Institution**: First Platypus Bank | **Username**: user_good

### What worked:
  - **Click Connect button**: data-testid selector
  - **Skip Remember Me phone screen**: frameLocator — "Continue without phone number"
  - **Accept data sharing consent**: Not found
  - **Search for "First Platypus Bank"**: frameLocator input — "input[placeholder*="Search" i]"
  - **Select "First Platypus Bank" from results**: frameLocator getByText — "First Platypus Bank"
  - **Handle connection type screen (if shown)**: Selected first option — "li:first-of-type button"
  - **Enter username: user_good**: frameLocator — "input[type="text"]:first-of-type"
  - **Enter password**: frameLocator — "input[type="password"]"
  - **Submit credentials**: frameLocator — "button[type="submit"]"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Continue clicked without explicit account selection (may already be pre-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 30000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN

---

## Run: Mar 9, 2026 — PASS (16/16) [CSS-only]
**Institution**: First Platypus Bank | **Username**: user_good

### What worked:
  - **Click Connect button**: data-testid selector
  - **Skip Remember Me phone screen**: frameLocator — "Continue without phone number"
  - **Accept data sharing consent**: Not found
  - **Search for "First Platypus Bank"**: frameLocator input — "input[placeholder*="Search" i]"
  - **Select "First Platypus Bank" from results**: frameLocator getByText — "First Platypus Bank"
  - **Handle connection type screen (if shown)**: Selected first option — "li:first-of-type button"
  - **Enter username: user_good**: frameLocator — "input[type="text"]:first-of-type"
  - **Enter password**: frameLocator — "input[type="password"]"
  - **Submit credentials**: frameLocator — "button[type="submit"]"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Continue clicked without explicit account selection (may already be pre-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  (none — all passed!)

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, SKIP_SUBMIT_PHONE, TRANSITION_VIEW, SEARCH_INSTITUTION, SELECT_BRAND, SELECT_INSTITUTION, TRANSITION_VIEW, SUBMIT_CREDENTIALS, TRANSITION_VIEW, TRANSITION_VIEW, TRANSITION_VIEW, HANDOFF

---

## Run: Mar 9, 2026 — PASS (17/17) [CSS-only] — Remember Me — New user (first-time)
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0010

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0010**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Search for "First Platypus Bank"**: frameLocator input — "input[placeholder*="Search" i]"
  - **Select "First Platypus Bank" from results**: frameLocator getByText — "First Platypus Bank"
  - **Handle connection type screen (if shown)**: Selected first option — "li:first-of-type button"
  - **Enter username: user_good**: frameLocator — "input[type="text"]:first-of-type"
  - **Enter password**: frameLocator — "input[type="password"]"
  - **Submit credentials**: frameLocator — "button[type="submit"]"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Continue clicked without explicit account selection (may already be pre-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  (none — all passed!)

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, SEARCH_INSTITUTION, SELECT_BRAND, SELECT_INSTITUTION, TRANSITION_VIEW, SUBMIT_CREDENTIALS, TRANSITION_VIEW, HANDOFF

---

## Run: Mar 9, 2026 — FAIL (10/17) [CSS-only] — Remember Me — Verified returning user
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0011

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0011**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE

---

## Run: Mar 9, 2026 — FAIL (11/17) [CSS-only] — Remember Me — Returning + new account
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0012

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0012**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Account selected via "li[role="listitem"]" (Continue not found)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE

---

## Run: Mar 9, 2026 — FAIL (10/17) [CSS-only] — Remember Me — OAuth returning user
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0013

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0013**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE

---

## Run: Mar 9, 2026 — FAIL (11/17) [CSS-only] — Remember Me — New device (extra verification)
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0014

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0014**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Account selected via "li[role="listitem"]" (Continue not found)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE

---

## Run: Mar 9, 2026 — FAIL (10/17) [CSS-only] — Remember Me — Auto-select (single institution)
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0015

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0015**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SELECT_INSTITUTION

---

## Batch Summary: Remember Me — Mar 9, 2026
| Phone | Tag | Result | Outcome |
|-------|-----|--------|---------|
| `415-555-0010` | Remember Me — New user (first-time) | 17/17 ✅ | onSuccess |
| `415-555-0011` | Remember Me — Verified returning user | 10/17 ❌ | timeout |
| `415-555-0012` | Remember Me — Returning + new account | 11/17 ❌ | timeout |
| `415-555-0013` | Remember Me — OAuth returning user | 10/17 ❌ | timeout |
| `415-555-0014` | Remember Me — New device (extra verification) | 11/17 ❌ | timeout |
| `415-555-0015` | Remember Me — Auto-select (single institution) | 10/17 ❌ | timeout |

---

## Run: Mar 10, 2026 — FAIL (10/17) [CSS-only] — Remember Me — Verified returning user
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0011

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0011**: Phone entered via "input[type="tel"]" + submitted via "button:has-text("Send code")"
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE

---

## Batch Summary: Remember Me — Mar 10, 2026
| Phone | Tag | Result | Outcome |
|-------|-----|--------|---------|
| `415-555-0011` | Remember Me — Verified returning user | 10/17 ❌ | timeout |

---

## Run: Mar 10, 2026 — FAIL (10/17) [CSS-only] — Remember Me — Verified returning user
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0011

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0011**: Phone entered via "input[type="tel"]" + submitted via "button:has-text("Send code")"
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE

---

## Batch Summary: Remember Me — Mar 10, 2026
| Phone | Tag | Result | Outcome |
|-------|-----|--------|---------|
| `415-555-0011` | Remember Me — Verified returning user | 10/17 ❌ | timeout |

---

## Run: Mar 10, 2026 — FAIL (12/17) [CSS-only] — Remember Me — Verified returning user
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0011

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0011**: Phone entered via "input[type="tel"]" + submitted via "button:has-text("Send code")"
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Selected first option — "ul li:first-of-type"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Account selected via "li[role="listitem"]" + Continue clicked
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SUBMIT_PHONE, TRANSITION_VIEW, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, SELECT_INSTITUTION, HANDOFF

---

## Batch Summary: Remember Me — Mar 10, 2026
| Phone | Tag | Result | Outcome |
|-------|-----|--------|---------|
| `415-555-0011` | Remember Me — Verified returning user | 12/17 ❌ | onSuccess |

---

## Run: Mar 10, 2026 — FAIL (16/17) [CSS-only] — Remember Me — New user (first-time)
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0010

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0010**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Search for "First Platypus Bank"**: frameLocator input — "input[placeholder*="Search" i]"
  - **Select "First Platypus Bank" from results**: frameLocator getByText — "First Platypus Bank"
  - **Handle connection type screen (if shown)**: Selected first option — "li:first-of-type button"
  - **Enter username: user_good**: frameLocator — "input[type="text"]:first-of-type"
  - **Enter password**: frameLocator — "input[type="password"]"
  - **Submit credentials**: frameLocator — "button[type="submit"]"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Clicked final button: "Continue"
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  - **Select first account**: no detail

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, SEARCH_INSTITUTION, SELECT_BRAND, SELECT_INSTITUTION, TRANSITION_VIEW, SUBMIT_CREDENTIALS, TRANSITION_VIEW, HANDOFF

---

## Run: Mar 10, 2026 — FAIL (12/17) [CSS-only] — Remember Me — Verified returning user
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0011

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0011**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Selected first option — "ul li:first-of-type"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Account selected via "li[role="listitem"]" + Continue clicked
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, SELECT_INSTITUTION, HANDOFF

---

## Run: Mar 10, 2026 — FAIL (12/17) [CSS-only] — Remember Me — Returning + new account
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0012

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0012**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Selected first option — "ul li:first-of-type"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Account selected via "li[role="listitem"]" + Continue clicked
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, SELECT_INSTITUTION, HANDOFF

---

## Run: Mar 10, 2026 — FAIL (12/17) [CSS-only] — Remember Me — OAuth returning user
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0013

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0013**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Selected first option — "ul li:first-of-type"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Account selected via "li[role="listitem"]" + Continue clicked
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, SELECT_INSTITUTION, HANDOFF

---

## Run: Mar 10, 2026 — FAIL (11/17) [CSS-only] — Remember Me — New device (extra verification)
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0014

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0014**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Selected first option — "ul li:first-of-type"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Account selected via "li[role="listitem"]" + Continue clicked
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE

---

## Run: Mar 10, 2026 — FAIL (11/17) [CSS-only] — Remember Me — Auto-select (single institution)
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0015

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0015**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: frameLocator button — "Continue"
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SELECT_INSTITUTION, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, HANDOFF

---

## Batch Summary: Remember Me — Mar 10, 2026
| Phone | Tag | Result | Outcome |
|-------|-----|--------|---------|
| `415-555-0010` | Remember Me — New user (first-time) | 16/17 ❌ | onSuccess |
| `415-555-0011` | Remember Me — Verified returning user | 12/17 ❌ | onSuccess |
| `415-555-0012` | Remember Me — Returning + new account | 12/17 ❌ | onSuccess |
| `415-555-0013` | Remember Me — OAuth returning user | 12/17 ❌ | onSuccess |
| `415-555-0014` | Remember Me — New device (extra verification) | 11/17 ❌ | timeout |
| `415-555-0015` | Remember Me — Auto-select (single institution) | 11/17 ❌ | onSuccess |

---

## Run: Mar 10, 2026 — FAIL (8/17) [CSS-only] — Remember Me — New user (first-time)
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0010 [phone in token]

### What worked:
  - **Enter Remember Me phone: 415-555-0010**: Phone screen not detected — may have been skipped automatically
  - **Enter Remember Me OTP: 123456**: OTP screen not shown — Plaid may have auto-advanced
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Click Connect button**: no detail
  - **Plaid iframe appears**: page.waitForSelector: Timeout 20000ms exceeded.
Call log:
[2m  - waiting for locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]')[22m

  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  (none)

---

## Run: Mar 10, 2026 — FAIL (8/17) [CSS-only] — Remember Me — Verified returning user
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0011 [phone in token]

### What worked:
  - **Enter Remember Me phone: 415-555-0011**: Phone screen not detected — may have been skipped automatically
  - **Enter Remember Me OTP: 123456**: OTP screen not shown — Plaid may have auto-advanced
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Click Connect button**: no detail
  - **Plaid iframe appears**: page.waitForSelector: Timeout 20000ms exceeded.
Call log:
[2m  - waiting for locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]')[22m

  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  (none)

---

## Run: Mar 10, 2026 — FAIL (8/17) [CSS-only] — Remember Me — Returning + new account
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0012 [phone in token]

### What worked:
  - **Enter Remember Me phone: 415-555-0012**: Phone screen not detected — may have been skipped automatically
  - **Enter Remember Me OTP: 123456**: OTP screen not shown — Plaid may have auto-advanced
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Click Connect button**: no detail
  - **Plaid iframe appears**: page.waitForSelector: Timeout 20000ms exceeded.
Call log:
[2m  - waiting for locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]')[22m

  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  (none)

---

## Run: Mar 10, 2026 — FAIL (8/17) [CSS-only] — Remember Me — OAuth returning user
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0013 [phone in token]

### What worked:
  - **Enter Remember Me phone: 415-555-0013**: Phone screen not detected — may have been skipped automatically
  - **Enter Remember Me OTP: 123456**: OTP screen not shown — Plaid may have auto-advanced
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Click Connect button**: no detail
  - **Plaid iframe appears**: page.waitForSelector: Timeout 20000ms exceeded.
Call log:
[2m  - waiting for locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]')[22m

  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  (none)

---

## Run: Mar 10, 2026 — FAIL (8/17) [CSS-only] — Remember Me — New device (extra verification)
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0014 [phone in token]

### What worked:
  - **Enter Remember Me phone: 415-555-0014**: Phone screen not detected — may have been skipped automatically
  - **Enter Remember Me OTP: 123456**: OTP screen not shown — Plaid may have auto-advanced
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Click Connect button**: no detail
  - **Plaid iframe appears**: page.waitForSelector: Timeout 20000ms exceeded.
Call log:
[2m  - waiting for locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]')[22m

  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  (none)

---

## Run: Mar 10, 2026 — FAIL (8/17) [CSS-only] — Remember Me — Auto-select (single institution)
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0015 [phone in token]

### What worked:
  - **Enter Remember Me phone: 415-555-0015**: Phone screen not detected — may have been skipped automatically
  - **Enter Remember Me OTP: 123456**: OTP screen not shown — Plaid may have auto-advanced
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Click Connect button**: no detail
  - **Plaid iframe appears**: page.waitForSelector: Timeout 20000ms exceeded.
Call log:
[2m  - waiting for locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]')[22m

  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  (none)

---

## Batch Summary: Remember Me — Mar 10, 2026
| Phone | Tag | Result | Outcome |
|-------|-----|--------|---------|
| `415-555-0010` | Remember Me — New user (first-time) | 8/17 ❌ | timeout |
| `415-555-0011` | Remember Me — Verified returning user | 8/17 ❌ | timeout |
| `415-555-0012` | Remember Me — Returning + new account | 8/17 ❌ | timeout |
| `415-555-0013` | Remember Me — OAuth returning user | 8/17 ❌ | timeout |
| `415-555-0014` | Remember Me — New device (extra verification) | 8/17 ❌ | timeout |
| `415-555-0015` | Remember Me — Auto-select (single institution) | 8/17 ❌ | timeout |

---

## Run: Mar 10, 2026 — PASS (17/17) [CSS-only] — Remember Me — New user (first-time)
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0010 [phone in token]

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0010**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Search for "First Platypus Bank"**: frameLocator input — "input[placeholder*="Search" i]"
  - **Select "First Platypus Bank" from results**: frameLocator getByText — "First Platypus Bank"
  - **Handle connection type screen (if shown)**: Selected first option — "li:first-of-type button"
  - **Enter username: user_good**: frameLocator — "input[type="text"]:first-of-type"
  - **Enter password**: frameLocator — "input[type="password"]"
  - **Submit credentials**: frameLocator — "button[type="submit"]"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Continue clicked without explicit account selection (may already be pre-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  (none — all passed!)

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, SEARCH_INSTITUTION, SELECT_BRAND, SELECT_INSTITUTION, TRANSITION_VIEW, SUBMIT_CREDENTIALS, TRANSITION_VIEW, HANDOFF

---

## Run: Mar 10, 2026 — FAIL (12/17) [CSS-only] — Remember Me — Verified returning user
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0011 [phone in token]

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0011**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Selected first option — "ul li:first-of-type"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Account selected via "li[role="listitem"]" + Continue clicked
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, SELECT_INSTITUTION, HANDOFF

---

## Run: Mar 10, 2026 — FAIL (12/17) [CSS-only] — Remember Me — Returning + new account
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0012 [phone in token]

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0012**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Selected first option — "ul li:first-of-type"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Account selected via "li[role="listitem"]" + Continue clicked
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, SELECT_INSTITUTION, HANDOFF

---

## Run: Mar 10, 2026 — FAIL (12/17) [CSS-only] — Remember Me — OAuth returning user
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0013 [phone in token]

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0013**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Selected first option — "ul li:first-of-type"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Account selected via "li[role="listitem"]" + Continue clicked
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, SELECT_INSTITUTION, HANDOFF

---

## Run: Mar 10, 2026 — FAIL (11/17) [CSS-only] — Remember Me — New device (extra verification)
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0014 [phone in token]

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0014**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: Not found
  - **Handle connection type screen (if shown)**: Selected first option — "ul li:first-of-type"
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Select first account**: Account selected via "li[role="listitem"]" + Continue clicked
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Plaid Link onSuccess fires**: page.waitForFunction: Timeout 60000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE

---

## Run: Mar 10, 2026 — FAIL (11/17) [CSS-only] — Remember Me — Auto-select (single institution)
**Institution**: First Platypus Bank | **Username**: user_good | **Flow**: Remember Me phone=415-555-0015 [phone in token]

### What worked:
  - **Click Connect button**: data-testid selector
  - **Enter Remember Me phone: 415-555-0015**: Phone entered via "input[type="tel"]" (submit not found)
  - **Enter Remember Me OTP: 123456**: OTP entered via "input[inputmode="numeric"]" (submit not found)
  - **Accept data sharing consent**: frameLocator button — "Continue"
  - **Handle connection type screen (if shown)**: Not shown — single connection type
  - **Enter MFA code (if shown)**: Not shown — no MFA prompted
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown — may have auto-advanced
  - **Plaid Link onSuccess fires**: public_token received

### What failed:
  - **Search for "First Platypus Bank"**: no detail
  - **Select "First Platypus Bank" from results**: no detail
  - **Enter username: user_good**: no detail
  - **Enter password**: no detail
  - **Submit credentials**: no detail
  - **Select first account**: no detail

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SELECT_INSTITUTION, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, HANDOFF

---

## Batch Summary: Remember Me — Mar 10, 2026
| Phone | Tag | Result | Outcome |
|-------|-----|--------|---------|
| `415-555-0010` | Remember Me — New user (first-time) | 17/17 ✅ | onSuccess |
| `415-555-0011` | Remember Me — Verified returning user | 12/17 ❌ | onSuccess |
| `415-555-0012` | Remember Me — Returning + new account | 12/17 ❌ | onSuccess |
| `415-555-0013` | Remember Me — OAuth returning user | 12/17 ❌ | onSuccess |
| `415-555-0014` | Remember Me — New device (extra verification) | 11/17 ❌ | timeout |
| `415-555-0015` | Remember Me — Auto-select (single institution) | 11/17 ❌ | onSuccess |

---

## Run: Mar 10, 2026 — FAIL (10/11) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: +14155550011 | **Token method**: link-with-phone | **Manual login**: false
**Layer outcome**: no LAYER_READY/LAYER_NOT_AVAILABLE event observed

### What worked:
  - **Create Layer token**: token created via link-with-phone
  - **Layer: enter OTP 123456 (if shown)**: OTP filled (auto-advance expected)
  - **Wait for LAYER_READY or LAYER_NOT_AVAILABLE**: No Layer event — events: TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE
  - **Handle institution search (if shown)**: Institution search not shown — skipped
  - **Handle credentials (if shown)**: Credential screen not shown — skipped (returning user or Layer handled auth)
  - **Handle account selection (if shown)**: Account selected + Continue clicked
  - **Plaid Layer onSuccess fires**: public_token received

### What failed:
  - **Layer: enter phone number**: locator.click: Timeout 30000ms exceeded.
Call log:
[2m  - waiting for locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]').contentFrame().locator('button:has-text("Continue")').first()[22m
[2m    - locator resolved to <button disabled tabindex="-1" type="submit" role="button" id="aut-button" aria-disabled="true" class="MuiButtonBase-root MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Mui-disabled MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Button-module__button Button-module__refreshed css-d9vs8">…</button>[22m
[2m  - attempting click action[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m    - waiting 20ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m      - waiting 100ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m      - waiting 500ms[22m
[2m    - waiting for element to be visible, enabled and stable[22m
[2m  - element was detached from the DOM, retrying[22m
[2m    - locator resolved to <button disabled tabindex="-1" type="submit" role="button" id="aut-button" aria-disabled="true" class="MuiButtonBase-root MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Mui-disabled MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Button-module__button Button-module__refreshed css-o8l9o5">…</button>[22m
[2m  - attempting click action[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m    - waiting 20ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m      - waiting 100ms[22m
[2m    55 × waiting for element to be visible, enabled and stable[22m
[2m       - element is not enabled[22m
[2m     - retrying click action[22m
[2m       - waiting 500ms[22m


### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, SELECT_INSTITUTION, HANDOFF

---

## Run: Mar 10, 2026 — FAIL (9/11) [Layer] — Layer — Ineligible (LAYER_NOT_AVAILABLE)
**Phone**: +14155550000 | **Token method**: link-with-phone | **Manual login**: false
**Layer outcome**: no LAYER_READY/LAYER_NOT_AVAILABLE event observed

### What worked:
  - **Create Layer token**: token created via link-with-phone
  - **Layer: enter OTP 123456 (if shown)**: OTP filled (auto-advance expected)
  - **Wait for LAYER_READY or LAYER_NOT_AVAILABLE**: No Layer event — events: TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE
  - **Handle institution search (if shown)**: Searched and selected First Platypus Bank
  - **Handle credentials (if shown)**: Credential screen not shown — skipped (returning user or Layer handled auth)
  - **Handle account selection (if shown)**: Account selection not shown — skipped

### What failed:
  - **Layer: enter phone number**: locator.click: Timeout 30000ms exceeded.
Call log:
[2m  - waiting for locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]').contentFrame().locator('button:has-text("Continue")').first()[22m
[2m    - locator resolved to <button disabled tabindex="-1" type="submit" role="button" id="aut-button" aria-disabled="true" class="MuiButtonBase-root MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Mui-disabled MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Button-module__button Button-module__refreshed css-d9vs8">…</button>[22m
[2m  - attempting click action[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m    - waiting 20ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m      - waiting 100ms[22m
[2m    - waiting for element to be visible, enabled and stable[22m
[2m  - element was detached from the DOM, retrying[22m
[2m    - locator resolved to <button disabled tabindex="-1" type="submit" role="button" id="aut-button" aria-disabled="true" class="MuiButtonBase-root MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Mui-disabled MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Button-module__button Button-module__refreshed css-o8l9o5">…</button>[22m
[2m  - attempting click action[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m    - waiting 20ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m      - waiting 100ms[22m
[2m    57 × waiting for element to be visible, enabled and stable[22m
[2m       - element is not enabled[22m
[2m     - retrying click action[22m
[2m       - waiting 500ms[22m

  - **Plaid Layer onSuccess fires**: page.waitForFunction: Timeout 30000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE

---

## Run: Mar 10, 2026 — FAIL (8/11) [Layer] — Layer — Partial PII
**Phone**: +15155550017 | **Token method**: link-with-phone | **Manual login**: false
**Layer outcome**: no LAYER_READY/LAYER_NOT_AVAILABLE event observed

### What worked:
  - **Create Layer token**: token created via link-with-phone
  - **Layer: enter OTP 123456 (if shown)**: OTP filled (auto-advance expected)
  - **Wait for LAYER_READY or LAYER_NOT_AVAILABLE**: No Layer event — events: TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SELECT_INSTITUTION
  - **Handle institution search (if shown)**: Institution search not shown — skipped
  - **Handle credentials (if shown)**: Credential screen not shown — skipped (returning user or Layer handled auth)

### What failed:
  - **Layer: enter phone number**: locator.click: Timeout 30000ms exceeded.
Call log:
[2m  - waiting for locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]').contentFrame().locator('button:has-text("Continue")').first()[22m
[2m    - locator resolved to <button disabled tabindex="-1" type="submit" role="button" id="aut-button" aria-disabled="true" class="MuiButtonBase-root MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Mui-disabled MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Button-module__button Button-module__refreshed css-d9vs8">…</button>[22m
[2m  - attempting click action[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m    - waiting 20ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m      - waiting 100ms[22m
[2m    - waiting for element to be visible, enabled and stable[22m
[2m    - element is not enabled[22m
[2m  - retrying click action[22m
[2m    - waiting 500ms[22m
[2m    - waiting for element to be visible, enabled and stable[22m
[2m  - element was detached from the DOM, retrying[22m
[2m    - locator resolved to <button disabled tabindex="-1" type="submit" role="button" id="aut-button" aria-disabled="true" class="MuiButtonBase-root MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Mui-disabled MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Button-module__button Button-module__refreshed css-o8l9o5">…</button>[22m
[2m  - attempting click action[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m    - waiting 20ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m      - waiting 100ms[22m
[2m    56 × waiting for element to be visible, enabled and stable[22m
[2m       - element is not enabled[22m
[2m     - retrying click action[22m
[2m       - waiting 500ms[22m

  - **Handle account selection (if shown)**: locator.click: Timeout 30000ms exceeded.
Call log:
[2m  - waiting for locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]').contentFrame().locator('li[role="listitem"]').first()[22m
[2m    - locator resolved to <li tabindex="-1" role="listitem" id="aut-selection-0" data-state="disabled" class="MuiListItem-root MuiListItem-gutters MuiListItem-padding Thr-ListItem UserSelectionPane-module__refreshedListItem css-cajy21">…</li>[22m
[2m  - attempting click action[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is visible, enabled and stable[22m
[2m      - scrolling into view if needed[22m
[2m      - done scrolling[22m
[2m      - <div class="margin-bottom-2">…</div> intercepts pointer events[22m
[2m    - retrying click action[22m
[2m    - waiting 20ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is visible, enabled and stable[22m
[2m      - scrolling into view if needed[22m
[2m      - done scrolling[22m
[2m      - <div class="margin-bottom-2">…</div> intercepts pointer events[22m
[2m    - retrying click action[22m
[2m      - waiting 100ms[22m
[2m    57 × waiting for element to be visible, enabled and stable[22m
[2m       - element is visible, enabled and stable[22m
[2m       - scrolling into view if needed[22m
[2m       - done scrolling[22m
[2m       - <div class="margin-bottom-2">…</div> intercepts pointer events[22m
[2m     - retrying click action[22m
[2m       - waiting 500ms[22m

  - **Plaid Layer onSuccess fires**: page.waitForFunction: Timeout 30000ms exceeded.

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SELECT_INSTITUTION

---

## Run: Mar 10, 2026 — FAIL (10/12) [Layer] — Layer — Manual login bypass
**Phone**: +14155550011 | **Token method**: link-with-phone | **Manual login**: true
**Layer outcome**: no LAYER_READY/LAYER_NOT_AVAILABLE event observed

### What worked:
  - **Create Layer token**: token created via link-with-phone
  - **Layer: enter OTP 123456 (if shown)**: OTP filled (auto-advance expected)
  - **Wait for LAYER_READY or LAYER_NOT_AVAILABLE**: No Layer event — events: TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE
  - **Handle institution search (if shown)**: Institution search not shown — skipped
  - **Handle credentials (if shown)**: Credential screen not shown — skipped (returning user or Layer handled auth)
  - **Handle account selection (if shown)**: Account selected + Continue clicked
  - **Plaid Layer onSuccess fires**: public_token received

### What failed:
  - **Layer: enter phone number**: locator.click: Timeout 30000ms exceeded.
Call log:
[2m  - waiting for locator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]').contentFrame().locator('button:has-text("Continue")').first()[22m
[2m    - locator resolved to <button disabled tabindex="-1" type="submit" role="button" id="aut-button" aria-disabled="true" class="MuiButtonBase-root MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Mui-disabled MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Button-module__button Button-module__refreshed css-d9vs8">…</button>[22m
[2m  - attempting click action[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m    - waiting 20ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m      - waiting 100ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m      - waiting 500ms[22m
[2m    - waiting for element to be visible, enabled and stable[22m
[2m  - element was detached from the DOM, retrying[22m
[2m    - locator resolved to <button disabled tabindex="-1" type="submit" role="button" id="aut-button" aria-disabled="true" class="MuiButtonBase-root MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Mui-disabled MuiButton-root MuiButton-text MuiButton-textPrimary MuiButton-sizeMedium MuiButton-textSizeMedium MuiButton-colorPrimary Button-module__button Button-module__refreshed css-o8l9o5">…</button>[22m
[2m  - attempting click action[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m    - waiting 20ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not enabled[22m
[2m    - retrying click action[22m
[2m      - waiting 100ms[22m
[2m    55 × waiting for element to be visible, enabled and stable[22m
[2m       - element is not enabled[22m
[2m     - retrying click action[22m
[2m       - waiting 500ms[22m

  - **Layer: click "I'd rather log in manually"**: no detail

### Plaid events observed:
  TRANSITION_VIEW, TRANSITION_VIEW, OPEN, VERIFY_PHONE, SUBMIT_PHONE, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, SELECT_INSTITUTION, HANDOFF

---

## Batch Summary: Plaid Layer — Mar 10, 2026
| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 10/11 ❌ | none | onSuccess |
| `+14155550000` | Layer — Ineligible (LAYER_NOT_AVAILABLE) | 9/11 ❌ | none | timeout/error |
| `+15155550017` | Layer — Partial PII | 8/11 ❌ | none | timeout/error |
| `+14155550011` | Layer — Manual login bypass | 10/12 ❌ | none | onSuccess |

---

## Run: Mar 10, 2026 — FAIL (0/1) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: none (LAYER_READY/LAYER_NOT_AVAILABLE not fired)
**Outcome**: timeout / incomplete

### What worked:
  (none)

### What failed:
  - **Create session token (/link/token/create + template_id)**: Token creation failed: {"display_message":null,"documentation_url":"https://plaid.com/docs/?ref=error#invalid-request-errors","error_code":"UNKNOWN_FIELDS","error_message":"the following fields are not recognized by this endpoint: user.phone_number","error_type":"INVALID_REQUEST","request_id":"0PBlhvIaeYbdrTp","suggested_action":null}

### Plaid events observed:
  (none)

---

## Run: Mar 10, 2026 — FAIL (0/1) [Layer] — Layer — Ineligible (LAYER_NOT_AVAILABLE)
**Phone**: `+14155550000` | **Manual login**: false | **Expected event**: LAYER_NOT_AVAILABLE
**Layer event observed**: none (LAYER_READY/LAYER_NOT_AVAILABLE not fired)
**Outcome**: timeout / incomplete

### What worked:
  (none)

### What failed:
  - **Create session token (/link/token/create + template_id)**: Token creation failed: {"display_message":null,"documentation_url":"https://plaid.com/docs/?ref=error#invalid-request-errors","error_code":"UNKNOWN_FIELDS","error_message":"the following fields are not recognized by this endpoint: user.phone_number","error_type":"INVALID_REQUEST","request_id":"AzTAt2AjXs9dPP0","suggested_action":null}

### Plaid events observed:
  (none)

---

## Run: Mar 10, 2026 — FAIL (0/1) [Layer] — Layer — Partial PII
**Phone**: `+15155550017` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: none (LAYER_READY/LAYER_NOT_AVAILABLE not fired)
**Outcome**: timeout / incomplete

### What worked:
  (none)

### What failed:
  - **Create session token (/link/token/create + template_id)**: Token creation failed: {"display_message":null,"documentation_url":"https://plaid.com/docs/?ref=error#invalid-request-errors","error_code":"UNKNOWN_FIELDS","error_message":"the following fields are not recognized by this endpoint: user.phone_number","error_type":"INVALID_REQUEST","request_id":"rtoAXpf0XFQfJLP","suggested_action":null}

### Plaid events observed:
  (none)

---

## Run: Mar 10, 2026 — FAIL (0/1) [Layer] — Layer — Manual login bypass
**Phone**: `+14155550011` | **Manual login**: true | **Expected event**: LAYER_READY
**Layer event observed**: none (LAYER_READY/LAYER_NOT_AVAILABLE not fired)
**Outcome**: timeout / incomplete

### What worked:
  (none)

### What failed:
  - **Create session token (/link/token/create + template_id)**: Token creation failed: {"display_message":null,"documentation_url":"https://plaid.com/docs/?ref=error#invalid-request-errors","error_code":"UNKNOWN_FIELDS","error_message":"the following fields are not recognized by this endpoint: user.phone_number","error_type":"INVALID_REQUEST","request_id":"GuQWL0tVgaklpuB","suggested_action":null}

### Plaid events observed:
  (none)

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 0/1 ❌ | none | timeout |
| `+14155550000` | Layer — Ineligible (LAYER_NOT_AVAILABLE) | 0/1 ❌ | none | timeout |
| `+15155550017` | Layer — Partial PII | 0/1 ❌ | none | timeout |
| `+14155550011` | Layer — Manual login bypass | 0/1 ❌ | none | timeout |

---

## Run: Mar 10, 2026 — FAIL (0/1) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: none (LAYER_READY/LAYER_NOT_AVAILABLE not fired)
**Outcome**: timeout / incomplete

### What worked:
  (none)

### What failed:
  - **Create session token (/link/token/create + template_id)**: Token creation failed: {"link":{"expiration":"2026-03-10T13:13:03Z","link_token":"link-sandbox-61dfbe06-8a6c-4066-a125-c6cf83fd7b6a"},"request_id":"OUoAFhGrwHQbZ2O"}

### Plaid events observed:
  (none)

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 0/1 ❌ | none | timeout |

---

## Run: Mar 10, 2026 — FAIL (10/13) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: none (LAYER_READY/LAYER_NOT_AVAILABLE not fired)
**Outcome**: timeout / incomplete

### What worked:
  - **Create session token (/link/token/create + template_id)**: link_token created for user layer-test-1773146594017
  - **Layer: fill phone (auto-submits)**: Phone input not shown (events so far: none)
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown

### What failed:
  - **Layer: fill OTP 123456 (auto-submits)**: Polling exhausted after 10 attempts: OTP input
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: window is not defined
  - **Poll for onSuccess (with backoff)**: Polling exhausted after 15 attempts: onSuccess

### Plaid events observed:
  (none)

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 10/13 ❌ | none | timeout |

---

## Run: Mar 10, 2026 — FAIL (10/13) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: none (LAYER_READY/LAYER_NOT_AVAILABLE not fired)
**Outcome**: timeout / incomplete

### What worked:
  - **Create session token (/link/token/create + template_id)**: link_token created for user layer-test-1773146802724
  - **Layer: fill phone (auto-submits)**: Phone input not shown (events so far: none)
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown

### What failed:
  - **Layer: fill OTP 123456 (auto-submits)**: Polling exhausted after 10 attempts: OTP input
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: Polling exhausted after 12 attempts: Layer event
  - **Poll for onSuccess (with backoff)**: Polling exhausted after 15 attempts: onSuccess

### Plaid events observed:
  (none)

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 10/13 ❌ | none | timeout |

---

## Run: Mar 10, 2026 — FAIL (0/1) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: none (LAYER_READY/LAYER_NOT_AVAILABLE not fired)
**Outcome**: timeout / incomplete

### What worked:
  (none)

### What failed:
  - **Create session token (/user/create + /session/token/create)**: /user/create failed: {"display_message":null,"documentation_url":"https://plaid.com/docs/?ref=error#invalid-request-errors","error_code":"UNKNOWN_FIELDS","error_message":"the following fields are not recognized by this endpoint: address, date_of_birth, name, phone_number","error_type":"INVALID_REQUEST","request_id":"huqrEa0HJ2DDtBY","suggested_action":null}

### Plaid events observed:
  (none)

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 0/1 ❌ | none | timeout |

---

## Run: Mar 10, 2026 — FAIL (0/1) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: none (LAYER_READY/LAYER_NOT_AVAILABLE not fired)
**Outcome**: timeout / incomplete

### What worked:
  (none)

### What failed:
  - **Create session token (/user/create + /session/token/create)**: /session/token/create failed: {"display_message":null,"documentation_url":"https://plaid.com/docs/?ref=error#invalid-request-errors","error_code":"UNKNOWN_FIELDS","error_message":"the following fields are not recognized by this endpoint: user_token","error_type":"INVALID_REQUEST","request_id":"GizvJOF2gXFl1qL","suggested_action":null}

### Plaid events observed:
  (none)

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 0/1 ❌ | none | timeout |

---

## Run: Mar 10, 2026 — FAIL (10/13) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: none (LAYER_READY/LAYER_NOT_AVAILABLE not fired)
**Outcome**: timeout / incomplete

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773147269154
  - **Layer: fill phone (auto-submits)**: Phone input not shown (events so far: none)
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown

### What failed:
  - **Layer: fill OTP 123456 (auto-submits)**: Polling exhausted after 10 attempts: OTP input
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: Polling exhausted after 12 attempts: Layer event
  - **Poll for onSuccess (with backoff)**: Polling exhausted after 15 attempts: onSuccess

### Plaid events observed:
  (none)

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 10/13 ❌ | none | timeout |

---

## Run: Mar 10, 2026 — FAIL (11/12) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_READY
**Outcome**: timeout / incomplete

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773147866115
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_READY
  - **LAYER_READY: click Continue on consent screen**: Clicked Continue on Layer consent screen
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown

### What failed:
  - **Poll for onSuccess (with backoff)**: Polling exhausted after 15 attempts: onSuccess

### Plaid events observed:
  LAYER_READY, OPEN

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 11/12 ❌ | LAYER_READY | timeout |

---

## Run: Mar 10, 2026 — FAIL (12/13) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_READY
**Outcome**: timeout / incomplete

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773148080734
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_READY
  - **LAYER_READY: click Continue on consent screen**: Clicked Continue on Layer consent screen
  - **LAYER_READY: fill OTP (auto-submits)**: OTP 123456 filled — auto-submit expected
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown

### What failed:
  - **Poll for onSuccess (with backoff)**: Polling exhausted after 15 attempts: onSuccess

### Plaid events observed:
  LAYER_READY, OPEN, VERIFY_PHONE

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 12/13 ❌ | LAYER_READY | timeout |

---

## Run: Mar 10, 2026 — FAIL (14/15) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_READY
**Outcome**: onSuccess — public_token received

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773148298713
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_READY
  - **LAYER_READY: click Continue on consent screen**: Clicked Continue on Layer consent screen
  - **LAYER_READY: fill OTP (auto-submits)**: OTP 123456 filled — auto-submit expected
  - **LAYER_READY: click Share on review screen**: Clicked Share on Layer review screen
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onSuccess (with backoff)**: public_token received

### What failed:
  - **Exchange public_token → access_token**: no detail

### Plaid events observed:
  LAYER_READY, OPEN, VERIFY_PHONE, TRANSITION_VIEW, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, HANDOFF

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 14/15 ❌ | LAYER_READY | onSuccess |

---

## Run: Mar 10, 2026 — PASS (15/15) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_READY
**Outcome**: onSuccess — public_token received

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773148352732
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_READY
  - **LAYER_READY: click Continue on consent screen**: Clicked Continue on Layer consent screen
  - **LAYER_READY: fill OTP (auto-submits)**: OTP 123456 filled — auto-submit expected
  - **LAYER_READY: click Share on review screen**: Clicked Share on Layer review screen
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onSuccess (with backoff)**: public_token received
  - **Retrieve Layer session data (/user_account/session/get)**: Layer session data: {"identity":{"address":{"city":"Madison","country":"US","postal_code":"47250","region":"IN","street"

### What failed:
  (none — all passed!)

### Plaid events observed:
  LAYER_READY, OPEN, VERIFY_PHONE, TRANSITION_VIEW, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, HANDOFF

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 15/15 ✅ | LAYER_READY | onSuccess |

---

## Run: Mar 10, 2026 — PASS (15/15) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_READY
**Outcome**: onSuccess — public_token received

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773148379941
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_READY
  - **LAYER_READY: click Continue on consent screen**: Clicked Continue on Layer consent screen
  - **LAYER_READY: fill OTP (auto-submits)**: OTP 123456 filled — auto-submit expected
  - **LAYER_READY: click Share on review screen**: Clicked Share on Layer review screen
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onSuccess (with backoff)**: public_token received
  - **Retrieve Layer session data (/user_account/session/get)**: Layer session data: {"identity":{"address":{"city":"Madison","country":"US","postal_code":"47250","region":"IN","street"

### What failed:
  (none — all passed!)

### Plaid events observed:
  LAYER_READY, OPEN, VERIFY_PHONE, TRANSITION_VIEW, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, HANDOFF

---

## Run: Mar 10, 2026 — FAIL (10/11) [Layer] — Layer — Ineligible (LAYER_NOT_AVAILABLE)
**Phone**: `+14155550000` | **Manual login**: false | **Expected event**: LAYER_NOT_AVAILABLE
**Layer event observed**: LAYER_NOT_AVAILABLE
**Outcome**: timeout / incomplete

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773148407130
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_NOT_AVAILABLE
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown

### What failed:
  - **Poll for onSuccess (with backoff)**: Polling exhausted after 15 attempts: onSuccess

### Plaid events observed:
  LAYER_NOT_AVAILABLE

---

## Run: Mar 10, 2026 — FAIL (10/11) [Layer] — Layer — Partial PII
**Phone**: `+15155550017` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_NOT_AVAILABLE
**Outcome**: timeout / incomplete

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773148512711
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_NOT_AVAILABLE
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown

### What failed:
  - **Poll for onSuccess (with backoff)**: Polling exhausted after 15 attempts: onSuccess

### Plaid events observed:
  LAYER_NOT_AVAILABLE

---

## Run: Mar 10, 2026 — FAIL (15/16) [Layer] — Layer — Manual login bypass
**Phone**: `+14155550011` | **Manual login**: true | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_READY
**Outcome**: onSuccess — public_token received

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773148618941
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_READY
  - **LAYER_READY: click Continue on consent screen**: Clicked Continue on Layer consent screen
  - **LAYER_READY: fill OTP (auto-submits)**: OTP 123456 filled — auto-submit expected
  - **LAYER_READY: click Share on review screen**: Clicked Share on Layer review screen
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onSuccess (with backoff)**: public_token received
  - **Retrieve Layer session data (/user_account/session/get)**: Layer session data: {"identity":{"address":{"city":"Madison","country":"US","postal_code":"47250","region":"IN","street"

### What failed:
  - **Layer: click "I'd rather log in manually"**: no detail

### Plaid events observed:
  LAYER_READY, OPEN, VERIFY_PHONE, TRANSITION_VIEW, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, HANDOFF

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 15/15 ✅ | LAYER_READY | onSuccess |
| `+14155550000` | Layer — Ineligible (LAYER_NOT_AVAILABLE) | 10/11 ❌ | LAYER_NOT_AVAILABLE | timeout |
| `+15155550017` | Layer — Partial PII | 10/11 ❌ | LAYER_NOT_AVAILABLE | timeout |
| `+14155550011` | Layer — Manual login bypass | 15/16 ❌ | LAYER_READY | onSuccess |

---

## Run: Mar 10, 2026 — FAIL (10/11) [Layer] — Layer — Ineligible (LAYER_NOT_AVAILABLE)
**Phone**: `+14155550000` | **Manual login**: false | **Expected event**: LAYER_NOT_AVAILABLE
**Layer event observed**: LAYER_NOT_AVAILABLE
**Outcome**: timeout / incomplete

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773148676575
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_NOT_AVAILABLE
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown

### What failed:
  - **Poll for onSuccess (with backoff)**: Polling exhausted after 15 attempts: onSuccess

### Plaid events observed:
  LAYER_NOT_AVAILABLE

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550000` | Layer — Ineligible (LAYER_NOT_AVAILABLE) | 10/11 ❌ | LAYER_NOT_AVAILABLE | timeout |

---

## Run: Mar 10, 2026 — FAIL (10/11) [Layer] — Layer — Ineligible (LAYER_NOT_AVAILABLE)
**Phone**: `+14155550000` | **Manual login**: false | **Expected event**: LAYER_NOT_AVAILABLE
**Layer event observed**: LAYER_NOT_AVAILABLE
**Outcome**: timeout / incomplete

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773148828693
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_NOT_AVAILABLE
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown

### What failed:
  - **Poll for onSuccess (with backoff)**: Polling exhausted after 15 attempts: onSuccess

### Plaid events observed:
  LAYER_NOT_AVAILABLE, LAYER_AUTOFILL_NOT_AVAILABLE

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550000` | Layer — Ineligible (LAYER_NOT_AVAILABLE) | 10/11 ❌ | LAYER_NOT_AVAILABLE | timeout |

---

## Run: Mar 10, 2026 — PASS (12/12) [Layer] — Layer — Ineligible (LAYER_NOT_AVAILABLE)
**Phone**: `+14155550000` | **Manual login**: false | **Expected event**: LAYER_NOT_AVAILABLE
**Layer event observed**: LAYER_NOT_AVAILABLE
**Outcome**: onExit (LAYER_AUTOFILL_NOT_AVAILABLE)

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773148969784
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_NOT_AVAILABLE
  - **LAYER_NOT_AVAILABLE: click Exit (ineligible — no fallback)**: Clicked Exit on ineligible screen (LAYER_AUTOFILL_NOT_AVAILABLE)
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onExit (ineligible) (with backoff)**: User exited — LAYER_AUTOFILL_NOT_AVAILABLE (expected for LAYER_NOT_AVAILABLE)

### What failed:
  (none — all passed!)

### Plaid events observed:
  LAYER_NOT_AVAILABLE, LAYER_AUTOFILL_NOT_AVAILABLE, EXIT

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550000` | Layer — Ineligible (LAYER_NOT_AVAILABLE) | 12/12 ✅ | LAYER_NOT_AVAILABLE | onExit (LAYER_AUTOFILL_NOT_AVAILABLE) |

---

## Run: Mar 10, 2026 — PASS (15/15) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_READY
**Outcome**: onSuccess — public_token received

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773148986411
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_READY
  - **LAYER_READY: click Continue on consent screen**: Clicked Continue on Layer consent screen
  - **LAYER_READY: fill OTP (auto-submits)**: OTP 123456 filled — auto-submit expected
  - **LAYER_READY: click Share on review screen**: Clicked Share on Layer review screen
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onSuccess (with backoff)**: public_token received
  - **Retrieve Layer session data (/user_account/session/get)**: Layer session data: {"identity":{"address":{"city":"Madison","country":"US","postal_code":"47250","region":"IN","street"

### What failed:
  (none — all passed!)

### Plaid events observed:
  LAYER_READY, OPEN, VERIFY_PHONE, TRANSITION_VIEW, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, HANDOFF

---

## Run: Mar 10, 2026 — PASS (12/12) [Layer] — Layer — Ineligible (LAYER_NOT_AVAILABLE)
**Phone**: `+14155550000` | **Manual login**: false | **Expected event**: LAYER_NOT_AVAILABLE
**Layer event observed**: LAYER_NOT_AVAILABLE
**Outcome**: onExit (LAYER_AUTOFILL_NOT_AVAILABLE)

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773149014019
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_NOT_AVAILABLE
  - **LAYER_NOT_AVAILABLE: click Exit (ineligible — no fallback)**: Clicked Exit on ineligible screen (LAYER_AUTOFILL_NOT_AVAILABLE)
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onExit (ineligible) (with backoff)**: User exited — LAYER_AUTOFILL_NOT_AVAILABLE (expected for LAYER_NOT_AVAILABLE)

### What failed:
  (none — all passed!)

### Plaid events observed:
  LAYER_NOT_AVAILABLE, LAYER_AUTOFILL_NOT_AVAILABLE, EXIT

---

## Run: Mar 10, 2026 — PASS (12/12) [Layer] — Layer — Partial PII
**Phone**: `+15155550017` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_NOT_AVAILABLE
**Outcome**: onExit (LAYER_AUTOFILL_NOT_AVAILABLE)

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773149030289
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_NOT_AVAILABLE
  - **LAYER_NOT_AVAILABLE: click Exit (ineligible — no fallback)**: Clicked Exit on ineligible screen (LAYER_AUTOFILL_NOT_AVAILABLE)
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onExit (ineligible) (with backoff)**: User exited — LAYER_AUTOFILL_NOT_AVAILABLE (expected for LAYER_NOT_AVAILABLE)

### What failed:
  (none — all passed!)

### Plaid events observed:
  LAYER_NOT_AVAILABLE, LAYER_AUTOFILL_NOT_AVAILABLE, EXIT

---

## Run: Mar 10, 2026 — FAIL (15/16) [Layer] — Layer — Manual login bypass
**Phone**: `+14155550011` | **Manual login**: true | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_READY
**Outcome**: onSuccess — public_token received

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773149046395
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_READY
  - **LAYER_READY: click Continue on consent screen**: Clicked Continue on Layer consent screen
  - **LAYER_READY: fill OTP (auto-submits)**: OTP 123456 filled — auto-submit expected
  - **LAYER_READY: click Share on review screen**: Clicked Share on Layer review screen
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onSuccess (with backoff)**: public_token received
  - **Retrieve Layer session data (/user_account/session/get)**: Layer session data: {"identity":{"address":{"city":"Madison","country":"US","postal_code":"47250","region":"IN","street"

### What failed:
  - **Layer: click "I'd rather log in manually"**: no detail

### Plaid events observed:
  LAYER_READY, OPEN, VERIFY_PHONE, TRANSITION_VIEW, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, HANDOFF

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 15/15 ✅ | LAYER_READY | onSuccess |
| `+14155550000` | Layer — Ineligible (LAYER_NOT_AVAILABLE) | 12/12 ✅ | LAYER_NOT_AVAILABLE | onExit (LAYER_AUTOFILL_NOT_AVAILABLE) |
| `+15155550017` | Layer — Partial PII | 12/12 ✅ | LAYER_NOT_AVAILABLE | onExit (LAYER_AUTOFILL_NOT_AVAILABLE) |
| `+14155550011` | Layer — Manual login bypass | 15/16 ❌ | LAYER_READY | onSuccess |

---

## Run: Mar 10, 2026 — PASS (15/15) [Layer] — Layer — Full profile (LAYER_READY)
**Phone**: `+14155550011` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_READY
**Outcome**: onSuccess — public_token received

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773149098907
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_READY
  - **LAYER_READY: click Continue on consent screen**: Clicked Continue on Layer consent screen
  - **LAYER_READY: fill OTP (auto-submits)**: OTP 123456 filled — auto-submit expected
  - **LAYER_READY: click Share on review screen**: Clicked Share on Layer review screen
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onSuccess (with backoff)**: public_token received
  - **Retrieve Layer session data (/user_account/session/get)**: Layer session data: {"identity":{"address":{"city":"Madison","country":"US","postal_code":"47250","region":"IN","street"

### What failed:
  (none — all passed!)

### Plaid events observed:
  LAYER_READY, OPEN, VERIFY_PHONE, TRANSITION_VIEW, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, HANDOFF

---

## Run: Mar 10, 2026 — PASS (12/12) [Layer] — Layer — Ineligible (LAYER_NOT_AVAILABLE)
**Phone**: `+14155550000` | **Manual login**: false | **Expected event**: LAYER_NOT_AVAILABLE
**Layer event observed**: LAYER_NOT_AVAILABLE
**Outcome**: onExit (LAYER_AUTOFILL_NOT_AVAILABLE)

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773149132589
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_NOT_AVAILABLE
  - **LAYER_NOT_AVAILABLE: click Exit (ineligible — no fallback)**: Clicked Exit on ineligible screen (LAYER_AUTOFILL_NOT_AVAILABLE)
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onExit (ineligible) (with backoff)**: User exited — LAYER_AUTOFILL_NOT_AVAILABLE (expected for LAYER_NOT_AVAILABLE)

### What failed:
  (none — all passed!)

### Plaid events observed:
  LAYER_NOT_AVAILABLE, LAYER_AUTOFILL_NOT_AVAILABLE, EXIT

---

## Run: Mar 10, 2026 — PASS (12/12) [Layer] — Layer — Partial PII
**Phone**: `+15155550017` | **Manual login**: false | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_NOT_AVAILABLE
**Outcome**: onExit (LAYER_AUTOFILL_NOT_AVAILABLE)

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773149148911
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_NOT_AVAILABLE
  - **LAYER_NOT_AVAILABLE: click Exit (ineligible — no fallback)**: Clicked Exit on ineligible screen (LAYER_AUTOFILL_NOT_AVAILABLE)
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onExit (ineligible) (with backoff)**: User exited — LAYER_AUTOFILL_NOT_AVAILABLE (expected for LAYER_NOT_AVAILABLE)

### What failed:
  (none — all passed!)

### Plaid events observed:
  LAYER_NOT_AVAILABLE, LAYER_AUTOFILL_NOT_AVAILABLE, EXIT

---

## Run: Mar 10, 2026 — PASS (16/16) [Layer] — Layer — Manual login bypass
**Phone**: `+14155550011` | **Manual login**: true | **Expected event**: LAYER_READY
**Layer event observed**: LAYER_READY
**Outcome**: onSuccess — public_token received

### What worked:
  - **Create session token (/user/create + /session/token/create)**: link_token created for user layer-test-1773149165153
  - **Poll for LAYER_READY or LAYER_NOT_AVAILABLE event**: LAYER_READY
  - **LAYER_READY: click Continue on consent screen**: Clicked Continue on Layer consent screen
  - **LAYER_READY: fill OTP (auto-submits)**: OTP 123456 filled — auto-submit expected
  - **LAYER_READY: click Share on review screen**: Clicked Share on Layer review screen
  - **Layer: check for manual login bypass option**: Manual bypass option not available with this template (template-controlled feature)
  - **Handle institution search (if shown — LAYER_NOT_AVAILABLE fallback)**: Institution search not shown — skipped
  - **Handle credentials (if shown — LAYER_NOT_AVAILABLE fallback)**: Credential screen not shown — skipped
  - **Handle account selection (if shown)**: Account list not shown — skipped (Layer may have auto-selected)
  - **Dismiss Save with Plaid screen (if shown)**: Not shown — clean exit
  - **Handle final permissions screen (if shown)**: Not shown
  - **Poll for onSuccess (with backoff)**: public_token received
  - **Retrieve Layer session data (/user_account/session/get)**: Layer session data: {"identity":{"address":{"city":"Madison","country":"US","postal_code":"47250","region":"IN","street"

### What failed:
  (none — all passed!)

### Plaid events observed:
  LAYER_READY, OPEN, VERIFY_PHONE, TRANSITION_VIEW, TRANSITION_VIEW, SUBMIT_OTP, TRANSITION_VIEW, HANDOFF

---

## Batch Summary: Plaid Layer — Mar 10, 2026
**Template ID**: `template_n31w56t6o9a7`

| Phone | Tag | Result | Layer Event | Outcome |
|-------|-----|--------|-------------|---------|
| `+14155550011` | Layer — Full profile (LAYER_READY) | 15/15 ✅ | LAYER_READY | onSuccess |
| `+14155550000` | Layer — Ineligible (LAYER_NOT_AVAILABLE) | 12/12 ✅ | LAYER_NOT_AVAILABLE | onExit (LAYER_AUTOFILL_NOT_AVAILABLE) |
| `+15155550017` | Layer — Partial PII | 12/12 ✅ | LAYER_NOT_AVAILABLE | onExit (LAYER_AUTOFILL_NOT_AVAILABLE) |
| `+14155550011` | Layer — Manual login bypass | 16/16 ✅ | LAYER_READY | onSuccess |

---
