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
    expect(terminalComment('abc123', 'base123', failedCi, [], undefined, [])).toContain('**CI gate:** BLOCKED. test failed.')
  })

  it('reports READY when every gate passed', () => {
    expect(reviewOutcome(gates())).toBe('READY')
  })

  it('shows every Review gate while CI is pending', () => {
    const body = terminalComment(
      'abc123',
      'base123',
      gates({ ci: pending('Base branch CI: deploy is still running.') }),
      [],
      undefined,
      [],
    )

    expect(body).toContain('### 🤖 PENDING')
    expect(body).toContain('<!-- workflow-state: {"_tag":"Review","headSha":"abc123","baseSha":"base123","outcome":"PENDING"')
    expect(body).toContain('**Merge gate:** Passed.')
    expect(body).toContain('**Review gate:** Passed. No material issues.')
    expect(body).toContain('**CI gate:** PENDING. Base branch CI: deploy is still running.')
    expect(body).toContain('Next: The controller updates this comment when a Review gate changes.')
  })
})
