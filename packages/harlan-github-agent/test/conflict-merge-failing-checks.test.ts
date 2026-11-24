import type { GitHubCheck, PullRequestReviewSnapshot } from '../src/github-agent-source.ts'
import type { GitHubPullRequestItem } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createAutoMergeController } from '../src/auto-merge-controller.ts'
import { autoMergeDecision } from '../src/auto-merge.ts'
import { createConflictWorker } from '../src/conflict-worker.ts'
import { terminalComment } from '../src/item-agent.ts'
import { ok } from '../src/result.ts'
import { refreshReviewGates } from '../src/review-gate-sweep.ts'
import { openJournalStore } from '../src/store.ts'
import { runClaimedTask } from '../src/task-scheduler.ts'
import { agentRuntime, changedLinesSource, headChangedFiles, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

const at = (minutes: number) => new Date(Date.parse('2026-11-20T08:00:00.000Z') + minutes * 60_000).toISOString()
const renderCheck = 'pnpm vitest run test/render.test.ts'
const failingSentence = `Conflict resolution pushed this merge of \`main\` with \`${renderCheck}\` failing; Repair follows when CI fails.`

const agentAnswer = {
  outcome: 'resolved_with_failures',
  summary: 'Merged. A test outside the merge still imports the removed helper.',
  checks: [
    { command: 'pnpm vitest run test/parser.test.ts', outcome: 'passed', details: 'Passed.' },
    { command: renderCheck, outcome: 'failed', details: 'test/render.test.ts imports a removed export.' },
  ],
  commitMessage: 'merge: reconcile the parser with main',
  unavailableCheck: { command: '', error: '' },
  failures: [{ command: renderCheck, paths: ['test/render.test.ts'] }],
}

function check(name: string, conclusion: 'success' | 'failure'): GitHubCheck {
  return { id: 1, name, status: 'completed', conclusion, source: { _tag: 'CheckRun', appId: 1 }, failure: { _tag: 'Unknown', reason: 'The job steps were not read.' } }
}

function reviewSnapshot(pullRequest: GitHubPullRequestItem, testConclusion: 'success' | 'failure'): PullRequestReviewSnapshot {
  return {
    baseChecks: { _tag: 'Available', checks: [check('test', 'success')] },
    body: '',
    checks: { _tag: 'Available', checks: [check('test', testConclusion)] },
    comments: [],
    findingDiscussions: [],
    priorAutomatedReview: { _tag: 'None' },
    pullRequest,
    requiredChecks: { _tag: 'Declared', contexts: ['test'] },
    reviews: [],
  }
}

/**
 * Runs the conflict Agent's answer through the real store, publishes its
 * merge, and settles a Review of the pushed head while CI still runs.
 */
async function pushedMergeUnderReview() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  const mapping = repositoryMapping()
  store.syncRepositories([mapping], at(0))
  store.setRepositoryWritesEnabled(mapping.github, true)
  const conflicting = pullRequestItem({ headSha: 'head-before-merge', baseSha: 'base-1', mergeState: 'conflicting', updatedAt: at(1) })
  if (store.recordObservation({ externalId: 'conflicting', observedAt: at(1), source: 'poll', subject: conflicting })._tag !== 'Inserted')
    throw new Error('Expected the conflicting pull request.')
  const task = store.claimNextConflictTask('conflict-agent', at(2), 600_000)
  if (task === null)
    throw new Error('Expected the conflict Task.')

  const worker = createConflictWorker({
    github: { getPullRequest: () => Promise.resolve(ok(conflicting)), isBranchProtected: () => Promise.resolve(ok(false)) },
    now: () => new Date(at(3)),
    runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(agentAnswer))),
    store,
    validateMapping: validated => Promise.resolve(ok(validated)),
    worktrees: {
      prepare: () => Promise.resolve(ok({ _tag: 'Conflicted' as const, worktree: { path: '/tmp/worktree', headSha: 'head-before-merge', baseSha: 'base-1', conflictedFiles: ['src/parser.ts'], writablePaths: ['src/parser.ts'] } })),
      verify: () => Promise.resolve(ok({ digest: 'digest', changedFiles: 1 })),
      commit: () => Promise.resolve(ok({ commitSha: 'merge-commit', baseSha: 'base-1', artifactRef: 'refs/harlan-github-agent/publications/merge', digest: 'digest', changedFiles: 1 })),
    },
  })
  expect(await runClaimedTask(task, {
    leaseMilliseconds: 600_000,
    now: () => new Date(at(3)),
    onError: (error) => {
      throw error
    },
    store,
    worker,
    workerId: task.state.workerId,
  })).toEqual({ _tag: 'Publishing' })

  // The publisher pushes the merge commit through the usual conflict publication.
  const publication = store.claimNextPublication('publisher', at(4), 60_000)
  if (publication === null)
    throw new Error('Expected the conflict Publication.')
  expect(publication).toEqual(expect.objectContaining({ _tag: 'UpdatePullRequest', taskKind: 'resolve_conflict', commitSha: 'merge-commit' }))
  expect(store.completePublication({ commandId: publication.id, workerId: publication.workerId, fence: publication.fence, at: at(5), evidence: 'Published merge-commit.' })).toBe(true)

  const pushed = pullRequestItem({ headSha: 'merge-commit', baseSha: 'base-1', mergeState: 'clean', autoMerge: true, updatedAt: at(6) })
  const observed = store.recordObservation({ externalId: 'pushed', observedAt: at(6), source: 'poll', subject: pushed })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected the pushed head to start a new Revision.')

  const review = store.claimNextAdversarialReviewTask('reviewer', at(7), 600_000)
  if (review?.pullRequest.headSha !== 'merge-commit')
    throw new Error('Expected the Review of the pushed head.')
  store.completeWorkerTask({ taskId: review.id, workerId: review.state.workerId, fence: review.state.fence, at: at(8), evidence: 'review-of-merge' })
  const passed = (label: string) => ({ _tag: 'Passed' as const, evidence: [{ label, sha256: 'a'.repeat(64) }] })
  expect(store.recordReviewRun({
    id: 'review-of-merge',
    repository: mapping.github,
    pullRequestNumber: pushed.number,
    revisionId: observed.revisionId,
    headSha: 'merge-commit',
    provider: 'codex',
    sessionId: 'review-session',
    model: 'gpt-5.6-sol',
    agentVersion: '0.0.0',
    skillDigest: 'c'.repeat(64),
    startedAt: at(7),
    completedAt: at(9),
    usage: { _tag: 'Unavailable' },
    gates: { merge: passed('mergeability'), review: passed('review'), ci: { _tag: 'Pending', reason: 'test is running.', evidence: [] } },
    confidence: 95,
    findings: [],
  })).toEqual({ _tag: 'Inserted', reviewRunId: 'review-of-merge' })
  expect(store.recordReviewPublication({
    id: 'review-of-merge-pending',
    reviewRunId: 'review-of-merge',
    body: '### 🤖 PENDING',
    at: at(10),
    result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
  })).toEqual({ _tag: 'Inserted', publicationId: 'review-of-merge-pending' })
  return { mapping, observed, pushed, store }
}

