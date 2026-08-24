import type { AutoMergePolicy } from '../src/auto-merge.ts'
import type { ReviewFinding, ReviewGates, ReviewGateState, ReviewOutcome, ReviewRun } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { AUTO_MERGE_LABEL, autoMergeDecision, hasAutoMergeLabel } from '../src/auto-merge.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const passed: ReviewGateState = { _tag: 'Passed', evidence: [] }

const gates: ReviewGates = {
  head: passed,
  merge: passed,
  metadata: passed,
  review: passed,
  verification: passed,
  ci: passed,
}

function attempt(overrides: { headSha?: string, outcome?: ReviewOutcome, findings?: ReviewFinding[], completedAt?: string } = {}): ReviewRun {
  return {
    id: 'attempt-1',
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-1',
    headSha: overrides.headSha ?? 'abc123',
    provider: 'codex',
    sessionId: 'session-1',
    model: 'gpt-5.6-sol',
    agentVersion: '0.0.0',
    skillDigest: 'digest',
    startedAt: '2026-08-18T00:00:00.000Z',
    completedAt: overrides.completedAt ?? '2026-08-18T00:10:00.000Z',
    gates,
    outcome: overrides.outcome ?? { _tag: 'Ready', confidence: 100 },
    findings: overrides.findings ?? [],
    usage: { _tag: 'Unavailable' },
    publications: [],
  }
}

const enabled: AutoMergePolicy = { _tag: 'Enabled', minimumConfidence: 100, method: 'squash' }

function decide(input: {
  attempts?: ReviewRun[]
  policy?: AutoMergePolicy
  pullRequest?: Parameters<typeof pullRequestItem>[0]
  repository?: Parameters<typeof repositoryMapping>[0]
} = {}) {
  return autoMergeDecision({
    attempts: input.attempts ?? [attempt()],
    policy: input.policy ?? enabled,
    pullRequest: pullRequestItem({ autoMerge: true, mergeState: 'clean', ...input.pullRequest }),
    repository: repositoryMapping(input.repository),
  })
}

describe('auto merge label', () => {
  it('matches the label whatever its case', () => {
    expect(hasAutoMergeLabel(['bug', AUTO_MERGE_LABEL.toUpperCase()])).toBe(true)
    expect(hasAutoMergeLabel(['bug', 'harlan-agent-review'])).toBe(false)
    expect(hasAutoMergeLabel([])).toBe(false)
  })
})

describe('auto merge decision', () => {
  it('merges a labelled pull request with a READY review at full confidence', () => {
    expect(decide()).toEqual({ _tag: 'Merge', headSha: 'abc123', method: 'squash', reviewRunId: 'attempt-1' })
  })

  it('holds when the policy is disabled', () => {
    expect(decide({ policy: { _tag: 'Disabled' } })).toEqual({ _tag: 'Hold', reason: 'Auto merge is disabled.' })
  })

  it('holds when the pull request has no label', () => {
    expect(decide({ pullRequest: { autoMerge: false } })._tag).toBe('Hold')
  })

  it('holds for a repository Harlan does not own', () => {
    expect(decide({ repository: { ownership: 'maintained' } })).toEqual({
      _tag: 'Hold',
      reason: 'Auto merge covers owned repositories only.',
    })
  })

  it('holds for an author outside the trusted authors', () => {
    expect(decide({ pullRequest: { author: 'contributor' } })).toEqual({
      _tag: 'Hold',
      reason: 'The pull request author is not a trusted author.',
    })
  })

  it('holds for a draft, a conflict, and a closed pull request', () => {
    expect(decide({ pullRequest: { draft: true } })._tag).toBe('Hold')
    expect(decide({ pullRequest: { mergeState: 'conflicting' } })._tag).toBe('Hold')
    expect(decide({ pullRequest: { mergeState: 'unknown' } })._tag).toBe('Hold')
    expect(decide({ pullRequest: { state: 'closed' } })._tag).toBe('Hold')
  })

  it('holds when the READY review covers an older head commit', () => {
    expect(decide({ attempts: [attempt({ headSha: 'older' })] })).toEqual({
      _tag: 'Hold',
      reason: 'The current head commit has no READY review.',
    })
  })

  it('holds when the review is not READY', () => {
    expect(decide({ attempts: [attempt({ outcome: { _tag: 'Blocked' } })] })._tag).toBe('Hold')
    expect(decide({ attempts: [] })._tag).toBe('Hold')
  })

  it('holds when confidence is below the minimum', () => {
    expect(decide({ attempts: [attempt({ outcome: { _tag: 'Ready', confidence: 95 } })] })).toEqual({
      _tag: 'Hold',
      reason: 'Review confidence is below 100.',
    })
  })

  it('holds when the review reported no confidence', () => {
    expect(decide({ attempts: [attempt({ outcome: { _tag: 'Ready' } })] })._tag).toBe('Hold')
  })

  it('holds when the review left an open finding', () => {
    const findings: ReviewFinding[] = [{ _tag: 'Open', summary: 'Race condition', nextAction: 'Guard the write' }]
    expect(decide({ attempts: [attempt({ findings })] })).toEqual({
      _tag: 'Hold',
      reason: 'The review left an open finding.',
    })
  })

  it('uses the newest READY review for the current head commit', () => {
    const stale = attempt({ outcome: { _tag: 'Ready', confidence: 90 }, completedAt: '2026-08-18T00:01:00.000Z' })
    const current = { ...attempt({ completedAt: '2026-08-18T00:20:00.000Z' }), id: 'attempt-2' }
    expect(decide({ attempts: [stale, current] })).toEqual({
      _tag: 'Merge',
      headSha: 'abc123',
      method: 'squash',
      reviewRunId: 'attempt-2',
    })
  })

  it('merges at a lower configured minimum confidence', () => {
    const policy: AutoMergePolicy = { _tag: 'Enabled', minimumConfidence: 90, method: 'merge' }
    expect(decide({ attempts: [attempt({ outcome: { _tag: 'Ready', confidence: 95 } })], policy })).toEqual({
      _tag: 'Merge',
      headSha: 'abc123',
      method: 'merge',
      reviewRunId: 'attempt-1',
    })
  })
})
