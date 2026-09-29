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
So use only the `gh stack` commands that read, link, or unstack. Never use the ones that switch branches or rebase.

| Need | Command |
| --- | --- |
| Start a stack | `gh stack link PARENT_PR NEW_PR` |
| Add a pull request on top of a stack | `gh stack link STACK_NUMBER NEW_PR` |
| Insert a pull request below the top | [Insert inside a stack](#insert-inside-a-stack) |
| Merge a stack | `gh stack merge PR_NUMBER --squash --yes` |

Never run `gh stack init`, `add`, `checkout`, `modify`, `sync`, `rebase`, or `push`.
They switch branches in the current working tree and push with `--force-with-lease`.
Both break the [worktree isolation contract](../../../references/worktree-isolation.md) and the no-force rule.

Pass pull request numbers, not branch names. A branch argument makes `gh stack link` push from the current directory.
Arguments run bottom to top.

**`gh stack link` only appends to the top.** The GitHub Stacks API has no insert or reorder.
With a stack number first, every other argument goes above the current top PR, whatever the branch history says.
If that PR's commits are already in the top branch, GitHub marks it merged into that branch at once. It cannot be reopened.

## Read the stack

Run this from the repository. It prints the stack bottom to top, each line as `#PR base <- head`:

```bash
gh api 'repos/{owner}/{repo}/stacks?pull_request=PR' --jq '.[0].number, (.[0].pull_requests[]?.number)' \
  | { read -r stack; echo "stack $stack"; while read -r n; do
      gh pr view "$n" --json number,baseRefName,headRefName --jq '"#\(.number) \(.baseRefName) <- \(.headRefName)"'
    done; }
```

If `stack` prints no number, the PR is in no stack. `gh stack view` reads local tracking only, so it shows nothing here.

## Procedure

1. Read the stack of the parent PR. Write the target order, for example `main <- #a <- #new`.
   If `#new` goes anywhere but the top, stop and use [Insert inside a stack](#insert-inside-a-stack).
2. Create the worktree on the parent: `wt switch --create BRANCH --base origin/PARENT_BRANCH`.
3. Build the body as Step 3 says. Open the description with `Stacked on #PARENT_PR.`
4. Create the pull request against the parent: `gh pr create --base PARENT_BRANCH ...`.
5. Run the [check before linking](#check-before-linking) for the parent and the new branch.
6. Link it. If the parent is in no stack, run `gh stack link PARENT_PR NEW_PR`. If the parent is the top of a stack, run `gh stack link STACK_NUMBER NEW_PR`.
7. [Read the stack](#read-the-stack) again. It must match the target order, and each base must equal the head on the line above.

Create the pull request first, then link. `gh stack link` creates pull requests with generated titles and empty bodies, so a pull request it creates never passes Step 3.

## Check before linking

Run it for each adjacent pair in the target order, `LOWER` directly below `UPPER`:

```bash
git fetch origin
git merge-base --is-ancestor origin/LOWER origin/UPPER && echo ok-contains-lower
git merge-base --is-ancestor origin/UPPER origin/LOWER && echo STOP-lower-already-has-upper
```

- If `ok-contains-lower` is missing, merge `origin/LOWER` into `UPPER` and push first.
- If `STOP-lower-already-has-upper` prints, the order is upside down. Linking it would mark `UPPER` merged. Fix the order.

## Insert inside a stack

Use this when a new PR belongs below a PR that is already in a stack, for example a fix under the Skill PR.
Target: `main <- #a <- #new <- #b`.

1. [Read the stack](#read-the-stack). Record the stack number and the current order.
2. Create `#new` on `#a`: `wt switch --create NEW_BRANCH --base origin/A_BRANCH`, then `gh pr create --base A_BRANCH`.
3. In the worktree of `#b`, merge the new branch in: `git fetch origin && git merge origin/NEW_BRANCH`, then `git push`.
4. Retarget `#b`: `gh pr edit B --base NEW_BRANCH`.
5. Run the [check before linking](#check-before-linking) for every adjacent pair in the target order.
6. Unstack: `gh stack unstack STACK_NUMBER`. The PRs and their bases stay. Only the stack goes.
7. Link the full target order, every PR, bottom to top: `gh stack link A NEW B`. If the stack base is not the default branch, add `--base STACK_BASE`.
8. [Read the stack](#read-the-stack). It must match the target order.

Never pass a stack number here: that appends `#new` above `#b`.
Never list a new order against a stack that still exists: `gh stack link` rewrites PR bases, then refuses the reorder, and leaves the bases changed.

If a PR shows merged into the wrong branch, open a new PR from the same branch against the right base. Then repeat this procedure with the new number.

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
