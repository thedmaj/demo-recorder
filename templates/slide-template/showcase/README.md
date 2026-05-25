# tmp-showcase — Plaid × Workhorse slide template review

Temporary scaffold for reviewing the **20 distinct templates** the hybrid skill
([`plaid-workhorse-slides`](../.claude/skills/plaid-workhorse-slides/SKILL.md))
can produce. Strictly Plaid-branded: no Workhorse themes, no `runtime.js`, no
Chart.js — same contract that pipeline slides honor.

## Open it

```bash
open tmp-showcase/index.html
```

(Or any local browser — fonts and logos resolve via symlinks back to
`templates/slide-template/`.)

Keyboard: `↑` `↓` / `j` `k` / `Space` to advance. `Home` / `End` to jump. Click
any sidebar entry to jump directly. The current template's name, skill mapping,
"when to use", and "avoid when" appear above each slide.

## Files

- `index.html` — the showcase. 20 templates with sidebar nav + per-template
  metadata. Plaid-branded; SVG-only charts.
- `STATUS.md` — your review surface. Fill in **Decision** and **Notes** for
  each template; the agent can later read this file to refine the skill.
- Symlinks to `colors_and_type.css`, `slide.css`, `pipeline-slide-contract.css`,
  `fonts/`, and `assets/` — sourced from `templates/slide-template/`.

## What each template costs

Counted per template in [`STATUS.md`](STATUS.md). T1–T11 are the canonical
Plaid Deck Design System templates already documented in
[`DECK_TEMPLATES.md`](../templates/slide-template/brand-design-briefs/DECK_TEMPLATES.md).
The other nine are Workhorse-derived patterns the hybrid skill borrows from
[`html-ppt`](../.agents/skills/tosea-slide-workhorse/) layout library.

## How to use this review

1. Walk all 20.
2. Mark `keep` / `remove` / `rename` / `needs-guidance` in `STATUS.md`.
3. Edit the "when to use" notes inline if they're not crisp enough.
4. Ask the agent to fold the decisions back into:
   - [`.claude/skills/plaid-workhorse-slides/SKILL.md`](../.claude/skills/plaid-workhorse-slides/SKILL.md) (routing table + guidance)
   - [`DECK_TEMPLATES.md`](../templates/slide-template/brand-design-briefs/DECK_TEMPLATES.md) (T-number set, if any T# is being added/removed)
   - [`PIPELINE_SLIDE_SHELL_RULES.md`](../templates/slide-template/PIPELINE_SLIDE_SHELL_RULES.md) (only if the DOM contract changes)

## When you're done

```bash
rm -rf tmp-showcase/
```

(The directory is intentionally not in any test or build path — removing it
has no production consequence.)
