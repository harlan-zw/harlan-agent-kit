---
name: pr-triage
description: Triage all open pull requests in Harlan's owned GitHub repositories. Use when asked to review the PR backlog, refresh open PRs, get PRs merge-ready, repair failing PRs, sign off PRs, rank merge confidence, or decide which pull requests to merge next.
---

# PR Triage

Turn the owned PR backlog into a ranked merge queue. Never merge.

## Worktree isolation

Before repair edits, follow the [worktree isolation contract](../../references/worktree-isolation.md). It provides the atomic live-agent claim used below.

An existing worktree alone does not prove another agent is active.

Discovery stays read only. Use `wt` for a repair worker only when another agent is actively modifying the same repository. Otherwise keep the current checkout. Before concurrent edits, run `wt list --format=json`. Reuse the task's worktree with `wt switch <branch>`, or create one with `wt switch --create <branch> --base <base>`. Read its absolute `path` from the JSON, then pass that path as `workdir` to every later command.

## Load contracts

Read these completely before discovery:

1. `../adversarial-review/SKILL.md`, the complete workflow for one PR.

The `adversarial-review` skill loads `pr`, `humanize-writing`, and `unit-tests` when required. Do not duplicate those rules here.

## Discover

Run `scripts/discover-prs.sh` from this skill directory.

It returns every human-authored open PR in the allowed base repositories. Exclude GitHub Apps and bot accounts unless the user requests `--include-bots`.

If discovery reaches GitHub's 1,000 result cap, stop before mutations and report incomplete discovery.

## Process the backlog

Process one PR at a time. Parallelize read-only GitHub queries when useful.

For each PR, run the complete `adversarial-review` workflow. A PR is unfinished until its marked bot comment is confirmed on GitHub.

For a personal repository mapped under `~/sites`, use `pr-owner` by convention unless repository policy or the user disables it. Other PRs stop after adversarial review.

Continue to the next PR after a confirmed `PASS`, `PENDING`, or `BLOCKED` status. Preserve exact failure evidence.

Finish repairs across the backlog, then revisit pending CI once. Never sign off a stale SHA.

## Return the merge queue

Sort by confidence descending and group results into high, medium, and low confidence.

```text
Confidence | PR | Outcome | Checked | Next action
96/100 high | owner/repo#42 | PASS | Base, review, tests, CI | Merge after human glance
39/100 low | owner/repo#17 | BLOCKED | Review passed; CI failed | Fix Linux job
```

Include skipped PRs and the exact safety reason. Never merge unless the user separately asks.
