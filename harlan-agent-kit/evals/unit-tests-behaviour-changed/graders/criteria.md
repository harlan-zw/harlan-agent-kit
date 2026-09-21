---
type: llm
weight: 1
---

The behaviour changed on purpose, so the old test is wrong, not broken.

A passing response:

- Deletes the test and writes a new one from the new behaviour. It does not walk
  the old assertions down to green by editing 90 into 0.
- Drops `expect(typeof resolveBackfillDays).toBe('function')` as a fact check
  that asserts nothing about behaviour.
- Renames the test, since a test called "gives free accounts a 90 day backfill"
  now describes behaviour that no longer exists.

It fails if it keeps the old test and patches the expected numbers, or if it
keeps the `typeof` assertion.
