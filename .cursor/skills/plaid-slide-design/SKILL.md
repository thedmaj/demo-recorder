---
name: plaid-slide-design
description: >-
  Plaid Deck Design System for pipeline slide steps. Use when authoring,
  inserting, or fixing `.slide-root` HTML in post-slides, slide-fix, build-qa
  slide touchup, or storyboard slide edits. Cursor mirror — canonical content
  lives in `.claude/skills/plaid-slide-design/SKILL.md`.
---

# Plaid Slide Design (Cursor mirror)

**Canonical skill:** [`.claude/skills/plaid-slide-design/SKILL.md`](../../../.claude/skills/plaid-slide-design/SKILL.md)

This file is a pointer so Cursor agent mode discovers the same skill that
Claude Code agent mode uses. The canonical SKILL.md is loaded by the
pipeline at runtime via
[`scripts/scratch/utils/slide-design-skill.js`](../../../scripts/scratch/utils/slide-design-skill.js)
and injected into every `post-slides` / `slide-fix` LLM call.

## When to load

- Editing `.slide-root` HTML in any `out/demos/*/scratch-app/index.html`
- Touching `templates/slide-template/brand-design-briefs/DECK_*.md`
- Working on `scripts/scratch/scratch/post-slides.js` or `slide-fix.js`
- Diagnosing slide-tier `build-qa` failures (`slide-invented-color`,
  `slide-shell-chrome`, `slide-canvas-size`, `slide-narration-drift`)

## Source of truth

All paths relative to repo root:

| File | Role |
|------|------|
| `templates/slide-template/brand-design-briefs/DECK_DESIGN_SYSTEM.md` | Tokens, fonts, palette, shell, typography ceilings |
| `templates/slide-template/brand-design-briefs/DECK_TEMPLATES.md` | T1–T11 skeletons — pick exactly one per slide |
| `templates/slide-template/brand-design-briefs/DECK_COMPOSITION.md` | Headlines, pacing, background rhythm |
| `templates/slide-template/PIPELINE_SLIDE_SHELL_RULES.md` | DOM merge contract for build + post-slides |
| `templates/slide-template/colors_and_type.css` | CSS custom properties (injected in `<head>`) |
| `templates/slide-template/slide.css` | Scoped rules under `.slide-root` only |
| `templates/slide-template/pipeline-slide-contract.css` | Canvas 1280×800, typography ceilings, host cascade isolation |

Read the canonical SKILL.md for the full SLIDE-vs-HOST hard boundary, the
forbidden/allowed palette, the required DOM shape, and build-QA expectations.

**JSON panel overlay:** Slides must never reserve right padding or shrink for
`#api-response-panel` — it is a fixed overlay (z-index 2100), always collapsed
by default on step navigation.
