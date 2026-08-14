# Dashboard task cancellation contract

## What will be built

The dashboard will cancel active or queued agent tasks. The store will keep manual cancellation across later polls. A closed pull request will use the same cancellation path.

## Testable behaviors

- [C1] GIVEN an active task, WHEN Cancel is clicked, THEN the task stops and leaves Active agents.
- [C2] GIVEN a queued task, WHEN Cancel is clicked, THEN the task leaves the Queue.
- [C3] GIVEN a cancellation request, WHEN it is pending, THEN every control for that task is disabled.
- [C4] GIVEN a failed cancellation request, WHEN the response arrives, THEN the dashboard shows the failure beside the task.
- [C5] GIVEN live updates, WHEN cancellation completes, THEN the dashboard removes the task without a reload.
- [C6] GIVEN a cancelled task, WHEN the same pull request is polled again, THEN the task stays cancelled.
- [C7] GIVEN a pull request closes, WHEN the close is stored, THEN all current tasks use the cancellation path.
- [C8] GIVEN a 375px viewport, WHEN controls render, THEN they stay inside each task panel.
- [C9] GIVEN dark mode, WHEN controls render, THEN existing semantic tokens remain readable.
- [C10] GIVEN keyboard navigation, WHEN Cancel receives focus, THEN its label and focus state identify the task.

## Design expectations

Use the existing DevTool system. Keep cancellation visible, compact, and secondary to task progress.

## Out of scope

No bulk cancellation, undo, or remote GitHub state changes.
