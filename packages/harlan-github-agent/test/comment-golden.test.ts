import type { PackageReleaseRecord, ReleaseNote } from '../src/package-release-store.ts'
import type { PackageReleasePlan } from '../src/package-release.ts'
import type { QueuedReviewStatus, StoppedReview } from '../src/store.ts'
import type { ReviewFinding, ReviewGates, ReviewGateState } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { createApprovalController } from '../src/approval-controller.ts'
import { issueTriageComment } from '../src/issue-triage-comment.ts'
import { progressComment, terminalComment } from '../src/item-agent.ts'
import { nativeReviewBody } from '../src/native-review.ts'
import { packageReleaseStatus } from '../src/package-release-controller.ts'
import { renderManualMajorRelease } from '../src/package-release.ts'
import { reviewSkippedComment } from '../src/pull-request-triage.ts'
import { queuePositionComment } from '../src/queue-position-sweep.ts'
import { ok } from '../src/result.ts'
import { resolvedThreadBody, reviewFindingThreadBody } from '../src/review-finding-threads.ts'
import { repairProgressComment } from '../src/review-status-controller.ts'
import { stoppedReviewComment } from '../src/review-stop-sweep.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

// One golden body per state family. A template change shows here as a diff a
// reviewer reads, instead of a scattered `toContain` that still passes.
const repository = 'harlan-zw/example'
const head = '6aa6d8e1520848daef9646d402ea16ee3f9a4221'
const base = '70edfe5f32699f7f6042c0bd66e8a68e3b282fc5'
const prior = '19c6342ed161f0542c8da0656ec199a3fc118b14'
const at = '2026-11-23T15:03:00.000Z'
const evidence = [{ label: 'gate', sha256: 'a'.repeat(64) }]
const passed: ReviewGateState = { _tag: 'Passed', evidence }
const gates = (overrides: Partial<ReviewGates> = {}): ReviewGates => ({ merge: passed, review: passed, ci: passed, ...overrides })

function followUp(impact: number, summary: string, line: number): Extract<ReviewFinding, { _tag: 'Logged' }> {
  return {
    _tag: 'Logged',
    impact,
    summary,
    nextAction: 'Query for span overlap with the viewport.',
    details: { fingerprint: String(impact).padStart(64, 'f'), identity: summary, location: { path: 'src/timeline-store.ts', line }, proof: 'When a bar crosses the viewport edge, the query drops it.' },
  }
}
const issue = {
  _tag: 'Open',
  impact: 86,
  summary: 'Draft saves skip approval when HOME is unset',
  nextAction: 'Fail closed when neither XDG_CONFIG_HOME nor HOME is absolute.',
  resolution: 'Repair',
  details: { fingerprint: 'b'.repeat(64), identity: 'home-unset', location: { path: 'hooks/himalaya-read-only.sh', line: 30 }, proof: 'With HOME unset, the config path resolves to /.config. The guard reads a missing file as permission.', regressionTest: 'Unset HOME and expect a denial.' },
} satisfies Extract<ReviewFinding, { _tag: 'Open' }>
const followUps = [followUp(79, 'Finished bars disappear at a viewport boundary', 83), followUp(55, 'Zero deliveries for an unmeasured interval', 208), followUp(29, 'Duplicate Task bars on wide viewports', 8)]

