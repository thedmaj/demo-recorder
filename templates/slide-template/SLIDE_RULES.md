# Slide Template Rules (Plaid-only)

## Purpose
Slides are a supplement to PowerPoint in presentations. They must be visually consistent across pipeline runs and should be directly readable in both remote calls and in-person rooms.

## Key principles
1. **Plaid-only styling**: use Plaid design-system tokens from `CLAUDE.md` (dark navy background, Plaid teal accent `#00A67E`, white primary text).
2. **Stable type scale**: never “random” font sizes. Match:
   - slide title: large, bold (recommended 40–48px)
   - subtitle/body: 14–18px range with max line length ~55–65ch
   - endpoint text: mono font
3. **Safe area / crops**: maintain consistent padding so content is not clipped by projector overscan.
4. **Consistency over novelty**: match one of the existing panel patterns (hero + panels + optional callout).

## Required structure (HTML contract)
When generating a slide step, use:
- `.slide-root` as the full surface container
- `.slide-header` with:
  - `.slide-header-pill` containing `PLAID`
  - `.slide-header-endpoint` containing the endpoint being described (e.g. `POST /auth/get`)
- `.slide-body` containing:
  - `.slide-hero` with `.slide-title` and optional `.slide-subtitle`
  - optional `.slide-panels` with one or more `.slide-panel`
  - optional `.slide-callout`

## Agent constraints
- Do **not** use host-app branding (no TD shell layout, no TD colors).
- Do **not** invent new layout patterns for every slide; reuse `.slide-panel` and `.slide-callout`.
- Slides should avoid heavy tables; if data must be shown, prefer a panel with 3–6 short bullets.

## Presentation checklist
- Ensure all text remains legible at 125% zoom.
- Keep paragraphs short: prefer 1–2 sentences per block.
- Use accents only for emphasis (badges, callouts, endpoints).

