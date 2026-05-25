# Plaid Transactions — Pitch Deck

> **A complete design brief for rebuilding this 23-slide pitch deck in Claude Code.**
> 1920×1080 slide deck, dark-base with selective light/holo accents, built as static HTML using a slide-stage web component. The deck pitches Plaid Transactions as the AI foundation behind intelligent finance.

> ## Pipeline addendum (demo-recorder builds)
>
> **Inside the demo-recorder pipeline, the canvas is 1280×800 (16:10 responsive), not 1920×1080.** Tokens (`--type-title`, `--plaid-*`) and T1–T11 templates port directly to pipeline slide steps; only the canvas scale differs. The pipeline's [`pipeline-slide-contract.css`](../pipeline-slide-contract.css) owns canvas sizing + cascade, with no `!important` arms race. Do NOT bake fixed 1920×1080 pixel positions into pipeline slide HTML — they will overflow at the 1280×800 recorded canvas.

---

## 0. What you are building

A 23-slide HTML deck at `deck.html` that uses a custom `<deck-stage>` web component (provided as `deck-stage.js`) to scale slides to any viewport, handle keyboard nav, and render speaker notes. Each slide is a direct child `<section>` of `<deck-stage>`. The deck is purely static HTML — **no React, no build step**. Slides are styled with CSS custom properties and inline styles; layouts use flex + grid with `gap`.

**Output structure:**

```
deck.html                          ← main file
deck-stage.js                      ← slide-stage web component (provided)
colors_and_type.css                ← design tokens (provided)
fonts/                             ← Plaid Sans + Bowery Street .otf files (provided)
assets/logos/
  plaid-horizontal-white.png
  plaid-horizontal-dark.png
assets/textures/                   ← (optional holo gradients — we use CSS instead)
```

**Critical viewport contract:** every slide is authored at 1920×1080. The `<deck-stage>` component scales to fit. Do not use vw/vh units inside slides; use px.

---

## 1. Design system tokens

### 1.1 Fonts

```css
--font-display: "Bowery Street", "Times New Roman", Georgia, serif;
--font-sans:    "Plaid Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono:    "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
```

- **Bowery Street** (serif) — display/headline accents only. Used for hero numbers, "intelligent finance" italicized phrases, and section starters. Available weights: Thin (100), Light (300), Regular (400), Medium (500), Bold (700), each with italic. The deck uses 400 italic and 500 regular heavily.
- **Plaid Sans** — all body and most headlines. Weights 300, 400, 500, 600, 700.
- **SF Mono / JetBrains Mono** — code, raw bank strings, eyebrow labels, JSON fragments.

### 1.2 Color palette

```css
/* Core neutrals */
--plaid-black:   #111112;
--plaid-white:   #FFFFFF;
--gray-50:       #F9F9F9;
--gray-100:      #F2F2F2;

/* Brand blues + mint */
--plaid-ink-900:  #022544;   /* deepest navy — primary dark background */
--plaid-ink-800:  #043C65;
--plaid-blue-700: #07578D;
--plaid-blue-600: #0B7BBC;   /* signature Plaid blue */
--plaid-blue-500: #3A80E2;
--plaid-blue-400: #5FA8E2;
--plaid-teal-600: #05565C;
--plaid-teal-500: #42F0CD;   /* fresh mint — accent / "after / Plaid" color */
--plaid-teal-400: #71FBE3;

/* Holograph pastels — soft, used for title + closing slides */
--holo-lilac:       #E6E6FF;
--holo-mint:        #D8FEF3;
--holo-buttercream: #FFF6D8;
--holo-pink:        #FFC0FF;
--holo-periwinkle:  #98A5FF;
```

### 1.3 Type & spacing scale

```css
:root {
  --type-mega:     180px;   /* hero numbers (rare) */
  --type-display:  110px;   /* title cover, section starters */
  --type-title:    72px;    /* slide titles (default; some go larger) */
  --type-subtitle: 48px;    /* large body / accent */
  --type-body:     30px;    /* slide body */
  --type-small:    24px;    /* secondary body / captions */
  --type-meta:     24px;    /* eyebrow / metadata (24px minimum) */
  --type-mono:     26px;    /* code blocks */
  --type-mono-sm:  22px;

  --pad-top:    100px;
  --pad-bottom: 88px;
  --pad-x:      120px;
}
```

**Type hard rules (projection-safe):**
- Body text minimum: 24px
- Eyebrow / mono labels minimum: 24px (the only exception is decorative UI mockup chrome like avatar letters or "VERY_HIGH" confidence pills, which are intentionally small to mimic real product UI)
- Slide titles: 64–84px
- Hero numbers: 140–200px Bowery Street, weight 500, letter-spacing -0.02 to -0.03em

### 1.4 Background variants (slide classes)

Each `<section>` gets one of:
- **Default (no class)** — dark navy (`--plaid-ink-900`) base, white text. This is the dominant treatment.
- **`.light`** — pure white background, dark text. Used for Klover proof slide.
- **`.cream`** — `#F4F0E6` background, dark text. Used for Layla phone mockup slide for warmth.
- **`.holo`** — soft holograph gradient. Used for slides 1 (title), 20 (Why now), 23 (Next steps).

```css
section.holo {
  color: var(--plaid-ink-900);
  background:
    radial-gradient(1200px 700px at 12% 18%, rgba(152,165,255,0.55), transparent 60%),
    radial-gradient(1100px 800px at 88% 82%, rgba(255,192,255,0.45), transparent 55%),
    radial-gradient(900px 600px at 78% 14%, rgba(255,246,216,0.55), transparent 60%),
    radial-gradient(900px 700px at 18% 82%, rgba(216,254,243,0.55), transparent 55%),
    linear-gradient(135deg, #E6E6FF 0%, #D8FEF3 50%, #FFF6D8 100%);
}
```

---

## 2. Visual system (what makes the deck cohesive)

### 2.1 Reusable patterns

