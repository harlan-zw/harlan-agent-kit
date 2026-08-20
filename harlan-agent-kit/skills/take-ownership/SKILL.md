---
name: take-ownership
description: "Own current work through merge, CI, deployment, and smoke verification. Resume from any delivery stage and repair attributable failures until verified, blocked, or cancelled."
---

# Take Ownership

Stay responsible for one current work item until its intended result is `VERIFIED`, `BLOCKED`, or `CANCELLED`.

A commit, green CI, or merge remains intermediate when later delivery stages apply.

## Use existing contracts

Read these completely when they apply:

1. `../pr/SKILL.md` for pull request creation, updates, CI, and review feedback.
2. `../adversarial-review/SKILL.md` for readiness.
3. `../adversarial-review/references/mutation-authority.md` for mutation and merge authority.
4. `../unit-tests/SKILL.md` before repairing behavior or validation.

Follow repository instructions and delivery configuration. Use `dev-browser` for browser smoke tests.

Delegate detailed permissions, review gates, worktree isolation, publication, and cleanup to those contracts.

If `harlan-github-agent` already controls the repository, resume its existing worker. Do not start another watcher.

## Start ownership

Inspect local Git state and remote state. Select one exact target:

- `LocalWork`: current uncommitted or unpushed work.
- `PullRequest`: one open pull request and its exact head commit.
- `Revision`: one pushed commit without an open pull request.

Determine the intended result and applicable CI, merge, deployment, release, and smoke stages.

Ask only when multiple targets remain plausible or the intended result materially changes the work.

Keep the exact commit and delivery targets attached to ownership.

Record whether the user invoked `$take-ownership`, `/take-ownership`, or explicitly requested a merge.

Pass that context to mutation authority. Other ownership requests permit eligible repairs but never grant merge authority.

## Complete and review

Complete local work with the relevant domain skills and verification.

Use `pr` when code needs review. Use `adversarial-review` before deciding readiness.

Restart readiness after the remote head changes.

## Land and follow

When authority permits, land the exact ready head through the repository's normal merge path.

Otherwise wait for the human merge decision and keep ownership active.

Follow the exact commit through every applicable delivery stage. Do not infer delivery success from unrelated green checks.

If newer work supersedes the target, explicitly adopt its commit or cancel ownership with evidence.

## Repair and recover

Prove a failure belongs to the owned change before editing.

Add a failing test first for behavior or validation regressions. Apply the smallest useful repair and verify it.

Use `chore: <specific problem>` for CI or delivery pipeline repairs. Use `fix:` for deployed product behavior.

Let the loaded contracts choose a direct push, branch repair, or repair pull request.

If production remains unsafe, choose the safest viable recovery: repair, rollback, or block with evidence.

Keep trying while meaningful progress remains. Block after three failed repairs for the same cause.

## Smoke and close

Verify the result against a meaningful target and assertion.

For browser targets, check health, changed behavior, console errors, and one relevant critical path.

If smoke finds a regression, return to repair.

Update the existing marked comment or durable record. Preserve delivery and smoke evidence.

Close only as `VERIFIED`, `BLOCKED`, or `CANCELLED`. Apply the loaded cleanup contract.

Do not stop at an intermediate state while an expected CI, merge, deployment, release, or smoke event can progress.
