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
    expect(comment).toContain('⚪ **Duplicate of #17**\n\nBoth reports reproduce the same chunk boundary error. Follow #17 for the fix.')
    expect(comment).toContain('- #25: Changes the affected parser branch.')
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

describe('what a Needs info triage asks for', () => {
  const evidence = (ask?: unknown) => JSON.stringify({
    _tag: 'NEEDS_INFO',
    difficulty: 3,
    impact: 4,
    hasReproduction: false,
    needsCodebaseReview: true,
    summary: 'OG images render blank on Cloudflare Pages.',
    nextAction: 'Wait for a minimal reproduction.',
    relatedIssues: [],
    duplicateIssue: null,
    relatedPullRequests: [],
    ...(ask === undefined ? {} : { ask }),
  })

  it('lists the exact missing items to the person who opened the issue', () => {
    const result = parseStoredIssueTriage(evidence(['Your `nuxt-og-image` and Nuxt versions', ' The `ogImage` config\nblock ', '']))

    expect(result?.ask).toEqual(['Your `nuxt-og-image` and Nuxt versions', 'The `ogImage` config block'])
    expect(issueTriageComment(result!)).toContain('🟠 **Needs info**\n\nOG images render blank on Cloudflare Pages.\n\nAdd these to move it forward:\n\n- Your `nuxt-og-image` and Nuxt versions\n- The `ogImage` config block\n\n<sub>')
  })

  it('reads evidence stored before the list existed, and asks with the next action instead', () => {
    const result = parseStoredIssueTriage(evidence())

    expect(result?.ask).toEqual([])
    expect(issueTriageComment(result!)).toContain('Add these to move it forward:\n\nWait for a minimal reproduction.')
  })

  it('rejects a list that is not a list of text', () => {
    expect(parseStoredIssueTriage(evidence('Your Nuxt version'))).toBeNull()
    expect(parseStoredIssueTriage(evidence([42]))).toBeNull()
  })
})
