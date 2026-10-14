import type { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { approvalLabels } from '../src/approval-labels.ts'
import { BASELINE_REPAIR_MARKER, pullRequestPurpose } from '../src/baseline-repair-state.ts'
import { candidateFingerprintMarker } from '../src/candidate-issue-controller.ts'
import {
  createGitHubIssuePublisher,
  createGitHubSource,
  isAutomatedGitHubActor,
  isIssueAtOrAfterCutoff,
} from '../src/github.ts'
import { AUTOMATED_ISSUE_TRIAGE_MARKER } from '../src/issue-triage-comment.ts'
import { ok } from '../src/result.ts'
import { trackingIssueBody } from '../src/routine-report-controller.ts'
import { repositoryMapping } from './fixtures.ts'

describe('gitHub subjects', () => {
  it('reads owner change requests alongside exact rerun commands', async () => {
    const source = createGitHubSource({
      actorLogin: () => 'wolfstar-github-agent[bot]',
      createClient: () =>
        ({
          rest: {
            issues: {
              listCommentsForRepo: async () => ({
                data: [
                  {
                    id: 6072523996,
                    body: '@wolfstar-github-agent can we just changing trailingSlash to false ',
                    user: { login: 'wolfstar-project' },
                    issue_url: 'https://api.github.com/repos/wolfstar-project/example/issues/109',
                    updated_at: '2026-10-09T01:41:51Z',
                  },
                  {
                    id: 2,
                    body: '@wolfstar-agent rerun',
                    user: { login: 'wolfstar-project' },
                    issue_url: 'https://api.github.com/repos/wolfstar-project/example/issues/109',
                    updated_at: '2026-10-09T01:42:00Z',
                  },
                  {
                    id: 3,
                    body: 'Mentioned @wolfstar-agent fix this',
                    user: { login: 'wolfstar-project' },
                    issue_url: 'https://api.github.com/repos/wolfstar-project/example/issues/109',
                    updated_at: '2026-10-09T01:43:00Z',
                  },
                ],
              }),
            },
            pulls: { listReviewCommentsForRepo: async () => ({ data: [] }) },
          },
        }) as unknown as Octokit,
      issueCutoff: '2026-07-01',
      tokens: {
        getToken: async () => ok({ token: 'token', expiresAt: '2026-10-10T02:00:00.000Z' }),
        invalidate: () => undefined,
      },
    })
    expect(await source.listReviewRerunRequests(repositoryMapping())).toEqual(
      ok([
        {
          author: 'wolfstar-project',
          commentId: 6072523996,
          origin: 'ChangeRequest',
          instruction: 'can we just changing trailingSlash to false',
          pullRequestNumber: 109,
          updatedAt: '2026-10-09T01:41:51Z',
        },
        {
          author: 'wolfstar-project',
          commentId: 2,
          origin: 'Command',
          pullRequestNumber: 109,
          updatedAt: '2026-10-09T01:42:00Z',
        },
      ]),
    )
  })

  it('reads the Routine spec from its canonical repository path', async () => {
    const getContentCalls: Array<Record<string, unknown>> = []
    const client = {
      rest: {
        repos: {
          getBranch: () => Promise.resolve({ data: { commit: { sha: 'base-sha' } } }),
          getContent: (input: Record<string, unknown>) => {
            getContentCalls.push(input)
            return Promise.resolve({
              data: {
                type: 'file',
                content: Buffer.from('version: 1').toString('base64'),
                encoding: 'base64',
              },
            })
          },
        },
      },
    } as unknown as Octokit
    const source = createGitHubSource({
      actorLogin: () => 'wolfstar-github-agent[bot]',
      createClient: () => client,
      issueCutoff: '2026-07-01',
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    expect(await source.readRoutineSpec(repositoryMapping())).toEqual(
      ok({
        _tag: 'Present',
        specSha: 'base-sha',
        text: 'version: 1',
      }),
    )
    expect(getContentCalls).toEqual([
      expect.objectContaining({
        path: '.github/routines.yml',
        ref: 'base-sha',
      }),
    ])
  })

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
    expect(
      isAutomatedGitHubActor({ login: 'wolfstar-github-agent[bot]', type: 'Bot' }, ['wolfstar-github-agent[bot]']),
    ).toBe(false)
  })

  it('excludes a bot issue even when pull requests from it are allowed', async () => {
    const listIssues = () => undefined
    const listPulls = () => undefined
    const client = {
      paginate: (method: unknown) =>
        Promise.resolve(
          method === listIssues
            ? [
                {
                  number: 12,
                  state: 'open',
                  title: 'Routine report',
                  user: { login: 'wolfstar-github-agent[bot]', type: 'Bot' },
                  html_url: 'https://github.com/wolfstar-project/example/issues/12',
                  created_at: '2026-08-01T00:00:00.000Z',
                  updated_at: '2026-08-13T00:00:00.000Z',
                  labels: [],
                },
              ]
            : [],
        ),
      rest: {
        issues: { listForRepo: listIssues },
        pulls: { list: listPulls },
      },
    } as unknown as Octokit
    const source = createGitHubSource({
      actorLogin: () => 'wolfstar-github-agent[bot]',
      createClient: () => client,
      issueCutoff: '2026-07-01',
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })
    const repository = repositoryMapping({
      writablePullRequestAuthors: ['wolfstar-project', 'wolfstar-github-agent[bot]'],
    })

    expect(await source.listOpenItems(repository)).toEqual(ok([]))
  })

  it('marks a canonical Routine run log as a tracking issue', async () => {
    const listIssues = () => undefined
    const listPulls = () => undefined
    const client = {
      paginate: (method: unknown) =>
        Promise.resolve(
          method === listIssues
            ? [
                {
                  number: 23,
                  state: 'open',
                  title: 'sentry-checkin: run log for wolfstar-project/example',
                  body: trackingIssueBody('sentry-checkin'),
                  user: { login: 'wolfstar-github-agent[bot]', type: 'Bot' },
                  html_url: 'https://github.com/wolfstar-project/example/issues/23',
                  created_at: '2026-08-01T00:00:00.000Z',
                  updated_at: '2026-08-13T00:00:00.000Z',
                  labels: [{ name: 'routine:sentry-checkin' }],
                },
              ]
            : [],
        ),
      rest: {
        issues: { listForRepo: listIssues },
        pulls: { list: listPulls },
      },
    } as unknown as Octokit
    const source = createGitHubSource({
      actorLogin: () => 'wolfstar-github-agent[bot]',
      createClient: () => client,
      issueCutoff: '2026-07-01',
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    expect(await source.listOpenItems(repositoryMapping())).toEqual(
      ok([expect.objectContaining({ number: 23, routineFiled: true, routineTracking: true })]),
    )
  })

  it('keeps unmarked user-token comments and ignores marked controller comments', async () => {
    const listIssues = () => undefined
    const listPulls = () => undefined
    const listComments = () => undefined
    let humanBody = 'First detail.'
    let controllerBody = `${AUTOMATED_ISSUE_TRIAGE_MARKER}\nRunning.`
    const client = {
      paginate: (method: unknown) =>
        Promise.resolve(
          method === listIssues
            ? [
                {
                  number: 12,
                  state: 'open',
                  title: 'Broken thing',
                  body: 'Please fix it.',
                  user: { login: 'contributor', type: 'User' },
                  html_url: 'https://github.com/wolfstar-project/example/issues/12',
                  created_at: '2026-08-01T00:00:00.000Z',
                  updated_at: '2026-08-13T00:00:00.000Z',
                  labels: [{ name: 'bug' }, { name: 'wolfstar-agent-running' }],
                },
              ]
            : method === listComments
              ? [
                  {
                    id: 1,
                    body: humanBody,
                    updated_at: '2026-08-13T00:01:00.000Z',
                    user: { login: 'wolfstar-project' },
                  },
                  {
                    id: 2,
                    body: controllerBody,
                    updated_at: '2026-08-13T00:02:00.000Z',
                    user: { login: 'wolfstar-project' },
                  },
                ]
              : [],
        ),
      rest: {
        issues: { listComments, listForRepo: listIssues },
        pulls: { list: listPulls },
      },
    } as unknown as Octokit
    const source = createGitHubSource({
      actorLogin: () => 'wolfstar-project',
      createClient: () => client,
      issueCutoff: '2026-07-01',
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    const first = await source.listOpenItems(repositoryMapping())
    controllerBody = `${AUTOMATED_ISSUE_TRIAGE_MARKER}\nCompleted.`
    const controllerChanged = await source.listOpenItems(repositoryMapping())
    humanBody = 'Corrected detail.'
    const humanChanged = await source.listOpenItems(repositoryMapping())
    if (first._tag === 'Err' || controllerChanged._tag === 'Err' || humanChanged._tag === 'Err')
      throw new Error('Expected GitHub Issue snapshots.')
    const initialIssue = first.value[0]
    const changedByHuman = humanChanged.value[0]
    if (initialIssue?.kind !== 'issue' || changedByHuman?.kind !== 'issue')
      throw new Error('Expected GitHub Issue snapshots.')

    expect(controllerChanged.value[0]).toMatchObject({ contentDigest: initialIssue.contentDigest })
    expect(changedByHuman.contentDigest).not.toBe(initialIssue.contentDigest)
  })

  it('reads one exact issue with the same semantic state as the open list', async () => {
    const listComments = () => undefined
    const issue = {
      number: 12,
      state: 'open',
      title: 'Broken thing',
      body: 'Please fix it.',
      user: { login: 'wolfstar-github-agent[bot]', type: 'Bot' },
      html_url: 'https://github.com/wolfstar-project/example/issues/12',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-13T00:00:00.000Z',
      labels: [{ name: 'routine:sentry-checkin' }, { name: 'wolfstar-agent-running' }],
    }
    const client = {
      paginate: (method: unknown) =>
        Promise.resolve(
          method === listComments
            ? [
                {
                  id: 1,
                  body: 'Human detail.',
                  updated_at: '2026-08-13T00:01:00.000Z',
                  user: { login: 'wolfstar-project' },
                },
              ]
            : [],
        ),
      rest: {
        issues: {
          get: () => Promise.resolve({ data: issue }),
          listComments,
        },
      },
    } as unknown as Octokit
    const source = createGitHubSource({
      actorLogin: () => 'wolfstar-github-agent[bot]',
      createClient: () => client,
      issueCutoff: '2026-07-01',
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    expect(await source.getIssue(repositoryMapping(), 12)).toEqual(
      ok(
        expect.objectContaining({
          number: 12,
          state: 'open',
          routineFiled: true,
          contentDigest: expect.stringMatching(/^[a-f\d]{64}$/),
        }),
      ),
    )
  })

  it('uses one fixed inclusive issue cutoff', () => {
    expect(isIssueAtOrAfterCutoff('2026-07-13T23:59:59.999Z', '2026-07-14')).toBe(false)
    expect(isIssueAtOrAfterCutoff('2026-07-14T00:00:00.000Z', '2026-07-14')).toBe(true)
    expect(isIssueAtOrAfterCutoff('2026-08-13T00:00:00.000Z', '2026-07-14')).toBe(true)
  })

  it('recognizes only exact Approval labels', () => {
    expect(approvalLabels(['WOLFSTAR-AGENT-REVIEW', 'bug'])).toEqual(['review'])
    expect(approvalLabels(['wolfstar-agent-review-later'])).toEqual([])
  })

  it.each([
    ['marked body', BASELINE_REPAIR_MARKER, [], 'fix/baseline-ci-abcdef012345'],
    ['durable label', '', ['wolfstar-agent-baseline-repair'], 'fix/baseline-ci-abcdef012345'],
    ['legacy branch', '', [], 'fix/baseline-ci-abcdef012345'],
  ])('recovers Baseline repair purpose from a %s', (_name, body, labels, headRef) => {
    expect(
      pullRequestPurpose({
        actorLogin: 'wolfstar-github-agent[bot]',
        authorLogin: 'wolfstar-github-agent[bot]',
        body,
        headRef,
        headRepository: 'wolfstar-project/example',
        labels,
        repository: 'wolfstar-project/example',
      }),
    ).toEqual({ _tag: 'BaselineRepair', baseShaPrefix: 'abcdef012345' })
  })

  it('does not trust a Baseline repair marker from another author', () => {
    expect(
      pullRequestPurpose({
        actorLogin: 'wolfstar-github-agent[bot]',
        authorLogin: 'contributor',
        body: BASELINE_REPAIR_MARKER,
        headRef: 'fix/baseline-ci-abcdef012345',
        headRepository: 'wolfstar-project/example',
        labels: ['wolfstar-agent-baseline-repair'],
        repository: 'wolfstar-project/example',
      }),
    ).toEqual({ _tag: 'Change' })
  })
})

describe('open Candidate issue lookup', () => {
  it.each([false, true])('ignores closed updates and reuses only an open issue: %s', async (includeOpen) => {
    const body = candidateFingerprintMarker('dependency-updates')
    const client = {
      rest: { issues: { listForRepo: () => undefined } },
      paginate: async () => [
        { number: 1, html_url: 'https://github.com/example/issues/1', state: 'closed', body },
        ...(includeOpen ? [{ number: 2, html_url: 'https://github.com/example/issues/2', state: 'open', body }] : []),
      ],
    } as unknown as Octokit
    const publisher = createGitHubIssuePublisher({
      createClient: () => client,
      tokens: {
        getToken: async () => ok({ token: 'token', expiresAt: '2026-09-16T00:00:00.000Z' }),
        invalidate: () => undefined,
      },
    })
    expect(
      await publisher.findOpenIssueByFingerprint({
        repository: repositoryMapping(),
        fingerprint: 'dependency-updates',
      }),
    ).toEqual(ok(includeOpen ? { number: 2, url: 'https://github.com/example/issues/2' } : null))
  })
})
