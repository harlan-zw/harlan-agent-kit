---
name: take-ownership
description: "Own current work through delivery and smoke verification, finish loose ends, reconcile records, and clean task-owned Git state. Use to resume delivery, follow up after merge or deploy, check what remains, close off, wrap up, or finish up."
user_invocable: true
argument-hint: "[work item, pull request, or branch] | close [target]"
---

# Take Ownership

Stay responsible for one current work item until its intended result is `VERIFIED`, `BLOCKED`, or `CANCELLED`.

A commit, green CI, or merge remains intermediate when later delivery stages apply.

## Select mode

Resolve one current work item from the conversation and `$ARGUMENTS`.

| Request | Mode | Next step |
| --- | --- | --- |
| Own, resume, land, or follow current work through delivery | Delivery | Start ownership below. |
| What remains, follow-up, close off, wrap up, or finish up | Completion | Read [completion](references/completion.md). |
| `close` followed by a work item, pull request, or branch | Completion | Read [completion](references/completion.md) for that target. |
| Work has delivered and needs records or cleanup | Completion | Read [completion](references/completion.md). |

Completion mode resolves remaining work before cleanup.
For related gaps, opportunities, or improvements, use [i-dont-know-just-keep-working](../i-dont-know-just-keep-working/SKILL.md).
For a bare "what's next", check required completion work before proposing expansion.
If delivery remains required, follow the Delivery sections below, then return to the same completion ledger.
Preserve the target, evidence, and original authority when changing modes.
Do not restart target selection or create another watcher.

## Authority

Completion requests authorize safe cleanup of task-owned integrated Git state.
They grant no merge, issue mutation, publication, or unrelated delivery authority.
Skill selection, mode selection, and generated default prompts never grant merge authority.
Use the mutation authority contract for every merge decision.

## Use existing contracts

Read these completely when they apply:

1. `../pr/SKILL.md` for pull request creation, updates, CI, and review feedback.
2. `../adversarial-review/SKILL.md` for readiness.
3. `../adversarial-review/references/mutation-authority.md` for mutation and merge authority.
4. `../unit-tests/SKILL.md` before repairing behavior or validation.
5. `../../references/worktree-isolation.md` before local mutation or cleanup.

Follow repository instructions and delivery configuration. Use `dev-browser` for browser smoke tests.

Before browser work, read [browser](../browser/SKILL.md).
Verify the intended Chrome profile and the target site's signed-in identity.

Delegate detailed permissions, review gates, worktree isolation, and publication to those contracts.
Use [completion](references/completion.md) for the closure ledger and cleanup proof.

If `harlan-github-agent` already controls the repository, resume its existing worker. Do not start another watcher.

## Start ownership

Inspect local Git state and remote state. Select one exact target:

- `LocalWork`: current uncommitted or unpushed work.
- `PullRequest`: one open pull request and its exact head commit.
- `Revision`: one pushed commit without an open pull request.

Determine the intended result and applicable CI, merge, deployment, release, and smoke stages.

A Markdown-only pull request runs no CI unless a workflow event uses `paths` to include that Markdown.
After its merge, verify the merge commit on `origin/main` instead of a green check.

Ask only when multiple targets remain plausible or the intended result materially changes the work.

Keep the exact commit and delivery targets attached to ownership.

Record the user's exact action authority for the resolved target.

Pass that evidence to mutation authority. Ownership and completion requests alone never grant merge authority.

## Complete and review

Complete local work with the relevant domain skills and verification.

Use `pr` when code needs review. Use `adversarial-review` before deciding readiness.

Restart readiness after the remote head changes.

If `pr` uses the capacity fallback, finish the independent assessment and current-head CI.
That fallback stops the exact-head Service Review and cancels its queued Task.
Report the assessment, stopped Service Review, and outstanding human decision. End the interactive wait.
Do not await the cancelled Task or request another Review for that stopped head.
An independent assessment does not satisfy the `READY` merge gate or grant merge authority.
Retain ownership of the target for the human decision or a new head.
Do not report `VERIFIED` before all applicable delivery and smoke stages complete.

If an active Service Review or Repair Task still owns the work, hand off to that durable Task.
Name its exact state and next action. Never edit while its Repair Task is active.

## Land and follow

When authority permits, land the exact ready head through the repository's normal merge path.

Otherwise wait for the human merge decision and keep ownership active.

Follow the exact commit through every applicable delivery stage. Do not infer delivery success from unrelated green checks.

If newer work supersedes the target, explicitly adopt its commit or cancel ownership with evidence.

## Repair and recover

Prove a failure belongs to the owned change before editing.

Add a failing test first for behavior or validation regressions. Apply the smallest useful repair and verify it.

Use `chore: <specific problem>` for CI or delivery pipeline repairs. Use `fix:` for deployed product behavior.

Use the task branch for pre-merge repair. After merge, open a focused repair pull request from the current remote default branch.
Never push directly to the default branch.

If production remains unsafe, choose the safest viable recovery: repair, rollback, or block with evidence.

Keep trying while meaningful progress remains. Block after three failed repairs for the same cause.

## Smoke and close

Verify the result against a meaningful target and assertion.

For browser targets, check health, changed behavior, console errors, and one relevant critical path.

If smoke finds a regression, return to repair.

Update the existing marked comment or durable record. Preserve delivery and smoke evidence.

After smoke, follow [completion](references/completion.md) to finish loose ends, reconcile records, and clean task-owned state.
Close only as `VERIFIED`, `BLOCKED`, or `CANCELLED`.

Do not stop at an intermediate state while an expected CI, merge, deployment, release, or smoke event can progress.
