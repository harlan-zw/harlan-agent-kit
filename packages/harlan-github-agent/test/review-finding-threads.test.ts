import type { Octokit } from 'octokit'
import type { ReviewFindingComment, ReviewFindingThread, ReviewFindingThreadMirror, ReviewFindingThreadsOutcome } from '../src/review-finding-threads.ts'
import type { ClaimedReviewStatusCommand, ReviewFinding } from '../src/types.ts'
import { describe, expect, it, vi } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { err, ok } from '../src/result.ts'
import { mirrorReviewFindingThreads } from '../src/review-finding-threads.ts'
import { publishClaimedReviewStatus } from '../src/review-status-controller.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const headSha = '5a885d2507bd5c0f86f027c7054fcda215d444f1'
const lockFingerprint = 'a'.repeat(64)
const clockFingerprint = 'b'.repeat(64)
const authorize = () => ok(undefined)

function openFinding(fingerprint: string, path: string, line: number | null): ReviewFinding {
  return {
    _tag: 'Open',
    summary: 'Lane tests share the isolate lock',
    nextAction: 'Reset the module state between tests',
    resolution: 'Repair',
    details: { fingerprint, location: { path, line }, proof: 'Two tests hold the lock at once', regressionTest: null },
  }
}

function fakeSource(threads: ReviewFindingThread[], outcome: 'Posted' | 'OutsideDiff' = 'Posted') {
  const posted: ReviewFindingComment[] = []
  const resolved: string[] = []
  const reports: ReviewFindingThreadsOutcome[] = []
  const mirror: ReviewFindingThreadMirror = {
    source: {
      listReviewFindingThreads: () => Promise.resolve(ok(threads)),
      postReviewFindingComment: (_repository, _number, comment) => {
        posted.push(comment)
        return Promise.resolve(ok({ _tag: outcome }))
      },
      resolveReviewFindingThread: (_repository, threadId) => {
        resolved.push(threadId)
        return Promise.resolve(ok(undefined))
      },
    },
    findings: () => null,
    report: (_repository, value) => reports.push(value),
  }
  return { mirror, posted, reports, resolved }
}

describe('review finding threads', () => {
  it('comments each open finding on its line at the reviewed head', async () => {
    const { mirror, posted, reports } = fakeSource([])

    await mirrorReviewFindingThreads(mirror, repositoryMapping(), 497, headSha, [
      openFinding(lockFingerprint, 'test/jobs/lane.test.ts', 32),
      { _tag: 'Fixed', summary: 'Old issue' },
    ], new AbortController().signal, authorize)

    expect(posted).toEqual([expect.objectContaining({ headSha, path: 'test/jobs/lane.test.ts', line: 32 })])
    expect(posted[0]!.body).toContain('**Open:** Lane tests share the isolate lock.')
    expect(posted[0]!.body).toContain('Next: Reset the module state between tests.')
    expect(reports).toEqual([{ _tag: 'Written', posted: 1, outsideDiff: 0, resolved: 0 }])
  })

  it('never opens a second thread for a finding that already has one', async () => {
    const { mirror, posted } = fakeSource([{ threadId: 'T1', fingerprint: lockFingerprint, resolved: true }])

    await mirrorReviewFindingThreads(mirror, repositoryMapping(), 497, headSha, [openFinding(lockFingerprint, 'a.ts', 1)], new AbortController().signal, authorize)

    expect(posted).toEqual([])
  })

  it('resolves open threads whose finding the latest Review no longer reports', async () => {
    const { mirror, resolved } = fakeSource([
      { threadId: 'T1', fingerprint: lockFingerprint, resolved: false },
      { threadId: 'T2', fingerprint: clockFingerprint, resolved: false },
      { threadId: 'T3', fingerprint: 'c'.repeat(64), resolved: true },
    ])

    await mirrorReviewFindingThreads(mirror, repositoryMapping(), 497, headSha, [openFinding(lockFingerprint, 'a.ts', 1)], new AbortController().signal, authorize)

    expect(resolved).toEqual(['T2'])
  })

  it('reports a failed thread read instead of hiding it', async () => {
    const { mirror, reports } = fakeSource([])
    mirror.source.listReviewFindingThreads = () => Promise.resolve(err('GitHub timed out.'))

    await mirrorReviewFindingThreads(mirror, repositoryMapping(), 497, headSha, [openFinding(lockFingerprint, 'a.ts', 1)], new AbortController().signal, authorize)

    expect(reports).toEqual([{ _tag: 'Failed', message: 'GitHub timed out.' }])
  })
})

