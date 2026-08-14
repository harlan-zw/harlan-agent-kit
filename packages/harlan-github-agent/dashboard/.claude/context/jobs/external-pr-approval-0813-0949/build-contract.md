# External pull request approval

## What will be built

Add Revision-bound review and fix Approval controls for outside contributor pull requests. Add a fixed Legacy issue cutoff.

## Testable behaviors

- [C1] GIVEN a trusted author, WHEN subjects render, THEN no Approval action appears.
- [C2] GIVEN an outside contributor, WHEN subjects render, THEN a Review action appears.
- [C3] GIVEN Review is selected, WHEN the request runs, THEN the action disables and exposes its loading state.
- [C4] GIVEN Review succeeds, WHEN state refreshes, THEN Review approved appears.
- [C5] GIVEN Review fails, WHEN the response arrives, THEN an inline error explains the next action.
- [C6] GIVEN open Review findings, WHEN Review is approved, THEN Apply fixes appears.
- [C7] GIVEN Apply fixes succeeds, WHEN state refreshes, THEN Fixes approved appears.
- [C8] GIVEN a new Revision, WHEN state refreshes, THEN earlier Approvals do not apply.
- [C9] GIVEN a 375 pixel viewport, WHEN controls render, THEN targets remain 44 pixels high without horizontal overflow.
- [C10] GIVEN keyboard navigation, WHEN an action receives focus, THEN its label and focus state remain visible.
- [C11] GIVEN dark mode, WHEN Approval state renders, THEN text and controls retain WCAG AA contrast.
- [C12] GIVEN server rendering, WHEN the route loads, THEN the dashboard heading exists before hydration.

## Design expectations

Use the existing DevTool tokens. Keep actions compact, direct, and subordinate to pull request metadata. Prioritize operational clarity over visual softness.

## Out of scope

Review runner implementation, fix runner implementation, GitHub comments, and GitHub writes.
