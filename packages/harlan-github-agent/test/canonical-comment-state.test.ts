import type { QueuedReviewStatus, StoppedReview } from '../src/store.ts'
import type { ClaimedReviewFixTask } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { queuePositionComment } from '../src/queue-position-sweep.ts'
import { reviewCheckRunUpdate } from '../src/review-check-run.ts'
import { canonicalCommentHeadline, canonicalCommentOutcome, priorAutomatedReviewForHead } from '../src/review-comment.ts'
import { repairProgressComment } from '../src/review-status-controller.ts'
import { stoppedReviewComment } from '../src/review-stop-sweep.ts'

// Old comments stay on GitHub and in the Journal, so every reader must accept
// the `### 🤖` heading format and the Status line format alike. The old bodies
// below are frozen copies of what the templates wrote before the Status line.
const head = '69c7ef6eaf1ec7bb186f27f46fa343d3d38f1f23'
const base = 'a2bf631b82ed5c386bfa4c384a44720f67182513'
const marker = `<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: ${head} -->`
const oldDisclosure = '> [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) posted this automated review. [AI open source policy](https://harlanzw.com/blog/ai-in-open-source).'
const footer = '<sub>[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) automated review, not Harlan\'s · [AI policy](https://harlanzw.com/blog/ai-in-open-source)</sub>'
const review = (outcome: string) => `<!-- workflow-state: {"_tag":"Review","headSha":"${head}","baseSha":"${base}","outcome":"${outcome}","gates":{"merge":"Passed","review":"Passed","ci":"Passed"}} -->`
const state = (tag: string, extra = '') => `<!-- workflow-state: {"_tag":"${tag}","headSha":"${head}"${extra}} -->`
const commit = `[\`${head.slice(0, 7)}\`](https://github.com/harlan-zw/example/commit/${head})`

interface Pair { name: string, old: string, next: string, outcome: ReturnType<typeof canonicalCommentOutcome> }

