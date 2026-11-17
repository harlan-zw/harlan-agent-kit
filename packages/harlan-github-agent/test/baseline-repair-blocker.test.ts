import type { FailedJobContext, GitHubCheck } from '../src/github-agent-source.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { retireObsoleteBaselineRepairs } from '../src/baseline-repair-sweep.ts'
import { createBaselineRepairWorker } from '../src/baseline-repair-worker.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { runClaimedTask } from '../src/task-scheduler.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

const at = (minute: number) => new Date(Date.parse('2026-11-09T03:00:00Z') + minute * 60_000).toISOString()
const blocked = {
  outcome: 'blocked',
  summary: 'Cause unknown. Read-only checks confirm the failed revision is active and both temporary canaries are absent. The private journal returns HTTP 404. Reproduction requires prohibited production writes. No code changed.',
  checks: ['pnpm db:plan'],
  commitMessage: '',
  pullRequestTitle: '',
  pullRequestBody: '',
}
const deployCheck: GitHubCheck = { id: 128969098035, name: 'deploy', status: 'completed', conclusion: 'failure', failure: { _tag: 'NotAsked' }, source: { _tag: 'CheckRun', appId: 15368 } }

interface FailingCommit {
  baseSha: string
  headSha?: string
  failedStep?: string
  /** Each run has its own run id and log, even when the failure is the same. */
  runId: number
}

function setup() {
  const store = openJournalStore(':memory:', true)
  stores.push(store)
  const mapping = repositoryMapping()
  store.syncRepositories([mapping], at(0))
  store.setRepositoryWritesEnabled(mapping.github, true)
  return { store, mapping }
}

/** One red default branch commit, from gate refresh to the end of its Baseline repair. */
async function repairCommit(fixture: ReturnType<typeof setup>, minute: number, commit: FailingCommit) {
  const { store, mapping } = fixture
  const observed = store.recordObservation({
    externalId: `${commit.baseSha}:${commit.headSha ?? 'abc123'}`,
    observedAt: at(minute),
    source: 'poll',
    subject: pullRequestItem({ baseSha: commit.baseSha, headSha: commit.headSha ?? 'abc123', mergeState: 'clean', updatedAt: at(minute) }),
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a new pull request Revision.')
  const queued = store.queueBaselineRepairForGate({ repository: mapping.github, pullRequestNumber: 24, revisionId: observed.revisionId, baseSha: commit.baseSha, at: at(minute + 1) })
  expect(queued._tag).toBe('Queued')
  const task = store.claimNextBaselineRepairTask('baseline-agent', at(minute + 2), 600_000)
  if (task === null)
    throw new Error('Expected the Baseline repair Task.')
  const job: FailedJobContext = {
    runId: commit.runId,
    jobName: 'deploy',
    failedStep: commit.failedStep ?? 'Publish private native database companion',
    logTail: [`run ${commit.runId}`, 'Error: activation response lost'],
  }
  let agentTurns = 0
  const provider = stubProvider(turnEvents(blocked))
  const worker = createBaselineRepairWorker({
    runtime: agentRuntime(CODEX_AGENT_PROFILE, { ...provider, runTurn: (request) => {
      agentTurns += 1
      return provider.runTurn(request)
    } }),
    github: {
      findOpenPullRequestForBranch: () => Promise.resolve(ok(null)),
      getFailedJobContext: () => Promise.resolve(ok(job)),
      getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
      getDefaultBranchSnapshot: () => Promise.resolve(ok({ baseSha: commit.baseSha, baseChecks: { _tag: 'Available', checks: [{ ...deployCheck, id: commit.runId }] } })),
    },
    inspectWorkspace: () => Promise.resolve({ hasAgentsFile: false, nodeOptions: null }),
    now: () => new Date(at(minute + 3)),
    store,
    validateMapping: value => Promise.resolve(ok(value)),
    worktrees: {
      prepare: () => Promise.resolve(ok({ path: '/tmp/baseline-worktree', baseSha: commit.baseSha, headSha: commit.baseSha })),
      verify: () => Promise.reject(new Error('A blocked Agent never reaches verification.')),
      commit: () => Promise.reject(new Error('A blocked Agent never commits.')),
    },
  })
  const errors: unknown[] = []
  const result = await runClaimedTask(task, {
    leaseMilliseconds: 600_000,
    now: () => new Date(at(minute + 4)),
    onError: error => errors.push(error),
    store,
    worker,
    workerId: 'baseline-agent',
  })
  expect(errors).toEqual([])
  return { result, agentTurns, taskId: task.id }
}

/** The default branch moved on, as it did between every Baseline repair of gscdump.com#1094. */
async function moveDefaultBranch(fixture: ReturnType<typeof setup>, minute: number, baseSha: string) {
  const retired = await retireObsoleteBaselineRepairs({
    store: fixture.store,
    repository: fixture.mapping,
    now: () => new Date(at(minute)),
    github: { getDefaultBranchSnapshot: () => Promise.resolve(ok({ baseSha, baseChecks: { _tag: 'Available', checks: [] } })) },
  }, new AbortController().signal)
  expect(retired).toEqual(ok(1))
}

describe('repeated Baseline repair blocker', () => {
  // gscdump.com#1094: 8 of 12 blocked Agent turns stopped at deploy, "Publish private native database companion".
  it('keeps the Agent blocker for the next red default branch commit with the same failed step', async () => {
    const fixture = setup()
    const first = await repairCommit(fixture, 0, { baseSha: '785fcfae3241e8c56ebc8ce84f70a57bb64376d3', runId: 1 })
    expect(first).toMatchObject({ agentTurns: 1, result: { _tag: 'ActionRequired', reason: blocked.summary } })
    await moveDefaultBranch(fixture, 10, 'fe9c3f033fc8de4291dc74d587b93fcb70aa5277')

    const second = await repairCommit(fixture, 20, { baseSha: 'fe9c3f033fc8de4291dc74d587b93fcb70aa5277', runId: 2 })

    expect(second.agentTurns).toBe(0)
    expect(second.result).toEqual({ _tag: 'ActionRequired', reason: expect.stringContaining(blocked.summary) })
    const task = fixture.store.getDashboardSnapshot(at(30)).tasks.find(value => value.id === second.taskId)
    expect(task?.state).toEqual({ _tag: 'ActionRequired', reason: expect.stringContaining(blocked.summary) })
    expect(fixture.store.listIncidents().filter(incident => incident.scope._tag === 'Task' && incident.scope.taskId === second.taskId)).toHaveLength(1)
  })

  it.each([
    { change: 'a different failed step', commit: { baseSha: 'fe9c3f033fc8de4291dc74d587b93fcb70aa5277', runId: 2, failedStep: 'Run pnpm db:migrate' } },
    { change: 'a new pull request head commit', commit: { baseSha: 'fe9c3f033fc8de4291dc74d587b93fcb70aa5277', runId: 2, headSha: 'new-head' } },
  ])('starts a new Agent turn for $change', async ({ commit }) => {
    const fixture = setup()
    expect((await repairCommit(fixture, 0, { baseSha: '785fcfae3241e8c56ebc8ce84f70a57bb64376d3', runId: 1 })).agentTurns).toBe(1)
    await moveDefaultBranch(fixture, 10, 'fe9c3f033fc8de4291dc74d587b93fcb70aa5277')

    expect((await repairCommit(fixture, 20, commit)).agentTurns).toBe(1)
  })
})
