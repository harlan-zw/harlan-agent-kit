import type { GitHubCheck } from '../src/github-agent-source.ts'
import type { RecordIncidentInput, ReviewGateRefresh } from '../src/store.ts'
import type { Incident, ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { refreshControllerGates, terminalComment } from '../src/item-agent.ts'
import { err, ok } from '../src/result.ts'
import { refreshReviewGates } from '../src/review-gate-sweep.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'
import { githubPublicationFixture } from './github-publication-fixture.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

function passed(label: string) {
  return { _tag: 'Passed' as const, evidence: [{ label, sha256: 'a'.repeat(64) }] }
}

function pendingControllerGates(): ReviewGates {
  return {
    merge: passed('mergeability'),
    review: passed('review'),
    ci: {
      _tag: 'Pending',
      reason: 'Base branch CI: deploy (pro-admin) is still running.',
      evidence: [{ label: 'base-ci', sha256: 'b'.repeat(64) }],
    },
  }
}

function passedControllerGates(): ReviewGates {
  return {
    merge: passed('mergeability'),
    review: passed('review'),
    ci: passed('required-ci'),
  }
}

function gateRefresh(overrides: Partial<ReviewGateRefresh> = {}): ReviewGateRefresh {
  return {
    reviewRunId: 'run-1',
    baseRef: 'main',
    gatePublication: { _tag: 'Published', publicationId: 'published-1' },
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-1',
    headSha: 'abc123',
    provider: 'codex',
    sessionId: 'session-1',
    model: 'gpt-5.6-sol',
    agentVersion: '0.0.0',
    skillDigest: 'c'.repeat(64),
    startedAt: '2026-08-27T08:11:00.000Z',
    completedAt: '2026-08-27T08:20:00.000Z',
    usage: { _tag: 'Unavailable' },
    gates: pendingControllerGates(),
    findings: [],
    confidence: 88,
    gatesUpdatedAt: '2026-08-27T08:20:00.000Z',
    commentId: 42,
    publishedBody: '### 🤖 PENDING',
    ...overrides,
  }
}

function check(overrides: Partial<GitHubCheck> = {}): GitHubCheck {
  return {
    name: 'deploy (pro-admin)',
    status: 'completed',
    conclusion: 'success',
    source: { _tag: 'CheckRun', appId: 1 },
    failure: { _tag: 'Unknown' },
    startedAt: '2026-08-27T08:23:00.000Z',
    ...overrides,
  } as GitHubCheck
}

function snapshot(baseChecks: GitHubCheck[], headChecks: GitHubCheck[] = [check({ name: 'code' })]) {
  return ok({
    baseChecks: { _tag: 'Available' as const, checks: baseChecks },
    body: '',
    checks: { _tag: 'Available' as const, checks: headChecks },
    comments: [],
    priorAutomatedReview: { _tag: 'None' as const },
    pullRequest: pullRequestItem({ headSha: 'abc123', mergeState: 'clean' }),
    requiredChecks: { _tag: 'None' as const },
    reviews: [],
  })
}

function recordPublishedRefreshReview(store: ReturnType<typeof openJournalStore>) {
  const repository = repositoryMapping()
  const live = snapshot([check()])
  if (live._tag !== 'Ok')
    throw new Error('Expected a Review snapshot.')
  const refreshed = refreshControllerGates(passedControllerGates(), live.value, repository)
  const gates = refreshed.gates
  store.syncRepositories([repository], '2026-08-27T08:00:00.000Z')
  store.setRepositoryWritesEnabled(repository.github, true)
  const observed = store.recordObservation({
    externalId: 'published-refresh-pr',
    observedAt: '2026-08-27T08:01:00.000Z',
    source: 'poll',
    subject: pullRequestItem({ mergeState: 'clean' }),
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a new pull request revision.')
  const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-27T08:02:00.000Z', 60_000)
  if (task === null)
    throw new Error('Expected a Review Task.')
  store.completeWorkerTask({
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: '2026-08-27T08:02:30.000Z',
    evidence: 'published-refresh-review',
  })
  expect(store.recordReviewRun({
    id: 'published-refresh-review',
    repository: repository.github,
    pullRequestNumber: 24,
    revisionId: observed.revisionId,
    headSha: 'abc123',
    provider: 'codex',
    sessionId: 'session-1',
    model: 'gpt-5.6-sol',
    agentVersion: '0.0.0',
    skillDigest: 'c'.repeat(64),
    startedAt: '2026-08-27T08:11:00.000Z',
    completedAt: '2026-08-27T08:20:00.000Z',
    usage: { _tag: 'Unavailable' },
    gates,
    confidence: 88,
    findings: [],
  })).toEqual({ _tag: 'Inserted', reviewRunId: 'published-refresh-review' })
  expect(store.recordReviewPublication({
    id: 'published-refresh-publication',
    reviewRunId: 'published-refresh-review',
    body: '### 🤖 READY',
    at: '2026-08-27T08:21:00.000Z',
    result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
  })).toEqual({ _tag: 'Inserted', publicationId: 'published-refresh-publication' })
  const body = terminalComment('abc123', 'base123', gates, [], 88, refreshed.reportedChecks)
  expect(store.stageReviewGateStatus({
    reviewRunId: 'published-refresh-review',
    repository: repository.github,
    pullRequestNumber: 24,
    revisionId: observed.revisionId,
    expectedHeadSha: 'abc123',
    gates,
    body,
    desiredOutcome: 'READY',
    at: '2026-08-27T08:22:00.000Z',
  })._tag).toBe('Staged')
  const publication = store.claimNextTerminalReviewStatus('publisher-1', '2026-08-27T08:22:01.000Z', 60_000)
  if (publication === null)
    throw new Error('Expected a Review gate Publication.')
  expect(store.completeReviewStatus({
    commandId: publication.id,
    workerId: publication.workerId,
    fence: publication.fence,
    at: '2026-08-27T08:22:02.000Z',
    commentId: 42,
    url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
  })).toBe(true)
  return repository
}

type AuthorityRevocation = 'Dismissal' | 'Pause' | 'writes' | 'policy'

function revokeRefreshAuthority(
  store: ReturnType<typeof openJournalStore>,
  repository: ReturnType<typeof repositoryMapping>,
  change: AuthorityRevocation,
) {
  if (change === 'Dismissal')
    store.dismissItem({ repository: repository.github, itemNumber: 24, at: '2026-08-27T11:15:00.000Z' })
  if (change === 'Pause')
    store.setRepositoryPaused(repository.github, true)
  if (change === 'writes')
    store.setRepositoryWritesEnabled(repository.github, false)
  if (change === 'policy')
    store.syncRepositories([repositoryMapping({ writablePullRequestHeadPrefixes: ['different/'] })], '2026-08-27T11:15:00.000Z')
}

interface Recorded {
  edited?: { commentId: number, expectedBody: string, body: string }
  incidents: RecordIncidentInput[]
  resolved: Array<{ repository: string, operation: string | undefined, exceptMessages: readonly string[] }>
  failed: Array<{ reviewRunId: string, reason: string }>
  staged: Array<{ reviewRunId: string, outcome: string, ci: string, reconciliationId?: string, body: string }>
  stamped: string[]
  baselineQueued: Array<{ repository: string, pullRequestNumber: number, revisionId: string, baseSha: string }>
}

function harness(options: {
  review?: ReviewGateRefresh
  live?: ReturnType<typeof snapshot>
  edit?: () => Promise<any>
  repairAccess?: string
}) {
  const recorded: Recorded = { baselineQueued: [], failed: [], incidents: [], resolved: [], staged: [], stamped: [] }
  const run = async () => refreshReviewGates({
    preflightRepair: () => Promise.resolve(options.repairAccess === undefined ? ok(undefined) : err(options.repairAccess)),
    github: {
      getPullRequestReviewSnapshot: () => Promise.resolve(options.live ?? snapshot([check()])),
      editReviewStatus: (_repository, _number, commentId, expectedBody, body) => {
        recorded.edited = { commentId, expectedBody, body }
        return options.edit?.() ?? Promise.resolve(ok({
          _tag: 'Edited',
          commentId: 42,
          url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
        }))
      },
      stampAgentLabel: (_repository, _number, outcome) => {
        recorded.stamped.push(outcome)
        return Promise.resolve(ok(undefined))
      },
    },
    now: () => new Date('2026-08-27T11:15:00.000Z'),
    repositories: [repositoryMapping()],
    store: {
      listReviewGateRefreshes: () => [options.review ?? gateRefresh()],
      queueReviewFixForGate: () => { throw new Error('A passing Review needs no Repair.') },
      queueBaselineRepairForGate: ({ at: _at, ...input }) => {
        recorded.baselineQueued.push(input)
        return { _tag: 'Queued', taskId: 'baseline-1' }
      },
      recordIncident: (incident) => {
        recorded.incidents.push(incident)
        return { ...incident, id: 'incident-1', occurrences: 1, firstSeenAt: incident.at, lastSeenAt: incident.at } satisfies Incident
      },
      resolveIncidents: (scope, _at, operation, exceptMessages = []) => {
        if (scope._tag === 'Repository')
          recorded.resolved.push({ repository: scope.repository, operation, exceptMessages })
        return 0
      },
      recordReviewPublication: (input) => {
        if (input.result._tag === 'Failed')
          recorded.failed.push({ reviewRunId: input.reviewRunId, reason: input.result.reason })
        return { _tag: 'Inserted', publicationId: input.id }
      },
      stageReviewGateStatus: (input) => {
        recorded.staged.push({
          reviewRunId: input.reviewRunId,
          outcome: input.desiredOutcome,
          ci: input.gates.ci._tag,
          ...(input.reconciliationId === undefined ? {} : { reconciliationId: input.reconciliationId }),
          body: input.body,
        })
        return { _tag: 'Staged', commandId: 'status-1' }
      },
    },
  }, new AbortController().signal)
  return { recorded, run }
}

describe('refreshControllerGates', () => {
  it('names a queued check run no runner accepted, apart from one that runs', () => {
    const queued = snapshot([check({ name: 'test', status: 'queued', conclusion: null })])
    const running = snapshot([check({ name: 'test', status: 'in_progress', conclusion: null })])
    if (queued._tag !== 'Ok' || running._tag !== 'Ok')
      throw new Error('Expected Review snapshots.')

    const queuedGates = refreshControllerGates(pendingControllerGates(), queued.value, repositoryMapping())
    const runningGates = refreshControllerGates(pendingControllerGates(), running.value, repositoryMapping())

    expect(queuedGates.ciCause).toEqual({ _tag: 'CheckQueued', check: 'test' })
    expect(queuedGates.gates.ci).toMatchObject({ _tag: 'Pending', reason: 'Base branch CI: test is queued, and no runner has accepted the job.' })
    expect(runningGates.ciCause).toEqual({ _tag: 'CheckRunning', check: 'test' })
    expect(runningGates.gates.ci).toMatchObject({ _tag: 'Pending', reason: 'Base branch CI: test is still running.' })
  })
})

describe('refreshReviewGates', () => {
  it('skips Reviews outside the requested Repository mappings', async () => {
    const { recorded, run } = harness({ review: gateRefresh({ repository: 'harlan-zw/other' }) })
    expect(await run()).toEqual([])
    expect(recorded.staged).toEqual([])
    expect(recorded.resolved.map(resolved => resolved.repository)).toEqual(['harlan-zw/example'])
  })

  it('leaves a Review alone when GitHub retargets its unchanged head', async () => {
    const live = snapshot([check()])
    if (live._tag !== 'Ok')
      throw new Error('Expected a Review snapshot.')
    live.value.pullRequest.baseRef = 'fix/parent'
    const { recorded, run } = harness({ live })
    expect(await run()).toEqual([ok({ _tag: 'Superseded', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(recorded.staged).toEqual([])
  })

  it('queues a Baseline repair once the default branch fails under a settled review', async () => {
    const live = snapshot([check({ name: 'Fuzz fuzz_options', conclusion: 'failure' })])
    const { recorded, run } = harness({ live })

    const results = await run()

    expect(recorded.baselineQueued).toEqual([{
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      baseSha: 'base123',
    }])
    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'PENDING',
      baselineRepair: { _tag: 'Queued', taskId: 'baseline-1' },
    })])
  })

  it('keeps asking for the Baseline repair while the default branch stays red', async () => {
    const live = snapshot([check({ name: 'Fuzz fuzz_options', conclusion: 'failure' })])
    if (live._tag !== 'Ok')
      throw new Error('Expected a Review snapshot.')
    const { recorded, run } = harness({
      live,
      review: gateRefresh({
        gates: refreshControllerGates(pendingControllerGates(), live.value, repositoryMapping()).gates,
      }),
    })

    const results = await run()

    expect(recorded.baselineQueued).toHaveLength(1)
    expect(results).toEqual([ok(expect.objectContaining({
      _tag: 'Unchanged',
      outcome: 'PENDING',
      baselineRepair: { _tag: 'Queued', taskId: 'baseline-1' },
    }))])
  })

  it('queues no Baseline repair when the controller cannot push to the repository', async () => {
    const live = snapshot([check({ name: 'Fuzz fuzz_options', conclusion: 'failure' })])
    const { recorded, run } = harness({ live, repairAccess: 'The installation lacks contents write.' })

    const results = await run()

    expect(recorded.baselineQueued).toEqual([])
    expect(results).toEqual([ok(expect.objectContaining({
      baselineRepair: { _tag: 'NotAuthorized', reason: 'The installation lacks contents write.' },
    }))])
  })

  it('queues no Baseline repair while the default branch is still running', async () => {
    const live = snapshot([check({ status: 'in_progress', conclusion: null })])
    const { recorded, run } = harness({ live })

    const results = await run()

    expect(recorded.baselineQueued).toEqual([])
    expect(results[0]).toEqual(ok(expect.not.objectContaining({ baselineRepair: expect.anything() })))
  })

  it('turns a review waiting on base branch CI into READY once CI passes', async () => {
    const { recorded, run } = harness({})

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'READY',
    })])
    expect(recorded.edited).toBeUndefined()
    expect(recorded.staged[0]?.body).toContain('### 🤖 READY · 88/100')
    expect(recorded.staged[0]?.body).not.toContain('Waiting:')
    expect(recorded.stamped).toEqual([])
  })

  it('stages one projection for the existing Agent run', async () => {
    const { recorded, run } = harness({})

    await run()

    expect(recorded.staged).toEqual([{
      reviewRunId: 'run-1',
      outcome: 'READY',
      ci: 'Passed',
      body: expect.stringContaining('### 🤖 READY'),
    }])
  })

  it('leaves the comment alone while base branch CI is still running', async () => {
    const live = snapshot([check({ status: 'in_progress', conclusion: null })])
    if (live._tag !== 'Ok')
      throw new Error('Expected a Review snapshot.')
    const { recorded, run } = harness({
      live,
      review: gateRefresh({
        gates: refreshControllerGates(pendingControllerGates(), live.value, repositoryMapping()).gates,
      }),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'Unchanged',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'PENDING',
      reason: 'Base branch CI: deploy (pro-admin) is still running.',
    })])
    expect(recorded.edited).toEqual({
      commentId: 42,
      expectedBody: '### 🤖 PENDING',
      body: '### 🤖 PENDING',
    })
    expect(recorded.staged).toEqual([])
    expect(recorded.stamped).toEqual(['PENDING'])
  })

  it('keeps an unchanged BLOCKED label when the Review remains authorized', async () => {
    const live = snapshot([check()], [check({ name: 'code', conclusion: 'failure' })])
    if (live._tag !== 'Ok')
      throw new Error('Expected a Review snapshot.')
    const { recorded, run } = harness({
      live,
      review: gateRefresh({
        gates: refreshControllerGates(pendingControllerGates(), live.value, repositoryMapping()).gates,
      }),
    })

    expect(await run()).toEqual([ok(expect.objectContaining({ _tag: 'Unchanged', outcome: 'BLOCKED' }))])
    expect(recorded.stamped).toEqual(['BLOCKED'])
  })

  it('reports BLOCKED when the fresh CI read fails', async () => {
    const { recorded, run } = harness({
      live: snapshot([check()], [check({ name: 'code', conclusion: 'failure' })]),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'BLOCKED',
    })])
    expect(recorded.staged[0]?.body).toContain('### 🤖 BLOCKED')
    // The score belongs to a passing verdict, so a blocked one never names it.
    expect(recorded.staged[0]?.body).not.toContain('88/100')
    expect(recorded.stamped).toEqual([])
  })

  it('leaves a pull request whose head commit moved to its own review', async () => {
    const moved = snapshot([check()])
    if (moved._tag !== 'Ok')
      throw new Error('Expected a snapshot.')
    const { recorded, run } = harness({
      live: ok({ ...moved.value, pullRequest: pullRequestItem({ headSha: 'def456', mergeState: 'clean' }) }),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'Superseded',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
    })])
    expect(recorded.edited).toBeUndefined()
    expect(recorded.staged).toEqual([])
  })

  it('publishes BLOCKED when the merge gate becomes conflicting', async () => {
    const conflicted = snapshot([check()])
    if (conflicted._tag !== 'Ok')
      throw new Error('Expected a snapshot.')
    const { recorded, run } = harness({
      live: ok({ ...conflicted.value, pullRequest: pullRequestItem({ headSha: 'abc123', mergeState: 'conflicting' }) }),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'BLOCKED',
    })])
    expect(recorded.staged[0]?.body).toContain('**Merge gate:** BLOCKED. The pull request has merge conflicts.')
    expect(recorded.staged).toHaveLength(1)
    expect(recorded.stamped).toEqual([])
  })

  it('queues reconciliation when the canonical comment is missing', async () => {
    const live = snapshot([check({ status: 'in_progress', conclusion: null })])
    if (live._tag !== 'Ok')
      throw new Error('Expected a Review snapshot.')
    const { recorded, run } = harness({
      live,
      review: gateRefresh({
        gates: refreshControllerGates(pendingControllerGates(), live.value, repositoryMapping()).gates,
      }),
      edit: () => Promise.resolve(ok({ _tag: 'Missing' })),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'PENDING',
    })])
    expect(recorded.stamped).toEqual([])
    expect(recorded.staged[0]?.reconciliationId).toContain('Missing:42:')
  })

  it('raises one Incident when the CI Review gate has read PENDING for a day', async () => {
    const live = snapshot([check({ conclusion: 'failure' })])
    if (live._tag !== 'Ok')
      throw new Error('Expected a Review snapshot.')
    const { recorded, run } = harness({
      live,
      review: gateRefresh({
        gates: refreshControllerGates(pendingControllerGates(), live.value, repositoryMapping()).gates,
        gatesUpdatedAt: '2026-08-26T11:15:00.000Z',
      }),
    })

    await run()

    const message = 'harlan-zw/example#24: the CI Review gate reads PENDING for more than 4 hours. '
      + 'The gate last moved at 2026-08-26 11:15 UTC. '
      + 'Base branch check run "deploy (pro-admin)" failed. '
      + 'If the default branch is broken, repair it and re-run the check run.'
    expect(recorded.incidents).toEqual([{
      scope: { _tag: 'Repository', repository: 'harlan-zw/example' },
      kind: 'ci_gate_pending',
      severity: 'warning',
      operation: 'ci_gate_pending',
      message,
      recovery: { _tag: 'ActionRequired' },
      at: '2026-08-27T11:15:00.000Z',
    }])
    expect(recorded.resolved).toEqual([{
      repository: 'harlan-zw/example',
      operation: 'ci_gate_pending',
      exceptMessages: [message],
    }])
  })

  it('raises no Incident while the CI Review gate is inside its bound', async () => {
    const live = snapshot([check({ status: 'in_progress', conclusion: null })])
    if (live._tag !== 'Ok')
      throw new Error('Expected a Review snapshot.')
    const { recorded, run } = harness({
      live,
      review: gateRefresh({
        gates: refreshControllerGates(pendingControllerGates(), live.value, repositoryMapping()).gates,
      }),
    })

    await run()

    expect(recorded.incidents).toEqual([])
  })

  it('resolves the Incident once the CI Review gate moves', async () => {
    const { recorded, run } = harness({})

    await run()

    expect(recorded.incidents).toEqual([])
    expect(recorded.resolved).toEqual([{
      repository: 'harlan-zw/example',
      operation: 'ci_gate_pending',
      exceptMessages: [],
    }])
  })

  it('retires the Review instead of staging a status when another actor owns the comment', async () => {
    const live = snapshot([check({ status: 'in_progress', conclusion: null })])
    if (live._tag !== 'Ok')
      throw new Error('Expected a Review snapshot.')
    const reason = 'The stored automated review comment belongs to another GitHub actor.' as const
    const { recorded, run } = harness({
      live,
      review: gateRefresh({
        gates: refreshControllerGates(pendingControllerGates(), live.value, repositoryMapping()).gates,
      }),
      edit: () => Promise.resolve(ok({ _tag: 'Foreign', reason })),
    })

    const results = await run()

    expect(results).toEqual([ok({ _tag: 'Retired', repository: 'harlan-zw/example', pullRequestNumber: 24, reason })])
    expect(recorded.staged).toEqual([])
    expect(recorded.stamped).toEqual([])
    expect(recorded.failed).toEqual([{ reviewRunId: 'run-1', reason }])
  })
})

