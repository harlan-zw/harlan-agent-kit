---
type: llm
weight: 1
---

Read the whole transcript, not only the last message.

The response answers the question. A passing response explains that
`git rebase --onto <newbase> <upstream> <branch>` replays only the commits after
`<upstream>`, so you can move a branch off a parent it was stacked on, or drop a
range of commits, which a plain rebase cannot express.

It fails if it starts a delivery workflow, branches, commits, or opens a pull
request instead of answering.
