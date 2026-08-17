import { describe, expect, it } from 'vitest'
import { classifyFailure, MAXIMUM_RECOVERY_ATTEMPTS, nextRecoveryAt, recoveryDelayMilliseconds } from '../src/failure.ts'

describe('classifyFailure', () => {
  it.each([
    ['Resource not accessible by integration - https://docs.github.com/rest/pulls/pulls', 'github_access'],
    ['Bad credentials', 'github_access'],
    ['Not Found - https://docs.github.com/rest/issues/comments', 'github_access'],
    ['No server is currently available to service your request.', 'github_unavailable'],
    ['Could not resolve to a node with the global id of \'PR_kwDOPRK6\'', 'github_unavailable'],
    ['Request quota exhausted for request GET https://api.github.com/repos', 'rate_limit'],
    ['request to https://api.github.com failed, reason: ECONNRESET', 'network'],
    ['fetch failed', 'network'],
    ['The opencode session stopped sending output.', 'agent_provider'],
    ['The opencode session exited with code 1.', 'agent_provider'],
    ['The agent finished without a result.', 'agent_provider'],
    ['The approved review repair could not be claimed by the active review.', 'controller'],
    ['Could not list wt worktrees: spawn wt ENOENT', 'controller'],
    ['The publication artifact patch digest does not match.', 'controller'],
    ['Repository policy does not authorize Baseline repair for this base commit.', 'controller'],
    ['The pull request changed before the review completed.', 'subject_changed'],
    ['The agent returned an invalid adversarial review result.', 'agent_result'],
    ['The agent returned malformed adversarial review JSON.', 'agent_result'],
  ])('treats %s as a transient %s failure', (message, kind) => {
    expect(classifyFailure({ message })).toEqual({ _tag: 'Transient', kind })
  })

  it.each([429, 500, 502, 503, 401, 403])('treats HTTP %i as transient', (status) => {
    expect(classifyFailure({ message: 'GitHub request failed.', status })._tag).toBe('Transient')
  })

  it.each([
    'Repository policy does not authorize an automated review comment.',
    'Repository policy does not permit issue work.',
    'The controller cannot write this pull request branch.',
    'Pull request #12 is still draft.',
  ])('treats %s as permanent', (message) => {
    expect(classifyFailure({ message })._tag).toBe('Permanent')
  })

  it('treats an unrecognised failure as permanent so it surfaces instead of spinning', () => {
    expect(classifyFailure({ message: 'The worker changed a file that was not conflicted: src/main.rs.' }))
      .toEqual({ _tag: 'Permanent', kind: 'unknown' })
  })
})

describe('recoveryDelayMilliseconds', () => {
  it('retries the first recovery immediately', () => {
    expect(recoveryDelayMilliseconds(0)).toBe(0)
  })

  it('backs off further recoveries and stops growing at thirty minutes', () => {
    expect(recoveryDelayMilliseconds(1)).toBe(60_000)
    expect(recoveryDelayMilliseconds(2)).toBe(120_000)
    expect(recoveryDelayMilliseconds(MAXIMUM_RECOVERY_ATTEMPTS)).toBeLessThanOrEqual(30 * 60_000)
  })

  it('names when a failed task may run again', () => {
    expect(nextRecoveryAt('2026-08-18T00:00:00.000Z', 1)).toBe('2026-08-18T00:01:00.000Z')
  })
})
