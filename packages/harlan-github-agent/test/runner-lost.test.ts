import type { GitHubCheck, PullRequestReviewSnapshot } from '../src/github-agent-source.ts'
import type { ReviewWorkerOptions } from '../src/item-agent.ts'
import type { RecordIncidentInput } from '../src/store.ts'
import type { ClaimedAdversarialReviewTask, GitHubPullRequestItem, Incident, RecordReviewRunInput } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { classifyFailedJob } from '../src/github-agent-source.ts'
import { createReviewWorker, RUNNER_LOST_INCIDENT_MESSAGE } from '../src/item-agent.ts'
import { ok } from '../src/result.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const cleanReview = {
  metadata: { state: 'passed', reason: '', evidence: 'metadata aligned' },
  review: { state: 'passed', reason: '', evidence: 'full diff reviewed' },
  verification: { state: 'passed', reason: '', evidence: 'focused tests passed' },
  findings: [],
  confidence: 96,
}

function check(id: number, name: string, conclusion: string, failure: GitHubCheck['failure'] = { _tag: 'NotAsked' }): GitHubCheck {
  return { id, failure, source: { _tag: 'CheckRun', appId: 15368 }, name, status: 'completed', conclusion }
}

/** GitHub reports a lost container as a failed job whose steps never finished. */
const lostRunner = check(2, 'ci / test', 'failure', { _tag: 'RunnerLost', incompleteSteps: 4 })

function reviewTask(pullRequest: GitHubPullRequestItem): ClaimedAdversarialReviewTask {
  return {
    id: 'review-task',
    kind: 'adversarial_review',
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-1',
    state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-19T02:00:00.000Z' },
    updatedAt: '2026-08-19T01:00:00.000Z',
    repositoryMapping: repositoryMapping(),
    pullRequest,
    rerun: { _tag: 'Requested' },
  }
}

interface ReviewProbe {
  comments: string[]
  incidents: RecordIncidentInput[]
  baselineRepairs: number
  runs: RecordReviewRunInput[]
  run: () => Promise<unknown>
}

/** One review worker whose only moving parts are the head and base check runs. */
function reviewWith(input: { headChecks: GitHubCheck[], baseChecks?: GitHubCheck[] }): ReviewProbe {
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  const comments: string[] = []
  const incidents: RecordIncidentInput[] = []
  const runs: RecordReviewRunInput[] = []
  let baselineRepairs = 0
  const snapshot: PullRequestReviewSnapshot = {
    baseChecks: { _tag: 'Available', checks: input.baseChecks ?? [check(1, 'ci / test', 'success')] },
    body: 'Fixes the bug.',
    checks: { _tag: 'Available', checks: input.headChecks },
    comments: [],
    priorAutomatedReview: { _tag: 'None' },
    pullRequest,
    requiredChecks: { _tag: 'Declared', contexts: ['ci / test'] },
    reviews: [],
  }
  const options: ReviewWorkerOptions = {
    runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(cleanReview))),
    github: {
      consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
      ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
      getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
      listPullRequestFiles: () => Promise.reject(new Error('Unexpected file listing.')),
      getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
      getPullRequestReviewSnapshot: () => Promise.resolve(ok(snapshot)),
      upsertIssueTriageComment: () => Promise.reject(new Error('Review must not post issue triage.')),
      upsertReviewStatus: () => Promise.reject(new Error('The Worker must use the status controller.')),
    },
    now: () => new Date('2026-08-19T01:00:00.000Z'),
    store: {
      queueReviewFixTaskForReview: () => { throw new Error('Unexpected Repair queue.') },
      getRepairedHeadFindings: () => [],
      getWorkerSession: () => null,
      isBaselineRepairPullRequest: () => false,
      recordIncident: (incident) => {
        incidents.push(incident)
        return { ...incident, id: 'incident-1', occurrences: 1, firstSeenAt: incident.at, lastSeenAt: incident.at } satisfies Incident
      },
      queueBaselineRepairForReview: () => {
        baselineRepairs += 1
        return { _tag: 'Queued', taskId: 'baseline-task' }
      },
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
  return {
    comments,
    incidents,
    runs,
    run: () => worker.run(reviewTask(pullRequest), new AbortController().signal),
    get baselineRepairs() {
      return baselineRepairs
    },
  }
}

