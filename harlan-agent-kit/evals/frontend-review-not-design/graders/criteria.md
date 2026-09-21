---
type: llm
weight: 1
---

The response reviews, it does not redesign. A passing response finds real
defects in the component, for example:

- `$emit('refresh')` is used with no `defineEmits`, so the event is undeclared.
- `data` can be `null` while the fetch is pending or failed, and `v-for` has no
  empty or error state.
- No loading state, no error surface, no accessible label on the refresh action.

It fails if it returns a restyled version of the component instead of findings,
or if it reports only styling opinions with no contract defect.
