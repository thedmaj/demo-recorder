# Slide template review — STATUS

> Temporary file under `tmp-showcase/`. Edit the **Decision** and **Notes**
> columns as you walk through `index.html`. When done, the agent can use this
> file to update `.claude/skills/plaid-workhorse-slides/SKILL.md`,
> `templates/slide-template/brand-design-briefs/DECK_TEMPLATES.md`, and the
> Workhorse routing table accordingly.

Decision values: `keep` · `remove` · `rename` · `needs-guidance` · `merge-with-XX`

| #  | Template name           | Category        | Skill mapping                       | Decision         | Notes / rename / when-to-use refinement                          |
|----|-------------------------|-----------------|-------------------------------------|------------------|------------------------------------------------------------------|
| 01 | Title Hero              | Opening         | T1 · Workhorse: cover               |                  |                                                                  |
| 02 | Section Beat            | Opening         | T2 · Workhorse: section-divider     |                  |                                                                  |
| 03 | Statement Slide         | Explainer       | T3 · Workhorse: bullets/two-column  |                  |                                                                  |
| 04 | Bullet List             | Explainer       | aliases T3 · Workhorse: bullets     |                  |                                                                  |
| 05 | Three Pillars           | Explainer       | T5 · Workhorse: three-column        |                  |                                                                  |
| 06 | Big Pull Quote          | Explainer       | aliases T3 · Workhorse: big-quote   |                  |                                                                  |
| 07 | Triple Stat             | Metrics & Data  | T4 · Workhorse: stat-highlight      |                  |                                                                  |
| 08 | KPI Grid                | Metrics & Data  | aliases T4 · Workhorse: kpi-grid    |                  |                                                                  |
| 09 | Data Table              | Metrics & Data  | aliases T7 · Workhorse: table       |                  |                                                                  |
| 10 | Bar Chart Insight       | Metrics & Data  | aliases T4 · Workhorse: chart-bar   |                  |                                                                  |
| 11 | Before / After          | Comparison      | T6 · Workhorse: comparison          |                  |                                                                  |
| 12 | Old Way vs New Way      | Comparison      | T7 · Workhorse: comparison          |                  |                                                                  |
| 13 | Step Flow               | Flow            | T8 · Workhorse: process-steps       |                  |                                                                  |
| 14 | Flow Diagram            | Flow            | aliases T8 · Workhorse: flow-diagram|                  |                                                                  |
| 15 | Architecture Map        | Flow            | T9 · Workhorse: arch-diagram        |                  |                                                                  |
| 16 | Timeline                | Plans           | aliases T8 · Workhorse: timeline    |                  |                                                                  |
| 17 | Roadmap                 | Plans           | aliases T11 · Workhorse: roadmap    |                  |                                                                  |
| 18 | Proof Quote             | Proof           | T10 · Workhorse: customer-proof     |                  |                                                                  |
| 19 | Code Window             | Proof           | aliases T3 · Workhorse: code        |                  |                                                                  |
| 20 | Action Cards            | Close           | T11 · Workhorse: cta                |                  |                                                                  |

## Overall notes

(Add deck-level observations here — e.g. "we never need pull quotes" or
"add a fifth Comparison variant for product family rollouts".)

## Templates considered but not shown

Workhorse layouts intentionally omitted from this showcase (still discoverable
via the canonical Workhorse skill if needed). Mark as **add** if any should be
promoted into the hybrid library:

| Workhorse layout       | Reason omitted                                                | Add? |
|------------------------|---------------------------------------------------------------|------|
| toc                    | Plaid decks have not historically used a table-of-contents.   |      |
| chart-line             | SVG variant of Bar Chart Insight covers most needs.           |      |
| chart-pie              | Pies under-represent magnitude; rarely the right call.        |      |
| chart-radar            | Specialized; product comparisons usually fit Data Table.      |      |
| diff                   | Engineering-specific; covered ad-hoc inside Code Window.      |      |
| terminal               | Same niche as Code Window; consolidate?                       |      |
| mindmap                | Looks great in Workhorse, hard to recolor for Plaid brand.    |      |
| gantt                  | Heavier than Timeline; consider for engineering reviews only. |      |
| pros-cons              | Two-column thinking — Before/After does this more crisply.    |      |
| todo-checklist         | Internal/operational; rarely a customer-facing slide.         |      |
| image-hero             | Plaid decks rarely use full-bleed imagery on slide steps.     |      |
| image-grid             | Same as image-hero.                                           |      |
| thanks                 | Action Cards is a stronger close than a thanks slide.         |      |
