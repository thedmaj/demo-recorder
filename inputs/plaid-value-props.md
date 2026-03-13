# Plaid Demo Script — Value Propositions & Talking Points

Priority reference for demo script generation. These messages, proof points, and talk
tracks are pre-approved and should be used verbatim or closely adapted. Research from
AskBill and Glean supplements this document — it does NOT override it.

Scope: Auth (`auth/get`), Identity Match (`identity/match`), Signal (`signal/evaluate`)
Use cases: Account Funding · Instant Account Verification (IAV) · External Account Verification (EAV)

---

## Use Case Context

| Use Case | Description | Key APIs |
|----------|-------------|----------|
| **Account Funding** | Users fund wallets, investment accounts, or new bank accounts via ACH. Need instant verification and risk assessment. | Auth, Identity Match, Signal |
| **Instant Account Verification (IAV)** | Replace multi-day micro-deposits with credential-based or database verification in seconds. | Auth (Instant + Database), Identity Match |
| **External Account Verification (EAV)** | Securely attach external bank accounts for pay-ins and payouts. Need ownership verification and return-risk scoring. | Auth, Identity Match, Signal |

---

## Combined Value Story (Auth + Identity Match + Signal)

### Elevator pitch (use one of these to open or close the demo)

- **"Instant account verification that turns account funding into a growth engine."**
- **"Link and fund in seconds, not days."**
- **"Reduce reliance on micro-deposits while tightening fraud controls."**
- **"Best-in-class coverage and network-powered risk."**

### Proof points (use these with specific numbers — do not round or generalize)

- ~**65% uplift in conversion** vs micro-deposits (typical benchmark)
- **95%+ of U.S. depository accounts** (10,000+ FIs) via Plaid
- **~23% increase** in successful verifications when moving from aggregator/database mix to Plaid IAV
- **20%+ more accounts funded at origination** and **3–4x higher average funding amounts** when leading with Plaid for account funding

### Full combined talk track (use or adapt for the demo closing)

> "We use Plaid Instant Auth to instantly authenticate the external bank account and retrieve the ACH rails directly from the source of truth at the bank—no manual entry, no multi-day micro-deposits. In the same flow, Identity Match compares your KYC data to the bank's identity data and returns match scores for name, address, phone, and email, so you can be confident the person funding the account actually owns that account. Before you release funds, Signal evaluates ACH return risk using network-level and cash-flow signals, so you can safely offer instant or accelerated availability to low-risk users and route high-risk transactions to slower rails or additional checks."

---

## Auth API (`auth/get`)

### Value propositions

| Value Statement | Problem Solved |
|-----------------|----------------|
| Instantly retrieve account and routing numbers | Eliminates manual entry, errors, and delays |
| Multiple verification modes (Instant, Micro-deposit, Database) | Maximizes coverage; handles users who cannot or will not log into their FI |
| Flexible use for funding, payouts, and pay-by-bank | Single integration for many use cases |
| Reduced risk of payment returns | Verifies account can accept ACH |
| Seamless developer integration | Turnkey, privacy-conscious UX in a single session |

### Approved sales phrases

- "Use Link to connect to your users' financial accounts. Instantly retrieve account and routing numbers when users connect their checking or savings accounts."
- "98% of bank account linking flows through our instant authentication methods—users select their bank and use credentials or biometrics to connect."
- "Database Auth is embedded in Plaid Link, provides instant verification results, and verifies account ownership with enhanced risk attributes—supporting Identity Match and Signal."
- "98%+ of U.S. depository accounts, including long-tail fintechs—often 3–4x the coverage of traditional database solutions."

### Gong talking points

- "Auth is grabbing that account and routing number."
- "For account funding, Auth pulls valid account and routing numbers directly from the FI so you can actually move money via ACH."
- "Instant account verification removes micro-deposits and manual verification, and ideally removes friction or fraud points."
- "We typically see around 65% uplift in conversion from micro deposit verification"
- "We see North of 20% conversion with compared against other aggregators"
- "Signal can reduce ACH return losses by over 40%"

---

## Identity Match API (`identity/match`)

### Value propositions

| Value Statement | Problem Solved |
|-----------------|----------------|
| Verify the person linking the bank account is the account owner | Reduces fraud and account takeover |
| Streamline KYC/compliance | Account-level verification satisfies ownership and regulatory needs |
| Improve UX with fuzzy matching | Keeps good users in the flow (e.g., "Andy" vs "Andrew") |
| Actionable match breakdown | Granular scores per attribute for tuning and decisioning |
| Works with Auth (including micro-deposit and database) | ~30% of manual-entry Items eligible for Identity Match |

### Approved sales phrases

- "Verify bank account ownership to supplement anti-fraud initiatives—Plaid's Identity Match automatically checks ownership without additional PII."
- "Identity Match typically increases match/pass rates by 20–30% vs in-house or legacy matching allowing more good users to stay on the happy path to onboarding and funding their accounts."
- "Outsource matching to Plaid so you can focus on a great consumer experience."
- "No one else in the market can do what Plaid does when it comes to marrying KYC data with bank identity data at the funding source."

### Gong talking points

- "Identity Match keeps good users in the flow—they don't fall out and have to call the call center because of nuances in address or name."
- "Identity Match verifies that the person linking the bank account is actually the account owner—we give you back a score."
- "We can match first name, last name, and email from signup to account ownership from the bank—prevent trial abuse by ensuring one ACH-verified identity per free trial."

