import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { reconcileRepository } from '../src/reconcile.ts'
import { err, ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { issueSubject, repositoryMapping } from './fixtures.ts'

describe('gitHub reconciliation', () => {
  it('ignores issues authored by automated accounts', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')

    const result = await reconcileRepository(repository, {
      github: { listOpenSubjects: () => Promise.resolve(ok([issueSubject({ author: 'github-actions[bot]' })])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 0, inserted: 0, duplicates: 0, stale: 0, closed: 0 },
    })
    expect(store.getDashboardSnapshot('2026-08-13T01:00:00.000Z').subjects).toEqual([])
    store.close()
  })

  it('records subjects idempotently and updates poll health', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    const github = { listOpenSubjects: () => Promise.resolve(ok([issueSubject()])) }
    const now = () => new Date('2026-08-13T01:00:00.000Z')

    const first = await reconcileRepository(repository, { github, store, now })
    const second = await reconcileRepository(repository, { github, store, now })

    expect(first).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 1, duplicates: 0, stale: 0, closed: 0 },
    })
    expect(second).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 0, duplicates: 1, stale: 0, closed: 0 },
    })
    expect(store.getDashboardSnapshot(now().toISOString()).repositories[0]?.lastError).toBeNull()
    store.close()
  })

  it('reconciles Approval labels for issues', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    const issue = issueSubject({ approvalLabels: ['review'] })
    const approved: Array<{ kind: string, revisionId: string }> = []
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')

    const result = await reconcileRepository(repository, {
      approvals: {
        reconcile: (_mapping, subject, revisionId) => {
          approved.push({ kind: subject.kind, revisionId })
          return Promise.resolve(ok(undefined))
        },
      },
      github: { listOpenSubjects: () => Promise.resolve(ok([issue])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result._tag).toBe('Ok')
    expect(approved).toEqual([{ kind: 'issue', revisionId: expect.stringMatching(/^[a-f\d]{64}$/) }])
    store.close()
  })

  it('surfaces GitHub failures in repository health', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    const github = { listOpenSubjects: () => Promise.resolve(err({ repository: repository.github, message: 'Rate limited' })) }
    const now = () => new Date('2026-08-13T01:00:00.000Z')

    const result = await reconcileRepository(repository, { github, store, now })

    expect(result).toEqual({ _tag: 'Err', error: { repository: repository.github, message: 'Rate limited' } })
    expect(store.getDashboardSnapshot(now().toISOString()).repositories[0]?.lastError).toBe('Rate limited')
    store.close()
  })

  it('does not reuse legacy observation identities after revision schema changes', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    const incoming = issueSubject()
    const legacyExternalId = createHash('sha256')
      .update(`${repository.github}:${incoming.kind}:${incoming.number}:${JSON.stringify(incoming)}`)
      .digest('hex')
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: legacyExternalId,
      observedAt: '2026-08-13T00:30:00.000Z',
      source: 'poll',
      subject: issueSubject({ title: 'Legacy snapshot' }),
    })

    const result = await reconcileRepository(repository, {
      github: { listOpenSubjects: () => Promise.resolve(ok([incoming])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 1, duplicates: 0, stale: 0, closed: 0 },
    })
    store.close()
  })
})
