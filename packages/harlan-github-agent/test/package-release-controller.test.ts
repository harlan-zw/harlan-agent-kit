import type { PackageReleaseSource } from '../src/package-release-controller.ts'
import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { reconcilePackageReleases } from '../src/package-release-controller.ts'
import { createPackageReleaseStore } from '../src/package-release-store.ts'
import { renderPackageRelease } from '../src/package-release.ts'
import { createWebhookApp } from '../src/webhook.ts'
import { repositoryMapping } from './fixtures.ts'

const plan = { _tag: 'Available' as const, bump: 'patch' as const, packageName: 'example', version: '1.0.1', previousVersion: '1.0.0', previousTag: 'v1.0.0', sourceSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40) }
const repository = { ...repositoryMapping(), release: { manifest: 'package.json', versionFiles: ['package.json'], tagPrefix: 'v', workflow: 'release.yml', checks: ['test'] } }

function setup() {
  const database = new DatabaseSync(':memory:')
  const store = createPackageReleaseStore(database)
  const source: PackageReleaseSource = {
    candidates: async () => [24],
    inspect: async () => plan,
    comment: vi.fn(async () => 99),
    prepare: vi.fn<PackageReleaseSource['prepare']>(async () => ({ _tag: 'Prepared', pullRequestNumber: 25, headSha: 'c'.repeat(40), branch: 'release/24-1.0.1' })),
    merge: vi.fn(async () => null),
    publish: vi.fn(async () => null),
  }
  const run = (webhookReady = true) => reconcilePackageReleases({ webhookReady, repository, store: createPackageReleaseStore(database), source: () => source, now: () => 1000, signal: new AbortController().signal })
  const click = () => store.requestPackageRelease({ repository: repository.github, pullRequestNumber: 24, commentId: 99, before: renderPackageRelease(plan), requestedBy: 'harlan-zw', commentAuthor: 'harlan-github-agent[bot]' })
  return { database, store, source, run, click }
}

describe('release controller', () => {
  it('finishes an authorized release across restarts without preparing twice', async () => {
    const task = setup()
    await task.run()
    expect(task.click()).toBe(true)
    await task.run()
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Prepared')
    task.source.merge = vi.fn<PackageReleaseSource['merge']>(async () => ({ _tag: 'Publishing', tag: 'v1.0.1', sha: 'd'.repeat(40) }))
    await task.run()
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Publishing')
    task.source.publish = vi.fn(async () => 'https://github.com/harlan-zw/example/releases/tag/v1.0.1')
    await task.run()
    await task.run()
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Completed')
    expect(task.source.prepare).toHaveBeenCalledTimes(1)
    expect(task.source.publish).toHaveBeenCalledTimes(1)
    expect(task.source.comment).toHaveBeenLastCalledWith(24, expect.stringContaining('Published [example@1.0.1]'), 99)
    task.database.close()
  })
  it('does not release a changed range or policy', async () => {
    const task = setup()
    await task.run()
    task.click()
    task.source.inspect = async () => ({ ...plan, sourceSha: 'e'.repeat(40) })
    await task.run()
    expect(task.source.prepare).not.toHaveBeenCalled()
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Blocked')
    task.database.close()
  })
  it('resumes publication after a lost response with the same version', async () => {
    const task = setup()
    await task.run()
    task.click()
    task.source.merge = async () => ({ _tag: 'Publishing', tag: 'v1.0.1', sha: 'd'.repeat(40) })
    task.source.publish = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce('https://example.com/release')
    await expect(task.run()).rejects.toThrow('Connection lost')
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Publishing')
    expect(task.source.comment).toHaveBeenLastCalledWith(24, expect.stringContaining('Connection lost'), 99)
    await task.run()
    expect(task.source.prepare).toHaveBeenCalledTimes(1)
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Completed')
    task.database.close()
  })
})

it.each(['valid', 'other-sender', 'foreign-comment', 'bad-signature'])('authenticates a merged pull request release click: %s', async (mode) => {
  const task = setup()
  await task.run()
  const before = renderPackageRelease(plan)
  const body = JSON.stringify({ action: 'edited', repository: { full_name: repository.github }, issue: { number: 24, pull_request: {} }, sender: { login: mode === 'other-sender' ? 'contributor' : 'harlan-zw' }, comment: { id: 99, user: { login: mode === 'foreign-comment' ? 'contributor' : 'harlan-github-agent[bot]' }, body: before.replace('[ ]', '[x]') }, changes: { body: { from: before } } })
  const app = createWebhookApp({ secret: 'secret', allowedOwners: ['harlan-zw'], onHint: () => {}, logger: { info: () => {} }, packageRelease: { allowedAuthor: 'harlan-zw', actorLogin: () => 'harlan-github-agent[bot]', apply: (request) => {
    task.store.requestPackageRelease(request)
  } } })
  const response = await app.fetch(new Request('http://localhost/webhook', { method: 'POST', body, headers: {
    'x-github-event': 'issue_comment',
    'x-github-delivery': 'release-click',
    'x-hub-signature-256': `sha256=${createHmac('sha256', mode === 'bad-signature' ? 'wrong' : 'secret').update(body).digest('hex')}`,
  } }))
  expect(response.status).toBe(mode === 'bad-signature' ? 401 : 204)
  expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe(mode === 'valid' ? 'Queued' : 'Available')
  task.database.close()
})

it('keeps a text command that arrives before the offer exists', async () => {
  const task = setup()
  task.store.queuePackageReleaseCommand({ repository: repository.github, pullRequestNumber: 24, commentId: 101, requestedBy: 'harlan-zw', bump: 'auto' })
  await task.run()
  expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Queued')
  await task.run()
  expect(task.source.prepare).toHaveBeenCalledTimes(1)
  task.store.queuePackageReleaseCommand({ repository: repository.github, pullRequestNumber: 24, commentId: 101, requestedBy: 'harlan-zw', bump: 'auto' })
  expect(task.store.listPackageReleaseCommands(repository.github)).toEqual([])
  task.database.close()
})

it('does not offer or publish releases while the webhook listener is unavailable', async () => {
  const task = setup()
  await task.run(false)
  expect(task.source.comment).not.toHaveBeenCalled()
  expect(task.store.listPackageReleases(repository.github)).toEqual([])
  task.database.close()
})