### Score thresholds and interpretation (use in demo decisioning logic)

| Score range | Verdict | Meaning |
|-------------|---------|---------|
| **0–69** | Fail | No match — flag for review or block |
| **70–100** | Pass | Match — covers maiden name and middle name changes |
| **90+** | Pass | Includes nickname matches and names with Spanish roots |
| **95+** | Pass | Likely minor mismatches or common name variations |
| **99** | Pass | High string match; normalization and initials handled |
| **100** | Pass | Exact match |

Per-field scores are returned for: **name, address, city, state/zip, phone, email**. Each is scored independently — a low email score does not block approval if name/address/phone are strong.

### Reference data scenario (use for demo data and narration)

The canonical example to reference or adapt in demos:

| Field | Bank data | KYC data on file | ID Match score |
|-------|-----------|-----------------|----------------|
| Name | Alberta Bobbeth Charleson | Berta Charleson | 80 |
| Address | 2992 Cameron Road | 2992 Cameron Rd. Unit B | 90 |
| City | Malakoff | Malakoff | 90 |
| State/Zip | NY 14236 | New York 14236 | 80 |
| Phone | 1112223333 | +1(111)222-3333 | 80 |
| Email | accountholder0@example.com | bcharleson@mailnator.com | 0 |

Key demo insight: despite the email mismatch (score 0), all other fields pass — Identity Match surfaces this nuance so you can make a confident approval decision rather than blocking the user.

### Core value statements (use verbatim in demo narration or insight screens)

- "Ensure your customer is the true owner of the external bank account."
- "Reconcile PII in your system with the identity on file at the external financial institution."
- "Use external bank identity data plus identity matching scores to support decisions."
- "Identity Match improves match rates by 20–30% compared to legacy aggregators or in-house matching."

---

## Signal Evaluate API (`signal/evaluate`)

### Value propositions

| Value Statement | Problem Solved |
|-----------------|----------------|
| Real-time ACH risk assessment | Near-instant risk decisioning in funding flows (median ~1s, p95 <2s) |
| ML-based return predictions | Uses 1,000+ risk factors; predicts bank- and customer-initiated returns |
| Customizable risk controls | Tune thresholds and rules via dashboard; no code changes required |
| Rich risk signals (80+ attributes) | Beyond balance: tenure, connection history, NSF history, etc. |
| Reduced losses and higher approvals | Lower ACH returns and fraud; fewer false declines |

### Approved sales phrases

- "Signal delivers a network-powered risk assessment by analyzing behavior of the consumer's linked account across Plaid's network—over 80 actionable risk insights."
- "Configure risk score thresholds and deploy ACCEPT/REVIEW/REJECT/REROUTE actions from a single dashboard."
- "Use Signal with Balance: Balance for funds at initiation, Signal to minimize ACH return loss across the settlement window."
- "Confidently offer near-instant funding for low-risk transactions, backed by deep financial insights and Plaid's account verification tools."

### Gong talking points

- "Plaid Signal turns over 1,000 behavioral and identity signals into actionable outcomes."
- "Account funding is the perfect Signal use case—you call Signal when a user is crediting their account to decide whether to release funds instantly or step them up."
- "The value of Signal goes beyond initial account funding—call it again before another transfer from an external account."
- "Signal helps evaluate likelihood of transaction returns like unauthorized or NSF returns, with network attributes you don't get from a basic balance check."

### Proof point: Robinhood

- **Robinhood**: Using Signal for instant funding drove **$100M+ more deposited annually** and **~1.5% increase in instant funding** while managing ACH risk.

---

## Salesforce Pain Points (map to demo steps)

**Auth / Account Verification pain:**
- Micro-deposit flows / clunky ACH onboarding
- Manual data entry; people get account/routing numbers wrong
- Penny tests, delays in onboarding

**Identity pain:**
- Fraud: bad actors connecting accounts not theirs
- Valid bank accounts submitted by non-owners
- Fraud and insufficient funds for ACH

**Signal / Funding pain:**
- Bring funds from bank account with least friction
- Low conversion and UX issues on funding flows
- Finance team wants to move away from checks

---

## Reusable Narration Paragraphs

### Demo opening

> "Today we'll walk through how Plaid powers account funding and instant account verification. We'll connect a bank account in seconds, verify that the person linking owns that account, and evaluate ACH return risk before releasing funds—all in one integrated flow."

### Auth step

> "With Auth, we retrieve account and routing numbers directly from the bank. Users connect via Plaid Link using credentials or OAuth—no typing, no micro-deposits. That gives you 95%+ coverage of U.S. depository accounts."

### Identity Match step

> "Before we move money, we verify ownership. Identity Match compares your KYC data—name, email, phone, address—to what's on file at the bank. We return scores per attribute, so you can approve, review, or block. It handles nicknames and typos and typically improves pass rates by 20–30% over legacy matching."

### Signal step

> "Signal evaluates ACH return risk in real time—bank-initiated returns like NSF and closed accounts, and customer-initiated returns like unauthorized disputes. It uses 1,000+ risk factors and 80+ attributes. You get ACCEPT, REVIEW, or REROUTE recommendations, so you can offer instant funding for low-risk users and step up high-risk ones."

### Demo closing

> "Auth gives you verified account numbers instantly, Identity Match confirms ownership for more good users, and Signal assesses return risk - all using the Power of Plaid's network. Together, that's instant account verification with strong fraud controls—link and fund in seconds instead of days, with lower returns and higher conversion."
