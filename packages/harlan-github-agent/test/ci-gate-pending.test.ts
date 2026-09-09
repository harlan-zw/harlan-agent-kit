import type { CiGateCause } from '../src/ci-gate-pending.ts'
import type { ReviewGates } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import {
  ciGatePendingMessage,
  IDLE_GATE_BOUND_MILLISECONDS,
  readCiGate,
  RUNNING_CHECK_BOUND_MILLISECONDS,
} from '../src/ci-gate-pending.ts'

const pendingSince = '2026-09-05T00:00:00.000Z'

function at(milliseconds: number): Date {
  return new Date(Date.parse(pendingSince) + milliseconds)
}

function passed(label: string) {
  return { _tag: 'Passed' as const, evidence: [{ label, sha256: 'a'.repeat(64) }] }
}

function gates(overrides: Partial<ReviewGates> = {}): ReviewGates {
  return {
    merge: passed('mergeability'),
    review: passed('agent-report'),
    ci: { _tag: 'Pending', reason: 'Base branch CI: build failed.', evidence: [{ label: 'base-ci', sha256: 'b'.repeat(64) }] },
    ...overrides,
  }
}

const baseFailed: CiGateCause = { _tag: 'BaseBranchFailed', check: 'build' }
const running: CiGateCause = { _tag: 'CheckRunning', check: 'ci / test' }
const queued: CiGateCause = { _tag: 'CheckQueued', check: 'test' }

describe('readCiGate', () => {
  it('reports a base branch failure the pull request cannot resolve as overdue', () => {
    const reading = readCiGate({ gates: gates(), cause: baseFailed, pendingSince, now: at(IDLE_GATE_BOUND_MILLISECONDS + 60_000) })

    expect(reading).toEqual({
      _tag: 'Overdue',
      cause: baseFailed,
      pendingSince,
      elapsedMilliseconds: IDLE_GATE_BOUND_MILLISECONDS + 60_000,
      boundMilliseconds: IDLE_GATE_BOUND_MILLISECONDS,
    })
  })

  it('keeps the three hour wait this service recorded as healthy inside the bound', () => {
    const reading = readCiGate({ gates: gates(), cause: baseFailed, pendingSince, now: at(3 * 60 * 60_000) })

    expect(reading).toEqual({
      _tag: 'Within',
      elapsedMilliseconds: 3 * 60 * 60_000,
      boundMilliseconds: IDLE_GATE_BOUND_MILLISECONDS,
    })
  })

  it('gives a running check run the whole time GitHub allows one job', () => {
    const input = { gates: gates(), cause: running, pendingSince }

    expect(readCiGate({ ...input, now: at(RUNNING_CHECK_BOUND_MILLISECONDS - 60_000) })._tag).toBe('Within')
    expect(readCiGate({ ...input, now: at(RUNNING_CHECK_BOUND_MILLISECONDS + 60_000) })).toEqual({
      _tag: 'Overdue',
      cause: running,
      pendingSince,
      elapsedMilliseconds: RUNNING_CHECK_BOUND_MILLISECONDS + 60_000,
      boundMilliseconds: RUNNING_CHECK_BOUND_MILLISECONDS,
    })
  })

  it('ignores a repository with no CI, because its gate passed', () => {
    const reading = readCiGate({
      gates: gates({ ci: passed('github-ci') }),
      cause: { _tag: 'Settled' },
      pendingSince,
      now: at(5 * 24 * 60 * 60_000),
    })

    expect(reading._tag).toBe('Ignored')
  })

  it('ignores a pull request another Review gate already holds', () => {
    const reading = readCiGate({
      gates: gates({ merge: { _tag: 'Failed', reason: 'The pull request has merge conflicts.', evidence: [] } }),
      cause: baseFailed,
      pendingSince,
      now: at(2 * 24 * 60 * 60_000),
    })

    expect(reading._tag).toBe('Ignored')
  })

  it('ignores a lost runner, because that failure has its own Incident', () => {
    const reading = readCiGate({
      gates: gates(),
      cause: { _tag: 'RunnerLost', check: 'ci / test' },
      pendingSince,
      now: at(2 * 24 * 60 * 60_000),
    })

    expect(reading._tag).toBe('Ignored')
  })

  it('ignores a clock that runs backwards', () => {
    const reading = readCiGate({ gates: gates(), cause: baseFailed, pendingSince, now: at(-60_000) })

    expect(reading._tag).toBe('Within')
  })
})

describe('ciGatePendingMessage', () => {
  it('names the repository, the pull request, the gate state, and the wait', () => {
    const reading = readCiGate({ gates: gates(), cause: baseFailed, pendingSince, now: at(26 * 60 * 60_000) })
    if (reading._tag !== 'Overdue')
      throw new Error('Expected an overdue CI Review gate.')

    const message = ciGatePendingMessage('harlan-zw/gscdump.com', 213, reading)

    expect(message).toBe([
      'harlan-zw/gscdump.com#213: the CI Review gate reads PENDING for more than 4 hours.',
      'The gate last moved at 2026-09-05 00:00 UTC.',
      'Base branch check run "build" failed.',
      'If the default branch is broken, repair it and re-run the check run.',
    ].join(' '))
  })

  it('writes one message whatever the wait grows to, so one gate keeps one Incident', () => {
    const early = readCiGate({ gates: gates(), cause: running, pendingSince, now: at(7 * 60 * 60_000) })
    const late = readCiGate({ gates: gates(), cause: running, pendingSince, now: at(70 * 60 * 60_000) })
    if (early._tag !== 'Overdue' || late._tag !== 'Overdue')
      throw new Error('Expected two overdue CI Review gates.')

    expect(ciGatePendingMessage('harlan-zw/example', 24, early)).toBe(ciGatePendingMessage('harlan-zw/example', 24, late))
    expect(ciGatePendingMessage('harlan-zw/example', 24, early)).toContain('Check run "ci / test" has not reported a conclusion.')
  })

  it('names a queued job no runner accepted, and does not tell Harlan to re-run it', () => {
    const reading = readCiGate({ gates: gates(), cause: queued, pendingSince, now: at(RUNNING_CHECK_BOUND_MILLISECONDS + 60_000) })
    if (reading._tag !== 'Overdue')
      throw new Error('Expected an overdue CI Review gate.')

    expect(ciGatePendingMessage('harlan-zw/gscdump', 49, reading)).toBe([
      'harlan-zw/gscdump#49: the CI Review gate reads PENDING for more than 6 hours.',
      'The gate last moved at 2026-09-05 00:00 UTC.',
      'Check run "test" is queued, and no runner has accepted the job.',
      'If the job stays queued, read the runner supervisor on Hogwild.',
    ].join(' '))
  })

  it('gives a queued job the six hour bound, because the runner supervisor drops older runs', () => {
    expect(readCiGate({ gates: gates(), cause: queued, pendingSince, now: at(RUNNING_CHECK_BOUND_MILLISECONDS - 60_000) })._tag).toBe('Within')
    expect(readCiGate({ gates: gates(), cause: queued, pendingSince, now: at(RUNNING_CHECK_BOUND_MILLISECONDS + 60_000) })._tag).toBe('Overdue')
  })
})
