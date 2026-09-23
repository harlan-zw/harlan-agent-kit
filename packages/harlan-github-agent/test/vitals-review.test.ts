import type { LabScan } from '../src/routines/vitals-review.ts'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRoutineSpec } from '../src/routine-spec.ts'
import { getRoutine } from '../src/routines/index.ts'
import { createVitalsReview, judgeLabScans, labVerification, parseScanRows } from '../src/routines/vitals-review.ts'

// Real `nuxtseo scans list --json` rows for nuxtseo.com, captured 2026-09-23.
// The scheduler scans desktop on Sundays and mobile on Tuesdays, so the list
// alternates between LCP 1.1 s and LCP 8 s for one page.
const mixedStrategy = JSON.parse(readFileSync(new URL('./fixtures/nuxtseo-scans-mixed-strategy.json', import.meta.url), 'utf8')) as { data: { scans: unknown[] } }

function parsedFixture(): LabScan[] {
  const parsed = parseScanRows(mixedStrategy.data.scans)
  if (parsed._tag === 'Err')
    throw new Error(parsed.error)
  return parsed.value
}

function scan(day: number, lcp: number, strategy: 'mobile' | 'desktop' = 'desktop', url = 'https://example.com/blog'): Record<string, unknown> {
  return {
    url,
    strategy,
    status: 'complete',
    completedAt: `2026-09-${String(day).padStart(2, '0')}T06:00:00.000Z`,
    lcp,
    tbt: 50,
    cls: 0,
    fcp: null,
  }
}

function scans(rows: Record<string, unknown>[]): LabScan[] {
  const parsed = parseScanRows(rows)
  if (parsed._tag === 'Err')
    throw new Error(parsed.error)
  return parsed.value
}

function verdictFor(judged: ReturnType<typeof judgeLabScans>, path: string, strategy: string, metric: string) {
  return judged.find(entry => entry.path === path && entry.strategy === strategy && entry.metric === metric)?.verdict
}

const proposal = {
  title: 'Preload the blog hero image',
  target: 'app/pages/blog/index.vue',
  claim: 'The hero image is lazy loaded.',
  verification: 'pnpm build',
  estimatedChangedFiles: 1,
}

function fieldFinding(overrides: Record<string, unknown> = {}) {
  return {
    finding: {
      metric: 'lcp',
      severity: 'poor',
      p75: 4300,
      route: '/blog',
      selector: 'main > img.hero',
      estimatedViews: 1840,
      fixPrompt: 'The LCP element on /blog is main > img.hero at 4300ms.',
      ...overrides,
    },
    labCls: null,
    ...proposal,
  }
}

function answer(input: { fieldFindings?: unknown[], labFindings?: unknown[] }) {
  return { report: 'Site s_1 matched https://example.com.', fieldFindings: input.fieldFindings ?? [], labFindings: input.labFindings ?? [] }
}

describe('vitals review Routine', () => {
  it('is accepted in a repository Routine spec', () => {
    const parsed = parseRoutineSpec(`version: 1
routines:
  - name: vitals-review
    on:
      schedule:
        - cron: '0 9 * * 3'
    mode: report
`)
    expect(parsed._tag).toBe('Ok')
  })

  it('refuses a run that returns no report', () => {
    expect(getRoutine('vitals-review').parseResponse({ report: '', fieldFindings: [], labFindings: [] })._tag).toBe('Err')
  })
})

