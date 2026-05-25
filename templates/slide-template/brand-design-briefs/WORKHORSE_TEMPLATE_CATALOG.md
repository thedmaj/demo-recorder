# Workhorse × Plaid template catalog (pipeline)

> Canonical routing table for hybrid slide authoring. Sourced from
> `templates/slide-template/showcase/index.html` + `showcase/STATUS.md` (May 2026).
> Use with [`.claude/skills/plaid-workhorse-slides/SKILL.md`](../../../.claude/skills/plaid-workhorse-slides/SKILL.md).

Every pipeline slide sets **both**:

- `data-slide-template="T1"…"T11"` — nearest Plaid Deck template (build-QA metadata)
- `data-workhorse-layout="<name>"` — actual Workhorse html-ppt layout used

## Showcase templates (20 → T1–T11)

| # | Showcase name | Category | `data-workhorse-layout` | `data-slide-template` | When to use |
|---|---------------|----------|-------------------------|----------------------|-------------|
| 01 | Title Hero | Opening | `cover` | T1 | Deck open / product hero |
| 02 | Section Beat | Opening | `section-divider` | T2 | Chapter break between story beats |
| 03 | Statement Slide | Explainer | `bullets` or `two-column` | T3 | One idea + supporting body |
| 04 | Bullet List | Explainer | `bullets` | T3 | Feature list, proof points |
| 05 | Three Pillars | Explainer | `three-column` | T5 | Three parallel value props |
| 06 | Big Pull Quote | Explainer | `big-quote` | T3 | Narrator quote / customer voice |
| 07 | Triple Stat | Metrics | `stat-highlight` | T4 | 2–3 hero metrics |
| 08 | KPI Grid | Metrics | `kpi-grid` | T4 | Dashboard-style KPI tiles |
| 09 | Data Table | Metrics | `table` | T7 | Tabular comparison / API fields |
| 10 | Bar Chart Insight | Metrics | `chart-bar` | T4 | Magnitude comparison (SVG only) |
| 11 | Before / After | Comparison | `comparison` | T6 | Side-by-side outcome shift |
| 12 | Old Way vs New Way | Comparison | `comparison` | T7 | Process contrast |
| 13 | Step Flow | Flow | `process-steps` | T8 | Numbered integration steps |
| 14 | Flow Diagram | Flow | `flow-diagram` | T8 | Arrows / nodes between systems |
| 15 | Architecture Map | Flow | `arch-diagram` | T9 | System boxes + connectors |
| 16 | Timeline | Plans | `timeline` | T8 | Dated milestones |
| 17 | Roadmap | Plans | `roadmap` | T11 | Future phases / quarters |
| 18 | Proof Quote | Proof | `customer-proof` | T10 | Logo bar + testimonial |
| 19 | Code Window | Proof | `code` | T3 | API snippet / JSON highlight |
| 20 | Action Cards | Close | `cta` | T11 | Next steps / recap CTAs |

## Logo + chrome (production — not showcase preview)

Showcase HTML scales `.chrome-logo` to ~140px for gallery readability. **Pipeline recordings use 28px** via `slide.css` + `pipeline-slide-contract.css`:

```css
.slide-root .chrome-logo {
  position: absolute;
  top: calc(var(--pad-top) - 75px); /* 75px above topmost text row */
  right: var(--pad-x);              /* top-right, not top-left */
  height: 28px;
  width: auto;
  opacity: 0.85;
}
```

- Do **not** inline `style="left:…"` or oversized `height:` on `.chrome-logo`.
- T1 title slides may omit `.chrome-logo` entirely.

## Workhorse layouts omitted from showcase (still valid ad-hoc)

| Layout | Reason omitted | Pipeline note |
|--------|----------------|---------------|
| `toc` | Plaid decks rarely use TOC slides | Internal decks only |
| `chart-line`, `chart-pie`, `chart-radar` | Bar/table cover most needs | SVG rebuild required |
| `diff`, `terminal` | Niche engineering | Use `code` layout instead |
| `mindmap` | Hard to recolor for Plaid | Prefer `arch-diagram` |
| `gantt` | Heavier than `timeline` | Engineering reviews |
| `pros-cons` | `comparison` is crisper | Allowed when narrative fits |
| `todo-checklist` | Operational, not customer-facing | Avoid in demos |
| `image-hero`, `image-grid` | Rare in Plaid product demos | Avoid |
| `thanks` | `cta` is a stronger close | Prefer T11 `cta` |

## Reference files

| File | Role |
|------|------|
| `templates/slide-template/showcase/index.html` | Live preview of all 20 templates |
| `templates/slide-template/slide.css` | Production logo + shell CSS |
| `templates/slide-template/pipeline-slide-contract.css` | Canvas + logo enforcement |
| `brand-design-briefs/DECK_TEMPLATES.md` | T1–T11 Plaid skeletons |
