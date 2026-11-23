import type { Octokit } from 'octokit'
import type { ReviewCheckRunOutcome } from '../src/review-check-run.ts'
import type { JournalStore, StoppedReview } from '../src/store.ts'
import { describe, expect, it } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { err, ok } from '../src/result.ts'
import { publishStoppedReviews, stoppedReviewComment } from '../src/review-stop-sweep.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const githubStatus = {
  clearAgentLabels: () => Promise.resolve(ok(undefined)),
  upsertReviewCheckRun: () => Promise.resolve(ok(undefined)),
}

const reviewClosureStore = {
  recordReviewClosure: () => true,
}

const stopped: StoppedReview = {
  taskId: 'review-task',
  taskKind: 'adversarial_review',
  repository: 'harlan-zw/example',
  pullRequestNumber: 24,
  revisionId: 'revision-1',
  headSha: 'abc123',
  closureRevisionId: 'revision-1',
  currentHeadSha: 'abc123',
  currentBaseSha: 'base123',
  reason: 'The pull request is not ready for review.',
  disposition: { _tag: 'Stopped' },
  commentId: 42,
  publishedBody: '### 🤖 REVIEWING · Reviewing changed files',
  findings: [],
}

const stoppedRepair: StoppedReview = {
  ...stopped,
  taskId: 'repair-task',
  taskKind: 'review_fix',
  reason: 'The Repair Agent found an unsafe scope.',
  findings: [
    { _tag: 'Open', summary: 'First exact finding.', nextAction: 'Fix the first boundary.', resolution: 'Repair' },
    { _tag: 'Open', summary: 'Second exact finding.', nextAction: 'Fix the second boundary.', resolution: 'Repair' },
  ],
}

