import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { createPackageReleaseStore } from '../src/package-release-store.ts'
import { renderPackageRelease } from '../src/package-release.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

it('binds a click to its stored offer and consumes it once across restart', () => {
  const db = new DatabaseSync(':memory:')
  const store = createPackageReleaseStore(db)
  const plan = { _tag: 'Available' as const, bump: 'patch' as const, packageName: 'example', version: '1.0.1', previousVersion: '1.0.0', previousTag: 'v1.0.0', sourceSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40) }
  const body = renderPackageRelease(plan)
  const offer = { repository: 'harlan-zw/example', pullRequestNumber: 1, commentId: 2, body, plan, policy: 'policy' }
  store.saveReleaseOffer(offer)
  const request = { repository: offer.repository, pullRequestNumber: 1, commentId: 2, before: body, requestedBy: 'harlan-zw', commentAuthor: 'bot' }
  expect(store.requestPackageRelease({ ...request, before: `${body}changed` })).toBe(false)
  expect(store.requestPackageRelease(request)).toBe(true)
  expect(createPackageReleaseStore(db).requestPackageRelease(request)).toBe(false)
  expect(store.listPackageReleases(offer.repository)[0]?.state).toEqual({ _tag: 'Queued', requestedBy: 'harlan-zw' })
  store.saveReleaseOffer({ ...offer, plan: { ...plan, sourceSha: 'c'.repeat(40) } })
  expect(store.listPackageReleases(offer.repository)[0]?.plan.sourceSha).toBe(plan.sourceSha)
  db.close()
})

it('fences expired lease holders and serializes a repository', () => {
  const db = new DatabaseSync(':memory:')
  const store = createPackageReleaseStore(db)
  const first = store.claimPackageReleaseLease('repo', 1000)
  expect(first).not.toBeNull()
  expect(store.claimPackageReleaseLease('repo', 1001)).toBeNull()
  const next = store.claimPackageReleaseLease('repo', 100000)
  expect(next).not.toBeNull()
  expect(store.renewPackageReleaseLease('repo', first!, 100001)).toBe(false)
  expect(store.renewPackageReleaseLease('repo', next!, 100001)).toBe(true)
  db.close()
})

it('honors repository pause and write revocation before release publication', async () => {
  const journal = openJournalStore(':memory:')
  const repository = repositoryMapping()
  journal.syncRepositories([repository], '2026-09-14T00:00:00.000Z')
  journal.setRepositoryWritesEnabled(repository.github, true)
  expect(journal.mayPublishPackageRelease(repository.github)).toBe(true)
  journal.setRepositoryPaused(repository.github, true)
  expect(journal.mayPublishPackageRelease(repository.github)).toBe(false)
  journal.setRepositoryPaused(repository.github, false)
  journal.setRepositoryWritesEnabled(repository.github, false)
  expect(journal.mayPublishPackageRelease(repository.github)).toBe(false)
  journal.close()
})
