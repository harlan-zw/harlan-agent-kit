---
type: llm
weight: 1
---

Read the whole transcript, not only the last message.

The skill lists the tells first, then gives the rewrite. Both parts must appear.

A passing response:

- Names the tells, including "thrilled to announce", "dive in", "seamless",
  "cutting-edge", "fast-paced digital landscape", and the "This isn't just X,
  it's Y" construction.
- Then supplies rewritten release-note text.
- The rewrite drops every tell it named, keeps the "not X, it's Y" pattern out,
  and uses no em dashes and no hyphens as dashes.

It fails if no rewritten text is ever produced, or if the rewrite still carries
the "not X, it's Y" pattern, a listed filler phrase, or an em dash.