const pairs: Pair[] = [
  {
    name: 'READY',
    old: `${marker}\n${review('READY')}\n### 🤖 READY · 90/100\n\n${oldDisclosure}\n\n- **Merge gate:** Passed.`,
    next: `${marker}\n${review('READY')}\n🟢 **Ready** · \`90/100\`\n\nNo issues found in ${commit}.\n\n${footer}`,
    outcome: 'READY',
  },
  {
    name: 'PENDING',
    old: `${marker}\n${review('PENDING')}\n### 🤖 PENDING\n\n${oldDisclosure}`,
    next: `${marker}\n${review('PENDING')}\n⚪ **Pending** · the review passed; the verdict waits for CI\n\n${footer}`,
    outcome: 'PENDING',
  },
  {
    name: 'BLOCKED',
    old: `${marker}\n${review('BLOCKED')}\n### 🤖 BLOCKED\n\n${oldDisclosure}`,
    next: `${marker}\n${review('BLOCKED')}\n🟠 **Blocked** · 2 issues to fix before merge\n\n${footer}`,
    outcome: 'BLOCKED',
  },
  {
    name: 'REVIEW SKIPPED',
    old: `${marker}\n<!-- workflow-state: {"_tag":"ReviewSkipped","headSha":"${head}","baseSha":"${base}"} -->\n### 🤖 REVIEW SKIPPED\n\n${oldDisclosure}`,
    next: `${marker}\n<!-- workflow-state: {"_tag":"ReviewSkipped","headSha":"${head}","baseSha":"${base}"} -->\n⚪ **Review skipped** · documentation only\n\n${footer}`,
    outcome: 'SKIPPED',
  },
  {
    name: 'WAITING',
    old: `${marker}\n<!-- workflow-state: {"_tag":"WaitingForBaselineRepair","baseSha":"${base}"} -->\n### 🤖 WAITING\n\n${oldDisclosure}`,
    next: `${marker}\n<!-- workflow-state: {"_tag":"WaitingForBaselineRepair","baseSha":"${base}"} -->\n🟠 **Stuck** · the default branch fails CI at ${commit}\n\n${footer}`,
    outcome: 'WAITING',
  },
  {
    name: 'repair BLOCKED',
    old: `${marker}\n### 🤖 BLOCKED\n\n${oldDisclosure}\n\nRepair stopped.`,
    next: `${marker}\n${state('RepairStopped')}\n🟠 **Blocked** · repair stopped\n\n${footer}`,
    outcome: 'BLOCKED',
  },
  {
    name: 'REVIEWING',
    old: `${marker}\n<!-- workflow-state: {"_tag":"Reviewing","headSha":"${head}","baseSha":"${base}"} -->\n### 🤖 REVIEWING\n\n${oldDisclosure}`,
    next: `${marker}\n<!-- workflow-state: {"_tag":"Reviewing","headSha":"${head}","baseSha":"${base}"} -->\n⚪ **Reviewing** ${commit} · this comment updates when it finishes\n\n${footer}`,
    outcome: null,
  },
  ...['QUEUED', 'RETRYING', 'PAUSED'].map((heading): Pair => ({
    name: heading,
    old: `${marker}\n### 🤖 ${heading}\n\n${oldDisclosure}\n\nNext: Review starts when an Agent is free.`,
    next: `${marker}\n${state('Queued')}\n⚪ **Queued** · review of ${commit} starts when an agent is free\n\n${footer}`,
    outcome: null,
  })),
  {
    name: 'STUCK',
    old: `${marker}\n### 🤖 STUCK\n\n${oldDisclosure}`,
    next: `${marker}\n${state('Stuck')}\n🟠 **Stuck** · needs Harlan\n\n${footer}`,
    outcome: null,
  },
  {
    name: 'REPAIR',
    old: `${marker}\n### 🤖 REPAIR · round 1 of 3\n\n${oldDisclosure}`,
    next: `${marker}\n${state('Repair')}\n⚪ **Repair** · round 1 of 3\n\n${footer}`,
    outcome: null,
  },
  {
    name: 'STOPPED',
    old: `${marker}\n### 🤖 STOPPED\n\n${oldDisclosure}`,
    next: `${marker}\n${state('ReviewStopped')}\n🟠 **Stuck** · the review stopped\n\n${footer}`,
    outcome: null,
  },
  {
    name: 'REVIEW PAUSED',
    old: `${marker}\n### 🤖 REVIEW PAUSED\n\n${oldDisclosure}`,
    next: `${marker}\n${state('ApprovalRequired')}\n🟠 **Approval needed** · outside contributor\n\n${footer}`,
    outcome: null,
  },
  {
    name: 'MERGED',
    old: `${marker}\n<!-- workflow-state: {"_tag":"PullRequestMerged","workflowVersion":2,"headSha":"${head}","baseSha":"${base}"} -->\n### 🤖 MERGED\n\n${oldDisclosure}`,
    next: `${marker}\n<!-- workflow-state: {"_tag":"PullRequestMerged","workflowVersion":2,"headSha":"${head}","baseSha":"${base}"} -->\n🟣 **Merged** · reviewed with no issues\n\n${footer}`,
    outcome: null,
  },
  {
    name: 'CLOSED',
    old: `${marker}\n<!-- workflow-state: {"_tag":"PullRequestClosed","workflowVersion":2,"headSha":"${head}","baseSha":"${base}"} -->\n### 🤖 CLOSED\n\n${oldDisclosure}`,
    next: `${marker}\n<!-- workflow-state: {"_tag":"PullRequestClosed","workflowVersion":2,"headSha":"${head}","baseSha":"${base}"} -->\n⚪ **Closed** · no further reviews\n\n${footer}`,
    outcome: null,
  },
]

describe('the canonical comment outcome', () => {
  it.each(pairs)('reads the same $name outcome from the old and the new body', ({ old, next, outcome }) => {
    expect(canonicalCommentOutcome(old)).toBe(outcome)
    expect(canonicalCommentOutcome(next)).toBe(outcome)
  })

  it('reads a trusted maintainer\'s Status line without a workflow marker', () => {
    expect(canonicalCommentOutcome(`${marker}\n🟢 **Ready** · \`96/100\``)).toBe('READY')
    expect(canonicalCommentOutcome(`${marker}\n🟠 **Blocked** · 1 issue to fix before merge`)).toBe('BLOCKED')
  })

  it('reads nothing from a body without a state', () => {
    expect(canonicalCommentOutcome(`${marker}\nA person wrote this.`)).toBeNull()
  })

  it('ignores a malformed workflow marker and reads the visible line', () => {
    expect(canonicalCommentOutcome(`${marker}\n<!-- workflow-state: {"_tag": -->\n🟢 **Ready** · \`90/100\``)).toBe('READY')
  })
})