describe('lab series', () => {
  it('never reads a mixed desktop and mobile list as a drop', () => {
    const judged = judgeLabScans(parsedFixture())
    expect(judged.length).toBeGreaterThan(0)
    expect(judged.filter(entry => entry.verdict._tag === 'Drop')).toEqual([])
  })

  it('calls mobile LCP persistently Poor, and desktop LCP on the same page steady', () => {
    const judged = judgeLabScans(parsedFixture())
    expect(verdictFor(judged, '/', 'mobile', 'lcp')?._tag).toBe('Poor')
    expect(verdictFor(judged, '/', 'desktop', 'lcp')?._tag).toBe('Steady')
    expect(verdictFor(judged, '/tools/schema-validator', 'mobile', 'lcp')?._tag).toBe('Poor')
    expect(verdictFor(judged, '/tools/schema-validator', 'desktop', 'lcp')?._tag).toBe('Steady')
  })

  it('folds a trailing slash, so the origin and / are one page', () => {
    const judged = judgeLabScans(scans([scan(1, 1100, 'desktop', 'https://example.com'), scan(2, 1100, 'desktop', 'https://example.com/')]))
    expect(judged.filter(entry => entry.metric === 'lcp').map(entry => entry.path)).toEqual(['/'])
  })

  it('files nothing for a flapping series, whose reference Scans disagree with each other', () => {
    // Homepage desktop TBT swings between 143 ms and 1129 ms with no deploy.
    const verdict = verdictFor(judgeLabScans(parsedFixture()), '/', 'desktop', 'tbt')
    expect(verdict?._tag).toBe('Unstable')
  })

  it('confirms a drop that persists across two Scans, and names where it started', () => {
    const judged = judgeLabScans(scans([scan(1, 1100), scan(2, 1150), scan(3, 1120), scan(4, 1100), scan(5, 2600), scan(6, 2700)]))
    const verdict = verdictFor(judged, '/blog', 'desktop', 'lcp')
    expect(verdict).toMatchObject({ _tag: 'Drop', since: '2026-09-05T06:00:00.000Z', lastReferenceAt: '2026-09-04T06:00:00.000Z', scans: 2 })
  })

  it('holds a single worse Scan as a Suspect', () => {
    const judged = judgeLabScans(scans([scan(1, 1100), scan(2, 1150), scan(3, 1120), scan(4, 1100), scan(5, 2600)]))
    expect(verdictFor(judged, '/blog', 'desktop', 'lcp')?._tag).toBe('Suspect')
  })

  it('drops nothing once the page recovers', () => {
    const judged = judgeLabScans(scans([scan(1, 1100), scan(2, 1150), scan(3, 2600), scan(4, 2700), scan(5, 1100)]))
    expect(verdictFor(judged, '/blog', 'desktop', 'lcp')?._tag).toBe('Steady')
  })

  it('refuses to judge a drop with fewer than two reference Scans', () => {
    const judged = judgeLabScans(scans([scan(1, 1100), scan(2, 2600), scan(3, 2700)]))
    expect(verdictFor(judged, '/blog', 'desktop', 'lcp')?._tag).toBe('ShortSeries')
  })

  it('skips a failed Scan instead of reading it as a gap in the drop', () => {
    const rows = [scan(1, 1100), scan(2, 1150), scan(3, 1120), scan(4, 2600), { ...scan(5, 0), status: 'failed', lcp: null }, scan(6, 2700)]
    expect(verdictFor(judgeLabScans(scans(rows)), '/blog', 'desktop', 'lcp')?._tag).toBe('Drop')
  })

  it('refuses a scan list that is not the CLI shape', () => {
    expect(parseScanRows([{ url: 'https://example.com', strategy: 'tablet', status: 'complete', completedAt: '2026-09-01T00:00:00.000Z' }])._tag).toBe('Err')
  })
})

describe('lab verification', () => {
  it.each([
    ['lcp', null, 'Lab'],
    ['inp', null, 'FieldOnly'],
    ['cls', 0, 'FieldOnly'],
    ['cls', null, 'FieldOnly'],
    ['cls', 0.22, 'Lab'],
  ] as const)('%s with lab CLS %s verifies in %s', (metric, labCls, tag) => {
    expect(labVerification(metric, labCls)._tag).toBe(tag)
  })
})