| Pattern | Where it's used | Visual notes |
|---|---|---|
| **Chrome logo top-right** | Every slide | Plaid horizontal logo, 28px tall, opacity 0.85. Positioned in the top margin, 75 px above the topmost text row: `top: calc(var(--pad-top) - 75px); right: var(--pad-x)` |
| **Eyebrow tag** | Most slides | `Section X — Section Name`, mono uppercase, 24px, teal on dark / blue on light, letter-spacing 0.18em |
| **Page-number footer** | All non-title slides | bottom:48px, mono "XX / 23 · Section name" — page count + section only, no source citations |
| **Slide title** | Top of every content slide | Plaid Sans 600, 64–84px, line-height 1.08, `<em>` accent in Bowery Street italic 400 (often mint) |
| **Mono eyebrow label** | Section markers inside cards | SF Mono, 18–24px, uppercase, teal, letter-spacing 0.14–0.16em |
| **Big numbered list (01, 02, 03)** | Section breakers, benefit cards | Bowery Street 500, 60–96px, mint-at-50%-opacity OR blue-600, line-height 0.95 |
| **Hero stat block** | "500M+", "+10%", "100M+" etc. | Bowery Street 500, 140–200px, mint or white, line-height 0.9, letter-spacing -0.03em |
| **Card** | Anywhere content needs containment | `background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:14–18px; padding:30–48px` |
| **Accent card (mint highlight)** | The "best" of a set | `background:linear-gradient(160deg, rgba(66,240,205,0.14), rgba(11,123,188,0.06)); border:1px solid rgba(66,240,205,0.3)` |

### 2.2 Bowery Street italic — the rhetorical accent

The serif italic is used **sparingly and intentionally** to punch a phrase inside a sans-serif headline. Pattern:

```html
<h2 class="h-title">
  From bank data to <em style="font-family:var(--font-display); font-weight:400; font-style:italic;">financial intelligence.</em>
</h2>
```

Common italicized phrases throughout the deck: *"for finance"*, *"actually act on"*, *"sharper insights"*, *"specific"*, *"really"*, *"converging"*, *"evolved with the model"*. Always reserve the italic for the most quotable noun phrase in a sentence.

### 2.3 Mint as a semantic color

