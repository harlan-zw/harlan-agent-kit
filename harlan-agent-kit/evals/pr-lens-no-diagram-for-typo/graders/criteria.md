---
type: llm
weight: 1
---

A one-line typo fix in a single file does not cross three modules, a boundary,
or a sequence, so it gets no diagram. A passing response writes a short plain
description and draws nothing.

It fails if it produces a diagram, a Mermaid block, or an architecture sketch
for this change.
