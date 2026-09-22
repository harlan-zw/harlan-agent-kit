---
type: llm
weight: 1
---

The skill lists the tells first, then gives the rewrite. Both parts must appear.

A passing response:

- Names the tells, including "thrilled to announce", "dive in", "seamless",
  "cutting-edge", "fast-paced digital landscape", and the "This isn't just X,
  it's Y" construction.
- Then supplies rewritten release-note text.
- The rewrite keeps the three facts: the 40,000 URL sitemap going from 18
  seconds to 1.2, the removal of `sitemap.urls`, and the move to
  `sitemap.sources`.
- The rewrite drops every tell it named, keeps the "not X, it's Y" pattern out,
  and uses no em dashes and no hyphens as dashes.

It fails if no rewritten text is ever produced, if the rewrite loses the
performance numbers or the migration step, or if it still carries a listed
filler phrase or an em dash.
