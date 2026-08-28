import type { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { approvalLabels } from '../src/approval-labels.ts'
import { BASELINE_REPAIR_MARKER, pullRequestPurpose } from '../src/baseline-repair-state.ts'
import { createGitHubSource, isAutomatedGitHubActor, isIssueAtOrAfterCutoff } from '../src/github.ts'
import { ok } from '../src/result.ts'
import { trackingIssueBody } from '../src/routine-report-controller.ts'
import { repositoryMapping } from './fixtures.ts'

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

  it('keeps an explicitly allowed GitHub App pull request author', () => {
    expect(isAutomatedGitHubActor(
      { login: 'harlan-github-agent[bot]', type: 'Bot' },
      ['harlan-github-agent[bot]'],
    )).toBe(false)
  })

  it('excludes a bot issue even when pull requests from it are allowed', async () => {
    const listIssues = () => undefined
    const listPulls = () => undefined
    const client = {
      paginate: (method: unknown) => Promise.resolve(method === listIssues
        ? [{
            number: 12,
            state: 'open',
            title: 'Routine report',
            user: { login: 'harlan-github-agent[bot]', type: 'Bot' },
            html_url: 'https://github.com/harlan-zw/example/issues/12',
            created_at: '2026-08-01T00:00:00.000Z',
            updated_at: '2026-08-13T00:00:00.000Z',
            labels: [],
          }]
        : []),
      rest: {
        issues: { listForRepo: listIssues },
        pulls: { list: listPulls },
      },
    } as unknown as Octokit
    const source = createGitHubSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => client,
      issueCutoff: '2026-07-01',
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })
    const repository = repositoryMapping({ writablePullRequestAuthors: ['harlan-zw', 'harlan-github-agent[bot]'] })

    expect(await source.listOpenItems(repository)).toEqual(ok([]))
  })

  it('marks a canonical Routine run log as a tracking issue', async () => {
    const listIssues = () => undefined
    const listPulls = () => undefined
    const client = {
      paginate: (method: unknown) => Promise.resolve(method === listIssues
        ? [{
            number: 23,
            state: 'open',
            title: 'sentry-checkin: run log for harlan-zw/example',
            body: trackingIssueBody('sentry-checkin'),
            user: { login: 'harlan-github-agent[bot]', type: 'Bot' },
            html_url: 'https://github.com/harlan-zw/example/issues/23',
            created_at: '2026-08-01T00:00:00.000Z',
            updated_at: '2026-08-13T00:00:00.000Z',
            labels: [{ name: 'routine:sentry-checkin' }],
          }]
        : []),
      rest: {
        issues: { listForRepo: listIssues },
        pulls: { list: listPulls },
      },
    } as unknown as Octokit
    const source = createGitHubSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => client,
      issueCutoff: '2026-07-01',
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    expect(await source.listOpenItems(repositoryMapping())).toEqual(ok([
      expect.objectContaining({ number: 23, routineFiled: true, routineTracking: true }),
    ]))
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

  it.each([
    ['marked body', BASELINE_REPAIR_MARKER, [], 'fix/baseline-ci-abcdef012345'],
    ['durable label', '', ['harlan-agent-baseline-repair'], 'fix/baseline-ci-abcdef012345'],
    ['legacy branch', '', [], 'fix/baseline-ci-abcdef012345'],
  ])('recovers Baseline repair purpose from a %s', (_name, body, labels, headRef) => {
    expect(pullRequestPurpose({
      actorLogin: 'harlan-github-agent[bot]',
      authorLogin: 'harlan-github-agent[bot]',
      body,
      headRef,
      headRepository: 'harlan-zw/example',
      labels,
      repository: 'harlan-zw/example',
    })).toEqual({ _tag: 'BaselineRepair', baseShaPrefix: 'abcdef012345' })
  })

  it('does not trust a Baseline repair marker from another author', () => {
    expect(pullRequestPurpose({
      actorLogin: 'harlan-github-agent[bot]',
      authorLogin: 'contributor',
      body: BASELINE_REPAIR_MARKER,
      headRef: 'fix/baseline-ci-abcdef012345',
      headRepository: 'harlan-zw/example',
      labels: ['harlan-agent-baseline-repair'],
      repository: 'harlan-zw/example',
    })).toEqual({ _tag: 'Change' })
  })
})
