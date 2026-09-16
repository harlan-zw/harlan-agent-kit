import { describe, expect, it } from 'vitest'
import { getRoutine, ROUTINE_NAMES } from '../src/routines/index.ts'
import { perfReview, refusesMeasurementChange } from '../src/routines/perf-review.ts'

describe('perf review Routine', () => {
  it('is selectable by name, so repository YAML may enable it', () => {
    expect(ROUTINE_NAMES).toContain('perf-review')
    expect(getRoutine('perf-review')).toBe(perfReview)
  })

  it('allows Issue work that repairs the cause', () => {
    const verified = refusesMeasurementChange(['packages/engine/src/hyparquet/decode.ts'])
    expect(verified._tag).toBe('Ok')
  })

  it('refuses Issue work that weakens the Benchmark instead of fixing the code', () => {
    // The whole failure mode: make the number go away by measuring less.
    const verified = refusesMeasurementChange(['perf/benchmarks.json'])
    expect(verified._tag).toBe('Err')
    if (verified._tag === 'Err')
      expect(verified.error).toContain('perf/benchmarks.json')
  })

  it('refuses a change to the harness or a case file', () => {
    expect(refusesMeasurementChange(['scripts/perf/run.mjs'])._tag).toBe('Err')
    expect(refusesMeasurementChange(['scripts/perf/cases/decode-parquet.mjs'])._tag).toBe('Err')
  })

  it('names every refused path, so one sweep fixes the pull request', () => {
    const verified = refusesMeasurementChange(['src/a.ts', 'perf/benchmarks.json', 'scripts/perf/run.mjs'])
    expect(verified._tag).toBe('Err')
    if (verified._tag === 'Err') {
      expect(verified.error).toContain('perf/benchmarks.json')
      expect(verified.error).toContain('scripts/perf/run.mjs')
      expect(verified.error).not.toContain('src/a.ts')
    }
  })

  it('does not refuse a path that merely starts with the same letters', () => {
    expect(refusesMeasurementChange(['performance-notes.md'])._tag).toBe('Ok')
    expect(refusesMeasurementChange(['scripts/perfect.ts'])._tag).toBe('Ok')
  })

  it('refuses a report that arrives empty, because a run must always say what it judged', () => {
    const parsed = perfReview.parseResponse({ candidates: [], report: '' })
    expect(parsed._tag).toBe('Err')
  })

  it('accepts a run that judged nothing but said so', () => {
    const parsed = perfReview.parseResponse({ candidates: [], report: 'Only 3 usable Measurements for engine/decode. Judged nothing.' })
    expect(parsed._tag).toBe('Ok')
  })
})
