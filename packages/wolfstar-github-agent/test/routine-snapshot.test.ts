import { expect, it } from 'vitest'
import { scheduledRoutineRecords } from '../dashboard/app/utils/dashboard.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

it('retains a settled result outside recent runs while a new scan is queued', () => {
  const store = openJournalStore(':memory:')
  const at = '2026-10-01T00:00:00.000Z'
  const routineId = 'wolfstar-project/example:pr-triage'
  try {
    store.syncRepositories([repositoryMapping()], at)
    store.setRepositoryWritesEnabled('wolfstar-project/example', true)
    store.syncRoutines({
      repository: 'wolfstar-project/example',
      specSha: 'abc',
      entries: (['pr-triage', 'daily-checkin'] as const).map((name) => ({
        name,
        crons: ['0 7 * * *'],
        timeZone: 'UTC',
        mode: 'propose',
        enabled: true,
      })),
      at,
    })
    store.openRoutineRun({ routineId, specSha: 'abc', scheduledFor: at, at })
    const claim = store.claimNextRoutineRun('worker', at, 60_000)
    if (claim === null) throw new Error('Expected a Routine claim.')
    store.completeRoutineRun({
      taskId: claim.id,
      workerId: 'worker',
      fence: claim.state.fence,
      at,
      evidence: 'Previous settled result.',
    })
    for (let index = 1; index <= 51; index += 1) {
      const later = new Date(Date.parse(at) + index * 60_000).toISOString()
      store.skipRoutineRun({
        routineId: 'wolfstar-project/example:daily-checkin',
        specSha: 'abc',
        scheduledFor: later,
        at: later,
        reason: 'No work.',
      })
    }
    const later = '2026-10-02T00:00:00.000Z'
    store.openRoutineRun({ routineId, specSha: 'abc', scheduledFor: later, at: later })
    const snapshot = store.getDashboardSnapshot(later)
    expect(
      scheduledRoutineRecords(snapshot.routines, snapshot.routineRuns).find(
        (record) => record.routine.id === routineId,
      ),
    ).toMatchObject({
      latestRun: { state: { _tag: 'Queued' } },
      resultRun: { state: { _tag: 'Completed', evidence: 'Previous settled result.' } },
    })
  } finally {
    store.close()
  }
})
