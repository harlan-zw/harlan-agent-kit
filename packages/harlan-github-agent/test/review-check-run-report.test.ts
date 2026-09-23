import { describe, expect, it } from 'vitest'
import { err } from '../src/result.ts'
import { reviewCheckRunOutcome } from '../src/review-check-run.ts'
import { createReviewCheckRunReport } from '../src/service.ts'
import { openJournalStore } from '../src/store.ts'

const now = () => new Date('2026-09-22T06:00:00.000Z')
const refusal = 'The level of access for permissions requested are not granted to this installation.'

describe('reporting Review check run writes', () => {
  it('files repeated refusals as one Incident that names the missing permission', () => {
    const store = openJournalStore(':memory:')
    try {
      const report = createReviewCheckRunReport(store, now)
      const refused = reviewCheckRunOutcome(err(refusal))

      report('harlan-zw/example', refused)
      report('harlan-zw/example', refused)

      expect(store.listIncidents()).toMatchObject([{
        operation: 'review_check_run',
        kind: 'installation_access',
        occurrences: 2,
        recovery: { _tag: 'ActionRequired' },
        message: expect.stringContaining('checks: write'),
      }])
    }
    finally {
      store.close()
    }
  })

  it('clears the Incident once a check run write lands', () => {
    const store = openJournalStore(':memory:')
    try {
      const report = createReviewCheckRunReport(store, now)

      report('harlan-zw/example', reviewCheckRunOutcome(err(refusal)))
      report('harlan-zw/example', { _tag: 'Written' })

      expect(store.listIncidents()).toEqual([])
    }
    finally {
      store.close()
    }
  })
})
