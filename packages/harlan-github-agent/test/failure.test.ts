import { describe, expect, it } from 'vitest'
import { classifyFailure, contextBudgetExhaustedReason, MAXIMUM_RECOVERY_ATTEMPTS, mayRetryFailure, nextRecoveryAt, recoveryDelayMilliseconds, REVIEW_REPAIR_REFUSALS } from '../src/failure.ts'

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
    ['The opencode session failed: Unexpected server error. Check server logs for details.', 'agent_provider'],
    ['The agent finished without a result.', 'agent_provider'],
    ['The review Task lease changed before the repair started.', 'subject_changed'],
    ['The repair Task changed before the review claimed it.', 'subject_changed'],
    ['Could not list wt worktrees: spawn wt ENOENT', 'controller'],
    ['The publication artifact patch digest does not match.', 'controller'],
    ['Repository policy does not authorize Baseline repair for this base commit.', 'controller'],
    ['The pull request changed before the review completed.', 'subject_changed'],
    ['The agent returned an invalid adversarial review result.', 'agent_result'],
    ['The agent returned malformed adversarial review JSON.', 'agent_result'],
    ['The Agent returned invalid pull request text.', 'agent_result'],
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

  it.each(Object.values(REVIEW_REPAIR_REFUSALS))('never lets the refusal %s retry', (reason) => {
    // A refused repair reads the same policy on every attempt. One wording that
    // slipped into a Transient pattern would spend an agent turn per pass.
    expect(classifyFailure({ message: reason })).toEqual({ _tag: 'Permanent', kind: 'policy' })
    expect(mayRetryFailure({ message: reason })).toBe(false)
  })

  it('keeps the attempts of a failure nobody has classified', () => {
    expect(mayRetryFailure({ message: 'The worker changed a file the merge did not touch: src/main.rs.' })).toBe(true)
  })

  it.each([
    'The permissions requested are not granted to this installation. - https://docs.github.com/rest',
    'The level of access for permissions requested are not granted to this installation.',
  ])('separates %s from a degraded GitHub', (message) => {
    // Retries while a person can still grant the permission, but never wins its
    // budget back from a healthy poll, so the retry is bounded.
    expect(classifyFailure({ message, status: 403 })).toEqual({ _tag: 'Transient', kind: 'installation_access' })
  })

  it('keeps an integration rejection transient, because a degraded GitHub returns it', () => {
    expect(classifyFailure({
      message: 'Resource not accessible by integration - https://docs.github.com/rest/issues/comments#list-issue-comments',
      status: 403,
    })).toEqual({ _tag: 'Transient', kind: 'github_access' })
  })

  it('retries a short grant, because GitHub scopes tokens down while degraded', () => {
    expect(classifyFailure({ message: 'GitHub granted less access than this token asked for: issues.' }))
      .toEqual({ _tag: 'Transient', kind: 'github_access' })
  })

  it('retries the node error GitHub leaks from its own REST layer', () => {
    // GitHub answers a public repository this way when a request lacks access,
    // and answers a private one with 403 for the same call.
    expect(classifyFailure({
      message: 'Not Found: {"type":"NOT_FOUND","path":["node"],"message":"Could not resolve to a node with the global id of \'PR_kwDOQ3hsQ8\'."} - https://docs.github.com/rest/pulls/reviews',
      status: 404,
    })).toEqual({ _tag: 'Transient', kind: 'github_unavailable' })
  })

  it.each([
    'This operation was aborted',
    'The operation was aborted',
  ])('retries %s, because a restart aborts work that can run again', (message) => {
    // A shutdown aborts whatever is in flight. The article in front of
    // "operation" is not a fact about the world, so it must not decide the class.
    expect(classifyFailure({ message })).toEqual({ _tag: 'Transient', kind: 'network' })
  })

  it('treats an unrecognised failure as permanent so it surfaces instead of spinning', () => {
    expect(classifyFailure({ message: 'The worker changed a file the merge did not touch: src/main.rs.' }))
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

describe('contextBudgetExhaustedReason', () => {
  const reason = contextBudgetExhaustedReason({
    cachedTokensRead: 20_400_128,
    itemNumber: 24,
    repository: 'harlan-zw/example',
  })

  it('names the pull request that did not converge', () => {
    expect(reason).toContain('harlan-zw/example#24')
    expect(reason).toContain('20.4 million')
  })

  it('never retries a session that already read its whole budget', () => {
    // A retry reads the same context again, so it doubles the worst spend.
    expect(classifyFailure({ message: reason })).toEqual({ _tag: 'Permanent', kind: 'context_budget' })
    expect(mayRetryFailure({ message: reason })).toBe(false)
  })

  it('classifies by its own prefix, so no later pattern can make it retry', () => {
    const wordedLikeAnOutage = `${reason} fetch failed: request timed out.`

    expect(classifyFailure({ message: wordedLikeAnOutage })).toEqual({ _tag: 'Permanent', kind: 'context_budget' })
    expect(mayRetryFailure({ message: wordedLikeAnOutage })).toBe(false)
  })
})
