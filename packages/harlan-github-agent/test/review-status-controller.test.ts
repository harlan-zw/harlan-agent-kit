import type { ReviewCheckRunOutcome, ReviewCheckRunUpdate } from '../src/review-check-run.ts'
import type { ClaimedReviewFixTask } from '../src/types.ts'
import { describe, expect, it, vi } from 'vitest'
import { agentPhase } from '../src/agent-progress.ts'
import { err, ok } from '../src/result.ts'
import { createReviewStatusController } from '../src/review-status-controller.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

describe('review status controller', () => {
  function harness(commentControls = false) {
    const repository = repositoryMapping()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task',
      kind: 'review_fix',
      repository: repository.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repository,
      pullRequest,
      rounds: { number: 1, limit: 3, prior: [] },
    }
    let replaced = false
    let body = ''
    let stagedBody = ''
    const controller = createReviewStatusController({
      commentControls,
      github: {
        readExistingReviewLabel: () => { throw new Error('Unexpected existing review.') },
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
        upsertReviewStatus: (_repository, _number, _commentId, value, replacePriorReview) => {
          body = value
          replaced = replacePriorReview
          return Promise.resolve(ok({ commentId: 29, url: pullRequest.url }))
        },
        stampAgentLabel: () => Promise.resolve(ok(undefined)),
      },
      leaseMilliseconds: 60_000,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        authorizeReviewStatus: () => true,
        stageReviewStatus: (input) => {
          stagedBody = input.body
          return { _tag: 'Staged', commandId: 'status-command' }
        },
        claimReviewStatus: () => ({
          id: 'status-command',
          taskKind: 'review_fix',
          taskId: task.id,
          repository: repository.github,
          pullRequestNumber: pullRequest.number,
          revisionId: task.revisionId,
          expectedHeadSha: pullRequest.headSha,
          expectedBaseRef: pullRequest.baseRef ?? null,
          phase: 'repair',
          body: stagedBody,
          reviewRunId: null,
          desiredOutcome: null,
          outcomeUnknown: false,
          commentId: null,
          workerId: 'status-worker',
          fence: 1,
          leaseExpiresAt: '2026-08-13T01:10:00.000Z',
          repositoryMapping: repository,
        }),
        completeReviewStatus: () => true,
        recordReviewStatusReceipt: () => true,
        deferReviewStatus: () => { throw new Error('Unexpected defer.') },
        supersedeReviewStatus: () => { throw new Error('Unexpected supersede.') },
      },
      workerId: 'status-worker',
    })

    return { controller, task, read: () => ({ body, replaced }) }
  }

  it('replaces the blocked review comment with repair progress', async () => {
    const { controller, task, read } = harness()

    expect(await controller.publishRepair(task, agentPhase('WorktreeReady', 'Git worktree ready'), new AbortController().signal)).toEqual(ok(undefined))

    expect(read().replaced).toBe(true)
    expect(read().body).toContain('### 🤖 REPAIR · round 1 of 3 · 35% · Git worktree ready')
  })

  it.each([false, true])('offers a checkbox only with webhook controls enabled: %s', async (enabled) => {
    const { controller, task, read } = harness(enabled)
    await controller.publishRepair(task, agentPhase('WorktreeReady', 'Reviewing'), new AbortController().signal)
    expect(read().body.includes('- [ ] Stop Review and any follow-up repair')).toBe(enabled)
  })

  it('says how long one phase has run, so a slow agent reads as alive', async () => {
    const { controller, task, read } = harness()

    // The clock reads 01:00, so this phase started 35 minutes ago.
    expect(await controller.publishRepair(
      task,
      { ...agentPhase('Editing', 'Editing files'), since: '2026-08-13T00:25:00.000Z' },
      new AbortController().signal,
    )).toEqual(ok(undefined))

    expect(read().body).toContain('### 🤖 REPAIR · round 1 of 3 · 65% · Editing files for 35 min')
  })

  it('leaves a phase that just started without a duration', async () => {
    const { controller, task, read } = harness()

    expect(await controller.publishRepair(
      task,
      { ...agentPhase('Editing', 'Editing files'), since: '2026-08-13T00:59:40.000Z' },
      new AbortController().signal,
    )).toEqual(ok(undefined))

    expect(read().body).toContain('### 🤖 REPAIR · round 1 of 3 · 65% · Editing files\n')
  })
})

