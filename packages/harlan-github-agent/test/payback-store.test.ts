import type { AgentTurnRecord } from '../src/agent-turn-store.ts'
import type { GitHubIssuePublisher } from '../src/github.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { candidateIssueCommands, createCandidateIssueController } from '../src/candidate-issue-controller.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

const range = { from: '2026-08-13T00:00:00.000Z', to: '2026-08-14T00:00:00.000Z' }

function turn(taskId: string, role: AgentTurnRecord['role']): AgentTurnRecord {
  return {
    id: `turn-${taskId}`,
    taskId,
    role,
    repository: 'harlan-zw/example',
    itemNumber: 24,
    provider: 'codex',
    model: 'gpt-6.1-sol',
    reasoningEffort: null,
    sessionId: 'thread-1',
    startedAt: '2026-08-13T01:01:30.000Z',
    completedAt: '2026-08-13T01:01:50.000Z',
    outcome: 'Answered',
    usage: { _tag: 'Available', input: 10, cachedInput: 5, cacheWrite: 0, output: 1, reasoning: 0 },
    sessionTotal: null,
  }
}

describe('listPaybackTasks', () => {
  it('follows a published conflict resolution to its merged pull request', () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'payback-conflict',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'conflicting' }),
    })
    const task = store.claimNextConflictTask('repair-agent', '2026-08-13T01:01:00.000Z', 10 * 60_000)
    if (task === null)
      throw new Error('Expected conflict resolution work.')
    store.recordAgentTurn(turn(task.id, 'conflict_resolution'))
    store.recordAgentTurn(turn('routine-run-1', 'routine_scan'))
    const staged = store.stagePublication({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:02:00.000Z',
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'resolve_conflict',
        pullRequestNumber: task.pullRequestNumber,
        commitSha: 'resolved-commit',
        baseSha: task.pullRequest.baseSha,
        baseRef: task.pullRequest.baseRef ?? 'main',
        expectedHeadSha: task.pullRequest.headSha,
        headRef: task.pullRequest.headRef,
        artifactRef: 'refs/harlan-github-agent/publications/payback-conflict',
        patchDigest: 'payback-patch',
        changedFiles: 2,
      },
    })
    if (staged._tag !== 'Staged')
      throw new Error(`Expected a staged Publication: ${JSON.stringify(staged)}`)

    const before = store.listPaybackTasks(range)
    expect(before).toHaveLength(2)
    expect(before).toEqual(expect.arrayContaining([
      { taskId: 'routine-run-1', state: null, published: false, pullRequest: 'None' },
      { taskId: task.id, state: 'Publishing', published: false, pullRequest: 'Open' },
    ]))

    const claimed = store.claimNextPublication('publisher', '2026-08-13T01:03:00.000Z', 60_000)
    if (claimed === null)
      throw new Error('Expected the Publication command.')
    store.completePublication({ commandId: claimed.id, workerId: claimed.workerId, fence: claimed.fence, at: '2026-08-13T01:04:00.000Z', evidence: 'Updated pull request #24.' })
    store.recordObservation({
      externalId: 'payback-merged',
      observedAt: '2026-08-13T02:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ state: 'closed', mergedAt: '2026-08-13T01:59:00.000Z', headSha: 'resolved-commit', mergeState: 'clean' }),
    })

    expect(store.listPaybackTasks(range).find(fact => fact.taskId === task.id)).toEqual(expect.objectContaining({
      published: true,
      pullRequest: 'Merged',
    }))
  })
})

describe('listPaybackRoutineRuns', () => {
  const routine = { repository: 'harlan-zw/example', name: 'pr-triage', scheduledFor: '2026-08-13T01:00:00.000Z' } as const
  const routineId = 'harlan-zw/example:pr-triage'
  const found = `${routineId}:2026-08-13T01:00:00.000Z`
  const quiet = `${routineId}:2026-08-13T02:00:00.000Z`

  function publisher(): GitHubIssuePublisher {
    return {
      updateIssue: async () => ok(undefined),
      findOpenIssueByFingerprint: () => Promise.resolve(ok(null)),
      findOpenIssueByMarker: () => Promise.resolve(ok(null)),
      findFollowUpIssues: async () => ok([]),
      findRoutineTrackingIssue: () => Promise.resolve(ok(null)),
      findIssueCommentByMarker: () => Promise.resolve(ok(null)),
      createComment: async () => ok({ id: 1 }),
      createIssue: async () => ok({ number: 101, url: 'https://github.com/harlan-zw/example/issues/101' }),
    }
  }

  it('names the Routine of each spent run and counts its Candidates by result', async () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.setRepositoryWritesEnabled('harlan-zw/example', true)
    store.syncRoutines({
      repository: 'harlan-zw/example',
      specSha: 'abc123',
      entries: [{ name: 'pr-triage', crons: ['0 * * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
      at: '2026-08-13T00:00:00.000Z',
    })
    for (const scheduledFor of ['2026-08-13T01:00:00.000Z', '2026-08-13T02:00:00.000Z'])
      store.openRoutineRun({ routineId, scheduledFor, specSha: 'abc123', at: scheduledFor })
    const proposal = { title: 'Unused helper', target: 'src/a.ts', claim: 'Never called.', verification: 'pnpm test', estimatedChangedFiles: 1 }
    store.recordCandidates({
      routineId,
      runId: found,
      candidates: [{ ...proposal, fingerprint: 'src/a.ts#rejected' }, { ...proposal, fingerprint: 'src/a.ts#pending' }],
      at: '2026-08-13T01:00:30.000Z',
    })
    const rejected = store.listCandidates(routineId).filter(candidate => candidate.fingerprint === 'src/a.ts#rejected')
    store.stageCandidateIssues({ commands: candidateIssueCommands(rejected, routine), at: '2026-08-13T01:01:00.000Z' })
    const at = () => new Date('2026-08-13T01:02:00.000Z')
    await createCandidateIssueController({ github: publisher(), now: at, store, workerId: 'publisher' }).publishPending(new AbortController().signal)
    store.recordObservation({ externalId: 'rejected', observedAt: '2026-08-13T01:03:00.000Z', source: 'poll', subject: issueItem({ number: 101, state: 'closed', closureReason: 'not_planned', closureDetail: 'Expected.' }) })
    store.reconcileRoutineCandidates('2026-08-13T01:04:00.000Z')
    store.recordAgentTurn(turn(found, 'routine_scan'))
    store.recordAgentTurn(turn(quiet, 'routine_scan'))
    store.recordAgentTurn(turn('run-the-journal-lost', 'routine_scan'))
    store.recordAgentTurn(turn('task-1', 'issue_work'))

    expect(store.listPaybackRoutineRuns(range)).toEqual([
      { runId: found, work: { _tag: 'Routine', name: 'pr-triage' }, mode: 'propose', state: 'Queued', candidates: { merged: 0, open: 1, closed: 1 } },
      { runId: quiet, work: { _tag: 'Routine', name: 'pr-triage' }, mode: 'propose', state: 'Queued', candidates: { merged: 0, open: 0, closed: 0 } },
    ])
  })
})
