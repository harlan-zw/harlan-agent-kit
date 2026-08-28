# Stats page build contract

## What will be built

- A `/stats` dashboard page.
- An authenticated `/api/stats` endpoint.
- URL backed 7, 30, and 90 day range controls.
- A custom date range with visible validation.
- Outcome totals with previous period comparisons.
- Daily outcome charts with direct labels and zero baselines.
- A work results chart and accessible detail table.
- History links that preserve the selected dates and work type.
- Durable pull request triage records for future Stats coverage.

## Testable behaviours

- [C1] GIVEN no query dates, WHEN Stats opens, THEN the URL and page use the last 30 days.
- [C2] GIVEN a preset, WHEN it is selected, THEN the URL and all Stats use that range.
- [C3] GIVEN custom dates, WHEN Apply is selected, THEN the API receives exact range instants.
- [C4] GIVEN a reversed custom range, WHEN Apply is selected, THEN the page shows a field error.
- [C5] GIVEN a work row, WHEN its History link is selected, THEN History receives matching dates and work.
- [C6] GIVEN Stats is loading, WHEN data has not arrived, THEN the page shows a loading state.
- [C7] GIVEN no completed work, WHEN data arrives, THEN the page explains that the range is empty.
- [C8] GIVEN the Stats request fails, WHEN the page settles, THEN it shows the failure and a Retry control.
- [C9] GIVEN a 375px viewport, WHEN Stats opens, THEN controls stack and every target is at least 44px.
- [C10] GIVEN a 768px viewport, WHEN Stats opens, THEN charts remain readable without horizontal page scroll.
- [C11] GIVEN dark mode, WHEN Stats opens, THEN every label and data mark retains WCAG AA contrast.
- [C12] GIVEN keyboard navigation, WHEN focus moves through controls, THEN order follows dates, presets, charts, and table.
- [C13] GIVEN server rendering, WHEN `/stats` HTML loads, THEN it contains the Stats heading and range controls.
- [C14] GIVEN a published Repair, WHEN its range loads, THEN fix commits and one changed pull request increase.
- [C15] GIVEN a staged or failed Publication command, WHEN its range loads, THEN delivered totals do not increase.
- [C16] GIVEN one Review settlement, WHEN its range loads, THEN the original Review counts once.
- [C17] GIVEN legacy pull request triage history, WHEN Stats loads, THEN the page marks partial coverage.

## Design expectations

Use the existing minimal control room theme.

The page prioritizes hierarchy over uniformity.

One outcome statement leads. Compact supporting facts follow.

Charts use neutral data marks and primary only for the focal result.

Bars start at zero. Every series uses direct labels.

The detail table carries exact values for assistive technology.

## Out of scope

- A combined value score.
- Agent rankings.
- Monetary savings.
- External analytics.
- Human time tracking.
- A new chart dependency.
