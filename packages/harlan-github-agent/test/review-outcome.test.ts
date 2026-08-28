import type { ReviewGates, ReviewGateState } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { reviewOutcome, terminalComment } from '../src/item-agent.ts'

const passed: ReviewGateState = { _tag: 'Passed', evidence: [] }
const pending = (reason: string): ReviewGateState => ({ _tag: 'Pending', reason, evidence: [] })
const failed = (reason: string): ReviewGateState => ({ _tag: 'Failed', reason, evidence: [] })

function gates(overrides: Partial<ReviewGates> = {}): ReviewGates {
  return {
    merge: passed,
    review: passed,
    ci: passed,
    ...overrides,
  }
}

describe('reviewOutcome', () => {
  it('waits when a controller gate is pending', () => {
    expect(reviewOutcome(gates({ merge: pending('GitHub is computing mergeability.') }))).toBe('PENDING')
  })

  it('blocks when the review itself failed', () => {
    expect(reviewOutcome(gates({ review: failed('A material defect remains.') }))).toBe('BLOCKED')
  })

  it('blocks on red CI when the review did complete', () => {
    const failedCi = gates({ ci: failed('test failed.') })

    expect(reviewOutcome(failedCi)).toBe('BLOCKED')
    expect(terminalComment('abc123', failedCi, [], undefined, [])).toContain('Blocked: test failed.')
  })

  it('reports READY when every gate passed', () => {
    expect(reviewOutcome(gates())).toBe('READY')
  })
})
