# Dashboard build contract

## Build

Build one Nuxt dashboard for repository, subject, task, mutation, and connection state. Use the DevTool design system.

## Behaviors

- [C1] GIVEN the page opens, WHEN the API responds, THEN current repository, subject, and task counts render.
- [C2] GIVEN live updates connect, WHEN state changes, THEN the visible data updates without a page reload.
- [C3] GIVEN live updates disconnect, WHEN the connection fails, THEN the header shows Reconnecting.
- [C4] GIVEN a repository filter, WHEN text changes, THEN repository rows filter by GitHub name.
- [C5] GIVEN subject type controls, WHEN one is selected, THEN only that subject type renders.
- [C6] GIVEN a GitHub subject, WHEN its title is activated, THEN GitHub opens in a new tab.
- [C7] GIVEN fresh data is loading, WHEN no prior state exists, THEN loading panels preserve layout.
- [C8] GIVEN the API fails, WHEN state cannot load, THEN a visible error explains the next action.
- [C9] GIVEN no repositories, subjects, or tasks exist, WHEN data loads, THEN each region shows its own empty state.
- [C10] GIVEN a 375px viewport, WHEN the dashboard renders, THEN summary and activity rows stack without horizontal page overflow.
- [C11] GIVEN a 768px viewport, WHEN the dashboard renders, THEN the repository table retains readable columns.
- [C12] GIVEN dark mode, WHEN system preference changes, THEN the dashboard uses dark semantic surfaces and readable text.
- [C13] GIVEN keyboard navigation, WHEN Tab advances, THEN every control and subject link has a visible focus indicator.
- [C14] GIVEN generated HTML before hydration, WHEN inspected, THEN the page title, headings, and empty shell are present.

## Design expectations

Use compact table led composition, dashed schematic structure, IBM Plex typography, and semantic state text. Operational clarity has priority over visual softness.

## Out of scope

No mutation controls, review dispatch, charts, webhook ingress, or invented historical metrics.
