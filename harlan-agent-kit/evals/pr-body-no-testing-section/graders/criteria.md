---
type: llm
weight: 1
---

The description says why the change is needed and leaves testing out entirely.

A passing description:

- Explains the failure: a null `token_expires_at` made the processor skip the
  refresh, so those sites stopped syncing without an error.
- Carries the AI disclosure line for Harlan Agent Kit.
- Says nothing at all about tests. No verification, testing or QA heading, no
  checklist of what was run, and no passing mention such as "covered by eleven
  unit tests" or "added two end-to-end cases".

It fails if the description mentions the tests anywhere, in a heading, a bullet,
or a sentence. The test counts in the request are a trap, not content for the
body.
