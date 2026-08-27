---
name: pr-triage
description: "Triage all open pull requests in Harlan-owned repositories. Use to repair, rank, sign off, or decide merge order across the PR backlog."
---

# PR Triage

Turn the owned PR backlog into a ranked merge queue. Never merge.

`harlan-github-agent` merges pull requests labelled `harlan-agent-auto-merge` on its own. This skill never does. See [auto merge](../../references/auto-merge.md).

## Worktree isolation

Before repair edits, follow the [worktree isolation contract](../../references/worktree-isolation.md). It provides the atomic live-agent claim used below.

An existing worktree alone does not prove another agent is active.

`wt` is the only worktree tool. Never run `git worktree add`, and never use a harness worktree option such as `EnterWorktree` or `isolation: "worktree"`. Those write to `.claude/worktrees/`, which is banned. `wt` places every worktree at `<parent>/<repo>.<branch-slug>`.

Discovery stays read only and may use the primary checkout. Every Repair uses a task-owned worktree. Run `wt list --format=json`. Reuse the task's worktree with `wt switch <branch>`, or create one with `wt switch --create <branch> --base origin/main`. Read its absolute `path` from the JSON, then pass that path as `workdir` to every later command.

## Load contracts

Read these completely before discovery:

1. `../adversarial-review/SKILL.md`, the complete workflow for one PR.

The `adversarial-review` skill loads `pr`, `humanize-writing`, and `unit-tests` when required. Do not duplicate those rules here.

## Discover

Run `scripts/discover-prs.sh` from this skill directory.

It returns every human-authored open PR in the allowed base repositories. Exclude GitHub Apps and bot accounts unless the user requests `--include-bots`.

Skip automated authors before dispatch, review attempts, or comments. Do not post a skip status.

For an author outside configured `writable_pr_authors`, wait for exact-Revision Review Approval in `harlan-github-agent`. Do not create a status comment before Approval. Require separate fix Approval after open findings and before edits.

If discovery reaches GitHub's 1,000 result cap, stop before mutations and report incomplete discovery.

## Process the backlog

Process one PR at a time. Parallelize read-only GitHub queries when useful.

For each PR, run the complete `adversarial-review` workflow. A PR is unfinished until its marked bot comment is confirmed on GitHub.

Treat one trusted marked comment for the current head commit as the active review. Never dispatch a second agent for that head commit.

For a personal repository mapped under `~/sites`, use `take-ownership` by convention unless repository policy or the user disables it. Other PRs stop after adversarial review.

Continue to the next PR after a confirmed `READY`, `WAITING`, or `BLOCKED` status. Preserve exact failure evidence.

Finish repairs across the backlog, then revisit `WAITING` pull requests once. Never sign off a stale SHA.

When required CI also fails on the current base of an owned repository, dispatch one focused baseline repair worker. Open its repair pull request, link it from the original PR status, and revisit the original after merge.

## Return the merge queue

List `READY` pull requests first, sorted by confidence. Then list `WAITING` and
`BLOCKED` pull requests without confidence scores.

```text
Confidence | PR | Outcome | Checked | Next action
96/100 high | owner/repo#42 | READY | Base, review, tests, CI | Human merge decision
— | owner/repo#17 | BLOCKED | Review complete; CI failed | Fix Linux job
```

Include skipped PRs and the exact safety reason. Never merge unless the user separately asks.
