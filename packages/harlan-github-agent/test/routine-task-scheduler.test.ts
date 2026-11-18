import { describe, expect, it } from 'vitest'
import { createAgentPermitPool } from '../src/agent-permit-pool.ts'
import { ok } from '../src/result.ts'
import { createRoutineTaskScheduler } from '../src/routine-task-scheduler.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

const at = '2026-11-16T07:00:00.000Z'

describe('controller Routine admission', () => {
  it.each(['provider unavailable', 'Agent permits occupied', 'Paused', 'restart pending'] as const)('admits only permitted work when %s', async (blocked) => {
    const store = openJournalStore(':memory:')
    const permits = createAgentPermitPool(1)
    const occupied = blocked === 'Agent permits occupied' ? permits.tryAcquire() : null
    const executed: string[] = []
    store.syncRepositories([repositoryMapping()], at)
    store.syncRoutines({ repository: 'harlan-zw/example', specSha: 'abc123', at, entries: ['pr-triage', 'ready-digest'].map(name => ({ name: name as 'pr-triage' | 'ready-digest', crons: ['0 7 * * 1'], timeZone: 'UTC', mode: 'report', enabled: true })) })
    for (const routine of store.listRoutines())
      store.openRoutineRun({ routineId: routine.id, specSha: 'abc123', scheduledFor: at, at })
    const scheduler = createRoutineTaskScheduler({
      canClaim: () => blocked !== 'Paused' && blocked !== 'restart pending',
      canStartAgent: () => blocked !== 'provider unavailable',
      store,
      complete: store.completeRoutineRun,
      fail: store.failRoutineRun,
      heartbeat: store.heartbeatRoutineRun,
      intervalMilliseconds: 5_000,
      leaseMilliseconds: 60_000,
      now: () => new Date(at),
      onError: (error) => { throw error },
      permits,
      workerId: 'routine-worker',
      worker: { run: async (task) => {
        executed.push(task.name)
        return ok({ evidence: 'Completed fixture.', usage: { _tag: 'Unavailable' as const } })
      } },
    })
    try {
      await scheduler.runNow()
      const allowed = blocked !== 'Paused' && blocked !== 'restart pending'
      expect(executed).toEqual(allowed ? ['ready-digest'] : [])
      expect(store.listRoutineRuns('harlan-zw/example:ready-digest')[0]?.state._tag).toBe(allowed ? 'Completed' : 'Queued')
      expect(store.listRoutineRuns('harlan-zw/example:pr-triage')[0]?.state._tag).toBe('Queued')
    }
    finally {
      await scheduler.stop()
      occupied?.release()
      store.close()
    }
  })
})
