import type { RecordReviewRunInput } from '../src/types.ts'
import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createIssueTriageWorker, createReviewWorker, reviewSnapshotDigest } from '../src/item-agent.ts'
import { ok } from '../src/result.ts'
import { issueItem, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

describe('subject Workers', () => {
  it('keeps one review identity while GitHub activity time and CI results move', () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
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
    expect(reviewSnapshotDigest({
      ...snapshot,
      checks: { _tag: 'Available' as const, checks: [{ id: 1, source: { _tag: 'CheckRun' as const, appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }] },
    })).toBe(reviewSnapshotDigest(snapshot))
    expect(reviewSnapshotDigest({ ...snapshot, comments: ['Different human review comment.'] })).not.toBe(reviewSnapshotDigest(snapshot))
  })

  it('records and publishes one isolated adversarial review', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const capture: ProviderCapture = { requests: [] }
    const comments: string[] = []
    let attempt: RecordReviewRunInput | undefined
    const worker = createReviewWorker({
      profile: CODEX_AGENT_PROFILE,
      provider: stubProvider(turnEvents({
        metadata: { state: 'passed', reason: '', evidence: 'metadata aligned' },
        review: { state: 'passed', reason: '', evidence: 'full diff reviewed' },
        verification: { state: 'passed', reason: '', evidence: 'focused tests passed' },
        findings: [],
        repair: { outcome: 'not_needed', summary: 'No repair needed.', checks: [], commitMessage: '' },
        confidence: 96,
      }), capture),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
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
        isBaselineRepairPullRequest: () => false,
        queueBaselineRepairForReview: () => { throw new Error('Healthy base CI must not queue Baseline repair.') },
        retireBaselineRepairForReview: () => 0,
        saveWorkerSession: () => undefined,
        stagePublication: () => { throw new Error('A clean review must not stage a repair.') },
        updateAgentProgress: () => true,
        recordReviewRun: (input) => {
          attempt = input
          return { _tag: 'Inserted', reviewRunId: input.id }
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
    expect(capture.requests).toEqual([expect.objectContaining({ model: 'gpt-5.6-sol', reasoningEffort: 'high' })])
  })

  it('does not start a second review for the same head commit', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    let workspaceCreated = false
    const capture: ProviderCapture = { requests: [] }
    const worker = createReviewWorker({
      profile: CODEX_AGENT_PROFILE,
      provider: stubProvider([], capture),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
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
        isBaselineRepairPullRequest: () => false,
        queueBaselineRepairForReview: () => { throw new Error('A second review must not queue Baseline repair.') },
        retireBaselineRepairForReview: () => 0,
        saveWorkerSession: () => undefined,
        stagePublication: () => { throw new Error('A second review must not stage a repair.') },
        updateAgentProgress: () => true,
        recordReviewRun: () => { throw new Error('A second review must not be recorded.') },
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
    expect(capture.requests).toEqual([])
    expect(workspaceCreated).toBe(false)
  })

  it('repairs findings during the review turn and stages their publication', async () => {
    const repository = repositoryMapping()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    let attempt: RecordReviewRunInput | undefined
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
    const worker = createReviewWorker({
      profile: CODEX_AGENT_PROFILE,
      provider: stubProvider(turnEvents({
        metadata: { state: 'passed', reason: '', evidence: 'metadata aligned' },
        review: { state: 'failed', reason: 'The parser drops data.', evidence: 'focused reproduction failed before repair' },
        verification: { state: 'passed', reason: '', evidence: 'regression passes after repair' },
        findings: [{ summary: 'The parser drops data.', nextAction: 'Preserve the buffered bytes.' }],
        repair: { outcome: 'repaired', summary: 'Preserved buffered bytes.', checks: ['pnpm vitest run test/parser.test.ts'], commitMessage: 'fix(core): preserve buffered parser bytes' },
        confidence: null,
      })),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
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
        isBaselineRepairPullRequest: () => false,
        queueBaselineRepairForReview: () => { throw new Error('Healthy base CI must not queue Baseline repair.') },
        retireBaselineRepairForReview: () => 0,
        failTask: () => { throw new Error('A verified repair must not fail.') },
        recordReviewRun: (input) => {
          attempt = input
          return { _tag: 'Inserted', reviewRunId: input.id }
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
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    let baselineQueued = false
    const capture: ProviderCapture = { requests: [] }
    const worker = createReviewWorker({
      profile: CODEX_AGENT_PROFILE,
      provider: stubProvider([], capture),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
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
        isBaselineRepairPullRequest: () => false,
        queueBaselineRepairForReview: () => {
          baselineQueued = true
          return { _tag: 'Queued', taskId: 'baseline-task' }
        },
        retireBaselineRepairForReview: () => 0,
        recordReviewRun: () => { throw new Error('Review must not record an Attempt.') },
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

  it('reviews the pull request anyway when policy does not authorize Baseline repair', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const capture: ProviderCapture = { requests: [] }
    let published = ''
    const worker = createReviewWorker({
      profile: CODEX_AGENT_PROFILE,
      provider: stubProvider(turnEvents({
        metadata: { state: 'passed', reason: '', evidence: 'metadata aligned' },
        review: { state: 'passed', reason: '', evidence: 'full diff reviewed' },
        verification: { state: 'passed', reason: '', evidence: 'build passes' },
        findings: [],
        repair: { outcome: 'not_needed', summary: 'No material defect.', checks: ['pnpm build'], commitMessage: '' },
        confidence: 91,
      }), capture),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [{ id: 1, source: { _tag: 'CheckRun', appId: 15368 }, name: 'build', status: 'completed', conclusion: 'failure' }] },
          body: 'Fixes the parser.',
          checks: { _tag: 'Available', checks: [{ id: 2, source: { _tag: 'CheckRun', appId: 15368 }, name: 'build', status: 'completed', conclusion: 'success' }] },
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
        claimReviewFixTaskForReview: () => { throw new Error('No repair is needed.') },
        failTask: () => { throw new Error('No repair Task should exist.') },
        getWorkerSession: () => null,
        isBaselineRepairPullRequest: () => false,
        queueBaselineRepairForReview: () => ({
          _tag: 'NotAuthorized',
          reason: 'Repository policy does not authorize Baseline repair for this base commit.',
        }),
        retireBaselineRepairForReview: () => 0,
        recordReviewRun: () => ({ _tag: 'Inserted', reviewRunId: 'attempt-1' }),
        recordReviewPublication: () => ({ _tag: 'Inserted', publicationId: 'publication-1' }),
        saveWorkerSession: () => undefined,
        stagePublication: () => { throw new Error('No repair is needed.') },
        updateAgentProgress: () => true,
      },
      status: {
        publish: (_task, phase, body) => {
          if (phase === 'terminal')
            published = body
          return Promise.resolve(ok({ commentId: 1, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-1' }))
        },
        publishRepair: () => Promise.reject(new Error('No repair is needed.')),
      },
      triageStatus: { publish: () => Promise.reject(new Error('Unexpected issue triage.')) },
      workspaces: {
        prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
        prepareReview: () => Promise.resolve(ok({ path: '/tmp/review', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
      },
      repairs: {
        commit: () => Promise.reject(new Error('No repair is needed.')),
        verify: () => Promise.reject(new Error('No repair is needed.')),
      },
    })

    const result = await worker.run({
      id: 'review-task',
      kind: 'adversarial_review',
      repository: 'nuxt-modules/sitemap',
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repositoryMapping({ ownership: 'external' }),
      pullRequest,
      rerun: { _tag: 'NotRequested' },
    }, new AbortController().signal)

    expect(result).toEqual(ok({ evidence: expect.any(String) }))
    expect(capture.requests).toHaveLength(1)
    expect(published).toContain('PENDING')
    expect(published).toContain('Base branch CI')
  })

  it('reviews a stacked pull request instead of queueing a Baseline repair for its parent', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean', baseRef: 'fix/parent-work' })
    const capture: ProviderCapture = { requests: [] }
    let published = ''
    const worker = createReviewWorker({
      profile: CODEX_AGENT_PROFILE,
      provider: stubProvider(turnEvents({
        metadata: { state: 'passed', reason: '', evidence: 'metadata aligned' },
        review: { state: 'passed', reason: '', evidence: 'full diff reviewed' },
        verification: { state: 'passed', reason: '', evidence: 'build passes' },
        findings: [],
        repair: { outcome: 'not_needed', summary: 'No material defect.', checks: ['pnpm build'], commitMessage: '' },
        confidence: 90,
      }), capture),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          // The parent pull request is red. That is the parent's problem.
          baseChecks: { _tag: 'Available', checks: [{ id: 1, source: { _tag: 'CheckRun', appId: 15368 }, name: 'build', status: 'completed', conclusion: 'failure' }] },
          body: 'Builds on the parent pull request.',
          checks: { _tag: 'Available', checks: [{ id: 2, source: { _tag: 'CheckRun', appId: 15368 }, name: 'build', status: 'completed', conclusion: 'success' }] },
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
        claimReviewFixTaskForReview: () => { throw new Error('No repair is needed.') },
        failTask: () => { throw new Error('No repair Task should exist.') },
        getWorkerSession: () => null,
        isBaselineRepairPullRequest: () => false,
        queueBaselineRepairForReview: () => { throw new Error('A stacked pull request must not queue Baseline repair.') },
        retireBaselineRepairForReview: () => 0,
        recordReviewRun: () => ({ _tag: 'Inserted', reviewRunId: 'attempt-1' }),
        recordReviewPublication: () => ({ _tag: 'Inserted', publicationId: 'publication-1' }),
        saveWorkerSession: () => undefined,
        stagePublication: () => { throw new Error('No repair is needed.') },
        updateAgentProgress: () => true,
      },
      status: {
        publish: (_task, phase, body) => {
          if (phase === 'terminal')
            published = body
          return Promise.resolve(ok({ commentId: 1, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-1' }))
        },
        publishRepair: () => Promise.reject(new Error('No repair is needed.')),
      },
      triageStatus: { publish: () => Promise.reject(new Error('Unexpected issue triage.')) },
      workspaces: {
        prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
        prepareReview: () => Promise.resolve(ok({ path: '/tmp/review', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
      },
      repairs: {
        commit: () => Promise.reject(new Error('No repair is needed.')),
        verify: () => Promise.reject(new Error('No repair is needed.')),
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
      repositoryMapping: repositoryMapping({ defaultBranch: 'main' }),
      pullRequest,
      rerun: { _tag: 'NotRequested' },
    }, new AbortController().signal)

    expect(result).toEqual(ok({ evidence: expect.any(String) }))
    expect(capture.requests).toHaveLength(1)
    expect(published).toContain('Base branch CI')
  })

  it('reviews the Baseline repair pull request itself while the default branch stays red', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean', headRef: 'fix/baseline-ci-abcdef012345' })
    const capture: ProviderCapture = { requests: [] }
    let published = ''
    const worker = createReviewWorker({
      profile: CODEX_AGENT_PROFILE,
      provider: stubProvider(turnEvents({
        metadata: { state: 'passed', reason: '', evidence: 'metadata aligned' },
        review: { state: 'passed', reason: '', evidence: 'full diff reviewed' },
        verification: { state: 'passed', reason: '', evidence: 'build passes with the fix' },
        findings: [],
        repair: { outcome: 'not_needed', summary: 'No material defect.', checks: ['pnpm build'], commitMessage: '' },
        confidence: 88,
      }), capture),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          // The default branch is red. That failure is what this pull request repairs.
          baseChecks: { _tag: 'Available', checks: [{ id: 1, source: { _tag: 'CheckRun', appId: 15368 }, name: 'build', status: 'completed', conclusion: 'failure' }] },
          body: 'Repairs the default branch build.',
          checks: { _tag: 'Available', checks: [{ id: 2, source: { _tag: 'CheckRun', appId: 15368 }, name: 'build', status: 'completed', conclusion: 'success' }] },
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
        claimReviewFixTaskForReview: () => { throw new Error('No repair is needed.') },
        failTask: () => { throw new Error('No repair Task should exist.') },
        getWorkerSession: () => null,
        isBaselineRepairPullRequest: () => true,
        queueBaselineRepairForReview: () => { throw new Error('A Baseline repair must not queue another Baseline repair.') },
        retireBaselineRepairForReview: () => 0,
        recordReviewRun: () => ({ _tag: 'Inserted', reviewRunId: 'attempt-1' }),
        recordReviewPublication: () => ({ _tag: 'Inserted', publicationId: 'publication-1' }),
        saveWorkerSession: () => undefined,
        stagePublication: () => { throw new Error('No repair is needed.') },
        updateAgentProgress: () => true,
      },
      status: {
        publish: (_task, phase, body) => {
          if (phase === 'terminal')
            published = body
          return Promise.resolve(ok({ commentId: 1, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-1' }))
        },
        publishRepair: () => Promise.reject(new Error('No repair is needed.')),
      },
      triageStatus: { publish: () => Promise.reject(new Error('Unexpected issue triage.')) },
      workspaces: {
        prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
        prepareReview: () => Promise.resolve(ok({ path: '/tmp/review', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
      },
      repairs: {
        commit: () => Promise.reject(new Error('No repair is needed.')),
        verify: () => Promise.reject(new Error('No repair is needed.')),
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

    expect(result).toEqual(ok({ evidence: expect.any(String) }))
    expect(capture.requests).toHaveLength(1)
    expect(published).toContain('READY · 88/100')
  })

  it('publishes a valid issue triage result on the issue', async () => {
    const issue = issueItem()
    const capture: ProviderCapture = { requests: [] }
    let triageBody = ''
    const worker = createIssueTriageWorker({
      profile: CODEX_AGENT_PROFILE,
      provider: stubProvider(turnEvents({
        validity: 'valid',
        difficulty: 2,
        impact: 4,
        hasReproduction: true,
        needsCodebaseReview: false,
        summary: 'The parser drops valid input.',
        nextAction: 'Write a regression test and repair the parser.',
      }), capture),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        getIssueTriageSnapshot: () => Promise.resolve(ok({ body: 'Reproduction', comments: [], state: 'open', title: issue.title, updatedAt: issue.updatedAt })),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        listPullRequestFiles: () => Promise.resolve(ok([])),
        getPullRequestReviewSnapshot: () => Promise.reject(new Error('Unexpected pull request request.')),
        upsertIssueTriageComment: () => Promise.reject(new Error('The controller publishes issue triage.')),
        upsertReviewStatus: () => Promise.reject(new Error('Issue triage must not post a review comment.')),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        getWorkerSession: () => null,
        isBaselineRepairPullRequest: () => false,
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
        recordReviewRun: () => { throw new Error('Unexpected review Attempt.') },
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
        prepareIssue: () => Promise.resolve(ok({ path: '/tmp/issue-worktree', baseSha: 'base', headSha: 'base', defaultBranchSha: 'base' })),
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
    expect(capture.requests).toEqual([expect.objectContaining({ model: 'gpt-5.6-terra', reasoningEffort: 'medium' })])
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
