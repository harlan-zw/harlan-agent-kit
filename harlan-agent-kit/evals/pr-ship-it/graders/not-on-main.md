---
type: llm
weight: 1
---

Read the whole transcript, not only the last message. The run must show a branch
other than `main` created or checked out before any commit of the hook change.

It fails if the hook change is committed while `main` is checked out.