describe('field findings', () => {
  it('files one Candidate for a Poor finding above the view floor', () => {
    const parsed = createVitalsReview({ minimumViews: 200 }).parseResponse(answer({ fieldFindings: [fieldFinding()] }))
    expect(parsed._tag).toBe('Ok')
    if (parsed._tag === 'Ok')
      expect(parsed.value.candidates.map(candidate => candidate.fingerprint)).toEqual(['vitals-field#/blog#lcp#main > img.hero'])
  })

  it.each([
    ['below the view floor', { estimatedViews: 199 }],
    ['rated needs-improvement', { severity: 'needs-improvement' }],
  ])('files nothing for a finding %s, and says why in the report', (_label, overrides) => {
    const parsed = createVitalsReview({ minimumViews: 200 }).parseResponse(answer({ fieldFindings: [fieldFinding(overrides)] }))
    expect(parsed._tag).toBe('Ok')
    if (parsed._tag === 'Ok') {
      expect(parsed.value.candidates).toEqual([])
      expect(parsed.value.report).toContain('/blog')
    }
  })

  it('takes the view floor from its configuration', () => {
    const parsed = createVitalsReview({ minimumViews: 5000 }).parseResponse(answer({ fieldFindings: [fieldFinding()] }))
    expect(parsed._tag === 'Ok' && parsed.value.candidates).toEqual([])
  })

  it('gives one element on one page one fingerprint, however the selector is spaced', () => {
    const parsed = createVitalsReview({ minimumViews: 200 }).parseResponse(answer({
      fieldFindings: [fieldFinding(), fieldFinding({ selector: 'main  >  img.hero ', estimatedViews: 900 }), fieldFinding({ route: '/blog/' })],
    }))
    expect(parsed._tag === 'Ok' && parsed.value.candidates.length).toBe(1)
  })

  it('keeps two elements on one page apart', () => {
    const parsed = createVitalsReview({ minimumViews: 200 }).parseResponse(answer({
      fieldFindings: [fieldFinding(), fieldFinding({ selector: 'header > nav' })],
    }))
    expect(parsed._tag === 'Ok' && parsed.value.candidates.length).toBe(2)
  })

  it('tells Issue work to skip lab verification when lab CLS is near zero', () => {
    const parsed = createVitalsReview({ minimumViews: 200 }).parseResponse(answer({
      fieldFindings: [{ ...fieldFinding({ metric: 'cls', p75: 0.31 }), labCls: 0 }],
    }))
    expect(parsed._tag).toBe('Ok')
    if (parsed._tag === 'Ok')
      expect(parsed.value.candidates[0]?.claim).toContain('Skip lab verification')
  })

  it('refuses a finding that is not the CLI shape', () => {
    expect(createVitalsReview({ minimumViews: 200 }).parseResponse(answer({ fieldFindings: [fieldFinding({ metric: 'ttfb' })] }))._tag).toBe('Err')
  })
})

describe('lab findings', () => {
  const rows = (mixedStrategy.data.scans as Array<{ url: string }>).filter(row => row.url === 'https://nuxtseo.com')

  function labFinding(overrides: Record<string, unknown> = {}) {
    return { url: 'https://nuxtseo.com/', strategy: 'mobile', metric: 'lcp', scans: rows, suspectCommits: '', ...proposal, ...overrides }
  }

  it('files a persistently Poor mobile page, keyed on page, strategy, and metric', () => {
    const parsed = createVitalsReview({ minimumViews: 200 }).parseResponse(answer({ labFindings: [labFinding()] }))
    expect(parsed._tag === 'Ok' && parsed.value.candidates.map(candidate => candidate.fingerprint)).toEqual(['vitals-lab#/#mobile#lcp'])
  })

  it('files nothing for a proposal the series does not support', () => {
    const parsed = createVitalsReview({ minimumViews: 200 }).parseResponse(answer({ labFindings: [labFinding({ strategy: 'desktop' })] }))
    expect(parsed._tag).toBe('Ok')
    if (parsed._tag === 'Ok') {
      expect(parsed.value.candidates).toEqual([])
      expect(parsed.value.report).toContain('Steady')
    }
  })

  it('merges two proposals for one page, strategy, and metric', () => {
    const parsed = createVitalsReview({ minimumViews: 200 }).parseResponse(answer({ labFindings: [labFinding(), labFinding({ url: 'https://nuxtseo.com' })] }))
    expect(parsed._tag === 'Ok' && parsed.value.candidates.length).toBe(1)
  })

  it('refuses a drop that names no suspect commits', () => {
    const dropRows = [scan(1, 1100), scan(2, 1150), scan(3, 1120), scan(4, 2600), scan(5, 2700)]
    const review = createVitalsReview({ minimumViews: 200 })
    const missing = review.parseResponse(answer({ labFindings: [labFinding({ url: 'https://example.com/blog', strategy: 'desktop', scans: dropRows })] }))
    expect(missing._tag === 'Ok' && missing.value.candidates).toEqual([])
    const named = review.parseResponse(answer({ labFindings: [labFinding({ url: 'https://example.com/blog', strategy: 'desktop', scans: dropRows, suspectCommits: 'a1b2c3d..e4f5a6b' })] }))
    expect(named._tag === 'Ok' && named.value.candidates.map(candidate => candidate.fingerprint)).toEqual(['vitals-lab#/blog#desktop#lcp'])
  })
})
