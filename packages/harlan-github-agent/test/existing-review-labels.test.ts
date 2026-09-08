import type { ExistingReviewLabel } from '../src/github-agent-source.ts'
import type { GitHubPullRequestItem } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { err, ok } from '../src/result.ts'
import { createReviewStatusScheduler } from '../src/review-status-scheduler.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

function harness() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  const repository = repositoryMapping()
  let pullRequest = pullRequestItem({
    mergeState: 'clean',
    priorAutomatedReview: {
      _tag: 'Found',
      authorLogin: 'harlan-zw',
      state: 'complete',
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    },
  })
  let now = new Date('2026-08-13T01:00:00.000Z')
  store.syncRepositories([repository], now.toISOString())
  const observe = (changes: Partial<GitHubPullRequestItem> = {}) => {
    now = new Date(now.getTime() + 1000)
    pullRequest = { ...pullRequest, ...changes, updatedAt: now.toISOString() }
    return store.recordObservation({ externalId: now.toISOString(), observedAt: now.toISOString(), source: 'poll', subject: pullRequest })
  }
  observe()
  const labels: string[] = []
  const failures: string[] = []
  let failLabel = false
  let outcome: ExistingReviewLabel['label'] = 'READY'
  const scheduler = () => createReviewStatusScheduler({
    github: {
      getPullRequestReviewSnapshot: () => Promise.resolve(ok({
        baseChecks: { _tag: 'Available', checks: [] },
        body: '',
        checks: { _tag: 'Available', checks: [] },
        comments: [],
        priorAutomatedReview: pullRequest.priorAutomatedReview,
        pullRequest,
        requiredChecks: { _tag: 'None' },
        reviews: [],
      })),
      readExistingReviewLabel: (_repository, _number, commentId) => Promise.resolve(ok({ commentId, url: `${pullRequest.url}#issuecomment-${commentId}`, label: outcome })),
      upsertReviewStatus: () => { throw new Error('The existing comment must stay unchanged.') },
      stampAgentLabel: (_repository, _number, label) => {
        if (failLabel)
          return Promise.resolve(err('GitHub refused the label.'))
        labels.push(label)
        return Promise.resolve(ok(undefined))
      },
    },
    intervalMilliseconds: 5_000,
    leaseMilliseconds: 60_000,
    now: () => now,
    onError: (error) => { throw error },
    onFailure: (_repository, _number, reason) => failures.push(reason),
    onPublished: () => undefined,
    store,
    workerId: 'label-publisher',
  })
  return {
    store,
    labels,
    failures,
    observe,
    scheduler,
    failLabel: (value: boolean) => { failLabel = value },
    outcome: (value: ExistingReviewLabel['label']) => { outcome = value },
  }
}

describe('labels for an existing review', () => {
  it('restores the label without starting an Agent or changing the comment', async () => {
    const test = harness()
    await test.scheduler().runNow()
    await test.scheduler().runNow()

    expect(test.labels).toEqual(['READY'])
    expect(test.store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:02:00.000Z', 60_000)).toBeNull()
    expect(test.store.listWorkflowEvents({ stream: 'review_status', limit: 20 }).map(event => event.event))
      .toContain('OutcomeLabelConfirmed')
  })

  it('retries a failed label after the scheduler restarts', async () => {
    const test = harness()
    test.failLabel(true)
    await test.scheduler().runNow()
    test.failLabel(false)
    await test.scheduler().runNow()

    expect(test.failures).toEqual(['GitHub refused the label.'])
    expect(test.labels).toEqual(['READY'])
  })

  it('checks the current comment again on later observations', async () => {
    const test = harness()
    await test.scheduler().runNow()
    test.outcome('BLOCKED')
    test.observe()
    await test.scheduler().runNow()

    expect(test.labels).toEqual(['READY', 'BLOCKED'])
  })

  it('follows a replacement trusted comment on the same head', async () => {
    const test = harness()
    test.observe({ priorAutomatedReview: {
      _tag: 'Found',
      authorLogin: 'harlan-zw',
      state: 'complete',
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-43',
    } })
    await test.scheduler().runNow()

    expect(test.labels).toEqual(['READY'])
    expect(test.failures).toEqual([])
  })

  it.each([
    { headSha: 'new-head', priorAutomatedReview: { _tag: 'None' as const } },
    { state: 'closed' as const },
  ])('does not restore a label after the pull request changes: %j', async (changes) => {
    const test = harness()
    test.observe(changes)
    await test.scheduler().runNow()

    expect(test.labels).toEqual([])
  })

  it('retires the label publication when a fresh review is requested', async () => {
    const test = harness()
    const subject = test.observe()
    if (subject._tag !== 'Inserted' && subject._tag !== 'Duplicate')
      throw new Error('Expected the observed pull request.')
    test.store.requestReviewRerun({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: subject.revisionId,
      source: 'dashboard',
      requestedBy: 'harlan-zw',
      requestId: 'rerun',
      at: '2026-08-13T01:00:02.000Z',
    })
    await test.scheduler().runNow()

    expect(test.labels).toEqual([])
    expect(test.store.listWorkflowEvents({ stream: 'review_status', limit: 20 }).map(event => event.event))
      .toContain('Superseded')
  })

  it('honors Manual Selection mode when it changes before publication', async () => {
    const test = harness()
    test.store.setSelectionMode('manual')
    await test.scheduler().runNow()

    expect(test.labels).toEqual([])
  })

  it('honors Dismissal before publication', async () => {
    const test = harness()
    test.store.dismissItem({ repository: 'harlan-zw/example', itemNumber: 24, at: '2026-08-13T01:00:02.000Z' })
    await test.scheduler().runNow()

    expect(test.labels).toEqual([])
  })

  it('honors repository policy when it changes before publication', async () => {
    const test = harness()
    test.store.syncRepositories([repositoryMapping({ pullRequestReview: false })], '2026-08-13T01:00:02.000Z')
    await test.scheduler().runNow()

    expect(test.labels).toEqual([])
  })
})
