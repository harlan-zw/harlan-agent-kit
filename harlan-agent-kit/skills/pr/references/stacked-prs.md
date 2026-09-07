# Stacked pull requests

GitHub stacks chain pull requests. Each child targets its parent's branch.
GitHub shows the chain on every pull request in it and merges the chain in one atomic operation.
`gh stack` is the GitHub CLI extension for stacks. Docs: https://gh.io/stacks

## When to stack

Stack only when the change does not build, pass, or make sense without an open pull request's diff.

Related but independent work targets `origin/main`, even when it touches the same area.
Independent pull requests merge in parallel and auto-merge can take them.
A stack merges in order, and a child waits for its parent.

## Commands this skill allows

`wt` owns every branch and worktree, and this skill never force pushes.
So use only the `gh stack` commands that read or link. Never use the ones that switch branches or rebase.

| Need | Command |
| --- | --- |
| Link pull requests into a stack | `gh stack link PARENT_BRANCH BRANCH` |
| Grow an existing stack | `gh stack link STACK_NUMBER BRANCH` |
| Merge a stack | `gh stack merge PR_NUMBER --squash --yes` |

Never run `gh stack init`, `add`, `checkout`, `modify`, `sync`, `rebase`, or `push`.
They switch branches in the current working tree and push with `--force-with-lease`.
Both break the [worktree isolation contract](../../../references/worktree-isolation.md) and the no-force rule.

`gh stack link` needs no local stack state. It pushes branches, reuses open pull requests, creates missing ones, and sets each base.
Arguments run bottom to top. A branch already in the stack is skipped.

## Procedure

1. Create the worktree on the parent: `wt switch --create BRANCH --base origin/PARENT_BRANCH`.
2. Build the body as Step 3 says. Open the description with `Stacked on #PARENT_PR.`
3. Create the pull request against the parent: `gh pr create --base PARENT_BRANCH ...`.
4. Link it: `gh stack link PARENT_BRANCH BRANCH`.
5. Confirm the chain: `gh pr view --json baseRefName` reads `PARENT_BRANCH`.

Create the pull request first, then link. `gh stack link` creates pull requests with generated titles and empty bodies, so a pull request it creates never passes Step 3.

## When the parent changes

GitHub does not update the child when the parent gets new commits.
If the child needs them, merge the parent into the child head:

```bash
git merge origin/PARENT_BRANCH
git push
```

Never rebase the child and force push.

## Merge

`gh pr merge` and the web merge button refuse a pull request that has a child:

```
This pull request is part of a stack and must be merged using the asynchronous merge REST API.
```

`gh stack merge PR_NUMBER --squash --yes` merges every pull request up to and including `PR_NUMBER` in one operation.
If any one cannot merge, none merge. Branch protection still applies.

Merge the parent alone only when the child is not ready.
After the parent squash merges, GitHub retargets the child to `main` and the child turns CONFLICTING, because its branch still carries the parent's original commits.
Repair it in the child's worktree:

```bash
git fetch origin
git merge -X ours origin/main
```

The head is a superset of the squashed parent, so `-X ours` keeps it.
Then diff every file both sides touched. A concurrent pull request that changed the same lines is dropped silently by `-X ours`.
Fix forward with new commits. Never force push.
