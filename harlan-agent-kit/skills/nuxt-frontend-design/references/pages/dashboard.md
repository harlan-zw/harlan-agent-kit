# Dashboard Patterns

Reference: **Linear**

---

## Keyboard First

- **j/k navigation**: Move through lists without mouse
- **Cmd+K palette**: Universal command access via `UCommandPalette`
- **Right-click context menus**: Power users expect them

---

## Density

- **Hierarchy through typography, not color**: Weight/size > rainbow status colors
- **Status indicators > progress bars**: "Done" badge beats 100% bar
- **Data tables over cards**: Cards waste space for data-heavy views

---

## Actions

- **Undo over confirm**: "Deleted. Undo?" toast beats "Are you sure?" dialog
- **Inline editing**: Click to edit, don't navigate away
- **Batch operations**: Checkbox column + bulk action bar on select

---

## State

- **Filters persist in URL**: Refresh doesn't reset, shareable
- **Filter pills**: Active filters as removable tags
- **Saved views**: Let users save filter combinations

---

## Performance

- **Optimistic updates**: UI updates before server confirms
- **Stale-while-revalidate**: Show cached, refresh quietly
- **Zero state = onboarding**: First empty state is setup wizard

---

## Time

- **Smart groups**: "Today", "Yesterday", "This week"
- **Relative timestamps**: "2h ago" not "2024-01-05 14:32"

---

## Layout

```vue
<template>
  <UDashboardLayout>
    <UDashboardSidebar>
      <UNavigationMenu :items="navItems" />
    </UDashboardSidebar>

    <UDashboardMain>
      <UDashboardToolbar>
        <template #left>
          <UBreadcrumb :items="breadcrumbs" />
        </template>
        <template #right>
          <UButton>New Item</UButton>
        </template>
      </UDashboardToolbar>

      <UTable :columns="columns" :rows="items" :loading="pending" />
    </UDashboardMain>
  </UDashboardLayout>
</template>
```

---

## Stat Cards & KPIs

Don't build stat cards from scratch. Copy the primitives in [library.md](../library.md) — `UiStat`, `UiStats`, `UiSparkline`, `UiTrend`, `UiSkeleton`, `UiNoData`. They handle trend direction coloring, invertible metrics (lower-is-better), loading skeletons, status chips, and sparkline backdrops.

### Single KPI

```vue
<UiStat
  icon="i-lucide-trending-up"
  title="MRR"
  :value="42800"
  :format="(n) => `$${(n / 1000).toFixed(1)}k`"
  :trend="8.1"
  trend-suffix="%"
  :sparkline="mrrSeries"
  size="lg"
/>
```

### Stat row (divided)

Header-style stat bar — compact, divided, one row:

```vue
<UiStats
  variant="card"
  :data="[
    { title: 'Revenue', value: 142500, format: (n) => `$${(n / 1000).toFixed(1)}k`, trend: 12.4 },
    { title: 'Users', value: 1284, trend: -2.3 },
    { title: 'Churn', value: 1.2, suffix: '%', trend: -0.4, invertTrend: true },
    { title: 'Signups', value: 87, trend: 22.0 },
  ]"
/>
```

### Stat card grid

Grid of cards with ambient sparklines — richer, landing-style:

```vue
<UiStats
  variant="cards"
  :data="kpis.map(k => ({
    ...k,
    icon: 'i-lucide-activity',
    sparkline: k.history,
    to: `/metrics/${k.slug}`,
  }))"
/>
```

### Loading and empty

- Pass `:loading="pending"` to show a skeleton in place of the value
- When a metric has no data, render `<UiNoData title="No activity yet" message="..." />` instead of an empty card
- For a threshold alert, set `status="crisis"` / `"warning"` / `"good"` for a status chip next to the title

### Metric conventions

- **Invert trend** for lower-is-better metrics (churn, rank, latency, bounce rate): `invertTrend: true` → negative change shows green
- **Neutralize color** when direction is meaningless (population count, token supply): `trendNeutral: true` → trend shows muted color
- **Format callback** takes a raw number; use it consistently across sibling stats so axes visually align
- **Tabular numerals** are built in via `font-mono tabular-nums` — don't override

### Chart hygiene

Dashboards live or die on graphical integrity. Read [polish/data-viz.md](../polish/data-viz.md) before adding any chart beyond a `UiSparkline`. Non-negotiable rules:

- **Bars start at zero.** Always. Truncating a bar's baseline is a lie.
- **No 3D, no perspective, no tilt** on any 2D chart.
- **Kill the default legend.** Echarts/Chart.js/Recharts ship a legend on by default — turn it off (`legend: { show: false }` / `plugins.legend.display: false`) and direct-label the line at its end. Legends force the eye to ping-pong between key and data.
- **No pies or donuts for >5 segments**, ever. For ≤5, a sorted horizontal bar still reads faster. Default to bars; reach for pie only when the user explicitly requests it.
- **Small multiples beat multi-series spaghetti.** If you have >3 series on one chart, split into a grid of panels on a shared scale.
- **No glow, drop shadow, or theme texture on data marks.** Theme voice belongs on the card chrome around the chart, not on the line/bar itself. A glowing bar overstates its magnitude.
- **Direct-label series**, drop the chart-library default tooltip-only labels for headline series.

For sparklines specifically: keep using `UiSparkline` — it already enforces no-axis/no-legend/no-gridline.