function terminal(comments: string[]): string {
  return comments[comments.length - 1] ?? ''
}

describe('a failing job with no failed step', () => {
  it('reads a killed container as a lost runner', () => {
    expect(classifyFailedJob([
      { conclusion: 'success' },
      { conclusion: null },
      { conclusion: null },
    ])).toEqual({ _tag: 'RunnerLost', incompleteSteps: 2 })
  })

  it('reads a failed step as a genuine failure', () => {
    expect(classifyFailedJob([
      { conclusion: 'success' },
      { conclusion: 'failure' },
      { conclusion: null },
    ])).toEqual({ _tag: 'StepFailed' })
  })

  it('reads a container killed during a step as a genuine failure', () => {
    // An OOM kill inside a step leaves one failed step and no incomplete step.
    // GitHub also loses the log. From here that is a broken build, and it must
    // stay one. Do not widen the lost runner shape to cover it.
    expect(classifyFailedJob([
      { conclusion: 'success' },
      { conclusion: 'failure' },
    ])).toEqual({ _tag: 'StepFailed' })
  })

  it('refuses to guess when no step failed and no step is incomplete', () => {
    expect(classifyFailedJob([{ conclusion: 'success' }])._tag).toBe('Unknown')
    expect(classifyFailedJob([])._tag).toBe('Unknown')
  })
})

describe('a required check that lost its runner', () => {
  it('waits instead of blocking the pull request', async () => {
    const test = reviewWith({ headChecks: [lostRunner] })

    await test.run()

    expect(terminal(test.comments)).toContain('PENDING')
    expect(test.runs[0]?.gates.ci._tag).toBe('Pending')
  })

  it('says the check lost its runner', async () => {
    const test = reviewWith({ headChecks: [lostRunner] })

    await test.run()

    expect(terminal(test.comments)).toContain('ci / test lost its runner')
  })

  it('raises one warning Incident against the repository', async () => {
    const test = reviewWith({ headChecks: [lostRunner] })

    await test.run()

    expect(test.incidents).toEqual([{
      scope: { _tag: 'Repository', repository: 'harlan-zw/example' },
      kind: 'runner_lost',
      severity: 'warning',
      operation: 'read_checks',
      message: RUNNER_LOST_INCIDENT_MESSAGE,
      recovery: { _tag: 'Retrying', attempt: 0, nextAttemptAt: '2026-08-19T01:00:00.000Z' },
      at: '2026-08-19T01:00:00.000Z',
    }])
  })

  it('does not queue a Baseline repair for a base check that lost its runner', async () => {
    const test = reviewWith({
      headChecks: [check(3, 'ci / test', 'success')],
      baseChecks: [check(1, 'ci / test', 'failure', { _tag: 'RunnerLost', incompleteSteps: 4 })],
    })

    await test.run()

    expect(test.baselineRepairs).toBe(0)
    expect(test.incidents).toHaveLength(1)
  })
})

describe('a required check that really failed', () => {
  it('blocks when a step reports failure', async () => {
    const test = reviewWith({ headChecks: [check(2, 'ci / test', 'failure', { _tag: 'StepFailed' })] })

    await test.run()

    expect(terminal(test.comments)).toContain('BLOCKED')
    expect(test.runs[0]?.gates.ci._tag).toBe('Failed')
    expect(test.incidents).toEqual([])
  })

  it('blocks when GitHub does not answer what the steps say', async () => {
    const test = reviewWith({ headChecks: [check(2, 'ci / test', 'failure', { _tag: 'Unknown', reason: 'GitHub returned 500.' })] })

    await test.run()

    expect(terminal(test.comments)).toContain('BLOCKED')
    expect(test.runs[0]?.gates.ci._tag).toBe('Failed')
    expect(test.incidents).toEqual([])
  })

  it('blocks when the controller never read the steps', async () => {
    const test = reviewWith({ headChecks: [check(2, 'ci / test', 'failure')] })

    await test.run()

    expect(terminal(test.comments)).toContain('BLOCKED')
    expect(test.runs[0]?.gates.ci._tag).toBe('Failed')
    expect(test.incidents).toEqual([])
  })
})