/** Settles the Review of the pushed head against one GitHub snapshot and publishes its comment. */
async function settleReview(setup: Awaited<ReturnType<typeof pushedMergeUnderReview>>, live: PullRequestReviewSnapshot) {
  const { mapping, store } = setup
  const results = await refreshReviewGates({
    preflightRepair: () => Promise.resolve(ok(undefined)),
    github: {
      getPullRequestReviewSnapshot: () => Promise.resolve(ok(live)),
      editReviewStatus: () => Promise.resolve(ok({ _tag: 'Changed' })),
      stampAgentLabel: () => Promise.resolve(ok(undefined)),
    },
    now: () => new Date(at(40)),
    repositories: [mapping],
    store,
  }, new AbortController().signal)
  const status = store.claimNextTerminalReviewStatus('status-publisher', at(41), 60_000)
  if (status === null)
    throw new Error('Expected the Review status.')
  expect(store.completeReviewStatus({
    commandId: status.id,
    workerId: status.workerId,
    fence: status.fence,
    at: at(42),
    commentId: 42,
    url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
  })).toBe(true)
  return { body: status.body, results }
}

describe('a conflict merge pushed with a failing check', () => {
  it('names the failing check on the pushed head and on no later head', async () => {
    const { mapping, pushed, store } = await pushedMergeUnderReview()

    expect(store.mergedWithFailingChecks(mapping.github, pushed.number, 'merge-commit')).toEqual({
      _tag: 'MergedWithFailingChecks',
      commitSha: 'merge-commit',
      baseRef: 'main',
      failures: [{ command: renderCheck, paths: ['test/render.test.ts'] }],
    })
    expect(store.mergedWithFailingChecks(mapping.github, pushed.number, 'repair-commit')).toBeNull()
  })

  it('reads BLOCKED, queues head CI Repair, and holds Auto merge while its check fails on GitHub', async () => {
    const setup = await pushedMergeUnderReview()
    const { mapping, pushed, store } = setup

    const { body, results } = await settleReview(setup, reviewSnapshot(pushed, 'failure'))

    expect(results).toEqual([ok(expect.objectContaining({ _tag: 'PublicationQueued', outcome: 'BLOCKED' }))])
    expect(body).toContain(failingSentence)
    expect(body).toContain('Required check "test" fails on the pull request head commit.')
    expect(body).toContain('Repair round 1 of 3 starts.')
    expect(autoMergeDecision({
      attempts: store.listReviewRuns(mapping.github, pushed.number),
      changedFiles: headChangedFiles(undefined, { baseSha: 'base-1', headSha: 'merge-commit' }),
      mergedWithFailingChecks: store.mergedWithFailingChecks(mapping.github, pushed.number, 'merge-commit'),
      policy: { _tag: 'Enabled', minimumConfidence: 80, method: 'squash' },
      pullRequest: pushed,
      repository: mapping,
    })).toEqual(expect.objectContaining({ _tag: 'Hold', cause: 'NoReadyReview' }))
  })

  it.each(['no checks', 'a passing check'] as const)('holds Auto merge on the pushed merge after a READY Review with %s, and merges the next head', async (checks) => {
    const setup = await pushedMergeUnderReview()
    const { mapping, pushed, store } = setup
    const live = reviewSnapshot(pushed, 'success')
    if (checks === 'no checks') {
      live.checks = { _tag: 'Available', checks: [] }
      live.requiredChecks = { _tag: 'Declared', contexts: [] }
    }
    const { results } = await settleReview(setup, live)
    expect(results).toEqual([ok(expect.objectContaining({ _tag: 'PublicationQueued', outcome: 'READY' }))])
    const merges: string[] = []
    const controller = createAutoMergeController({
      changedLines: changedLinesSource(),
      merger: {
        merge: async (request) => {
          merges.push(request.expectedHeadSha)
          return ok({ _tag: 'AutoMergeEnabled' })
        },
        retargetMergedParent: async () => ok(false),
      },
      now: () => new Date(at(43)),
      policy: { _tag: 'Enabled', minimumConfidence: 80, method: 'squash' },
      report: () => undefined,
      store,
    })

    await controller.reconcile(mapping, pushed, new AbortController().signal)

    expect(merges).toEqual([])
    expect(store.listTrialAutoMergeHolds({ from: at(0), to: at(60) }).holds).toEqual([
      expect.objectContaining({ headSha: 'merge-commit', cause: 'MergedWithFailingChecks', heldOnlyByLabel: false }),
    ])

    // The next head commit, such as a Repair push, needs only its own published READY Review.
    const repaired = { ...pushed, headSha: 'repair-commit', updatedAt: at(44) }
    const observation = store.recordObservation({ externalId: 'repaired', observedAt: at(44), source: 'poll', subject: repaired })
    if (observation._tag !== 'Inserted')
      throw new Error('Expected the repaired head Revision.')
    const prior = store.listReviewRuns(mapping.github, pushed.number)[0]!
    expect(store.recordReviewRun({ ...prior, id: 'review-of-repair', headSha: repaired.headSha, revisionId: observation.revisionId, startedAt: at(45), completedAt: at(46), confidence: 95 })).toEqual({ _tag: 'Inserted', reviewRunId: 'review-of-repair' })
    store.stageReviewGateStatus({ reviewRunId: 'review-of-repair', repository: mapping.github, pullRequestNumber: repaired.number, revisionId: observation.revisionId, expectedHeadSha: repaired.headSha, gates: prior.gates, body: 'READY', desiredOutcome: 'READY', at: at(47) })
    const repairedStatus = store.claimNextTerminalReviewStatus('status-publisher', at(48), 60_000)
    if (repairedStatus === null)
      throw new Error('Expected the repaired head Review status.')
    expect(store.completeReviewStatus({ commandId: repairedStatus.id, workerId: repairedStatus.workerId, fence: repairedStatus.fence, at: at(49), commentId: 42, url: repaired.url })).toBe(true)

    await controller.reconcile(mapping, repaired, new AbortController().signal)

    expect(merges).toEqual(['repair-commit'])
  })
})