describe('review verdict', () => {
  it('renders READY, PENDING, and both BLOCKED shapes', () => {
    const verdict = (overrides: Partial<Parameters<typeof terminalComment>[0]>) => terminalComment({
      headSha: head,
      baseSha: base,
      gates: gates(),
      findings: [],
      confidence: 90,
      reportedChecks: [],
      repository,
      commands: ['Change', 'Rerun'],
      reviewedAt: at,
      ...overrides,
    })
    expect(verdict({ findings: followUps, checked: 'Timeline reads against dense windows', notChecked: 'the dashboard in a browser', history: { _tag: 'AfterRepair', priorHeadSha: prior, priorOutcome: 'Blocked', findings: 2 } })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"Review","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","baseSha":"70edfe5f32699f7f6042c0bd66e8a68e3b282fc5","outcome":"READY","gates":{"merge":"Passed","review":"Passed","ci":"Passed"}} -->
      🟢 **Ready** · \`90/100\`

      Repair fixed 2 issues from \`19c6342\`. Checked Timeline reads against dense windows. Not checked: the dashboard in a browser.

      <details><summary><b>2 follow-ups</b> · none block merge</summary>

      - \`79\` Finished bars disappear at a viewport boundary · [\`timeline-store.ts:83\`](https://github.com/harlan-zw/example/blob/6aa6d8e1520848daef9646d402ea16ee3f9a4221/src/timeline-store.ts#L83)
      - \`55\` Zero deliveries for an unmeasured interval · [\`timeline-store.ts:208\`](https://github.com/harlan-zw/example/blob/6aa6d8e1520848daef9646d402ea16ee3f9a4221/src/timeline-store.ts#L208)

      </details>

      <sub>1 note below 40/100 not shown.</sub>

      <sub><relative-time datetime="2026-11-23T15:03:00.000Z">2026-11-23 15:03 UTC</relative-time> · [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's; a person merges · [AI policy](https://harlanzw.com/blog/ai-in-open-source) · \`@harlan-agent rerun\` · \`@harlan-agent <change>\`</sub>"
    `)
    expect(verdict({ gates: gates({ ci: { _tag: 'Pending', reason: 'test is still running.', evidence } }), mergeRisk: { _tag: 'Sensitive', reason: 'A migration changes the Journal schema.' } })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"Review","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","baseSha":"70edfe5f32699f7f6042c0bd66e8a68e3b282fc5","outcome":"PENDING","gates":{"merge":"Passed","review":"Passed","ci":"Pending"}} -->
      ⚪ **Pending** · the review passed; the verdict waits for CI

      <sub>test is still running.</sub>

      Merge risk: **Sensitive**. A migration changes the Journal schema.

      No issues found in [\`6aa6d8e\`](https://github.com/harlan-zw/example/commit/6aa6d8e1520848daef9646d402ea16ee3f9a4221).

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's; a person merges · [AI policy](https://harlanzw.com/blog/ai-in-open-source) · \`@harlan-agent rerun\` · \`@harlan-agent <change>\`</sub>"
    `)
    expect(verdict({ gates: gates({ review: { _tag: 'Failed', reason: issue.summary, evidence } }), findings: [issue, { ...issue, summary: 'Continued shell lines evade the guard', impact: 92, resolution: 'Dismissal' }, ...followUps], confidence: undefined, commands: ['Rerun'] })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"Review","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","baseSha":"70edfe5f32699f7f6042c0bd66e8a68e3b282fc5","outcome":"BLOCKED","gates":{"merge":"Passed","review":"Failed","ci":"Passed"}} -->
      🟠 **Blocked** · 2 issues to fix before merge

      1. **Draft saves skip approval when HOME is unset** \`86/100\`  
         [\`himalaya-read-only.sh:30\`](https://github.com/harlan-zw/example/blob/6aa6d8e1520848daef9646d402ea16ee3f9a4221/hooks/himalaya-read-only.sh#L30) · Fix: Fail closed when neither XDG_CONFIG_HOME nor HOME is absolute.
      2. **Continued shell lines evade the guard** \`92/100\`  
         [\`himalaya-read-only.sh:30\`](https://github.com/harlan-zw/example/blob/6aa6d8e1520848daef9646d402ea16ee3f9a4221/hooks/himalaya-read-only.sh#L30) · Dismissal recommended.

      <details><summary><b>2 follow-ups</b> · none block merge</summary>

      - \`79\` Finished bars disappear at a viewport boundary · [\`timeline-store.ts:83\`](https://github.com/harlan-zw/example/blob/6aa6d8e1520848daef9646d402ea16ee3f9a4221/src/timeline-store.ts#L83)
      - \`55\` Zero deliveries for an unmeasured interval · [\`timeline-store.ts:208\`](https://github.com/harlan-zw/example/blob/6aa6d8e1520848daef9646d402ea16ee3f9a4221/src/timeline-store.ts#L208)

      </details>

      <sub>1 note below 40/100 not shown.</sub>

      <sub><relative-time datetime="2026-11-23T15:03:00.000Z">2026-11-23 15:03 UTC</relative-time> · [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's; a person merges · [AI policy](https://harlanzw.com/blog/ai-in-open-source) · \`@harlan-agent rerun\`</sub>"
    `)
    expect(verdict({ gates: gates({ merge: { _tag: 'Failed', reason: 'The pull request has merge conflicts.', evidence } }), confidence: undefined, checked: 'the catalog bumps and the codex-sdk changelog', notChecked: null })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"Review","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","baseSha":"70edfe5f32699f7f6042c0bd66e8a68e3b282fc5","outcome":"BLOCKED","gates":{"merge":"Failed","review":"Passed","ci":"Passed"}} -->
      🟠 **Blocked** · merge conflict; the review itself passed

      Checked the catalog bumps and the codex-sdk changelog.

      <sub><relative-time datetime="2026-11-23T15:03:00.000Z">2026-11-23 15:03 UTC</relative-time> · [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's; a person merges · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
  })
})

