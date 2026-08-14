import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk'
import type { RecordReviewAttemptInput } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { createCodexIssueTriageWorker, createCodexReviewWorker, reviewSnapshotDigest } from '../src/subject-worker.ts'
import { issueSubject, pullRequestSubject, repositoryMapping } from './fixtures.ts'

function codexFactory(response: unknown, capture: { client?: CodexOptions, thread?: ThreadOptions }) {
  return (options: CodexOptions) => {
    capture.client = options
    const thread = {
      runStreamed: () => Promise.resolve({
        events: (async function* () {
          yield { type: 'thread.started' as const, thread_id: 'session-1' }
          yield { type: 'item.started' as const, item: { id: 'command-1', type: 'command_execution' as const, command: 'pnpm test', aggregated_output: '', status: 'in_progress' as const } }
          yield { type: 'item.completed' as const, item: { id: 'message-1', type: 'agent_message' as const, text: JSON.stringify(response) } }
          yield { type: 'turn.completed' as const, usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 1 } }
        })(),
      }),
    }
    return {
      startThread: (threadOptions: ThreadOptions) => {
        capture.thread = threadOptions
        return thread
      },
      resumeThread: () => thread,
    }
  }
}

describe('subject Workers', () => {
  it('keeps one review session when only GitHub activity time changes', () => {
    const pullRequest = pullRequestSubject({ mergeState: 'clean' })
    const snapshot = {
      baseChecks: { _tag: 'Available' as const, checks: [] },
      body: 'Fixes the bug.',
      checks: { _tag: 'Available' as const, checks: [] },
      comments: ['Human review comment.'],
      priorAutomatedReview: { _tag: 'None' as const },
      pullRequest,
      reviews: [],
    }

    expect(reviewSnapshotDigest({
      ...snapshot,
      pullRequest: { ...pullRequest, updatedAt: '2026-08-13T02:00:00.000Z' },
    })).toBe(reviewSnapshotDigest(snapshot))
    expect(reviewSnapshotDigest({ ...snapshot, comments: ['Different human review comment.'] })).not.toBe(reviewSnapshotDigest(snapshot))
  })

  it('records and publishes one isolated adversarial review', async () => {
    const pullRequest = pullRequestSubject({ mergeState: 'clean' })
    const capture: { client?: CodexOptions, thread?: ThreadOptions } = {}
    const comments: string[] = []
    let attempt: RecordReviewAttemptInput | undefined
    const worker = createCodexReviewWorker({
      createCodex: codexFactory({
        metadata: { state: 'passed', reason: '', evidence: 'metadata aligned' },
        review: { state: 'passed', reason: '', evidence: 'full diff reviewed' },
        verification: { state: 'passed', reason: '', evidence: 'focused tests passed' },
        findings: [],
        repair: { outcome: 'not_needed', summary: 'No repair needed.', checks: [], commitMessage: '' },
        confidence: 96,
      }, capture),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [{ id: 1, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }] },
          body: 'Fixes the bug.',
          checks: { _tag: 'Available', checks: [{ id: 1, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }] },
          comments: [],
          priorAutomatedReview: {
            _tag: 'Found',
            authorLogin: 'harlan-zw',
            state: 'complete',
            url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-40',
          },
          pullRequest,
          reviews: [],
        })),
        upsertIssueTriageComment: () => Promise.reject(new Error('Review must not post issue triage.')),
        upsertReviewStatus: () => Promise.reject(new Error('The Worker must use the status controller.')),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        claimReviewFixTaskForReview: () => { throw new Error('A clean review must not claim repair work.') },
        failTask: () => { throw new Error('A clean review must not fail repair work.') },
        getWorkerSession: () => null,
        queueBaselineRepairForReview: () => { throw new Error('Healthy base CI must not queue Baseline repair.') },
        saveWorkerSession: () => undefined,
        stagePublication: () => { throw new Error('A clean review must not stage a repair.') },
        updateAgentProgress: () => true,
        recordReviewAttempt: (input) => {
          attempt = input
          return { _tag: 'Inserted', attemptId: input.id }
        },
        recordReviewPublication: input => ({ _tag: 'Inserted', publicationId: input.id }),
      },
      status: {
        publish: (_task, _phase, body) => {
          comments.push(body)
          return Promise.resolve(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
        publishRepair: () => Promise.reject(new Error('A clean review must not publish repair progress.')),
      },
      triageStatus: { publish: () => Promise.reject(new Error('Review must not publish issue triage.')) },
      workspaces: {
        prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
        prepareReview: () => Promise.resolve(ok({ path: '/tmp/review-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
      },
      repairs: {
        commit: () => Promise.reject(new Error('A clean review must not commit a repair.')),
        verify: () => Promise.reject(new Error('A clean review must not verify a repair.')),
      },
    })

    const result = await worker.run({
      id: 'review-task',
      kind: 'adversarial_review',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repositoryMapping(),
      pullRequest,
      rerun: { _tag: 'Requested' },
    }, new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(comments).toHaveLength(6)
    expect(comments[0]).toContain('REVIEWING · Pull request loaded')
    expect(comments[2]).toContain('REVIEWING · Running tests and checks')
    expect(comments[2]).toContain('▓▓▓▓░ 70%')
    expect(comments[3]).toContain('REVIEWING · Preparing the review comment')
    expect(comments[5]).toContain('READY · 96/100')
    expect(comments[5]).toContain('▓▓▓▓▓ 100%')
    expect(attempt).toEqual(expect.objectContaining({ model: 'gpt-5.6-sol', confidence: 96 }))
    expect(capture.client).toEqual({})
    expect(capture.thread).toEqual(expect.objectContaining({ model: 'gpt-5.6-sol', modelReasoningEffort: 'high', webSearchMode: 'live' }))
  })

  it('does not start a second review for the same head commit', async () => {
    const pullRequest = pullRequestSubject({ mergeState: 'clean' })
    let codexStarted = false
    let workspaceCreated = false
    const worker = createCodexReviewWorker({
      createCodex: () => {
        codexStarted = true
        throw new Error('A second review must not start.')
      },
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [{ id: 1, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }] },
          body: 'Fixes the bug.',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: {
            _tag: 'Found',
            authorLogin: 'harlan-zw',
            state: 'complete',
            url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
          },
          pullRequest,
          reviews: [],
        })),
        upsertIssueTriageComment: () => Promise.reject(new Error('Review must not post issue triage.')),
        upsertReviewStatus: () => Promise.reject(new Error('A second comment must not be posted.')),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        claimReviewFixTaskForReview: () => { throw new Error('A second review must not claim repair work.') },
        failTask: () => { throw new Error('A second review must not fail repair work.') },
        getWorkerSession: () => null,
        queueBaselineRepairForReview: () => { throw new Error('A second review must not queue Baseline repair.') },
        saveWorkerSession: () => undefined,
        stagePublication: () => { throw new Error('A second review must not stage a repair.') },
        updateAgentProgress: () => true,
        recordReviewAttempt: () => { throw new Error('A second review must not be recorded.') },
        recordReviewPublication: () => { throw new Error('A second comment must not be recorded.') },
      },
      status: {
        publish: () => Promise.reject(new Error('A second comment must not be posted.')),
        publishRepair: () => Promise.reject(new Error('A second comment must not be posted.')),
      },
      triageStatus: { publish: () => Promise.reject(new Error('Review must not publish issue triage.')) },
      workspaces: {
        prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
        prepareReview: () => {
          workspaceCreated = true
          return Promise.reject(new Error('A second Git worktree must not be created.'))
        },
      },
      repairs: {
        commit: () => Promise.reject(new Error('A second review must not commit a repair.')),
        verify: () => Promise.reject(new Error('A second review must not verify a repair.')),
      },
    })

    const result = await worker.run({
      id: 'review-task',
      kind: 'adversarial_review',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repositoryMapping(),
      pullRequest,
      rerun: { _tag: 'NotRequested' },
    }, new AbortController().signal)

    expect(result).toEqual({
      _tag: 'Ok',
      value: { evidence: 'Existing automated review by @harlan-zw: https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
    })
    expect(codexStarted).toBe(false)
    expect(workspaceCreated).toBe(false)
  })

  it('repairs findings during the review turn and stages their publication', async () => {
    const repository = repositoryMapping()
    const pullRequest = pullRequestSubject({ mergeState: 'clean' })
    let attempt: RecordReviewAttemptInput | undefined
    let claimed = false
    let staged = false
    const repairTask = {
      id: 'repair-task',
      kind: 'review_fix' as const,
      repository: repository.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running' as const, workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repository,
      pullRequest,
      findings: [{ _tag: 'Open' as const, summary: 'The parser drops data.', nextAction: 'Preserve the buffered bytes.' }],
    }
    const worker = createCodexReviewWorker({
      createCodex: codexFactory({
        metadata: { state: 'passed', reason: '', evidence: 'metadata aligned' },
        review: { state: 'failed', reason: 'The parser drops data.', evidence: 'focused reproduction failed before repair' },
        verification: { state: 'passed', reason: '', evidence: 'regression passes after repair' },
        findings: [{ summary: 'The parser drops data.', nextAction: 'Preserve the buffered bytes.' }],
        repair: { outcome: 'repaired', summary: 'Preserved buffered bytes.', checks: ['pnpm vitest run test/parser.test.ts'], commitMessage: 'fix(core): preserve buffered parser bytes' },
        confidence: null,
      }, {}),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [{ id: 1, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }] },
          body: 'Fixes the parser.',
          checks: { _tag: 'Available', checks: [{ id: 1, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          reviews: [],
        })),
        upsertIssueTriageComment: () => Promise.reject(new Error('Unexpected issue comment.')),
        upsertReviewStatus: () => Promise.reject(new Error('The status controller owns comments.')),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        claimReviewFixTaskForReview: () => {
          claimed = true
          return repairTask
        },
        getWorkerSession: () => null,
        queueBaselineRepairForReview: () => { throw new Error('Healthy base CI must not queue Baseline repair.') },
        failTask: () => { throw new Error('A verified repair must not fail.') },
        recordReviewAttempt: (input) => {
          attempt = input
          return { _tag: 'Inserted', attemptId: input.id }
        },
        recordReviewPublication: () => { throw new Error('A repaired head must not publish the old terminal review.') },
        saveWorkerSession: () => undefined,
        stagePublication: () => {
          staged = true
          return { _tag: 'Staged', commandId: 'publication-1' }
        },
        updateAgentProgress: () => true,
      },
      status: {
        publish: () => Promise.resolve(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
        publishRepair: () => Promise.resolve(ok(undefined)),
      },
      triageStatus: { publish: () => Promise.reject(new Error('Unexpected issue triage.')) },
      workspaces: {
        prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
        prepareReview: () => Promise.resolve(ok({ path: '/tmp/review-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
      },
      repairs: {
        verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 2 })),
        commit: (_task, _workspace, _patch, message) => {
          expect(message).toBe('fix(core): preserve buffered parser bytes')
          return Promise.resolve(ok({
            commitSha: 'repair-commit',
            baseSha: pullRequest.baseSha,
            artifactRef: 'artifact-ref',
            digest: 'patch-digest',
            changedFiles: 2,
          }))
        },
      },
    })

    const result = await worker.run({
      id: 'review-task',
      kind: 'adversarial_review',
      repository: repository.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repository,
      pullRequest,
      rerun: { _tag: 'NotRequested' },
    }, new AbortController().signal)

    expect(result).toEqual(ok({ evidence: expect.any(String) }))
    expect(attempt?.findings).toEqual(repairTask.findings)
    expect(claimed).toBe(true)
    expect(staged).toBe(true)
  })

  it('waits for Baseline repair without starting a review agent', async () => {
    const pullRequest = pullRequestSubject({ mergeState: 'clean' })
    let baselineQueued = false
    const worker = createCodexReviewWorker({
      createCodex: () => { throw new Error('Review must wait for Baseline repair.') },
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [{ id: 1, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'failure' }] },
          body: 'Fixes the parser.',
          checks: { _tag: 'Available', checks: [{ id: 1, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'failure' }] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          reviews: [],
        })),
        upsertIssueTriageComment: () => Promise.reject(new Error('Unexpected issue comment.')),
        upsertReviewStatus: () => Promise.reject(new Error('The status controller owns comments.')),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        claimReviewFixTaskForReview: () => { throw new Error('Base CI failure must prevent repair work.') },
        failTask: () => { throw new Error('No repair Task should exist.') },
        getWorkerSession: () => null,
        queueBaselineRepairForReview: () => {
          baselineQueued = true
          return { _tag: 'Queued', taskId: 'baseline-task' }
        },
        recordReviewAttempt: () => { throw new Error('Review must not record an Attempt.') },
        recordReviewPublication: () => { throw new Error('Review must not record a Publication.') },
        saveWorkerSession: () => undefined,
        stagePublication: () => { throw new Error('Base CI failure must prevent publication.') },
        updateAgentProgress: () => true,
      },
      status: {
        publish: () => Promise.reject(new Error('Review must not publish a status.')),
        publishRepair: () => Promise.reject(new Error('Base CI failure must prevent repair progress.')),
      },
      triageStatus: { publish: () => Promise.reject(new Error('Unexpected issue triage.')) },
      workspaces: {
        prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
        prepareReview: () => Promise.reject(new Error('Review must not prepare a workspace.')),
      },
      repairs: {
        commit: () => Promise.reject(new Error('Base CI failure must prevent repair commits.')),
        verify: () => Promise.reject(new Error('Base CI failure must prevent repair verification.')),
      },
    })

    const result = await worker.run({
      id: 'review-task',
      kind: 'adversarial_review',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repositoryMapping(),
      pullRequest,
      rerun: { _tag: 'NotRequested' },
    }, new AbortController().signal)

    expect(result).toEqual(ok({ evidence: 'Waiting for Baseline repair baseline-task.' }))
    expect(baselineQueued).toBe(true)
  })

  it('publishes a valid issue triage result on the issue', async () => {
    const issue = issueSubject()
    const capture: { thread?: ThreadOptions } = {}
    let triageBody = ''
    const worker = createCodexIssueTriageWorker({
      createCodex: codexFactory({
        validity: 'valid',
        difficulty: 2,
        impact: 4,
        hasReproduction: true,
        needsCodebaseReview: false,
        summary: 'The parser drops valid input.',
        nextAction: 'Write a regression test and repair the parser.',
      }, capture),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.resolve(ok({ body: 'Reproduction', comments: [], state: 'open', title: issue.title, updatedAt: issue.updatedAt })),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        getPullRequestReviewSnapshot: () => Promise.reject(new Error('Unexpected pull request request.')),
        upsertIssueTriageComment: () => Promise.reject(new Error('The controller publishes issue triage.')),
        upsertReviewStatus: () => Promise.reject(new Error('Issue triage must not post a review comment.')),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getWorkerSession: () => null,
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
        recordReviewAttempt: () => { throw new Error('Unexpected review Attempt.') },
        recordReviewPublication: () => { throw new Error('Unexpected review Publication.') },
      },
      status: { publish: () => Promise.reject(new Error('Issue triage must not publish status.')) },
      triageStatus: {
        publish: (_task, body) => {
          triageBody = body
          return Promise.resolve(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/issues/12#issuecomment-42' }))
        },
      },
      workspaces: {
        prepareIssue: () => Promise.resolve(ok({ path: '/tmp/issue-worktree', baseSha: 'base', headSha: 'base' })),
        prepareReview: () => Promise.reject(new Error('Unexpected review workspace.')),
      },
    })

    const result = await worker.run({
      id: 'issue-task',
      kind: 'issue_triage',
      repository: 'harlan-zw/example',
      issueNumber: 12,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repositoryMapping(),
      issue,
    }, new AbortController().signal)

    expect(result).toEqual({
      _tag: 'Ok',
      value: {
        evidence: JSON.stringify({
          validity: 'valid',
          difficulty: 2,
          impact: 4,
          hasReproduction: true,
          needsCodebaseReview: false,
          summary: 'The parser drops valid input.',
          nextAction: 'Write a regression test and repair the parser.',
        }),
      },
    })
    expect(capture.thread).toEqual(expect.objectContaining({ model: 'gpt-5.6-terra', modelReasoningEffort: 'medium' }))
    expect(triageBody).toBe(`<!-- harlan-agent-kit:issue-triage -->
### 🤖 Issue triage

> Harlan Agent Kit posted this automated triage. It is not Harlan's personal assessment or commitment.

- **Validity:** Valid
- **Difficulty:** 2/5
- **Impact:** 4/5
- **Reproduction:** Yes
- **Codebase review:** Not needed
- **Summary:** The parser drops valid input.
- **Next action:** Write a regression test and repair the parser.`)
  })
})
