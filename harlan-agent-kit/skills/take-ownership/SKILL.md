---
name: take-ownership
description: >
  Own current work through its intended delivery result.
  Use for end-to-end closure, landing, merging, CI monitoring, deployment monitoring, or smoke verification.
  Resume from local changes, a branch, a pull request, a merged change, or a pushed revision.
  Repair attributable failures and continue until verified, blocked, or cancelled.
---

# Take Ownership

Own one current work item until its intended delivery result is verified or visibly blocked.

A commit, green CI, or merge is intermediate when later delivery stages apply.

## Worktree isolation

An existing worktree alone does not prove another agent is active.

Use `wt` only when another agent is actively modifying the same repository. Otherwise keep the current checkout. Before concurrent edits, run `wt list --format=json`. Reuse the task's worktree with `wt switch <branch>`, or create one with `wt switch --create <branch> --base <base>`. Read its absolute `path` from the JSON, then pass that path as `workdir` to every later command. Never share a mutation worktree between tasks.

## Load contracts

Read these completely:

1. `../pr/SKILL.md` before creating or updating a pull request.
2. `../adversarial-review/SKILL.md` before deciding merge readiness.
3. `../adversarial-review/references/mutation-authority.md` before any mutation.
4. `../adversarial-review/references/review-contract.md` before updating the bot status.
5. `../unit-tests/SKILL.md` before repairing behavior or validation.

Read repository instructions, required workflows, release configuration, deployment configuration, and smoke commands.

Use `dev-browser` for browser smoke tests.

## Resolve the work item

Inspect local Git state and GitHub state. Record exactly one subject:

- `LocalWork`: uncommitted or unpushed work for the current request.
- `PullRequest`: an open pull request with its exact head revision.
- `Revision`: a pushed commit without an open pull request.

Ask for a target only when multiple subjects remain plausible.

Record the repository, subject, initial revision, default branch, canonical checkout, and intended result.

Also record required CI, merge policy, production targets, release targets, and smoke assertions.

Treat configured delivery stages as required. Never silently shorten the intended result.

If `harlan-github-agent` already controls the repository, resume its existing worker and journal. Do not start another watcher.

## Establish authority

Apply the mutation authority contract before every code, branch, metadata, comment, or merge mutation.

Explicit `$take-ownership`, `/take-ownership`, `get this merged`, or `land this` authorizes an eligible merge.

Other ownership requests activate tracking and eligible repair authority. They do not authorize a merge.

For example, `watch this through deploy` permits eligible repairs for the exact subject. Wait for the human merge decision.

Merge only repositories owned by the authenticated GitHub user. Never merge maintained or external repositories.

Require `READY` for the exact pull request head. Recheck every gate immediately before merging.

Honor branch protection, required approvals, merge queues, and repository merge methods. Never bypass them.

Never approve the pull request, use administrator privileges, force push, or amend a published commit.

## Lifecycle

Run each applicable phase in order. Resume the same durable session when new evidence arrives.

### 1. Finish the change

For `LocalWork`, complete the requested implementation and its required verification.

Load any domain skill required by the change. Keep unrelated work outside the ownership subject.

Use `pr` to create or update the pull request when code needs review.

For a feature branch `Revision`, create or resolve its pull request. For a default branch revision, continue to delivery tracking.

### 2. Reach readiness

Use `pr` for metadata, publication, CI monitoring, and review feedback repairs.

Run `adversarial-review` against the complete remote head. Resume until the exact head becomes `READY`.

Restart readiness checks after every pushed repair or remote head change.

### 3. Land the change

If merge authority exists, refetch the pull request and confirm the exact `READY` head.

Use the repository's normal merge method. If GitHub queues the merge, track the queue until it lands.

Without merge authority, wait for the human merge decision and keep ownership active.

When merged, record the merge commit and exact default branch head. Treat a pull request closed unmerged as `CANCELLED`.

### 4. Track delivery

For already pushed code, start from this phase when earlier phases do not apply.

Track required checks, workflows, deployments, releases, and provider jobs for the owned revision.

For a pull request, follow the merge commit and only its proven default branch descendants.

Match the revision, workflow identity, environment, target, and delivery source. Ignore unrelated green jobs.

Do not infer deployment or publication success from CI success.

### 5. Repair failures

Prove the failure belongs to the owned revision before editing.

Read the failing logs and classify the cause. Distinguish subject failures, baseline failures, and transient provider failures.

Retry one proven transient failure once. Repair deterministic failures.

If another agent is active in the repository, create the repair worktree with `wt switch --create <branch> --base <current-writable-branch>`. Otherwise keep the current checkout. Add a failing test first for behavior or validation regressions.

Use `chore: <specific problem>` for every CI or delivery pipeline repair. Never use the generic `chore: fix ci`.

Use a precise `fix:` subject when deployed product behavior is wrong.

Apply the smallest repair and run focused verification. Let required CI provide broad verification.

Recheck the remote target revision before pushing. Rebuild the repair when the target changed.

Use a normal repair pull request when direct repair is ineligible or branch protection rejects the push.

Never weaken protection, bypass hooks, force push, or hide a failed repair.

Stop after three failed repairs for the same cause. Mark ownership `BLOCKED` with exact evidence.

### 6. Smoke the result

Wait for the matched deployment or release to succeed. Then test the configured target.

For browser targets, check HTTP health, changed behavior, console errors, and one critical path.

For packages or services, run the configured consumer, release, or protocol smoke command.

Choose assertions from the request, changed files, pull request description, and repository configuration.

If smoke finds a regression, return to Repair failures.

Never claim verification without a meaningful target and assertion. Keep ownership active while evidence can still arrive.

Use `BLOCKED` when required evidence is unavailable and no safe discovery path remains.

### 7. Close ownership

For a pull request, update and confirm the existing marked bot comment.

Preserve review evidence. Append the owned revision, delivery target, delivery outcome, and smoke evidence.

For a direct revision, preserve the same evidence in the durable journal or final ownership record.

Close only as `VERIFIED`, `BLOCKED`, or `CANCELLED`. If this task created a worktree, run `wt remove <branch>` after closure. Do not force removal.

Do not stop at an intermediate state while an expected CI, merge, deployment, release, or smoke event can progress.

## Examples

Input: `Take ownership of the current work`

Output:

```text
owner/repo#42 · VERIFIED · MERGE_SHA · https://example.com/path · COMMENT_URL
```

Input: `The code is pushed, watch it through deploy`

Output:

```text
owner/repo@REVISION · BLOCKED · chore: correct Linux artifact path failed three times
```
