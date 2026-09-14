import { afterEach, expect, it } from 'vitest'
import { queueAttention } from '../dashboard/app/utils/attention.ts'
import { humanDecisionEntries } from '../dashboard/app/utils/dashboard.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
const at = '2026-09-14T00:00:00.000Z'
const later = '2026-09-14T00:01:00.000Z'
const repository = 'harlan-zw/example'

afterEach(() => stores.splice(0).forEach(store => store.close()))

it.each([
  { scope: 'repository', batch: false },
  { scope: 'repository', batch: true },
  { scope: 'global', batch: false },
  { scope: 'global', batch: true },
])('surfaces the $scope limit for issue work, batch=$batch, and clears it when capacity returns', ({ scope, batch }) => {
  const store = openJournalStore(':memory:', false, undefined, scope === 'global' ? 1 : 8)
  stores.push(store)
  store.syncRepositories([repositoryMapping({ maxOpenPullRequests: scope === 'repository' ? 1 : null })], at)
  const numbers = batch ? [101, 102] : [101]
  for (const number of numbers) {
    store.recordObservation({
      externalId: `issue-${number}`,
      observedAt: at,
      source: 'poll',
      subject: issueItem({ number, author: 'harlan-zw', routineFiled: true }),
    })
    const triage = store.claimNextIssueTriageTask('triage', at, 60_000)!
    store.completeWorkerTask({
      taskId: triage.id,
      workerId: triage.state.workerId,
      fence: triage.state.fence,
      at,
      evidence: JSON.stringify({ _tag: 'READY_TO_IMPLEMENT', difficulty: 1, impact: 3, hasReproduction: true, needsCodebaseReview: false, summary: 'Fix the issue.', nextAction: 'Apply the fix.', relatedIssues: [] }),
    })
  }
  if (batch)
    store.planBatches(at)
  const pullRequest = pullRequestItem({ controllerOwned: true, mergeState: 'clean' })
  store.recordObservation({ externalId: 'open', observedAt: at, source: 'poll', subject: pullRequest })

  expect(store.claimNextIssueWorkTask('work', at, 60_000)).toBeNull()
  const blocked = store.getDashboardSnapshot(at)
  expect(humanDecisionEntries(blocked).filter(entry => entry.kind === 'issue').map(entry => entry.number)).toEqual(numbers)
  expect(blocked.queue.find(entry => entry.number === 101)?.state).toEqual({
    _tag: 'ActionRequired',
    reason: scope === 'repository'
      ? `${repository} has 1 open automated pull request; its limit is 1. Merge or close a pull request to start Issue work.`
      : 'The service has 1 open automated pull request; its limit is 1. Merge or close a pull request to start Issue work.',
  })

  const entry = blocked.queue.find(entry => entry.number === 101)!
  expect(queueAttention(entry, blocked)).toMatchObject({
    owner: 'You',
    blocker: 'Open pull request limit',
    summary: entry.state._tag === 'ActionRequired' ? entry.state.reason : '',
  })

  store.setSelectionMode('manual')
  expect(humanDecisionEntries(store.getDashboardSnapshot(at)).filter(entry => entry.kind === 'issue')).toEqual([])
  store.setSelectionMode('auto')

  // The limit is a live condition. Clearing it needs no Approval or Task reset.
  store.recordObservation({ externalId: 'closed', observedAt: later, source: 'poll', subject: { ...pullRequest, state: 'closed', updatedAt: later } })
  expect(humanDecisionEntries(store.getDashboardSnapshot(later)).filter(entry => entry.kind === 'issue')).toEqual([])
  if (batch)
    expect(store.claimNextBatch('batch', later, 60_000)?.repository).toBe(repository)
  else
    expect(store.claimNextIssueWorkTask('work', later, 60_000)?.issueNumber).toBe(101)
})
