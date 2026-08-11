---
name: pr-triage
description: Triage all open pull requests in Harlan's owned GitHub repositories. Use when asked to review the PR backlog, refresh open PRs, get PRs merge-ready, repair failing PRs, sign off PRs, rank merge confidence, or decide which pull requests to merge next.
---

# PR Triage

Turn the owned PR backlog into a ranked merge queue. Update branches, repair code and metadata, re-review, post one explicit robot status, then summarize confidence. Never merge.

## Load the contracts

Read these files completely before discovery:

1. `../pr/SKILL.md`, the source of truth for PR metadata, verification, CI, and fix-forward rules.
2. `../humanize-writing/SKILL.md`, required before changing PR titles or bodies.
3. `references/review-contract.md`, the adversarial review, sign-off, and confidence contract.

Follow repository-local `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and pull request templates. A repository's instructions override generic verification commands.

## Enforce ownership

Mutate PRs only when the base repository is:

- Any non-archived repository whose owner exactly matches the authenticated GitHub login.
- `unjs/unhead`.

Always exclude:

- `nuxt/nuxt`.
- Every `unjs/*` repository except `unjs/unhead`.
- Any other organization repository, even when the authenticated user has admin or write access.

Treat this as a hard safety boundary. GitHub permissions do not prove ownership. Never broaden the allowlist without an explicit user instruction.

Run `scripts/discover-prs.sh` from this skill directory. It returns every human-authored open PR in the allowed base repositories. Exclude GitHub Apps and bot accounts, including dependency update bots. Use `--include-bots` only when the user explicitly requests bot PR triage. If discovery reaches GitHub's 1,000 result cap, stop before mutations and report incomplete discovery.

## Triage each PR

Process one PR at a time. Parallelize read-only GitHub queries when useful. Keep code changes isolated in a temporary clone created with `mktemp -d`.

### 1. Snapshot

Fetch the PR with:

```bash
gh pr view "$number" --repo "$repo" \
  --json additions,author,baseRefName,baseRefOid,body,changedFiles,commits,deletions,files,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,isDraft,latestReviews,maintainerCanModify,mergeStateStatus,mergeable,number,reviewDecision,reviews,statusCheckRollup,title,url
```

Fetch issue comments, inline review comments, and all review threads. Continue GraphQL pagination when `reviewThreads.pageInfo.hasNextPage` is true. Record unresolved threads and requested changes.

Recheck the exact base repository against the ownership allowlist before every mutation.

### 2. Establish branch write access

A head branch is mutable only when at least one condition holds:

- Its repository owner is the authenticated user.
- Its repository equals the base repository.
- `maintainerCanModify` is true.

Never force push, amend published commits, dismiss reviews, or push to the base branch. If a required change cannot be pushed, mark the PR blocked and explain the permission boundary in the final robot status.

### 3. Update from the actual base

Clone the base repository into the temporary directory and check out the PR head. Fetch the current `origin/<baseRefName>`.

Use the PR's actual base branch, not an assumed `main`. If the current base tip is not an ancestor of the PR head, merge it into the head branch. Resolve conflicts when the correct resolution is clear, verify the result, commit the merge, and push normally to the PR's head repository and exact head branch.

If a conflict cannot be resolved confidently, preserve the remote branch, mark the PR blocked, and continue to the next PR.

After every push, refetch the PR. Confirm the remote `headRefOid` matches the reviewed commit and `mergeable` is not `CONFLICTING`. Retry an `UNKNOWN` mergeability response three times before treating it as pending evidence.

### 4. Align metadata

Apply the title and body rules from `../pr/SKILL.md`. Preserve useful contributor context while normalizing:

- Conventional commit title, fewer than 70 characters.
- Linked issue section, using `No linked issue.` when none exists.
- Exactly one checked change type.
- Two or three concrete description sentences.
- Breaking change and migration sections only when applicable.

Humanize changed prose. Update metadata directly with `gh pr edit`; do not leave a comment asking the author to do it.

### 5. Review, repair, re-review

Inspect the complete base-to-head diff, not only the latest commit. Apply the adversarial checklist from `references/review-contract.md`.

When a material defect is found:

1. Add a failing test first for bugs and validation logic.
2. Fix the code in the PR branch.
3. Run focused checks, then repository-required checks.
4. Commit with a conventional fix-forward commit and push normally.
5. Restart from Snapshot and review the new remote head from scratch.

Resolve review threads only after their concern is fixed and verified. Do not post progress chatter or a sequence of review comments. Stop after three failed repair attempts for the same issue, mark it blocked, and continue.

### 6. Verify stable state

Use repository instructions and existing CI configuration to choose commands. Prefer the commands required by `../pr/SKILL.md` when available. Record exact commands and results.

Required evidence:

- Current base is an ancestor of the reviewed head.
- GitHub reports no merge conflict.
- Relevant local checks pass.
- Required CI checks pass.
- No unresolved material review finding or requested change remains.
- The reviewed SHA still equals the remote PR head.

Finish repairs across the backlog, then revisit pending CI once. Never sign off a stale SHA.

### 7. Post one robot status

Post only after the repair loop reaches a stable pass, pending, or blocked outcome. Follow the exact format and idempotent update procedure in `references/review-contract.md`.

Use an issue comment, never an approval review. The authenticated GitHub identity belongs to Harlan, so an approval would misrepresent the automated action. State plainly that the comment came from a robot and is not Harlan's personal review.

Update the existing marked comment on later runs instead of creating another. Include the reviewed head SHA, base SHA, outcome, confidence, and compact evidence.

## Return the merge queue

Sort results by confidence descending. Return:

| Confidence | PR | Outcome | Checked | Next action |
| --- | --- | --- | --- | --- |

Keep each cell concise. Group the table into:

1. High confidence, merge first.
2. Medium confidence, quick human check.
3. Low confidence, more work required.

Include skipped repositories or PRs and the exact safety reason. Never merge unless the user separately asks.

Example:

| Confidence | PR | Outcome | Checked | Next action |
| --- | --- | --- | --- | --- |
| 96/100 high | `owner/repo#42` | PASS | Base, metadata, review, tests, CI | Merge after human glance |
| 39/100 low | `owner/repo#17` | BLOCKED | Review passed; CI failed | Fix the failing Linux job |
