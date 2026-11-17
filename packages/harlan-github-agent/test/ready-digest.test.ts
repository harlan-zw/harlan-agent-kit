import type { Trial } from '../src/trials.ts'
import type { ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { collectReadyDigest } from '../src/ready-digest.ts'
import { ok } from '../src/result.ts'
import { createRoutineScanWorker } from '../src/routine-worker.ts'
import { getRoutine } from '../src/routines/index.ts'
import { openJournalStore } from '../src/store.ts'
import { collectTrialReportEvidence } from '../src/trial-report.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

type Store = ReturnType<typeof openJournalStore>

const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

const kit = 'harlan-zw/harlan-agent-kit'

function createStore(repositories: string[]): Store {
  const store = openJournalStore(':memory:')
  stores.push(store)
  store.syncRepositories(repositories.map(github => repositoryMapping({ github })), '2026-11-01T00:00:00.000Z')
  return store
}

function gates(state?: { failed?: keyof ReviewGates, pending?: keyof ReviewGates }): ReviewGates {
  const passed = { _tag: 'Passed' as const, evidence: [{ label: 'fixture', sha256: 'e'.repeat(64) }] }
  const all: ReviewGates = { merge: passed, review: passed, ci: passed }
  if (state?.failed !== undefined)
    return { ...all, [state.failed]: { _tag: 'Failed', reason: 'Fixture failure.', evidence: [] } }
  if (state?.pending !== undefined)
    return { ...all, [state.pending]: { _tag: 'Pending', reason: 'Fixture wait.', evidence: [] } }
  return all
}

interface PullRequestSeed {
  repository: string
  number: number
  title?: string
  draft?: boolean
  /** Each Review run on the pull request, in order. A run may name its own head. */
  reviews: Array<{ at: string, headSha?: string, failed?: keyof ReviewGates, pending?: keyof ReviewGates }>
  /** The head the pull request ends on, when it moved after the last Review. */
  headSha?: string
  closedAt?: string
  mergedAt?: string
}

/** Records a pull request, its Review runs through the real store, and how it ended. */
function seedPullRequest(store: Store, seed: PullRequestSeed): void {
  const subject = (headSha: string, observedAt: string) => pullRequestItem({
    repository: seed.repository,
    number: seed.number,
    title: seed.title ?? `Change ${seed.number}`,
    url: `https://github.com/${seed.repository}/pull/${seed.number}`,
    headSha,
    draft: seed.draft ?? false,
    mergeState: 'clean',
    updatedAt: observedAt,
  })
  for (const [index, review] of seed.reviews.entries()) {
    const headSha = review.headSha ?? 'head-1'
    const observed = store.recordObservation({
      externalId: `${seed.repository}#${seed.number}:${index}`,
      observedAt: review.at,
      source: 'poll',
      subject: subject(headSha, review.at),
    })
    const revisionId = observed._tag === 'Inserted' || observed._tag === 'Duplicate' ? observed.revisionId : null
    if (revisionId === null)
      throw new Error(`Expected an observation of ${seed.repository}#${seed.number}: ${JSON.stringify(observed)}`)
    const recorded = store.recordReviewRun({
      id: `review-${seed.repository}-${seed.number}-${index}`,
      repository: seed.repository,
      pullRequestNumber: seed.number,
      revisionId,
      headSha,
      provider: 'codex',
      sessionId: `session-${seed.number}-${index}`,
      model: 'gpt-5.6-sol',
      agentVersion: '1.0.0',
      skillDigest: 'f'.repeat(64),
      startedAt: review.at,
      completedAt: review.at,
      gates: gates(review),
      confidence: 90,
      findings: [],
    })
    if (recorded._tag !== 'Inserted')
      throw new Error(`Expected Review run ${index} of ${seed.repository}#${seed.number}: ${JSON.stringify(recorded)}`)
  }
  const lastReview = seed.reviews.at(-1)!
  const finalHead = seed.headSha ?? lastReview.headSha ?? 'head-1'
  const endedAt = seed.mergedAt ?? seed.closedAt
  if (seed.headSha !== undefined || endedAt !== undefined) {
    const at = endedAt ?? new Date(Date.parse(lastReview.at) + 60_000).toISOString()
    store.recordObservation({
      externalId: `${seed.repository}#${seed.number}:end`,
      observedAt: at,
      source: 'poll',
      subject: {
        ...subject(finalHead, at),
        ...(endedAt === undefined ? {} : { state: 'closed' as const, mergedAt: seed.mergedAt ?? null }),
      },
    })
  }
}

describe('ready pull requests', () => {
  it('lists open pull requests whose current head is READY with passing CI, oldest READY first', () => {
    const store = createStore(['harlan-zw/example', 'harlan-zw/private-site'])
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 1, reviews: [{ at: '2026-11-10T00:00:00.000Z' }, { at: '2026-11-12T00:00:00.000Z' }] })
    seedPullRequest(store, { repository: 'harlan-zw/private-site', number: 2, reviews: [{ at: '2026-11-03T00:00:00.000Z' }] })
    // CI was pending, then a later Review on the same head passed.
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 3, reviews: [{ at: '2026-11-01T00:00:00.000Z', pending: 'ci' }, { at: '2026-11-14T00:00:00.000Z' }] })

    expect(store.listReadyPullRequests()).toEqual([
      { repository: 'harlan-zw/private-site', pullRequestNumber: 2, title: 'Change 2', readyAt: '2026-11-03T00:00:00.000Z' },
      { repository: 'harlan-zw/example', pullRequestNumber: 1, title: 'Change 1', readyAt: '2026-11-10T00:00:00.000Z' },
      { repository: 'harlan-zw/example', pullRequestNumber: 3, title: 'Change 3', readyAt: '2026-11-14T00:00:00.000Z' },
    ])
  })

  it('leaves out a moved head, a later Blocked Review, pending CI, drafts, and closed pull requests', () => {
    const store = createStore(['harlan-zw/example'])
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 10, reviews: [{ at: '2026-11-10T00:00:00.000Z' }], headSha: 'head-2' })
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 11, reviews: [{ at: '2026-11-10T00:00:00.000Z' }, { at: '2026-11-11T00:00:00.000Z', failed: 'review' }] })
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 12, reviews: [{ at: '2026-11-10T00:00:00.000Z', pending: 'ci' }] })
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 13, draft: true, reviews: [{ at: '2026-11-10T00:00:00.000Z' }] })
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 14, reviews: [{ at: '2026-11-10T00:00:00.000Z' }], closedAt: '2026-11-11T00:00:00.000Z' })
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 15, reviews: [{ at: '2026-11-10T00:00:00.000Z' }], mergedAt: '2026-11-11T00:00:00.000Z' })

    expect(store.listReadyPullRequests()).toEqual([])
  })
})

