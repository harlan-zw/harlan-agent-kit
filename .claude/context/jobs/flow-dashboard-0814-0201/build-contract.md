# Flow dashboard contract

## What will be built

A static `/flow` route that maps repository intake, pull request review, issue triage, GitHub writes, recovery, and post-merge ownership. It distinguishes implemented behavior from Harlan decisions and paths that are not connected to the service.

## Testable behaviors

- [C1] GIVEN `/flow`, WHEN the route renders, THEN the GitHub intake, pull request, issue, and controller paths appear in SSR HTML.
- [C2] GIVEN either dashboard page, WHEN navigation is used, THEN Dashboard and Flow link to each other.
- [C3] GIVEN the flow legend, WHEN it is read, THEN Implemented, Harlan decision, and Not connected states are explained.
- [C4] GIVEN the pull request lane, WHEN it is read, THEN author approval, conflict repair, review, CI use, comment, and merge status paths are explicit.
- [C5] GIVEN the issue lane, WHEN it is read, THEN cutoff, repository topic, triage, and the missing implementation handoff are explicit.
- [C6] GIVEN a recoverable controller failure, WHEN the recovery path is read, THEN base movement, invalid Codex output, and recurring conflicts lead back to Queue work.
- [C7] GIVEN a 375px viewport, WHEN `/flow` renders, THEN lanes stack without horizontal page overflow.
- [C8] GIVEN a viewport at least 768px wide, WHEN `/flow` renders, THEN pull request and issue lanes appear side by side.
- [C9] GIVEN dark mode, WHEN `/flow` renders, THEN every surface uses existing semantic tokens.
- [C10] GIVEN keyboard navigation, WHEN focus moves through links and disclosure controls, THEN visible focus remains and headings preserve document order.
- [C11] GIVEN the known gaps section, WHEN each disclosure opens, THEN it states the missing service connection without implying it is implemented.

## Design expectations

Use the existing DevTool system. Operational clarity takes priority over visual softness. Use flat schematic nodes, dashed connectors, IBM Plex typography, semantic state color, and no decorative charts.

## Out of scope

No live workflow editor, drag interactions, configuration writes, or inferred completion state.
