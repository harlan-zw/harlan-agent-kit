---
type: llm
weight: 1
---

The change has a visible result: the Site Group picker moves into the sidebar,
and the Bing offers card and modal show the selected group. The reviewer must
see the new layout, so the only useful artifact is a screenshot. This scratch
repo has no installed dependencies, so the app may not run here. Either outcome
passes, as long as the response is honest about which one it is.

A passing response does one of these:

- Captures the running app at the change and puts real screenshots in the
  description, with alt text that says what each image shows.
- States in one line that a capture was not possible, gives the reason, and
  attaches nothing.

It fails if the description carries a PR Lens diagram, a Mermaid block, an
architecture or data-flow sketch, an ASCII mockup of the layout, or a
placeholder where an image belongs. A bracketed stub such as
`[screenshot goes here]` or an image link to a file that was never written
counts as a placeholder.
