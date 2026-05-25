---
name: plaid-workhorse-slides
description: >-
  Hybrid slide authoring for the demo pipeline: Workhorse layout patterns inside
  Plaid Deck Design System branding. Cursor mirror — canonical content lives in
  `.claude/skills/plaid-workhorse-slides/SKILL.md`.
---

# Plaid × Workhorse slides (Cursor mirror)

**Canonical skill:** [`.claude/skills/plaid-workhorse-slides/SKILL.md`](../../../.claude/skills/plaid-workhorse-slides/SKILL.md)

**Workhorse layout assets:** [`.claude/skills/tosea-slide-workhorse/`](../../../.claude/skills/tosea-slide-workhorse/)

This file is a pointer so Cursor agent mode discovers the same hybrid skill that
Claude Code uses. The pipeline injects it via
[`scripts/scratch/utils/slide-design-skill.js`](../../../scripts/scratch/utils/slide-design-skill.js)
alongside **plaid-slide-design**.

## Quick rules

1. **Pick Workhorse layout** at runtime (`data-workhorse-layout`) for structure.
2. **Always Plaid brand** — tokens, fonts, chrome; never Workhorse themes.
3. **Pipeline:** static slides, SVG charts only, no `runtime.js` / animations.
4. Set nearest **`data-slide-template="T#"`** for build-QA metadata.

Read the canonical SKILL.md for the layout routing table, token bridge, and DOM contract.
