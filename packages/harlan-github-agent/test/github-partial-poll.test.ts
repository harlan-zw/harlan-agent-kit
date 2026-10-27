import type { Octokit } from 'octokit'
import { expect, it } from 'vitest'
import { createApprovalController } from '../src/approval-controller.ts'
import { createGitHubSource } from '../src/github.ts'
import { reconcileRepository } from '../src/reconcile.ts'
import { err, ok } from '../src/result.ts'
import { openJournalStore, revisionIdFor } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

function partialPoll(beforeFailure: () => void = () => undefined) {
  const listIssues = () => undefined
  const listPulls = () => undefined
  const listComments = () => undefined
  let failure: number | null = 404
  let commentsFailure: number | null = null
  const reads: number[] = []
  const pull = (number: number) => ({
    number,
    state: 'open',
    title: `Change ${number}`,
    body: '',
    user: { login: 'harlan-zw', type: 'User' },
    html_url: `https://github.com/harlan-zw/example/pull/${number}`,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
    labels: number === 26 ? [{ name: 'harlan-agent-review' }] : [],
    base: { ref: 'main' },
    head: { sha: `head-${number}`, ref: `fix/change-${number}`, repo: { full_name: 'harlan-zw/example' } },
    merged_at: null,
    draft: false,
    mergeable: true,
  })
  const client = {
    paginate: (method: unknown, parameters?: { issue_number?: number }) => method === listComments && parameters?.issue_number === 24 && commentsFailure !== null
      ? new Promise((resolve, reject) => { setTimeout(() => reject(Object.assign(new Error('Comments unavailable.'), { status: commentsFailure })), 0) })
      : Promise.resolve(method === listPulls ? [24, 25, 26].map(pull) : []),
    rest: {
      issues: { listForRepo: listIssues, listComments },
      pulls: {
        list: listPulls,
        get: ({ pull_number: number }: { pull_number: number }) => {
          reads.push(number)
          if (number === 24 && failure !== null)
            beforeFailure()
          return number === 24 && failure !== null
            ? Promise.reject(Object.assign(new Error('Pull request detail unavailable.'), { status: failure }))
            : Promise.resolve({ data: pull(number) })
        },
      },
      repos: { getBranch: async () => ({ data: { commit: { sha: 'base123' } } }) },
    },
  } as unknown as Octokit
  const source = createGitHubSource({
    actorLogin: () => 'harlan-github-agent[bot]',
    createClient: () => client,
    issueCutoff: '2026-07-01',
    tokens: {
      getToken: async () => ok({ token: 'fixture-token', expiresAt: '2099-01-01T00:00:00.000Z' }),
      invalidate: () => undefined,
    },
  })
  return {
    source,
    reads,
    failWith: (status: number | null) => { failure = status },
    failCommentsWith: (status: number) => { commentsFailure = status },
  }
}

it('returns healthy pull snapshots and an explicit unavailable identity after one detail 404', async () => {
  const fixture = partialPoll()
  const result = await fixture.source.listOpenItems(repositoryMapping())
  expect(result).toEqual(ok([
    { kind: 'unavailable', itemKind: 'pull_request', number: 24, error: { repository: 'harlan-zw/example', status: 404, message: 'Pull request detail unavailable.' } },
    expect.objectContaining({ kind: 'pull_request', number: 25, headSha: 'head-25' }),
    expect.objectContaining({ kind: 'pull_request', number: 26, headSha: 'head-26' }),
  ]))
  fixture.failWith(null)
  expect(await fixture.source.listOpenItems(repositoryMapping())).toEqual(ok([24, 25, 26].map(number => expect.objectContaining({ kind: 'pull_request', number }))))
})

it.each([401, 403, 503])('keeps a non-404 detail failure authoritative: %s', async (status) => {
  const fixture = partialPoll()
  fixture.failWith(status)
  expect(await fixture.source.listOpenItems(repositoryMapping())).toEqual(err({ repository: 'harlan-zw/example', status, message: 'Pull request detail unavailable.' }))
})

it('propagates cancellation instead of accepting a concurrent detail 404 as a partial poll', async () => {
  const controller = new AbortController()
  const fixture = partialPoll(() => controller.abort())
  expect(await fixture.source.listOpenItems(repositoryMapping(), controller.signal)).toEqual(err({ repository: 'harlan-zw/example', status: 404, message: 'Pull request detail unavailable.' }))
})

