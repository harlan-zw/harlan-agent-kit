---
type: llm
weight: 1
---

Read the whole transcript, not only the last message.

The response reviews the component, it does not redesign it. A passing response
finds both real defects:

- The Refresh action cannot refresh anything. The data is fetched inside this
  component, but the click is emitted to the parent, so nothing re-runs. Any
  wording of this defect counts.
- The async data has no loading, error, or empty state.

It fails if it returns a restyled or rewritten version of the component instead
of findings, or if it reports only styling opinions and misses both defects
above.
