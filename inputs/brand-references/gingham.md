---
brand: Gingham
slug: gingham
last_verified: 2026-07-08
canonical_url: null
---

# Gingham — default generic brand (fictional; local assets only, NEVER Brandfetch)

Used automatically when a demo prompt names **no company and no website**. Gingham is a
generic, modern fintech brand: a **fixed visual identity** (logo, colors, fonts, design
system, voice) paired with **content that the build generates to fit the demo's use case
and story** — nav, footer, hero, and product copy are NOT hard-coded here, because Gingham
may front a bank, a lender, a payments app, a marketplace, an insurer, etc. The design
system (tokens + component recipes + voice) is injected at build time from
`assets/gingham-brand/` — that folder is the single source of truth.

Isolation: this brand is loaded ONLY on the `gingham-default` path (no company + no URL).
It must never be Brandfetch'd and its design tokens must never appear in a real-company build.

## Mode
- light

## Logo
- file: gingham-logo.png

## Brand Colors
- bgPrimary: #FFFFFF
- bgGradient: radial-gradient(120% 120% at 50% 0%, #EEF5FF, #E4ECF7)
- accentCta: #0A54C4
- textPrimary: #0B1B33
- textSecondary: #64748B
- textTertiary: #94A3B8
- accentBorder: rgba(10,84,196,0.22)
- accentBgTint: #EFF4FE
- error: #D92D20
- success: #12A150
- surfaceCard: #FFFFFF
- surfaceCardBorder: #E5EAF1
- navBg: #FFFFFF
- navAccentStripe: #51D2FB
- footerBg: #041E45

## Brand motifs
- Gingham Blue (#0A54C4) for primary actions and structure on a white-first canvas; Sky (#51D2FB) accent for highlights, links, and focus rings. Cool-tinted neutrals; ink text (#0B1B33) — never pure black. Weave gradient (135deg #0A54C4 → #51D2FB) for hero/feature flourishes only, used sparingly. Rounded cards (radius 12–24px) with soft blue-tinted shadows. Space Grotesk for display/headlines/money figures (tight tracking), Hanken Grotesk for body/UI. One dominant primary action per screen. Voice: clear over clever, warm not cute, "you" not "we", sentence case, a tasteful "check" pun welcome but never forced.

<!-- NOTE: No ## Nav / ## Footer / ## Hero here on purpose — the build generates those
     to match each demo's use case and story. Compliance rules still apply: no fabricated
     regulatory claims (FDIC / NMLS / Equal Housing) unless the scenario genuinely warrants
     it and it is accurate. -->
