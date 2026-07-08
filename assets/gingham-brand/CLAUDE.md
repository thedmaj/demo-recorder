# Gingham brand — instructions for Claude Code

When building any Gingham UI in this repo, follow the brand system in `gingham-brand/`.

**Always:**
- Import `gingham-brand/gingham.css` once at the app root and style with `var(--gg-*)` tokens — never hard-code hex values, radii, or shadows.
- Read `gingham-brand/GINGHAM_BRAND.md` for logo usage, color/type rules, voice, and component recipes before creating new components.
- Load the two brand fonts (Space Grotesk for display/headlines/money, Hanken Grotesk for body/UI) from Google Fonts.
- Keep surfaces white-first with blue accents; one dominant primary action per screen.
- Use `gingham-brand/logo.svg` for the mark (locked colorway — do not recolor).

`gingham-brand/tokens.json` holds the same values in machine-readable form.

**Choose the approach that fits this repo:**
- **Tailwind repo** → merge `gingham-brand/tailwind.config.js` (`theme.extend`) into the project config and build with `bg-gg-primary`, `text-gg-ink`, `rounded-gg-lg`, `shadow-gg-md`, `font-display`, `bg-gradient-weave`, etc. Still import `gingham.css` — the utilities resolve to its variables.
- **Plain CSS / CSS-in-JS repo** → import `gingham.css` and reference `var(--gg-*)` directly, or read raw values from `tokens.json`.

`gingham-brand/brand-spec.html` is a static, self-contained visual reference — open it in a browser to see the system rendered. It links `gingham.css`, so it doubles as a live check that the tokens are correct.