describe('terminalComment for a conflict merge with failing checks', () => {
  const gates = {
    merge: { _tag: 'Passed' as const, evidence: [] },
    review: { _tag: 'Passed' as const, evidence: [] },
    ci: { _tag: 'Pending' as const, reason: 'test is running.', evidence: [] },
  }

  it('names at most three failing checks in one sentence', () => {
    const body = terminalComment({
      headSha: 'merge-commit',
      baseSha: 'base-1',
      gates,
      findings: [],
      confidence: undefined,
      reportedChecks: [],
      mergedWithFailingChecks: {
        _tag: 'MergedWithFailingChecks',
        commitSha: 'merge-commit',
        baseRef: 'feat/parent',
        failures: ['pnpm lint', 'pnpm typecheck', 'pnpm vitest run `a`', 'pnpm build'].map(command => ({ command, paths: ['src/a.ts'] })),
      },
    })

    expect(body).toContain('Conflict resolution pushed this merge of `feat/parent` with `pnpm lint`, `pnpm typecheck`, `pnpm vitest run a`, and 1 more failing; Repair follows when CI fails.')
  })

  it('says nothing about a merge for any other head', () => {
    const body = terminalComment({ headSha: 'merge-commit', baseSha: 'base-1', gates, findings: [], confidence: undefined, reportedChecks: [], mergedWithFailingChecks: null })

    expect(body).not.toContain('Conflict resolution')
  })
})
