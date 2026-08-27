import type { GitHubCheck, PullRequestReviewSnapshot, RequiredChecks } from '../src/github-agent-source.ts'
import type { ReviewWorkerOptions } from '../src/item-agent.ts'
import type { ClaimedAdversarialReviewTask, GitHubPullRequestItem, RecordReviewRunInput } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { requiredCheckContexts } from '../src/github-agent-source.ts'
import { createReviewWorker } from '../src/item-agent.ts'
import { ok } from '../src/result.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const cleanReview = {
  metadata: { state: 'passed', reason: '', evidence: 'metadata aligned' },
  premise: { verdict: 'sound', reason: 'The change can remain intact.' },
  review: { state: 'passed', reason: '', evidence: 'full diff reviewed' },
  verification: { state: 'passed', reason: '', evidence: 'focused tests passed' },
  findings: [],
  confidence: 96,
}

function check(id: number, name: string, conclusion: string): GitHubCheck {
  return { id, failure: { _tag: 'NotAsked' }, source: { _tag: 'CheckRun', appId: 15368 }, name, status: 'completed', conclusion }
}

const passingBaseCheck = check(1, 'ci / test', 'success')

function reviewTask(pullRequest: GitHubPullRequestItem): ClaimedAdversarialReviewTask {
  return {
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
  }
}

/** One review worker whose only moving parts are the head checks and the required checks. */
function reviewWith(input: { headChecks: GitHubCheck[], requiredChecks: RequiredChecks }): {
  comments: string[]
  runs: RecordReviewRunInput[]
  run: () => Promise<unknown>
} {
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  const comments: string[] = []
  const runs: RecordReviewRunInput[] = []
  const snapshot: PullRequestReviewSnapshot = {
    baseChecks: { _tag: 'Available', checks: [passingBaseCheck] },
    body: 'Fixes the bug.',
    checks: { _tag: 'Available', checks: input.headChecks },
    comments: [],
    priorAutomatedReview: { _tag: 'None' },
    pullRequest,
    requiredChecks: input.requiredChecks,
    reviews: [],
  }
  const options: ReviewWorkerOptions = {
    runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(cleanReview))),
    github: {
      consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
      editReviewStatus: () => Promise.reject(new Error('Unexpected comment edit.')),
      ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
      stampReviewOutcome: () => Promise.resolve(ok(undefined)),
      getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
      listPullRequestFiles: () => Promise.reject(new Error('Unexpected file listing.')),
      getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
      getPullRequestReviewSnapshot: () => Promise.resolve(ok(snapshot)),
      upsertIssueTriageComment: () => Promise.reject(new Error('Review must not post issue triage.')),
      upsertReviewStatus: () => Promise.reject(new Error('The Worker must use the status controller.')),
    },
    now: () => new Date('2026-08-13T01:00:00.000Z'),
    preflightRepair: () => Promise.resolve(ok(undefined)),
    store: {
      queueReviewFixTaskForReview: () => { throw new Error('Unexpected Repair queue.') },
      getRepairedHeadFindings: () => [],
      getWorkerSession: () => null,
      recordIncident: () => { throw new Error('Unexpected Incident.') },
      queueBaselineRepairForReview: () => { throw new Error('Healthy base CI must not queue Baseline repair.') },
      retireBaselineRepairForReview: () => 0,
      saveWorkerSession: () => undefined,
      updateAgentProgress: () => true,
      recordReviewRun: (run) => {
        runs.push(run)
        return { _tag: 'Inserted', reviewRunId: run.id }
      },
      recordReviewPublication: publication => ({ _tag: 'Inserted', publicationId: publication.id }),
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
  }
  const worker = createReviewWorker(options)
  return { comments, runs, run: () => worker.run(reviewTask(pullRequest), new AbortController().signal) }
}

function terminal(comments: string[]): string {
  return comments[comments.length - 1] ?? ''
}

describe('required checks and the CI Review gate', () => {
  it('does not block on a failing check that GitHub does not require', async () => {
    const test = reviewWith({
      headChecks: [check(1, 'ci / test', 'success'), check(2, 'Analyze (javascript-typescript)', 'failure')],
      requiredChecks: { _tag: 'Declared', contexts: ['ci / test'] },
    })

    await test.run()

    expect(terminal(test.comments)).toContain('READY')
    expect(test.runs[0]?.gates.ci._tag).toBe('Passed')
  })

  it('reports the failing check that GitHub does not require', async () => {
    const test = reviewWith({
      headChecks: [check(1, 'ci / test', 'success'), check(2, 'Analyze (javascript-typescript)', 'failure')],
      requiredChecks: { _tag: 'Declared', contexts: ['ci / test'] },
    })

    await test.run()

    expect(terminal(test.comments)).toContain('Analyze (javascript-typescript) failed')
    expect(terminal(test.comments)).toContain('GitHub does not require this check')
  })

  it('blocks on every failing check when the repository declares no required check', async () => {
    const test = reviewWith({
      headChecks: [check(1, 'ci / test', 'success'), check(2, 'Analyze (javascript-typescript)', 'failure')],
      requiredChecks: { _tag: 'None' },
    })

    await test.run()

    expect(terminal(test.comments)).toContain('BLOCKED')
    expect(test.runs[0]?.gates.ci._tag).toBe('Failed')
  })

  it('blocks on every failing check when GitHub does not answer which checks it requires', async () => {
    const test = reviewWith({
      headChecks: [check(1, 'ci / test', 'success'), check(2, 'Analyze (javascript-typescript)', 'failure')],
      requiredChecks: { _tag: 'Unavailable', reason: 'GitHub returned 500.' },
    })

    await test.run()

    expect(terminal(test.comments)).toContain('BLOCKED')
    expect(test.runs[0]?.gates.ci._tag).toBe('Failed')
  })

  it('blocks when a required check fails', async () => {
    const test = reviewWith({
      headChecks: [check(1, 'ci / test', 'failure'), check(2, 'Analyze (javascript-typescript)', 'success')],
      requiredChecks: { _tag: 'Declared', contexts: ['ci / test'] },
    })

    await test.run()

    expect(terminal(test.comments)).toContain('BLOCKED')
    expect(test.runs[0]?.gates.ci._tag).toBe('Failed')
  })

  it('reads the required contexts out of a branch rules response', () => {
    expect(requiredCheckContexts([
      { type: 'deletion', ruleset_id: 1 },
      {
        type: 'required_status_checks',
        ruleset_id: 2,
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: 'ci-ok', integration_id: 15368 }, { context: 'ci / test' }],
        },
      },
    ])).toEqual(['ci-ok', 'ci / test'])
    expect(requiredCheckContexts([{ type: 'deletion', ruleset_id: 1 }])).toEqual([])
    expect(requiredCheckContexts([])).toEqual([])
    expect(requiredCheckContexts({ message: 'Not Found' })).toEqual([])
  })

  it('waits when a required check has not reported', async () => {
    const test = reviewWith({
      headChecks: [check(1, 'ci / test', 'success')],
      requiredChecks: { _tag: 'Declared', contexts: ['ci / test', 'ci / typecheck'] },
    })

    await test.run()

    expect(terminal(test.comments)).toContain('PENDING')
    expect(test.runs[0]?.gates.ci._tag).toBe('Pending')
  })
})
