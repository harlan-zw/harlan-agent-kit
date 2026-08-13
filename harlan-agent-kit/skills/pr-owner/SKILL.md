---
name: pr-owner
description: Own one pull request from creation or review through merge, deployment, and production smoke verification. Use instead of the plain PR workflow for personal site repositories mapped under ~/sites, or when the user says "own this PR", "take this PR end to end", "watch this through deploy", or asks an agent to remain responsible after merge. Never use post-merge repair authority on repositories owned by another account or organization.
---

# PR Owner

Own one PR until its production result is verified or visibly blocked. A merge is an intermediate state.

Personal site repositories under `~/sites` enable this convention by default. Other repositories require explicit selection.

## Load contracts

Read these completely:

1. `../adversarial-review/SKILL.md` for review, repair, and the bot status.
2. `../adversarial-review/references/mutation-authority.md` for the narrow default branch repair boundary.
3. `../adversarial-review/references/review-contract.md` for the deployment status extension.
4. `../pr/SKILL.md` when creating or updating the PR.

Read repository instructions and deployment configuration. Use `dev-browser` for browser smoke tests.

## Eligibility

Enable direct post-merge repair only when the base repository owner equals the authenticated GitHub login and its canonical mapped checkout is under `~/sites`.

Never directly repair the default branch of `nuxt/nuxt`, `unjs/unhead`, another `unjs/*` repository, or any repository owned by another account or organization.

If the PR is ineligible, retain review ownership only. Stop at merge and record that deployment ownership is disabled.

## Lifecycle

Run each phase in order. Resume the same durable session when new evidence arrives.

### 1. Register ownership

Record repository ID, PR number, initial head SHA, default branch, canonical checkout, production targets, required workflows, and smoke commands.

Keep one durable agent session for the PR. Resume it after CI, review, merge, deployment, or smoke events.

### 2. Create and review

Use `pr` when the PR does not exist. Run `adversarial-review` before merge readiness.

Do not merge. Wait for the human merge decision.

### 3. Detect merge

Poll and reconcile webhook events until GitHub reports the PR merged or closed.

On merge, record the merge commit SHA and the exact default branch head. Cancel ownership when the PR closes unmerged.

### 4. Follow deployment

Track required workflows, GitHub deployments, and provider checks started from the merge commit or its default branch descendants.

Do not infer deployment success from an unrelated green workflow. Match the commit, environment, workflow identity, and configured production target.

### 5. Repair failures

When an owned site fails CI or deployment, prove the failure belongs to the owned merge before editing.

Create an isolated worktree from the current remote default branch. Add a failing test when behavior or validation broke. Apply the smallest repair and run focused checks.

For CI-only repairs, use `chore: fix ci`. For a production behavior repair, use a precise conventional `fix:` subject.

Recheck the remote default branch SHA immediately before a normal push. If it changed, rebuild the repair on the new head. Never force push or bypass branch protection.

If branch protection rejects the push, create a normal repair PR through `pr`. Never weaken protection.

Stop after three failed repairs for the same cause. Mark deployment `BLOCKED` with exact evidence.

### 6. Smoke production

Wait until the matched deployment reports success, then test the configured production URL.

Check HTTP health, the changed route or behavior, browser console errors, and one repository-specific critical path. Use changed files and the PR description to choose relevant smoke coverage.

Never claim success when no production target or meaningful assertion is configured. Use `PENDING` and state what is missing.

If smoke verification exposes a regression, return to Repair failures.

### 7. Close ownership

Update and confirm the existing marked bot comment. Preserve review evidence and append merge SHA, deployment target, deployment outcome, and smoke evidence.

Close ownership only with `Deployment: VERIFIED`, `Deployment: BLOCKED`, or an explicit cancellation. Clean the worktree after closure.

## Examples

Examples:

Input: `Own this site PR through production`

Output:

```text
owner/site#42 · Deployment: VERIFIED · MERGE_SHA · https://site.example/path · COMMENT_URL
```

Input: `Watch this through deploy`

Output:

```text
owner/site#17 · Deployment: BLOCKED · chore: fix ci failed three times · COMMENT_URL
```
