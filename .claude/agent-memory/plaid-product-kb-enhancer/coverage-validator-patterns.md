---
name: coverage-validator-patterns
description: How simulate-product-knowledge.js scores KB sections; what formatting the scanner requires to register a section as "present"
metadata:
  type: reference
---

# Coverage Validator Patterns

**Tool:** `node scripts/scratch/simulate-product-knowledge.js --slug=<slug> --dry-run`

## How it scores sections

The validator (`scripts/scratch/utils/product-knowledge-coverage.js`) requires each section to meet a `minBullets` threshold:

| Section | Min bullets | minChars |
|---|---|---|
| valuePropositions | 3 | — |
| customerUseCases | 2 | — |
| narrationTalkTracks | 1 | — |
| accurateTerminology | 4 | — |
| competitiveDifferentiators | 2 | — |
| proofPoints | 2 | — |
| objectionsResponses | 1 | — |
| implementationPitfalls | 1 | — |
| overview | 0 | 80 |
| whereItFits | 0 | 80 |

**What counts as a "bullet":** Lines matching `/^[-*]\s+/` or `/^\|.*\|/` (table rows). Blockquotes (`>`), bold text (`**`), sub-headings (`###`), and plain paragraphs do NOT count.

## Common failure patterns

- Files with `### Use Case Name` + `**Persona:** ...` format → 0 bullets counted even though content exists
- Files with `> "narration text"` blockquotes in Narration Talk Tracks → 0 bullets
- Fix: add `-` bullet summary lines at the top of each section before the detailed sub-sections

## Heading aliases

Custom KB headings can be registered in `inputs/products/_heading-aliases.json`. Files that use non-canonical headings (e.g., Protect uses its own structure) should have aliases registered there — don't restructure the file just for the scanner.

## Running the check

```bash
# Single product
node scripts/scratch/simulate-product-knowledge.js --slug=signal --dry-run

# All 15 products at once
for slug in auth bank-income cra-base-report cra-cashflow-insights cra-lend-score ewa-score identity-verification income-insights investments-move investments layer liabilities protect signal transfer; do
  result=$(node scripts/scratch/simulate-product-knowledge.js --slug=$slug --dry-run 2>&1 | grep -E "^Present:|^Confidence:|^Blocking")
  echo "$slug | $result"
done
```

## Target state

All 15 slugs: `Present: 10/10`, `Confidence: high`, `recommendedMode: skip`
