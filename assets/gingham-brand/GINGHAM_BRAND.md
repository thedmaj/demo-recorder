# Gingham Brand System

A fictional neobank for product demos. Familiar, trustworthy, and crisp — a modern
take on the classic blue gingham check. Use this document as the source of truth
when building any Gingham front-end.

## Files in this folder
- `gingham.css` — design tokens as CSS custom properties (`var(--gg-*)`). Import once at the app root. **Single source of truth.**
- `tokens.json` — the same values, machine-readable (for JS themes, codegen, etc.).
- `tailwind.config.js` — maps Tailwind utilities onto the CSS variables (merge into `theme.extend`).
- `brand-spec.html` — static, self-contained visual reference; open in a browser.
- `logo.svg` — the Gingham mark (scalable, locked colorway).
- `GINGHAM_BRAND.md` — this file: rules, usage, component recipes.
- `CLAUDE.md` — instructions for Claude Code (place a copy at repo root).

## Golden rules
1. **Legibility & contrast win.** Everything else is secondary.
2. **White-first.** App surfaces are white / `--gg-bg-subtle`. Blue appears as accent.
3. **One dominant action per screen.** A single solid `--gg-primary` button; everything else is secondary/ghost.
4. **Reference tokens, never raw hex.** Use `var(--gg-*)` or `tokens.json`. Don't invent colors, radii, or shadows.
5. The **Weave gradient** and the **mark** are flourishes — use sparingly, never as wallpaper.

---

## Logo
- Locked colorway: deep blue square (`#0A54C4`), light-blue field (`#51D2FB`), white woven check. **Do not recolor the mark freely.**
- Wordmark = mark + "Gingham" in Space Grotesk SemiBold, tight tracking (`-0.03em`); icon at ~cap-height ×1.15.
- Clearspace: one icon-width on all sides. Minimum: mark 24px, wordmark 20px cap height.
- Placement: on white (default), on brand blue (add subtle white ring/shadow), or on the Weave gradient (white wordmark).

## Color
- **Gingham Blue** (`--gg-blue-*`, base `500 #0A54C4`) — primary actions, structure, trust.
- **Sky** (`--gg-sky-*`, base `400 #51D2FB`) — highlights, focus rings, links, energy.
- **Neutrals** are cool-tinted (`--gg-gray-*`, text `--gg-ink #0B1B33`). Borders/shadows read as part of the palette — never pure black/gray.
- **Signal** (`--gg-positive/warning/negative`) is for finance semantics only (money in = positive green, out/error = negative red).
- Gradients: `--gg-grad-weave` (hero), `--gg-grad-deep-weave` (dark cards), `--gg-grad-mist` (app backdrop).

## Typography
- **Space Grotesk** (`--gg-font-display`, weights 500–600) — wordmark, headlines, and big money figures. Always tight tracking.
- **Hanken Grotesk** (`--gg-font-text`, weights 400–700) — body, UI, labels. The workhorse.
- Load both from Google Fonts:
  `https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Hanken+Grotesk:wght@400;500;600;700;800&display=swap`
- Money/balances: Space Grotesk SemiBold; put the cents in `--gg-sky-300`/`--gg-gray-400` for a lighter tail.
- Sentence case everywhere except the wordmark. Headlines take no period unless two sentences.

## Voice
Clear over clever · warm not cute · "you" not "we" · quietly witty (a tasteful "check" pun is welcome, never at the reader's expense). Start with the useful thing.
- Say: "Your account's open. Add money to get going."
- Not: "Congratulations! Your account provisioning is now complete."

---

## Component recipes

### Button — primary
`height:48px; padding:0 24px; border-radius:var(--gg-radius-md); background:var(--gg-primary); color:#fff; font:600 15px var(--gg-font-text); box-shadow:var(--gg-shadow-primary);`
Hover: background `--gg-primary-hover`. Press: scale .98. Focus: `--gg-focus-ring`.

### Button — secondary / ghost
Secondary: `background:var(--gg-primary-tint); color:var(--gg-primary);` · Ghost: transparent bg, `color:var(--gg-primary)`.
Pill / gradient CTA: `border-radius:var(--gg-radius-pill); background:var(--gg-grad-weave); color:#fff;`

### Input
`height:48px; border:1.5px solid var(--gg-border); border-radius:var(--gg-radius-md); padding:0 16px; font:400 15px var(--gg-font-text); color:var(--gg-ink);`
Focus: `border-color:var(--gg-primary); box-shadow:var(--gg-focus-ring);`
Label: `13px/600 var(--gg-gray-700)`, 6px below.

### Card
`background:var(--gg-surface); border:1px solid var(--gg-border); border-radius:var(--gg-radius-lg); box-shadow:var(--gg-shadow-md); padding:24–28px;`

### Balance card (feature)
`background:var(--gg-grad-deep-weave); color:#fff; border-radius:var(--gg-radius-xl);` with the mark bleeding out of a corner at ~0.35 opacity. Amount in Space Grotesk 600.

### Badge / pill
`height:26px; padding:0 12px; border-radius:var(--gg-radius-pill); font:700 12px var(--gg-font-text);`
Verified → positive bg/fg · Instant/info → sky-50 / sky-600 · Pending → warning bg/fg · Neutral → gray-100 / gray-600.

### Eyebrow
`font:700 12px var(--gg-font-text); letter-spacing:0.12em; text-transform:uppercase; color:var(--gg-sky-600);`

### Progress bar
`height:6px; border-radius:var(--gg-radius-pill); background:var(--gg-gray-100);` fill: `var(--gg-grad-weave)`.

---

## Using with Tailwind (optional)
Map `tokens.json` into `theme.extend.colors` (e.g. `gingham-blue-500`, `sky-400`), `borderRadius`, `boxShadow`, and `fontFamily`. Then build with utility classes that resolve to these tokens instead of arbitrary values.
