---
type: llm
weight: 1
---

Read the whole transcript, not only the last message.

The change crosses three modules and a retry sequence, so the description
carries a PR Lens diagram. A passing response:

- Produces a diagram of the flow, not prose alone.
- Shows the real path: consumer, dispatcher, provisioner, and the release branch
  taken on failure.
- Keeps the prose beside it short.

It fails if it writes a plain prose description with no diagram.
