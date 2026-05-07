---
name: plaid-integration
description: >-
  Pointer to the canonical Plaid integration skill ZIP injected by the demo pipeline
  (research + build). Use when editing technical baseline content for demos.
disable-model-invocation: true
---

# Plaid integration skill (canonical bundle)

**Authoritative content** for API flows, Link setup, and product references lives in the repo archive:

- [`skills/plaid-integration.skill`](../../../skills/plaid-integration.skill) — ZIP consumed by [`scripts/scratch/utils/plaid-skill-loader.js`](../../../scripts/scratch/utils/plaid-skill-loader.js).

The pipeline loads excerpts into research and build prompts automatically; do not duplicate long prose here. Update the ZIP (and `api_version` / `last_verified` comments inside markdown members), then run `npm run validate:plaid-skill` to confirm the bundle exists and record SHA256 drift.

See also [`.claude/skills/plaid-integration-bundle/SKILL.md`](../../../.claude/skills/plaid-integration-bundle/SKILL.md) for the Claude Code mirror.