it.each([403, 503])('preserves a concurrent comments failure when the detail returns 404 first: %s', async (status) => {
  const fixture = partialPoll()
  fixture.failCommentsWith(status)
  expect(await fixture.source.listOpenItems(repositoryMapping())).toEqual(err({ repository: 'harlan-zw/example', status, message: 'Comments unavailable.' }))
})

it.each([
  { dismissed: false, approved: false },
  { dismissed: false, approved: true },
  { dismissed: true, approved: false },
])('preserves unavailable state and approval rules while healthy observations progress: $dismissed/$approved', async ({ dismissed, approved }) => {
  const fixture = partialPoll()
  const repository = repositoryMapping()
  const store = openJournalStore(':memory:', true)
  const before = '2026-08-13T00:01:00.000Z'
  const at = '2026-08-13T01:00:00.000Z'
  const previous = pullRequestItem({ number: 24, author: 'contributor', mergeState: 'clean' })
  store.syncRepositories([repository], before)
  store.setRepositoryWritesEnabled(repository.github, true)
  store.setSelectionMode('manual')
  store.recordPollSuccess(repository.github, before)
  store.recordPollObservation({ observedAt: before, subject: previous })
  if (approved)
    expect(store.approvePullRequest({ repository: repository.github, pullRequestNumber: 24, revisionId: revisionIdFor(previous), kind: 'review', at: before })._tag).toBe('Approved')
  if (dismissed)
    expect(store.dismissItem({ repository: repository.github, itemNumber: 24, at: before })._tag).toBe('Dismissed')
  const originalTasks = store.listTasks()
  const approvals = createApprovalController({
    store,
    now: () => new Date(at),
    github: {
      clearAgentLabels: async () => { throw new Error('No labels should need clearing.') },
      consumeApprovalLabel: async () => ok(undefined),
      ensureApprovalLabel: async () => ok(undefined),
      upsertReviewStatus: async () => { throw new Error('Manual Selection needs no Approval prompt.') },
    },
  })
  try {
    const poll = (time: string) => reconcileRepository(repository, { approvals, github: fixture.source, store, now: () => new Date(time) })
    expect(await poll(at)).toEqual(err({ repository: repository.github, message: 'Pull request detail unavailable.' }))
    expect(store.getDashboardSnapshot(at).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'pull_request', number: 24, state: 'open', revisionId: revisionIdFor(previous) }),
      expect.objectContaining({ kind: 'pull_request', number: 25, state: 'open' }),
      expect.objectContaining({ kind: 'pull_request', number: 26, state: 'open' }),
    ]))
    expect(fixture.reads.filter(number => number === 24)).toHaveLength(1)
    expect(store.listTasks().filter(task => task.revisionId === revisionIdFor(previous))).toEqual(originalTasks)
    expect(store.hasPullRequestApproval(repository.github, 24, revisionIdFor(previous), 'review')).toBe(approved)
    expect(store.isItemDismissed(repository.github, 'pull_request', 24)).toBe(dismissed)
    if (approved)
      expect(store.claimNextAdversarialReviewTask('previously-approved', at, 10_000)?.pullRequestNumber).toBe(24)
    expect(store.claimNextAdversarialReviewTask('healthy-review', at, 10_000)?.pullRequestNumber).toBe(26)
    expect(store.claimNextAdversarialReviewTask('unapproved-review', at, 10_000)).toBeNull()
    expect(store.getDashboardSnapshot(at).repositories[0]).toMatchObject({ lastError: 'Pull request detail unavailable.', lastSuccessAt: before })

    fixture.failWith(null)
    const recoveredAt = '2026-08-13T01:00:01.000Z'
    expect((await poll(recoveredAt))._tag).toBe('Ok')
    expect(store.getPullRequestWatchState(repository.github, 24)).toMatchObject({ _tag: dismissed ? 'Dismissed' : 'Open', pullRequest: { headSha: 'head-24' } })
    expect(store.isItemDismissed(repository.github, 'pull_request', 24)).toBe(dismissed)
    expect(store.claimNextAdversarialReviewTask('still-unapproved', recoveredAt, 10_000)).toBeNull()
    expect(store.getDashboardSnapshot(recoveredAt).repositories[0]).toMatchObject({ lastError: null, lastSuccessAt: recoveredAt })
  }
  finally {
    store.close()
  }
})
