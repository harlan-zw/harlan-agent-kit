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
