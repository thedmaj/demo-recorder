# Deck Composition Guide

> **How to choose templates, sequence sections, write headlines, and add speaker notes.**
> Use this after you've read `DECK_DESIGN_SYSTEM.md` and `DECK_TEMPLATES.md`.

---

## 1. Choosing templates

Match the rhetorical purpose to the template:

| You want to… | Use… |
|---|---|
| Open the deck with a thesis | **T1 Title** |
| Mark a major section change | **T2 Section divider** |
| Land a single big idea | **T3 Statement** |
| Quantify with 3 hero stats | **T4 Big-number trio** |
| Make a parallel argument (3 reasons / pillars) | **T5 Three-column body** |
| Show a transformation (raw → enriched) | **T6 Before/after split** |
| Force a head-to-head decision | **T7 Comparison table** |
| Walk through a process | **T8 Step flow** |
| Show a one-to-many relationship | **T9 Architecture diagram** |
| Anchor with a customer story | **T10 Customer proof** |
| Close with three audience-specific CTAs | **T11 CTA / next steps** |

**Composition is rarely 1-template-per-slide.** A "big-number trio" (T4) can include mini step-flows (T8) inside each card. A "customer proof" (T10) embeds a 3-stage step-flow as its left column. Mix freely.

### When to repeat a template

- **T4 (big-number trio)** appears 2–3 times in a 20-slide deck — each time with different numbers and a different argument. The shape becomes familiar; the content stays fresh.
- **T9 (architecture diagram)** is powerful exactly once or twice. The second time, *return to the same diagram* and highlight a different part of it — that visual callback is one of the strongest moves in the deck.
- **T6 (before/after)** can run 2–3 times in sequence for a "tour of examples" section. Keep the layout identical so the audience pattern-matches.
- **T2 (section dividers)** should be rare — 3–5 in a 20-slide deck, no more.

### Pipeline product demos (2–4 slides) — not sales decks

Short demos embedded in the Plaid Demo Pipeline use the same T1–T11 vocabulary but **different closing rules**:

| Sales deck habit | Pipeline demo rule |
|------------------|-------------------|
| T11 with “contact us” / Account Manager CTAs | **Forbidden** — no contact Plaid, contact Account Manager, free trial, Start a POC, or perform a retro analysis |
| Faux button pills (“Start your Retro →”) | **Forbidden** — use declarative copy or outcome bullets only |
| Three audience-segment action cards | Three **product value** cards (capabilities unlocked in the demo) |
| Peer proof as dense table | Two hero stats → **T4 stat-highlight**, not T7 table |

**Spacing:** wrap body in `.slide-stack` with `padding-bottom: 32–48px` so `.chrome-foot` never overlaps body copy (top QA failure: `slide-text-overlap`).

---

## 2. Sequencing a deck

### The default 5-act structure (any length)

1. **Open** — title (T1) + frame the shift / problem (T3 or T5)
2. **Make the audience feel the problem** — concrete examples (T6 × 2–3)
3. **Reveal the solution** — the foundation / mechanism (T9 + T8 + T5)
4. **Quantify the benefit** — what you get (T4 + T6 + T3)
5. **Differentiate and close** — competitive frame (T7), customer proof (T10), CTA (T11)

### Length tuning

| Deck length | Section structure |
|---|---|
| **5 slides** (lightning) | T1 → T3 → T4 → T10 → T11 |
| **10 slides** (pitch) | T1 → T3 → T6 → T6 → T9 → T4 → T6 → T7 → T10 → T11 |
| **15–20 slides** (full pitch / sales deck) | Default 5-act, ~3–4 slides per act |
| **25–30 slides** (deep-dive / internal review) | Default 5-act, add T8 step flows and a second T9 callback diagram |

### Pacing rules

- **Never run >4 navy slides in a row** without a `.light`, `.cream`, or `.holo` interlude. The pacing matters even when the content is dense.
- **One "wow" slide per act.** A `.holo` section divider, a Bowery Street numeral the size of half the screen, a hand-drawn-feeling SVG flow. The eye needs a place to rest and a place to fire.
- **End every section on a quotable line.** Your speaker should be able to say it without looking at the slide.

---

## 3. Writing the deck

### Headlines (the rules)

- **Sentence case**, not Title Case. ("From bank data to financial intelligence." — not "From Bank Data To Financial Intelligence.")
- **One idea per headline**, max two clauses. If you need a comma, you probably need a `<br/>` and two phrases.
- **End with a period.** Periods make a slide feel declarative. Questions weaken the slide.
- **Italic accent goes on the noun phrase that pays off the sentence.** ("Recording transactions *isn't enough anymore.*" — italic on the operative phrase, not the subject.)
- **Avoid clever phrasing.** The headline is a load-bearing wall, not a joke. Save cleverness for the speaker notes.