it.each([
  ['path', '/private-checkouts/repo', []],
  ['host', 'https://private-host.test/work', [700, 500]],
] as const)('keeps stopped Review %s details out of comments and every check payload', async (_kind, detail, runIds) => {
  const review = { ...stopped, reason: `Cannot access ${detail}` }
  let remoteBody = review.publishedBody
  const comments: string[] = []
  const titles: string[] = []
  const writeCheck = (input: { output: { title: string } }) => {
    titles.push(input.output.title)
    return Promise.resolve({ data: { id: 900 } })
  }
  const comment = () => ({ id: review.commentId, body: remoteBody, user: { login: 'agent[bot]' }, html_url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })
  const client = {
    paginate: () => Promise.resolve(runIds.map(id => ({ id, name: 'harlan-agent-kit / Review', status: 'in_progress', app: { id: 98114 } }))),
    rest: {
      checks: { listForRef: () => undefined, create: writeCheck, update: writeCheck },
      issues: {
        getComment: () => Promise.resolve({ data: comment() }),
        updateComment: (input: { body: string }) => {
          comments.push(input.body)
          remoteBody = input.body
          return Promise.resolve({ data: comment() })
        },
      },
    },
  } as unknown as Octokit
  const source = createGitHubAgentSource({
    actorLogin: () => 'agent[bot]',
    createClient: () => client,
    ownAppId: 98114,
    publicText: { details: { paths: ['/private-checkouts'], hosts: ['private-host.test'] }, report: () => {} },
    tokens: { getToken: async () => ok({ token: 'fixture-token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
  })
  const result = await publishStoppedReviews({
    github: { ...source, clearAgentLabels: githubStatus.clearAgentLabels, getPullRequestReviewSnapshot: async () => snapshot() },
    now: () => new Date('2026-11-23T00:00:00.000Z'),
    reportCheckRun: () => {},
    repositories: [repositoryMapping()],
    store: {
      ...reviewClosureStore,
      listStoppedReviews: () => [review],
      recordStoppedReviewStatus: () => true,
      recordDeletedReviewComment: () => true,
    },
  }, new AbortController().signal)

  expect(result.results).toEqual([ok({ _tag: 'Published', repository: review.repository, pullRequestNumber: 24 })])
  expect(comments).toHaveLength(1)
  expect(titles).toHaveLength(runIds.length || 1)
  for (const payload of [...comments, ...titles]) {
    expect(payload).not.toContain(detail)
    expect(payload).toContain('_One line removed: it named a private path or host._')
  }
})

function snapshot(overrides: Parameters<typeof pullRequestItem>[0] = {}) {
  return ok({
    baseChecks: { _tag: 'Available' as const, checks: [] },
    body: '',
    checks: { _tag: 'Available' as const, checks: [] },
    comments: [],
    priorAutomatedReview: { _tag: 'None' as const },
    pullRequest: pullRequestItem({ headSha: 'abc123', ...overrides }),
    findingDiscussions: [],
    requiredChecks: { _tag: 'None' as const },
    reviews: [],
  })
}

describe('stoppedReviewComment', () => {
  const followUp = {
    _tag: 'Logged' as const,
    impact: 40,
    summary: 'The fallback needs more detail.',
    nextAction: 'Name the missing setting.',
    details: { fingerprint: 'f'.repeat(64), identity: 'fallback', location: { path: 'src/config.ts', line: 1 }, proof: 'The fallback omits the setting.' },
  }

  it.each(['Merged', 'Repair'] as const)('keeps a follow-up row when closing %s work', (mode) => {
    const body = stoppedReviewComment({
      ...stopped,
      taskKind: mode === 'Repair' ? 'review_fix' : 'adversarial_review',
      findings: [followUp, { ...followUp, impact: 12, summary: 'A comment has a typo.' }],
    }, '2026-08-15T04:00:00.000Z', mode === 'Merged' ? { _tag: 'Merged' } : { _tag: 'Stopped' })
    expect(body).toContain('- `40` The fallback needs more detail. · [`config.ts:1`](https://github.com/harlan-zw/example/blob/abc123/src/config.ts#L1)')
    expect(body).not.toContain('A comment has a typo.')
  })

  it('reads a review that stopped on a pull request no longer eligible as a skip, with no work claimed', () => {
    const body = stoppedReviewComment(stopped, '2026-08-15T04:00:00.000Z')

    expect(body).toContain('⚪ **Review skipped** · the pull request is not ready for review')
    expect(body).toContain('{"_tag":"ReviewStopped"')
    expect(body).not.toContain('REVIEWING')
    expect(body).not.toMatch(/[▓░]|\b\d+%/)
  })

  it('names a lost provider sign-in in the first line instead of printing the provider error', () => {
    const providerError = 'The codex session failed: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'
    const body = stoppedReviewComment({ ...stopped, reason: providerError }, '2026-11-22T04:00:00.000Z')

    expect(body).toContain('🟠 **Stuck** · the agent lost its sign-in\n\nHarlan must sign it in again.')
    expect(body).not.toContain('refresh token')
    expect(body).not.toContain('codex session failed')
  })

  it.each([
    ['Merged', { _tag: 'Merged' } as const],
    ['Repair', { _tag: 'Stopped' } as const],
  ])('never prints the provider error on %s work', (mode, disposition) => {
    const body = stoppedReviewComment({
      ...stopped,
      taskKind: mode === 'Repair' ? 'review_fix' : 'adversarial_review',
      reason: 'The opencode session failed: Unexpected server error.',
    }, '2026-11-22T04:00:00.000Z', disposition)

    expect(body).not.toContain('opencode session failed')
    if (mode === 'Repair')
      expect(body).toContain('The agent provider failed before the agent answered.')
  })

  it.each([
    'The helper was not found in the module, so the Repair is unsafe.',
    'The fix would bypass the rate limit guard.',
    'The earlier run said "The codex session failed: timeout", but the real blocker is the missing migration.',
  ])('keeps a Repair Agent summary that only mentions a failure word: %s', (summary) => {
    const body = stoppedReviewComment({ ...stoppedRepair, reason: summary }, '2026-11-22T04:00:00.000Z')

    expect(body).toContain(`🟠 **Blocked** · repair stopped\n\n${summary}`)
  })

  it('writes one line after a clean merge, because the verdict it replaces offers commands', () => {
    const verdict = `${stopped.publishedBody}\n<!-- workflow-state: {"_tag":"Review","headSha":"abc123","baseSha":"base123","outcome":"READY","gates":{"merge":"Passed","review":"Passed","ci":"Passed"}} -->`
    expect(stoppedReviewComment({ ...stopped, reason: null, publishedBody: verdict }, '2026-11-22T04:00:00.000Z', { _tag: 'Merged' }))
      .toContain('🟣 **Merged** · reviewed with no issues')
    expect(stoppedReviewComment({ ...stopped, reason: null }, '2026-11-22T04:00:00.000Z', { _tag: 'Merged' }))
      .toContain('🟣 **Merged** · no further reviews')
  })

  it('leaves a verdict standing when the pull request closes, and replaces a working state', () => {
    const verdict = '<!-- workflow-state: {"_tag":"Review","headSha":"abc123","baseSha":"base123","outcome":"BLOCKED","gates":{"merge":"Passed","review":"Failed","ci":"Passed"}} -->\n🟠 **Blocked** · 1 issue to fix before merge'
    expect(stoppedReviewComment({ ...stopped, publishedBody: verdict }, '2026-11-22T04:00:00.000Z', { _tag: 'Closed' })).toBe(verdict)
    expect(stoppedReviewComment(stopped, '2026-11-22T04:00:00.000Z', { _tag: 'Closed' })).toContain('⚪ **Closed** · no further reviews')
  })

  it('replaces Repair progress with Blocked and every exact finding', () => {
    const body = stoppedReviewComment(stoppedRepair, '2026-08-15T04:00:00.000Z')

    expect(body).toContain('🟠 **Blocked** · repair stopped')
    expect(body).toContain('1. **First exact finding.**  \n   Fix: Fix the first boundary.')
    expect(body).toContain('2. **Second exact finding.**  \n   Fix: Fix the second boundary.')
    expect(body).toContain('The Repair Agent found an unsafe scope.')
    expect(body).not.toContain('REPAIR')
  })

  it('keeps the reviewed code link after merge', () => {
    const body = stoppedReviewComment({
      ...stopped,
      findings: [{
        _tag: 'Open',
        summary: 'The queue can drop events.',
        nextAction: 'Preserve pending events.',
        details: {
          fingerprint: 'queue-events',
          location: { path: 'src/queue.ts', line: 42 },
          proof: 'The queue resets before sending.',
          regressionTest: 'Send two events.',
        },
      }],
    }, '2026-08-15T04:00:00.000Z', { _tag: 'Merged' })

    expect(body).toContain('🟣 **Merged** · 1 issue not fixed\n\n- The queue can drop events. · [`queue.ts:42`](https://github.com/harlan-zw/example/blob/abc123/src/queue.ts#L42)')
  })
})

describe('publishStoppedReviews', () => {
  it('reads stopped reviews one at a time to protect the GitHub request quota', async () => {
    let active = 0
    let maximumActive = 0
    const reviews = Array.from({ length: 8 }, (_, index): StoppedReview => ({
      ...stopped,
      taskId: `review-task-${index}`,
      pullRequestNumber: 24 + index,
    }))

    await publishStoppedReviews({
      github: {
        ...githubStatus,
        getPullRequestReviewSnapshot: async () => {
          active += 1
          maximumActive = Math.max(maximumActive, active)
          await new Promise(resolve => setTimeout(resolve, 5))
          active -= 1
          return snapshot()
        },
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => reviews,
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(maximumActive).toBe(1)
  })

  it('rewrites the canonical comment and records it once', async () => {
    let edited: { commentId: number, body: string } | undefined
    let recorded = 0
    const { results } = await publishStoppedReviews({
      github: {
        ...githubStatus,
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: (_repository, _number, commentId, _expectedBody, body) => {
          edited = { commentId, body }
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => {
          recorded += 1
          return true
        },
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'Published', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(edited?.commentId).toBe(42)
    expect(edited?.body).toContain('⚪ **Review skipped**')
    expect(recorded).toBe(1)
  })

  it('retires the publication once the comment belongs to another actor', async () => {
    const retired: Array<{ commentId: number, reason: string }> = []
    let recorded = 0
    const reason = 'The stored automated review comment belongs to another GitHub actor.' as const
    const { results } = await publishStoppedReviews({
      github: {
        ...githubStatus,
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Foreign', reason })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: (input) => {
          retired.push({ commentId: input.commentId, reason: input.reason })
          return true
        },
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => {
          recorded += 1
          return true
        },
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'Retired', repository: 'harlan-zw/example', pullRequestNumber: 24, reason })])
    expect(recorded).toBe(0)
    expect(retired).toEqual([{ commentId: 42, reason }])
  })

  it('does not finish while stale Agent labels remain', async () => {
    let recorded = 0
    const { results } = await publishStoppedReviews({
      github: {
        upsertReviewCheckRun: () => Promise.resolve(ok(undefined)),
        clearAgentLabels: () => Promise.resolve(err('GitHub did not clear the labels.')),
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => {
          recorded += 1
          return true
        },
      },
    }, new AbortController().signal)

    expect(results).toEqual([err('harlan-zw/example#24: GitHub did not clear the labels.')])
    expect(recorded).toBe(0)
  })

  it('closes a stale progress comment after GitHub merges the pull request', async () => {
    let body = ''
    let labelsCleared = 0
    const { results } = await publishStoppedReviews({
      github: {
        upsertReviewCheckRun: () => Promise.resolve(ok(undefined)),
        clearAgentLabels: () => {
          labelsCleared += 1
          return Promise.resolve(ok(undefined))
        },
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot({
          state: 'closed',
          mergedAt: '2026-08-15T03:00:00.000Z',
          headSha: 'def456',
        })),
        editReviewStatus: (_repository, _number, _commentId, _expectedBody, value) => {
          body = value
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'Published', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(body).toContain('🟣 **Merged**')
    expect(body).not.toContain('REVIEWING')
    expect(labelsCleared).toBe(1)
  })

  it('closes the comment on a merged pull request whose head branch GitHub deleted', async () => {
    let body = ''
    let closure: Parameters<JournalStore['recordReviewClosure']>[0] | undefined
    const { results } = await publishStoppedReviews({
      github: {
        ...githubStatus,
        getPullRequestReviewSnapshot: () => Promise.resolve(err('Branch not found - https://docs.github.com/rest/branches/branches#get-a-branch')),
        editReviewStatus: (_repository, _number, _commentId, _expectedBody, value) => {
          body = value
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        recordReviewClosure: (input) => {
          closure = input
          return true
        },
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [{ ...stopped, disposition: { _tag: 'Merged' } }],
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'Published', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(body).toContain('🟣 **Merged**')
    expect(closure).toEqual(expect.objectContaining({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      headSha: 'abc123',
      baseSha: 'base123',
      disposition: { _tag: 'Merged' },
      result: expect.objectContaining({ _tag: 'Published', body }),
    }))
  })

  it('keeps a missing closed comment eligible when label cleanup fails', async () => {
    let closures = 0
    let retired = 0
    const { results } = await publishStoppedReviews({
      github: {
        upsertReviewCheckRun: () => Promise.resolve(ok(undefined)),
        clearAgentLabels: () => Promise.resolve(err('GitHub did not clear the labels.')),
        getPullRequestReviewSnapshot: () => Promise.reject(new Error('A merged pull request needs no snapshot.')),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Missing' })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        recordReviewClosure: () => {
          closures += 1
          return true
        },
        recordDeletedReviewComment: () => {
          retired += 1
          return true
        },
        listStoppedReviews: () => [{ ...stopped, disposition: { _tag: 'Merged' } }],
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(results).toEqual([err('harlan-zw/example#24: GitHub did not clear the labels.')])
    expect(closures).toBe(0)
    expect(retired).toBe(0)
  })

  it('stops on its own budget and leaves the rest for the next pass', async () => {
    const backlog = Array.from({ length: 5 }, (_, index) => ({
      ...stopped,
      taskId: `review-task-${index}`,
      pullRequestNumber: 24 + index,
      disposition: { _tag: 'Merged' as const },
    }))
    let edits = 0
    // Every closed comment costs a GitHub round trip. This clock spends one
    // second on each, so the budget runs out partway through the backlog.
    let clock = Date.parse('2026-08-15T04:00:00.000Z')
    const { results, remaining } = await publishStoppedReviews({
      github: {
        ...githubStatus,
        getPullRequestReviewSnapshot: () => Promise.reject(new Error('A merged pull request needs no snapshot.')),
        editReviewStatus: () => {
          edits += 1
          clock += 1_000
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      now: () => new Date(clock),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => backlog,
        recordStoppedReviewStatus: () => true,
      },
      budgetMilliseconds: 3_000,
    }, new AbortController().signal)

    expect(results).toHaveLength(3)
    expect(remaining).toBe(2)
    expect(edits).toBe(3)
  })

  it('reports a backlog it never started, so a spent pass is never silent', async () => {
    const { results, remaining } = await publishStoppedReviews({
      github: {
        ...githubStatus,
        getPullRequestReviewSnapshot: () => Promise.reject(new Error('The budget was spent before any row ran.')),
        editReviewStatus: () => Promise.reject(new Error('The budget was spent before any row ran.')),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [stopped, stopped],
        recordStoppedReviewStatus: () => true,
      },
      budgetMilliseconds: 0,
    }, new AbortController().signal)

    expect(results).toEqual([])
    expect(remaining).toBe(2)
  })

  it('retires the publication a person deleted, so no later pass asks again', async () => {
    const retired: number[] = []
    let recorded = 0
    const { results } = await publishStoppedReviews({
      github: {
        ...githubStatus,
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Missing' })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: (input) => {
          retired.push(input.commentId)
          return true
        },
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => {
          recorded += 1
          return true
        },
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'CommentGone', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(recorded).toBe(0)
    expect(retired).toEqual([42])
  })

  it('completes the Review check run when it closes a stopped review', async () => {
    const checkRuns: Array<{ headSha: string, conclusion: string, title: string }> = []
    const { results } = await publishStoppedReviews({
      github: {
        ...githubStatus,
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
        upsertReviewCheckRun: (_repository, headSha, update) => {
          checkRuns.push(update._tag === 'Completed'
            ? { headSha, conclusion: update.conclusion, title: update.title }
            : { headSha, conclusion: 'running', title: update.title })
          return Promise.resolve(ok(undefined))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'Published', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(checkRuns).toEqual([{ headSha: 'abc123', conclusion: 'neutral', title: '⚪ Review skipped · the pull request is not ready for review' }])
  })

  it('completes the Review check run even when a person deleted the comment', async () => {
    const checkRuns: Array<{ headSha: string, conclusion: string }> = []
    await publishStoppedReviews({
      github: {
        ...githubStatus,
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Missing' })),
        upsertReviewCheckRun: (_repository, headSha, update) => {
          checkRuns.push(update._tag === 'Completed'
            ? { headSha, conclusion: update.conclusion }
            : { headSha, conclusion: 'running' })
          return Promise.resolve(ok(undefined))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(checkRuns).toEqual([{ headSha: 'abc123', conclusion: 'neutral' }])
  })

  it('settles a stopped review when the installation refuses its check run', async () => {
    let recorded = 0
    const reports: ReviewCheckRunOutcome[] = []
    const { results } = await publishStoppedReviews({
      github: {
        ...githubStatus,
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
        upsertReviewCheckRun: () => Promise.resolve(err('The permissions requested are not granted to this installation.')),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: (_repository, outcome) => reports.push(outcome),
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => {
          recorded += 1
          return true
        },
      },
    }, new AbortController().signal)

    expect(results[0]?._tag).toBe('Ok')
    expect(recorded).toBe(1)
    expect(reports.map(report => report._tag)).toEqual(['Refused'])
  })

  it('retires a stale publication after another Task replaces its comment', async () => {
    const retired: number[] = []
    const { results } = await publishStoppedReviews({
      github: {
        ...githubStatus,
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Changed' })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: (input) => {
          retired.push(input.commentId)
          return true
        },
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'Superseded', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(retired).toEqual([42])
  })

  it('leaves the comment alone once the pull request moves on', async () => {
    let writes = 0
    const { results } = await publishStoppedReviews({
      github: {
        ...githubStatus,
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot({ headSha: 'def456' })),
        editReviewStatus: () => {
          writes += 1
          return Promise.resolve(err('Unexpected comment write.'))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      reportCheckRun: () => undefined,
      repositories: [repositoryMapping()],
      store: {
        ...reviewClosureStore,
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(writes).toBe(0)
    expect(results).toEqual([ok({ _tag: 'Superseded', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
  })
})
