---
type: llm
weight: 1
---

Read the whole transcript, not only the final answer.

Pass: infers Hold Scope without asking the user to select a mode again.
It reviews failure paths, caller behavior, and boundary scope without implementing or expanding scope.
It distinguishes demonstrated defects from missing evidence and assigns severity by impact.
Fail: requires another ambition-mode selection, recommends expansion despite explicit scope,
or automatically calls every unproven failure strategy critical.
