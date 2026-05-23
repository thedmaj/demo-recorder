# Plaid Deck Design Brief — README

> **A three-part design system for building any HTML slide deck in the Plaid visual language.**
> Drop these files into Claude Code in agent mode (with the supporting assets), and it can build a coherent, projection-ready deck on any topic.

## What's in this brief

| File | Purpose | Read first if… |
|---|---|---|
| **`DECK_DESIGN_SYSTEM.md`** | Tokens, fonts, color, type scale, the slide shell. The foundation everything else builds on. | You're new to the system or need to look up a token. |
| **`DECK_TEMPLATES.md`** | Eleven reusable slide templates with copy-paste skeletons. The library you compose from. | You know what kind of slide you need and want the markup. |
| **`DECK_COMPOSITION.md`** | How to choose templates, sequence sections, write headlines, add speaker notes, avoid pitfalls. | You're planning a deck or stuck on writing it. |

## What you'll need to ship a deck

Bring these into the project alongside the briefs:

```
colors_and_type.css      ← design tokens (provided)
deck-stage.js            ← slide-stage web component (provided)
fonts/                   ← Plaid Sans + Bowery Street .otf files (provided)
assets/logos/
  plaid-horizontal-white.png
  plaid-horizontal-dark.png
```

## Template library at a glance

| # | Template | Use it when… |
|---|---|---|
| T1 | Title | Opening the deck |
| T2 | Section divider | Marking a major beat in a long deck |
| T3 | Statement | A single big idea deserves its own slide |
| T4 | Big-number trio | Three related hero stats |
| T5 | Three-column body | Three parallel reasons / pillars / audiences |
| T6 | Before / after split | Showing a transformation |
| T7 | Comparison table | "Old way vs. new way" decision frame |
| T8 | Step flow | Sequential process or evolution |
| T9 | Architecture diagram | One thing on top, many things below |
| T10 | Customer proof | One marquee customer, deep |
| T11 | CTA / next steps | Closing the deck with audience-specific actions |

## Quickstart

1. **Read all three briefs** (they're short).
2. **Outline first.** Slide number → template choice → headline → label. Don't open the HTML editor until the outline reads cleanly.
3. **Scaffold the deck shell** with empty `<section>` tags, plus a `#speaker-notes` JSON with empty strings.
4. **Fill slide-by-slide**, copy-pasting from the template skeletons in `DECK_TEMPLATES.md`. Write the speaker note for that slide before moving on.
5. **Check pacing** — no more than 4 navy slides in a row without an interlude.
6. **Run the type-size sweep** — anything under 24px outside of mockup chrome gets bumped.
7. **Export to PPTX** using the Manrope / Playfair Display / JetBrains Mono swaps.

## The five-second design summary

- **Dark navy is the default background.** Light / cream / holo interludes are interstitial relief.
- **Bowery Street italic is your accent voice.** Use it for the operative noun phrase in a headline. Once per sentence.
- **Mint is the "this is the one" color.** One mint moment per slide.
- **Mono is the "underlying mechanics" voice.** Use for eyebrows, raw data, code, metadata.
- **24px floor on all body text.** Hero numbers and titles much larger.
- **Cards are the layout primitive.** Default cards on dark are `rgba(255,255,255,0.04)` with a 1px white-10% border and 14–18px radius. Accent cards use a mint→blue gradient.
- **Flex / grid with `gap`** for every multi-element row. Never inline-block.
