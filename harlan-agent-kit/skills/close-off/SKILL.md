---
name: close-off
description: "Finish remaining task work, verify delivery, reconcile records, and safely clean task-owned worktrees and branches. Use after a merge or deploy, or when the user asks what remains, asks for follow-up, or says close off, wrap up, or finish up."
user_invocable: true
argument-hint: "[work item, pull request, or branch]"
---

# Close Off

Close one current work item completely.

Finish required loose ends before reconciling records and cleaning task-owned state.

## Use existing contracts

Read these contracts completely when they apply:

1. `../take-ownership/SKILL.md` for an open pull request, revision, delivery, release, or smoke path.
2. `../pr/SKILL.md` when local changes need review or an existing pull request needs updates.
3. `../adversarial-review/SKILL.md` before any readiness or merge decision.
4. `../unit-tests/SKILL.md` before repairing behavior or validation.
5. `../../references/worktree-isolation.md` before local mutation or cleanup.

Use the matching domain skill for repairs. Do not copy loaded workflows here.

## Authority

Closing off authorizes safe cleanup of task-owned integrated Git state.

This includes the exact merged pull request branch in an owned repository.

It grants no merge, issue mutation, publication, or unrelated delivery authority.

Existing user instructions can grant those actions for the current work item.

## 1. Fix the closure target

Start from the current conversation. Resolve one work item and its named repositories.

Use `$ARGUMENTS` when it names a work item, pull request, branch, issue, or work brief.

Record its closure contract:

1. The intended result.
2. Every promise made during the task.
3. Every reported failure or untested path.
4. Every explicit deferral.
5. Exact repositories, revisions, pull requests, issues, and work briefs.
6. Existing authority for external actions.

Inspect the current summary when conversation compaction occurred.

Use durable Git and GitHub evidence when earlier detail is unavailable.

Search local session history only when the work item identifies the missing session.

Never run a broad history search by default.

Ask once only when plausible targets require materially different or destructive actions.

## 2. Build the closure ledger

Inspect applicable state before editing. Run independent read-only checks in parallel.

### Conversation state

Find unfinished promises, workarounds, follow-ups, and blockers.

Collect unfinished task-owned agent or background command results before cleanup.

### Local state

Inspect branches, changes, divergence, unpushed commits, live claims, task worktrees, processes, and temporary files.

Never infer file ownership from location alone.

### Remote and delivery state

Fetch current state and prune stale tracking references.

Inspect the exact pull request head, gates, linked records, superseding work, and remote head branch.

Check whether another open pull request uses that branch.

Determine whether deployment, migration, release, smoke verification, or monitoring applies.

For Markdown-only work, verify the exact commit on `origin/main`.
Expect no CI or deployment unless a workflow event uses `paths` to include that Markdown.

Never infer delivery from a merged pull request or unrelated green check.

### Durable records

Inspect each work brief, plan, status document, marked review comment, or task ledger.

## 3. Classify every loose end

Classify each item:

1. `Required`: needed for the intended result.
2. `RelatedDefect`: the same failure category in a directly adjacent consumer.
3. `Superseded`: replaced by newer verified work.
4. `Deferred`: useful work outside the intended result.
5. `UnknownOwnership`: ownership cannot be proved.

Finish every `Required` item.

Preserve `UnknownOwnership` items. Record `Deferred` items without starting them.

Prove replacement delivery before closing `Superseded` items.

## 4. Run one related defect sweep

Perform this step only when the work fixed a defect category.

Check directly adjacent surfaces once:

1. Consumers of the changed export or contract.
2. Call sites of the repaired helper.
3. Equivalent routes, components, jobs, or configuration paths.
4. Tests and documentation tied to the behavior.

Fix confirmed instances of the same defect category.

Use a failing test first when required. Stop after one bounded pass.

Do not begin unrelated polish, architecture work, or backlog items.

## 5. Finish required work

For task-owned local changes, separate exact paths from unknown work.

Complete them, run applicable checks, then use `pr` when review is required.

For an open pull request or revision, resume `take-ownership`.

For a merged pull request, verify its revision on the default branch.

Complete every applicable delivery stage already inside the intended result.

Repair attributable failures through the loaded contracts.

Wait while CI, review, deployment, release, or smoke work can still progress.

Do not stop at an intermediate state.

## 6. Reconcile durable records

Update existing work briefs and ledgers with current evidence.

Move briefs to shipped only after delivery verification.

Preserve exact revisions, commands, URLs, and smoke assertions for handoffs.

Issue comments, issue closure, review replies, and publications keep normal approval requirements.

Draft the exact text when publication approval is missing.

## 7. Clean task-owned state

Cleanup starts only after the work reaches `VERIFIED`, `BLOCKED`, or `CANCELLED`.

Before deleting a task worktree or branch, prove:

1. No live agent or process owns it.
2. The worktree is clean.
3. Its tip matches the exact merged pull request head, or it is an ancestor of the destination.
4. The pull request's merge commit exists on the destination, or Git proves full integration.
5. No open pull request uses the branch.
6. It is not a default, protected, shared, or unknown branch.

Squash and rebase merges leave unique source commits.

The exact merged head and destination merge commit prove those branches safe to remove.

Then clean in this order:

1. Stop only task-owned temporary processes.
2. Remove only task-owned temporary files.
3. Release the task's worktree claim.
4. Run `wt remove <branch>` for each eligible worktree.
5. Run `git branch -d <branch>` when Git reports the remaining local branch merged.
6. After `wt list` proves no checkout uses it, run `git update-ref -d refs/heads/<branch> <expected-head>`.
7. Delete the remote with `git push --force-with-lease=refs/heads/<branch>:<expected-head> origin :refs/heads/<branch>`.
8. Fetch and prune stale tracking references again.

`wt remove` may delete the integrated local branch itself.

Use `wt` for worktree mutations, without `--force`, `--force-delete`, or `--clobber`.

Never delete a local ref without its expected old SHA, or when integration proof is missing.

If safe deletion fails, preserve the state and report why.

Fast-forward a canonical default checkout only when it is clean and unclaimed.

Never switch or rewrite a checkout during cleanup.

## 8. Close with evidence

Use one terminal state from `take-ownership`:

1. `VERIFIED`: the intended result works and no actionable task-owned loose end remains.
2. `BLOCKED`: progress needs new authority or external state. Name the blocker and next action.
3. `CANCELLED`: the user abandoned the result. Preserve useful work and complete safe cleanup.

For `VERIFIED`, required records must match reality.

Cleanup must complete or preserve each item for a stated safety reason.

## Final response

Lead with the terminal state and outcome.

List only unresolved items requiring the user.

Name any preserved worktree or branch. Report end-to-end confidence.

## Boundaries

Default scope is the current conversation and current repository.

Include another repository only when the intended result already names it.

This skill does not triage the general backlog.

It does not inspect unrelated worktrees across the machine.

It does not start the next work item.
