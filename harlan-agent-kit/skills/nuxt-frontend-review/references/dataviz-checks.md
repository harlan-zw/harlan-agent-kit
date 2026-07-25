# Data Visualization Checks

Run only when the diff touches charts, dashboards, sparklines, stat cards, or quantitative tables. Detect with:

```bash
git diff --name-only "$HASH" | grep -iE '(chart|sparkline|stat|dashboard|graph|metric|trend)' \
  || grep -lEr 'echarts|chart\.js|recharts|d3|UiSparkline|UiStat|UiTrend' {changed_files}
```

Neither matches, skip this block.

Underlying principles live in the sibling design skill: `../nuxt-frontend-design/references/polish/data-viz.md` relative to `${CLAUDE_SKILL_DIR}`. They are authoritative: when a theme's aesthetic conflicts with graphical integrity on a data mark, integrity wins.

Scope is the **plot interior** (data marks, axes, gridlines, in-plot labels). The card or panel chrome around the chart is governed by the project theme and is out of scope here.

## [HARD REJECT]

- **Lie Factor distortion**: bar chart with non-zero baseline; 3D effect on 2D data; bubble area scaled by radius; dual-axis implying correlation; visual size disproportionate to value.
- **Misleading truncation**: y-axis truncated without a break marker while the chart is framed as magnitude rather than rate-of-change.
- **Pie/donut with >5 slices or unsorted segments**: replace with a sorted bar or labelled table.

## [RUBRIC]

- **Chartjunk inside the plot**: heavy gridlines, chart borders, plot-background fills, shadows/glow/texture on data marks, moiré patterns, decorative icons in the plot area. Theme effects on the surrounding card are fine; on the data mark they distort perceived magnitude.
- **Default legend left on**: a legend rendering on a chart with ≤3 series that should be direct-labelled. Inspect the config; the legend should be explicitly disabled.
- **Eraser-test failures**: legend duplicating direct labels; numeric labels and tick marks for the same values; per-panel scale annotations duplicating a shared-scale caption.
- **Collision failures**: in-plot annotations crossing data marks or other text; band/epoch labels stacked at axis zero; baseline labels overlapping leftmost data points.
- **Sparkline malpractice**: axes, gridlines, or legend on a sparkline; height not matching surrounding line-height; used standalone rather than inline with a number.
- **Missing comparison**: a single number with no delta, baseline, peer value, or sparkline answering "compared to what?".
- **Color-only encoding**: trend or category by color alone; deltas without an arrow or sign.
- **Table numerics**: number columns not right-aligned, or missing `tabular-nums`.
- **Duplicate primitive**: a hand-rolled sparkline or stat card when the project already has one. Check `app/components/` for an existing `UiSparkline`/`UiStat` equivalent first; a parallel implementation is a RUBRIC unless materially different.

Cite file:line and the principle violated (lie factor, data-ink, chartjunk, eraser test, collision test, small-multiples, sparkline).