**Bad → Better:**

| Bad | Better |
|---|---|
| "Why Choose Plaid?" | "What you're really choosing." |
| "Our Industry-Leading Foundation Model" | "We built the first transaction foundation model for finance." |
| "Real-Time Data, At Scale!" | "4× the lookback. Multiple syncs per day." |
| "Customer Success Story: Klover" | "Klover+ evolved with the model." |

### Body copy

- **24–30px**, line-height 1.4–1.55. Wide is fine; long is not. Keep paragraphs to ≤3 lines at this scale.
- **One thought per paragraph.** If you find yourself writing "and also," start a new paragraph or a new card.
- **Concrete over abstract.** "12+ new subcategories — Gig Income, Overdraft Fee, Wire Transfer, Mortgage" beats "richer categorization across many transaction types."

### Numbers

- **Round, don't approximate.** "500M+" is better than "approximately 487 million." Hero numbers are graphic elements first, data points second.
- **Suffix in smaller type.** `500M+` where `+` is 50% the size of `500M`. `+10%` where `%` is 50% the size of `+10`.
- **Caption every hero number** with what it means (e.g. "transactions enriched daily") and the source (e.g. "on the Plaid Network").
- **Three numbers max per slide.** Beyond three, the eye can't anchor and the slide reads as noise.

### Mono labels (the eyebrow voice)

- Use mono for: section names, "Example 01 — Walmart"-style labels, code, raw data fragments, status indicators ("BETA → GA"), audit-style metadata.
- Mono is a tonal voice — it whispers "this is the underlying mechanics" while the sans says "this is what matters to you."
- Mono uppercase letter-spacing: **0.14em–0.18em**. Lower spacing reads as engineering tooling; higher reads as design metadata.

### Mint, used semantically

Mint (`#42F0CD`) is the deck's "**this is the one**" color. Use it for:

- The italicized payoff phrase in a headline
- The accent card in a T4 trio
- The "after" column in a T6 split
- The mint arrow in a T7 comparison
- The "current state" stage in a T10 customer arc
- A `↑` indicator on a card that's "the highlighted one"

If everything on the slide is mint, **nothing is mint.** One mint moment per slide is the rule.

---

## 4. Speaker notes

### Format

Add this to `<head>`. The array must have exactly one entry per slide.

```html
<script type="application/json" id="speaker-notes">
[
  "Note for slide 1...",
  "Note for slide 2...",
  ...
]
</script>
```

### What makes a good speaker note

- **2–4 sentences for routine slides; up to 6–8 for hero slides.** The note is a script, not a research dump.
- **Start with how to enter the slide:** "Pause here." / "Make the case against the easy answer." / "Now zoom out."
- **One concrete example** if the slide uses abstractions. (See slide 2 of the Plaid Transactions deck — abstract "agents are operating on financial data" gets grounded with "ChatGPT pulling a user's recent spending, a Klarna agent rebalancing autopay…")
- **End with the line your speaker should say out loud.** "Land on: the cost of being wrong has gone up." / "The closer line: 'one foundation, every Plaid product gets better.'"
- **Bridge to the next slide.** "Next slide is where the audience feels the unlock." This makes the deck flow conversationally.

### What a speaker note should NOT do

- Repeat the slide. The speaker can read.
- Cite sources or include data the audience can't see. (Source citations belong in an appendix, not the talk.)
- Run >150 words for non-hero slides. Anything longer suggests the slide is doing too much.

---

## 5. The deck-stage component contract

The `<deck-stage>` web component is what scales the slide, handles keyboard nav, prints to PDF, and posts speaker-note updates. You don't need to know its internals — you just need to respect its contract:

```html
<deck-stage width="1920" height="1080">
  <section data-label="01 ...">...</section>
  <section data-label="02 ...">...</section>
  ...
</deck-stage>
```

**Rules:**

- Each slide is a **direct-child `<section>`** of `<deck-stage>`. Don't wrap them in extra divs.
- Every slide gets `data-label="NN Short label"` — used by the slide picker, comment threading, and the page-number footer.
- **Slide labels are 1-indexed.** "01" is the first slide, not "00". If you 0-index, every reference is off by one.
- Don't manually post `slideIndexChanged` — the component does it for you.
- For interactive demos inside a slide (any live JS state), use `localStorage` keyed to the slide label so refreshes don't lose state.

---

## 6. Exporting

