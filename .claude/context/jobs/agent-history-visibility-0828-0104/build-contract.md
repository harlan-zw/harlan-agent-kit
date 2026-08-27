# Agent history visibility

## What will be built

- Replace running completion percentages with the current agent phase.
- Explain each Review outcome on History and Recently finished.
- Keep superseded Tasks separate from failures and Review findings.
- Show the last reported phase and terminal reason for finished Tasks.

## Testable behaviors

- [C1] GIVEN a running agent, WHEN the Board renders, THEN its current phase is visible without a completion percentage.
- [C2] GIVEN a running agent with activity, WHEN Terminal opens, THEN the recent redacted activity is visible.
- [C3] GIVEN two minutes without progress, WHEN the Board renders, THEN it warns that progress stopped.
- [C4] GIVEN a BLOCKED Review with findings, WHEN History renders, THEN it states the finding count.
- [C5] GIVEN a PENDING Review, WHEN History renders, THEN it names the unsettled Review gate and reason.
- [C6] GIVEN a failed Task, WHEN History renders, THEN it shows the last phase and exact failure reason.
- [C7] GIVEN a superseded Task, WHEN History filters apply, THEN it appears only in All or Superseded.
- [C8] GIVEN recently finished work, WHEN System renders, THEN each row explains its outcome.
- [C9] GIVEN no matching history, WHEN a filter applies, THEN the empty state remains visible.
- [C10] GIVEN state loading or request failure, WHEN the Board renders, THEN existing loading and error states remain visible.
- [C11] GIVEN a 375px or 768px viewport, WHEN the pages render, THEN rows wrap without horizontal scrolling.
- [C12] GIVEN dark mode, WHEN the pages render, THEN status text keeps the existing semantic tokens.
- [C13] GIVEN keyboard navigation, WHEN a filter or disclosure receives focus, THEN its label and state are announced.
- [C14] GIVEN server rendering, WHEN History loads, THEN headings and filter labels exist in HTML.
- [C15] GIVEN declared Routines, WHEN System renders, THEN each repository schedule is visible.
- [C16] GIVEN several runs for one Routine, WHEN System renders, THEN its newest run is shown.
- [C17] GIVEN a failed or skipped run, WHEN System renders, THEN its durable reason is visible.
- [C18] GIVEN a tracking issue, WHEN System renders, THEN the Routine links to that issue.

## Design expectations

- Keep the quiet control room design.
- Use typography and exact copy for hierarchy.
- Keep evidence behind disclosures.
- Use semantic color only for state.

## Out of scope

- Persisting full terminal activity.
- Changing scheduler recovery behavior.
- Changing GitHub review comments.
