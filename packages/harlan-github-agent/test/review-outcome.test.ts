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

  it('logs an 80-impact finding without an action or failed Review gate', () => {
    const body = terminalComment('abc123', 'base123', gates(), [{
      _tag: 'Logged',
      impact: 80,
      summary: 'A rare empty state loses spacing.',
      details: {
        fingerprint: 'empty-spacing',
        identity: 'empty-spacing',
        location: { path: 'src/view.ts', line: 14 },
        proof: 'The empty list hides its gap.',
      },
    }], 95, [], undefined, 'harlan-zw/example')

    expect(body).toContain('### 🤖 READY · 95/100')
    expect(body).toContain('**Logged (80/100):** A rare empty state loses spacing.')
    expect(body).toContain('[View code](https://github.com/harlan-zw/example/blob/abc123/src/view.ts#L14)')
    expect(body).not.toContain('**Open:**')
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

  it('links an open finding to the reviewed code line', () => {
    const body = terminalComment('abc123', 'base123', gates({ review: failed('A defect remains.') }), [{
      _tag: 'Open',
      impact: 81,
      summary: 'The queue can drop events.',
      nextAction: 'Preserve pending events.',
      details: {
        fingerprint: 'queue-events',
        location: { path: 'src/queue worker.ts', line: 42 },
        proof: 'The queue resets before sending.',
        regressionTest: 'Send two events.',
      },
    }], undefined, [], undefined, 'harlan-zw/example')

    expect(body).toContain('[View code](https://github.com/harlan-zw/example/blob/abc123/src/queue%20worker.ts#L42)')
    expect(body).toContain('**Open (81/100):**')
    expect(body).not.toContain('events..')
  })

  it('keeps the finding when its code path cannot form a safe link', () => {
    const body = terminalComment('abc123', 'base123', gates({ review: failed('A defect remains.') }), [{
      _tag: 'Open',
      summary: 'The queue can drop events.',
      nextAction: 'Preserve pending events.',
      details: {
        fingerprint: 'queue-events',
        location: { path: '../queue.ts', line: 42 },
        proof: 'The queue resets before sending.',
        regressionTest: 'Send two events.',
      },
    }], undefined, [], undefined, 'harlan-zw/example')

    expect(body).toContain('The queue can drop events. Next: Preserve pending events.')
    expect(body).not.toContain('[View code]')
  })
})
