import type { AutoMergePolicy } from '../src/auto-merge.ts'
import type { MergeRisk } from '../src/merge-risk.ts'
import type { MergeRiskRecord, RepositoryAutoMergeScope, ReviewGates, ReviewGateState, ReviewPublication, ReviewRun } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { autoMergeDecision } from '../src/auto-merge.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const passed: ReviewGateState = { _tag: 'Passed', evidence: [] }
const gates: ReviewGates = { ci: passed, merge: passed, review: passed }

const publication: ReviewPublication = {
  at: '2026-09-16T00:10:00.000Z',
  body: '### 🤖 READY',
  bodySha256: 'a'.repeat(64),
  id: 'publication-1',
  result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
  reviewRunId: 'attempt-1',
}

/** Both independent answers agreed, which is the only way to reach Contained. */
function agreed(risk: MergeRisk): MergeRiskRecord {
  return { claim: risk, combined: risk, floor: risk }
}

const containedRisk = agreed({ _tag: 'Contained' })
const reviewableRisk = agreed({ _tag: 'Reviewable', reason: 'it changes a shared default' })
const sensitiveRisk = agreed({ _tag: 'Sensitive', reason: 'it runs a migration' })

function containedScope(overrides: Partial<Extract<RepositoryAutoMergeScope, { _tag: 'Contained' }>> = {}): RepositoryAutoMergeScope {
  return {
    _tag: 'Contained',
    labelOverridesRisk: true,
    minimumConfidence: 90,
    policy: { containedPaths: [], maximumChangedFiles: 12, maximumChangedLines: 300, requireTestChange: false, sensitivePaths: [] },
    ...overrides,
  }
}

function attempt(mergeRisk: MergeRiskRecord | null, confidence = 100): ReviewRun {
  return {
    agentVersion: '0.0.0',
    baseRef: 'main',
    completedAt: '2026-09-16T00:10:00.000Z',
    feedback: null,
    findings: [],
    gatePublication: { _tag: 'Published', publicationId: 'publication-1' },
    gates,
    headSha: 'abc123',
    id: 'attempt-1',
    mergeRisk,
    model: 'gpt-5.6-sol',
    outcome: { _tag: 'Ready', confidence },
    provider: 'codex',
    publications: [publication],
    pullRequestNumber: 24,
    repository: 'harlan-zw/example',
    revisionId: 'revision-1',
    sessionId: 'session-1',
    skillDigest: 'digest',
    startedAt: '2026-09-16T00:00:00.000Z',
    usage: { _tag: 'Unavailable' },
  }
}

const policy: AutoMergePolicy = { _tag: 'Enabled', method: 'squash', minimumConfidence: 100 }

function decide(input: {
  autoMerge?: RepositoryAutoMergeScope
  confidence?: number
  labelled?: boolean
  mergeRisk?: MergeRiskRecord | null
}) {
  return autoMergeDecision({
    attempts: [attempt(input.mergeRisk ?? null, input.confidence ?? 100)],
    policy,
    pullRequest: pullRequestItem({ autoMerge: input.labelled ?? false, headSha: 'abc123', mergeState: 'clean' }),
    repository: { ...repositoryMapping(), autoMerge: input.autoMerge ?? containedScope() },
  })
}

describe('merge risk at the Auto merge gate', () => {
  it('merges a Contained pull request that carries no label', () => {
    // The whole point: code ships without a person, on evidence rather than a label.
    expect(decide({ mergeRisk: containedRisk })._tag).toBe('Merge')
  })

  it('holds a Reviewable pull request that carries no label', () => {
    const decision = decide({ mergeRisk: reviewableRisk })
    expect(decision._tag).toBe('Hold')
    if (decision._tag === 'Hold')
      expect(decision.reason).toContain('shared default')
  })

  it('holds when the review recorded no verdict at all', () => {
    // A review from before this existed, or one whose file list could not be
    // read. Absent must never read as Contained.
    const decision = decide({ mergeRisk: null })
    expect(decision._tag).toBe('Hold')
    if (decision._tag === 'Hold')
      expect(decision.reason).toContain('no Merge risk')
  })

  it('lets a label carry a Reviewable pull request, because a person chose it', () => {
    expect(decide({ labelled: true, mergeRisk: reviewableRisk })._tag).toBe('Merge')
  })

  it('lets a Sensitive verdict beat a label when the repository asks it to', () => {
    // A label left on a pull request that has since grown into a migration.
    const decision = decide({
      autoMerge: containedScope({ labelOverridesRisk: false }),
      labelled: true,
      mergeRisk: sensitiveRisk,
    })
    expect(decision._tag).toBe('Hold')
    if (decision._tag === 'Hold')
      expect(decision.reason).toContain('runs a migration')
  })

  it('keeps the existing label behaviour by default', () => {
    expect(decide({ labelled: true, mergeRisk: sensitiveRisk })._tag).toBe('Merge')
  })

  it('holds a Contained pull request below the repository confidence bar', () => {
    const decision = decide({ confidence: 80, mergeRisk: containedRisk })
    expect(decision._tag).toBe('Hold')
    if (decision._tag === 'Hold')
      expect(decision.reason).toContain('below 90')
  })

  it('holds a labelled pull request to the service-wide bar, not the lower Contained one', () => {
    // A repository may set a Contained bar below the service-wide one. That
    // lower bar belongs to Merge risk alone and must never widen the label.
    const decision = decide({ confidence: 95, labelled: true, mergeRisk: reviewableRisk })
    expect(decision._tag).toBe('Hold')
    if (decision._tag === 'Hold')
      expect(decision.reason).toContain('below 100')
  })

  it('holds a labelled Contained pull request to the service-wide bar', () => {
    // The label is the qualification here, so the repository's lower
    // Merge risk bar must never replace the service-wide one.
    const decision = decide({ confidence: 95, labelled: true, mergeRisk: containedRisk })
    expect(decision._tag).toBe('Hold')
    if (decision._tag === 'Hold')
      expect(decision.reason).toContain('below 100')
  })

  it('changes nothing for a repository that never opted in', () => {
    expect(decide({ autoMerge: { _tag: 'Labelled' }, mergeRisk: null })._tag).toBe('Hold')
    expect(decide({ autoMerge: { _tag: 'Labelled' }, labelled: true, mergeRisk: null })._tag).toBe('Merge')
  })
})
