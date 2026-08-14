# Agent and queue dashboard

## Build

- Put active agents at the top of the dashboard.
- Show live agent role, provider, session, task state, lease, subject, and latest known progress.
- Show recent review agents with outcome, gates, findings, timing, model, commit, and published comment.
- Show an ordered Queue for active work, decisions, review work, and issue triage.
- Keep repositories and open subjects as lower priority operational detail.
- Link every repository, subject, commit, publication, agent context, and Queue entry to its source or detail section.

## Behaviours

- [C1] GIVEN an active agent, WHEN the dashboard loads, THEN its full activity panel appears before the Queue.
- [C2] GIVEN no active agents, WHEN the dashboard loads, THEN a clear idle state appears before the Queue.
- [C3] GIVEN Queue entries, WHEN the dashboard loads, THEN entries appear in engine priority order with numbered positions.
- [C4] GIVEN an outside pull request needs approval, WHEN Review is clicked, THEN progress and errors remain visible inline.
- [C5] GIVEN an agent or Queue entry, WHEN its subject link is clicked, THEN GitHub opens in a new tab.
- [C6] GIVEN a review publication, WHEN its link is clicked, THEN the exact GitHub comment opens.
- [C7] GIVEN a review commit, WHEN its link is clicked, THEN the relevant GitHub commit opens.
- [C8] GIVEN an SSE update, WHEN agent, Queue, review, or repository state changes, THEN the visible data updates without reload.
- [C9] GIVEN an SSE interruption, WHEN the connection reconnects, THEN the header shows the connection state.
- [C10] GIVEN initial loading, WHEN data is pending, THEN stable skeletons replace agent and Queue content.
- [C11] GIVEN state loading fails, WHEN the error appears, THEN Retry reloads the state.
- [C12] GIVEN no Queue entries, WHEN the dashboard loads, THEN the Queue explains that no work is waiting.
- [C13] GIVEN a 375px viewport, WHEN the dashboard loads, THEN agent and Queue rows stack without horizontal page overflow.
- [C14] GIVEN a 768px viewport, WHEN the dashboard loads, THEN primary activity uses the available width and low priority metadata remains readable.
- [C15] GIVEN dark mode, WHEN the user toggles color mode, THEN all primary states remain legible.
- [C16] GIVEN keyboard navigation, WHEN Tab moves through the page, THEN every entity link and action has a visible focus indicator.
- [C17] GIVEN server rendering, WHEN the root HTML loads, THEN the dashboard title and primary activity headings exist before hydration.

## Design

- Keep the DevTool theme and dashed schematic panels.
- Prioritize operational clarity over visual softness.
- Use typography and layout for hierarchy. Reserve color for state.
- Keep body text at least 1rem and controls at least 44px.

## Out of scope

- Starting or cancelling agents from the dashboard.
- Enabling mutations.
- Adding the missing automatic review dispatcher.
