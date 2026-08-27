import { describe, expect, it } from 'vitest'
import { planReviewOutcomeLabels, REVIEW_OUTCOME_LABELS } from '../src/review-outcome-label.ts'

describe('planReviewOutcomeLabels', () => {
  it('adds the label for the verdict the Review reached', () => {
    expect(planReviewOutcomeLabels('READY', [])).toEqual({
      add: REVIEW_OUTCOME_LABELS.READY,
      remove: [],
    })
  })

  it('clears the verdict a head commit no longer holds', () => {
    expect(planReviewOutcomeLabels('BLOCKED', ['harlan-agent-ready'])).toEqual({
      add: REVIEW_OUTCOME_LABELS.BLOCKED,
      remove: ['harlan-agent-ready'],
    })
  })

  it('writes nothing when the pull request already states this verdict', () => {
    expect(planReviewOutcomeLabels('PENDING', ['harlan-agent-pending'])).toEqual({ add: null, remove: [] })
  })

  it('leaves every label the service does not own', () => {
    const plan = planReviewOutcomeLabels('READY', ['bug', 'harlan-agent-auto-merge', 'harlan-agent-review'])

    expect(plan.remove).toEqual([])
    expect(plan.add).toEqual(REVIEW_OUTCOME_LABELS.READY)
  })

  it('removes a second verdict GitHub reports in any casing', () => {
    expect(planReviewOutcomeLabels('READY', ['Harlan-Agent-Blocked', 'harlan-agent-ready']).remove)
      .toEqual(['Harlan-Agent-Blocked'])
  })

  it('gives each verdict its own label, so two verdicts never read alike', () => {
    const names = Object.values(REVIEW_OUTCOME_LABELS).map(label => label.name)

    expect(new Set(names).size).toBe(names.length)
  })
})
