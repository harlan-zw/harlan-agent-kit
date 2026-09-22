---
type: llm
weight: 1
---

Read the whole transcript, not only the last message.

The response applies the Effect-inspired design principles. A passing response:

- Replaces the optional-field plus boolean shape with a `_tag` discriminated
  union, so `rows` cannot coexist with `error`.
- Calls out `.catch(() => null)` as a silent catch that destroys the cause, and
  either propagates the error or carries a reason.
- Keeps errors as values for the expected domain failure, so the signature shows
  them.

It fails if it approves the type as written, or if it only suggests cosmetic
changes such as renaming fields or marking them readonly.
