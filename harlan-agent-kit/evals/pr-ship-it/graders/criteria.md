---
type: llm
weight: 1
---

Read the whole transcript, not only the last message.

The response delivers the change the way the `pr` skill prescribes. A passing
response:

- Moves the work onto a branch. It never commits to `main`.
- Uses a Conventional Commits subject, `type(scope): description`, imperative
  mood, under 70 characters, no trailing period. For this change, something in
  the shape of `feat(hooks): print the branch name at session start`.
- Ends at a pull request: it states the push command and the pull request title,
  since there is no remote.

It fails if it commits to `main`, writes a subject that breaks Conventional
Commits, or finishes without a pull request step.
