# Automated review contract

## Adversarial review

Review the entire base-to-head diff and its surrounding code. Disprove correctness where possible.

Check:

- Behavior against the linked issue and PR description.
- Boundary inputs, malformed data, empty states, and unexpected ordering.
- Error propagation, silent catches, partial writes, retries, and cleanup.
- Security boundaries, secrets, injection, authorization, and unsafe parsing.
- Data loss, concurrency, race conditions, idempotency, and rollback behavior.
- Public API compatibility, types, exports, runtime targets, and migrations.
- Performance regressions on hot or scaling-sensitive paths.
- Tests that would fail before the change and cover realistic regressions.
- Documentation for user-visible behavior.
- Repository architecture and local instructions.

Treat style-only preferences as non-blocking. Treat correctness, security, data loss, public API breakage, and missing regression coverage as material.

## Outcome gates

Use one outcome:

- `PASS`: Base current, conflict-free, metadata aligned, local verification passed, required CI passed, no material unresolved review concern, reviewed SHA unchanged.
- `PENDING`: No known defect, but evidence is incomplete, usually CI still running, mergeability unknown, or required checks unavailable.
- `BLOCKED`: Conflict, stale reviewed SHA, failing check, unresolved material finding, requested changes, or no permission to push a required repair.

Do not call `PENDING` or `BLOCKED` a sign-off.

## Confidence

Start at 100 after a complete adversarial review.

Deduct:

- 10 for a draft.
- 5 for a broad or unusually risky diff, even after targeted checks pass.
- 5 for limited local coverage when required CI is green.
- 5 for unresolved, non-actionable reviewer uncertainty.

Apply caps after deductions:

- 79 when required CI or mergeability evidence is pending or unavailable.
- 49 when requested changes or a material review concern remains.
- 39 when local verification or required CI fails.
- 29 when the branch is stale, conflicting, or a required repair cannot be pushed.

Bands:

- High: 90 to 100.
- Medium: 70 to 89.
- Low: 0 to 69.

Never inflate confidence to fill a band. State the deduction or cap in the final queue.

## Bot status

Use this marker exactly:

```markdown
<!-- harlan-agent-kit:pr-triage -->
```

Render at most five compact evidence bullets:

```markdown
<!-- harlan-agent-kit:pr-triage -->
### 🤖 Harlan Agent Kit automated review

🤖 Bot review: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) posted this comment. It is not Harlan's personal review or approval. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).

**PASS · 96/100 confidence**

- Reviewed `HEAD_SHA` against `BASE_BRANCH@BASE_SHA`
- Base current; GitHub reports no conflicts
- PR title and body match the project template
- Adversarial code review found no remaining material issues
- Passed: `COMMANDS`; required CI `PASSED/TOTAL`

Human merge decision still required.
```

For `PENDING` or `BLOCKED`, replace the pass claim with the exact incomplete or failed evidence and the next action. Keep the identity statement unchanged.

## Deployment extension

When `pr-owner` is active, update the same marked comment after merge. Preserve the review outcome and evidence.

Append the merge SHA, deployment outcome, production target, and smoke evidence. Replace `Human merge decision still required.` with the current ownership state.

Use `Deployment: VERIFIED`, `Deployment: PENDING`, or `Deployment: BLOCKED`. Never claim `VERIFIED` from CI alone.

## Idempotent posting

List issue comments through:

```bash
gh api "repos/$repo/issues/$number/comments" --paginate
```

Find the newest comment authored by the authenticated login whose body contains the exact marker. Create one when absent. Otherwise update that comment with:

```bash
gh api --method PATCH "repos/$repo/issues/comments/$comment_id" --input payload.json
```

Build `payload.json` from the final body with `jq`; do not interpolate JSON manually. Never modify another author's marked comment.