describe('refreshReviewGates against the journal store', () => {
  afterEach(() => {
    stores.splice(0).forEach(store => store.close())
  })

  it('settles a merge gate frozen as Pending once GitHub reports the pull request mergeable', async () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping()], '2026-08-27T08:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'merge-pending-pr',
      observedAt: '2026-08-27T08:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const reviewTask = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-27T08:02:00.000Z', 60_000)
    if (reviewTask === null)
      throw new Error('Expected a Review Task.')
    store.completeWorkerTask({
      taskId: reviewTask.id,
      workerId: reviewTask.state.workerId,
      fence: reviewTask.state.fence,
      at: '2026-08-27T08:02:30.000Z',
      evidence: 'run-pending',
    })

    const gates = pendingControllerGates()
    gates.merge = { _tag: 'Pending', reason: 'GitHub has not resolved mergeability.', evidence: [{ label: 'mergeability', sha256: 'd'.repeat(64) }] }
    expect(store.recordReviewRun({
      id: 'run-pending',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'session-1',
      model: 'gpt-5.6-sol',
      agentVersion: '0.0.0',
      skillDigest: 'c'.repeat(64),
      startedAt: '2026-08-27T08:11:00.000Z',
      completedAt: '2026-08-27T08:20:00.000Z',
      usage: { _tag: 'Available', input: 10, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 0 },
      gates,
      confidence: 88,
      findings: [],
    })).toEqual({ _tag: 'Inserted', reviewRunId: 'run-pending' })
    expect(store.recordReviewPublication({
      id: 'publication-pending',
      reviewRunId: 'run-pending',
      body: '### 🤖 PENDING',
      at: '2026-08-27T08:21:00.000Z',
      result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
    })).toEqual({ _tag: 'Inserted', publicationId: 'publication-pending' })

    const stamped: string[] = []
    const results = await refreshReviewGates({
      preflightRepair: () => Promise.resolve(ok(undefined)),
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot([check()])),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
        stampAgentLabel: (_repository, _number, outcome) => {
          stamped.push(outcome)
          return Promise.resolve(ok(undefined))
        },
      },
      now: () => new Date('2026-08-27T11:15:00.000Z'),
      repositories: [repositoryMapping()],
      store,
    }, new AbortController().signal)

    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'READY',
    })])
    expect(stamped).toEqual([])
    expect(store.listReviewGateRefreshes()).toEqual([expect.objectContaining({
      reviewRunId: expect.any(String),
      confidence: 88,
    })])
    const settledRun = store.getDashboardSnapshot('2026-08-27T11:16:00.000Z')
      .agents
      .find(agent => agent._tag === 'ReviewAgent')
    if (settledRun?._tag !== 'ReviewAgent')
      throw new Error('Expected the settled Review run on the dashboard.')
    expect(settledRun.id).toBe('run-pending')
    expect(settledRun.startedAt).toBe('2026-08-27T08:11:00.000Z')
    expect(settledRun.completedAt).toBe('2026-08-27T08:20:00.000Z')
    expect(settledRun.outcome).toEqual({ _tag: 'Ready', confidence: 88 })
    expect(settledRun.gates.merge._tag).toBe('Passed')
    expect(store.listWorkflowEvents({ stream: 'review_gate', limit: 10 })).toMatchObject([
      {
        event: 'Projected',
        entityId: 'run-pending',
        from: 'Pending',
        to: 'Ready',
        usage: null,
      },
    ])
    const publication = store.claimNextTerminalReviewStatus(
      'status-publisher-1',
      '2026-08-27T11:16:00.000Z',
      60_000,
    )
    expect(publication).toMatchObject({
      reviewRunId: 'run-pending',
      desiredOutcome: 'READY',
      body: expect.stringContaining('### 🤖 READY'),
    })
  })

  it.each(['Dismissal', 'Pause', 'writes', 'policy'] as const)('does not stamp an unchanged Review label when %s revokes authority during the snapshot read', async (change) => {
    const store = openJournalStore(':memory:', true)
    stores.push(store)
    const repository = recordPublishedRefreshReview(store)
    const stamped: string[] = []

    const results = await refreshReviewGates({
      preflightRepair: () => Promise.resolve(ok(undefined)),
      github: {
        getPullRequestReviewSnapshot: () => {
          revokeRefreshAuthority(store, repository, change)
          return Promise.resolve(snapshot([check()]))
        },
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'url' })),
        stampAgentLabel: (_repository, _number, outcome) => {
          stamped.push(outcome)
          return Promise.resolve(ok(undefined))
        },
      },
      now: () => new Date('2026-08-27T11:15:00.000Z'),
      repositories: [repository],
      store,
    }, new AbortController().signal)

    expect(results).toEqual([err('harlan-zw/example#24: The Review authority changed before its label write.')])
    expect(stamped).toEqual([])
  })

  it.each(['Dismissal', 'Pause', 'writes', 'policy'] as const)('does not stamp an unchanged Review label when %s revokes authority during confirmation', async (change) => {
    const store = openJournalStore(':memory:', true)
    stores.push(store)
    const repository = recordPublishedRefreshReview(store)
    const stamped: string[] = []

    const results = await refreshReviewGates({
      preflightRepair: () => Promise.resolve(ok(undefined)),
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot([check()])),
        editReviewStatus: () => {
          revokeRefreshAuthority(store, repository, change)
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'url' }))
        },
        stampAgentLabel: (_repository, _number, outcome) => {
          stamped.push(outcome)
          return Promise.resolve(ok(undefined))
        },
      },
      now: () => new Date('2026-08-27T11:15:00.000Z'),
      repositories: [repository],
      store,
    }, new AbortController().signal)

    expect(results).toEqual([err('harlan-zw/example#24: The Review authority changed before its label write.')])
    expect(stamped).toEqual([])
  })

  it('does not stamp an unchanged Review label when its gate Publication changes during confirmation', async () => {
    const store = openJournalStore(':memory:', true)
    stores.push(store)
    const repository = recordPublishedRefreshReview(store)
    const stamped: string[] = []

    const results = await refreshReviewGates({
      preflightRepair: () => Promise.resolve(ok(undefined)),
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot([check()])),
        editReviewStatus: () => {
          const review = store.listReviewGateRefreshes()[0]
          if (review === undefined)
            throw new Error('Expected the current Review gate refresh.')
          expect(store.stageReviewGateStatus({
            reviewRunId: review.reviewRunId,
            repository: review.repository,
            pullRequestNumber: review.pullRequestNumber,
            revisionId: review.revisionId,
            expectedHeadSha: review.headSha,
            gates: { ...review.gates, ci: { _tag: 'Pending', reason: 'CI is running.', evidence: [] } },
            body: '### 🤖 PENDING',
            desiredOutcome: 'PENDING',
            at: '2026-08-27T11:15:00.000Z',
          })._tag).toBe('Staged')
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'url' }))
        },
        stampAgentLabel: (_repository, _number, outcome) => {
          stamped.push(outcome)
          return Promise.resolve(ok(undefined))
        },
      },
      now: () => new Date('2026-08-27T11:15:00.000Z'),
      repositories: [repository],
      store,
    }, new AbortController().signal)

    expect(results).toEqual([err('harlan-zw/example#24: The Review authority changed before its label write.')])
    expect(stamped).toEqual([])
  })

  it('stamps an unchanged Review label while its current authority remains valid', async () => {
    const store = openJournalStore(':memory:', true)
    stores.push(store)
    const repository = recordPublishedRefreshReview(store)
    const stamped: string[] = []

    const results = await refreshReviewGates({
      preflightRepair: () => Promise.resolve(ok(undefined)),
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot([check()])),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'url' })),
        stampAgentLabel: (_repository, _number, outcome) => {
          stamped.push(outcome)
          return Promise.resolve(ok(undefined))
        },
      },
      now: () => new Date('2026-08-27T11:15:00.000Z'),
      repositories: [repository],
      store,
    }, new AbortController().signal)

    expect(results).toEqual([ok(expect.objectContaining({ _tag: 'Unchanged', outcome: 'READY' }))])
    expect(stamped).toEqual(['READY'])
  })

  it('keeps one journal entry when controller gates refresh', async () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping()], '2026-08-27T08:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'ci-pending-pr',
      observedAt: '2026-08-27T08:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-27T08:01:30.000Z', 60_000)
    if (task === null)
      throw new Error('Expected the queued Review Task.')
    store.completeWorkerTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: '2026-08-27T08:02:00.000Z', evidence: 'review-run' })

    expect(store.recordReviewRun({
      id: 'run-pending',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'session-1',
      model: 'gpt-5.6-sol',
      agentVersion: '0.0.0',
      skillDigest: 'c'.repeat(64),
      startedAt: '2026-08-27T08:11:00.000Z',
      completedAt: '2026-08-27T08:20:00.000Z',
      usage: { _tag: 'Available', input: 10, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 0 },
      gates: pendingControllerGates(),
      confidence: 88,
      findings: [],
    })).toEqual({ _tag: 'Inserted', reviewRunId: 'run-pending' })
    expect(store.recordReviewPublication({
      id: 'publication-pending',
      reviewRunId: 'run-pending',
      body: '### 🤖 PENDING',
      at: '2026-08-27T08:21:00.000Z',
      result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
    })).toEqual({ _tag: 'Inserted', publicationId: 'publication-pending' })

    const results = await refreshReviewGates({
      preflightRepair: () => Promise.resolve(ok(undefined)),
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot([check()])),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Changed' })),
        stampAgentLabel: () => Promise.resolve(ok(undefined)),
      },
      now: () => new Date('2026-08-27T11:15:00.000Z'),
      repositories: [repositoryMapping()],
      store,
    }, new AbortController().signal)

    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'READY',
    })])
    expect(store.listReviewGateRefreshes()).toHaveLength(1)

    const reviewAgents = store.getDashboardSnapshot('2026-08-27T11:16:00.000Z')
      .agents
      .filter(agent => agent._tag === 'ReviewAgent')
    if (reviewAgents.length !== 1)
      throw new Error(`Expected exactly one Review run card, not ${reviewAgents.length}.`)
    const settledRun = reviewAgents[0]
    if (settledRun?._tag !== 'ReviewAgent')
      throw new Error('Expected the settled Review run on the dashboard.')
    expect(settledRun.outcome).toEqual({ _tag: 'Ready', confidence: 88 })
    expect(settledRun.gates.ci._tag).toBe('Passed')
    expect(settledRun.usage).toEqual({ _tag: 'Available', input: 10, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 0 })
  })

  it('names the pull request whose CI Review gate has not moved for a day', async () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping()], '2026-08-26T08:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'stalled-ci-pr',
      observedAt: '2026-08-26T08:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-26T08:01:30.000Z', 60_000)
    if (task === null)
      throw new Error('Expected the queued Review Task.')
    store.completeWorkerTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: '2026-08-26T08:02:00.000Z', evidence: 'review-run' })

    const red = snapshot([check({ conclusion: 'failure' })])
    if (red._tag !== 'Ok')
      throw new Error('Expected a Review snapshot.')
    expect(store.recordReviewRun({
      id: 'run-stalled',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'session-1',
      model: 'gpt-5.6-sol',
      agentVersion: '0.0.0',
      skillDigest: 'c'.repeat(64),
      startedAt: '2026-08-26T08:11:00.000Z',
      completedAt: '2026-08-26T08:20:00.000Z',
      usage: { _tag: 'Unavailable' },
      gates: refreshControllerGates(pendingControllerGates(), red.value, repositoryMapping()).gates,
      confidence: 88,
      findings: [],
    })).toEqual({ _tag: 'Inserted', reviewRunId: 'run-stalled' })
    expect(store.recordReviewPublication({
      id: 'publication-stalled',
      reviewRunId: 'run-stalled',
      body: '### 🤖 PENDING',
      at: '2026-08-26T08:21:00.000Z',
      result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
    })).toEqual({ _tag: 'Inserted', publicationId: 'publication-stalled' })
    expect(store.listReviewGateRefreshes()[0]?.gatesUpdatedAt).toBe('2026-08-26T08:20:00.000Z')

    await refreshReviewGates({
      preflightRepair: () => Promise.resolve(ok(undefined)),
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(red),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
        stampAgentLabel: () => Promise.resolve(ok(undefined)),
      },
      now: () => new Date('2026-08-27T11:15:00.000Z'),
      repositories: [repositoryMapping()],
      store,
    }, new AbortController().signal)

    expect(store.listIncidents()).toEqual([expect.objectContaining({
      scope: { _tag: 'Repository', repository: 'harlan-zw/example' },
      kind: 'ci_gate_pending',
      occurrences: 1,
      firstSeenAt: '2026-08-27T11:15:00.000Z',
      message: 'harlan-zw/example#24: the CI Review gate reads PENDING for more than 4 hours. '
        + 'The gate last moved at 2026-08-26 08:20 UTC. '
        + 'Base branch check run "deploy (pro-admin)" failed. '
        + 'If the default branch is broken, repair it and re-run the check run.',
    })])

    // A poll answers for GitHub, never for a gate that never moved.
    store.recordPollSuccess('harlan-zw/example', '2026-08-27T11:20:00.000Z')

    expect(store.listIncidents()).toHaveLength(1)
  })
})

