import type { AutoMergePolicy } from '../src/auto-merge.ts'
import type { ReviewFinding, ReviewGates, ReviewGateState, ReviewOutcome, ReviewPublication, ReviewRun } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { AUTO_MERGE_LABEL, autoMergeCandidate, autoMergeDecision, hasAutoMergeLabel } from '../src/auto-merge.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const passed: ReviewGateState = { _tag: 'Passed', evidence: [] }

const gates: ReviewGates = {
  merge: passed,
  review: passed,
  ci: passed,
}

const publication: ReviewPublication = {
  id: 'publication-1',
  reviewRunId: 'attempt-1',
  body: '### 🤖 READY',
  bodySha256: 'a'.repeat(64),
  at: '2026-08-18T00:10:00.000Z',
  result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
}

function attempt(overrides: { headSha?: string, outcome?: ReviewOutcome, findings?: ReviewFinding[], completedAt?: string, publications?: ReviewPublication[] } = {}): ReviewRun {
  return {
    id: 'attempt-1',
    gatePublication: { _tag: 'Published', publicationId: 'publication-1' },
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-1',
    headSha: overrides.headSha ?? 'abc123',
    baseRef: 'main',
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
    feedback: null,
    publications: overrides.publications ?? [publication],
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
  it('holds when a newer Review is PENDING for the same head', () => {
    expect(decide({ attempts: [attempt(), attempt({ completedAt: '2026-08-18T01:00:00.000Z', outcome: { _tag: 'Pending', confidence: 100 } })] })._tag).toBe('Hold')
  })

  it('holds when the latest gates have no confirmed Publication', () => {
    expect(decide({ attempts: [{ ...attempt(), gatePublication: { _tag: 'Unpublished' } }] })._tag).toBe('Hold')
  })

  it('holds a reviewed stack until it targets the default branch', () => {
    expect(decide({ pullRequest: { baseRef: 'fix/parent' } })).toEqual({
      _tag: 'Hold',
      reason: 'The pull request must target the default branch before Auto merge.',
    })
  })

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

  it('holds when the same head was reviewed against a different target branch', () => {
    expect(decide({ attempts: [{ ...attempt(), baseRef: 'fix/parent' }] })._tag).toBe('Hold')
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

  it('holds until the READY review is published', () => {
    expect(decide({ attempts: [attempt({ publications: [] })] })).toEqual({
      _tag: 'Hold',
      reason: 'The current head commit has no published READY review.',
    })
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

describe('auto merge scoped to every pull request', () => {
  const every = { autoMerge: { _tag: 'Every', minimumConfidence: 80 } } as const

  it('merges an unlabelled pull request at the repository minimum, below the service minimum', () => {
    expect(decide({
      attempts: [attempt({ outcome: { _tag: 'Ready', confidence: 80 } })],
      pullRequest: { autoMerge: false },
      repository: every,
    })).toEqual({ _tag: 'Merge', headSha: 'abc123', method: 'squash', reviewRunId: 'attempt-1' })
  })

  it('holds below the repository minimum even with the label', () => {
    expect(decide({
      attempts: [attempt({ outcome: { _tag: 'Ready', confidence: 79 } })],
      pullRequest: { autoMerge: true },
      repository: every,
    })).toEqual({ _tag: 'Hold', reason: 'Review confidence is below 80.' })
  })

  it('still needs a trusted author and a READY review', () => {
    expect(decide({ pullRequest: { autoMerge: false, author: 'stranger' }, repository: every })).toEqual({
      _tag: 'Hold',
      reason: 'The pull request author is not a trusted author.',
    })
    expect(decide({ attempts: [], pullRequest: { autoMerge: false }, repository: every })).toEqual({
      _tag: 'Hold',
      reason: 'The current head commit has no READY review.',
    })
  })

  it('names the candidates the controller may spend a merge check on', () => {
    expect(autoMergeCandidate(repositoryMapping(), pullRequestItem({ autoMerge: false }))).toBe(false)
    expect(autoMergeCandidate(repositoryMapping(), pullRequestItem({ autoMerge: true }))).toBe(true)
    expect(autoMergeCandidate(repositoryMapping(every), pullRequestItem({ autoMerge: false }))).toBe(true)
  })
})