describe('review status check run sink', () => {
  function harness(failing?: () => Promise<{ _tag: 'Ok', value: void } | { _tag: 'Err', error: string }>) {
    const repository = repositoryMapping()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task',
      kind: 'review_fix',
      repository: repository.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repository,
      pullRequest,
      rounds: { number: 1, limit: 3, prior: [] },
    }
    let stagedBody = ''
    const deferred: string[] = []
    const upsert = vi.fn((_repository: unknown, _headSha: string, _update: ReviewCheckRunUpdate, _signal: AbortSignal) =>
      failing === undefined ? Promise.resolve(ok(undefined)) : failing())
    const reports: ReviewCheckRunOutcome[] = []
    const checkRuns = {
      publisher: { upsertReviewCheckRun: (...args: Parameters<typeof upsert>) => upsert(...args) },
      report: (_repository: string, outcome: ReviewCheckRunOutcome) => reports.push(outcome),
    }
    const controller = createReviewStatusController({
      checkRuns,
      github: {
        readExistingReviewLabel: () => { throw new Error('Unexpected existing review.') },
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
        upsertReviewStatus: (_repository: unknown, _number: unknown, _commentId: unknown, _body: string) =>
          Promise.resolve(ok({ commentId: 29, url: pullRequest.url })),
        stampAgentLabel: () => Promise.resolve(ok(undefined)),
      },
      leaseMilliseconds: 60_000,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        authorizeReviewStatus: () => true,
        stageReviewStatus: (input: { body: string }) => {
          stagedBody = input.body
          return { _tag: 'Staged', commandId: 'status-command' }
        },
        claimReviewStatus: () => ({
          id: 'status-command',
          taskKind: 'review_fix',
          taskId: task.id,
          repository: repository.github,
          pullRequestNumber: pullRequest.number,
          revisionId: task.revisionId,
          expectedHeadSha: pullRequest.headSha,
          expectedBaseRef: pullRequest.baseRef ?? null,
          phase: 'repair',
          body: stagedBody,
          reviewRunId: null,
          desiredOutcome: null,
          outcomeUnknown: false,
          commentId: null,
          workerId: 'status-worker',
          fence: 1,
          leaseExpiresAt: '2026-08-13T01:10:00.000Z',
          repositoryMapping: repository,
        }),
        completeReviewStatus: () => true,
        recordReviewStatusReceipt: () => true,
        deferReviewStatus: (input: { reason: string }) => {
          deferred.push(input.reason)
          return true
        },
        supersedeReviewStatus: () => { throw new Error('Unexpected supersede.') },
      },
      workerId: 'status-worker',
    })

    return { controller, deferred, reports, upsert, task }
  }

  it('publishes the check run beside the comment, on the reviewed head', async () => {
    const { controller, deferred, task, upsert } = harness()

    expect(await controller.publishRepair(task, agentPhase('WorktreeReady', 'Git worktree ready'), new AbortController().signal)).toEqual(ok(undefined))

    expect(upsert).toHaveBeenCalledWith(
      repositoryMapping(),
      task.pullRequest.headSha,
      expect.objectContaining({ _tag: 'Running', title: '🤖 REPAIR · round 1 of 3 · 35% · Git worktree ready' }),
      expect.anything(),
      expect.anything(),
    )
    expect(deferred).toEqual([])
  })

  it('publishes and reports when the check run write fails', async () => {
    const { controller, deferred, reports, task } = harness(() => Promise.resolve(err('GitHub timed out.')))
    const result = await controller.publishRepair(task, agentPhase('WorktreeReady', 'Git worktree ready'), new AbortController().signal)

    expect(result).toEqual(ok(undefined))
    expect(deferred).toEqual([])
    expect(reports).toEqual([{ _tag: 'Failed', message: 'GitHub timed out.' }])
  })
})