describe('the prior review a new head finds', () => {
  const found = (body: string, authorLogin = 'harlan-github-agent[bot]', authorAssociation = 'NONE') => priorAutomatedReviewForHead([{
    authorAssociation,
    authorLogin,
    body,
    url: 'https://github.com/harlan-zw/example/pull/1#issuecomment-1',
  }], head, 'harlan-github-agent[bot]')

  it.each(pairs)('answers the same for the old and the new $name body', ({ old, next }) => {
    expect(found(next)).toEqual(found(old))
  })

  it.each(pairs)('answers the same for a trusted maintainer\'s old and new $name body', ({ old, next }) => {
    expect(found(next, 'harlan-zw', 'OWNER')).toEqual(found(old, 'harlan-zw', 'OWNER'))
  })

  it('keeps a PENDING verdict active', () => {
    const pending = pairs.find(pair => pair.name === 'PENDING')!
    expect(found(pending.next, 'harlan-zw', 'OWNER')).toMatchObject({ _tag: 'Found', state: 'active' })
  })
})

describe('the Review check run title', () => {
  const title = (body: string) => {
    const update = reviewCheckRunUpdate({ taskKind: 'adversarial_review', phase: 'terminal', desiredOutcome: 'READY', body }, '2026-11-23T15:03:00.000Z')
    return update?.title
  }

  it('names the outcome from the Status line, without Markdown', () => {
    expect(title(pairs[0]!.next)).toBe('🟢 Ready · 90/100')
    expect(title(pairs.find(pair => pair.name === 'REVIEWING')!.next)).toBe(`⚪ Reviewing ${head.slice(0, 7)} · this comment updates when it finishes`)
  })

  it('still names the outcome from an old heading', () => {
    expect(title(pairs[0]!.old)).toBe('🤖 READY · 90/100')
  })

  it('falls back to Review for a body with neither', () => {
    expect(title(`${marker}\nA person wrote this.`)).toBe('Review')
    expect(canonicalCommentHeadline(`${marker}\nA person wrote this.`)).toBeUndefined()
  })
})

describe('every canonical comment names its state in a marker', () => {
  const tag = (body: string): string | undefined => {
    const encoded = body.match(/<!-- workflow-state: (\{[^\n]+\}) -->/)?.[1]
    return encoded === undefined ? undefined : (JSON.parse(encoded) as { _tag: string })._tag
  }
  const queued = (attempt: QueuedReviewStatus['attempt'], queue: QueuedReviewStatus['queue'] = { _tag: 'Waiting', position: 1, total: 1 }): QueuedReviewStatus => ({
    taskId: 'task',
    taskKind: 'adversarial_review',
    repository: 'harlan-zw/example',
    pullRequestNumber: 1,
    revisionId: 'revision',
    headSha: head,
    queue,
    verdict: { _tag: 'Unanswered' },
    history: { _tag: 'FirstReview' },
    attempt,
    commentId: 1,
    publishedBody: '',
  })
  const stopped: StoppedReview = {
    taskId: 'task',
    taskKind: 'adversarial_review',
    repository: 'harlan-zw/example',
    pullRequestNumber: 1,
    revisionId: 'revision',
    headSha: head,
    closureRevisionId: 'revision',
    currentHeadSha: head,
    currentBaseSha: base,
    reason: null,
    disposition: { _tag: 'Stopped' },
    commentId: 1,
    publishedBody: '',
    findings: [],
  }

  it('marks the Queue states', () => {
    expect(tag(queuePositionComment(queued({ _tag: 'FirstAttempt' })))).toBe('Queued')
    expect(tag(queuePositionComment(queued({ _tag: 'Retrying', reason: 'The network failed.', retry: null, nextAttemptAt: null })))).toBe('Queued')
    expect(tag(queuePositionComment(queued({ _tag: 'Stuck', reason: 'The worktree could not be created.' })))).toBe('Stuck')
  })

  it('marks Repair, a stopped Review, and a stopped Repair', () => {
    expect(tag(repairProgressComment({ repository: 'harlan-zw/example', pullRequest: { headSha: head } as ClaimedReviewFixTask['pullRequest'], rounds: { number: 1, limit: 3 } as ClaimedReviewFixTask['rounds'] }))).toBe('Repair')
    expect(tag(stoppedReviewComment(stopped, '2026-11-23T15:03:00.000Z'))).toBe('ReviewStopped')
    const repair = stoppedReviewComment({ ...stopped, taskKind: 'review_fix' }, '2026-11-23T15:03:00.000Z')
    expect(tag(repair)).toBe('RepairStopped')
    expect(canonicalCommentOutcome(repair)).toBe('BLOCKED')
  })
})
