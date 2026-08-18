import type { ReviewGates, ReviewGateState } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { reviewOutcome } from '../src/item-agent.ts'

const passed: ReviewGateState = { _tag: 'Passed', evidence: [] }
const pending = (reason: string): ReviewGateState => ({ _tag: 'Pending', reason, evidence: [] })
const failed = (reason: string): ReviewGateState => ({ _tag: 'Failed', reason, evidence: [] })

function gates(overrides: Partial<ReviewGates> = {}): ReviewGates {
  return {
    head: passed,
    merge: passed,
    metadata: passed,
    review: passed,
    verification: passed,
    ci: passed,
    ...overrides,
  }
}

describe('reviewOutcome', () => {
  it('never blocks a pull request the agent did not review', () => {
    // The agent answered that it had not reviewed, and CI was red. Reporting
    // BLOCKED reads as "the review found defects", which never happened.
    expect(reviewOutcome(gates({
      review: pending('No adversarial review was completed before the previous answer was rejected.'),
      metadata: pending('No prior review context was retained from the rejected response.'),
      verification: pending('No verification run was performed in this session.'),
      ci: failed('test failed.'),
    }))).toBe('PENDING')
  })

  it('blocks when the review itself failed', () => {
    expect(reviewOutcome(gates({ review: failed('A material defect remains.') }))).toBe('BLOCKED')
  })

  it('blocks on red CI when the review did complete', () => {
    expect(reviewOutcome(gates({ ci: failed('test failed.') }))).toBe('BLOCKED')
  })

  it('reports READY when every gate passed', () => {
    expect(reviewOutcome(gates())).toBe('READY')
  })
})