### To PPTX (editable)

When the deck is ready, export to PowerPoint with these font swaps so it renders on any machine:

- **Plaid Sans → Manrope** (Google Font)
- **Bowery Street → Playfair Display** (Google Font)
- **SF Mono → JetBrains Mono** (Google Font)

The export tool needs `width: 1920`, `height: 1080`, and one slide entry per `<deck-stage>` child. Speaker notes are picked up automatically from the `#speaker-notes` script tag.

### To PDF

The deck-stage component has built-in print-to-PDF. Use the print button in the slide rail, or `Cmd+P` / `Ctrl+P` — one page per slide, no manual setup.

### To standalone HTML

For sharing offline, bundle the deck and all assets into a single self-contained HTML file. This works without an internet connection and can be opened anywhere.

---

## 7. Common pitfalls

| Pitfall | Why it's bad | Fix |
|---|---|---|
| Body text < 24px | Won't read in a conference room | Hard floor: 24px, no exceptions outside mockup chrome |
| Two italic accents in one headline | Dilutes both | One per headline, on the operative phrase |
| Five+ items in a row | Breaks the eye, looks cluttered | Three or four, max |
| Background gradient with white text | Often illegible on holo | Use white text on dark, dark text on holo / light / cream |
| Source citations in the chrome-foot | Reads as internal / academic | Move sources to an appendix or speaker note |
| Per-element margins for spacing | Breaks under direct manipulation | Always `gap:` on a flex/grid parent |
| Same slide background for 5+ slides in a row | Visual fatigue | Insert `.light` / `.cream` / `.holo` interlude every 4–5 slides |
| Inventing new colors | Breaks the system | Use tokens; for tints, `rgba()` on brand colors |
| Headlines with "?" | Weakens the slide | Make it declarative; let the speaker ask the question |
| Inventing data | Audit risk + erodes trust | Use real numbers; if you don't have a number, don't have a stat slide |

---

## 8. Implementation checklist for Claude Code

When starting a new deck, work in this order:

1. **Read all three briefs** (`DECK_DESIGN_SYSTEM.md`, `DECK_TEMPLATES.md`, this file). Don't skim.
2. **Confirm assets are in place:** `colors_and_type.css`, `deck-stage.js`, `fonts/` directory, `assets/logos/`.
3. **Outline the deck before writing any HTML.** Slide-by-slide list:
   - Slide number
   - Template choice (T1–T11)
   - Background variant (default / `.light` / `.cream` / `.holo`)
   - One-sentence headline
   - 3–5 word slide label for `data-label`
4. **Check pacing:** scan the outline and make sure no >4-slide stretch is all-navy. Insert an interlude if so.
5. **Write the slide shell scaffold** (head with imports, `<deck-stage>` element, empty `<section>` tags with `data-label` attributes). Commit before adding content.
6. **Write the speaker notes JSON in parallel.** Each entry maps positionally to a slide. This is easier to keep in sync if you do it slide-by-slide as you build, not at the end.
7. **Fill in slides** by copy-pasting from the template skeletons and replacing content. Don't write slides from scratch.
8. **Verify in browser.** Arrow-key through all slides. Watch for: text overflow, missing footers, italic-accent overuse, mint overuse.
9. **Run a font-size sweep.** Anything under 24px outside of mockup chrome → bump.
10. **Export to PPTX** with the font swaps above. Open in PowerPoint to confirm it renders.

---

## 9. Quick reference card

```
COLORS                  WEIGHTS               SIZES
navy   #022544          Plaid Sans 400/500/600/700    Hero       140–200px
mint   #42F0CD          Bowery Street 400i/500        Title      64–84px
blue   #0B7BBC          SF Mono 400                   Body       30px
gray-50 #F9F9F9                                       Small/eyebrow 24px
holo lilac #E6E6FF                                    Padding    100/120/88
holo mint  #D8FEF3
holo butter #FFF6D8

CARDS
default   rgba(255,255,255,0.04) + 1px rgba(255,255,255,0.1) border + 14px radius
accent    linear-gradient mint/blue + 1px mint border + 14px radius
light     white + 16px radius + soft shadow
frosted   rgba(255,255,255,0.5) + blur(8px) — for holo bgs

VOICE
Headlines    declarative, sentence case, period at end, one italic accent
Body         24–30px, ≤3 lines per paragraph, concrete over abstract
Mono         eyebrows, labels, code, data — 0.14–0.18em letter-spacing, uppercase
Numbers      rounded, with suffix in smaller type, captioned with meaning + source
Mint         the "this is the one" color — one mint moment per slide
```