describe('ready-digest', () => {
  const now = new Date('2026-11-23T19:30:00.000Z')

  it('writes one line per pull request and shows a title only for a public repository', () => {
    const store = createStore(['harlan-zw/example', 'harlan-zw/private-site'])
    seedPullRequest(store, { repository: 'harlan-zw/private-site', number: 2, title: 'Secret launch plan', reviews: [{ at: '2026-11-03T00:00:00.000Z' }] })
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 1, title: 'fix: mention @someone in `code` and #4', reviews: [{ at: '2026-11-22T00:00:00.000Z' }] })

    const digest = collectReadyDigest(store, { now, publicRepositories: new Set(['harlan-zw/example']) })

    expect(digest.pullRequests).toEqual([
      { pullRequest: 'harlan-zw/private-site#2', title: null, daysSinceReady: 20 },
      { pullRequest: 'harlan-zw/example#1', title: 'fix: mention @someone in \'code\' and #4', daysSinceReady: 1 },
    ])
    expect(digest.markdown).toContain('2 pull requests are READY with passing CI')
    expect(digest.markdown).toContain('- `harlan-zw/private-site#2`: 20 days since READY')
    expect(digest.markdown).toContain('- `harlan-zw/example#1` `fix: mention @someone in \'code\' and #4`: 1 day since READY')
    expect(digest.markdown).not.toContain('Secret launch plan')
  })

  it('hides every title when no repository is known to be public', () => {
    const store = createStore(['harlan-zw/example'])
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 1, title: 'Unreleased feature', reviews: [{ at: '2026-11-22T00:00:00.000Z' }] })

    expect(collectReadyDigest(store, { now, publicRepositories: new Set() }).markdown).not.toContain('Unreleased feature')
  })

  it('says so when nothing waits, and counts the lines past the limit', () => {
    const store = createStore(['harlan-zw/example'])
    expect(collectReadyDigest(store, { now, publicRepositories: new Set() }).markdown).toBe('No pull request is READY with passing CI.')

    for (const number of [1, 2, 3])
      seedPullRequest(store, { repository: 'harlan-zw/example', number, reviews: [{ at: `2026-11-1${number}T00:00:00.000Z` }] })
    const digest = collectReadyDigest(store, { now, publicRepositories: new Set(), limit: 2 })
    expect(digest.pullRequests.map(line => line.pullRequest)).toEqual(['harlan-zw/example#1', 'harlan-zw/example#2'])
    expect(digest.markdown).toContain('1 more pull request not listed.')
  })

  it('posts the list to the run log without an Agent turn', async () => {
    const store = createStore([kit, 'harlan-zw/example', 'harlan-zw/private-site'])
    store.setRepositoryWritesEnabled(kit, true)
    seedPullRequest(store, { repository: 'harlan-zw/private-site', number: 2, title: 'Secret launch plan', reviews: [{ at: '2026-11-03T00:00:00.000Z' }] })
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 1, title: 'fix: keep the head', reviews: [{ at: '2026-11-22T00:00:00.000Z' }] })
    store.syncRoutines({ repository: kit, specSha: 'abc123', entries: [{ name: 'ready-digest', crons: ['30 6 * * 1'], timeZone: 'Australia/Melbourne', mode: 'report', enabled: true }], at: now.toISOString() })
    store.openRoutineRun({ routineId: `${kit}:ready-digest`, scheduledFor: now.toISOString(), specSha: 'abc123', at: now.toISOString() })
    const task = store.claimNextRoutineRun('worker-1', now.toISOString(), 60 * 60_000)
    if (task === null)
      throw new Error('Expected the ready-digest run.')
    const turns: string[] = []
    const worker = createRoutineScanWorker({
      github: { getIssue: async () => { throw new Error('ready-digest reads no issue.') } },
      serviceEvidence: store,
      publicRepositories: new Set(['harlan-zw/example']),
      logger: { error: () => undefined, info: () => undefined },
      now: () => now,
      runtime: () => ({ profile: CODEX_AGENT_PROFILE, provider: { name: 'codex', runTurn: (request) => {
        turns.push(request.prompt)
        throw new Error('The ready-digest Routine must not start an Agent turn.')
      } } }),
      store,
      workspaces: { prepareRoutine: async () => ok({ path: '/tmp/routine', baseSha: 'abc123', headSha: 'abc123', defaultBranchSha: 'abc123' }) },
    })

    const result = await worker.run(task, new AbortController().signal)

    expect(result).toEqual(ok({ evidence: 'ready-digest on harlan-zw/harlan-agent-kit | 2 pull requests READY with passing CI', usage: { _tag: 'Unavailable' } }))
    expect(turns).toEqual([])
    store.completeRoutineRun({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: now.toISOString(), evidence: result._tag === 'Ok' ? result.value.evidence : '' })
    const body = store.claimNextRoutineReport('controller-1', now.toISOString(), 60_000)?.body
    expect(body).toContain('- `harlan-zw/private-site#2`: 20 days since READY')
    expect(body).toContain('- `harlan-zw/example#1` `fix: keep the head`: 1 day since READY')
    expect(body).not.toContain('Secret launch plan')
    expect(store.listCandidates(`${kit}:ready-digest`)).toEqual([])
  })

  it('runs only in the kit', () => {
    expect(getRoutine('ready-digest').prepare('harlan-zw/example', { listAgentFeedback: () => [], listImplicitSignals: () => [] })._tag).toBe('Err')
    expect(getRoutine('ready-digest').prepare(kit, { listAgentFeedback: () => [], listImplicitSignals: () => [] })._tag).toBe('Ok')
  })
})

