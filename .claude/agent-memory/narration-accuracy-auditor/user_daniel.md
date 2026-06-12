---
name: user-daniel
description: Daniel Majetic, Plaid — owner of the demo-recorder pipeline; wants tight high-signal-only narration audits
metadata:
  type: user
---

Daniel Majetic (dmajetic@plaid.com), Plaid. Owns/operates the Plaid Demo Pipeline (`demo-recorder`).

For narration-accuracy audits he wants:
- HIGH-SIGNAL ONLY: recurring drift (same wrong claim in ≥2 runs), missing guardrails that would have prevented an error class, or terminology the KBs should pin. NOT one-off stylistic nits, word-count, or anything existing validators catch.
- Edits land in the specific `inputs/products/<slug>.md` (facts) or `.claude/skills/*/SKILL.md` (sequencing). Never edit CLAUDE.md (thin index).
- All KB/skill edits stay UNCOMMITTED for human review. Gong/sales dollar/percent/threshold stats: add only qualitative framing, HOLD numbers for sign-off.
- Deliverable is a concise report returned as the message (no .md report files).

**How to apply:** Lead with the smallest set of edits that are primary-source-backed and recurring. State explicitly what you did NOT act on and why.
