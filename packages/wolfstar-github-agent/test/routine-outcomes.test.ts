import { describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

describe('routine history retention', () => {
  it('retains the latest weekly run after fifty newer daily runs', () => {
    const store = openJournalStore(':memory:')
    try {
      store.syncRepositories([repositoryMapping()], '2026-10-01T00:00:00.000Z')
      store.syncRoutines({
        repository: 'wolfstar-project/example',
        specSha: 'a',
        at: '2026-10-01T00:00:00.000Z',
        entries: [
          { name: 'ci-review', crons: ['0 7 * * 1'], timeZone: 'UTC', mode: 'propose', enabled: true },
          { name: 'daily-checkin', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true },
        ],
      })
      const weekly = store.openRoutineRun({
        routineId: 'wolfstar-project/example:ci-review',
        scheduledFor: '2026-10-01T00:00:00.000Z',
        specSha: 'a',
        at: '2026-10-01T00:00:00.000Z',
      })!
      for (let day = 1; day <= 51; day++) {
        const at = new Date(Date.parse('2026-10-01T00:00:00.000Z') + day * 86_400_000).toISOString()
        store.openRoutineRun({
          routineId: 'wolfstar-project/example:daily-checkin',
          scheduledFor: at,
          specSha: 'a',
          at,
        })
      }
      expect(
        store.getDashboardSnapshot('2026-12-01T00:00:00.000Z').routineRuns.find((run) => run.id === weekly.id)?.state,
      ).toEqual({ _tag: 'Queued' })
    } finally {
      store.close()
    }
  })
})
