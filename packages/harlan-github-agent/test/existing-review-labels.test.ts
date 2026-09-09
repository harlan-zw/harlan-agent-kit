import type { ReviewStatusPublicationOptions } from '../src/review-status-controller.ts'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { publishClaimedReviewStatus } from '../src/review-status-controller.ts'
import { createReviewStatusScheduler } from '../src/review-status-scheduler.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'
import { githubPublicationFixture } from './github-publication-fixture.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

it('requires fresh Review before publishing a READY label for an unscoped comment', async () => {
  const store = openJournalStore(':memory:')
  stores.push(store)
  const pullRequest = pullRequestItem({
    mergeState: 'clean',
    priorAutomatedReview: {
      _tag: 'Found',
      authorLogin: 'harlan-zw',
      state: 'complete',
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    },
  })
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  const labels: string[] = []
  const scheduler = createReviewStatusScheduler({
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
      readExistingReviewLabel: () => Promise.resolve(ok({ commentId: 42, url: pullRequest.url, label: 'READY' })),
      upsertReviewStatus: () => { throw new Error('The existing comment must stay unchanged.') },
      stampAgentLabel: (_repository, _number, label) => {
        labels.push(label)
        return Promise.resolve(ok(undefined))
      },
    },
    intervalMilliseconds: 5_000,
    leaseMilliseconds: 60_000,
    now: () => new Date('2026-08-13T01:01:00.000Z'),
    onError: (error) => { throw error },
    onFailure: (_repository, _number, reason) => { throw new Error(reason) },
    onPublished: () => undefined,
    store,
    workerId: 'label-publisher',
  })
  for (const externalId of ['first', 'repeat']) {
    store.recordObservation({ externalId, observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: pullRequest })
    await scheduler.runNow()
  }

  expect(labels).toEqual([])
  expect(store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:02:00.000Z', 60_000)?.pullRequest.baseRef).toBe('main')
})

it.each(['kept', 'revoked', 'rerun', 'Pause', 'labels', 'create label', 'add label', 'remove label'] as const)('publishes an existing review label only while write authority is %s', async (authority) => {
  const directory = mkdtempSync(join(tmpdir(), 'existing-review-label-'))
  const path = join(directory, 'journal.sqlite')
  const repository = repositoryMapping()
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  const store = openJournalStore(path, true)
  store.syncRepositories([repository], '2026-08-13T01:00:00.000Z')
  store.setRepositoryWritesEnabled(repository.github, true)
  const observed = store.recordObservation({ externalId: 'existing-review', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: pullRequest })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a pull request.')
  const task = store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:00:01.000Z', 60_000)!
  store.completeReviewTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: '2026-08-13T01:00:02.000Z', evidence: 'existing', resolution: { _tag: 'ExistingReview', url: pullRequest.url } })
  store.close()
  const database = new DatabaseSync(path)
  database.prepare(`INSERT INTO review_status_commands (id, task_kind, task_id, task_fence, revision_id, expected_head_sha, phase, body, body_sha256, state_tag, github_comment_id, github_url, created_at, updated_at) VALUES (?, 'existing_review', 'existing', 0, ?, ?, 'terminal', '', ?, 'Pending', 42, ?, ?, ?)`).run('existing-command', observed.revisionId, pullRequest.headSha, createHash('sha256').update('').digest('hex'), pullRequest.url, '2026-08-13T01:00:03.000Z', '2026-08-13T01:00:03.000Z')
  database.close()
  const reopened = openJournalStore(path, true)
  try {
    const command = reopened.claimNextTerminalReviewStatus('publisher', '2026-08-13T01:00:04.000Z', 60_000)!
    const labels: string[] = []
    const github = githubPublicationFixture({ body: '', mode: 'idempotent', ...(['labels', 'create label', 'add label', 'remove label'].includes(authority) ? { boundary: authority as 'labels' | 'create label' | 'add label' | 'remove label' } : {}), change: () => expect(reopened.requestReviewRerun({ repository: repository.github, pullRequestNumber: 24, revisionId: observed.revisionId, requestId: 'boundary-rerun', source: 'dashboard', requestedBy: 'harlan-zw', at: '2026-08-13T01:00:05.000Z' })._tag).toBe('Queued') })
    let paused = false
    const options = { store: reopened, now: () => new Date('2026-08-13T01:00:05.000Z'), github: {
      getPullRequestReviewSnapshot: () => { throw new Error('Unexpected snapshot.') },
      upsertReviewStatus: () => { throw new Error('Unexpected comment.') },
      readExistingReviewLabel: () => {
        if (authority === 'revoked')
          reopened.setRepositoryWritesEnabled(repository.github, false)
        if (authority === 'Pause' && !paused) {
          paused = true
          reopened.setRepositoryPaused(repository.github, true)
        }
        if (authority === 'rerun')
          expect(reopened.requestReviewRerun({ repository: repository.github, pullRequestNumber: 24, revisionId: observed.revisionId, requestId: 'rerun', source: 'dashboard', requestedBy: 'harlan-zw', at: '2026-08-13T01:00:05.000Z' })._tag).toBe('Queued')
        return Promise.resolve(ok({ commentId: 42, url: pullRequest.url, label: 'READY' }))
      },
      stampAgentLabel: async (...args) => {
        const result = await github.source.stampAgentLabel(...args)
        if (result._tag === 'Ok')
          labels.push('READY')
        return result
      },
    } } satisfies ReviewStatusPublicationOptions
    const result = await publishClaimedReviewStatus(options, command, false, new AbortController().signal)
    expect(result._tag).toBe(authority === 'kept' ? 'Ok' : 'Err')
    expect(labels).toEqual(authority === 'kept' ? ['READY'] : [])
    expect(reopened.claimNextTerminalReviewStatus('next-publisher', '2026-08-13T01:02:00.000Z', 60_000)).toBeNull()
    const accepted = authority === 'kept'
      ? ['create label', 'add label', 'remove label', 'remove label']
      : authority === 'create label'
        ? ['create label']
        : authority === 'add label'
          ? ['create label', 'add label']
          : authority === 'remove label' ? ['create label', 'add label', 'remove label'] : []
    expect(github.writes).toEqual(accepted)
    const events = reopened.listWorkflowEvents({ stream: 'review_status', limit: 100 }).filter(event => event.entityId === command.id)
    expect(events).toContainEqual(expect.objectContaining({ event: authority === 'kept' ? 'Published' : authority === 'Pause' ? 'Deferred' : 'Superseded' }))
    if (authority === 'rerun' || ['labels', 'create label', 'add label', 'remove label'].includes(authority))
      expect(reopened.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:02:01.000Z', 60_000)?.rerun._tag).toBe('Requested')
    if (authority === 'Pause') {
      reopened.setRepositoryPaused(repository.github, false)
      const resumed = reopened.claimNextTerminalReviewStatus('resumed-publisher', '2026-08-13T01:02:01.000Z', 60_000)!
      expect(resumed.id).toBe(command.id)
      expect((await publishClaimedReviewStatus({ ...options, now: () => new Date('2026-08-13T01:02:02.000Z') }, resumed, false, new AbortController().signal))._tag).toBe('Ok')
      expect(github.writes).toEqual(['create label', 'add label', 'remove label', 'remove label'])
      expect(reopened.claimNextTerminalReviewStatus('finished-publisher', '2026-08-13T01:03:02.000Z', 60_000)).toBeNull()
    }
  }
  finally {
    reopened.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