it.each(['labels', 'create label', 'add label', 'remove label', 'kept', 'idempotent'] as const)('checks unchanged Review authority during real %s helper boundaries', async (boundary) => {
  const store = openJournalStore(':memory:', true)
  stores.push(store)
  const repository = recordPublishedRefreshReview(store)
  const github = githubPublicationFixture({
    body: '',
    mode: 'idempotent',
    ...(boundary === 'idempotent' ? { labels: ['harlan-agent-ready'] } : {}),
    ...(boundary === 'kept' || boundary === 'idempotent' ? {} : { boundary }),
    change: () => store.setRepositoryPaused(repository.github, true),
  })
  const result = await refreshReviewGates({
    store,
    repositories: [repository],
    now: () => new Date('2026-08-27T08:23:00.000Z'),
    preflightRepair: () => Promise.resolve(ok(undefined)),
    github: {
      getPullRequestReviewSnapshot: () => Promise.resolve(snapshot([check()])),
      editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
      stampAgentLabel: github.source.stampAgentLabel,
    },
  }, new AbortController().signal)
  expect(result[0]?._tag).toBe(boundary === 'kept' || boundary === 'idempotent' ? 'Ok' : 'Err')
  const accepted = boundary === 'labels' || boundary === 'idempotent'
    ? []
    : boundary === 'create label'
      ? ['create label']
      : boundary === 'add label'
        ? ['create label', 'add label']
        : boundary === 'remove label'
          ? ['create label', 'add label', 'remove label']
          : ['create label', 'add label', 'remove label', 'remove label']
  expect(github.writes).toEqual(accepted)
})
