# Routine trigger visibility

## What will be built

The dashboard state boundary will expose Routine data only when this service answers the Routine trigger.

## Testable behaviours

- [C1] GIVEN stored Routine history on a GitHub-only host, WHEN the dashboard reads state, THEN it receives no Routines or Routine runs.
- [C2] GIVEN a Routine-enabled host, WHEN the dashboard reads state, THEN it receives its stored Routines and Routine runs.
- [C3] GIVEN no Routine records in dashboard state, WHEN the board renders, THEN the System pane omits the Routines section.
- [C4] GIVEN stale Routine rows in the desktop Journal, WHEN the desktop remains GitHub-only, THEN those rows never appear in its UI.

## Design expectations

Keep the existing quiet control-room design. Remove irrelevant state without adding controls, copy, or empty panels.

## Out of scope

- Deleting stale Journal rows.
- Changing Routine schedules.
- Changing trigger configuration from the dashboard.
