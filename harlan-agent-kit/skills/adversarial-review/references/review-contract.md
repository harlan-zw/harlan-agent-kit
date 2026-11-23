# Automated review contract

## Adversarial review

Review the entire base-to-head diff and its surrounding code. Disprove correctness where possible.

Check:

- Behavior against the linked issue and PR description.
- Every image in the PR description and in comments by the PR author, with visual inspection for UI defects.
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

Do not report style preferences. Record credible defects with an impact score from 0 to 100.
Score harm if merged unfixed. Consider likelihood, affected users, blast radius, and reversibility.
Scores from 81 to 100 require action. Scores from 0 to 80 stay Logged without Repair.
Logged findings are follow-ups. Record their proposed next action with the finding.
They never block Review or start automatic Repair.
Do not raise a score to trigger Repair. Visible UI defects can qualify when they harm use.
Use 81 to 90 for common broken paths or wrong results without a practical workaround.
Use 91 to 100 for credible data loss, security bypass, or broad outage.
Use 0 to 80 for limited, recoverable defects. Log their proof without starting Repair.

Treat a clearly labelled `Before` image as historical evidence. Verify the current head before recording a finding.

## Outcome gates

The controller records `Passed`, `Pending`, or `Failed` for three gates:

| Gate | Passed | Pending | Failed |
| --- | --- | --- | --- |
| Merge | GitHub reports conflict-free | Mergeability unknown, or conflicts with repair active | Conflicts present |
| Review | The Agent report has no finding above 80/100 | Never, a valid Agent report completes this gate | One or more findings score above 80/100 |
| CI | Every GitHub Actions check run passed | GitHub Actions CI unavailable, running, or blocked by a confirmed head or base failure with repair active | The PR caused a GitHub Actions check run to fail, or repair exhausted its attempts |

Only check runs from the `github-actions` app count as CI. Ignore commit statuses
and check runs from other apps, even when GitHub branch rules require them.
Do not mention ignored checks in the Review finding or status comment.
Available empty base and head Actions check snapshots pass CI.
An unavailable Actions snapshot stays `Pending`.

Head stability is an invariant. Store the Agent report against its exact
Revision before later GitHub reads. If the head moved, keep that history but
never publish it against the new head. Metadata and focused verification are
Review evidence, not separate workflow gates.

Derive one outcome without judgment:

1. Any `Failed` gate gives `BLOCKED`.
2. Otherwise, any `Pending` gate gives `PENDING`.
3. Every gate `Passed` gives `READY`.

Gate outcomes are deterministic. Confidence never changes an outcome. Do not show
`PENDING` or `BLOCKED` a confidence score or call either a sign-off.

The Agent returns only the premise, scored findings, and confidence. It never
returns workflow state. The controller derives every gate and the outcome.

## Confidence

The Agent calculates confidence for every report. Start at 100 after the
adversarial review completes. The controller keeps it while merge or CI moves,
but shows it only after every gate passes.

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

Create the marked comment when review starts. Edit that same comment again when review finishes. Never create a second progress comment.

Before dispatch, find trusted marked comments for the current head commit. Trust the GitHub App and repository owners, members, or collaborators. Ignore marked comments from outside contributors. A terminal comment means the head commit is already reviewed. A `Reviewing` comment is status only. Local Task ownership decides whether work is active.

For comments created before the hidden head commit marker, recognize `- Reviewed \`HEAD_SHA\` against`. Readers also accept the `### 🤖 READY` heading of a comment written before the Status line. Write only the current format.

Every comment starts with one Status line: a dot, the outcome in bold, and one fact only this comment knows.
⚪ means the agent has the work. 🟢 means READY. 🟠 means Harlan or the author must act. 🟣 means merged or published.
Write the outcome in sentence case: Ready, Pending, Blocked, Reviewing.
Every comment ends with one `<sub>` footer that names the bot, says it is not Harlan's, and links the AI policy.

Use this nonterminal shape:

```markdown
<!-- harlan-agent-kit:pr-triage -->
<!-- reviewed-sha: HEAD_SHA -->
<!-- workflow-state: {"_tag":"Reviewing","headSha":"HEAD_SHA","baseSha":"BASE_SHA"} -->
⚪ **Reviewing** `SHORT_HEAD_SHA` · this comment updates when it finishes

<sub>Last review of `SHORT_PRIOR_SHA`: OUTCOME, N issues. A new commit replaced it.</sub>

<sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
```

Keep this body steady while Review runs, so one Review writes one in-progress edit. Include the history line only when the newest Review answered an earlier head. OUTCOME is the verdict the last gate refresh settled, in sentence case. Omit `, N issues` when no Open finding remains. After a Repair push, end it with `Repair pushed this commit.` Keep findings out until verified.

The controller reads the Agent's own `▓▓▓░░ NN% next-step` line and records that text as the phase in the Dashboard. Without one, the controller guesses the phase from the shape of each shell command.

Keep the reviewed SHA in hidden metadata. The visible body reports what the Review checked, the issues to fix, Logged follow-ups, and fixes.

```markdown
<!-- harlan-agent-kit:pr-triage -->
<!-- reviewed-sha: HEAD_SHA -->
🟢 **Ready** · `96/100`

Checked WHAT_THE_REVIEW_EXERCISED. Not checked: LARGEST_GAP.

<sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's; a person merges · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
```

When Review found issues, the Status line reads `🟠 **Blocked** · N issues to fix before merge`. Show each finding once:

