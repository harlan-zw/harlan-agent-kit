import type { MergeRiskRecord, RepositoryAutoMergeScope, ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { createReviewWorker, terminalComment } from '../src/item-agent.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => stores.splice(0).forEach(store => store.close()))

const containedScope: RepositoryAutoMergeScope = {
  _tag: 'Contained',
  labelOverridesRisk: true,
  minimumConfidence: 90,
  policy: { containedPaths: [], maximumChangedFiles: 12, maximumChangedLines: 300, requireTestChange: false, sensitivePaths: [] },
}

function passedGates(): ReviewGates {
  return {
    merge: { _tag: 'Passed', evidence: [{ label: 'mergeability', sha256: 'b'.repeat(64) }] },
    review: { _tag: 'Passed', evidence: [{ label: 'review', sha256: 'c'.repeat(64) }] },
    ci: { _tag: 'Passed', evidence: [{ label: 'required-ci', sha256: 'e'.repeat(64) }] },
  }
}

const containedRisk: MergeRiskRecord = {
  claim: { _tag: 'Contained' },
  combined: { _tag: 'Contained' },
  floor: { _tag: 'Contained' },
}

function reviewWithVerdict(store: ReturnType<typeof openJournalStore>): void {
  store.syncRepositories([repositoryMapping({ autoMerge: containedScope })], '2026-09-16T00:00:00.000Z')
  const observed = store.recordObservation({
    externalId: 'dashboard-merge-risk',
    observedAt: '2026-09-16T00:01:00.000Z',
    source: 'poll',
    subject: pullRequestItem({ mergeState: 'clean' }),
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected the pull request revision.')
  const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-09-16T00:01:30.000Z', 3_600_000)
  if (task === null)
    throw new Error('Expected the Review Task.')
  store.recordReviewRun({
    id: 'attempt-contained',
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: observed.revisionId,
    headSha: 'abc123',
    provider: 'codex',
    sessionId: 'session-1',
    model: 'gpt-5.6',
    agentVersion: '1.2.3',
    skillDigest: 'f'.repeat(64),
    startedAt: '2026-09-16T00:02:00.000Z',
    completedAt: '2026-09-16T00:03:00.000Z',
    gates: passedGates(),
    confidence: 100,
    findings: [],
    mergeRisk: containedRisk,
  })
  store.completeReviewTask({
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: '2026-09-16T00:03:30.000Z',
    evidence: 'attempt-contained',
    resolution: { _tag: 'Reviewed', reviewRunId: 'attempt-contained' },
  })
}

describe('a recorded Merge risk verdict stays visible', () => {
  it('reaches the dashboard agents payload', () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    reviewWithVerdict(store)

    const agent = store.getDashboardSnapshot('2026-09-16T00:04:00.000Z').agents.find(candidate => candidate._tag === 'ReviewAgent' && candidate.id === 'attempt-contained')
    expect(agent).toMatchObject({ mergeRisk: containedRisk })
  })

  it('carries a describeMergeRisk line beside the gate lines in the published body', () => {
    const body = terminalComment('abc123', 'base123', passedGates(), [], 100, [], containedRisk.combined)
    expect(body).toContain('- **Merge risk:** Contained')
  })
})

describe('a fresh Review publishes its Merge risk verdict', () => {
  it('carries the Merge risk line in the first terminal comment', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const comments: string[] = []
    const passingCheck = { id: 1, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun' as const, appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }
    const worker = createReviewWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        premise: { verdict: 'sound', reason: 'The change can be repaired without replacing its intent.' },
        findings: [],
        confidence: 96,
        mergeRisk: { verdict: 'contained', reason: 'One small file inside the diff.' },
      }))),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        editReviewStatus: () => Promise.reject(new Error('Unexpected comment edit.')),
        upsertReviewCheckRun: () => Promise.reject(new Error('Unexpected Review check run write.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        clearAgentLabels: () => Promise.reject(new Error('Unexpected label clear.')),
        clearRunningLabel: () => Promise.reject(new Error('Unexpected Running label clear.')),
        listRunningLabelledItems: () => Promise.reject(new Error('Unexpected Running label read.')),
        stampAgentLabel: () => Promise.resolve(ok(undefined)),
        findOpenPullRequestForBranch: () => Promise.reject(new Error('Unexpected pull request lookup.')),
        getFailedJobContext: () => Promise.reject(new Error('Unexpected job log read.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        listPullRequestFiles: () => Promise.resolve(ok([{ path: 'src/parser.ts', status: 'modified', additions: 4, deletions: 2, previousFilename: null }])),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [passingCheck] },
          body: 'Fixes the bug.',
          checks: { _tag: 'Available', checks: [passingCheck] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          requiredChecks: { _tag: 'None' },
          reviews: [],
        })),
        upsertIssueTriageComment: () => Promise.reject(new Error('Review must not post issue triage.')),
        upsertReviewStatus: () => Promise.reject(new Error('The Worker must use the status controller.')),
      },
      now: () => new Date('2026-09-16T01:00:00.000Z'),
      preflightRepair: () => Promise.resolve(ok(undefined)),
      store: {
        recordExactPullRequestObservation: () => { throw new Error('Unexpected merge observation.') },
        queueReviewFixTaskForReview: () => { throw new Error('A clean review must not queue Repair work.') },
        getRepairedHeadFindings: () => [],
        repairRoundPlan: () => ({ _tag: 'Allowed' as const, number: 1 }),
        getWorkerSession: () => null,
        storedReviewForHead: () => ({ _tag: 'None' }),
        getRevisionFiles: () => null,
        supersedeReviewRun: input => ({ _tag: 'Inserted', reviewRunId: input.id }),
        recordIncident: () => { throw new Error('Unexpected Incident.') },
        queueBaselineRepairForReview: () => { throw new Error('Healthy base CI must not queue Baseline repair.') },
        retireBaselineRepairForReview: () => 0,
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
        recordReviewRun: input => ({ _tag: 'Inserted', reviewRunId: input.id }),
        recordReviewPublication: input => ({ _tag: 'Inserted', publicationId: input.id }),
      },
      status: {
        publish: (_task, _phase, body) => {
          comments.push(body)
          return Promise.resolve(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      triageStatus: { publish: () => Promise.reject(new Error('Review must not publish issue triage.')) },
      workspaces: {
        prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
        prepareReview: () => Promise.resolve(ok({ path: '/tmp/review-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
        verifyReview: () => Promise.resolve(ok(undefined)),
      },
    })

    const result = await worker.run({
      id: 'review-task',
      kind: 'adversarial_review',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-09-16T02:00:00.000Z' },
      updatedAt: '2026-09-16T01:00:00.000Z',
      repositoryMapping: repositoryMapping({ autoMerge: containedScope }),
      pullRequest,
      rerun: { _tag: 'NotRequested' },
    }, new AbortController().signal)

    expect(result._tag).toBe('Ok')
    if (result._tag !== 'Ok')
      throw new Error(result.error)
    const terminal = comments.at(-1)
    expect(terminal).toContain('READY · 96/100')
    expect(terminal).toContain('- **Merge risk:** Contained')
  })

  it('computes the floor from the recorded files without reading GitHub', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const comments: string[] = []
    const passingCheck = { id: 1, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun' as const, appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }
    const worker = createReviewWorker({
      runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents({
        premise: { verdict: 'sound', reason: 'The change can be repaired without replacing its intent.' },
        findings: [],
        confidence: 96,
        mergeRisk: { verdict: 'contained', reason: 'One small file inside the diff.' },
      }))),
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        editReviewStatus: () => Promise.reject(new Error('Unexpected comment edit.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
        clearAgentLabels: () => Promise.reject(new Error('Unexpected label clear.')),
        clearRunningLabel: () => Promise.reject(new Error('Unexpected Running label clear.')),
        listRunningLabelledItems: () => Promise.reject(new Error('Unexpected Running label read.')),
        stampAgentLabel: () => Promise.resolve(ok(undefined)),
        upsertReviewCheckRun: () => Promise.reject(new Error('Unexpected Review check run write.')),
        findOpenPullRequestForBranch: () => Promise.reject(new Error('Unexpected pull request lookup.')),
        getFailedJobContext: () => Promise.reject(new Error('Unexpected job log read.')),
        getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
        getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
        listPullRequestFiles: () => Promise.reject(new Error('The recorded files must answer the Merge risk floor.')),
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [passingCheck] },
          body: 'Fixes the bug.',
          checks: { _tag: 'Available', checks: [passingCheck] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          requiredChecks: { _tag: 'None' },
          reviews: [],
        })),
        upsertIssueTriageComment: () => Promise.reject(new Error('Review must not post issue triage.')),
        upsertReviewStatus: () => Promise.reject(new Error('The Worker must use the status controller.')),
      },
      now: () => new Date('2026-09-16T01:00:00.000Z'),
      preflightRepair: () => Promise.resolve(ok(undefined)),
      store: {
        recordExactPullRequestObservation: () => { throw new Error('Unexpected merge observation.') },
        queueReviewFixTaskForReview: () => { throw new Error('A clean review must not queue Repair work.') },
        getRepairedHeadFindings: () => [],
        repairRoundPlan: () => ({ _tag: 'Allowed' as const, number: 1 }),
        getWorkerSession: () => null,
        storedReviewForHead: () => ({ _tag: 'None' }),
        getRevisionFiles: () => ({ files: [{ path: 'src/parser.ts', status: 'modified', additions: 4, deletions: 2, previousFilename: null }], headSha: 'abc123' }),
        supersedeReviewRun: input => ({ _tag: 'Inserted', reviewRunId: input.id }),
        recordIncident: () => { throw new Error('Unexpected Incident.') },
        queueBaselineRepairForReview: () => { throw new Error('Healthy base CI must not queue Baseline repair.') },
        retireBaselineRepairForReview: () => 0,
        saveWorkerSession: () => undefined,
        updateAgentProgress: () => true,
        recordReviewRun: input => ({ _tag: 'Inserted', reviewRunId: input.id }),
        recordReviewPublication: input => ({ _tag: 'Inserted', publicationId: input.id }),
      },
      status: {
        publish: (_task, _phase, body) => {
          comments.push(body)
          return Promise.resolve(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      triageStatus: { publish: () => Promise.reject(new Error('Review must not publish issue triage.')) },
      workspaces: {
        prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
        prepareReview: () => Promise.resolve(ok({ path: '/tmp/review-worktree', baseSha: pullRequest.baseSha, headSha: pullRequest.headSha })),
        verifyReview: () => Promise.resolve(ok(undefined)),
      },
    })

    const result = await worker.run({
      id: 'review-task',
      kind: 'adversarial_review',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-09-16T02:00:00.000Z' },
      updatedAt: '2026-09-16T01:00:00.000Z',
      repositoryMapping: repositoryMapping({ autoMerge: containedScope }),
      pullRequest,
      rerun: { _tag: 'NotRequested' },
    }, new AbortController().signal)

    expect(result._tag).toBe('Ok')
    if (result._tag !== 'Ok')
      throw new Error(result.error)
    expect(comments.at(-1)).toContain('- **Merge risk:** Contained')
  })
})
