---
name: adversarial-review
description: Adversarially review one pull request, repair material defects when policy permits, verify the exact remote head, and create or update the canonical Harlan Agent Kit bot status. Use when the user says "adversarial review", "review this PR", "try to disprove this change", "check this PR before merge", or asks for a rigorous correctness review of one pull request.
---

# Adversarial Review

Review exactly one pull request. Disprove correctness where possible, repair what is safe, then post the canonical bot status.

Returning findings without posting and confirming the status comment is incomplete.

## Worktree isolation

Before any edit, acquire the controller's atomic task claim for the intended checkout. If no controller exists, acquire an atomic session-owned lock keyed by the repository and absolute checkout path. Treat another live claim in the repository as an active agent. Release the claim when the task ends. If ownership is ambiguous, do not edit the shared checkout.

An existing worktree alone does not prove another agent is active.

Use `wt` only when another agent is actively modifying the same repository. Otherwise keep the current checkout. Before concurrent edits, run `wt list --format=json`. Reuse the task's worktree with `wt switch <branch>`, or create one with `wt switch --create <branch> --base <base>`. Read its absolute `path` from the JSON, then pass that path as `workdir` to every later command. Never share a mutation worktree between tasks.

Keep the review read only until mutation authority exists. Apply this rule before any repair or branch alignment edit.

## Load contracts

Read these completely before reviewing:

1. `references/mutation-authority.md` for repository and mutation authority.
2. `references/review-contract.md` for review gates, confidence, comment format, and idempotent posting.

Read `../pr/SKILL.md` before changing PR metadata. Read `../humanize-writing/SKILL.md` before changing its prose.

Read `../unit-tests/SKILL.md` before repairing a bug or validation rule.

Follow repository-local `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and PR templates.

## Review workflow

Run each phase in order. Restart from Snapshot after every remote head change.

### 1. Resolve one PR

Use the supplied URL or number. Otherwise resolve the PR for the current branch with `gh pr view`.

Stop and request a target when zero or multiple PRs remain possible.

### 2. Snapshot remote state

Fetch the PR, base and head SHAs, complete base-to-head diff, checks, reviews, issue comments, inline comments, and every review thread.

Record the initial head SHA. Never review only the latest commit.

### 3. Establish authority

Apply the ownership contract before every code, metadata, branch, or comment mutation.

Continue read only when code cannot be changed. Record the exact permission boundary for the status.

Never approve, merge, dismiss a review, force push, amend published commits, or push the base branch.

### 4. Align the PR

Update from the PR's actual base branch when policy permits. Preserve the head branch and use a normal merge commit when required.

Apply the `pr` metadata contract. Preserve contributor context and the visible AI disclosure.

Refetch and restart when either action changes the remote head or metadata snapshot.

### 5. Disprove the change

Apply every adversarial check in the review contract to the complete diff and surrounding implementation.

Trace changed inputs through public boundaries, failures, cleanup, concurrency, persistence, and tests.

Ignore style-only preferences. Treat correctness, security, data loss, public API breakage, and missing regression coverage as material.

### 6. Repair and restart

When mutation is allowed, add the failing test first, fix the defect, run focused and repository-required checks, then push a fix-forward commit.

After every push, discard prior review evidence. Snapshot and review the new remote head from the start.

Stop automatic repair after three failed attempts for one finding. Preserve work and use `BLOCKED`.

### 7. Freeze the outcome

Apply the exact `PASS`, `PENDING`, or `BLOCKED` gate and confidence rules from the review contract.

Refetch the PR immediately before posting. If the head SHA changed, restart the review.

### 8. Post and confirm the bot status

Create or update the marked `harlan-agent-kit:pr-triage` issue comment using the review contract.

Post one status for every terminal outcome, including `PENDING` and `BLOCKED`. Never use a GitHub approval review.

Treat the GitHub response as part of the operation. Refetch the comment and confirm its author, marker, reviewed SHA, outcome, and identity statement.

If creation, update, or confirmation fails, return an explicit posting failure. Never report the adversarial review as complete.

## Return

Return one compact line:

## Examples

Examples:

Input: `Adversarial review https://github.com/owner/repo/pull/42`

Output:

```text
owner/repo#42 · PASS · 96/100 · HEAD_SHA · COMMENT_URL
```

Input: `Disprove the PR for this branch`

Output:

```text
owner/repo#17 · BLOCKED · 39/100 · HEAD_SHA · COMMENT_URL · required CI failed
```

Add pushed repair commits or a next action only when present. The GitHub comment is the durable review record.
