# Plaid Link Pre-Link UI Design Skill
### Research-backed guidelines for building Plaid Link demo prototypes

---

## ⚡ FLOW TYPE DISAMBIGUATION — READ THIS FIRST

Before generating any pre-Link UI, identify which flow type applies. The design philosophy, copy rules, and component requirements are meaningfully different between the two.

| Signal in the prompt | Flow type to use |
|---|---|
| Lending, underwriting, loan approval, credit decision | **Credit-Specific** → [Part II](#part-ii-credit-specific-flows) |
| Buy now pay later (BNPL), second-look underwriting | **Credit-Specific** → [Part II](#part-ii-credit-specific-flows) |
| Repayment setup, loan repayment, credit card payment | **Credit-Specific** → [Part II](#part-ii-credit-specific-flows) |
| Account verification, identity verification, bank account linking | **Generic** → [Part I](#part-i-generic--account-verification-flows) |
| Payments, P2P transfers, sending/receiving money (e.g., Venmo-like) | **Generic** → [Part I](#part-i-generic--account-verification-flows) |
| Investment/trading/brokerage account funding (e.g., Coinbase, Webull-like) | **Generic** → [Part I](#part-i-generic--account-verification-flows) |
| Business banking, accounting software, cash flow management | **Generic** → [Part I](#part-i-generic--account-verification-flows) |
| Fuel/rewards/loyalty programs requiring bank linkage (e.g., GasBuddy-like) | **Generic** → [Part I](#part-i-generic--account-verification-flows) |

**When in doubt:** If the user is linking a bank account for a financial benefit that is NOT credit/lending (i.e., no underwriting, no credit decision, no repayment), use the Generic flow. If there is a credit decision, an offer that could change based on bank data, or a repayment setup, use the Credit-Specific flow.

---

## 🚫 SINGLE PRE-LINK SCREEN RULE (NON-NEGOTIABLE)

For any one Plaid Link launch event, build **exactly one** pre-Link explainer screen.

- Use one screen to communicate the use case + benefit + security reassurance.
- The next user action from that screen should launch Plaid Link immediately.
- Do **not** chain multiple pre-Link explanation screens back-to-back.

### Anti-pattern (do NOT do this)
- Screen A: "Add a bank account to improve your offer"
- Then Screen B: "Connect your bank account"
- Then Plaid Link launch

This duplicated pre-Link sequence adds friction and consistently hurts completion.

### Required structure
- Host flow steps (phone, OTP, personal details, bureau status, etc.)
- **One** pre-Link screen
- Plaid Link launch (`plaidPhase: "launch"`)

If any example in this document appears to suggest multiple consecutive pre-Link explainer screens,
the single-screen rule above is authoritative and must win.

---

## CRA API CONTRACT GUARDRAIL (for slide/API side-panel content)

This skill governs **UX/UI composition**. When a step includes API side-panel JSON, use AskBill-validated
field names and sequence from the Plaid technical skill/docs. Do not invent API structures from UI copy.

For CRA/Check flows, keep the sequence and payloads aligned to this contract:

1. `POST /user/create`
   - New integrations use `identity` (preferred).
   - Some legacy accounts still require `consumer_report_user_identity`.
   - Include required user identity fields expected by the account configuration.
2. `POST /link/token/create`
   - Use root `user_id` from `/user/create`.
   - Include CRA products (`cra_base_report`, optional `cra_income_insights`), `consumer_report_permissible_purpose`,
     and `cra_options.days_requested`.
3. `POST /cra/check_report/base_report/get`
   - Request by `user_id` (or `user_token` for legacy).
4. `POST /cra/check_report/income_insights/get`
   - Request by `user_id` (or `user_token` for legacy).

### Side-panel JSON rules
- API side panels should show **canonical top-level fields** for each endpoint.
- Do not nest Link token request config under synthetic wrapper keys (for example `config.user.client_user_id`)
  when representing `/link/token/create`; use canonical request field names.
- If uncertain, resolve with AskBill before finalizing slide JSON.

---

---

# PART I: Generic / Account Verification Flows

**Applies to:** Payments, P2P transfers, investment/brokerage funding, business banking, rewards programs, and any flow where a bank account is linked for access, identity, or feature enablement — but NOT for credit decisions.

**Philosophy:** This type of flow benefits from more education and transparency. Users may not know what Plaid is or why they're being asked for bank credentials. Preparation, reassurance, and clear value framing are the primary conversion drivers.

---

## I-1. Core Conversion Drivers

These six factors — in order of impact — determine whether a user completes Plaid Link in a generic flow:

**1. UX Pre-Link (most in your control)**
Messaging users the importance of linking, providing security context, explaining benefits vs. alternatives, and setting expectations for the Link flow are the biggest levers. A well-designed pre-Link screen can significantly lift conversion.

**2. Industry**
Investment and lending services see the highest conversion. Payments and PFM follow. Business services and casual-use apps tend to see lower baseline conversion.

**3. Use Case**
High-competition categories, fraud-risk use cases, and casual (non-need-based) use cases see lower conversion. If the user clearly needs to link to get something valuable, conversion is higher.

**4. Business Model**
If the user pays for the service (or will pay), conversion is higher. Free or optional flows require stronger persuasion.

**5. Plaid Product**
Transactions and Assets (10,000+ supported institutions) result in higher conversion. Auth (~3,500 institutions) can lead to slightly lower conversion due to institution availability.

**6. A/B Testing**
Every brand, use case, and user base is different. A/B testing pre-Link copy and design is essential to optimizing conversion over time.

---

## I-2. The Five Pre-Link Best Practices

Apply ALL five of these to any generic pre-Link screen.

### 1. Provide a Value Proposition

Tell the user clearly why linking their bank is worth doing. Lead with the benefit, not the mechanism.

- **Speed framing:** "Instant account funding," "instant access to funds," "get approved in seconds" (vs. slower alternatives like micro-deposits or manual entry)
- **Cost framing:** "Free to use" (vs. fees for debit/credit card transactions — relevant for payment apps)
- **Feature framing:** Place the bank link directly behind a meaningful product benefit — e.g., unlock a core feature, fund an account, get access to rewards. Users who link for a clear reason convert significantly better.

### 2. Prime the User

Avoid surprises. Tell users what the next screen will look like and what they'll be asked to do.

- Flows that open Plaid Link without warning — without telling the user they're about to enter their banking credentials — consistently show lower conversion
- A brief "heads up" screen, or a step indicator showing "next: link your bank," meaningfully reduces drop-off
- If the user will be entering login credentials for their bank, say so before they get there

Example priming language: "On the next screen, you'll be asked to enter your online banking credentials. This creates a secure bank connection in seconds."

### 3. Introduce Plaid (Generic flows only)

Unlike in credit flows, generic flows should explicitly name and introduce Plaid. Many users have never heard of it and need reassurance before entering credentials.

- Name Plaid as the secure connection layer: "We use Plaid to securely connect your bank account"
- Explain what Plaid does and does NOT do (it does not store credentials; your app only sees what you've permitted)
- Show the Plaid + your company logo together (co-branding) when users hit the Plaid consent screen

### 4. Highlight Security and Transparency

Security messaging directly impacts conversion in generic flows. Include at least one of the following:

- "256-bit encryption" — specific and credible
- "We never store your bank credentials" — addresses the #1 user fear
- Lock icon (🔒) near security statements
- "Your data belongs to you" — reinforces user control
- Social proof if applicable: "700 million+ bank transactions imported" or "[X] million users connected"

Transparency note: Tell users what specific data will be accessed and why. Example: "We'll read your account balance and transaction history to verify your account."

### 5. Good Design

Well-designed screens build curiosity, trust, and motivation to complete the flow.

- Use a **"Recommended" or "Preferred" tag** on the Plaid-powered option when multiple linking methods exist
- Position the Plaid option first in the list
- Use lightning bolt (⚡) icons to convey speed
- Lock icons (🔒) to convey security
- Make the primary CTA visually prominent and easy to find
- "Instant" is an effective word for the primary CTA in generic flows

### 6. Plaid Link launch CTA (host app — `data-testid="link-external-account-btn"`)

**Non-negotiable UX:** The button that opens Plaid Link is a **primary CTA**, not an icon poster.

- **Icon scale:** Any leading link/chain icon should read as an **inline affordance** next to the label (target **~18–24px**, similar to line-height), not a large hero graphic that dominates the button.
- **Pipeline contract:** The demo pipeline injects a **fixed-size stock Heroicons outline “link”** SVG for this button and adds layout CSS so flex parents cannot stretch it to fill the control. Do **not** replace it with custom merged paths, emoji, or oversized decorative SVGs.
- **Layout:** Do **not** wrap the icon in `flex: 1`, `flex-grow`, percentage-based heights, or full-height icon wells that force the glyph to scale with the button. Keep **label-forward** hierarchy: text is primary; icon supports it.
- If the build agent or human feedback changes this button, preserve **modest icon proportion** and the canonical `data-testid`.

---

## I-2b. Layer Share-Screen Field Rules (Use-Case Based)

When building mocked or real Layer confirmation/share screens, field selection must match the story use case.

### Screen 1 language rule (phone entry)
- The first host screen should frame phone capture as onboarding/signup/application start.
- Do not tell users this step is an eligibility check.
- Keep eligibility determination behind the scenes and out of primary user copy.

### Account verification / pay-by-bank / account linking
- Show: Name, phone, address, email (if available), bank account details.
- Do NOT include DOB or SSN by default.
- If DOB/SSN appear in this flow, only include them when explicitly required by the prompt or compliance narrative.

### Identity verification use cases
- Show: Name, address, phone, DOB, SSN (or SSN last4), plus email when used.
- In this flow, DOB + SSN are expected and should be visible in the share confirmation list.

### CRA / consumer report use cases
- Treat as strict identity flow for share fields.
- Show at minimum: Name, address, DOB, SSN (or SSN last4), phone, and email where required by account configuration.
- Bank account rows may be present when the story combines CRA with account-derived insights.

### General implementation rule
- Layer template requirements are the source of truth for which fields are required vs optional.
- Mock screens should represent that template intent accurately.
- If story type changes, update field list accordingly; do not reuse a one-size-fits-all share panel.

## I-3. Layout Patterns by Use Case

### Pattern A: Payment App (Venmo-style)

**Screen flow: payment method selection → bank add screen → Plaid consent → Link**

**Payment Method Selection Screen:**
- List of available payment methods (Venmo balance, credit card, bank/ACH)
- Bank/ACH option positioned visibly with a clear "Add" button or chevron
- The option can be labeled "Bank" with a small bank icon
- No fee shown (vs. fee shown for card options) — this is the value prop
- Tapping the bank option leads to an intermediate screen before launching Plaid

**Bank Add/Explain Screen (pre-Plaid):**
- Headline: Something like "Instant Bank Verification" or "Add a bank or card"
- Body copy explains: We use Plaid to verify your bank account info and periodically check the balance to ensure there's enough money for transactions
- Reference to privacy policy/terms
- "Next" CTA (full-width, brand color)
- Secondary option: "Verify bank manually" as a text link

**Plaid Consent Screen (Plaid-owned):**
- "[App] uses Plaid to connect your account"
- Two trust statements with checkmarks:
  - "Connect effortlessly — Plaid lets you securely connect your financial accounts in seconds"
  - "Your data belongs to you — Plaid doesn't sell personal info and will only use it with your permission"
- "Continue" CTA (full-width, dark/black button)
- By tapping Continue, user agrees to Plaid's End User Privacy Policy

---

### Pattern B: Investment / Trading App (Coinbase/Webull-style)

**Screen flow: settings/account → add payment method → method selection → Plaid Link**

**Account/Settings Screen:**
- Shows currently linked accounts with masked account numbers (e.g., "Ally Bank ··· 3762", "Chase ··· 8538")
- An "+ Add a payment method" row with an "Add" button
- Clear navigation to get there — this should not be buried

**Add Payment Method Selection Screen:**
- Title: "Add Account"
- "Bank Account" listed first with "Recommended" tag (teal/brand-colored badge)
- Supporting copy: "Use any bank account to make purchases and sales. Prices are locked in today and trades will process instantly."
- Alternative options below (Debit Card, PayPal) with their respective limitations noted
- The contrast between Plaid (recommended, instant) and alternatives (limited) does persuasive work here

**ACH Method Confirmation Screen:**
- Title: "Link Bank Account" or "Verify your bank account"
- Two verification options presented:
  - "Real-time Verification — Instantly verify account ownership" (Plaid)
  - "Micro-Deposit Verification — Verify in 1-2 business days"
- Include important caveats/notes for the user (e.g., only checking and savings supported, no credit cards)
- This transparency reduces support tickets and sets correct expectations

**Plaid Consent Screen (Plaid-owned, co-branded):**
- "[App] uses Plaid to link your bank"
- Trust statements:
  - "Secure — Transfer of your information is encrypted end-to-end"
  - "Private — Your credentials will never be made accessible to [App]"
- "Continue" CTA

**Key principles for investment flows:**
- Present ACH/Plaid as the free option and position it first
- Use lightning bolt (⚡) icons to communicate speed
- Call out that wire transfers incur fees — this makes the free Plaid option more attractive
- "Instantly" is an effective descriptor in this context

---

### Pattern C: Rewards / Value-Add Feature App (GasBuddy-style)

**Screen flow: feature discovery → onboarding → link explanation → link account screen → Plaid**

**Feature Discovery / Value Hook Screen:**
- Lead with the feature benefit, not the bank link requirement
- Example: "Saving Americans millions at the pump" — the value prop comes first
- Show the feature in use (e.g., gas savings, cashback) before asking for the bank link
- CTA: "Join for Free" or "Get Started" — commitment to the feature, not to linking

**Onboarding / Explain Screen:**
- After the user commits to the feature, explain what's needed
- Multi-step instructions that preview the entire process (e.g., step 1: add card, step 2: link bank, step 3: earn rewards)
- Important: outline ALL next steps here — users who are surprised mid-flow drop off
- "Continue" advances to the link screen

**Link Account Explanation Screen:**
- Title: "Link Account"
- Explain why linking is required for this specific feature: "When you pay at the pump, we withdraw the discounted price directly from your account"
- Explain what Plaid does: "Linking a checking account allows us to keep your card and billing info up to date"
- Two action paths:
  - "Link Account" — primary CTA (full-width, brand-colored button)
  - "Enter Account Manually" — secondary text link

**Plaid Consent Screen (Plaid-owned, co-branded):**
- "[App] uses Plaid to link your bank"
- Trust statements with checkmarks
- "Continue" CTA

**Key principles for value-add flows:**
- Always place the bank link BEHIND a clear feature/value reveal, not in front of it
- Users who see the benefit first are far more willing to complete the link
- Make the "why" obvious before asking for credentials

---

### Pattern D: Business Banking / Accounting (Wave-style)

**Screen flow: dashboard → single pre-link trust + value screen → Plaid**

**Single Pre-Link Trust + Value Screen:**
- Headline: "Connect your bank securely"
- Optional social proof line (for example: "700M+ bank transactions imported")
- Two trust bullets max:
  - "[App] never stores your bank credentials"
  - "Connections are read-only unless explicitly authorized"
- One concise priming line: "Next, you'll authenticate with your bank in Plaid."
- Primary CTA launches Plaid immediately (no second explainer screen)
- Optional secondary text link for manual path if the use case requires it

**Key principles for business flows:**
- Social proof is especially effective — B2B users respond to scale numbers
- The read-only / no-movement-of-funds clarification is critical for business owners who fear unauthorized transactions
- Show security commitments in the single pre-Link screen (not split across multiple pre-Link screens)

---

## I-4. Generic Flow UI/UX Rules

| Element | ✅ Do | ❌ Avoid |
|---------|-------|---------|
| Introducing Plaid | Name it explicitly, explain the role it plays | Hiding Plaid entirely (creates surprise) |
| Security copy | "256-bit encryption", "credentials never stored" | "Your data is safe" (too vague) |
| CTA label | "Add instantly", "Link Account", "Continue", "Join for Free" | No specific verb restrictions — match the context |
| Method ranking | Plaid/instant option first, tagged "Recommended" | Burying Plaid below manual options |
| Priming | Always explain the next step before it happens | Opening Plaid without any pre-screen |
| Value prop | Lead with feature or financial benefit | Starting with "We need your bank account" |
| Transparency | State what data is accessed and why | Vague references to "your information" |
| Social proof | Use scale numbers if available | Made-up or unverifiable claims |

---

---

# PART II: Credit-Specific Flows

**Applies to:** Personal lending, BNPL (buy now pay later), credit card products, second-look underwriting, repayment setup. Any flow where Plaid data is used for a credit decision, offer generation, or loan repayment.

**Philosophy:** This type of flow requires less education and more momentum. Users who reach a credit application pre-Link screen have already committed to the process. The design goal is forward motion — not explanation. Every extra word, every extra bullet, every extra screen is an opportunity to lose the user.

---

## II-1. Two Integration Options

There are two ways to hand off users to Plaid Link in a credit flow. The choice significantly impacts conversion.

### Option A: Embedded UX ✅ Strongly Recommended

**What it is:** Plaid's bank selection UI is embedded directly into your product screen. The user never leaves your page — they search for and select their bank right inside your pre-Link pane, and the Plaid flow continues inline.

**Visual layout of the Embedded UX screen:**
- Your app's header bar at top with your logo/brand name centered
- Bold heading (e.g., "Add a bank account") — the first thing users see
- Short subheader (1–2 lines) immediately below
- A search bar: "Search for your bank"
- 2-column grid of recognizable bank logo tiles (4–6 banks visible: e.g., Gingham Bank, H&T, Brocade, KilimCredit, iKAT, Twill Financial)
- At the bottom of the grid: "Manually connect" as a small muted text link
- Below that: Plaid wordmark + "What is Plaid Passport?" link (small, secondary)
- Full-width "Next" button anchored to the bottom (rounded, brand fill color — e.g., lavender/light purple)

**Why Embedded works better for credit:**
- Eliminates context switching at the moment of highest commitment
- Collapses the decision to "which bank?" instead of "how do I proceed?"
- Bank logos themselves establish trust — less persuasion copy is needed
- Significantly higher Plaid adoption than Standalone UX
- Requires minimal subheader copy because the visual UI does the trust-building

**Important constraint:** Embedded UX is NOT supported inside an `<iframe>`.

---

### Option B: Standalone UX

**What it is:** A custom pre-Link screen your team builds entirely. The user sees your screen, then taps a CTA to launch Plaid Link as a separate modal/flow.

**Visual layout of the Standalone UX screen:**
- Back-arrow/chevron (`<`) in the top-left for navigation
- Your logo/brand centered at top (small, subtle)
- Bold heading — the primary action statement
- Short subheader (1–3 lines)
- Two icon bullet rows (checkmark or shield icon on the left of each)
- Primary full-width CTA button with lock icon (e.g., "Add instantly 🔒")
- Secondary text link directly below (e.g., "Add manually instead")

**Use Standalone when:** Embedded UX is not possible due to technical or organizational constraints.

---

## II-2. Three Keys to Conversion in Credit Flows

### Key 1: Prime Users Before Plaid (Most Important)

The quality of your pre-Link screen is the single biggest driver of Plaid adoption. Users need to arrive at the Plaid UI already motivated and moving. See all component guidance below.

**Hard constraint:** Prime users with one pre-Link screen only. Do not create a second "connect/link" explainer screen after an "add bank/improve offer" screen.

### Key 2: Make Plaid the Primary (or Only) Option

- The Plaid-powered CTA must be the primary button — visually dominant, positioned first
- If a manual alternative exists, it must be a text link (no button, no border, muted color)
- Embedded UX with no visible alternative drives the highest adoption

### Key 3: A/B Test Continuously

- Every brand, use case, and user segment converts differently
- Test copy variants, especially the header and CTA label
- Respect the design constraints in this guide — don't test outside them

---

## II-3. Embedded UX — Detailed Component Guidelines

### Header

| Attribute | Guidance |
|---|---|
| **Job** | Trigger forward motion |
| **Verb** | `add` — always |
| **Avoid** | `connect`, `link`, `sync` — these feel technical |
| **Why "add"** | Familiar verbs reduce hesitation. Users know how to "add" things. |
| **Standard example** | "Add a bank account" |
| **Financial upside variant** | When the user has a direct financial incentive (better offer, higher loan amount), put it in the header: "Add a bank account to improve your offers" |
| **Rule** | Only include financial upside in the header if it directly changes the user's outcome. Otherwise, keep the header clean and action-only. |

### Subheader

| Attribute | Guidance |
|---|---|
| **Job** | Communicate value without slowing momentum |
| **Lead with** | The benefit the user will receive |
| **Do NOT** | Introduce or explain Plaid by name — trust is already established by the bank logos below |
| **Failure framing** | If not linking = no offer, say it explicitly |
| **Example** | "This enables you to securely verify your data through Plaid. We will use the account you add for loan repayment." |
| **Why** | Users prioritize outcomes. Once trust is established (by the bank logos), explanation slows them down. |

### Bank Selection Grid

- 4–6 recognizable institution logos in a 2-column grid
- Logos appear as rounded-rectangle tiles with the bank logo centered
- Search bar above the grid: "Search for your bank"
- Grid is scrollable for more options
- "Manually connect" as a small muted text link BELOW the grid — not a button

### Footer

- Plaid wordmark (small, lower area) for brand recognition
- "What is Plaid Passport?" link (small, muted) — lets curious users learn more without interrupting the primary flow

### CTA Button

- Label: **"Next"**
- Full-width, anchored to the bottom
- Rounded corners, brand fill color (lavender, brand blue, or brand primary)
- Activates after a bank is selected or advances to Plaid's search interface

---

## II-4. Standalone UX — Detailed Component Guidelines

### Core Principles

Plaid should feel like infrastructure, not a pitch. This screen is about **momentum**, not education.

1. **Action-first** — Lead with action, not explanation
2. **Familiarity** — The first verb must be `add`
3. **Financial upside** — Only in the header if it directly changes the user's outcome
4. **Value placement** — All other value props go in the subheader
5. **Brevity** — Fewer words always win

### Header

| Attribute | Guidance |
|---|---|
| **Verb** | `add` — always |
| **Avoid** | `connect`, `link` |
| **With financial upside** | "Add a bank account to improve your offers" |
| **Without financial upside** | "Add a bank account" |

### Subheader

| Attribute | Guidance |
|---|---|
| **Job** | Communicate value AND introduce Plaid as the secure mechanism |
| **Lead with** | What the user gets, not how Plaid works |
| **Name Plaid** | Yes — unlike Embedded, trust isn't auto-established here, so name Plaid explicitly |
| **Failure framing** | If not completing = no offer, say it |
| **Example** | "This enables you to securely verify your data through Plaid. We will use the account you add for loan repayment." |

### Icon Bullets

- **Maximum: 2 bullets** — more bullets reduce completion unless they add clear financial upside
- Each bullet: small icon on left (✓ checkmark or 🛡️ shield)
- **Bullet 1:** Speed-oriented — e.g., "Share your data and get qualified faster"
- **Bullet 2:** Security-oriented — e.g., "Secured by 256-bit encryption"
- One line each

### Primary CTA Button

| Attribute | Guidance |
|---|---|
| **Label** | "Add instantly" with 🔒 lock icon |
| **Why "instantly"** | Tested well in user research — signals speed at the exact moment of commitment |
| **Styling** | Full-width, filled, brand primary color (deep navy `#1A1A2E`, brand blue `#3D5AF1`), rounded corners |

### Secondary Option

- Label: **"Add manually instead"**
- Style: Plain text link, no button, no border, muted gray
- Position: Centered directly below the primary button
- Purpose: Escape hatch without competing visually with Plaid

---

## II-5. Credit Flow Real-World Examples

### Example 1: Personal Lender — Optional Bank Connection for Underwriting

**Context:** Bank linkage is optional but unlocks a higher loan amount.

- Header: "Add your bank account to enjoy benefits. You may get a **higher approved loan amount**."
- Body: Lists specific benefits — faster approval, no documents required, expedited loan funds
- Icon bullets: Speed-oriented, referencing financial benefit (e.g., "Faster loan application", "No documents required", "Expedited loan funds")
- Additional financial upside reinforced in a bullet
- Primary CTA: "Add bank" with a right-arrow icon
- Secondary: "Skip for now" — acknowledges optionality without equal weight

### Example 2: Buy Now Pay Later — Second Look Underwriting

**Context:** Linking a checking account is required to receive a BNPL offer.

- Header: "Add a checking account" (action-led, no fluff)
- Subheader: Explains the lender's connection and why the bank data is needed
- Two bullets: "Get qualified faster" + "Security share your data"
- Primary CTA: "Add with Plaid" (full-width, filled)
- Secondary: "Add manually with routing number"

### Example 3: Credit Card / Personal Lender — Repayment Setup

**Context:** User must choose how to set up repayment. Plaid is the recommended option.

- Headline: "Where should we transfer the money?"
- Two-option layout — Plaid option is labeled **"RECOMMENDED"** and positioned first
- Plaid option card:
  - Label: "Instant Connection"
  - Sub-label: "Add instantly to link your bank and agree to Biz Automation"
  - CTA inside card: "Add instantly" (full-width, brand green/teal button)
- Secondary text (not a button): "You can also connect manually by entering a routing and account number"

---

## II-6. Conversion Boosters (Credit Flows)

### Booster 1: Co-Brand Plaid Link with Your Logo

Adding your logo to Plaid's consent screen increases conversion by creating visual continuity and transferring trust from your brand to Plaid.

**Without co-branding:** User sees only the Plaid icon — no visual connection to your app.

**With co-branding:** Your logo appears as a badge overlaid on the Plaid icon in the top of the consent screen. Users see both brands together.

**Visual appearance of the co-branded Plaid consent screen:**
- Top: A combined icon — Plaid logo with your company logo badge in the bottom-right corner
- Headline: "Use Plaid Passport to help [Your Company] understand your finances"
- Phone number field (pre-filled if you pass it — see Booster 2)
- Consent text: "Instantly and securely share your financial accounts and info. Learn More"
- Terms: "Terms apply. By continuing you agree to Plaid's Privacy Policy."
- Primary CTA: "Continue" (full-width, filled black button)
- Secondary: "Continue as guest"

**How to implement:** Upload your company logo in the Plaid Dashboard under co-branding settings. Applies to both Embedded and Standalone UX.

---

### Booster 2: Pre-Pass the Consumer's Phone Number

Pass the user's phone number to Plaid at Link initialization so it pre-fills on the Plaid consent screen.

**Without pre-passing:** User sees an empty "Phone number" field and must type it.

**With pre-passing:** The field shows their number already (e.g., "+1 (337) 555-5040"). They just tap "Continue." The field remains editable.

**Why it works:** One less field = less friction = more completions.

**Implementation:** Pass the phone number via the `user` object during Plaid Link token creation.

---

## II-7. Post-Link Guidance (Credit Flows)

### Embedded UX Post-Link

Plaid's Embedded UX handles the success state automatically — no custom success screen needed.

**What Plaid shows automatically:**
- Bank icon with the connected bank's name + "Connected" status displayed in the embedded module area
- The pane updates in-place — no page navigation

**What you build:**
- A "Next" button (or equivalent) to advance the user to the next step in your flow
- Optional: Update your pane header to "Account successfully added" to reinforce the success state

**Visual layout of Embedded post-link success state:**
- Your app header bar (with logo) at top
- Your header text (e.g., "Add your primary bank account")
- Your subheader (e.g., "We will use this to confirm your eligibility and set up repayment.")
- Inside the Plaid embedded module: Plaid wordmark at top, then large circular bank icon (bank logo in a blue circle) centered, with "Gingham Bank" and "**Connected**" below it
- Full-width "Next" button at the bottom

---

### Standalone UX Post-Link

Plaid does NOT auto-generate a post-link success screen for Standalone. You must build all three of the following:

**1. Success Message**
- Display a confirmation screen in your app
- Include a success icon (✓ checkmark in a circle)
- Reference the specific bank and masked account number
- Example: "Your Gingham (··1234) account has been successfully connected"
- Subtext: Next-step prompt (e.g., "Continue to view your offers")
- Primary CTA: Action button advancing the user (e.g., "View offers" — full-width, brand color)

**2. Next Steps Communication**
- Explicitly state what happens after account linkage
- Example: "We'll review your linked account and notify you of your offers within minutes"
- Reduces anxiety and abandonment after the link step

**3. Account Management**
- Let users view, manage, and remove linked accounts in settings
- Provides long-term trust and a sense of control

---

## II-8. Credit Flow Copywriting Quick Reference

| Element | ✅ Do | ❌ Avoid |
|---|---|---|
| Header verb | `add` | `connect`, `link`, `sync`, `share` |
| Header content | Action + financial upside if applicable | Explaining Plaid, describing the process |
| Subheader | Benefit → Plaid as secure mechanism | Starting with "Plaid is..." |
| CTA primary | "Add instantly 🔒" | "Connect with Plaid", "Link account", "Continue" |
| CTA secondary | "Add manually instead" | "Skip", "Cancel", "Not now" (too dismissive) |
| Speed bullet | "Get qualified faster" | "Instant access to your data" |
| Security bullet | "Secured by 256-bit encryption" | "Your data is safe" (too vague) |
| Financial upside | State explicitly in header if it changes the offer | Bury in subheader or bullets |
| Failure framing | "Without adding a bank, you won't receive an offer" | Vague or implied consequences |
| Number of bullets | 2 max | 3+ (reduces completion) |

---

---

## Shared Design System Reference

These values apply to both Generic and Credit-Specific flows.

### Colors

| Element | Suggested Value |
|---|---|
| Primary CTA (dark) | `#1A1A2E` deep navy, or brand primary |
| Primary CTA (brand blue) | `#3D5AF1` or `#4B5FD9` |
| Primary CTA (payment/green) | `#1DB954` for payment/repayment-adjacent flows |
| Plaid embedded module border | `#E8E8E8` light gray, 1px |
| Bank tile background | `#FFFFFF` with `#E8E8E8` border |
| "Manually connect" / secondary link | `#9B9B9B` muted gray |
| Body text | `#333333` dark gray |
| Subheader text | `#666666` medium gray |
| Success state accent | `#0070F3` brand blue or `#27AE60` green |

### Typography

| Element | Style |
|---|---|
| Main heading | Bold, 22–26pt, near-black |
| Subheader | Regular, 14–15pt, medium gray |
| Icon bullet text | Regular, 13–14pt, dark gray |
| CTA button label | Semibold, 16pt, white |
| Secondary link | Regular, 14pt, muted gray |
| Plaid footer / disclaimer | Regular, 11pt, light gray |

### Spacing

- Screen padding: 16–20px horizontal on each side
- Header → subheader gap: 8px
- Subheader → first content element: 16–20px
- Between icon bullets: 12px
- CTA button: full width, 52–56px height, 12px border radius
- Bank tile grid: 2 columns, 8px gap, 12px border radius per tile

---

## Prototype Checklists

### Generic / Account Verification Checklist

- [ ] Value proposition is stated before any ask for bank credentials
- [ ] User is primed for what the next step will look like before Plaid opens
- [ ] Plaid is introduced by name and its role is explained
- [ ] At least one security statement is present (256-bit, credentials not stored, or read-only)
- [ ] Plaid / bank linking option is positioned first and tagged "Recommended" or "Preferred" if competing options exist
- [ ] The CTA is visually dominant and labeled with an action verb
- [ ] If social proof is available, it is used (user count, transaction count, institution count)
- [ ] Co-branding is enabled so your logo appears in the Plaid consent screen

### Credit-Specific Checklist

- [ ] Exactly one pre-Link explainer screen exists before Plaid launch (never two consecutive pre-Link explainers)
- [ ] Header uses the verb "add" (not "connect" or "link")
- [ ] Header includes financial upside ONLY if it directly changes the user's outcome
- [ ] Subheader leads with user benefit (not a description of Plaid)
- [ ] If not linking = no offer, this is stated explicitly
- [ ] Embedded: Bank logo grid is visible and prominent above the fold
- [ ] Standalone: Exactly 2 icon bullets (one speed, one security)
- [ ] Primary CTA: "Add instantly 🔒" (Standalone) or "Next" (Embedded)
- [ ] Secondary option is a text link only — no button, no border
- [ ] Co-branding enabled (your logo in Plaid consent screen)
- [ ] Phone number pre-passed to Plaid if technically feasible
- [ ] Post-link success state is designed and confirms which account was linked
- [ ] Post-link screen communicates what happens next
- [ ] Account management exists or is referenced
