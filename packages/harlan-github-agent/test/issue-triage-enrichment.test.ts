import { describe, expect, it } from 'vitest'
import { issueTriageComment } from '../src/issue-triage-comment.ts'
import { parseStoredIssueTriage } from '../src/issue-triage.ts'

describe('issue triage evidence', () => {
  it('shows a verified duplicate and related pull requests with reasons', () => {
    const result = parseStoredIssueTriage(JSON.stringify({
      _tag: 'WAIT_TO_IMPLEMENT',
      difficulty: 2,
      impact: 4,
      hasReproduction: true,
      needsCodebaseReview: true,
      summary: 'The parser drops the last byte.',
      nextAction: 'Track the existing report.',
      relatedIssues: [],
      duplicateIssue: { number: 17, reason: 'Both reports reproduce the same chunk boundary error.' },
      relatedPullRequests: [{ number: 25, reason: 'Changes the affected parser branch.' }],
    }))

    expect(result).not.toBeNull()
    if (result === null)
      return
    const comment = issueTriageComment(result)
    expect(comment).toContain('**Duplicate of:** #17: Both reports reproduce the same chunk boundary error.')
    expect(comment).toContain('**Related pull requests:** #25: Changes the affected parser branch.')
  })

  it('rejects duplicate evidence without a reason', () => {
    const result = parseStoredIssueTriage(JSON.stringify({
      _tag: 'WAIT_TO_IMPLEMENT',
      difficulty: 2,
      impact: 4,
      hasReproduction: true,
      needsCodebaseReview: true,
      summary: 'Same symptom.',
      nextAction: 'Track the other issue.',
      relatedIssues: [],
      duplicateIssue: { number: 17, reason: '' },
      relatedPullRequests: [],
    }))

    expect(result).toBeNull()
  })

  it('rejects a duplicate that would still start issue work', () => {
    const result = parseStoredIssueTriage(JSON.stringify({
      _tag: 'READY_TO_IMPLEMENT',
      difficulty: 2,
      impact: 4,
      hasReproduction: true,
      needsCodebaseReview: true,
      summary: 'The parser drops the last byte.',
      nextAction: 'Repair the parser.',
      relatedIssues: [],
      duplicateIssue: { number: 17, reason: 'The same boundary error.' },
      relatedPullRequests: [],
    }))

    expect(result).toBeNull()
  })
})
