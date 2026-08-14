# Review rerun

## What will be built

Add `Rerun review` to current pull request review results and waiting Queue rows. The action targets the displayed head commit.

## Testable behaviors

- [C1] GIVEN a current completed review, WHEN `Rerun review` is pressed, THEN the dashboard posts its repository, PR number, and head revision.
- [C2] GIVEN a rerun request is pending, WHEN the action renders, THEN it shows a loading state and blocks another request.
- [C3] GIVEN the API accepts a rerun, WHEN it completes, THEN live dashboard state refreshes.
- [C4] GIVEN the API rejects a rerun, WHEN it completes, THEN an inline error explains that refresh and retry are available.
- [C5] GIVEN an old review attempt, WHEN it renders, THEN no rerun action appears.
- [C6] GIVEN a waiting current PR in the Queue, WHEN it renders, THEN `Rerun review` appears.
- [C7] GIVEN a 375 pixel viewport, WHEN the action renders, THEN its target remains at least 44 pixels high.
- [C8] GIVEN light or dark mode, WHEN the action renders, THEN it uses existing Nuxt UI tokens.
- [C9] GIVEN keyboard navigation, WHEN focus reaches the action, THEN its accessible name identifies the repository and PR.
- [C10] GIVEN server rendered HTML, WHEN the dashboard shell loads, THEN existing sections still render.

## Design expectations

Use the DevTool theme and existing button styles. Prioritize operational clarity over visual softness. Keep the action next to existing row controls.

## Out of scope

No layout redesign, confirmation dialog, or new review history page.
