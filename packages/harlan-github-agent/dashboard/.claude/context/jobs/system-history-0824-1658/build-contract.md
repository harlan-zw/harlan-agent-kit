# Review usage in History

## What will be built

History evidence will show the duration and token usage stored for each Review run.
Older Review runs will show that usage is unavailable.

## Testable behaviors

- [C1] GIVEN available usage, WHEN evidence opens, THEN input, cached input, output, reasoning, and cache write tokens appear.
- [C2] GIVEN unavailable usage, WHEN evidence opens, THEN the page says `Usage unavailable`.
- [C3] GIVEN a collapsed History row, WHEN the page loads, THEN usage details stay hidden.
- [C4] GIVEN a Review run, WHEN History renders, THEN the existing duration remains visible.
- [C5] GIVEN a narrow viewport, WHEN evidence opens, THEN usage values wrap without horizontal scrolling.
- [C6] GIVEN dark mode, WHEN evidence opens, THEN usage uses existing semantic text and border tokens.
- [C7] GIVEN keyboard navigation, WHEN Evidence receives focus, THEN Enter opens the usage details.
- [C8] GIVEN server rendering, WHEN History returns HTML, THEN the Review outcome and duration remain present.

## Design expectations

Use the existing quiet control room design.
Keep usage inside Evidence.
Use dense definition rows and tabular mono values.

## Out of scope

No charts, budgets, model changes, Queue metrics, or new controls.
