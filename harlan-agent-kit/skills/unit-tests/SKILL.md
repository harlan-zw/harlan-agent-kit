---
name: unit-tests
description: Write or review unit tests that exercise an API instead of fact-checking a file. Use when writing tests, adding test coverage, reviewing a test file, or when a test suite feels brittle, verbose, or expensive to maintain. Also use before writing the failing test for a bug fix.
user_invocable: true
argument-hint: "[file or directory to test or review]"
---

# Unit Tests

A unit test exercises an API. Input goes in, output gets asserted. Everything else is a fact check against the source file and should be deleted.

## Worktree isolation

Before writing or deleting tests, follow the [worktree isolation contract](../../references/worktree-isolation.md). It provides the atomic live-agent claim used below.

An existing worktree alone does not prove another agent is active.

Use `wt` before writing or deleting tests only when another agent is actively modifying the same repository. Otherwise keep the current checkout. For concurrent edits, run `wt list --format=json`. Reuse the task's worktree with `wt switch <branch>`, or create one with `wt switch --create <branch> --base <base>`. Read its absolute `path` from the JSON, then pass that path as `workdir` to every later command. Never share a mutation worktree between tasks.

## The failure mode this exists to stop

Fact-check tests restate what the file already says. They pass by construction, break on harmless refactors, and prove nothing.

```ts
// all of these are fact checks, not tests
expect(Object.keys(config)).toEqual(['name', 'hooks', 'setup'])
expect(source).toContain('export function resolvePath')
expect(module.default.name).toBe('my-module')
expect(handlers).toHaveLength(3)
expect(typeof createClient).toBe('function')
```

They feel productive because the file goes green. The suite grows, review cost grows, and no bug is ever caught.

## The two questions

Before keeping any assertion:

1. **Delete it if it can fail while the code is still correct.** Renaming an internal, reordering an array, adding a config key must never turn the suite red.
2. **Delete it if it can pass while the code is broken.**

An assertion that survives both is testing behaviour. Anything else is ballast.

## Shape

Every test is three lines of intent: build an input, call an export, assert the result.

```ts
it('rejects a path outside the root', () => {
  const result = resolvePath('/srv/app', '../../etc/passwd')
  expect(result).toEqual({ _tag: 'Err', reason: 'escapes-root' })
})
```

- Call it the way a consumer calls it: through `exports`, not through a deep internal import.
- Assert on the **returned value**, the **thrown error**, or a **recorded side effect** at the boundary. Not on internal state.
- One concrete input, one concrete expectation. Table-drive the variants with `it.each`.
- Prefer a real fixture over a mock. Mocking the module under test means you are testing the mock.

## Tests are scratchpad

Cheap to write, cheap to throw away. Deleting a test is a normal outcome, not a regression.

- When behaviour intentionally changes, **delete the test and write the new one**. Do not repair old assertions until they go green; that is how a suite ossifies around an API nobody wants.
- Never write a test to raise coverage. Untested trivial code is fine.
- If a test costs more to maintain than the bug it would catch, it is negative value. Remove it.
- A test file should be deletable in one commit without anyone needing to reconstruct why it existed.

## Never test

- File contents, `dist/` output, or source text as a string
- That a symbol exists, is a function, or has N keys
- The shape of a config or options object
- Snapshots of anything except stable output a human actually reads (rendered markup, generated file a user opens, CLI output). Never snapshot an internal data structure.
- "Does not throw" as the only assertion
- Private/internal functions reached by deep import

## Worth testing

- **Pure functions**: input to output, including the boring edges (empty, zero, unicode).
- **Error paths**: bad input produces the tagged `Err` or the thrown error with the right discriminant.
- **Boundary parsers**: untrusted input becomes a precise type, or is rejected.
- **Transforms and builds**: feed a real fixture in, assert on the **parsed output value**, not the emitted text.
- **Regressions**: the failing test written before a bug fix, named for the behaviour, not the ticket.

## Reviewing an existing suite

Read the file and bucket every `expect` into fact check, behaviour, or unclear. Report the counts, list the fact checks with line numbers, and propose deletions. Do not rewrite a fact check into a behaviour test unless the underlying behaviour is genuinely worth covering; usually the right patch is a deletion.

Report in this shape:

```
resolve-path.test.ts — 14 expects: 9 fact check, 4 behaviour, 1 unclear

Delete (fact check):
  L12  expect(Object.keys(opts)).toEqual([...])   restates the options type
  L27  expect(typeof resolvePath).toBe('function') passes by construction
  L31-38  snapshot of the internal config object

Unclear:
  L44  asserts cache.size === 1 — internal state; is the caching itself a documented guarantee?

Keep: L52, L58, L63, L70 (input to output, incl. two error paths)
```