```markdown
1. **CONSEQUENCE_TITLE** `IMPACT/100`  
   `FILE:LINE` · Fix: NEXT_ACTION
2. **CONSEQUENCE_TITLE** `IMPACT/100`  
   `FILE:LINE` · Dismissal recommended.

- ~~SHORT_DESCRIPTION~~ fixed

<details><summary><b>N follow-ups</b> · none block merge</summary>

- `IMPACT` CONSEQUENCE_TITLE · `FILE:LINE`

</details>

<sub>N notes below 40/100 not shown.</sub>
```

Number the issues to fix. Fold the Logged follow-ups. Count Logged findings below 40/100 and never list them.

Do not list the reviewed SHA, base state, metadata conformance, commands run, passed
checks, CI counts, merge conflicts, review lanes, or other routine evidence in the visible body.
GitHub's merge box already shows CI and conflicts. Preserve that evidence in the review record outside the comment when available.

For Pending, the Status line says what the verdict waits for. For Blocked by a failed gate alone, name the gate in two or three words, such as `merge conflict; the review itself passed`. Quote operational or
permission blockers. Keep the exact outcome reason and next action.

## Structured Repair handoff

Record every evidence-backed Review finding. Never cap the finding count.

Each finding records impact, a stable fingerprint, exact path and line, proof, summary, and proposed next action.
An actionable finding also records its resolution.

Decide the pull request premise once before classifying findings.

A sound premise means safe fixes preserve the pull request intent. Findings above 80 use `Repair` and record the regression test the fresh Repair Agent must write first. A finding no test can cover, such as a stale comment or documentation, records none.

A wrong premise means safe fixes must reverse the intent, remove a safeguard, or add unrelated root architecture. Findings above 80 use `Dismissal` and record no regression test.

Findings at 80 or below use `Logged`, regardless of premise. They do not fail the Review gate or queue Repair.

Never mix `Repair` and `Dismissal` findings. For an actionable wrong premise, queue no Repair.
Publish Blocked with Action required. Harlan decides whether to Dismiss.

## Deployment extension

When `take-ownership` is active, update the same marked comment after merge. Preserve the review outcome and evidence.

Before merge, replace `a person merges` in the footer only when explicit merge authority exists.
Use `merge authorized by explicit user request` for that state.

Keep the merge SHA in hidden metadata. Add the deployment outcome, production
target, smoke evidence, and current ownership state as one `<sub>` line above the footer. Add
a visible issue only when deployment found or fixed a material issue.

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

## Review outcome labels

A terminal status needs its confirmed comment and the matching Review outcome label, when the table lists one.
Apply this contract during standalone reviews and when reusing a trusted terminal comment.
For controller-dispatched Review, the controller owns publication. Its Agents must never write GitHub comments or labels.
The controller requires stored Review evidence for the current Revision before publishing. A trusted comment alone cannot replace that evidence.

| Outcome | Label | Color |
| --- | --- | --- |
| `READY` | `harlan-agent-ready` | `0e8a16` |
| `PENDING` | none, so only remove the labels in step 5 | none |
| `WAITING` on a Baseline repair | `harlan-agent-pending` | `fbca04` |
| `BLOCKED` | `harlan-agent-blocked` | `d73a4a` |

1. Establish mutation authority before writing labels. If authority is missing, report incomplete publication.
2. Refetch the pull request before writing. Require an open pull request whose head matches the comment's reviewed SHA.
3. If the head changed, restart Review. Never apply the previous outcome to the new head.
4. If the repository lacks the matching label, create it with the listed color. Surface creation failures.
5. Add the matching label. Remove the other Review outcome labels, `harlan-agent-running`, `harlan-agent-review-required`, and `harlan-agent-review-skipped`.
6. Preserve all other labels, including `harlan-agent-review` and `harlan-agent-auto-merge`. Review publication never grants merge authority.
7. Refetch the pull request and comment. Confirm the head, open state, comment outcome, and matching label. Confirm the conflicting labels are absent.

If confirmation finds a changed head or closed pull request, remove the outcome label this publication added. Report any cleanup failure.
If the head changed, restart from Snapshot. If the pull request closed, stop Review.
If a write fails on the same head, retain the confirmed comment and retry label publication alone.
Do not rerun Review or create another comment to repair a missing label.
Return completion only after both the comment and labels pass confirmation.

## Local journal

When `harlan-github-agent` dispatches Review, record one immutable Review run against the exact Revision.
Record it before any later GitHub read or Publication.
Store the three gates, evidence digests, Review findings, Review outcome, Agent version, skill digest, and timestamps.
Store duration and Agent provider token usage.
Use an explicit unavailable state when the Agent provider reports no usage.
Keep the Agent confidence for every report. Show it only for `READY`.

For an outside contributor, reject the Review run unless the same Revision has Review and repair Approval. Queue verified repairs under that Approval.

Carry Approval only to an exact repair commit published by the controller for the approved Revision.

After each GitHub write, record one Publication with the exact Markdown and the
GitHub comment ID and URL. If the write fails, record the attempted Markdown and
failure reason. Retry that controller write from the stored Review run. Never
repeat the Agent turn for a later GitHub read or write failure. Refresh merge
and CI gates as often as they move on the same head commit. Never store secrets
or full tool transcripts.

Reject a Review run when its Revision or head SHA does not match. Reject duplicate
identifiers with different content. A dispatched review remains incomplete until
both its Review run and Publication result are durable.
