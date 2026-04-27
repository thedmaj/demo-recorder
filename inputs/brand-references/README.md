# Brand reference library

Verified facts about specific customer brands the demo pipeline should match
when generating host UI. Each file is hand-curated by maintainers and
overrides anything the auto-crawl in `brand-extract.js` produces (so a stale
or noisy crawl can't poison the prompt).

## File format

```yaml
---
brand: <human name>            # required
slug: <kebab-case-slug>        # required, must match brand-extract output
last_verified: YYYY-MM-DD      # required
canonical_url: https://...     # required
---

# <brand name> — verified UI facts

## Nav (online banking, post-login)
- Item 1 | Item 2 | Item 3 | …

## Hero / hero-area copy patterns
- "Greeting, [FirstName]"
- Other recurring hero strings

## Footer disclosures (verbatim — DO NOT paraphrase)
- "Member FDIC. Equal Housing Lender."
- "© 2026 <brand> Corporation. All rights reserved."

## Transaction feed format
- Sample line, e.g. "BANK OF AMERICA DES:DIRECT DEP CO ID:9000123456 INDN:..."

## Account number masks
- Convention, e.g. `••••XXXX` (4 visible, mid-dot bullets prefix)

## Brand motifs
- Distinctive visual elements (logo placement, tagline, color stripe)
```

## Loading order

1. `brand-extract.js` runs the auto-crawl first.
2. If `inputs/brand-references/<slug>.md` exists, its facts MERGE on top
   (file wins for any explicitly declared field).
3. The merged profile is saved as the run's brand profile.
4. `prompt-templates.js` renders verbatim disclosures + nav items into the
   build prompt under "HOST APP NAV" / "HOST APP FOOTER" sections.

## Maintainer guidance

- **Don't ship anything you can't verify with a screenshot.** Real customer
  pages change; pin a `last_verified` date and refresh quarterly.
- **Footer disclosures are regulatory.** Customers can be fined for
  misrepresenting FDIC / Equal Housing Lender / NMLS text. Capture verbatim.
- **Skip facts you're unsure about.** Empty sections are fine; the build
  prompt degrades gracefully when a field is absent.