describe('ready-digest trial', () => {
  const start = '2026-11-18T00:00:00.000Z'
  const readyTrial: Trial = {
    _tag: 'Measured',
    id: 'ready-digest',
    title: '6. Weekly ready-digest',
    start: { _tag: 'On', at: start },
    weeks: 4,
    metric: 'Fixture metric.',
    keepRule: 'Fixture keep rule.',
    killRule: 'Fixture kill rule.',
    before: 'Fixture before.',
    onMiss: { _tag: 'Kill' },
    measure: {
      _tag: 'ReadyWait',
      overdueDays: 3,
      baseline: { measuredAt: start, ready: 4, overdue: 2, oldestDays: 50 },
      minimumDrop: 0.5,
      readCheckWeek: 2,
    },
  }
  const now = new Date('2026-11-24T00:00:00.000Z')

  function seed(): Store {
    const store = createStore(['harlan-zw/example'])
    const ready = (number: number, at: string, ended?: { mergedAt?: string, closedAt?: string }) =>
      seedPullRequest(store, { repository: 'harlan-zw/example', number, reviews: [{ at }], ...ended })
    // READY 4 days before the reading: overdue.
    ready(1, '2026-11-20T00:00:00.000Z')
    // READY 2 days before the reading: not yet.
    ready(2, '2026-11-22T00:00:00.000Z')
    // READY long ago, then merged or closed: never part of it.
    ready(3, '2026-11-01T00:00:00.000Z', { mergedAt: '2026-11-21T00:00:00.000Z' })
    ready(4, '2026-11-01T00:00:00.000Z', { closedAt: '2026-11-21T00:00:00.000Z' })
    return store
  }

  it('counts open pull requests READY with passing CI for over 3 days, and the oldest one\'s age', () => {
    const [reading] = collectTrialReportEvidence(seed(), now, [readyTrial]).trials
    if (reading?._tag !== 'Measured' || reading.metrics?._tag !== 'ReadyWait')
      throw new Error('Expected a measured ready-digest trial.')

    expect(reading.metrics.current).toEqual({ ready: 2, overdue: 1, oldestDays: 4 })
    expect(reading.metrics.baseline).toEqual({ measuredAt: start, ready: 4, overdue: 2, oldestDays: 50 })
    expect(reading.keep).toEqual([{ _tag: 'Met', detail: expect.stringContaining('50% fewer') }])
    expect(reading.kill).toEqual([{ _tag: 'NotYetMeasurable', detail: expect.stringContaining('week 2') }])
    expect(reading.markdown).toContain('| READY with passing CI for over 3 days | 1 | 2 |')
    expect(reading.markdown).toContain('| Oldest of those, days since READY | 4 | 50 |')
  })

  it('reads nothing overdue when every READY head is younger than 3 days', () => {
    const store = createStore(['harlan-zw/example'])
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 2, reviews: [{ at: '2026-11-22T00:00:00.000Z' }] })

    const [reading] = collectTrialReportEvidence(store, now, [readyTrial]).trials
    if (reading?._tag !== 'Measured' || reading.metrics?._tag !== 'ReadyWait')
      throw new Error('Expected a measured ready-digest trial.')
    expect(reading.metrics.current).toEqual({ ready: 1, overdue: 0, oldestDays: null })
    expect(reading.markdown).toContain('| Oldest of those, days since READY | n/a | 50 |')
  })

  it('kills nothing by itself, and asks Harlan from week 2 whether he still reads it', () => {
    const [reading] = collectTrialReportEvidence(seed(), new Date('2026-11-26T00:00:00.000Z'), [readyTrial]).trials
    if (reading?._tag !== 'Measured')
      throw new Error('Expected a measured ready-digest trial.')

    expect(reading.kill).toEqual([{ _tag: 'OwnerCheck', detail: expect.stringContaining('still read') }])
    expect(reading.suggestion.verdict).toBe('Continue')
  })

  it('kills an ended trial whose overdue count did not fall by half', () => {
    const store = seed()
    seedPullRequest(store, { repository: 'harlan-zw/example', number: 5, reviews: [{ at: '2026-11-25T00:00:00.000Z' }] })

    const [reading] = collectTrialReportEvidence(store, new Date('2026-12-20T00:00:00.000Z'), [readyTrial]).trials
    if (reading?._tag !== 'Measured')
      throw new Error('Expected a measured ready-digest trial.')
    expect(reading.state._tag).toBe('Ended')
    expect(reading.keep).toEqual([{ _tag: 'NotMet', detail: expect.stringContaining('3 pull requests') }])
    expect(reading.suggestion.verdict).toBe('Kill')
  })
})
