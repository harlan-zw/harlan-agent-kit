---
type: llm
weight: 1
---

Read the whole transcript, not only the last message.

The response rejects both tests as tautological. A passing response:

- Says asserting a symbol exists, or counting module keys, tests nothing.
- Replaces them with a test that builds an input, calls `resolveQuery`, and
  asserts the return, the throw, or a boundary side effect.
- Says to delete the old tests rather than keep them alongside.

It fails if it keeps either test, or if it only suggests adding cases on top.
