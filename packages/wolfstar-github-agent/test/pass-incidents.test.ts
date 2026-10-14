import { describe, expect, it } from 'vitest'
import { repositoryQuarantineReason } from '../src/github-write-gate.ts'
import { createPassIncidentRecorder, reportAgentCapacity } from '../src/service.ts'
import { openJournalStore } from '../src/store.ts'
import { dashboardSnapshot, issueItem, repositoryMapping } from './fixtures.ts'

const now = () => new Date('2026-08-27T06:00:00.000Z')

describe('reporting live Agent capacity', () => {
  it.each(['Available', 'ReserveReached', 'CapacityUnavailable'] as const)('reports %s from live readings', (state) => {
    const store = openJournalStore(':memory:')
    try {
      store.syncRepositories([repositoryMapping()], now().toISOString())
      store.recordObservation({
        externalId: 'capacity-fixture',
        observedAt: now().toISOString(),
        source: 'poll',
        subject: issueItem({ author: 'wolfstar-project' }),
      })
      const stored = store.getDashboardSnapshot(now().toISOString())
      expect(stored.tasks.some((task) => task.state._tag === 'Queued')).toBe(true)
      const snapshot = dashboardSnapshot({
        ...stored,
        mutationsEnabled: true,
        agentSelection: { _tag: 'Automatic', order: ['codex'] },
        providerCapacities: [
          {
            provider: 'codex',
            reservePercent: 20,
            capacity:
              state === 'CapacityUnavailable'
                ? { _tag: 'Unavailable', reason: 'The provider timed out.' }
                : { _tag: 'Available', usedPercent: state === 'Available' ? 37 : 90, resetsAt: now().toISOString() },
          },
        ],
      })
      const messages: string[] = []
      const record = createPassIncidentRecorder({ now, signal: new AbortController().signal, store })
      record('agent_capacity', ['An earlier reading failed.'])

      reportAgentCapacity(snapshot, {
        log: (message) => messages.push(message),
        record: (errors) => record('agent_capacity', errors),
      })

      expect(store.listIncidents().map((incident) => incident.operation)).toEqual(
        state === 'CapacityUnavailable' ? ['agent_capacity'] : [],
      )
      expect(messages).toEqual(
        state === 'Available'
          ? []
          : [expect.stringContaining(state === 'ReserveReached' ? 'reached its Reserve' : 'did not report a limit')],
      )
    } finally {
      store.close()
    }
  })
})

describe('recording one poll pass failures', () => {
  it('does not project write quarantine as an Incident', () => {
    const store = openJournalStore(':memory:')
    try {
      const record = createPassIncidentRecorder({ now, signal: new AbortController().signal, store })

      record('running_label', [
        `wolfstar-project/example: ${repositoryQuarantineReason('wolfstar-project/example')}`,
        'wolfstar-project/other: GitHub returned 502.',
      ])

      expect(store.listIncidents()).toMatchObject([
        {
          operation: 'running_label',
          message: 'wolfstar-project/other: GitHub returned 502.',
        },
      ])
    } finally {
      store.close()
    }
  })

  it('records what a finished pass failed at', () => {
    const store = openJournalStore(':memory:')
    try {
      const record = createPassIncidentRecorder({ now, signal: new AbortController().signal, store })

      record('stopped_review_comment', ['wolfstar-project/example#1: GitHub returned 502.'])

      expect(store.listIncidents().map((incident) => incident.operation)).toEqual(['stopped_review_comment'])
    } finally {
      store.close()
    }
  })

  it('records nothing for an aborted pass, because a shutdown is not a fault', () => {
    const store = openJournalStore(':memory:')
    try {
      const controller = new AbortController()
      const record = createPassIncidentRecorder({ now, signal: controller.signal, store })
      controller.abort()

      record(
        'stopped_review_comment',
        Array.from({ length: 40 }, (_unused, index) => `wolfstar-project/example#${index}: This operation was aborted`),
      )

      expect(store.listIncidents()).toEqual([])
    } finally {
      store.close()
    }
  })

  it('leaves an Incident an earlier pass recorded, so an abort hides nothing', () => {
    const store = openJournalStore(':memory:')
    try {
      const controller = new AbortController()
      createPassIncidentRecorder({ now, signal: new AbortController().signal, store })('stopped_review_comment', [
        'wolfstar-project/example#1: GitHub returned 502.',
      ])
      controller.abort()
      createPassIncidentRecorder({ now, signal: controller.signal, store })('stopped_review_comment', [])

      expect(store.listIncidents()).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('clears an Incident once a finished pass stops failing', () => {
    const store = openJournalStore(':memory:')
    try {
      const record = createPassIncidentRecorder({ now, signal: new AbortController().signal, store })
      record('stopped_review_comment', ['wolfstar-project/example#1: GitHub returned 502.'])

      record('stopped_review_comment', [])

      expect(store.listIncidents()).toEqual([])
    } finally {
      store.close()
    }
  })
})