`--plaid-teal-500` (#42F0CD) is the deck's "after / better / Plaid" color. Every before/after, every "with Plaid" treatment, every CTA highlight uses mint. Cool blues are the brand; mint is the action.

### 2.4 Mono fragments as evidence

The deck uses raw monospace bank strings ("PURCHASE WM SUPERCENTER #1700 POWAY CAUS", "Dd Doordash Burgerkin") as visual evidence. These are pulled directly from the Plaid docs and should be reproduced **verbatim**, including the weird capitalization. They are the single most quotable visual artifact in the deck.

---

## 3. Standard slide shell

Every slide follows this skeleton:

```html
<section data-label="NN Short label">
  <div class="frame">
    <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="" />
    <div class="eyebrow-tag" style="margin-top:24px;">Section X — Section Name</div>

    <h2 class="h-title">
      Headline with <em>italicized accent.</em>
    </h2>

    <!-- slide body here -->

    <div class="chrome-foot">
      <span>NN / 23 &nbsp;·&nbsp; Section name</span>
    </div>
  </div>
</section>
```

Where:

```css
.frame {
  width: 100%; height: 100%;
  box-sizing: border-box;
  padding: var(--pad-top) var(--pad-x) var(--pad-bottom);
  display: flex; flex-direction: column;
  position: relative;
}
.chrome-logo {
  position: absolute;
  top: 60px; left: 120px;
  height: 28px;
  opacity: 0.85;
}
.chrome-foot {
  position: absolute;
  bottom: 48px; left: 120px; right: 120px;
  display: flex; justify-content: space-between; align-items: baseline;
  font-family: var(--font-sans);
  font-size: 24px; font-weight: 500;
  color: rgba(255,255,255,0.45);
  letter-spacing: 0.04em;
}
.light .chrome-foot, .cream .chrome-foot, .holo .chrome-foot {
  color: rgba(2,37,68,0.55);
}
```

Light/cream/holo slides use `assets/logos/plaid-horizontal-dark.png` instead of white.

---

## 4. Section structure

The deck has 7 sections totaling 23 slides:

| Section | Slides | Theme |
|---|---|---|
| **1. The shift** | 1–3 | Why "recording transactions" is no longer enough |
| **2. Examples** | 4–6 | Three demos of what enrichment looks like |
| **3. The foundation** | 7–10 | Foundation model, architecture, data engine, customer benefits |
| **4. What you get today** | 11–13 | PFC v2 numbers, before/after, version flag |
| **5. Differentiators** | 14–18 | History, enrich, conversion, one-foundation, business |
| **6. Why now & what's next** | 19–21 | Roadmap, why-now, Klover proof |
| **7. Close** | 22–23 | Decision frame, next steps |

---

## 5. Slide-by-slide spec

### Slide 1 — Title (`.holo`)

- **Label:** `01 Title`
- **Background:** holo gradient
- **Logo:** dark horizontal logo top-right
- **Padding:** `padding-top: 140px`
- **Above headline:** mono text, 30px, color rgba(2,37,68,0.55):
  - `PURCHASE WM SUPERCENTER #1700 POWAY CAUS`
- **Headline:** Bowery Street 500, **140px**, max-width 1500px:
  - `From bank data` / `to <em>financial intelligence.</em>`
- **Subtitle:** Plaid Sans, 42px, color rgba(2,37,68,0.76):
  - `The AI foundation behind Plaid Transactions.`
- **Bottom-row split:** mono JSON fragment on left (26px), uppercase tracking-out label on right (24px) reading `Plaid · 2026 · Pitch deck`. JSON content:
  - `merchant_name: "Walmart"`
  - `store_number: "1700"`
  - `location.lat: 32.959068`

---

### Slide 2 — The shift

- **Label:** `02 The shift`
- **Eyebrow:** `Section 1 — The shift`
- **Headline:** `Recording transactions isn't enough anymore.`
- **Three-column body** (flex, gap 48px), each column:
  - Mono eyebrow (`01 — Apps`, `02 — Consumers`, `03 — Agents`), teal, 24px uppercase
  - Body paragraph 30px:
    - **Apps:** "Apps need to understand transactions well enough to *act* on them — approve a payment, set a credit limit, surface a real-time insight, flag a fraud event."
    - **Consumers:** "Consumers expect personalization grounded in their actual money movement — not generic advice that ignores how they spend."
    - **Agents:** "AI agents are moving money, blocking transactions, and making eligibility decisions. The cost of being wrong has gone up."
- **Timeline at bottom** (three nodes on a 2px track):
  - 1980–2000s → "Branches" (white dot)
  - 2010–2024 → "Apps" (blue dot, completed half)
  - 2025 → → "Agents · Intelligent finance" (mint dot, glow shadow `0 0 24px rgba(66,240,205,0.6)`)
  - Track is gradient from blue-500 to teal-500 across the first 66%

---

### Slide 3 — Why bolted-on AI isn't enough

- **Label:** `03 Bolted-on AI`
- **Headline:** `General-purpose LLMs don't speak bank.`
- **Two columns:**
  - **Left (flex 1.05):** "One string. Many meanings." mono label in teal, then four stacked mono boxes (each `background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); padding:18px 22px; border-radius:8px; font-size:24px`):
    - `SQ *COFFEE 12345 SAN FRA CA`
    - `SQUARE COFFEE 12345*`
    - `SQ Coffee #1 SF 4154...`
    - `PURCHASE SQ COFFEE BAR`
  - Then a horizontal rule with "resolves to →" label
  - Then a teal/blue gradient mono box: `merchant: "Square (Coffee Bar)"  ·  category: FOOD_AND_DRINK_COFFEE`
  - **Right (flex 0.95):** Three numbered points (01/02/03 mono in blue-400):
    1. "Bank descriptions appear in dozens of string variations — for the same merchant, the same charge."
    2. "The same string can mean different things depending on context and shifting institutional metadata."
    3. "Layering a general-purpose LLM on top doesn't fix the underlying ambiguity — it inherits it."
- **Takeaway box at bottom** (gradient blue → teal, 1px border, 16px radius, padding 36px 44px):
  - Subtitle 38px: "What's needed is a <em style="color:teal-500; font-style:normal; font-weight:600;">shared, scalable representation of financial activity</em> that works across institutions, products, and use cases."

---

### Slide 4 — Example 1: Walmart

- **Label:** `04 Walmart example`
- **Custom padding:** `padding:80px 100px 80px;`
- **Top bar:** white horizontal logo + mono label `Example 01 — Walmart`
- **Headline (64px):** "What looks like a string" (in white 55% opacity) / "is actually fifteen useful fields."
- **Two-panel body:**
  - **Left card** (`background:rgba(0,0,0,0.32); border-radius:14px; padding:40px`): mac-window dot row, "Raw bank string" mono label, then the bank string at **38px** mono:
    - `PURCHASE WM SUPERCENTER #1700 POWAY CAUS` (with "PURCHASE" and "#1700" muted)
  - **Center arrow column** (64px wide): "Enrich" pill + mint arrow SVG
  - **Right card** (white, dark text, flex 1.15): Walmart avatar (blue, "W"), name "Walmart", entity_id (mono 16px, muted), VERY_HIGH pill. Then a multi-line mono block (19px, line-height 1.7) showing:
    - merchant_name, website, logo_url, store_number, location object with all fields, payment_channel, personal_finance_category
- **Bottom strip:** sub 32px in white "One API call. <span teal>Fifteen useful fields.</span>" + right-aligned page number

---

### Slide 5 — Example 2: DoorDash × Burger King

- **Label:** `05 DoorDash example`
- **Custom padding:** same as slide 4
- **Top bar:** mono label `Example 02 — DoorDash × Burger King`
- **Headline (64px):** "…is actually" / "two relationships."
- **Two-panel body** (mirrors slide 4):
  - **Left:** raw mono `Dd Doordash` / `Burgerkin` at **54px**, plus a small "Is this DoorDash? / Is this Burger King? / It's both." caption with the last line in mint
  - **Right:** white card with two stacked mini-cards:
    - **Merchant card:** Burger King avatar (red), "Burger King", `type: merchant`, VERY_HIGH pill
    - **Counterparty card:** DoorDash avatar (red), "DoorDash", `type: marketplace`, VERY_HIGH pill
  - Below those: mono JSON snippet showing merchant_name, counterparties[0], personal_finance_category
  - Footer pill (holo gradient): "Unlocks rewards optimization, partnership intelligence, and granular spend analytics — the full payment path."
- **Bottom strip:** "Not the merchant, not the marketplace. <span teal>Both.</span>"

---

### Slide 6 — Layla (`.cream`)

- **Label:** `06 Layla example`
- **Custom padding:** `padding:80px 100px 80px;`
- **Top bar:** dark horizontal logo + mono label `Example 03 — Layla, gig worker`
- **Headline:** Bowery Street 500, **96px**, "Meet Layla." in plaid-ink-900
- **Subtitle (28px):** "Layla drives for DoorDash and Lyft. Two deposits land in her checking account each week."
- **Two phone mockups, centered:**
  - **Left phone — "Before, v1 categorization"** (dark navy screen, 360×560, 36px radius, 8px black border):
    - Status bar 9:41 / ●●●●
    - "This week / 2 deposits"
    - Two deposit cards (rgba white 6%): each shows "Other income" eyebrow + amount + mono `DD DOORDASH DEPOSIT` / `LYFT DRIVER PAY`
    - Bottom alert (red tint): "✕  No income forecast available"
  - **Center arrow column:** "With PFC v2" pill (light blue) + blue arrow
  - **Right phone — "After, AI-enhanced v2"** (white screen):
    - Same status bar
    - "This week / 2 gig deposits · forecast ready"
    - Two deposit cards using holo gradients (lilac→mint, mint→buttercream): each shows "Gig income · DoorDash" / "Gig income · Lyft" with bold amount + mono `GIG_INCOME_GIG_WORK`
    - Bottom success: "✓  Next payout est. $310 · Thu Aug 14"
- **Two captions below phones:**
  - "For an EWA provider — Forecast payouts, adjust advance limits responsibly, surface savings opportunities."
  - "For a PFM app — Automatic gig-income tracking, more accurate tax estimates, personalized insights."

---

### Slide 7 — Transaction Foundation Model

- **Label:** `07 Foundation model`
- **Headline (84px):** "We built the first transaction / foundation model <em>for finance.</em>"
- **Two-column body:**
  - **Left (flex 1.1):** three mono-eyebrow paragraphs:
    1. **Trained at network scale** — "On large-scale anonymized transaction data across the Plaid Network, using self-supervised learning."
    2. **Deeper transaction understanding** — "Merchant identity, payment context, and financial attributes — beyond the raw bank description."
    3. **Built on years of iteration** — "Plaid's enrichment pipeline laid the groundwork — moving from surface-level cleaning to deep financial reasoning."
  - **Right (flex 0.9):** giant mint number block in accent card:
    - **200px** Bowery Street: `500M+` (the `+` is sans 80px superscript)
    - 30px white sub: "transactions enriched <em>daily</em>"
    - 18px mono muted: "on the Plaid Network"

---

### Slide 8 — Architecture

- **Label:** `08 Architecture`
- **Custom padding:** `padding-top: 72px; padding-bottom: 64px;` (tight)
- **Headline (60px):** "One shared representation. <span muted>Five focused capabilities.</span>"
- **Architecture diagram (centered, full-width):**
  - **Top block (780px min-width):** gradient blue→teal background, "Core infrastructure" mono eyebrow, "Transaction Foundation Model" sans 600 40px, sub "Shared transaction representation, trained on the Plaid Network"
  - **Connecting SVG (1400×160):** vertical drop from top block, "lightweight adaptation ↓" label, horizontal spine at y=60, five vertical drops at x=140, 420, 700, 980, 1260 with arrow heads
  - **Bottom row of five capability cards** (1400px wide, gap 24px), each `background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.12); border-radius:14px; padding:24px 22px`:
    - **PFC v2** — Categories — "16 primary · 104 detailed"
    - **Business** — SMB Categories — "13 purpose-built (beta → GA)"
    - **Credit** — LendScore — "Cash flow underwriting"
    - **Lending** — EWA Score — "Earned wage access risk"
    - **Risk** — Protect · Signal — "Fraud · ACH risk decisioning"
- **Footer sub (26px):** "Turn on Transactions today, and every Plaid product gets smarter as the foundation does. <em>No re-integration.</em>"

---

### Slide 9 — Data engine

- **Label:** `09 Data engine`
- **Headline (64px):** "AI labels at network scale. / <span muted>Human-quality precision.</span>"
- **Three-step flow** (cards with arrow separators):
  1. **AI Annotator** — eyebrow "LLM-assisted labels" — "Generates labels across millions of anonymized transactions — at a fraction of the cost and time of manual review." Mini viz: stacked bars in blue/teal/white showing label distribution.
  2. **Human validation** — eyebrow "Golden datasets" — "Reviewers build golden datasets for benchmarking and spot-check edge cases where AI labels disagree." Mini viz: 40-square grid of teal dots with 2 pink "override" dots scattered + legend.
  3. **Iterate** — eyebrow "Loop tightens" — "The model retrains. New categories ship. Edge cases shrink. The data engine is the moat — not just the model." Mini viz: two SVG curves trending up from "v1.0" to "v2.x".
- Each card has the big 72px Bowery Street number (01/02/03) in teal at 40% opacity in the top-left corner.
- **Big stat callout below the three cards:**
  - 120px Bowery Street: `>95%` (with `%` at 60px)
  - 28px white sub: "human alignment on AI-generated labels — at a fraction of the cost and time of manual labeling."

---

### Slide 10 — What it means for you

- **Label:** `10 What it means for you`
- **Headline (72px):** "What it means <em>for you.</em>"
- **Subtitle (28px, muted):** "You didn't build the data engine. You don't pay to maintain it. You still get the upside."
- **Five horizontal cards** (gap 20px), each with:
  - 60px Bowery Street number (01–05) in mint at 50% opacity (card 03 uses solid mint to highlight it as strategic)
  - Mono eyebrow + sans 600 30px subheadline
  - 20px body paragraph
  - Mono caption at bottom (border-top divider)

  | # | Eyebrow | Subheadline | Body | Caption |
  |---|---|---|---|---|
  | 01 | Speed | Months, not years. | "New categories ship in a single release cycle. PFC v2's 12+ subcategories went from concept to production while in-house teams would still be scoping." | Gig Income · Overdraft Fee · Wire · Mortgage |
  | 02 | Cost | Zero training tax. | "Labeling pipelines, golden datasets, ongoing retrains — baked into Transactions. No separate line item, no internal headcount." | Pay per connected account · not per label |
  | 03 | Network | One fix → every customer. | "When one customer's feedback corrects an edge-case merchant or income stream, the fix lands for every Plaid customer on the next retrain." | You inherit improvements you didn't ask for |
  | 04 | Audit-ready | A benchmark behind every label. | "Golden datasets give your compliance, risk, and lending teams something defensible to point at — not a black-box AI categorization." | Lending · Fraud · ACH risk |
  | 05 | Compounding | Smarter at 12 months. | "The model you ship against today is measurably better in twelve months — without a migration, without an engineering project on your side." | Same integration · better outputs |

  Card 03 uses the accent style (`linear-gradient(160deg, rgba(66,240,205,0.14), rgba(11,123,188,0.06))` with teal border).

---

### Slide 11 — PFC v2 numbers

- **Label:** `11 PFC v2 numbers`
- **Headline (72px):** "Smarter categories. <span muted>Sharper insights.</span>"
- **Three big stat cards** (flex equal, gap 32px):

  | # | Eyebrow | Big number | Body | Caption |
  |---|---|---|---|---|
  | 1 | Primary categories | `+10%` (white, 200px) | "Higher accuracy on the 16 top-level personal finance categories." | vs PFC v1 baseline |
  | 2 | Detailed sub-categories | `+20%` (mint, 200px) — **accent card** | "Higher accuracy on 104 detailed sub-categories." | where the product unlocks live |
  | 3 | New subcategories | `12+` (white, 200px) | "Income types, repayments, disbursements, bank fees, transfers." | shipped Dec 2025, expanding |

- **Footer sub (26px, muted):** "Trained with AI-assisted label generation and targeted human review — the same data engine you saw on the previous slide."

---

### Slide 12 — Before/after subcategories

- **Label:** `12 Subcategories before after`
- **Headline (64px):** "Cash flow you can actually <em>act on.</em>"
- **Four-row comparison table.** Each row:
  - Left column (flex 0.9): v1 generic name in mono 28px, white-6% background with dashed border, dim color
  - Center (width 80px): mint arrow "→"
  - Right column (flex 1.8): three v2 names as pills — first one in **solid mint background** (`#42F0CD`) with dark text and weight 600, others in soft mint (`#D8FEF3`) with dark text:

  | v1 | v2 |
  |---|---|
  | Other Income | **Gig Income** · Tax Refund · Interest Income |
  | Transfer | **Internal Transfer** · Wire Transfer · P2P Transfer |
  | Bank Fees | **Overdraft Fee** · ATM Fee · Foreign Transaction Fee |
  | Loan Payment | **Mortgage** · Student Loan · Auto Loan |

- **Footer takeaway** (mint left-border, soft mint background):
  - 26px: "Each row is a product unlock — EWA forecasting, PFM budgeting, tax estimates, lending insights — <em>immediately</em> better."

---

### Slide 13 — Versioning

- **Label:** `13 Versioning`
- **Headline (72px):** "Upgrade when you're ready. / <span muted>Never break what works.</span>"
- **Two-column body:**
  - **Left (flex 1.1):** "One flag." mono eyebrow, then a mock terminal/code block:
    - Background `#020F1E`, teal-25% border, 14px radius
    - "POST /transactions/sync" label top-right
    - Mac-window dots
    - Mono **30px** content (with syntax-colored quotes):
      ```
      {
        "personal_finance_category_version": "v2"
      }
      ```
    - Below: 18px mono "Same flag works on `/transactions/sync`, `/transactions/get`, and `/transactions/enrich`"
  - **Right (flex 1):** Three bullets with mint left-border:
    - **Existing customers** — "Opt in by setting `v2` on your next call. v1 keeps working — no migration."
    - **New customers (post Dec 2025)** — "Receive v2 by default. Zero config."
    - **Legacy v1** (white border instead of mint) — "Supported indefinitely. No forced cutover, no breaking changes."
- **Closer (30px):** "<em>Adopt AI</em> without taking a migration hit."

---

### Slide 14 — History depth (4× lookback)

- **Label:** `14 History`
- **Headline (78px):** "4× the lookback. / <span muted>Multiple syncs per day.</span>"
- **Body — two columns:**
  - **Left (flex 1.4) — bar chart:**
    - "Plaid Transactions" label + "You get this" mint pill
    - Full-width bar at 64px tall: gradient blue→teal, right-aligned text "730 days · up to 24 months" in dark
    - Below: mono caption "1–4 syncs/day · On-demand Refresh · SYNC_UPDATES_AVAILABLE webhook"
    - "Typical aggregators" label, opacity 0.78
    - Bar at 50px, only 24.6% filled (white-28%), text "180 days default"
    - Below: mono caption "Daily syncs · Limited or no real-time refresh"
    - Bottom axis: dashed border with 0d / 180d / 365d / 730d marks
  - **Right (flex 1) — sidebar card:**
    - Mono eyebrow "Practical use case"
    - Body 26px: "Underwriting models that need 12+ months of cash flow can run <em>today</em> — not after a six-month data accrual."
    - Bottom row: 76px Bowery Street mint "12+" + caption "months of cash flow, available on day one"

---

### Slide 15 — Enrichment moat

- **Label:** `15 Enrichment moat`
- **Headline (64px):** "The same intelligence — <em>on your own data, too.</em>"
- **Diagram (centered, full-width row):**
  - **Left column:** two source cards stacked:
    - Plaid-linked accounts (blue icon: bank columns SVG)
    - Your card / bank data (teal icon: card SVG)
  - **Connecting SVG paths** (mint, with arrowhead)
  - **Center engine block:** "Plaid" eyebrow + "Transaction Enrichment Engine" 32px + "500M+ txns/day · ML-powered" footer. Glow shadow.
  - **Arrow SVG** rightward
  - **Right card:** "Your app" with white star avatar + "consistent enrichment across all sources"
- **Bottom three-column strip** (border-top divider):
  - **Transactions** — "Enrichment baked into every Plaid-linked Item."
  - **Enrich** — "Send your non-Plaid transactions. Receive merchant, counterparty, category, location, logos."
  - **Consistent outputs** — "Same fields across in-house and Plaid-linked data. No reconciliation tax."

---

### Slide 16 — Conversion

- **Label:** `16 Conversion`
- **Headline (72px):** "Better data is only valuable / <span muted>on items that link.</span>"
- **Three big stat cards:**

  | # | Eyebrow | Big number | Body |
  |---|---|---|---|
  | 1 | Remember Me network | `100M+` (white 140px) | "profiles in the network — <em>up to +11%</em> conversion for returning users." |
  | 2 | Broken-link self-repair | `52%` (mint 140px) — **accent card** | "of broken links self-repair without user re-auth — your users never even know." |
  | 3 | Head-to-head | `#1` (white 140px) | "Industry-leading Link conversion across head-to-head tests with major aggregators." |

- **Flywheel strip below:** rounded card with mono text flowing horizontally (alternating mint and white):
  > More items linked → more transactions → richer training signal → better model → more items linked.

---

### Slide 17 — One foundation

- **Label:** `17 One foundation`
- **Headline (68px):** "Turn on Transactions. <em>Strengthen everything downstream.</em>"
- **Quote callout** (blue/teal gradient, mint left-border):
  - 34px Bowery Street italic: `"Point solutions don't talk to each other. <span teal>Plaid's foundation does.</span>"`
- **Repeated architecture diagram** (smaller than slide 8):
  - Top block "When this gets smarter…" + "Transactions Foundation"
  - SVG spine to 5 columns
  - Bottom row of five "downstream" cards (each with a teal `↑` arrow in the top-right corner):
    - **Signal** — ACH payment risk — "Sharper return-risk scoring"
    - **Protect** — Fraud detection — "Cleaner signals into Trust Index 2"
    - **Credit** — LendScore — "Cash flow underwriting"
    - **Lending** — EWA Score — "Earned wage advance risk"
    - **Insights** — Cash Flow Insights — "PFM, EWA, lending unlocks"

---

### Slide 18 — Transactions for Business

- **Label:** `18 Business`
- **Headline (64px):** "First-class SMB data. <em>No more hand-rolled categories.</em>"
- **Three-column body:**
  - **Today card (flex 1):**
    - Eyebrow "Today" + "BETA → GA" pill (gray)
    - Body: "A `holder_category` flag on every account — flags business vs consumer surfaces at link time."
    - Mono snippet on dark background showing the field
    - Footer: "Distinguish SMB accounts before you touch a transaction."
  - **Coming soon card (flex 1.1) — accent treatment:**
    - Eyebrow "Coming soon" + "H2 2026 · GA" pill (mint)
    - Body: "<span teal weight 600>13 purpose-built business categories</span> under a new `business_finance_category` object."
    - 3×4 grid of mono category chips: `PAYROLL`, `SOFTWARE`, `CONTRACTOR`, `RENT`, `UTILITIES`, `TAX_PAYMENT`, `INVENTORY`, `SHIPPING`, `PROF_SERVICES`, `MARKETING`, `TRAVEL`, `LOAN_REPAY`, `+ 1 more`
    - Footer: "Only first-party SMB-native taxonomy among major aggregators."
  - **Already on Plaid card (flex 0.7):**
    - Eyebrow "Already on Plaid"
    - Body: "Serving tens of millions of business accounts today."
    - Three Bowery Street 48px logos (text): **Brex** / **Bluevine** / **Wave**

---

### Slide 19 — 2026 Roadmap

- **Label:** `19 Roadmap`
- **Headline (72px):** "We're not done. <em>2026 highlights.</em>"
- **Three-column body** with icon + eyebrow + headline + three bullets + bottom stat:

  | Column | Icon | Eyebrow | Headline | Bullets | Bottom stat |
  |---|---|---|---|---|---|
  | 1 | shield SVG | Reliability | Sync architecture migration | (a) "Move sync source of truth from a dedicated changeset service into the transaction document itself." (b) "Eliminates race conditions and cross-service drift. Raises the 99.98% endpoint above." (c) "Better item-health prediction — break before the user notices." | `99.98%` + "sync success rate, last 30d" |
  | 2 (accent) | targeting SVG | Intelligence | Foundation model expansion | (a) "Continued retraining and new capability layers on the shared representation." (b) "Business categorization GA — 13 SMB-native categories." (c) "Agentic enrichment fix workflows — auto rule generation from customer feedback." | `+12` + "new subcategories, more on the way" |
  | 3 | bolt SVG | Speed | Fresher data at the source | (a) "Traffic-optimization ML for major banks — Wells Fargo, Capital One." (b) "ARM + account-based skipping models — smarter extraction timing." (c) "API v2 perf program — reduce latency added on every Plaid call." | `1–4/d` + "syncs per institution, tuned by ML" |

---

### Slide 20 — Why now (`.holo`)

- **Label:** `20 Why now`
- **Headline:** Bowery Street 500, **120px**: "Three forces / are <em>converging.</em>"
- **Three frosted cards** (each `background:rgba(255,255,255,0.5); border:1px solid rgba(2,37,68,0.08); backdrop-filter:blur(8px)`):
  - **01** — "AI agents are operating on financial data." — "They need cleaner, denser signals than humans do — and they're already moving money on your platform."
  - **02** — "Consumers expect personalization." — "Generic categories no longer cut it. J.D. Power finds personalization is the lever for satisfaction and engagement."
  - **03** — "Open finance regulation is solidifying." — "Your aggregator choice is now a multi-year commitment — switching has a cost the industry didn't have before."
- **Closer (36px Bowery Street italic):** "Pick the foundation that's going to keep getting smarter — without a migration."

---

### Slide 21 — Klover proof (`.light`)

- **Label:** `21 Klover story`
- **Custom padding:** `padding:80px 100px 80px;`
- **Headline (72px, dark):** "Klover+ <em>evolved with the model.</em>"
- **Subtitle (26px):** "Chicago-based fintech serving millions of customers underserved by traditional banking. Built their flagship PFM product on Plaid Transactions — and rebuilt it as our intelligence grew."
- **Two-column body:**
  - **Left column (flex 1.35) — story arc + stats card:**
    - White card with mono eyebrow "The Klover+ arc"
    - **Three-stage row:** three sub-cards separated by mono "→" arrows. Each has a 52px Bowery Street number (blue-600), 22px subhead, 18px body:
      1. **Measurement** — "Started as a simple tool measuring spend from clean Plaid transaction data." (gray bg)
      2. **Categorization** — "As Plaid added merchant names and richer categorization, Klover+ deepened." (gray bg)
      3. **Anticipation** — "Anticipatory tools — what the customer is about to do next." (**holo gradient bg** — lilac→mint)
    - Dashed border-top, footer: "No re-architecture. The same Transactions integration; the model under it kept getting smarter."
    - **Four stat callouts below** (gap 16px), each in white card:
      - `~$1M/day` — "in cash advances on Klover product"
      - `80%+` — "approval rate on cash advance"
      - `~20%` — "savings returned to users via Klover+"
      - `+58 pts` (blue-700, **accent card**) — "credit score lift (vs. ~25pt industry avg)"
  - **Right column (flex 1) — pull quote card:**
    - Dark navy background, holo decorative circle bottom-right
    - 120px mint open-quote character
    - 27px Bowery Street italic: "Klover+ evolved with Plaid's transactions offering. As Plaid began to offer more solutions — like merchant name and categorization — we built anticipatory tools that helped us understand what the customer was going to do next. With the new categorization that's available, we'll be able to <span teal>evolve it even further.</span>"
    - Attribution: "DB" avatar in holo gradient, "Dominic Bennett" + "Co-founder & CTO · Klover"
- **Logo strip footer:** border-top, "Also building on Transactions" mono label, then five 34px Bowery Street logos in gray-78%: **Drop · Brigit · Vola · SoFi · Steady**

---

### Slide 22 — Decision frame

- **Label:** `22 Decision frame`
- **Headline (78px):** "What you're <em>really</em> choosing."
- **Two-column comparison table:**
  - Header row: "Building on raw bank data" (muted mono) | "Building on Plaid's foundation" (mint mono)
  - Four rows, each with left side muted-white body / center mint arrow / right side white weight-500 body:

  | Building on raw bank data | → | Building on Plaid's foundation |
  |---|---|---|
  | You build & maintain enrichment. | → | We ship it, you consume it. |
  | You wait 12 months for v2 categories. | → | You get v2 today, opt in by flag. |
  | Your AI inherits raw ambiguity. | → | Your AI inherits network intelligence. |
  | One product, one team's data. | → | **One foundation, every Plaid product gets better.** (mint, 30px, weight 600) |

  Last row uses a horizontal mint gradient highlight background.

---

### Slide 23 — Next steps (`.holo`)

- **Label:** `23 Next steps`
- **Headline:** Bowery Street 500, **140px**, line-height 0.95: "Let's get / <em>specific.</em>"
- **Three CTA cards** (gap 24px), each with strong shadow:

  | Card | Eyebrow | Title | Body | Extra |
  |---|---|---|---|---|
  | White | If you're already on Transactions | Flip on v2. | "We'll co-pilot the rollout. A version flag, not a migration." | Mock code block at bottom showing the JSON flag |
  | Dark navy | If you're evaluating an adjacent product | 30-minute architecture review. | "We map Transactions → your downstream use case: PFM, EWA, lending, BFM." | Four mint pills: PFM · EWA · Lending · BFM |
  | White | If this is a new evaluation | Sandbox + 2-week pilot. | "On your real institution mix. You see the foundation in your data." | Blue arrow icon + "Same-week sandbox access. Pilot kicks off the week after." |

- **Footer strip:** Contact section ("Your Plaid AE / SE pair · transactions-feedback@plaid.com") + right-aligned mono "Walmart · DoorDash × Burger King · Layla / *remember the foundation.*"

---

## 6. Speaker notes

Add this script tag inside `<head>` so the deck-stage component renders speaker notes in sync with the slide index. Each string corresponds to one slide; the array must have exactly 23 entries.

```html
<script type="application/json" id="speaker-notes">
[
  "Set the tone — this pitch is about the foundation, not just features. The opening line: 'What does it actually take to turn a bank string into financial intelligence?' That's the whole deck in one question.",
  "Frame the shift. Recording transactions used to be enough; today, apps, consumers, and AI agents all need to act on transactions, which means understanding them. The agent point can feel abstract, so ground it: ChatGPT pulling a user's recent spending to answer 'can I afford this trip?', a Klarna or Cash App agent rebalancing autopay schedules, an SMB copilot pre-approving a vendor invoice off the company checking account, an EWA agent deciding whether a $200 advance is responsible based on next week's projected gig income. The pattern is the same — an agent reads transaction data and then moves money or blocks a transaction on the user's behalf. Land on: the cost of being wrong has gone up.",
  "Make the case against the easy answer. People assume general LLMs can read bank descriptions. They can't, reliably. Bank strings are short, ambiguous, contextual. Layering a general model on top inherits the ambiguity. The takeaway box is the punchline: what's needed is a shared representation.",
  "This is the baseline. Before AI even enters the conversation, this is what Plaid does for every transaction, on every connected account. Walk slowly through the right side — fifteen useful fields from one bank string. Pause on store_number and lat/lon; those usually surprise people.",
  "Now the relationship story. A 'Burger King' charge is also a DoorDash transaction. The counterparties array surfaces both. This unlocks rewards optimization, partnership analytics, and granular spend categorization. It's not the merchant or the marketplace — it's both.",
  "Pause here. This is the most quotable slide in the deck. Layla is a real customer composite. With v1, both deposits are 'Other Income.' With v2, they're 'Gig Income — DoorDash' and 'Gig Income — Lyft.' For an EWA app, that's the difference between guessing and forecasting.",
  "Now zoom out. This is the architecture behind the previous three slides. Plaid built the first transaction foundation model for finance. Trained self-supervised on the Plaid Network. The 500 million number lands hard — this isn't a science experiment, it's running in production today.",
  "Walk the diagram. One shared transaction representation at the top. Lightweight adaptation layers below — PFC, business categories, LendScore, EWA Score, Protect, Signal. The strategic point: turn on Transactions, and every downstream product gets smarter when the foundation does.",
  "The 'how do we know it's better than what you'd build yourselves' answer. AI Annotator generates labels at network scale. Human reviewers build the golden datasets and spot-check edge cases. The model retrains. >95% alignment with humans, at a fraction of the cost and time of manual labeling. The data engine — not the model — is the moat. Next slide is what that actually means for you.",
  "Five things you inherit by building on this. Walk them quickly; don't get bogged down. One — speed: new categories ship in months, not years. PFC v2's 12+ subcategories went from concept to production in a single release cycle. Two — cost: it's baked into Transactions, you never pay to train or maintain it. Three — the network effect: when one customer's feedback corrects an edge-case merchant or a misclassified income stream, every customer inherits the fix on the next retrain. Four — audit-ready: the golden datasets are a defensible benchmark behind every label, which matters for lending decisions, fraud blocking, ACH risk. Five — and this is the strategic one — the model you ship against today is measurably better in twelve months, and you will not have lifted a finger to make that happen. The closer line: 'you didn't build the data engine; you don't have to pay for it; you still get the upside.'",
  "The numbers behind PFC v2. Don't read all three — point at them. +10% on primary categories, +20% on detailed sub-categories, 12+ new subcategories. The numbers are the proof; the next slide is where the audience feels the unlock.",
  "Walk row by row. 'Other Income' becomes Gig Income, Tax Refund, Interest Income. 'Transfer' becomes Internal, Wire, P2P. 'Bank Fees' splits into Overdraft, ATM, Foreign Transaction. Each of these unlocks a specific product feature — call out one example per row for your audience.",
  "For the risk-averse people in the room. v2 ships behind a version flag. Existing customers opt in. New customers get v2 by default. v1 stays supported. Zero migration risk — that's the message.",
  "Now we're out of the AI section and into the broader Transactions story. 730 days of history, multiple syncs a day, on-demand refresh. The use case to anchor it: any underwriting model that needs 12+ months of cash flow can run today on Plaid, not after a 6-month wait.",
  "Same intelligence — on your own data, too. Enrich lets customers send their non-Plaid transactions through the same pipeline. The takeaway: one categorization output across your in-house and Plaid-linked data. No reconciliation tax.",
  "Better data is only valuable on items that link. This is the flywheel slide: 100M+ Remember Me profiles boost conversion up to 11% for returning users; 52% of broken links self-repair without re-auth. More items linked, more transactions, richer signal, better model.",
  "We're returning to the same architecture diagram on purpose. The point: when you upgrade Transactions, Plaid Signal gets sharper on ACH risk. Protect gets sharper on fraud. LendScore gets sharper on underwriting. Point solutions can't do this. A foundation can.",
  "First-class SMB data. The holder_category field already flags business vs consumer accounts. Coming soon: 13 purpose-built business categories under business_finance_category. Brex, Bluevine, Wave are already on Plaid Transactions for tens of millions of business accounts.",
  "What we're shipping in 2026. Three lanes: reliability — the sync migration, item health prediction; intelligence — foundation model expansion, business GA, agentic fix workflows; speed — ML traffic optimization for the big banks, fresher data through smarter extraction timing.",
  "Why now, in three forces. AI agents now act on financial data. Consumers expect personalization. Open finance regulation is locking in — your aggregator choice is a multi-year commitment. The punchline: pick the foundation that's going to keep getting smarter without a migration.",
  "This is the deepest customer proof we have. Klover is a Chicago fintech serving millions of customers who don't have access to traditional banking benefits. They built Klover+ — their flagship PFM — on Plaid Transactions, and rebuilt it as our intelligence grew. The arc is the deck's thesis in customer form: measurement → categorization → anticipation. No re-architecture; the same Transactions integration, the model under it kept getting smarter. ~$1M/day in cash advances, 80%+ approval rate, ~20% savings returned to users, +58-point average credit-score lift versus an industry average of ~25. Dominic Bennett's quote — 'with the new categorization that's available, we'll be able to evolve it even further' — is the perfect bridge from this slide to the PFC v2 conversation. And just to ground the breadth: Drop, Brigit, Vola, SoFi, Steady all run on the same Transactions foundation.",
  "The closer. Two columns. On the left: building on raw bank data. On the right: building on Plaid's foundation. Let the audience read it. The fourth row is the one to land on — one foundation, every Plaid product gets better.",
  "Three CTAs based on where the customer is today. Existing Transactions customer? Flip on v2; we co-pilot the rollout. Adjacent product evaluation? 30-minute architecture review. New evaluation? Sandbox plus a 2-week pilot on your real institution mix."
]
</script>
```

---

## 7. Implementation checklist for Claude Code

1. **Pull the shared assets** (fonts, logos, `colors_and_type.css`, `deck-stage.js`) into the project. These are not invented — they are part of the Plaid design system.
2. **Build `deck.html` top-to-bottom** following the spec above. Don't skip the eyebrow / page-number footers — they are part of the visual rhythm.
3. **Use static HTML**, not React. The deck is meant to be directly editable in the browser; keep `<h2>`/`<p>` tags un-templated.
4. **Use flex/grid with `gap`** for every multi-element row. No inline-block, no per-element margins, no whitespace-as-spacing.
5. **Hold the line on 24px minimum body text.** The only exception: simulated product-UI chrome (avatar letters, confidence pills, status bars) inside mockup cards.
6. **Use Bowery Street italic** as a rhetorical accent — once per headline, never twice in the same sentence.
7. **Don't invent new colors.** Use the tokens. If you need a soft tint, use `rgba()` on the existing brand colors (most cards use `rgba(255,255,255,0.04)` or `rgba(66,240,205,0.14)`).
8. **Match the source content verbatim.** The raw bank strings ("PURCHASE WM SUPERCENTER #1700 POWAY CAUS", "Dd Doordash Burgerkin") are pulled from Plaid's actual docs and should not be paraphrased.
9. **Confirm slide count = 23** (every chrome footer reads `XX / 23`, every speaker-note array has 23 entries).
10. **Test by loading `deck.html` in a browser.** Arrow keys navigate. The deck should letterbox cleanly at any window size.