describe('review lifecycle', () => {
  const status: QueuedReviewStatus = {
    taskId: 'task',
    taskKind: 'adversarial_review',
    repository,
    pullRequestNumber: 740,
    revisionId: 'revision',
    headSha: head,
    queue: { _tag: 'Waiting', position: 2, total: 3 },
    verdict: { _tag: 'Unanswered' },
    history: { _tag: 'AfterPush', priorHeadSha: prior, priorOutcome: 'BLOCKED', findings: 2 },
    attempt: { _tag: 'FirstAttempt' },
    commentId: 1,
    publishedBody: '',
  }

  it('renders the working states without a time', () => {
    expect(queuePositionComment(status)).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"Queued","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","taskKind":"adversarial_review"} -->
      ⚪ **Queued** · review of [\`6aa6d8e\`](https://github.com/harlan-zw/example/commit/6aa6d8e1520848daef9646d402ea16ee3f9a4221) starts when an agent is free

      <sub>Last review of \`19c6342\`: Blocked, 2 issues. A new commit replaced it.</sub>

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(queuePositionComment({ ...status, history: { _tag: 'FirstReview' }, attempt: { _tag: 'Retrying', reason: 'The opencode session failed: Unexpected server error.', retry: { spent: 1, limit: 3 }, nextAttemptAt: '2026-11-24T03:40:00.000Z' } })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"Queued","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","taskKind":"adversarial_review"} -->
      ⚪ **Queued** · retry 1 of 3 at 03:40 UTC

      <sub>Last attempt: The agent provider failed before the agent answered.</sub>

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(queuePositionComment({ ...status, taskKind: 'review_fix', history: { _tag: 'FirstReview' }, queue: { _tag: 'Paused' } })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"Queued","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","taskKind":"review_fix"} -->
      ⚪ **Queued** · this repository is paused

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated repair, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(progressComment(head, base, { _tag: 'AfterRepair', priorHeadSha: prior, priorOutcome: 'Blocked', findings: 2 }, repository)).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"Reviewing","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","baseSha":"70edfe5f32699f7f6042c0bd66e8a68e3b282fc5"} -->
      ⚪ **Reviewing** [\`6aa6d8e\`](https://github.com/harlan-zw/example/commit/6aa6d8e1520848daef9646d402ea16ee3f9a4221) · this comment updates when it finishes

      <sub>Last review of \`19c6342\`: Blocked, 2 issues. Repair pushed this commit.</sub>

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(repairProgressComment({ repository, pullRequest: pullRequestItem({ headSha: head }), rounds: { number: 1, limit: 3, prior: [] } })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"Repair","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221"} -->
      ⚪ **Repair** · round 1 of 3

      Repair is fixing the issues found in [\`6aa6d8e\`](https://github.com/harlan-zw/example/commit/6aa6d8e1520848daef9646d402ea16ee3f9a4221). A new review checks its commit.

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated repair, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
  })

  it('renders the states that need a person', async () => {
    expect(queuePositionComment({ ...status, attempt: { _tag: 'Stuck', reason: 'The worktree could not be created.' } })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"Stuck","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","taskKind":"adversarial_review"} -->
      🟠 **Stuck** · needs Harlan

      The worktree could not be created. Fix the cause, then push a commit. The Dashboard shows the Incident.

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    let approval = ''
    await createApprovalController({
      github: {
        clearAgentLabels: () => Promise.resolve(ok(undefined)),
        consumeApprovalLabel: () => Promise.resolve(ok(undefined)),
        ensureApprovalLabel: () => Promise.resolve(ok(undefined)),
        upsertReviewStatus: (_repository, _number, _commentId, body) => {
          approval = body
          return Promise.resolve(ok({ commentId: 1, url: 'url' }))
        },
      },
      now: () => new Date(at),
      reviewApprovalControls: () => true,
      store: {
        approveIssue: () => { throw new Error('Unexpected issue Approval.') },
        isIssueApprovalPending: () => false,
        hasApprovalPromptComment: () => true,
        recordApprovalPromptComment: () => true,
        getSelectionMode: () => 'auto' as const,
        hasPullRequestApproval: () => false,
        approvePullRequest: () => { throw new Error('Unexpected Approval.') },
      },
    }).reconcile(repositoryMapping(), pullRequestItem({ author: 'outside-contributor', headSha: head }), 'revision', new AbortController().signal)
    expect(approval).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- target-branch: main -->
      <!-- workflow-state: {"_tag":"ApprovalRequired","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221"} -->
      🟠 **Approval needed** · outside contributor

      Thanks for the pull request. Automated review and repair of [\`6aa6d8e\`](https://github.com/harlan-zw/example/commit/6aa6d8e1520848daef9646d402ea16ee3f9a4221) wait for Harlan.

      - [ ] Review and repair

      <sub>Only Harlan's click starts work. It adds the <kbd>harlan-agent-review</kbd> label.</sub>

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated status, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(reviewSkippedComment(head, base, { _tag: 'ADVERSARIAL_REVIEW_SKIPPED', reason: 'model: classification chose skip with confidence 0.94.', source: 'model' }, at)).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"ReviewSkipped","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","baseSha":"70edfe5f32699f7f6042c0bd66e8a68e3b282fc5"} -->
      ⚪ **Review skipped** · prose-only change

      <sub>model: classification chose skip with confidence 0.94. Add the <kbd>harlan-agent-review</kbd> label to review it anyway.</sub>

      <sub><relative-time datetime="2026-11-23T15:03:00.000Z">2026-11-23 15:03 UTC</relative-time> · [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated triage, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
  })
})

describe('a stopped Task and a pull request that left', () => {
  const stopped: StoppedReview = {
    taskId: 'task',
    taskKind: 'adversarial_review',
    repository,
    pullRequestNumber: 740,
    revisionId: 'revision',
    headSha: head,
    closureRevisionId: 'revision',
    currentHeadSha: head,
    currentBaseSha: base,
    reason: 'The codex session failed: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
    disposition: { _tag: 'Stopped' },
    commentId: 1,
    publishedBody: progressComment(head, base, { _tag: 'FirstReview' }, repository),
    findings: [],
  }

  it('renders Stuck, a skip, repair stopped, merged, and closed', () => {
    expect(stoppedReviewComment(stopped, at)).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"ReviewStopped","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221"} -->
      🟠 **Stuck** · the agent lost its sign-in

      Harlan must sign it in again.

      Push a commit to start a new review, or comment \`@harlan-agent rerun\` to review this commit again.

      <sub><relative-time datetime="2026-11-23T15:03:00.000Z">2026-11-23 15:03 UTC</relative-time> · [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(stoppedReviewComment({ ...stopped, reason: 'The pull request is not ready for review.' }, at)).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"ReviewStopped","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221"} -->
      ⚪ **Review skipped** · the pull request is not ready for review

      <sub><relative-time datetime="2026-11-23T15:03:00.000Z">2026-11-23 15:03 UTC</relative-time> · [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(stoppedReviewComment({ ...stopped, taskKind: 'review_fix', reason: 'Round 3 of 3 pushed a commit that still fails the version guard test.', findings: [{ _tag: 'Fixed', summary: 'Default robots.txt grants AI-input permission' }, issue, ...followUps] }, at)).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"RepairStopped","headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221"} -->
      🟠 **Blocked** · repair stopped

      Round 3 of 3 pushed a commit that still fails the version guard test.

      1. **Draft saves skip approval when HOME is unset** \`86/100\`  
         [\`himalaya-read-only.sh:30\`](https://github.com/harlan-zw/example/blob/6aa6d8e1520848daef9646d402ea16ee3f9a4221/hooks/himalaya-read-only.sh#L30) · Fix: Fail closed when neither XDG_CONFIG_HOME nor HOME is absolute.

      - ~~Default robots.txt grants AI-input permission~~ fixed

      <details><summary><b>2 follow-ups</b> · none block merge</summary>

      - \`79\` Finished bars disappear at a viewport boundary · [\`timeline-store.ts:83\`](https://github.com/harlan-zw/example/blob/6aa6d8e1520848daef9646d402ea16ee3f9a4221/src/timeline-store.ts#L83)
      - \`55\` Zero deliveries for an unmeasured interval · [\`timeline-store.ts:208\`](https://github.com/harlan-zw/example/blob/6aa6d8e1520848daef9646d402ea16ee3f9a4221/src/timeline-store.ts#L208)

      </details>

      <sub>1 note below 40/100 not shown.</sub>

      <sub><relative-time datetime="2026-11-23T15:03:00.000Z">2026-11-23 15:03 UTC</relative-time> · [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's; a person merges · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(stoppedReviewComment({ ...stopped, findings: followUps }, at, { _tag: 'Merged' })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"PullRequestMerged","workflowVersion":2,"headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","baseSha":"70edfe5f32699f7f6042c0bd66e8a68e3b282fc5"} -->
      🟣 **Merged** · 2 follow-ups not fixed

      - \`79\` Finished bars disappear at a viewport boundary · [\`timeline-store.ts:83\`](https://github.com/harlan-zw/example/blob/6aa6d8e1520848daef9646d402ea16ee3f9a4221/src/timeline-store.ts#L83)
      - \`55\` Zero deliveries for an unmeasured interval · [\`timeline-store.ts:208\`](https://github.com/harlan-zw/example/blob/6aa6d8e1520848daef9646d402ea16ee3f9a4221/src/timeline-store.ts#L208)

      <sub><relative-time datetime="2026-11-23T15:03:00.000Z">2026-11-23 15:03 UTC</relative-time> · [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(stoppedReviewComment({ ...stopped, publishedBody: terminalComment({ headSha: head, baseSha: base, gates: gates(), findings: [], confidence: 90, reportedChecks: [] }) }, at, { _tag: 'Merged' })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"PullRequestMerged","workflowVersion":2,"headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","baseSha":"70edfe5f32699f7f6042c0bd66e8a68e3b282fc5"} -->
      🟣 **Merged** · reviewed with no issues

      <sub><relative-time datetime="2026-11-23T15:03:00.000Z">2026-11-23 15:03 UTC</relative-time> · [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(stoppedReviewComment(stopped, at, { _tag: 'Closed' })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- workflow-state: {"_tag":"PullRequestClosed","workflowVersion":2,"headSha":"6aa6d8e1520848daef9646d402ea16ee3f9a4221","baseSha":"70edfe5f32699f7f6042c0bd66e8a68e3b282fc5"} -->
      ⚪ **Closed** · no further reviews

      <sub><relative-time datetime="2026-11-23T15:03:00.000Z">2026-11-23 15:03 UTC</relative-time> · [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
  })
})

describe('findings beside the code', () => {
  it('renders an issue, a follow-up with its control, a fixed thread, and the native review', () => {
    const thread = reviewFindingThreadBody(issue, head, 'main')
    expect(thread).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- review-finding: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aG9tZS11bnNldA -->
      🟠 **Draft saves skip approval when HOME is unset** · \`86/100\` · blocks merge

      With HOME unset, the config path resolves to /.config. The guard reads a missing file as permission.

      **Fix:** Fail closed when neither XDG_CONFIG_HOME nor HOME is absolute.

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(reviewFindingThreadBody(followUp(42, 'Provisioning fails when Skills sit on a separate mount', 3), head, 'main')).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- review-finding: ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff42 UHJvdmlzaW9uaW5nIGZhaWxzIHdoZW4gU2tpbGxzIHNpdCBvbiBhIHNlcGFyYXRlIG1vdW50 -->
      <!-- review-finding-disposition: logged -->
      ⚪ **Provisioning fails when Skills sit on a separate mount** · \`42/100\` · does not block merge

      When a bar crosses the viewport edge, the query drops it.

      **Fix:** Query for span overlap with the viewport.

      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      <!-- finding-base: bWFpbg -->
      - [ ] Ask an agent to verify and fix this finding <!-- logged-finding: ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff42 -->

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(resolvedThreadBody(thread, issue.details.fingerprint, '9260eac5ce38d7579dee5a2b551069c3b3e08ca7', `https://github.com/${repository}/commit/9260eac5ce38d7579dee5a2b551069c3b3e08ca7`)).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:pr-triage -->
      <!-- review-finding: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb aG9tZS11bnNldA -->
      🟢 **Fixed in [\`9260eac\`](https://github.com/harlan-zw/example/commit/9260eac5ce38d7579dee5a2b551069c3b3e08ca7)**

      ~~Draft saves skip approval when HOME is unset~~ · \`86/100\` · blocks merge

      With HOME unset, the config path resolves to /.config. The guard reads a missing file as permission.

      **Fix:** Fail closed when neither XDG_CONFIG_HOME nor HOME is absolute.

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(nativeReviewBody({ headSha: head, outcome: 'BLOCKED', commentUrl: `https://github.com/${repository}/pull/740#issuecomment-1`, findings: [issue, ...followUps] })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:native-review -->
      <!-- reviewed-sha: 6aa6d8e1520848daef9646d402ea16ee3f9a4221 -->
      🟠 **Blocked** · 1 issue to fix before merge · [read the review](https://github.com/harlan-zw/example/pull/740#issuecomment-1)

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
  })
})

describe('issue triage', () => {
  const triage = {
    _tag: 'READY_TO_IMPLEMENT' as const,
    difficulty: 2,
    impact: 2,
    hasReproduction: false,
    needsCodebaseReview: false,
    summary: 'Bounded catalog and lockfile refresh for 19 minor and patch updates.',
    nextAction: 'Refresh registry evidence, apply passing updates together, and report any excluded update.',
    relatedIssues: [12],
    duplicateIssue: null,
    relatedPullRequests: [{ number: 608, reason: 'The previous update set several current versions.' }],
    ask: [],
  }

  it('renders a route, Needs info, and a duplicate', () => {
    expect(issueTriageComment(triage)).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:issue-triage -->
      🟢 **Ready to implement** · difficulty \`2/5\` · impact \`2/5\`

      Bounded catalog and lockfile refresh for 19 minor and patch updates.

      <details><summary>Plan for the implementing agent</summary>

      Refresh registry evidence, apply passing updates together, and report any excluded update.

      Reproduction: no. Codebase review: not needed.

      - Fix with: #12
      - #608: The previous update set several current versions.

      </details>

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated triage, not Harlan's commitment · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(issueTriageComment({ ...triage, _tag: 'NEEDS_INFO', summary: 'OG images render blank on Cloudflare Pages.', nextAction: 'Wait for a minimal reproduction.', ask: ['Your `nuxt-og-image` and Nuxt versions', 'The `ogImage` config block'] })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:issue-triage -->
      🟠 **Needs info**

      OG images render blank on Cloudflare Pages.

      Add these to move it forward:

      - Your \`nuxt-og-image\` and Nuxt versions
      - The \`ogImage\` config block

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated triage, not Harlan's commitment · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
    expect(issueTriageComment({ ...triage, _tag: 'WAIT_TO_IMPLEMENT', duplicateIssue: { number: 463, reason: 'Same Vite 8 `advancedChunks` deprecation.' }, relatedPullRequests: [] })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:issue-triage -->
      ⚪ **Duplicate of #463**

      Same Vite 8 \`advancedChunks\` deprecation. Follow #463 for the fix.

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated triage, not Harlan's commitment · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>"
    `)
  })
})

describe('package release', () => {
  const plan: PackageReleasePlan = { _tag: 'Available', bump: 'minor', version: '6.1.0', previousVersion: '6.0.3', previousTag: 'v6.0.3', packageName: 'nuxt-seo', headSha: head, sourceSha: head, mergeSha: head }
  const record = (state: PackageReleaseRecord['state'], releasePlan: PackageReleasePlan = plan) => ({ repository, pullRequestNumber: 719, commentId: 1, body: '', plan: releasePlan, state, policy: '' }) as unknown as PackageReleaseRecord
  const note = (state: ReleaseNote['state']) => ({ state }) as ReleaseNote
  const url = 'https://github.com/harlan-zw/nuxt-seo/releases/tag/v6.1.0'
  const text = '## AI Ready bundle\n\nNuxt SEO now ships `llms.txt` by default.'

  it('renders the offer, Publishing, Published with each draft state, and Blocked', () => {
    expect(packageReleaseStatus(record({ _tag: 'Available' }))).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      ⚪ **Release \`nuxt-seo@6.1.0\`** · minor · all changes since \`v6.0.3\` · from \`6aa6d8e\`

      - [ ] Release minor

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
    expect(packageReleaseStatus(record({ _tag: 'AwaitingMerge' } as PackageReleaseRecord['state'], { ...plan, _tag: 'BeforeMerge' } as PackageReleasePlan))).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      ⚪ **Release \`nuxt-seo@6.1.0\` after merge** · minor · all changes since \`v6.0.3\`

      - [x] Release minor after merge

      <sub>It runs once this pull request merges and default branch checks pass. It applies to head \`6aa6d8e\`; a new commit or version clears it. Clear the checkbox to cancel.</sub>

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
    expect(packageReleaseStatus(record({ _tag: 'Queued', requestedBy: 'harlan-zw' }))).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      ⚪ **Publishing \`nuxt-seo@6.1.0\`** · waits for default branch checks

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
    expect(packageReleaseStatus(record({ _tag: 'Prepared', pullRequestNumber: 720 } as PackageReleaseRecord['state']))).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      ⚪ **Publishing \`nuxt-seo@6.1.0\`** · waits for #720

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
    expect(packageReleaseStatus(record({ _tag: 'Publishing' } as PackageReleaseRecord['state']))).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      ⚪ **Publishing \`nuxt-seo@6.1.0\`** · GitHub Actions, then npm

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
    const completed = record({ _tag: 'Completed', url } as PackageReleaseRecord['state'])
    expect(packageReleaseStatus(completed, note({ _tag: 'Running' } as ReleaseNote['state']))).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      🟣 **Published [\`nuxt-seo@6.1.0\`](https://github.com/harlan-zw/nuxt-seo/releases/tag/v6.1.0)**

      Drafting a release note.

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
    expect(packageReleaseStatus(completed, note({ _tag: 'Drafted', text } as ReleaseNote['state']))).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      🟣 **Published [\`nuxt-seo@6.1.0\`](https://github.com/harlan-zw/nuxt-seo/releases/tag/v6.1.0)**

      <details><summary>Release note draft · the GitHub release is unchanged</summary>

      > \`\`\`markdown
      > ## AI Ready bundle
      >
      > Nuxt SEO now ships \`llms.txt\` by default.
      > \`\`\`

      </details>

      - [ ] Add this draft to the GitHub release

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
    expect(packageReleaseStatus(completed, note({ _tag: 'Approved', text } as ReleaseNote['state']))).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      🟣 **Published [\`nuxt-seo@6.1.0\`](https://github.com/harlan-zw/nuxt-seo/releases/tag/v6.1.0)**

      <details><summary>Release note draft · adding it to the GitHub release</summary>

      > \`\`\`markdown
      > ## AI Ready bundle
      >
      > Nuxt SEO now ships \`llms.txt\` by default.
      > \`\`\`

      </details>

      - [x] Add this draft to the GitHub release

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
    expect(packageReleaseStatus(completed, note({ _tag: 'Applied', text, url } as ReleaseNote['state']))).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      🟣 **Published [\`nuxt-seo@6.1.0\`](https://github.com/harlan-zw/nuxt-seo/releases/tag/v6.1.0)**

      Added the release note draft to the [GitHub release](https://github.com/harlan-zw/nuxt-seo/releases/tag/v6.1.0).

      <details><summary>Release note draft</summary>

      > \`\`\`markdown
      > ## AI Ready bundle
      >
      > Nuxt SEO now ships \`llms.txt\` by default.
      > \`\`\`

      </details>

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
    expect(packageReleaseStatus(completed, note({ _tag: 'ApplyFailed', text, reason: 'GitHub refused the edit.' } as ReleaseNote['state']))).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      🟣 **Published [\`nuxt-seo@6.1.0\`](https://github.com/harlan-zw/nuxt-seo/releases/tag/v6.1.0)**

      Could not add the draft to the GitHub release: GitHub refused the edit. Copy it by hand if you still want it.

      <details><summary>Release note draft</summary>

      > \`\`\`markdown
      > ## AI Ready bundle
      >
      > Nuxt SEO now ships \`llms.txt\` by default.
      > \`\`\`

      </details>

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
    expect(packageReleaseStatus(completed, note({ _tag: 'Failed', reason: 'The draft was empty.' } as ReleaseNote['state']))).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      🟣 **Published [\`nuxt-seo@6.1.0\`](https://github.com/harlan-zw/nuxt-seo/releases/tag/v6.1.0)**

      No release note draft: The draft was empty.

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
    expect(packageReleaseStatus(record({ _tag: 'Blocked', reason: 'A public API changed. Check compatibility before releasing.' }))).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      🟠 **Release blocked** · \`nuxt-seo@6.1.0\` · needs Harlan

      A public API changed. Check compatibility before releasing.

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
    expect(renderManualMajorRelease({ _tag: 'ManualMajor', reason: 'This release includes breaking changes. Run a manual major release.', previousTag: 'v6.0.3', headSha: head })).toMatchInlineSnapshot(`
      "<!-- harlan-agent-kit:package-release -->
      🟠 **Release blocked** · needs Harlan

      This release includes breaking changes. Run a manual major release.

      <sub>Includes all unreleased changes since \`v6.0.3\`. Checked head \`6aa6d8e\`.</sub>

      <sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated release, not Harlan's · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>
      "
    `)
  })
})
