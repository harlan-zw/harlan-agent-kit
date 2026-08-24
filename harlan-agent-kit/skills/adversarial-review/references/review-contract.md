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
- Code comments against `../../../references/code-comments.md`.
- Repository architecture and local instructions.

Treat style-only preferences as non-blocking. Treat correctness, security, data loss, public API breakage, and missing regression coverage as material.

## Outcome gates

Record `passed`, `waiting`, or `failed` for every gate:

| Gate | Passed | Waiting | Failed |
| --- | --- | --- | --- |
| Head | Base current; reviewed SHA unchanged | Head or base state unavailable | Head changed after review freeze |
| Merge | GitHub reports conflict-free | Mergeability unknown | Conflicts present |
| Metadata | Required metadata aligned | Required metadata review incomplete | Required metadata cannot be aligned |
| Review | Full diff reviewed; zero open material findings or requested changes | Review incomplete or PR is a draft | Material finding or requested change remains |
| Verification | Focused behavior checks passed when needed, or CI covers the reviewed behavior | A material finding cannot be verified and CI does not cover it | A focused behavior check failed |
| CI | Every required check passed | Required CI unavailable, running, or blocked by a confirmed base failure with repair active | The PR caused required CI failure, or baseline repair exhausted its attempts |

Derive one outcome without judgment:

1. Any `failed` gate gives `BLOCKED`.
2. Otherwise, any `waiting` gate gives `PENDING`.
3. Every gate `passed` gives `READY`.

Gate outcomes are deterministic. Confidence never changes an outcome. Do not give
`PENDING` or `BLOCKED` a confidence score or call either a sign-off.

## Confidence

Calculate confidence only for `READY`. Start at 100 after all gates pass.

Deduct:

- 5 for a broad or unusually risky diff, even after targeted checks pass.
- 5 for limited local coverage when required CI is green.
- 5 for unresolved, non-actionable reviewer uncertainty.

Bands:

- High: 90 to 100.
- Medium: 70 to 89.
- Low: 0 to 69.

Never inflate confidence to fill a band. State each deduction in the final queue.

## Review status

Use this marker exactly:

```markdown
<!-- harlan-agent-kit:pr-triage -->
```

Create the marked comment when review starts. Edit that same comment after each phase transition. Never create a second progress comment.

Before dispatch, find trusted marked comments for the current head commit. Trust the GitHub App and repository owners, members, or collaborators. Ignore marked comments from outside contributors. A terminal comment means the head commit is already reviewed. A `REVIEWING` comment means another agent has the review. Do not start another agent.

For comments created before the hidden head commit marker, recognize `- Reviewed \`HEAD_SHA\` against`. Write only the current format.

Use this nonterminal shape:

```markdown
<!-- harlan-agent-kit:pr-triage -->
<!-- reviewed-sha: HEAD_SHA -->
### 🤖 REVIEWING · PHASE

> [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) posted this automated review. [AI open source policy](https://harlanzw.com/blog/ai-in-open-source). Last updated: UTC_TIME.

`▓▓░░░ 35%`

Next: SHORT_ACTION
```

Use the percentage reported by the agent. Update only at a phase transition or changed blocker. Keep findings out until verified.

Keep the reviewed SHA in hidden metadata. Render one robot emoji. Put disclosure,
policy, waiting state, and human ownership in one blockquoted line. The visible
review body only reports material issues found or fixed.

```markdown
<!-- harlan-agent-kit:pr-triage -->
<!-- reviewed-sha: HEAD_SHA -->
### 🤖 READY · 96/100

> [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) posted this automated review. It is not Harlan's personal review or approval. [AI open source policy](https://harlanzw.com/blog/ai-in-open-source). Human merge decision still required.

`▓▓▓▓▓ 100%`
```

When Review found issues, show every material finding once:

```markdown
- **Fixed:** SHORT_DESCRIPTION
- **Open:** SHORT_DESCRIPTION. Next: NEXT_ACTION
- **Dismissal recommended:** SHORT_DESCRIPTION. Next: Dismiss this pull request.
```

Do not list the reviewed SHA, base state, metadata conformance, commands, passed
checks, CI counts, review lanes, or other routine evidence in the visible body.
Preserve that evidence in the review record outside the comment when available.

For `PENDING`, append one short reason to that line. For `BLOCKED`, report the
blocker as an open issue when it affects the pull request. Quote operational or
permission blockers. Keep the exact outcome reason and next action. Do not use
an issue bullet for a clean result.

## Structured Repair handoff

Record every material Review finding. Never cap the finding count.

Each finding records a stable fingerprint, exact path and line, proof, summary, next action, and resolution.

A `Repair` finding also records the regression test the fresh Repair Agent must write first.

A `Dismissal` finding records no regression test. Use it only when the premise is wrong and Repair would replace the pull request intent.

When any finding recommends Dismissal, queue no Repair. Publish `BLOCKED` with Action required. Harlan decides whether to Dismiss.

## Deployment extension

When `take-ownership` is active, update the same marked comment after merge. Preserve the review outcome and evidence.

Before merge, replace `Human merge decision still required.` only when explicit merge authority exists.
Use `Automated merge authorized by explicit user request.` for that state.

Keep the merge SHA in hidden metadata. Append the deployment outcome, production
target, smoke evidence, and current ownership state to the blockquoted line. Add
a visible issue bullet only when deployment found or fixed a material issue.

Use `Deployment: VERIFIED`, `Deployment: PENDING`, or `Deployment: BLOCKED`. Never claim `VERIFIED` from CI alone.

## Idempotent posting

List issue comments through:

```bash
gh api "repos/$repo/issues/$number/comments" --paginate
```

Find the newest comment authored by the authenticated login whose body contains the exact marker. Before creation, repeat the trusted current head commit check. Create one when absent. Otherwise update that comment with:

```bash
gh api --method PATCH "repos/$repo/issues/comments/$comment_id" --input payload.json
```

Build `payload.json` from the final body with `jq`; do not interpolate JSON manually. Never modify another author's marked comment.

## Local journal

When `harlan-github-agent` dispatches Review, record one immutable Review run
against the exact Revision before publication. Store the six gates, evidence
digests, Review findings, derived outcome, agent version, skill digest, and
timestamps. Store confidence only for `READY`.

For an outside contributor, reject the Review run unless the same Revision has Review and repair Approval. Queue verified repairs under that Approval.

Carry Approval only to an exact repair commit published by the controller for the approved Revision.

After each GitHub write, record one Publication with the exact Markdown and the
GitHub comment ID and URL. If the write fails, record the attempted Markdown and
failure reason. Never store secrets or full tool transcripts.

Reject a Review run when its Revision or head SHA does not match. Reject duplicate
identifiers with different content. A dispatched review remains incomplete until
both its Review run and Publication result are durable.