describe('terminal Review publication', () => {
  function command(overrides: Partial<ClaimedReviewStatusCommand> = {}): ClaimedReviewStatusCommand {
    const repository = repositoryMapping()
    return {
      id: 'status-command',
      taskKind: 'adversarial_review',
      phase: 'terminal',
      taskId: 'review-task',
      repository: repository.github,
      pullRequestNumber: 497,
      revisionId: 'revision-1',
      expectedHeadSha: headSha,
      expectedBaseRef: 'main',
      body: '<!-- harlan-agent-kit:pr-triage -->\n### 🤖 BLOCKED',
      reviewRunId: 'run-1',
      desiredOutcome: 'BLOCKED',
      outcomeUnknown: false,
      commentId: null,
      workerId: 'status-worker',
      fence: 1,
      leaseExpiresAt: '2026-09-29T04:00:00.000Z',
      repositoryMapping: repository,
      ...overrides,
    } as ClaimedReviewStatusCommand
  }

  function publish(claimed: ClaimedReviewStatusCommand, mirror: ReviewFindingThreadMirror) {
    const pullRequest = pullRequestItem({ number: 497, headSha, baseRef: 'main' })
    return publishClaimedReviewStatus({
      findingThreads: mirror,
      github: {
        readExistingReviewLabel: () => { throw new Error('Unexpected existing review.') },
        getPullRequestStatusIdentity: () => { throw new Error('Terminal reads the snapshot.') },
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          requiredChecks: { _tag: 'None' as const },
          reviews: [],
        })),
        upsertReviewStatus: () => Promise.resolve(ok({ commentId: 29, url: pullRequest.url })),
        stampAgentLabel: () => Promise.resolve(ok(undefined)),
      },
      now: () => new Date('2026-09-29T03:25:00.000Z'),
      store: {
        authorizeReviewStatus: () => true,
        completeReviewStatus: () => true,
        recordReviewStatusReceipt: () => true,
        deferReviewStatus: () => { throw new Error('Unexpected defer.') },
        supersedeReviewStatus: () => { throw new Error('Unexpected supersede.') },
      },
    }, claimed, true, new AbortController().signal)
  }

  it('puts the Review run findings beside the code after the comment', async () => {
    const { mirror, posted } = fakeSource([])
    mirror.findings = (_repository, _number, runId) => runId === 'run-1' ? [openFinding(lockFingerprint, 'a.ts', 7)] : null

    expect((await publish(command(), mirror))._tag).toBe('Ok')
    expect(posted).toEqual([expect.objectContaining({ path: 'a.ts', line: 7 })])
  })

  it('still completes the comment when the thread sync fails', async () => {
    const { mirror, reports } = fakeSource([])
    mirror.findings = () => [openFinding(lockFingerprint, 'a.ts', 7)]
    mirror.source.postReviewFindingComment = () => Promise.resolve(err('GitHub timed out.'))

    expect((await publish(command(), mirror))._tag).toBe('Ok')
    expect(reports).toEqual([{ _tag: 'Failed', message: 'GitHub timed out.' }])
  })

  it('leaves threads alone for a terminal comment with no Review run', async () => {
    const { mirror, posted, reports } = fakeSource([])
    mirror.findings = () => [openFinding(lockFingerprint, 'a.ts', 7)]

    expect((await publish(command({ reviewRunId: null }), mirror))._tag).toBe('Ok')
    expect(posted).toEqual([])
    expect(reports).toEqual([])
  })
})

describe('gitHub review finding threads', () => {
  function github(responses: Array<number | null>, threads: unknown[] = []) {
    const createReviewComment = vi.fn((_input: Record<string, unknown>) => {
      const status = responses.shift()
      return status === null || status === undefined
        ? Promise.resolve({ data: { id: 1 } })
        : Promise.reject(Object.assign(new Error('Validation Failed'), { status }))
    })
    const graphql = vi.fn((_query: string, _variables: Record<string, unknown>) => Promise.resolve({
      repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } },
    }))
    const client = { graphql, rest: { pulls: { createReviewComment } } } as unknown as Octokit
    const source = createGitHubAgentSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => client,
      ownAppId: 98114,
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'app-token', expiresAt: '2026-09-30T00:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })
    return { createReviewComment, source }
  }
  const comment = { headSha, path: 'a.ts', line: 7, body: 'body' }

  it('falls back to a file comment when GitHub refuses the line', async () => {
    const { createReviewComment, source } = github([422, null])

    expect(await source.postReviewFindingComment(repositoryMapping(), 497, comment, new AbortController().signal, authorize)).toEqual(ok({ _tag: 'Posted' }))
    expect(createReviewComment.mock.calls.map(([input]) => [input.line, input.subject_type])).toEqual([[7, undefined], [undefined, 'file']])
  })

  it('answers OutsideDiff when GitHub refuses the file too', async () => {
    const { source } = github([422, 422])

    expect(await source.postReviewFindingComment(repositoryMapping(), 497, comment, new AbortController().signal, authorize)).toEqual(ok({ _tag: 'OutsideDiff' }))
  })

  it('writes nothing once the publication lost its authority', async () => {
    const { createReviewComment, source } = github([null])

    expect((await source.postReviewFindingComment(repositoryMapping(), 497, comment, new AbortController().signal, () => err('Lease lost.')))._tag).toBe('Err')
    expect(createReviewComment).not.toHaveBeenCalled()
  })

  it('reads only the finding threads this App opened', async () => {
    const marked = `<!-- harlan-agent-kit:pr-triage -->\n<!-- review-finding: ${lockFingerprint} -->\n**Open:** x`
    const { source } = github([], [
      { id: 'T1', isResolved: false, comments: { nodes: [{ body: marked, author: { login: 'harlan-github-agent' } }] } },
      { id: 'T2', isResolved: false, comments: { nodes: [{ body: marked, author: { login: 'someone-else' } }] } },
      { id: 'T3', isResolved: true, comments: { nodes: [{ body: 'A person asks a question.', author: { login: 'harlan-github-agent' } }] } },
    ])

    expect(await source.listReviewFindingThreads(repositoryMapping(), 497, new AbortController().signal))
      .toEqual(ok([{ threadId: 'T1', fingerprint: lockFingerprint, resolved: false }]))
  })
})
