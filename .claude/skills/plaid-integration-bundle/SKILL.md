---
name: plaid-integration-bundle
description: >-
  Canonical Plaid integration skill bundle (ZIP) for the demo pipeline — same source as Cursor;
  edit skills/plaid-integration.skill, not this stub.
disable-model-invocation: true
---

# Plaid integration bundle (pipeline)

One source of truth:

- **Archive:** `skills/plaid-integration.skill` (bundled markdown under `plaid-integration/` inside the ZIP).
- **Loader:** `scripts/scratch/utils/plaid-skill-loader.js` selects excerpts by product family + prompt keywords.

Human or agent edits should modify files inside the ZIP (or rebuild the ZIP), bump inline `api_version` / `last_verified` stamps where relevant, then validate:

```bash
npm run validate:plaid-skill
```

Optional AskBill smoke (requires AskBill MCP / env as for the pipeline):

```bash
node scripts/validate-plaid-integration-skill.js --smoke-askbill
```

Cursor users: see `.cursor/skills/plaid-integration/SKILL.md` for the same pointer.
