import type { PullRequestFile } from '../src/merge-risk.ts'
import type { AgentProfile } from '../src/types.ts'
import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE, resolveAgentProfile } from '../src/agent-profile.ts'
import { createReviewWorker } from '../src/item-agent.ts'
import { ok } from '../src/result.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const passingCheck = { id: 1, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun' as const, appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }

function file(path: string, additions: number, deletions = 0): PullRequestFile {
  return { path, status: 'modified', additions, deletions, previousFilename: null }
}

/**
 * Runs one Review over the given changed files and reports what the Agent
 * turn was asked for and what the Review run recorded.
 */
async function reviewWith(files: PullRequestFile[], profile: AgentProfile = CODEX_AGENT_PROFILE) {
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  const capture: ProviderCapture = { requests: [] }
  const recorded: Array<string | null | undefined> = []
  const worker = createReviewWorker({
    runtime: agentRuntime(profile, stubProvider(turnEvents({
      premise: { verdict: 'sound', reason: 'The change can be repaired without replacing its intent.' },
      findings: [],
      confidence: 96,
    }), capture)),
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
      listPullRequestFiles: () => Promise.reject(new Error('The recorded files must answer the Reasoning effort band.')),
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
      getWorkerSession: () => null,
      storedReviewForHead: () => ({ _tag: 'None' }),
      getRevisionFiles: () => ({ files, headSha: 'abc123' }),
      supersedeReviewRun: input => ({ _tag: 'Inserted', reviewRunId: input.id }),
      recordIncident: () => { throw new Error('Unexpected Incident.') },
      queueBaselineRepairForReview: () => { throw new Error('Healthy base CI must not queue Baseline repair.') },
      retireBaselineRepairForReview: () => 0,
      saveWorkerSession: () => undefined,
      updateAgentProgress: () => true,
      recordReviewRun: (input) => {
        recorded.push(input.reasoningEffort)
        return { _tag: 'Inserted', reviewRunId: input.id }
      },
      recordReviewPublication: input => ({ _tag: 'Inserted', publicationId: input.id }),
    },
    status: {
      publish: () => Promise.resolve(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
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
    repositoryMapping: repositoryMapping(),
    pullRequest,
    rerun: { _tag: 'NotRequested' },
  }, new AbortController().signal)

  if (result._tag !== 'Ok')
    throw new Error(result.error)
  return { asked: capture.requests.at(0)?.reasoningEffort, recorded: recorded.at(0) }
}

describe('the Reasoning effort band reaches the Review turn', () => {
  it('reviews a small change at low, and records that it did', async () => {
    const review = await reviewWith([file('src/parser.ts', 4, 2)])
    expect(review.asked).toBe('low')
    expect(review.recorded).toBe('low')
  })

  it('keeps the Agent default for a change an agent reads as instructions', async () => {
    const review = await reviewWith([file('AGENTS.md', 4, 2)])
    expect(review.asked).toBe(CODEX_AGENT_PROFILE.roles.adversarial_review.reasoningEffort)
    expect(review.recorded).toBe(CODEX_AGENT_PROFILE.roles.adversarial_review.reasoningEffort)
  })

  it('leaves a pinned Reasoning effort alone, even when it matches the provider default', async () => {
    const profile = resolveAgentProfile({ provider: 'codex', model: null, reasoningEffort: 'high' }, 3)
    const review = await reviewWith([file('src/parser.ts', 4, 2)], profile)
    expect(review.asked).toBe('high')
    expect(review.recorded).toBe('high')
  })

  it('leaves a configured Reasoning effort alone, even when it matches the provider default', async () => {
    const profile = resolveAgentProfile(
      { provider: 'codex', model: null, reasoningEffort: null },
      3,
      { codex: { adversarial_review: 'high' } },
    )
    const review = await reviewWith([file('src/parser.ts', 4, 2)], profile)
    expect(review.asked).toBe('high')
    expect(review.recorded).toBe('high')
  })
})
