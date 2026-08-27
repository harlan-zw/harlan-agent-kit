# System pane recently finished

## What will be built

Add a compact Recently finished list to the existing System pane.
Show the three newest completed Review runs and terminal Tasks.
Keep History as the full record.

## Testable behaviors

- [C1] GIVEN finished work, WHEN the System pane renders, THEN it shows at most three records in newest-first order.
- [C2] GIVEN a Review record, WHEN it renders, THEN it links to the pull request and shows its Review outcome.
- [C3] GIVEN a terminal Task, WHEN it renders, THEN it links to the issue or pull request and shows its Task state.
- [C4] GIVEN no finished work, WHEN the System pane renders, THEN it says `Nothing has finished yet.`
- [C5] GIVEN more history, WHEN Recently finished renders, THEN `All history` links to `/history`.
- [C6] GIVEN a 375px viewport, WHEN rows wrap, THEN the outcome, item link, and relative time remain readable.
- [C7] GIVEN dark mode, WHEN rows render, THEN they use semantic dashboard tokens.
- [C8] GIVEN a screen reader, WHEN it enters Recently finished, THEN the heading and list structure identify the section.
- [C9] GIVEN server rendering, WHEN `/` loads, THEN the Recently finished heading exists in HTML.

## Design expectations

Match the quiet control-room design.
Use divided rows, mono machine values, semantic outcome color, and no nested panel.

## Out of scope

No new API, journal state, filters, controls, or project-specific Review rules.
