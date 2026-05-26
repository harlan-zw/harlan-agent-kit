# Data Visualization (Tufte)

Load when building or polishing charts, sparklines, stat cards, dashboards, tables, or any quantitative display. Distilled from *Visual Display of Quantitative Information*, *Envisioning Information*, *Beautiful Evidence*.

## Decide before drawing

1. **What comparison does the user need?** Time vs time, group vs group, part vs whole, distribution, rank. The comparison dictates the form, not the other way around.
2. **What is the key insight?** State it as a sentence. If the chart doesn't make that sentence visible at a glance, redesign.
3. **What's the audience's read budget?** A landing-page stat gets 1 second; an analyst dashboard gets 30. Density scales with that budget.

## Form selection

| Need | Form | Avoid |
|------|------|-------|
| Many series, same scale | Small multiples | One chart with 8 lines and a legend |
| Inline trend with a number | Sparkline (no axes, no labels) | Full chart for a single 12-point series |
| Time series | Line, minimal grid | Area chart unless cumulative |
| Part-to-whole, ≤5 parts | Stacked bar or labelled table | Pie / donut |
| Part-to-whole, >5 parts | Table sorted by value | Anything circular |
| Rank ordering | Horizontal bar | Vertical bar with rotated labels |
| Distribution | Strip plot, histogram, ECDF | Box plot for general audiences |
| Single number with context | Stat card with sparkline + delta | Number floating alone |

## Graphical integrity (hard requirements)

- **Lie Factor ≈ 1.0.** Visual size of an effect = numerical size. Bar charts MUST start at zero. Line charts MAY truncate the y-axis if the truncation is labelled and the comparison is rate-of-change, not magnitude.
- **No 3D for 2D data.** Perspective distorts area; tilt distorts position. Banned outright for bars, pies, lines.
- **One scale per axis.** Dual-axis charts compare nothing honestly; split into small multiples.
- **Area encodes area, length encodes length.** Bubble charts use sqrt scaling, never linear-on-radius.
- **Baselines visible.** When zero is the baseline, draw it. When it isn't, label the truncation.

## Scope: plot interior vs surrounding chrome

These rules apply to the **plot interior**: data marks, axes, ticks, gridlines, in-plot labels, plot background. The surrounding card, header, padding, shadow, and panel chrome follow the project's theme. A `kinetic-paper` card may have paper shadow; the line inside it still must not.

Specifically, theme signature tokens (`--shadow-brutal`, `--shadow-clay`, `--shadow-glass`, mesh/glow) are allowed on the **card** that contains the chart and must not be applied to **data marks** (lines, bars, points, areas). A glow on a bar inflates its perceived size — that is a lie factor violation regardless of theme voice.

## Data-ink ratio (plot interior only)

Every pixel inside the plot must encode data or directly support reading it. Erase or fade everything else.

- Drop chart borders, plot background fills, heavy gridlines, redundant tick labels.
- **Series color**: focal series gets the brand accent; non-focal series recede to muted/neutral. This is a within-chart hierarchy rule, not a "make the UI grayscale" rule — the chart's accent should match the project's `colors.primary`, not invent its own.
- Direct-label series at the line end; remove the chart library's default legend. Echarts/Chart.js/Recharts ship legends by default — turn them off and label inline.
- Range-frame axes: draw the axis only across the data's actual range, not the full canvas.
- Replace shaded plot backgrounds with thin reference lines or marginal notes.
- Numeric labels and a tick mark for the same value is duplicate ink — keep one.

## Eraser test

Before shipping a chart, walk each element (gridline, label, tick, border, annotation, legend, panel title): can it be erased without losing information that isn't already conveyed elsewhere? If yes, erase it.

## Collision test

Mentally draw a bounding box around every text element in the plot. Anything crossing it — another label, a data line, a dense marker cluster — is a collision.

Fixes: move prose to the figcaption; move band/epoch labels to a strip above the plot; push baseline labels to the outer margin; give in-plot annotations a leader line. Watch especially: inverted axes, shared-scale small multiples (labels stack near zero in every panel), dense scatter.

## Small multiples

When comparing >2 series, prefer N small charts on a shared scale over 1 chart with N series. Sort the panels by something meaningful (magnitude, similarity), not alphabetically. Share x and y scales across panels unless explicitly noting otherwise.

## Sparklines

Tiny, word-sized, intense. Used inline with the number they qualify, not as standalone art.

- No axes, no gridlines, no legend.
- Mark the current/last value with a dot, optionally the min/max.
- Height: match the surrounding line-height (16–24px).
- Width: enough to show the shape, ~80–160px.
- Color: the focal series in the brand accent; min/max dots in red/green only when those carry meaning.

The project ships `UiSparkline` in `references/library.md`; prefer it over hand-rolling.

## Layering & separation

Primary data dominates; secondary context recedes. Use opacity, weight, and grayscale — not color — to express hierarchy. A 30% grey gridline reads as context; a black gridline competes with the data.

## Micro/macro readings

A good display rewards both glance and study. Stat cards: the big number for glance, the sparkline + delta for study. Dashboards: the layout for glance, the per-tile detail for study. If the design only works at one read distance, it's incomplete.

## Tables are charts too

For ≤20 rows of dense quantitative data, a well-typeset table beats a chart. Right-align numbers, monospace digits (`font-variant-numeric: tabular-nums`), sort by the column that carries the insight, lighten gridlines until they recede.

## Project surfaces this applies to

- **Stat cards** (`UiStat`, `UiStats`): number, label, delta, optional sparkline. Delta uses one accent for positive, one for negative — no traffic-light gradients.
- **Sparklines** (`UiSparkline`): see above.
- **Dashboards** (`references/pages/dashboard.md`): apply small-multiples thinking before reaching for a tabbed chart switcher.
- **Tables** (`references/components/tables.md`): tabular-nums, right-align numerics, lighten borders, sort by insight column.
- **Trend indicators** (`UiTrend`): direction + magnitude, never just direction.

## Quick checklist (pre-ship)

- [ ] Lie Factor ≈ 1.0; no truncated baselines on bars; no 3D
- [ ] Every element passes the eraser test
- [ ] Every label passes the collision test
- [ ] Maximum data-ink ratio; grayscale default, accent earns its color
- [ ] Answers "compared to what?" (delta, baseline, or peer series visible)
- [ ] Direct labels on series; legend removed where possible
- [ ] Micro + macro readings both work
- [ ] Sparklines use `UiSparkline`; stat cards use `UiStat`
- [ ] Tables use tabular-nums and right-aligned numerics
