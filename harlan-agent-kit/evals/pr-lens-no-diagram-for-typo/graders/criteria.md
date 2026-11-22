---
type: llm
weight: 1
---

A one-line typo fix in a single file has no visible result and moves no data
across a boundary, so it gets no artifact.

A passing response writes a short description that names the real correction,
"recieved" to "received", and draws nothing.

It fails if it produces a diagram, a Mermaid block or an architecture sketch, or
if it leaves placeholders where the correction belongs.
