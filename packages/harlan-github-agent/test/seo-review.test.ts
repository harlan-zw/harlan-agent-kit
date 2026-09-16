import { describe, expect, it } from 'vitest'
import { parseRoutineSpec } from '../src/routine-spec.ts'
import { MAXIMUM_REPORT_DETAIL_LENGTH } from '../src/routines/contract.ts'
import { getRoutine } from '../src/routines/index.ts'

const seoReview = getRoutine('seo-review')

describe('seo review Routine', () => {
  it('is accepted in a repository Routine spec', () => {
    const parsed = parseRoutineSpec(`version: 1
routines:
  - name: seo-review
    on:
      schedule:
        - cron: '0 9 * * 2'
    timezone: Australia/Sydney
    mode: propose
    enabled: true
`)
    expect(parsed._tag).toBe('Ok')
  })

  it('refuses a run that returns no report, because an unmatched Site must still be explained', () => {
    const parsed = seoReview.parseResponse({ candidates: [], report: '' })
    expect(parsed._tag).toBe('Err')
  })

  it('refuses a report longer than the issue can hold', () => {
    const parsed = seoReview.parseResponse({ candidates: [], report: 'x'.repeat(MAXIMUM_REPORT_DETAIL_LENGTH + 1) })
    expect(parsed._tag).toBe('Err')
  })

  it('accepts a run that found no repository fix but said why', () => {
    const parsed = seoReview.parseResponse({ candidates: [], report: 'Site s_1 matched https://example.com. 3 actions judged: all Operational.' })
    expect(parsed._tag).toBe('Ok')
  })

  it('names the target in Issue work, so the agent starts where the action points', () => {
    expect(seoReview.issueWork.prompt('app/middleware/redirects.ts')).toContain('app/middleware/redirects.ts')
  })
})
