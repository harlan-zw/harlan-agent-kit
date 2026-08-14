import { describe, expect, it } from 'vitest'
import { approvalLabels } from '../src/approval-labels.ts'
import { isAutomatedGitHubActor, isIssueAtOrAfterCutoff } from '../src/github.ts'

describe('gitHub subjects', () => {
  it.each([
    ['renovate[bot]', 'Bot'],
    ['dependabot[bot]', 'User'],
    ['deployment-bot-runner', 'User'],
    ['app/renovate', 'User'],
  ])('identifies automated pull request author %s', (login, type) => {
    expect(isAutomatedGitHubActor({ login, type })).toBe(true)
  })

  it('keeps a human pull request author', () => {
    expect(isAutomatedGitHubActor({ login: 'edevil', type: 'User' })).toBe(false)
  })

  it('uses one fixed inclusive issue cutoff', () => {
    expect(isIssueAtOrAfterCutoff('2026-07-13T23:59:59.999Z', '2026-07-14')).toBe(false)
    expect(isIssueAtOrAfterCutoff('2026-07-14T00:00:00.000Z', '2026-07-14')).toBe(true)
    expect(isIssueAtOrAfterCutoff('2026-08-13T00:00:00.000Z', '2026-07-14')).toBe(true)
  })

  it('recognizes only exact Approval labels', () => {
    expect(approvalLabels(['HARLAN-AGENT-REVIEW', 'bug'])).toEqual(['review'])
    expect(approvalLabels(['harlan-agent-review-later'])).toEqual([])
  })
})
