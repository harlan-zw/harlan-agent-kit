import type { ClaimedReviewFixTask, ReviewFinding } from '../src/types.ts'
import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { err, ok } from '../src/result.ts'
import { createReviewFixWorker } from '../src/review-fix-worker.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

describe('review fix Worker', () => {
  it('starts a fresh Repair Agent with the exact stored findings', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const mapping = repositoryMapping({ ownership: 'maintained' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
    }
    const findings: ReviewFinding[] = [{
      _tag: 'Open',
      summary: 'The parser drops buffered bytes.',
      nextAction: 'Preserve all buffered bytes.',
      details: {
        fingerprint: 'f'.repeat(64),
        location: { path: 'src/parser.ts', line: 42 },
        proof: 'A split UTF-8 sequence loses its first byte.',
        regressionTest: 'Split one UTF-8 sequence across two chunks and assert the original string.',
      },
    }]
    const capture: ProviderCapture = { requests: [] }
    let committedMessage = ''

    const result = await createReviewFixWorker({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          requiredChecks: { _tag: 'None' },
          reviews: [],
        })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'repaired',
        summary: 'Preserved buffered bytes.',
        checks: ['pnpm vitest run test/parser.test.ts'],
        commitMessage: 'fix(parser): preserve buffered bytes',
      }), capture)),
      status: { publishRepair: () => Promise.resolve(ok(undefined)) },
      store: {
        getReviewFixFindings: () => findings,
        getWorkerSession: () => 'review-session-must-not-resume',
        requestReviewRerun: () => { throw new Error('A successful Repair must not queue another Review.') },
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(mapping)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/repair-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 2 })),
        commit: (_task, _workspace, _patch, message) => {
          committedMessage = message
          return Promise.resolve(ok({
            commitSha: 'repair-commit',
            baseSha: pullRequest.baseSha,
            artifactRef: 'artifact-ref',
            digest: 'patch-digest',
            changedFiles: 2,
          }))
        },
      },
    }).run(task, new AbortController().signal)

    expect(result).toEqual(ok({
      _tag: 'Publish',
      publication: expect.objectContaining({ taskKind: 'review_fix', expectedHeadSha: pullRequest.headSha }),
    }))
    expect(committedMessage).toBe('fix(parser): preserve buffered bytes')
    expect(capture.requests).toEqual([expect.objectContaining({
      sessionId: null,
      model: 'gpt-5.6-terra',
      prompt: expect.stringContaining('Split one UTF-8 sequence across two chunks'),
    })])
  })

  it('queues one fresh Review when Repair disproves a finding', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const mapping = repositoryMapping({ ownership: 'maintained' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task-disputed',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
    }
    const findings: ReviewFinding[] = [{
      _tag: 'Open',
      summary: 'The history query has no limit.',
      nextAction: 'Limit the history query.',
      details: {
        fingerprint: 'f'.repeat(64),
        location: { path: 'src/store.ts', line: 42 },
        proof: 'The false branch omits LIMIT 100.',
        regressionTest: 'Seed old history and assert only 100 rows are read.',
      },
    }]
    const reruns: unknown[] = []

    const result = await createReviewFixWorker({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          requiredChecks: { _tag: 'None' },
          reviews: [],
        })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'disputed',
        summary: 'The false branch already adds LIMIT 100.',
        checks: ['pnpm vitest run test/dashboard-history-limit.test.ts'],
        commitMessage: '',
      }))),
      status: { publishRepair: () => Promise.resolve(ok(undefined)) },
      store: {
        getReviewFixFindings: () => findings,
        getWorkerSession: () => null,
        requestReviewRerun: (input) => {
          reruns.push(input)
          return { _tag: 'Queued', taskId: 'review-task' }
        },
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(mapping)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/repair-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
        verify: () => { throw new Error('A disputed finding must not produce a patch.') },
        commit: () => { throw new Error('A disputed finding must not produce a commit.') },
      },
    }).run(task, new AbortController().signal)

    expect(result).toEqual(ok({
      _tag: 'ActionRequired',
      reason: 'Repair disputed the finding. One fresh Review was queued: The false branch already adds LIMIT 100.',
      evidence: JSON.stringify({ findings, checks: ['pnpm vitest run test/dashboard-history-limit.test.ts'] }),
    }))
    expect(reruns).toEqual([{
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: task.revisionId,
      requestId: expect.stringMatching(/^repair-dispute:repair-task-disputed:[0-9a-f]{64}$/),
      source: 'repair_dispute',
      requestedBy: 'review_fix',
      at: '2026-08-13T01:00:00.000Z',
    }])
  })

  it('gives each distinct dispute set its own rerun request', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const mapping = repositoryMapping({ ownership: 'maintained' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task-disputed',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
    }
    const openFinding = (fingerprint: string): ReviewFinding => ({
      _tag: 'Open',
      summary: `Finding ${fingerprint.slice(0, 4)}.`,
      nextAction: 'Fix it.',
      details: {
        fingerprint,
        location: { path: 'src/store.ts', line: 42 },
        proof: 'The false branch omits LIMIT 100.',
        regressionTest: null,
      },
    })
    const snapshot = () => Promise.resolve(ok({
      baseChecks: { _tag: 'Available' as const, checks: [] },
      body: '',
      checks: { _tag: 'Available' as const, checks: [] },
      comments: [],
      priorAutomatedReview: { _tag: 'None' } as const,
      pullRequest,
      requiredChecks: { _tag: 'None' } as const,
      reviews: [],
    }))
    const run = async (findings: ReviewFinding[]) => {
      const reruns: string[] = []
      await createReviewFixWorker({
        github: { getPullRequestReviewSnapshot: snapshot },
        now: () => new Date('2026-08-13T01:00:00.000Z'),
        runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
          outcome: 'disputed',
          summary: 'The false branch already adds LIMIT 100.',
          checks: [],
          commitMessage: '',
        }))),
        status: { publishRepair: () => Promise.resolve(ok(undefined)) },
        store: {
          getReviewFixFindings: () => findings,
          getWorkerSession: () => null,
          requestReviewRerun: (input) => {
            reruns.push(input.requestId)
            return { _tag: 'Queued', taskId: 'review-task' }
          },
          saveWorkerSession: () => undefined,
          updateAgentProgress: () => true,
        },
        validateMapping: () => Promise.resolve(ok(mapping)),
        worktrees: {
          prepare: () => Promise.resolve(ok({ path: '/tmp/repair-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
          verify: () => { throw new Error('A disputed finding must not produce a patch.') },
          commit: () => { throw new Error('A disputed finding must not produce a commit.') },
        },
      }).run(task, new AbortController().signal)
      return reruns
    }

    const firstDispute = await run([openFinding('a'.repeat(64))])
    const repeatedDispute = await run([openFinding('a'.repeat(64))])
    const secondDispute = await run([openFinding('b'.repeat(64))])

    expect(firstDispute[0]).toMatch(/^repair-dispute:repair-task-disputed:[0-9a-f]{64}$/)
    expect(secondDispute[0]).not.toBe(firstDispute[0])
    expect(repeatedDispute[0]).toBe(firstDispute[0])
  })

  it('routes a capped second disagreement to action without another Review', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const mapping = repositoryMapping({ ownership: 'maintained' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task-dispute-capped',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
    }
    const findings: ReviewFinding[] = [{
      _tag: 'Open',
      summary: 'The history query has no limit.',
      nextAction: 'Limit the history query.',
      details: {
        fingerprint: 'b'.repeat(64),
        location: { path: 'src/store.ts', line: 42 },
        proof: 'The false branch omits LIMIT 100.',
        regressionTest: null,
      },
    }]

    const result = await createReviewFixWorker({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          requiredChecks: { _tag: 'None' },
          reviews: [],
        })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'disputed',
        summary: 'The false branch already adds LIMIT 100.',
        checks: [],
        commitMessage: '',
      }))),
      status: { publishRepair: () => Promise.resolve(ok(undefined)) },
      store: {
        getReviewFixFindings: () => findings,
        getWorkerSession: () => null,
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'DisputeCapReached' } }),
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(mapping)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/repair-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
        verify: () => { throw new Error('A disputed finding must not produce a patch.') },
        commit: () => { throw new Error('A disputed finding must not produce a commit.') },
      },
    }).run(task, new AbortController().signal)

    expect(result).toEqual(ok({
      _tag: 'ActionRequired',
      reason: 'Repair and the fresh Review still disagree: The false branch already adds LIMIT 100.',
      evidence: JSON.stringify({ findings, checks: [] }),
    }))
  })

  it('rejects a blocked result with an empty summary', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const mapping = repositoryMapping({ ownership: 'maintained' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task-empty-summary',
      kind: 'review_fix',
      repository: mapping.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest,
    }
    const findings: ReviewFinding[] = [{
      _tag: 'Open',
      summary: 'The parser drops buffered bytes.',
      nextAction: 'Preserve all buffered bytes.',
      details: {
        fingerprint: 'f'.repeat(64),
        location: { path: 'src/parser.ts', line: 42 },
        proof: 'A split UTF-8 sequence loses its first byte.',
        regressionTest: 'Split one UTF-8 sequence across two chunks and assert the original string.',
      },
    }]
    const capture: ProviderCapture = { requests: [] }

    const result = await createReviewFixWorker({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          requiredChecks: { _tag: 'None' },
          reviews: [],
        })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        outcome: 'blocked',
        summary: '',
        checks: [],
        commitMessage: '',
      }), capture)),
      status: { publishRepair: () => Promise.resolve(ok(undefined)) },
      store: {
        getReviewFixFindings: () => findings,
        getWorkerSession: () => null,
        requestReviewRerun: () => { throw new Error('An invalid result must not queue another Review.') },
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
      },
      validateMapping: () => Promise.resolve(ok(mapping)),
      worktrees: {
        prepare: () => Promise.resolve(ok({ path: '/tmp/repair-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 2 })),
        commit: () => Promise.resolve(ok({
          commitSha: 'repair-commit',
          baseSha: pullRequest.baseSha,
          artifactRef: 'artifact-ref',
          digest: 'patch-digest',
          changedFiles: 2,
        })),
      },
    }).run(task, new AbortController().signal)

    expect(result).toEqual(err('The Agent returned an invalid Repair result.'))
    expect(capture.requests).toHaveLength(2)
    expect(capture.requests[1]?.prompt).toContain('schema')
  })
})
