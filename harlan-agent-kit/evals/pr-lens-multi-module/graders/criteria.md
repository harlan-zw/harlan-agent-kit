---
type: llm
weight: 1
---

The change crosses three modules and a sequence, so the description carries a
PR Lens diagram. A passing response:

- Produces a diagram of the flow, not only prose.
- Shows the real path: dispatch, consumer, provisioner, and the release branch
  on failure.
- Keeps the prose short beside it.

It fails if it writes a plain prose description with no diagram.
