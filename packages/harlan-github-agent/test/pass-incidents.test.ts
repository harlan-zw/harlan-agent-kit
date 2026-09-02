import { describe, expect, it } from 'vitest'
import { repositoryQuarantineReason } from '../src/github-write-gate.ts'
import { createPassIncidentRecorder } from '../src/service.ts'
import { openJournalStore } from '../src/store.ts'

const now = () => new Date('2026-08-27T06:00:00.000Z')

describe('recording one poll pass failures', () => {
  it('does not project write quarantine as an Incident', () => {
    const store = openJournalStore(':memory:')
    try {
      const record = createPassIncidentRecorder({ now, signal: new AbortController().signal, store })

      record('running_label', [
        `harlan-zw/example: ${repositoryQuarantineReason('harlan-zw/example')}`,
        'harlan-zw/other: GitHub returned 502.',
      ])

      expect(store.listIncidents()).toMatchObject([{
        operation: 'running_label',
        message: 'harlan-zw/other: GitHub returned 502.',
      }])
    }
    finally {
      store.close()
    }
  })

  it('records what a finished pass failed at', () => {
    const store = openJournalStore(':memory:')
    try {
      const record = createPassIncidentRecorder({ now, signal: new AbortController().signal, store })

      record('stopped_review_comment', ['harlan-zw/example#1: GitHub returned 502.'])

      expect(store.listIncidents().map(incident => incident.operation)).toEqual(['stopped_review_comment'])
    }
    finally {
      store.close()
    }
  })

  it('records nothing for an aborted pass, because a shutdown is not a fault', () => {
    const store = openJournalStore(':memory:')
    try {
      const controller = new AbortController()
      const record = createPassIncidentRecorder({ now, signal: controller.signal, store })
      controller.abort()

      record('stopped_review_comment', Array.from(
        { length: 40 },
        (_unused, index) => `harlan-zw/example#${index}: This operation was aborted`,
      ))

      expect(store.listIncidents()).toEqual([])
    }
    finally {
      store.close()
    }
  })

  it('leaves an Incident an earlier pass recorded, so an abort hides nothing', () => {
    const store = openJournalStore(':memory:')
    try {
      const controller = new AbortController()
      createPassIncidentRecorder({ now, signal: new AbortController().signal, store })(
        'stopped_review_comment',
        ['harlan-zw/example#1: GitHub returned 502.'],
      )
      controller.abort()
      createPassIncidentRecorder({ now, signal: controller.signal, store })('stopped_review_comment', [])

      expect(store.listIncidents()).toHaveLength(1)
    }
    finally {
      store.close()
    }
  })

  it('clears an Incident once a finished pass stops failing', () => {
    const store = openJournalStore(':memory:')
    try {
      const record = createPassIncidentRecorder({ now, signal: new AbortController().signal, store })
      record('stopped_review_comment', ['harlan-zw/example#1: GitHub returned 502.'])

      record('stopped_review_comment', [])

      expect(store.listIncidents()).toEqual([])
    }
    finally {
      store.close()
    }
  })
})
