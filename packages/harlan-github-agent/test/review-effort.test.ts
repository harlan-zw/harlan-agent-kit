import type { PullRequestFile } from '../src/merge-risk.ts'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyReviewReasoningEffortBand, DEFAULT_REVIEW_REASONING_EFFORT_POLICY, reviewReasoningEffortBand } from '../src/review-effort.ts'

function file(path: string, additions = 1, deletions = 0): PullRequestFile {
  return { path, status: 'modified', additions, deletions, previousFilename: null }
}

describe('review reasoning effort band', () => {
  it('reviews a small, ordinary change at low', () => {
    const band = reviewReasoningEffortBand([file('src/text.ts', 8, 2), file('test/text.test.ts', 12)])
    expect(band.effort).toBe('low')
  })

  it('reviews a change an agent reads as instructions at high', () => {
    const band = reviewReasoningEffortBand([file('AGENTS.md', 3)])
    expect(band.effort).toBe('high')
    expect(band.reason).toContain('AGENTS.md')
  })

  it('reviews a sensitive path for this repository at high, whatever its size', () => {
    const band = reviewReasoningEffortBand(
      [file('server/auth.ts', 2)],
      { ...DEFAULT_REVIEW_REASONING_EFFORT_POLICY, sensitivePaths: ['server/**'] },
    )
    expect(band.effort).toBe('high')
  })

  it('reviews a wide change at high', () => {
    const band = reviewReasoningEffortBand([file('src/app.ts', 700, 40)])
    expect(band.effort).toBe('high')
  })

  it('reviews a middling change at medium', () => {
    const band = reviewReasoningEffortBand([file('src/app.ts', 150, 20)])
    expect(band.effort).toBe('medium')
  })

  it('reviews at high when the changed files could not be read', () => {
    expect(reviewReasoningEffortBand(null).effort).toBe('high')
    expect(reviewReasoningEffortBand([]).effort).toBe('high')
  })
})

describe('applying the band to the agent default', () => {
  it('lowers the default', () => {
    expect(applyReviewReasoningEffortBand('high', 'low')).toBe('low')
  })

  it('never raises it', () => {
    expect(applyReviewReasoningEffortBand('low', 'high')).toBe('low')
    expect(applyReviewReasoningEffortBand('medium', 'high')).toBe('medium')
  })

  it('leaves a default outside the three bands alone', () => {
    expect(applyReviewReasoningEffortBand('xhigh', 'low')).toBe('xhigh')
    expect(applyReviewReasoningEffortBand(undefined, 'low')).toBeUndefined()
  })
})

/**
 * The bands are a claim about recorded Review runs, so they are measured
 * against them. `findings` is what the Review at `high` found on that head
 * commit. The guard is the claim that earned the change: `low` covers a real
 * share of pull requests and rarely covers one that carried a defect.
 */
describe('the bands against recorded Review runs', () => {
  const recorded: Array<{ repository: string, number: number, findings: number, changedFiles: Array<Omit<PullRequestFile, 'previousFilename'>> }>
    = JSON.parse(readFileSync(new URL('./fixtures/recorded-review-runs.json', import.meta.url), 'utf8'))

  it('sends a fifth of pull requests to low, and few that carried a defect', () => {
    const banded = recorded.map(run => ({
      findings: run.findings,
      effort: reviewReasoningEffortBand(run.changedFiles.map(changed => ({ ...changed, previousFilename: null }))).effort,
    }))
    const low = banded.filter(run => run.effort === 'low')
    const carried = low.filter(run => run.findings > 0)
    expect(low.length / banded.length).toBeGreaterThan(0.2)
    expect(carried.length / low.length).toBeLessThan(0.1)
    // The whole set is the comparison: the band has to be cleaner than chance.
    expect(carried.length / low.length).toBeLessThan(banded.filter(run => run.findings > 0).length / banded.length)
  })
})
