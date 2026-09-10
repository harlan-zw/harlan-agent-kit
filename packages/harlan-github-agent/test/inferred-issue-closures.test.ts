import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore, reconcileRepository } from '../src/index.ts'
import { ok } from '../src/result.ts'
import { issueItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

function setup() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  const repository = repositoryMapping({ ownership: 'maintained', authentication: 'user', issueWork: true })
  store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
  const issue = issueItem({ author: 'contributor' })
  const read = (subject: typeof issue, at: string) => reconcileRepository(repository, {
    github: {
      listOpenItems: () => Promise.resolve(ok([subject])),
      getIssue: () => Promise.resolve(ok(subject)),
      getPullRequest: () => Promise.reject(new Error('No pull request exists.')),
    },
    store,
    now: () => new Date(at),
  })
  return { store, repository, issue, read }
}

describe('inferred issue closures', () => {
  it.each([false, true])('restores an open issue from a fresh poll when its content changed: %s', async (changed) => {
    const { store, repository, issue, read } = setup()
    await read(issue, '2026-08-13T02:00:00.000Z')
    // Older controllers guessed closure from a missing list entry and stamped their own time.
    store.closeMissingItems(repository.github, [], '2026-08-14T00:00:00.000Z')
    const current = changed
      ? { ...issue, contentDigest: 'updated-content', updatedAt: '2026-08-13T03:00:00.000Z' }
      : issue

    const result = await read(current, '2026-08-15T00:00:00.000Z')

    expect(result).toEqual(ok(expect.objectContaining({ stale: 0 })))
    expect(store.listOpenIssueNumbers(repository.github)).toEqual([issue.number])
    expect(store.getDashboardSnapshot('2026-08-15T00:00:00.000Z').items)
      .toContainEqual(expect.objectContaining({ number: issue.number, state: 'open' }))
  })

  it('restores the contributor issue without granting Approval', async () => {
    const { store, repository, issue, read } = setup()
    await read(issue, '2026-08-13T02:00:00.000Z')
    expect(store.claimNextIssueTriageTask('triage', '2026-08-13T02:01:00.000Z', 60_000)).toBeNull()
    store.closeMissingItems(repository.github, [], '2026-08-14T00:00:00.000Z')

    await read(issue, '2026-08-15T00:00:00.000Z')

    expect(store.getDashboardSnapshot('2026-08-15T00:00:00.000Z').queue)
      .toContainEqual(expect.objectContaining({ number: issue.number, state: { _tag: 'AwaitingApproval', kind: 'issue_triage' } }))
    expect(store.claimNextIssueTriageTask('triage', '2026-08-15T00:01:00.000Z', 60_000)).toBeNull()
    expect(store.claimNextIssueWorkTask('implementation', '2026-08-15T00:01:00.000Z', 60_000)).toBeNull()
  })

  it('keeps a confirmed GitHub closure when an older open poll arrives', async () => {
    const { store, repository, issue, read } = setup()
    await read(issue, '2026-08-13T02:00:00.000Z')
    store.recordObservation({
      externalId: 'github-confirmed-closure',
      subject: { ...issue, state: 'closed', updatedAt: '2026-08-14T00:00:00.000Z' },
      source: 'poll',
      observedAt: '2026-08-14T00:01:00.000Z',
    })

    const result = await read(issue, '2026-08-15T00:00:00.000Z')

    expect(result).toEqual(ok(expect.objectContaining({ stale: 1 })))
    expect(store.listOpenIssueNumbers(repository.github)).toEqual([])
  })

  it.each([
    { source: 'webhook' as const, observedAt: '2026-08-15T00:00:00.000Z' },
    { source: 'poll' as const, observedAt: '2026-08-13T04:00:00.000Z' },
  ])('rejects an older issue from $source observed at $observedAt', async ({ source, observedAt }) => {
    const { store, repository, issue, read } = setup()
    await read(issue, '2026-08-13T02:00:00.000Z')
    store.closeMissingItems(repository.github, [], '2026-08-14T00:00:00.000Z')

    const result = store.recordObservation({ externalId: 'delayed-webhook', subject: issue, source, observedAt })

    expect(result._tag).toBe('Stale')
    expect(store.listOpenIssueNumbers(repository.github)).toEqual([])
  })
})
